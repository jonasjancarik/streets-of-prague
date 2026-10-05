"""Selective extraction and shared parsing preserve map geometry and binary packing."""

import contextlib
import io
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

import numpy as np
from shapely.geometry import LineString, Polygon, box

import dtm
import ipr_buildings
import ipr_terrain
import kerbs
import osm_area
import structures


class ExtractionTests(unittest.TestCase):
    def features(self):
        geoms = [box(14.4001, 50.0801, 14.4003, 50.0803),
                 box(14.4001, 50.0801, 14.4002, 50.0802),
                 LineString([(14.40015, 50.0802), (14.40025, 50.0802)]),
                 LineString([(14.4000, 50.0804), (14.4005, 50.0804)]),
                 LineString([(14.4000, 50.08042), (14.4005, 50.08042)]),
                 box(14.4, 50.08, 14.4005, 50.0805)]
        rows = [{"building": "house", "roof:material": "roof_tiles"},
                {"building:part": "yes", "roof:material": "slate"},
                {"highway": "footway", "tunnel": "yes", "covered": "yes"},
                {"highway": "residential", "surface": "sett"},
                {"highway": "footway", "footway": "sidewalk"},
                {"landuse": "residential"}]
        return np.array(geoms, dtype=object), [{"element": "way", "id": k + 1, **r} for k, r in enumerate(rows)]

    def extract(self, **kwargs):
        return osm_area.extract("ujezd", bbox=(14.4, 50.08, 14.4005, 50.0805), centre=(14.40025, 50.08025),
                                features=self.features(), **kwargs)

    def test_buildings_only_matches_full_and_never_reads_dtm(self):
        with patch.object(dtm, "streets", return_value=Polygon()), patch.object(dtm, "land", return_value={}), \
                patch.object(dtm, "parking", return_value=Polygon()):
            full = self.extract()
        with patch.object(dtm, "streets", side_effect=AssertionError("unused survey")), \
                patch.object(dtm, "land", side_effect=AssertionError("unused land")):
            selected = self.extract(ground=False, buildings_only=True)
        self.assertEqual(selected, {k: full[k] for k in ("buildings", "parts")})
        self.assertTrue(selected["parts"])

    def test_streets_only_keeps_passages_and_kerbs(self):
        with patch.object(dtm, "streets", return_value=Polygon()), patch.object(dtm, "land", return_value={}):
            full, selected = self.extract(), self.extract(ground=False)
        self.assertEqual(full["ground_ways"], {3})
        self.assertEqual(full["ground_ways"], selected["ground_ways"])
        self.assertEqual(full["passages"], selected["passages"])
        lines = [LineString([(0, 10), (25, 10)])]
        ests = [kerbs.estimate(8, lambda _: None, True)]
        self.assertEqual(full["kerbs"](lines, ests), selected["kerbs"](lines, ests))
        self.assertEqual(selected["areas"], {})
        self.assertEqual(selected["roads"], {})

    def test_timing_laps_cover_classification_without_entering_output(self):
        times, stats = {}, {}
        with patch.object(dtm, "streets", return_value=Polygon()), patch.object(dtm, "land", return_value={}):
            result = self.extract(timings=times, stats=stats)
        self.assertTrue({"dtm_streets", "kerb_measure", "cobble_voronoi", "gardens", "dtm_land"} <= times.keys())
        self.assertTrue(all(v >= 0 for v in times.values()))
        self.assertEqual(stats["features"], 6)
        self.assertNotIn("timings", result)


class ReuseTests(unittest.TestCase):
    def test_kerb_samples_reused_only_for_same_ordered_lines(self):
        lines = [LineString([(0, 0), (30, 0)]), LineString([(0, 10), (30, 10)])]
        estimates = [kerbs.estimate(8, lambda _: None, True)] * 2
        measured = kerbs.Kerbs([], [], lines, box(-5, -5, 35, 15))
        with patch.object(kerbs, "_samples", wraps=kerbs._samples) as samples:
            with patch.object(measured, "_on", wraps=measured._on) as on:
                offsets = measured(lines, estimates)
                shares = measured.surveyed(list(lines))
                self.assertEqual(samples.call_count, 1)
                self.assertEqual(on.call_count, 1)
                fresh = kerbs.Kerbs([], [], lines, box(-5, -5, 35, 15))
                self.assertEqual(offsets, fresh(lines, estimates))
                np.testing.assert_array_equal(shares, fresh.surveyed(lines))
                measured.surveyed(list(reversed(lines)))
                self.assertEqual(on.call_count, 2)

    def test_dtm_both_indexes_unpickle_once(self):
        class Packages:
            def glob(self, pattern):
                return ["synthetic"]

        data = {"road": (np.array([0]), np.array([box(0, 0, 1, 1)], dtype=object)),
                "yard": (np.array([0, 1]), np.array([box(2, 2, 3, 3), box(4, 4, 5, 5)], dtype=object))}
        with patch.object(dtm, "_index", None), patch.object(dtm, "_land_index", None), patch.object(dtm, "_parking_index", None), \
                patch.object(dtm, "PACKAGES", Packages()), patch.object(dtm, "surfaces", return_value=data) as load:
            dtm.streets((-1, -1, 8, 8), lambda x, y: (x, y))
            land = dtm.land((-1, -1, 8, 8), lambda x, y: (x, y))
            self.assertEqual(load.call_count, 1)
            self.assertAlmostEqual(land["yard"].area, 1)


class IdentityTransform:
    def __init__(self, local):
        pass

    def transform(self, x, y):
        return x, y


class IprSourceTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(patch.object(ipr_buildings, "CACHE", self.root))
        self.stack.enter_context(patch.object(ipr_terrain, "CACHE", self.root))
        self.stack.enter_context(patch.object(ipr_buildings, "krovak_to_local", IdentityTransform))
        self.stack.enter_context(patch.object(ipr_terrain, "krovak_to_local", IdentityTransform))

    def test_building_xml_is_shared_between_area_projections(self):
        path = self.root / "sheet.gml"
        path.write_text('''<root xmlns:gml="http://www.opengis.net/gml" xmlns:bldg="http://www.opengis.net/citygml/building/2.0">
<bldg:Building gml:id="test"><bldg:GroundSurface><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>1 1 180 9 1 180 9 9 180 1 9 180 1 1 180</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></bldg:GroundSurface>
<bldg:RoofSurface><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>1 1 185 9 1 185 9 9 185 1 9 185 1 1 185</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></bldg:RoofSurface></bldg:Building></root>''')
        # Wrap parsing without changing the function's source-derived cache version.
        with patch.object(ipr_buildings.etree, "iterparse", wraps=ipr_buildings.etree.iterparse) as parse:
            first = ipr_buildings.read_sheet(("BD3_test", str(path), "first-area", 250, [0, 0]))[1]
            second = ipr_buildings.read_sheet(("BD3_test", str(path), "second-area", 250, [0, 0]))[1]
            warm = ipr_buildings.read_sheet(("BD3_test", str(path), "first-area", 250, [0, 0]))[1]
            self.assertEqual(parse.call_count, 1)
        for found in (second, warm):
            self.assertEqual(first[0][:4], found[0][:4])
            np.testing.assert_array_equal(first[0][4], found[0][4])
            np.testing.assert_array_equal(first[0][5], found[0][5])
            self.assertTrue(first[0][6][0].equals_exact(found[0][6][0], 0))

    def test_terrain_xml_is_shared_while_lattice_remains_area_specific(self):
        path = self.root / "terrain.gml"
        path.write_text('''<root xmlns:gml="http://www.opengis.net/gml"><gml:Triangle>
<gml:posList>0 0 180 8 0 182 0 8 184 0 0 180</gml:posList>
</gml:Triangle></root>''')
        with patch.object(ipr_terrain.etree, "iterparse", wraps=ipr_terrain.etree.iterparse) as parse:
            first = ipr_terrain.read_sheet(("TER_test", str(path), "first-area", 0, 0, 4))[1]
            second = ipr_terrain.read_sheet(("TER_test", str(path), "second-area", 0, 0, 4))[1]
            shifted = ipr_terrain.read_sheet(("TER_test", str(path), "first-area", 1, 1, 4))[1]
            self.assertEqual(parse.call_count, 1)
        np.testing.assert_array_equal(first[2], second[2])
        self.assertFalse(np.array_equal(first[2], shifted[2], equal_nan=True))

    def test_bridge_cache_tracks_shapefile_components(self):
        bridge_dir = self.root / "mosty"
        bridge_dir.mkdir()
        (bridge_dir / "mosty.shp").write_text("fixture")
        dbf = bridge_dir / "mosty.dbf"
        dbf.write_text("first")
        polygon = Polygon([(0, 0, 185), (10, 0, 185), (10, 10, 185), (0, 10, 185)])
        with patch.object(structures, "CACHE", self.root), \
                patch.object(structures, "krovak_to_local", IdentityTransform), \
                patch("geopandas.read_file", return_value=SimpleNamespace(geometry=[polygon])) as read:
            sources = {}
            first = structures.ipr_decks("first-area", sources)
            warm = structures.ipr_decks("first-area")
            self.assertEqual(read.call_count, 1)
            np.testing.assert_array_equal(first[(5, 5)], warm[(5, 5)])
            self.assertIn(str(dbf.resolve()), sources)
            dbf.write_text("other")
            structures.ipr_decks("first-area")
            self.assertEqual(read.call_count, 2)


if __name__ == "__main__":
    unittest.main()
