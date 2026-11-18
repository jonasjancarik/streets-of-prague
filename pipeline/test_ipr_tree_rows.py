import unittest

import numpy as np
import shapely
from shapely.geometry import box, Polygon

from ipr_trees import displaced_road_row


class DisplacedTreeRowTest(unittest.TestCase):
    def detect(self, osm, ipr, survey=None, parking=None):
        road = box(-20, -3, 30, 3)
        return displaced_road_row(np.asarray(osm), np.asarray(ipr), shapely.STRtree(shapely.points(ipr)),
                                  road, road if survey is None else survey, Polygon() if parking is None else parking)

    def test_shifted_row_is_replaced_without_dropping_an_isolated_tree(self):
        self.assertEqual(self.detect([(0, 1.5), (6, 1.5), (12, 1.5), (-17, -1.5)],
                                     [(0, 5.7), (6, 5.7), (12, 5.7), (-17, -5.7)]), {0, 1, 2})

    def test_parking_and_unsurveyed_surfaces_do_not_supply_a_conflict(self):
        osm = [(0, 1.5), (6, 1.5), (12, 1.5)]
        ipr = [(0, 5.7), (6, 5.7), (12, 5.7)]
        self.assertEqual(self.detect(osm, ipr, survey=Polygon()), set())
        self.assertEqual(self.detect(osm, ipr, parking=box(-1, 1, 13, 2)), set())

    def test_inconsistent_shifts_and_tied_matches_are_kept(self):
        osm = [(0, 1.5), (6, 1.5), (12, 1.5)]
        self.assertEqual(self.detect(osm, [(0, 5.7), (6, 5.7), (12, -4)]), set())
        self.assertEqual(self.detect(osm, [(0, 5.7), (6, 5.7), (12, 5.7), (12, -2.7)]), set())
