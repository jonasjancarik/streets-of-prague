"""The tile pass of the terrain (docs/terrain-tin-plan.md, "The move off the lattice"):
each tile's ground as a triangulated mesh fitted to a surface every 0.5 m, written as
tiles/<k>.tin.bin.gz beside the lattice. The game draws the ground from it wherever a
tile has one.

    uv run tin_tiles.py ujezd [--data ../public/data] [--no-lidar] [--tiles i_j,…] [--jobs N]

The target and the tiles are made in --jobs processes side by side (all cores but one
by default), each taking blocks of BLOCK tiles.

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
   - where the LiDAR is more than AGREE m off the city pass (wholly from twice that) and
     IPR's dense model doesn't bear it out, the city pass: a hole in the scan (4 m deep on
     Československého exilu). And the city pass, whatever the dense model says, on each
     patch where the two are more than AGREE m apart that reaches a face in the LiDAR
     across the middle of a car street, or of any street or path within BRIDGE_NEAR m of
     a bridge, out to HELD_REACH m from the face: a wall both models have, which OSM
     draws a street across (Sekaninova), and the ground under a deck where OSM ends a
     bridge short of its abutment (the ends of Hlávkův most, Čechův most and 5. května
     over Hvězdova came out 3–4.5 m below their decks). A patch with no such face is the
     city pass's own mistake and keeps the LiDAR (a pit 2 m deep in Národní). Divadelní,
     down its cutting to the car park, has its walls beside the street, not across it,
     but the dense model hasn't the cutting either, so the first rule gives it the city
     pass's ground, as on the lattice (which has the LiDAR's road down to the underpass
     since November 2026: dtm_heights._scan_streets). A patch is held the same way, face or not, where a
     car street's middle has the city pass more than ALOFT m over the LiDAR away from
     tunnels (a deck the map calls ground; its patch out to ALOFT_REACH m, the slip roads
     coming down off it), and within LANDING m of where a bridge's way
     comes down onto a way on the ground (the decks are the city pass's); a held patch is
     the city pass off paved ground too. And a car street's carriageway (from kerb to
     kerb, not under decks or in tunnels) is the city pass plus the LiDAR's small offsets
     from it, smoothed over ROAD_SMOOTH m along the road; where the LiDAR is more than
     AGREE m off and IPR's dense model bears it out, the LiDAR (the city pass wrong, Pod
     Stárkou), and where the dense model doesn't, the road round it (a bank or a ramp
     beside the road inside OSM's width); a stretch more than ROAD_FAR m off along the
     road is left to the rules above;
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
import os
import shutil
import subprocess
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from pyproj.enums import TransformDirection
from scipy.ndimage import distance_transform_edt, gaussian_filter, label, map_coordinates, maximum_filter, minimum_filter
from scipy.spatial import cKDTree

import build_cache
import tin_record
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
PAD = 40  # samples read past the tile for the smoothing and the held patches (HELD_REACH and some), so neighbours come out alike
STEEP = 1.0  # m: the LiDAR rising this much within a metre is a wall's face (one the city pass has no outline for)
STEEP_NEAR = 1.5  # m round such a face where IPR's dense model takes over from the LiDAR
AGREE = 0.5  # m: the LiDAR further than this from the city pass (and IPR's dense model) gives way, wholly from twice it
ROAD_SMOOTH = 2.0  # m: the Gaussian along a carriageway over how far the LiDAR is off the city pass
ROAD_FAR = 2.5  # m: the LiDAR further than this off the city pass along a carriageway is left to the other rules
ROAD_RAMP = 12.0  # m past a bridge's landing over which a carriageway comes back to the city pass
HELD_GROW = 1.0  # m round where it gives way that it does so too, so the change lies where the two agree
BRIDGE_NEAR = 8.0  # m round the map's bridges where a face in the LiDAR holds the city pass (both models are bare earth)
HELD_REACH = 15.0  # m from such a face (or one across a car street) that the patch it holds reaches
ALOFT = 3.0  # m: the city pass this far over the LiDAR on a car street's middle is a deck the map calls ground
TUNNEL_NEAR = 15.0  # m round a tunnel where it is not: the ramp down to the portal, in its cutting
ALOFT_REACH = 60.0  # m from such a middle that its patch reaches: the slip roads coming down off it
LANDING = 6.0  # m round where a bridge's way comes down onto a way on the ground: the city pass, to meet the deck
MIDDLE = 1.0  # m either side of a street's line: a face there crosses it (one further out runs beside it)
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
    metres once it's asked for; the last KEEP sheets asked for are kept (a city's don't
    fit in memory in every process)."""

    KEEP = 12

    def __init__(self, local):
        self.to_local = krovak_to_local(local)
        self.to_krovak = LocalToKrovak(local)
        self.sheets: OrderedDict[str, tuple[np.ndarray, np.ndarray] | None] = OrderedDict()

    def names(self, box, margin=5.0):
        x0, y0, x1, y1 = box
        xs = np.linspace(x0 - margin, x1 + margin, 6)
        ys = np.linspace(y0 - margin, y1 + margin, 6)
        X, Y = np.meshgrid(xs, ys)
        kx, ky = self.to_krovak.transform(X.ravel(), Y.ravel())
        return sorted({n for n in (sheet_name(*sheet(a, b)) for a, b in zip(kx, ky)) if n})

    def sheet(self, name):
        if name in self.sheets:
            self.sheets.move_to_end(name)
        else:
            while len(self.sheets) >= self.KEEP:
                self.sheets.popitem(last=False)
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


class Kerbs:
    """The area's kerbs with each line's box, to pick a tile's without looking at them all."""

    def __init__(self, lines):
        self.lines = lines
        self.box = np.array([[c[:, 0].min(), c[:, 1].min(), c[:, 0].max(), c[:, 1].max()] for c in lines]).reshape(-1, 4)

    def near(self, box):
        """The lines whose box reaches the tile's, in their order."""
        x0, y0, x1, y1 = box
        b = self.box
        return [self.lines[n] for n in np.nonzero((b[:, 2] >= x0) & (b[:, 0] <= x1) & (b[:, 3] >= y0) & (b[:, 1] <= y1))[0]]


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
    """A field of the tile's target (`paved`, `h`) with `pad` samples round it from its
    neighbours, placed by their boxes (an area's last row and column of tiles are
    narrower); False or NaN where there is no neighbour."""
    nx, ny, g = meta["nx"], meta["ny"], meta["grid"]
    x0, y0 = meta["box"][:2]
    flag = targets(meta["i"], meta["j"])[field].dtype == bool
    out = np.zeros((ny + 2 * pad, nx + 2 * pad), bool) if flag else np.full((ny + 2 * pad, nx + 2 * pad), np.nan)
    # (The tile itself last: its own values on the rows it shares with a neighbour.)
    for di, dj in sorted(((a, b) for a in (-1, 0, 1) for b in (-1, 0, 1)), key=lambda d: d == (0, 0)):
        n = targets(meta["i"] + di, meta["j"] + dj)
        if n is None:
            continue
        c0 = int(round((n["meta"]["box"][0] - x0) / g)) + pad
        r0 = int(round((n["meta"]["box"][1] - y0) / g)) + pad
        a = n[field]
        rs, cs = max(0, -r0), max(0, -c0)
        re, ce = min(a.shape[0], out.shape[0] - r0), min(a.shape[1], out.shape[1] - c0)
        if re > rs and ce > cs:
            if flag:
                out[r0 + rs:r0 + re, c0 + cs:c0 + ce] |= a[rs:re, cs:ce]
            else:
                out[r0 + rs:r0 + re, c0 + cs:c0 + ce] = a[rs:re, cs:ce]
    return out


def held_ground(tile_of, i, j):
    """Where the city pass is held (`surface`), round tile (i, j), as prepared shapely
    geometries (each None where there is none). `tile_of(key)` gives a tile's JSON or None.
    - "middles": where a face in the LiDAR holds it: the middles of the car streets on
      the ground, and those of every street and path within BRIDGE_NEAR m of one of the
      map's bridges, each MIDDLE m either side of its line;
    - "cars": the car streets' middles alone (the carriageways' rule);
    - "aloft": those further than TUNNEL_NEAR m from a tunnel (ALOFT);
    - "landings": the ways' middles within LANDING m of where a bridge's way comes down
      onto a way on the ground;
    - "carriage": the car streets' carriageways on the ground, kerb to kerb (the survey's
      kerbs where the map measured them, else half the width either side)."""
    bridges, tunnels, cars, ways, sides = [], [], [], [], []
    on_deck, on_ground, at = set(), set(), {}
    for a in (-1, 0, 1):
        for b in (-1, 0, 1):
            tj = tile_of(f"{i + a}_{j + b}")
            if not tj:
                continue
            for s in tj.get("structures") or []:
                if s.get("kind") in ("bridge", "tunnel"):
                    polys = [shapely.Polygon(p[0], p[1:]) for p in s["polys"] if len(p[0]) >= 3]
                    (bridges if s["kind"] == "bridge" else tunnels).extend(polys)
            for kind in ("drive", "walk"):
                for e in tj.get(kind) or []:
                    if len(e["pts"]) < 2 or (e.get("level") or 0) < 0:
                        continue
                    line = shapely.LineString(e["pts"])
                    ways.append(line)
                    deck = bool(e.get("bridge") or e.get("level"))
                    for node, p in ((e.get("u"), e["pts"][0]), (e.get("v"), e["pts"][-1])):
                        if node is not None:
                            (on_deck if deck else on_ground).add(node)
                            at[node] = p
                    if kind == "drive" and not deck:
                        cars.append(line)
                        w = e.get("width") or 6.0
                        kl, kr = [float(x) if x else w / 2 for x in (e.get("kerb") or [w / 2, w / 2])]
                        sides += [shapely.buffer(line, kl, single_sided=True), shapely.buffer(line, -kr, single_sided=True)]
    union = lambda parts: shapely.union_all(shapely.make_valid(np.array(parts, dtype=object))) if parts else None
    car_mid = shapely.buffer(union(cars), MIDDLE, cap_style="flat") if cars else None
    way_mid = shapely.buffer(union(ways), MIDDLE, cap_style="flat") if ways else None
    middles = [car_mid] if car_mid is not None else []
    if bridges and way_mid is not None:
        middles.append(shapely.intersection(way_mid, shapely.buffer(union(bridges), BRIDGE_NEAR)))
    landings = None
    if way_mid is not None and (down := [at[n] for n in on_deck & on_ground]):
        landings = shapely.intersection(way_mid, shapely.buffer(shapely.multipoints(down), LANDING))
    aloft = car_mid
    if car_mid is not None and tunnels:
        aloft = shapely.difference(car_mid, shapely.buffer(union(tunnels), TUNNEL_NEAR))
    out = dict(middles=union(middles), cars=car_mid, aloft=aloft, landings=landings, carriage=union(sides))
    for g in out.values():
        if g is not None:
            shapely.prepare(g)
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


def surface(t, targets, dense, scan_at, pads, kerbs, held_at=None):
    """The tile's surface and breaklines (the module's docstring, step 2 and 3).
    `held_at`: `held_ground`'s streets' middles."""
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
    far_p = dense.heights((x0 - PAD * g, y0 - PAD * g, x1 + PAD * g, y1 + PAD * g), nx + 2 * PAD, ny + 2 * PAD, g)
    far = far_p[PAD:-PAD, PAD:-PAD]
    have = np.isfinite(far)
    far = np.where(have, far, h)
    held = np.zeros((ny, nx))
    if scan_at is not None:
        # (All of it with PAD samples round the tile, so neighbours come out alike at their seam.)
        px = x0 + (np.arange(nx + 2 * PAD) - PAD) * g
        py = y0 + (np.arange(ny + 2 * PAD) - PAD) * g
        PX, PY = np.meshgrid(px, py)
        sp = np.asarray(scan_at(PX.ravel(), PY.ravel()), float).reshape(PY.shape)
        ok = np.isfinite(sp)
        num = gaussian_filter(np.where(ok, sp, 0.0), SMOOTH / g, mode="nearest")
        den = gaussian_filter(ok.astype(float), SMOOTH / g, mode="nearest")
        with np.errstate(invalid="ignore", divide="ignore"):
            soft = np.where(den > 0.2, num / den, np.nan)
        h_p = padded(targets, meta, "h", PAD)
        h_p = np.where(np.isfinite(h_p), h_p, sp)
        street = np.where(padded(targets, meta, "paved", PAD), sp, soft)
        street = np.where(np.isfinite(street), street, h_p)
        lidar = street
        # (A face in the LiDAR: its rise within a metre, 3 × 3 samples.)
        rise = maximum_filter(np.where(ok, sp, -np.inf), size=3) - minimum_filter(np.where(ok, sp, np.inf), size=3)
        d_face = distance_transform_edt(~(np.isfinite(rise) & (rise > STEEP))) * g
        have_p = np.isfinite(far_p)
        wf = np.clip(STEEP_NEAR + 1 - d_face, 0, 1) * have_p
        street = street * (1 - wf) + np.where(have_p, far_p, 0.0) * wf
        # Where the LiDAR parts from the city pass, the city pass, unless IPR's dense model
        # bears the LiDAR out: a hole in the scan. And every patch where the two part that
        # reaches a face in the LiDAR (a rise of STEEP within a metre) across the middle of
        # a car street, or of any street or path near a bridge (`held_ground`), out to
        # HELD_REACH from it, even where the dense model bears the LiDAR out: a street
        # drawn across a wall both models have, the ground under a deck where OSM ends a
        # bridge short of its abutment (both models are bare earth). A patch with no such
        # face is the city pass's own mistake and takes the LiDAR: at Národní, inside Most
        # Legií's outline, a pit 2 m deep on a flat street. (Beside it Divadelní, down the
        # cutting to the car park under the theatre, has no face across it, but the dense
        # model lacks the cutting too, so the first part takes the city pass there: the
        # LiDAR's road down to the underpass, since dtm_heights._scan_streets reaches it.)
        #
        # Three more seeds hold a patch the same way, faces or not:
        # - on a car street's middle, the city pass more than ALOFT over the LiDAR: a deck
        #   the map calls ground (a motorway at the city's north-east edge, 50.1336,
        #   14.6361, and Pražský okruh at 50.0476, 14.2727: both models have flat ground
        #   5–8 m under them). Not within TUNNEL_NEAR of a tunnel: the link road down to
        #   Bubenečský tunel at 50.1136, 14.4327 is in a cutting 6 m deep that both
        #   models have, and the city pass has it level at the top;
        # - within LANDING of where a bridge's way comes down onto a way on the ground: the
        #   decks are the city pass's, and the ground has to meet them (on the lattice the
        #   street's last metres came down a metre to one of Jižní spojka's decks, which
        #   the mesh left a metre over it).
        # And a car street's carriageway, kerb to kerb, has its own rule (below): the
        # city pass's streets are the LiDAR's own, level kerb to kerb
        # (`dtm_heights._scan_streets`), so the road keeps them and takes of the LiDAR
        # only its small offsets, smoothed along the road. Before, each sample took the
        # LiDAR, the city pass or IPR's dense model by itself, and the short blends
        # between them were most of the steps the mesh had and the lattice hadn't.
        geo = held_at or {}
        inside = lambda key: shapely.contains_xy(geo[key], PX, PY) if geo.get(key) is not None else np.zeros(PX.shape, bool)
        near, cars, high, land = inside("middles"), inside("cars"), inside("aloft"), inside("landings")
        with np.errstate(invalid="ignore"):
            off = np.nan_to_num(np.abs(street - h_p))
            alt = np.where(have_p, np.abs(street - far_p), np.inf)
            part = np.nan_to_num(np.clip((np.minimum(off, alt) - AGREE) / AGREE, 0, 1))
            above = np.nan_to_num(h_p - street) > ALOFT
        apart = off > AGREE
        if cars.any():
            # The carriageway: the city pass, and of the LiDAR only how far it is off the
            # city pass, where that is small, smoothed along the road. (The LiDAR itself,
            # not IPR's dense model by a face: a kerb's or a parked car's edge is a face,
            # and on Nad Lávkou the dense model lies 1.4 m over the road both others have.)
            # Where the LiDAR is further off and IPR's dense model bears it out, the city
            # pass is what's wrong (Pod Stárkou, a metre under both), and the road is the
            # LiDAR's; where the dense model doesn't, it is something beside the road inside
            # OSM's width (a bank along Na dražkách, a ramp beside Revoluční by Kotva) and
            # the road round it says. Every weight is smoothed along the road, or the
            # surface flickers between the two from one sample to the next.
            road = inside("carriage")
            sigma = ROAD_SMOOTH / g
            along = lambda v: gaussian_filter(v * road, sigma, mode="nearest")
            cover = np.maximum(along(np.ones(PX.shape)), 1e-6)
            r = np.nan_to_num(lidar - h_p)
            a = np.abs(r)
            w = road * np.clip((AGREE - a) / (AGREE / 2), 0, 1) * np.isfinite(h_p)
            num, den = gaussian_filter(w * r, sigma, mode="nearest"), gaussian_filter(w, sigma, mode="nearest")
            with np.errstate(invalid="ignore", divide="ignore"):
                res = np.where(den > 1e-3, num / den, 0.0)
            backed = np.clip((2 * AGREE - np.where(have_p, np.abs(lidar - far_p), np.inf)) / AGREE, 0, 1)
            wrong = along(np.clip((a - AGREE) / AGREE, 0, 1) * backed) / cover
            # Not where the two are more than ROAD_FAR apart along the road: a deck or a
            # cutting, the rules below.
            trust = road * np.clip((ROAD_FAR - along(a) / cover) / AGREE, 0, 1)
            # Toward a bridge's end the road comes back to the city pass, over ROAD_RAMP m
            # past the landing: the decks are the city pass's, and the LiDAR's offsets kept
            # up to a street's last metres left the joins at Jižní spojka and 5. května
            # 0.6 m apart (0.2 m before).
            if land.any():
                ramp = np.clip(distance_transform_edt(~land) * g / ROAD_RAMP, 0, 1)
                res, wrong = res * ramp, wrong * ramp
            fill = np.nan_to_num(h_p) + res
            mine = fill * (1 - wrong) + lidar * wrong
            street = np.where(np.isfinite(h_p), street * (1 - trust) + mine * trust, street)
            off = np.where(road, np.nan_to_num(np.abs(street - h_p)), off)
            part = part * (1 - trust)
        seed_aloft = apart & high & above
        seed = apart & ((near & (d_face <= g)) | land)
        grow = int(round(HELD_GROW / g))
        soften = lambda w: gaussian_filter(maximum_filter(w, size=2 * grow + 1), grow / 2)
        hold = np.zeros(PX.shape)
        if seed.any() or seed_aloft.any():
            patches, _ = label(apart, structure=np.ones((3, 3)))
            hit = np.unique(patches[seed | seed_aloft])
            reach = np.zeros(PX.shape, bool)
            for s, r in ((seed, HELD_REACH), (seed_aloft, ALOFT_REACH)):
                if s.any():
                    reach |= distance_transform_edt(~s) * g <= r
            mine = np.isin(patches, hit[hit > 0]) & reach
            hold = np.clip((off - AGREE) / AGREE, 0, 1) * mine
            part = np.maximum(part, hold)
        part = soften(part)
        street = np.where(np.isfinite(h_p), street * (1 - part) + np.nan_to_num(h_p) * part, street)
        street, held = street[PAD:-PAD, PAD:-PAD], (part * off)[PAD:-PAD, PAD:-PAD]  # (held: how far it moved)
        street = np.where(np.isfinite(street), street, h)
        # (A held patch is the city pass off paved ground too, where the dense model would
        # come in: that motorway's verges fell 8 m beside its held carriageways.)
        hold = soften(hold)[PAD:-PAD, PAD:-PAD]
        far = far * (1 - hold) + h * hold
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
                 held=float((held[paved] > AGREE).mean()) if paved.any() else 0.0,  # (paved ground moved back to the city pass)
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


BLOCK = (4, 16)  # tiles a process takes at a time, columns by rows: its neighbours and IPR's sheets read once for it
TARGET_RUN = 32  # tiles in a row of the target that one process makes before the next takes over


def blocks(keys, jobs):
    """The tiles in BLOCK-sized blocks, each row by row; smaller blocks where that would
    leave fewer than twice `jobs` (a small area)."""
    ij = sorted(tuple(map(int, k.split("_"))) for k in keys)
    size = BLOCK
    while True:
        out: dict[tuple[int, int], list[tuple[int, int]]] = {}
        for i, j in ij:
            out.setdefault((i // size[0], j // size[1]), []).append((i, j))
        if len(out) >= 2 * jobs or size == (1, 1):
            break
        size = (max(1, size[0] // 2), max(1, size[1] // 2))
    return [[f"{i}_{j}" for i, j in sorted(b, key=lambda t: (t[1], t[0]))] for _, b in sorted(out.items())]


class Pass:
    """One process's share of the tile pass: what it reads, and the targets and tiles it
    keeps while it needs them (a city's don't fit in memory)."""

    def __init__(self, folder, target, surf, area, local, no_lidar, tol, loose):
        self.target, self.surf, self.tiles_dir = Path(target), Path(surf), Path(folder) / "tiles"
        self.tol, self.loose = tol, loose
        self.dense = DenseSheets(local)
        self.scan_at = None if no_lidar else ipr_lidar.sampler(ipr_lidar.CACHE, local)[0]
        self.kerbs = Kerbs(kerb_lines(area, local))
        self.cache: dict[tuple[int, int], dict | None] = {}
        self.tile_json: dict[str, dict | None] = {}

    def targets(self, i, j):
        if (i, j) not in self.cache:
            self.cache[(i, j)] = read_target(self.target, f"{i}_{j}")
        return self.cache[(i, j)]

    def tile_of(self, key):
        if key not in self.tile_json:
            p = self.tiles_dir / f"{key}.json"
            self.tile_json[key] = json.loads(p.read_text()) if p.exists() else None
        return self.tile_json[key]

    def keep(self, i0, j0, i1, j1):
        """Forget the targets and tiles outside columns i0–i1 and rows j0–j1."""
        def out(i, j):
            return not (i0 <= i <= i1 and j0 <= j <= j1)
        for c in [c for c in self.cache if out(*c)]:
            del self.cache[c]
        for c in [c for c in self.tile_json if out(*map(int, c.split("_")))]:
            del self.tile_json[c]

    def tile(self, k):
        """Make tile k's surface and mesh; its report row, or None if it has no target."""
        t1 = time.time()
        i, j = map(int, k.split("_"))
        t = self.targets(i, j)
        if t is None:
            return None
        tj = self.tile_of(k)
        pads = {int(x["label"]) for x in tj.get("terraces") or [] if "h" in x}
        held_at = held_ground(self.tile_of, i, j) if self.scan_at is not None else None
        new, lines, kerb_rows, stats = surface(t, self.targets, self.dense, self.scan_at, pads,
                                               self.kerbs.near(t["meta"]["box"]), held_at)
        write_surface(self.surf, t, new, lines, kerb_rows)
        t2 = time.time()
        res = tin.build(self.surf, k, self.tol, self.loose)
        body = gzip.compress(tin.write(res), 9)
        (self.tiles_dir / f"{k}.tin.bin.gz").write_bytes(body)
        check = tin.label_check(res)
        return dict(k=k, points=len(res["P"].xy), extra=sum(len(x) - 1 for x in res["P"].h), breaklines=len(res["steps"]),
                    bytes=len(body), err=round(res["err"], 3), err_paved=round(res["err_paved"], 3),
                    near_worst=round(float(res["near_err"].max()), 3) if len(res["near_err"]) else 0.0,
                    labels_off=check[0], labels_off_m2=round(check[1], 2), **{s: round(v, 3) if isinstance(v, float) else v for s, v in stats.items()},
                    surface_s=round(t2 - t1, 1), fit_s=round(time.time() - t2, 1))


_PASS: dict[tuple, Pass] = {}


def run_block(job):
    """A block of tiles in one process (`build_cache.parallel_map`): their report rows."""
    setup, keys = job
    if setup not in _PASS:
        _PASS.clear()
        _PASS[setup] = Pass(*setup)
    p = _PASS[setup]
    ij = [tuple(map(int, k.split("_"))) for k in keys]
    i0, i1 = min(i for i, _ in ij), max(i for i, _ in ij)
    j1 = max(j for _, j in ij)
    rows = []
    for k, (i, j) in zip(keys, ij):
        p.keep(i0 - 1, j - 1, i1 + 1, j1 + 1)
        row = p.tile(k)
        if row:
            rows.append(row)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("map", help="the map's folder name without _now (ujezd, praha, or a copy such as ujezd-lidar)")
    ap.add_argument("--data", type=Path, default=OUT)
    ap.add_argument("--no-lidar", action="store_true", help="paved ground from the city pass, not the 2023 LiDAR")
    ap.add_argument("--tiles", help="i_j,… (default all)")
    ap.add_argument("--stale", action="store_true",
                    help="only the tiles whose mesh no longer fits their ground or that have none (layers.py says how many)")
    ap.add_argument("--tol", type=float, default=TOL)
    ap.add_argument("--loose", type=float, default=LOOSE)
    ap.add_argument("--keep-target", action="store_true", help="reuse the last tin-target.mjs output")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1), help="processes side by side")
    ap.add_argument("--work", type=Path, help="where the target, the surface and the report go (default "
                    ".cache/tin/<map>, or <data>/tin-<map> for a map outside public/data, so window builds "
                    "running side by side keep apart)")
    a = ap.parse_args()
    folder = a.data.resolve() / f"{a.map}_now"
    index = json.loads((folder / "index.json").read_text())
    area = index["area"]
    local = local_crs(area)
    work = a.work or (HERE / ".cache" / "tin" / a.map if a.data.resolve() == OUT.resolve() else a.data.resolve() / f"tin-{a.map}")
    work.mkdir(parents=True, exist_ok=True)
    target = work / "target"
    jobs = max(1, a.jobs)
    settings = dict(format=tin.FORMAT, tol=a.tol, loose=a.loose, lidar=not a.no_lidar)
    if a.stale:
        record = tin_record.read(work)
        if record["settings"] != settings:
            record = {"settings": settings, "tiles": {}}
        _, stale = tin_record.fresh(folder / "tiles", index["terrain"], record)
        meshed = {p.name[: -len(".tin.bin.gz")] for p in (folder / "tiles").glob("*.tin.bin.gz")}
        bare = {p.name[: -len(".height.bin.gz")] for p in (folder / "tiles").glob("*.height.bin.gz")} - meshed
        todo = sorted({*stale, *bare}, key=lambda kk: tuple(map(int, kk.split("_"))))
        print(f"{len(stale)} meshes no longer fit and {len(bare)} tiles have none", flush=True)
        if not todo:
            return
        a.tiles = ",".join(todo)
    t0 = time.time()
    if not (a.keep_target and target.exists()):
        for old in (target, work / a.map):
            if old.exists():
                shutil.rmtree(old)
        have = {p.name[:-5] for p in (folder / "tiles").glob("*_*.json")}
        if a.tiles:
            # (The neighbours too: the distances to paved ground and walls reach across.)
            want = set()
            for kk in a.tiles.split(","):
                i, j = map(int, kk.split("_"))
                want |= {f"{i + di}_{j + dj}" for di in (-1, 0, 1) for dj in (-1, 0, 1)}
            have &= want
        order = sorted(have, key=lambda kk: tuple(map(int, kk.split("_"))))
        cmd = ["node", str(ROOT / "scripts" / "tin-target.mjs"), a.map, "--data", str(a.data.resolve()), "--out", str(work)]
        # (Runs of TARGET_RUN tiles dealt out in turn, so each process has some of the dense
        # centre: with one slice each, the four that had it ran 40 minutes past the rest.)
        runs = [order[n:n + TARGET_RUN] for n in range(0, len(order), TARGET_RUN)]
        shares = [[k for r in runs[m::jobs] for k in r] for m in range(min(jobs, len(runs)))]
        procs = [subprocess.Popen(cmd + ["--tiles", ",".join(s)]) for s in shares]
        codes = [p.wait() for p in procs]  # (every one waited for, failed or not)
        if any(codes):
            raise SystemExit("tin-target.mjs failed")
        (work / a.map).rename(target)
    print(f"target: {time.time() - t0:.1f} s", flush=True)

    keys = a.tiles.split(",") if a.tiles else [p.stem for p in target.glob("*.json")]
    kerb_lines(area, local)  # (made once here if it isn't cached, not in every process)
    surf = work / ("surface-nolidar" if a.no_lidar else "surface")
    if surf.exists():
        shutil.rmtree(surf)
    surf.mkdir(parents=True)
    tiles_dir = folder / "tiles"
    setup = (str(folder), str(target), str(surf), area, local, a.no_lidar, a.tol, a.loose)
    rows, total = [], dict(points=0, extra=0, breaklines=0, bytes=0, seconds=0.0)
    t1 = time.time()
    for got in build_cache.parallel_map(run_block, [(setup, b) for b in blocks(keys, jobs)], jobs):
        for row in got:
            rows.append(row)
            for f in ("points", "extra", "breaklines", "bytes"):
                total[f] += row[f]
            total["seconds"] += row["surface_s"] + row["fit_s"]
            print(json.dumps(row), flush=True)
    rows.sort(key=lambda r: tuple(map(int, r["k"].split("_"))))
    total["wall"] = time.time() - t1
    # What each new mesh was made from (tin_record.py), and the meshes that still fit listed.
    record = tin_record.read(work)
    if record["settings"] != settings:
        record = {"settings": settings, "tiles": {}}
    record["tiles"].update(tin_record.inputs(tiles_dir, index["terrain"], [r["k"] for r in rows]))
    tin_record.write(work, record)
    done, stale = tin_record.fresh(tiles_dir, index["terrain"], record)
    if stale:
        print(f"{len(stale)} tiles keep a mesh that no longer fits, left out: run tin_tiles.py {a.map} --stale")
    index["tin"] = dict(**settings, tiles=done)
    out_index = folder / "index.json"
    if out_index.is_symlink():
        out_index.unlink()  # (a window's map links the built map's: its own copy, not that one)
    out_index.write_text(json.dumps(index, separators=(",", ":")))
    (work / ("report-nolidar.json" if a.no_lidar else "report.json")).write_text(json.dumps(dict(rows=rows, total=total), indent=1))
    print(json.dumps(dict(map=a.map, tiles=len(rows), **{f: round(v, 1) for f, v in total.items()})))


if __name__ == "__main__":
    main()
