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
  (not where the map has a tunnel or an underpass and the survey is well below the
  terrain model: that's the street in the underpass, and the ground is the one over it);
- the ground within FEATHER of a surveyed street moves with it: by what the survey
  changed on the street points round about, fading with the distance;
- a lattice point on water takes the water's level: the lowest terrain within WATER_REACH
  on the water, which is the river's surface clear of the banks' ramps, and is marked as
  water (the game reads the height on either side of a bank from that side's points);
- a lattice point on the land beside water, within the terrain model's ramp (BANK), takes
  the height of the nearest surveyed street within STREET_NEAR, or, where a surveyed wall
  runs along the bank, of the nearest land clear of the ramp. A natural bank, with no
  wall, stays the slope it is;
- a surveyed wall on land with the ground well higher on one side than on the other
  (STEP_MIN between points PROBE either side, and no more than that further out: a step,
  not a hillside) is a retaining wall. The lattice points within REACH of it take the
  lowest height the terrain model has out to REACH on their own side below the wall, the
  highest above it, and the strip STRIP wide at the wall's foot is marked as a terrace.

Everything else keeps the terrain model's height, and so do the places listed in
terrain_keep.json: looked at in the game and found worse with the survey than without
(a tangle of ramps and walls the rules above get wrong). Add a place there rather than
bend a rule for it.

The marks are what lets the game make a step of a wall. Each lattice point has a label:
0 the plain ground, 1 water, 2 and up a terrace of its tile, whose outline the tile lists
("terraces"). Where the labels in a lattice cell differ, the game reads the height at a
point from the corners with that point's own label alone (src/terrain.ts), cuts the
ground along the outlines and puts a wall there (src/ground.ts).

Source: DTM kraje – ZPS, datový podklad © IPR Praha (CC BY 4.0).
"""

import pickle
import warnings
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
# Walls, for where they are (a bank with one is a step, not a slope), not for their heights.
WALLS = {"010000030202": "wall edge", "010000016802": "wall"}
VERSION = 3
SPACING = 1.5  # m between the points taken along a surveyed line
ON_EDGE = 0.15  # m: a surveyed point this close to a surface's edge belongs to it
FEATHER = 14.0  # m from a surveyed street: as far as the ground beside it follows it
FEATHER_BLUR = 5.0  # m: over how far the streets' changes are averaged
OVERHANG = 12.0  # m from a surveyed street: a mapped carriageway this near one is the same street, drawn on past its edge
UNDER = 2.0  # m below the terrain model, in a tunnel of the map's: surveyed under the ground
UNDER_SIDE = 4.0  # m either side of the tunnel that counts as in it
FEW = 3  # a surface with fewer surveyed points than this keeps the terrain model's heights
WATER_REACH = 16.0  # m: further than the terrain model's ramp at a bank reaches
AWASH = 0.15  # m above the water: the least the land at its edge is
BANK = 10.0  # m from the water: the land the terrain model's ramp spoils
STREET_NEAR = 8.0  # m: a surveyed street this close gives the bank its height
WALL_NEAR = 6.0  # m: a surveyed wall this close makes the bank a walled one
INLAND = 24.0  # m: how far the land clear of the ramp may be
PIECE = 4.0  # m: a wall is judged piece by piece
PROBE = 7.0  # m either side of a wall: where the ground's heights are compared
STEP_MIN = 1.5  # m between them: a retaining wall
STEP_WEAK = 0.9  # m: still one, along a wall that is one elsewhere
SLOPE = 1.6  # times that much twice as far out, or more: a wall on a hillside, not a step
WATER_CLEAR = 8.0  # m from the water: nearer, the wall is the bank's, which is a step already
BESIDE = 1.5  # m: two wall lines this close are one wall's two faces; the lower one is the step
RUN_MIN = 12.0  # m: shorter stretches of retaining wall are left alone (their ends make more mess than they make steps)
REACH = 10.0  # m either side of a retaining wall: as far as the terrain model's ramp reaches
STRIP = 8.0  # m: the width of the terrace marked at a wall's foot (two lattice cells)


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
    points along the lines measured on the ground as an (n, 3) array, the walls' lines
    as (n, 2) arrays). Kept per area."""
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    w, s, e, n = bbox
    cx, cy = to_krovak.transform([w, w, e, e], [s, n, s, n])
    box = (min(cx) - margin, min(cy) - margin, max(cx) + margin, max(cy) + margin)
    packages = sorted(PACKAGES.glob("*.zip")) + sorted(LINES.glob("*.zip"))
    cache = CACHE / "heights" / f"{area}.pkl"
    key = [VERSION, [build_cache.identity(p) for p in packages], list(bbox), SURFACES, ON_GROUND, WALLS, SPACING,
           [build_cache.function_key(f) for f in (survey, _tables, _inside, _along)], build_cache.runtime_key()]
    got = build_cache.load_pickle(cache, key)
    if got:
        return got["polys"], got["points"], got["walls"]
    print(f"dtm heights: reading the survey from {len(packages)} packages", flush=True)
    polys, points, walls = [], [], []
    for p in sorted(PACKAGES.glob("*.zip")):
        for _, level, blob in _tables(p, SURFACES):
            g = _inside(blob, box) if level == 0 else None
            if g is not None:
                polys.append(shapely.force_2d(g))
    for p in sorted(LINES.glob("*.zip")):
        for code, level, blob in _tables(p, {**ON_GROUND, **WALLS}):
            g = _inside(blob, box) if level == 0 else None
            if g is None:
                continue
            c = shapely.get_coordinates(g, include_z=True)
            if code in WALLS:
                if len(c) > 1:
                    walls.append(c[:, :2].copy())
            elif len(c) > 1 and not np.isnan(c[:, 2]).any():
                points.append(_along(c))
    points = np.concatenate(points) if points else np.zeros((0, 3))
    cache.parent.mkdir(parents=True, exist_ok=True)
    build_cache.atomic(cache, pickle.dumps({"key": key, "polys": polys, "points": points, "walls": walls}, protocol=5))
    return polys, points, walls


def _along(c, spacing=SPACING):
    """A surveyed line's vertices and points every `spacing` metres between them."""
    out = [c[:1]]
    for a, b in zip(c[:-1], c[1:]):
        k = max(1, int(np.ceil(np.hypot(*(b - a)[:2]) / spacing)))
        out.append(a + (b - a) * (np.arange(1, k + 1) / k)[:, None])
    return np.concatenate(out)


def _bilinear(grid, u, v):
    """The grid's heights at fractional columns u and rows v; NaN off the grid."""
    h, w = grid.shape
    ok = (u >= 0) & (v >= 0) & (u <= w - 1) & (v <= h - 1)
    u, v = np.clip(u, 0, w - 1.001), np.clip(v, 0, h - 1.001)
    i, j = u.astype(int), v.astype(int)
    fu, fv = u - i, v - j
    out = (grid[j, i] * (1 - fu) + grid[j, i + 1] * fu) * (1 - fv) + (grid[j + 1, i] * (1 - fu) + grid[j + 1, i + 1] * fu) * fv
    return np.where(ok, out, np.nan)


def _retaining(lines, at, dry):
    """The stretches of the walls that hold the ground up: [(points, low)], low = 1 where
    the lower ground is on the left of the line, -1 on its right. `at(points)`: the
    ground's height; `dry(points)`: whether a point is clear of the water."""
    # The survey draws one wall as several lines end to end.
    lines = [shapely.linestrings(c) for c in lines if len(c) > 1]
    if not lines:
        return []
    lines = [shapely.get_coordinates(g) for g in shapely.get_parts(shapely.line_merge(shapely.multilinestrings(lines)))]
    found = []  # per wall line: (points, pieces that are a step, those that surely are, low side of each)
    mids, lows, owners, where = [], [], [], []
    for k, c in enumerate(lines):
        c = _along(c, PIECE)
        d = c[1:] - c[:-1]
        length = np.hypot(d[:, 0], d[:, 1])
        n = np.column_stack([-d[:, 1], d[:, 0]]) / np.maximum(length, 1e-9)[:, None]
        m = (c[1:] + c[:-1]) / 2
        with np.errstate(invalid="ignore"):
            near, far = at(m + n * PROBE) - at(m - n * PROBE), at(m + n * 2 * PROBE) - at(m - n * 2 * PROBE)
            step = (length > 1e-6) & (np.abs(far) < SLOPE * np.abs(near)) & (near * far > 0) & dry(m)
            weak, sure = step & (np.abs(near) >= STEP_WEAK), step & (np.abs(near) >= STEP_MIN)
        low = -np.sign(np.nan_to_num(near))
        found.append((c, weak, sure, low))
        idx = np.flatnonzero(weak)
        mids.append(m[idx]); lows.append(n[idx] * low[idx, None]); owners.append(np.full(len(idx), k)); where.append(idx)
    if not sum(len(m) for m in mids):
        return []
    mids, lows, owners, where = np.concatenate(mids), np.concatenate(lows), np.concatenate(owners), np.concatenate(where)
    # A wall has two faces, each a line of its own: the step is at the lower one.
    for a, b in cKDTree(mids).query_pairs(BESIDE):
        if owners[a] == owners[b]:
            continue
        if (mids[b] - mids[a]) @ lows[a] > 0.15:
            found[owners[a]][1][where[a]] = False
        elif (mids[a] - mids[b]) @ lows[b] > 0.15:
            found[owners[b]][1][where[b]] = False
    runs = []
    for c, weak, sure, low in found:
        k = 0
        while k < len(weak):
            if not weak[k]:
                k += 1
                continue
            e = k
            while e + 1 < len(weak) and weak[e + 1] and low[e + 1] == low[k]:
                e += 1
            pts = c[k:e + 2]
            # A stretch counts from where the step is slight, if somewhere along it it's plain.
            if sure[k:e + 1].any() and np.hypot(*(pts[1:] - pts[:-1]).T).sum() >= RUN_MIN:
                runs.append((pts, int(low[k])))
            k = e + 1
    return runs


def apply(area, bbox, to_local, tiles, N, step, gx0, gy0, water, boxes, roads=(), tunnels=(), keep=(), carriageways=(), no_feather=False):
    """Correct the tiles' lattices in place (see the top of the file). Works on arrays
    over the whole area (a few GB for `praha`). `tiles`: {(i, j):
    (N + 1) x (N + 1) heights}, the lattice of tile (i, j) starting at point (i * N, j * N);
    `water`: the water's polygons in local metres; `boxes`: each tile's box; `roads`: the
    streets and paths on the ground in the tiles with water; `tunnels`: the map's tunnels
    and underpasses as (line, width); `carriageways`: those of `roads` that cars drive on; `keep`: places looked at by hand where the terrain
    model does better left as it is (terrain_keep.json), as polygons. Returns what it changed, for
    the log, with "labels" (each tile's lattice of labels) and "terraces" (each tile's
    terraces: their label and outline; and under label 1 its water, where that's not
    simply the map's: see below)."""
    polys, points, walls = survey(area, bbox)
    if not len(points):
        return {"surfaces": 0, "street_points": 0, "water_points": 0, "labels": {}, "terraces": {}}
    walls = [np.column_stack(to_local.transform(w[:, 0], w[:, 1])) for w in walls]
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
    street = np.zeros(grid.shape, dtype=bool)
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
        street[gj, gi] = True
        surfaces += 1
        street_points += len(gi)

    # A street surveyed in an underpass is under the ground, not on it: where the map has
    # a tunnel and the survey is well below the terrain model, the terrain stays.
    under = 0
    for line, width in tunnels:
        hole = line.buffer(width / 2 + UNDER_SIDE)
        bx0, by0, bx1, by1 = hole.bounds
        ia, ib = max(0, int(np.ceil((bx0 - x_of(0)) / step))), min(grid.shape[1] - 1, int(np.floor((bx1 - x_of(0)) / step)))
        ja, jb = max(0, int(np.ceil((by0 - y_of(0)) / step))), min(grid.shape[0] - 1, int(np.floor((by1 - y_of(0)) / step)))
        if ia > ib or ja > jb:
            continue
        gi, gj = np.meshgrid(np.arange(ia, ib + 1), np.arange(ja, jb + 1))
        with np.errstate(invalid="ignore"):
            back = shapely.contains_xy(hole, x_of(gi), y_of(gj)) & street[gj, gi] & (bare[gj, gi] - grid[gj, gi] > UNDER)
        grid[gj[back], gi[back]] = bare[gj[back], gi[back]]
        street[gj[back], gi[back]] = False
        under += int(back.sum())

    # The ground beside a surveyed street follows it. A path down a bank or a street in a
    # cutting is narrower than the lattice, so only a point here and there falls on it;
    # with the survey a metre or two off the terrain model there, those points alone made
    # the slope ragged. What the survey changed on the street (survey minus terrain model)
    # is carried over to the ground beside it, averaged over the street points round about
    # and fading out to FEATHER: the slope keeps its shape and meets the street. (Water,
    # banks and retaining walls come after this and have the last word where they are.)
    feathered = 0
    if street.any() and not no_feather:
        change = np.where(street, np.nan_to_num(grid - bare), 0).astype(np.float32)
        mean = ndimage.gaussian_filter(change, FEATHER_BLUR / step) / np.maximum(ndimage.gaussian_filter(street.astype(np.float32), FEATHER_BLUR / step), 1e-3)
        d = ndimage.distance_transform_edt(~street) * step
        beside = ~street & ~np.isnan(bare) & (d < FEATHER)
        with np.errstate(invalid="ignore"):
            beside &= np.abs(mean) > 0.05
        grid[beside] = bare[beside] + mean[beside] * (1 - d[beside] / FEATHER)
        feathered = int(beside.sum())

    # The map draws a street on to where its bridge begins, which is often a little past
    # the edge of the quay wall the bridge comes off: its last metres lie over the water,
    # and would hang down to it. They're at the height of the surveyed
    # street they run on from.
    overhang = 0
    carriageways = [g for g in carriageways if not g.is_empty]
    if water is not None and not water.is_empty:
        shapely.prepare(water)
        carriageways = [g for g in carriageways if water.intersects(g)]
    else:
        carriageways = []
    if street.any() and len(carriageways):
        d, (sj, si) = ndimage.distance_transform_edt(~street, return_indices=True)
        raised = np.zeros(grid.shape, dtype=bool)
        for road in carriageways:
            bx0, by0, bx1, by1 = road.bounds
            ia, ib = max(0, int(np.ceil((bx0 - x_of(0)) / step))), min(grid.shape[1] - 1, int(np.floor((bx1 - x_of(0)) / step)))
            ja, jb = max(0, int(np.ceil((by0 - y_of(0)) / step))), min(grid.shape[0] - 1, int(np.floor((by1 - y_of(0)) / step)))
            if ia > ib or ja > jb:
                continue
            gi, gj = np.meshgrid(np.arange(ia, ib + 1), np.arange(ja, jb + 1))
            on = ~street[gj, gi] & ~np.isnan(grid[gj, gi]) & (d[gj, gi] * step <= OVERHANG)
            if not on.any():
                continue
            on &= shapely.contains_xy(road, x_of(gi), y_of(gj))
            # (Only over the map's water: a street beside a higher one, on land, is another street.)
            on[on] = shapely.contains_xy(water, x_of(gi[on]), y_of(gj[on]))
            # (Up to the street, never down: the nearest surveyed street may as well be
            # the one along the quay below.)
            on &= grid[sj[gj, gi], si[gj, gi]] > grid[gj, gi] + 0.3
            gi, gj = gi[on], gj[on]
            grid[gj, gi] = grid[sj[gj, gi], si[gj, gi]]
            raised[gj, gi] = True
            overhang += len(gi)
        # (Marked as street only now: one such point doesn't hand its height on to the next.)
        street |= raised

    # The map's water runs on under streets it doesn't call bridges (a causeway, the road
    # across an island's tip, a quay drawn a little too far out): what's a street on the
    # ground, surveyed or mapped, isn't water.
    mapped = water
    if water is not None and not water.is_empty:
        shapely.prepare(water)
        over = [g for g in polys[STRtree(polys).query(water, predicate="intersects")]] + [g for g in roads if water.intersects(g)]
        if over:
            water = water.difference(shapely.union_all(shapely.make_valid(np.array(over, dtype=object)), grid_size=0.01))
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

    # The land beside the water, as far as the terrain model's ramp reaches.
    bank_points = 0
    if wet.any():
        street &= ~wet
        land = ~wet & ~np.isnan(bare)
        from_water = ndimage.distance_transform_edt(~wet) * step
        spoilt = land & ~street & (from_water <= BANK)
        # By a surveyed street: its height.
        if street.any():
            d, (sj, si) = ndimage.distance_transform_edt(~street, return_indices=True)
            take = spoilt & (d * step <= STREET_NEAR)
            grid[take] = grid[sj[take], si[take]]
            spoilt &= ~take
            bank_points += int(take.sum())
        # By a surveyed wall: the height of the nearest land clear of the ramp.
        if len(walls) and spoilt.any():
            gj, gi = np.nonzero(spoilt)
            d, _ = cKDTree(np.concatenate([_along(w) for w in walls])).query(np.column_stack([x_of(gi), y_of(gj)]), distance_upper_bound=WALL_NEAR)
            walled = np.zeros(grid.shape, dtype=bool)
            walled[gj[np.isfinite(d)], gi[np.isfinite(d)]] = True
            clear = land & (street | (from_water > BANK))
            if clear.any():
                d, (sj, si) = ndimage.distance_transform_edt(~clear, return_indices=True)
                take = walled & (d * step <= INLAND)
                grid[take] = grid[sj[take], si[take]]
                bank_points += int(take.sum())

    # The land right at the water isn't below it (the terrain model has a quay awash here
    # and there, by a decimetre or a metre): the bank would be a step down from the water.
    if wet.any():
        d, (sj, si) = ndimage.distance_transform_edt(~wet, return_indices=True)
        edge = ~wet & ~np.isnan(bare) & (d <= 2.5)
        with np.errstate(invalid="ignore"):
            low = edge & (grid < grid[sj, si] + AWASH)
        grid[low] = grid[sj[low], si[low]] + AWASH

    # Retaining walls on land: the ground on either side from clear of the ramp, and a
    # terrace marked at each wall's foot.
    before = grid.copy()
    at = lambda p: _bilinear(before, (p[:, 0] - x_of(0)) / step, (p[:, 1] - y_of(0)) / step)  # noqa: E731
    from_water = ndimage.distance_transform_edt(~wet) * step if wet.any() else np.full(grid.shape, np.inf)
    def dry(p):
        gi = np.clip(np.round((p[:, 0] - x_of(0)) / step).astype(int), 0, grid.shape[1] - 1)
        gj = np.clip(np.round((p[:, 1] - y_of(0)) / step).astype(int), 0, grid.shape[0] - 1)
        return from_water[gj, gi] > WATER_CLEAR
    terrace = np.zeros(grid.shape, dtype=np.int32)  # which terrace a lattice point is on, from 1
    strips, wall_length, wall_points = [], 0.0, 0
    nearby = {}  # the terraces so far by the 64 m squares they reach into: a terrace doesn't lie over another
    squares = lambda g: [(i, j) for i in range(int(g.bounds[0] // 64), int(g.bounds[2] // 64) + 1)  # noqa: E731
                         for j in range(int(g.bounds[1] // 64), int(g.bounds[3] // 64) + 1)]
    if water is not None:
        shapely.prepare(water)
    for run, low in _retaining(walls, at, dry):
        line = shapely.LineString(run)
        bx0, by0, bx1, by1 = line.bounds
        ia, ib = max(0, int(np.floor((bx0 - REACH - x_of(0)) / step))), min(grid.shape[1] - 1, int(np.ceil((bx1 + REACH - x_of(0)) / step)))
        ja, jb = max(0, int(np.floor((by0 - REACH - y_of(0)) / step))), min(grid.shape[0] - 1, int(np.ceil((by1 + REACH - y_of(0)) / step)))
        if ia > ib or ja > jb:
            continue
        gi, gj = np.meshgrid(np.arange(ia, ib + 1), np.arange(ja, jb + 1))
        gi, gj = gi.ravel(), gj.ravel()
        p = np.column_stack([x_of(gi), y_of(gj)])
        pt = shapely.points(p)
        d, u = shapely.distance(line, pt), shapely.line_locate_point(line, pt)
        # Beside the wall, not past its ends.
        on = (d <= REACH) & (d > 1e-6) & (u > 1e-6) & (u < line.length - 1e-6) & ~wet[gj, gi] & ~street[gj, gi] & ~np.isnan(grid[gj, gi])
        gi, gj, p, d, u = gi[on], gj[on], p[on], d[on], u[on]
        if len(gi):
            foot = shapely.get_coordinates(shapely.line_interpolate_point(line, u))
            away = (p - foot) / d[:, None]
            # Which side of the wall: the lower ground's or the higher's.
            ahead = shapely.get_coordinates(shapely.line_interpolate_point(line, np.minimum(u + 0.1, line.length))) \
                - shapely.get_coordinates(shapely.line_interpolate_point(line, np.maximum(u - 0.1, 0)))
            below = np.sign(ahead[:, 0] * away[:, 1] - ahead[:, 1] * away[:, 0]) == low
            # The terrain model's ramp runs from the foot of the wall to its top over REACH
            # at most: the ground below is the lowest out to there, the ground above the
            # highest (not simply the height REACH away: an embankment between two walls is
            # narrower than that, and the ground beyond its far wall is low again).
            with np.errstate(invalid="ignore"), warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                along = np.array([at(foot + away * r) for r in np.linspace(REACH / 5, REACH, 5)])
                h = np.where(below, np.nanmin(along, axis=0), np.nanmax(along, axis=0))
            ok = ~np.isnan(h)
            grid[gj[ok], gi[ok]] = h[ok]
            wall_points += int(ok.sum())
        strip = line.buffer(STRIP * low, single_sided=True).buffer(0)
        if water is not None and water.intersects(strip):
            strip = strip.difference(water)
        for k in sorted({k for sq in squares(strip) for k in nearby.get(sq, ())}):
            if strips[k].intersects(strip):
                strip = strip.difference(strips[k])
        parts = [g for g in shapely.get_parts(strip) if g.geom_type == "Polygon" and g.area >= 4]
        if not parts:
            continue
        strip = shapely.union_all(parts)
        for sq in squares(strip):
            nearby.setdefault(sq, []).append(len(strips))
        strips.append(strip)
        wall_length += line.length
        bx0, by0, bx1, by1 = strip.bounds
        ia, ib = max(0, int(np.floor((bx0 - x_of(0)) / step))), min(grid.shape[1] - 1, int(np.ceil((bx1 - x_of(0)) / step)))
        ja, jb = max(0, int(np.floor((by0 - y_of(0)) / step))), min(grid.shape[0] - 1, int(np.ceil((by1 - y_of(0)) / step)))
        gi, gj = np.meshgrid(np.arange(ia, ib + 1), np.arange(ja, jb + 1))
        inside = shapely.contains_xy(strip, x_of(gi), y_of(gj)) & ~wet[ja:jb + 1, ia:ib + 1]
        terrace[ja:jb + 1, ia:ib + 1][inside] = len(strips)

    # Places where all this makes things worse (terrain_keep.json): as the terrain model has them.
    kept = 0
    for place in keep:
        bx0, by0, bx1, by1 = place.bounds
        ia, ib = max(0, int(np.ceil((bx0 - x_of(0)) / step))), min(grid.shape[1] - 1, int(np.floor((bx1 - x_of(0)) / step)))
        ja, jb = max(0, int(np.ceil((by0 - y_of(0)) / step))), min(grid.shape[0] - 1, int(np.floor((by1 - y_of(0)) / step)))
        if ia > ib or ja > jb:
            continue
        gi, gj = np.meshgrid(np.arange(ia, ib + 1), np.arange(ja, jb + 1))
        on = shapely.contains_xy(place, x_of(gi), y_of(gj))
        gi, gj = gi[on], gj[on]
        grid[gj, gi] = bare[gj, gi]
        wet[gj, gi] = False
        terrace[gj, gi] = 0
        kept += len(gi)

    # Per tile: its heights, its labels (0 plain ground, 1 water, 2… its terraces) and the
    # terraces' outlines within it.
    labels, outlines = {}, {}
    ring = lambda r: np.round(shapely.get_coordinates(r)[:-1], 2).tolist()  # noqa: E731
    for (i, j), arr in tiles.items():
        rows, cols = slice(j * N - j0, j * N - j0 + N + 1), slice(i * N - i0, i * N - i0 + N + 1)
        arr[:] = grid[rows, cols]
        label = wet[rows, cols].astype(np.uint8)
        listed = []
        for g in np.unique(terrace[rows, cols]):
            if g == 0 or len(listed) >= 250:
                continue
            here = [q for q in shapely.get_parts(strips[g - 1].intersection(boxes[(i, j)])) if q.geom_type == "Polygon" and q.area > 0.5]
            if not here:
                continue
            listed.append({"label": 2 + len(listed), "polys": [[ring(q.exterior), *(ring(r) for r in q.interiors)] for q in here]})
            label[(terrace[rows, cols] == g) & (label == 0)] = listed[-1]["label"]
        labels[(i, j)] = label
        # Its water, where streets were taken out of it.
        if mapped is not None and label.any():
            was, now = mapped.intersection(boxes[(i, j)]), water.intersection(boxes[(i, j)])
            if was.area - now.area > 1:
                here = [q for q in shapely.get_parts(now) if q.geom_type == "Polygon" and q.area > 0.5]
                listed.insert(0, {"label": 1, "polys": [[ring(q.exterior), *(ring(r) for r in q.interiors)] for q in here]})
        if listed:
            outlines[(i, j)] = listed
    changed = ~np.isnan(bare) & (np.abs(grid - bare) > 0.05)
    return {"surfaces": surfaces, "street_points": street_points, "under_points": under, "feathered": feathered, "overhang_points": overhang, "water_points": int(wet.sum()), "bank_points": bank_points,
            "kept_by_hand": kept, "retaining_walls": len(strips), "retaining_metres": round(wall_length), "wall_points": wall_points,
            "changed": int(changed.sum()), "mean_change": float(np.abs(grid - bare)[changed].mean()) if changed.any() else 0.0,
            "labels": labels, "terraces": outlines}
