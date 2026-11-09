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
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

import layers
import build_cache
import dmr5g
import dtm_heights
import ipr_lidar
import step_lines
import structures
from osm_area import AREAS, OUT
from ipr_buildings import CACHE, krovak_to_local, search, sheet_names

STEP = 4.0  # roughly: the step used divides the tile evenly (grid_step)
NEAR_DECK, OFF_DECK = 0.5, 1.5  # m between a bridge and the ground under or beside it: one with it, nothing to do with it
GML = "http://www.opengis.net/gml"


def pull_to_bridges(tiles, labels, found, N):
    """Bring dry ground to nearby decks, with one support set per shared node.

    Drawable bridge polygons are clipped per tile, so a bridge's padded height
    grid can be exported on only one side of a tile edge. The physical ground
    correction at that shared lattice point must nevertheless run on both sides.
    Interior support and the existing ascending-level pull rule stay unchanged.
    """
    edge = [(y, x) for y in (0, N) for x in range(N + 1)] + [(y, x) for y in range(1, N) for x in (0, N)]
    shared = {}
    for (i, j), levels in sorted(found.items()):
        for level, kind, h, _ in levels:
            if kind != 'bridge':
                continue
            for y, x in np.argwhere(np.isfinite(h)):
                if x not in (0, N) and y not in (0, N):
                    continue
                node = (i * N + int(x), j * N + int(y))
                support = shared.setdefault(node, {})
                value = float(h[y, x])
                if level in support and support[level] != value:
                    raise ValueError(f"conflicting bridge support at {node}, level {level}: {support[level]} != {value}")
                support.setdefault(level, value)
    # Validate shared plain ground before mutating any tile. Differences between
    # distinct terrace labels/heights are not evidence for a common ground plane.
    plain = {}
    for (i, j), arr in sorted(tiles.items()):
        lab = labels.get((i, j))
        for y, x in edge:
            node = (i * N + x, j * N + y)
            if node not in shared or (lab is not None and lab[y, x] != 0):
                continue
            value = float(arr[y, x])
            if node in plain and value != plain[node]:
                raise ValueError(f"conflicting plain ground before bridge pull at {node}: {plain[node]} != {value}")
            plain[node] = value
    changed = 0
    for (i, j), arr in tiles.items():
        support = {level: h.copy() for level, kind, h, _ in found.get((i, j), []) if kind == 'bridge'}
        for y, x in edge:
            for level, value in shared.get((i * N + x, j * N + y), {}).items():
                if level not in support:
                    support[level] = np.full(arr.shape, np.nan, dtype=np.float32)
                h = support[level]
                h[y, x] = value
        lab = labels.get((i, j))
        for level in sorted(support):
            h = support[level]
            with np.errstate(invalid='ignore'):
                apart = h - arr
                pull = np.clip((OFF_DECK - np.abs(apart)) / (OFF_DECK - NEAR_DECK), 0, 1)
            near = np.isfinite(apart) & (pull > 0)
            if lab is not None:
                near &= lab != 1
            arr[near] += (apart * pull)[near]
            changed += int(near.sum())
    return changed


CATALOGUE = "catalogue_ter.json"


def catalogue():
    path = CACHE / CATALOGUE
    if path.exists():
        return json.loads(path.read_text())
    items = {t[: -len("_gml")]: i for t, (i, _) in search("TER_").items() if t.endswith("_gml")}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, indent=1))
    return items


def sheet_path(name):
    return CACHE / f"{name}_gml.gml"


def download(name, items):
    path = sheet_path(name)
    if path.exists():
        return path
    if name not in items:
        return None
    print(f"  downloading {name}…")
    data = urllib.request.urlopen(f"https://www.arcgis.com/sharing/rest/content/items/{items[name]}/data").read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = next(m for m in z.namelist() if m.lower().endswith(".gml"))
        build_cache.atomic(path, z.read(member))
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


def grid_step(T, target=STEP):
    """(steps across a tile, the step): close to `target` and dividing the tile evenly."""
    N = max(1, round(T / target))
    return N, T / N


def read_sheet(job):
    """One sheet's heights on the area's lattice: (grid column and row of its first
    cell, the heights as float32 with NaN where the sheet has none, lowest, highest).
    Kept per area and sheet."""
    name, path, local, gx0, gy0, step = job
    cache = CACHE / "parsed" / f"{name}_{zlib.crc32(local.encode()):08x}.pkl"
    started = time.perf_counter()
    key = [PARSED_VERSION, build_cache.identity(path), *build_cache.processing("terrain_sheet"), local, gx0, gy0, step]
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
    to the water. `dry`: NaN on the water."""
    labels = labels or {}
    def at(xs, ys, dry=False):
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
                if dry and (corner == 1).all():
                    continue
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


def kept_places(local):
    """The places in terrain_keep.json (boxes in degrees: west, south, east, north) as
    polygons in the area's metres."""
    to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    out = []
    for place in json.loads((Path(__file__).parent / "terrain_keep.json").read_text()):
        w, s, e, n = place["box"]
        out.append(Polygon(zip(*to_local.transform([w, e, e, w], [s, s, n, n]))))
    return out


def drawn_walls(local):
    """The walls in terrain_walls.json (lines in degrees: lon, lat) as lines in the
    area's metres."""
    to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    return [LineString(zip(*to_local.transform(*zip(*wall["line"]))))
            for wall in json.loads((Path(__file__).parent / "terrain_walls.json").read_text())]


def source_paths(area, options):
    paths = [CACHE / CATALOGUE, *structures.bridge_files()]
    paths.extend(sheet_path(f"TER_{name}") for name in sheet_names(area))
    if not options.get("no_survey"):
        paths.extend(dtm_heights.survey_packages())
    if options.get("dmr5g"):
        paths.extend(dmr5g.raster_path(name) for name in dmr5g.BOXES)
    if directory := options.get("ipr_lidar"):
        paths.extend(ipr_lidar.source_paths(directory))
    if (directory := options.get("survey_scan")) and directory != options.get("ipr_lidar"):
        paths.extend(ipr_lidar.source_paths(directory))
    return paths


def main() -> None:
    command_started = time.perf_counter()
    timings = build_cache.Timings()
    ap = argparse.ArgumentParser(description="IPR Praha's terrain for an area's tiles")
    ap.add_argument("area", nargs="?", default="centrum", choices=AREAS)
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 2)), help="sheets read side by side")
    ap.add_argument("--no-survey", action="store_true", help="the terrain model's heights as they are, without the survey's (dtm_heights.py)")
    ap.add_argument("--no-survey-scan", action="store_true",
                    help="leave the survey's points however far under IPR's 2023 LiDAR they are (to compare; dtm_heights.OFF_SCAN)")
    ap.add_argument("--no-feather", action="store_true", help="the ground beside surveyed streets as the terrain model has it (to compare)")
    raster = ap.add_mutually_exclusive_group()
    raster.add_argument("--dmr5g", action="store_true", help="prototype: ČÚZK's DMR 5G as the terrain in dmr5g.BOXES")
    raster.add_argument("--ipr-lidar", type=Path, metavar="CACHE_DIR", help="use IPR's 2023 bare-earth raster where available")
    ap.add_argument("--shoulder", action="store_true", help="trial: the ground within 5 m of a surveyed street level with it")
    ap.add_argument("--walls-on-streets", action="store_true", help="retaining walls' terraces over car streets as they come (to compare)")
    ap.add_argument("--valley-nearest", action="store_true", help="made-up land beside water from the nearest water alone, cliffs and all (to compare)")
    ap.add_argument("--cut-streets", action="store_true", help="trial: a surveyed street under or over a steep bank is a terrace, cut along its outline")
    ap.add_argument("--no-cuttings", action="store_true", help="no walls along a street in a cutting under a bridge (to compare)")
    ap.add_argument("--no-sunk-kerbs", action="store_true", help="streets over an underpass from the kerbs below too (to compare)")
    ap.add_argument("--no-scan-levels", action="store_true",
                    help="bridges' decks surveyed as ground in the ground under them, and two levels decided without the LiDAR (to compare)")
    ap.add_argument("--no-level", action="store_true", help="car streets from their nearest kerb points, leaning and all, not level across (to compare)")
    ap.add_argument("--survey-companion-decks", action="store_true",
                    help="trial: use the DTM to add a second carriageway on a bridge already identified above a cutting")
    ap.add_argument("--step", type=float, default=STEP, help="prototype: the lattice's step in metres, roughly (the default about 4)")
    ap.add_argument("--lidar-window", type=int, default=1, metavar="N",
                    help="prototype: each lattice point takes the median of N × N of the LiDAR's 1 m cells round it (1: the scan at the point)")
    ap.add_argument("--lidar-ground", action="store_true",
                    help="prototype: the LiDAR is the ground and the survey only says where the walls, streets and water are; heights in centimetres")
    ap.add_argument("--step-lines", action="store_true",
                    help="trial: each step's outline with the ground's height on either side of it (step_lines.py)")
    ap.add_argument("--resume", action="store_true", help="reuse completed terrain output if its inputs and binary files match")
    ap.add_argument("--no-assemble", action="store_true", help="leave output staged; assemble the complete generation separately")
    args = ap.parse_args()
    if args.jobs < 1:
        ap.error("jobs must be positive")
    if args.lidar_ground and (not args.ipr_lidar or args.no_survey):
        ap.error("--lidar-ground needs --ipr-lidar and the survey")
    if args.survey_companion_decks and args.no_survey:
        ap.error("--survey-companion-decks requires the survey")
    area = args.area
    out_dir = OUT / f"{area}_now"
    meta = layers.read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: run build_tiles.py {area} first")
    w, s, e, n = AREAS[area]
    T = meta["tile"]
    ox, oy = meta["origin"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    options = {name: getattr(args, name) for name in (
        "no_survey", "no_feather", "dmr5g", "shoulder", "walls_on_streets", "valley_nearest", "cut_streets", "no_level", "no_sunk_kerbs", "no_scan_levels", "no_cuttings")}
    if args.ipr_lidar:
        options["ipr_lidar"] = str(args.ipr_lidar.resolve())
    if args.survey_companion_decks:
        options["survey_companion_decks"] = True
    # The survey's points are checked against IPR's 2023 LiDAR wherever it's been imported
    # (ipr_lidar.py), whether or not it's the ground.
    scan_dir = args.ipr_lidar or ipr_lidar.CACHE
    if not args.no_survey and not args.no_survey_scan:
        if all(p.exists() for p in ipr_lidar.source_paths(scan_dir)):
            options["survey_scan"] = str(Path(scan_dir).resolve())
        else:
            print(f"  note: no LiDAR in {scan_dir}, so the survey isn't checked against it (ipr_lidar.py imports it)")
    if args.step != STEP:
        options["step"] = args.step
    if args.lidar_ground:
        options["lidar_ground"] = True
    if args.lidar_window > 1:
        options["lidar_window"] = args.lidar_window
    if args.step_lines:
        options["step_lines"] = True
    inputs = layers.stage_inputs(area, "terrain", options, meta)
    if args.resume and layers.resume_stage(area, "terrain", inputs, args.no_assemble):
        return
    N, step = grid_step(T, args.step)
    gx0, gy0 = -ox, -oy
    items = catalogue()
    sheets = []
    for suffix in sheet_names(area):
        name = f"TER_{suffix}"
        path = download(name, items)
        if not path:
            print(f"  {name}: not in the catalogue")
            continue
        sheets.append((name, str(path), local, gx0, gy0, step))
    if sheets:
        structures.bridge_shapefile(download=True)
        if args.dmr5g:
            for name in dmr5g.BOXES:
                if not dmr5g.raster_path(name).exists():
                    dmr5g.raster(name)
    inputs["sources"] = layers.stage_sources(area, "terrain", options)
    if args.ipr_lidar:
        try:
            lidar_at, lidar_source = ipr_lidar.sampler(options["ipr_lidar"], local)
            lattice_at = ipr_lidar.sampler(options["ipr_lidar"], local, args.lidar_window)[0] if args.lidar_window > 1 else lidar_at
        except ValueError as exc:
            ap.exit(1, f"{exc}\n")
    timings.lap("prepare_downloads")

    # Heights on one lattice over the area (x = -ox + i * step), kept per tile and
    # filled sheet by sheet, so memory follows the tiles that exist, not the bbox. The
    # step divides the tile, so tile (i, j) starts at lattice point (i * N, j * N).
    tiles, boxes, outlines, roads, ways, water, by_water, driven = {}, {}, [], [], [], [], [], []
    weirs, streets, street_edges, tile_water = [], {}, {}, {}
    for i, j, t in layers.tiles(area, meta):
        tiles[(i, j)] = np.full((N + 1, N + 1), np.nan, dtype=np.float32)
        boxes[(i, j)] = box(*t["box"])
        tile_water[(i, j)] = t["areas"].get("water", [])
        water += [Polygon(r[0], r[1:]).buffer(0) for r in t["areas"].get("water", [])]
        weirs += t.get("weirs") or []
        # The car streets on the ground, kerb to kerb (a tile lists each edge that touches it).
        for e in t.get("drive") or []:
            if not e.get("bridge") and len(e["pts"]) > 1 and e["id"] not in streets:
                half = min(e["width"] / 2, *(e.get("kerb") or [e["width"] / 2]))
                streets[e["id"]] = (LineString(e["pts"]), half)
                street_edges[e["id"]] = e
        if t["areas"].get("water"):
            for kind in ("road", "sett", "path", "dirt"):
                here = [Polygon(r[0], r[1:]).buffer(0) for r in t["roads"].get(kind, [])]
                by_water += here
                if kind in ("road", "sett"):
                    driven += here
        here = t["areas"].get("bridge", [])
        outlines += [Polygon(r[0], r[1:]).buffer(0.05) for r in here]
        if here or t["roads"].get("bridge"):
            for kind in ("road", "sett", "path", "dirt"):
                roads += [Polygon(r[0], r[1:]) for r in t["roads"].get(kind, [])]
    for ci, cj in layers.chunks(meta):
        ways += layers.read_chunk(area, "streets", ci, cj).get("structures", [])
    timings.lap("prepare_layers")
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
    if args.ipr_lidar:
        sampled = 0
        offsets = np.arange(N + 1)
        for (i, j), arr in tiles.items():
            # Use integer lattice indices so adjacent tiles query the same shared points.
            xs, ys = np.meshgrid(gx0 + (i * N + offsets) * step, gy0 + (j * N + offsets) * step)
            h = lattice_at(xs, ys)
            valid = np.isfinite(h)
            if valid.any():
                arr[valid] = h[valid]
                lo, hi = min(lo, float(h[valid].min())), max(hi, float(h[valid].max()))
                sampled += int(valid.sum())
        if not sampled:
            ap.exit(1, f"{area}: no valid IPR LiDAR samples in the map tiles\n")
        print(f"  IPR LiDAR at {sampled:,} of {len(tiles) * (N + 1)**2:,} tile lattice points")
        timings.lap("lidar_raster")
    if lo == math.inf:
        print("no terrain")
        return
    # (What the model has nothing for, before it's filled in: dtm_heights.py shapes the
    # land by the water there.)
    unknown = {k: np.isnan(arr) for k, arr in tiles.items() if np.isnan(arr).any()}
    fill_gaps(tiles, N, T, step)
    timings.lap("fill_gaps")
    # Prototype: ČÚZK's DMR 5G (laser-scanned, 2 m) instead of IPR's model where it's been fetched.
    if args.dmr5g:
        swapped = 0
        for name in dmr5g.BOXES:
            at = dmr5g.sampler(name, local)
            for (i, j), arr in tiles.items():
                xs, ys = np.meshgrid(gx0 + i * T + np.arange(N + 1) * step, gy0 + j * T + np.arange(N + 1) * step)
                h = at(xs, ys)
                ok = ~np.isnan(h)
                if ok.any():
                    arr[ok] = h[ok]
                    swapped += int(ok.sum())
        print(f"  DMR 5G at {swapped} points")
    # A short underpass in an open cutting is on the ground, and the streets over it on
    # bridges (structures.cuttings), before the survey, which leaves the ground under
    # bridges alone.
    deck_survey = None
    if args.survey_companion_decks:
        import dtm_structures
        deck_survey = dtm_structures.for_area(AREAS[area], krovak_to_local(local).transform)
    dropped, cut_bridges = structures.cuttings(ways, street_edges, sampler(tiles, N, T, step, gx0, gy0), deck_survey)
    if dropped:
        ways = [w for w in ways if w["id"] not in dropped] + cut_bridges
        print(f"  {len(dropped)} underpasses in an open cutting: on the ground, {len(cut_bridges)} streets over them on bridges")
    # Streets and water from the survey on the ground (dtm_heights.py).
    labels, terraces = {}, {}
    if not args.no_survey:
        surveyed = dtm_heights.apply(area, AREAS[area], krovak_to_local(local), tiles, N, step, gx0, gy0, unary_union(water) if water else None, boxes, by_water,
                                      [(LineString(w["pts"]), w["w"]) for w in ways if w["kind"] == "tunnel" and len(w["pts"]) > 1], kept_places(local), driven, [] if args.walls_on_streets else list(streets.values()), args.no_feather, not args.shoulder, args.cut_streets, weirs=weirs, unknown=unknown, valley_smooth=not args.valley_nearest,
                                      bridges=[LineString(w["pts"]).buffer(w["w"] / 2) for w in ways if w["kind"] == "bridge" and len(w["pts"]) > 1] + list(outlines),
                                      bridge_ends=dtm_heights.bridge_ends([LineString(w["pts"]) for w in ways if w["kind"] == "bridge" and len(w["pts"]) > 1]),
                                      bridge_ways=[] if args.no_cuttings else [(LineString(w["pts"]), w["w"]) for w in ways if w["kind"] == "bridge" and len(w["pts"]) > 1],
                                      drawn=drawn_walls(local), level_across=not args.no_level,
                                      cuts=[LineString(w["pts"]).buffer(w["w"] / 2) for w in ways if w.get("cut")], sharp=args.lidar_ground,
                                      scan=ipr_lidar.range_sampler(options["survey_scan"])[0] if options.get("survey_scan") else None,
                                      sunk_kerbs=not args.no_sunk_kerbs, scan_levels=not args.no_scan_levels)
        labels, terraces = surveyed.pop("labels"), surveyed.pop("terraces")
        print(f"  survey: {surveyed}")
        timings.lap("survey")
    # Bridges and tunnels, above and below the bare ground (structures.py).
    merged = unary_union(outlines) if outlines else None
    way_levels, steep = [], {}
    found = structures.build(ways, list(getattr(merged, "geoms", [merged])) if merged else [], roads, sampler(tiles, N, T, step, gx0, gy0, labels),
                             local, tiles, N, T, step, gx0, gy0, boxes, way_levels=way_levels, ramps_out=steep,
                             streets=[line for line, _ in streets.values()])
    # Where a bridge is close over the ground (at its ends) the ground comes up, or down,
    # to it: wholly within NEAR_DECK of it, less and less out to OFF_DECK. The map's bridge
    # and the street it runs on from rarely meet where the terrain says the abutment is,
    # and the ground between them was left crumpled.
    met = 0
    if not args.no_survey:
        # The street's last metres before a bridge drawn from past its wall's edge: a flat
        # terrace at the bridge's height, with its outline (smaller than a lattice cell,
        # mostly, so the lattice alone couldn't say it).
        ring = lambda r: np.round(shapely.get_coordinates(r)[:-1], 2).tolist()  # noqa: E731
        lifted = 0
        for pad, height in structures.pads(ways):
            bx0, by0, bx1, by1 = pad.bounds
            for i in range(math.floor((bx0 - gx0) / T), math.floor((bx1 - gx0) / T) + 1):
                for j in range(math.floor((by0 - gy0) / T), math.floor((by1 - gy0) / T) + 1):
                    arr = tiles.get((i, j))
                    if arr is None:
                        continue
                    here = [q for q in shapely.get_parts(pad.intersection(boxes[(i, j)])) if q.geom_type == "Polygon" and q.area > 0.5]
                    listed = terraces.setdefault((i, j), [])
                    label = max([t["label"] for t in listed] + [1]) + 1
                    if not here or label > 255:
                        continue
                    listed.append({"label": label, "h": round(height, 2), "polys": [[ring(q.exterior), *(ring(r) for r in q.interiors)] for q in here]})
                    xs, ys = np.meshgrid(gx0 + i * T + np.arange(N + 1) * step, gy0 + j * T + np.arange(N + 1) * step)
                    on = shapely.contains_xy(pad, xs, ys)
                    arr[on] = height
                    labels.setdefault((i, j), np.zeros((N + 1, N + 1), dtype=np.uint8))[on] = label
                    lifted += 1
        print(f"  {lifted} flat terraces under the street before bridges drawn from past their wall")
        met = pull_to_bridges(tiles, labels, found, N)
        print(f"  ground brought to the bridges' ends at {met} points")
    timings.lap("bridges_tunnels")
    # Trial: the steps as lines with the ground's height either side (step_lines.py), read
    # from the scan where it's the ground, else from the lattice's own side.
    lines_by_tile = {}
    if args.step_lines and labels:
        own = step_lines.lattice_reader(tiles, labels, N, T, step, gx0, gy0)
        read = (lambda xs, ys, label: own(xs, ys, label) if label == step_lines.WATER else lidar_at(xs, ys)) if args.lidar_ground else own
        kerbs = [line.buffer(half, cap_style="flat") for line, half in streets.values()]
        tree = shapely.STRtree(kerbs)
        def driven(xs, ys):
            on = np.zeros(len(xs), dtype=bool)
            hit, _ = tree.query(shapely.points(xs, ys), predicate="within")
            on[hit] = True
            return on
        for key, listed in terraces.items():
            got = step_lines.for_tile(boxes[key].bounds, tile_water.get(key, []), listed, read, driven)
            if got:
                lines_by_tile[f"{key[0]}_{key[1]}"] = got
        print(f"  {sum(len(v) for v in lines_by_tile.values())} step lines, {sum(len(l['pts']) for v in lines_by_tile.values() for l in v)} points")
        timings.lap("step_lines")
    # The heights, then each point's label as a byte (dtm_heights.py): 0 the plain ground,
    # 1 water, 2 and up the tile's terraces. A bank or a retaining wall is a step in the
    # ground: the game reads the height by one from the points with the same label alone.
    plain = np.zeros((N + 1, N + 1), dtype=np.uint8)
    # (Decimetres; centimetres with --lidar-ground on a lattice under 3 m. On a 4 m one
    # they add nothing: with the LiDAR through it, 0.30 % of the street middle lines'
    # metres have a wave over 0.1 m within 2 m in decimetres and 0.29 % in centimetres,
    # and the heights take twice the room.)
    unit = 0.01 if args.lidar_ground and step < 3 else 0.1
    encode = lambda a, label: np.clip(np.round((a - 100) / unit), 0, 65535).astype("<u2").tobytes() + label.astype(np.uint8).tobytes()  # noqa: E731
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
            # (`ramps`: the level's stairs and other ways too steep for the lattice, each with its own profile.)
            per_tile[k] = [{"level": lv, "kind": kind, "polys": polys, **({"ramps": steep[(i, j)][lv]} if steep.get((i, j), {}).get(lv) else {})}
                           for lv, kind, _, polys in found[(i, j)]]
        else:
            layers.remove_bin(out_dir / "tiles", f"{k}.levels.bin")
        # From before: one deck level, and before that the bare ground kept where
        # bridges were raised into it.
        layers.remove_bin(out_dir / "tiles", f"{k}.deck.bin")
        layers.remove_bin(out_dir / "tiles", f"{k}.bare.bin")
    if inputs != layers.stage_inputs(area, "terrain", options):
        raise RuntimeError("terrain sources or processing code changed; keep output staged and rebuild")
    terrain_index = {"step": step, "n": N + 1, "min": float(lo), "max": float(hi), "structures": sorted(per_tile), "wayLevels": True}
    if args.ipr_lidar:
        terrain_index["lidar"] = lidar_source
    if unit != 0.1:
        terrain_index["unit"] = unit
    layers.write_layer(area, "terrain", {"gzip": True, "tile": T, "made_for": [f"{i}_{j}" for i, j in tiles], "tiles": per_tile,
                                         "terraces": {f"{i}_{j}": v for (i, j), v in terraces.items()},
                                         **({"steplines": lines_by_tile} if lines_by_tile else {}),
                                         # Each bridge or tunnel way's level, for the streets and tram tracks on them (structures.OnLevels).
                                         "ways": way_levels,
                                         **inputs, "payloads": payloads, "index": terrain_index})
    print(f"terrain {lo:.0f}–{hi:.0f} m for {len(tiles)} tiles")
    timings.lap("encode_write")
    if not args.no_assemble:
        layers.assemble(area)
    timings.lap("assembly")
    timings.out["total"] = time.perf_counter() - command_started
    build_cache.report_times(f"{area} ipr_terrain", timings.out)


if __name__ == "__main__":
    main()
