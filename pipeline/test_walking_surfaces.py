"""Drawn walking surfaces must not change routes, kerbs or other ground levels."""

import unittest
from unittest.mock import patch

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box

from osm_area import AREAS, _ground_level, _walking_surfaces, extract


class WalkingSurfaceTests(unittest.TestCase):
    def surface(self, tag=None, cls="path", at_ground=True, areas=None):
        geom = LineString([(-10, 5), (30, 5)]).buffer(1.5)
        got = list(_walking_surfaces([(geom, cls, tag, at_ground, False)],
                                     areas or {"square_setts": [box(0, 0, 20, 10)]}))
        return geom, got[0][1] if got else Polygon()

    def test_matching_and_untagged_routes_leave_square_and_edge_clear(self):
        for tag in (None, "sett", "cobblestone", "unhewn_cobblestone"):
            before, after = self.surface(tag, "sett")
            self.assertLess(after.area, before.area)
            self.assertEqual(after.intersection(box(-0.49, 0, 20.49, 10)).area, 0)
            self.assertGreater(after.intersection(box(-10, 0, -1, 10)).area, 0)

    def test_different_and_unknown_explicit_materials_are_kept(self):
        for tag in ("asphalt", "paving_stones", "wood", "unknown"):
            before, after = self.surface(tag)
            self.assertTrue(after.equals(before), tag)

    def test_all_square_materials_match_only_their_own_surface(self):
        for kind, tag in (("square", "paving_stones"), ("square_asphalt", "asphalt"),
                          ("square_loose", "gravel")):
            _, after = self.surface(tag, areas={kind: [box(0, 0, 20, 10)]})
            self.assertEqual(after.intersection(box(0, 0, 20, 10)).area, 0)

    def test_bridge_and_other_level_surfaces_are_kept(self):
        for cls in ("bridge", "path", "dirt", "sett"):
            before, after = self.surface("sett", cls, at_ground=False)
            self.assertTrue(after.equals(before))

    def test_square_hole_keeps_its_path(self):
        square = box(-5, -5, 25, 15).difference(box(2, 0, 18, 10))
        _, after = self.surface(areas={"square_setts": [square]})
        self.assertGreater(after.intersection(box(3, 0, 17, 10)).area, 40)

    def test_square_edge_preserves_path_in_narrow_mapped_green_hole(self):
        green = box(0, 0, 40, 0.8)
        square = box(-10, -10, 50, 10).difference(green)
        path = box(2, 0.1, 38, 0.7)
        got = list(_walking_surfaces([(path, "path", None, True, False)],
                                     {"square_setts": [square], "park": [green]}))
        self.assertTrue(got[0][1].equals(path))

    def test_island_link_tags_keep_the_part_crossing_mapped_greenery(self):
        path = box(-10, 1, 30, 3)
        green = box(0, 0, 20, 10)
        got = list(_walking_surfaces([(path, "path", None, True, True)], {"park": [green]}))
        self.assertTrue(got[0][1].equals(path.intersection(green)))
        got = list(_walking_surfaces([(path, "path", None, True, True)], {"water": [green]}))
        self.assertEqual(got, [])

    def test_ground_levels_accept_numeric_and_string_decimal_zero(self):
        for value in (None, 0, 0.0, "0", "0.0", "0.00", " 0.0 "):
            self.assertTrue(_ground_level(value), value)
        for value in (1, 1.0, "1.0", "-1", "0;1", "roof", float("nan")):
            self.assertFalse(_ground_level(value), value)
        for value in ("0.0", 0.0):
            got = self.extract([{"highway": "footway", "footway": "link", "level": value}])
            self.assertEqual(got["roads"].get("path", Polygon()).area, 0)

    def test_clipping_after_subtraction_keeps_both_sides_of_seam(self):
        _, after = self.surface()
        left, right = box(-20, -20, 10, 20), box(10, -20, 40, 20)
        self.assertTrue(shapely.union(after.intersection(left), after.intersection(right)).equals(after))

    def extract(self, tags, geoms=None, land=None, walks=None):
        w, s, e, n = AREAS["ujezd"]
        crs = f"+proj=tmerc +lat_0={(s+n)/2} +lon_0={(w+e)/2} +ellps=WGS84 +units=m"
        inv = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        # Parallel ways, far enough apart for each surface to be checked separately.
        geoms = np.array(geoms if geoms is not None else
                         [LineString([(-30, i*20), (30, i*20)]) for i in range(len(tags))], dtype=object)
        geoms = shapely.transform(geoms, lambda c: np.column_stack(inv.transform(c[:, 0], c[:, 1])))
        rows = [{"element": "way", "id": i+1, **tag} for i, tag in enumerate(tags)]
        with patch("osm_area.dtm.streets", return_value=Polygon()), patch("osm_area.dtm.land", return_value=land or {}), \
                patch("osm_area.dtm.parking", return_value=Polygon()), patch("osm_area.dtm.walks", return_value=walks or {}):
            # (No surveyed pavements either: the real ones at this spot would take the ribbons' place.)
            return extract("ujezd", features=(geoms, rows))

    def test_cobbled_footways_and_pedestrian_streets_use_setts(self):
        got = self.extract([{"highway": "pedestrian", "surface": "sett"},
                            {"highway": "footway", "surface": "cobblestone"},
                            {"highway": "footway", "surface": "paving_stones"}])
        self.assertGreater(got["roads"]["sett"].area, 500)
        self.assertGreater(got["roads"]["path"].area, 170)
        self.assertEqual(len(got["kerbs"].sw), 2)  # rendering never removes kerb candidates

    def test_island_and_link_routes_omit_only_ground_surface(self):
        got = self.extract([{"highway": "footway", "footway": "traffic_island"},
                            {"highway": "footway", "footway": "link"},
                            {"highway": "footway", "footway": "traffic_island", "bridge": "yes"},
                            {"highway": "footway", "footway": "link", "layer": "1"},
                            {"highway": "footway", "footway": "link", "level": "1"}])
        self.assertEqual(got["roads"]["path"].intersection(box(-40, -10, 40, 30)).area, 0)
        self.assertGreater(got["roads"]["bridge"].area, 170)
        self.assertGreater(got["roads"]["path"].area, 340)
        self.assertEqual(len(got["kerbs"].sw), 0)  # these tags were never kerb candidates

    def test_untagged_real_path_and_loose_bridge_are_kept(self):
        got = self.extract([{"highway": "footway"}, {"highway": "path", "surface": "gravel", "bridge": "yes"}])
        self.assertGreater(got["roads"]["path"].area, 170)
        self.assertGreater(got["roads"]["bridge"].area, 110)
        self.assertNotIn("dirt", got["roads"])

    def test_named_square_does_not_pave_over_park_or_remove_its_path(self):
        got = self.extract([{"place": "square", "surface": "sett"}, {"leisure": "park"},
                            {"highway": "footway"}],
                           [box(-40, -40, 40, 40), box(-20, -20, 20, 20),
                            LineString([(-35, 0), (35, 0)])])
        park = got["areas"]["park"]
        self.assertLess(got["areas"]["square_setts"].intersection(park).area, 1e-5)
        self.assertGreater(got["roads"]["path"].intersection(park).area, 110)
        self.assertEqual(len(got["kerbs"].sw), 1)

    def test_explicit_paved_area_inside_park_keeps_its_surface(self):
        got = self.extract([{"highway": "pedestrian", "surface": "sett"}, {"leisure": "park"}],
                           [box(-10, -10, 10, 10), box(-20, -20, 20, 20)])
        self.assertGreater(got["areas"]["square_setts"].intersection(got["areas"]["park"]).area, 399)

    def test_gardens_start_behind_a_surveyed_pavement(self):
        # A street along y = 0 with a surveyed pavement 3 m deep on its north side, and
        # two family houses in a residential area beyond it.
        tags = [{"landuse": "residential"}, {"building": "house"}, {"building": "house"},
                {"highway": "residential", "width": "6"}, {"highway": "footway", "footway": "sidewalk"}]
        geoms = [box(-60, -40, 60, 40), box(-30, 12, -18, 24), box(10, 12, 22, 24),
                 LineString([(-80, 0), (80, 0)]), LineString([(-80, 4.5), (80, 4.5)])]
        pavement = box(-80, 3, 80, 6)
        before = self.extract(tags, geoms)
        after = self.extract(tags, geoms, walks={"pavement": np.array([pavement], dtype=object)})
        self.assertGreater(before["areas"]["garden"].intersection(pavement).area, 300)  # the ribbon lay on the garden
        self.assertLess(after["areas"]["garden"].intersection(pavement).area, 1)
        self.assertGreater(after["roads"]["pavement"].area, 350)
        self.assertNotIn("path", after["roads"])  # the pavement's own ribbon is gone
        for f in after["fences"]:
            self.assertLess(LineString(f["pts"]).intersection(pavement.buffer(-0.2)).length, 0.5, f)

    def test_route_link_across_inferred_estate_lawn_keeps_real_surface(self):
        got = self.extract([{"landuse": "residential"}, {"building": "apartments"},
                            {"highway": "footway", "footway": "link"}],
                           [box(-100, -100, 100, 100), box(50, 50, 70, 70),
                            LineString([(-50, 0), (50, 0)])])
        self.assertGreater(got["areas"]["lawn"].area, 39000)
        self.assertGreaterEqual(got["roads"]["path"].area, 300)  # 100 m, 3 m wide, with square ends

    def test_route_link_across_surveyed_green_keeps_real_surface(self):
        got = self.extract([{"highway": "footway", "footway": "link"}],
                           land={"green": box(-100, -100, 100, 100)})
        self.assertGreater(got["roads"]["path"].area, 170)
        self.assertEqual(got["areas"]["dtm_green"].area, 40000)

    def test_named_square_keeps_surveyed_green_and_its_crossing_path(self):
        got = self.extract([{"place": "square", "surface": "sett"}, {"highway": "footway"}],
                           [box(-40, -40, 40, 40), LineString([(-35, 0), (35, 0)])],
                           land={"green": box(-20, -20, 20, 20)})
        green = got["areas"]["dtm_green"]
        self.assertLess(got["areas"]["square_setts"].intersection(green).area, 1e-5)
        self.assertGreater(got["roads"]["path"].intersection(green).area, 119)

    def test_named_square_keeps_inferred_lawn_and_its_crossing_path(self):
        got = self.extract([{"landuse": "residential"}, {"building": "apartments"},
                            {"place": "square", "surface": "sett"}, {"highway": "footway"}],
                           [box(-100, -100, 100, 100), box(50, 50, 70, 70),
                            box(-40, -40, 40, 40), LineString([(-35, 0), (35, 0)])])
        self.assertNotIn("square_setts", got["areas"])
        self.assertGreater(got["roads"]["path"].area, 200)

    def test_route_tags_preserve_explicit_different_material_on_square(self):
        for footway in ("link", "traffic_island"):
            got = self.extract([{"highway": "pedestrian", "surface": "sett"},
                                {"highway": "footway", "footway": footway, "surface": "asphalt"}],
                               [box(-40, -40, 40, 40), LineString([(-35, 0), (35, 0)])])
            self.assertGreater(got["roads"].get("path", Polygon()).area, 200)
            matching = self.extract([{"highway": "pedestrian", "surface": "sett"},
                                     {"highway": "footway", "footway": footway, "surface": "sett"}],
                                    [box(-40, -40, 40, 40), LineString([(-35, 0), (35, 0)])])
            self.assertEqual(matching["roads"].get("sett", Polygon()).area, 0)


if __name__ == "__main__":
    unittest.main()
