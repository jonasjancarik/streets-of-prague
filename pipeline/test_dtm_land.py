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
        dtm._parking_index = None

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

    def test_parking_is_the_surveyed_ground_level_car_parks(self):
        class Packages:
            def glob(self, pattern):
                return ["synthetic-package"]

        kinds = {
            "parking": (np.array([0, 1], dtype=np.int8), np.array([box(2, 2, 6, 5), box(20, 20, 25, 25)], dtype=object)),
        }
        with patch.object(dtm, "surfaces", return_value=kinds), patch.object(dtm, "PACKAGES", Packages()):
            got = dtm.parking((-1, -1, 8, 8), lambda x, y: (x, y))
            none = dtm.parking((100, 100, 108, 108), lambda x, y: (x, y))
        self.assertAlmostEqual(got.area, 12)  # the second one, on a deck, is left out
        self.assertTrue(none.is_empty)


if __name__ == "__main__":
    unittest.main()
