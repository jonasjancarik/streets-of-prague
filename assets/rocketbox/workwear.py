"""Build the two refuse uniforms from the shipped Rocketbox body textures.

Run with Python (Pillow and numpy) and basisu. Heads, mesh geometry, normal
maps and animation rigs come from the ordinary avatars at runtime.
"""
import json
from pathlib import Path
import struct
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[2] / "public/rocketbox"


def uniform(name, directory):
    data = (OUT / f"{name}.glb").read_bytes()
    size, = struct.unpack_from("<I", data, 12)
    gltf = json.loads(data[20:20 + size])
    body = next(m for m in gltf["materials"] if m["name"].endswith("_body"))
    tex = gltf["textures"][body["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
    image = gltf["images"][tex["extensions"]["KHR_texture_basisu"]["source"]]
    view = gltf["bufferViews"][image["bufferView"]]
    start = size + 28 + view.get("byteOffset", 0)
    (directory / "body.ktx2").write_bytes(data[start:start + view["byteLength"]])
    subprocess.run(["basisu", "-unpack", "-no_ktx", "-etc1_only", "-file", "body.ktx2"],
                   cwd=directory, check=True, stdout=subprocess.DEVNULL)
    rgb = np.asarray(Image.open(next(directory.glob("body*level_0_*png"))).convert("RGB"), dtype=float)
    h, w = rgb.shape[:2]
    y, x = np.indices((h, w)) * 512 / np.array([h, w])[:, None, None]
    r, g, b = rgb.transpose(2, 0, 1)
    original = np.max(rgb, axis=2)
    out = rgb.copy()
    # Dark boots and gloves. Retain the original stitching, laces and fingers.
    def dye(mask, colour, shade):
        out[mask] = np.asarray(colour) * np.clip(shade[mask, None], .37, 1.19)

    dye(original > 0, (53, 59, 57), .61 + original / 400)
    trousers = ((x < 158) | (x > 354)) & (y < 218)
    torso = (x > 163) & (x < 348) & (y < 431)
    sleeves = ((x < 156) | (x > 356)) & (y >= 220) & (y < 429)
    jacket = torso | sleeves
    # These two zipped jackets have different underlying panel colours.
    if name.endswith("10"):
        folds = .52 + np.minimum(r, 143) / 224
        leg_folds = .55 + original / 134
        back_bands, front_bands = [54, 81], [355, 382]
    else:
        folds = np.where(b > r * 1.35, .53 + b / 224,
                         np.where(original > 90, .29 + original / 305, .51 + original / 160))
        leg_folds = .55 + original / 162
        back_bands, front_bands = [45, 72], [343, 370]

    dye(trousers, (51, 84, 64), leg_folds)
    dye(trousers & (y > 112), (224, 103, 32), leg_folds)
    dye(jacket, (250, 106, 26), folds)
    hem = torso & ((y < back_bands[0] - 8) | (y > front_bands[-1] + 14))
    dye(hem | (sleeves & (y > 393)), (44, 74, 60), folds)
    tape = np.zeros((h, w), dtype=bool)
    for row in back_bands + front_bands:
        tape |= torso & (y >= row) & (y < row + 10)
    for row in [344, 368]:
        tape |= sleeves & (y >= row) & (y < row + 9)
    for row in [154, 178]:
        tape |= trousers & (y >= row) & (y < row + 9)
    dye(tape, (211, 217, 208), .51 + .47 * np.where(trousers, leg_folds, folds))
    # Keep the zipper visible through the horizontal tape.
    zip_line = torso & (abs(x - 255) < 1.35) & (y > 259) & (y < 397)
    dye(zip_line, (63, 73, 66), folds)
    out[original < 4] = 0
    image = Image.fromarray(np.uint8(np.clip(out, 0, 255)))
    # A generic bin pictogram on a stitched patch, on the back and left chest.
    patch = Image.new("RGB", (84, 66), "#e0d6ac")
    d = ImageDraw.Draw(patch)
    d.rectangle((3, 3, 80, 62), outline="#646e5d", width=2)
    d.polygon([(27, 23), (58, 23), (54, 47), (32, 47)], fill="#326447")
    d.rectangle((24, 17, 60, 21), fill="#326447")
    d.rectangle((36, 13, 48, 18), fill="#326447")
    for xx in [33, 49]:
        d.ellipse((xx, 46, xx + 6, 52), fill="#34423a")
    image.paste(patch.rotate(180), (470, 260))
    image.paste(patch.resize((34, 27), Image.Resampling.LANCZOS), (559, 584))
    image.save(directory / "uniform.png")
    subprocess.run(["basisu", "-ktx2", "-mipmap", "-q", "210", "-file", "uniform.png",
                    "-output_file", str(OUT / f"dustman-{name}.ktx2")],
                   cwd=directory, check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    for avatar in ["male-adult-10", "male-adult-17"]:
        with tempfile.TemporaryDirectory() as temp:
            uniform(avatar, Path(temp))
