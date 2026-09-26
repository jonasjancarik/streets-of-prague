"""Cut the present-day map of an area into square tiles the driving game streams in
around the camera, so an area can be as large as the city.

    uv run build_tiles.py centrum          # 250 m tiles → public/data/centrum_now/
    uv run build_tiles.py ujezd 200        # any area from build_area.AREAS, any size

Writes index.json (area size, origin, tile grid, all tram and funicular rails, since
trams run across tiles) and tiles/<i>_<j>.json. Each tile has its own clipped land
use, roads, rails, walls, weirs, crossings and trees; buildings that touch it, with
`own` set on the tile holding the building's centre (the one that draws it); and the
share of each paid-parking section that falls inside it, if <area>_parking.json exists.
Run build_traffic.py and build_parking.py for the same area as well.
"""

import json
import math
import sys
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box

from build_area import OUT, _coords, _lines, _polys, _rings, extract


def main(area: str = "centrum", tile: str = "250") -> None:
    T = float(tile)
    x = extract(area, "now")
    x0, y0, x1, y1 = x["box"]
    cols, rows = math.ceil((x1 - x0) / T), math.ceil((y1 - y0) / T)
    out_dir = OUT / f"{area}_now"
    (out_dir / "tiles").mkdir(parents=True, exist_ok=True)

    shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in x["buildings"]]
    centres = [p.representative_point() for p in shapes]
    line_sets = {
        "walls": [(w, w["pts"]) for w in x["walls"]],
        "rails": [(r, r["pts"]) for r in x["rails"]],
    }
    sections = []
    parking = OUT / f"{area}_parking.json"
    if parking.exists():
        for s in json.loads(parking.read_text())["sections"]:
            polys = [Polygon(r[0], r[1:]) for r in s["polys"]]
            full = sum(p.area for p in polys) / max(s["inside"], 1e-6)
            sections.append((s["code"], polys, full))

    tiles = []
    for i in range(cols):
        for j in range(rows):
            bx = box(x0 + i * T, y0 + j * T, min(x1, x0 + (i + 1) * T), min(y1, y0 + (j + 1) * T))
            t = {"i": i, "j": j, "box": [round(v, 2) for v in bx.bounds]}
            t["areas"] = {k: [_rings(p) for p in _polys(g.intersection(bx))] for k, g in x["areas"].items()}
            t["roads"] = {k: [_rings(p) for p in _polys(g.intersection(bx))] for k, g in x["roads"].items()}
            t["areas"] = {k: v for k, v in t["areas"].items() if v}
            t["roads"] = {k: v for k, v in t["roads"].items() if v}
            bx0, by0, bx1, by1 = bx.bounds
            last_i, last_j = i == cols - 1, j == rows - 1

            def own(c):  # half-open, so every centre belongs to exactly one tile
                return (bx0 <= c.x < bx1 or (last_i and c.x == bx1)) and (by0 <= c.y < by1 or (last_j and c.y == by1))

            t["buildings"] = [{**b, "own": own(centres[k])} for k, b in enumerate(x["buildings"]) if shapes[k].intersects(bx)]
            for key, items in line_sets.items():
                t[key] = []
                for item, pts in items:
                    for ls in _lines(LineString(pts).intersection(bx)):
                        t[key].append({**item, "pts": _coords(ls)})
            t["weirs"] = [_coords(ls) for w in x["weirs"] for ls in _lines(LineString(w).intersection(bx))]
            t["crossings"] = [_coords(ls) for c in x["crossings"] if len(c) > 1 for ls in _lines(LineString(c).intersection(bx))]
            t["trees"] = [p for p in x["trees"] if bx.contains(Point(p))]
            t["sections"] = []
            for code, polys, full in sections:
                a = sum(p.intersection(bx).area for p in polys)
                if a > 1:
                    t["sections"].append({"code": code, "share": round(a / full, 4)})
            if not (t["buildings"] or t["areas"] or t["roads"]):
                continue
            (out_dir / "tiles" / f"{i}_{j}.json").write_text(json.dumps(t, ensure_ascii=False, separators=(",", ":")))
            tiles.append([i, j, sum(b["own"] for b in t["buildings"])])

    w, s, e, n = x["bbox"]
    index = {
        "area": area, "bbox_wgs84": [w, s, e, n],
        "size": [round(x1 - x0, 2), round(y1 - y0, 2)], "origin": [round(-x0, 2), round(-y0, 2)],
        "tile": T, "cols": cols, "rows": rows, "tiles": tiles,
        "rails": x["rails"],
    }
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    total = sum(p.stat().st_size for p in (out_dir / "tiles").glob("*.json"))
    print(f"{area}: {x1 - x0:.0f} x {y1 - y0:.0f} m, {len(tiles)} tiles of {T:.0f} m, "
          f"{len(x['buildings'])} buildings, {total / 1e6:.1f} MB → {out_dir.name}/")


if __name__ == "__main__":
    main(*sys.argv[1:])
