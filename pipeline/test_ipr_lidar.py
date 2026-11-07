import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np

import build_cache
import ipr_lidar
import ipr_terrain
from ipr_buildings import krovak_to_local

ORIGIN = (-744000.25, -1041500.75)
LOCAL = "+proj=tmerc +lat_0=50.08 +lon_0=14.41 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"


class LidarTests(unittest.TestCase):
    def test_interpolates_from_pixel_centres_and_respects_grid_edges(self):
        h = np.array([[200, 202], [206, 208]], dtype=np.float32)
        x, y = ORIGIN
        np.testing.assert_allclose(ipr_lidar.sample_projected(h, ORIGIN, [x, x + 1, x + .25], [y, y - 1, y - .5]),
                                   [200, 208, 203.5])
        self.assertTrue(np.isnan(ipr_lidar.sample_projected(h, ORIGIN, [x - .1, x + 1.1, np.nan], y)).all())

    def test_no_interpolation_across_missing_cells(self):
        h = np.array([[200, 202], [np.nan, 208]], dtype=np.float32)
        x, y = ORIGIN
        np.testing.assert_allclose(ipr_lidar.sample_projected(h, ORIGIN, x + .5, [y, y - .5]), [201, np.nan])

    def test_range_within_reach_by_cell_centres(self):
        h = np.array([[200, 201, 202, 203], [204, 205, np.nan, 207], [208, 209, 210, 211]], dtype=np.float32)
        x, y = ORIGIN
        # Cell (1, 1): its four neighbours are within 1 m, the corners aren't; the missing
        # cell doesn't count, and a point off the raster has nothing.
        lo, hi = ipr_lidar.range_projected(h, ORIGIN, [x + 1, x + 3, x - 5], [y - 1, y - 1, y], 1)
        np.testing.assert_allclose(lo, [201, 203, np.nan])
        np.testing.assert_allclose(hi, [209, 211, np.nan])

    def test_terrain_transform_matches_citygml_alignment(self):
        x, y = ORIGIN
        local_xy = krovak_to_local(LOCAL).transform(x + .25, y - .5)
        with tempfile.TemporaryDirectory() as tmp:
            heights, manifest = ipr_lidar.source_paths(tmp)
            np.save(heights, np.array([[200, 202], [206, 208]], dtype="<f4"))
            manifest.write_text(json.dumps({"format": ipr_lidar.CACHE_FORMAT, "source": ipr_lidar.SOURCE,
                                            "archiveSha256": ipr_lidar.ARCHIVE_SHA256, "origin": ORIGIN, "shape": [2, 2]}))
            at, provenance = ipr_lidar.sampler(tmp, LOCAL)
            # The Czech datum transform round-trips within millimetres of position.
            self.assertAlmostEqual(float(at(*local_xy)), 203.5, delta=.02)
            self.assertEqual(provenance["verticalDatum"], "Bpv")
            heights.write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "Import DTM.zip"):
                ipr_lidar.sampler(tmp, LOCAL)

    def test_cache_paths_affect_only_opted_in_terrain(self):
        with tempfile.TemporaryDirectory() as tmp:
            options = {"ipr_lidar": tmp}
            baseline = build_cache.sources(ipr_terrain.source_paths("ujezd", {}))
            before = build_cache.sources(ipr_terrain.source_paths("ujezd", options))
            for path in ipr_lidar.source_paths(tmp):
                self.assertIsNone(before[str(path.resolve())])
                path.write_bytes(b"finished")
            self.assertNotEqual(before, build_cache.sources(ipr_terrain.source_paths("ujezd", options)))
            self.assertEqual(baseline, build_cache.sources(ipr_terrain.source_paths("ujezd", {})))

    def test_rejects_partial_archive_without_publishing(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive, cache = Path(tmp) / "DTM.zip.part", Path(tmp) / "cache"
            archive.write_bytes(b"PK\x03\x04")
            with self.assertRaisesRegex(ValueError, "unexpected IPR archive SHA-256"):
                ipr_lidar.import_archive(archive, cache)
            self.assertFalse(cache.exists())

    @unittest.skipUnless(importlib.util.find_spec("tifffile"), "optional TIFF importer")
    def test_import_checks_reference_and_masks_float32_nodata(self):
        import tifffile

        x, y = ORIGIN
        with tempfile.TemporaryDirectory() as tmp:
            archive, cache, tiff = [Path(tmp) / name for name in ("DTM.zip", "cache", "source.tif")]
            h = np.array([[200, 202], [np.finfo(np.float32).min, 208]], dtype=np.float32)
            tags = [(33550, "d", 3, (1, 1, 0), False), (33922, "d", 6, (0, 0, 0, x - .5, y + .5, 0), False),
                    (34735, "H", 12, (1, 1, 0, 2, 1025, 0, 1, 1, 3072, 0, 1, 5514), False),
                    (42113, "s", 0, "-3.4028234663852886e+38", False)]
            tifffile.imwrite(tiff, h, extratags=tags)
            with zipfile.ZipFile(archive, "w") as z:
                z.write(tiff, "dtm_1m.tif")
                z.writestr("dtm_1m.tfw", f"1\n0\n0\n-1\n{x}\n{y + 1}\n")
            with patch.object(ipr_lidar, "ARCHIVE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest()):
                with self.assertRaisesRegex(ValueError, "disagree"):
                    ipr_lidar.import_archive(archive, cache)
            self.assertFalse(cache.exists())

            with zipfile.ZipFile(archive, "w") as z:
                z.write(tiff, "dtm_1m.tif")
                z.writestr("dtm_1m.tfw", f"1\n0\n0\n-1\n{x}\n{y}\n")
            with patch.object(ipr_lidar, "ARCHIVE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest()):
                record = ipr_lidar.import_archive(archive, cache)
                self.assertEqual(record["validCells"], 3)
                with self.assertRaises(FileExistsError):
                    ipr_lidar.import_archive(archive, cache)
            np.testing.assert_allclose(np.load(cache / ipr_lidar.HEIGHTS), [[200, 202], [np.nan, 208]])


if __name__ == "__main__":
    unittest.main()
