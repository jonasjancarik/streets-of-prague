"""Skyline silhouettes of real Prague views for the game's art (loading screens, the
backdrop behind character portraits), drawn from the same IPR 3D buildings and terrain
the game uses, so every tower is where it really is.

    uv run skyline.py hradcany                 # one view, into ../assets/skylines/
    uv run skyline.py --all --out /tmp/sky     # every view, elsewhere

Buildings and terrain are projected through a pinhole camera and painted far to near.
Their colour comes from distance (the farther, the closer to the sky), stepped into a
few flat bands like a screen print; the sky is a halftone gradient. Needs the praha
caches from ipr_buildings.py and ipr_terrain.py (pipeline/.cache/ipr/parsed/).
"""

import argparse
import math
import pickle
import zlib
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer

import layers
from osm_area import AREAS

CACHE = Path(__file__).parent / ".cache" / "ipr" / "parsed"
OUT = Path(__file__).resolve().parent.parent / "assets" / "skylines"
AREA = "praha"
REF_HEIGHT = 180.0
STEP = 4.0

# eye: (lon, lat); height: metres above the ground there, or a.s.l. when over 100
# (for bridges above the river); at: (lon, lat) the camera faces; pitch: degrees up
# from level; fov: horizontal field of view in degrees (narrow flattens the city into
# a skyline); clear: buildings nearer than this are left out, so the camera can stand
# on a bridge or among trees.
VIEWS = {
    # From the middle of Charles Bridge to the castle.
    "hradcany": dict(eye=(14.4092, 50.08645), height=199, at=(14.4005, 50.0907), pitch=9, fov=34, clear=150),
    # From Letná's terrace over the river to the Old Town's towers.
    "stare-mesto": dict(eye=(14.4205, 50.0957), height=3, at=(14.4227, 50.0876), pitch=2, fov=24, clear=60),
    # From the top of Vítkov over Žižkov's roofs to the television tower.
    "zizkov": dict(eye=(14.4488, 50.0878), height=3, at=(14.4512, 50.0809), pitch=10, fov=40, clear=90),
    # Across the housing estate of Jižní Město from its central park.
    "jizni-mesto": dict(eye=(14.5205, 50.0265), height=3, at=(14.5330, 50.0300), pitch=6, fov=44, clear=60),
}

# Screen-print colours: sky light at the horizon, darker up high; buildings from near
# (black) to far (a red close to the sky's).
SKY_LOW, SKY_HIGH = (214, 44, 36), (122, 18, 20)
BANDS = [(18, 10, 10), (58, 14, 15), (104, 20, 22), (150, 30, 28)]
BAND_EDGES = [350, 900, 1800]  # metres


def local_proj():
    w, s, e, n = AREAS[AREA]
    return f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"


def tile_meta():
    meta = layers.read_meta(AREA)
    if not meta:
        raise SystemExit(f"{AREA}: run build_tiles.py {AREA} first")
    return meta["tile"], tuple(meta["origin"])


T, ORIGIN = tile_meta()


def load_buildings(key):
    """(n, 3, 3) triangles in local metres (x east, y north, z m a.s.l.) and the
    distance-sorting centre of the building each belongs to."""
    tris, centres = [], []
    for path in sorted(CACHE.glob(f"BD3_*_{key}.pkl")):
        with open(path, "rb") as f:
            got = pickle.load(f)
        for _, cx, cy, (i, j), pos, _, _ in got["buildings"]:
            if pos is None:
                continue
            p = pos.astype(np.float64).reshape(-1, 3) / 100
            x0, y0 = i * T - ORIGIN[0], j * T - ORIGIN[1]
            v = np.column_stack([p[:, 0] + x0, p[:, 2] + y0, p[:, 1] + REF_HEIGHT]).reshape(-1, 3, 3)
            tris.append(v)
            centres.append(np.repeat([[cx, cy]], len(v), axis=0))
    return np.concatenate(tris), np.concatenate(centres)


def load_terrain(key):
    """[(first lattice column, first row, heights)] per sheet, on the 4 m lattice."""
    grids = []
    for path in sorted(CACHE.glob(f"TER_*_{key}.pkl")):
        with open(path, "rb") as f:
            gi0, gj0, sub, *_ = pickle.load(f)["grid"]
        grids.append((gi0, gj0, sub))
    return grids


def ground_at(grids, x, y):
    gi, gj = (x + ORIGIN[0]) / STEP, (y + ORIGIN[1]) / STEP
    for gi0, gj0, sub in grids:
        a, b = int(round(gi - gi0)), int(round(gj - gj0))
        if 0 <= b < sub.shape[0] and 0 <= a < sub.shape[1] and not np.isnan(sub[b, a]):
            return float(sub[b, a])
    raise SystemExit(f"no terrain at {x:.0f}, {y:.0f}")


def terrain_tris(grids, cam, reach, every=3):
    """Terrain as triangles within reach of the camera, every n-th lattice point."""
    out = []
    ex, ey = cam["eye"][:2]
    for gi0, gj0, sub in grids:
        h = sub[::every, ::every]
        ny, nx = h.shape
        xs = (gi0 + np.arange(nx) * every) * STEP - ORIGIN[0]
        ys = (gj0 + np.arange(ny) * every) * STEP - ORIGIN[1]
        if xs[-1] < ex - reach or xs[0] > ex + reach or ys[-1] < ey - reach or ys[0] > ey + reach:
            continue
        X, Y = np.meshgrid(xs, ys)
        V = np.stack([X, Y, h], axis=-1)
        a, b, c, d = V[:-1, :-1], V[:-1, 1:], V[1:, :-1], V[1:, 1:]
        quads = np.stack([np.stack([a, b, d], -2), np.stack([a, d, c], -2)]).reshape(-1, 3, 3)
        keep = ~np.isnan(quads[:, :, 2]).any(1)
        q = quads[keep]
        cx, cy = q[:, :, 0].mean(1), q[:, :, 1].mean(1)
        out.append(q[np.hypot(cx - ex, cy - ey) < reach])
    return np.concatenate(out)


def camera(view, grids, to_local, width, height):
    ex, ey = to_local.transform(*view["eye"])
    tx, ty = to_local.transform(*view["at"])
    h = view["height"]
    eye = np.array([ex, ey, h if h > 100 else ground_at(grids, ex, ey) + h])
    heading = math.atan2(ty - ey, tx - ex)
    pitch = math.radians(view["pitch"])
    f = np.array([math.cos(heading) * math.cos(pitch), math.sin(heading) * math.cos(pitch), math.sin(pitch)])
    r = np.cross(f, [0, 0, 1.0])
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    focal = width / 2 / math.tan(math.radians(view["fov"]) / 2)
    # Where level lines of sight meet the picture.
    horizon = height / 2 + math.tan(pitch) * focal
    return {"eye": eye, "f": f, "r": r, "u": u, "focal": focal, "w": width, "h": height, "horizon": horizon}


def project(cam, tris):
    """Screen x, y and depth of every vertex; triangles behind or off screen dropped."""
    d = tris - cam["eye"]
    z = d @ cam["f"]
    sx = cam["w"] / 2 + (d @ cam["r"]) / np.maximum(z, 1e-3) * cam["focal"]
    sy = cam["h"] / 2 - (d @ cam["u"]) / np.maximum(z, 1e-3) * cam["focal"]
    keep = (z > 2).all(1)
    keep &= ~((sx < 0).all(1) | (sx > cam["w"]).all(1) | (sy < 0).all(1) | (sy > cam["h"]).all(1))
    return keep, sx, sy, z


def band(dist):
    return np.searchsorted(BAND_EDGES, dist)


def halftone_sky(width, height, horizon, cell):
    """Red sky: a gradient drawn as a dot screen at 45 degrees, darker dots growing
    towards the top."""
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    t = np.clip(1 - yy / max(horizon, 1), 0, 1)  # 0 at the horizon, 1 at the top
    u, v = (xx + yy) / math.sqrt(2) / cell, (xx - yy) / math.sqrt(2) / cell
    du, dv = u - np.round(u), v - np.round(v)
    r = np.sqrt(du * du + dv * dv)
    dot = r < 0.62 * np.sqrt(t)  # dot area follows the tone
    low, high = np.array(SKY_LOW, np.float32), np.array(SKY_HIGH, np.float32)
    img = np.where(dot[..., None], high, low)
    return Image.fromarray(img.astype(np.uint8))


def render(name, view, buildings, centres, grids, to_local, width, height, ss, reach):
    W, H = width * ss, height * ss
    cam = camera(view, grids, to_local, W, H)
    ground = terrain_tris(grids, cam, reach)
    ex, ey = cam["eye"][:2]
    d = np.hypot(centres[:, 0] - ex, centres[:, 1] - ey)
    near = (d < reach) & (d > view["clear"])
    tris = np.concatenate([buildings[near], ground])
    # Buildings take their colour from their centre, so each one is a single flat shape;
    # the ground from each triangle's own distance.
    dist = np.concatenate([np.hypot(centres[near, 0] - ex, centres[near, 1] - ey),
                           np.hypot(ground[:, :, 0].mean(1) - ex, ground[:, :, 1].mean(1) - ey)])
    keep, sx, sy, z = project(cam, tris)
    order = np.argsort(-z.mean(1)[keep])
    sx, sy, dist = sx[keep][order], sy[keep][order], dist[keep][order]
    print(f"{name}: {keep.sum():,} triangles, eye {cam['eye'][2]:.0f} m a.s.l.")

    horizon = cam["horizon"]
    img = halftone_sky(W, H, horizon, cell=7 * ss)
    draw = ImageDraw.Draw(img)
    # The ground right under the camera, which is too near to draw as triangles.
    draw.rectangle([0, max(horizon, 0), W, H], fill=BANDS[0])
    colours = [BANDS[b] for b in band(dist)]
    for k in range(len(sx)):
        draw.polygon([(sx[k, 0], sy[k, 0]), (sx[k, 1], sy[k, 1]), (sx[k, 2], sy[k, 2])], fill=colours[k])
    return img.resize((width, height), Image.LANCZOS)


def main() -> None:
    ap = argparse.ArgumentParser(description="Skyline silhouettes of Prague views")
    ap.add_argument("views", nargs="*", help=f"views to draw: {', '.join(VIEWS)}")
    ap.add_argument("--all", action="store_true", help="draw every view")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--ss", type=int, default=2, help="supersampling")
    ap.add_argument("--reach", type=float, default=6000, help="metres drawn from the eye")
    args = ap.parse_args()
    names = list(VIEWS) if args.all else args.views
    if not names or set(names) - set(VIEWS):
        ap.error(f"name a view ({', '.join(VIEWS)}) or pass --all")
    width, height = map(int, args.size.split("x"))
    local = local_proj()
    key = f"{zlib.crc32(local.encode()):08x}"
    to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    grids = load_terrain(key)
    buildings, centres = load_buildings(key)
    args.out.mkdir(parents=True, exist_ok=True)
    for name in names:
        img = render(name, VIEWS[name], buildings, centres, grids, to_local, width, height, args.ss, args.reach)
        img.save(args.out / f"{name}.png")


if __name__ == "__main__":
    main()
