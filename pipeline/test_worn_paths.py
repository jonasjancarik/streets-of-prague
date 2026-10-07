import unittest

from shapely.geometry import LineString, Point, box

import numpy as np

from worn_paths import Footfall, ribbons, worn_paths


class WornPathsTest(unittest.TestCase):
    # A lawn with a block of flats at its west end; the footway starts below the block, goes
    # round the lawn's south edge, and ends by a bus stop 70 m away across the grass.
    def setUp(self):
        self.lawn = box(-40, 0, 100, 60)
        self.block = box(-30, 20, -10, 40)
        self.buildings = {"b": self.block}
        self.street = LineString([(-45, -40), (-45, 100), (105, 100)])
        self.footway = LineString([(-20, 18), (-20, -10), (50, -10), (50, 5)])
        self.stop = Point(50, 12)

    def run_(self, **over):
        args = dict(grass=self.lawn, buildings=self.buildings, doors=["b"], stops=[self.stop],
                    foot_lines=[self.footway], car_lines=[self.street], obstacles=self.block)
        args.update(over)
        return worn_paths(**args)

    def test_shortcut_to_stop_across_the_lawn(self):
        got = self.run_()
        self.assertEqual(len(got), 1)
        pts, width, to_stop = got[0]
        self.assertTrue(to_stop)
        self.assertLessEqual(max(x for x, _ in pts), 80)
        self.assertGreaterEqual(width, 0.6)

    def test_same_every_run(self):
        self.assertEqual(self.run_(), self.run_())

    def test_no_path_over_paving_or_past_80_m(self):
        self.assertEqual(self.run_(grass=box(0, 0, 100, 5)), [])
        self.assertEqual(self.run_(stops=[Point(95, 30)], foot_lines=[]), [])

    def test_no_path_where_the_mapped_way_is_about_as_short(self):
        direct = LineString([(-2, 30), (60, 12)])
        self.assertEqual(self.run_(foot_lines=[direct], stops=[Point(50, 12)]), [])

    def test_no_path_through_an_obstacle(self):
        wall = box(30, -5, 32, 70)
        self.assertEqual(self.run_(obstacles=self.block.union(wall)), [])

    def test_a_mapped_entrance_is_where_the_path_starts(self):
        # Without entrances the door is taken to be the point of the outline nearest a way
        # (the south wall, by the footway); the block's mapped door is on its east wall.
        guessed = self.run_()[0][0][0]
        self.assertAlmostEqual(guessed[1], 20, delta=0.1)
        got = self.run_(entrances=[(-10, 33), (300, 300)])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0][0][0], (-10, 33))
        # An entrance of another building is not this block's door.
        self.assertEqual(self.run_(entrances=[(300, 300)])[0][0][0], guessed)

    def test_two_entrances_two_paths(self):
        north = Point(-20, 95)  # a second stop, up the street from the block's north door
        got = self.run_(grass=box(-40, 0, 100, 99), entrances=[(-10, 33), (-20, 40)], stops=[self.stop, north])
        self.assertEqual(sorted(pts[0] for pts, _, _ in got), [(-20, 40), (-10, 33)])

    def test_the_busier_place_wins_and_wears_a_wider_path(self):
        # Two stops across the lawn from the block's east door. The far one saves more of the
        # walk, so it wins where every place counts the same; the near one wins once it is busy.
        near, far = Point(50, 12), Point(50, 48)
        share = np.zeros((8, 8), np.float32)
        busy = Footfall(share, [-100, -100, 100, 100], 25.0)
        args = dict(stops=[near, far], entrances=[(-10, 30)])
        calm = self.run_(footfall=busy, **args)
        self.assertEqual(calm[0][0], self.run_(**args)[0][0])
        self.assertAlmostEqual(calm[0][0][-1][1], 48, delta=0.1)
        share[3, 6] = 0.5  # the cell of (50, 12): rows from the north
        self.assertGreater(busy.busy(50, 12), busy.busy(50, 48))
        got = self.run_(footfall=busy, **args)
        self.assertAlmostEqual(got[0][0][-1][1], 12, delta=0.1)
        self.assertGreater(got[0][1], calm[0][1])
        self.assertEqual(Footfall.load("/nowhere"), None)

    def test_ribbon_polygons(self):
        core, rim = ribbons(self.run_())
        self.assertGreater(rim.area, core.area)
        self.assertTrue(core.within(rim))


if __name__ == "__main__":
    unittest.main()
