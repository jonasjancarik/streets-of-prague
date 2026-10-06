"""Lawns, shrubs, hedges and flower beds from IPR Praha's open data, the greenery the
city looks after (Hosted/OPK_CUR_OPK_SMZ_VP_P, about 127,000 polygons, and the single
shrubs among the points of OPK_CUR_OPK_SMZ_VP_B, about 30,000). CC BY.

    uv run ipr_greenery.py download        # the whole city → .cache/greenery/
    uv run ipr_greenery.py build praha     # → .cache/layers/praha/greenery.json, then the tiles

The survey is of what the city tends, so it is exact where it has something and silent
elsewhere (private gardens, most courtyards). Where it has something it goes over what
the map only guesses there: the gardens and lawns made up for a block (osm_area.py), the
technical map's "maintained green" and the photos' grass and tree canopy
(ground_cover.py). A tile gets, cut to its box (layers.merge_greenery):

    areas.ipr_lawn     lawns of every kind (trávník, parkový, parterový…)
    areas.ipr_meadow   meadow lawns and what grows wild (luční, bylinné společenstvo, ruderální)
    areas.ipr_bed      flower beds (annuals, roses, perennials)
    areas.ipr_shrubs   groups of shrubs, and hedges too wide or too crooked to be a row
    areas.wood         groups of trees and stands of woody plants, added to the woods
    fences             hedges, as rows along their middle (kind "hedge", h from their shape:
                       clipped ones low, free-growing ones high), unless the map has one there
    shrubs             single shrubs, [x, y]

src/ground.ts draws the areas, src/map/vegetation.ts fills the shrub groups with shrubs
and makes up no trees on the surveyed lawns (IPR's own trees stand there, ipr_trees.py).
"""


import argparse
import math
import time
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box as shapely_box

import build_cache
import ipr_open
import layers
from osm_area import AREAS

POLYGONS = "OPK_CUR_OPK_SMZ_VP_P"
POINTS = "OPK_CUR_OPK_SMZ_VP_B"


def download():
    """(polygons, shrubs): [[kod_vp, kod_tvar, rings in lon/lat], …] and [[lon, lat], …]."""
    def polygons():
        return [[f["attributes"]["kod_vp"], f["attributes"].get("kod_tvar"), f["geometry"]["rings"]]
                for f in ipr_open.pages(POLYGONS, fields="kod_vp,kod_tvar", what="greenery polygons")
                if (f.get("geometry") or {}).get("rings")]

    def shrubs():
        return [[x, y] for f in ipr_open.pages(POINTS, where="kod_vp=51", what="shrubs")
                if f.get("geometry") for x, y in f["geometry"]["points"]]

    return ipr_open.cached("greenery/polygons.json", polygons), ipr_open.cached("greenery/shrubs.json", shrubs)


# kod_vp → the tile's area it goes into.
LAWN, MEADOW, BED, SHRUBS, GROVE, HEDGE = "ipr_lawn", "ipr_meadow", "ipr_bed", "ipr_shrubs", "ipr_grove", "hedge"
CLASSES = {
    121: LAWN, 123: LAWN, 124: LAWN, 125: LAWN, 126: LAWN,
    122: MEADOW, 31: MEADOW, 32: MEADOW,
    11: BED, 12: BED, 13: BED, 14: BED,
    41: SHRUBS, 51: SHRUBS,
    61: GROVE, 111: GROVE,
    131: HEDGE,
    # Left out: 21 plants in tubs, 101 climbers, 127 grass pavers.
}
TOLERANCE = 0.15  # m the outlines are simplified by
MIN_AREA = {LAWN: 4.0, MEADOW: 4.0, BED: 1.0, SHRUBS: 1.5, GROVE: 12.0}  # m2: smaller pieces are left out
HEDGE_MAX_W = 2.4  # m: a wider "hedge" is a bed of shrubs
HEDGE_H = {1: 1.1, 2: 1.7}  # kod_tvar: clipped (tvarovaný), free-growing (volně rostlý)
HEDGE_MIN = 1.5  # m: shorter rows are left out


def centreline(poly):
    """The line along the middle of a long thin polygon (a hedge's outline), and its mean
    width; None if it isn't one. The outline is walked both ways from a point on it, and
    the start is chosen so the two walks stay closest together: they then run along the
    hedge's two sides, and the line is half-way between them."""
    if poly.interiors or poly.length < 2 * HEDGE_MIN:
        return None
    n = max(16, min(400, int(poly.length / 0.4)))
    n += n % 2
    ring = poly.exterior
    p = np.array([ring.interpolate(k / n, normalized=True).coords[0] for k in range(n)])
    half = n // 2
    k = np.arange(half + 1)
    best, cost = 0, math.inf
    for i in range(half):
        c = np.hypot(*(p[(i + k) % n] - p[(i - k) % n]).T).mean()
        if c < cost:
            best, cost = i, c
    a, b = p[(best + k) % n], p[(best - k) % n]
    width = float(np.hypot(*(a - b).T)[1:-1].mean()) if half > 1 else 0.0
    line = LineString((a + b) / 2).simplify(0.25)
    if width > HEDGE_MAX_W or line.length < HEDGE_MIN or line.length < 2.5 * width:
        return None
    return line, width


def rings_of(geom):
    """A (multi)polygon as the tiles' [[outer, hole…], …], rounded to 10 cm."""
    out = []
    for g in getattr(geom, "geoms", [geom]):
        if g.geom_type != "Polygon" or g.is_empty:
            continue
        rings = [[[round(x, 1), round(y, 1)] for x, y in r.coords[:-1]] for r in [g.exterior, *g.interiors]]
        if len(rings[0]) >= 3:
            out.append([r for r in rings if len(r) >= 3])
    return out


def tiles_of(meta, bounds):
    """The tiles (i, j) a box in local metres reaches into."""
    T, (x0, y0, _, _) = meta["tile"], meta["box"]
    i0, j0 = max(0, int((bounds[0] - x0) // T)), max(0, int((bounds[1] - y0) // T))
    i1, j1 = min(meta["cols"] - 1, int((bounds[2] - x0) // T)), min(meta["rows"] - 1, int((bounds[3] - y0) // T))
    return [(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]


def processing():
    return [build_cache.digest(Path(__file__).read_bytes())]


def build(area):
    meta = layers.read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: run build_tiles.py {area} first")
    started = time.time()
    polygons, shrubs = download()
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)
    tiles, counts = {}, {}

    def tile(i, j):
        return tiles.setdefault(f"{i}_{j}", {"areas": {}, "hedges": [], "shrubs": []})

    for kod, shape, rings in polygons:
        cls = CLASSES.get(kod)
        lon, lat = rings[0][0]
        if cls is None or not (w - 0.01 <= lon <= e + 0.01 and s - 0.01 <= lat <= n + 0.01):
            continue
        local = [list(zip(*tf.transform([p[0] for p in r], [p[1] for p in r]))) for r in rings if len(r) >= 4]
        if not local:
            continue
        # ArcGIS lists a polygon's rings flat: outer ones clockwise, holes the other way.
        made = [Polygon(r).buffer(0) for r in local]
        outer = [g for g, r in zip(made, local) if not Polygon(r).exterior.is_ccw] or made
        holes = [g for g, r in zip(made, local) if Polygon(r).exterior.is_ccw and len(outer) < len(made)]
        poly = shapely.union_all(outer)
        if holes:
            poly = poly.difference(shapely.union_all(holes))
        poly = poly.simplify(TOLERANCE)
        if poly.is_empty or not poly.area:
            continue
        if cls == HEDGE:
            parts = [g for g in getattr(poly, "geoms", [poly]) if g.geom_type == "Polygon"]
            rows = [centreline(g) for g in parts]
            if all(rows):
                for line, _ in rows:
                    for i, j in tiles_of(meta, line.bounds):
                        piece = line.intersection(shapely_box(*layers.tile_box(meta, i, j)))
                        for part in getattr(piece, "geoms", [piece]):
                            if part.geom_type == "LineString" and part.length >= 1.0:
                                tile(i, j)["hedges"].append({"h": HEDGE_H.get(shape, 1.4), "pts": [[round(x, 1), round(y, 1)] for x, y in part.coords]})
                                counts[HEDGE] = counts.get(HEDGE, 0) + 1
                continue
            cls = SHRUBS
        for i, j in tiles_of(meta, poly.bounds):
            piece = poly.intersection(shapely_box(*layers.tile_box(meta, i, j)))
            got = [r for r in rings_of(piece) if Polygon(r[0], r[1:]).area >= MIN_AREA[cls]]
            if got:
                tile(i, j)["areas"].setdefault(cls, []).extend(got)
                counts[cls] = counts.get(cls, 0) + len(got)
    T, (x0, y0, _, _) = meta["tile"], meta["box"]
    near = [(lon, lat) for lon, lat in shrubs if w <= lon <= e and s <= lat <= n]
    if near:
        for x, y in zip(*tf.transform([p[0] for p in near], [p[1] for p in near])):
            i, j = int((x - x0) // T), int((y - y0) // T)
            if 0 <= i < meta["cols"] and 0 <= j < meta["rows"]:
                tile(i, j)["shrubs"].append([round(x, 1), round(y, 1)])
                counts["shrub"] = counts.get("shrub", 0) + 1
    layers.write_layer(area, "greenery", {
        "tile": meta["tile"], "tiles": tiles, "processing": processing(),
        "sources": build_cache.sources([ipr_open.CACHE / "greenery" / "polygons.json", ipr_open.CACHE / "greenery" / "shrubs.json"])})
    print(f"{area}: greenery in {len(tiles)} tiles ({', '.join(f'{v} {k}' for k, v in sorted(counts.items()))}), {time.time() - started:.0f} s")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=["download", "build"])
    ap.add_argument("area", nargs="?", default="praha", choices=AREAS)
    ap.add_argument("--no-assemble", action="store_true", help="build: leave the game's tiles alone")
    args = ap.parse_args()
    if args.cmd == "download":
        a, b = download()
        print(len(a), "polygons,", len(b), "shrubs")
        return
    build(args.area)
    if not args.no_assemble:
        layers.assemble(args.area)


if __name__ == "__main__":
    main()
