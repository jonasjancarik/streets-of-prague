"""The pads of a dual carriageway's two bridges at one end are joined over the ground
between them (structures.twin_pads): at Řepy the D0's twin bridges have the slip road
below showing between their decks, and in front of the deck's end the ground between
the carriageways sank into a pit with the pads' walls round it."""
import unittest

from shapely import box
from shapely.ops import unary_union

from structures import twin_pads

OUT = (0, -1)  # the bridges are north of y = 20 and the streets run on south


def pad(x0, x1, y0, h=338.6, u=OUT, lip=0.0):
    """A pad on the ground from y0 to the bridge's end at y = 20, with a lip under it."""
    ground = box(x0, y0, x1, 20)
    return (box(x0, y0, x1, 20 + lip), h, u, ground, ((x0 + x1) / 2, y0), ((x0 + x1) / 2, 20 + lip))


def joined(pads, *args, **kw):
    (both, _), = twin_pads(pads, *args, **kw)
    return both


class TwinPads(unittest.TestCase):
    def test_joins_two_carriageways_at_one_end(self):
        (both, height), = twin_pads([pad(-14, -3, 0), pad(3, 14, 0, h=338.8)])  # 6 m of median, 0.2 m higher
        self.assertAlmostEqual(height, 338.7)
        self.assertTrue(both.contains(box(-3, 0, 3, 20)))

    def test_keeps_apart_what_isnt_twin(self):
        a = pad(-14, -3, 0)
        far = pad(20, 30, 0)  # 23 m away
        lower = pad(3, 14, 0, h=338.2)  # 0.4 m lower
        across = pad(3, 23, 10, u=(1, 0))  # a street at right angles
        for other in (far, lower, across):
            self.assertEqual(twin_pads([a, other]), [(a[0], a[1]), (other[0], other[1])])

    def test_leaves_the_street_passing_under_clear(self):
        under = box(-1, -5, 1, 25)
        both = joined([pad(-14, -3, 0), pad(3, 14, 0)], lambda area, h: under)
        self.assertFalse(both.intersects(box(-0.9, 0, 0.9, 20)))
        self.assertTrue(both.contains(box(-3, 0, -1.1, 20)))

    def test_stays_out_from_under_the_decks(self):
        # The decks begin along a skewed abutment: the left one at y = 22, the right one
        # at y = 12, each with a 2 m lip. Between the lips is the deck.
        left = (box(-14, 0, -3, 22), 338.6, OUT, box(-14, 0, -3, 20), (-8.5, 0), (-8.5, 22))
        right = (box(3, 0, 14, 12), 338.6, OUT, box(3, 0, 14, 10), (8.5, 0), (8.5, 12))
        both = joined([left, right])
        self.assertTrue(both.contains(box(-3, 0, 3, 13.9)))  # to 2 m past the shorter lip's end
        self.assertFalse(both.intersects(box(-2, 14.5, 2, 21.5)))

    def test_leaves_a_carriageway_past_its_pad_at_its_own_height(self):
        # The right pad is 10 m long, the left 20 m: south of y = 10 the right
        # carriageway runs on at its own height, and the median beside it is joined.
        roads = [box(-13, -50, -4, 30), box(4, -50, 13, 30)]
        runs = lambda area, h: unary_union([r for r in roads if r.intersects(area)])  # noqa: E731
        both = joined([pad(-14, -3, 0), pad(3, 14, 10)], runs=runs)
        self.assertTrue(both.contains(box(-2.9, 5, 3.9, 20)))
        self.assertFalse(both.intersects(box(4.1, 0, 12.9, 9.9)))
        self.assertTrue(both.contains(box(-14, 0, -3, 20)))  # the left pad stays whole

    def test_joins_only_over_a_pit(self):
        pads = [pad(-14, -3, 0), pad(3, 14, 0)]
        level = lambda xs, ys: [338.4] * len(xs)  # noqa: E731
        pit = lambda xs, ys: [334.2 if abs(x) < 3 else 338.4 for x in xs]  # noqa: E731
        self.assertEqual(len(twin_pads(pads, ground=level)), 2)  # nothing to fill: left as they were
        self.assertEqual(len(twin_pads(pads, ground=pit)), 1)


if __name__ == "__main__":
    unittest.main()
