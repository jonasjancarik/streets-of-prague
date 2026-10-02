"""Surveyed heights for the terrain, from the digital technical map (DTM kraje, ZPS).

IPR's terrain model (ipr_terrain.py) has a point about every 10 m, so a quay wall, a
retaining wall or the edge of a cutting comes out as a broad ramp. The technical map
was surveyed on the ground: the lines of set 3 (kerbs and other edges of streets,
walls, buildings, steps, terrain edges) carry a height at every vertex, and the
polygons of set 2 say which surface each line bounds. apply() uses them to correct
the terrain's lattice:

- a lattice point on a surveyed street surface (carriageway, pavement, parking, tram
  track, platform…) takes its height from the surveyed points along that surface's own
  edge, so the street above a wall never mixes with the quay below it;
- a lattice point on water takes the water's level: the lowest terrain within WATER_REACH
  on the water, which is the river's surface clear of the banks' ramps.

Everything else keeps the terrain model's height. PROTOTYPE: tried on `ujezd` (Masarykovo
nábřeží); reads the packages for the area's bounding box only and works on one array for
the whole area, which wouldn't do for `praha` as it is.

Source: DTM kraje – ZPS, datový podklad © IPR Praha (CC BY 4.0).
"""

import pickle
import sqlite3
import struct
import tempfile
import zipfile

import numpy as np
import shapely
from pyproj import Transformer
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely import STRtree

import build_cache
from dtm import CACHE, PACKAGES, _wkb

LINES = CACHE / "ZPS_KR"
# Surfaces whose height the survey gives along their edges, by the DTM's object code.
SURFACES = {
    "010000000503": "road", "010000032003": "roadside", "010000000703": "pavement",
    "010000000903": "cycleway", "010000001103": "parking", "010000001303": "island",
    "010000001503": "median", "010000001703": "ramp", "010000002403": "tram",
    "010000005303": "platform", "010000005503": "handling",
}
# Lines measured on the surface they bound. Walls, buildings and railings are left out:
# theirs may be the height of the wall's crown or of something standing on the ground.
ON_GROUND = {"010000030402": "kerb", "010000032302": "inner"}
VERSION = 1
SPACING = 1.5  # m between the points taken along a surveyed line
ON_EDGE = 0.15  # m: a surveyed point this close to a surface's edge belongs to it
FEW = 3  # a surface with fewer surveyed points than this keeps the terrain model's heights
WATER_REACH = 16.0  # m: further than the terrain model's ramp at a bank reaches


def _tables(package, codes):
    """(code, level, WKB) of each object of the wanted kinds in a package."""
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(package) as z:
        name = next(n for n in z.namelist() if n.endswith(".gpkg"))
        db = sqlite3.connect(z.extract(name, tmp))
        for (table,) in db.execute("select table_name from gpkg_contents").fetchall():
            code = table.split("#")[-1][:12]
            if code not in codes:
                continue
            cols = {r[1] for r in db.execute(f'pragma table_info("{table}")')}
            level = "UrovenUmisteniObjektuZPS" if "UrovenUmisteniObjektuZPS" in cols else "0"
            for blob, lv in db.execute(f'select shape, {level} from "{table}" where shape is not null'):
                yield code, int(lv or 0), blob
        db.close()


def _inside(blob, box):
    """The geometry in a GeoPackage blob if it reaches into a box, else None. Read from
    the blob's envelope where it has one, without parsing the geometry."""
    if (blob[3] >> 1) & 7:
        x0, x1, y0, y1 = struct.unpack("<4d", blob[8:40])
        if x1 < box[0] or x0 > box[2] or y1 < box[1] or y0 > box[3]:
            return None
    g = shapely.from_wkb(_wkb(blob))
    if g is None or g.is_empty:
        return None
    x0, y0, x1, y1 = g.bounds
    return g if x1 >= box[0] and x0 <= box[2] and y1 >= box[1] and y0 <= box[3] else None


def survey(area, bbox, margin=60.0):
    """The survey on the ground within a WGS84 box, in S-JTSK: (surface polygons,
    points along the lines measured on the ground as an (n, 3) array). Kept per area."""
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    w, s, e, n = bbox
    cx, cy = to_krovak.transform([w, w, e, e], [s, n, s, n])
    box = (min(cx) - margin, min(cy) - margin, max(cx) + margin, max(cy) + margin)
    packages = sorted(PACKAGES.glob("*.zip")) + sorted(LINES.glob("*.zip"))
    cache = CACHE / "heights" / f"{area}.pkl"
    key = [VERSION, [build_cache.identity(p) for p in packages], list(bbox), SURFACES, ON_GROUND, SPACING,
           [build_cache.function_key(f) for f in (survey, _tables, _inside, _along)], build_cache.runtime_key()]
    got = build_cache.load_pickle(cache, key)
    if got:
        return got["polys"], got["points"]
    print(f"dtm heights: reading the survey from {len(packages)} packages", flush=True)
    polys, points = [], []
    for p in sorted(PACKAGES.glob("*.zip")):
        for _, level, blob in _tables(p, SURFACES):
            g = _inside(blob, box) if level == 0 else None
            if g is not None:
                polys.append(shapely.force_2d(g))
    for p in sorted(LINES.glob("*.zip")):
        for _, level, blob in _tables(p, ON_GROUND):
            g = _inside(blob, box) if level == 0 else None
            if g is not None:
                c = shapely.get_coordinates(g, include_z=True)
                if len(c) > 1 and not np.isnan(c[:, 2]).any():
                    points.append(_along(c))
    points = np.concatenate(points) if points else np.zeros((0, 3))
    cache.parent.mkdir(parents=True, exist_ok=True)
    build_cache.atomic(cache, pickle.dumps({"key": key, "polys": polys, "points": points}, protocol=5))
    return polys, points


def _along(c):
    """A surveyed line's vertices and points every SPACING metres between them."""
    out = [c[:1]]
    for a, b in zip(c[:-1], c[1:]):
        k = max(1, int(np.ceil(np.hypot(*(b - a)[:2]) / SPACING)))
        out.append(a + (b - a) * (np.arange(1, k + 1) / k)[:, None])
    return np.concatenate(out)


def apply(area, bbox, to_local, tiles, N, step, gx0, gy0, water):
    """Correct the tiles' lattices in place (see the top of the file). `tiles`: {(i, j):
    (N + 1) x (N + 1) heights}, the lattice of tile (i, j) starting at point (i * N, j * N);
    `water`: the water's polygons in local metres. Returns what it changed, for the log."""
    polys, points = survey(area, bbox)
    if not len(points):
        return {"surfaces": 0, "street_points": 0, "water_points": 0}
    px, py = to_local.transform(points[:, 0], points[:, 1])
    pts = np.column_stack([px, py])
    polys = shapely.transform(np.array(polys, dtype=object), lambda c: np.column_stack(to_local.transform(c[:, 0], c[:, 1])))

    # One array over the area; neighbouring tiles share their edge points.
    i0, j0 = min(k[0] for k in tiles) * N, min(k[1] for k in tiles) * N
    i1, j1 = max(k[0] for k in tiles) * N + N, max(k[1] for k in tiles) * N + N
    grid = np.full((j1 - j0 + 1, i1 - i0 + 1), np.nan, dtype=np.float32)
    for (i, j), arr in tiles.items():
        grid[j * N - j0:j * N - j0 + N + 1, i * N - i0:i * N - i0 + N + 1] = arr
    bare = grid.copy()
    x_of = lambda i: gx0 + (i + i0) * step  # noqa: E731
    y_of = lambda j: gy0 + (j + j0) * step  # noqa: E731

    # Streets: each surface from the surveyed points along its own edge.
    edges = STRtree(shapely.boundary(polys))
    owner, point = edges.query(shapely.points(pts), predicate="dwithin", distance=ON_EDGE)[::-1]
    order = np.argsort(owner, kind="stable")
    owner, point = owner[order], point[order]
    starts = np.flatnonzero(np.r_[True, owner[1:] != owner[:-1]])
    surfaces = street_points = 0
    for a, b in zip(starts, np.r_[starts[1:], len(owner)]):
        if b - a < FEW:
            continue
        poly = polys[owner[a]]
        bx0, by0, bx1, by1 = poly.bounds
        ia, ib = max(0, int(np.ceil((bx0 - x_of(0)) / step))), min(grid.shape[1] - 1, int(np.floor((bx1 - x_of(0)) / step)))
        ja, jb = max(0, int(np.ceil((by0 - y_of(0)) / step))), min(grid.shape[0] - 1, int(np.floor((by1 - y_of(0)) / step)))
        if ia > ib or ja > jb:
            continue
        gi, gj = np.meshgrid(np.arange(ia, ib + 1), np.arange(ja, jb + 1))
        gi, gj = gi.ravel(), gj.ravel()
        on = shapely.contains_xy(poly, x_of(gi), y_of(gj)) & ~np.isnan(grid[gj, gi])
        if not on.any():
            continue
        gi, gj, own = gi[on], gj[on], point[a:b]
        k = min(6, len(own))
        d, near = cKDTree(pts[own]).query(np.column_stack([x_of(gi), y_of(gj)]), k=k)
        d, near = d.reshape(len(gi), k), near.reshape(len(gi), k)
        wgt = 1.0 / (d * d + 0.25)
        grid[gj, gi] = (wgt * points[own, 2][near]).sum(axis=1) / wgt.sum(axis=1)
        surfaces += 1
        street_points += len(gi)

    # Water: the lowest bare terrain on the water round each point.
    wet = np.zeros(grid.shape, dtype=bool)
    if water is not None and not water.is_empty:
        bx0, by0, bx1, by1 = water.bounds
        ia, ib = max(0, int(np.floor((bx0 - x_of(0)) / step))), min(grid.shape[1] - 1, int(np.ceil((bx1 - x_of(0)) / step)))
        ja, jb = max(0, int(np.floor((by0 - y_of(0)) / step))), min(grid.shape[0] - 1, int(np.ceil((by1 - y_of(0)) / step)))
        gi, gj = np.meshgrid(np.arange(ia, ib + 1), np.arange(ja, jb + 1))
        shapely.prepare(water)
        wet[ja:jb + 1, ia:ib + 1] = shapely.contains_xy(water, x_of(gi), y_of(gj))
        wet &= ~np.isnan(bare)
        r = int(np.ceil(WATER_REACH / step))
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        level = ndimage.minimum_filter(np.where(wet, bare, np.inf), footprint=xx * xx + yy * yy <= r * r, mode="constant", cval=np.inf)
        grid[wet] = level[wet]

    for (i, j), arr in tiles.items():
        arr[:] = grid[j * N - j0:j * N - j0 + N + 1, i * N - i0:i * N - i0 + N + 1]
    changed = ~np.isnan(bare) & (np.abs(grid - bare) > 0.05)
    return {"surfaces": surfaces, "street_points": street_points, "water_points": int(wet.sum()),
            "changed": int(changed.sum()), "mean_change": float(np.abs(grid - bare)[changed].mean()) if changed.any() else 0.0,
            "wet": {k: wet[k[1] * N - j0:k[1] * N - j0 + N + 1, k[0] * N - i0:k[0] * N - i0 + N + 1] for k in tiles}}
