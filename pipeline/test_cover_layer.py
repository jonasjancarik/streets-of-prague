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


if __name__ == "__main__":
    unittest.main()
