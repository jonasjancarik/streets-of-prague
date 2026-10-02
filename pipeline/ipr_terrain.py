"""Terrain heights for the tiles made by build_tiles.py, from IPR Praha's open 3D
terrain model (a TIN with ~10 m spacing, CityGML), for hill shading in the game.

    uv run ipr_terrain.py centrum            # after build_tiles.py centrum
    uv run ipr_terrain.py praha --jobs 4     # sheets read side by side (default: cores - 2)

Writes tiles/<i>_<j>.height.bin.gz: a (N+1) x (N+1) grid of heights about every 4 m
across the tile (N = round(tile / 4), step = tile / N, so the grid's first and last rows
lie on the tile's edges and neighbouring tiles share them), as little-endian uint16
decimetres above 100 m a.s.l., rows from the tile's south edge, followed by each point's
label as a byte (0 the plain ground, 1 water, 2 and up the tile's terraces at the foot of
retaining walls, see dtm_heights.py), gzipped; and "terrain"
in index.json with the grid step (kept as the terrain layer, see layers.py). (Before
2026-09-29 the step was 4 m flat: the grid stopped 2 m short of a 250 m tile's far
edge and every other tile's grid sat up to 2 m off its own corner, which left a step
in the ground along tile edges on a slope. The game reads both.) The ground stays bare under bridges and over
tunnels: those have heights of their own (structures.py), per level in
tiles/<i>_<j>.levels.bin.gz, on the same lattice but in centimetres (0 off the level),
one level after another in the order the tile's "structures" lists them, for the
tiles listed in "structures". Each sheet's heights on the area's grid are kept in
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
from pathlib import Path

import numpy as np
from lxml import etree
from pyproj import Transformer
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

import layers
import build_cache
import dtm_heights
import structures
from osm_area import AREAS, OUT
from ipr_buildings import CACHE, krovak_to_local, search, sheet, sheet_name

STEP = 4.0  # roughly: the step used divides the tile evenly (grid_step)
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


def fill_gaps(tiles, N, T, step, coarse=8):
    """Give grid points no sheet covers the height of the nearest ground that has one,
    so the terrain runs on flat past the edge of the model instead of dropping to a
    fixed height in a cliff. Works on a coarse grid (coarse x step metres) spreading
    known heights outwards ring by ring, then samples it bilinearly."""
    corner = {k: (k[0] * N, k[1] * N) for k in tiles}
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


PARSED_VERSION = 1  # bump when read_sheet's output changes


def grid_step(T):
    """(steps across a tile, the step): close to STEP and dividing the tile evenly."""
    N = max(1, round(T / STEP))
    return N, T / N


def read_sheet(job):
    """One sheet's heights on the area's lattice: (grid column and row of its first
    cell, the heights as float32 with NaN where the sheet has none, lowest, highest).
    Kept per area and sheet."""
    name, path, local, gx0, gy0, step = job
    cache = CACHE / "parsed" / f"{name}_{zlib.crc32(local.encode()):08x}.pkl"
    started = time.perf_counter()
    key = [PARSED_VERSION, build_cache.identity(path), build_cache.code_key(), build_cache.runtime_key(), local, gx0, gy0, step]
    got = build_cache.load_pickle(cache, key)
    if got:
        print(f"  {name}: area cache hit, {time.perf_counter() - started:.2f} s, worker peak {build_cache.peak_mb():.1f} MB", flush=True)
        return name, got["grid"]
    to_local = krovak_to_local(local)
    stats = {}
    tris = build_cache.source_data(path, CACHE / "source" / f"{name}.triangles.pkl",
                                   [1, build_cache.function_key(triangles), GML, key[3]], triangles, stats)
    flat = tris.reshape(-1, 3)
    lx, ly = to_local.transform(flat[:, 0], flat[:, 1])
    tris = np.column_stack([lx, ly, flat[:, 2]]).reshape(-1, 3, 3)
    gi0, gi1 = math.floor((lx.min() - gx0) / step), math.ceil((lx.max() - gx0) / step)
    gj0, gj1 = math.floor((ly.min() - gy0) / step), math.ceil((ly.max() - gy0) / step)
    sub = np.full((gj1 - gj0 + 1, gi1 - gi0 + 1), np.nan)
    rasterise(tris, gx0 + gi0 * step, gy0 + gj0 * step, sub.shape[1], sub.shape[0], step, sub)
    grid = (gi0, gj0, sub.astype(np.float32), float(np.nanmin(sub)), float(np.nanmax(sub)), len(tris))
    if build_cache.identity(path) != key[1]:
        raise RuntimeError(f"IPR source changed while processing {name}")
    build_cache.atomic(cache, pickle.dumps({"key": key, "grid": grid}, protocol=5))
    print(f"  {name}: area cache miss, source cache {stats['source_cache']}, "
          f"{time.perf_counter() - started:.2f} s, worker peak {build_cache.peak_mb():.1f} MB", flush=True)
    return name, grid


def sampler(tiles, N, T, step, gx0, gy0, labels=None):
    """Bare terrain height (m a.s.l.) at points, bilinear between lattice points, read
    from each tile's corner as the game reads it; NaN outside the tiles. With `labels`
    (dtm_heights.py), in a cell a step crosses it's the plain ground's corners that count,
    or else the dry ones: a bridge's end by a quay wall is on the quay, not half-way down
    to the water."""
    labels = labels or {}
    def at(xs, ys):
        xs, ys = np.asarray(xs, float), np.asarray(ys, float)
        out = np.full(len(xs), np.nan)
        for k in range(len(xs)):
            i, j = math.floor((xs[k] - gx0) / T), math.floor((ys[k] - gy0) / T)
            arr = tiles.get((i, j))
            if arr is None:
                continue
            a = min(N - 0.001, max(0.0, (xs[k] - gx0 - i * T) / step))
            b = min(N - 0.001, max(0.0, (ys[k] - gy0 - j * T) / step))
            ia, ib = int(a), int(b)
            fa, fb = a - ia, b - ib
            lab = labels.get((i, j))
            if lab is not None:
                corner = lab[ib:ib + 2, ia:ia + 2]
                if corner.min() != corner.max():
                    own = corner == 0 if (corner == 0).any() else corner != 1
                    w = np.array([[(1 - fa) * (1 - fb), fa * (1 - fb)], [(1 - fa) * fb, fa * fb]]) * own
                    h = arr[ib:ib + 2, ia:ia + 2]
                    out[k] = (h * w).sum() / w.sum() if w.sum() > 1e-4 else h[own].mean()
                    continue
            out[k] = ((arr[ib, ia] * (1 - fa) + arr[ib, ia + 1] * fa) * (1 - fb)
                      + (arr[ib + 1, ia] * (1 - fa) + arr[ib + 1, ia + 1] * fa) * fb)
        return out
    return at


def main() -> None:
    command_started = time.perf_counter()
    timings = build_cache.Timings()
    ap = argparse.ArgumentParser(description="IPR Praha's terrain for an area's tiles")
    ap.add_argument("area", nargs="?", default="centrum", choices=AREAS)
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 2)), help="sheets read side by side")
    ap.add_argument("--no-survey", action="store_true", help="the terrain model's heights as they are, without the survey's (dtm_heights.py)")
    ap.add_argument("--no-assemble", action="store_true", help="leave output staged; assemble the complete generation separately")
    args = ap.parse_args()
    if args.jobs < 1:
        ap.error("jobs must be positive")
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
    dependencies = layers.dependency_snapshot(area, layers.DEPENDENCIES["terrain"])
    processing = [build_cache.code_key(), build_cache.runtime_key()]

    # Heights on one lattice over the area (x = -ox + i * step), kept per tile and
    # filled sheet by sheet, so memory follows the tiles that exist, not the bbox. The
    # step divides the tile, so tile (i, j) starts at lattice point (i * N, j * N).
    N, step = grid_step(T)
    gx0, gy0 = -ox, -oy
    tiles, boxes, outlines, roads, ways, water = {}, {}, [], [], [], []
    for i, j, t in layers.tiles(area, meta):
        tiles[(i, j)] = np.full((N + 1, N + 1), np.nan, dtype=np.float32)
        boxes[(i, j)] = box(*t["box"])
        water += [Polygon(r[0], r[1:]).buffer(0) for r in t["areas"].get("water", [])]
        here = t["areas"].get("bridge", [])
        outlines += [Polygon(r[0], r[1:]).buffer(0.05) for r in here]
        if here or t["roads"].get("bridge"):
            for kind in ("road", "sett", "path", "dirt"):
                roads += [Polygon(r[0], r[1:]) for r in t["roads"].get(kind, [])]
    for ci, cj in layers.chunks(meta):
        ways += layers.read_chunk(area, "streets", ci, cj).get("structures", [])
    sheets = []
    for X in range(min(c[0] for c in corners), max(c[0] for c in corners) + 1):
        for Y in range(min(c[1] for c in corners), max(c[1] for c in corners) + 1):
            name = sheet_name(X, Y) and f"TER_{sheet_name(X, Y)}"
            path = name and download(name, items)
            if not path:
                if name:
                    print(f"  {name}: not in the catalogue")
                continue
            sheets.append((name, str(path), local, gx0, gy0, step))
    sources = build_cache.sources([job[1] for job in sheets])
    timings.lap("prepare_downloads_layers")
    started = time.perf_counter()
    lo, hi = math.inf, -math.inf
    for name, (gi0, gj0, sub, slo, shi, count) in build_cache.parallel_map(read_sheet, sheets, args.jobs):
        gi1, gj1 = gi0 + sub.shape[1] - 1, gj0 + sub.shape[0] - 1
        lo, hi = min(lo, slo), max(hi, shi)
        for (i, j), arr in tiles.items():
            ci, cj = i * N, j * N
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
    timings.lap("sheets_raster_merge")
    if lo == math.inf:
        print("no terrain")
        return
    fill_gaps(tiles, N, T, step)
    timings.lap("fill_gaps")
    # Streets and water from the survey on the ground (dtm_heights.py).
    labels, terraces = {}, {}
    if not args.no_survey:
        surveyed = dtm_heights.apply(area, AREAS[area], krovak_to_local(local), tiles, N, step, gx0, gy0, unary_union(water) if water else None, boxes)
        labels, terraces = surveyed.pop("labels"), surveyed.pop("terraces")
        print(f"  survey: {surveyed}")
        timings.lap("survey")
    # Bridges and tunnels, above and below the bare ground (structures.py).
    merged = unary_union(outlines) if outlines else None
    found = structures.build(ways, list(getattr(merged, "geoms", [merged])) if merged else [], roads, sampler(tiles, N, T, step, gx0, gy0, labels),
                             local, tiles, N, T, step, gx0, gy0, boxes, source_manifest=sources)
    timings.lap("bridges_tunnels")
    # The heights, then each point's label as a byte (dtm_heights.py): 0 the plain ground,
    # 1 water, 2 and up the tile's terraces. A bank or a retaining wall is a step in the
    # ground: the game reads the height by one from the points with the same label alone.
    plain = np.zeros((N + 1, N + 1), dtype=np.uint8)
    encode = lambda a, label: np.clip(np.round((a - 100) * 10), 0, 65535).astype("<u2").tobytes() + label.astype(np.uint8).tobytes()  # noqa: E731
    # The structures' heights to the centimetre (decimetres would step along a deck).
    fine = lambda a: np.clip(np.round((np.nan_to_num(a, nan=100.0) - 100) * 100), 0, 65535).astype("<u2").tobytes()  # noqa: E731
    per_tile = {}
    payloads = {}
    layers.begin_layer(area, "terrain")
    for (i, j), arr in tiles.items():
        k = f"{i}_{j}"
        layers.write_bin(out_dir / "tiles", f"{k}.height.bin", encode(arr, labels.get((i, j), plain)), payloads)
        # Each level's heights one after the other, in the order the tile lists them.
        if (i, j) in found:
            layers.write_bin(out_dir / "tiles", f"{k}.levels.bin", b"".join(fine(h) for _, _, h, _ in found[(i, j)]), payloads)
            per_tile[k] = [{"level": lv, "kind": kind, "polys": polys} for lv, kind, _, polys in found[(i, j)]]
        else:
            layers.remove_bin(out_dir / "tiles", f"{k}.levels.bin")
        # From before: one deck level, and before that the bare ground kept where
        # bridges were raised into it.
        layers.remove_bin(out_dir / "tiles", f"{k}.deck.bin")
        layers.remove_bin(out_dir / "tiles", f"{k}.bare.bin")
    if not build_cache.sources_current(sources) or processing != [build_cache.code_key(), build_cache.runtime_key()]:
        raise RuntimeError("terrain sources or processing code changed; keep output staged and rebuild")
    layers.write_layer(area, "terrain", {"gzip": True, "tile": T, "made_for": [f"{i}_{j}" for i, j in tiles], "tiles": per_tile,
                                         "terraces": {f"{i}_{j}": v for (i, j), v in terraces.items()},
                                         "dependencies": dependencies, "sources": sources, "processing": processing, "payloads": payloads,
                                         "index": {"step": step, "n": N + 1, "min": float(lo), "max": float(hi), "structures": sorted(per_tile)}})
    print(f"terrain {lo:.0f}–{hi:.0f} m for {len(tiles)} tiles")
    timings.lap("encode_write")
    if not args.no_assemble:
        layers.assemble(area)
    timings.lap("assembly")
    timings.out["total"] = time.perf_counter() - command_started
    build_cache.report_times(f"{area} ipr_terrain", timings.out)


if __name__ == "__main__":
    main()
