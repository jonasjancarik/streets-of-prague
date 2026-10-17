"""Timetable refreshes preserve usable caches when downloads or writes fail."""

import contextlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pid_timetable as pid


def archive(files):
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as zipped:
        for name, content in files.items():
            zipped.writestr(name, content)
    return raw.getvalue()


GTFS = {
    "feed_info.txt": "feed_start_date\n20261001\n",
    "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20261231\n",
    "calendar_dates.txt": "service_id,date,exception_type\n",
    "routes.txt": "route_id,route_type,route_short_name,route_color,is_night\nR,0,22,FF0000,0\n",
    "trips.txt": "route_id,service_id,trip_id,direction_id\nR,S,T,0\n",
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,parent_station,location_type\nA,First,50.08,14.4,,0\nB,Last,50.09,14.4,,0\n",
    "stop_times.txt": "trip_id,stop_id,stop_sequence,arrival_time,departure_time\nT,A,1,08:00:00,08:00:00\nT,B,2,08:15:00,08:15:00\n",
}


class TimetableCacheTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        for name, value in (("CACHE", root), ("FEED", root / "feed.zip"), ("SUMMARY", root / "summary.json")):
            self.stack.enter_context(patch.object(pid, name, value))
        self.request = self.stack.enter_context(patch.object(pid.requests, "get"))
        self.raw = archive(GTFS)
        self.request.return_value = SimpleNamespace(content=self.raw, raise_for_status=lambda: None)

    def old_feed(self):
        pid.FEED.write_bytes(archive({"old.txt": "previous feed"}))
        os.utime(pid.FEED, ns=(1_000_000_000, 1_000_000_000))
        return pid.FEED.read_bytes(), pid.FEED.stat().st_mtime_ns

    def assert_old_feed(self, before):
        self.assertEqual((pid.FEED.read_bytes(), pid.FEED.stat().st_mtime_ns), before)

    def test_fresh_feed_is_reused_without_a_request(self):
        pid.FEED.write_bytes(self.raw)
        self.assertEqual(pid.feed(), pid.FEED)
        self.request.assert_not_called()

    def test_successful_refresh_replaces_the_old_archive(self):
        self.old_feed()
        self.assertEqual(pid.feed(), pid.FEED)
        self.assertEqual(pid.FEED.read_bytes(), self.raw)
        self.request.assert_called_once()
        self.assertEqual(pid.feed(), pid.FEED)
        self.request.assert_called_once()

    def test_non_zip_download_preserves_the_previous_feed(self):
        before = self.old_feed()
        self.request.return_value.content = b"<html>Service unavailable</html>"
        with self.assertRaises(zipfile.BadZipFile):
            pid.feed()
        self.assert_old_feed(before)

    def test_damaged_archive_member_preserves_the_previous_feed(self):
        before = self.old_feed()
        raw = archive({"test.txt": "new feed"})
        self.request.return_value.content = raw.replace(b"new feed", b"bad feed")
        with self.assertRaisesRegex(ValueError, "test.txt"):
            pid.feed()
        self.assert_old_feed(before)

    def test_missing_required_csv_preserves_the_previous_feed(self):
        before = self.old_feed()
        for files in ({}, {"readme.txt": "not a timetable"}, {name: content for name, content in GTFS.items() if name != "stop_times.txt"}):
            with self.subTest(files=tuple(files)):
                self.request.return_value.content = archive(files)
                with self.assertRaisesRegex(ValueError, "missing required files:.*stop_times.txt"):
                    pid.feed()
                self.assert_old_feed(before)

    def test_interrupted_refresh_preserves_old_bytes_and_retries(self):
        before = self.old_feed()
        write_bytes = Path.write_bytes

        def interrupted(path, raw):
            write_bytes(path, raw[:3])
            raise OSError("simulated interrupted write")

        with patch.object(Path, "write_bytes", interrupted), self.assertRaisesRegex(OSError, "interrupted"):
            pid.feed()
        self.assert_old_feed(before)
        self.assertEqual(pid.feed().read_bytes(), self.raw)
        self.assertEqual(self.request.call_count, 2)

    def test_interrupted_summary_preserves_previous_json_and_rebuilds(self):
        pid.FEED.write_bytes(self.raw)
        previous = json.dumps({"version": 0, "previous": True})
        pid.SUMMARY.write_text(previous)
        write_bytes, write_text = Path.write_bytes, Path.write_text

        def interrupted_bytes(path, raw):
            write_bytes(path, raw[:3])
            raise OSError("simulated interrupted write")

        def interrupted_text(path, raw, *args, **kwargs):
            write_text(path, raw[:3], *args, **kwargs)
            raise OSError("simulated interrupted write")

        with patch.object(Path, "write_bytes", interrupted_bytes), patch.object(Path, "write_text", interrupted_text):
            with self.assertRaisesRegex(OSError, "interrupted"):
                pid.summary()
        self.assertEqual(pid.SUMMARY.read_text(), previous)
        data = pid.summary()
        self.assertEqual(data["version"], pid.VERSION)
        self.assertEqual([(t["ref"], t["dur"]) for t in data["trips"]], [("22", 900)])
        self.assertEqual(json.loads(pid.SUMMARY.read_text()), data)
        self.assertEqual(pid.summary(), data)
        self.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
