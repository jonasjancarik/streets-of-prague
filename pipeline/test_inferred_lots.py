"""Paving used for parking that OSM doesn't map as a car park (osm_area._inferred_lots)."""

import unittest

from shapely.geometry import LineString, box

from osm_area import _inferred_lots


def building(x0, y0, x1, y1):
    return {"rings": [list(box(x0, y0, x1, y1).exterior.coords)]}


class InferredLotsTests(unittest.TestCase):
    def lots(self, parking=box(0, 0, 0, 0), yards=(), mapped=(), buildings=(), drivable=(), natural=box(0, 0, 0, 0),
             car_lines=(LineString([(-50, -1), (80, -1)]),)):
        return _inferred_lots(parking, list(yards), [{"o": None, "poly": p} for p in mapped], list(buildings),
                              list(drivable), natural, list(car_lines), box(-200, -200, 200, 200))

    def test_surveyed_parking_beside_a_street_becomes_an_inferred_lot(self):
        got = self.lots(parking=box(0, 0, 30, 14))
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["i"], 1)
        self.assertGreater(got[0]["poly"].area, 350)

    def test_footprints_that_cross_themselves_do_not_stop_the_chunk(self):
        # Joining these two as they are raises in GEOS (praha, 5 October 2026).
        bow = {"rings": [[(100, 14), (108, 22), (108, 14), (100, 22), (100, 14)]]}
        tie = {"rings": [[(104, 10), (112, 18), (112, 10), (104, 18), (104, 10)]]}
        got = self.lots(parking=box(0, 0, 30, 14), buildings=[bow, tie])
        self.assertEqual(len(got), 1)

    def test_mapped_car_parks_and_their_surroundings_are_not_doubled(self):
        self.assertEqual(self.lots(parking=box(0, 0, 30, 14), mapped=[box(-1, -1, 31, 15)]), [])

    def test_narrow_strips_and_small_patches_are_left_out(self):
        self.assertEqual(self.lots(parking=box(0, 0, 40, 3)), [])
        self.assertEqual(self.lots(parking=box(0, 0, 6, 6)), [])

    def test_car_ways_and_buildings_are_cut_out(self):
        road = LineString([(-10, 7), (50, 7)]).buffer(3)
        got = self.lots(parking=box(0, 0, 30, 14), drivable=[road], car_lines=[LineString([(-10, 7), (50, 7)])])
        self.assertEqual(got, [])  # what is left either side of the road is under 4.4 m wide
        wide = self.lots(parking=box(0, 0, 30, 30), buildings=[building(0, 0, 30, 10)],
                         car_lines=[LineString([(-50, 8), (80, 8)])])
        self.assertEqual(len(wide), 1)
        self.assertEqual(wide[0]["poly"].intersection(box(0, 0, 30, 10)).area, 0)

    def test_no_car_way_near_means_no_lot(self):
        self.assertEqual(self.lots(parking=box(0, 0, 30, 14), car_lines=[LineString([(-50, 60), (80, 60)])]), [])

    def test_work_yards_are_kept_unless_buildings_close_them_in(self):
        self.assertEqual(len(self.lots(yards=[box(0, 0, 30, 14)])), 1)
        courtyard = [building(-8, -8, 38, 0), building(-8, 14, 38, 22), building(-8, 0, 0, 14), building(30, 0, 38, 14)]
        self.assertEqual(self.lots(yards=[box(0, 0, 30, 14)], buildings=courtyard), [])
        # ...but a surveyed car park in the same place stays
        self.assertEqual(len(self.lots(parking=box(0, 0, 30, 14), buildings=courtyard)), 1)


if __name__ == "__main__":
    unittest.main()
