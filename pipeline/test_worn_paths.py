import unittest

from shapely.geometry import LineString, Point, box

from worn_paths import ribbons, worn_paths


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

    def test_ribbon_polygons(self):
        core, rim = ribbons(self.run_())
        self.assertGreater(rim.area, core.area)
        self.assertTrue(core.within(rim))


if __name__ == "__main__":
    unittest.main()
