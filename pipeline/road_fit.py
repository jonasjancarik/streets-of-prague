"""Fit one smooth surface over an area's paved streets (pilot).

Streets are tapes: along their length they climb and bend gently, across
they may lean and carry a crown. The fit is a 2 m grid over the carriageways
(IPR's surface outlines, © IPR Praha, CC BY 4.0), pulled towards IPR's 2023
LiDAR terrain and held by a bending penalty that is stiff along each street,
loose across it and isotropic at junctions. A lopsided robust loss keeps
anything left above the road (a car, a hedge) from lifting it.

Where the LiDAR and the map's ground disagree by more than 0.3 m, each such
place is judged on its own. A metre or more apart, IPR's surface model (the
top surface, as the game's camera sees it) picks the level; closer than that,
or where it shows neither, the map keeps its level unless it has a hole or a
spike there and the LiDAR runs on smoothly. Where the map keeps its level the
fit follows it, smoothed. Retaining walls, terraces and tunnels split the grid.
The surveyed road edges are only a check: the map was built with them.

The result is written as level-zero road surface patches (src/roadSurfaces.ts)
that replace the map's ground on the carriageway and fade into it over the
first metres past the kerb. The game leaves them out of tiles with a tunnel.
The checkers take the file with --roadsurfaces and the game with
?roadsurfaces&roadfit (road-fit.json beside the map).

    uv run --project pipeline python pipeline/road_fit.py --data public/data/praha_now \\
      --out public/data/praha_now/road-fit.json --report docs/evidence/road-fit/report.json
"""

import argparse
from collections import defaultdict
import json
import math
from pathlib import Path
import time

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from pyproj.enums import TransformDirection
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import box as rect

from dtm_heights import _along
import ipr_lidar
from layers import write
from road_height_sources import dsm_sampler
from road_profile import polygons, terrain_at
from road_surfaces import Map, smooth

HERE = Path(__file__).resolve().parent
LIDAR = HERE / ".cache" / "ipr_lidar" / "2023"
SURVEY = HERE / ".cache" / "dtm" / "heights" / "praha.pkl"
# west, south, east, north
AREAS = {"nusle": (14.424, 50.059, 14.447, 50.085)}

CELL = 2.0          # m, the fit's grid
INSET = 1.0         # m, LiDAR only this far inside the kerb (the kerb's own step stays out)
FEATHER = 2.5       # m past the kerb over which the fit fades into the map's ground
WALL_GAP = 1.6      # m either side of a surveyed wall where the grid is cut
HOUSE_GAP = 2.0     # m from a building over which the fit fades out
CORE = 120          # m, each patch's own square (patches allow at most 128 nodes a side)
LARGE = 1.0         # m, changes this large are listed in the report for a look

# Bending penalties per grid cell, against a data weight of 1 per LiDAR cell.
# With second differences on a 2 m grid a weight w smooths out waves shorter
# than about 2π·2·w^¼ m: 20 m along, 6 m across, 12 m for the twist.
ALONG, ACROSS, TWIST = 6.0, 0.05, 0.8
JUNCTION = 2.0      # isotropic, at junctions and on squares
TIE = 1e-3          # weak pull to the map's ground, so a cell with no data has a height
HELD = 0.2          # where the map keeps its level it holds the fit there, smoothed
ROUGH, SMOOTH = 0.25, 0.08  # m off the 3×3 mean: a map hole's sides, a LiDAR street with none
APART = 1.0         # m, where the LiDAR and the map are this far apart the surface model decides
SEEN = 0.5          # m, the surface model (lowest quarter) this close to a level shows it is on top
OFFSET = 0.3        # m, a LiDAR cell this far off the survey (or the map) disagrees
# Lopsided Huber scales: the road under a car is below the LiDAR, not above it.
ABOVE, BELOW = 0.06, 0.12
ROUNDS = 5


def grid_cells(bounds):
    x0, y0, x1, y1 = (math.floor(bounds[0] / CELL) * CELL, math.floor(bounds[1] / CELL) * CELL,
                      math.ceil(bounds[2] / CELL) * CELL, math.ceil(bounds[3] / CELL) * CELL)
    nx, ny = int(round((x1 - x0) / CELL)) + 1, int(round((y1 - y0) / CELL)) + 1
    return x0, y0, nx, ny


def collect(city, bounds):
    """The area's ground carriageways, decks, tunnels, terraces, buildings and street axes."""
    tiles = city.tiles(bounds)
    out = defaultdict(list)
    edges = {}
    for key, t in tiles.items():
        clip = rect(*t["box"])
        for kind in ("road", "sett"):
            out["paved"] += [p.intersection(clip) for p in polygons(t["roads"].get(kind, []))]
        for s in t.get("structures", []):
            out["deck" if s["kind"] == "bridge" else "tunnel"] += polygons(s["polys"])
        for s in t.get("terraces", []):
            out["terrace"] += polygons(s["polys"])
        out["house"] += polygons(b["rings"] for b in t["buildings"])
        for e in t["drive"]:
            if e.get("bridge") or e.get("tunnel") or e.get("level", 0) != 0 or len(e["pts"]) < 2:
                continue
            # A street crosses several tiles; keep its longest piece per tile and all pieces.
            edges.setdefault(e["id"], []).append(e)
    merged = {k: shapely.union_all([p for p in v if not p.is_empty]) for k, v in out.items()}
    return tiles, merged, edges


def axes(edges):
    """Points a metre apart along the ground street axes, with their direction and half width."""
    pts, dirs, half = [], [], []
    for pieces in edges.values():
        for e in pieces:
            p = np.asarray(e["pts"], float)
            seg = np.diff(p, axis=0)
            for a, d, n in zip(p[:-1], seg, np.hypot(*seg.T)):
                if n < 1e-6:
                    continue
                k = max(2, int(math.ceil(n)))
                s = (np.arange(k) + 0.5) / k
                pts.append(a + s[:, None] * d)
                dirs.append(np.repeat((d / n)[None], k, axis=0))
                half.append(np.full(k, (e.get("width") or 6.0) / 2))
    return np.concatenate(pts), np.concatenate(dirs), np.concatenate(half)


def junctions(edges):
    """Junction centres (graph nodes where three or more ground streets meet) and their reach."""
    ends = defaultdict(list)
    for pieces in edges.values():
        e = pieces[0]
        pts = [np.asarray(p["pts"], float) for p in pieces]
        # The edge's own ends are the piece ends farthest from the other pieces' interiors:
        # take the extreme points of all pieces along the edge's chord.
        allp = np.concatenate(pts)
        chord = allp[-1] - allp[0]
        if np.hypot(*chord) < 1e-6:
            continue
        s = allp @ chord
        a, b = allp[s.argmin()], allp[s.argmax()]
        w = max((p.get("width") or 6.0) for p in pieces)
        ends[e["u"]].append((a, w, e["id"]))
        ends[e["v"]].append((b, w, e["id"]))
    out = []
    for node, items in ends.items():
        if len({i for _, _, i in items}) >= 3:
            xy = np.mean([a for a, _, _ in items], axis=0)
            out.append((xy, max(w for _, w, _ in items) / 2 + 4.0))
    return out


def build_penalty(idx, tx, ty, iso):
    """Sparse rows of the bending penalty on the grid cells `idx` (−1 off the grid)."""
    ny, nx = idx.shape
    pad = np.full((ny + 2, nx + 2), -1, int)
    pad[1:-1, 1:-1] = idx
    c = pad[1:-1, 1:-1]
    E, W, N, S = pad[1:-1, 2:], pad[1:-1, :-2], pad[2:, 1:-1], pad[:-2, 1:-1]
    NE, NW, SE, SW = pad[2:, 2:], pad[2:, :-2], pad[:-2, 2:], pad[:-2, :-2]
    full = (c >= 0) & (E >= 0) & (W >= 0) & (N >= 0) & (S >= 0) & (NE >= 0) & (NW >= 0) & (SE >= 0) & (SW >= 0)
    xs = (c >= 0) & (E >= 0) & (W >= 0) & ~full
    ys = (c >= 0) & (N >= 0) & (S >= 0) & ~full
    rows, cols, vals = [], [], []
    count = 0

    def add(mask, terms, weight):
        nonlocal count
        k = np.count_nonzero(mask)
        if not k:
            return
        r = count + np.arange(k)
        sw = np.sqrt(weight[mask]) if np.ndim(weight) else np.full(k, math.sqrt(weight))
        for cell, coef in terms:
            cf = coef[mask] if np.ndim(coef) else np.full(k, coef)
            rows.append(r)
            cols.append(cell[mask])
            vals.append(sw * cf)
        count += k

    # Second differences (unnormalised, h = 1 cell).
    def hessian_terms(a, b, cxy):
        """Row a·zxx + b·zyy + cxy·zxy as stencil terms."""
        return [(c, -2 * a - 2 * b), (E, a), (W, a), (N, b), (S, b),
                (NE, cxy / 4), (SW, cxy / 4), (NW, -cxy / 4), (SE, -cxy / 4)]

    t2x, t2y, txy = tx * tx, ty * ty, tx * ty
    wa = np.where(iso, JUNCTION, ALONG)
    wc = np.where(iso, JUNCTION, ACROSS)
    wt = np.where(iso, 2 * JUNCTION, 2 * TWIST)
    add(full, hessian_terms(t2x, t2y, 2 * txy), wa)          # along: tᵀHt
    add(full, hessian_terms(t2y, t2x, -2 * txy), wc)         # across: nᵀHn
    add(full, hessian_terms(-txy, txy, t2x - t2y), wt)       # twist: tᵀHn
    # Where the 3×3 neighbourhood is cut, keep what bending can still be measured.
    add(xs, [(c, -2.0), (E, 1.0), (W, 1.0)], JUNCTION)
    add(ys, [(c, -2.0), (N, 1.0), (S, 1.0)], JUNCTION)
    n = int(idx.max()) + 1
    return sp.csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(count, n))


def bilinear_rows(px, py, x0, y0, idx):
    """Rows interpolating the grid at points; points whose four cells are not all on the grid drop out."""
    gx, gy = (px - x0) / CELL, (py - y0) / CELL
    i, j = np.floor(gx).astype(int), np.floor(gy).astype(int)
    fa, fb = gx - i, gy - j
    ny, nx = idx.shape
    ok = (i >= 0) & (j >= 0) & (i < nx - 1) & (j < ny - 1)
    i, j, fa, fb = i[ok], j[ok], fa[ok], fb[ok]
    corners = [(idx[j, i], (1 - fa) * (1 - fb)), (idx[j, i + 1], fa * (1 - fb)),
               (idx[j + 1, i], (1 - fa) * fb), (idx[j + 1, i + 1], fa * fb)]
    good = np.all([c >= 0 for c, _ in corners], axis=0)
    keep = np.flatnonzero(ok)[good]
    k = len(keep)
    rows = np.repeat(np.arange(k), 4)
    cols = np.column_stack([c[good] for c, _ in corners]).ravel()
    vals = np.column_stack([w[good] for _, w in corners]).ravel()
    return keep, sp.csr_matrix((vals, (rows, cols)), shape=(k, int(idx.max()) + 1))


def fit(city, area, lidar_at, dsm_at):
    t0 = time.time()
    w, s, e, n = area
    lon = np.array([w, e, e, w])
    lat = np.array([s, s, n, n])
    lx, ly = city.tf.to_local.transform(lon, lat)
    bounds = (min(lx), min(ly), max(lx), max(ly))
    tiles, geo, edges = collect(city, (bounds[0] - 20, bounds[1] - 20, bounds[2] + 20, bounds[3] + 20))
    paved = geo["paved"].intersection(rect(*bounds))
    shapely.prepare(paved)
    x0, y0, nx, ny = grid_cells(bounds)
    gx, gy = np.meshgrid(x0 + CELL * np.arange(nx), y0 + CELL * np.arange(ny))
    pts = shapely.points(gx.ravel(), gy.ravel())
    near = shapely.dwithin(paved, pts, FEATHER + CELL).reshape(gx.shape)
    cut = np.zeros_like(near)
    blockers = [geo.get("terrace"), geo.get("tunnel")]
    sub = pts[near.ravel()]
    blocked = np.zeros(len(sub), bool)
    for g in blockers:
        if g is not None and not g.is_empty:
            shapely.prepare(g)
            blocked |= shapely.covers(g, sub)
    sel = np.isin(city.wall_ids, city.wall_tree.query(rect(*bounds).buffer(10)))
    pieces = np.split(city.walls[sel][:, :2], np.flatnonzero(np.diff(city.wall_ids[sel])) + 1)
    walls = shapely.union_all([shapely.linestrings(wl) for wl in pieces if len(wl) > 1]) if sel.any() else None
    if walls is not None and not walls.is_empty:
        shapely.prepare(walls)
        blocked |= shapely.dwithin(walls, sub, WALL_GAP)
    cut[near] = blocked
    on = near & ~cut
    idx = np.full(gx.shape, -1, int)
    idx[on] = np.arange(np.count_nonzero(on))
    cells = np.count_nonzero(on)
    tunnel_tiles = sorted(k for k, t in tiles.items() if any(st["kind"] == "tunnel" for st in t.get("structures", [])))
    print(f"{len(tiles)} tiles ({len(tunnel_tiles)} with a tunnel, where the game leaves road patches out), "
          f"{len(edges)} ground streets, {cells} grid cells ({time.time() - t0:.0f} s)")

    # Each cell's street direction, and whether it is at a junction or off any street axis.
    ap, ad, ah = axes(edges)
    tree = cKDTree(ap)
    cx, cy = gx[on], gy[on]
    dist, nearest = tree.query(np.column_stack([cx, cy]))
    tx, ty = np.zeros(gx.shape), np.zeros(gx.shape)
    tx[on], ty[on] = ad[nearest, 0], ad[nearest, 1]
    iso = np.zeros(gx.shape, bool)
    junction = junctions(edges)
    if junction:
        jt = cKDTree(np.array([p for p, _ in junction]))
        reach = np.array([r for _, r in junction])
        dj, kj = jt.query(np.column_stack([cx, cy]))
        iso[on] = (dj <= reach[kj]) | (dist > ah[nearest] + FEATHER + 6)
    P = build_penalty(idx, tx, ty, iso)

    # The map's ground now: the weak tie, a check on the LiDAR and the measure of the change.
    at = terrain_at(city.data, city.index, tiles)
    ground = np.full(gx.shape, np.nan)
    ground[on] = at(cx, cy)
    # LiDAR, a 2 m cell as the mean of its four 1 m samples, only well inside the kerb.
    inside = np.zeros(gx.shape, bool)
    inner = paved.buffer(-INSET)
    shapely.prepare(inner)
    inside[on] = shapely.covers(inner, shapely.points(cx, cy))
    lid = np.full(gx.shape, np.nan)
    qx, qy = gx[inside], gy[inside]
    samples = np.stack([lidar_at(qx + a, qy + b) for a in (-.5, .5) for b in (-.5, .5)]).astype(float)
    lid[inside] = np.where(samples.max(0) - samples.min(0) < 0.5, samples.mean(0), np.nan)

    # Where the LiDAR and the map's ground disagree, one of them isn't the road. Where they
    # are a metre or more apart IPR's surface model, which sees the top surface as the
    # game's camera does, picks the level: on the LiDAR the map is wrong (the survey caught
    # a metro shaft, a crossing got the wrong level); on the map the street is on something
    # the LiDAR's bare earth leaves out (a road over a station hall, a bridge the map
    # doesn't have). Closer than that, and where the surface model shows neither (trees, a
    # deck above), the shape decides: a hole or a spike in the map has sides no street has
    # while the LiDAR runs on smoothly; otherwise the map keeps its level, smoothed.
    valid = np.isfinite(lid)
    off = valid & (np.abs(lid - ground) > OFFSET)
    groups, _ = ndimage.label(off, structure=np.ones((3, 3)))
    def rough(h):
        """How far each cell stands off the mean of its 3×3 neighbourhood (a plane, any slope, is 0)."""
        return np.abs(h - ndimage.uniform_filter(h, 3, mode="nearest"))
    r_ground, r_lidar = rough(ground), rough(lid)
    top = np.full(gx.shape, np.nan)
    top[off] = dsm_at(gx[off], gy[off])
    suspect = np.zeros(gx.shape, bool)
    votes = defaultdict(int)
    for k, sl in enumerate(ndimage.find_objects(groups), 1):
        sl = tuple(slice(max(0, q.start - 4), q.stop + 4) for q in sl)
        part = groups[sl] == k
        l, m_ = np.median(lid[sl][part]), np.median(ground[sl][part])
        seen = top[sl][part]
        seen = seen[np.isfinite(seen)]
        t = np.percentile(seen, 25) if len(seen) else np.nan
        why = None
        if abs(l - m_) >= APART:
            if abs(t - l) < SEEN and abs(t - l) < abs(t - m_):
                why = "seen at the LiDAR"
            elif abs(t - m_) < SEEN:
                why = "seen at the map"
        if why is None:
            around = ndimage.binary_dilation(part, iterations=3) & valid[sl]
            rough_map = np.nanpercentile(r_ground[sl][around], 90) if np.isfinite(r_ground[sl][around]).any() else 0
            rough_lidar = np.nanpercentile(r_lidar[sl][around], 90) if np.isfinite(r_lidar[sl][around]).any() else 1
            why = "a hole or spike in the map" if rough_map > ROUGH and rough_lidar < SMOOTH else "left to the map"
        votes[why] += 1
        if why in ("seen at the map", "left to the map"):
            suspect[sl] |= ndimage.binary_dilation(part, iterations=1)
    print(f"{sum(votes.values())} places where the LiDAR and the map disagree: " + ", ".join(f"{n} {w}" for w, n in votes.items()))
    masked = inside & suspect
    data_cells = valid & ~masked
    L_idx = idx[data_cells]
    d_lidar = lid[data_cells]
    L = sp.csr_matrix((np.ones(len(L_idx)), (np.arange(len(L_idx)), L_idx)), shape=(len(L_idx), cells))
    held = np.where(masked[on], HELD, TIE)
    base = np.where(np.isfinite(ground[on]), ground[on], np.nanmedian(d_lidar))
    print(f"{len(d_lidar)} LiDAR cells, {np.count_nonzero(masked)} left to the map ({time.time() - t0:.0f} s)")

    A, d = L, d_lidar
    weights = np.ones(len(d))
    PtP = (P.T @ P).tocsc()
    tie = sp.diags(held, format="csc")
    z = None
    factor = None
    for k in range(ROUNDS):
        Wd = sp.diags(weights)
        Nm = (A.T @ Wd @ A).tocsc() + PtP + tie
        rhs = A.T @ (weights * d) + held * base
        if factor is None:
            factor = spla.splu(Nm, permc_spec="COLAMD")
            z = factor.solve(rhs)
        else:
            M = spla.LinearOperator(Nm.shape, factor.solve)
            z, _ = spla.cg(Nm, rhs, x0=z, M=M, rtol=1e-9, maxiter=200)
        r = d - A @ z
        scale = np.where(r > 0, ABOVE, BELOW)
        weights = np.minimum(1.0, scale / np.maximum(np.abs(r), 1e-9))
        print(f"round {k + 1}: median |r| {np.median(np.abs(r)) * 100:.1f} cm, "
              f"{np.mean(np.abs(r) > 0.15) * 100:.1f}% over 15 cm ({time.time() - t0:.0f} s)")
    Z = np.full(gx.shape, np.nan)
    Z[on] = z
    # Up to a wall each side keeps its own height: a cut cell takes its nearest fitted cell's.
    _, (nj, ni) = ndimage.distance_transform_edt(~on, return_indices=True)
    Z[cut] = Z[nj[cut], ni[cut]]
    nl = len(d_lidar)
    big = inside & (np.abs(Z - ground) > LARGE)
    lab, _ = ndimage.label(big)
    places = []
    for k, sl in enumerate(ndimage.find_objects(lab), 1):
        part = lab[sl] == k
        if part.sum() < 3:
            continue
        jj, ii = np.nonzero(part)
        px, py = x0 + CELL * (ii.mean() + sl[1].start), y0 + CELL * (jj.mean() + sl[0].start)
        lon_, lat_ = city.tf.to_local.transform(px, py, direction="INVERSE")
        delta = (Z - ground)[sl][part]
        places.append(dict(at=[round(lat_, 5), round(lon_, 5)], area=int(part.sum() * CELL * CELL),
                           change=round(float(np.median(delta)), 2), most=round(float(delta[np.abs(delta).argmax()]), 2),
                           lidarLeftOut=round(float(masked[sl][part].mean()), 2)))
    places.sort(key=lambda p: -p["area"])
    stats = dict(tiles=len(tiles), tunnelTiles=tunnel_tiles, cells=int(cells), lidarCells=int(nl), disagreements=dict(votes), leftToMap=int(np.count_nonzero(masked)),
                 lidarResidual=dict(median=float(np.median(np.abs(r))), p95=float(np.percentile(np.abs(r), 95))),
                 seconds=round(time.time() - t0), largeChanges=places)
    # The surveyed road edges (the lines along the carriageway's outline) as a check.
    # The map was built with them, so they lean its way. Kerbs of a deck above lie on the
    # same outline as the street under it: only those within a metre of the map's ground.
    ids = city.line_tree.query(paved.buffer(0.7), predicate="intersects")
    chunks = [city.lines[city.line_offsets[k]:city.line_offsets[k + 1]] for k in ids]
    sv = np.concatenate([_along(c, 1.0) for c in chunks if len(c) > 1 and np.isfinite(c).all()])
    sv = sv[shapely.dwithin(paved.boundary, shapely.points(sv[:, :2]), 0.65)]
    keep_c, C = bilinear_rows(sv[:, 0], sv[:, 1], x0, y0, idx)
    sv = sv[keep_c]
    now = np.asarray(at(sv[:, 0], sv[:, 1]), float)
    near = np.abs(sv[:, 2] - now) < 1.0
    if near.any():
        def spread(e):
            return dict(median=float(np.median(e)), spread=float(1.4826 * np.median(np.abs(e - np.median(e)))),
                        p95=float(np.percentile(np.abs(e - np.median(e)), 95)))
        stats["surveyCheck"] = dict(points=int(near.sum()), fit=spread((C @ z - sv[:, 2])[near]),
                                    now=spread((now - sv[:, 2])[near]))
    grids = dict(Z=Z, base=ground, lidar=lid, inside=inside, masked=masked, iso=iso, cut=cut)
    return dict(Z=Z, x0=x0, y0=y0, on=on, geo=geo, paved=paved, bounds=bounds, tiles=tiles, at=at, idx=idx, grids=grids), stats


def patches(city, f):
    """Cut the fit into patches on a fixed 120 m layout; neighbours share their edge nodes."""
    Z, x0, y0, paved, at = f["Z"], f["x0"], f["y0"], f["paved"], f["at"]
    b = f["bounds"]
    geo = f["geo"]
    zone = paved.buffer(FEATHER)
    blocked = [g for g in (geo.get("terrace"), geo.get("tunnel")) if g is not None and not g.is_empty]
    house = geo.get("house")
    out, report = [], dict(patches=0, nodes=0, full=0, inTunnelTiles=0, change=[])
    for cx in range(int(math.floor(b[0] / CORE)) * CORE, int(math.ceil(b[2] / CORE)) * CORE, CORE):
        for cy in range(int(math.floor(b[1] / CORE)) * CORE, int(math.ceil(b[3] / CORE)) * CORE, CORE):
            core = rect(cx, cy, cx + CORE, cy + CORE)
            if not zone.intersects(core):
                continue
            bx = [cx - 1, cy - 1, cx + CORE + 1, cy + CORE + 1]
            xs, ys = np.meshgrid(np.arange(bx[0], bx[2] + 1), np.arange(bx[1], bx[3] + 1))
            px, py = xs.ravel().astype(float), ys.ravel().astype(float)
            g = shapely.points(px, py)
            reach = rect(*bx).buffer(FEATHER + HOUSE_GAP + 1)
            here = paved.intersection(reach)
            dist = shapely.distance(here, g)
            weight = np.where(dist <= 0, 1.0, smooth((FEATHER - dist) / FEATHER))
            for blk in blocked:
                blk = blk.intersection(reach)
                if not blk.is_empty:
                    weight[shapely.covers(blk, g)] = 0
            if house is not None and not house.is_empty:
                houses = house.intersection(reach)
                if not houses.is_empty:
                    weight *= smooth(shapely.distance(houses, g) / HOUSE_GAP)
            own = (px >= cx) & (px <= cx + CORE) & (py >= cy) & (py <= cy + CORE)
            weight[~own] = 0
            # Heights from the 2 m grid; a node needs its four grid cells.
            gxf, gyf = (px - x0) / CELL, (py - y0) / CELL
            i, j = np.floor(gxf).astype(int), np.floor(gyf).astype(int)
            ny, nx = Z.shape
            i, j = np.clip(i, 0, nx - 2), np.clip(j, 0, ny - 2)
            fa, fb = np.clip(gxf - i, 0, 1), np.clip(gyf - j, 0, 1)
            h = ((1 - fa) * (1 - fb) * Z[j, i] + fa * (1 - fb) * Z[j, i + 1]
                 + (1 - fa) * fb * Z[j + 1, i] + fa * fb * Z[j + 1, i + 1])
            ground = np.asarray(at(px, py), float)
            missing = ~np.isfinite(h)
            weight[missing] = 0
            h = np.where(missing, ground, h)
            change = np.abs(h - ground)
            h = np.where(np.isfinite(h), h, np.nanmedian(h))
            enc = np.round(255 * weight).astype(int)
            enc2 = enc.reshape(xs.shape)
            enc2[[0, -1], :] = 0
            enc2[:, [0, -1]] = 0
            if not enc.any():
                continue
            active = enc > 0
            report["change"].append(change[active & np.isfinite(change)])
            report["patches"] += 1
            report["nodes"] += int(np.count_nonzero(active))
            report["full"] += int(np.count_nonzero(enc == 255))
            # The game leaves road patches out of a tile with a tunnel (its ground is cut there).
            keys = [k for k, t in city.tiles(bx).items()
                    if not any(st["kind"] == "tunnel" for st in t.get("structures", []))]
            if len(keys) < len(city.tiles(bx)):
                report["inTunnelTiles"] += 1
            if not keys:
                continue
            out.append(dict(id=f"roadfit:{cx}_{cy}", kind="roadfit", box=bx, n=[xs.shape[1], xs.shape[0]],
                            weights=enc.tolist(), heights=np.round(h, 3).tolist(), tiles=sorted(keys)))
    ch = np.concatenate(report.pop("change")) if report["patches"] else np.array([0.0])
    report["change"] = dict(median=float(np.median(ch)), p95=float(np.percentile(ch, 95)), max=float(ch.max()))
    return out, report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--area", default="nusle", choices=AREAS)
    ap.add_argument("--survey-snapshot", type=Path, default=SURVEY)
    ap.add_argument("--lidar", type=Path, default=LIDAR)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--report", type=Path, required=True)
    args = ap.parse_args()
    city = Map(args.data, args.survey_snapshot)
    w, s, e, n = city.index["bbox_wgs84"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    lidar_at, source = ipr_lidar.sampler(args.lidar, local)
    to_wgs = Transformer.from_crs(local, "EPSG:4326", always_xy=True)
    k_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                 area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))

    def to_krovak(xs, ys):
        return k_wgs.transform(*to_wgs.transform(xs, ys), direction=TransformDirection.INVERSE)
    f, stats = fit(city, AREAS[args.area], lidar_at, dsm_sampler(to_krovak))
    out, report = patches(city, f)
    np.savez_compressed(args.report.with_suffix(".npz"), x0=f["x0"], y0=f["y0"], cell=CELL, **f["grids"])
    write(args.out, json.dumps(dict(version=1, area=city.index["area"], built=city.index["built"], patches=out),
                               separators=(",", ":")) + "\n")
    write(args.report, json.dumps(dict(area=args.area, box=AREAS[args.area], fit=stats, **report,
                                       lidar=source), ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(dict(fit=stats, **report), indent=1))


if __name__ == "__main__":
    main()
