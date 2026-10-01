"""Regression tests for the byte formula and final-GLB colour conversion."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from landmark_colours import convert_glb, migrate, pack_glb, parse_glb, warm_pixels


def scalar(pixel):
    """Literal per-pixel translation of src/tiles.ts warmUp, with Canvas rounding."""
    result = list(pixel)
    r, g, b = (value / 255 for value in pixel[:3])
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d < 0.04 or mx != r or g < b:
        return result
    h = ((g - b) / d) / 6
    if h > 0.17:
        return result
    w = 1 - max(0, h - 0.11) / 0.06
    h = max(0, h - 0.018 * w)
    s = min(1, (d / mx) * (1 + 0.08 * w))
    k = h * 6
    g = mx * (1 - s * (1 - k))
    b = mx * (1 - s)
    result[:3] = [round(value * 255) for value in (mx, g, b)]
    return result


def png(pixels):
    encoded = io.BytesIO()
    Image.fromarray(np.asarray(pixels, dtype=np.uint8), "RGBA").save(encoded, format="PNG")
    return encoded.getvalue()


def fixture(images=None, shared_role=False):
    images = images or [png([[[180, 120, 65, 255], [30, 50, 90, 255]], [[210, 150, 30, 255], [220, 140, 80, 24]]]),
                        png([[[120, 75, 40, 255]]]), png([[[127, 127, 255, 255]]])]
    geometry = b"\x01\x02\x03\x04\x05\x06\x07\x08"
    blob = bytearray(geometry)
    views = [{"buffer": 0, "byteOffset": 0, "byteLength": len(geometry), "target": 34962}]
    for image in images:
        blob.extend(b"\0" * (-len(blob) % 4))
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(image)})
        blob.extend(image)
    blob.extend(b"\0" * (-len(blob) % 4))
    materials = [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}},
                 {"pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}}]
    materials[0]["normalTexture"] = {"index": 0 if shared_role else 2}
    doc = {"asset": {"version": "2.0", "copyright": "IPR Praha, CC BY"},
           "scene": 0, "scenes": [{"nodes": [0], "extras": {"note": "retained"}}],
           "nodes": [{"mesh": 0}], "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "material": 0}]}],
           "buffers": [{"byteLength": len(blob)}], "bufferViews": views,
           "accessors": [{"bufferView": 0, "componentType": 5126, "count": 0, "type": "VEC3"}],
           "images": [{"bufferView": i + 1, "mimeType": "image/png"} for i in range(len(images))],
           "textures": [{"source": i} for i in range(len(images))], "materials": materials,
           "samplers": [{"magFilter": 9729}]}
    return pack_glb(doc, bytes(blob))


class ColourFormulaTests(unittest.TestCase):
    def test_reference_pixels_and_rows(self):
        rows = np.array([
            [[0, 0, 0, 255], [120, 120, 120, 33], [50, 70, 200, 255], [255, 0, 0, 1]],
            [[160, 75, 18, 255], [200, 185, 60, 9], [120, 116, 113, 255], [170, 160, 164, 255]],
        ], dtype=np.uint8)
        expected = np.array([[scalar(pixel) for pixel in row] for row in rows], dtype=np.uint8)
        np.testing.assert_array_equal(warm_pixels(rows), expected)
        np.testing.assert_array_equal(warm_pixels(rows)[..., 3], rows[..., 3])
        self.assertTrue(np.array_equal(rows[0, 0], [0, 0, 0, 255]))

    def test_deterministic_random_pixels(self):
        pixels = np.random.default_rng(1010).integers(0, 256, (17, 23, 4), dtype=np.uint8)
        expected = np.array([[scalar(pixel) for pixel in row] for row in pixels], dtype=np.uint8)
        np.testing.assert_array_equal(warm_pixels(pixels), expected)


class GlbTests(unittest.TestCase):
    def test_multi_image_geometry_metadata_alignment_and_idempotence(self):
        source = fixture()
        original, original_blob = parse_glb(source)
        converted, report = convert_glb(source)
        doc, blob = parse_glb(converted)
        self.assertEqual(len(report), 2)
        self.assertEqual(doc["scenes"][0]["extras"], {"note": "retained", "landmarkColourVersion": 1})
        self.assertEqual(doc["asset"], original["asset"])
        self.assertEqual(doc["meshes"], original["meshes"])
        self.assertEqual(doc["accessors"], original["accessors"])
        self.assertEqual(doc["samplers"], original["samplers"])
        self.assertEqual(blob[:8], original_blob[:8])
        untouched = doc["bufferViews"][3]
        old_untouched = original["bufferViews"][3]
        self.assertEqual(blob[untouched["byteOffset"]:untouched["byteOffset"] + untouched["byteLength"]],
                         original_blob[old_untouched["byteOffset"]:old_untouched["byteOffset"] + old_untouched["byteLength"]])
        self.assertEqual(doc["buffers"][0]["byteLength"], len(blob))
        for view in doc["bufferViews"]:
            self.assertEqual(view["byteOffset"] % 4, 0)
            self.assertLessEqual(view["byteOffset"] + view["byteLength"], len(blob))
        image_view = doc["bufferViews"][1]
        with Image.open(io.BytesIO(blob[image_view["byteOffset"]:image_view["byteOffset"] + image_view["byteLength"]])) as image:
            self.assertEqual(image.size, (2, 2))
            self.assertEqual(image.getpixel((1, 1))[3], 24)
        self.assertEqual(convert_glb(converted), (converted, []))

    def test_shared_colour_and_normal_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "both colour and non-colour"):
            convert_glb(fixture(shared_role=True))

    def test_external_image_and_unsupported_version_are_rejected(self):
        doc, blob = parse_glb(fixture())
        doc["images"][0] = {"uri": "photo.png"}
        with self.assertRaisesRegex(ValueError, "external image"):
            convert_glb(pack_glb(doc, blob))
        doc["images"][0] = {"bufferView": 1, "mimeType": "image/png"}
        doc["scenes"][0]["extras"]["landmarkColourVersion"] = 2
        with self.assertRaisesRegex(ValueError, "unsupported landmark colour version"):
            convert_glb(pack_glb(doc, blob))
        doc["scenes"][0]["extras"]["landmarkColourVersion"] = True
        with self.assertRaisesRegex(ValueError, "unsupported landmark colour version"):
            convert_glb(pack_glb(doc, blob))

    def test_migration_preserves_source_and_reports_partial_failure(self):
        with tempfile.TemporaryDirectory() as root:
            area, staged = Path(root) / "source", Path(root) / "staged"
            (area / "landmarks").mkdir(parents=True)
            original = fixture()
            (area / "landmarks" / "one.glb").write_bytes(original)
            manifest = [{"name": "one", "file": "landmarks/one.glb", "home": "1_2"}]
            (area / "landmarks.json").write_text(json.dumps(manifest))
            self.assertEqual(migrate(area, staged, True), 0)
            self.assertFalse(staged.exists())
            self.assertEqual(migrate(area, staged), 0)
            self.assertEqual((area / "landmarks" / "one.glb").read_bytes(), original)
            result = json.loads((staged / "landmarks.json").read_text())
            self.assertEqual(result, [{**manifest[0], "file": "landmarks/one.warm-v1.glb"}])
            parse_glb((staged / result[0]["file"]).read_bytes())
            self.assertEqual(migrate(area, staged), 0)
            manifest.append({"name": "missing", "file": "landmarks/missing.glb", "home": "2_3"})
            (area / "landmarks.json").write_text(json.dumps(manifest))
            self.assertEqual(migrate(area, staged), 1)
            self.assertEqual(json.loads((staged / "landmarks.json").read_text())[1], manifest[1])
            self.assertFalse((staged / "landmarks" / "missing.warm-v1.glb").exists())

    def test_same_root_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, "separate"):
                migrate(Path(root), Path(root))

    def test_failed_output_keeps_manifest_entry_and_source(self):
        with tempfile.TemporaryDirectory() as root:
            area, staged = Path(root) / "source", Path(root) / "staged"
            (area / "landmarks").mkdir(parents=True)
            original = fixture()
            (area / "landmarks" / "one.glb").write_bytes(original)
            entry = {"name": "one", "file": "landmarks/one.glb", "home": "1_2"}
            (area / "landmarks.json").write_text(json.dumps([entry]))
            with patch("landmark_colours.convert_file", side_effect=OSError("disk full")):
                self.assertEqual(migrate(area, staged), 1)
            self.assertEqual(json.loads((staged / "landmarks.json").read_text()), [entry])
            self.assertEqual((area / entry["file"]).read_bytes(), original)
            self.assertFalse((staged / "landmarks" / "one.warm-v1.glb").exists())


if __name__ == "__main__":
    unittest.main()
