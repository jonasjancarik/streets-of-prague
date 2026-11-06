"""A short underpass the terrain model shows in an open cutting (structures.cuttings)."""

import unittest
from unittest.mock import patch

import numpy as np
from shapely.geometry import LineString, Point, Polygon, box

import dtm_structures as dtm
import structures


def tunnel(ident, pts, w=7.0):
    return {"id": ident, "kind": "tunnel", "hw": "tertiary", "w": w, "pts": pts}


def street(ident, pts, width=10.0):
    return {"id": ident, "hw": "primary", "width": width, "pts": pts}


def trench(depth):
    # Ground at 240 m with a trench 20 m wide along y = 0, `depth` deep.
    return lambda xs, ys: 240.0 - depth * (np.abs(np.asarray(ys, float)) < 10)


class Cuttings(unittest.TestCase):
    def test_street_over_a_trench_goes_on_a_bridge_and_the_underpass_on_the_ground(self):
        dropped, bridges = structures.cuttings([tunnel(1, [[-20, 0], [20, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, trench(6))
        self.assertEqual(dropped, {1})
        self.assertEqual(len(bridges), 1)
        b = bridges[0]
        self.assertTrue(b["cut"])
        self.assertEqual(b["kind"], "bridge")
        ys = [p[1] for p in b["pts"]]
        # From where the ground is back at the street's height on one side to the other.
        self.assertLess(min(ys), -10)
        self.assertGreater(max(ys), 10)
        self.assertLess(max(ys) - min(ys), 30)

    def test_tunnel_under_the_ground_stays(self):
        dropped, bridges = structures.cuttings([tunnel(1, [[-20, 0], [20, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, trench(0.5))
        self.assertEqual((dropped, bridges), (set(), []))

    def test_street_going_down_past_a_portal_stays(self):
        # The street drops 6 m across the tunnel: a slope, not a street over a cutting.
        def slope(xs, ys):
            return 240.0 - 6.0 * (np.asarray(ys, float) > 0)
        dropped, _ = structures.cuttings([tunnel(1, [[-20, 0], [20, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, slope)
        self.assertEqual(dropped, set())

    def test_long_tunnel_stays(self):
        dropped, _ = structures.cuttings([tunnel(1, [[-200, 0], [200, 0]])], {"a": street("a", [[0, -60], [0, 60]])}, trench(6))
        self.assertEqual(dropped, set())

    def test_street_over_it_is_on_the_bridge_for_that_stretch(self):
        ways = [{"kind": "bridge", "level": 1, "cut": True, "pts": [[0, -15], [0, 15]]}]
        on = structures.OnLevels(ways, {})
        self.assertEqual(on.over_cutting({"pts": [[0, -60], [0, 60]]}), [[0.0, 0], [45.0, 1], [75.0, 0]])
        self.assertIsNone(on.over_cutting({"pts": [[30, -60], [30, 60]]}))
        self.assertIsNone(on.over_cutting({"bridge": True, "pts": [[0, -60], [0, 60]]}))
        # (the underpass's street, crossing under it)
        self.assertIsNone(on.over_cutting({"pts": [[-60, 0], [60, 0]]}))


def evidence(code, ident, level, shape, **attrs):
    return {"package": "fixture.gpkg.zip", "code": code,
            "attrs": {"ID": ident, dtm.LEVEL: level, **attrs}, "shape": shape}


class SurveyCompanions(unittest.TestCase):
    underpass = tunnel(1, [[-30, 0], [30, 0]])
    streets = {
        "a": street("a", [[-8, -60], [-8, 60]], 8),
        "b": street("b", [[8, -22], [8, 22]], 8),
        "c": street("c", [[23, -22], [23, 22]], 8),
        "lower": street("lower", [[-30, 0], [30, 0]], 7),
    }

    def evidence(self, half_span=12, accuracy=3, z=240):
        return [
            evidence(dtm.BRIDGE, 10, 1, box(-14, -12, 14, 12)),
            evidence(dtm.ROAD, 11, 1, box(-12, -12, -4, 12)),
            evidence(dtm.ROAD, 12, 1, box(4, -half_span, 12, half_span)),
            # A nearby, separately mapped bridge and a tunnel that overlaps the road in plan.
            evidence(dtm.BRIDGE, 13, 1, box(19, -12, 27, 12)),
            evidence(dtm.ROAD, 14, 1, box(19, -12, 27, 12)),
            evidence(dtm.TUNNEL, 15, -2, box(-32, -3, 32, 3)),
            evidence(dtm.EDGE, 16, -2, LineString([(-30, -3, 227), (30, -3, 227)]),
                     **{dtm.ACCURACY_Z: 3, dtm.ACQUISITION: 3, dtm.EDGE_TYPE: 18}),
            *(evidence(dtm.EDGE, 17 + k, 1, LineString([(x, y, z) for y in (-10, -5, 5, 10)]),
                       **{dtm.ACCURACY_Z: accuracy, dtm.ACQUISITION: 1, dtm.EDGE_TYPE: 1})
              for k, x in enumerate((4, 12))),
        ]

    def build(self, records):
        return structures.cuttings([self.underpass], self.streets, trench(6),
                                   dtm.DeckSurvey(records, lambda x, y: (x, y)))

    def test_supported_second_carriageway_has_its_own_span_and_keeps_lower_street_on_ground(self):
        dropped, bridges = self.build(self.evidence())
        self.assertEqual(dropped, {1})
        self.assertEqual(len(bridges), 2)
        upper = bridges[-1]
        self.assertEqual(upper["pts"], [[8, -12], [8, 12]])
        self.assertEqual(upper["survey_sources"]["bridge"]["ID"], 10)
        self.assertEqual(upper["survey_sources"]["road"]["ID"], 12)
        self.assertEqual({r["ID"] for r in upper["survey_sources"]["edges"]}, {17, 18})
        on = structures.OnLevels([dict(w, level=1) for w in bridges], {})
        self.assertIsNotNone(on.over_cutting(self.streets["b"]))
        self.assertIsNone(on.over_cutting(self.streets["c"]))
        self.assertIsNone(on.over_cutting(self.streets["lower"]))
        _, heights = structures.companion_profile(upper, trench(6))
        np.testing.assert_allclose(heights, 240)

    def test_incomplete_extent_uncertain_height_and_wrong_height_keep_original_cut(self):
        for evidence in (self.evidence(half_span=5), self.evidence(accuracy=9), self.evidence(z=234)):
            with self.subTest(evidence=evidence):
                dropped, bridges = self.build(evidence)
                self.assertEqual(dropped, {1})
                self.assertEqual(len(bridges), 1)
                self.assertNotIn("survey_sources", bridges[0])

    def test_companion_does_not_renumber_or_move_another_deck(self):
        ways = [self.underpass, tunnel(2, [[135, 70], [175, 70]])]
        streets = {**self.streets, "far": street("far", [[160, 15], [160, 130]], 8)}

        def ground(xs, ys):
            return np.minimum(trench(6)(xs, ys), trench(5)(xs, np.asarray(ys) - 70))

        survey = dtm.DeckSurvey(self.evidence(), lambda x, y: (x, y))
        _, old = structures.cuttings(ways, streets, ground)
        _, new = structures.cuttings(ways, streets, ground, survey)
        self.assertEqual(old, [w for w in new if not w.get("survey_sources")])
        self.assertEqual(len(new), len(old) + 1)

        near, far = (0, 0), (2, 1)
        boxes = {near: box(-50, -50, 50, 50), far: box(150, 50, 250, 150)}

        def make(ways):
            levels = []
            with patch.object(structures, "ipr_decks", return_value={}):
                tiles = structures.build(ways, [], [], ground, None, boxes, 20, 100, 5, -50, -50,
                                         boxes, way_levels=levels)
            return levels, tiles[far][0]

        old_levels, old_deck = make(old)
        new_levels, new_deck = make(new)
        self.assertEqual(old_levels, [w for w in new_levels if not w.get("survey_sources")])
        self.assertEqual(old_deck[:2], new_deck[:2])
        self.assertEqual(old_deck[3], new_deck[3])
        np.testing.assert_array_equal(old_deck[2], new_deck[2])

    def test_companion_crossing_a_tile_edge_has_geometry_and_equal_height_on_both_sides(self):
        _, ways = self.build(self.evidence())
        south, north = (0, -1), (0, 0)
        boxes = {south: box(-50, -100, 50, 0), north: box(-50, 0, 50, 100)}
        with patch.object(structures, "ipr_decks", return_value={}):
            tiles = structures.build(ways, [], [], trench(6), None, boxes, 20, 100, 5, -50, 0, boxes)
        for key, y, row in ((south, -1, -1), (north, 1, 0)):
            level, kind, heights, polygons = tiles[key][0]
            self.assertEqual((level, kind), (1, "bridge"))
            self.assertTrue(any(Polygon(p[0], p[1:]).covers(Point(8, y)) for p in polygons))
            self.assertEqual(heights[row, 12], 240.0)

    def test_companion_cannot_take_a_higher_level_below_an_existing_deck(self):
        shape = box(0, 0, 10, 10)
        upper = structures.Piece("bridge", shape, lambda xs, ys: np.full(len(xs), 240.0), [1])
        companion = structures.Piece("bridge", shape, lambda xs, ys: np.full(len(xs), 234.0), [2])
        with self.assertRaisesRegex(ValueError, "cannot fit between the existing bridge levels"):
            structures.assign_levels([[companion], [upper]], {2})
        self.assertEqual(upper.level, 1)
        self.assertEqual(companion.level, 0)

    def test_companion_above_a_contained_deck_takes_the_next_level(self):
        lower = structures.Piece("bridge", box(12, 12, 20, 20), lambda xs, ys: np.full(len(xs), 234.0), [1])
        companion = structures.Piece("bridge", box(0, 0, 40, 40), lambda xs, ys: np.full(len(xs), 240.0), [2])
        structures.assign_levels([[companion], [lower]], {2})
        self.assertEqual(lower.level, 1)
        self.assertEqual(companion.level, 2)


if __name__ == "__main__":
    unittest.main()
