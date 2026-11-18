"""A man_made=bridge outline takes the height of the carriageway that covers most of it
(structures.pieces): Barrandovský most's east end, where a cycleway runs the whole
outline and down a ramp off it, and the outline was drawn at the cycleway's height,
a second deck under the main one and wider than it."""
import unittest
from unittest.mock import patch

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

    def test_a_sloping_viaduct_keeps_its_far_carriageways_and_not_a_flyover(self):
        # Wilsonova's viaduct falls 10 m from Hlavní nádraží to Bulhar. The long way at the
        # top end gives the outline its reference height; the carriageways at the bottom end
        # (one running on from it, one beside that) are 5 m under it at their middles but
        # at the deck's height beside it. A flyover crosses 17 m over the bottom end.
        top, top_profile = way(1, [(0.0, 0.0), (200.0, 0.0)], 14.0, [206.0, 201.0])
        on, on_profile = way(2, [(200.0, 0.0), (300.0, 0.0)], 10.0, [201.0, 196.0])
        on["nodes"] = [11, 21]  # runs on from the top way's end
        twin, twin_profile = way(3, [(300.0, 10.0), (200.0, 10.0)], 10.0, [196.0, 201.0])
        flyover, flyover_profile = way(4, [(250.0, -30.0), (250.0, 40.0)], 10.0, [215.0, 215.0])
        flyover["mapped_layer"] = None
        ways, profiles = [top, on, twin, flyover], [top_profile, on_profile, twin_profile, flyover_profile]
        args = ([box(0, -8, 300, 18)], lambda xs, ys: np.full(len(xs), 185.0), {}, None)
        out, groups = structures.pieces(ways, profiles, *args)
        outline = out[-1]
        group = next(g for g in groups if outline in g)
        self.assertEqual([p in group for p in out[:4]], [True, True, True, False])
        self.assertAlmostEqual(outline.height(np.array([250.0]), np.array([0.0]))[0], 198.5, delta=0.01)
        # The old rule, to compare: the bottom end's carriageways left out.
        with patch.object(structures, "OUTLINE_ALONG", False):
            out, groups = structures.pieces(ways, profiles, *args)
        group = next(g for g in groups if out[-1] in g)
        self.assertEqual([p in group for p in out[:4]], [True, False, False, False])


if __name__ == "__main__":
    unittest.main()
