"""Fit one smooth surface over an area's paved streets (pilot).

Streets are tapes: along their length they climb and bend gently, across
they may lean and carry a crown. The fit is a 2 m grid over the carriageways
(IPR's surface outlines, © IPR Praha, CC BY 4.0), pulled towards IPR's 2023
LiDAR terrain and held by a bending penalty that is stiff along each street,
loose across it and isotropic at junctions. A lopsided robust loss keeps
anything left above the road (a car, a hedge) from lifting it.

Where the LiDAR and the map's ground disagree by more than 0.3 m, each such
place is judged on its own. A metre or more apart, IPR's surface model (the
top surface, as the game's camera sees it) picks the level; closer than that it
picks the LiDAR's only when it lies clearly on it. Otherwise the map keeps its
level unless it has a hole or a spike there and the LiDAR runs on smoothly.
Where the map keeps its level the fit follows it, smoothed. LiDAR the fit ends
up a metre or more away from is left to the map in a second pass, and off the
car streets the map shows there. Retaining walls and terraces split the grid.
Over a tunnel and where the ground meets a bridge's deck the street is the map's
(its ground was shaped there to meet them) and the fit comes down to it, so
there is no step where they meet.
The surveyed road edges are only a check: the map was built with them.

The result is written as level-zero road surface patches (src/roadSurfaces.ts)
that replace the map's ground on the carriageway and fade into it over the
first metres past the kerb.
The checkers take the file with --roadsurfaces and the game with
?roadsurfaces&roadfit (road-fit.json beside the map). layers.assemble writes that
one for every area in AREAS on the map (after_assemble); by hand, for a trial:

    uv run --project pipeline python pipeline/road_fit.py --data public/data/praha_now --area nusle \\
      --out docs/evidence/road-fit/road-fit.json --report docs/evidence/road-fit/report.json
"""

import argparse
import base64
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
from road_height_sources import DSM, Map as RoadHeights, dsm_sampler
from road_profile import polygons, terrain_at
from road_surfaces import Map, smooth

HERE = Path(__file__).resolve().parent
LIDAR = HERE / ".cache" / "ipr_lidar" / "2023"
SURVEY = HERE / ".cache" / "dtm" / "heights" / "praha.pkl"
# west, south, east, north
AREAS = {"nusle": (14.424, 50.059, 14.447, 50.085), "zlichov": (14.398, 50.040, 14.420, 50.062)}

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
JUNCTION = 0.5      # isotropic at junctions: soft, so a steep side street breaks at the junction
SQUARE = 2.0        # isotropic, on squares and paving off any street
TIE = 1e-3          # weak pull to the map's ground, so a cell with no data has a height
HELD = 0.2          # where the map keeps its level it holds the fit there, smoothed
PIN = 100.0         # over a tunnel the fit takes the map's level
TUNNEL_GAP = 4.0    # m round a tunnel where it does so too
EDGE = 10.0         # m inside the area's edge where it does so too
MEETS = 1.0         # m: where the ground is this close to a deck beside it, it meets the deck
ROUGH, SMOOTH = 0.25, 0.08  # m off the 3×3 mean: a map hole's sides, a LiDAR street with none
APART = 1.0         # m, where the LiDAR and the map are this far apart the surface model decides
SEEN = 0.5          # m, the surface model (lowest quarter) this close to a level shows it is on top
CLOSE = 0.15        # m, under a metre apart the surface model must be this close to the LiDAR, and this much closer than to the map
OFFSET = 0.3        # m, a LiDAR cell this far off the survey (or the map) disagrees
# Lopsided Huber scales: the road under a car is below the LiDAR, not above it.
ABOVE, BELOW = 0.06, 0.12
ROUNDS = 5
REJECT = 1.0        # m, LiDAR this far off the fit was set aside: the second pass leaves it to the map
ASIDE = 3.0         # m round such LiDAR off the car streets where the patches show the map, and as far again to fade in


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
    """Sparse rows of the bending penalty on the grid cells `idx` (−1 off the grid). `iso` marks
    the cells bent the same whichever way (True: at the junction weight), or gives their weight."""
    iso = np.asarray(iso)
    iso_w = np.where(iso, JUNCTION, 0.0) if iso.dtype == bool else iso.astype(float)
    iso = iso_w > 0
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
    wa = np.where(iso, iso_w, ALONG)
    wc = np.where(iso, iso_w, ACROSS)
    wt = np.where(iso, 2 * iso_w, 2 * TWIST)
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


class Decks:
    """The highest bridge deck at a point on the game's lattice (NaN off any deck)."""

    def __init__(self):
        self.m = RoadHeights()

    def at(self, xs, ys):
        m = self.m
        xs, ys = np.asarray(xs, float).ravel(), np.asarray(ys, float).ravel()
        out = np.full(xs.shape, np.nan)
        ti = np.floor((xs + m.ox) / m.T).astype(int)
        tj = np.floor((ys + m.oy) / m.T).astype(int)
        for i, j in set(zip(ti.tolist(), tj.tolist())):
            got = m.lattice(i, j)
            if got is None or got[1] is None:
                continue
            g = got[1]
            sel = (ti == i) & (tj == j)
            a = np.clip((xs[sel] + m.ox - i * m.T) / m.step, 0, m.n - 1.001)
            b = np.clip((ys[sel] + m.oy - j * m.T) / m.step, 0, m.n - 1.001)
            ia, ib = a.astype(int), b.astype(int)
            fa, fb = a - ia, b - ib
            out[sel] = ((1 - fa) * (1 - fb) * g[ib, ia] + fa * (1 - fb) * g[ib, ia + 1]
                        + (1 - fa) * fb * g[ib + 1, ia] + fa * fb * g[ib + 1, ia + 1])
        return out


def fit(city, area, lidar_at, dsm_at):
    t0 = time.time()
    decks = Decks()
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
    blockers = [geo.get("terrace")]
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

    # The map's ground now: the weak tie, a check on the LiDAR and the measure of the change.
    at = terrain_at(city.data, city.index, tiles)
    ground = np.full(gx.shape, np.nan)
    ground[near] = at(gx[near], gy[near])
    # LiDAR, a 2 m cell as the mean of its four 1 m samples, only well inside the kerb.
    inside = np.zeros(gx.shape, bool)
    inner = paved.buffer(-INSET)
    shapely.prepare(inner)
    uncut = near & ~cut
    inside[uncut] = shapely.covers(inner, shapely.points(gx[uncut], gy[uncut]))
    lid = np.full(gx.shape, np.nan)
    qx, qy = gx[inside], gy[inside]
    samples = np.stack([lidar_at(qx + a, qy + b) for a in (-.5, .5) for b in (-.5, .5)]).astype(float)
    lid[inside] = np.where(samples.max(0) - samples.min(0) < 0.5, samples.mean(0), np.nan)
    on = near & ~cut
    idx = np.full(gx.shape, -1, int)
    idx[on] = np.arange(np.count_nonzero(on))
    cells = np.count_nonzero(on)
    print(f"{len(tiles)} tiles, {len(edges)} ground streets, {cells} grid cells ({time.time() - t0:.0f} s)")

    # Each cell's street direction, and whether it is at a junction or off any street axis.
    ap, ad, ah = axes(edges)
    tree = cKDTree(ap)
    cx, cy = gx[on], gy[on]
    dist, nearest = tree.query(np.column_stack([cx, cy]))
    tx, ty = np.zeros(gx.shape), np.zeros(gx.shape)
    tx[on], ty[on] = ad[nearest, 0], ad[nearest, 1]
    iso = np.zeros(gx.shape)
    off_street = dist > ah[nearest] + FEATHER + 6
    street = np.zeros(gx.shape, bool)
    street[on] = dist <= ah[nearest] + CELL
    iso[on] = np.where(off_street, SQUARE, 0)
    junction = junctions(edges)
    if junction:
        jt = cKDTree(np.array([p for p, _ in junction]))
        reach = np.array([r for _, r in junction])
        dj, kj = jt.query(np.column_stack([cx, cy]))
        iso[on] = np.where(dj <= reach[kj], JUNCTION, iso[on])
    P = build_penalty(idx, tx, ty, iso)

    # Over a tunnel and round it, and where the ground meets a bridge's deck (at its ends,
    # over a cutting), the map's ground: no LiDAR, and the map's level held. The ground
    # there was shaped to meet them.
    pinned = np.zeros(gx.shape, bool)
    tunnel = geo.get("tunnel")
    if tunnel is not None and not tunnel.is_empty:
        shapely.prepare(tunnel)
        pinned[on] = shapely.dwithin(tunnel, shapely.points(cx, cy), TUNNEL_GAP)
        # Beside a covered tunnel the map can dip to the tunnel's own level. Where the LiDAR and
        # the surface model agree on a level a metre or more off the map, that's the street on
        # top (also at the kerb, where the fit otherwise takes no LiDAR).
        beside = pinned.copy()
        beside[beside] = ~shapely.intersects(tunnel, shapely.points(gx[beside], gy[beside]))
        bx, by = gx[beside], gy[beside]
        l_here = np.asarray(lidar_at(bx, by), float)
        on_top = (np.abs(l_here - ground[beside]) >= APART) & (np.abs(dsm_at(bx, by) - l_here) < SEEN)
        print(f"{np.count_nonzero(on_top)} cells beside a tunnel where the street on top shows")
        pinned[tuple(a[on_top] for a in np.nonzero(beside))] = False
    deck = geo.get("deck")
    if deck is not None and not deck.is_empty:
        shapely.prepare(deck)
        near_deck = on.copy()
        near_deck[on] = shapely.dwithin(deck, shapely.points(cx, cy), TUNNEL_GAP)
        qx, qy = gx[near_deck], gy[near_deck]
        meets = np.zeros(len(qx), bool)
        r = TUNNEL_GAP * 0.75
        for a, b in [(0, 0)] + [(r * math.cos(t), r * math.sin(t)) for t in np.arange(8) * math.pi / 4]:
            d = decks.at(qx + a, qy + b)
            meets |= np.abs(d - ground[near_deck]) < MEETS
        pinned[near_deck] = meets
    # At the edge of the area the fit comes down to the map, which goes on beyond it.
    pinned |= on & ((gx < bounds[0] + EDGE) | (gx > bounds[2] - EDGE) | (gy < bounds[1] + EDGE) | (gy > bounds[3] - EDGE))
    lid[pinned] = np.nan

    # Where the LiDAR and the map's ground disagree, one of them isn't the road. Where they
    # are a metre or more apart IPR's surface model, which sees the top surface as the
    # game's camera does, picks the level: on the LiDAR the map is wrong (the survey caught
    # a metro shaft, a crossing got the wrong level); on the map the street is on something
    # the LiDAR's bare earth leaves out (a road over a station hall, a bridge the map
    # doesn't have). Closer than that the surface model picks the LiDAR only when it lies
    # on it. Where it shows neither (trees, a deck above), the shape decides: a hole or a
    # spike in the map has sides no street has while the LiDAR runs on smoothly; otherwise
    # the map keeps its level, smoothed.
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
        elif abs(t - l) < CLOSE and abs(t - m_) > abs(t - l) + CLOSE:
            # Closer, the surface model only decides when it lies on the LiDAR's street.
            why = "seen at the LiDAR"
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
    PtP = (P.T @ P).tocsc()
    rejected = 0
    aside = np.zeros(gx.shape, bool)
    # LiDAR the fit sets aside (a metre or more off it) leaves those cells held by
    # nothing: a narrow strip with one row of LiDAR on a level the streets round it don't
    # share then tips any which way. A second pass leaves such places to the map.
    for attempt in range(2):
        data_cells = valid & ~masked
        L_idx = idx[data_cells]
        d_lidar = lid[data_cells]
        L = sp.csr_matrix((np.ones(len(L_idx)), (np.arange(len(L_idx)), L_idx)), shape=(len(L_idx), cells))
        held = np.where(pinned[on], PIN, np.where(masked[on], HELD, TIE))
        base = np.where(np.isfinite(ground[on]), ground[on], np.nanmedian(d_lidar))
        print(f"{len(d_lidar)} LiDAR cells, {np.count_nonzero(masked)} left to the map ({time.time() - t0:.0f} s)")
        A, d = L, d_lidar
        weights = np.ones(len(d))
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
        off_fit = np.zeros(gx.shape, bool)
        off_fit[data_cells] = np.abs(r) > REJECT
        if attempt or not off_fit.any():
            break
        grown = inside & ndimage.binary_dilation(off_fit, iterations=1)
        rejected = int(np.count_nonzero(grown & ~masked))
        # (Only off the car streets: on one, the map's hole is what the fit is there to mend.)
        aside = grown & ~masked & ~street
        masked |= grown
        print(f"{np.count_nonzero(off_fit)} LiDAR cells set aside by the fit; left to the map with their neighbours")
    Z = np.full(gx.shape, np.nan)
    Z[on] = z
    # Up to a wall each side keeps its own height: a cut cell takes its nearest fitted cell's
    # on its own side of the wall.
    _, (nj, ni) = ndimage.distance_transform_edt(~on, return_indices=True)
    Z[cut] = Z[nj[cut], ni[cut]]
    if walls is not None and not walls.is_empty:
        cj, ci = np.nonzero(cut)
        best = np.full(len(cj), np.inf)
        for dj, di in sorted(((a, b) for a in range(-2, 3) for b in range(-2, 3) if a or b), key=lambda q: q[0] ** 2 + q[1] ** 2):
            d = math.hypot(dj, di)
            j, i = cj + dj, ci + di
            ok = (j >= 0) & (i >= 0) & (j < ny) & (i < nx) & (d < best)
            ok[ok] &= on[j[ok], i[ok]]
            if not ok.any():
                continue
            seg = shapely.linestrings(np.stack([np.column_stack([gx[cj[ok], ci[ok]], gy[cj[ok], ci[ok]]]),
                                                np.column_stack([gx[j[ok], i[ok]], gy[j[ok], i[ok]]])], axis=1))
            same = ~shapely.intersects(walls, seg)
            k = np.flatnonzero(ok)[same]
            Z[cj[k], ci[k]] = Z[j[k], i[k]]
            best[k] = d
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
    stats = dict(tiles=len(tiles), cells=int(cells), lidarCells=int(nl), disagreements=dict(votes), leftToMap=int(np.count_nonzero(masked)), setAside=rejected,
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
    # Round LiDAR set aside off the car streets the patches fade into the map, which is
    # right there more often than not. Where the surface model lies nearer the fit than the
    # map, the fit stays: fading into a map metres off would raise a hill in a car park.
    aside_dist = ndimage.distance_transform_edt(~aside) * CELL if aside.any() else np.full(gx.shape, np.inf)
    keep_fit = np.zeros(gx.shape)
    zone = (aside_dist < 2 * ASIDE + CELL) & np.isfinite(Z) & np.isfinite(ground)
    if zone.any():
        top = dsm_at(gx[zone], gy[zone])
        keep_fit[zone] = np.abs(top - Z[zone]) < np.abs(top - ground[zone])
        keep_fit = ndimage.uniform_filter(keep_fit, 3)
        stats["asideKept"] = int(np.count_nonzero(keep_fit[zone] > 0.5))
    grids = dict(Z=Z, base=ground, lidar=lid, inside=inside, masked=masked | pinned, iso=iso > 0, cut=cut)
    return dict(Z=Z, x0=x0, y0=y0, on=on, geo=geo, paved=paved, bounds=bounds, tiles=tiles, at=at, idx=idx, walls=walls,
                aside=aside_dist, keep_fit=keep_fit, grids=grids), stats


def node_heights(Z, x0, y0, px, py, i, j, fa, fb, walls):
    """Patch nodes from the 2 m grid, bilinear; near a wall only from the grid cells on the
    node's own side of it, so the step stays at the wall and doesn't lean out over the street."""
    corners = [(j, i, (1 - fa) * (1 - fb)), (j, i + 1, fa * (1 - fb)), (j + 1, i, (1 - fa) * fb), (j + 1, i + 1, fa * fb)]
    w = np.stack([c[2] for c in corners])
    if walls is not None and not walls.is_empty:
        near = shapely.dwithin(walls, shapely.points(px, py), CELL * 1.5)
        if near.any():
            k = np.flatnonzero(near)
            for n, (cj, ci, _) in enumerate(corners):
                seg = shapely.linestrings(np.stack([np.column_stack([px[k], py[k]]),
                                                    np.column_stack([x0 + CELL * ci[k], y0 + CELL * cj[k]])], axis=1))
                cross = shapely.intersects(walls, seg)
                # (A node on no side keeps them all.)
                w[n, k[cross]] = 0
            lost = w.sum(0) < 1e-9
            w[:, lost] = np.stack([c[2] for c in corners])[:, lost]
    zs = np.stack([Z[cj, ci] for cj, ci, _ in corners])
    # (A node needs all four cells, as before: past them the fit has no height.)
    return np.where(np.isfinite(zs).all(0), (w * np.nan_to_num(zs)).sum(0) / w.sum(0), np.nan)


def pack_heights(h, weights):
    """Heights as int16 steps from the middle of their range (a millimetre, or a little more
    where the range is wider than 65 m), each row as the change from the node before it (wrapping
    round), base64 (src/roadSurfaces.ts). Nodes no weighted cell touches are left at the
    base: nothing reads them, and the file packs far smaller."""
    used = ndimage.binary_dilation(weights > 0, np.ones((3, 3), bool))
    lo, hi = float(np.min(h[used])), float(np.max(h[used]))
    base = round((lo + hi) / 2, 3)
    step = max(0.001, (hi - lo) / 65000)
    q = np.where(used, np.round((h - base) / step), 0).astype(np.int32)
    dq = np.diff(q, axis=1, prepend=0).astype("<i2")
    return dict(base=base, step=step, data=base64.b64encode(dq.tobytes()).decode())


def patches(city, f):
    """Cut the fit into patches on a fixed 120 m layout; neighbours share their edge nodes."""
    Z, x0, y0, paved, at = f["Z"], f["x0"], f["y0"], f["paved"], f["at"]
    b = f["bounds"]
    geo = f["geo"]
    zone = paved.buffer(FEATHER)
    blocked = [g for g in (geo.get("terrace"), geo.get("tunnel")) if g is not None and not g.is_empty]
    house = geo.get("house")
    out, report = [], dict(patches=0, nodes=0, full=0, change=[])
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
            # Where the fit set the LiDAR aside it had nothing to go on: the map shows there
            # (unless the surface model sides with the fit, see fit()).
            # Read between the cells: a fade that changed only at each 2 m cell would cut a
            # step into the ground wherever the fit and the map are metres apart.
            far = np.minimum(f["aside"], 2 * ASIDE + CELL)
            gc = [(py - y0) / CELL, (px - x0) / CELL]
            near_aside = ndimage.map_coordinates(far, gc, order=1, mode="nearest")
            fade = smooth((near_aside - ASIDE) / ASIDE)
            weight *= fade + (1 - fade) * ndimage.map_coordinates(f["keep_fit"], gc, order=1, mode="nearest")
            own = (px >= cx) & (px <= cx + CORE) & (py >= cy) & (py <= cy + CORE)
            weight[~own] = 0
            # Heights from the 2 m grid; a node needs its four grid cells.
            gxf, gyf = (px - x0) / CELL, (py - y0) / CELL
            i, j = np.floor(gxf).astype(int), np.floor(gyf).astype(int)
            ny, nx = Z.shape
            i, j = np.clip(i, 0, nx - 2), np.clip(j, 0, ny - 2)
            fa, fb = np.clip(gxf - i, 0, 1), np.clip(gyf - j, 0, 1)
            h = node_heights(Z, x0, y0, px, py, i, j, fa, fb, f.get("walls"))
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
            keys = list(city.tiles(bx))
            if not keys:
                continue
            out.append(dict(id=f"roadfit:{cx}_{cy}", kind="roadfit", box=bx, n=[xs.shape[1], xs.shape[0]],
                            weights=base64.b64encode(enc.astype(np.uint8).tobytes()).decode(),
                            heights=pack_heights(h.reshape(xs.shape), enc2), tiles=sorted(keys)))
    ch = np.concatenate(report.pop("change")) if report["patches"] else np.array([0.0])
    report["change"] = dict(median=float(np.median(ch)), p95=float(np.percentile(ch, 95)), max=float(ch.max()))
    return out, report


def run(data, areas, out, report, survey=SURVEY, lidar=LIDAR, verbose=True):
    """Fit the areas (keys of AREAS) on the map in data and write their patches to out,
    stamped with the map's build, and the report (with each area's grids as .npz) to report."""
    city = Map(data, survey)
    w, s, e, n = city.index["bbox_wgs84"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    lidar_at, source = ipr_lidar.sampler(lidar, local)
    to_wgs = Transformer.from_crs(local, "EPSG:4326", always_xy=True)
    k_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                 area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))

    def to_krovak(xs, ys):
        return k_wgs.transform(*to_wgs.transform(xs, ys), direction=TransformDirection.INVERSE)
    areas = list(dict.fromkeys(areas))
    out_patches, reports = [], {}
    for name in areas:
        f, stats = fit(city, AREAS[name], lidar_at, dsm_sampler(to_krovak))
        got, rep = patches(city, f)
        # Patches sit on one fixed layout, so two areas sharing a patch would clash.
        shared = {p["id"] for p in out_patches} & {p["id"] for p in got}
        if shared:
            raise SystemExit(f"{name} shares patches with another area: {', '.join(sorted(shared))}")
        out_patches += got
        npz = report.with_suffix(".npz" if len(areas) == 1 else f".{name}.npz")
        np.savez_compressed(npz, x0=f["x0"], y0=f["y0"], cell=CELL, **f["grids"])
        reports[name] = dict(box=AREAS[name], fit=stats, **rep)
        if verbose:
            print(json.dumps({name: dict(fit=stats, **rep)}, indent=1))
    write(out, json.dumps(dict(version=1, area=city.index["area"], built=city.index["built"], patches=out_patches),
                          separators=(",", ":")) + "\n")
    one = reports[areas[0]] if len(areas) == 1 else None
    write(report, json.dumps(dict(area=areas[0], **one, lidar=source) if one else dict(areas=reports, lidar=source),
                             ensure_ascii=False, indent=2) + "\n")
    return reports


def after_assemble(index, out_dir, report_dir):
    """Fit every area of AREAS that lies wholly on the map just put together (layers.assemble).
    The game takes road-fit.json only when it carries the map's build, and every step
    that puts the map together gives it a new one: refitting here keeps the two together."""
    out = out_dir / "road-fit.json"
    w, s, e, n = index["bbox_wgs84"]
    inside = [k for k, (a, b, c, d) in AREAS.items() if a >= w and b >= s and c <= e and d <= n]
    missing = [str(p) for p in (LIDAR, SURVEY, DSM) if not p.exists()] if inside else []
    if not inside or missing:
        if missing:
            print(f"road fit: none, missing {', '.join(missing)}")
        out.unlink(missing_ok=True)  # one left from an earlier build would no longer match
        return
    started = time.perf_counter()
    report_dir.mkdir(parents=True, exist_ok=True)
    reports = run(out_dir, inside, out, report_dir / "report.json", verbose=False)
    done = ", ".join(f"{k} {r['patches']} patches" for k, r in reports.items())
    print(f"road fit: {done} → {out.name} ({time.perf_counter() - started:.0f} s)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--area", nargs="+", default=["nusle"], choices=AREAS,
                    help="one or more areas; their patches go into one file")
    ap.add_argument("--survey-snapshot", type=Path, default=SURVEY)
    ap.add_argument("--lidar", type=Path, default=LIDAR)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--report", type=Path, required=True)
    args = ap.parse_args()
    run(args.data, args.area, args.out, args.report, args.survey_snapshot, args.lidar)


if __name__ == "__main__":
    main()
