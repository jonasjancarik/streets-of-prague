import unittest

from shapely.geometry import LineString, Point, box

from street_lighting import BY_BUILDINGS, BY_LAMP, BY_LINK, DARK, LINK, TAGGED, lighting


def lit_at(runs, x, y):
    """The flag of the stretch through a point (None: no stretch there)."""
    for flag, pts in runs:
        if LineString(pts).distance(Point(x, y)) < 0.5:
            return flag
    return None


class StreetLightingTest(unittest.TestCase):
    def test_built_up_untagged_street_is_lit(self):
        # Houses along the first 200 m of a kilometre of road; fields after that.
        houses = [box(x, 8, x + 12, 18) for x in range(0, 200, 30)]
        runs, metres = lighting([(None, "residential", [(0, 0), (1000, 0)])], houses, [])
        self.assertEqual(lit_at(runs, 100, 0), BY_BUILDINGS)
        self.assertIsNone(lit_at(runs, 600, 0), "the road beyond the houses stays dark")
        self.assertLess(metres[BY_BUILDINGS], 300)
        self.assertGreater(metres[None], 650)

    def test_a_shed_is_not_a_building(self):
        runs, _ = lighting([(None, "residential", [(0, 0), (300, 0)])], [box(100, 5, 105, 10)], [])
        self.assertEqual(runs, [])

    def test_lamp_nearby_lights_an_untagged_street(self):
        runs, _ = lighting([(None, "residential", [(0, 0), (400, 0)])], [], [(200, 30)])
        self.assertEqual(lit_at(runs, 200, 0), BY_LAMP)
        self.assertIsNone(lit_at(runs, 320, 0))

    def test_road_between_fields_stays_dark(self):
        runs, metres = lighting([(None, "tertiary", [(0, 0), (2000, 0)]), (None, "unclassified", [(1000, 0), (1000, 900)])], [], [])
        self.assertEqual(runs, [])
        self.assertAlmostEqual(metres[None], 2900, delta=1)

    def test_tagged_dark_stays_dark_among_houses_and_lamps(self):
        houses = [box(x, 8, x + 12, 18) for x in range(0, 300, 30)]
        runs, metres = lighting([(0, "residential", [(0, 0), (300, 0)])], houses, [(150, 5)])
        self.assertEqual({f for f, _ in runs}, {DARK})
        self.assertAlmostEqual(metres[DARK], 300, delta=1)

    def test_island_is_joined_to_the_nearest_lit_street(self):
        # A row of houses 200 m up a side road from a lit main street; another lit street
        # further away the other way (400 m), which the lights don't carry on to.
        ways = [
            (1, "secondary", [(-300, 0), (0, 0), (300, 0)]),
            (None, "residential", [(0, 0), (0, 200), (0, 300), (0, 700)]),
            (1, "tertiary", [(-300, 700), (0, 700), (300, 700)]),
        ]
        houses = [box(8, y, 20, y + 12) for y in (210, 240, 270)]
        runs, metres = lighting(ways, houses, [])
        self.assertEqual(lit_at(runs, 0, 250), BY_BUILDINGS)
        self.assertEqual(lit_at(runs, 0, 100), BY_LINK, "the way down to the main street is lit")
        self.assertIsNone(lit_at(runs, 0, 500), "the longer way to the other street is not")
        self.assertEqual(lit_at(runs, 100, 0), TAGGED)
        self.assertLessEqual(metres[BY_LINK], LINK)

    def test_island_too_far_from_anything_stays_alone(self):
        ways = [(1, "secondary", [(-300, 0), (0, 0), (300, 0)]), (None, "residential", [(0, 0), (0, 1000)])]
        runs, metres = lighting(ways, [box(8, 600, 25, 615)], [])
        self.assertEqual(lit_at(runs, 0, 610), BY_BUILDINGS)
        self.assertIsNone(lit_at(runs, 0, 300), "a lone farm doesn't light the road to the village")
        self.assertNotIn(BY_LINK, metres)

    def test_no_link_along_a_street_tagged_dark(self):
        ways = [(1, "secondary", [(-300, 0), (0, 0), (300, 0)]), (0, "residential", [(0, 0), (0, 150)]), (None, "residential", [(0, 150), (0, 400)])]
        runs, metres = lighting(ways, [box(8, 200, 25, 215)], [])
        self.assertEqual(lit_at(runs, 0, 75), DARK)
        self.assertNotIn(BY_LINK, metres)

    def test_trunk_roads_are_left_to_their_tags(self):
        runs, _ = lighting([(None, "trunk", [(0, 0), (300, 0)])], [box(100, 8, 120, 20)], [(50, 10)])
        self.assertEqual(runs, [])


if __name__ == "__main__":
    unittest.main()
