"""Outdoor stairs as the technical map has them (DTM kraje, ZPS), tread by tread.

OSM maps a flight of stairs as a line with a width, where it maps it at all: in Praha 1
it has about half of the flights that rise a metre or more. The survey has each one as
a polygon (set 2, "Schodiště") and its outline as lines with heights at their
vertices (set 3, "Hranice schodiště"); not the treads themselves. Here each outline
vertex takes the height of the surveyed line through it, the way the flight climbs is
the slope of a plane through those heights, and the flight is cut straight across that
way into even treads of a rise near RISER, between where its height profile leaves its
foot and reaches its head (a landing at either end stays flat). A flight whose heights
don't lie on one sloping plane (one that turns) is left out rather than drawn wrong: each tread a polygon with its top's height above sea level (Bpv, as the terrain
and iprRef), and the front edges of the treads (the nosings). The game draws them in
place of the stairs it would make from OSM's line (src/map/stairs.ts), and draws the
flights OSM doesn't have too. They are only drawn: walking still follows the terrain
and the walking network.

Stairs on the ground only (UrovenUmisteniObjektuZPS 0), and only those whose outline
has heights and rises at least MIN_RISE.

Source: DTM kraje – ZPS, datový podklad © IPR Praha (CC BY 4.0).

    uv run dtm_stairs.py      # read all of Prague and count the stairs and treads
"""

import pickle
import sqlite3
import tempfile
import zipfile

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from shapely import STRtree
from shapely.geometry import LineString, Polygon

import build_cache
from dtm import CACHE, PACKAGES, _wkb
from dtm_walls import LINES

PARSED = CACHE / "stairs.pkl"
VERSION = 1
POLYGONS = "010000016603"  # Schodiště, set 2
OUTLINES = "010000030102"  # Hranice schodiště, set 3 (with heights)
RISER = 0.16      # m: the rise of a step aimed for
MIN_RISE = 0.12   # m: less than this is a sill, not a step
MAX_STEPS = 120
SNAP = 0.15       # m: how close an outline line must come to a polygon's vertex to give its height
BIN = 0.25        # m: the slices of a flight's length its profile is read in
MIN_SLOPE = 0.05  # a flight climbs at least this much per metre
MISFIT = 0.12     # of its rise: how far a flight's heights may stray from one sloping plane
MIN_TREAD, MAX_TREAD = 0.22, 1.2  # m: how deep a tread can be
WIDER = 2.5  # a tread this much wider than the flight's usual one runs along an arm: left out
FLAT = 0.03       # m: a landing at either end is flat to within this
DENSE = 0.5       # m between the heights put along the outline before triangulating
LOW_HEIGHT = 100.0  # m a.s.l.: a height below this is missing (Prague lies at 170-400 m)
MARGIN = 0.0005   # degrees past a box
TO_WGS = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True, area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))

_index = None  # per process: (STRtree of the stairs' outlines in WGS84, stairs)


def _tables(package, code):
    """The WKB in S-JTSK of every object of one type on the ground in a package."""
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(package) as z:
        name = next(n for n in z.namelist() if n.endswith(".gpkg"))
        db = sqlite3.connect(z.extract(name, tmp))
        for (table,) in db.execute("select table_name from gpkg_contents").fetchall():
            if table.split("#")[-1][:12] != code:
                continue
            cols = {r[1] for r in db.execute(f'pragma table_info("{table}")')}
            level = "UrovenUmisteniObjektuZPS" if "UrovenUmisteniObjektuZPS" in cols else "0"
            for blob, lv in db.execute(f'select shape, {level} from "{table}" where shape is not null'):
                if not int(lv or 0):
                    yield bytes(_wkb(blob))
        db.close()


def _district(package):
    return package.name.split("_")[3]


def heights(poly, lines, tree):
    """The polygon's outline densified to DENSE m, as [n, 3] (x, y, height), the heights
    from the surveyed lines near each point and interpolated along the outline between
    them; None where the lines give fewer than two heights."""
    ring = np.asarray(shapely.segmentize(poly.exterior, DENSE).coords)[:-1]
    z = np.full(len(ring), np.nan)
    near = tree.query(shapely.points(ring), predicate="dwithin", distance=SNAP)
    for i, k in zip(*near):
        line = lines[k]
        p = shapely.Point(ring[i])
        if shapely.distance(line, p) > SNAP:
            continue
        c = shapely.get_coordinates(line, include_z=True)
        # The height at the nearest point of the line, between its two nearest vertices.
        s = line.project(p)
        along = np.r_[0, np.cumsum(np.hypot(*np.diff(c[:, :2], axis=0).T))]
        zz = np.interp(s, along, c[:, 2])
        if zz > LOW_HEIGHT and (np.isnan(z[i]) or shapely.distance(line, p) < 0.01):
            z[i] = zz
    ok = ~np.isnan(z)
    if ok.sum() < 2:
        return None
    # Between surveyed heights, along the outline (it is a ring).
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(np.vstack([ring, ring[:1]]), axis=0).T))][:-1]
    total = poly.exterior.length
    known = np.nonzero(ok)[0]
    xs = np.r_[s[known] - total, s[known], s[known] + total]
    z = np.interp(s, xs, np.r_[z[known], z[known], z[known]])
    return np.column_stack([ring, z])


def profile(ring):
    """(u, s, z) of a flight: `u` the unit direction it climbs in (the slope of a plane fit
    to its outline's heights), and its height z against the distance s along u, from
    the outline's heights in BIN-wide slices, never going down (a landing is flat);
    None where the outline doesn't slope."""
    xy, h = ring[:, :2], ring[:, 2]
    A = np.column_stack([xy - xy.mean(axis=0), np.ones(len(xy))])
    (gx, gy, g0), *_ = np.linalg.lstsq(A, h, rcond=None)
    slope = np.hypot(gx, gy)
    if slope < MIN_SLOPE:
        return None
    # Flights that turn (two arms at an angle) don't lie on one sloping plane: left out.
    misfit = np.sqrt(np.mean((A @ [gx, gy, g0] - h) ** 2))
    if misfit > MISFIT * (h.max() - h.min()):
        return None
    u = np.array([gx, gy]) / slope
    along = xy @ u
    edges = np.arange(along.min(), along.max() + BIN, BIN)
    k = np.clip(np.searchsorted(edges, along, side="right") - 1, 0, len(edges) - 1)
    ss, zz = [], []
    for b in np.unique(k):
        ss.append(along[k == b].mean())
        zz.append(np.median(h[k == b]))
    ss, zz = np.array(ss), np.maximum.accumulate(np.array(zz))
    return u, np.r_[along.min(), ss, along.max()], np.r_[zz[0], zz, zz[-1]]


def treads(poly, ring):
    """(treads [(height of the top, Polygon)], nosings [(height, LineString)]) of a flight:
    `poly` its outline, `ring` its outline's points with heights (heights()). The treads
    are cut straight across the way the flight climbs (profile()), at the distances
    where its profile passes each step's height."""
    got = profile(ring)
    if got is None:
        return [], []
    u, ss, zz = got
    lo, hi = zz[0], zz[-1]
    rise = hi - lo
    if rise < MIN_RISE:
        return [], []
    n = max(1, round(rise / RISER))
    if n > MAX_STEPS:
        return [], []
    levels = lo + rise * np.arange(n + 1) / n
    # Even treads from where the flight leaves its foot to where it reaches its head;
    # the flat ends are landings.
    start = ss[max(0, np.argmax(zz > lo + FLAT) - 1)]
    end = ss[np.argmax(zz >= hi - FLAT)]
    if end - start < n * MIN_TREAD:
        start, end = ss[0], ss[-1]
    if not MIN_TREAD <= (end - start) / n <= MAX_TREAD:  # the way it climbs is misread
        return [], []
    cuts = [ss[0], *np.linspace(start, end, n + 1)[1:-1], ss[-1]]
    v = np.array([-u[1], u[0]])
    c = np.asarray(poly.centroid.coords[0])
    base, far = c - u * (c @ u), poly.length  # base + u * s is at distance s along u

    def strip(a, b):
        return Polygon([base + u * a - v * far, base + u * a + v * far, base + u * b + v * far, base + u * b - v * far])
    out, noses = [], []
    for k in range(n):
        h = float(levels[k + 1])
        band = poly.intersection(strip(cuts[k] - (1.0 if k == 0 else 0.0), cuts[k + 1] + (1.0 if k == n - 1 else 0.0)))
        parts = [p for p in shapely.get_parts(band) if isinstance(p, Polygon) and p.area > 0.01]
        if len(parts) > 1:  # the cut crosses the outline twice: not one straight run
            return [], []
        for p in parts:
            out.append((h, shapely.Polygon(p.exterior).simplify(0.01)))
        if k:
            line = shapely.LineString([base + u * cuts[k] - v * far, base + u * cuts[k] + v * far])
            for ln in shapely.get_parts(line.intersection(poly)):
                if isinstance(ln, LineString) and ln.length > 0.1:
                    noses.append((h, ln))
    # A flight with several arms or a sharp turn gets treads cut along an arm instead of
    # across it, much wider than the rest: such flights are left out.
    widths = [np.ptp(shapely.get_coordinates(p) @ v) for _, p in out]
    if widths and max(widths) > WIDER * np.median(widths) + 0.5:
        return [], []
    return out, noses


def stairs():
    """Every flight in Prague: [{"treads": [(h, Polygon)], "noses": [(h, LineString)]}]
    in WGS84, read from the packages once and kept in stairs.pkl until they change."""
    polys = sorted(PACKAGES.glob("*.zip"))
    lines = {_district(p): p for p in sorted(LINES.glob("*.zip"))}
    key = [VERSION, [build_cache.identity(p) for p in polys], [build_cache.identity(p) for p in lines.values()],
           [RISER, MIN_RISE, MAX_STEPS, SNAP, DENSE, BIN, MIN_SLOPE, MISFIT, FLAT, MIN_TREAD, MAX_TREAD, WIDER],
           [build_cache.function_key(f) for f in (stairs, heights, profile, treads, _tables, _wkb)], build_cache.runtime_key()]
    got = build_cache.load_pickle(PARSED, key)
    if got:
        return got["stairs"]
    print(f"dtm stairs: reading the {len(polys)} districts' stairs", flush=True)
    out, failed = [], []
    for package in polys:
        outlines = lines.get(_district(package))
        if outlines is None:
            continue
        flights = shapely.force_2d(shapely.from_wkb(list(_tables(package, POLYGONS))))
        edges = shapely.from_wkb(list(_tables(outlines, OUTLINES)))
        if not len(flights) or not len(edges):
            continue
        tree = STRtree(edges)
        for g in flights:
            for poly in shapely.get_parts(shapely.make_valid(g)):
                if not isinstance(poly, Polygon) or poly.area < 0.5:
                    continue
                ring = heights(poly, edges, tree)
                if ring is None:
                    continue
                try:
                    ts, ns = treads(poly, ring)
                except (shapely.errors.GEOSException, ValueError) as e:  # an outline the cutting can't handle
                    failed.append(str(e)[:80])
                    continue
                if ts:
                    wgs = lambda geoms: shapely.transform(np.array(geoms, dtype=object), lambda c: np.column_stack(TO_WGS.transform(c[:, 0], c[:, 1])))  # noqa: E731
                    out.append({"treads": list(zip([h for h, _ in ts], wgs([p for _, p in ts]))),
                                "noses": list(zip([h for h, _ in ns], wgs([ln for _, ln in ns]))) if ns else []})
    if failed:
        print(f"dtm stairs: {len(failed)} flights left out, e.g. {failed[0]}")
    CACHE.mkdir(parents=True, exist_ok=True)
    build_cache.atomic(PARSED, pickle.dumps({"key": key, "stairs": out}, protocol=5))
    return out


def survey(bbox, transform):
    """The flights whose middle is in a WGS84 box, in local metres (`transform`: lon, lat
    arrays → x, y arrays), as the tiles carry them: {"t": [[h, x0, y0, x1, y1, …]],
    "n": [[h, x0, y0, …]]}, heights in m a.s.l. to the cm."""
    global _index
    if _index is None:
        all_ = stairs() if any(PACKAGES.glob("*.zip")) and any(LINES.glob("*.zip")) else []
        middles = shapely.points([s["treads"][0][1].centroid.coords[0] for s in all_]) if all_ else np.array([], dtype=object)
        _index = (STRtree(middles), all_)
    tree, all_ = _index
    w, s, e, n = bbox
    out = []
    for k in sorted(tree.query(shapely.box(w, s, e, n), predicate="contains")):
        flight = all_[k]
        to_local = lambda g: shapely.transform(g, lambda c: np.column_stack(transform(c[:, 0], c[:, 1])))  # noqa: E731
        flat = lambda h, coords: [round(h, 2), *np.round(np.asarray(coords), 2).ravel().tolist()]  # noqa: E731
        out.append({"t": [flat(h, np.asarray(to_local(p).exterior.coords)[:-1]) for h, p in flight["treads"]],
                    "n": [flat(h, to_local(ln).coords) for h, ln in flight["noses"]]})
    return out


if __name__ == "__main__":
    got = stairs()
    t = sum(len(s["treads"]) for s in got)
    print(f"{len(got)} flights of stairs, {t} treads")
