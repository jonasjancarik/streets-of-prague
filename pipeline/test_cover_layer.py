"""The ground cover joins a tile as areas the game already draws, and goes stale with its inputs."""

import unittest

import layers

SHARED_EMPTY = layers.EMPTY["ground"]["areas"]


def tile(**areas):
    return {"areas": areas, "roads": {}, "buildings": [{"rings": [[[0, 0], [1, 0], [1, 1]]]}],
            "trees": [[10.0, 10.0]]}


class CoverMergeTests(unittest.TestCase):
    def test_classes_become_cover_areas_and_canopy_wood(self):
        t = tile(wood=[[[[0, 0], [1, 0], [1, 1]]]])
        layers.merge_cover(t, {"areas": {"grass": [["g"]], "trees": [["w"]]}, "trees": []})
        self.assertEqual(t["areas"]["cover_grass"], [["g"]])
        self.assertEqual(t["areas"]["wood"], [[[[0, 0], [1, 0], [1, 1]]], ["w"]])

    def test_tile_with_no_ground_of_its_own_leaves_the_shared_empty_one_alone(self):
        t = {"areas": SHARED_EMPTY, "trees": []}
        layers.merge_cover(t, {"areas": {"dirt": [["d"]]}, "trees": []})
        self.assertEqual(SHARED_EMPTY, {})
        self.assertIn("cover_dirt", t["areas"])

    def test_single_trees_next_to_a_surveyed_one_are_that_tree(self):
        t = tile()
        layers.merge_cover(t, {"areas": {}, "trees": [[11.0, 11.0], [20.0, 20.0]]})
        self.assertEqual(t["trees"], [[10.0, 10.0], [20.0, 20.0]])

    def test_key_follows_the_bare_ground_and_heights_but_not_the_cover(self):
        t = tile()
        key = layers.cover_key(t, "h1")
        layers.merge_cover(t, {"areas": {}, "trees": []})
        self.assertEqual(layers.cover_key(tile(), "h1"), key)
        self.assertNotEqual(layers.cover_key(tile(), "h2"), key)
        self.assertNotEqual(layers.cover_key(tile(park=[[["p"]]]), "h1"), key)

    def test_key_is_the_same_once_the_tiles_young_woods_are_in_it(self):
        t = tile(wood=[[["w"]]])
        key = layers.cover_key(t, "h1")
        t["areas"] = {**t["areas"], "young_wood": [[["y"]]]}
        self.assertEqual(layers.cover_key(t, "h1"), key)


class CoverGridTests(unittest.TestCase):
    def test_a_tiles_pixels_land_where_projecting_each_one_puts_them(self):
        try:
            import ground_cover as G
        except ImportError:
            self.skipTest("needs the cover dependency group")
        import numpy as np
        t = {"box": [-9250.0, 3000.0, -9000.0, 3250.0]}
        X, Y = G.grid(t, G.RES)
        to_ll, tf = G._transformers("praha")
        E, N = tf.transform(*to_ll.transform(X.ravel(), Y.ravel()))
        e, n = G.sjtsk("praha", t, G.RES)
        self.assertLess(max(np.abs(e - E).max(), np.abs(n - N).max()), 1e-4)  # of a 0.25 m pixel


class CoverSeamTests(unittest.TestCase):
    def test_two_tiles_give_the_cells_along_their_edge_the_same_class(self):
        try:
            import cover_cells as C
        except ImportError:
            self.skipTest("needs the cover dependency group")
        import numpy as np
        from scipy import ndimage
        rng = np.random.default_rng(4)
        M, T = round(C.MARGIN / C.RES), 200           # pixels of margin, and of a (small) tile
        h, w = T + 2 * M, 2 * T + 2 * M               # two tiles side by side, with their margins
        patchy = lambda sigma, lo, hi: lo + (hi - lo) * (lambda a: (a - a.min()) / (a.max() - a.min()))(ndimage.gaussian_filter(rng.random((h, w)), sigma))
        rgb = np.stack([patchy(6, 0.2, 0.95), patchy(6, 0.2, 0.9), patchy(6, 0.15, 0.85)], -1).astype(np.float32)
        cir = np.stack([patchy(9, 0.1, 0.9), patchy(9, 0.2, 0.8), patchy(9, 0.2, 0.8)], -1).astype(np.float32)
        dtm = np.full((h, w), 200, np.float32)
        dsm = dtm + patchy(8, -3, 6).astype(np.float32)
        mask = patchy(10, 0, 1) > 0.35

        def tile(c0):  # the tile whose own pixels start at column c0, worked out with its margin
            win = np.s_[:, c0 - M:c0 + T + M]
            return C.voted(C.classify(C.measure(rgb[win], cir[win], dsm[win], dtm[win]), mask[win]))
        west, east = tile(M), tile(M + T)
        m, t, k = round(C.MARGIN / C.CELL), round(T * C.RES / C.CELL), 6
        a, b = west[m:-m, m + t - k:m + t + k], east[m:-m, m - k:m + k]
        self.assertGreater(len(np.unique(a[a >= 0])), 2)  # (several classes do meet the edge)
        self.assertTrue((a == b).all())

    def test_a_tile_that_is_not_a_whole_number_of_cells_is_classified(self):
        try:
            import cover_cells as C
        except ImportError:
            self.skipTest("needs the cover dependency group")
        import numpy as np
        rng = np.random.default_rng(2)
        h, w = 577, 400                                # pixels: 288.5 cells high (an edge tile of ujezd)
        rgb, cir = rng.random((h, w, 3), np.float32), rng.random((h, w, 3), np.float32)
        dtm = np.full((h, w), 200, np.float32)
        near = {"building": np.zeros((289, 200), bool)}  # drawn at the cell size: a row more
        near["building"][100:120, 50:80] = True
        cls = C.classify(C.measure(rgb, cir, dtm + 1, dtm), np.ones((h, w), bool), near)
        self.assertEqual(cls.shape, (288, 200))

    def test_outlines_reach_the_tile_edge_and_stop_there(self):
        try:
            import cover_cells as C
        except ImportError:
            self.skipTest("needs the cover dependency group")
        import numpy as np
        smooth = np.full((80, 80), C.CLASSES.index("dirt"), np.int64)
        got = C.polygons(smooth, (-10.0, 30.0), (0.0, 0.0, 20.0, 20.0))
        xs = [x for poly in got["dirt"] for ring in poly for x, _ in ring]
        ys = [y for poly in got["dirt"] for ring in poly for _, y in ring]
        self.assertEqual((min(xs), max(xs), min(ys), max(ys)), (0.0, 20.0, 0.0, 20.0))


if __name__ == "__main__":
    unittest.main()
