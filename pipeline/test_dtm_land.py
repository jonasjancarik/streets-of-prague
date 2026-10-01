"""DTM ground classes stay separate from kerb-level street surfaces."""

import unittest
from unittest.mock import patch

import numpy as np
from shapely.geometry import box

import dtm


class DtmLandTests(unittest.TestCase):
    def tearDown(self):
        dtm._index = None
        dtm._land_index = None

    def test_ground_land_excludes_decks_and_streets(self):
        class Packages:
            def glob(self, pattern):
                return ["synthetic-package"]

        kinds = {
            "road": (np.array([0], dtype=np.int8), np.array([box(0, 0, 1, 1)], dtype=object)),
            "yard": (np.array([0, 1], dtype=np.int8), np.array([box(2, 2, 3, 3), box(4, 4, 5, 5)], dtype=object)),
            "green": (np.array([0], dtype=np.int8), np.array([box(6, 6, 7, 7)], dtype=object)),
        }
        with patch.object(dtm, "surfaces", return_value=kinds), patch.object(dtm, "PACKAGES", Packages()):
            street = dtm.streets((-1, -1, 8, 8), lambda x, y: (x, y))
            land = dtm.land((-1, -1, 8, 8), lambda x, y: (x, y))
        self.assertLess(street.bounds[2], 2)
        self.assertEqual(set(land), {"yard", "green"})
        self.assertAlmostEqual(land["yard"].area, 1)
        self.assertAlmostEqual(land["green"].area, 1)
        self.assertEqual(land["yard"].bounds, (2, 2, 3, 3))


if __name__ == "__main__":
    unittest.main()
