"""A man_made=bridge outline takes the height of the carriageway that covers most of it
(structures.pieces): Barrandovský most's east end, where a cycleway runs the whole
outline and down a ramp off it, and the outline was drawn at the cycleway's height,
a second deck under the main one and wider than it."""
import unittest

import numpy as np
from shapely.geometry import box

import structures


def way(ident, pts, w, h):
    length = float(np.hypot(*np.subtract(pts[-1], pts[0])))
    return {"id": ident, "kind": "bridge", "layer": 1, "mapped_layer": 1, "hw": "trunk", "w": w, "pts": pts,
            "nodes": [ident * 10, ident * 10 + 1], "grade": [False, False]}, (np.array([0.0, length]), np.array(h, float))


class BridgeOutlineTests(unittest.TestCase):
    def test_the_carriageway_not_the_longest_way_gives_the_outline_its_height(self):
        road, road_profile = way(1, [(0.0, 2.0), (80.0, 2.0)], 14.0, [203.0, 203.0])
        cycleway, cycleway_profile = way(2, [(0.0, -8.0), (100.0, -8.0)], 2.5, [202.0, 189.0])
        out, groups = structures.pieces([road, cycleway], [road_profile, cycleway_profile], [box(0, -10, 100, 10)],
                                        lambda xs, ys: np.full(len(xs), 185.0), {}, None)
        outline = out[-1]
        self.assertAlmostEqual(outline.height(np.array([40.0]), np.array([2.0]))[0], 203.0, delta=0.01)
        group = next(g for g in groups if outline in g)
        self.assertIn(out[0], group)
        self.assertNotIn(out[1], group)


if __name__ == "__main__":
    unittest.main()
