"""Street simplification keeps structures and shared OSM way endpoints separate."""
import pickle
import unittest
from types import SimpleNamespace

import osmnx as ox

import build_tiles


def elements():
    nodes = [{"type": "node", "id": i, "lat": 50.0, "lon": 14.0 + i * 0.001} for i in range(1, 5)]
    way = lambda wid, refs, **tags: {"type": "way", "id": wid, "nodes": refs, "tags": {"highway": "trunk", **tags}}
    return nodes + [way(10, [1, 2], tunnel="yes"), way(11, [2, 3], bridge="yes"), way(12, [3, 4])]


class EdgeJoiningTests(unittest.TestCase):
    def test_tunnel_and_bridge_are_not_joined(self):
        G = ox.graph._create_graph([{"elements": elements()}], False)
        joined = ox.simplify_graph(G)
        self.assertTrue(any("yes" in str(d.get("tunnel")) and "yes" in str(d.get("bridge")) for *_, d in joined.edges(data=True)))
        kept = ox.simplify_graph(G, edge_attrs_differ=build_tiles.JOIN_ONLY_ALIKE)
        for *_, d in kept.edges(data=True):
            self.assertFalse(d.get("tunnel") == "yes" and d.get("bridge") == "yes")
            self.assertNotIsInstance(d.get("tunnel"), list)
            self.assertNotIsInstance(d.get("bridge"), list)

    def roads(self, ways):
        positions = {1: 50.003, 2: 50.001, 3: 49.999, 4: 49.997}
        used = {node for _, nodes, _ in ways for node in nodes}
        nodes = [{"type": "node", "id": node, "lat": lat, "lon": 14.0} for node, lat in positions.items() if node in used]
        return pickle.dumps({"elements": nodes + [
            {"type": "way", "id": way, "nodes": refs, "tags": {"highway": "tertiary", "lanes": str(lanes), "name": "Through road"}}
            for way, refs, lanes in ways]})

    def edges(self, ways, core, network="drive"):
        projection = SimpleNamespace(transform=lambda x, y: ((x - 14) * 70000, (y - 50) * 111000))
        return build_tiles.graph_edges(None, projection, network, network == "drive", source=self.roads(ways), core=core)

    def test_adjacent_cuts_keep_shared_way_endpoints_and_width(self):
        # Both cuts contain way 20; only one sees the preceding way, and only the
        # other sees the following way. Merging them loses their shared node ids.
        south = [(20, [2, 3], 2), (30, [3, 4], 2)]
        north = [(10, [1, 2], 1), (20, [2, 3], 2)]
        for network in ("drive", "walk"):
            with self.subTest(network=network):
                lower = {e["id"]: e for e in self.edges(south, (-500, -250, 500, 0), network)}
                upper = {e["id"]: e for e in self.edges(north, (-500, 0, 500, 250), network)}
                common = ["2>3>0", "3>2>0"] if network == "drive" else ["2>3>0"]
                for key in common:
                    self.assertIn(key, lower)
                    self.assertIn(key, upper)
                    self.assertEqual(lower[key]["pts"], upper[key]["pts"])
                    for edge in (lower[key], upper[key]):
                        self.assertEqual(edge["lanes"], 2)
                        self.assertEqual(edge["width"], 7)
                self.assertEqual(upper["1>2>0"]["lanes"], 1)
                self.assertEqual(upper["1>2>0"]["width"], 3.75)

    def test_intermediate_nodes_of_one_way_still_simplify(self):
        for network, count in (("drive", 2), ("walk", 1)):
            with self.subTest(network=network):
                edges = self.edges([(20, [1, 2, 3, 4], 2)], (-500, -250, 500, 250), network)
                self.assertEqual(len(edges), count)
                for edge in edges:
                    self.assertEqual({edge["u"], edge["v"]}, {"1", "4"})
                    self.assertEqual(len(edge["pts"]), 4, "simplification keeps the way's bends")


if __name__ == "__main__":
    unittest.main()
