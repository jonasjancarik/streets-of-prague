"""Build service uniforms from the shipped Rocketbox body textures.

Run with Python (Pillow and numpy) and basisu. Heads, mesh geometry, normal
maps and animation rigs come from the ordinary avatars at runtime.
"""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[2] / "public/rocketbox"


def body_pixels(name, directory):
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
    return rgb


def refuse_uniform(name, rgb):
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
    return image


# Both jackets zip at the front; the women's atlas has its legs below the
# jacket and the back panel the other way up. All masks use 512-unit UV space.
def responder_uniform(role, name, rgb):
    h, w = rgb.shape[:2]
    y, x = np.indices((h, w)) * 512 / np.array([h, w])[:, None, None]
    r, g, b = rgb.transpose(2, 0, 1)
    lum = .299 * r + .587 * g + .114 * b
    out = rgb.copy()
    female = name.startswith("female")
    if female:
        legs = (y > 278) & ((x < 153) | (x > 358))
        torso = (x > 154) & (x < 357) & (y < 382)
        arms = ((x < 154) | (x > 357)) & (y > 147) & (y < 265)
        # This donor has bare forearms and hands. Keep their original skin.
        hands = ((r > g * 1.12) & (g > b * 1.06)) & ~legs & ~torso & ~arms
        cloth = .30 + lum / 265
        pants = .54 + lum / 146
        waist = torso & ((y < 24) | (y > 348))
        tape = torso & (((y > 45) & (y < 59)) | ((y > 312) & (y < 327)))
        arm_tape = arms & ((x < 35) | (x > 477))
        leg_tape = legs & (((y > 432) & (y < 445)) | ((y > 458) & (y < 470)))
        back_y, chest_y = 115, 280
    else:
        legs = (y < 218) & ((x < 158) | (x > 354))
        torso = (x > 163) & (x < 348) & (y < 431)
        arms = ((x < 156) | (x > 356)) & (y >= 220) & (y < 429)
        hands = ((r > g * 1.12) & (g > b * 1.06)) & (y > 432)
        # Shoe tongues and soles sit between the cuffs and the coat hem.
        torso &= (y < 379) | ((x > 184) & (x < 328))
        arms &= (y < 389) | (x < 120) | (x > 392)
        cloth = .52 + np.minimum(r, 143) / 224
        pants = .55 + np.max(rgb, axis=2) / 134
        if name.endswith("17"):
            cloth = np.where(b > r * 1.35, .53 + b / 224, np.where(lum > 90, .29 + lum / 305, .51 + lum / 160))
        waist = torso & ((y < 37) | (y > 387))
        tape = torso & (((y > 69) & (y < 82)) | ((y > 358) & (y < 371)))
        arm_tape = arms & (((y > 337) & (y < 350)) | ((y > 364) & (y < 374)))
        leg_tape = legs & (((y > 154) & (y < 167)) | ((y > 180) & (y < 189)))
        back_y, chest_y = 145, 298

    def dye(mask, colour, shade):
        out[mask] = np.asarray(colour) * np.clip(shade[mask, None], .35, 1.15)

    jacket, trousers, contrast, marking = {
        "police": ((39, 57, 79), (35, 45, 58), (25, 34, 44), "POLICIE"),
        "medic": ((226, 222, 49), (194, 49, 40), (194, 49, 40), "ZÁCHRANKA"),
        "fire": ((54, 62, 67), (49, 56, 59), (37, 44, 46), "HASIČI"),
    }[role]
    dye(~hands if role == "police" else np.ones_like(hands), (44, 51, 53), .62 + lum / 350)
    dye(legs, trousers, pants)
    dye(torso | arms, jacket, cloth)
    dye(waist, contrast, cloth)
    if role == "police":
        # Dark vest panels leave the shirt sleeves and zipper visible.
        dye(torso & (abs(x - 254) < 66), contrast, cloth)
    else:
        bands = tape | arm_tape | leg_tape
        dye(bands, (213, 219, 211), .55 + .44 * np.where(legs, pants, cloth))
        if role == "fire":
            edge = np.roll(bands, 3, axis=0) & ~bands & (torso | arms | legs)
            dye(edge, (212, 214, 58), cloth)
    out[lum < 3] = 0
    image = Image.fromarray(np.uint8(np.clip(out, 0, 255)))
    # The labels are painted into the atlas so they bend with the coat.
    patch = Image.new("RGB", (188, 50), (33, 44, 54) if role == "police" else contrast)
    d = ImageDraw.Draw(patch)
    font = ImageFont.truetype(str(OUT.parents[1] / "trailer/media/BebasNeue-Regular.ttf"), 40)
    d.rectangle((1, 1, 186, 48), outline=(130, 145, 142), width=2)
    d.text((94, 24), marking, font=font, anchor="mm", fill=(233, 236, 219))
    image.paste(patch.rotate(180), (418, back_y*2 - 25))
    image.paste(patch.resize((72, 20), Image.Resampling.LANCZOS), (540, chest_y*2))
    if role == "police":
        # Vest pockets and a shoulder microphone follow the jacket UVs.
        d = ImageDraw.Draw(image)
        y0 = chest_y*2 + 37
        for left in (389, 542):
            d.rounded_rectangle((left, y0, left+75, y0+51), radius=5, fill="#283542", outline="#434c54", width=2)
            d.rectangle((left+2, y0+2, left+73, y0+13), fill="#37434f")
            d.ellipse((left+34, y0+6, left+40, y0+11), fill="#535b5c")
        d.rounded_rectangle((407, y0-49, 432, y0-16), radius=4, fill="#171f25", outline="#697077")
        for yy in range(y0-42, y0-23, 4):
            d.line((412, yy, 427, yy), fill="#777b78", width=1)
        d.line([(420, y0-16), (414, y0-6), (406, y0), (401, y0+12)], fill="#171f25", width=3)
    return image


def uniform(role, name, directory, rgb):
    image = refuse_uniform(name, rgb) if role == "dustman" else responder_uniform(role, name, rgb)
    image.save(directory / "uniform.png")
    subprocess.run(["basisu", "-ktx2", "-mipmap", "-q", "210", "-file", "uniform.png",
                    "-output_file", str(OUT / f"{role}-{name}.ktx2")],
                   cwd=directory, check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--missing", action="store_true", help="build only missing textures")
    args = parser.parse_args()
    for avatar, roles in {
        "male-adult-10": ["police", "medic", "fire", "dustman"],
        "male-adult-17": ["fire", "dustman"],
        "female-adult-05": ["medic", "police"],
    }.items():
        needed = []
        for role in roles:
            dest = OUT / f"{role}-{avatar}.ktx2"
            if not args.missing or not dest.is_file() or dest.stat().st_size == 0:
                needed.append(role)
        if needed:
            with tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                rgb = body_pixels(avatar, directory)
                for role in needed:
                    uniform(role, avatar, directory, rgb)
