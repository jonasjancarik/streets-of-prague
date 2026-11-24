"""Metre-scale geometry, texture packing and survey-shell import for Old Town Square."""

import io
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from landmark_geometry import Building, at, edges, unit
from landmark_colours import parse_glb

# Prague survey X/Y, height above its 180 m datum, anticlockwise angle of local X.
# For each façade local X runs to the viewer's right and local -Y faces the square.
FRAMES = {
    "radnice": (-3215, 3049, 12, 25.6),
    "tyn": (-3080, 3120, 12, -72.65),
    "mikulas": (-3270, 3145, 12, 10.8),
    "sloup": (-3170, 3085, 12, 22),
}
NAMES = {
    "radnice": "Old Town Hall and Orloj",
    "tyn": "Church of Our Lady before Týn",
    "mikulas": "St Nicholas on Old Town Square",
    "sloup": "Old Town Marian Column",
}

COLORS = {
    "sandstone": (165, 147, 122),
    "granite": (165, 160, 151),
    "carving": (197, 184, 159),
    "cream": (228, 221, 204),
    "plaster": (214, 205, 183),
    "recess": (66, 63, 59),
    "slate": (67, 74, 81),
    "copper": (105, 142, 130),
    "seam": (77, 102, 96),
    "lead": (81, 86, 89),
    "gold": (232, 186, 80),
    "iron": (69, 61, 53),
    "rose": (203, 170, 153),
    "statue": (190, 177, 151),
    "tile": (150, 82, 65),
}


class Atlas:
    def __init__(self, size, images):
        self.image = Image.new("RGB", (size, size), (128, 121, 108))
        self.tiles = {}
        free = [(0, 0, size, size)]
        rng = np.random.default_rng(1410)
        for name, color in COLORS.items():
            noise = rng.normal(0, 1.5 if name == "rose" else 5, (48, 48))
            noise += 4 * gaussian_filter(noise, 3, mode="wrap")
            images[name] = Image.fromarray(np.uint8(np.clip(np.array(color) + noise[:, :, None], 0, 255)))
        for name, im in sorted(images.items(), key=lambda item: -max(item[1].size)):
            w, h = im.size
            fits = [(fw * fh, i) for i, (_, _, fw, fh) in enumerate(free) if fw >= w + 8 and fh >= h + 8]
            if not fits:
                raise ValueError(f"Atlas too small for {name}")
            _, i = min(fits)
            x, y, fw, fh = free.pop(i)
            # Leave the longer spare span unbroken for tall photographs.
            if fw - w > fh - h:
                free.extend([(x + w + 8, y, fw - w - 8, fh), (x, y + h + 8, w + 8, fh - h - 8)])
            else:
                free.extend([(x + w + 8, y, fw - w - 8, h + 8), (x, y + h + 8, fw, fh - h - 8)])
            tile = np.pad(np.asarray(im.convert("RGB")), ((4, 4), (4, 4), (0, 0)), mode="edge")
            self.image.paste(Image.fromarray(tile), (x, y))
            self.tiles[name] = (x + 4.5, y + 4.5, w - 1, h - 1)

    def uv(self, key, t):
        x, y, w, h = self.tiles[key]
        return (x + w * t[0]) / self.image.width, (y + h * t[1]) / self.image.height


def survey(name):
    doc, blob = parse_glb((ROOT / f"public/data/praha_now/landmarks/{name}.glb").read_bytes())
    prim = doc["meshes"][0]["primitives"][0]

    def array(i, w):
        a = doc["accessors"][i]
        v = doc["bufferViews"][a["bufferView"]]
        return np.frombuffer(
            blob,
            {5123: "<u2", 5125: "<u4", 5126: "<f4"}[a["componentType"]],
            a["count"] * w,
            v.get("byteOffset", 0) + a.get("byteOffset", 0),
        ).reshape(-1, w)

    pos = array(prim["attributes"]["POSITION"], 3).astype(float)[:, [0, 2, 1]]
    ox, oy, oz, angle = FRAMES[name]
    pos[:, 1] *= -1
    pos -= (ox, oy, oz)
    a = math.radians(angle)
    pos[:, :2] = pos[:, :2] @ np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    uv = array(prim["attributes"]["TEXCOORD_0"], 2)
    tris = array(prim["indices"], 1).reshape(-1, 3)
    v = doc["bufferViews"][doc["images"][0]["bufferView"]]
    start = v.get("byteOffset", 0)
    texture = Image.open(io.BytesIO(blob[start : start + v["byteLength"]])).convert("RGB")
    return np.column_stack((pos, uv))[tris], texture.resize((1280, 1280), Image.Resampling.LANCZOS)


def shell(m, triangles, ceiling):
    # Slice the survey rather than discarding triangles by centroid: its long walls
    # can run from pavement to belfry in one triangle. Interpolate UVs at each cut.
    for tri in triangles:
        polygon = []
        for a, b in zip(tri, np.roll(tri, -1, axis=0)):
            if a[2] <= ceiling:
                polygon.append(a)
            if a[2] < ceiling < b[2] or b[2] < ceiling < a[2]:
                polygon.append(a + (b - a) * (ceiling - a[2]) / (b[2] - a[2]))
        if len(polygon) < 3:
            continue
        vs = np.array(polygon)
        p = vs[:, :3]
        n = np.cross(p[1] - p[0], p[2] - p[0])
        if np.linalg.norm(n) < 1e-7:
            continue
        n = unit(n)
        # Baked survey surfaces already carry directional light. The fitted stone
        # and metalwork use their physical normals throughout.
        m.face(p, "survey", vs[:, 3:], [unit(np.array([0, 0, 1.8]) + n)] * len(p))


def rect(x, y, w, d):
    return np.array(
        [[x - w / 2, y - d / 2], [x + w / 2, y - d / 2], [x + w / 2, y + d / 2], [x - w / 2, y + d / 2]]
    )


def panel(m, x0, x1, y, z0, z1, tex, uv=(0, 0, 1, 1)):
    u, v, r, b = uv
    m.face([(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)], tex, [(u, b), (r, b), (r, v), (u, v)])


def lathe(m, x, y, profile, mat, sides=24, phase=0):
    angles = np.arange(sides) * math.tau / sides + phase
    circle = np.column_stack((np.cos(angles), np.sin(angles)))
    for (z, r), (h, s) in zip(profile, profile[1:]):
        if r == 0 and s == 0:
            continue
        # A true triangular tip avoids degenerate triangles at a collapsed ring.
        lo = (x, y) + circle * r
        hi = (x, y) + circle * s
        for i in range(sides):
            j = (i + 1) % sides
            pts = [at(lo[i], z), at(lo[j], z), at(hi[j], h), at(hi[i], h)]
            m.face(pts[:3] if s == 0 else [pts[0], pts[2], pts[3]] if r == 0 else pts, mat)
    z, r = profile[-1]
    if r:
        m.face([at(p, z) for p in (x, y) + circle * r], mat)


def rod(m, a, b, r, mat, sides=6):
    a, b = np.array(a), np.array(b)
    d = unit(b - a)
    u = unit(np.cross(d, (0, 0, 1) if abs(d[2]) < 0.9 else (0, 1, 0)))
    v = np.cross(d, u)
    offsets = [
        r * (u * math.cos(i * math.tau / sides) + v * math.sin(i * math.tau / sides)) for i in range(sides)
    ]
    for i, f in enumerate(offsets):
        g = offsets[(i + 1) % sides]
        m.face([a + f, a + g, b + g, b + f], mat)
    m.face([b + f for f in offsets], mat)


def finial(m, x, y, z, h, cross=False):
    r = h * 0.075
    lathe(
        m,
        x,
        y,
        [
            (z, r * 0.46),
            (z + h * 0.30, r * 0.46),
            (z + h * 0.35, r),
            (z + h * 0.42, r * 1.15),
            (z + h * 0.49, r * 0.74),
            (z + h * 0.52, r * 0.28),
            (z + h, r * 0.10),
        ],
        "gold",
        8,
    )
    if cross:
        rod(m, (x - 0.17 * h, y, z + 0.79 * h), (x + 0.17 * h, y, z + 0.79 * h), 0.028 * h, "gold")


def drum(m, ring, bottom, top, mat):
    for a, b in edges(ring):
        m.wall(a, b, bottom, top, mat)
    m.face([at(p, top) for p in ring], mat)
    m.face([at(p, bottom) for p in ring[::-1]], mat)


def band(m, x, y, w, d, z, h, mat="carving"):
    drum(m, rect(x, y, w, d), z, z + h, mat)
