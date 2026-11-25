"""A metro vestibule's corridors aren't tunnels, even in a cut without the station."""

import unittest

import numpy as np

import structures


class IdentityTransform:
    def transform(self, xs, ys):
        return np.asarray(xs), np.asarray(ys)


def cut(entrance_at):
    # An underpass under a street: stairs down from a passage on the ground whose far
    # end is a metro entrance, the station itself outside this cut (Jiřího z Poděbrad).
    nodes = [{"type": "node", "id": i, "lon": x, "lat": y}
             for i, x, y in ((1, entrance_at, 0), (2, 0, 0), (3, 0, 5), (4, 0, 30), (5, 0, 35))]
    nodes[0]["tags"] = {"railway": "subway_entrance"}
    ways = [
        {"type": "way", "id": 10, "nodes": [1, 2], "tags": {"highway": "footway", "tunnel": "building_passage"}},
        {"type": "way", "id": 11, "nodes": [2, 3], "tags": {"highway": "steps", "tunnel": "yes", "layer": "-1"}},
        {"type": "way", "id": 12, "nodes": [3, 4], "tags": {"highway": "footway", "tunnel": "yes", "layer": "-1"}},
        {"type": "way", "id": 13, "nodes": [4, 5], "tags": {"highway": "steps", "tunnel": "yes", "layer": "-1"}},
    ]
    return nodes + ways


class StationWaysTests(unittest.TestCase):
    def test_station_roof_keeps_lower_stairs_and_indoor_footways_off_the_surface(self):
        ways = cut(40.0)
        for ident, tags in [
            (431095280, {"highway": "steps", "level": "-1;0", "layer": "-1", "tunnel": "building_passage"}),
            (20, {"highway": "steps", "level": "-1;0", "layer": "-1", "tunnel": "building_passage"}),
            (21, {"highway": "footway", "level": "-2", "indoor": "yes"}),
            (22, {"highway": "footway", "level": "0", "indoor": "yes"}),
        ]:
            ways.append({"type": "way", "id": ident, "nodes": [1, 2], "tags": tags})
        self.assertEqual(structures.station_ways(ways, IdentityTransform(), {10}), {431095280, 21})

    def test_corridor_next_to_an_entrance_is_the_stations(self):
        self.assertEqual(structures.station_ways(cut(3.0), IdentityTransform(), {10}), {11, 12, 13})

    def test_underpass_away_from_the_metro_stays(self):
        self.assertEqual(structures.station_ways(cut(40.0), IdentityTransform(), {10}), set())


if __name__ == "__main__":
    unittest.main()
