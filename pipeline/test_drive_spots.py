"""Places for a car on a house's drive (osm_area._drive_spots)."""

import math
import unittest

from shapely.geometry import Polygon, box

from osm_area import _drive_spots


class DriveSpotsTests(unittest.TestCase):
    street = box(-20, -1.5, 60, 1.5)  # the street's edge, as _gardens buffers it

    def spots(self, *houses, plot=box(0, 1, 20, 30)):
        homes = [(k, h) for k, h in enumerate(houses)]
        return _drive_spots([(0, plot)], homes, list(houses), self.street)

    def test_a_car_stands_inside_the_gate_facing_the_house(self):
        [spot] = self.spots(box(6, 14, 14, 22))
        self.assertAlmostEqual(spot["h"], math.pi / 2, delta=0.2)  # house is "up" the plot from the street
        self.assertTrue(1 < spot["y"] < 6)
        self.assertTrue(0 < spot["x"] < 20)

    def test_a_house_close_to_the_street_has_no_room_for_one(self):
        self.assertEqual(self.spots(box(6, 5, 14, 12)), [])

    def test_a_footprint_that_crosses_itself_does_not_stop_the_chunk(self):
        # Two such buildings sharing a crossing point: joining them as they are raises
        # in GEOS (seen in praha on 5 October 2026).
        bow = Polygon([(30, 14), (38, 22), (38, 14), (30, 22)])
        tie = Polygon([(34, 10), (42, 18), (42, 10), (34, 18)])
        house = box(6, 14, 14, 22)
        homes = [(0, house)]
        got = _drive_spots([(0, box(0, 1, 20, 30))], homes, [house, bow, tie], self.street)
        self.assertEqual(len(got), 1)

    def test_a_plot_away_from_the_street_gets_none(self):
        self.assertEqual(self.spots(box(6, 14, 14, 22), plot=box(0, 10, 20, 40)), [])


if __name__ == "__main__":
    unittest.main()
