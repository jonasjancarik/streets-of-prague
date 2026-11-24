"""Pack the Rocketbox diffuse textures for crowd.mjs. Names arrive in catalogue order."""
import json
import math
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

FOLDER = Path(__file__).resolve().parents[2] / "public" / "rocketbox"
PARTS = ["body", "head", "opacity", "glasses"]
CELL, PAD, COLUMNS = 128, 4, 8


def patch(data, doc, start, material, folder):
    index = material["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    source = doc["textures"][index]["extensions"]["KHR_texture_basisu"]["source"]
    view = doc["bufferViews"][doc["images"][source]["bufferView"]]
    offset = start + view.get("byteOffset", 0)
    folder.mkdir()
    (folder / "map.ktx2").write_bytes(data[offset:offset + view["byteLength"]])
    # BC3 produces an RGBA PNG for masked hair and eyewear as well as RGB maps.
    subprocess.run(["basisu", "-unpack", "-no_ktx", "-format_only", "3", "-file", "map.ktx2"],
                   cwd=folder, stdout=subprocess.DEVNULL, check=True)
    pngs = sorted(folder.glob("*level_0_*png"))
    image = next((p for p in pngs if "_rgba_" in p.name), None)
    if image is None:
        image = next(p for p in pngs if "_rgb_" in p.name)
    with Image.open(image) as original:
        photo = original.convert("RGBA").resize((CELL - 2 * PAD, CELL - 2 * PAD), Image.Resampling.LANCZOS)
    if material.get("alphaMode", "OPAQUE") == "OPAQUE":
        photo.putalpha(255)
    pixels = np.array(photo)
    clear = pixels[:, :, 3] < 8
    if clear.any() and not clear.all():
        iy, ix = distance_transform_edt(clear, return_distances=False, return_indices=True)
        pixels[clear, :3] = pixels[iy[clear], ix[clear], :3]
    return Image.fromarray(np.pad(pixels, ((PAD, PAD), (PAD, PAD), (0, 0)), mode="edge"))


def build(names):
    rows = 2 ** math.ceil(math.log2(math.ceil(len(names) * len(PARTS) / COLUMNS)))
    atlas = Image.new("RGBA", (CELL * COLUMNS, CELL * rows))
    with tempfile.TemporaryDirectory() as tmp:
        for catalogue, name in enumerate(names):
            raw = (FOLDER / (name + ".glb")).read_bytes()
            length = struct.unpack_from("<I", raw, 12)[0]
            doc = json.loads(raw[20:20 + length])
            for material in doc["materials"]:
                part = PARTS.index(material["name"].split("_")[-1])
                slot = catalogue * len(PARTS) + part
                image = patch(raw, doc, 28 + length, material, Path(tmp) / str(slot))
                atlas.paste(image, (slot % COLUMNS * CELL, slot // COLUMNS * CELL))
    output = FOLDER / "crowd.webp"
    atlas.save(output, quality=89, method=4, exact=True)
    print(output, output.stat().st_size, "bytes")


if __name__ == "__main__":
    build(sys.argv[1:])
