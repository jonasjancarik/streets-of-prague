"""The road fit's bending penalty (road_fit.build_penalty): a street may climb and lean
at any steady rate for free, bending along it costs more than the same bending across,
and at a junction it costs the same whichever way it runs."""
import base64
import unittest

import numpy as np
import shapely

import road_fit


def grid(n=9):
    idx = np.arange(n * n).reshape(n, n)
    y, x = np.mgrid[0:n, 0:n].astype(float)
    return idx, x, y


def cost(P, z):
    r = P @ z.ravel()
    return float(r @ r)


class RoadFitPenaltyTests(unittest.TestCase):
    def setUp(self):
        self.idx, self.x, self.y = grid()
        n = self.idx.shape
        # Every cell on a street running east–west.
        self.along_x = road_fit.build_penalty(self.idx, np.ones(n), np.zeros(n), np.zeros(n, bool))
        self.junction = road_fit.build_penalty(self.idx, np.ones(n), np.zeros(n), np.ones(n, bool))

    def test_a_steady_climb_and_lean_cost_nothing(self):
        plane = 0.08 * self.x - 0.03 * self.y + 240
        self.assertAlmostEqual(cost(self.along_x, plane), 0, places=9)
        self.assertAlmostEqual(cost(self.junction, plane), 0, places=9)

    def test_bending_along_the_street_costs_more_than_across(self):
        # A wider grid, so the cells on its rim (bent either way at the junction weight) count less.
        idx, x, y = grid(21)
        n = idx.shape
        P = road_fit.build_penalty(idx, np.ones(n), np.zeros(n), np.zeros(n, bool))
        self.assertGreater(cost(P, 0.05 * (x - 10) ** 2), 20 * cost(P, 0.05 * (y - 10) ** 2))

    def test_a_junction_has_no_favourite_direction(self):
        self.assertAlmostEqual(cost(self.junction, 0.05 * (self.x - 4) ** 2),
                               cost(self.junction, 0.05 * (self.y - 4) ** 2), places=9)

    def test_a_cut_cell_parts_the_two_sides(self):
        idx = self.idx.copy()
        idx[:, 4] = -1
        idx[idx >= 0] = np.arange(np.count_nonzero(idx >= 0))
        n = idx.shape
        P = road_fit.build_penalty(idx, np.ones(n), np.zeros(n), np.zeros(n, bool))
        # A step at the cut: each side flat at its own height.
        z = np.where(self.x < 4, 240.0, 242.0)[idx >= 0]
        r = P @ z
        self.assertAlmostEqual(float(r @ r), 0, places=9)


class WallTests(unittest.TestCase):
    def test_a_point_by_a_wall_takes_its_height_from_its_own_side(self):
        # A wall along x = 5 between a street at 240 m and a terrace at 243 m (2 m cells).
        y, x = np.mgrid[0:6, 0:6].astype(float) * road_fit.CELL
        Z = np.where(x < 5, 240.0, 243.0)
        wall = shapely.linestrings([[5, -5], [5, 15]])
        px, py = np.array([4.6, 5.4, 1.0]), np.array([5.0, 5.0, 5.0])
        gi, gj = px / road_fit.CELL, py / road_fit.CELL
        i, j = np.floor(gi).astype(int), np.floor(gj).astype(int)
        h = road_fit.node_heights(Z, 0.0, 0.0, px, py, i, j, gi - i, gj - j, wall)
        np.testing.assert_allclose(h, [240, 243, 240])
        # Without the wall the point by it blends both sides.
        h = road_fit.node_heights(Z, 0.0, 0.0, px, py, i, j, gi - i, gj - j, None)
        self.assertGreater(h[0], 240.5)


class PackTests(unittest.TestCase):
    def test_packed_heights_come_back_where_the_game_reads_them(self):
        y, x = np.mgrid[0:12, 0:15].astype(float)
        h = 240 + 0.5 * x + 3 * np.sin(y) + 30 * (x > 12)  # a 40 m range: steps under a mm
        weights = np.zeros(h.shape, np.uint8)
        weights[2:8, 2:9] = 255
        packed = road_fit.pack_heights(h, weights)
        dq = np.frombuffer(base64.b64decode(packed["data"]), "<i2").reshape(h.shape)
        q = np.cumsum(dq.astype(np.int64), axis=1)
        q = ((q + 32768) % 65536) - 32768  # the reader wraps round at 16 bits too
        back = packed["base"] + q * packed["step"]
        used = np.zeros(h.shape, bool)
        used[1:9, 1:10] = True
        self.assertLess(np.abs(back - h)[used].max(), packed["step"])
        self.assertTrue((back[~used] == packed["base"]).all())


if __name__ == "__main__":
    unittest.main()
