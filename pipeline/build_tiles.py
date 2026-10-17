"""Cut the present-day map of an area into square tiles the driving game streams in
around the camera, so an area can be as large as the city.

    uv run build_tiles.py centrum                     # 250 m tiles → public/data/centrum_now/
    uv run build_tiles.py praha 250 2000              # tile size, chunk size (m) for big areas
    uv run build_tiles.py centrum --layers ground     # only the land use, streets and pavements
    uv run build_tiles.py praha --jobs 4              # chunks built side by side (default: cores - 2)

Large areas are processed in chunks (default 2 km square, with a 150 m margin so
buildings and streets across a chunk border come out whole and the same on both
sides); every chunk is fetched from OSM, classified by osm_area.extract() in the
area's own local metres, and cut into tiles. With the local OSM extract, each
chunk's OSM data is read once and kept next to its cut (<area>_<ci>_<cj>.parsed.pkl),
so building again, or another layer, starts straight from it.

What a tile has comes in layers (see layers.py), and --layers rebuilds only some:
buildings (OSM buildings that touch the tile, with `own` set on the tile holding the
building's centre, the one that draws it); ground (clipped land use, streets and
pavements, parking areas, walls, rails, weirs, crossings and trees); streets (the car
and pedestrian network edges that touch it, with OSM node ids, so the game can join
them up across tiles); parking (the share of each paid-parking section inside it, if
<area>_parking.json exists; run build_parking.py first). Changing the size of the
tiles or chunks needs all four.

Then it writes index.json (area size, origin, tile grid, all tram and funicular rails,
since trams run across tiles), tiles/<i>_<j>.json and names.json (layers.assemble).
"""

import argparse
import json
import math
import os
import pickle
import re
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import osmnx as ox
from pyproj import Transformer
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Polygon, box

from kerbs import NO_PARKING, estimate
import build_cache
import chunk_cache
import dtm
import dtm_walls
import ipr_trees
import lanes
import layers
import structures
from osm_area import (AREAS, CAR_ROADS, FEATURE_TAGS, ORIENTATIONS, OUT, _coords, _float, _lines, _polys, _rings, extract,
                      features_from_json, feature_rows, road_width, use_overpass_mirror)

MARGIN = 150.0
ROAD_TOLERANCE = 0.03  # metres the streets' outlines may be simplified by
# A local OpenStreetMap extract, if there is one, is much faster and kinder than
# Overpass for big areas: https://download.geofabrik.de/europe/czech-republic.html
PBF = Path(os.environ.get("OSM_PBF", Path(__file__).parent / ".cache" / "osm" / "czech-republic-latest.osm.pbf"))


def cut(bbox, out, source=None, stats=None):
    """The OSM data of a box (.osm XML or .pbf by name), cut from a local extract with osmium."""
    out, source = Path(out), Path(PBF if source is None else source)
    expected = {"version": 1, "source": build_cache.identity(source), "bbox": list(bbox), "strategy": "smart"}
    record = out.with_name(f"{out.name}.source.json")
    got = build_cache.read_json(record)
    hit = out.exists() and got.get("input") == expected and got.get("output") == build_cache.identity(out)
    if stats is not None:
        stats["cut_cache"] = "hit" if hit else "miss"
    if not hit:
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_name(f"{out.stem}.{os.getpid()}.tmp{out.suffix}")
        w, s, e, n = bbox
        subprocess.run(["osmium", "extract", "-b", f"{w},{s},{e},{n}", "--strategy", "smart",
                        "--overwrite", "-o", str(tmp), str(source)], check=True)
        if build_cache.identity(source) != expected["source"]:
            raise RuntimeError(f"OSM source changed while cutting {out.name}")
        tmp.replace(out)
        build_cache.write_json(record, {"input": expected, "output": build_cache.identity(out)})
    return out


def network_filter(network):
    """osmnx's Overpass filter for a network type, as a test on a way's tags."""
    parts = re.findall(r'\["([^"]+)"(?:(!?~)"([^"]*)")?\]', ox._overpass._get_network_filter(network))

    def ok(tags):
        for key, op, rx in parts:
            v = tags.get(key)
            if not op and v is None:
                return False
            if op == "~" and (v is None or not re.search(rx, v)):
                return False
            if op == "!~" and v is not None and re.search(rx, v):
                return False
        return True
    return ok


def first(v):
    # osmnx merges the tags of joined ways into lists in no fixed order; sort them so
    # every build gives the same answer.
    if isinstance(v, list):
        return sorted(v, key=str)[0] if v else None
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def truthy(v):
    return first(v) not in (None, False, "no", "False")


def values(v):
    """Every value of a tag on an edge that osmnx may have joined from several ways."""
    vs = v if isinstance(v, list) else [v]
    return {x for x in vs if x is not None and not (isinstance(x, float) and math.isnan(x))}


# Street-side parking tags: the current scheme, then the older parking:lane:* one.
PARKING_TAGS = [f"parking:{s}{k}" for s in ("both", "left", "right") for k in (":orientation", "")] + \
    [f"parking:lane:{s}{k}" for s in ("both", "left", "right") for k in ("", *(f":{o}" for o in ORIENTATIONS))]


def kerb_parking(d, side):
    """How cars park on one side ("left"/"right") of a way: an orientation, "no", or None."""
    for s in (side, "both"):
        o = first(d.get(f"parking:{s}:orientation"))
        if o in ORIENTATIONS:
            return o
        if first(d.get(f"parking:{s}")) in NO_PARKING:
            return "no"
        lane = first(d.get(f"parking:lane:{s}"))
        if lane in ORIENTATIONS:
            return lane
        if lane in NO_PARKING:
            return "no"
    return None


# Ways that differ in these stay separate edges: a tunnel joined to the bridge before it
# became one edge that was both, and the game put its cars on a bridge over the park.
# Keep OSM way endpoints too: neighboring cuts can include different adjacent ways.
# Joining across them would give their shared road different endpoint ids and widths.
JOIN_ONLY_ALIKE = ("bridge", "tunnel", "osmid")


def graph_edges(bbox, tf, network, directed, source=None, kerbs=None, core=None, ground=frozenset(), setting=None):
    """Edges of an osmnx network as dicts with OSM node ids and local-metre polylines;
    with `kerbs` (kerbs.Kerbs), car roads get their kerbs as `kerb`: [right, left].
    `source`: the local cut's OSM data as read by read_osm (pickled osmnx JSON);
    `core`: the chunk's own box in local metres (without its margin);
    `setting`: lanes.Setting, to size untagged streets the survey doesn't reach like the ground does;
    `ground`: ways tagged as tunnels that are passages through buildings (osm_area)."""
    if source:
        # The same network osmnx would ask Overpass for, built from the local cut.
        data = pickle.loads(source)
        ok = network_filter(network)
        # Not a metro station's corridors and stairs: they're underground, off the map.
        station = structures.station_ways(data["elements"], tf, ground)
        data["elements"] = [el for el in data["elements"] if el["type"] != "way" or (ok(el.get("tags", {})) and el["id"] not in station)]
        G = ox.graph._create_graph([data], network in ox.settings.bidirectional_network_types)
        G = ox.simplify_graph(G, edge_attrs_differ=JOIN_ONLY_ALIKE)
    else:
        G = ox.simplify_graph(ox.graph_from_bbox(bbox, network_type=network, simplify=False, retain_all=True), edge_attrs_differ=JOIN_ONLY_ALIKE)
    if directed:
        G = connected(G, tf, core)
    out, seen, sized = [], set(), []
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
        passage = bool(values(d.get("osmid")) & ground)
        # Kerbside parking on the edge's right and left; an edge that runs against its
        # way (the far lane of a two-way street) has the way's sides swapped.
        right, left = kerb_parking(d, "right"), kerb_parking(d, "left")
        rev = truthy(d.get("reversed"))
        if rev:
            right, left = left, right
        width = road_width(hw, _float(first(d.get("width"))), _float(first(d.get("lanes"))))
        if kerbs and hw in CAR_ROADS:
            est = {**estimate(width, lambda key: first(d.get(key)), first(d.get("width")) is None and first(d.get("lanes")) is None), "hw": hw}
            if rev:
                est["left"], est["right"] = est["right"], est["left"]
            sized.append((len(out), LineString(pts), est))
        out.append({
            "id": f"{u}>{v}>{k}", "u": str(u), "v": str(v), "hw": hw, "name": first(d.get("name")),
            "oneway": truthy(d.get("oneway")), "lanes": _float(first(d.get("lanes"))),
            "maxspeed": _float(first(d.get("maxspeed"))), "width": width,
            "bridge": truthy(d.get("bridge")), "surface": first(d.get("surface")), "pts": pts,
            **({"passage": True} if "building_passage" in values(d.get("tunnel")) or passage else {}),
            **({"tunnel": True} if not passage and values(d.get("tunnel")) - {"no", "False", "building_passage"} else {}),
            **({"park": [right, left]} if directed and (right or left) else {}),
        })
    if sized:
        lines, ests = [s[1] for s in sized], [s[2] for s in sized]
        for (i, _, _), w in zip(sized, lanes.apply(setting, kerbs, lines, [e["hw"] for e in ests], ests, [not e["guessed"] for e in ests])):
            if w:
                out[i]["width"] = w
        for (i, _, _), (left, right) in zip(sized, kerbs(lines, ests)):
            out[i]["kerb"] = [right, left]
    return out


def connected(G, tf, core):
    """The car network strongly connected, so a car can always leave any street it
    turns into. The streets beyond the chunk's own box carry on in the next chunk, so
    they count as connected through it: a one-way carriageway leaving the chunk (the
    magistrála, say) stays in, where on its own it would be a dead end."""
    import networkx as nx
    out = "beyond"
    if core is not None:
        x0, y0, x1, y1 = core
        for n, d in list(G.nodes(data=True)):
            x, y = tf.transform(d["x"], d["y"])
            if not (x0 <= x <= x1 and y0 <= y <= y1):
                G.add_edge(n, out)
                G.add_edge(out, n)
    comps = list(nx.strongly_connected_components(G))
    keep = next((c for c in comps if out in c), None) or max(comps, key=len)
    G = G.subgraph(keep - {out}).copy()
    return G


PARSED_VERSION = 2  # bump when what read_osm keeps changes


def read_osm(source: Path, stats=None):
    """A chunk's OSM data read from its .osm cut once: (osmnx's JSON of it, pickled, for
    the street graphs; the features for osm_area.extract). Kept next to the cut and
    read again only when the cut or the tags asked for change."""
    cache = source.with_suffix(".parsed.pkl")
    key = [PARSED_VERSION, build_cache.identity(source), ox.__version__, repr(FEATURE_TAGS),
           build_cache.function_key(features_from_json), build_cache.function_key(feature_rows)]
    got = build_cache.load_pickle(cache, key)
    if stats is not None:
        stats["parsed_cache"] = "hit" if got else "miss"
    if got:
        return got["elements"], got["features"]
    elements = pickle.dumps(ox._osm_xml._overpass_json_from_xml(source, "utf-8"), protocol=5)
    # osmnx may change the data it's handed, so the features get a copy of their own.
    features = features_from_json(pickle.loads(elements))
    if build_cache.identity(source) != key[1]:
        raise RuntimeError(f"OSM source changed while parsing {source.name}")
    build_cache.atomic(cache, pickle.dumps({"key": key, "elements": elements, "features": features}, protocol=5))
    return elements, features


def setup():
    """osmnx settings for the street graphs and features, in every worker."""
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(Path(__file__).parent / ".cache")
    use_overpass_mirror()
    if "surface" not in ox.settings.useful_tags_way:
        ox.settings.useful_tags_way = [*ox.settings.useful_tags_way, "surface"]  # asphalt vs setts
    ox.settings.useful_tags_way = [*dict.fromkeys([*ox.settings.useful_tags_way, *PARKING_TAGS, "embedded_rails"])]


def load_sections(area):
    """Paid-parking sections (meta, polygons, the section's whole area), if built."""
    sections = []
    parking = OUT / f"{area}_parking.json"
    if parking.exists():
        for sec in json.loads(parking.read_text())["sections"]:
            polys = [Polygon(r[0], r[1:]) for r in sec["polys"]]
            full = sum(p.area for p in polys) / max(sec["inside"], 1e-6)
            meta = {k: sec.get(k) for k in ("code", "category", "spaces", "occDay", "occNight")}
            sections.append((meta, polys, full))
    return sections


_sections = None  # per worker: (sections, STRtree over all their polygons, polygon → section)


def build_chunk(job):
    """Build the asked-for layers of one chunk; writes them and returns what took how long."""
    global _sections
    area, meta, ci, cj, wanted, area_pbf, keys = job
    started = time.perf_counter()
    record = chunk_cache.begin(area, meta, ci, cj, wanted)
    T, centre = meta["tile"], meta["centre"]
    x0, y0, x1, y1 = meta["box"]
    C = meta["chunk_tiles"]
    tf = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)
    inv = Transformer.from_crs(tf.target_crs, "EPSG:4326", always_xy=True)
    core = (x0 + ci * C * T, y0 + cj * C * T, min(x1, x0 + (ci + 1) * C * T), min(y1, y0 + (cj + 1) * C * T))
    mx0, my0, mx1, my1 = core[0] - MARGIN, core[1] - MARGIN, core[2] + MARGIN, core[3] + MARGIN
    corners = [inv.transform(px, py) for px in (mx0, mx1) for py in (my0, my1)]
    bbox = (min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners))
    tiles = layers.chunk_tiles(meta, ci, cj)
    boxes = {(i, j): box(*layers.tile_box(meta, i, j)) for i, j in tiles}
    out = {}
    lap = {}
    stats, classify = {}, {}

    if wanted & {"buildings", "ground", "streets"}:
        t0 = time.perf_counter()
        source = features = None
        if area_pbf:
            # Chunks of the default size keep their old names; other sizes get their own.
            grid = "" if (T, C) == (250.0, 8) else f"_{T:g}x{C}"
            osm = cut(bbox, PBF.parent / f"{area}{grid}_{ci}_{cj}.osm", Path(area_pbf), stats)
            source, features = read_osm(osm, stats)
        lap["read"] = time.perf_counter() - t0
        t0 = time.perf_counter()
        x = extract(area, bbox=bbox, centre=centre, source=osm if area_pbf else None, features=features,
                    ground="ground" in wanted, buildings_only=not wanted & {"ground", "streets"}, timings=classify, stats=stats)
        lap["classify"] = time.perf_counter() - t0

    if "buildings" in wanted:
        t0 = time.perf_counter()
        shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in x["buildings"]]
        centres = [p.representative_point() for p in shapes]
        btree = STRtree(shapes)
        ptree = STRtree([Polygon(p["rings"][0], p["rings"][1:]) for p in x["parts"]])
        layer = {}
        for (i, j), bx in boxes.items():
            bx0, by0, bx1, by1 = bx.bounds
            last_i, last_j = i == meta["cols"] - 1, j == meta["rows"] - 1

            def own(c):  # half-open, so every centre belongs to exactly one tile
                return (bx0 <= c.x < bx1 or (last_i and c.x == bx1)) and (by0 <= c.y < by1 or (last_j and c.y == by1))

            hits = btree.query(bx, predicate="intersects")
            if len(hits):
                layer[f"{i}_{j}"] = {"buildings": [{**x["buildings"][k], "own": own(centres[k])} for k in sorted(hits)]}
            # Building parts are only for ipr_buildings.py (roof colours); tiles don't get them.
            got = [x["parts"][k] for k in sorted(ptree.query(bx, predicate="intersects"))]
            if got:
                layer.setdefault(f"{i}_{j}", {"buildings": []})["parts"] = got
        out["buildings"] = {"tiles": layer}
        lap["buildings"] = time.perf_counter() - t0

    if "ground" in wanted:
        t0 = time.perf_counter()
        core_box = box(*core)
        rails = [{**r, "pts": _coords(ls)} for r in x["rails"] for ls in _lines(LineString(r["pts"]).intersection(core_box))]
        ltree = STRtree([lot["poly"] for lot in x["lots"]])
        # Lines looked up by tile through a tree; sorted hits keep the order they came in.
        lines = {key: [LineString(item["pts"]) for item in x[key]] for key in ("walls", "fences", "rails", "passages")}
        lines["weirs"] = [LineString(wr) for wr in x["weirs"]]
        crossings = [c for c in x["crossings"] if len(c) > 1]
        lines["crossings"] = [LineString(c) for c in crossings]
        lines["marks"] = [LineString(m) for m in x["marks"] if len(m) > 1]
        trees = {key: STRtree(v) for key, v in lines.items()}
        x["trees"] = ipr_trees.merge(x["trees"], bbox, tf)
        tree_xy = shapely.points([tr[:2] for tr in x["trees"]]) if x["trees"] else None
        drive_xy = shapely.points([(d["x"], d["y"]) for d in x["drives"]]) if x["drives"] else None
        # What stands on the plots of family houses (plots.py): each plot and shed in the
        # tile that holds its middle, the patches of ground cut to the tile.
        # (A plot a way cuts through is in pieces: its largest piece is its outline.)
        plot_xy = shapely.points([p["poly"].representative_point().coords[0] for p in x["plots"]]) if x["plots"] else None
        shed_xy = shapely.points([sh[:2] for sh in x["sheds"]]) if x["sheds"] else None
        # The survey's walls, fences and railings (dtm_walls.py), in place of OSM's where it has been.
        surveyed = dtm_walls.survey(bbox, tf.transform)
        survey_tree = STRtree([ln for _, _, ln in surveyed]) if surveyed else None
        open_ground = dtm_walls.openings(x) if surveyed else None
        survey_m = [0.0, 0.0, 0.0]
        layer = {}
        for (i, j), bx in boxes.items():
            t = {}
            t["areas"] = {k: v for k, g in x["areas"].items() if (v := [_rings(p) for p in _polys(g.intersection(bx))])}
            # Parking areas one by one, with their orientation (the game lays out bays).
            t["lots"] = [{"o": x["lots"][k]["o"], **({"i": 1} if x["lots"][k].get("i") else {}), "rings": _rings(p)}
                         for k in sorted(ltree.query(bx, predicate="intersects"))
                         for p in _polys(x["lots"][k]["poly"].intersection(bx)) if p.area > 4]
            # Finer for the streets, whose rounded corners (dtm.py) the coarser tolerance undoes.
            t["roads"] = {k: v for k, g in x["roads"].items() if (v := [_rings(p, ROAD_TOLERANCE) for p in _polys(g.intersection(bx))])}
            for key in ("walls", "fences", "rails", "passages"):
                t[key] = [{**x[key][k], "pts": _coords(ls)} for k in sorted(trees[key].query(bx))
                          for ls in _lines(lines[key][k].intersection(bx))]
            if surveyed:
                for n, m in enumerate(dtm_walls.replace(t, bx, surveyed, survey_tree, open_ground)):
                    survey_m[n] += m
            t["weirs"] = [_coords(ls) for k in sorted(trees["weirs"].query(bx)) for ls in _lines(lines["weirs"][k].intersection(bx))]
            t["crossings"] = [_coords(ls) for k in sorted(trees["crossings"].query(bx)) for ls in _lines(lines["crossings"][k].intersection(bx))]
            t["marks"] = [_coords(ls) for k in sorted(trees["marks"].query(bx)) for ls in _lines(lines["marks"][k].intersection(bx))]
            t["trees"] = [x["trees"][k] for k in shapely.contains(bx, tree_xy).nonzero()[0]] if tree_xy is not None else []
            # Places for a car on a drive (plan 029), each in the tile that holds its middle.
            t["drives"] = [x["drives"][k] for k in shapely.contains(bx, drive_xy).nonzero()[0]] if drive_xy is not None else []
            t["plots"] = [{"b": p["b"], "ring": _rings(max(_polys(p["poly"]), key=lambda g: g.area), 0.3)[0], **{key: p[key] for key in ("gate", "strip") if key in p}}
                          for p in (x["plots"][k] for k in shapely.contains(bx, plot_xy).nonzero()[0])] if plot_xy is not None else []
            t["patches"] = {k: v for k, g in x["patches"].items() if (v := [_rings(p) for p in _polys(g.intersection(bx)) if p.area > 0.2])}
            t["sheds"] = [x["sheds"][k] for k in shapely.contains(bx, shed_xy).nonzero()[0]] if shed_xy is not None else []
            if any(t.values()):
                layer[f"{i}_{j}"] = t
        out["ground"] = {"tiles": layer, "rails": rails}
        stats["survey_walls_m"], stats["survey_fences_m"], stats["osm_walls_fences_replaced_m"] = (round(m) for m in survey_m)
        lap["ground"] = time.perf_counter() - t0

    if "streets" in wanted:
        t0 = time.perf_counter()
        drive = graph_edges(bbox, tf, "drive", True, source, x["kerbs"], core, x["ground_ways"], x["setting"])
        walk = graph_edges(bbox, tf, "walk", False, source, ground=x["ground_ways"])
        names = {}  # street name → (length of its longest edge, midpoint), for the dev search
        for ed in drive + walk:
            if ed["name"]:
                ls = LineString(ed["pts"])
                mid = ls.interpolate(0.5, normalized=True)
                if x0 <= mid.x <= x1 and y0 <= mid.y <= y1 and ls.length > names.get(ed["name"], (0,))[0]:
                    names[ed["name"]] = (ls.length, round(mid.x, 1), round(mid.y, 1))
        dtree, wtree = STRtree([LineString(ed["pts"]) for ed in drive]), STRtree([LineString(ed["pts"]) for ed in walk])
        layer = {}
        for (i, j), bx in boxes.items():
            t = {"drive": [drive[k] for k in sorted(dtree.query(bx, predicate="intersects"))],
                 "walk": [walk[k] for k in sorted(wtree.query(bx, predicate="intersects"))]}
            if t["drive"] or t["walk"]:
                layer[f"{i}_{j}"] = t
        # Bridges and tunnels, with where they meet the streets on the ground, for
        # ipr_terrain.py to work out their heights (structures.py).
        found = structures.structure_ways(pickle.loads(source), tf, x["ground_ways"]) if source else []
        out["streets"] = {"tiles": layer, "names": names, "structures": found}
        lap["streets"] = time.perf_counter() - t0

    if "parking" in wanted:
        t0 = time.perf_counter()
        # Paid-parking sections clipped to the tile, with the share of each section's
        # spaces that falls inside it.
        if _sections is None:
            secs = load_sections(area)
            polys = [p for _, ps, _ in secs for p in ps]
            owner = [n for n, (_, ps, _) in enumerate(secs) for _ in ps]
            _sections = (secs, STRtree(polys), owner)
        secs, stree, owner = _sections
        layer = {}
        for (i, j), bx in boxes.items():
            found = []
            for n in sorted({owner[k] for k in stree.query(bx)}):
                sec_meta, polys, full = secs[n]
                parts = [q for p in polys for q in _polys(p.intersection(bx))]
                a = sum(q.area for q in parts)
                if a > 1:
                    found.append({**sec_meta, "share": round(a / full, 4), "polys": [_rings(q) for q in parts]})
            if found:
                layer[f"{i}_{j}"] = {"sections": found}
        out["parking"] = {"tiles": layer}
        lap["parking"] = time.perf_counter() - t0

    t0 = time.perf_counter()
    outputs = {name: layers.dumps(data) for name, data in out.items()}
    for name, raw in outputs.items():
        layers.write(layers.chunk_path(area, name, ci, cj), raw)
    chunk_cache.complete(area, ci, cj, record, outputs, keys)
    lap["write"] = time.perf_counter() - t0
    lap["total"] = time.perf_counter() - started
    lap["extract"] = classify
    lap["stats"] = {**stats, "worker_peak_mb": round(build_cache.peak_mb(), 1)}
    return ci, cj, lap


def main() -> None:
    command_started = time.perf_counter()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("area", nargs="?", default="centrum", choices=AREAS)
    ap.add_argument("tile", nargs="?", type=float, default=250.0, help="tile size in metres")
    ap.add_argument("chunk", nargs="?", type=float, default=2000.0, help="chunk size in metres")
    ap.add_argument("--layers", default=",".join(layers.CHUNKED),
                    help=f"which layers to build, comma-separated (default all: {','.join(layers.CHUNKED)})")
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 2)), help="chunks built side by side")
    ap.add_argument("--resume", action="store_true", help="reuse completed chunk layers only when inputs and output hashes match")
    ap.add_argument("--no-assemble", action="store_true", help="leave layers staged; assemble after IPR buildings and terrain finish")
    ap.add_argument("--chunks", default="", help="only these chunks, as ci,cj separated by spaces (a trial; the rest keep what they have)")
    args = ap.parse_args()
    area, T = args.area, args.tile
    wanted = set(args.layers.split(","))
    if not wanted or wanted - set(layers.CHUNKED):
        ap.error(f"unknown layers: {', '.join(sorted(wanted - set(layers.CHUNKED)))}")
    if args.jobs < 1 or not math.isfinite(T) or T <= 0 or not math.isfinite(args.chunk) or args.chunk <= 0:
        ap.error("jobs, tile size and chunk size must be positive")
    C = max(1, round(args.chunk / T))  # tiles per chunk side
    w, s, e, n = AREAS[area]
    centre = ((w + e) / 2, (s + n) / 2)
    crs = f"+proj=tmerc +lat_0={centre[1]} +lon_0={centre[0]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    tf = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)
    cols, rows = math.ceil((x1 - x0) / T), math.ceil((y1 - y0) / T)
    meta = {
        "area": area, "bbox_wgs84": [w, s, e, n], "centre": centre, "crs": crs, "box": [x0, y0, x1, y1],
        "size": [round(x1 - x0, 2), round(y1 - y0, 2)], "origin": [round(-x0, 2), round(-y0, 2)],
        "tile": T, "chunk_tiles": C, "cols": cols, "rows": rows,
    }
    todo = layers.chunks(meta)
    try:
        only = {tuple(int(v) for v in c.split(",")) for c in args.chunks.split()}
    except ValueError:
        ap.error("chunks must be pairs of integers, ci,cj separated by spaces")
    if any(len(c) != 2 for c in only):
        ap.error("chunks must be pairs of integers, ci,cj separated by spaces")
    outside = only - set(todo)
    if outside:
        ap.error("chunks outside this area's grid: " + ", ".join(f"{ci},{cj}" for ci, cj in sorted(outside)))
    old = layers.read_meta(area)
    if (wanted != set(layers.CHUNKED) or only) and (not old or layers.grid_key(old) != layers.grid_key(meta)):
        ap.error("the tiles or chunks aren't the ones already built: build all layers without --chunks first")
    meta["parking"] = bool(load_sections(area)) if "parking" in wanted else old["parking"]

    setup()
    # Cut the area out of the country extract once; chunks are cut from that.
    area_pbf = None
    if PBF.exists() and wanted & {"buildings", "ground", "streets"}:
        pad = 0.01
        area_pbf = str(cut((w - pad, s - pad, e + pad, n + pad), PBF.parent / f"{area}.osm.pbf"))

    if wanted & {"ground", "streets"}:
        # The technical map's streets (dtm.py), read here once rather than in every worker.
        try:
            dtm.download()
        except OSError as e:
            print(f"dtm: couldn't look for a newer map ({e}); using the one here")
        dtm.surfaces()
        dtm.covered([14.42], [50.08])  # (and where the survey reaches at all, kept for the workers)
    if "ground" in wanted:
        if any(dtm_walls.LINES.glob("*.zip")):
            dtm_walls.lines()
        ipr_trees.download()

    settings = {"margin": MARGIN, "road_tolerance": ROAD_TOLERANCE, "parsed_version": PARSED_VERSION}
    # Preserve the OSM input for parking-only updates, which don't need to cut it.
    meta["build_source"] = area_pbf if wanted & {"buildings", "ground", "streets"} else (old or {}).get("build_source")
    meta["build_settings"] = settings
    keys = chunk_cache.inputs(area, meta, wanted, area_pbf, settings)
    jobs = []
    reused = 0
    for ci, cj in todo:
        if only and (ci, cj) not in only:
            continue
        needed = chunk_cache.remaining(area, meta, ci, cj, wanted, keys) if args.resume else wanted
        reused += len(wanted) - len(needed)
        if needed:
            jobs.append((area, meta, ci, cj, needed, area_pbf, keys))
    prepared = time.perf_counter() - command_started
    started = time.perf_counter()
    print(f"{area}: {x1 - x0:.0f} x {y1 - y0:.0f} m, {len(todo)} chunks, layers {', '.join(sorted(wanted))}, {args.jobs} at a time; "
          f"{len(jobs)} chunks to build, {reused} layer outputs reused", flush=True)

    def results():
        if args.jobs == 1 or len(jobs) <= 1:
            yield from map(build_chunk, jobs)
        else:
            with ProcessPoolExecutor(args.jobs, initializer=setup) as pool:
                for future in as_completed([pool.submit(build_chunk, job) for job in jobs]):
                    yield future.result()

    for number, (ci, cj, lap) in enumerate(results(), 1):
        steps = ", ".join(f"{k} {v:.1f}" for k, v in lap.items() if k not in ("total", "extract", "stats"))
        print(f"chunk {number}/{len(jobs)} ({ci},{cj}) {lap['total']:.1f} s ({steps})", flush=True)
        build_cache.report_times(f"  extract {ci},{cj}", lap["extract"])
        print(f"  counts/cache {ci},{cj}: {json.dumps(lap['stats'], sort_keys=True)}", flush=True)
    if chunk_cache.inputs(area, meta, wanted, area_pbf, settings) != keys:
        raise SystemExit("build inputs changed during the run; keep this output staged and rebuild before assembling")
    layers.write_meta(area, meta)
    worker_wall = time.perf_counter() - started
    assembly_started = time.perf_counter()
    if not args.no_assemble:
        layers.assemble(area)
    build_cache.report_times(f"{area} build_tiles", {"prepare": prepared, "workers": worker_wall,
                             "assembly": time.perf_counter() - assembly_started,
                             "total": time.perf_counter() - command_started})
    later = []
    if wanted & {"buildings", "ground"} and layers.read_layer(area, "ipr"):
        later.append(f"ipr_buildings.py {area} (it uses OSM buildings and ground-water polygons)")
    if wanted & {"ground", "streets"} and layers.read_layer(area, "terrain"):
        later.append(f"ipr_terrain.py {area} (it works out the bridges and tunnels)")
    for step in later:
        print(f"now run {step}")


if __name__ == "__main__":
    main()
