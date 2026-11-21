"""How far the street's last metres before a bridge are brought up to it
(structures.abutment): out to where the ground comes within STEP of the street, not just
past the steepest rise. The D0's north-east end at Řepy comes off its bridge 6 m over a
slope that reaches the street 9 m on, and the street dipped 3 m into it."""
import unittest

import numpy as np

from structures import abutment


class Abutment(unittest.TestCase):
    def test_a_slope_up_to_the_street(self):
        # The ground climbs evenly from 332.5 at the end to 338.6 at 10 m and stays there.
        ground = lambda xs, ys: np.minimum(332.5 + 0.61 * np.asarray(xs, float), 338.6)  # noqa: E731
        height, far = abutment(ground, (0.0, 0.0), (1.0, 0.0), 332.5)
        self.assertAlmostEqual(height, 338.6)
        self.assertGreaterEqual(far, 9.0)

    def test_a_wall(self):
        # A quay wall 3 m on: the street is up there from the wall's edge.
        ground = lambda xs, ys: np.where(np.asarray(xs, float) < 3.0, 330.0, 336.0)  # noqa: E731
        height, far = abutment(ground, (0.0, 0.0), (1.0, 0.0), 330.0)
        self.assertEqual(height, 336.0)
        self.assertLessEqual(far, 4.0)

    def test_level_ground(self):
        ground = lambda xs, ys: np.full(len(xs), 336.0)  # noqa: E731
        self.assertEqual(abutment(ground, (0.0, 0.0), (1.0, 0.0), 336.0), (336.0, 0.0))


if __name__ == "__main__":
    unittest.main()
