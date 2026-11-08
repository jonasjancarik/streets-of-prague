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

    def test_sunk_below_flat_ground_rejected(self):
        # náměstí Míru: a kerb whose every other vertex is 21 m below the square.
        flat = lambda p: np.full(len(p), 243.0)  # noqa: E731
        points, rejected = dh._survey_points([np.array([(0, 0, 243.6), (1, 0, 222.5), (3, 0, 243.8), (4, 0, 222.7)], dtype=float)],
                                             Identity(), flat, flat)
        self.assertEqual(rejected, 2)
        np.testing.assert_array_equal(points[:, 2], [243.6, 243.8])

    def test_sunk_near_lower_ground_retained(self):
        # A quay 21 m below the street 10 m away is low ground nearby, not an error.
        points, rejected = dh._survey_points([np.array([(0, 0, 222.0), (8, 0, 222.0)], dtype=float)], Identity(),
                                             lambda p: np.full(len(p), 243.0), lambda p: np.full(len(p), 221.0))
        self.assertEqual(rejected, 0)
        self.assertGreater(len(points), 2)

    def test_under_the_scan_moved_up(self):
        # Svornosti: a kerb's corner 2.2 m under the junction the scan has at 194.3–194.5 m.
        scan = lambda xs, ys, reach: (np.full(len(xs), 194.3), np.full(len(xs), 194.5))  # noqa: E731
        counts = {}
        points, rejected = dh._survey_points([np.array([(0, 0, 194.6), (6, 0, 192.1), (12, 0, 194.5)], dtype=float)],
                                             Identity(), lambda p: np.full(len(p), 194.0), None, scan, counts)
        self.assertEqual(rejected, 0)
        self.assertEqual(counts["off_scan"], 1)
        self.assertAlmostEqual(points[np.argmin(np.abs(points[:, 0] - 6)), 2], 194.3)
        self.assertGreater(points[:, 2].min(), 194.2)

    def test_under_the_scan_by_a_bridge_kept(self):
        # A quay street under a bridge's end, where the scan has the abutment over it.
        scan = lambda xs, ys, reach: (np.full(len(xs), 194.2), np.full(len(xs), 194.4))  # noqa: E731
        counts = {}
        points, _ = dh._survey_points([np.array([(0, 0, 191.0), (8, 0, 191.0)], dtype=float)], Identity(),
                                      lambda p: np.full(len(p), 192.0), None, scan, counts,
                                      lambda p: p[:, 0] > 4)
        self.assertEqual(counts["off_scan"], 1)
        self.assertEqual(points[0, 2], 194.2)
        self.assertEqual(points[-1, 2], 191.0)

    def test_over_the_scan_kept(self):
        # An elevated road surveyed as ground: left as it was (its bridge's joins need it).
        scan = lambda xs, ys, reach: (np.full(len(xs), 200.0), np.full(len(xs), 200.4))  # noqa: E731
        points, rejected = dh._survey_points([np.array([(0, 0, 206.0), (8, 0, 206.0)], dtype=float)],
                                             Identity(), lambda p: np.full(len(p), 201.0), None, scan, {})
        self.assertEqual(rejected, 0)
        np.testing.assert_array_equal(points[:, 2], 206.0)

    def test_kerb_by_a_wall_within_the_scans_range_retained(self):
        # The scan has the wall's foot and top within 2 m: a kerb at either is on the ground.
        scan = lambda xs, ys, reach: (np.full(len(xs), 200.0), np.full(len(xs), 203.0))  # noqa: E731
        points, rejected = dh._survey_points([np.array([(0, 0, 200.2), (8, 0, 202.9)], dtype=float)],
                                             Identity(), lambda p: np.full(len(p), 201.5), None, scan)
        self.assertEqual(rejected, 0)
        self.assertGreater(len(points), 2)
        self.assertAlmostEqual(points[0, 2], 200.2)

    def test_no_scan_there_does_not_reject(self):
        scan = lambda xs, ys, reach: (np.full(len(xs), np.nan), np.full(len(xs), np.nan))  # noqa: E731
        points, rejected = dh._survey_points([np.array([(0, 0, 192.1), (8, 0, 192.1)], dtype=float)],
                                             Identity(), lambda p: np.full(len(p), 194.0), None, scan)
        self.assertEqual(rejected, 0)

    def test_unknown_lowest_does_not_reject(self):
        points, rejected = dh._survey_points([np.array([(0, 0, 222.0), (8, 0, 222.0)], dtype=float)], Identity(),
                                             lambda p: np.full(len(p), 243.0), lambda p: np.full(len(p), np.nan))
        self.assertEqual(rejected, 0)

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


class UnderpassTests(unittest.TestCase):
    """A street over a short underpass, both one surveyed surface (Na Veselí under
    5. května): the street's kerbs at 200 m along y = 18, the underpass road's at 194.5 m
    along y = 2, in the map's tunnel."""

    def build(self, tunnels):
        bare = np.full((17, 17), 200.0, dtype=np.float32)
        tiles = {(0, 0): bare.copy()}
        boxes = {(0, 0): box(0, 0, 64, 64)}
        lines = [[(2, 18, 200), (62, 18, 200)], [(2, 2, 194.5), (62, 2, 194.5)]]
        with patch.object(dh, 'survey', return_value=([box(2, 2, 62, 18)], [np.array(c, float) for c in lines], [])):
            out = dh.apply('test', None, Identity(), tiles, 16, 4.0, 0, 0, None, boxes, tunnels=tunnels)
        return tiles[0, 0], out

    def test_the_street_over_an_underpass_keeps_its_own_kerbs(self):
        before, _ = self.build(())
        after, out = self.build([(shapely.LineString([(10, 2), (54, 2)]), 2.0)])
        self.assertLess(before[2, 8], 197.0)  # (32, 8): the road's kerbs were nearest
        self.assertGreater(out['sunk_kerbs'], 0)
        self.assertAlmostEqual(float(after[2, 8]), 200.0, delta=0.3)


class DeckKerbTests(unittest.TestCase):
    """A road in a cutting under an overpass, one surveyed surface (the D0 under Na
    Radosti): the road's kerbs at 200 m along y = 20 and y = 44, the overpass's deck
    kerbs at 209 m along x = 28 and x = 36, surveyed as ground. The LiDAR has no bridges:
    200 m everywhere."""

    def build(self, bridges, scan):
        bare = np.full((17, 17), 200.0, dtype=np.float32)
        tiles = {(0, 0): bare.copy()}
        boxes = {(0, 0): box(0, 0, 64, 64)}
        lines = [[(2, 20, 200), (62, 20, 200)], [(2, 44, 200), (62, 44, 200)],
                 [(28, 2, 209), (28, 62, 209)], [(36, 2, 209), (36, 62, 209)]]
        flat = lambda xs, ys, reach: (np.full(len(xs), 200.0, dtype=np.float32), np.full(len(xs), 200.0, dtype=np.float32))  # noqa: E731
        with patch.object(dh, 'survey', return_value=([box(2, 2, 62, 62)], [np.array(c, float) for c in lines], [])):
            out = dh.apply('test', None, Identity(), tiles, 16, 4.0, 0, 0, None, boxes, bridges=bridges,
                           scan=flat if scan else None, level_across=False)
        return tiles[0, 0], out

    def test_the_road_under_a_bridge_takes_no_kerbs_of_its_deck(self):
        bridge = [box(30, 0, 34, 64)]
        before, _ = self.build(bridge, scan=False)
        after, out = self.build(bridge, scan=True)
        self.assertGreater(before[8, 8], 207.0)  # (32, 32): the upper level, the deck's
        self.assertGreater(out['deck_kerbs'], 0)
        self.assertAlmostEqual(float(after[8, 8]), 200.0, delta=0.3)

    def test_the_lidar_picks_one_of_two_levels_without_a_bridge(self):
        before, _ = self.build((), scan=False)
        after, out = self.build((), scan=True)
        self.assertGreater(before[8, 7], 201.0)  # (28, 32): the two levels averaged
        self.assertEqual(out['deck_kerbs'], 0)
        self.assertGreater(out['scan_lower'], 0)
        self.assertAlmostEqual(float(after[8, 7]), 200.0, delta=0.3)

    def test_past_a_bridge_s_end_the_scan_leaves_the_upper_level(self):
        # The bridge ends 4 m short of (32, 32): the street on from it is on the viaduct
        # the scan doesn't see (Hlávkův most's north end).
        after, _ = self.build([box(30, 0, 34, 28)], scan=True)
        self.assertGreater(float(after[8, 8]), 207.0)


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


class LidarGroundTests(unittest.TestCase):
    """The LiDAR as the ground (`sharp`): the scan is bare earth, 200 m everywhere, and
    one street surveyed across the whole square, its kerbs along y = 20 and y = 44."""

    def build(self, kerbs):
        tiles = {(0, 0): np.full((17, 17), 200.0, dtype=np.float32)}
        boxes = {(0, 0): box(0, 0, 64, 64)}
        lines = [[(2, 20, kerbs), (62, 20, kerbs)], [(2, 44, kerbs), (62, 44, kerbs)]]
        with patch.object(dh, 'survey', return_value=([box(2, 2, 62, 62)], [np.array(c, float) for c in lines], [])):
            dh.apply('test', None, Identity(), tiles, 16, 4.0, 0, 0, None, boxes, sharp=True)
        return tiles[0, 0]

    def test_a_street_near_the_scan_is_the_scan(self):
        self.assertAlmostEqual(float(self.build(200.3)[8, 8]), 200.0, delta=0.01)

    def test_a_street_on_a_viaduct_the_map_does_not_draw_keeps_the_survey(self):
        self.assertAlmostEqual(float(self.build(209.0)[8, 8]), 209.0, delta=0.01)

    def test_in_between_it_is_a_mix(self):
        h = float(self.build(201.0)[8, 8])
        self.assertGreater(h, 200.2)
        self.assertLess(h, 200.8)
