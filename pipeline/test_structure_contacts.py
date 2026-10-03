"""Whole-area bridge decks must equal decks assembled from overlapping OSM cuts."""

import copy
import unittest
from unittest.mock import patch

import numpy as np
from shapely.geometry import box

import structures


class IdentityTransform:
    def transform(self, xs, ys):
        return np.asarray(xs), np.asarray(ys)


def source(ids):
    nodes = [{"type": "node", "id": i, "lon": x, "lat": 0}
             for i, x in ((1, 0), (2, 100), (3, 200), (4, -10), (5, 210))]
    ways = [
        {"type": "way", "id": 11, "nodes": [1, 2], "tags": {"highway": "residential", "bridge": "yes"}},
        {"type": "way", "id": 12, "nodes": [2, 3], "tags": {"highway": "residential", "bridge": "yes"}},
        {"type": "way", "id": 13, "nodes": [4, 1], "tags": {"highway": "residential"}},
        {"type": "way", "id": 14, "nodes": [3, 5], "tags": {"highway": "residential"}},
    ]
    return {"elements": nodes + [w for w in ways if w["id"] in ids]}


class StructureContactTests(unittest.TestCase):
    def ways(self, ids):
        return structures.structure_ways(source(ids), IdentityTransform())

    def build(self, ways):
        # A real 220 m bridge crosses a valley whose ground is 190 m. An isolated
        # chunk's false centre anchor must not pull the deck down into that valley.
        ground = lambda xs, ys: np.where((np.asarray(xs) > 10) & (np.asarray(xs) < 190), 190.0, 220.0)
        decks = {(x, y): np.array([220.0]) for x in range(201) for y in range(-5, 6)}
        with patch.object(structures, "ipr_decks", return_value=decks):
            return structures.build(copy.deepcopy(ways), [], [], ground, "fixture", {(0, 0): None},
                                    50, 250, 5, -25, -125, {(0, 0): box(-25, -125, 225, 125)})

    def test_chunk_isolation_is_not_observed_ground_contact(self):
        isolated = self.ways({11})[0]
        self.assertEqual(isolated["grade"], [True, True])  # compatible local hint
        self.assertEqual(isolated["on_ground"], [False, False])
        complete = self.ways({11, 12, 13, 14})[0]
        self.assertEqual(complete["on_ground"], [True, False])

    def test_overlapping_chunks_and_reverse_order_equal_full_area_decks(self):
        complete = self.ways({11, 12, 13, 14})
        fragmented = self.ways({11}) + complete + self.ways({12})
        whole, chunks, reversed_chunks = self.build(complete), self.build(fragmented), self.build(fragmented[::-1])
        for other in (chunks, reversed_chunks):
            self.assertEqual([(lv, kind, polys) for lv, kind, _, polys in whole[(0, 0)]],
                             [(lv, kind, polys) for lv, kind, _, polys in other[(0, 0)]])
            for a, b in zip(whole[(0, 0)], other[(0, 0)]):
                np.testing.assert_array_equal(a[2], b[2])
        heights = whole[(0, 0)][0][2]
        self.assertAlmostEqual(float(np.nanmin(heights)), 220.0)
        self.assertAlmostEqual(float(np.nanmax(heights)), 220.0)

    def test_true_ground_contact_at_bridge_junction_is_preserved(self):
        ways = self.ways({11, 12, 13, 14})
        ways[0]["on_ground"][1] = True  # an observed street at the shared node
        merged = structures.merge_ways(ways)
        self.assertTrue(merged[0]["grade"][-1])
        self.assertTrue(merged[1]["grade"][0])

    def test_new_global_loose_ends_still_meet_ground(self):
        merged = structures.merge_ways(self.ways({11, 12}))
        self.assertEqual(merged[0]["grade"], [True, False])
        self.assertEqual(merged[1]["grade"], [False, True])

    def test_legacy_cache_remains_readable_with_its_original_flags(self):
        ways = self.ways({11, 12, 13, 14})
        for way in ways:
            way.pop("on_ground", None)
        merged = structures.merge_ways(ways)
        self.assertEqual(merged[0]["grade"], [True, False])
        self.assertEqual(merged[1]["grade"], [False, True])

    def test_mixed_contact_evidence_in_one_component_requires_refresh(self):
        ways = self.ways({11, 12, 13, 14})
        ways[1].pop("on_ground", None)
        with self.assertRaisesRegex(ValueError, "rebuild.*streets"):
            structures.merge_ways(ways)

    def test_empty_structure_input_has_no_levels(self):
        self.assertEqual(self.build([]), {})

    def test_incomplete_contact_array_requires_refresh(self):
        ways = self.ways({11})
        ways[0]["on_ground"] = [False]
        with self.assertRaisesRegex(ValueError, "incomplete.*rebuild"):
            structures.merge_ways(ways)

    def test_grade_separated_crossing_keeps_road_and_cycleway_decks(self):
        ways = [
            {"id": 21, "kind": "bridge", "layer": 1, "hw": "cycleway", "w": 2.5,
             "pts": [[-100, 0], [100, 0]], "nodes": [1, 2],
             "grade": [True, True], "on_ground": [False, False]},
            {"id": 22, "kind": "bridge", "layer": 2, "hw": "motorway", "w": 12,
             "pts": [[0, -100], [0, 100]], "nodes": [3, 4], "grade": [True, True]},
        ]
        # Disjoint legacy/current components remain readable even where their
        # geometry crosses: connectivity follows node IDs, not projected position.
        ground = lambda xs, ys: np.where(np.abs(xs) >= np.abs(ys), 220.0, 240.0)
        decks = {(x, 0): np.array([220.0, 240.0]) for x in range(-100, 101)}
        decks.update({(0, y): np.array([220.0, 240.0]) for y in range(-100, 101)})
        with patch.object(structures, "ipr_decks", return_value=decks):
            levels = structures.build(ways, [], [], ground, "fixture", {(0, 0): None},
                                      50, 250, 5, -125, -125, {(0, 0): box(-125, -125, 125, 125)})
        self.assertEqual(len(levels[(0, 0)]), 2)
        self.assertEqual([float(h[25, 25]) for _, _, h, _ in levels[(0, 0)]], [220.0, 240.0])

    def test_explicit_different_layers_do_not_merge_even_with_close_inferred_heights(self):
        ways = [
            {"id": 21, "kind": "bridge", "layer": 1, "mapped_layer": 1, "hw": "cycleway", "w": 2,
             "pts": [[0, 0], [100, 0]], "nodes": [1, 2], "grade": [True, True], "on_ground": [True, True]},
            {"id": 22, "kind": "bridge", "layer": 2, "mapped_layer": 2, "hw": "motorway", "w": 10,
             "pts": [[0, 0], [100, 0]], "nodes": [3, 4], "grade": [True, True], "on_ground": [True, True]},
        ]
        with patch.object(structures, "ipr_decks", return_value={}):
            levels = structures.build(ways, [box(0, -5, 100, 5)], [], lambda xs, ys: np.full(len(xs), 220.0),
                                      "fixture", {(0, 0): None}, 50, 250, 5, -25, -125,
                                      {(0, 0): box(-25, -125, 225, 125)})
        self.assertEqual(len(levels[(0, 0)]), 2)

    def test_different_tags_at_a_shared_bridge_node_keep_the_physical_join(self):
        ways = self.ways({11, 12, 13, 14})
        ways[0]["mapped_layer"], ways[1]["mapped_layer"] = 1, 2
        ground = lambda xs, ys: np.full(len(xs), 220.0)
        with patch.object(structures, "ipr_decks", return_value={}):
            levels = structures.build(ways, [box(0, -4, 200, 4)], [], ground, "fixture", {(0, 0): None},
                                      50, 250, 5, -25, -125, {(0, 0): box(-25, -125, 225, 125)})
        self.assertEqual(len(levels[(0, 0)]), 1)

    def test_nested_explicit_decks_keep_levels_without_nearby_exterior_edges(self):
        lower = structures.Piece("bridge", box(-1, -1, 1, 1), lambda xs, ys: np.full(len(xs), 220.0),
                                 mapped_layer=1, nodes=[1, 2])
        upper = structures.Piece("bridge", box(-30, -30, 30, 30), lambda xs, ys: np.full(len(xs), 221.0),
                                 mapped_layer=2, nodes=[3, 4])
        structures.assign_levels([[lower], [upper]])
        self.assertNotEqual(lower.level, upper.level)


if __name__ == "__main__":
    unittest.main()
