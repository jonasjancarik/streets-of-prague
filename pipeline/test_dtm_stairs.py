import unittest

import numpy as np
import shapely
from shapely.geometry import Polygon

from dtm_stairs import heights, treads


def flight(length, width, rise, z0=200.0):
    """A straight flight climbing along x, its outline with heights at the corners."""
    poly = Polygon([(0, 0), (length, 0), (length, width), (0, width)])
    edges = np.array([shapely.LineString([(0, 0, z0), (length, 0, z0 + rise)]),
                      shapely.LineString([(length, 0, z0 + rise), (length, width, z0 + rise)]),
                      shapely.LineString([(length, width, z0 + rise), (0, width, z0)]),
                      shapely.LineString([(0, width, z0), (0, 0, z0)])], dtype=object)
    return poly, heights(poly, edges, shapely.STRtree(edges))


class TreadsTest(unittest.TestCase):
    def test_straight_flight_has_even_treads_across_it(self):
        poly, ring = flight(6.0, 2.0, 1.6)
        got, noses = treads(poly, ring)
        self.assertEqual(len(got), 10)  # 1.6 m at 0.16 m a step
        tops = [h for h, _ in got]
        np.testing.assert_allclose(np.diff(tops), 0.16, atol=1e-6)
        self.assertAlmostEqual(tops[-1], 201.6)
        # Cut straight across: every tread spans the flight's width.
        for _, p in got:
            x0, y0, x1, y1 = p.bounds
            self.assertAlmostEqual(y1 - y0, 2.0, places=2)
        self.assertEqual(len(noses), 9)
        self.assertAlmostEqual(sum(p.area for _, p in got), 12.0, places=1)

    def test_a_sill_is_not_a_flight(self):
        poly, ring = flight(3.0, 2.0, 0.05)
        self.assertEqual(treads(poly, ring), ([], []))

    def test_too_steep_for_its_treads_is_left_out(self):
        # 3 m up over 2 m: treads 0.13 m deep, the way it climbs is misread.
        poly, ring = flight(2.0, 6.0, 3.0)
        self.assertEqual(treads(poly, ring), ([], []))


if __name__ == "__main__":
    unittest.main()
