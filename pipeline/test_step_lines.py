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
