import unittest

import numpy as np

from landmark_crowns import TAU, join_rings, ring, st_nicholas


def tower(x, levels, sides):
    angles = np.arange(sides) * TAU / sides
    directions = np.column_stack((np.cos(angles), np.sin(angles)))
    rows = [ring(np.array([x, 0.0]) + directions * radius, y) for y, radius in levels[:-1]]
    out = []
    for a, b in zip(rows, rows[1:]):
        out.extend(join_rings(a, angles, b, angles))
    tip = [x, levels[-1][0], 0]
    out.extend([p, tip, rows[-1][(i + 1) % sides]] for i, p in enumerate(rows[-1]))
    return np.asarray(out)


class LandmarkCrowns(unittest.TestCase):
    def test_seam_winds_outwards_with_different_survey_and_city_rings(self):
        lo = np.array([0, .24, 1.2, 1.95, 3.4, 4.5, 5.9])
        hi = np.arange(12) * TAU / 12
        lower = ring(np.column_stack((np.cos(lo), np.sin(lo))), 2)
        upper = ring(np.column_stack((np.cos(hi), np.sin(hi))) * .95, 3)
        tri = np.array(list(join_rings(lower, lo, upper, hi)))
        self.assertEqual(len(tri), len(lo) + len(hi))
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        self.assertTrue((np.sum(n[:, [0, 2]] * tri.mean(1)[:, [0, 2]], axis=1) > 0).all())

    def test_only_the_two_tower_tops_change(self):
        dome = tower(0, [(20, 9), (68, 9), (82, 0)], 12)
        bell = tower(20, [(20, 5), (68, 5), (80, 0)], 8)
        nave = np.array([[[-38, 18, 0], [-36, 41, 4], [-30, 18, 6]]])
        clean = np.concatenate((dome, bell, nave))
        scan = np.concatenate((
            tower(0, [(20, 9), (66, 9), (75, 4), (79, 2), (81, 2.6), (84, .7), (89, 0)], 32),
            tower(20, [(20, 5), (68, 5), (74, 2), (78, 2.6), (82, .7), (87, 0)], 32),
        ))
        fitted, start = st_nicholas(clean, scan)
        self.assertGreater(start, 55)
        self.assertTrue(np.isfinite(fitted).all())
        self.assertTrue(np.any(np.all(fitted == nave[0], axis=(1, 2))))
        for x, apex in [(0, 89), (20, 87)]:
            near = fitted[abs(fitted[:, :, 0].mean(1) - x) < 10]
            self.assertAlmostEqual(near[:, :, 1].max(), apex)
