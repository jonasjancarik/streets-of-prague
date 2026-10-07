"""Verges: narrow grass along a carriageway, and unmapped land the survey doesn't reach."""

import unittest

from shapely.geometry import LineString, Polygon, box

import verges


class StripTests(unittest.TestCase):
    road = box(0, -3, 200, 3)

    def test_a_narrow_band_beside_the_road_is_a_verge(self):
        got = verges.strips(box(0, 3, 200, 6), self.road)
        self.assertAlmostEqual(got.area, 600, delta=30)

    def test_a_lawn_beside_the_road_is_not(self):
        self.assertTrue(verges.strips(box(0, 3, 200, 60), self.road).is_empty)

    def test_a_strip_away_from_any_road_is_not(self):
        self.assertTrue(verges.strips(box(0, 20, 200, 23), self.road).is_empty)

    def test_the_strip_joined_to_a_lawn_is_cut_from_it(self):
        grass = box(0, 3, 100, 6).union(box(100, 3, 200, 60))
        got = verges.strips(grass, self.road)
        self.assertAlmostEqual(got.area, 300, delta=40)
        self.assertLess(got.bounds[2], 104)


class UnmappedTests(unittest.TestCase):
    clip = box(0, 0, 400, 200)
    road = box(0, 97, 400, 103)
    field = box(0, 110, 400, 200)

    def test_land_nobody_mapped_beside_a_country_road_is_verge(self):
        got = verges.unmapped(self.clip, [self.road, self.field], None, [], [])
        self.assertAlmostEqual(got.area, 400 * 97 + 400 * 7, delta=50)
        self.assertFalse(got.intersects(self.road.buffer(-0.5)))

    def test_not_where_the_survey_reaches(self):
        got = verges.unmapped(self.clip, [self.road, self.field], lambda x, y: x < 200, [], [])
        self.assertAlmostEqual(got.bounds[0], 200, delta=verges.CELL)
        self.assertTrue(verges.unmapped(self.clip, [self.road], lambda x, y: x < 1e9, [], []).is_empty)

    def test_a_yard_stays_paved_and_a_tagged_pavement_keeps_its_width(self):
        hall = box(100, 40, 140, 60)
        centre = LineString([(0, 100), (400, 100)])
        got = verges.unmapped(self.clip, [self.road, self.field, hall], None, [hall], [(centre, 3.0, 1)])
        self.assertFalse(got.intersects(hall.buffer(verges.YARD - 1)))
        self.assertFalse(got.intersects(box(10, 103.2, 390, 103 + verges.PAVEMENT - 0.2)))  # the left side: paved
        self.assertTrue(got.intersects(box(10, 96.5, 390, 96.9)))  # the right side has no pavement: grass to the road
        self.assertTrue(got.intersects(box(10, 105.5, 390, 109)))  # beyond the pavement: grass


if __name__ == "__main__":
    unittest.main()


class BrokenShapeTests(unittest.TestCase):
    def test_shapes_that_cross_themselves_are_joined_all_the_same(self):
        # (A full praha build stopped on such a mapped shape: "side location conflict".)
        bow = Polygon([(0, 0), (10, 10), (10, 0), (0, 10)])
        got = verges._union([bow, box(5, 0, 20, 10), box(30, 0, 40, 10)])
        self.assertGreater(got.area, 200)
        self.assertTrue(got.is_valid)
