"""A cobbled side street ends straight along the asphalt street it joins (no wedges)."""
import unittest

from shapely.geometry import LineString, box
from shapely.ops import unary_union

from osm_area import _paving_owners


class PavingOwners(unittest.TestCase):
    def setUp(self):
        # An asphalt street along y = 0, 16 m of carriageway (parking lanes included,
        # wider than its kerbs say), and a cobbled side street, 8 m wide, from the north.
        self.main = box(-60, -8, 60, 8)
        self.side = box(-4, 8, 4, 60)
        self.surface = unary_union([self.main, self.side])
        self.lines = [
            (LineString([(-60, 0), (60, 0)]), False, "residential", 5.0, 5.0),
            (LineString([(0, 0), (0, 60)]), True, "residential", 4.0, 4.0),
        ]

    def test_side_street_ends_at_through_street_edge(self):
        region, own = _paving_owners(self.lines, self.surface)
        setts = region.intersection(self.surface)
        self.assertLess(setts.intersection(self.main).area, 1.0, "cobbles reach into the asphalt street")
        self.assertGreater(setts.intersection(self.side).area, self.side.area - 1.0, "the side street isn't all cobbled")

    def test_cobbled_through_street_keeps_its_setts(self):
        # The other way round: the cobbled street is the more important one.
        lines = [(self.lines[0][0], True, "tertiary", 5.0, 5.0), (self.lines[1][0], False, "residential", 4.0, 4.0)]
        region, own = _paving_owners(lines, self.surface)
        setts = region.intersection(self.surface)
        self.assertGreater(setts.intersection(self.main).area, self.main.area - 1.0)
        self.assertLess(setts.intersection(self.side).area, 1.0)


if __name__ == "__main__":
    unittest.main()
