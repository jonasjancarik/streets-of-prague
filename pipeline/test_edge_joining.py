"""A tunnel and the bridge beside it must stay two street edges (Strahovský tunel)."""
import unittest

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


if __name__ == "__main__":
    unittest.main()
