import unittest

import numpy as np

from tin_tiles import scanned_road_dips


class ScannedRoadDips(unittest.TestCase):
    def setUp(self):
        y, x = np.indices((100, 120))
        self.scan = 205 + .015 * x - .01 * y
        self.road = np.abs(y - 50) < 8
        self.trough = np.maximum(0, 1 - np.abs(x - 60) / 15)

    def test_short_false_dip_on_a_sloping_road(self):
        weight = scanned_road_dips(self.scan - self.trough, self.scan, self.road, .5)
        self.assertEqual(weight[50, 60], 1)
        self.assertTrue(np.all(weight[~self.road] == 0))

    def test_scan_confirms_dip_or_never_meets_road(self):
        measured = self.scan - self.trough
        for base, scan in [(measured, measured), (self.scan - 1.2, self.scan)]:
            self.assertFalse(np.any(scanned_road_dips(base, scan, self.road, .5)))

    def test_missing_scan_cannot_anchor_a_repair(self):
        scan = self.scan.copy()
        scan[:, :60] = np.nan
        self.assertFalse(np.any(scanned_road_dips(self.scan - self.trough, scan, self.road, .5)))
