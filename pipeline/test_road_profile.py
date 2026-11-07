"""The fit keeps real grade and banking, and never trains on its check stations."""
import unittest

import numpy as np

from road_profile import fit_profile


class RoadProfileTest(unittest.TestCase):
    def samples(self, held_out_delta=0.0):
        out = []
        for k in range(50):
            s = k + 0.5
            height = 234 - 0.06 * s + 0.0001 * s * s
            if k % 4 == 1:
                height += held_out_delta
            if k == 20:  # A single misplaced kerb observation.
                out.append((k, s, [-5, height + 0.1 + 0.9], [5, height - 0.1]))
            else:
                out.append((k, s, [-5, height + 0.1], [5, height - 0.1]))
        return out

    def test_robust_fit_preserves_grade_and_banking(self):
        fit, count = fit_profile(50, self.samples())
        self.assertEqual(count, 37)
        np.testing.assert_allclose(fit, fit_profile(50, self.samples(50))[0])
        s = np.linspace(0, 1, 20)
        np.testing.assert_allclose(np.polynomial.polynomial.polyval(s, fit[:4]),
                                   234 - 3 * s + 0.25 * s**2, atol=0.02)
        self.assertAlmostEqual(fit[4], -0.02, delta=0.002)

    def test_rejects_a_long_gap_or_unmodelled_banking(self):
        samples = self.samples()
        with self.assertRaisesRegex(ValueError, "unmeasured stretch"):
            fit_profile(50, samples[:12] + samples[27:])
        for _, _, left, right in samples:
            left[1] += 0.5
            right[1] -= 0.5
        with self.assertRaisesRegex(ValueError, "banking"):
            fit_profile(50, samples)
