"""Plan 018, phases 3 and 4: tidy ribbons, and the survey's pavements in their place."""

import unittest

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box

import pavements


def arr(*geoms):
    return np.array(geoms, dtype=object)


class Ribbons(unittest.TestCase):
    def test_a_path_that_ends_has_a_square_end(self):
        line = LineString([(0, 0), (10, 0)])
        got = pavements.ribbon(line, 1.5, pavements.joints([line]))
        self.assertAlmostEqual(got.area, 30.0, places=6)
        self.assertEqual(got.bounds, (0.0, -1.5, 10.0, 1.5))

    def test_ends_that_meet_are_rounded_and_corners_mitred(self):
        a, b = LineString([(0, 0), (10, 0)]), LineString([(10, 0), (10, 10)])
        meet = pavements.joints([a, b])
        got = shapely.union_all([pavements.ribbon(a, 1.5, meet), pavements.ribbon(b, 1.5, meet)])
        # No notch at the corner: the point just outside the two squares' ends is covered.
        self.assertTrue(got.contains(shapely.Point(10.9, -0.9)))
        self.assertEqual(pavements.ribbon(a, 1.5, meet).bounds[0], 0.0)  # the free end stays square
        bent = pavements.ribbon(LineString([(0, 0), (10, 0), (10, 10)]), 1.5, {})
        self.assertTrue(bent.contains(shapely.Point(11.4, -1.4)))  # a mitred corner, not a round one

    def test_tidy_closes_a_narrow_gap_but_not_over_a_road(self):
        a, b = box(0, 0, 20, 2), box(0, 2.6, 20, 4.6)
        got = pavements.tidy(shapely.union_all([a, b]), [])
        self.assertEqual(len(shapely.get_parts(got)), 1)
        self.assertAlmostEqual(got.area, 20 * 4.6, delta=0.5)
        road = box(8, -5, 12, 10)
        kept = pavements.tidy(shapely.union_all([a, b]), [road])
        self.assertLess(kept.intersection(box(8, 2, 12, 2.6)).area, 0.01)
        self.assertGreater(kept.intersection(box(0, 2, 8, 2.6)).area, 4.0)

    def test_tidy_keeps_a_wide_gap_drops_crumbs_and_spare_points(self):
        a, b = box(0, 0, 20, 2), box(0, 3.5, 20, 5.5)
        crumb = box(40, 40, 41, 41)
        wavy = Polygon([(0, 20), (5, 20.05), (10, 20), (15, 20.05), (20, 20), (20, 23), (0, 23)])
        got = pavements.tidy(shapely.union_all([a, b, crumb, wavy]), [])
        self.assertEqual(len(shapely.get_parts(got)), 3)
        self.assertFalse(got.intersects(crumb))
        self.assertEqual(shapely.get_num_coordinates(got.intersection(box(-1, 19, 21, 24))), 5)


class Surveyed(unittest.TestCase):
    def setUp(self):
        # A street 6 m wide along x, a pavement 4 m deep on each side, an island in it.
        self.street = box(0, -3, 100, 3).difference(box(40, -1, 50, 1))
        self.north, self.south = box(0, 3, 100, 7), box(0, -7, 100, -3)
        self.island = box(40, -1, 50, 1)
        self.bed = box(0, 20, 100, 26)
        self.walks = {"pavement": arr(self.north, self.south), "island": arr(self.island), "trambed": arr(self.bed)}
        self.clip = box(-10, -50, 110, 50)

    def test_paving_comes_from_the_footways_and_spreads_to_the_untagged(self):
        ways = [(LineString([(0, 5), (100, 5)]), "asphalt", False), (LineString([(0, -5), (100, -5)]), None, False)]
        stats = {}
        paved, walked = pavements.surveyed(self.walks, self.street, ways, Polygon(), Polygon(), self.clip, stats)
        # The untagged pavement and the island are paved like the nearest tagged one.
        self.assertEqual(set(paved), {"pavement_asphalt", "trambed"})
        # (With the bit past each end of the street, where both stop on one line.)
        self.assertAlmostEqual(paved["pavement_asphalt"].area, 820, delta=4)
        self.assertAlmostEqual(paved["trambed"].area, 600, delta=1)
        self.assertFalse(walked.intersects(self.bed))
        self.assertEqual((stats["surveyed_pavement_m2"], stats["surveyed_island_m2"], stats["surveyed_trambed_m2"]), (800, 20, 600))

    def test_mosaic_without_tags_and_setts_only_in_a_walking_street(self):
        paved, _ = pavements.surveyed(self.walks, self.street, [], Polygon(), Polygon(), self.clip)
        self.assertEqual(set(paved), {"pavement", "trambed"})
        ways = [(LineString([(0, 5), (100, 5)]), "sett", True), (LineString([(0, -5), (100, -5)]), "sett", False)]
        paved, _ = pavements.surveyed(self.walks, self.street, ways, Polygon(), Polygon(), self.clip)
        self.assertAlmostEqual(paved["sett"].area, 400, delta=1)  # the walking street
        self.assertAlmostEqual(paved["pavement"].area, 420, delta=4)  # a cobbled pavement is mosaic; the island too

    def test_gaps_at_the_kerb_are_pavement_but_a_tree_pit_and_a_square_are_not(self):
        street = box(0, -3, 100, 2.8)  # misses the northern pavement by 20 cm
        pit = box(20, 4, 21.5, 5.5)
        walks = {"pavement": arr(self.north.difference(pit), self.south)}
        paved, walked = pavements.surveyed(walks, street, [], box(60, 0, 80, 10), pit, self.clip)
        self.assertTrue(walked.contains(box(1, 2.85, 99, 2.95)))
        self.assertFalse(paved["pavement"].intersects(pit.buffer(-0.1)))
        self.assertLess(paved["pavement"].intersection(box(60, 0, 80, 10)).area, 0.01)
        self.assertTrue(walked.intersects(box(61, 4, 79, 6)))  # the footway's ribbon still goes there

    def test_nothing_surveyed(self):
        self.assertEqual(pavements.surveyed({}, Polygon(), [], Polygon(), Polygon(), self.clip), ({}, Polygon()))


class Ribbon_replacement(unittest.TestCase):
    def test_ribbons_on_the_survey_go_and_the_rest_stay(self):
        walked = box(0, 3, 100, 7)
        way = lambda line: pavements.ribbon(line, 1.5, {})  # noqa: E731
        ways = [
            (way(LineString([(0, 4), (100, 4)])), "path", None, True, False),  # the pavement's own line, half over the kerb
            (way(LineString([(50, 5), (50, 60)])), "path", None, True, False),  # a path leaving it through a park
            (way(LineString([(0, 4), (100, 4)])), "bridge", None, False, False),  # a footbridge above it
            (way(LineString([(0, 40), (100, 40)])), "dirt", None, True, False),  # nowhere near
        ]
        got = pavements.without_survey(ways, [True, False, False, False], walked)
        self.assertEqual([cls for _, cls, *_ in got], ["path", "bridge", "dirt"])
        park = got[0][0]
        self.assertAlmostEqual(park.bounds[1], 7.5, places=6)  # starts just past the pavement's edge
        self.assertAlmostEqual(park.area, 3 * 52.5, delta=0.1)
        self.assertEqual(got[1][0].area, ways[2][0].area)
        self.assertEqual(got[2][0].area, ways[3][0].area)

    def test_a_pavement_line_mostly_off_the_survey_keeps_its_ribbon_there(self):
        walked = box(0, 3, 30, 7)
        ribbon = pavements.ribbon(LineString([(0, 5), (100, 5)]), 1.5, {})
        got = pavements.without_survey([(ribbon, "path", None, True, False)], [True], walked)
        self.assertEqual(len(got), 1)
        self.assertAlmostEqual(got[0][0].area, 3 * 69.5, delta=0.1)


if __name__ == "__main__":
    unittest.main()
