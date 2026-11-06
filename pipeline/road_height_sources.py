"""Compare the height sources a road surface could be fitted to, along a few streets.

    uv run --project pipeline --with matplotlib python pipeline/road_height_sources.py \
        --out docs/evidence/road-sources [--sites italska,husitska]

Sources: the game's terrain lattice (what the map has now), the surveyed kerb lines
(DTM ZPS), IPR's 1 m LiDAR terrain raster, IPR's 1 m surface model (DSM) and IPR's
photorealistic mesh (finest level, rasterised from above at 0.25 m).

For each site it follows the named street ±LENGTH m from the site and samples every
source on a grid along it (0.5 m) and across it (0.25 m). It writes, per site, a
figure (hillshades, cross-sections, long profiles against the survey) and the
numbers, and a summary over all sites. Needs a built Prague map in public/data and
the pipeline caches (survey snapshot, LiDAR import, DSM, photomesh; missing mesh
pieces are downloaded).
"""
import argparse
import gzip
import json
import math
import pickle
import sys
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from pyproj.enums import TransformDirection
from scipy import ndimage
from scipy.interpolate import BSpline
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import ipr_lidar  # noqa: E402
import photomesh  # noqa: E402
from ipr_buildings import krovak_to_local  # noqa: E402
from osm_area import AREAS  # noqa: E402

DATA = ROOT / "public" / "data" / "praha_now"
SURVEY = HERE / ".cache" / "dtm" / "heights" / "praha.pkl"
LIDAR = HERE / ".cache" / "ipr_lidar" / "2023"
DSM = HERE / ".cache" / "cover" / "dsm_ipr" / "DSM_1m.tif"

# name: (lat, lon) or None for the street's label point in names.json, street name, what it tests
SITES = {
    "italska": ((50.08243, 14.43964), "Italská", "hillside street with surveyed kerbs"),
    "dobrovolskeho": ((50.03516, 14.50886), "Dobrovolského", "long waves along an ordinary street"),
    "husitska": ((50.08678, 14.43900), "Husitská", "lower road beside a bank and elevated ramps"),
    "karmelitska": ((50.0868, 14.4037), "Karmelitská", "setts and tram tracks in a narrow street"),
    "pod_kastany": (None, "Pod Kaštany", "street under chestnut trees"),
    "evropska": (None, "Evropská", "wide arterial"),
    "kongresova": ((50.06130, 14.43124), "5. května", "deck over a cutting (Kongresová below)"),
    "nuselsky_most": (None, "Nuselský most", "bridge deck high above a valley"),
}
LENGTH = 60.0  # m either side of the site along the street
ALONG, ACROSS, PIXEL = 0.5, 0.25, 0.25  # m: sample spacing along and across, mesh raster
MESH_LEVEL = 16
COLOURS = {"game": "#e07b00", "lidar": "#1f6fd1", "dsm": "#7a7a7a", "mesh": "#2a9d3c"}
LABELS = {"game": "game lattice (now)", "lidar": "LiDAR terrain 1 m", "dsm": "surface model 1 m", "mesh": "photomesh"}


def read(path: Path) -> bytes:
    gz = path.with_name(path.name + ".gz")
    raw = gz.read_bytes() if gz.exists() else path.read_bytes()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


class Map:
    """The assembled map's tiles: drive edges, road outlines and the terrain lattice."""

    def __init__(self):
        w, s, e, n = AREAS["praha"]
        self.local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
        index = json.loads((DATA / "index.json").read_text())
        self.T, (self.ox, self.oy) = index["tile"], index["origin"]
        self.n, self.step = index["terrain"]["n"], index["terrain"]["step"]
        self.names = json.loads((DATA / "names.json").read_text())
        self._tiles, self._lattice = {}, {}

    def tile_of(self, x, y):
        return int((x + self.ox) // self.T), int((y + self.oy) // self.T)

    def tile(self, i, j):
        if (i, j) not in self._tiles:
            f = DATA / "tiles" / f"{i}_{j}.json"
            self._tiles[(i, j)] = json.loads(read(f)) if f.exists() or f.with_name(f.name + ".gz").exists() else None
        return self._tiles[(i, j)]

    def tiles_around(self, x, y, reach=1):
        i, j = self.tile_of(x, y)
        return [t for di in range(-reach, reach + 1) for dj in range(-reach, reach + 1)
                if (t := self.tile(i + di, j + dj)) is not None]

    def lattice(self, i, j):
        """(ground heights, [top deck heights or None]) on the tile's lattice, rows from the south."""
        if (i, j) not in self._lattice:
            n = self.n
            f = DATA / "tiles" / f"{i}_{j}.height.bin"
            if not (f.exists() or f.with_name(f.name + ".gz").exists()):
                self._lattice[(i, j)] = None
                return None
            raw = read(f)
            ground = np.frombuffer(raw[:n * n * 2], "<u2").reshape(n, n) / 10 + 100
            deck = None
            t = self.tile(i, j)
            lv = DATA / "tiles" / f"{i}_{j}.levels.bin"
            if t and t.get("structures") and (lv.exists() or lv.with_name(lv.name + ".gz").exists()):
                levels = np.frombuffer(read(lv), "<u2").reshape(len(t["structures"]), n, n) / 100 + 100
                levels = np.where(levels <= 100.001, np.nan, levels)
                up = [k for k, st in enumerate(t["structures"]) if st["level"] > 0]
                if up:
                    deck = np.nanmax(levels[up], axis=0) if len(up) > 1 else levels[up[0]]
            self._lattice[(i, j)] = (ground, deck)
        return self._lattice[(i, j)]

    def heights(self, xs, ys, top=False):
        """Bilinear between lattice points as the game reads them. With `top`, the highest
        bridge deck where one covers all four corners, else the ground."""
        xs, ys = np.asarray(xs, float).ravel(), np.asarray(ys, float).ravel()
        out = np.full(xs.shape, np.nan)
        ti = np.floor((xs + self.ox) / self.T).astype(int)
        tj = np.floor((ys + self.oy) / self.T).astype(int)
        for i, j in set(zip(ti.tolist(), tj.tolist())):
            got = self.lattice(i, j)
            if got is None:
                continue
            ground, deck = got
            sel = (ti == i) & (tj == j)
            a = np.clip((xs[sel] + self.ox - i * self.T) / self.step, 0, self.n - 1.001)
            b = np.clip((ys[sel] + self.oy - j * self.T) / self.step, 0, self.n - 1.001)
            ia, ib = a.astype(int), b.astype(int)
            fa, fb = a - ia, b - ib

            def bil(g):
                return ((1 - fa) * (1 - fb) * g[ib, ia] + fa * (1 - fb) * g[ib, ia + 1]
                        + (1 - fa) * fb * g[ib + 1, ia] + fa * fb * g[ib + 1, ia + 1])
            h = bil(ground)
            if top and deck is not None:
                d = bil(deck)
                h = np.where(np.isfinite(d), np.fmax(h, d), h)
            out[sel] = h
        return out


def dsm_sampler(to_krovak):
    """IPR's 1 m DSM, bilinear; the GeoTIFF is uncompressed in square blocks."""
    import tifffile
    with tifffile.TiffFile(DSM) as tf:
        page = tf.pages[0]
        H, W = page.shape
        th, tw, offsets = page.tilelength, page.tilewidth, page.dataoffsets
    f = open(DSM, "rb")

    def at(xs, ys):
        xs, ys = np.asarray(xs, float), np.asarray(ys, float)
        E, N = to_krovak(xs.ravel(), ys.ravel())
        cols, rows = np.asarray(E) + 757499.5, -1034000.5 - np.asarray(N)
        c0, c1 = max(int(cols.min()) - 2, 0), min(int(cols.max()) + 3, W)
        r0, r1 = max(int(rows.min()) - 2, 0), min(int(rows.max()) + 3, H)
        win = np.full((r1 - r0, c1 - c0), np.nan, np.float32)
        per_row = -(-W // tw)
        for ty in range(r0 // th, (r1 - 1) // th + 1):
            for tx in range(c0 // tw, (c1 - 1) // tw + 1):
                f.seek(offsets[ty * per_row + tx])
                block = np.frombuffer(f.read(th * tw * 4), "<f4").reshape(th, tw)
                y0, x0 = ty * th, tx * tw
                a0, a1, b0, b1 = max(y0, r0), min(y0 + th, r1), max(x0, c0), min(x0 + tw, c1)
                win[a0 - r0:a1 - r0, b0 - c0:b1 - c0] = block[a0 - y0:a1 - y0, b0 - x0:b1 - x0]
        win[~(win > -1000)] = np.nan
        out = ndimage.map_coordinates(np.nan_to_num(win, nan=-9999), [rows - r0, cols - c0], order=1, mode="nearest")
        return np.where(out < 0, np.nan, out).reshape(xs.shape)
    return at


def rasterise_top(tris, x0, y0, nx, ny, res, small=4):
    """Highest and lowest mesh surface at cell centres x0 + i*res, y0 + j*res (NaN where none)."""
    top = np.full((ny, nx), -np.inf)
    bottom = np.full((ny, nx), np.inf)
    X, Y, Z = tris[:, :, 0], tris[:, :, 1], tris[:, :, 2]
    i0 = np.ceil((X.min(1) - x0) / res).astype(int)
    i1 = np.floor((X.max(1) - x0) / res).astype(int)
    j0 = np.ceil((Y.min(1) - y0) / res).astype(int)
    j1 = np.floor((Y.max(1) - y0) / res).astype(int)
    d = (Y[:, 1] - Y[:, 2]) * (X[:, 0] - X[:, 2]) + (X[:, 2] - X[:, 1]) * (Y[:, 0] - Y[:, 2])
    keep = (i1 >= i0) & (j1 >= j0) & (i1 >= 0) & (j1 >= 0) & (i0 < nx) & (j0 < ny) & (np.abs(d) > 1e-12)

    def fill(sel, gi, gj):
        gx, gy = x0 + gi * res, y0 + gj * res
        ax, bx, cx = X[sel, 0], X[sel, 1], X[sel, 2]
        ay, by, cy = Y[sel, 0], Y[sel, 1], Y[sel, 2]
        dd = d[sel]
        l1 = ((by - cy) * (gx - cx) + (cx - bx) * (gy - cy)) / dd
        l2 = ((cy - ay) * (gx - cx) + (ax - cx) * (gy - cy)) / dd
        l3 = 1 - l1 - l2
        ok = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6) & (gi >= 0) & (gi < nx) & (gj >= 0) & (gj < ny)
        z = l1 * Z[sel, 0] + l2 * Z[sel, 1] + l3 * Z[sel, 2]
        np.maximum.at(top, (gj[ok], gi[ok]), z[ok])
        np.minimum.at(bottom, (gj[ok], gi[ok]), z[ok])

    w, h = i1 - i0 + 1, j1 - j0 + 1
    little = keep & (w <= small) & (h <= small)
    for di in range(small):
        for dj in range(small):
            sel = np.flatnonzero(little & (w > di) & (h > dj))
            fill(sel, i0[sel] + di, j0[sel] + dj)
    for k in np.flatnonzero(keep & ~little):
        gi, gj = np.meshgrid(np.arange(max(i0[k], 0), min(i1[k], nx - 1) + 1), np.arange(max(j0[k], 0), min(j1[k], ny - 1) + 1))
        fill(np.full(gi.size, k), gi.ravel(), gj.ravel())
    top[~np.isfinite(top)] = np.nan
    bottom[~np.isfinite(bottom)] = np.nan
    return top, bottom


def mesh_raster(m: Map, box, res=PIXEL):
    """The photomesh over a local box, from above: (x0, y0, top, bottom, vertices per m²)."""
    x0, y0, x1, y1 = box
    to3857 = Transformer.from_crs(m.local, "EPSG:3857", always_xy=True)
    back = Transformer.from_crs("EPSG:3857", m.local, always_xy=True)
    xs, ys = to3857.transform([x0, x1, x0, x1], [y0, y0, y1, y1])
    nodes = photomesh.nodes_over((min(xs), min(ys), max(xs), max(ys)), MESH_LEVEL)
    photomesh.fetch_all([f"nodes/{n['id']}/geometries/0" for n in nodes])
    parts, levels = [], set()
    for n in nodes:
        pos, _ = photomesh.triangles(n)
        lx, ly = back.transform(pos[:, 0], pos[:, 1])
        parts.append(np.column_stack([lx, ly, pos[:, 2]]))
        levels.add(n.get("level"))
    pts = np.concatenate(parts)
    tris = pts.reshape(-1, 3, 3)
    inside = ((tris[:, :, 0].max(1) >= x0) & (tris[:, :, 0].min(1) <= x1)
              & (tris[:, :, 1].max(1) >= y0) & (tris[:, :, 1].min(1) <= y1))
    tris = tris[inside]
    nx, ny = int((x1 - x0) / res) + 1, int((y1 - y0) / res) + 1
    top, bottom = rasterise_top(tris, x0, y0, nx, ny, res)
    flat = tris.reshape(-1, 3)
    within = (flat[:, 0] >= x0) & (flat[:, 0] <= x1) & (flat[:, 1] >= y0) & (flat[:, 1] <= y1)
    density = np.unique(np.round(flat[within, :2], 3), axis=0).shape[0] / ((x1 - x0) * (y1 - y0))
    return x0, y0, top, bottom, density, sorted(levels)


def raster_at(x0, y0, grid, res, xs, ys):
    u, v = (np.asarray(xs) - x0) / res, (np.asarray(ys) - y0) / res
    filled = np.nan_to_num(grid, nan=-9999)
    out = ndimage.map_coordinates(filled, [v.ravel(), u.ravel()], order=1, mode="nearest").reshape(np.shape(xs))
    return np.where(out < 0, np.nan, out)


def chain(m: Map, site_xy, name):
    """The street's centreline through the site: its drive edges joined end to end."""
    x, y = site_xy
    edges = {}
    for t in m.tiles_around(x, y, reach=2):
        for d in t["drive"]:
            if d.get("name") == name:
                edges[d["id"]] = d
    if not edges:
        raise SystemExit(f"no drive edge named {name} near {site_xy}")

    def dist(d):
        p = shapely.LineString(d["pts"])
        return p.distance(shapely.Point(x, y))
    seed = min(edges.values(), key=dist)
    by_u, by_v = {}, {}
    for d in edges.values():
        by_u.setdefault(d["u"], []).append(d)
        by_v.setdefault(d["v"], []).append(d)

    def heading(a, b):
        return math.atan2(b[1] - a[1], b[0] - a[0])

    def turn(h0, h1):
        return abs((h1 - h0 + math.pi) % (2 * math.pi) - math.pi)

    pts = [tuple(p) for p in seed["pts"]]
    used = {seed["id"]}
    for forward in (True, False):
        cur = seed
        while True:
            length = shapely.LineString(pts).length
            if length > 4 * LENGTH:
                break
            if forward:
                h0 = heading(pts[-2], pts[-1])
                nxt = [d for d in by_u.get(cur["v"], []) if d["id"] not in used and d["v"] != cur["u"]]
                nxt = [(turn(h0, heading(d["pts"][0], d["pts"][1])), d) for d in nxt]
            else:
                h0 = heading(pts[0], pts[1])
                nxt = [d for d in by_v.get(cur["u"], []) if d["id"] not in used and d["u"] != cur["v"]]
                nxt = [(turn(h0, heading(d["pts"][-2], d["pts"][-1])), d) for d in nxt]
            nxt = [(a, d) for a, d in nxt if a < math.radians(50)]
            if not nxt:
                break
            _, cur = min(nxt, key=lambda ad: ad[0])
            used.add(cur["id"])
            if forward:
                pts += [tuple(p) for p in cur["pts"][1:]]
            else:
                pts = [tuple(p) for p in cur["pts"][:-1]] + pts
    line = shapely.LineString(pts)
    s0 = line.project(shapely.Point(x, y))
    info = {"edges": sorted(used), "width": seed.get("width"), "bridge": seed.get("bridge"), "level": seed.get("level"),
            "surface": seed.get("surface"), "hw": seed.get("hw")}
    return line, s0, info


def frame(line, s0, half_width):
    """Sample stations along the centreline and the (s, t) -> (x, y) grid."""
    a, b = max(0.0, s0 - LENGTH), min(line.length, s0 + LENGTH)
    S = np.arange(a, b + 1e-9, ALONG)
    P = np.array([line.interpolate(s).coords[0] for s in S])
    # Tangent smoothed over ±4 m so a kink in the edge doesn't fan the sections.
    span = 4.0
    ahead = np.array([line.interpolate(min(s + span, line.length)).coords[0] for s in S])
    behind = np.array([line.interpolate(max(s - span, 0)).coords[0] for s in S])
    tang = ahead - behind
    tang /= np.linalg.norm(tang, axis=1, keepdims=True)
    normal = np.column_stack([-tang[:, 1], tang[:, 0]])  # left of the direction of travel
    Tt = np.arange(-half_width, half_width + 1e-9, ACROSS)
    X = P[:, 0, None] + Tt[None, :] * normal[:, 0, None]
    Y = P[:, 1, None] + Tt[None, :] * normal[:, 1, None]
    return S - s0, Tt, X, Y, P, normal


def carriageway(m: Map, X, Y, Tt):
    """This street's carriageway on the grid: the run of road outline across each station
    that holds the centreline (or the nearest run to it)."""
    polys = []
    for t in m.tiles_around(float(X.mean()), float(Y.mean()), reach=2):
        for kind in ("road", "sett", "bridge"):
            for p in t["roads"].get(kind, []):
                rings = [shapely.LinearRing(r) for r in p if len(r) >= 3]
                if rings:
                    polys.append(shapely.Polygon(rings[0], rings[1:]))
    road = shapely.union_all(shapely.make_valid(polys)) if polys else shapely.Polygon()
    on = shapely.contains_xy(road, X, Y)
    run = np.zeros_like(on)
    mid = len(Tt) // 2
    for k in range(on.shape[0]):
        row = on[k]
        if not row.any():
            continue
        idx = np.flatnonzero(row)
        c = idx[np.argmin(np.abs(idx - mid))]
        if abs(c - mid) * ACROSS > 3:
            continue
        lo = c
        while lo > 0 and row[lo - 1]:
            lo -= 1
        hi = c
        while hi < len(row) - 1 and row[hi + 1]:
            hi += 1
        run[k, lo:hi + 1] = True
    return run, road


def survey_points(m: Map, box):
    """Surveyed ground lines (kerbs and others) in the box, as local (x, y, z), 0.5 m apart."""
    with open(SURVEY, "rb") as f:
        lines = pickle.load(f)["lines"]
    to_k = Transformer.from_crs(m.local, "EPSG:4326", always_xy=True)
    k_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                 area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))
    x0, y0, x1, y1 = box
    lon, lat = to_k.transform([x0, x1, x0, x1], [y0, y0, y1, y1])
    kx, ky = k_wgs.transform(lon, lat, direction=TransformDirection.INVERSE)
    kx0, kx1, ky0, ky1 = min(kx) - 5, max(kx) + 5, min(ky) - 5, max(ky) + 5
    keep = []
    for c in lines:
        if c[:, 0].max() < kx0 or c[:, 0].min() > kx1 or c[:, 1].max() < ky0 or c[:, 1].min() > ky1:
            continue
        out = [c[:1]]
        for a, b in zip(c[:-1], c[1:]):
            k = max(1, int(np.ceil(np.hypot(*(b - a)[:2]) / 0.5)))
            out.append(a + (b - a) * (np.arange(1, k + 1) / k)[:, None])
        keep.append(np.concatenate(out))
    if not keep:
        return np.zeros((0, 3))
    pts = np.concatenate(keep)
    lx, ly = krovak_to_local(m.local).transform(pts[:, 0], pts[:, 1])
    return np.column_stack([lx, ly, pts[:, 2]])


def to_st(P, normal, S, pts):
    """Station and offset of points against the sampled centreline (NaN off its ends)."""
    tree = cKDTree(P)
    _, k = tree.query(pts[:, :2])
    d = pts[:, :2] - P[k]
    t = d[:, 0] * normal[k, 0] + d[:, 1] * normal[k, 1]
    along = d[:, 0] * normal[k, 1] - d[:, 1] * normal[k, 0]
    s = S[k] + along
    ok = (np.abs(along) <= ALONG) & (k > 0) & (k < len(S) - 1)
    return np.where(ok, s, np.nan), t


def reference(s, t, z, S):
    """The survey's road: z = a(s) + b(s) t, a cubic in s with knots every 8 m, b every
    25 m, fitted robustly (Huber) to the kerb points. Returns a function of (s, t)."""
    def basis(x, spacing):
        lo, hi = S.min() - 1e-6, S.max() + 1e-6
        n = max(1, int(math.ceil((hi - lo) / spacing)))
        inner = np.linspace(lo, hi, n + 1)
        knots = np.r_[[lo] * 3, inner, [hi] * 3]
        return BSpline.design_matrix(np.clip(x, lo, hi), knots, 3).toarray()
    A = np.hstack([basis(s, 8.0), basis(s, 25.0) * t[:, None]])
    w = np.ones(len(z))
    for _ in range(8):
        sw = np.sqrt(w)
        coef, *_ = np.linalg.lstsq(A * sw[:, None], z * sw, rcond=None)
        r = z - A @ coef
        scale = max(1.4826 * np.median(np.abs(r)), 0.02)
        w = np.minimum(1, 1.5 * scale / np.maximum(np.abs(r), 1e-9))

    def at(ss, tt):
        ss, tt = np.asarray(ss, float), np.asarray(tt, float)
        flat = np.hstack([basis(ss.ravel(), 8.0), basis(ss.ravel(), 25.0) * tt.ravel()[:, None]])
        return (flat @ coef).reshape(ss.shape)
    return at, float(1.4826 * np.median(np.abs(r)))


def stats(values):
    v = np.asarray(values, float)
    v = v[np.isfinite(v)]
    if len(v) < 10:
        return None
    return {"n": int(len(v)), "median": float(np.median(v)), "p95": float(np.percentile(v, 95)), "max": float(v.max())}


def measure(H, run, interior, S, Tt, ref, lidar, game):
    """Numbers for one source on the carriageway's interior."""
    out = {}
    if H is not game:
        r = (H - game)[interior]
        r = r[np.isfinite(r)]
        if len(r) > 10:
            bias = float(np.median(r))
            out["vs_game"] = {"bias": bias, "spread": float(1.4826 * np.median(np.abs(r - bias)))}
    if H is not lidar:
        r = (H - lidar)[interior]
        r = r[np.isfinite(r)]
        if len(r) > 10:
            bias = float(np.median(r))
            out["vs_lidar"] = {"bias": bias, "spread": float(1.4826 * np.median(np.abs(r - bias))),
                               "above_30cm": float(np.mean(r - bias > 0.3))}
    lag = int(round(3.0 / ALONG))  # 6 m chord: |h(s) - mean(h(s-3), h(s+3))|
    a, b, c = H[:-2 * lag], H[lag:-lag], H[2 * lag:]
    ok = interior[:-2 * lag] & interior[lag:-lag] & interior[2 * lag:]
    out["wave6_along"] = stats(np.abs(b - (a + c) / 2)[ok])
    lagx = int(round(1.5 / ACROSS))  # 3 m chord across
    a, b, c = H[:, :-2 * lagx], H[:, lagx:-lagx], H[:, 2 * lagx:]
    ok = interior[:, :-2 * lagx] & interior[:, lagx:-lagx] & interior[:, 2 * lagx:]
    out["wave3_across"] = stats(np.abs(b - (a + c) / 2)[ok])
    if ref is not None:
        r = (H - ref)[interior]
        r = r[np.isfinite(r)]
        if len(r) > 10:
            bias = float(np.median(r))
            out["vs_survey_surface"] = {"bias": bias, "spread": float(1.4826 * np.median(np.abs(r - bias))),
                                        "p95": float(np.percentile(np.abs(r - bias), 95)),
                                        "above_50cm": float(np.mean(r - bias > 0.5))}
    return out


def hillshade(z, res, exaggerate=4.0, azimuth=315, altitude=35):
    gy, gx = np.gradient(np.nan_to_num(z, nan=np.nanmedian(z)) * exaggerate, res)
    slope = np.pi / 2 - np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(azimuth), np.radians(altitude)
    shade = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
    return np.where(np.isfinite(z), shade, np.nan)


def run_site(m: Map, key, samplers, out_dir: Path):
    place, name, what = SITES[key]
    if place is None:
        x, y = m.names[name]
    else:
        x, y = Transformer.from_crs("EPSG:4326", m.local, always_xy=True).transform(place[1], place[0])
    line, s0, info = chain(m, (x, y), name)
    half = max((info["width"] or 8) / 2 + 9, 12)
    S, Tt, X, Y, P, normal = frame(line, s0, half)
    run, road = carriageway(m, X, Y, Tt)
    interior = ndimage.binary_erosion(run, structure=np.ones((1, 2 * int(0.75 / ACROSS) + 1)))
    pad = 6
    box = (X.min() - pad, Y.min() - pad, X.max() + pad, Y.max() + pad)
    print(f"{key}: {name}, {len(info['edges'])} edges, {S[-1] - S[0]:.0f} m, half-width {half:.1f} m, "
          f"carriageway samples {int(run.sum())}", flush=True)

    mx0, my0, mtop, _, density, levels = mesh_raster(m, box)
    on_deck = bool(info["bridge"])
    H = {
        "game": m.heights(X, Y, top=on_deck).reshape(X.shape),
        "lidar": samplers["lidar"](X.ravel(), Y.ravel()).reshape(X.shape).astype(float),
        "dsm": samplers["dsm"](X, Y),
        "mesh": raster_at(mx0, my0, mtop, PIXEL, X, Y),
    }

    sv = survey_points(m, box)
    ss, st = to_st(P, normal, S + s0, sv) if len(sv) else (np.zeros(0), np.zeros(0))
    ss = ss - s0
    ss[np.abs(st) > half] = np.nan
    near_edge = np.zeros(len(sv), bool)
    edge_t = np.full(len(sv), np.nan)
    if len(sv):
        k = np.clip(np.round(np.nan_to_num(ss - S[0]) / ALONG).astype(int), 0, len(S) - 1)
        for idx in np.flatnonzero(np.isfinite(ss)):
            row = run[k[idx]]
            if not row.any():
                continue
            cols = np.flatnonzero(row)
            lo, hi = Tt[cols[0]], Tt[cols[-1]]
            if abs(st[idx] - lo) <= 1.0:
                near_edge[idx], edge_t[idx] = True, lo
            elif abs(st[idx] - hi) <= 1.0:
                near_edge[idx], edge_t[idx] = True, hi
    kerb = near_edge & (not on_deck)
    ref_fn, ref_scatter, ref = None, None, None
    if kerb.sum() >= 20 and (st[kerb] > 0).sum() >= 8 and (st[kerb] < 0).sum() >= 8:
        ref_fn, ref_scatter = reference(ss[kerb], st[kerb], sv[kerb, 2], S)
        SS, TT = np.meshgrid(S, Tt, indexing="ij")
        ref = ref_fn(SS, TT)
        # Only where both kerbs have surveyed points within 5 m: no extrapolation.
        for side in (st[kerb] > 0, st[kerb] < 0):
            have = np.zeros(len(S), bool)
            for v in ss[kerb][side]:
                have |= np.abs(S - v) <= 5
            ref[~have] = np.nan

    result = {"site": key, "street": name, "tests": what, **info, "length": float(S[-1] - S[0]),
              "mesh_levels": levels, "mesh_vertices_per_m2": round(density, 2),
              "kerb_points": int(kerb.sum()), "survey_fit_scatter": ref_scatter, "sources": {}}
    for src, h in H.items():
        r = measure(h, run, interior, S, Tt, ref, H["lidar"], H["game"])
        if kerb.any() and not on_deck:
            # At each kerb point, the source half a metre inside the carriageway.
            inward = np.sign(-edge_t[kerb])
            kk = np.clip(np.round((ss[kerb] - S[0]) / ALONG).astype(int), 0, len(S) - 1)
            tt_in = st[kerb] + 0.5 * inward
            qx = P[kk, 0] + tt_in * normal[kk, 0]
            qy = P[kk, 1] + tt_in * normal[kk, 1]
            if src == "game":
                hv = m.heights(qx, qy, top=on_deck)
            elif src == "lidar":
                hv = samplers["lidar"](qx, qy).astype(float)
            elif src == "dsm":
                hv = samplers["dsm"](qx, qy)
            else:
                hv = raster_at(mx0, my0, mtop, PIXEL, qx, qy)
            d = hv - sv[kerb, 2]
            d = d[np.isfinite(d)]
            if len(d) > 10:
                bias = float(np.median(d))
                r["vs_kerbs"] = {"n": int(len(d)), "bias": bias, "spread": float(1.4826 * np.median(np.abs(d - bias))),
                                 "p95": float(np.percentile(np.abs(d - bias), 95))}
        result["sources"][src] = r
    (out_dir / f"{key}.json").write_text(json.dumps(result, indent=1, ensure_ascii=False))
    draw(key, name, what, S, Tt, X, Y, H, run, ref, ss, st, sv, kerb, road, box, (mx0, my0, mtop), m, samplers,
         on_deck, result, out_dir)
    j = int(np.argmin(np.abs(Tt + 1.8)))
    if ref is not None and np.isfinite(ref[:, j]).sum() > 20:
        base, what_base = ref[:, j], "surveyed kerbs"
    else:
        med = np.nanmedian(np.vstack([h[:, j] for h in H.values()]), axis=0)
        good = np.isfinite(med) & run[:, j]
        base = np.polyval(np.polyfit(S[good], med[good], 2), S) if good.sum() > 10 else np.full_like(S, np.nan)
        what_base = "smooth curve through all sources"
    profile = {src: np.where(run[:, j], h[:, j] - base, np.nan) for src, h in H.items()}
    return result, (S, profile, what_base)


def draw(key, name, what, S, Tt, X, Y, H, run, ref, ss, st, sv, kerb, road, box, mesh, m, samplers, on_deck,
         result, out_dir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    res = 0.5
    x0, y0, x1, y1 = box
    gx, gy = np.meshgrid(np.arange(x0, x1, res), np.arange(y0, y1, res))
    tops = {
        "game": m.heights(gx, gy, top=on_deck).reshape(gx.shape),
        "lidar": samplers["lidar"](gx.ravel(), gy.ravel()).reshape(gx.shape).astype(float),
        "dsm": samplers["dsm"](gx, gy),
        "mesh": raster_at(mesh[0], mesh[1], mesh[2], PIXEL, gx, gy),
    }
    fig = plt.figure(figsize=(18, 15), constrained_layout=True)
    grid = fig.add_gridspec(3, 4, height_ratios=[1.25, 1, 1])
    outline = []
    for g in shapely.get_parts(shapely.clip_by_rect(road, x0, y0, x1, y1)):
        for ring in [g.exterior, *g.interiors]:
            outline.append(np.asarray(ring.coords))
    edges = [np.column_stack([X[:, 0], Y[:, 0]]), np.column_stack([X[:, -1], Y[:, -1]])]
    sections = [len(S) // 6, len(S) // 2, 5 * len(S) // 6]
    for col, src in enumerate(H):
        ax = fig.add_subplot(grid[0, col])
        ax.imshow(hillshade(tops[src], res), cmap="gray", origin="lower", extent=(x0, x1, y0, y1), vmin=-0.2, vmax=1)
        for o in outline:
            ax.plot(o[:, 0], o[:, 1], color="#ffcc00", lw=0.6, alpha=0.8)
        for e in edges:
            ax.plot(e[:, 0], e[:, 1], color="#ff3b30", lw=0.6, ls="--")
        for k in sections:
            ax.plot(X[k, [0, -1]], Y[k, [0, -1]], color="#00b7ff", lw=0.8)
        ax.set_title(LABELS[src], fontsize=11)
        ax.set_xticks([])
        ax.set_yticks([])
        ax.set_aspect("equal")
    for col, k in enumerate(sections):
        ax = fig.add_subplot(grid[1, col])
        cols = np.flatnonzero(run[k])
        if len(cols):
            ax.axvspan(Tt[cols[0]], Tt[cols[-1]], color="#ffcc00", alpha=0.15, lw=0)
        for src, h in H.items():
            ax.plot(Tt, h[k], color=COLOURS[src], lw=1.2, label=LABELS[src])
        if ref is not None:
            ax.plot(Tt[cols] if len(cols) else Tt, (ref[k, cols] if len(cols) else ref[k]), color="k", lw=0.8, ls=":",
                    label="fit to surveyed kerbs")
        near = np.isfinite(ss) & (np.abs(ss - S[k]) <= 1.0)
        ax.scatter(st[near], sv[near, 2], s=10, c=np.where(kerb[near], "k", "#b0b0b0"), zorder=5, label="survey lines")
        ax.set_title(f"across at {S[k]:+.0f} m", fontsize=10)
        ax.set_xlabel("offset from centreline, m (left +)")
        basis = H["game"][k] if on_deck else H["lidar"][k]
        core = basis[cols] if len(cols) else basis
        core = core[np.isfinite(core)]
        if len(core):
            mid = float(np.median(core))
            ax.set_ylim(mid - 2.5, mid + 3.5)
        if col == 0:
            ax.set_ylabel("m above sea level")
            ax.legend(fontsize=8, loc="best")
    ax = fig.add_subplot(grid[1, 3])
    ax.axis("off")
    rows = [["source", "6 m wave\nalong, cm\nmedian/p95", "3 m wave\nacross, cm\nmedian/p95", "at kerbs,\ncm\nbias/spread",
             "vs survey\nroad, cm\nbias/spread", "vs LiDAR\n>30 cm\nabove"]]
    for src, r in result["sources"].items():
        def cm(d, a, b):
            return f"{100 * d[a]:.0f} / {100 * d[b]:.0f}" if d else "–"
        vl = r.get("vs_lidar")
        rows.append([src, cm(r["wave6_along"], "median", "p95"), cm(r["wave3_across"], "median", "p95"),
                     cm(r.get("vs_kerbs"), "bias", "spread"), cm(r.get("vs_survey_surface"), "bias", "spread"),
                     f"{100 * vl['above_30cm']:.0f}%" if vl else "–"])
    table = ax.table(cellText=rows[1:], colLabels=rows[0], loc="upper center", cellLoc="center",
                     bbox=[0, 0.42, 1, 0.58])
    table.auto_set_font_size(False)
    table.set_fontsize(8.5)
    ax.text(0, 0.18, f"{name}: {what}\n{result['hw']}, {result['surface']}, {'bridge' if on_deck else 'on the ground'}"
            f"\n{result['kerb_points']} surveyed kerb samples; photomesh level {result['mesh_levels']}, "
            f"{result['mesh_vertices_per_m2']} vertices/m²", fontsize=9, transform=ax.transAxes, va="top")
    for col, (label, offset) in enumerate([("centreline", 0.0), ("right wheel path", -1.8), ("left wheel path", 1.8)]):
        ax = fig.add_subplot(grid[2, col])
        j = int(np.argmin(np.abs(Tt - offset)))
        if ref is not None and np.isfinite(ref[:, j]).sum() > 20:
            base, what_base = ref[:, j], "survey fit"
        else:
            src_base = "game" if on_deck else "lidar"
            good = np.isfinite(H[src_base][:, j])
            base = np.polyval(np.polyfit(S[good], H[src_base][good, j], 2), S) if good.sum() > 10 else np.zeros_like(S)
            what_base = f"quadratic through {'the game' if on_deck else 'LiDAR'}"
        for src, h in H.items():
            y = np.where(run[:, j], h[:, j] - base, np.nan)
            ax.plot(S, 100 * y, color=COLOURS[src], lw=1.1, label=LABELS[src])
        ax.axhline(0, color="k", lw=0.6, ls=":")
        ax.set_title(f"along the {label}, minus the {what_base}", fontsize=10)
        ax.set_xlabel("distance along the street, m")
        ax.set_ylim(-60, 80)
        if col == 0:
            ax.set_ylabel("cm")
    fig.suptitle(f"{name} ({key}): road height sources", fontsize=14)
    fig.savefig(out_dir / f"{key}.png", dpi=90)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "evidence" / "road-sources")
    ap.add_argument("--sites", default=",".join(SITES))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    m = Map()
    lidar_at, _ = ipr_lidar.sampler(LIDAR, m.local)
    wgs = Transformer.from_crs(m.local, "EPSG:4326", always_xy=True)
    k_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                 area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))

    def to_krovak(xs, ys):
        lon, lat = wgs.transform(xs, ys)
        return k_wgs.transform(lon, lat, direction=TransformDirection.INVERSE)
    samplers = {"lidar": lidar_at, "dsm": dsm_sampler(to_krovak)}
    done = [run_site(m, key, samplers, args.out) for key in args.sites.split(",")]
    results = [r for r, _ in done]
    (args.out / "summary.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))
    overview(done, args.out)


def overview(done, out_dir):
    """The right wheel path of every site, each source minus a smooth reference."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    cols = 2
    rows = -(-len(done) // cols)
    fig, axes = plt.subplots(rows, cols, figsize=(16, 3.4 * rows), constrained_layout=True, squeeze=False)
    for ax, (r, (S, profile, what_base)) in zip(axes.ravel(), done):
        for src, y in profile.items():
            ax.plot(S, 100 * y, color=COLOURS[src], lw=1.1, label=LABELS[src])
        ax.axhline(0, color="k", lw=0.6, ls=":")
        ax.set_ylim(-50, 70)
        ax.set_title(f"{r['street']}: {r['tests']} (minus {what_base})", fontsize=10)
        ax.set_ylabel("cm")
    for ax in axes.ravel()[len(done):]:
        ax.axis("off")
    axes[0, 0].legend(fontsize=8, loc="upper left", ncol=2)
    for ax in axes[-1]:
        ax.set_xlabel("distance along the street, m")
    fig.suptitle("Right wheel path along each street: height of each source above a smooth reference", fontsize=13)
    fig.savefig(out_dir / "overview.png", dpi=85)
    plt.close(fig)


if __name__ == "__main__":
    main()
