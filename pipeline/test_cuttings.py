"""A short underpass the terrain model shows in an open cutting (structures.cuttings)."""

import unittest

import numpy as np

import structures


def tunnel(ident, pts, w=7.0):
    return {"id": ident, "kind": "tunnel", "hw": "tertiary", "w": w, "pts": pts}


def street(ident, pts, width=10.0):
    return {"id": ident, "hw": "primary", "width": width, "pts": pts}


def trench(depth):
    # Ground at 240 m with a trench 20 m wide along y = 0, `depth` deep.
    return lambda xs, ys: 240.0 - depth * (np.abs(np.asarray(ys, float)) < 10)


class Cuttings(unittest.TestCase):
    def test_street_over_a_trench_goes_on_a_bridge_and_the_underpass_on_the_ground(self):
        dropped, bridges = structures.cuttings([tunnel(1, [[-20, 0], [20, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, trench(6))
        self.assertEqual(dropped, {1})
        self.assertEqual(len(bridges), 1)
        b = bridges[0]
        self.assertTrue(b["cut"])
        self.assertEqual(b["kind"], "bridge")
        ys = [p[1] for p in b["pts"]]
        # From where the ground is back at the street's height on one side to the other.
        self.assertLess(min(ys), -10)
        self.assertGreater(max(ys), 10)
        self.assertLess(max(ys) - min(ys), 30)

    def test_tunnel_under_the_ground_stays(self):
        dropped, bridges = structures.cuttings([tunnel(1, [[-20, 0], [20, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, trench(0.5))
        self.assertEqual((dropped, bridges), (set(), []))

    def test_street_going_down_past_a_portal_stays(self):
        # The street drops 6 m across the tunnel: a slope, not a street over a cutting.
        def slope(xs, ys):
            return 240.0 - 6.0 * (np.asarray(ys, float) > 0)
        dropped, _ = structures.cuttings([tunnel(1, [[-20, 0], [20, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, slope)
        self.assertEqual(dropped, set())

    def test_long_tunnel_stays(self):
        dropped, _ = structures.cuttings([tunnel(1, [[-200, 0], [200, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, trench(6))
        self.assertEqual(dropped, set())

    def test_street_over_it_is_on_the_bridge_for_that_stretch(self):
        ways = [{"kind": "bridge", "level": 1, "cut": True, "pts": [[0, -15], [0, 15]]}]
        on = structures.OnLevels(ways, {})
        self.assertEqual(on.over_cutting({"pts": [[0, -60], [0, 60]]}), [[0.0, 0], [45.0, 1], [75.0, 0]])
        self.assertIsNone(on.over_cutting({"pts": [[30, -60], [30, 60]]}))
        self.assertIsNone(on.over_cutting({"bridge": True, "pts": [[0, -60], [0, 60]]}))
        # (the underpass's street, crossing under it)
        self.assertIsNone(on.over_cutting({"pts": [[-60, 0], [60, 0]]}))


if __name__ == "__main__":
    unittest.main()
