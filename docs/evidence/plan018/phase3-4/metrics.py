"""Plan 018 phases 3-4: numbers from two builds' ground chunk layers.

    python metrics.py <before layers/<area> dir> <after layers/<area> dir> [out.json]

Areas in m2 after clipping to tiles; points are ring vertices as written to the tiles.
"""
import glob
import json
import sys
from pathlib import Path

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

WALKED = ("pavement", "pavement_asphalt")


def polys(v):
    out = []
    for r in v or []:
        if len(r[0]) >= 3:
            out.append(shapely.make_valid(Polygon(r[0], r[1:])))
    return unary_union(out) if out else Polygon()


def points(v):
    return sum(len(ring) for r in v or [] for ring in r)


def load(folder, layer):
    tiles = {}
    for f in sorted(glob.glob(f"{folder}/{layer}/*.json")):
        tiles.update(json.load(open(f))["tiles"])
    return tiles


def summary(folder):
    ground, streets, buildings = load(folder, "ground"), load(folder, "streets"), load(folder, "buildings")
    tot = {}
    per_tile = {}
    odd = {"path_on_road": 0.0, "path_on_building": 0.0, "path_on_water": 0.0, "path_on_surveyed": 0.0}
    walk = {"sidewalk_m": 0.0, "sidewalk_on_surveyed_m": 0.0, "sidewalk_on_ribbon_m": 0.0, "sidewalk_on_either_m": 0.0,
            "sidewalk_within_1m_m": 0.0, "walk_m": 0.0, "walk_on_surveyed_m": 0.0}
    kerb = {"sides": 0, "outside_is_surveyed_walk": 0, "outside_is_road": 0, "inside_is_surveyed_walk": 0}
    for k, t in ground.items():
        R = t.get("roads", {})
        for key, v in R.items():
            g = polys(v)
            d = tot.setdefault(key, {"area": 0.0, "points": 0, "pieces": 0})
            d["area"] += g.area
            d["points"] += points(v)
            d["pieces"] += len(v)
        path, walked = polys(R.get("path")), unary_union([polys(R.get(x)) for x in WALKED] + [polys(R.get("trambed")) if False else Polygon()])
        road = unary_union([polys(R.get("road")), polys(R.get("sett"))])
        per_tile[k] = {"surveyed": round(walked.area), "ribbons": round(path.area), "trambed": round(polys(R.get("trambed")).area)}
        if not path.is_empty:
            odd["path_on_road"] += path.intersection(road).area
            odd["path_on_water"] += path.intersection(polys(t.get("areas", {}).get("water"))).area
            odd["path_on_surveyed"] += path.intersection(walked).area
            b = unary_union([shapely.make_valid(Polygon(x["rings"][0], x["rings"][1:])) for x in buildings.get(k, {}).get("buildings", [])])
            odd["path_on_building"] += path.intersection(b).area
        s = streets.get(k, {})
        ribbon_or = unary_union([path, walked])
        near = walked.buffer(1.0) if not walked.is_empty else walked
        tb = shapely.box(*tile_box(k))
        for e in s.get("walk", []):
            ls = LineString(e["pts"]).intersection(tb)
            if ls.is_empty or e.get("bridge") or e.get("tunnel") or e.get("passage"):
                continue
            walk["walk_m"] += ls.length
            walk["walk_on_surveyed_m"] += ls.intersection(walked).length
        for e in s.get("drive", []):
            if not e.get("kerb") or e.get("bridge") or e.get("tunnel"):
                continue
            line = LineString(e["pts"])
            if line.length < 20:
                continue
            for side, off in ((-1, e["kerb"][0]), (1, e["kerb"][1])):  # right, left
                if off is None:
                    continue
                for d in np.arange(10, line.length - 10 + 1e-6, 10):
                    p, q = line.interpolate(d - 0.5), line.interpolate(d + 0.5)
                    tx, ty = q.x - p.x, q.y - p.y
                    n = (tx * tx + ty * ty) ** 0.5 or 1
                    nx, ny = -ty / n * side, tx / n * side
                    m = line.interpolate(d)
                    if not tb.contains(m):
                        continue
                    out = shapely.Point(m.x + nx * (off + 0.7), m.y + ny * (off + 0.7))
                    inn = shapely.Point(m.x + nx * (off - 0.7), m.y + ny * (off - 0.7))
                    kerb["sides"] += 1
                    kerb["outside_is_surveyed_walk"] += bool(walked.contains(out))
                    kerb["outside_is_road"] += bool(road.contains(out))
                    kerb["inside_is_surveyed_walk"] += bool(walked.contains(inn))
    return {"kinds": {k: {"area": round(v["area"], 1), "points": v["points"], "pieces": v["pieces"]} for k, v in sorted(tot.items())},
            "odd": {k: round(v, 1) for k, v in odd.items()}, "walk": {k: round(v) for k, v in walk.items()},
            "kerb": kerb, "per_tile": per_tile,
            "bytes_ground": sum(Path(f).stat().st_size for f in glob.glob(f"{folder}/ground/*.json"))}


META = None


def tile_box(k):
    i, j = map(int, k.split("_"))
    x0, y0 = META["box"][0], META["box"][1]
    T = META["tile"]
    return (x0 + i * T, y0 + j * T, min(META["box"][2], x0 + (i + 1) * T), min(META["box"][3], y0 + (j + 1) * T))


if __name__ == "__main__":
    before, after = sys.argv[1], sys.argv[2]
    META = json.load(open(f"{after}/meta.json"))
    out = {"before": summary(before), "after": summary(after)}
    for side in ("before", "after"):
        s = out[side]
        print(side, json.dumps({k: v for k, v in s.items() if k != "per_tile"}, indent=1))
    print("per tile (surveyed pavement m2 / ribbons m2 before -> after):")
    for k in sorted(out["after"]["per_tile"], key=lambda k: tuple(map(int, k.split("_")))):
        a, b = out["after"]["per_tile"][k], out["before"]["per_tile"].get(k, {})
        print(f"  {k}: surveyed {a['surveyed']}, ribbons {b.get('ribbons')} -> {a['ribbons']}, tram bed {a['trambed']}")
    if len(sys.argv) > 3:
        json.dump(out, open(sys.argv[3], "w"), indent=1)
