"""A car street on the ground takes the LiDAR's road (dtm_heights._scan_streets)."""

import unittest

import numpy as np
from shapely.geometry import LineString

import dtm_heights

STEP = 4.0


def _lattice(n=31):
    grid = np.zeros((n, n), dtype=np.float32)
    x_of = lambda i: -60 + np.asarray(i) * STEP  # noqa: E731
    y_of = lambda j: -60 + np.asarray(j) * STEP  # noqa: E731
    gj, gi = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    return grid, x_of, y_of, x_of(gi), y_of(gj)


def _scan(height):
    """The LiDAR as `(xy, reach) -> (lowest, highest)` from a function of x and y."""
    def at(xy, reach):
        z = height(xy[:, 0], xy[:, 1]).astype(np.float32)
        return z, z
    return at


STREET = [(LineString([(-50, 0), (50, 0)]), 5.0)]
SIDES = [(5.0, 5.0)]
FAR = lambda grid: np.full(grid.shape, np.inf, dtype=np.float32)  # noqa: E731
HERE = lambda grid: np.zeros(grid.shape, dtype=np.float32)  # noqa: E731


class ScanStreets(unittest.TestCase):
    def test_a_leaning_wavy_street_becomes_the_scan_s_road(self):
        # An east-west street climbing 1 m in 100 m. The lattice has it leaning (its
        # north edge 0.8 m up) with a wave along it; the scan has the road.
        grid, x_of, y_of, x, y = _lattice()
        on = np.abs(y) <= 6
        grid[:] = 30.0
        grid[on] = (10.5 + x / 100 + np.where(y > 0, 0.8, 0.0) + 0.4 * np.sin(x / 3))[on]
        done = dtm_heights._scan_streets(grid, on, STREET, SIDES, _scan(lambda px, py: 10.5 + px / 100), FAR(grid), HERE(grid), x_of, y_of, STEP)
        middle = on & (np.abs(x) <= 40)
        assert done[middle].all()
        assert np.abs(grid[middle] - (10.5 + x / 100)[middle]).max() < 0.05, np.abs(grid[middle] - (10.5 + x / 100)[middle]).max()
        # (The ground just past the kerbs is its shoulder; further out nothing moves.)
        assert np.abs(grid[(np.abs(y) == 8) & (np.abs(x) <= 40)] - (10.5 + x / 100)[(np.abs(y) == 8) & (np.abs(x) <= 40)]).max() < 0.05
        assert (grid[np.abs(y) >= 12] == 30.0).all()

    def test_a_point_past_the_kerb_on_a_bank_keeps_its_height(self):
        # North of the kerb the scan has a bank 3 m up; the surveyed surface reaches onto it.
        grid, x_of, y_of, x, y = _lattice()
        on = np.abs(y) <= 9
        grid[on] = 10.0
        grid[on & (y > 6)] = 13.0
        dtm_heights._scan_streets(grid, on, STREET, SIDES, _scan(lambda px, py: np.where(py > 6, 13.0, 10.0)), FAR(grid), HERE(grid), x_of, y_of, STEP)
        assert (grid[on & (y > 6)] == 13.0).all()
        assert np.abs(grid[on & (np.abs(y) <= 6) & (np.abs(x) <= 40)] - 10.0).max() < 0.05

    def test_up_to_a_bridge_the_scan_counts_as_far_as_it_is_unbroken(self):
        # A bridge at the street's west end, drawn 12 m too far east: the scan has the
        # road up to the abutment's edge at x = -38, and the ground 6 m below from there.
        grid, x_of, y_of, x, y = _lattice()
        on = np.abs(y) <= 6
        grid[on] = 20.0
        apart = np.abs(x + 50).astype(np.float32)
        dtm_heights._scan_streets(grid, on, STREET, SIDES, _scan(lambda px, py: np.where(px < -38, 13.0, 19.0)), apart, HERE(grid), x_of, y_of, STEP)
        assert np.abs(grid[on & (x >= -32) & (x <= 40)] - 19.0).max() < 0.05, grid[on & (x >= -32) & (x <= 40)]
        assert np.abs(grid[on & (x <= -40)] - 20.0).max() < 0.01, grid[on & (x <= -40)]

    def test_by_another_level_with_no_clear_stretch_the_survey_s_rules_stand(self):
        # A street wholly within SCAN_CLEAR of a deck's kerbs or a tunnel: the scan may be
        # the ground over or under it, and nothing says where it stops being the street.
        grid, x_of, y_of, x, y = _lattice()
        on = np.abs(y) <= 6
        grid[on] = 20.0
        dtm_heights._scan_streets(grid, on, STREET, SIDES, _scan(lambda px, py: np.full(len(px), 14.0)), np.full(grid.shape, 3.0, dtype=np.float32), HERE(grid), x_of, y_of, STEP)
        assert (grid[on] == 20.0).all()

    def test_a_street_beside_another_a_storey_up_keeps_its_own_height(self):
        # Two carriageways side by side, the north one 4 m up: no shoulder of one on the
        # other, and no blending across the wall between them.
        grid, x_of, y_of, x, y = _lattice()
        on = np.abs(y - 4) <= 10
        grid[on] = np.where(y > 4, 24.3, 19.7)[on]
        streets = [(LineString([(-50, 0), (50, 0)]), 4.0), (LineString([(-50, 8), (50, 8)]), 4.0)]
        dtm_heights._scan_streets(grid, on, streets, [(4.0, 4.0), (4.0, 4.0)], _scan(lambda px, py: np.where(py > 4, 24.0, 20.0)), FAR(grid), HERE(grid), x_of, y_of, STEP)
        middle = np.abs(x) <= 40
        assert np.abs(grid[middle & (y >= 8) & (y <= 12)] - 24.0).max() < 0.05, grid[middle & (y >= 8) & (y <= 12)]
        assert np.abs(grid[middle & (y >= -4) & (y <= 0)] - 20.0).max() < 0.05, grid[middle & (y >= -4) & (y <= 0)]

    def test_far_off_what_the_street_had_the_scan_needs_the_survey_to_bear_it_out(self):
        # The scan 5 m under the street: with a surveyed point near that the scan agrees
        # with it's the road (a pit the rules made); with none it's something else.
        for sure, height in ((0.0, 15.0), (np.inf, 20.0)):
            grid, x_of, y_of, x, y = _lattice()
            on = np.abs(y) <= 6
            grid[on] = 20.0
            dtm_heights._scan_streets(grid, on, STREET, SIDES, _scan(lambda px, py: np.full(len(px), 15.0)), FAR(grid),
                                      np.full(grid.shape, sure, dtype=np.float32), x_of, y_of, STEP)
            assert np.abs(grid[on & (np.abs(x) <= 40)] - height).max() < 0.05, (sure, grid[on].min())

    def test_no_scan_no_change(self):
        grid, x_of, y_of, x, y = _lattice()
        on = np.abs(y) <= 6
        grid[on] = 20.0
        done = dtm_heights._scan_streets(grid, on, STREET, SIDES, _scan(lambda px, py: np.full(len(px), np.nan)), FAR(grid), HERE(grid), x_of, y_of, STEP)
        assert not done.any() and (grid[on] == 20.0).all()


if __name__ == '__main__':
    unittest.main()
