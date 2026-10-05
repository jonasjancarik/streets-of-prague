"""Crash barriers stand along motorway and expressway edges, open where roads meet."""

import unittest

from shapely.geometry import LineString

import barriers

ROAD = LineString([(0, 0), (200, 0)])
SIDES = [(4.0, 4.0)]


def surface(line, half):
    return line.buffer(half, cap_style="flat")


class GuardRailTests(unittest.TestCase):
    def rails(self, hw="motorway", skip=False, extra=(), mapped=()):
        return barriers.guard_rails([ROAD], [hw], SIDES, [skip], [surface(ROAD, 4.0), *extra], list(mapped))

    def test_both_edges_of_a_motorway(self):
        left, right = sorted(self.rails(), key=lambda ln: -ln.coords[0][1])
        self.assertAlmostEqual(left.coords[0][1], 4.0 + barriers.OFFSET)
        self.assertAlmostEqual(right.coords[0][1], -4.0 - barriers.OFFSET)
        self.assertAlmostEqual(left.length, 200)

    def test_only_big_roads_on_the_ground(self):
        self.assertEqual(self.rails(hw="primary"), [])
        self.assertEqual(self.rails(hw="motorway_link"), [])
        self.assertEqual(self.rails(skip=True), [])

    def test_open_where_a_slip_road_joins(self):
        slip = surface(LineString([(100, 0), (100, -40)]), 3.0)
        got = self.rails(extra=[slip])
        south = [ln for ln in got if ln.coords[0][1] < 0]
        self.assertEqual(len(south), 2)
        for ln in south:
            self.assertGreater(ln.distance(slip), 0.25)
        self.assertEqual(len([ln for ln in got if ln.coords[0][1] > 0]), 1)

    def test_no_barrier_between_carriageways_that_touch(self):
        other = surface(LineString([(0, 8), (200, 8)]), 4.0)
        self.assertEqual([ln for ln in self.rails(extra=[other]) if ln.coords[0][1] > 0], [])

    def test_a_mapped_barrier_stands_for_the_edge_beside_it(self):
        mapped = LineString([(0, 4.8), (200, 4.8)])
        got = self.rails(mapped=[mapped])
        self.assertIn(mapped, got)
        self.assertEqual(len([ln for ln in got if ln.coords[0][1] > 0]), 1)
        self.assertEqual(len([ln for ln in got if ln.coords[0][1] < 0]), 1)


if __name__ == "__main__":
    unittest.main()
