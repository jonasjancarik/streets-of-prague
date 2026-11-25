"""A street mapped a layer up but not as a bridge runs on the roof of the building under it.

Seen at the main station: Wilsonova (layer 1) runs over the hall (relation 4257415, a
7 m building on the ground), which stood solid across its six lanes; cars stuck at its
edges both ways (players' reports of 13 and 16 November 2026).
"""
import unittest
from copy import deepcopy
from unittest.mock import patch

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, box

import osm_area
import wilsonova

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
    def test_upper_span_keeps_the_lightwell_lower_route_and_other_bridge(self):
        crs = "+proj=tmerc +lon_0=14.43 +lat_0=50.08 +ellps=WGS84"
        project = Transformer.from_crs(4326, crs, always_xy=True).transform
        ways = []
        for lon in (14.43378948, 14.43402378):
            x, y = project(lon, 50.081955)
            ways.append({"level": 1, "cut": True, "pts": [[x-2, y-5], [x+2, y+5]]})
        crossing = wilsonova.StationCrossing(crs, ways)
        old = [osm_area._rings(LineString(w["pts"]).buffer(2)) for w in ways]
        x, y = crossing.outline.bounds[:2]
        unrelated = osm_area._rings(box(x-20, y-20, x-15, y-15))
        lower = {"name": None, "hw": "service", "pts": ways[0]["pts"]}
        tile = {"box": crossing.outline.buffer(25).bounds, "walk": [], "drive": [lower.copy()],
                "structures": [{"kind": "bridge", "level": 1, "polys": [*old, unrelated]}]}
        crossing.fit(tile)
        fitted, = tile["structures"]
        self.assertEqual(tile["drive"], [lower])
        self.assertEqual(len(fitted["polys"]), 2)
        self.assertIn(unrelated, fitted["polys"])
        top = shapely.Polygon(fitted["polys"][-1][0], fitted["polys"][-1][1:])
        self.assertEqual(len(top.interiors), 1)
        road = shapely.union_all([shapely.Polygon(r[0], r[1:]) for r in fitted["deckSurface"]["road"]])
        self.assertLess(road.difference(top).area, .5)
        again = deepcopy(tile)
        crossing.fit(again)
        self.assertEqual(again, tile)

    def test_station_roof_has_two_continuous_carriageways_and_a_clear_median(self):
        to_local = Transformer.from_crs(4326, "+proj=tmerc +lon_0=14.43 +lat_0=50.08 +ellps=WGS84", always_xy=True)
        deck, median = wilsonova.surfaces(to_local.transform)
        clip = deck.envelope.buffer(10)
        # A transverse pavement, parking bay and path from the entrance below.
        roads = {"pavement": clip, "path": clip}
        areas = {"parking": clip}
        lots = wilsonova.upper_road(roads, areas, [{"poly": clip, "o": None}], clip, to_local.transform)
        self.assertEqual(len(osm_area._polys(roads["road"])), 2)
        self.assertLess(deck.difference(roads["road"].union(roads["pavement_asphalt"])).area, 1)
        self.assertLess(median.intersection(roads["road"]).area, 1)
        for layer in (roads["pavement"], roads["path"], areas["parking"], lots[0]["poly"]):
            self.assertLess(layer.intersection(deck).area, 1)
            self.assertGreater(layer.area, 0)

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
