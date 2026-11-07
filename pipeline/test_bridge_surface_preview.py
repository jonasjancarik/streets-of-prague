"""A ramp may lose spurious cover, while a surveyed higher deck stays intact."""

import unittest

import numpy as np
import shapely
from shapely.geometry import Point, box as rectangle

from bridge_footprints import connect_outline
from bridge_surface_preview import ramp_cuts
from road_profile import polygons


class RampCoverTest(unittest.TestCase):
    def test_separates_ramp_without_cutting_surveyed_overpass(self):
        class Tile:
            key = "0_0"
            box = rectangle(0, 0, 48, 20)
            levels = {1: (rectangle(0, 1, 48, 5), None), 2: (rectangle(0, 0, 48, 15), None)}
            raw = {"drive": [
                dict(id="ramp", level=1, hw="primary_link", width=4, pts=[[0, 3], [48, 3]]),
                dict(id="road", level=2, hw="primary", width=6, pts=[[0, 10], [48, 10]]),
            ]}

            def height(self, level, _x, _y):
                return 200 if level == 1 else 205

        measured = {(x, y): np.array([200, 205] if 19 <= x <= 28 else [200])
                    for x in range(49) for y in range(8)}
        [(_, level, rings, _)] = ramp_cuts([Tile()], measured)
        self.assertEqual(level, 2)
        trimmed = shapely.union_all(polygons(rings))
        self.assertFalse(trimmed.covers(Point(12, 3)))
        self.assertTrue(trimmed.covers(Point(24, 3)))
        self.assertTrue(trimmed.covers(Point(12, 10)))

    def test_continuous_outline_replaces_the_remnants_and_preserves_ends(self):
        main = rectangle(0, 0, 12, 100)
        extra = rectangle(12, 35, 19, 65)
        old = main.union(extra)
        surveyed = rectangle(.5, 0, 11.5, 100)
        restored = connect_outline(old, surveyed, extra, (-5, 0, 30, 100))
        self.assertEqual(restored.geom_type, "Polygon")
        self.assertFalse(restored.interiors)
        self.assertFalse(restored.covers(Point(14, 52)))
        for ends in (rectangle(-5, 0, 30, 20), rectangle(-5, 80, 30, 100)):
            self.assertTrue(restored.intersection(ends).equals(old.intersection(ends)))
        broken = surveyed.difference(rectangle(-1, 45, 13, 55))
        self.assertIsNone(connect_outline(old, broken, extra, (-5, 0, 30, 100)))
