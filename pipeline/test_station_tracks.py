import unittest

from shapely.geometry import LineString, box

from station_tracks import deck_tracks


class StationDeckTests(unittest.TestCase):
    def test_bridge_tags_fill_a_gap_in_the_surveyed_track(self):
        tracks = deck_tracks([LineString([(-5, 5), (15, 5)])], {1: box(0, 0, 10, 10)},
                             [{"level": 1, "pts": [[0, 5], [2, 5]]}])
        self.assertEqual(tracks, [{"level": 1, "pts": [[0, 5], [10, 5]]}])

    def test_overlapping_decks_require_surveyed_assignment(self):
        tracks = deck_tracks([LineString([(-5, 5), (20, 5)])],
                             {1: box(0, 0, 10, 10), 2: box(8, 0, 15, 10)},
                             [{"level": 2, "pts": [[8, 5], [10, 5]]}])
        by_level = {level: [LineString(t["pts"]) for t in tracks if t["level"] == level] for level in (1, 2)}
        self.assertEqual([line.bounds for line in by_level[1]], [(0, 5, 8, 5)])
        self.assertIn((8, 5, 9.8, 5), [line.bounds for line in by_level[2]])


if __name__ == "__main__":
    unittest.main()
