"""Hedges and fences between gardens stay with the gardens (plots.py)."""

import unittest

from shapely.geometry import Polygon, box

import plots


def between(fences, x=40):
    """The pieces of fence or hedge that stand on the line the two plots share."""
    return [f for f in fences if all(abs(px - x) < 0.2 for px, _ in f["pts"])]


class PlotFenceTests(unittest.TestCase):
    green = box(-100, -100, 200, 200)
    street = Polygon()
    mapped = Polygon()

    def fences(self, a, b, ids):
        recs = plots.layout([(ids[0], box(0, 0, 40, 60)), (ids[1], box(40, 0, 80, 60))],
                            [(ids[0], a), (ids[1], b)], [("house", a), ("house", b)], self.street)
        return plots.fences(recs, self.green, self.street, self.mapped)

    def test_neighbours_with_houses_close_by_get_one_between_their_gardens(self):
        # (Whether a pair has a hedge, a fence or nothing comes from their ids.)
        near = [self.fences(box(30, 25, 38, 35), box(42, 25, 50, 35), (i, i + 1000)) for i in range(40)]
        self.assertTrue(any(between(f) for f in near))

    def test_houses_far_apart_have_nothing_between_them_across_the_lawn(self):
        for i in range(40):
            self.assertEqual(between(self.fences(box(2, 25, 10, 35), box(70, 25, 78, 35), (i, i + 1000))), [], i)

    def test_a_hedge_stops_within_reach_of_its_house(self):
        for i in range(40):
            for f in self.fences(box(30, 5, 38, 15), box(42, 5, 50, 15), (i, i + 1000)):
                for _, y in f["pts"]:
                    self.assertLessEqual(y, 15 + plots.GARDEN + 0.5)


if __name__ == "__main__":
    unittest.main()
