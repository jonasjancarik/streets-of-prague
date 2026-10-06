"""Surveyed walls, fences and railings, from the digital technical map (DTM kraje, ZPS).

Set 3 of the technical map (the lines; already downloaded for dtm_heights.py into
.cache/dtm/ZPS_KR/) has every wall, fence and railing the surveyors met, where OSM has
a wall or a fence here and there. In a tile the survey covers they stand in place of
OSM's and of the fences made up round the plots of family houses:

- walls ("Zeď", a line along the wall): an enclosing wall is as high as a garden wall,
  a retaining wall or one of an unknown kind is a low one (its height isn't in the
  map: a line's heights are sometimes the crown's, sometimes the ground's);
- fences ("Plot") and railings ("Zábradlí"), drawn as fences are, a railing lower.

The outlines of thick walls ("Hranice zdi") are left out: they are the two faces of
quay walls and retaining walls, which the terrain makes steps of (dtm_heights.py) and
the game puts a parapet on (src/stepEdges.ts).

A surveyed line is cut where a street or a path runs (a wall drawn across a gateway
would close it: walls are solid in the game). OSM's town walls and gates stay, with
their names and heights; so do hedges, which the survey doesn't know, unless a
surveyed fence or wall runs along them. Outside the survey (past the city's edge, or
with the packages missing) everything is OSM's, as before.

Source: DTM kraje – ZPS, datový podklad © IPR Praha (CC BY 4.0).

    uv run dtm_walls.py <area> [--before <tiles folder of the map before>]

counts the metres of surveyed and of OSM's walls and fences in each tile of a built map.
"""

import pickle
import sqlite3
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from shapely import STRtree
from shapely.geometry import LineString

import build_cache
from dtm import CACHE, _wkb

LINES = CACHE / "ZPS_KR"
PARSED = CACHE / "walls.pkl"
VERSION = 1
# By the DTM's object code: what it is here, and the column with its sort (or None).
CODES = {"010000016802": ("wall", "TypZdi"), "010000016202": ("fence", None), "010000019902": ("railing", None)}
ENCLOSING = 2  # TypZdi: a wall round a plot (1 and 3 hold the ground up, 99 isn't known)
WALL_H, LOW_WALL_H, FENCE_H, RAILING_H = 2.0, 1.0, 1.5, 1.0  # m
COVERED = 30.0  # m of surveyed lines in a tile: the survey has been there
SHORTEST = 2.0  # m: shorter pieces are left out
TOLERANCE = 0.15  # m: how far a line may be straightened
MARGIN = 0.0005  # degrees past a box
OPEN = 0.3  # m kept clear either side of a street's or a path's surface
ALONG = 1.2  # m: a hedge or fence this close to a surveyed line is the same one
TOWN_WALLS = ("city_wall", "castle_wall", "city_gate")
NEAR_TOWN_WALL = 3.0  # m: the survey's lines of a town wall OSM draws

_index = None  # per process: (STRtree, lines in WGS84, kinds, heights)


def lines():
    """(lines in WGS84, their kinds, their heights) for all of Prague, read from the
    packages once and kept in walls.pkl until they change."""
    packages = sorted(LINES.glob("*.zip"))
    key = [VERSION, [build_cache.identity(p) for p in packages], CODES, [WALL_H, LOW_WALL_H, FENCE_H, RAILING_H],
           [build_cache.function_key(f) for f in (lines, _read, _wkb)], build_cache.runtime_key()]
    got = build_cache.load_pickle(PARSED, key)
    if got:
        return got["lines"], got["kinds"], got["heights"]
    print(f"dtm walls: reading the {len(packages)} districts' lines", flush=True)
    blobs, kinds, heights = [], [], []
    for p in packages:
        for kind, h, blob in _read(p):
            blobs.append(blob); kinds.append(kind); heights.append(h)
    geoms = shapely.force_2d(shapely.from_wkb(blobs)) if blobs else np.array([], dtype=object)
    to_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True, area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))
    geoms = shapely.transform(geoms, lambda c: np.column_stack(to_wgs.transform(c[:, 0], c[:, 1])))
    keep = ~(shapely.is_missing(geoms) | shapely.is_empty(geoms))
    geoms, kinds, heights = geoms[keep], np.array(kinds, dtype=object)[keep], np.array(heights, dtype=np.float32)[keep]
    CACHE.mkdir(parents=True, exist_ok=True)
    build_cache.atomic(PARSED, pickle.dumps({"key": key, "lines": geoms, "kinds": kinds, "heights": heights}, protocol=5))
    return geoms, kinds, heights


def _read(package):
    """(kind, height, WKB in S-JTSK) of every wall, fence and railing on the ground in a package."""
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(package) as z:
        name = next(n for n in z.namelist() if n.endswith(".gpkg"))
        db = sqlite3.connect(z.extract(name, tmp))
        for (table,) in db.execute("select table_name from gpkg_contents").fetchall():
            kind, sort = CODES.get(table.split("#")[-1][:12], (None, None))
            if not kind:
                continue
            cols = {r[1] for r in db.execute(f'pragma table_info("{table}")')}
            level = "UrovenUmisteniObjektuZPS" if "UrovenUmisteniObjektuZPS" in cols else "0"
            sort = sort if sort in cols else "0"
            for blob, lv, s in db.execute(f'select shape, {level}, {sort} from "{table}" where shape is not null'):
                if int(lv or 0):
                    continue
                h = (WALL_H if int(s or 0) == ENCLOSING else LOW_WALL_H) if kind == "wall" else FENCE_H if kind == "fence" else RAILING_H
                yield kind, h, bytes(_wkb(blob))
        db.close()


def _parts(g):
    return [ln for ln in shapely.get_parts(g) if isinstance(ln, LineString) and not ln.is_empty] if g is not None and not g.is_empty else []


def survey(bbox, transform):
    """[(kind, height, line in local metres)] of the survey within a WGS84 box."""
    global _index
    if _index is None:
        geoms, kinds, heights = lines() if any(LINES.glob("*.zip")) else (np.array([], dtype=object), np.array([], dtype=object), np.zeros(0))
        _index = (STRtree(geoms), geoms, kinds, heights)
    tree, geoms, kinds, heights = _index
    w, s, e, n = bbox
    hits = np.sort(tree.query(shapely.box(w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN)))
    if not len(hits):
        return []
    local = shapely.transform(geoms[hits], lambda c: np.column_stack(transform(c[:, 0], c[:, 1])))
    return [(kinds[k], float(heights[k]), ln) for k, g in zip(hits, local) for ln in _parts(g)]


def replace(tile, box, surveyed, tree, open_ground):
    """Put the survey's walls and fences in a tile's ground layer (`tile`: its "walls"
    and "fences", already cut to `box`) in place of OSM's, if the survey covers it.
    `surveyed`: survey()'s lines with their STRtree `tree`; `open_ground`: the tile's
    streets and paths, which no surveyed line may cross. Returns the metres of
    (surveyed walls, surveyed fences, OSM's walls and fences taken out)."""
    hits = sorted(tree.query(box)) if surveyed else []
    got = []
    for k in hits:
        kind, h, line = surveyed[k]
        for ln in _parts(line.intersection(box)):
            got.append((kind, h, ln))
    if sum(ln.length for _, _, ln in got) < COVERED:
        return 0.0, 0.0, 0.0
    town = [LineString(wl["pts"]) for wl in tile["walls"] if wl.get("kind") in TOWN_WALLS and len(wl["pts"]) > 1]
    clear = [open_ground.buffer(OPEN)] if open_ground is not None and not open_ground.is_empty else []
    if town:
        clear.append(shapely.union_all(town).buffer(NEAR_TOWN_WALL))
    clear = shapely.union_all(clear) if clear else None
    walls, fences = [], []
    for kind, h, ln in got:
        for piece in _parts(ln.difference(clear) if clear is not None else ln):
            piece = piece.simplify(TOLERANCE)
            if piece.length >= SHORTEST:
                (walls if kind == "wall" else fences).append((h, piece))
    # A fence on a wall is the wall.
    if walls and fences:
        beside = shapely.union_all([ln for _, ln in walls]).buffer(0.6)
        fences = [(h, p) for h, ln in fences for p in _parts(ln.difference(beside)) if p.length >= SHORTEST]
    mine = shapely.union_all([ln for _, ln in walls + fences]).buffer(ALONG) if walls or fences else None
    taken = 0.0
    kept_walls, kept_fences = [], []
    for wl in tile["walls"]:
        if wl.get("kind") in TOWN_WALLS:
            kept_walls.append(wl)
        elif len(wl["pts"]) > 1:
            taken += LineString(wl["pts"]).length
    for f in tile["fences"]:
        if f.get("kind") == "guard_rail":
            kept_fences.append(f)
        elif f.get("kind") == "hedge":
            # (Whole, or not at all: a hedge is short, and half of one looks cut off.)
            ln = LineString(f["pts"]) if len(f["pts"]) > 1 else None
            if ln is None or mine is None or ln.intersection(mine).length < 0.5 * ln.length:
                kept_fences.append(f)
        elif len(f["pts"]) > 1:
            taken += LineString(f["pts"]).length
    coords = lambda ln: [[round(x, 2), round(y, 2)] for x, y in ln.coords]  # noqa: E731
    tile["walls"] = kept_walls + [{"kind": "wall", "name": None, "h": h, "s": 1, "pts": coords(ln)} for h, ln in walls]
    tile["fences"] = kept_fences + [{"kind": "fence", "h": h, "s": 1, "pts": coords(ln)} for h, ln in fences]
    return sum(ln.length for _, ln in walls), sum(ln.length for _, ln in fences), taken


def main():
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Metres of surveyed and of OSM's walls and fences in each tile of a built map")
    ap.add_argument("area", nargs="?", default="ujezd")
    ap.add_argument("--before", help="the tiles folder of the map before the survey's walls, to count what OSM had")
    ap.add_argument("--tiles", action="store_true", help="a line for every tile")
    args = ap.parse_args()
    folder = Path(__file__).parent.parent / "public" / "data" / f"{args.area}_now" / "tiles"

    def metres(path):
        try:
            t = json.loads(path.read_text())
        except OSError:
            return None
        out = {"wall": [0.0, 0.0], "fence": [0.0, 0.0], "hedge": [0.0, 0.0], "guard_rail": [0.0, 0.0]}
        for key in ("walls", "fences"):
            for item in t.get(key, []):
                kind = "wall" if key == "walls" else item.get("kind", "fence")
                pts = np.array(item["pts"])
                out.setdefault(kind, [0.0, 0.0])[1 if item.get("s") else 0] += float(np.hypot(*(pts[1:] - pts[:-1]).T).sum())
        return out

    total = {"survey walls": 0.0, "survey fences": 0.0, "osm walls": 0.0, "osm fences": 0.0, "osm walls before": 0.0, "osm fences before": 0.0}
    covered = count = 0
    for path in sorted(folder.glob("*.json"), key=lambda p: [int(v) for v in p.stem.split("_")]):
        now = metres(path)
        was = metres(Path(args.before) / path.name) if args.before else None
        count += 1
        covered += bool(now["wall"][1] + now["fence"][1])
        total["survey walls"] += now["wall"][1]; total["survey fences"] += now["fence"][1]
        total["osm walls"] += now["wall"][0]; total["osm fences"] += now["fence"][0]
        if was:
            total["osm walls before"] += was["wall"][0]; total["osm fences before"] += was["fence"][0]
        if args.tiles:
            before = f"   before: walls {was['wall'][0]:6.0f} fences {was['fence'][0]:6.0f}" if was else ""
            print(f"{path.stem:>8}  survey: walls {now['wall'][1]:6.0f} fences {now['fence'][1]:6.0f}   OSM kept: walls {now['wall'][0]:6.0f} fences {now['fence'][0]:6.0f}{before}")
    print(f"{args.area}: {count} tiles, {covered} with surveyed walls or fences")
    for k, v in total.items():
        if v or "before" not in k:
            print(f"  {k:<18} {v / 1000:8.1f} km")


if __name__ == "__main__":
    main()
