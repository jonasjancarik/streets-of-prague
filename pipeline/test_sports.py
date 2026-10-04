import unittest

from shapely import affinity
from shapely.geometry import Point, Polygon, box

import sports
from osm_area import NATURAL_GROUND


def one(leisure, sport, surface, geom, area=None, seed="w/1"):
    return sports.classify(leisure, sport, surface, area, geom, seed)


class Looks(unittest.TestCase):
    def test_tennis_court_on_clay_has_court_lines(self):
        court = affinity.rotate(box(0, 0, 36, 18), 20)
        (kind, _, lines), = one("pitch", "tennis", "clay", court)
        self.assertEqual(kind, "pitch_clay")
        self.assertGreaterEqual(len(lines), 6)

    def test_exact_tennis_court_fills_its_rectangle(self):
        court = box(0, 0, 23.77, 10.97)
        (_, _, lines), = one("pitch", "tennis", "acrylic", court)
        xs = [x for line in lines for x, _ in line]
        self.assertAlmostEqual(max(xs) - min(xs), 23.77, delta=0.1)

    def test_football_pitch_is_grass_with_markings(self):
        (kind, _, lines), = one("pitch", "soccer", "grass", box(0, 0, 105, 68))
        self.assertEqual(kind, "pitch")
        self.assertGreater(len(lines), 6)

    def test_small_untagged_pitch_is_a_hard_court(self):
        (kind, _, _), = one("pitch", None, None, box(0, 0, 20, 12))
        self.assertIn(kind, {"pitch_grey", "pitch_blue", "pitch_green", "pitch_red"})

    def test_beach_volleyball_is_sand(self):
        (kind, _, _), = one("pitch", "beachvolleyball", None, box(0, 0, 16, 8))
        self.assertEqual(kind, "pitch_sand")

    def test_playground_has_no_lines(self):
        (kind, _, lines), = one("playground", None, None, box(0, 0, 30, 30))
        self.assertEqual(kind, "pitch_sand")
        self.assertEqual(lines, [])

    def test_playground_on_grass_is_a_lawn(self):
        (kind, _, _), = one("playground", None, "grass", box(0, 0, 30, 30))
        self.assertEqual(kind, "park")

    def test_same_feature_always_gets_the_same_colour(self):
        a = one("pitch", None, None, box(0, 0, 20, 12), seed="way/7")
        b = one("pitch", None, None, box(0, 0, 20, 12), seed="way/7")
        self.assertEqual(a[0][0], b[0][0])


class Tracks(unittest.TestCase):
    def test_closed_way_becomes_a_band_with_grass_inside(self):
        ring = Polygon(Point(0, 0).buffer(60).exterior.coords)
        parts = one("track", "athletics", None, ring)
        kinds = [k for k, _, _ in parts]
        self.assertEqual(kinds, ["pitch_tartan", "pitch"])
        self.assertAlmostEqual(parts[0][1].area, 2 * 3.14159 * 60 * 6 * 1.22, delta=200)
        self.assertGreaterEqual(len(parts[0][2]), 5)


class Kinds(unittest.TestCase):
    def test_every_pitch_kind_counts_as_natural_ground(self):
        for kind in sports.PITCH_KINDS:
            self.assertIn(kind, NATURAL_GROUND)


if __name__ == "__main__":
    unittest.main()
