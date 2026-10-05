"""Streets outside the technical map are sized from their setting (plan 031); unmapped
land round family houses is gardens, not pavement."""

import unittest

from shapely.geometry import LineString, box

import lanes
import test_walking_surfaces


def building(x0, y0, x1, y1):
    return {"rings": [[(x0, y0), (x1, y0), (x1, y1), (x0, y1)]], "part": False}


def row(gap, count=8, size=10, big=False):
    """Houses along both sides of a street on y=0, `gap` m apart face to face."""
    d = 30 if big else size
    return [building(i * (d + 4), s * gap / 2 if s > 0 else -gap / 2 - d, i * (d + 4) + d, s * gap / 2 + d if s > 0 else -gap / 2)
            for i in range(count) for s in (1, -1)]


STREET = LineString([(0, 0), (8 * 14, 0)])


class FakeKerbs:
    def __init__(self, share):
        self.share = share

    def surveyed(self, lines):
        return [self.share] * len(lines)


class SettingTests(unittest.TestCase):
    def test_setting_from_the_buildings_round_a_street(self):
        self.assertEqual(lanes.Setting([], []).kind([STREET]), ["open"])
        self.assertEqual(lanes.Setting(row(20)[:2], []).kind([STREET]), ["open"])
        self.assertEqual(lanes.Setting(row(20), []).kind([STREET]), ["houses"])
        self.assertEqual(lanes.Setting(row(20, big=True), []).kind([LineString([(0, 0), (8 * 34, 0)])]), ["flats"])

    def test_room_is_the_gap_between_what_stands_either_side(self):
        room = lanes.Setting(row(12), []).room([STREET])[0]
        self.assertAlmostEqual(room, 12, delta=0.1)
        fence = [{"pts": [(-5, 3), (120, 3)]}, {"pts": [(-5, -3), (120, -3)]}]
        self.assertAlmostEqual(lanes.Setting([], fence).room([STREET])[0], 6, delta=0.1)
        self.assertTrue(lanes.np.isnan(lanes.Setting([], []).room([STREET])[0]))

    def test_width_is_the_setting_default_cut_to_the_room(self):
        self.assertEqual(lanes.Setting(row(40), []).widths([STREET], ["residential"]), [5.5])
        self.assertEqual(lanes.Setting(row(7), []).widths([STREET], ["residential"]), [5.5])
        self.assertEqual(lanes.Setting(row(6), []).widths([STREET], ["residential"]), [4.5])
        self.assertEqual(lanes.Setting(row(4), []).widths([STREET], ["residential"]), [4.0])
        self.assertEqual(lanes.Setting(row(40), []).widths([STREET], ["motorway"]), [None])

    def test_tagged_and_surveyed_streets_keep_their_width(self):
        setting = lanes.Setting(row(40), [])
        ests = [{"half": 4.0}, {"half": 4.0}]
        got = lanes.apply(setting, FakeKerbs(0.0), [STREET, STREET], ["residential"] * 2, ests, [True, False])
        self.assertEqual(got, [None, 5.5])
        self.assertEqual((ests[0]["half"], ests[1]["half"]), (4.0, 2.75))
        ests = [{"half": 4.0}]
        self.assertEqual(lanes.apply(setting, FakeKerbs(0.9), [STREET], ["residential"], ests, [False]), [None])
        self.assertEqual(ests[0]["half"], 4.0)


class HomesOnUnmappedLandTests(unittest.TestCase):
    extract = test_walking_surfaces.WalkingSurfaceTests.extract

    def test_land_round_family_houses_outside_any_residential_area_is_garden(self):
        got = self.extract([{"building": "house"}, {"building": "house"}, {"building": "house"}],
                           [box(0, 0, 10, 10), box(40, 0, 50, 10), box(0, 40, 10, 50)])
        garden = got["areas"]["garden"]
        self.assertGreater(garden.area, 3000)
        self.assertEqual(garden.intersection(box(0, 0, 10, 10)).area, 0)
        self.assertEqual(len(got["fences"]), 0)

    def test_land_with_a_mapped_use_stays_as_it_is(self):
        got = self.extract([{"building": "house"}, {"landuse": "railway"}],
                           [box(0, 0, 10, 10), box(-100, -100, 100, 100)])
        self.assertTrue("garden" not in got["areas"] or got["areas"]["garden"].area < 1)


class ShoulderTests(unittest.TestCase):
    def strips(self, hw="tertiary", guessed=True, share=0.0, bridge=False, houses=row(20)):
        return lanes.shoulders(lanes.Setting(houses, []), FakeKerbs(share), [STREET], [hw], [guessed],
                               [(3.0, 3.0)], [bridge], 0.5)

    def test_through_road_gets_gravel_beyond_each_kerb(self):
        left, right = self.strips()
        self.assertAlmostEqual(left.bounds[3], 3.0 + lanes.SHOULDER)
        self.assertAlmostEqual(right.bounds[1], -3.0 - lanes.SHOULDER)

    def test_other_roads_are_left_alone(self):
        self.assertEqual(self.strips(hw="residential"), [])
        self.assertEqual(self.strips(guessed=False), [])
        self.assertEqual(self.strips(share=0.8), [])
        self.assertEqual(self.strips(bridge=True), [])
        self.assertEqual(lanes.shoulders(lanes.Setting(row(20, big=True), []), FakeKerbs(0.0), [LineString([(0, 0), (8 * 34, 0)])],
                                         ["tertiary"], [True], [(3.0, 3.0)], [False], 0.5), [])


if __name__ == "__main__":
    unittest.main()
