import unittest

import numpy as np
from shapely.geometry import LineString

from bridge_joins import apply_spans, landing


class BridgeJoins(unittest.TestCase):
    def test_landing_only_after_road_recovers_across_its_width(self):
        road = LineString([(0, 0), (22, 0)])
        ground = lambda pts: np.where(pts[:, 0] < 4 + pts[:, 1] / 2, 236.0, 242.0)
        self.assertEqual(landing(road, 5, 242, ground), (8.0, 242.0))
        for height in (236.0, 242.0):
            self.assertIsNone(landing(road, 5, 242, lambda pts: np.full(len(pts), height)))

    def test_spans_use_endpoints_of_each_tile_copy(self):
        edges = [dict(id="a", pts=[[x, 0], [20, 0]]) for x in (0, 10)]
        apply_spans(edges, {"a": [([20, 0], 4.0, 1)]})
        self.assertEqual([e["levels"] for e in edges], [[[0, 0], [16.0, 1]], [[0, 0], [6.0, 1]]])

    def test_upper_span_can_cross_a_lower_street_without_changing_its_ground(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from bridge_joins import fit_tile

        box = [[21, 12], [40, 12], [40, 18], [21, 18]]
        upper = dict(id="bridge", u="b", v="c", bridge=True, level=1, pts=[[21, 15], [40, 15]], width=6)
        approach = dict(id="approach", u="a", v="b", pts=[[3, 15], [21, 15]], width=6)
        lower = dict(id="under", u="d", v="e", pts=[[20, 1], [20, 32]], width=5)
        pad = [[17, 17.5], [21, 17.5], [21, 19], [17, 19]]
        tile = dict(
            i=0,
            j=0,
            box=[0, 0, 49, 49],
            drive=[upper, approach],
            structures=[dict(kind="bridge", level=1, polys=[[box]])],
            terraces=[dict(h=240, polys=[[pad]])],
        )
        grid = np.full((50, 50), 1400, dtype="<u2")
        grid[:, 19:22] = 1340
        with TemporaryDirectory() as tmp:
            directory = Path(tmp)
            ground = directory / "0_0.height.bin"
            ground.write_bytes(grid.tobytes())
            (directory / "0_0.levels.bin").write_bytes(np.full_like(grid, 14000).tobytes())
            meta = dict(n=50, step=1)
            self.assertFalse(fit_tile(tile, meta, directory))
            tile["drive"].append(lower)
            joins = fit_tile(tile, meta, directory)
            self.assertEqual(set(joins), {"approach"})
            self.assertEqual(ground.read_bytes(), grid.tobytes())
            apply_spans(tile["drive"], joins)
            self.assertEqual(approach["levels"][-1][1], 1)
            self.assertNotIn("levels", lower)
