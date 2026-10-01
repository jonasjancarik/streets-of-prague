"""Regression cases for square surface tags and inheritance."""

import unittest

from shapely import STRtree
from shapely.geometry import LineString, box

from osm_area import FEATURE_TAGS, _square_from_ways, _square_surface


class SquareSurfaceTests(unittest.TestCase):
    def test_named_square_relations_are_requested(self):
        self.assertIn("square", FEATURE_TAGS["place"])

    def test_explicit_surface_groups(self):
        for value in ("sett", "cobblestone", "unhewn_cobblestone"):
            self.assertEqual(_square_surface(value), "square_setts")
        for value in ("paving_stones", "concrete:plates", "paved", "concrete"):
            self.assertEqual(_square_surface(value), "square")
        self.assertEqual(_square_surface("asphalt"), "square_asphalt")
        for value in ("compacted", "unpaved", "sand", "gravel", "fine_gravel"):
            self.assertEqual(_square_surface(value), "square_loose")

    def test_majority_and_minimum_length(self):
        square = box(0, 0, 100, 100)
        ways = [(LineString([(10, 10), (90, 10)]), "square_setts"),
                (LineString([(10, 20), (40, 20)]), "square")]
        self.assertEqual(_square_from_ways(square, ways, STRtree([w[0] for w in ways])), "square_setts")
        ways.append((LineString([(10, 30), (90, 30)]), "square"))
        self.assertIsNone(_square_from_ways(square, ways, STRtree([w[0] for w in ways])))
        short = [(LineString([(0, 0), (29, 0)]), "square_setts")]
        self.assertIsNone(_square_from_ways(square, short, STRtree([w[0] for w in short])))

    def test_untagged_way_counts_against_majority(self):
        square = box(0, 0, 100, 100)
        ways = [(LineString([(0, 10), (50, 10)]), "square_setts"),
                (LineString([(0, 20), (50, 20)]), None)]
        self.assertIsNone(_square_from_ways(square, ways, STRtree([w[0] for w in ways])))


if __name__ == "__main__":
    unittest.main()
