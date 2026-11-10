"""A step's line gets each side's height where the scan says it is: a wall's top and foot,
a slope's own height, and none across a car street (step_lines.py)."""
import unittest

import numpy as np

import step_lines as sl

# A terrace 20 m square in a 250 m tile; the line runs along its outline.
BOX = (0.0, 0.0, 250.0, 250.0)
SQUARE = [{"label": 2, "polys": [[[(100, 100), (120, 100), (120, 120), (100, 120)]]]}]


def inside(xs, ys):
    return (xs > 100) & (xs < 120) & (ys > 100) & (ys < 120)


def lines_for(read, driven=None):
    return sl.for_tile(BOX, [], SQUARE, read, driven)


def heights_at(lines, x, y):
    """Each side's height at the line's point nearest (x, y), by label."""
    best = None
    for line in lines:
        for p in line["pts"]:
            d = (p[0] - x) ** 2 + (p[1] - y) ** 2
            if best is None or d < best[0]:
                best = (d, {line["l"]: p[2], line["r"]: p[3]})
    return best[1]


class CarriedInTests(unittest.TestCase):
    def test_wall_keeps_top_and_foot(self):
        # Flat on both sides, the scan blurring the 3 m wall across the line.
        top = sl._carried_in(np.full(len(sl.OUT), 203.0), 201.5)
        foot = sl._carried_in(np.full(len(sl.OUT), 200.0), 201.5)
        self.assertAlmostEqual(top, 203.0, places=2)
        self.assertAlmostEqual(foot, 200.0, places=2)

    def test_bank_rising_away_gets_no_pit(self):
        # Level for a metre from the line, then rising: carried in straight it would land
        # 3 m below the line's own height.
        bank = 263.4 + np.maximum(0, sl.OUT - 1.0) * 2.0
        self.assertAlmostEqual(sl._carried_in(bank, 263.4), 263.4, places=2)

    def test_battered_face_keeps_its_foot(self):
        # A face rising 4 m per metre right from the line: the line has its foot.
        face = 216.0 + sl.OUT * 4.0
        self.assertAlmostEqual(sl._carried_in(face, 216.0), 216.0, places=1)

    def test_nothing_read_takes_the_line(self):
        self.assertEqual(sl._carried_in(np.full(len(sl.OUT), np.nan), 214.6), 214.6)


class ForTileTests(unittest.TestCase):
    def test_terrace_wall(self):
        read = lambda xs, ys, label: np.where(inside(xs, ys), 203.0, 200.0)  # noqa: E731
        got = heights_at(lines_for(read), 110, 100)
        self.assertAlmostEqual(got[2], 203.0, places=1)
        self.assertAlmostEqual(got[0], 200.0, places=1)

    def test_hardly_a_step_is_level(self):
        read = lambda xs, ys, label: np.where(inside(xs, ys), 200.2, 200.0)  # noqa: E731
        got = heights_at(lines_for(read), 110, 100)
        self.assertEqual(got[2], got[0])

    def test_car_street_across_the_line_keeps_the_lattice(self):
        read = lambda xs, ys, label: np.where(inside(xs, ys), 203.0, 200.0)  # noqa: E731
        street = lambda xs, ys: (xs > 106) & (xs < 114)  # noqa: E731  a street crossing the south side
        got = heights_at(lines_for(read, street), 110, 100)
        self.assertIsNone(got[2])
        self.assertIsNone(got[0])
        # Along the west side, which no street crosses, the wall stays.
        west = heights_at(lines_for(read, street), 100, 110)
        self.assertAlmostEqual(west[2], 203.0, places=1)


if __name__ == "__main__":
    unittest.main()


class SidedTests(unittest.TestCase):
    def test_the_lattice_reader_takes_only_corners_on_the_reading_s_side(self):
        # One plain-ground tile: a street at 20 m west of x = 8, the low side at 10 m east
        # of it. A wall's line at x = 9.9 passes close by the street's last points; its
        # foot, read on the east side, is the low ground's, not a share of the street's.
        N, step = 4, 4.0
        arr = np.where(np.arange(N + 1)[None, :] * step <= 8, 20.0, 10.0).repeat(N + 1, axis=0)
        read = sl.lattice_reader({(0, 0): arr}, {}, N, N * step, step, 0.0, 0.0)
        xs, ys = np.array([9.9]), np.array([6.0])
        assert abs(read(xs, ys, 0)[0] - 15.25) < 0.01
        assert read(xs, ys, 0, away=(xs, ys, np.array([1.0]), np.array([0.0])))[0] == 10.0
        assert read(xs, ys, 0, away=(xs, ys, np.array([-1.0]), np.array([0.0])))[0] == 20.0

    def test_a_street_under_a_bridge_s_deck_crosses_no_line(self):
        # The carriageway is drawn up to where its bridge begins; under the deck it's the
        # bridge's, and a wall there keeps its heights.
        from shapely.geometry import LineString, box
        driven = sl.crossing([(LineString([(0, 0), (10, 0)]), 3.0)], [box(8, -5, 20, 5)])
        assert driven(np.array([5.0, 9.0, 15.0]), np.array([0.0, 0.0, 0.0])).tolist() == [True, False, False]
