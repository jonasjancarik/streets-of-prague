"""Survey errors must not become interpolated spikes or cross-tile seams."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import shapely
from shapely.geometry import MultiLineString, box
import dtm_heights as dh


class Identity:
    def transform(self, x, y):
        return x, y


class SurveyVertexTests(unittest.TestCase):
    def samples(self, lines, at=lambda p: np.full(len(p), 194.0)):
        return dh._survey_points([np.array(c, dtype=float) for c in lines], Identity(), at)

    def test_reject_before_interpolation_without_bridging_missing_vertex(self):
        points, rejected = self.samples([[(0, 0, 194), (6, 0, 294), (12, 0, 194)]])
        np.testing.assert_array_equal(points, [[0, 0, 194], [12, 0, 194]])
        self.assertEqual(rejected, 1)

    def test_connected_valid_runs_keep_surveyed_gradient(self):
        points, rejected = self.samples([[(0, 0, 194), (6, 0, 197), (12, 0, 294), (18, 0, 203), (24, 0, 206)]])
        self.assertEqual(rejected, 1)
        self.assertFalse(np.any((points[:, 0] > 6) & (points[:, 0] < 18)))
        np.testing.assert_allclose(points[:, 2], 194 + points[:, 0] / 2)

    def test_quay_ramp_and_underpass_corrections_retained(self):
        for height in [187.0, 201.0, 220.0]:
            with self.subTest(height=height):
                points, rejected = self.samples([[(0, 0, height), (8, 0, height)]])
                self.assertEqual(rejected, 0)
                self.assertGreater(len(points), 2)
                np.testing.assert_array_equal(points[:, 2], height)

    def test_steep_coherent_hillside_retained(self):
        points, rejected = self.samples([[(0, 0, 194), (10, 0, 224), (20, 0, 254)]], lambda p: 194 + p[:, 0] * 3)
        self.assertEqual(rejected, 0)
        np.testing.assert_allclose(points[:, 2], 194 + points[:, 0] * 3)

    def test_unknown_terrain_does_not_reject_finite_survey(self):
        points, rejected = self.samples([[(0, 0, 294), (8, 0, 295)]], lambda p: np.full(len(p), np.nan))
        self.assertEqual(rejected, 0)
        self.assertGreater(len(points), 2)

    def test_nonfinite_vertices_split_runs(self):
        points, rejected = self.samples([[(0, 0, 194), (3, 0, np.nan), (6, 0, 194), (np.inf, 0, 194)]])
        self.assertEqual(rejected, 2)
        np.testing.assert_array_equal(points, [[0, 0, 194], [6, 0, 194]])

    def test_all_rejected_and_empty_sources(self):
        points, rejected = self.samples([[(0, 0, 294), (8, 0, 294)]])
        self.assertEqual(points.shape, (0, 3))
        self.assertEqual(rejected, 2)
        self.assertEqual(dh._survey_points([], Identity(), None)[0].shape, (0, 3))

    def test_multiline_components_remain_separate_in_source_cache(self):
        line = MultiLineString([[(0, 0, 194), (6, 0, 194)], [(20, 0, 200), (26, 0, 200)]])
        wall = MultiLineString([[(0, 8), (6, 8)], [(20, 8), (26, 8)]])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            packages, lines = root / 'ZPS_OPL', root / 'ZPS_KR'
            packages.mkdir(); lines.mkdir()
            (packages / 'surfaces.zip').touch(); (lines / 'lines.zip').touch()
            def tables(package, codes):
                if package.parent == packages:
                    return [('surface', 0, box(0, -1, 26, 1))]
                return [('010000030402', 0, line), ('010000016802', 0, wall)]
            with patch.object(dh, 'CACHE', root), patch.object(dh, 'PACKAGES', packages), patch.object(dh, 'LINES', lines), \
                    patch.object(dh, '_tables', new=tables), patch.object(dh, '_inside', new=lambda g, _: g):
                _, raw, walls = dh.survey('test', (14.4, 50.08, 14.41, 50.09))
                self.assertEqual(len(raw), 2)
                self.assertEqual(len(walls), 2)
                points, _ = dh._survey_points(raw, Identity(), lambda p: np.full(len(p), 194.0))
                self.assertFalse(np.any((points[:, 0] > 6) & (points[:, 0] < 20)))
                _, cached, _ = dh.survey('test', (14.4, 50.08, 14.41, 50.09))
                np.testing.assert_array_equal(cached[0], raw[0])


class TerrainApplyTests(unittest.TestCase):
    def build(self, lines):
        xx, yy = np.meshgrid(np.arange(9) * 4, np.arange(9) * 4)
        water = shapely.Polygon([(18, -1), (33, -1), (33, 33), (23, 33)])
        bare = np.where(shapely.contains_xy(water, xx, yy), 184.0, 194.0).astype(np.float32)
        tiles = {(i, j): bare[j * 4:j * 4 + 5, i * 4:i * 4 + 5].copy() for i in range(2) for j in range(2)}
        boxes = {(i, j): box(i * 16, j * 16, (i + 1) * 16, (j + 1) * 16) for i, j in tiles}
        with patch.object(dh, 'survey', return_value=([box(7, -1, 13, 33)], [np.array(c, float) for c in lines], [])):
            out = dh.apply('test', None, Identity(), tiles, 4, 4.0, 0, 0, water, boxes)
        return tiles, out

    def test_spike_does_not_spread_to_street_bank_or_water_and_seams_match(self):
        tiles, out = self.build([[(7, 0, 194), (7, 12, 294), (7, 20, 194), (7, 32, 194)], [(13, 0, 194), (13, 32, 194)]])
        self.assertEqual(out['survey_rejected_vertices'], 1)
        self.assertGreater(out['street_points'], 0)
        self.assertGreater(out['water_points'], 0)
        for k, grid in tiles.items():
            self.assertTrue(np.isfinite(grid).all())
            self.assertLessEqual(grid.max(), 194.0)
            np.testing.assert_array_equal(grid[out['labels'][k] == 1], 184.0)
            self.assertGreater(grid[out['labels'][k] == 0].min(), 184.0)
        for j in range(2):
            np.testing.assert_array_equal(tiles[0, j][:, -1], tiles[1, j][:, 0])
        for i in range(2):
            np.testing.assert_array_equal(tiles[i, 0][-1], tiles[i, 1][0])

    def test_water_still_processed_when_all_vertices_rejected(self):
        tiles, out = self.build([[(7, 0, 294), (7, 32, 294)]])
        self.assertEqual(out['street_points'], 0)
        self.assertEqual(out['survey_rejected_vertices'], 2)
        self.assertGreater(out['water_points'], 0)
        for k, grid in tiles.items():
            np.testing.assert_array_equal(grid[out['labels'][k] == 1], 184.0)


def _river(length=200, width=12):
    """A straight river on a 4 m lattice: `width` points across (48 m), land either side."""
    wet = np.zeros((width + 8, length), dtype=bool)
    wet[4:4 + width] = True
    return wet


class WaterLevelTests(unittest.TestCase):
    def test_water_stands_no_higher_than_the_water_it_is_joined_to(self):
        wet = _river()
        level = np.where(wet, 5.0, np.inf).astype(np.float32)
        level[:, 120:] = np.where(wet[:, 120:], 45.0, np.inf)  # past the terrain model's edge: the plateau's height
        level[4:7, 40:60] = 9.0  # a bank's ramp the lowest terrain nearby didn't clear
        out, lowered = dh.level_water(level, wet, 4.0)
        assert lowered > 900
        assert out[wet].max() < 5.0 + 800 * dh.POOL_FALL + 0.3
        assert np.all(np.abs(np.diff(out[10])) < 0.05)

    def test_a_weir_keeps_the_pools_apart(self):
        wet = _river()
        level = np.where(wet, 5.0, np.inf).astype(np.float32)
        level[:, :100] = np.where(wet[:, :100], 7.5, np.inf)  # the pool above the weir
        weir = dh.weir_points([[[398.0, 0.0], [398.0, 120.0]]], wet.shape, lambda i: i * 4.0, lambda j: j * 4.0, 4.0)
        assert weir[:, 99].all() and not weir[:, 90].any()
        out, _ = dh.level_water(level, wet, 4.0, weir)
        assert np.allclose(out[wet & ~weir][:1], 7.5) and np.allclose(out[10, :95], 7.5) and np.allclose(out[10, 105:], 5.0)
        # Without the weir the upper pool would drain into the lower one.
        drained, _ = dh.level_water(level, wet, 4.0)
        assert drained[10, 50] < 5.5

    def test_a_sluice_between_two_pieces_of_a_weir_is_part_of_it(self):
        pieces = [[[400.0, 0.0], [400.0, 40.0]], [[400.0, 60.0], [400.0, 120.0]]]
        weir = dh.weir_points(pieces, (30, 200), lambda i: i * 4.0, lambda j: j * 4.0, 4.0)
        assert weir[12, 100] and weir[13, 100]

    def test_a_brook_keeps_its_fall(self):
        wet = np.zeros((9, 200), dtype=bool)
        wet[4] = True  # one point wide: narrow water
        level = np.where(wet, 5.0 + np.arange(200) * 4.0 * 0.03, np.inf).astype(np.float32)  # 3 % uphill
        out, lowered = dh.level_water(level, wet, 4.0)
        assert lowered == 0 and np.allclose(out[wet], level[wet])

    def test_a_lock_beside_a_weir_does_not_drain_the_upper_pool(self):
        wet = _river()
        wet[18:20, 80:120] = True  # a lock two points wide, round the weir
        wet[16:18, 80:82] = wet[16:18, 118:120] = True
        level = np.where(wet, 5.0, np.inf).astype(np.float32)
        level[:, :100] = np.where(wet[:, :100], 7.5, np.inf)
        weir = np.zeros(wet.shape, dtype=bool)
        weir[4:16, 98:102] = True
        out, _ = dh.level_water(level, wet, 4.0, weir)
        assert np.allclose(out[10, :95], 7.5) and np.allclose(out[10, 105:], 5.0)
        assert out[18, 81] > 7.0 and out[18, 119] < 5.1  # the lock's ends at their pools' levels

    def test_a_ramp_along_the_bank_comes_down_to_the_pool(self):
        wet = _river()
        level = np.where(wet, 5.0, np.inf).astype(np.float32)
        level[4:6, 40:60] = 9.0  # the terrain model's bank, in the water's first two rows
        out, lowered = dh.level_water(level, wet, 4.0)
        assert lowered == 40 and out[4:6, 40:60].max() < 5.5


if __name__ == '__main__':
    unittest.main()
