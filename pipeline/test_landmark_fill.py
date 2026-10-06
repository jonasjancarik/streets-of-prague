"""uv run --project pipeline python -m unittest discover -s pipeline -p test_landmark_fill.py"""
import unittest

import numpy as np

from landmark_fill import copy_along, dark_spots, push_pull

SIZE, CELL = 64, 0.05


def wall():
    """One upright wall, a texel for every 5 cm of it, each texel its own colour."""
    ty, tx = np.mgrid[0:SIZE, 0:SIZE]
    px = np.dstack((ty / SIZE, tx / SIZE, np.zeros((SIZE, SIZE)), np.ones((SIZE, SIZE)))).astype(np.float32)
    where = np.dstack((tx * CELL, np.zeros((SIZE, SIZE)), ty * CELL)).astype(np.float32)
    return px, np.zeros((SIZE, SIZE), np.int32), where, np.array([[0.0, -1.0, 0.0]])


class Fill(unittest.TestCase):
    def test_gap_at_the_foot_repeats_the_wall_above(self):
        px, face, where, normals = wall()
        gap = np.zeros((SIZE, SIZE), bool)
        gap[:10] = True
        before = px.copy()
        filled = copy_along(px, gap, ~gap, face, where, normals)
        self.assertTrue(filled[:10].all() and not filled[10:].any())
        for row in range(10):  # mirrored about the gap's edge: row 9 from row 10, row 0 from row 19
            np.testing.assert_allclose(px[row, :, :3], before[19 - row, :, :3])
        np.testing.assert_array_equal(px[10:], before[10:])

    def test_ragged_edge_is_evened_out(self):
        px, face, where, normals = wall()
        gap = np.zeros((SIZE, SIZE), bool)
        gap[:10] = True
        gap[:14, 30:34] = True  # a notch: its neighbours copy from above it too
        before = px.copy()
        copy_along(px, gap, ~gap, face, where, normals)
        self.assertAlmostEqual(float(px[13, 31, 0]), float(before[14, 31, 0]))
        self.assertAlmostEqual(float(px[9, 20, 0]), float(before[18, 20, 0]))  # edge taken as row 14 here as well

    def test_gap_at_the_top_and_whole_columns(self):
        px, face, where, normals = wall()
        gap = np.zeros((SIZE, SIZE), bool)
        gap[50:] = True
        gap[:, 5] = True  # nothing known in this column
        before = px.copy()
        filled = copy_along(px, gap, ~gap, face, where, normals)
        self.assertTrue(filled[gap].all())
        np.testing.assert_allclose(px[63, 20, :3], before[36, 20, :3])  # from below, mirrored about row 49/50
        np.testing.assert_allclose(px[20, 5, :3], before[20, 4, :3])   # from the column beside it

    def test_other_faces_and_small_gaps_are_left(self):
        px, face, where, normals = wall()
        face[:, 32:] = 1
        normals = np.array([[0.0, -1.0, 0.0], [0.0, -1.0, 0.0]])
        gap = np.zeros((SIZE, SIZE), bool)
        gap[:10, 32:] = True
        gap[0, 0] = True
        before = px.copy()
        filled = copy_along(px, gap, ~gap, face, where, normals)
        self.assertFalse(filled[0, 0])
        np.testing.assert_array_equal(px[:, :32], before[:, :32])
        np.testing.assert_allclose(px[0, 40, :3], before[19, 40, :3])

    def test_dark_spots_only_inside_and_only_dark(self):
        px, face, where, normals = wall()
        px[..., :3] = 0.4
        px[20:30, 20:30, :3] = 0.05   # dark, inside the spot
        px[50:60, 50:60, :3] = 0.05   # dark, outside it
        where[..., 1] = where[..., 2]  # lay the face flat: seen from above
        paint = dark_spots(px, face, where, np.ones((SIZE, SIZE), bool), [(25 * CELL, 25 * CELL, 0.6)], grow=1)
        self.assertTrue(paint[20:30, 20:30].all())
        self.assertFalse(paint[50:60, 50:60].any())
        self.assertFalse(paint[10, 10])
        self.assertTrue(paint[19, 25])  # grown by a texel

    def test_push_pull_keeps_known_texels(self):
        rgb = np.random.default_rng(1).random((8, 8, 3)).astype(np.float32)
        known = np.ones((8, 8), bool)
        known[2:4, 2:4] = False
        out = push_pull(rgb, known)
        np.testing.assert_allclose(out[known], rgb[known], rtol=1e-5)
        self.assertTrue(np.isfinite(out).all())


if __name__ == "__main__":
    unittest.main()
