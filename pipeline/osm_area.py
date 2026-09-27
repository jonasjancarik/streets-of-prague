"""Today's OpenStreetMap for one box of Prague, classified into what the game draws,
in local metres (a transverse Mercator centred on the area: +x east, +y north).

Used by build_tiles.py, which calls extract() chunk by chunk; the areas themselves
are defined here in AREAS.
"""

import math
import os
from pathlib import Path

import osmnx as ox
from pyproj import Transformer
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.ops import transform, unary_union

AREAS = {
    # west, south, east, north (WGS84)
    "ujezd": (14.3985, 50.0765, 14.4155, 50.0865),
    # The historic centre: Hradčany and Malá Strana to Vinohrady, Smíchov and
    # Vyšehrad's edge to Letná's slope. About 4.3 x 3 km.
    "centrum": (14.390, 50.068, 14.450, 50.095),
    # The whole city (its administrative bounding box), 34 x 26 km.
    "praha": (14.2244, 49.9419, 14.7068, 50.1774),
}

OUT = Path(__file__).resolve().parent.parent / "public" / "data"

CAR_ROADS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary",
             "secondary_link", "tertiary", "tertiary_link", "residential", "unclassified", "living_street", "service"}
ROAD_WIDTH = {
    "motorway": 22, "trunk": 16, "primary": 14, "secondary": 12, "tertiary": 10, "residential": 8,
    "motorway_link": 7, "trunk_link": 7, "primary_link": 7, "secondary_link": 7, "tertiary_link": 6.5,
    "unclassified": 7, "living_street": 6, "service": 5, "pedestrian": 6,
    "footway": 3, "path": 2, "steps": 3, "cycleway": 2.5, "track": 3, "bridleway": 2,
}
LANE_WIDTH = 3.25
COBBLES = ("sett", "cobblestone", "unhewn_cobblestone", "paving_stones")


def road_width(hw, width=None, lanes=None):
    """Carriageway width: the width tag, else lanes x 3.25 m, else by class."""
    if width:
        return width
    if lanes and hw in CAR_ROADS and hw not in ("service", "living_street"):
        return lanes * LANE_WIDTH + (1.0 if hw.startswith(("motorway", "trunk", "primary")) else 0.5)
    return ROAD_WIDTH.get(hw, 6)


def extract(area: str, bbox=None, centre=None, source=None) -> dict:
    """Fetch and classify everything in the area; geometry stays as shapely objects.

    `bbox` (WGS84) overrides the area's box, e.g. for one chunk of a large area, and
    `centre` (lon, lat) keeps the local metres of the whole area, so chunks line up.
    `source`: an .osm XML file already cut to the box, instead of asking Overpass.
    """
    w, s, e, n = bbox or AREAS[area]
    lon0, lat0 = centre or ((w + e) / 2, (s + n) / 2)
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

    buildings = []
    areas: dict[str, list] = {}
    road_lines: dict[str, list] = {}
    rails, walls, trees, weirs, crossings, passages = [], [], [], [], [], []
    lots = []  # each parking area on its own, with how the cars stand in it

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
            if b == "construction":
                continue
            g = g.buffer(0).intersection(clip)
            for poly in _polys(g):
                if poly.area < 4:
                    continue
                buildings.append({
                    "id": osm_id,
                    "kind": b,
                    "name": col(row, "name"),
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
            width = road_width(hw, _float(col(row, "width")), _float(col(row, "lanes")))
            cls = "road" if hw in CAR_ROADS else "path"
            if col(row, "bridge") == "yes":
                cls = "bridge"
            tunnel = col(row, "tunnel")
            if tunnel == "building_passage" and (_float(col(row, "layer")) or 0) >= -1:
                # A way through a building at street level (a gateway, an arcade, a
                # pasáž): drawn like any street, and cut through the building's footprint.
                for ls in _lines(g.intersection(clip)):
                    passages.append({"hw": hw, "w": round(width, 1), "pts": _coords(ls)})
            elif tunnel:
                continue
            if hw in ("path", "track", "bridleway") and col(row, "surface") not in ("paving_stones", "sett", "asphalt", "cobblestone"):
                cls = "dirt"
            if cls == "road" and col(row, "surface") in COBBLES:
                cls = "sett"  # most streets are asphalt; the rest keep their cobbles
            if hw == "footway" and col(row, "footway") == "crossing":
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
            kind = _area_kind(row, col)
            if kind:
                areas.setdefault(kind, []).append(g.buffer(0))
            if kind == "parking" and col(row, "parking") not in UNDER_COVER:
                o = col(row, "orientation")
                for poly in _polys(g.buffer(0).intersection(clip)):
                    lots.append({"o": o if o in ORIENTATIONS else None, "poly": poly})
            elif (col(row, "man_made") == "bridge" or col(row, "bridge")) and not b:
                areas.setdefault("bridge", []).append(g.buffer(0))

    road_polys = {k: unary_union(v).intersection(clip) for k, v in road_lines.items()}
    area_polys = {k: unary_union(v).intersection(clip) for k, v in areas.items()}
    return {
        "area": area, "bbox": (w, s, e, n), "box": (x0, y0, x1, y1), "clip": clip,
        "buildings": buildings, "areas": area_polys, "roads": road_polys, "rails": rails,
        "walls": walls, "trees": trees, "weirs": weirs, "crossings": crossings, "passages": passages,
        "lots": lots,
    }


def use_overpass_mirror():
    """OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api when overpass-api.de refuses us."""
    if os.environ.get("OVERPASS_URL"):
        ox.settings.overpass_url = os.environ["OVERPASS_URL"]
        ox.settings.overpass_rate_limit = False


# How cars stand in a parking area or along a street (OSM `orientation` on parking
# areas, `parking:<side>:orientation` on streets).
ORIENTATIONS = ("parallel", "diagonal", "perpendicular")
# Car parks with no cars to see from above.
UNDER_COVER = ("underground", "multi-storey", "rooftop")


def _area_kind(row, col):
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
        return "parking"
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
    return [ln for ln in getattr(g, "geoms", []) if isinstance(ln, LineString)]


def _coords(ls):
    return [[round(x, 2), round(y, 2)] for x, y in ls.coords]


def _rings(poly: Polygon):
    poly = poly.simplify(0.15)
    outer = [[round(x, 2), round(y, 2)] for x, y in list(poly.exterior.coords)[:-1]]
    holes = [[[round(x, 2), round(y, 2)] for x, y in list(i.coords)[:-1]] for i in poly.interiors]
    return [outer, *holes]
