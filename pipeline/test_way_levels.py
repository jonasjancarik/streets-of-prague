"""Which deck a street or a tram track is on where bridges cross."""

import unittest

from shapely.geometry import LineString, box

import structures


def way(ident, kind, level, pts):
    return {"id": ident, "kind": kind, "level": level, "pts": pts}


class OnLevelsTests(unittest.TestCase):
    def setUp(self):
        # A low bridge along x and a high one along y crossing over it.
        self.ways = [way(1, "bridge", 1, [[-50, 0], [50, 0]]), way(2, "bridge", 2, [[0, -50], [0, 50]]),
                     way(3, "tunnel", -1, [[-50, 20], [50, 20]])]
        rect = lambda x0, y0, x1, y1: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]  # noqa: E731
        self.tiles = {"0_0": [{"level": 1, "kind": "bridge", "polys": [rect(-50, -5, 50, 5)]},
                              {"level": 2, "kind": "bridge", "polys": [rect(-5, -50, 5, 50)]}]}
        self.on = structures.OnLevels(self.ways, self.tiles)

    def test_edge_takes_the_level_of_the_way_it_runs_along(self):
        self.assertEqual(self.on.edge({"bridge": True, "pts": [[-40, 0], [40, 0]]}), 1)
        self.assertEqual(self.on.edge({"bridge": True, "pts": [[0, -40], [0, 40]]}), 2)
        self.assertEqual(self.on.edge({"tunnel": True, "pts": [[-40, 20], [40, 20]]}), -1)

    def test_edge_on_the_ground_or_away_from_any_way_has_none(self):
        self.assertIsNone(self.on.edge({"bridge": False, "pts": [[-40, 0], [40, 0]]}))
        self.assertIsNone(self.on.edge({"bridge": True, "pts": [[-40, 30], [40, 30]]}))
        # (a bridge is not a tunnel: the tunnel way under it doesn't count)
        self.assertIsNone(self.on.edge({"bridge": True, "pts": [[-40, 20], [40, 20]]}))

    def test_edge_of_two_ways_on_different_levels_is_cut_where_it_changes(self):
        ways = [way(1, "bridge", 1, [[0, 0], [60, 0]]), way(2, "bridge", 2, [[60, 0], [150, 0]])]
        on = structures.OnLevels(ways, {})
        e = {"bridge": True, "pts": [[0, 0], [150, 0]]}
        self.assertEqual(on.edge(e), 2)
        self.assertEqual(on.stretches(e), [[0.0, 1], [60.0, 2]])
        self.assertIsNone(on.stretches({"bridge": True, "pts": [[0, 0], [50, 0]]}))

    def test_track_is_on_the_deck_it_runs_along_through_the_crossing(self):
        low = self.on.rails("0_0", [{"kind": "tram", "pts": [[-48, 1], [48, 1]]}])
        self.assertEqual([r["level"] for r in low], [1])
        self.assertAlmostEqual(LineString(low[0]["pts"]).length, 96, delta=0.5)
        high = self.on.rails("0_0", [{"kind": "tram", "pts": [[1, -48], [1, 48]]}])
        self.assertEqual([r["level"] for r in high], [2])

    def test_track_off_the_bridges_and_other_rails_are_left_out(self):
        self.assertEqual(self.on.rails("0_0", [{"kind": "tram", "pts": [[-48, 70], [48, 70]]}]), [])
        self.assertEqual(self.on.rails("0_0", [{"kind": "rail", "pts": [[-48, 1], [48, 1]]}]), [])
        self.assertEqual(self.on.rails("1_0", [{"kind": "tram", "pts": [[-48, 1], [48, 1]]}]), [])

    def test_track_passing_under_a_bridge_stays_on_the_ground(self):
        # Across the high bridge alone, well away from the low one.
        self.assertEqual(self.on.rails("0_0", [{"kind": "tram", "pts": [[-20, 30], [20, 30]]}]), [])

    def test_track_in_a_street_on_the_ground_under_a_viaduct_stays_on_the_ground(self):
        # Along the low bridge's outline, but in a street on the ground beneath it.
        rails = [{"kind": "tram", "pts": [[-48, 1], [48, 1]]}]
        street = {"road": [[[[-60, -4], [60, -4], [60, 4], [-60, 4]]]]}
        self.assertEqual(self.on.rails("0_0", rails, street), [])
        # (the bridge's own carriageway is a street too, of the kind "bridge")
        deck = {"bridge": [[[[-60, -4], [60, -4], [60, 4], [-60, 4]]]], "road": []}
        self.assertEqual([r["level"] for r in self.on.rails("0_0", rails, deck)], [1])

    def test_track_running_onto_a_bridge_is_cut_where_the_deck_begins(self):
        got = self.on.rails("0_0", [{"kind": "tram", "pts": [[-80, 0], [-20, 0]]}])
        self.assertEqual(len(got), 1)
        xs = [p[0] for p in got[0]["pts"]]
        self.assertTrue(-54.1 <= min(xs) <= -46 and max(xs) == -20)


if __name__ == "__main__":
    unittest.main()
