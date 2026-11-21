import unittest

import numpy as np

from di_tracks import match


class MatchTest(unittest.TestCase):
    # Two surveyed tracks 3 m apart along x, at y = 0 and y = 3.
    AXES = [np.array([[0.0, 0.0], [100.0, 0.0]]), np.array([[0.0, 3.0], [100.0, 3.0]])]

    def test_moves_onto_its_own_axis(self):
        # OSM's track at y = 0.4 moves onto the axis at y = 0.
        nodes = {1: (10.0, 0.4), 2: (20.0, 0.4)}
        got = match(nodes, [[1, 2]], self.AXES)
        self.assertAlmostEqual(got[1][1], 0.0)

    def test_drawn_towards_its_neighbour_keeps_its_own_axis(self):
        # Track A drawn 2 m off towards B: B's axis is nearer to it, but nearer still to
        # B's own line, so A goes to its own axis.
        nodes = {1: (10.0, 2.0), 2: (20.0, 2.0), 3: (10.0, 3.1), 4: (20.0, 3.1)}
        got = match(nodes, [[1, 2], [3, 4]], self.AXES)
        self.assertAlmostEqual(got[1][1], 0.0)
        self.assertAlmostEqual(got[3][1], 3.0)

    def test_crossing_axis_is_not_taken(self):
        # A surveyed axis across the track (another line at a crossing) is left alone.
        nodes = {1: (50.0, 10.0), 2: (50.0, 20.0)}
        got = match(nodes, [[1, 2]], [np.array([[0.0, 11.0], [100.0, 11.0]])])
        self.assertNotIn(1, got)

    def test_far_track_stays(self):
        nodes = {1: (10.0, 8.0), 2: (20.0, 8.0)}
        self.assertEqual(match(nodes, [[1, 2]], self.AXES), {})


if __name__ == "__main__":
    unittest.main()
