"""DTM ground classes stay separate from kerb-level street surfaces."""

import unittest
from unittest.mock import patch

import numpy as np
from shapely.geometry import box

import dtm


class DtmLandTests(unittest.TestCase):
    def setUp(self):
        # Another test's build may have left the indexes filled in this process.
        dtm._index = None
        dtm._land_index = None
        dtm._parking_index = None
        dtm._raised_index = None

    tearDown = setUp

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

    def test_a_raised_carriageway_is_a_ground_streets_surface(self):
        # 5. května over Pražského povstání station: the survey has the carriageway on a
        # deck (level 2) and green on the ground under it, OSM the street on the ground.
        import osm_area
        from shapely.geometry import LineString

        class Packages:
            def glob(self, pattern):
                return ["synthetic-package"]

        kinds = {
            "road": (np.array([0, 2, 1], dtype=np.int8),
                     np.array([box(0, 0, 10, 40), box(0, 40, 10, 70), box(30, 40, 70, 45)], dtype=object)),
            "green": (np.array([0], dtype=np.int8), np.array([box(0, 40, 10, 70)], dtype=object)),
        }
        with patch.object(dtm, "surfaces", return_value=kinds), patch.object(dtm, "PACKAGES", Packages()):
            raised = dtm.raised((-1, -1, 80, 80), lambda x, y: (x, y))
        self.assertEqual(len(raised), 2)  # the ground's carriageway isn't raised
        # The street runs 30 m along the first deck and only crosses the second.
        street = [LineString([(5, 0), (5, 70)]), LineString([(50, 30), (50, 60)])]
        deck = osm_area._deck(raised, street)
        self.assertAlmostEqual(deck.area, 300)
        self.assertEqual(deck.bounds, (0, 40, 10, 70))
        self.assertTrue(osm_area._deck(raised, []).is_empty)

    def test_a_box_is_worked_out_once_and_kept_until_the_map_changes(self):
        import tempfile
        from pathlib import Path

        kinds = {"road": (np.array([0], dtype=np.int8), np.array([box(0, 0, 4, 4)], dtype=object))}
        with tempfile.TemporaryDirectory() as tmp:
            packages = Path(tmp) / "ZPS"
            packages.mkdir()
            (packages / "a.zip").write_bytes(b"one")
            frame = lambda x, y: (x, y)
            with patch.object(dtm, "PACKAGES", packages), patch.object(dtm, "BOXES", Path(tmp) / "boxes"), \
                    patch.object(dtm, "surfaces", return_value=kinds) as read:
                first = dtm.streets((-1, -1, 8, 8), frame)
                dtm._index = dtm._land_index = dtm._parking_index = None
                again = dtm.streets((-1, -1, 8, 8), frame)
                self.assertEqual(read.call_count, 1)  # the second came from the kept box
                self.assertTrue(first.equals(again))
                dtm.streets((-1, -1, 9, 9), frame)  # another box
                self.assertEqual(read.call_count, 2)
                (packages / "a.zip").write_bytes(b"another month")
                dtm._index = dtm._land_index = dtm._parking_index = None
                dtm.streets((-1, -1, 8, 8), frame)
                self.assertEqual(read.call_count, 3)


if __name__ == "__main__":
    unittest.main()
