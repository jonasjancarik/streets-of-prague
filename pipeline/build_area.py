"""Fetch OSM + historical orthophotos for one area of Prague and bake them into
game-ready JSON (local metres, origin at bbox centre, +x east, +y north).

    uv run build_area.py            # default: Újezd, as in May 1945
    uv run build_area.py ujezd now  # present day, for the driving game → ujezd_now.json
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
import osmnx as ox
import requests
from pyproj import Transformer
from shapely import affinity
from shapely.geometry import (
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
    mapping,
)
from shapely.ops import transform, unary_union

AREAS = {
    # west, south, east, north (WGS84)
    "ujezd": (14.3985, 50.0765, 14.4155, 50.0865),
    # Historic centre for the driving game: Hradčany and Malá Strana to Vinohrady,
    # Smíchov and Vyšehrad's edge to Letná's slope. About 4.3 x 3 km.
    "centrum": (14.390, 50.068, 14.450, 50.095),
    # The whole city (its administrative bounding box). Too big to commit: the
    # generated praha_* files are ignored by git; build them with the pipeline.
    "praha": (14.2244, 49.9419, 14.7068, 50.1774),
}

WMS = "https://gs-pub.praha.eu/arcgis/services/ort/ortofotomapa_archiv/MapServer/WmsServer"
ORTHO_LAYERS = {"1945": 205, "1938": 209, "2012": 117}  # 2012 = TrueOrto city centre

OUT = Path(__file__).resolve().parent.parent / "public" / "data"
REVIEW = Path(__file__).resolve().parent / "review"  # 1945 review candidates, not served to the game

# Things that were not there in 1945. OSM start_date catches some; the rest are
# checked by eye against the 1945 orthophoto (toggle "1945 photo" in the game).
NOT_IN_1945_NAMES = {
    "Pomník obětem komunismu",
}
# Verified by eye against the 1945 orthophoto. Prague buildings imported from RÚIAN
# carry full-date start_date values that are cadastre record dates, not construction
# dates, so those are only used to flag candidates for review, never to drop buildings.
NOT_IN_1945_OSM_IDS = {
    "way/27247992",   # Nová scéna ND (1983)
    "way/30788693",   # yard building, open ground in 1945
    "way/102685324",  # Jazz Dock (2009)
    "way/277827596",  # riverside pavilion, trees in 1945
    "way/277923426",  # greenhouse, trees in 1945
    "way/481770654",  # sculpture on the weir
    "way/672788270",  # kiosk by the Petřín orchard
}
EXISTED_IN_1945_OSM_IDS = {"relation/3366616"}  # Klementinum: start_date=1995 is wrong

ROAD_WIDTH = {
    "primary": 14, "secondary": 12, "tertiary": 10, "residential": 8,
    "unclassified": 7, "living_street": 6, "service": 5, "pedestrian": 6,
    "footway": 3, "path": 2, "steps": 3, "cycleway": 2.5, "track": 3,
    "bridleway": 2,
}
# Today's map also has the big roads (the 1945 map keeps its original classes and widths).
CAR_ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
             "secondary_link", "tertiary", "tertiary_link", "residential", "unclassified", "living_street", "service"}
ROAD_WIDTH_NOW = {**ROAD_WIDTH, "motorway": 22, "trunk": 16, "motorway_link": 7, "trunk_link": 7,
                  "primary_link": 7, "secondary_link": 7, "tertiary_link": 6.5}
LANE_WIDTH = 3.25


def road_width(hw, width=None, lanes=None, now=True):
    """Carriageway width: the width tag, else lanes x 3.25 m on today's map, else by class."""
    if width:
        return width
    if not now:
        return ROAD_WIDTH.get(hw, 6)
    if lanes and hw in CAR_ROADS and hw not in ("service", "living_street"):
        return lanes * LANE_WIDTH + (1.0 if hw.startswith(("motorway", "trunk", "primary")) else 0.5)
    return ROAD_WIDTH_NOW.get(hw, 6)


def extract(area: str = "ujezd", era: str = "1945", bbox=None, centre=None, source=None) -> dict:
    """Fetch and classify everything in the area; geometry stays as shapely objects.

    `bbox` (WGS84) overrides the area's box, e.g. for one chunk of a large area, and
    `centre` (lon, lat) keeps the local metres of the whole area, so chunks line up.
    `source`: an .osm XML file already cut to the box, instead of asking Overpass.
    """
    now = era == "now"
    w, s, e, n = bbox or AREAS[area]
    lon0, lat0 = centre or ((w + e) / 2, (s + n) / 2)
    # Local transverse mercator centred on the area → metres with negligible distortion.
    tf = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=tmerc +lat_0={lat0} +lon_0={lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
        always_xy=True,
    )
    proj = lambda g: transform(tf.transform, g)  # noqa: E731
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)
    clip = box(x0, y0, x1, y1)
    print(f"area {area}: {x1 - x0:.0f} x {y1 - y0:.0f} m")

    ox.settings.use_cache = True
    ox.settings.cache_folder = str(Path(__file__).parent / ".cache")
    use_overpass_mirror()
    tags = {
        "building": True, "highway": True, "landuse": True, "leisure": True,
        "natural": True, "waterway": True, "railway": True, "amenity": True,
        "barrier": ["wall", "city_wall"], "man_made": ["bridge", "pier"],
        "place": ["islet", "island"], "historic": ["city_gate", "castle_wall"],
        "bridge": True, "area:highway": True,
    }
    gdf = ox.features_from_xml(source, tags=tags) if source else ox.features_from_bbox((w, s, e, n), tags)
    gdf = gdf.reset_index()
    print(f"{len(gdf)} OSM features")

    def col(row, k):
        v = row.get(k)
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        return v

    buildings, removed, candidates = [], [], []
    areas: dict[str, list] = {}
    road_lines: dict[str, list] = {}
    rails, walls, trees, weirs, crossings = [], [], [], [], []

    for _, row in gdf.iterrows():
        g = row.geometry
        if g is None or g.is_empty:
            continue
        osm_id = f"{row['element']}/{row['id']}"
        g = proj(g)
        if not g.intersects(clip):
            continue

        b = col(row, "building")
        if b and isinstance(g, (Polygon, MultiPolygon)):
            start = col(row, "start_date")
            name = col(row, "name")
            year = _year(start)
            why = None
            if now:
                why = "under construction" if b == "construction" else None
            elif osm_id in EXISTED_IN_1945_OSM_IDS:
                pass
            elif year and year > 1945 and len(str(start)) == 4:
                why = f"start_date={start}"
            elif b in ("construction",) or name in NOT_IN_1945_NAMES or osm_id in NOT_IN_1945_OSM_IDS:
                why = "listed as post-1945"
            if not now and (why or (year and year > 1945)):
                # Everything with a post-1945 date or on a list is a review candidate,
                # kept or dropped, so review_1945.py can show it against the 1945 photo.
                candidates.append({"id": osm_id, "name": name, "start_date": start, "dropped": bool(why),
                                   "why": why or ("kept (verified: stood in 1945)" if osm_id in EXISTED_IN_1945_OSM_IDS
                                                  else "kept (full-date start_date is a cadastre record date)"),
                                   "rings": [_rings(p) for p in _polys(g.buffer(0).intersection(clip))]})
            if why:
                g2 = g.buffer(0).intersection(clip)
                removed.append({"id": osm_id, "name": name, "why": why,
                                "rings": [_rings(p) for p in _polys(g2)]})
                continue
            g = g.buffer(0).intersection(clip)
            for poly in _polys(g):
                if poly.area < 4:
                    continue
                buildings.append({
                    "id": osm_id,
                    "kind": b,
                    "name": name,
                    "h": _height(row, col),
                    "minh": _float(col(row, "min_height")) or 0,
                    "roof": col(row, "roof:shape"),
                    "church": b in ("church", "cathedral", "chapel") or col(row, "amenity") == "place_of_worship",
                    "part": bool(col(row, "building:part")),
                    "rings": _rings(poly),
                })
            continue

        hw = col(row, "highway")
        if hw and isinstance(g, (LineString, MultiLineString)):
            if hw in ("proposed", "construction", "elevator", "platform", "bus_stop"):
                continue
            width = road_width(hw, _float(col(row, "width")), _float(col(row, "lanes")), now)
            cls = "road" if hw in ("primary", "secondary", "tertiary", "residential",
                                   "unclassified", "living_street", "service") or hw.endswith("_link") else "path"
            if now and hw in CAR_ROADS:
                cls = "road"  # trunks, motorways and slip roads too, not just the 1945 classes
            if col(row, "bridge") == "yes":
                cls = "bridge"
            if col(row, "tunnel") in ("yes", "building_passage"):
                continue
            if hw in ("path", "track", "bridleway") and col(row, "surface") not in ("paving_stones", "sett", "asphalt", "cobblestone"):
                cls = "dirt"
            if now and cls == "road" and col(row, "surface") in ("sett", "cobblestone", "unhewn_cobblestone", "paving_stones"):
                cls = "sett"  # today most streets are asphalt; the rest keep their cobbles
            if now and hw == "footway" and col(row, "footway") == "crossing":
                crossings.extend(_coords(ls) for ls in _lines(g.intersection(clip)))
                continue
            road_lines.setdefault(cls, []).append(g.buffer(width / 2, cap_style="round", join_style="round"))
            continue
        if hw == "pedestrian" and isinstance(g, (Polygon, MultiPolygon)):
            areas.setdefault("square", []).append(g)
            continue

        rw = col(row, "railway")
        if rw in ("tram", "funicular", "rail") and isinstance(g, (LineString, MultiLineString)):
            if col(row, "tunnel") == "yes":
                continue
            for ls in _lines(g.intersection(clip)):
                rails.append({"kind": rw, "pts": _coords(ls)})
            continue

        if col(row, "barrier") in ("wall", "city_wall") or col(row, "historic") in ("city_gate", "castle_wall"):
            if isinstance(g, (LineString, MultiLineString)):
                for ls in _lines(g.intersection(clip)):
                    walls.append({"kind": col(row, "barrier") or col(row, "historic"), "name": col(row, "name"), "pts": _coords(ls)})
            continue

        if col(row, "waterway") in ("weir", "dam") and isinstance(g, (LineString, MultiLineString)):
            for ls in _lines(g.intersection(clip)):
                weirs.append(_coords(ls))
            continue

        if col(row, "natural") == "tree" and isinstance(g, Point):
            trees.append([round(g.x, 1), round(g.y, 1)])
            continue

        if isinstance(g, (Polygon, MultiPolygon)):
            kind = _area_kind(row, col, now)
            if kind:
                areas.setdefault(kind, []).append(g.buffer(0))
            elif (col(row, "man_made") == "bridge" or col(row, "bridge")) and not b:
                areas.setdefault("bridge", []).append(g.buffer(0))

    # Rivers mapped as lines only get buffered; the Vltava is an area in OSM already.
    road_polys = {k: unary_union(v).intersection(clip) for k, v in road_lines.items()}
    area_polys = {k: unary_union(v).intersection(clip) for k, v in areas.items()}
    return {
        "area": area, "era": era, "bbox": (w, s, e, n), "box": (x0, y0, x1, y1), "clip": clip,
        "buildings": buildings, "areas": area_polys, "roads": road_polys, "rails": rails,
        "walls": walls, "trees": trees, "weirs": weirs, "crossings": crossings,
        "removed": removed, "candidates": candidates,
    }


def main(area: str = "ujezd", era: str = "1945") -> None:
    now = era == "now"
    x = extract(area, era)
    w, s, e, n = x["bbox"]
    x0, y0, x1, y1 = x["box"]
    buildings, removed, candidates = x["buildings"], x["removed"], x["candidates"]
    area_polys, road_polys = x["areas"], x["roads"]
    rails, walls, trees, weirs, crossings = x["rails"], x["walls"], x["trees"], x["weirs"], x["crossings"]

    out = {
        "area": area,
        "bbox_wgs84": [w, s, e, n],
        "size": [round(x1 - x0, 2), round(y1 - y0, 2)],
        "origin": [round(-x0, 2), round(-y0, 2)],  # add to local coords → bbox-relative
        "buildings": buildings,
        "areas": {k: [_rings(p) for p in _polys(v)] for k, v in area_polys.items()},
        "roads": {k: [_rings(p) for p in _polys(v)] for k, v in road_polys.items()},
        "rails": rails,
        "walls": walls,
        "trees": trees,
        "weirs": weirs,
    }
    if now:
        out["crossings"] = crossings
    else:
        out["removed_for_1945"] = removed
    OUT.mkdir(parents=True, exist_ok=True)
    name = f"{area}_now.json" if now else f"{area}.json"
    (OUT / name).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(buildings)} building polys, {len(trees)} trees, {len(rails)} rail lines, {len(weirs)} weirs, "
          f"areas={ {k: len(_polys(v)) for k, v in area_polys.items()} }")
    if now:
        print(f"present day → {name}, {len(crossings)} pedestrian crossings")
        return
    print("removed for 1945:", [(r["id"], r["name"], r["why"]) for r in removed])
    REVIEW.mkdir(exist_ok=True)
    (REVIEW / f"{area}_1945_candidates.json").write_text(json.dumps(candidates, ensure_ascii=False, indent=1))
    print(f"{len(candidates)} review candidates → review/{area}_1945_candidates.json")

    for label, layer in ORTHO_LAYERS.items():
        path = OUT / f"{area}_ortho_{label}.jpg"
        if path.exists():
            continue
        px_w = 2048 * 2
        px_h = round(px_w * (y1 - y0) / (x1 - x0))
        r = requests.get(WMS, params={
            "SERVICE": "WMS", "VERSION": "1.1.1", "REQUEST": "GetMap", "LAYERS": str(layer),
            "STYLES": "", "SRS": "EPSG:4326", "BBOX": f"{w},{s},{e},{n}",
            "WIDTH": px_w, "HEIGHT": px_h, "FORMAT": "image/jpeg",
        }, timeout=120)
        r.raise_for_status()
        path.write_bytes(r.content)
        print(f"ortho {label}: {path.name} {px_w}x{px_h}")


def use_overpass_mirror():
    """OVERPASS_URL=https://overpass.kumi.systems/api when overpass-api.de refuses us."""
    import os
    if os.environ.get("OVERPASS_URL"):
        ox.settings.overpass_url = os.environ["OVERPASS_URL"]
        ox.settings.overpass_rate_limit = False


def _area_kind(row, col, now=False):
    lu, le, na, am = col(row, "landuse"), col(row, "leisure"), col(row, "natural"), col(row, "amenity")
    if na == "water" or lu in ("basin", "reservoir") or col(row, "waterway") == "riverbank":
        return "water"
    if lu == "orchard" or lu == "vineyard":
        return "orchard"
    if na == "wood" or lu == "forest":
        return "wood"
    if le in ("park", "garden") or lu in ("grass", "meadow", "village_green", "recreation_ground") or na in ("scrub", "grassland"):
        return "park"
    if le in ("pitch", "playground", "sports_centre", "track"):
        return "pitch"
    if am == "parking":
        return "parking" if now else "square"  # 1945: no car parks – render as cobbled yard
    if col(row, "area:highway") or col(row, "highway") == "pedestrian" or col(row, "place") == "square":
        return "square"
    if lu in ("cemetery",) or am == "grave_yard":
        return "park"
    return None


def _height(row, col):
    h = _float(col(row, "height"))
    if h:
        return h
    lv = _float(col(row, "building:levels"))
    if lv:
        return lv * 3.4 + 1.0
    b = col(row, "building")
    return {"church": 18, "garage": 3, "shed": 3, "roof": 4, "kiosk": 3}.get(b, 13)


def _float(v):
    try:
        return float(str(v).split(";")[0].replace("m", "").strip())
    except (TypeError, ValueError):
        return None


def _year(v):
    if not v:
        return None
    digits = "".join(ch if ch.isdigit() else " " for ch in str(v)).split()
    years = [int(d) for d in digits if len(d) == 4]
    return min(years) if years else None


def _polys(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def _lines(g):
    if isinstance(g, LineString):
        return [g] if not g.is_empty else []
    return [l for l in getattr(g, "geoms", []) if isinstance(l, LineString)]


def _coords(ls):
    return [[round(x, 2), round(y, 2)] for x, y in ls.coords]


def _rings(poly: Polygon):
    poly = poly.simplify(0.15)
    outer = [[round(x, 2), round(y, 2)] for x, y in list(poly.exterior.coords)[:-1]]
    holes = [[[round(x, 2), round(y, 2)] for x, y in list(i.coords)[:-1]] for i in poly.interiors]
    return [outer, *holes]


if __name__ == "__main__":
    main(*sys.argv[1:])
