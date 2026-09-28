"""Today's OpenStreetMap for one box of Prague, classified into what the game draws,
in local metres (a transverse Mercator centred on the area: +x east, +y north).

Used by build_tiles.py, which calls extract() chunk by chunk; the areas themselves
are defined here in AREAS.
"""

import math
import os
import random
import zlib
from pathlib import Path

import numpy as np
import osmnx as ox
import pandas as pd
import shapely
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

from kerbs import Kerbs, estimate

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


# What extract() asks OSM for.
FEATURE_TAGS = {
    "building": True, "highway": True, "landuse": True, "leisure": True,
    "natural": True, "waterway": True, "railway": True, "amenity": True,
    "barrier": ["wall", "city_wall"], "man_made": ["bridge", "pier"],
    "place": ["islet", "island"], "historic": ["city_gate", "castle_wall"],
    "bridge": True, "area:highway": True,
}


def features_from_json(data):
    """The features extract() works on, from OSM data already read into osmnx's JSON
    (as ox.features_from_xml would make them, without reading the file again)."""
    gdf = ox.features._create_gdf([data], Polygon(), FEATURE_TAGS)
    return feature_rows(gdf.drop(columns=list(set(gdf.columns) & {"changeset", "timestamp", "uid", "user", "version"})))


def feature_rows(gdf):
    """(geometries, each feature's tags) of an osmnx features table. The table has a
    column for every tag any feature has (a thousand in the centre), so each feature
    keeps only its own: much smaller to keep and quicker to go through."""
    fr = gdf.reset_index()
    rows = [{} for _ in range(len(fr))]
    for c in fr.columns:
        if c != "geometry":
            v = fr[c].values
            for k in pd.notna(v).nonzero()[0]:
                rows[k][c] = v[k]
    return fr.geometry.values, rows


def extract(area: str, bbox=None, centre=None, source=None, features=None, ground=True) -> dict:
    """Fetch and classify everything in the area; geometry stays as shapely objects.

    `bbox` (WGS84) overrides the area's box, e.g. for one chunk of a large area, and
    `centre` (lon, lat) keeps the local metres of the whole area, so chunks line up.
    `source`: an .osm XML file already cut to the box, instead of asking Overpass;
    `features`: the features already read (features_from_json).
    `ground`: False leaves out the land use and the streets' surfaces ("areas" and
    "roads" come back empty), which take most of the time here.
    """
    w, s, e, n = bbox or AREAS[area]
    lon0, lat0 = centre or ((w + e) / 2, (s + n) / 2)
    tf = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=tmerc +lat_0={lat0} +lon_0={lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
        always_xy=True,
    )
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)
    clip = box(x0, y0, x1, y1)

    if features is None:
        ox.settings.use_cache = True
        ox.settings.cache_folder = str(Path(__file__).parent / ".cache")
        use_overpass_mirror()
        features = feature_rows(ox.features_from_xml(source, tags=FEATURE_TAGS) if source else ox.features_from_bbox((w, s, e, n), FEATURE_TAGS))
    geoms, rows = features

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
    homes = []  # landuse=residential, where gardens may be (see _gardens)
    streets = []  # car roads other than service roads, which cut residential areas into blocks
    car_ways = []  # (line, what its tags say, class, a street?), sized after the loop
    sidewalks = []  # footways and paths with their half widths, which may run along a street

    # Every geometry into local metres in one go.
    geoms = shapely.transform(geoms, lambda c: np.column_stack(tf.transform(c[:, 0], c[:, 1])))
    for g, row in zip(geoms, rows):
        if g is None or g.is_empty:
            continue
        osm_id = f"{row['element']}/{row['id']}"
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
                    "h": _height(row, col, osm_id, poly.area),
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
            if col(row, "bridge") not in (None, "no"):  # yes, viaduct, cantilever, …
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
            if hw in ("footway", "path") and col(row, "footway") not in ("traffic_island", "link"):
                sidewalks.extend((ls, width / 2, col(row, "footway") == "sidewalk") for ls in _lines(g))
            if hw in CAR_ROADS:
                # Sized kerb to kerb once the pavements and tracks are all in (kerbs.py).
                est = estimate(width, lambda k: col(row, k), not col(row, "width") and not col(row, "lanes"))
                car_ways.extend((ls, est, cls, hw != "service") for ls in _lines(g))
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
            if col(row, "landuse") == "residential":
                homes.append(g.buffer(0))
            kind = _area_kind(row, col)
            if kind:
                areas.setdefault(kind, []).append(g.buffer(0))
            if kind == "parking" and col(row, "parking") not in UNDER_COVER:
                o = col(row, "orientation")
                for poly in _polys(g.buffer(0).intersection(clip)):
                    lots.append({"o": o if o in ORIENTATIONS else None, "poly": poly})
            elif (col(row, "man_made") == "bridge" or col(row, "bridge")) and not b:
                areas.setdefault("bridge", []).append(g.buffer(0))

    kerbs = Kerbs(sidewalks, [LineString(r["pts"]) for r in rails if r["kind"] == "tram"], [w[0] for w in car_ways])
    if not ground:
        return {
            "area": area, "bbox": (w, s, e, n), "box": (x0, y0, x1, y1), "clip": clip,
            "buildings": buildings, "areas": {}, "roads": {}, "rails": rails,
            "walls": walls, "trees": trees, "weirs": weirs, "crossings": crossings, "passages": passages,
            "lots": lots, "kerbs": kerbs,
        }
    for (ls, _, cls, street), (left, right) in zip(car_ways, kerbs([w[0] for w in car_ways], [w[1] for w in car_ways])):
        # Each side out to its kerb, and round ends so streets join up at crossroads.
        # (The pieces are merged with all the others below, so not one by one here.)
        pieces = [ls.buffer(left, single_sided=True), ls.buffer(-right, single_sided=True),
                  ls.buffer(min(left, right), cap_style="round", join_style="round")]
        road_lines.setdefault(cls, []).extend(pieces)
        if street:
            streets.extend(pieces)
    road_polys = {k: unary_union(v).intersection(clip) for k, v in road_lines.items()}
    area_polys = {k: unary_union(v).intersection(clip) for k, v in areas.items()}
    gardens = _gardens(homes, buildings, streets, clip)
    if not gardens.is_empty:
        area_polys["garden"] = unary_union([area_polys.get("garden", gardens), gardens])
    return {
        "area": area, "bbox": (w, s, e, n), "box": (x0, y0, x1, y1), "clip": clip,
        "buildings": buildings, "areas": area_polys, "roads": road_polys, "rails": rails,
        "walls": walls, "trees": trees, "weirs": weirs, "crossings": crossings, "passages": passages,
        "lots": lots, "kerbs": kerbs,
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
    if lu == "allotments":
        return "garden"
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


# Buildings that don't decide what a block is: sheds and garages stand in gardens too.
OUTBUILDINGS = {"garage", "garages", "shed", "carport", "roof", "hut", "cabin", "greenhouse", "kiosk", "service"}
# Buildings that aren't homes: a block with much of these stays paved.
NOT_HOMES = {"commercial", "retail", "office", "industrial", "warehouse", "school", "university", "hospital",
             "public", "civic", "government", "church", "hotel", "dormitory", "kindergarten"}


def _gardens(homes, buildings, streets, clip):
    """OSM maps a suburb or a housing estate as one residential area and rarely maps
    the gardens and lawns in it, so the ground between the buildings would all be
    paved. Cut the residential areas along the streets (not service roads) into blocks.
    A block is green where it's mostly homes and either family houses covering less
    than 45 % of it, or blocks of flats with lots of room round them (under 30 %, a
    housing estate; inner-city blocks with paved courtyards are denser). All of it
    but a strip round each building: 0.8 m round a house, 2 m round anything bigger."""
    region = unary_union(homes).intersection(clip) if homes else Polygon()
    if region.is_empty:
        return Polygon()
    blocks = _polys(region.difference(unary_union(streets)) if streets else region)
    shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in buildings]
    tree = STRtree(shapes)
    out = []
    for block in blocks:
        if block.area < 100:
            continue
        near = tree.query(block, predicate="intersects")
        main = [k for k in near if buildings[k]["kind"] not in OUTBUILDINGS and not buildings[k]["part"]
                and block.contains(shapes[k].representative_point())]
        if not main:
            continue
        covered = sum(shapes[k].area for k in main)
        other = sum(shapes[k].area for k in main if buildings[k]["kind"] in NOT_HOMES)
        houses = sum(shapes[k].area for k in main if shapes[k].area <= 350 and buildings[k]["kind"] not in NOT_HOMES | {"apartments"})
        share = covered / block.area
        if other > 0.3 * covered or not (share < 0.3 or (houses >= 0.7 * covered and share < 0.45)):
            continue
        out.append(block.difference(unary_union([shapes[k].buffer(0.8 if shapes[k].area <= 350 else 2) for k in near])))
    return unary_union(out) if out else Polygon()


def _height(row, col, osm_id, area):
    h = _float(col(row, "height"))
    if h:
        return h
    lv = _float(col(row, "building:levels"))
    if lv:
        return lv * 3.4 + 1.0
    return _guess_height(col(row, "building"), area, random.Random(zlib.crc32(osm_id.encode())))


# Where OSM gives neither a height nor a number of storeys (much of it past the city
# limits, where IPR's model stops), guess from the kind of building and its footprint:
# most of these are sheds, garden cottages and family houses. The guess is seeded by
# the OSM id, so a building comes out the same in every build and every chunk.
SMALL = {"garage", "garages", "shed", "carport", "hut", "cabin", "kiosk", "service", "static_caravan",
         "transformer_tower", "houseboat", "toilets", "container", "allotment_house", "greenhouse"}
HALLS = {"industrial", "warehouse", "barn", "farm_auxiliary", "transportation", "hangar", "manufacture",
         "retail", "supermarket", "storage_tank", "sports_hall", "cowshed", "stable", "parking"}
HOUSES = {"house", "detached", "semidetached_house", "terrace", "bungalow", "farm"}


def _guess_height(kind, area, rnd):
    storeys = lambda n: n * 3.4 + 1.0 + rnd.uniform(-0.4, 0.4)  # noqa: E731
    if kind in ("church", "cathedral"):
        return 18 if area > 150 else 8 + rnd.uniform(0, 3)
    if kind == "chapel":
        return 4.5 + rnd.uniform(0, 1.5) if area < 40 else 9 + rnd.uniform(0, 3)
    if kind == "roof":  # a canopy: over a petrol station, a platform
        return 4 + rnd.uniform(0, 1)
    if kind == "ruins":
        return rnd.uniform(3, 6)
    if kind in SMALL or area < 25:
        return (2.5 if area < 40 else 3.2) + rnd.uniform(0, 0.8)
    if kind in HALLS:
        if area < 80:
            return 3.5 + rnd.uniform(0, 1)
        return min(14, 5 + math.sqrt(area) / 12 + rnd.uniform(0, 2))
    if kind == "bungalow":
        return storeys(1)
    if kind in HOUSES:
        return storeys(rnd.choice((1, 2, 2)) if area < 250 else rnd.choice((2, 3)))
    if kind == "apartments":
        return storeys(rnd.randint(3, 5) if area < 500 else rnd.randint(4, 10))
    # building=yes, residential, civic, commercial, school, ...: by the footprint alone.
    if area < 60:
        return storeys(1) - 0.8
    if area < 250:
        return storeys(rnd.choice((1, 2, 2)))
    if area < 600:
        return storeys(rnd.randint(2, 3))
    if area < 1500:
        return storeys(rnd.randint(2, 4))
    return min(14, 6 + math.sqrt(area) / 15 + rnd.uniform(0, 2))


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
