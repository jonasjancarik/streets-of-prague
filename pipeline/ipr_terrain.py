"""Terrain heights for the tiles made by build_tiles.py, from IPR Praha's open 3D
terrain model (a TIN with ~10 m spacing, CityGML), for hill shading in the game.

    uv run ipr_terrain.py centrum            # after build_tiles.py centrum
    uv run ipr_terrain.py praha --jobs 4     # sheets read side by side (default: cores - 2)

Writes tiles/<i>_<j>.height.bin.gz: a (N+1) x (N+1) grid of heights every 4 m across
the tile (N = tile / 4), as little-endian uint16 decimetres above 100 m a.s.l.,
rows from the tile's south edge, gzipped; and "terrain" in index.json with the grid step (kept
as the terrain layer, see layers.py). The ground stays bare under bridges: their decks
have heights of their own, worked out from the streets and bridges of the ground layer,
in tiles/<i>_<j>.deck.bin.gz on the same lattice (0 off the decks), for the tiles
listed in "decks". Each sheet's heights on the area's grid are kept in
pipeline/.cache/ipr/parsed/, so running this again after the ground changed takes
seconds.

Source: IPR Praha, 3D model terénu (datový podklad © IPR Praha, CC BY), SMO-5
sheets TER_<block>_<X>-<Y>, downloaded once into pipeline/.cache/ipr/. Past the edge
of the model (outside the city) the ground carries on at the nearest known height.
"""

import argparse
import io
import json
import math
import os
import pickle
import time
import urllib.request
import zipfile
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from lxml import etree
from pyproj import Transformer

import layers
from osm_area import AREAS, OUT
from ipr_buildings import CACHE, krovak_to_local, search, sheet, sheet_name

STEP = 4.0
DECK_PAD = 6.0  # m of deck heights past the edge of a bridge (more than a lattice diagonal)
GML = "http://www.opengis.net/gml"


def catalogue():
    path = CACHE / "catalogue_ter.json"
    if path.exists():
        return json.loads(path.read_text())
    items = {t[: -len("_gml")]: i for t, (i, _) in search("TER_").items() if t.endswith("_gml")}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, indent=1))
    return items


def download(name, items):
    path = CACHE / f"{name}_gml.gml"
    if path.exists():
        return path
    if name not in items:
        return None
    print(f"  downloading {name}…")
    data = urllib.request.urlopen(f"https://www.arcgis.com/sharing/rest/content/items/{items[name]}/data").read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = next(m for m in z.namelist() if m.lower().endswith(".gml"))
        path.write_bytes(z.read(member))
    return path


def triangles(path):
    """All TIN triangles of a sheet as an (n, 3, 3) array in S-JTSK + height."""
    tris = []
    for _, el in etree.iterparse(str(path), events=("end",), tag=f"{{{GML}}}Triangle", huge_tree=True):
        pl = next(el.iter(f"{{{GML}}}posList"))
        v = np.array(pl.text.split(), dtype=float).reshape(-1, 3)[:3]
        tris.append(v)
        el.clear()
    return np.array(tris)


def rasterise(tris, x0, y0, nx, ny, step, grid):
    """Barycentric fill of the grid (heights at x0 + i*step, y0 + j*step)."""
    for a, b, c in tris:
        xs, ys = (a[0], b[0], c[0]), (a[1], b[1], c[1])
        i0, i1 = max(0, math.ceil((min(xs) - x0) / step)), min(nx - 1, math.floor((max(xs) - x0) / step))
        j0, j1 = max(0, math.ceil((min(ys) - y0) / step)), min(ny - 1, math.floor((max(ys) - y0) / step))
        if i0 > i1 or j0 > j1:
            continue
        gx, gy = np.meshgrid(x0 + np.arange(i0, i1 + 1) * step, y0 + np.arange(j0, j1 + 1) * step)
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-9:
            continue
        l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / d
        l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / d
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
        z = l1 * a[2] + l2 * b[2] + l3 * c[2]
        sub = grid[j0:j1 + 1, i0:i1 + 1]
        sub[inside] = z[inside]


def fill_gaps(tiles, N, T, coarse=8):
    """Give grid points no sheet covers the height of the nearest ground that has one,
    so the terrain runs on flat past the edge of the model instead of dropping to a
    fixed height in a cliff. Works on a coarse grid (coarse x STEP metres) spreading
    known heights outwards ring by ring, then samples it bilinearly."""
    corner = {k: (int(round(k[0] * T / STEP)), int(round(k[1] * T / STEP))) for k in tiles}
    ci0, cj0 = min(c[0] for c in corner.values()), min(c[1] for c in corner.values())
    w = (max(c[0] for c in corner.values()) - ci0 + N) // coarse + 2
    h = (max(c[1] for c in corner.values()) - cj0 + N) // coarse + 2
    total, count = np.zeros((h, w)), np.zeros((h, w))
    rows, cols = np.mgrid[0:N + 1, 0:N + 1]
    gaps = False
    for k, arr in tiles.items():
        ok = ~np.isnan(arr)
        gaps |= not ok.all()
        gi, gj = (corner[k][0] - ci0 + cols[ok]) // coarse, (corner[k][1] - cj0 + rows[ok]) // coarse
        np.add.at(total, (gj, gi), arr[ok])
        np.add.at(count, (gj, gi), 1)
    if not gaps or not count.any():
        return
    known = count > 0
    grid = np.where(known, total / np.maximum(count, 1), 0.0)
    while not known.all():
        s, c = np.zeros_like(grid), np.zeros_like(grid)
        for dj, di in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            src = np.roll(np.where(known, grid, 0.0), (dj, di), axis=(0, 1))
            n = np.roll(known, (dj, di), axis=(0, 1))
            # np.roll wraps round; drop what came across the far edge.
            if dj: n[0 if dj > 0 else -1, :] = False
            if di: n[:, 0 if di > 0 else -1] = False
            s += np.where(n, src, 0.0)
            c += n
        new = ~known & (c > 0)
        grid[new] = s[new] / c[new]
        known |= new
    for k, arr in tiles.items():
        miss = np.isnan(arr)
        if not miss.any():
            continue
        # Coarse cell centres sit at (index + 0.5) * coarse.
        u = np.clip((corner[k][0] - ci0 + cols[miss]) / coarse - 0.5, 0, w - 1.001)
        v = np.clip((corner[k][1] - cj0 + rows[miss]) / coarse - 0.5, 0, h - 1.001)
        i, j = u.astype(int), v.astype(int)
        fu, fv = u - i, v - j
        arr[miss] = ((grid[j, i] * (1 - fu) + grid[j, i + 1] * fu) * (1 - fv)
                     + (grid[j + 1, i] * (1 - fu) + grid[j + 1, i + 1] * fu) * fv)


def bridge_decks(ground, tiles, N, T, gx0, gy0):
    """The terrain model is bare earth, so under a bridge it drops to the river or the
    road below. Work out every bridge deck's own height instead: that of its ends, where
    the bridge meets ordinary roads and paths, sloping linearly from one end to the
    other. Returns the decks' heights per tile on the terrain's lattice (NaN off the
    decks), reaching DECK_PAD metres past each deck so the game can interpolate right
    up to its edge. `ground`: the tiles' ground (areas and roads), in the order of
    index.json; `tiles`: the bare terrain, which stays as it is."""
    import shapely
    from shapely import STRtree
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    pieces, roads = [], []
    for t in ground:
        here = t["areas"].get("bridge", []) + t["roads"].get("bridge", [])
        pieces += [Polygon(r[0], r[1:]).buffer(0.05) for r in here]
        if here:
            for kind in ("road", "sett", "path", "dirt"):
                roads += [Polygon(r[0], r[1:]) for r in t["roads"].get(kind, [])]
    decks = {}
    if not pieces:
        return decks
    merged = unary_union(pieces)
    polys = list(getattr(merged, "geoms", [merged]))
    road_tree = STRtree(roads) if roads else None
    near = {}  # tile → distance from each lattice point to the deck its height is from

    def height_at(x, y):
        i, j = math.floor((x - gx0) / T), math.floor((y - gy0) / T)
        arr = tiles.get((i, j))
        if arr is None:
            return np.nan
        ci, cj = int(round((x - gx0 - i * T) / STEP)), int(round((y - gy0 - j * T) / STEP))
        return arr[min(N, max(0, cj)), min(N, max(0, ci))]

    made = 0
    for poly in polys:
        if poly.area < 30:
            continue
        # The bridge's long axis, from its minimum rotated rectangle.
        rect = list(poly.minimum_rotated_rectangle.exterior.coords)
        e1, e2 = np.subtract(rect[1], rect[0]), np.subtract(rect[2], rect[1])
        axis = e1 if np.hypot(*e1) >= np.hypot(*e2) else e2
        axis = axis / (np.hypot(*axis) or 1)
        c = np.array(poly.centroid.coords[0])
        ring = poly.exterior.buffer(3).exterior
        pts = np.array([ring.interpolate(d).coords[0] for d in np.arange(0, ring.length, 2.0)])
        hs = np.array([height_at(x, y) for x, y in pts])
        # Ends: ring points on (or right next to) an ordinary road or path.
        on_road = np.zeros(len(pts), bool)
        if road_tree is not None:
            for k, (x, y) in enumerate(pts):
                on_road[k] = len(road_tree.query(shapely.points(x, y).buffer(2), predicate="intersects")) > 0
        # Only the outer fifths of the bridge's length count, so a road passing under the
        # middle of a flyover isn't mistaken for one of its ends.
        along = (pts - c) @ axis
        span = along.max() - along.min()
        outer = (along < along.min() + 0.2 * span) | (along > along.max() - 0.2 * span)
        ok = on_road & outer & ~np.isnan(hs)
        if ok.sum() < 2:
            ok = ~np.isnan(hs)
            if not ok.any():
                continue
            ends_t, ends_h = np.array([0.0]), np.array([np.percentile(hs[ok], 90)])
        else:
            t = (pts[ok] - c) @ axis
            h = hs[ok]
            lo, hi = t < np.median(t), t >= np.median(t)
            if lo.any() and hi.any() and t[hi].mean() - t[lo].mean() > 5:
                ends_t = np.array([np.median(t[lo]), np.median(t[hi])])
                ends_h = np.array([np.median(h[lo]), np.median(h[hi])])
            else:
                ends_t, ends_h = np.array([0.0]), np.array([np.median(h)])
        minx, miny, maxx, maxy = poly.bounds
        grown = poly.buffer(DECK_PAD)
        for i in range(math.floor((minx - DECK_PAD - gx0) / T), math.floor((maxx + DECK_PAD - gx0) / T) + 1):
            for j in range(math.floor((miny - DECK_PAD - gy0) / T), math.floor((maxy + DECK_PAD - gy0) / T) + 1):
                if (i, j) not in tiles:
                    continue
                tx0, ty0 = gx0 + i * T, gy0 + j * T
                xs, ys = np.meshgrid(tx0 + np.arange(N + 1) * STEP, ty0 + np.arange(N + 1) * STEP)
                inside = shapely.contains_xy(grown, xs, ys)
                if not inside.any():
                    continue
                arr = decks.setdefault((i, j), np.full((N + 1, N + 1), np.nan, dtype=np.float32))
                dist = near.setdefault((i, j), np.full((N + 1, N + 1), np.inf, dtype=np.float32))
                # Where two decks are close, each point takes the height of the nearer.
                d = np.full(xs.shape, np.inf, dtype=np.float32)
                d[inside] = shapely.distance(poly, shapely.points(xs[inside], ys[inside]))
                mine = inside & (d < dist)
                if len(ends_t) == 1:
                    arr[mine] = ends_h[0]
                else:
                    tt = (xs[mine] - c[0]) * axis[0] + (ys[mine] - c[1]) * axis[1]
                    f = np.clip((tt - ends_t[0]) / (ends_t[1] - ends_t[0]), 0, 1)
                    arr[mine] = ends_h[0] + (ends_h[1] - ends_h[0]) * f
                dist[mine] = d[mine]
        made += 1
    print(f"  {made} bridge decks")
    return decks


PARSED_VERSION = 1  # bump when read_sheet's output changes


def read_sheet(job):
    """One sheet's heights on the area's 4 m lattice: (grid column and row of its first
    cell, the heights as float32 with NaN where the sheet has none, lowest, highest).
    Kept per area and sheet."""
    name, path, local, gx0, gy0 = job
    cache = CACHE / "parsed" / f"{name}_{zlib.crc32(local.encode()):08x}.pkl"
    st = Path(path).stat()
    key = [PARSED_VERSION, st.st_mtime_ns, st.st_size, local, gx0, gy0, STEP]
    if cache.exists():
        with open(cache, "rb") as f:
            got = pickle.load(f)
        if got["key"] == key:
            return name, got["grid"]
    to_local = krovak_to_local(local)
    tris = triangles(path)
    flat = tris.reshape(-1, 3)
    lx, ly = to_local.transform(flat[:, 0], flat[:, 1])
    tris = np.column_stack([lx, ly, flat[:, 2]]).reshape(-1, 3, 3)
    gi0, gi1 = math.floor((lx.min() - gx0) / STEP), math.ceil((lx.max() - gx0) / STEP)
    gj0, gj1 = math.floor((ly.min() - gy0) / STEP), math.ceil((ly.max() - gy0) / STEP)
    sub = np.full((gj1 - gj0 + 1, gi1 - gi0 + 1), np.nan)
    rasterise(tris, gx0 + gi0 * STEP, gy0 + gj0 * STEP, sub.shape[1], sub.shape[0], STEP, sub)
    grid = (gi0, gj0, sub.astype(np.float32), float(np.nanmin(sub)), float(np.nanmax(sub)), len(tris))
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    with open(tmp, "wb") as f:
        pickle.dump({"key": key, "grid": grid}, f, protocol=5)
    tmp.replace(cache)
    return name, grid


def main() -> None:
    ap = argparse.ArgumentParser(description="IPR Praha's terrain for an area's tiles")
    ap.add_argument("area", nargs="?", default="centrum", choices=AREAS)
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 2)), help="sheets read side by side")
    args = ap.parse_args()
    area = args.area
    out_dir = OUT / f"{area}_now"
    meta = layers.read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: run build_tiles.py {area} first")
    w, s, e, n = AREAS[area]
    T = meta["tile"]
    ox, oy = meta["origin"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    corners = [sheet(*to_krovak.transform(lon, lat)) for lon in (w, e) for lat in (s, n)]
    items = catalogue()

    # Heights on one 4 m lattice over the area (x = -ox + i * STEP), kept per tile and
    # filled sheet by sheet, so memory follows the tiles that exist, not the bbox.
    N = int(T // STEP)
    gx0, gy0 = -ox, -oy
    ground = []
    tiles = {}
    for i, j, t in layers.tiles(area, meta):
        tiles[(i, j)] = np.full((N + 1, N + 1), np.nan, dtype=np.float32)
        ground.append({"areas": t["areas"], "roads": t["roads"]})
    sheets = []
    for X in range(min(c[0] for c in corners), max(c[0] for c in corners) + 1):
        for Y in range(min(c[1] for c in corners), max(c[1] for c in corners) + 1):
            name = sheet_name(X, Y) and f"TER_{sheet_name(X, Y)}"
            path = name and download(name, items)
            if not path:
                if name:
                    print(f"  {name}: not in the catalogue")
                continue
            sheets.append((name, str(path), local, gx0, gy0))
    started = time.perf_counter()
    lo, hi = math.inf, -math.inf
    run = map if args.jobs == 1 or len(sheets) == 1 else ProcessPoolExecutor(args.jobs).map
    for name, (gi0, gj0, sub, slo, shi, count) in run(read_sheet, sheets):
        gi1, gj1 = gi0 + sub.shape[1] - 1, gj0 + sub.shape[0] - 1
        lo, hi = min(lo, slo), max(hi, shi)
        for (i, j), arr in tiles.items():
            ci, cj = int(round(i * T / STEP)), int(round(j * T / STEP))
            a0, a1 = max(ci, gi0), min(ci + N, gi1)
            b0, b1 = max(cj, gj0), min(cj + N, gj1)
            if a0 > a1 or b0 > b1:
                continue
            part = sub[b0 - gj0:b1 - gj0 + 1, a0 - gi0:a1 - gi0 + 1]
            view = arr[b0 - cj:b1 - cj + 1, a0 - ci:a1 - ci + 1]
            ok = ~np.isnan(part)
            view[ok] = part[ok]
        print(f"  {name}: {count} triangles", flush=True)
    print(f"  sheets read in {time.perf_counter() - started:.0f} s")
    if lo == math.inf:
        print("no terrain")
        return
    fill_gaps(tiles, N, T)
    decks = bridge_decks(ground, tiles, N, T, gx0, gy0)
    encode = lambda a: np.clip(np.round((a - 100) * 10), 0, 65535).astype("<u2").tobytes()  # noqa: E731
    for (i, j), arr in tiles.items():
        layers.write_bin(out_dir / "tiles", f"{i}_{j}.height.bin", encode(arr))
        # Bridge decks on their own, 0 off them: the ground stays bare under a bridge,
        # so a road can pass under a flyover.
        if (i, j) in decks:
            layers.write_bin(out_dir / "tiles", f"{i}_{j}.deck.bin", encode(np.nan_to_num(decks[(i, j)], nan=100.0)))
        else:
            layers.remove_bin(out_dir / "tiles", f"{i}_{j}.deck.bin")
        # From before decks: the bare ground kept where bridges were raised into it.
        layers.remove_bin(out_dir / "tiles", f"{i}_{j}.bare.bin")
    layers.write_layer(area, "terrain", {"gzip": True, "tile": T, "made_for": [f"{i}_{j}" for i, j in tiles], "index": {"step": STEP, "n": N + 1, "min": float(lo), "max": float(hi), "decks": sorted(f"{i}_{j}" for i, j in decks)}})
    print(f"terrain {lo:.0f}–{hi:.0f} m for {len(tiles)} tiles")
    layers.assemble(area)


if __name__ == "__main__":
    main()
