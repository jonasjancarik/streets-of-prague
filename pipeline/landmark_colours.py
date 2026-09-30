"""Bake the browser's warm landmark photograph adjustment into final GLBs.

Migration keeps the source area intact::

    uv run --project pipeline python pipeline/landmark_colours.py \
        --area-root public/data/centrum_now --output-root /tmp/sop-landmark-colours/centrum_now

JPEG photographs are encoded at quality 88. PNGs retain alpha. Only images used
exclusively as material base-colour textures are changed.
"""

import argparse
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

VERSION = 1
JPEG_QUALITY = 88
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def warm_pixels(pixels: np.ndarray) -> np.ndarray:
    """Return Canvas Uint8ClampedArray-equivalent RGB, retaining alpha and rows."""
    if pixels.dtype != np.uint8 or pixels.ndim != 3 or pixels.shape[2] not in (3, 4):
        raise ValueError("expected H × W × RGB or RGBA uint8 pixels")
    out = pixels.copy()
    rgb = pixels[..., :3].astype(np.float64) / 255.0
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    d = mx - np.minimum(np.minimum(r, g), b)
    h = np.divide(g - b, d, out=np.zeros_like(d), where=d != 0) / 6.0
    selected = (d >= 0.04) & (mx == r) & (g >= b) & (h <= 0.17)
    w = 1.0 - np.maximum(0.0, h - 0.11) / 0.06
    shifted_h = np.maximum(0.0, h - 0.018 * w)
    saturation = np.minimum(1.0, np.divide(d, mx, out=np.zeros_like(d), where=mx != 0) * (1.0 + 0.08 * w))
    new_g = mx * (1.0 - saturation * (1.0 - shifted_h * 6.0))
    new_b = mx * (1.0 - saturation)
    out[..., 1][selected] = np.rint(np.clip(new_g[selected] * 255.0, 0, 255)).astype(np.uint8)
    out[..., 2][selected] = np.rint(np.clip(new_b[selected] * 255.0, 0, 255)).astype(np.uint8)
    return out


def parse_glb(raw: bytes) -> tuple[dict, bytes]:
    if len(raw) < 28 or struct.unpack_from("<III", raw) != (0x46546C67, 2, len(raw)):
        raise ValueError("unsupported GLB header or length")
    offset, chunks = 12, []
    while offset < len(raw):
        if offset + 8 > len(raw):
            raise ValueError("truncated GLB chunk")
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        if length % 4 or offset + length > len(raw):
            raise ValueError("invalid GLB chunk alignment or length")
        chunks.append((kind, raw[offset:offset + length]))
        offset += length
    if len(chunks) != 2 or [kind for kind, _ in chunks] != [JSON_CHUNK, BIN_CHUNK]:
        raise ValueError("expected one JSON chunk and one BIN chunk")
    doc = json.loads(chunks[0][1])
    if len(doc.get("buffers", [])) != 1 or "uri" in doc["buffers"][0]:
        raise ValueError("external or multiple buffers are unsupported")
    if doc["buffers"][0]["byteLength"] > len(chunks[1][1]):
        raise ValueError("BIN chunk is shorter than its buffer")
    if len(chunks[1][1]) - doc["buffers"][0]["byteLength"] > 3:
        raise ValueError("unexpected unreferenced BIN payload")
    return doc, chunks[1][1]


def pack_glb(doc: dict, blob: bytes) -> bytes:
    encoded = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    blob += b"\0" * (-len(blob) % 4)
    return (struct.pack("<III", 0x46546C67, 2, 28 + len(encoded) + len(blob))
            + struct.pack("<II", len(encoded), JSON_CHUNK) + encoded
            + struct.pack("<II", len(blob), BIN_CHUNK) + blob)


def _image_roles(doc: dict) -> set[int]:
    textures = doc.get("textures", [])
    colour, other = set(), set()

    def walk(value, path=()):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith("Texture") and isinstance(child, dict) and "index" in child:
                    index = child["index"]
                    if not isinstance(index, int) or not 0 <= index < len(textures):
                        raise ValueError(f"invalid texture index {index}")
                    source = textures[index].get("source")
                    if not isinstance(source, int) or not 0 <= source < len(doc.get("images", [])):
                        raise ValueError(f"unsupported texture source {source}")
                    (colour if key == "baseColorTexture" and path == ("pbrMetallicRoughness",) else other).add(source)
                else:
                    walk(child, path + (key,))
        elif isinstance(value, list):
            for child in value:
                walk(child, path)

    for material in doc.get("materials", []):
        walk(material)
    if colour & other:
        raise ValueError(f"image used for both colour and non-colour textures: {sorted(colour & other)}")
    return colour


def convert_glb(raw: bytes) -> tuple[bytes, list[dict]]:
    doc, blob = parse_glb(raw)
    scene = doc.get("scene", 0)
    if not isinstance(scene, int) or not 0 <= scene < len(doc.get("scenes", [])):
        raise ValueError("missing active scene")
    extras = doc["scenes"][scene].setdefault("extras", {})
    if not isinstance(extras, dict):
        raise ValueError("scene extras must be an object")
    if "landmarkColourVersion" in extras:
        if extras["landmarkColourVersion"] == VERSION:
            return raw, []
        raise ValueError(f"unsupported landmark colour version {extras['landmarkColourVersion']}")
    images = doc.get("images", [])
    colour = _image_roles(doc)
    if not colour:
        raise ValueError("no base-colour images to convert")
    views = doc.get("bufferViews", [])
    replacements, report = {}, []
    for index, image in enumerate(images):
        if "uri" in image or "bufferView" not in image:
            raise ValueError("external image references are unsupported")
        view_index = image["bufferView"]
        if not isinstance(view_index, int) or not 0 <= view_index < len(views):
            raise ValueError("invalid image bufferView")
        if index not in colour:
            continue
        if view_index in replacements:
            raise ValueError("multiple colour images share a bufferView")
        view = views[view_index]
        if view.get("buffer", 0) != 0:
            raise ValueError("external image buffer is unsupported")
        begin, size = view.get("byteOffset", 0), view["byteLength"]
        if begin < 0 or size < 0 or begin + size > doc["buffers"][0]["byteLength"]:
            raise ValueError("image bufferView exceeds BIN")
        mime = image.get("mimeType")
        if mime not in ("image/jpeg", "image/png"):
            raise ValueError(f"unsupported image MIME type {mime}")
        with Image.open(io.BytesIO(blob[begin:begin + size])) as source:
            # convert() reads stored rows as-is; no EXIF transpose or gamma transform.
            rgba = source.convert("RGBA")
            pixels = np.asarray(rgba).copy()
            warmed = warm_pixels(pixels)
            alpha = np.any(warmed[..., 3] != 255)
            output_mime = "image/png" if alpha or mime == "image/png" else "image/jpeg"
            result = Image.fromarray(warmed, "RGBA")
            encoded = io.BytesIO()
            if output_mime == "image/jpeg":
                result.convert("RGB").save(encoded, format="JPEG", quality=JPEG_QUALITY)
            else:
                result.save(encoded, format="PNG")
            replacements[view_index] = encoded.getvalue()
            image["mimeType"] = output_mime
            report.append({"image": index, "width": source.width, "height": source.height,
                           "mime": output_mime, "sourceBytes": size, "outputBytes": len(replacements[view_index])})
    # An image view must not also serve geometry, even if the GLB claims it does.
    image_views = {image["bufferView"] for image in images}
    for accessor in doc.get("accessors", []):
        if accessor.get("bufferView") in replacements or accessor.get("sparse", {}).get("indices", {}).get("bufferView") in replacements or accessor.get("sparse", {}).get("values", {}).get("bufferView") in replacements:
            raise ValueError("base-colour image bufferView is also used by geometry")
    new_blob = bytearray()
    for i, view in enumerate(views):
        if view.get("buffer", 0) != 0:
            raise ValueError("external bufferView is unsupported")
        begin, size = view.get("byteOffset", 0), view["byteLength"]
        if begin < 0 or size < 0 or begin + size > doc["buffers"][0]["byteLength"]:
            raise ValueError("bufferView exceeds BIN")
        new_blob.extend(b"\0" * (-len(new_blob) % 4))
        payload = replacements.get(i, blob[begin:begin + size])
        view["byteOffset"], view["byteLength"] = len(new_blob), len(payload)
        new_blob.extend(payload)
    new_blob.extend(b"\0" * (-len(new_blob) % 4))
    doc["buffers"][0]["byteLength"] = len(new_blob)
    extras["landmarkColourVersion"] = VERSION
    return pack_glb(doc, bytes(new_blob)), report


def convert_file(source: Path, output: Path) -> list[dict]:
    if source.resolve() == output.resolve():
        raise ValueError("source and output GLB paths must differ")
    converted, report = convert_glb(source.read_bytes())
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        temporary.write_bytes(converted)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return report


def migrate(area_root: Path, output_root: Path, dry_run: bool = False) -> int:
    if output_root.resolve().is_relative_to(area_root.resolve()):
        raise ValueError("output area root must be separate from the source area")
    listing = json.loads((area_root / "landmarks.json").read_text())
    staged, failures = [], []
    for entry in listing:
        source = area_root / entry["file"]
        if source.suffix != ".glb" or source.is_symlink() or not source.resolve().is_relative_to(area_root.resolve()):
            failures.append(f"{entry.get('name')}: unsafe asset path")
            staged.append(entry.copy())
            continue
        target_file = entry["file"] if entry["file"].endswith(".warm-v1.glb") else str(Path(entry["file"]).with_suffix(".warm-v1.glb"))
        target = output_root / target_file
        if not target.resolve().is_relative_to(output_root.resolve()):
            failures.append(f"{entry.get('name')}: unsafe output path")
            staged.append(entry.copy())
            continue
        try:
            if dry_run:
                convert_glb(source.read_bytes())  # Validate the entire input before reporting it.
                print(f"would write {target}")
            else:
                report = convert_file(source, target)
                print(f"{source.name} -> {target.name}: {report}")
            staged.append({**entry, "file": target_file})
        except Exception as error:
            failures.append(f"{entry.get('name')}: {error}")
            staged.append(entry.copy())
    if not dry_run:
        output_root.mkdir(parents=True, exist_ok=True)
        (output_root / "landmarks.json").write_text(json.dumps(staged, ensure_ascii=False))
    if failures:
        for failure in failures:
            print(f"FAILED {failure}", file=sys.stderr)
        print(f"partial result: {len(failures)} of {len(listing)} entries unconverted", file=sys.stderr)
        return 1
    print(f"{len(staged)} landmarks {'validated' if dry_run else 'staged'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--area-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        return migrate(args.area_root, args.output_root, args.dry_run)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"landmark colour migration failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
