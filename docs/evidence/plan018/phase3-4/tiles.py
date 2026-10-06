"""Plan 018 phases 3-4: two assembled maps compared tile by tile.

    python tiles.py <before public/data/<area>_now> <after …_now> [out.json]

Which tile fields differ at all; what the surveyed pavements lie on or under (IPR's
greenery, garden patches, inferred gardens, parking, squares); and where the things that
stand on the ground are (trees, utility marks, hedges, drive spots, parking lots).
"""
import glob
import gzip
import json
import os
import sys
from collections import Counter

import shapely
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union


def tile(path):
    return json.loads(gzip.open(path).read() if path.endswith(".gz") else open(path).read())


def tiles(folder):
    out = {}
    for f in glob.glob(f"{folder}/tiles/*.json*"):
        name = os.path.basename(f).split(".")[0]
        if f.endswith((".json", ".json.gz")):
            out[name] = f
    return out


def inter(a, b):
    """a ∩ b on a centimetre grid; empty where GEOS gives up on a degenerate ring."""
    try:
        return shapely.intersection(a, b, grid_size=0.01)
    except shapely.errors.GEOSException:
        return Polygon()


def polys(v):
    out = [Polygon(r[0], r[1:]).buffer(0) for r in v or [] if len(r[0]) >= 3]
    return shapely.union_all(out, grid_size=0.01) if out else Polygon()


def main(before, after, out=None):
    B, A = tiles(before), tiles(after)
    differ, same = Counter(), Counter()
    area, on = Counter(), Counter()
    for k in sorted(A):
        a, b = tile(A[k]), tile(B[k]) if k in B else {}
        for key in sorted(set(a) | set(b)):
            (same if a.get(key) == b.get(key) else differ)[key] += 1
        for key in sorted(set(a.get("areas", {})) | set(b.get("areas", {}))):
            if a.get("areas", {}).get(key) != b.get("areas", {}).get(key):
                differ[f"areas.{key}"] += 1
        for key in sorted(set(a.get("roads", {})) | set(b.get("roads", {}))):
            if a.get("roads", {}).get(key) != b.get("roads", {}).get(key):
                differ[f"roads.{key}"] += 1
        R, Ar = a.get("roads", {}), a.get("areas", {})
        paved = unary_union([polys(R.get(x)) for x in ("pavement", "pavement_asphalt")])
        bed = polys(R.get("trambed"))
        road = unary_union([polys(R.get("road")), polys(R.get("sett"))])
        area["surveyed pavement"] += paved.area
        area["tram bed"] += bed.area
        if paved.is_empty and bed.is_empty:
            continue
        for key, v in Ar.items():
            g = polys(v)
            area[key] += g.area
            on[f"pavement on areas.{key}"] += inter(paved, g).area
            on[f"tram bed on areas.{key}"] += inter(bed, g).area
        for key, v in (a.get("patches") or {}).items():
            on[f"pavement on patches.{key}"] += inter(paved, polys(v)).area
        on["pavement under road/sett"] += inter(paved, road).area
        on["tram bed over road/sett"] += inter(bed, road).area
        on["pavement on lots"] += inter(paved, polys([lot["rings"] for lot in a.get("lots", [])])).area
        on["pavement under buildings"] += inter(paved, polys([x["rings"] for x in a.get("buildings", [])])).area
        pts = lambda xs: shapely.points([p[:2] for p in xs]) if xs else []  # noqa: E731
        for name, xs in (("trees", a.get("trees")), ("utility marks", a.get("utility")), ("shrubs", a.get("shrubs")),
                         ("drive spots", [[d["x"], d["y"]] for d in a.get("drives", [])])):
            p = pts(xs or [])
            if len(p):
                on[f"{name}: all"] += len(p)
                on[f"{name}: on surveyed pavement"] += int(shapely.contains(paved, p).sum())
                on[f"{name}: on road/sett"] += int(shapely.contains(road, p).sum())
        hedges = [LineString(f["pts"]) for f in a.get("fences", []) if f.get("kind") == "hedge" and len(f["pts"]) > 1]
        if hedges:
            h = unary_union(hedges)
            on["hedges m: all"] += h.length
            on["hedges m: on surveyed pavement"] += h.intersection(paved).length
    res = {"tiles": len(A), "fields that differ in some tile": dict(sorted(differ.items())),
           "fields the same in every tile": sorted(k for k in same if k not in differ),
           "area m2": {k: round(v) for k, v in sorted(area.items()) if v >= 0.5},
           "overlaps": {k: round(v, 1) for k, v in sorted(on.items()) if v >= 0.05}}
    print(json.dumps(res, indent=1, ensure_ascii=False))
    if out:
        json.dump(res, open(out, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main(*sys.argv[1:])
