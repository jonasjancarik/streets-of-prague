import json
import tempfile
import unittest
from pathlib import Path

import tin_record

TERRAIN = {"n": 63, "step": 4.03, "unit": None}


def tile(i, j, **extra):
    t = {"i": i, "j": j, "box": [i * 250, j * 250, i * 250 + 250, j * 250 + 250],
         "roads": {"road": [[[[0, 0], [10, 0], [10, 10], [0, 0]]]]}, "areas": {"park": [], "water": []},
         "trees": [[1, 2, 3]], "drive": [{"id": "a", "pts": [[0, 0], [5, 5]], "width": 7, "u": "1", "v": "2"}]}
    t.update(extra)
    return t


class TinRecordTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        for i in range(3):
            for j in range(3):
                self.put(tile(i, j))
                (self.dir / f"{i}_{j}.height.bin").write_bytes(b"h%d%d" % (i, j))
                (self.dir / f"{i}_{j}.tin.bin.gz").write_bytes(b"mesh")

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, t):
        (self.dir / f"{t['i']}_{t['j']}.json").write_text(json.dumps(t))

    def record(self):
        return {"settings": {}, "tiles": tin_record.inputs(self.dir, TERRAIN)}

    def test_a_mesh_stays_while_what_it_was_made_from_does(self):
        rec = self.record()
        # Trees, ground cover and a street's width aren't what the mesh is made from.
        self.put(tile(1, 1, trees=[], areas={"park": [[[[0, 0], [1, 0], [1, 1], [0, 0]]]], "water": []},
                      drive=[{"id": "a", "pts": [[0, 0], [5, 5]], "width": 9, "u": "1", "v": "2"}]))
        ok, stale = tin_record.fresh(self.dir, TERRAIN, rec)
        self.assertEqual(len(ok), 9)
        self.assertEqual(stale, [])

    def test_paved_ground_heights_or_a_neighbours_streets_make_it_stale(self):
        rec = self.record()
        self.put(tile(0, 0, roads={}))  # the copy of a deck on the ground under it, gone
        ok, stale = tin_record.fresh(self.dir, TERRAIN, rec)
        self.assertEqual(stale, ["0_0", "0_1", "1_0", "1_1"])  # it and its neighbours
        rec = self.record()
        (self.dir / "2_2.height.bin").write_bytes(b"lower")
        self.assertEqual(tin_record.fresh(self.dir, TERRAIN, rec)[1], ["1_1", "1_2", "2_1", "2_2"])

    def test_a_mesh_nobody_recorded_is_stale(self):
        ok, stale = tin_record.fresh(self.dir, TERRAIN, {"settings": {}, "tiles": {}})
        self.assertEqual(ok, [])
        self.assertEqual(len(stale), 9)


if __name__ == "__main__":
    unittest.main()
