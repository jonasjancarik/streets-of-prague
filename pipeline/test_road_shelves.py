"""An independent low surface can support a shelf. Real banks do not qualify."""

import unittest

import numpy as np
from shapely.geometry import LineString

from road_shelves import shelf_samples


class ShelfEvidenceTest(unittest.TestCase):
    line = LineString([(0, 0), (50, 0)])

    @staticmethod
    def lidar(x, y):
        return np.where(y > 9, 210, 201)

    @staticmethod
    def coarse(points):
        return 201 + np.clip(points[:, 1] - 3, 0, 9)

    def test_detects_lower_strip_on_one_side(self):
        result = shelf_samples(self.coarse, self.lidar, self.line, 3.5)
        self.assertIsNotNone(result)
        self.assertEqual(result[2], 1)
        self.assertGreater(result[1], 4)

    def test_rejects_same_bank_and_disagreeing_road_level(self):
        self.assertIsNone(shelf_samples(self.coarse, lambda x, y: self.coarse(np.column_stack((x, y))), self.line, 3.5))
        self.assertIsNone(shelf_samples(lambda p: self.coarse(p) + 5, self.lidar, self.line, 3.5))
