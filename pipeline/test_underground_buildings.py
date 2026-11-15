"""Buildings OSM tags location=underground aren't drawn or solid above the street.

Seen at the main station: the passage under the forecourt (way 275405377) stood as a
10.5 m box beside the magistrála, as IPR's model has nothing there.
"""
import unittest

import numpy as np
from shapely.geometry import box

import osm_area


class UndergroundBuildingTests(unittest.TestCase):
    def test_underground_buildings_are_left_out(self):
        geoms = np.array([box(14.4001, 50.0801, 14.4003, 50.0803),
                          box(14.40035, 50.0801, 14.4004, 50.0803),
                          box(14.4001, 50.08035, 14.4003, 50.0804)], dtype=object)
        rows = [{"element": "way", "id": 1, "building": "house"},
                {"element": "way", "id": 2, "building": "transportation", "location": "underground",
                 "layer": "-1", "building:levels": "0"},
                {"element": "way", "id": 3, "building": "train_station", "location": "surface"}]
        got = osm_area.extract("ujezd", bbox=(14.4, 50.08, 14.4005, 50.0805), centre=(14.40025, 50.08025),
                               features=(geoms, rows), ground=False, buildings_only=True)
        self.assertEqual(sorted(b["id"] for b in got["buildings"]), ["way/1", "way/3"])


if __name__ == "__main__":
    unittest.main()
