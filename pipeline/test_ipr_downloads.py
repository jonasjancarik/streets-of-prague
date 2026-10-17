"""IPR source downloads publish complete feature sets, with no live service access."""

import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import build_lamps
import ipr_open
import ipr_trees


FEATURE = {"attributes": {"objectid": 1, "kod_drevin": 1, "ctmtp_kod": 606560},
           "geometry": {"points": [[14.4, 50.08]], "x": 14.4, "y": 50.08}}
ERROR = {"error": {"code": 503, "message": "Service unavailable", "details": ["Try later"]}}


class SourceDownloadTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(patch.object(ipr_open, "CACHE", self.root))
        self.stack.enter_context(patch.object(ipr_trees, "CACHE", self.root / "trees.json"))
        self.stack.enter_context(patch.object(ipr_open.time, "sleep"))
        self.request = self.stack.enter_context(patch.object(ipr_open.requests, "get"))
        self.paths = {name: self.root / f"{name}.json" for name in ("trees", "lamps", "open")}

    def download(self, name):
        if name == "trees":
            return ipr_trees.download()
        if name == "lamps":
            return build_lamps.download(cache=self.paths[name])
        return ipr_open.cached("open.json", lambda: list(ipr_open.pages("fixture")))

    def respond(self, *pages):
        self.request.reset_mock()
        self.request.side_effect = [SimpleNamespace(raise_for_status=lambda: None, json=lambda p=p: p) for p in pages]

    def test_service_error_is_retried_without_caching_an_empty_dataset(self):
        for name, path in self.paths.items():
            with self.subTest(source=name):
                self.respond(*[ERROR] * 5)
                with self.assertRaisesRegex(ValueError, "Service unavailable.*Try later"):
                    self.download(name)
                self.assertEqual(self.request.call_count, 5)
                self.assertFalse(path.exists())

    def test_failed_later_page_does_not_publish_a_partial_dataset(self):
        for name, path in self.paths.items():
            with self.subTest(source=name):
                self.respond({"features": [FEATURE], "exceededTransferLimit": True}, *[ERROR] * 5)
                with self.assertRaises(ValueError):
                    self.download(name)
                self.assertEqual([c.kwargs["params"]["resultOffset"] for c in self.request.call_args_list], [0, 1, 1, 1, 1, 1])
                self.assertFalse(path.exists())

    def test_malformed_or_incomplete_pages_are_not_empty_results(self):
        for name, path in self.paths.items():
            for page in ({}, [], {"features": None}, {"features": {}},
                         {"features": [], "exceededTransferLimit": True}):
                with self.subTest(source=name, page=page):
                    self.respond(*[page] * 5)
                    with self.assertRaises(ValueError):
                        self.download(name)
                    self.assertEqual(self.request.call_count, 5)
                    self.assertFalse(path.exists())

    def test_complete_pages_are_cached_and_reused(self):
        for name, path in self.paths.items():
            with self.subTest(source=name):
                self.respond({"features": [FEATURE], "exceededTransferLimit": True}, {"features": []})
                result = self.download(name)
                self.assertEqual(len(result), 1)
                self.assertTrue(path.exists())
                self.assertEqual(self.download(name), result)
                self.assertEqual([c.kwargs["params"]["resultOffset"] for c in self.request.call_args_list], [0, 1])

    def test_transient_error_retries_the_same_page_and_completes(self):
        for name, path in self.paths.items():
            with self.subTest(source=name):
                self.respond({"features": [FEATURE], "exceededTransferLimit": True}, ERROR, {"features": [FEATURE]})
                self.assertEqual(len(self.download(name)), 2)
                self.assertTrue(path.exists())
                self.assertEqual([c.kwargs["params"]["resultOffset"] for c in self.request.call_args_list], [0, 1, 1])

    def test_successful_empty_layer_is_cached(self):
        for name, path in self.paths.items():
            with self.subTest(source=name):
                self.respond({"features": [], "exceededTransferLimit": False})
                self.assertEqual(self.download(name), [])
                self.assertTrue(path.exists())
                self.assertEqual(self.download(name), [])
                self.assertEqual(self.request.call_count, 1)

    def test_interrupted_cache_write_is_retried_from_the_source(self):
        write_bytes, write_text = Path.write_bytes, Path.write_text

        def interrupted_bytes(path, raw):
            write_bytes(path, raw[:3])
            raise OSError("simulated interrupted write")

        def interrupted_text(path, raw, *args, **kwargs):
            write_text(path, raw[:3], *args, **kwargs)
            raise OSError("simulated interrupted write")

        for name, path in self.paths.items():
            with self.subTest(source=name):
                self.respond({"features": [FEATURE]})
                with patch.object(Path, "write_bytes", interrupted_bytes), patch.object(Path, "write_text", interrupted_text):
                    with self.assertRaisesRegex(OSError, "interrupted"):
                        self.download(name)
                self.assertFalse(path.exists())
                self.respond({"features": [FEATURE]})
                self.assertEqual(len(self.download(name)), 1)
                self.assertEqual(self.request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
