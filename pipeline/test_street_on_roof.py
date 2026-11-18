"""A street mapped a layer up but not as a bridge runs on the roof of the building under it.

Seen at the main station: Wilsonova (layer 1) runs over the hall (relation 4257415, a
7 m building on the ground), which stood solid across its six lanes; cars stuck at its
edges both ways (players' reports of 13 and 16 November 2026).
"""
import unittest
from unittest.mock import patch

import numpy as np
import shapely
from shapely.geometry import LineString, box

import osm_area

BBOX, CENTRE = (14.4, 50.08, 14.4005, 50.0805), (14.40025, 50.08025)
HALL = box(14.4001, 50.0801, 14.4004, 50.0804)  # about 21 by 33 m
ACROSS = LineString([(14.40025, 50.0799), (14.40025, 50.0806)])  # north to south through its middle


def buildings(street_tags, building_tags=None, streets=(ACROSS,)):
    geoms = np.array([HALL, *streets], dtype=object)
    rows = [{"element": "relation", "id": 1, "building": "train_station", **(building_tags or {})},
            *({"element": "way", "id": 2 + k, **street_tags} for k in range(len(streets)))]
    got = osm_area.extract("ujezd", bbox=BBOX, centre=CENTRE, features=(geoms, rows), ground=False, buildings_only=True)
    return [shapely.Polygon(b["rings"][0], b["rings"][1:]) for b in got["buildings"]]


class StreetOnRoofTests(unittest.TestCase):
    def test_a_street_a_layer_up_cuts_its_carriageway_out(self):
        got = buildings({"highway": "primary", "layer": "1", "width": "8"})
        self.assertEqual(len(got), 2)  # one either side of the street
        whole = buildings({"highway": "primary", "width": "8"})[0]  # (on the ground: through the building, as mapped)
        cx, cy = whole.centroid.x, whole.centroid.y
        self.assertFalse(any(p.contains(shapely.Point(cx, cy)) for p in got))
        self.assertTrue(all(p.distance(shapely.Point(cx, cy)) >= 3.9 for p in got))
        self.assertAlmostEqual(sum(p.area for p in got), whole.area - 8 * (whole.bounds[3] - whole.bounds[1]), delta=2)

    def test_the_median_between_its_carriageways_goes_too(self):
        # Two carriageways 8 m wide, 11 m apart between their middles: a median 3 m wide
        # between them, which stood as a strip of the hall 7 m high (ROOF_GAP).
        west, east = (LineString([(x, 50.0799), (x, 50.0806)]) for x in (14.40018, 14.400334))
        street = {"highway": "primary", "layer": "1", "width": "8"}
        self.assertEqual(buildings(street, streets=(west, east)), [])
        with patch.object(osm_area, "ROOF_GAP", 0.0):
            median = buildings(street, streets=(west, east))
        self.assertEqual(len(median), 1)
        self.assertAlmostEqual(median[0].bounds[2] - median[0].bounds[0], 3.0, delta=0.5)  # (local metres)

    def test_bridges_tunnels_service_roads_and_raised_buildings_are_left_whole(self):
        for street, building in (({"highway": "primary", "layer": "1", "bridge": "yes"}, None),
                                 ({"highway": "primary", "layer": "-1", "tunnel": "yes"}, None),
                                 ({"highway": "primary"}, None),
                                 # Rooftop car parks: their aisles are mapped a layer up on the roof itself.
                                 ({"highway": "service", "layer": "1"}, None),
                                 ({"highway": "primary", "layer": "1"}, {"min_height": "5"}),
                                 ({"highway": "primary", "layer": "1"}, {"layer": "2"})):
            with self.subTest(street=street, building=building):
                self.assertEqual(len(buildings(street, building)), 1)


if __name__ == "__main__":
    unittest.main()
