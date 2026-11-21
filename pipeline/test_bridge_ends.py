"""A bridge the survey has no deck for is as wide as the street on the ground it
carries on from, at each end (kerbs.bridge_ends), and its carriageway goes over from
one end's width to the other's (kerbs.tapered). The D0 over its slip road at Řepy was
10.75 m wide on its bridge and 14 m on the ground, with the deck showing between."""
import unittest

from shapely import LineString

from kerbs import bridge_ends, narrowest, tapered


class FakeKerbs:
    """Kerbs measured on the last metres of a street: (left, right) by where they lie."""

    def __init__(self, near):
        self.near = near

    def __call__(self, lines, ests):
        return [self.near(line) for line in lines]


class BridgeEnds(unittest.TestCase):
    def test_takes_the_kerbs_of_the_street_it_carries_on_from(self):
        south = LineString([(0, -100), (0, 0)])  # runs north into the bridge
        bridge = LineString([(0, 0), (0, 30)])
        north = LineString([(0, 130), (0, 30)])  # drawn the other way: its sides swap
        # Near the bridge the south street is 8 m to its left and 6 m to its right, the
        # north one (as drawn, heading south) 3 m to its left and 9 m to its right.
        kerbs = FakeKerbs(lambda piece: (8.0, 6.0) if piece.coords[0][1] < 0 else (3.0, 9.0))
        got = bridge_ends([south, bridge, north], kerbs, [{}] * 3, [False, True, False], [False, True, False])
        self.assertEqual(got, {1: ((8.0, 6.0), (9.0, 3.0))})
        # Its lanes keep to the narrower end on each side.
        self.assertEqual(narrowest((5.0, 5.0), got[1]), (8.0, 3.0))

    def test_leaves_a_surveyed_bridge_and_a_side_street(self):
        bridge = LineString([(0, 0), (0, 30)])
        side = LineString([(0, 0), (-50, 0)])  # at right angles: another street
        kerbs = FakeKerbs(lambda piece: (8.0, 8.0))
        self.assertEqual(bridge_ends([bridge, side], kerbs, [{}] * 2, [True, False], [True, False]), {})
        self.assertEqual(bridge_ends([bridge, side], kerbs, [{}] * 2, [True, False], [False, False]), {})

    def test_tapers_from_one_end_to_the_other(self):
        deck = tapered(LineString([(0, 0), (0, 40)]), (5.0, 5.0), ((8.0, 6.0), None))
        xs = lambda y: sorted({x for x, yy in deck.exterior.coords if abs(yy - y) < 1e-6})  # noqa: E731
        self.assertEqual(xs(0), [-8.0, 6.0])  # left of a line heading north is west
        self.assertEqual(xs(40), [-5.0, 5.0])
        self.assertAlmostEqual(deck.area, 40 * (14 + 10) / 2)


if __name__ == "__main__":
    unittest.main()
