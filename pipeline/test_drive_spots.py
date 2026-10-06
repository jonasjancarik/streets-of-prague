"""Places for a car on a house's drive, and the paving under them (plots.py)."""

import math
import unittest

from shapely.geometry import Point, Polygon, box

import plots


class DriveSpotsTests(unittest.TestCase):
    street = box(-20, -1.5, 60, 1.5)  # the street's edge, as _gardens buffers it

    def layout(self, *houses, plot=box(0, 1, 20, 30), kinds=None):
        homes = [(0, houses[0])]
        buildings = [((kinds or {}).get(k, "house"), h) for k, h in enumerate(houses)]
        return plots.layout([(0, plot)], homes, buildings, self.street)

    def spots(self, *houses, **kw):
        return plots.drive_spots(self.layout(*houses, **kw), list(houses))

    def test_a_car_stands_inside_the_gate_facing_the_house(self):
        [spot] = self.spots(box(6, 14, 14, 22))
        self.assertAlmostEqual(spot["h"], math.pi / 2, delta=0.2)  # house is "up" the plot from the street
        self.assertTrue(1 < spot["y"] < 6)
        self.assertTrue(0 < spot["x"] < 20)

    def test_a_house_close_to_the_street_has_no_room_for_one(self):
        self.assertEqual(self.spots(box(6, 5, 14, 12)), [])

    def test_a_footprint_that_crosses_itself_does_not_stop_the_chunk(self):
        # Two such buildings sharing a crossing point: joining them as they are raises
        # in GEOS (seen in praha on 5 October 2026).
        bow = Polygon([(30, 14), (38, 22), (38, 14), (30, 22)])
        tie = Polygon([(34, 10), (42, 18), (42, 10), (34, 18)])
        self.assertEqual(len(self.spots(box(6, 14, 14, 22), bow, tie)), 1)

    def test_a_plot_away_from_the_street_gets_none(self):
        self.assertEqual(self.spots(box(6, 14, 14, 22), plot=box(0, 10, 20, 40)), [])

    def test_the_car_stands_on_the_paved_strip(self):
        [rec] = self.layout(box(6, 14, 14, 22))
        strip = plots.paving(rec)
        [spot] = plots.drive_spots([rec], [rec["house"]])
        car = plots._rect(spot["x"], spot["y"], 4.2, 1.8, spot["h"])
        self.assertTrue(strip.contains(car))
        # The strip starts at the gate and reaches the house.
        self.assertLess(strip.distance(rec["gate"]), 0.01)
        self.assertLess(strip.distance(rec["house"]), 0.01)

    def test_a_house_close_to_the_street_gets_a_path_and_no_drive(self):
        [rec] = self.layout(box(6, 5, 14, 12))
        strip = plots.paving(rec)
        self.assertLess(strip.area, 1.5 * 5)
        self.assertLess(strip.distance(rec["house"]), 0.01)

    def test_a_garage_at_the_back_gets_the_drive_and_a_second_car(self):
        house, garage = box(2, 8, 10, 16), box(14, 20, 18, 26)
        [rec] = self.layout(house, garage, kinds={1: "garage"})
        self.assertTrue(rec["garage"])
        self.assertAlmostEqual(rec["gate"].x, 16, delta=0.5)  # the gate is opposite the garage
        spots = plots.drive_spots([rec], [house, garage])
        self.assertEqual([s.get("g") for s in spots], [None, 1])
        strip = plots.paving(rec)
        for s in spots:
            self.assertTrue(strip.contains(plots._rect(s["x"], s["y"], 4.2, 1.8, s["h"])))
        # The cars don't overlap, and a path joins the house to the drive.
        self.assertGreater(Point(spots[0]["x"], spots[0]["y"]).distance(Point(spots[1]["x"], spots[1]["y"])), 5.2)
        self.assertLess(strip.distance(house), 0.01)

    def test_a_garage_on_the_street_is_not_driven_up_to(self):
        house, garage = box(6, 14, 14, 22), box(15, 1.5, 19, 7)
        [rec] = self.layout(house, garage, kinds={1: "garage"})
        self.assertFalse(rec["garage"])


class FurnishTests(unittest.TestCase):
    street = box(-20, -1.5, 100, 1.5)

    def block(self):
        houses = [(k, box(6 + 20 * k, 14, 14 + 20 * k, 22)) for k in range(4)]
        made = [(k, box(20 * k, 1.5, 20 + 20 * k, 31.5)) for k in range(4)]
        green = box(0, 1.5, 80, 31.5).difference(box(0, 0, 0, 0))
        for _, h in houses:
            green = green.difference(h.buffer(0.8))
        return made, houses, green

    def test_the_same_block_is_furnished_the_same_way_twice(self):
        made, houses, green = self.block()
        a = plots.furnish(made, houses, [("house", h) for _, h in houses], green, self.street, Polygon())
        b = plots.furnish(made, houses, [("house", h) for _, h in houses], green, self.street, Polygon())
        self.assertEqual(a["fences"], b["fences"])
        self.assertEqual(a["sheds"], b["sheds"])
        self.assertEqual(len(a["plots"]), 4)
        self.assertTrue(all(p["strip"] and p["gate"] for p in a["plots"]))

    def test_small_things_stand_on_the_grass_clear_of_paving_and_houses(self):
        # Many blocks with other ids, so that every kind turns up.
        seen = {"sheds": 0, "beds": 0, "pools": 0}
        for n in range(40):
            made, houses, green = self.block()
            made = [(n * 10 + k, p) for k, p in made]
            houses = [(n * 10 + k, h) for k, h in houses]
            got = plots.furnish(made, houses, [("house", h) for _, h in houses], green, self.street, Polygon())
            strips = [p for p in got["paving"]]
            for x, y, h, length, width, _ in got["sheds"]:
                shed = plots._rect(x, y, length, width, h)
                self.assertTrue(green.contains(shed))
                self.assertTrue(any(pad.contains(shed) for pad in strips))  # its own pad
                seen["sheds"] += 1
            for kind in ("beds", "pools"):
                for shape in got[kind]:
                    self.assertTrue(green.contains(shape))
                    self.assertTrue(all(not shape.intersects(h) for _, h in houses))
                    seen[kind] += 1
        self.assertTrue(all(seen.values()), seen)

    def test_fences_stop_at_a_service_road_through_the_block(self):
        made, houses, green = self.block()
        lane = box(39, 1.5, 41, 31.5)  # along the edge between the second and third plots
        got = plots.furnish(made, houses, [("house", h) for _, h in houses], green, self.street, Polygon(), lane)
        from shapely.geometry import LineString
        for f in got["fences"]:
            self.assertLess(LineString(f["pts"]).intersection(lane.buffer(-0.2)).length, 0.01)  # (along its edge is fine)


    def test_plots_start_behind_a_pavement_inside_the_block(self):
        made, houses, green = self.block()
        pavement = box(0, 1.5, 80, 4)
        got = plots.furnish(made, houses, [("house", h) for _, h in houses], green, self.street, Polygon(), pavement)
        self.assertEqual(len(got["plots"]), 4)
        for p in got["plots"]:
            self.assertAlmostEqual(p["gate"][1], 4, delta=0.05)  # the gate is at the back of the pavement
            self.assertLess(p["poly"].intersection(pavement).area, 0.01)
        self.assertEqual(len(got["drives"]), 4)
        for d in got["drives"]:
            self.assertFalse(plots._rect(d["x"], d["y"], *plots.CAR, d["h"]).intersects(pavement))
        from shapely.geometry import LineString
        fronts = [LineString(f["pts"]) for f in got["fences"] if all(abs(y - 4) < 0.05 for _, y in f["pts"])]
        self.assertTrue(fronts)  # some plots' street fences stand along the back of the pavement


if __name__ == "__main__":
    unittest.main()
