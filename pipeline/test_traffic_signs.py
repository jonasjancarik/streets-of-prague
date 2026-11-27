"""The traffic signs inferred from OSM's rules (build_traffic_signs.py), on small made-up
street plans: where each stands, which way it faces, and which junctions get none."""

import math
import unittest

from build_traffic_signs import KERB_GAP, Way, direction_signs, traffic_signs


def way(osm_id, pts, nodes, **tags):
    tags.setdefault("highway", "residential")
    return Way(osm_id, tags, nodes, pts)


def cross(main="tertiary", side="residential", **side_tags):
    """A through road west–east along y=0 (nodes 1, 2, 3) and a side street from the
    junction (node 2, at 100, 0) north to node 4."""
    return [way(10, [(0, 0), (100, 0)], [1, 2], highway=main), way(11, [(100, 0), (200, 0)], [2, 3], highway=main),
            way(12, [(100, 0), (100, 100)], [2, 4], highway=side, **side_tags)]


def named(signs, name):
    return [s for s in signs if s[2] == name]


def facing(s):
    """The way a sign's face looks, (x, y)."""
    return (math.sin(s[3]), -math.cos(s[3]))


class TrafficSigns(unittest.TestCase):
    def test_one_way_street_between_junctions(self):
        # Node 2 → 5 one-way east, with streets crossing at both ends.
        ways = [way(1, [(0, 0), (100, 0)], [2, 5], oneway="yes"),
                way(2, [(0, -50), (0, 0)], [6, 2]), way(3, [(0, 0), (0, 50)], [2, 7]),
                way(4, [(100, -50), (100, 0)], [8, 5]), way(5, [(100, 0), (100, 50)], [5, 9])]
        signs, _ = traffic_signs(ways, {}, [])
        half = ways[0].half + KERB_GAP
        one, = named(signs, "one way")
        # Turning in at x=0 one drives east: on the right (south), facing west.
        self.assertAlmostEqual(one[0], 3)
        self.assertAlmostEqual(one[1], -half)
        self.assertAlmostEqual(facing(one)[0], -1)
        no, = named(signs, "no entry")
        # Against it from x=100 one would drive west: on the right (north), facing east.
        self.assertAlmostEqual(no[0], 97)
        self.assertAlmostEqual(no[1], half)
        self.assertAlmostEqual(facing(no)[0], 1)

    def test_side_street_gives_way_and_the_main_road_is_signed(self):
        signs, _ = traffic_signs(cross(), {}, [])
        give, = named(signs, "give way")
        # Coming south down the side street to the junction: 4 m short of it, on the west.
        self.assertAlmostEqual(give[1], 4)
        self.assertLess(give[0], 100)
        self.assertAlmostEqual(facing(give)[1], 1)
        mains = named(signs, "main road")
        self.assertEqual(len(mains), 2, mains)  # leaving the junction each way along the main road
        self.assertTrue(all(abs(s[1]) > 3 for s in mains))

    def test_no_priority_signs_between_equal_streets_or_by_traffic_lights(self):
        signs, _ = traffic_signs(cross("residential"), {}, [])
        self.assertFalse(named(signs, "give way"))
        lights = {50: ({"highway": "traffic_signals"}, (95, 5))}
        signs, _ = traffic_signs(cross(), lights, [])
        self.assertFalse(named(signs, "give way"))

    def test_mapped_give_way_is_kept_and_none_inferred(self):
        ways = cross()
        ways[2] = way(12, [(100, 0), (100, 5), (100, 100)], [2, 40, 4])
        nodes = {40: ({"highway": "stop"}, (100, 5))}
        signs, _ = traffic_signs(ways, nodes, [])
        self.assertEqual([s[2] for s in signs if s[2] in ("give way", "stop")], ["stop"])
        stop, = named(signs, "stop")
        self.assertAlmostEqual(facing(stop)[1], 1)  # facing those driving south to the junction
        self.assertEqual(len(named(signs, "main road")), 2)

    def test_crossing_signs_both_ways_one_lit(self):
        ways = [way(1, [(0, 0), (50, 0), (100, 0)], [1, 2, 3])]
        nodes = {2: ({"highway": "crossing", "crossing": "uncontrolled"}, (50, 0))}
        signs, _ = traffic_signs(ways, nodes, [], lit=[(49, -4.5)])
        lit, = named(signs, "crossing lit")
        plain, = named(signs, "crossing")
        # The east-bound traffic's sign is on the south kerb, facing west; the other opposite.
        self.assertLess(lit[1], 0)
        self.assertAlmostEqual(facing(lit)[0], -1)
        self.assertGreater(plain[1], 0)
        self.assertAlmostEqual(facing(plain)[0], 1)
        self.assertAlmostEqual(lit[0], 49)

    def test_unmarked_and_signalled_crossings_have_none(self):
        ways = [way(1, [(0, 0), (50, 0), (100, 0)], [1, 2, 3])]
        for tags in ({"highway": "crossing", "crossing": "unmarked"}, {"highway": "crossing", "crossing": "traffic_signals"}):
            signs, _ = traffic_signs(ways, {2: (tags, (50, 0))}, [])
            self.assertFalse(named(signs, "crossing"), tags)

    def test_zone_signs_where_a_zone_street_meets_one_outside(self):
        signs, _ = traffic_signs(cross(**{"maxspeed": "30", "maxspeed:type": "CZ:zone30"}), {}, [])
        entry, = named(signs, "zone 30")
        end, = named(signs, "zone 30 end")
        self.assertAlmostEqual(facing(entry)[1], -1)  # those turning in drive north
        self.assertAlmostEqual(facing(end)[1], 1)
        self.assertFalse(named(signs, "speed 30"))  # the zone is signed at its edge only

    def test_speed_limit_after_each_junction_and_its_end(self):
        ways = [way(1, [(0, 0), (100, 0)], [1, 2], maxspeed="40"), way(2, [(100, 0), (200, 0)], [2, 3], maxspeed="40"),
                way(3, [(100, 0), (100, 100)], [2, 4]), way(4, [(200, 0), (300, 0)], [3, 5])]
        signs, _ = traffic_signs(ways, {}, [])
        at = sorted((round(s[0]), round(facing(s)[0])) for s in named(signs, "speed 40"))
        # Out of the junction at x=100 both ways, and coming in from the town's 50 at x=200.
        self.assertEqual(at, [(92, 1), (108, -1), (192, 1)])
        end, = named(signs, "speed 40 end")
        self.assertAlmostEqual(end[0], 208)

    def test_limits_with_an_except_access_plate(self):
        signs, _ = traffic_signs(cross(hgv="destination", maxweight="6"), {}, [])
        self.assertEqual(sorted(s[2] for s in signs if s[2] in ("no lorries", "except access", "weight 6")),
                         ["except access", "no lorries", "weight 6"])

    def test_turn_ban_on_the_street_coming_up(self):
        signs, _ = traffic_signs(cross(), {}, [("no_left_turn", 12, 2, 10)])
        ban, = named(signs, "no left turn")
        self.assertAlmostEqual(ban[1], 12)
        self.assertAlmostEqual(facing(ban)[1], 1)

    def test_lane_arrows_for_the_street_into_a_junction(self):
        ways = cross()
        ways[0].tags["turn:lanes:forward"] = "left|through;right"
        _, turns = traffic_signs(ways, {}, [])
        self.assertEqual([(n, round(math.degrees(h)), lanes, xy) for n, h, lanes, xy in turns], [(2, 0, "left|through;right", (100, 0))])


class DirectionSigns(unittest.TestCase):
    def junction(self):
        """A secondary road east along y=0 through node 2 (at 100, 0), streets north and
        south from it, each named where it leads."""
        return [way(10, [(0, 0), (100, 0)], [1, 2], highway="secondary"),
                way(11, [(100, 0), (200, 0)], [2, 3], highway="secondary", **{"destination:forward": "Brno;Benešov", "destination:ref:forward": "D1"}),
                way(12, [(100, 0), (100, 100)], [2, 4], **{"destination:forward": "Vinohrady"}),
                way(13, [(100, 0), (100, -100)], [2, 5], highway="tertiary", oneway="yes", destination="Kbely")]

    def test_plates_and_a_board_for_the_road_coming_up(self):
        signs = [s for s in direction_signs(self.junction(), frozenset({"Vinohrady"})) if facing(s[:2] + (None, s[3]))[0] < -.9]
        plates, = [s for s in signs if s[2] == "plates"]
        board, = [s for s in signs if s[2] == "board"]
        # Driving east: on the right (south), 6 m and 70 m short of the junction, facing west.
        self.assertAlmostEqual(plates[0], 94)
        self.assertLess(plates[1], 0)
        self.assertAlmostEqual(board[0], 30)
        # Straight on first, then left (north), then right (south); white for the city's own part.
        self.assertEqual([(b[0], b[1], b[2], b[4]) for b in plates[4]],
                         [(0, "Brno;Benešov", "D1", "green"), (90, "Vinohrady", "", "white"), (-90, "Kbely", "", "blue")])

    def test_none_where_nothing_is_named_or_against_the_traffic(self):
        signs = direction_signs(self.junction())
        # From the north and the east there are plates; nobody drives north up the one-way 13.
        self.assertFalse([s for s in signs if facing(s[:2] + (None, s[3]))[1] < -.9])
        self.assertFalse(direction_signs(cross()))

    def test_across_a_dual_carriageway(self):
        # Coming up from the south, across a 12 m gap between the two carriageways to the street on north.
        ways = [way(1, [(0, 0), (100, 0)], [1, 2], highway="primary", oneway="yes"), way(2, [(100, 0), (200, 0)], [2, 3], highway="primary", oneway="yes"),
                way(3, [(200, 12), (100, 12)], [6, 7], highway="primary", oneway="yes"), way(4, [(100, 12), (0, 12)], [7, 8], highway="primary", oneway="yes"),
                way(5, [(100, -100), (100, 0)], [9, 2]), way(6, [(100, 0), (100, 12)], [2, 7]),
                way(7, [(100, 12), (100, 100)], [7, 10], **{"destination:forward": "Letňany"})]
        plates = [s for s in direction_signs(ways) if s[2] == "plates" and facing(s[:2] + (None, s[3]))[1] < -.9]
        self.assertEqual([b[1] for s in plates for b in s[4]], ["Letňany"])


if __name__ == "__main__":
    unittest.main()
