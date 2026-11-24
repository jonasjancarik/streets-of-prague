"""Surface atlas for the theatre. Work in east, north, up from its Národní entrance."""

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from landmark_colours import parse_glb
from mesh_colours import Mesh, top_view


def read_survey():
    doc, blob = parse_glb((ROOT / "pipeline/.cache/landmarks/praha/divadlo.mesh.glb").read_bytes())

    def view(i):
        v = doc["bufferViews"][i]
        start = v.get("byteOffset", 0)
        return memoryview(blob)[start : start + v["byteLength"]]

    triangles, uvs, which, images = [], [], [], []
    for pr in doc["meshes"][0]["primitives"]:

        def attribute(name, width):
            a = doc["accessors"][pr["attributes"][name]]
            return np.frombuffer(view(a["bufferView"]), "<f4").reshape(-1, 3, width)

        p = attribute("POSITION", 3)[:, :, [0, 2, 1]].copy()
        p[:, :, 0] += 3730
        p[:, :, 1] = -p[:, :, 1] - 2407
        p[:, :, 2] -= 10
        triangles.append(p)
        uvs.append(attribute("TEXCOORD_0", 2))
        which.append(np.full(len(p), len(images)))
        tex = doc["materials"][pr["material"]]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
        img = doc["images"][doc["textures"][tex]["source"]]
        images.append(np.asarray(Image.open(io.BytesIO(view(img["bufferView"])))))
    return Mesh(np.concatenate(triangles), np.concatenate(uvs), np.concatenate(which), images)


def photograph(mesh, axes, left, bottom, width, height, scale):
    # The same orthographic sampler as the map bake, turned to face the masonry.
    p = mesh.tris @ np.array(axes).T
    keep = (
        (p[:, :, 0].max(1) >= left)
        & (p[:, :, 0].min(1) <= left + width)
        & (p[:, :, 1].max(1) >= bottom)
        & (p[:, :, 1].min(1) <= bottom + height)
    )
    side = max(width, height)
    rgb, depth = top_view(
        Mesh(p[keep], mesh.uv[keep], mesh.tex[keep], mesh.atlases),
        left,
        bottom + height - side,
        side,
        1 / scale,
    )
    w, h = round(width * scale), round(height * scale)
    rgb, depth = rgb[:h, :w], depth[:h, :w]
    nearest = distance_transform_edt(~np.isfinite(depth), return_distances=False, return_indices=True)
    return Image.fromarray(rgb[tuple(nearest)])


STONE = (192, 170, 140)
TOP = ((1, 0, 0), (0, 1, 0), (0, 0, 1))


def material_tile(kind):
    rng = np.random.default_rng(143)
    base = {"ashlar": STONE, "slate": (64, 71, 78), "stone": STONE, "copper": (116, 147, 136)}[kind]
    im = Image.new("RGB", (192, 192), base)
    d = ImageDraw.Draw(im)
    if kind == "ashlar":
        for j in range(8):
            y = j * 24
            for x in range(-96 + (j % 2) * 43, 193, 90):
                offset = int(rng.integers(-7, 6))
                d.rectangle((x + 1, y + 1, x + 88, y + 22), fill=tuple(c + offset for c in base))
                d.line((x, y, x + 89, y), fill=(132, 116, 96), width=2)
                d.line((x, y + 1, x, y + 23), fill=(157, 139, 115))
                d.line((x + 1, y + 2, x + 89, y + 2), fill=(218, 197, 163))
    elif kind == "slate":
        # Fish-scale slate with the pale four-petal crosses visible from the bridge.
        for y in range(-12, 205, 12):
            for x in range(-24 + (y // 12 % 2) * 12, 204, 24):
                c = int(rng.integers(-8, 8))
                d.polygon(
                    [(x, y), (x + 23, y), (x + 22, y + 7), (x + 12, y + 13), (x + 1, y + 7)],
                    fill=tuple(v + c for v in base),
                    outline=(49, 55, 61),
                )
        for cx, cy in [(48, 48), (144, 144)]:
            for dx, dy in [(0, 1), (1, 0), (0, -1), (-1, 0)]:
                pts = [
                    (cx + dx * a - dy * b, cy + dy * a + dx * b) for a, b in [(1, 0), (9, -3), (14, 0), (9, 3)]
                ]
                d.polygon(pts, fill=(181, 179, 153))
            for x, y in [(-14, -14), (14, -14), (-14, 14), (14, 14)]:
                d.ellipse((cx + x - 2, cy + y - 2, cx + x + 1, cy + y + 1), fill=(134, 146, 142))
    elif kind == "copper":
        for x in range(0, 192, 24):
            d.line((x, 0, x, 192), fill=(77, 103, 98), width=2)
            d.line((x + 2, 0, x + 2, 192), fill=(147, 171, 155))
    a = np.asarray(im).astype(float) + rng.normal(0, 3, (192, 192, 1))
    return Image.fromarray(np.uint8(np.clip(a, 0, 255)))


def window_panel(kind):
    """A deep bronze casement, painted ashlar reveals and a moulded stone surround."""
    w, h = 160, 320 if kind == "doorway" else 160
    im = material_tile("stone").resize((w, h))
    d = ImageDraw.Draw(im)
    dark, light, warm = (107, 89, 72), (218, 198, 164), (169, 145, 117)
    if kind == "doorway":
        d.rounded_rectangle((12, 12, 148, 311), radius=64, fill=dark, outline=light, width=5)
        d.rounded_rectangle((18, 21, 142, 311), radius=58, fill=(61, 51, 44), outline=warm, width=5)
        for x0 in (27, 83):
            for y0 in (113, 206):
                d.rectangle((x0, y0, x0 + 49, y0 + 87), fill=(86, 64, 48), outline=(141, 110, 75), width=3)
                d.rectangle((x0 + 7, y0 + 6, x0 + 42, y0 + 80), outline=(56, 43, 38), width=3)
        d.arc((27, 32, 133, 137), 180, 360, fill=(174, 148, 108), width=3)
        for x0 in [38, 57, 80, 103, 122]:
            d.line((80, 93, x0, 48 + abs(80 - x0) * 0.58), fill=(161, 138, 104), width=2)
        d.line((22, 95, 138, 95), fill=warm, width=4)
        return im
    else:
        x, y, r, b = 13, 14, 147, 147
    d.rectangle((x - 7, y - 7, r + 7, b + 6), fill=warm, outline=light, width=3)
    d.rectangle((x - 2, y - 2, r + 2, b + 2), fill=(72, 62, 52))
    # Reflected sky above, warm interior and timber below, with a fine reveal shadow.
    for line in range(y, b):
        f = (line - y) / (b - y)
        d.line((x, line, r, line), fill=(int(65 - 26 * f), int(75 - 33 * f), int(78 - 39 * f)))
    for xx in [x + 2, (r + x) // 2, r - 2]:
        d.line((xx, y, xx, b), fill=(89, 71, 54), width=5)
        d.line((xx + 2, y, xx + 2, b), fill=(154, 127, 89), width=1)
    yy = int(y + (b - y) * 0.37)
    d.rectangle((x, yy - 2, r, yy + 2), fill=(125, 99, 71))
    d.rectangle((x - 11, b + 4, r + 11, b + 9), fill=light)
    d.rectangle((x - 9, b + 10, r + 9, b + 12), fill=dark)
    return im


class Atlas:
    def __init__(self, mesh):
        self.image = Image.new("RGB", (1024, 1024), STONE)
        self.tiles = {}
        self.cursor = [4, 4, 0]
        panels = {}
        stonework = Image.open(Path(__file__).with_name("stonework.webp"))
        for name, (x, y, w, h) in {
            "paired": (0, 0, 160, 288),
            "classic": (160, 0, 144, 288),
            "attic": (304, 0, 160, 128),
            "frieze": (0, 288, 196, 160),
            "carving": (196, 288, 176, 76),
            "oculus": (196, 364, 148, 90),
            "fluting": (0, 448, 72, 200),
            "capital": (72, 448, 94, 64),
            "niche": (304, 494, 148, 232),
        }.items():
            panels[name] = stonework.crop((x, y, x + w, y + h))
        for name in ["ashlar", "slate", "stone", "copper"]:
            panels[name] = material_tile(name)
        panels["rearRoof"] = photograph(mesh, TOP, -10, -100, 39, 47, 10)
        panels["doorway"] = window_panel("doorway")
        panels["lowerWindow"] = window_panel("lowerWindow")
        for name, panel in sorted(panels.items(), key=lambda pair: -pair[1].height):
            self.add(name, panel)
        # Small colour swatches allow stone, oxidised bronze and gilding to share the draw.
        for name, color in {
            "trim": (209, 188, 154),
            "shadow": (151, 131, 110),
            "glass": (51, 62, 65),
            "gold": (204, 162, 75),
            "giltEdge": (240, 204, 107),
            "bronze": (76, 109, 99),
            "lead": (85, 91, 90),
            "patina": (92, 129, 116),
        }.items():
            self.add(name, Image.new("RGB", (12, 12), color))

    def add(self, name, im):
        x, y, row = self.cursor
        w, h = im.size
        if x + w + 4 > self.image.width:
            x, y, row = 4, y + row + 8, 0
        if y + h + 4 > self.image.height:
            raise ValueError(f"{name} exceeds atlas height")
        # Extrude four pixels at every island edge so mipmaps see the same material.
        a = np.pad(np.asarray(im), ((4, 4), (4, 4), (0, 0)), mode="edge")
        self.image.paste(Image.fromarray(a), (x - 4, y - 4))
        self.tiles[name] = np.array([x + 0.5, y + 0.5, w - 1, h - 1])
        self.cursor = [x + w + 8, y, max(row, h)]

    def uv(self, name, uv):
        x, y, w, h = self.tiles[name]
        return (x + w * uv[0]) / 1024, (y + h * uv[1]) / 1024
