"""Mesh downloads validate compression before replacing cache files, offline."""

import contextlib
import gzip
import io
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import photomesh


PAYLOAD = b'{"id":"fixture"}'
PACKED = gzip.compress(PAYLOAD)
bad_crc = bytearray(PACKED)
bad_crc[-8] ^= 1
bad_deflate = bytearray(PACKED)
bad_deflate[10] = (bad_deflate[10] & ~7) | 7
BROKEN = ((PACKED[:-5], EOFError), (bytes(bad_crc), gzip.BadGzipFile), (bytes(bad_deflate), zlib.error))


class MeshDownloadTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(photomesh, "NODES", self.root))
        self.stack.enter_context(patch.object(photomesh.time, "sleep"))
        self.request = self.stack.enter_context(patch.object(photomesh.urllib.request, "urlopen"))
        self.path = self.root / "nodes_fixture"

    def respond(self, *payloads):
        self.request.reset_mock()
        self.responses = [io.BytesIO(data) for data in payloads]
        self.request.side_effect = self.responses

    def test_plain_and_compressed_payloads_are_cached_and_reused(self):
        for data in (PAYLOAD, PACKED):
            with self.subTest(compressed=data == PACKED):
                self.path.unlink(missing_ok=True)
                self.respond(data)
                self.assertEqual(photomesh.fetch("nodes/fixture"), PAYLOAD)
                self.assertEqual(self.path.read_bytes(), data)
                self.assertEqual(photomesh.fetch("nodes/fixture"), PAYLOAD)
                self.assertEqual(self.request.call_count, 1)
                self.assertTrue(self.responses[0].closed)

    def test_bad_compression_is_retried_before_caching(self):
        for data, _ in BROKEN:
            with self.subTest(data=data):
                self.path.unlink(missing_ok=True)
                self.respond(data, PACKED)
                self.assertEqual(photomesh.fetch("nodes/fixture"), PAYLOAD)
                self.assertEqual(self.request.call_count, 2)
                self.assertEqual(self.path.read_bytes(), PACKED)

    def test_persistent_bad_compression_leaves_no_new_cache(self):
        for data, error in BROKEN:
            with self.subTest(error=error):
                self.path.unlink(missing_ok=True)
                self.respond(*[data] * 5)
                with self.assertRaises(error):
                    photomesh.fetch("nodes/fixture")
                self.assertEqual(self.request.call_count, 5)
                self.assertFalse(self.path.exists())

    def test_bad_cached_gzip_is_replaced_only_after_a_valid_download(self):
        original = PACKED[:-5]
        self.path.write_bytes(original)
        self.respond(*[original] * 5)
        with self.assertRaises(EOFError):
            photomesh.fetch("nodes/fixture")
        self.assertEqual(self.request.call_count, 5)
        self.assertEqual(self.path.read_bytes(), original)
        self.respond(PACKED)
        self.assertEqual(photomesh.fetch("nodes/fixture"), PAYLOAD)
        self.assertEqual(self.request.call_count, 1)
        self.assertEqual(self.path.read_bytes(), PACKED)
        self.assertEqual(photomesh.fetch("nodes/fixture"), PAYLOAD)
        self.assertEqual(self.request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
