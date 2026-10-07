"""Stairs on bridges with their own profile, and bridges over open water."""

import unittest

import numpy as np
from shapely.geometry import box

import structures


def way(ident, hw, nodes, pts, grade, kind="bridge", w=2.0):
    return {"id": ident, "kind": kind, "hw": hw, "w": w, "layer": 1, "mapped_layer": None, "nodes": nodes, "pts": pts,
            "grade": grade, "on_ground": grade}


class StairsTests(unittest.TestCase):
    """A footbridge 60 m long over a street, level at 200 m by IPR, and stairs off its
    east end folded back beside it down to the ground at 195 m."""

    def setUp(self):
        self.ways = [way(1, "footway", [1, 2], [[0, 0], [60, 0]], [True, False]),
                     way(2, "steps", [2, 21, 3], [[60, 0], [60, 3], [48, 3]], [False, False, True])]
        self.ground = lambda xs, ys, dry=False: np.where(np.asarray(xs) < 2, 200.0, 195.0)
        self.decks = {(x, y): np.array([200.0], dtype=np.float32) for x in range(0, 61) for y in range(-1, 2)}

    def build(self):
        tiles = {(0, 0): None}
        boxes = {(0, 0): box(-20, -100, 230, 150)}
        ramps = {}
        from unittest.mock import patch
        with patch.object(structures, "ipr_decks", return_value=self.decks):
            found = structures.build(self.ways, [], [], self.ground, "fixture", tiles, 62, 250, 250 / 62, -20, -100, boxes, ramps_out=ramps)
        return found, ramps

    def test_stairs_carry_the_drop_and_the_deck_stays_level(self):
        net, profiles = structures.solve(self.ways, self.ground, self.decks)
        soft = frozenset(self.ways[k]["id"] for k in structures.stairs(self.ways, profiles))
        self.assertEqual(soft, {2})
        net, profiles = structures.solve(self.ways, self.ground, self.decks, soft)
        deck, flight = profiles
        self.assertLess(abs(deck[1][-1] - 200.0), 0.3)  # the deck's last node, where the stairs begin
        self.assertAlmostEqual(flight[1][-1], 195.0, places=2)

    def test_stairs_have_a_profile_and_leave_the_lattice_to_the_deck(self):
        found, ramps = self.build()
        levels = {lv: h for lv, kind, h, _ in found[(0, 0)]}
        self.assertEqual(len(levels), 2)  # the stairs are 5 m under the deck beside them: a level of their own
        deck_level = max(levels, key=lambda lv: np.nanmax(levels[lv]) if np.isfinite(levels[lv]).any() else -1)
        deck = levels[deck_level]
        self.assertGreater(np.nanmin(deck), 199.5)  # nothing of the stairs in the deck's lattice
        (stairs_level, profiles), = [(lv, r) for lv, r in ramps[(0, 0)].items()]
        self.assertNotEqual(stairs_level, deck_level)
        self.assertFalse(np.isfinite(levels[stairs_level]).any())  # their own level has no lattice heights at all
        pts = np.array([q for r in profiles for q in r["pts"]])
        self.assertLess(abs(pts[:, 2].max() - 200.0), 0.3)
        self.assertAlmostEqual(pts[:, 2].min(), 195.0, places=1)

    def test_a_steep_footway_is_stairs_too_and_a_gentle_one_is_not(self):
        profiles = [(np.array([0.0, 60.0]), np.array([200.0, 200.0])), (np.array([0.0, 15.0]), np.array([200.0, 195.0]))]
        self.ways[1]["hw"] = "footway"
        self.assertEqual(structures.stairs(self.ways, profiles), [1])
        profiles[1] = (np.array([0.0, 15.0]), np.array([200.0, 199.0]))
        self.assertEqual(structures.stairs(self.ways, profiles), [])


class OverWaterTests(unittest.TestCase):
    """A bridge 300 m long between banks at 190 m over water at 187 m (x from 20 to 280)."""

    def ground(self, xs, ys, dry=False):
        xs = np.asarray(xs, float)
        wet = (xs > 20) & (xs < 280)
        return np.where(wet, np.nan if dry else 187.0, 190.0)

    def test_a_bridge_ipr_does_not_have_clears_the_water_away_from_the_banks(self):
        ways = [way(1, "tertiary", [1, 2], [[0, 0], [300, 0]], [True, True])]
        _, ((s, h),) = structures.solve(ways, self.ground, {})
        self.assertAlmostEqual(h[0], 190.0, places=2)
        self.assertAlmostEqual(float(np.interp(150, s, h)), 187.0 + structures.WATER_CLEAR, delta=0.1)
        self.assertLess(float(np.interp(30, s, h)), 190.0 + 30 * structures.WATER_SLOPE + 0.1)

    def test_a_measured_deck_stays_where_ipr_has_it_and_a_piers_footing_is_not_a_deck(self):
        ways = [way(1, "tertiary", [1, 2], [[0, 0], [300, 0]], [True, True])]
        low = {(x, 0): np.array([191.5], dtype=np.float32) for x in range(0, 301)}
        _, ((s, h),) = structures.solve(ways, self.ground, low)
        self.assertGreater(float(np.interp(150, s, h)), 187.0 + structures.WATER_CLEAR - 0.6)  # 4.5 m over the water mid-river: a pier's cap
        measured = {(x, 0): np.array([194.0], dtype=np.float32) for x in range(0, 301)}
        _, ((s, h),) = structures.solve(ways, self.ground, measured)
        self.assertAlmostEqual(float(np.interp(150, s, h)), 194.0, delta=0.1)

    def test_a_short_bridge_stays_low(self):
        ground = lambda xs, ys, dry=False: np.where((np.asarray(xs, float) > 2) & (np.asarray(xs) < 10), np.nan if dry else 187.0, 188.0)  # noqa: E731
        ways = [way(1, "footway", [1, 2], [[0, 0], [12, 0]], [True, True])]
        _, ((s, h),) = structures.solve(ways, ground, {})
        self.assertLess(h.max(), 188.6)

    def test_an_end_out_on_the_water_is_not_an_end_on_the_ground(self):
        ways = [way(1, "footway", [1, 2], [[0, 0], [150, 0]], [True, True])]
        _, ((s, h),) = structures.solve(ways, self.ground, {})
        self.assertGreater(h[-1], 189.9)  # not held down at the water's 187 m


class OutlineOnIprTests(unittest.TestCase):
    def test_an_outline_with_no_street_takes_iprs_top_whatever_its_ends_say(self):
        poly = box(0, 0, 100, 10)
        decks = {(x, y): np.array([186.0, 194.0], dtype=np.float32) for x in range(0, 101) for y in range(0, 11)}
        height = structures.own_profile(poly, lambda xs, ys: np.full(len(xs), 184.0), decks, None)
        np.testing.assert_allclose(height(np.array([50.0]), np.array([5.0])), 194.0)


if __name__ == "__main__":
    unittest.main()
