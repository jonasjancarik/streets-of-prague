"""Sampled imagery caches describe the area, grid and source they actually contain."""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

import cache_stale
import ground_cover as gc
import layers
import tifffile
import tree_sizes
import young_woods


TILE = {"i": 0, "j": 0, "box": [0.0, 0.0, 4.0, 4.0]}
SHIFTED = {**TILE, "box": [4.0, 0.0, 8.0, 4.0]}


class RasterCacheTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name, value in (("CACHE", self.root), ("PHOTOS", self.root / "photos"),
                            ("IPR_DSM", self.root / "source.tif"), ("_dsm", None)):
            self.stack.enter_context(patch.object(gc, name, value))
        self.stack.enter_context(patch.object(gc, "_dsm_identity", None, create=True))
        self.addCleanup(lambda: gc._dsm and gc._dsm[0].close())
        self.stack.enter_context(patch.object(gc, "local_proj", side_effect=lambda area: f"projection:{area}"))
        self.stack.enter_context(patch.object(gc, "sjtsk", side_effect=self.coordinates))
        self.fetch = self.stack.enter_context(patch.object(gc.S, "get", side_effect=self.response))
        tifffile.imwrite(gc.IPR_DSM, 200 + np.arange(256, dtype=np.float32).reshape(16, 16), tile=(16, 16))
        if processing := getattr(gc, "raster_processing", None):
            processing.cache_clear()
            self.addCleanup(processing.cache_clear)

    def coordinates(self, area, tile, res):
        x, y = gc.grid(tile, res)
        return (x + (4 if area == "ujezd" else 0) - 757499.5).ravel(), (-1034000.5 - y).ravel()

    def response(self, url, params, timeout):
        value = 30 * self.fetch.call_count
        out = io.BytesIO()
        if params["format"] == "tiff":
            tifffile.imwrite(out, np.full((6, 6), value, np.float32))
        else:
            Image.fromarray(np.full((6, 6, 3), value, np.uint8)).save(out, format="JPEG" if params["format"] == "jpg" else "PNG")
        return SimpleNamespace(content=out.getvalue(), headers={"content-type": "image/png"},
                               text="", raise_for_status=lambda: None)

    def export(self, area="praha", tile=TILE, res=1.0, url="fixture", src_res=1.0, fmt="png", extra=None):
        return gc.export(url, "rgb", area, tile, res, src_res, fmt=fmt, extra=extra)

    def test_export_reuses_only_the_same_area_grid_and_request(self):
        first = self.export()
        np.testing.assert_array_equal(self.export(), first)
        self.assertEqual(self.fetch.call_count, 1)
        cases = ({"area": "ujezd"}, {"tile": SHIFTED}, {"res": 2.0}, {"url": "other-source"},
                 {"src_res": 2.0}, {"fmt": "tiff"}, {"extra": {"interpolation": "nearest"}})
        for case in cases:
            with self.subTest(case=case):
                before = self.fetch.call_count
                result = self.export(**case)
                self.assertEqual(self.fetch.call_count, before + 1)
                np.testing.assert_array_equal(self.export(**case), result)
                self.assertEqual(self.fetch.call_count, before + 1)

    def test_legacy_unscoped_array_is_a_miss(self):
        legacy = self.root / "img" / "rgb" / "0_0.npy"
        legacy.parent.mkdir(parents=True)
        np.save(legacy, np.full((4, 4, 3), 999, np.float32))
        self.assertLess(self.export().max(), 1)
        self.fetch.assert_called_once()
        self.assertTrue(legacy.exists())

    def test_sampled_arrays_follow_sampling_code_without_rekeying_each_tile(self):
        original = Path(gc.__file__).read_text()
        copied = self.root / "sampling.py"

        def restart():
            # The command normally starts a fresh process after source edits.
            if processing := getattr(gc, "raster_processing", None):
                processing.cache_clear()

        for kind, sample in (("export", self.export), ("ipr_dsm", lambda: gc.ipr_dsm("praha", TILE, 1.0))):
            with self.subTest(kind=kind):
                copied.write_text(original)
                restart()
                with patch.object(gc, "__file__", str(copied)), \
                        patch.object(gc.ndimage, "map_coordinates", wraps=gc.ndimage.map_coordinates) as sampled, \
                        patch.object(gc.build_cache, "reach_key", wraps=gc.build_cache.reach_key) as key:
                    first = sample()
                    calls = sampled.call_count
                    key_calls = key.call_count
                    self.assertGreater(calls, 0)
                    np.testing.assert_array_equal(sample(), first)
                    self.assertEqual(sampled.call_count, calls)
                    self.assertEqual(key.call_count, key_calls)
                    unrelated = original.replace("def kuwahara(img, radius=5", "def kuwahara(img, radius=6")
                    self.assertNotEqual(unrelated, original)
                    copied.write_text(unrelated)
                    restart()
                    np.testing.assert_array_equal(sample(), first)
                    self.assertEqual(sampled.call_count, calls)
                    changed = original.replace("return np.meshgrid(xs, ys)", "return np.meshgrid(xs, ys, copy=True)")
                    self.assertNotEqual(changed, original)
                    copied.write_text(changed)
                    restart()
                    result = sample()
                    self.assertGreater(sampled.call_count, calls)
                    calls = sampled.call_count
                    np.testing.assert_array_equal(sample(), result)
                    self.assertEqual(sampled.call_count, calls)
                    self.assertEqual(key.call_count, 3)

    def test_ipr_samples_follow_area_box_resolution_and_source_replacement(self):
        first = gc.ipr_dsm("praha", TILE, 1.0)
        np.testing.assert_array_equal(gc.ipr_dsm("praha", TILE, 1.0), first)
        self.assertFalse(np.array_equal(gc.ipr_dsm("ujezd", TILE, 1.0), first))
        self.assertFalse(np.array_equal(gc.ipr_dsm("praha", SHIFTED, 1.0), first))
        self.assertEqual(gc.ipr_dsm("praha", TILE, 2.0).shape, (2, 2))
        replacement = self.root / "replacement.tif"
        tifffile.imwrite(replacement, np.full((16, 16), 500, np.float32), tile=(16, 16))
        replacement.replace(gc.IPR_DSM)
        np.testing.assert_array_equal(gc.ipr_dsm("praha", TILE, 1.0), np.full((4, 4), 500, np.float32))

    def test_uncached_ipr_sampling_does_not_write_an_array(self):
        self.assertEqual(gc.ipr_dsm("praha", TILE, 1.0, cache=False).shape, (4, 4))
        self.assertEqual(list(self.root.rglob("*.npy")), [])

    def test_photo_reuses_only_the_same_source_box_and_resolution(self):
        def photo(**kw):
            return gc.photo(kw.get("url", "fixture"), "rgb", "praha", kw.get("tile", TILE), kw.get("res", 1.0))
        first = photo()
        np.testing.assert_array_equal(photo(), first)
        self.assertEqual(self.fetch.call_count, 1)
        for case in ({"tile": SHIFTED}, {"res": 2.0}, {"url": "other-source"}):
            with self.subTest(case=case):
                before = self.fetch.call_count
                result = photo(**case)
                self.assertEqual(self.fetch.call_count, before + 1)
                np.testing.assert_array_equal(photo(**case), result)
                self.assertEqual(self.fetch.call_count, before + 1)
        self.assertTrue((gc.PHOTOS / "praha" / "rgb" / "0_0.jpg").exists())

    def test_photo_window_reuses_the_full_tile_download(self):
        full = gc.photo("fixture", "rgb", "praha", TILE, 1.0)
        part = gc.photo("fixture", "rgb", "praha", TILE, 1.0, window=(1, 3, 0, 2))
        np.testing.assert_array_equal(part, full[1:3, :2])
        self.fetch.assert_called_once()

    def test_legacy_photo_without_provenance_is_a_miss(self):
        legacy = gc.PHOTOS / "praha" / "rgb" / "0_0.jpg"
        legacy.parent.mkdir(parents=True)
        Image.fromarray(np.full((6, 6, 3), 255, np.uint8)).save(legacy)
        self.assertLess(gc.photo("fixture", "rgb", "praha", TILE, 1.0).max(), 1)
        self.fetch.assert_called_once()

    def test_interrupted_array_write_does_not_replace_a_good_cache(self):
        first = self.export()
        array = next(self.root.rglob("*.npy"))
        before = array.read_bytes()
        write_bytes = Path.write_bytes

        def interrupted(path, raw):
            write_bytes(path, raw[:3])
            raise OSError("simulated interrupted write")

        with patch.object(Path, "write_bytes", interrupted), self.assertRaisesRegex(OSError, "interrupted"):
            self.export(url="other-source")
        self.assertEqual(array.read_bytes(), before)
        np.testing.assert_array_equal(self.export(), first)
        self.assertEqual(self.fetch.call_count, 2)

    def test_interrupted_metadata_write_cannot_approve_changed_array_bytes(self):
        self.export()
        with patch.object(gc.build_cache, "write_json", side_effect=OSError("interrupted metadata")):
            with self.assertRaisesRegex(OSError, "metadata"):
                self.export(url="other-source")
        result = self.export()
        self.assertEqual(self.fetch.call_count, 3)
        np.testing.assert_array_equal(self.export(), result)
        self.assertEqual(self.fetch.call_count, 3)

    def test_cache_cleanup_keeps_the_active_wide_surface_model(self):
        active = self.root / "cover" / "img" / "dsm_1m_wide"
        active.mkdir(parents=True)
        with patch.object(cache_stale, "CACHE", self.root):
            self.assertNotIn(active, [p for p, _ in cache_stale.stale({})])


class ProcessingKeyTests(unittest.TestCase):
    def test_producers_use_the_keys_checked_by_assembly(self):
        self.assertEqual(young_woods.processing(), layers.young_processing())
        self.assertEqual(tree_sizes.processing(), layers.treesize_processing())

    def test_shared_helpers_invalidate_layers_but_unrelated_prototype_edits_do_not(self):
        source = Path(gc.__file__).read_text()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("young_woods.py", "tree_sizes.py"):
                (root / name).write_bytes(Path(layers.__file__).with_name(name).read_bytes())
            copied = root / "ground_cover.py"
            copied.write_text(source)
            with patch.object(layers, "__file__", str(root / "layers.py")):
                before = [layers.young_processing(), layers.treesize_processing()]
                unrelated = source.replace("def kuwahara(img, radius=5", "def kuwahara(img, radius=6")
                self.assertNotEqual(unrelated, source)
                copied.write_text(unrelated)
                self.assertEqual([layers.young_processing(), layers.treesize_processing()], before)
                changed = source.replace('record.get("input") == inputs', 'record.get("input") != inputs')
                self.assertNotEqual(changed, source)
                copied.write_text(changed)
                for key, previous in zip([layers.young_processing(), layers.treesize_processing()], before):
                    self.assertNotEqual(key, previous)


if __name__ == "__main__":
    unittest.main()
