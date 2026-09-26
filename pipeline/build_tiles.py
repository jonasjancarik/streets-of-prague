"""Cut the present-day map of an area into square tiles the driving game streams in
around the camera, so an area can be as large as the city.

    uv run build_tiles.py centrum          # 250 m tiles → public/data/centrum_now/
    uv run build_tiles.py praha 250 2000   # tile size, chunk size (m) for big areas

Large areas are processed in chunks (default 2 km square, with a 150 m margin so
buildings and streets across a chunk border come out whole and the same on both
sides); every chunk is fetched from OSM, classified by build_area.extract() in the
area's own local metres, and cut into tiles.

Writes index.json (area size, origin, tile grid, all tram and funicular rails, since
trams run across tiles) and tiles/<i>_<j>.json. Each tile has its own clipped land
use, roads, rails, walls, weirs, crossings and trees; buildings that touch it, with
`own` set on the tile holding the building's centre (the one that draws it); the car
and pedestrian network edges that touch it (with OSM node ids, so the game can join
them up across tiles); and the share of each paid-parking section inside it, if
<area>_parking.json exists (run build_parking.py first).
"""

import json
import math
import sys
from pathlib import Path

import osmnx as ox
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon, box

from build_area import AREAS, OUT, ROAD_WIDTH, _coords, _float, _lines, _polys, _rings, extract, use_overpass_mirror

MARGIN = 150.0


def first(v):
    if isinstance(v, list):
        return v[0] if v else None
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def truthy(v):
    return first(v) not in (None, False, "no", "False")


def graph_edges(bbox, tf, network, directed):
    """Edges of an osmnx network as dicts with OSM node ids and local-metre polylines."""
    G = ox.graph_from_bbox(bbox, network_type=network, simplify=True, retain_all=True)
    G.remove_edges_from([(u, v, k) for u, v, k, d in G.edges(keys=True, data=True) if truthy(d.get("tunnel"))])
    if directed:
        # Strongly connected, so a car can always leave any street it turns into.
        G = ox.truncate.largest_component(G, strongly=True)
    out, seen = [], set()
    for u, v, k, d in G.edges(keys=True, data=True):
        if not directed:
            key = (min(u, v), max(u, v), k)
            if key in seen:
                continue
            seen.add(key)
        geom = d.get("geometry") or LineString([(G.nodes[u]["x"], G.nodes[u]["y"]), (G.nodes[v]["x"], G.nodes[v]["y"])])
        pts = [[round(a, 2), round(b, 2)] for a, b in (tf.transform(x, y) for x, y in geom.coords)]
        ux, uy = tf.transform(G.nodes[u]["x"], G.nodes[u]["y"])
        if math.dist(pts[0], (ux, uy)) > math.dist(pts[-1], (ux, uy)):
            pts.reverse()
        hw = first(d.get("highway")) or "unclassified"
        out.append({
            "id": f"{u}>{v}>{k}", "u": str(u), "v": str(v), "hw": hw, "name": first(d.get("name")),
            "oneway": truthy(d.get("oneway")), "lanes": _float(first(d.get("lanes"))),
            "maxspeed": _float(first(d.get("maxspeed"))), "width": _float(first(d.get("width"))) or ROAD_WIDTH.get(hw, 6),
            "bridge": truthy(d.get("bridge")), "surface": first(d.get("surface")), "pts": pts,
        })
    return out


def main(area: str = "centrum", tile: str = "250", chunk: str = "2000") -> None:
    T = float(tile)
    C = max(1, round(float(chunk) / T))  # tiles per chunk side
    w, s, e, n = AREAS[area]
    centre = ((w + e) / 2, (s + n) / 2)
    tf = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=tmerc +lat_0={centre[1]} +lon_0={centre[0]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
        always_xy=True,
    )
    inv = Transformer.from_crs(tf.target_crs, "EPSG:4326", always_xy=True)
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)
    cols, rows = math.ceil((x1 - x0) / T), math.ceil((y1 - y0) / T)
    out_dir = OUT / f"{area}_now"
    (out_dir / "tiles").mkdir(parents=True, exist_ok=True)
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(Path(__file__).parent / ".cache")
    use_overpass_mirror()

    sections = []
    parking = OUT / f"{area}_parking.json"
    if parking.exists():
        for sec in json.loads(parking.read_text())["sections"]:
            polys = [Polygon(r[0], r[1:]) for r in sec["polys"]]
            full = sum(p.area for p in polys) / max(sec["inside"], 1e-6)
            sections.append((sec["code"], polys, full))

    tiles, rails, n_buildings = [], [], 0
    chunks = [(ci, cj) for ci in range(math.ceil(cols / C)) for cj in range(math.ceil(rows / C))]
    for number, (ci, cj) in enumerate(chunks, 1):
        core = (x0 + ci * C * T, y0 + cj * C * T, min(x1, x0 + (ci + 1) * C * T), min(y1, y0 + (cj + 1) * C * T))
        mx0, my0, mx1, my1 = core[0] - MARGIN, core[1] - MARGIN, core[2] + MARGIN, core[3] + MARGIN
        corners = [inv.transform(px, py) for px in (mx0, mx1) for py in (my0, my1)]
        bbox = (min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners))
        print(f"chunk {number}/{len(chunks)} ({ci},{cj})")
        x = extract(area, "now", bbox=bbox, centre=centre)
        drive = graph_edges(bbox, tf, "drive", True)
        walk = graph_edges(bbox, tf, "walk", False)

        shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in x["buildings"]]
        centres = [p.representative_point() for p in shapes]
        btree = STRtree(shapes)
        dlines = [LineString(ed["pts"]) for ed in drive]
        wlines = [LineString(ed["pts"]) for ed in walk]
        dtree, wtree = STRtree(dlines), STRtree(wlines)
        core_box = box(*core)
        for r in x["rails"]:
            for ls in _lines(LineString(r["pts"]).intersection(core_box)):
                rails.append({**r, "pts": _coords(ls)})

        for i in range(ci * C, min(cols, (ci + 1) * C)):
            for j in range(cj * C, min(rows, (cj + 1) * C)):
                bx = box(x0 + i * T, y0 + j * T, min(x1, x0 + (i + 1) * T), min(y1, y0 + (j + 1) * T))
                bx0, by0, bx1, by1 = bx.bounds
                last_i, last_j = i == cols - 1, j == rows - 1

                def own(c):  # half-open, so every centre belongs to exactly one tile
                    return (bx0 <= c.x < bx1 or (last_i and c.x == bx1)) and (by0 <= c.y < by1 or (last_j and c.y == by1))

                t = {"i": i, "j": j, "box": [round(v, 2) for v in bx.bounds]}
                t["areas"] = {k: v for k, g in x["areas"].items() if (v := [_rings(p) for p in _polys(g.intersection(bx))])}
                t["roads"] = {k: v for k, g in x["roads"].items() if (v := [_rings(p) for p in _polys(g.intersection(bx))])}
                hits = btree.query(bx, predicate="intersects")
                t["buildings"] = [{**x["buildings"][k], "own": own(centres[k])} for k in sorted(hits)]
                for key in ("walls", "rails"):
                    t[key] = [{**item, "pts": _coords(ls)} for item in x[key] for ls in _lines(LineString(item["pts"]).intersection(bx))]
                t["weirs"] = [_coords(ls) for wr in x["weirs"] for ls in _lines(LineString(wr).intersection(bx))]
                t["crossings"] = [_coords(ls) for c in x["crossings"] if len(c) > 1 for ls in _lines(LineString(c).intersection(bx))]
                t["trees"] = [p for p in x["trees"] if bx.contains(Point(p))]
                t["drive"] = [drive[k] for k in sorted(dtree.query(bx, predicate="intersects"))]
                t["walk"] = [walk[k] for k in sorted(wtree.query(bx, predicate="intersects"))]
                t["sections"] = []
                for code, polys, full in sections:
                    a = sum(p.intersection(bx).area for p in polys)
                    if a > 1:
                        t["sections"].append({"code": code, "share": round(a / full, 4)})
                if not (t["buildings"] or t["areas"] or t["roads"] or t["walk"]):
                    continue
                (out_dir / "tiles" / f"{i}_{j}.json").write_text(json.dumps(t, ensure_ascii=False, separators=(",", ":")))
                owned = sum(b["own"] for b in t["buildings"])
                n_buildings += owned
                tiles.append([i, j, owned])

    index = {
        "area": area, "bbox_wgs84": [w, s, e, n],
        "size": [round(x1 - x0, 2), round(y1 - y0, 2)], "origin": [round(-x0, 2), round(-y0, 2)],
        "tile": T, "cols": cols, "rows": rows, "tiles": tiles, "rails": rails, "graphs": True,
    }
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    total = sum(p.stat().st_size for p in (out_dir / "tiles").glob("*.json"))
    print(f"{area}: {x1 - x0:.0f} x {y1 - y0:.0f} m, {len(tiles)} tiles of {T:.0f} m in {len(chunks)} chunks, "
          f"{n_buildings} buildings, {total / 1e6:.1f} MB → {out_dir.name}/")


if __name__ == "__main__":
    main(*sys.argv[1:])
