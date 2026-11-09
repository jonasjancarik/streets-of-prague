"""A car street is level from kerb to kerb (dtm_heights._level_across)."""

import unittest

import numpy as np
from shapely.geometry import LineString

import dtm_heights


def _lattice(step=4.0, n=31):
    grid = np.zeros((n, n), dtype=np.float32)
    x_of = lambda i: -60 + np.asarray(i) * step  # noqa: E731
    y_of = lambda j: -60 + np.asarray(j) * step  # noqa: E731
    return grid, x_of, y_of


def _kerb(x0, x1, y, z0, z1, spacing=1.5):
    x = np.arange(x0, x1 + 0.01, spacing)
    return np.column_stack([x, np.full(len(x), y), np.interp(x, [x0, x1], [z0, z1])])


class LevelAcross(unittest.TestCase):
    def test_hillside_street_is_level_across(self):
        # An east-west street 10 m wide climbing 1 m in 100 m; its north kerb 0.8 m above
        # its south one (a hillside). Every point across it gets the two kerbs' mean.
        grid, x_of, y_of = _lattice()
        points = np.vstack([_kerb(-50, 50, 5, 10.8, 11.8), _kerb(-50, 50, -5, 10.0, 11.0)])
        gj, gi = np.meshgrid(np.arange(grid.shape[0]), np.arange(grid.shape[1]), indexing="ij")
        on = np.abs(y_of(gj)) <= 6
        grid[on] = np.where(y_of(gj[on]) > 0, 10.8, 10.0)  # leaning, as the nearest kerb had it
        dtm_heights._level_across(grid, on, points, [(LineString([(-50, 0), (50, 0)]), 5.0)], x_of, y_of, 4.0)
        middle = (np.abs(x_of(gi)) <= 40) & on
        for i in np.unique(gi[middle]):
            across = grid[:, i][on[:, i]]
            assert np.ptp(across) < 0.01, across
            assert abs(across[0] - (10.4 + (x_of(i) + 50) / 100)) < 0.05

    def test_street_passing_underneath_is_not_taken(self):
        # A street 6 m lower crosses under the middle, its kerbs right along the upper one's.
        grid, x_of, y_of = _lattice()
        points = np.vstack([_kerb(-50, 50, 5, 20.0, 20.0), _kerb(-50, 50, -5, 20.0, 20.0),
                            _kerb(-6, 6, 4, 14.0, 14.0), _kerb(-6, 6, -4, 14.0, 14.0)])
        gj, gi = np.meshgrid(np.arange(grid.shape[0]), np.arange(grid.shape[1]), indexing="ij")
        on = np.abs(y_of(gj)) <= 6
        grid[on] = 20.0
        dtm_heights._level_across(grid, on, points, [(LineString([(-50, 0), (50, 0)]), 5.0)], x_of, y_of, 4.0)
        assert np.abs(grid[on] - 20.0).max() < 0.05

    def test_kerbs_crossing_under_a_wide_street_s_end_are_not_taken(self):
        # 5. května before its bridge over Hvězdova: the carriageway is wider than the map
        # says, so its own kerbs are out of reach, and the only kerb points in reach are
        # those of the street in the cutting, crossing 6 m down under its end.
        grid, x_of, y_of = _lattice()
        y = np.arange(-6, 6.01, 1.5)
        below = np.column_stack([np.full(len(y), 30.5), y, np.full(len(y), 14.0)])
        points = np.vstack([_kerb(-50, 30, 12, 20.0, 20.0), _kerb(-50, 30, -12, 20.0, 20.0), below])
        gj, gi = np.meshgrid(np.arange(grid.shape[0]), np.arange(grid.shape[1]), indexing="ij")
        on = (np.abs(y_of(gj)) <= 6) & (x_of(gi) <= 26)  # (the last points are under the bridge)
        grid[on] = 20.0
        dtm_heights._level_across(grid, on, points, [(LineString([(-50, 0), (30, 0)]), 4.0)], x_of, y_of, 4.0)
        assert np.abs(grid[on] - 20.0).max() < 0.05, grid[on].min()

    def test_a_kerb_a_little_off_the_street_s_own_points_still_counts(self):
        # A kerb half a metre over what the lattice has (a surface that took the other
        # kerb's height) is the street's own.
        grid, x_of, y_of = _lattice()
        points = np.vstack([_kerb(-50, 50, 5, 10.5, 10.5), _kerb(-50, 50, -5, 10.0, 10.0)])
        gj, gi = np.meshgrid(np.arange(grid.shape[0]), np.arange(grid.shape[1]), indexing="ij")
        on = np.abs(y_of(gj)) <= 6
        grid[on] = 10.0
        dtm_heights._level_across(grid, on, points, [(LineString([(-50, 0), (50, 0)]), 5.0)], x_of, y_of, 4.0)
        middle = (np.abs(x_of(gi)) <= 40) & on
        assert np.abs(grid[middle] - 10.25).max() < 0.05


if __name__ == '__main__':
    unittest.main()
