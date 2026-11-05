"""Structure evidence preserves the survey's levels and original observations."""

from contextlib import closing
from pathlib import Path
import sqlite3
import struct
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

from shapely.geometry import LineString, box

import dtm_structures as dtm


def package(path, tables):
    gpkg = path.parent / "test.gpkg"
    with closing(sqlite3.connect(gpkg)) as db, db:
        db.execute("CREATE TABLE gpkg_contents (table_name TEXT)")
        for code, features in tables.items():
            table = f"ZPS#{code}_fixture"
            db.execute("INSERT INTO gpkg_contents VALUES (?)", (table,))
            db.execute(f'CREATE TABLE "{table}" (shape BLOB, ID INTEGER, {dtm.LEVEL} INTEGER, '
                       f'{dtm.ACCURACY_Z} INTEGER, {dtm.ACQUISITION} INTEGER, {dtm.EDGE_TYPE} INTEGER, DatumZmeny TEXT)')
            db.executemany(f'INSERT INTO "{table}" VALUES (?, ?, ?, ?, ?, ?, ?)',
                           ((b"GP\x00\x01" + struct.pack("<i", 5514) + g.wkb, *attrs) for g, *attrs in features))
    with zipfile.ZipFile(path, "w") as archive:
        archive.write(gpkg, gpkg.name)
    gpkg.unlink()


class DtmStructures(unittest.TestCase):
    def test_levels_and_metadata_stay_separate_through_cached_reader(self):
        with TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            surfaces = tmp / "ZPS_OPL"
            lines = tmp / "ZPS_KR"
            for folder in (surfaces, lines):
                folder.mkdir()
            date = "2026-07-14T11:23:45"
            shape = box(0, 0, 10, 10)
            upper = LineString([(0, 0, 241.2), (10, 0, 241.8)])
            lower = LineString([(0, 0, 235.2), (10, 0, 235.8)])
            package(surfaces / "polys.zip", {
                dtm.BRIDGE: [(shape, 10, 1, None, None, None, date)],
                dtm.ROAD: [(shape, 11, 1, None, None, None, date), (shape, 12, 0, None, None, None, date)],
                dtm.TUNNEL: [(shape, 13, -1, None, None, None, date)],
            })
            package(lines / "edges.zip", {
                dtm.EDGE: [(upper, 20, 1, 3, 1, 16, date), (lower, 21, 0, 4, 2, 1, date),
                           (LineString([(20, 0, 0), (30, 0, 0)]), 22, 1, 3, 1, 16, date)],
            })
            with patch.multiple(dtm, CACHE=tmp, PACKAGES=surfaces, LINES=lines):
                bounds = (-1, -1, 11, 11)
                rec = {r["attrs"]["ID"]: r for r in dtm.survey(bounds)}
                self.assertEqual(set(rec), {10, 11, 13, 20})
                self.assertFalse(rec[10]["shape"].has_z)
                self.assertEqual(rec[20]["package"], "edges.zip")
                self.assertEqual(rec[20]["attrs"][dtm.ACCURACY_Z], 3)
                self.assertEqual(rec[20]["attrs"][dtm.ACQUISITION], 1)
                self.assertEqual(rec[20]["attrs"][dtm.EDGE_TYPE], 16)
                self.assertEqual(rec[20]["attrs"]["DatumZmeny"], date)
                self.assertEqual(list(rec[20]["shape"].coords), list(upper.coords))
                # A cache hit cannot depend on the freshly opened package contents.
                with patch.object(dtm.zipfile, "ZipFile", side_effect=AssertionError("cache miss")):
                    cached = {r["attrs"]["ID"]: r for r in dtm.survey(bounds)}
                self.assertEqual(cached, rec)
                all_records = {r["attrs"]["ID"]: r for r in dtm.survey(bounds, include_ground=True)}
                self.assertEqual(set(all_records), {10, 11, 12, 13, 20, 21})
                self.assertEqual(list(all_records[21]["shape"].coords), list(lower.coords))
                package(lines / "edges.zip", {dtm.EDGE: [(upper, 20, 1, 4, 2, 16, date)]})
                updated = {r["attrs"]["ID"]: r for r in dtm.survey(bounds)}
                self.assertEqual(updated[20]["attrs"][dtm.ACCURACY_Z], 4)


if __name__ == "__main__":
    unittest.main()
