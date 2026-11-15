import unittest

import numpy as np
from shapely.geometry import Polygon

import osm_area


class MoravkovaBuildingTests(unittest.TestCase):
    def extract(self, geoms=(), rows=()):
        return osm_area.extract(
            "praha", bbox=(14.597, 50.033, 14.598, 50.034),
            features=(np.array(geoms, dtype=object), rows), ground=False, buildings_only=True,
        )["buildings"]

    def test_registered_footprint_has_two_joined_roof_sections(self):
        sections = self.extract()
        self.assertEqual([b["name"] for b in sections], ["Morávkova 1685/8", "Morávkova 1685/10"])
        self.assertTrue(all(b["noIpr"] for b in sections))
        roofs = [Polygon(b["rings"][0]) for b in sections]
        self.assertTrue(roofs[0].touches(roofs[1]))
        self.assertAlmostEqual(roofs[0].union(roofs[1]).area, 115.92, delta=0.5)

    def test_existing_osm_footprint_supersedes_supplement(self):
        buildings = self.extract([Polygon(osm_area.MORAVKOVA_1685)],
                                 [{"element": "way", "id": 1, "building": "house"}])
        self.assertEqual([b["id"] for b in buildings], ["way/1"])
