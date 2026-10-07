"""Surveyed walls, fences and railings, from the digital technical map (DTM kraje, ZPS).

Set 3 of the technical map (the lines; already downloaded for dtm_heights.py into
.cache/dtm/ZPS_KR/) has every wall, fence and railing the surveyors met, where OSM has
a wall or a fence here and there. In a tile the survey covers they stand in place of
OSM's fences, of OSM's walls where the survey has a wall along them, and of the fences
made up round the plots of family houses:

- walls ("Zeď", a line along the wall): an enclosing wall is as high as a garden wall,
  a retaining wall or one of an unknown kind is a low one (its height isn't in the
  map: a line's heights are sometimes the crown's, sometimes the ground's);
- fences ("Plot") and railings ("Zábradlí"), drawn as fences are, a railing lower.

The outlines of thick walls ("Hranice zdi") are left out: they are the two faces of
quay walls and retaining walls, which the terrain makes steps of (dtm_heights.py) and
the game puts a parapet on (src/stepEdges.ts), and of the big garden walls, which stay
as OSM has them (cut at the same openings as the survey's).

A surveyed line is cut wherever something goes through (openings(): a wall drawn across
a gateway would close it, and walls are solid in the game): on the streets' and paths'
surfaces, across every street and path of the map over its width, in the passages
through buildings, at the gates of family houses' plots (plots.py) and right by a
building, where the door may be. OSM's town walls and gates stay, with
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
WAY_MIN = 1.0  # m: the least half width left open across a path
GATE = 1.6  # m each side of a plot's gate (as plots.py leaves in its own fences)
BY_HOUSE = 0.8  # m from a building: no wall there (a door opens onto it; the house is the wall)
ALONG = 1.2  # m: a hedge or fence this close to a surveyed line is the same one
SAME_WALL = 2.0  # m: OSM's wall this close to a surveyed wall is that wall
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


def openings(x):
    """Where a chunk's surveyed lines are cut: `x`, the chunk's extract (osm_area.py)."""
    parts = [g for g in x["roads"].values() if not g.is_empty]
    parts = [shapely.union_all(parts).buffer(OPEN)] if parts else []
    ways = x.get("ways") or []
    if ways:
        parts.append(shapely.union_all(shapely.buffer(np.array([ls for ls, _ in ways], dtype=object),
                                                      np.array([max(WAY_MIN, half + OPEN) for _, half in ways]), cap_style="flat")))
    passages = [LineString(p["pts"]).buffer(p["w"] / 2 + 0.5) for p in x.get("passages", []) if len(p["pts"]) > 1]
    gates = [shapely.Point(p["gate"][:2]).buffer(GATE) for p in x.get("plots", []) if p.get("gate")]
    houses = [shapely.Polygon(b["rings"][0], b["rings"][1:]) for b in x.get("buildings", [])]
    if houses:
        parts.append(shapely.union_all(shapely.buffer(shapely.make_valid(np.array(houses, dtype=object)), BY_HOUSE)))
    parts += passages + gates
    return shapely.union_all(parts) if parts else None


def replace(tile, box, surveyed, tree, open_ground):
    """Put the survey's walls and fences in a tile's ground layer (`tile`: its "walls"
    and "fences", already cut to `box`) in place of OSM's, if the survey covers it.
    `surveyed`: survey()'s lines with their STRtree `tree`; `open_ground`: openings(),
    which no surveyed line may cross. Returns the metres of
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
    clear = [open_ground.intersection(box.buffer(1.0))] if open_ground is not None and not open_ground.is_empty else []
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
    # OSM's wall goes where the survey has a wall along it. Elsewhere it stays: a thick
    # wall (round a palace garden, say) is two outlines in the survey, not a wall's line.
    beside_walls = shapely.union_all([ln for _, ln in walls]).buffer(SAME_WALL) if walls else None
    for wl in tile["walls"]:
        if wl.get("kind") in TOWN_WALLS:
            kept_walls.append(wl)
        elif len(wl["pts"]) > 1:
            ln = LineString(wl["pts"])
            rest = ln.difference(beside_walls) if beside_walls is not None else ln
            if clear is not None:
                rest = rest.difference(clear)
            pieces = [p for p in _parts(rest) if p.length >= SHORTEST]
            kept_walls.extend({**wl, "pts": [[round(x, 2), round(y, 2)] for x, y in p.coords]} for p in pieces)
            taken += ln.length - sum(p.length for p in pieces)
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
    ap.add_argument("--crossings", action="store_true", help="count the streets, paths and gates a wall or fence closes, instead")
    ap.add_argument("--list", type=int, default=8, help="how many new ones to list of each kind")
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

    def blocked(path):
        """What a tile's walls close: the graph's edges that cross a wall's solid strip
        (0.9 m wide in the collision grid), the plots' gates in one, and the same for
        fences (which stop only the player) → {kind: [(what, x, y)]}."""
        try:
            t = json.loads(path.read_text())
        except OSError:
            return {}
        bx = shapely.box(*t["box"])
        out = {}
        for key, reach in (("walls", 0.45), ("fences", 0.15)):
            items = [LineString(i["pts"]) for i in t.get(key, []) if len(i["pts"]) > 1 and i.get("kind") not in ("guard_rail", "hedge")]
            if not items:
                continue
            solid = shapely.union_all(items).buffer(reach)
            shapely.prepare(solid)
            for graph in ("drive", "walk"):
                for e in t.get(graph, []):
                    if e.get("bridge") or e.get("tunnel") or len(e["pts"]) < 2:
                        continue
                    hit = LineString(e["pts"]).intersection(bx).intersection(solid)
                    if not hit.is_empty and hit.length > 0.05:
                        c = hit.representative_point()
                        out.setdefault(f"{graph} edges across {key}", []).append((e.get("hw"), round(c.x), round(c.y)))
            for p in t.get("plots", []):
                if p.get("gate") and solid.contains(shapely.Point(p["gate"][:2])):
                    out.setdefault(f"plot gates in {key}", []).append(("gate", round(p["gate"][0]), round(p["gate"][1])))
        return out

    if args.crossings:
        now, was = {}, {}
        for path in sorted(folder.glob("*_*.json")):
            if not path.stem.replace("_", "").isdigit():
                continue
            for k, v in blocked(path).items():
                now.setdefault(k, []).extend((path.stem, *i) for i in v)
            if args.before:
                for k, v in blocked(Path(args.before) / path.name).items():
                    was.setdefault(k, []).extend((path.stem, *i) for i in v)
        print(f"{args.area}: what walls and fences close (now{', before' if args.before else ''})")
        for k in sorted(set(now) | set(was)):
            print(f"  {k:<28} {len(now.get(k, [])):5d}" + (f" {len(was.get(k, [])):5d}" if args.before else ""))
            fresh = sorted(set(now.get(k, [])) - set(was.get(k, [])))
            for item in fresh[:args.list]:
                print(f"      new: tile {item[0]}  {item[1]}  at {item[2]}, {item[3]}")
        return

    total = {"survey walls": 0.0, "survey fences": 0.0, "osm walls": 0.0, "osm fences": 0.0, "osm walls before": 0.0, "osm fences before": 0.0}
    covered = count = 0
    for path in sorted((p for p in folder.glob("*_*.json") if p.stem.replace("_", "").isdigit()), key=lambda p: [int(v) for v in p.stem.split("_")]):
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
