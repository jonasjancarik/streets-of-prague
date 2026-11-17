"""The tile pass of the terrain (docs/terrain-tin-plan.md, "The move off the lattice"):
each tile's ground as a triangulated mesh fitted to a surface every 0.5 m, written as
tiles/<k>.tin.bin.gz beside the lattice. The game draws the ground from it wherever a
tile has one.

    uv run tin_tiles.py ujezd [--data ../public/data] [--no-lidar] [--tiles i_j,…]

Run it on a built map whose terrain came from `ipr_terrain.py --tin` (the city pass: the
walls' outlines with straight tops, which the mesh keeps as breaklines). Per tile:

1. scripts/tin-target.mjs reads the built tile through the game's own sampler, so the
   city pass comes as the game draws it: every 0.5 m the height on its own side of each
   step, the side, whether it is paved, and the steps' outlines with each side's height.
2. The surface (`surface`):
   - water flat at its level, and pads (the flat terraces at bridge ends) flat at theirs;
   - paved ground the 2023 LiDAR as it is; within NEAR m of it on unpaved ground the
     LiDAR smoothed over SMOOTH m (as it is, the grass and hedges beside a street came
     out in scribbles). Without the LiDAR (`--no-lidar`) the city pass's streets;
   - open ground IPR's dense terrain model, its own triangles, from NEAR + BLEND m off
     paved ground, blending between; and within STEEP_NEAR m of a face the LiDAR has and
     the city pass hasn't (Smetanovo nábřeží's quay wall, a ramp on the lattice), IPR's
     dense model on paved ground too: it has the wall's top along a straight breakline,
     where the LiDAR's 1 m cells make a sawtooth of it;
   - within NEAR m of a wall the city pass, blending over BLEND m: the walls' foot and
     top still come from the lattice (step 4 of the plan moves them to points).
3. The breaklines: the walls' outlines with each side's height; an outline whose sides
   are less than STEP_REAL m apart (a terrace's edge along a kerb, not a wall) takes the
   surface's height on both; the survey's kerbs with the surface's height on both sides
   (raised kerbs wait for a gameplay pass).
4. `tin.build` fits the mesh, TOL m on paved ground and LOOSE m elsewhere, and
   `tin.write` writes the tile's file (its format is there).

The surfaces are kept in .cache/tin/<map>/surface for looking at. The mesh files go
straight into the assembled map and index.json lists them under `tin`; the map's own
assembly (layers.assemble) doesn't know them yet, so run this again after it.
"""
from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import time
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from pyproj.enums import TransformDirection
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates, maximum_filter, minimum_filter
from scipy.spatial import cKDTree

import build_cache
import dtm_heights
import ipr_lidar
import ipr_terrain
import tin
from ipr_buildings import krovak_to_local, sheet, sheet_name
from osm_area import AREAS, OUT

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WATER = 1
NEAR = 2.0  # m: from paved ground (the LiDAR) and from a wall (the city pass)
BLEND = 2.0  # m over which each gives way to what is further out
SMOOTH = 1.5  # m: the Gaussian over the LiDAR on unpaved ground
STEP_REAL = 0.3  # m between an outline's two sides: less, and it is no wall
PAD = 10  # samples read past the tile for the smoothing, so neighbours smooth alike
STEEP = 1.0  # m: the LiDAR rising this much within a metre is a wall's face (one the city pass has no outline for)
STEEP_NEAR = 1.5  # m round such a face where IPR's dense model takes over from the LiDAR
KERB = "010000030402"  # the survey's kerb (DTM ZPS, set 3)
KERB_EVERY = 0.5  # m between the points taken along a kerb
KERB_CLEAR = 0.5  # m: a kerb this near a step's outline is the outline's
KERB_LEAST = 1.0  # m: shorter pieces of kerb are left out
TOL, LOOSE = 0.10, 0.25


def local_crs(area: str) -> str:
    w, s, e, n = AREAS[area]
    return f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"


class LocalToKrovak:
    """The game's local metres → S-JTSK, the reverse of ipr_buildings.krovak_to_local."""

    def __init__(self, local):
        self.to_wgs = Transformer.from_crs(local, "EPSG:4326", always_xy=True)
        self.wgs_krovak = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                               area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))

    def transform(self, x, y):
        lon, lat = self.to_wgs.transform(x, y)
        return self.wgs_krovak.transform(lon, lat, direction=TransformDirection.INVERSE)


class DenseSheets:
    """IPR's dense terrain model (its Shapefile sheets), each sheet's triangles in local
    metres once it's asked for."""

    def __init__(self, local):
        self.to_local = krovak_to_local(local)
        self.to_krovak = LocalToKrovak(local)
        self.sheets: dict[str, tuple[np.ndarray, np.ndarray] | None] = {}

    def names(self, box, margin=5.0):
        x0, y0, x1, y1 = box
        xs = np.linspace(x0 - margin, x1 + margin, 6)
        ys = np.linspace(y0 - margin, y1 + margin, 6)
        X, Y = np.meshgrid(xs, ys)
        kx, ky = self.to_krovak.transform(X.ravel(), Y.ravel())
        return sorted({n for n in (sheet_name(*sheet(a, b)) for a, b in zip(kx, ky)) if n})

    def sheet(self, name):
        if name not in self.sheets:
            path = ipr_terrain.CACHE / f"TER_{name}_shp.zip"
            if not path.exists():
                print(f"  (no dense sheet {path.name})")
                self.sheets[name] = None
            else:
                t = ipr_terrain.shp_triangles(path)
                lx, ly = self.to_local.transform(t[:, :, 0].ravel(), t[:, :, 1].ravel())
                t = np.stack([np.reshape(lx, t.shape[:2]), np.reshape(ly, t.shape[:2]), t[:, :, 2]], axis=2)
                lo, hi = t[:, :, :2].min(1), t[:, :, :2].max(1)
                self.sheets[name] = (t, np.c_[lo, hi])
        return self.sheets[name]

    def heights(self, box, nx, ny, g):
        """The model's height at each sample of the tile's grid, NaN where it has none."""
        x0, y0, x1, y1 = box
        grid = np.full((ny, nx), np.nan)
        for name in self.names(box):
            got = self.sheet(name)
            if got is None:
                continue
            t, bb = got
            sel = (bb[:, 2] >= x0 - 1) & (bb[:, 0] <= x1 + 1) & (bb[:, 3] >= y0 - 1) & (bb[:, 1] <= y1 + 1)
            if sel.any():
                ipr_terrain.rasterise(t[sel], x0, y0, nx, ny, g, grid)
        return grid


def kerb_lines(area: str, local: str):
    """The survey's kerbs round the area, in local metres: a list of (n, 2) arrays."""
    packages = sorted(dtm_heights.LINES.glob("*.zip"))
    cache = HERE / ".cache" / "tin" / f"kerbs-{area}.pkl"
    key = [1, [build_cache.identity(p) for p in packages], list(AREAS[area]), KERB, build_cache.function_key(kerb_lines)]
    got = build_cache.load_pickle(cache, key)
    if got:
        return got["lines"]
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    w, s, e, n = AREAS[area]
    cx, cy = to_krovak.transform([w, w, e, e], [s, n, s, n])
    box = (min(cx) - 60, min(cy) - 60, max(cx) + 60, max(cy) + 60)
    to_local = krovak_to_local(local)
    lines = []
    for p in packages:
        for _, level, blob in dtm_heights._tables(p, {KERB: "kerb"}):
            g = dtm_heights._inside(blob, box) if level == 0 else None
            if g is None:
                continue
            for part in shapely.get_parts(g):
                c = shapely.get_coordinates(part)
                if len(c) >= 2:
                    lx, ly = to_local.transform(c[:, 0], c[:, 1])
                    lines.append(np.c_[lx, ly])
    import pickle
    cache.parent.mkdir(parents=True, exist_ok=True)
    build_cache.atomic(cache, pickle.dumps({"key": key, "lines": lines}, protocol=5))
    return lines


def read_target(tdir: Path, k: str):
    f = tdir / f"{k}.json"
    if not f.exists():
        return None
    meta = json.loads(f.read_text())
    nx, ny = meta["nx"], meta["ny"]
    raw = (tdir / f"{k}.grid.bin").read_bytes()
    h = np.frombuffer(raw, np.float32, nx * ny).reshape(ny, nx).astype(float)
    side = np.frombuffer(raw, np.uint8, nx * ny, offset=4 * nx * ny).reshape(ny, nx)
    paved = np.frombuffer(raw, np.uint8, nx * ny, offset=5 * nx * ny).reshape(ny, nx).astype(bool)
    lines = np.frombuffer((tdir / f"{k}.lines.bin").read_bytes(), np.float32).reshape(-1, 6).astype(float)
    return dict(meta=meta, raw=raw, h=h, side=side, paved=paved, lines=lines)


def padded(targets, meta, field, pad):
    """A field of the tile's target (`paved`) with `pad` samples round it from its
    neighbours, placed by their boxes (an area's last row and column of tiles are
    narrower); False where there is no neighbour."""
    nx, ny, g = meta["nx"], meta["ny"], meta["grid"]
    x0, y0 = meta["box"][:2]
    out = np.zeros((ny + 2 * pad, nx + 2 * pad), bool)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            n = targets(meta["i"] + di, meta["j"] + dj)
            if n is None:
                continue
            c0 = int(round((n["meta"]["box"][0] - x0) / g)) + pad
            r0 = int(round((n["meta"]["box"][1] - y0) / g)) + pad
            a = n[field]
            rs, cs = max(0, -r0), max(0, -c0)
            re, ce = min(a.shape[0], out.shape[0] - r0), min(a.shape[1], out.shape[1] - c0)
            if re > rs and ce > cs:
                out[r0 + rs:r0 + re, c0 + cs:c0 + ce] |= a[rs:re, cs:ce]
    return out


def kerbs_in(kerbs, box, lines, side, g):
    """The kerbs inside a tile as runs of points KERB_EVERY m apart, clear of the steps'
    outlines and the water, each with the side it is on."""
    x0, y0, x1, y1 = box
    clip = shapely.box(x0, y0, x1, y1)
    out = []
    step_tree = cKDTree(lines[:, :2]) if len(lines) else None
    ny, nx = side.shape
    for c in kerbs:
        if c[:, 0].max() < x0 or c[:, 0].min() > x1 or c[:, 1].max() < y0 or c[:, 1].min() > y1:
            continue
        for part in shapely.get_parts(shapely.intersection(shapely.linestrings(c), clip)):
            if part.geom_type != "LineString" or part.length < KERB_LEAST:
                continue
            n = max(2, int(np.ceil(part.length / KERB_EVERY)) + 1)
            p = shapely.get_coordinates(shapely.line_interpolate_point(part, np.linspace(0, part.length, n)))
            gi = np.clip(np.round((p[:, 0] - x0) / g).astype(int), 0, nx - 1)
            gj = np.clip(np.round((p[:, 1] - y0) / g).astype(int), 0, ny - 1)
            s = side[gj, gi].astype(int)
            ok = s != WATER
            if step_tree is not None:
                ok &= step_tree.query(p)[0] >= KERB_CLEAR
            # Runs of points that are clear and on one side.
            start = None
            for m in range(len(p) + 1):
                if m < len(p) and ok[m] and (start is None or s[m] == s[start]):
                    if start is None:
                        start = m
                    continue
                if start is not None and m - start >= 2 and (m - start - 1) * KERB_EVERY >= KERB_LEAST - 1e-9:
                    out.append((p[start:m], int(s[start])))
                start = m if m < len(p) and ok[m] else None
    return out


def surface(t, targets, dense, scan_at, pads, kerbs):
    """The tile's surface and breaklines (the module's docstring, step 2 and 3)."""
    meta, h, side, paved, lines = t["meta"], t["h"], t["side"], t["paved"], t["lines"]
    nx, ny, g = meta["nx"], meta["ny"], meta["grid"]
    x0, y0, x1, y1 = meta["box"]
    i, j = meta["i"], meta["j"]
    gx = np.where(np.arange(nx) == nx - 1, x1, x0 + np.arange(nx) * g)
    gy = np.where(np.arange(ny) == ny - 1, y1, y0 + np.arange(ny) * g)
    X, Y = np.meshgrid(gx, gy)
    # How far each sample is from paved ground and from a wall, the neighbours' too.
    reach = int(np.ceil((NEAR + BLEND) / g)) + 2
    d_paved = distance_transform_edt(~padded(targets, meta, "paved", reach))[reach:-reach, reach:-reach] * g
    walls = [w for a in (-1, 0, 1) for b in (-1, 0, 1) if (n := targets(i + a, j + b)) is not None
             for w in [n["lines"][np.abs(n["lines"][:, 2] - n["lines"][:, 3]) >= STEP_REAL]] if len(w)]
    walls = np.concatenate(walls) if walls else np.zeros((0, 6))
    d_wall = cKDTree(walls[:, :2]).query(np.c_[X.ravel(), Y.ravel()], distance_upper_bound=NEAR + BLEND + 1)[0].reshape(ny, nx) if len(walls) else np.full((ny, nx), np.inf)
    far = dense.heights(meta["box"], nx, ny, g)
    have = np.isfinite(far)
    far = np.where(have, far, h)
    if scan_at is not None:
        px = x0 + (np.arange(nx + 2 * PAD) - PAD) * g
        py = y0 + (np.arange(ny + 2 * PAD) - PAD) * g
        PX, PY = np.meshgrid(px, py)
        sp = np.asarray(scan_at(PX.ravel(), PY.ravel()), float).reshape(PY.shape)
        ok = np.isfinite(sp)
        num = gaussian_filter(np.where(ok, sp, 0.0), SMOOTH / g, mode="nearest")
        den = gaussian_filter(ok.astype(float), SMOOTH / g, mode="nearest")
        with np.errstate(invalid="ignore", divide="ignore"):
            soft = np.where(den > 0.2, num / den, np.nan)[PAD:-PAD, PAD:-PAD]
        raw = sp[PAD:-PAD, PAD:-PAD]
        street = np.where(paved, raw, soft)
        street = np.where(np.isfinite(street), street, h)
        # (A face in the LiDAR: its rise within a metre, 3 × 3 samples.)
        rise = maximum_filter(np.where(ok, sp, -np.inf), size=3) - minimum_filter(np.where(ok, sp, np.inf), size=3)
        d_face = distance_transform_edt(~(np.isfinite(rise) & (rise > STEEP)))[PAD:-PAD, PAD:-PAD] * g
        wf = np.clip(STEEP_NEAR + 1 - d_face, 0, 1) * have
        street = street * (1 - wf) + far * wf
    else:
        street = h
    wp = np.clip((d_paved - NEAR) / BLEND, 0, 1)
    away = street * (1 - wp) + far * wp
    ws = np.clip((d_wall - NEAR) / BLEND, 0, 1) * (side != WATER) * ~np.isin(side, list(pads))
    new = h * (1 - ws) + away * ws
    # An outline that is no wall takes the new ground's height on both sides: with the
    # lattice's it pinned a crease along the lattice's zigzag.
    lines = lines.copy()
    flat = np.abs(lines[:, 2] - lines[:, 3]) < STEP_REAL
    if flat.any():
        at = map_coordinates(new, [(lines[flat, 1] - y0) / g, (lines[flat, 0] - x0) / g], order=1, mode="nearest")
        lines[flat, 2] = at
        lines[flat, 3] = at
    runs = kerbs_in(kerbs, meta["box"], lines, side, g)
    kerb_rows = []
    for p, s in runs:
        hk = map_coordinates(new, [(p[:, 1] - y0) / g, (p[:, 0] - x0) / g], order=1, mode="nearest")
        kerb_rows.append(np.c_[p, hk, hk, np.full(len(p), s), np.full(len(p), s)])
    stats = dict(ipr=float((ws * wp * have).mean()), lidar=float((ws * (1 - wp) * (scan_at is not None)).mean()),
                 kerbs=len(runs), kerb_m=round(sum((len(p) - 1) * KERB_EVERY for p, _ in runs)),
                 moved=float(np.median(np.abs(new - h)[ws > 0])) if (ws > 0).any() else 0.0)
    return new.astype(np.float32), lines, kerb_rows, stats


def write_surface(out: Path, t, new, lines, kerb_rows):
    nx, ny = t["meta"]["nx"], t["meta"]["ny"]
    k = t["meta"]["k"]
    (out / f"{k}.grid.bin").write_bytes(new.tobytes() + t["raw"][4 * nx * ny:])
    (out / f"{k}.lines.bin").write_bytes(lines.astype(np.float32).tobytes())
    kr = np.concatenate(kerb_rows) if kerb_rows else np.zeros((0, 6))
    (out / f"{k}.kerbs.bin").write_bytes(kr.astype(np.float32).tobytes())
    meta = dict(t["meta"], kerbs=[len(r) for r in kerb_rows])
    (out / f"{k}.json").write_text(json.dumps(meta))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("map", help="the map's folder name without _now (ujezd, praha, or a copy such as ujezd-lidar)")
    ap.add_argument("--data", type=Path, default=OUT)
    ap.add_argument("--no-lidar", action="store_true", help="paved ground from the city pass, not the 2023 LiDAR")
    ap.add_argument("--tiles", help="i_j,… (default all)")
    ap.add_argument("--tol", type=float, default=TOL)
    ap.add_argument("--loose", type=float, default=LOOSE)
    ap.add_argument("--keep-target", action="store_true", help="reuse the last tin-target.mjs output")
    a = ap.parse_args()
    folder = a.data.resolve() / f"{a.map}_now"
    index = json.loads((folder / "index.json").read_text())
    area = index["area"]
    local = local_crs(area)
    work = HERE / ".cache" / "tin" / a.map
    target = work / "target"
    t0 = time.time()
    if not (a.keep_target and target.exists()):
        if target.exists():
            shutil.rmtree(target)
        cmd = ["node", str(ROOT / "scripts" / "tin-target.mjs"), a.map, "--data", str(a.data.resolve()), "--out", str(work)]
        if a.tiles:
            # (The neighbours too: the distances to paved ground and walls reach across.)
            want = set()
            for kk in a.tiles.split(","):
                i, j = map(int, kk.split("_"))
                want |= {f"{i + di}_{j + dj}" for di in (-1, 0, 1) for dj in (-1, 0, 1)}
            have = {p.name[:-5] for p in (folder / "tiles").glob("*_*.json")}
            cmd += ["--tiles", ",".join(sorted(want & have))]
        subprocess.run(cmd, check=True)
        (work / a.map).rename(target)
    print(f"target: {time.time() - t0:.1f} s", flush=True)
    cache: dict[tuple[int, int], dict | None] = {}

    def targets(i, j):
        if (i, j) not in cache:
            cache[(i, j)] = read_target(target, f"{i}_{j}")
        return cache[(i, j)]

    keys = a.tiles.split(",") if a.tiles else sorted(p.stem for p in target.glob("*.json"))
    dense = DenseSheets(local)
    scan_at = None if a.no_lidar else ipr_lidar.sampler(ipr_lidar.CACHE, local)[0]
    kerbs = kerb_lines(area, local)
    surf = work / ("surface-nolidar" if a.no_lidar else "surface")
    if surf.exists():
        shutil.rmtree(surf)
    surf.mkdir(parents=True)
    tiles_dir = folder / "tiles"
    rows, total = [], dict(points=0, extra=0, breaklines=0, bytes=0, seconds=0.0)
    for k in keys:
        t1 = time.time()
        i, j = map(int, k.split("_"))
        t = targets(i, j)
        if t is None:
            continue
        tj = json.loads((tiles_dir / f"{k}.json").read_text())
        pads = {int(x["label"]) for x in tj.get("terraces") or [] if "h" in x}
        new, lines, kerb_rows, stats = surface(t, targets, dense, scan_at, pads, kerbs)
        write_surface(surf, t, new, lines, kerb_rows)
        t2 = time.time()
        res = tin.build(surf, k, a.tol, a.loose)
        body = tin.write(res)
        (tiles_dir / f"{k}.tin.bin.gz").write_bytes(gzip.compress(body, 9))
        check = tin.label_check(res)
        row = dict(k=k, points=len(res["P"].xy), extra=sum(len(x) - 1 for x in res["P"].h), breaklines=len(res["steps"]),
                   bytes=len(gzip.compress(body, 9)), err=round(res["err"], 3), err_paved=round(res["err_paved"], 3),
                   near_worst=round(float(res["near_err"].max()), 3) if len(res["near_err"]) else 0.0,
                   labels_off=check[0], labels_off_m2=round(check[1], 2), **{s: round(v, 3) if isinstance(v, float) else v for s, v in stats.items()},
                   surface_s=round(t2 - t1, 1), fit_s=round(time.time() - t2, 1))
        rows.append(row)
        for f in ("points", "extra", "breaklines", "bytes"):
            total[f] += row[f]
        total["seconds"] += time.time() - t1
        print(json.dumps(row), flush=True)
    done = sorted(p.name[: -len(".tin.bin.gz")] for p in tiles_dir.glob("*.tin.bin.gz"))
    index["tin"] = dict(format=tin.FORMAT, tol=a.tol, loose=a.loose, lidar=not a.no_lidar, tiles=done)
    (folder / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    (work / ("report-nolidar.json" if a.no_lidar else "report.json")).write_text(json.dumps(dict(rows=rows, total=total), indent=1))
    print(json.dumps(dict(map=a.map, tiles=len(rows), **{f: round(v, 1) for f, v in total.items()})))


if __name__ == "__main__":
    main()
