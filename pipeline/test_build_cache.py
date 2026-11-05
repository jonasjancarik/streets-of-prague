"""Map cache correctness using tiny sources and private temporary directories."""

import contextlib
import gzip
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_cache
import build_tiles
import building_age
import chunk_cache
import dmr5g
import dtm
import dtm_heights
import dtm_walls
import ipr_trees
import ipr_buildings
import ipr_terrain
import layers
import structures
from shapely.geometry import Polygon


OSM = '''<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="test">
<node id="1" lat="50.0801" lon="14.4001"/>
<node id="2" lat="50.0801" lon="14.4002"/>
<node id="3" lat="50.0802" lon="14.4002"/>
<node id="4" lat="50.0802" lon="14.4001"/>
<node id="5" lat="50.0803" lon="14.4000"/>
<node id="6" lat="50.0803" lon="14.4005"/>
<way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="4"/><nd ref="1"/>
<tag k="building" v="house"/><tag k="roof:material" v="roof_tiles"/></way>
<way id="11"><nd ref="5"/><nd ref="6"/><tag k="highway" v="residential"/><tag k="name" v="Test Street"/></way>
</osm>'''


class IdentityTransform:
    def __init__(self, local):
        pass

    def transform(self, x, y):
        return x, y


class CacheTests(unittest.TestCase):
    def test_same_size_preserved_mtime_still_changes_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "source"
            p.write_text("abc")
            before = build_cache.identity(p)
            p.write_text("xyz")
            os.utime(p, ns=(p.stat().st_atime_ns, before[2]))
            self.assertNotEqual(build_cache.identity(p), before)

    def test_source_cache_reused_and_invalidated(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, cache = Path(tmp) / "source", Path(tmp) / "parsed.pkl"
            p.write_text("first")
            calls = []

            def load(path):
                calls.append(path)
                return Path(path).read_text()

            self.assertEqual(build_cache.source_data(p, cache, 1, load), "first")
            self.assertEqual(build_cache.source_data(p, cache, 1, load), "first")
            self.assertEqual(len(calls), 1)
            p.write_text("other")
            self.assertEqual(build_cache.source_data(p, cache, 1, load), "other")
            self.assertEqual(len(calls), 2)

    def test_streamed_source_is_not_published_until_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            p, cache = Path(tmp) / "source", Path(tmp) / "parsed.pkl"
            p.write_text("source")
            loader = lambda path: iter([("a", [1, 2]), ("b", [3, 4])])
            stream = build_cache.source_records(p, cache, 1, loader)
            self.assertEqual(next(stream)[0], "a")
            self.assertFalse(cache.exists())
            stream.close()
            expected = list(build_cache.source_records(p, cache, 1, loader))
            with patch.object(build_cache, "identity", wraps=build_cache.identity):
                self.assertEqual(list(build_cache.source_records(p, cache, 1, lambda _: self.fail("cache miss"))), expected)

    def test_cut_tracks_parent_bbox_and_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, out = Path(tmp) / "source.pbf", Path(tmp) / "cut.osm"
            source.write_text(OSM)
            calls = []

            def osmium(cmd, check):
                calls.append(cmd)
                Path(cmd[cmd.index("-o") + 1]).write_bytes(source.read_bytes())

            with patch.object(build_tiles.subprocess, "run", side_effect=osmium):
                build_tiles.cut((1, 2, 3, 4), out, source)
                build_tiles.cut((1, 2, 3, 4), out, source)
                self.assertEqual(len(calls), 1)
                source.write_text(OSM + "\n")
                build_tiles.cut((1, 2, 3, 4), out, source)
                build_tiles.cut((1, 2, 4, 4), out, source)
                out.write_text("damaged")
                build_tiles.cut((1, 2, 4, 4), out, source)
                self.assertEqual(len(calls), 4)

    def test_failed_cut_keeps_previous_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, out = Path(tmp) / "source.pbf", Path(tmp) / "cut.osm"
            source.write_text(OSM)
            out.write_text("previous")
            with patch.object(build_tiles.subprocess, "run", side_effect=RuntimeError("failed")):
                with self.assertRaises(RuntimeError):
                    build_tiles.cut((1, 2, 3, 4), out, source)
            self.assertEqual(out.read_text(), "previous")


class ChunkBuildTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.out = self.root / "data"
        self.out.mkdir()
        self.pbf = self.root / "osm" / "country.pbf"
        self.pbf.parent.mkdir()
        self.pbf.write_text(OSM)
        self.trees = self.root / "trees.json"
        self.trees.write_text("[]")
        for obj, attr, value in [(layers, "CACHE", self.root / "layers"), (layers, "OUT", self.out),
                                 (build_tiles, "OUT", self.out), (chunk_cache, "OUT", self.out),
                                 (build_tiles, "PBF", self.pbf), (ipr_trees, "CACHE", self.trees),
                                 (ipr_trees, "_table", None), (dtm, "PACKAGES", self.root / "dtm"),
                                 (dtm_walls, "LINES", self.root / "dtm_lines"),
                                 (build_tiles, "_sections", None),
                                 (build_tiles, "AREAS", {"ujezd": (14.4, 50.08, 14.4005, 50.0805)})]:
            self.stack.enter_context(patch.object(obj, attr, value))
        self.stack.enter_context(patch.object(build_tiles, "setup", return_value=None))
        self.stack.enter_context(patch.object(dtm, "download", return_value=None))
        self.stack.enter_context(patch.object(dtm, "surfaces", return_value={}))
        self.stack.enter_context(patch.object(dtm, "streets", return_value=Polygon()))
        self.stack.enter_context(patch.object(dtm, "land", return_value={}))
        self.stack.enter_context(patch.object(dtm, "parking", return_value=Polygon()))
        self.stack.enter_context(patch.object(dtm, "covered", side_effect=lambda lon, lat: dtm.np.zeros_like(lon, dtype=bool)))
        self.stack.enter_context(patch.object(dtm_walls, "survey", return_value=[]))

        # The subprocess module is shared: assembly also asks Git for provenance.
        def osmium(cmd, check, *, cwd=None, capture_output=False, text=False):
            self.assertTrue(check)
            if cmd[0] == "git":
                self.assertEqual(cmd, ["git", "describe", "--always", "--dirty", "--abbrev=10", "--exclude", "*"])
                self.assertEqual(cwd, Path(__file__).resolve().parent)
                self.assertTrue(capture_output)
                self.assertTrue(text)
                return build_tiles.subprocess.CompletedProcess(cmd, 0, stdout="test-pipeline\n")
            self.assertEqual(cmd[:2], ["osmium", "extract"])
            self.assertIsNone(cwd)
            self.assertFalse(capture_output)
            self.assertFalse(text)
            Path(cmd[cmd.index("-o") + 1]).write_bytes(Path(cmd[-1]).read_bytes())

        self.stack.enter_context(patch.object(build_tiles.subprocess, "run", side_effect=osmium))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def run_build(self, *extra):
        with patch("sys.argv", ["build_tiles.py", "ujezd", "--jobs", "1", "--no-assemble", *extra]):
            build_tiles.main()

    def outputs(self):
        return {name: layers.chunk_path("ujezd", name, 0, 0).read_bytes() for name in layers.CHUNKED}

    def test_resume_skips_all_unchanged_work_and_rebuilds_only_damaged_layer(self):
        self.run_build()
        expected = self.outputs()
        with patch.object(build_tiles, "build_chunk", wraps=build_tiles.build_chunk) as build:
            self.run_build("--resume")
            build.assert_not_called()
        layers.chunk_path("ujezd", "buildings", 0, 0).write_text("damaged")
        with patch.object(build_tiles, "build_chunk", wraps=build_tiles.build_chunk) as build:
            self.run_build("--resume")
            self.assertEqual(build.call_args.args[0][4], {"buildings"})
        self.assertEqual(self.outputs(), expected)

    def test_interrupted_chunk_has_no_success_and_resumes_to_clean_output(self):
        self.run_build()
        expected = self.outputs()
        write = layers.write

        def fail_ground(path, raw):
            if path.parent.name == "ground":
                raise RuntimeError("simulated interruption")
            return write(path, raw)

        with patch.object(layers, "write", side_effect=fail_ground):
            with self.assertRaisesRegex(RuntimeError, "interruption"):
                self.run_build()
        meta = layers.read_meta("ujezd")
        with self.assertRaises(SystemExit):
            chunk_cache.check_complete("ujezd", meta)
        self.run_build("--resume")
        self.assertEqual(self.outputs(), expected)
        chunk_cache.check_complete("ujezd", layers.read_meta("ujezd"))

    def test_source_change_and_grid_origin_invalidate_completion(self):
        self.run_build()
        self.pbf.write_text(OSM + "\n")
        with self.assertRaises(SystemExit):
            chunk_cache.check_complete("ujezd", layers.read_meta("ujezd"))
        with patch.object(build_tiles, "build_chunk", wraps=build_tiles.build_chunk) as build:
            self.run_build("--resume")
            self.assertEqual(build.call_args.args[0][4], set(layers.CHUNKED) - {"parking"})
        meta = layers.read_meta("ujezd")
        meta["origin"][0] += 1
        with self.assertRaises(SystemExit):
            chunk_cache.check_complete("ujezd", meta)

    def test_overpass_completion_is_validated_but_never_resumed(self):
        self.run_build()
        area = "ujezd"
        meta = layers.read_meta(area)
        meta["build_source"] = None
        wanted = set(layers.CHUNKED)
        keys = chunk_cache.inputs(area, meta, wanted, None, meta["build_settings"])
        record = chunk_cache.begin(area, meta, 0, 0, wanted)
        outputs = {name: raw.decode() for name, raw in self.outputs().items()}
        chunk_cache.complete(area, 0, 0, record, outputs, keys)
        chunk_cache.check_complete(area, meta)
        self.assertEqual(chunk_cache.remaining(area, meta, 0, 0, wanted, keys), wanted - {"parking"})
        # Legacy Overpass completions stored no processing fingerprint.
        record["layers"]["buildings"]["input"] = None
        build_cache.write_json(chunk_cache.record_path(area, 0, 0), record)
        with self.assertRaisesRegex(SystemExit, "buildings chunk"):
            chunk_cache.check_complete(area, meta)

    def test_footfall_metadata_change_only_rebuilds_ground(self):
        self.run_build()
        data = self.out / "ujezd_now"
        data.mkdir()
        (data / "footfall.json").write_text('{"box":[0,0,1,1],"cell":1}')
        with patch.object(build_tiles, "build_chunk", wraps=build_tiles.build_chunk) as build:
            self.run_build("--resume")
            self.assertEqual(build.call_args.args[0][4], {"ground"})
        chunk_cache.check_complete("ujezd", layers.read_meta("ujezd"))

    def test_parking_only_does_not_cut_osm_or_invalidate_other_layers(self):
        self.run_build()
        expected = self.outputs()
        with patch.object(build_tiles, "cut", side_effect=AssertionError("unused cut")):
            self.run_build("--layers", "parking")
        self.assertEqual(self.outputs(), expected)
        chunk_cache.check_complete("ujezd", layers.read_meta("ujezd"))

    def test_buildings_and_parking_skip_unused_dtm(self):
        self.run_build()
        expected = self.outputs()
        with patch.object(dtm, "streets", side_effect=AssertionError("unused DTM")):
            self.run_build("--layers", "buildings,parking")
        self.assertEqual(self.outputs(), expected)

    def test_chunk_trial_requires_an_existing_matching_grid_before_work(self):
        with patch.object(build_tiles, "setup", side_effect=AssertionError("started work")), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.run_build("--chunks", "0,0")
        self.run_build()
        before = (layers.folder("ujezd") / "meta.json").read_bytes()
        expected = self.outputs()
        with patch.object(build_tiles, "setup", side_effect=AssertionError("started work")), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                self.run_build("125", "--chunks", "0,0")
        self.assertEqual((layers.folder("ujezd") / "meta.json").read_bytes(), before)
        self.assertEqual(self.outputs(), expected)

    def test_invalid_chunk_selection_is_rejected_before_work(self):
        self.run_build()
        before = (layers.folder("ujezd") / "meta.json").read_bytes()
        with patch.object(build_tiles, "setup", side_effect=AssertionError("started work")), contextlib.redirect_stderr(io.StringIO()):
            for selection in ("1,0", "-1,0", "0,1", "0", "0,0,0", "x,0"):
                with self.subTest(selection=selection), self.assertRaises(SystemExit):
                    self.run_build(f"--chunks={selection}")
        self.assertEqual((layers.folder("ujezd") / "meta.json").read_bytes(), before)

    def test_matching_grid_trial_only_rebuilds_the_selected_chunk(self):
        with patch.object(build_tiles, "AREAS", {"ujezd": (14.4, 50.08, 14.404, 50.0805)}):
            self.run_build("250", "250")
            paths = [layers.chunk_path("ujezd", name, 1, 0) for name in layers.CHUNKED]
            before = {p: p.read_bytes() for p in paths}
            with patch.object(build_tiles, "build_chunk", wraps=build_tiles.build_chunk) as build:
                self.run_build("250", "250", "--chunks", "0,0")
            self.assertEqual(build.call_count, 1)
            self.assertEqual(build.call_args.args[0][2:4], (0, 0))
            self.assertEqual({p: p.read_bytes() for p in before}, before)

    def test_strict_assembly_preflight_keeps_index_when_dependencies_are_stale(self):
        self.run_build()
        meta = layers.read_meta("ujezd")
        keys = [f"{i}_{j}" for i, j, _ in layers.tiles("ujezd", meta)]
        tiles_dir = self.out / "ujezd_now" / "tiles"
        payloads = {}
        for k in keys:
            layers.write_bin(tiles_dir, f"{k}.height.bin", bytes(63 ** 2 * 2), payloads)
        for name in ("ipr", "terrain"):
            data = {"tile": meta["tile"], "made_for": keys, "gzip": True, "tiles": {},
                    **layers.stage_inputs("ujezd", name, {}), "payloads": payloads if name == "terrain" else {}}
            data.update({"iprRef": 180} if name == "ipr" else {"index": {"n": 63, "step": 250 / 62}})
            layers.write_layer("ujezd", name, data)
        index = layers.assemble("ujezd", strict=True)
        self.assertEqual(index["pipeline"], "test-pipeline")
        self.assertEqual(len(index["tiles"]), len(keys))
        before = (tiles_dir.parent / "index.json").read_bytes()
        ground = layers.chunk_path("ujezd", "ground", 0, 0)
        ground.write_bytes(ground.read_bytes() + b" ")
        with self.assertRaises(SystemExit):
            layers.assemble("ujezd", strict=True)
        self.assertEqual((tiles_dir.parent / "index.json").read_bytes(), before)

    def test_interrupted_binary_stage_cannot_reuse_old_completion(self):
        self.run_build()
        layers.write_layer("ujezd", "ipr", {"tile": 250, "gzip": True, "made_for": ["0_0"], "tiles": {},
                                             **layers.stage_inputs("ujezd", "ipr", {}), "payloads": {}})
        self.assertTrue(layers.layer_complete("ujezd", "ipr"))
        layers.begin_layer("ujezd", "ipr")
        self.assertFalse(layers.layer_complete("ujezd", "ipr"))
        with self.assertRaises(SystemExit):
            layers.assemble("ujezd", strict=True)

    def test_staged_ipr_resume_matches_full_build_and_validates_completion(self):
        self.run_build()
        cache = self.root / "ipr"
        cache.mkdir()
        ages = self.root / "building-age.json.gz"
        ages.write_bytes(gzip.compress(b"[]"))
        network = self.stack.enter_context(patch.object(building_age.requests, "get",
                                                       side_effect=AssertionError("network access in fixture")))
        buildings = cache / "BD3_test.gml"
        buildings.write_text('''<root xmlns:gml="http://www.opengis.net/gml" xmlns:bldg="http://www.opengis.net/citygml/building/2.0">
<bldg:Building gml:id="test"><bldg:GroundSurface><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>1 1 180 9 1 180 9 9 180 1 9 180 1 1 180</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></bldg:GroundSurface>
<bldg:RoofSurface><gml:Polygon><gml:exterior><gml:LinearRing><gml:posList>1 1 185 9 1 185 9 9 185 1 9 185 1 1 185</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon></bldg:RoofSurface></bldg:Building></root>''')
        terrain = cache / "TER_test_gml.gml"
        terrain.write_text('''<root xmlns:gml="http://www.opengis.net/gml"><gml:Triangle>
<gml:posList>-100 -100 180 400 -100 182 -100 400 184 -100 -100 180</gml:posList>
</gml:Triangle></root>''')

        for obj, attr, value in [(building_age, "CACHE", ages),
                                 (ipr_buildings, "OUT", self.out), (ipr_buildings, "CACHE", cache),
                                 (ipr_buildings, "MESH_COLOURS", self.root / "colours"),
                                 (ipr_buildings, "sheet_names", lambda area: ["test"]), (ipr_buildings, "catalogue", lambda: {}),
                                 (ipr_buildings, "krovak_to_local", IdentityTransform),
                                 (ipr_terrain, "OUT", self.out), (ipr_terrain, "CACHE", cache),
                                 (ipr_terrain, "krovak_to_local", IdentityTransform), (ipr_terrain, "catalogue", lambda: {}),
                                 (ipr_terrain, "sheet_names", lambda area: ["test"]),
                                 (dtm_heights, "CACHE", self.root / "dtm"),
                                 (dtm_heights, "PACKAGES", self.root / "dtm" / "ZPS_OPL"),
                                 (dtm_heights, "LINES", self.root / "dtm" / "ZPS_KR"),
                                 (structures, "CACHE", cache),
                                 (structures, "build", lambda *args, **kwargs: {})]:
            self.stack.enter_context(patch.object(obj, attr, value))
        bridge = cache / "mosty" / "mosty.shp"
        bridge.parent.mkdir()
        bridge.touch()
        # The two builds are compared byte for byte, and the index records when it was built.
        self.stack.enter_context(patch.object(layers.time, "gmtime", return_value=layers.time.gmtime(0)))

        def run_stage(module, *flags):
            options = ["--no-roof-details"] if module == ipr_buildings else []
            with patch("sys.argv", [Path(module.__file__).name, "ujezd", "--jobs", "1", *options, *flags]):
                module.main()

        run_stage(ipr_buildings, "--no-assemble")
        run_stage(ipr_terrain, "--no-assemble")
        self.assertFalse((self.out / "ujezd_now" / "index.json").exists())
        layers.assemble("ujezd", strict=True)
        expected = {p.relative_to(self.out): p.read_bytes() for p in self.out.rglob("*") if p.is_file()}

        # A warm staged run does not even read sheets. A warm immediate run assembles.
        with patch.object(ipr_buildings, "read_sheet") as b, patch.object(ipr_terrain, "read_sheet") as t, \
                patch.object(layers, "assemble", wraps=layers.assemble) as assemble:
            run_stage(ipr_buildings, "--resume", "--no-assemble")
            run_stage(ipr_terrain, "--resume", "--jobs", "2")
            b.assert_not_called()
            t.assert_not_called()
            assemble.assert_called_once_with("ujezd")
        actual = {p.relative_to(self.out): p.read_bytes() for p in self.out.rglob("*") if p.is_file()}
        self.assertEqual(actual, expected)

        tiles_dir = self.out / "ujezd_now" / "tiles"
        for module, layer, payload, option in (
                (ipr_buildings, "ipr", "0_0.ipr.bin.gz", "--no-borrow"),
                (ipr_terrain, "terrain", "0_0.height.bin.gz", "--no-feather")):
            with self.subTest(layer=layer), patch.object(module, "read_sheet", wraps=module.read_sheet) as read:
                path = tiles_dir / payload
                for damage in ("missing", "corrupt", "interrupted", "legacy", "forced", "options"):
                    with self.subTest(damage=damage):
                        read.reset_mock()
                        flags = ["--no-assemble", "--resume"]
                        if damage == "missing":
                            path.unlink()
                        elif damage == "corrupt":
                            path.write_bytes(b"damaged")
                        elif damage == "interrupted":
                            layers.begin_layer("ujezd", layer)
                        elif damage == "legacy":
                            data = layers.read_layer("ujezd", layer)
                            del data["options"]
                            layers.write_layer("ujezd", layer, data)
                        elif damage == "forced":
                            flags.remove("--resume")
                        elif damage == "options":
                            flags.append(option)
                        if damage in ("missing", "corrupt", "interrupted", "legacy"):
                            with self.assertRaises(SystemExit):
                                layers.assemble("ujezd", strict=True)
                        run_stage(module, *flags)
                        read.assert_called_once()
                        self.assertEqual(path.read_bytes(), expected[path.relative_to(self.out)])
                        layers.assemble("ujezd", strict=True)

        # Newly available sources are detected even though the previous run did not use them.
        before = layers.stage_inputs("ujezd", "terrain", {})
        bridge.with_suffix(".dbf").touch()
        self.assertNotEqual(before, layers.stage_inputs("ujezd", "terrain", {}))
        with self.assertRaisesRegex(SystemExit, "terrain dependencies"):
            layers.assemble("ujezd", strict=True)
        with patch.object(dmr5g, "CACHE", self.root / "dmr"):
            options = {"dmr5g": True}
            with_dmr = layers.stage_inputs("ujezd", "terrain", options)
            without_dmr = layers.stage_inputs("ujezd", "terrain", {})
            raster = dmr5g.raster_path("letna")
            raster.parent.mkdir()
            raster.touch()
            self.assertNotEqual(with_dmr, layers.stage_inputs("ujezd", "terrain", options))
            self.assertEqual(without_dmr, layers.stage_inputs("ujezd", "terrain", {}))

        # An addition to the survey during processing must prevent completion.
        dtm_heights.LINES.mkdir(parents=True)
        write_bin = layers.write_bin

        def survey_changed(*args):
            (dtm_heights.LINES / "new.zip").touch()
            return write_bin(*args)

        with patch.object(layers, "write_bin", side_effect=survey_changed):
            with self.assertRaisesRegex(RuntimeError, "changed"):
                run_stage(ipr_terrain, "--no-assemble")
        self.assertFalse(layers.layer_complete("ujezd", "terrain"))

        network.assert_not_called()

    def test_water_dependency_and_missing_payload_are_checked_before_writes(self):
        self.run_build()
        layers.write_layer("ujezd", "ipr", {"tile": 250, "gzip": True, "tiles": {}, "made_for": ["0_0"],
                                             **layers.stage_inputs("ujezd", "ipr", {}), "payloads": {}})
        before = layers.read_layer("ujezd", "ipr")["dependencies"]
        ground = layers.chunk_path("ujezd", "ground", 0, 0)
        ground.write_bytes(ground.read_bytes() + b" ")
        self.assertNotEqual(before, layers.dependency_snapshot("ujezd", layers.DEPENDENCIES["ipr"]))
        self.assertFalse((self.out / "ujezd_now" / "index.json").exists())
        with self.assertRaises(SystemExit):
            layers.assemble("ujezd", strict=True)
        self.assertFalse((self.out / "ujezd_now" / "index.json").exists())


class ProcessingKeyTests(unittest.TestCase):
    LAYERS = (*layers.CHUNKED, "ipr", "terrain")

    def test_dependencies_invalidate_only_their_layers(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(build_cache, "PIPELINE", Path(tmp)):
            files = {name for files in build_cache.CODE.values() for name in files}
            for name in files | {"build_audio.py", "build_cache.py", "chunk_cache.py"}:
                shutil.copyfile(Path(__file__).with_name(name), Path(tmp) / name)
            before = {layer: build_cache.processing(layer) for layer in self.LAYERS}
            for name, old, new, expected in (
                    ("build_audio.py", "", "\n# unrelated audio edit", set()),
                    ("plots.py", "", "\n# changed garden helper", {"ground"}),
                    ("terrain_walls.json", "", " ", {"terrain"}),
                    ("mesh_colours.py", "c = np.asarray(rgb, np.float64).reshape(-1, 3) / 255",
                     "c = np.asarray(rgb, np.float64).reshape(-1, 3) / 256", {"ipr"}),
                    ("ipr_buildings.py", "self.to_wgs.transform(x, y)", "self.to_wgs.transform(x + 1, y)",
                     {"ipr", "terrain"})):
                with self.subTest(file=name):
                    path = Path(tmp) / name
                    original = path.read_text()
                    self.assertIn(old, original)
                    path.write_text(original.replace(old, new, 1) if old else original + new)
                    changed = {layer for layer in self.LAYERS if build_cache.processing(layer) != before[layer]}
                    self.assertEqual(changed, expected)
                    path.write_text(original)

    def test_library_change_invalidates_the_layers_that_use_it(self):
        before = {layer: build_cache.processing(layer) for layer in self.LAYERS}
        version = build_cache.importlib.metadata.version

        def updated(name):
            return "test-upgrade" if name == "lxml" else version(name)

        with patch.object(build_cache.importlib.metadata, "version", side_effect=updated):
            changed = {layer for layer in self.LAYERS if build_cache.processing(layer) != before[layer]}
        self.assertEqual(changed, {"ipr", "terrain"})


class ReachKeyTests(unittest.TestCase):
    SOURCE = """
import numpy as np
LIMIT = 3
OTHER = 5

def helper(x):
    return np.minimum(x, LIMIT)

def made(x):
    return helper(x) + 1

def report(x):
    return x * OTHER
"""

    def key(self, source):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "module.py"
            path.write_text(source)
            return build_cache.reach_key(path, ["made"])

    def test_only_what_the_function_leads_to_changes_the_key(self):
        key = self.key(self.SOURCE)
        self.assertEqual(self.key(self.SOURCE.replace("x * OTHER", "x - OTHER").replace("OTHER = 5", "OTHER = 6")), key)
        self.assertNotEqual(self.key(self.SOURCE.replace("LIMIT = 3", "LIMIT = 4")), key)
        self.assertNotEqual(self.key(self.SOURCE.replace("np.minimum", "np.maximum")), key)
        self.assertNotEqual(self.key(self.SOURCE.replace("+ 1", "+ 2")), key)

    def test_the_cover_key_reaches_the_classifier_but_not_the_prototype(self):
        source = Path(build_cache.__file__).with_name("ground_cover.py").read_text()
        with tempfile.TemporaryDirectory() as tmp:
            def of(text):
                path = Path(tmp) / "ground_cover.py"
                path.write_text(text)
                return build_cache.reach_key(path, ["tile_cover"])
            key = of(source)
            self.assertEqual(of(source.replace("def kuwahara(img, radius=5", "def kuwahara(img, radius=6")), key)
            self.assertNotEqual(of(source.replace("MIN_BEIGE = 1000 ", "MIN_BEIGE = 1001 ")), key)  # (the thresholds are in cover_cells.py, keyed whole)
            self.assertNotEqual(of(source.replace("SJTSK_NODES = 33", "SJTSK_NODES = 17")), key)


if __name__ == "__main__":
    unittest.main()
