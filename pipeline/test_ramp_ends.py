"""A short steep bridge's ends on IPR's deck (structures.ipr_ends): the slip road off
Jižní spojka over Vrbova, whose far end the map puts on the slope under the deck."""
import unittest

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString

import structures


def way():
    return {"pts": [(0.0, 0.0), (17.0, 0.0)], "w": 7.5}


def deck(top=203.0, fall=0.05):
    # IPR's deck along the way, the underside half a metre below it.
    return {(x, y): np.array([top - fall * x - 0.5, top - fall * x], dtype=np.float32) for x in range(18) for y in (-1, 0, 1)}


def ground(xs, ys):
    # Behind the first end the embankment at 203 m, down the slope to 197 m at the way's
    # first end; past the last, the slope back up to the street at 201.2 m.
    xs = np.asarray(xs, float)
    return np.where(xs <= 0, np.clip(197 - 2 * xs, 197, 203), np.clip(197 + 0.35 * (xs - 17), 197, 201.2))


class RampEndTests(unittest.TestCase):
    def test_ends_go_onto_ipr_and_the_street_is_brought_up(self):
        (h0, far0), (h1, far1) = structures.ipr_ends(way(), deck(), ground, [203.0, 197.0])
        self.assertAlmostEqual(h0, 203.0, delta=0.5)
        self.assertGreater(far0, 0)
        # (IPR's deck ends 1 m over the street: the end comes down to the street.)
        self.assertAlmostEqual(h1, 201.2, delta=0.01)
        self.assertGreater(far1, 10)

    def test_ipr_agreeing_with_neither_end_is_left_alone(self):
        self.assertIsNone(structures.ipr_ends(way(), deck(top=206.0), ground, [203.0, 197.0]))

    def test_a_street_across_the_ground_to_raise_keeps_it_down(self):
        # (A street crossing past the last end, as Ryšavého under Jižní spojka; the street
        # running on from the bridge is no reason.)
        lines = [LineString([(25.0, -20.0), (25.0, 20.0)])]
        self.assertIsNone(structures.ipr_ends(way(), deck(), ground, [203.0, 197.0], (STRtree(lines), lines)))
        lines = [LineString([(17.0, 0.0), (60.0, 0.5)])]
        self.assertIsNotNone(structures.ipr_ends(way(), deck(), ground, [203.0, 197.0], (STRtree(lines), lines)))

    def test_no_deck_along_it(self):
        self.assertIsNone(structures.ipr_ends(way(), {}, ground, [203.0, 197.0]))


class LevelLinkTests(unittest.TestCase):
    """A trunk link at Zlíchov, level on IPR's deck at 195 m along the top of a cutting.
    The terrain model has no wall there: both of the bridge's ends lie on the cutting's
    floor at 189 m, the street reaches the deck's height 6 m on from its north end (a
    wall the abutment rule sees) and only 16 m on from its south end (a slope)."""

    def ground(self, xs, ys, dry=False):
        xs = np.asarray(xs, float)
        north = np.where(xs < -6, 195.0, 189.0)
        return np.where(xs > 42, np.clip(189 + 0.4 * (xs - 42), 189, 195.2), north)

    def test_both_ends_go_onto_ipr_and_the_deck_is_level(self):
        ways = [{"id": 1, "kind": "bridge", "hw": "trunk_link", "w": 7.0, "layer": 1, "mapped_layer": None,
                 "nodes": [1, 2], "pts": [[0.0, 0.0], [42.0, 0.0]], "grade": [True, True], "on_ground": [True, True]}]
        decks = {(x, y): np.array([194.4, 195.2], dtype=np.float32) for x in range(-1, 44) for y in (-1, 0, 1)}
        _, ((s, h),) = structures.solve(ways, self.ground, decks)
        self.assertGreater(h.min(), 194.5)
        self.assertLess(h.max() - h.min(), 0.6)


if __name__ == "__main__":
    unittest.main()
