"""The terrain model's triangles onto the lattice (ipr_terrain.rasterise)."""
import unittest

import numpy as np

import ipr_terrain


class RasteriseTests(unittest.TestCase):
    def test_a_plane_lands_on_the_lattice_as_it_is(self):
        # Two triangles make a 10 m square sloping 1 m a metre east and 2 m north.
        sq = np.array([[[0, 0, 0], [10, 0, 10], [10, 10, 30]], [[0, 0, 0], [10, 10, 30], [0, 10, 20]]], float)
        grid = np.full((5, 5), np.nan)
        ipr_terrain.rasterise(sq, -1.0, -1.0, 5, 5, 4.0, grid)
        xs, ys = np.meshgrid(-1 + np.arange(5) * 4.0, -1 + np.arange(5) * 4.0)
        inside = (xs >= 0) & (xs <= 10) & (ys >= 0) & (ys <= 10)
        self.assertTrue(np.allclose(grid[inside], (xs + 2 * ys)[inside]))
        self.assertTrue(np.isnan(grid[~inside]).all())

    def test_where_triangles_overlap_the_later_one_counts(self):
        tri = np.array([[0, 0, 0], [8, 0, 0], [0, 8, 0]], float)
        grid = np.full((3, 3), np.nan)
        ipr_terrain.rasterise(np.array([tri + [0, 0, 1], tri + [0, 0, 2]]), 0.0, 0.0, 3, 3, 4.0, grid)
        self.assertEqual(grid[0, 0], 2.0)


if __name__ == "__main__":
    unittest.main()
