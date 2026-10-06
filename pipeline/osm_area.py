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
import shapely.affinity
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

import barriers
import dtm
import lanes
import pavements
import plots as garden_plots
import roofs
import sports
import worn_paths
from build_cache import Timings
from kerbs import Kerbs, estimate

AREAS = {
    # west, south, east, north (WGS84)
    "ujezd": (14.3985, 50.0765, 14.4155, 50.0865),
    # The historic centre: Hradčany and Malá Strana to Vinohrady, Smíchov and
    # Vyšehrad's edge to Letná's slope. About 4.3 x 3 km.
    "centrum": (14.390, 50.068, 14.450, 50.095),
    # The whole city (its administrative bounding box), 34 x 26 km.
    "praha": (14.2244, 49.9419, 14.7068, 50.1774),
    # Three 1 x 1 km pieces of the outer ring, to try street widths where the technical
    # map is thin or missing (plan 031): Nad Vinicemi in the north, Uhříněves's edge
    # in the south-east, and Vinoř in the east.
    "outer_n": (14.3849, 50.1523, 14.3989, 50.1613),
    "outer_se": (14.5571, 49.9972, 14.5711, 50.0062),
    "outer_e": (14.6936, 50.1093, 14.7076, 50.1183),
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
# Ways that may run through a building at street level: a pasáž, a gateway, an arcade.
PASSAGE_WAYS = {"footway", "path", "pedestrian", "steps", "corridor", "cycleway", "living_street", "service"}
# A way tagged tunnel=yes or covered (not tunnel=building_passage) is taken for a
# passage through buildings when at least this much of it is inside them; an arcade
# (covered=arcade), which runs along the street under the buildings' fronts, when
# ARCADE metres of it are.
INSIDE = 0.5
ARCADE = 3.0
COBBLES = ("sett", "cobblestone", "unhewn_cobblestone", "paving_stones")
SQUARE_EDGE = 0.5  # m: avoid a remnant of a route ribbon along a square's edge
# `meadow` (meadows, grassland, scrub) and `lawn` (mown grass, and the lawns of housing
# estates) are kept apart from `park` and `garden` because they dry out differently in
# summer (src/groundSeason.ts); everything else treats them as the same green.
NATURAL_GROUND = ("park", "garden", "meadow", "lawn", "wood", "orchard", "water",
                  *sports.PITCH_KINDS)
# A car road at least this much of whose centre line runs on the technical map's
# surveyed surface is drawn from the survey (dtm.py); others, from OSM's tags.
SURVEYED = 0.5
# How far past its kerb a cobbled street's cobbles may reach (into its parking bays).
SETT_REACH = 4.0
FENCE_TOLERANCE = 0.25  # m: how far a fence's line may be straightened
GRID = 0.01  # metres, for overlaying the survey's surface
SPARSE_OTHER = 0.04  # of a block's area: a few shops or sheds in a mostly empty block don't make it commercial
SETTLED_REACH = 30.0  # m: how far from a family house unmapped land counts as its surroundings


def road_width(hw, width=None, lanes=None):
    """Carriageway width: the width tag, else lanes x 3.25 m, else by class."""
    if width:
        return width
    if lanes and hw in CAR_ROADS and hw not in ("service", "living_street"):
        return lanes * LANE_WIDTH + (1.0 if hw.startswith(("motorway", "trunk", "primary")) else 0.5)
    return ROAD_WIDTH.get(hw, 6)


# What extract() asks OSM for.
FEATURE_TAGS = {
    "building": True, "building:part": True, "highway": True, "landuse": True, "leisure": True,
    "natural": True, "waterway": True, "railway": True, "amenity": True,
    "barrier": ["wall", "city_wall", "fence", "hedge", "guard_rail"], "man_made": ["bridge", "pier"],
    "place": ["islet", "island", "square"], "historic": ["city_gate", "castle_wall"],
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


def extract(area: str, bbox=None, centre=None, source=None, features=None, ground=True,
            buildings_only=False, timings=None, stats=None) -> dict:
    """Fetch and classify everything in the area; geometry stays as shapely objects.

    `bbox` (WGS84) overrides the area's box, e.g. for one chunk of a large area, and
    `centre` (lon, lat) keeps the local metres of the whole area, so chunks line up.
    `source`: an .osm XML file already cut to the box, instead of asking Overpass;
    `features`: the features already read (features_from_json).
    `ground`: False leaves out the land use and the streets' surfaces ("areas" and
    "roads" come back empty), including unrelated land polygons and parking lots.
    `buildings_only`: only buildings and roof parts, without DTM or street work.
    `timings` and `stats`: optional dictionaries filled with durations and counts;
    they are not included in the returned geometry.
    """
    timer = Timings(timings)
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
    if stats is not None:
        stats["features"] = len(rows)
    timer.lap("features")

    def col(row, k):
        v = row.get(k)
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        return v

    def add_passage(g, hw, width):
        # A way through a building at street level (a gateway, an arcade, a pasáž):
        # drawn like any street, and cut through the building's footprint.
        for ls in _lines(g.intersection(clip)):
            passages.append({"hw": hw, "w": round(width, 1), "pts": _coords(ls)})

    def add_way(row, g, hw, width):
        cls = "road" if hw in CAR_ROADS else "path"
        if col(row, "bridge") not in (None, "no"):  # yes, viaduct, cantilever, …
            cls = "bridge"
        if cls != "bridge" and hw in ("path", "track", "bridleway") and col(row, "surface") not in ("paving_stones", "sett", "asphalt", "cobblestone"):
            cls = "dirt"
        if cls == "road" and col(row, "surface") in COBBLES:
            cls = "sett"  # most streets are asphalt; the rest keep their cobbles
        if cls == "path" and hw in ("pedestrian", "footway") and _square_surface(col(row, "surface")) == "square_setts":
            cls = "sett"  # a cobbled walking street has the same stones as its neighbours
        if hw == "footway" and col(row, "footway") == "crossing":
            crossings.extend(_coords(ls) for ls in _lines(g.intersection(clip)))
            return
        if hw not in CAR_ROADS and cls != "bridge":
            # What the surveyed pavement under it is paved with (pavements.py).
            paved_ways.extend((ls, col(row, "surface"), hw == "pedestrian") for ls in _lines(g))
        if hw in ("footway", "path") and col(row, "footway") not in ("traffic_island", "link"):
            sidewalks.extend((ls, width / 2, col(row, "footway") == "sidewalk") for ls in _lines(g))
        if hw in CAR_ROADS:
            # Sized kerb to kerb once the pavements and tracks are all in (kerbs.py).
            est = {**estimate(width, lambda k: col(row, k), not col(row, "width") and not col(row, "lanes")), "hw": hw,
                   "tunnel": col(row, "tunnel") not in (None, "no")}
            car_ways.extend((ls, est, cls, hw != "service") for ls in _lines(g))
            return
        if ground:
            at_ground = (col(row, "bridge") in (None, "no")
                         and _ground_level(col(row, "layer"))
                         and _ground_level(col(row, "level")))
            # On paving these tags describe a route, not another surface. A part
            # crossing mapped greenery still needs a real path; decide below.
            route = at_ground and hw == "footway" and col(row, "footway") in ("traffic_island", "link")
            # (Widened into a ribbon once every way is in: pavements.ribbon.)
            walking_surfaces.append((g, cls, col(row, "surface"), at_ground, route))
            walking_widths.append((width / 2, hw == "footway" and col(row, "footway") == "sidewalk"))

    buildings = []
    parts = []  # building parts whose roof OSM describes (roofs.py), to colour IPR's roofs by
    areas: dict[str, list] = {}
    road_lines: dict[str, list] = {}
    walking_surfaces = []  # (line, class, surface tag, ground level, route only on paving)
    walking_widths = []  # for each of those: (half width, tagged as a street's pavement)
    paved_ways = []  # (line, surface tag, a walking street?) of the ways for walking
    rails, walls, fences, trees, weirs, crossings, passages = [], [], [], [], [], [], []
    marks = []  # painted lines on pitches, courts and tracks (sports.py), as polylines
    lots = []  # each parking area on its own, with how the cars stand in it
    homes = []  # landuse=residential, where gardens may be (see _gardens)
    streets = []  # car roads other than service roads, which cut residential areas into blocks
    car_ways = []  # (line, what its tags say, class, a street?), sized after the loop
    mapped_rails = []  # crash barriers as OSM maps them
    sidewalks = []  # footways and paths with their half widths, which may run along a street
    drivable = []  # every car way as the road it covers, to keep inferred parking off it
    service = []  # those of them that aren't streets: they run through blocks of gardens
    maybe = []  # ways that are passages if they run through buildings (passage_tags)
    squares = []  # (polygon, own surface, named outline only); decide after all ways and land
    square_ways = []  # (line, mapped surface) on the ground, including untagged ways
    stops = []  # (x, y) of public transport stops, which people cross the grass to reach (worn_paths.py)
    ground_ways = set()  # the OSM ids of the passages among the ways tagged as tunnels

    # Every geometry into local metres in one go.
    if buildings_only:
        chosen = [k for k, row in enumerate(rows) if col(row, "building") or col(row, "building:part")]
        geoms, rows = np.asarray(geoms, dtype=object)[chosen], [rows[k] for k in chosen]
    geoms = shapely.transform(geoms, lambda c: np.column_stack(tf.transform(c[:, 0], c[:, 1])))
    timer.lap("project")
    for g, row in zip(geoms, rows):
        if g is None or g.is_empty:
            continue
        osm_id = f"{row['element']}/{row['id']}"
        if not g.intersects(clip):
            continue

        b = col(row, "building")
        cover = roofs.OVERRIDES.get(osm_id) or roofs.cover(col(row, "roof:material"), col(row, "roof:colour"))
        if not b and cover and col(row, "building:part") and isinstance(g, (Polygon, MultiPolygon)):
            parts += [{"id": osm_id, "cover": cover, "rings": _rings(poly)}
                      for poly in _polys(g.buffer(0).intersection(clip)) if poly.area >= 1]
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
                    **({"cover": cover} if cover else {}),
                    "rings": _rings(poly),
                })
            continue

        if buildings_only:
            continue
        if isinstance(g, Point) and (col(row, "highway") == "bus_stop" or col(row, "railway") in ("tram_stop", "halt", "station", "subway_entrance")):
            stops.append((g.x, g.y))
            continue
        hw = col(row, "highway")
        if hw and isinstance(g, (LineString, MultiLineString)):
            if hw in ("proposed", "construction", "elevator", "platform", "bus_stop"):
                continue
            if (ground and hw in ("pedestrian", "footway", "living_street", "service")
                    and col(row, "footway") != "crossing" and col(row, "tunnel") in (None, "no")
                    and col(row, "bridge") in (None, "no")
                    and _ground_level(col(row, "layer"))
                    and _ground_level(col(row, "level"))):
                square_ways.extend((ls, _square_surface(col(row, "surface"))) for ls in _lines(g.intersection(clip)))
            width = road_width(hw, _float(col(row, "width")), _float(col(row, "lanes")))
            passage = passage_tags(hw, lambda k: col(row, k))
            if passage == "maybe":
                maybe.append((row, g, hw, width))  # decided once all the buildings are in
                continue
            if passage:
                add_passage(g, hw, width)
            elif col(row, "tunnel"):
                continue
            add_way(row, g, hw, width)
            continue
        if ground and hw == "pedestrian" and isinstance(g, (Polygon, MultiPolygon)):
            squares.append((g.buffer(0), col(row, "surface"), False))
            continue

        rw = col(row, "railway")
        if rw in ("tram", "funicular", "rail") and isinstance(g, (LineString, MultiLineString)):
            if col(row, "tunnel") == "yes":
                continue
            for ls in _lines(g.intersection(clip)):
                rails.append({"kind": rw, "pts": _coords(ls)})
            continue

        if col(row, "barrier") == "guard_rail":
            if isinstance(g, (LineString, MultiLineString)):
                mapped_rails.extend(_lines(g.intersection(clip)))
            continue

        if col(row, "barrier") in ("fence", "hedge"):
            # A fence or hedge round a plot is a closed way, which osmnx may hand over as a polygon.
            line = g.boundary if isinstance(g, (Polygon, MultiPolygon)) else g
            if isinstance(line, (LineString, MultiLineString)):
                item = {"kind": col(row, "barrier")}
                h = _metres(col(row, "height"))
                if h and 0.3 <= h <= 4:
                    item["h"] = round(h, 1)
                for ls in _lines(line.intersection(clip)):
                    fences.append({**item, "pts": _coords(ls.simplify(FENCE_TOLERANCE))})
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
            tree = [round(g.x, 1), round(g.y, 1)]
            if _conifer(col(row, "leaf_type"), col(row, "genus"), col(row, "species")):
                tree.append(1)
            trees.append(tree)
            continue

        if ground and isinstance(g, (Polygon, MultiPolygon)):
            if col(row, "landuse") == "residential":
                homes.append(g.buffer(0))
            kind = _area_kind(row, col)
            if kind == "pitch":
                for kind, part, painted in sports.classify(col(row, "leisure"), col(row, "sport"), col(row, "surface"),
                                                           col(row, "area"), g.buffer(0), osm_id):
                    areas.setdefault(kind, []).append(part)
                    marks.extend(painted)
            elif kind == "square":
                outline = col(row, "place") == "square" and not col(row, "area:highway")
                squares.append((g.buffer(0), col(row, "surface"), outline))
            elif kind:
                areas.setdefault(kind, []).append(g.buffer(0))
            if kind == "parking" and col(row, "parking") not in UNDER_COVER:
                o = col(row, "orientation")
                for poly in _polys(g.buffer(0).intersection(clip)):
                    lots.append({"o": o if o in ORIENTATIONS else None, "poly": poly})
            elif (col(row, "man_made") == "bridge" or col(row, "bridge")) and not b:
                areas.setdefault("bridge", []).append(g.buffer(0))

    timer.lap("feature_loop")
    if stats is not None:
        stats.update(buildings=len(buildings), car_ways=len(car_ways), sidewalks=len(sidewalks))
    if buildings_only:
        return {"buildings": buildings, "parts": parts}

    # Passages tagged as tunnels or as covered ways: the ones that run through buildings.
    if maybe:
        shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in buildings]
        btree = STRtree(shapes)
        for row, g, hw, width in maybe:
            hits = btree.query(g, predicate="intersects")
            inside = unary_union([shapes[k] for k in hits]).intersection(g).length if len(hits) else 0
            if inside >= (min(ARCADE, INSIDE * g.length) if col(row, "covered") == "arcade" else INSIDE * g.length):
                add_passage(g, hw, width)
                if row["element"] == "way":
                    ground_ways.add(int(row["id"]))
            elif col(row, "tunnel"):
                continue
            add_way(row, g, hw, width)

    timer.lap("passages")

    # The streets as surveyed, where the technical map has them (within Prague).
    surface = shapely.intersection(dtm.streets((w, s, e, n), tf.transform), clip, grid_size=GRID)
    timer.lap("dtm_streets")
    kerbs = Kerbs(sidewalks, [LineString(r["pts"]) for r in rails if r["kind"] == "tram"], [w[0] for w in car_ways], surface)
    timer.lap("kerb_index")
    # Streets with no width, lanes or survey: by their setting and the room there is (lanes.py).
    # (Only the mapped fences and walls: the plots' fences are made later, from the streets.)
    setting = lanes.Setting(buildings, [*fences, *walls])
    car_lines = [w[0] for w in car_ways]
    lanes.apply(setting, kerbs, car_lines, [w[1]["hw"] for w in car_ways], [w[1] for w in car_ways],
                [not w[1]["guessed"] for w in car_ways])
    timer.lap("street_widths")
    if not ground:
        return {
            "area": area, "bbox": (w, s, e, n), "box": (x0, y0, x1, y1), "clip": clip,
            "buildings": buildings, "parts": parts, "areas": {}, "roads": {}, "rails": rails,
            "walls": walls, "fences": fences, "trees": trees, "weirs": weirs, "crossings": crossings, "passages": passages,
            "ground_ways": ground_ways, "marks": [],
            "lots": lots, "kerbs": kerbs, "drives": [], "setting": setting, "plots": [], "patches": {}, "sheds": [],
        }
    lines = [w[0] for w in car_ways]
    measured = kerbs(lines, [w[1] for w in car_ways])
    shares = kerbs.surveyed(lines)
    timer.lap("kerb_measure")
    surveyed, sett_near = [], []  # (centre line, cobbled?) of streets drawn from the survey
    for (ls, _, cls, street), (left, right), share in zip(car_ways, measured, shares):
        # Each side out to its kerb, and round ends so streets join up at crossroads.
        # (The pieces are merged with all the others below, so not one by one here.)
        pieces = [ls.buffer(left, single_sided=True), ls.buffer(-right, single_sided=True),
                  ls.buffer(min(left, right), cap_style="round", join_style="round")]
        drivable.extend(pieces)
        if street:
            streets.extend(pieces)
        else:
            service.extend(pieces)
        if cls != "bridge" and share >= SURVEYED:
            # The survey has this street: it's drawn from there (below); what OSM
            # says is only what it's paved with.
            surveyed.append((ls, cls == "sett"))
            if cls == "sett":
                sett_near.append(ls.buffer(max(left, right) + SETT_REACH))
            continue
        road_lines.setdefault(cls, []).extend(pieces)
    timer.lap("road_buffers")
    if not surface.is_empty:
        # Cobbles where a cobbled street is the nearest and close by, asphalt elsewhere,
        # including the surveyed car parks and lanes OSM doesn't have.
        # (Snapped to a centimetre grid: the survey's surface and the Voronoi cells meet
        # at countless near-coincident edges, which exact overlay trips over. Snapping
        # can also squash a sliver into a line, so only the areas are kept each time.)
        surface = _areas(surface)
        setts = Polygon()
        if sett_near:
            setts = _areas(shapely.intersection(_nearest(surveyed, surface), unary_union(sett_near), grid_size=GRID))
        road_lines.setdefault("sett", []).append(_areas(shapely.intersection(surface, setts, grid_size=GRID)))
        road_lines.setdefault("road", []).append(_areas(shapely.difference(surface, setts, grid_size=GRID)))
    timer.lap("cobble_voronoi")
    # Route-only links may cross the housing-estate lawns inferred from blocks,
    # or surveyed green that OSM hasn't mapped. Decide after those surfaces too.
    land = {f"dtm_{kind}": _areas(geom.intersection(clip))
            for kind, geom in dtm.land((w, s, e, n), tf.transform).items()}
    timer.lap("dtm_land")
    # The footpaths as ribbons with square ends (pavements.py).
    meet = pavements.joints([g for g, *_ in walking_surfaces])
    walking_surfaces = [(pavements.ribbon(g, half, meet), *rest)
                        for (g, *rest), (half, _) in zip(walking_surfaces, walking_widths)]
    # Where family houses stand on land nobody mapped (no residential area, no survey,
    # no mapped use), that land is gardens and meadow too, not pavement.
    spoken_for = [*(g for k, v in areas.items() if k not in NATURAL_GROUND for g in v),
                  *(g for v in road_lines.values() for g in v), *land.values(), *(p for p, _, _ in squares)]
    gardens, lawns, plot_fences, drives, on_plots = _gardens(
        homes, buildings, streets, clip,
        [LineString(f["pts"]) for f in fences] + [LineString(wl["pts"]) for wl in walls],
        unmapped=[g for g in spoken_for if not g.is_empty],
        ways=[g for g in [*service, *road_lines.get("path", []), *road_lines.get("dirt", []), *(ws[0] for ws in walking_surfaces)]
              if not g.is_empty and g.geom_type in ("Polygon", "MultiPolygon")])
    fences.extend(plot_fences)
    timer.lap("gardens")
    natural = unary_union([gardens, lawns, *(g for k in NATURAL_GROUND for g in areas.get(k, [])),
                          *(g for k, g in land.items()
                            if k in ("dtm_green", "dtm_garden", "dtm_wood", "dtm_pitch"))])
    # A named square can contain mapped, surveyed or inferred lawns. Decide its
    # paved remainder only after all those sources are in; explicit surface areas
    # keep their paving even when green also covers them.
    square_lines = [line for line, _ in square_ways]
    square_tree = STRtree(square_lines) if square_lines else None
    for poly, surface_tag, outline in squares:
        if outline and not natural.is_empty:
            poly = _areas(poly.difference(natural))
        if poly.is_empty:
            continue
        kind = _square_surface(surface_tag) if surface_tag is not None else _square_from_ways(poly, square_ways, square_tree)
        areas.setdefault(kind or "square", []).append(poly)
    # The pavements, islands and tram beds the technical map has surveyed, in place of
    # the footways' ribbons along them.
    paved, walked = pavements.surveyed(
        {} if pavements.DERIVED_ONLY else dtm.walks((w, s, e, n), tf.transform), surface, paved_ways,
        unary_union([g for k in ("square", "square_setts", "square_asphalt", "square_loose") for g in areas.get(k, [])]),
        unary_union([g for k, g in land.items() if k != "dtm_yard"]), clip, stats)
    walking_surfaces = pavements.without_survey(walking_surfaces, [beside for _, beside in walking_widths], walked)
    for key, geom in paved.items():
        road_lines.setdefault(key, []).append(geom)
    timer.lap("surveyed_pavements")
    for cls, geom in _walking_surfaces(walking_surfaces, areas, natural):
        road_lines.setdefault(cls, []).append(geom)
    timer.lap("squares_walking_surfaces")
    # A gravel shoulder beside the through roads sized from their setting (lanes.py).
    # After the walking surfaces, which take a square's paving for a path's.
    strips = lanes.shoulders(setting, kerbs, lines, [w[1]["hw"] for w in car_ways], [w[1]["guessed"] for w in car_ways],
                             measured, [w[2] == "bridge" for w in car_ways], SURVEYED)
    if strips:
        wet = unary_union(areas.get("water", []))
        areas.setdefault("square_loose", []).append(unary_union(strips).difference(wet))
    timer.lap("shoulders")
    # Crash barriers along the motorways and expressways (barriers.py). Kept out of
    # `fences` until here: they are not something a street is sized against or a
    # garden's edge.
    rails_beside = barriers.guard_rails(lines, [w[1]["hw"] for w in car_ways], measured,
                                        [w[2] == "bridge" or w[1]["tunnel"] for w in car_ways], drivable, mapped_rails)
    fences.extend({"kind": "guard_rail", "pts": _coords(piece)}
                  for ln in rails_beside for piece in _lines(ln.intersection(clip)) if piece.length >= 1)
    timer.lap("guard_rails")
    lots.extend(_inferred_lots(dtm.parking((w, s, e, n), tf.transform).intersection(clip),
                               [land.get("dtm_yard", Polygon()), *areas.get("yard", [])],
                               lots, buildings, drivable, natural, [w[0] for w in car_ways], clip))
    timer.lap("inferred_lots")
    road_polys = {k: unary_union(v) for k, v in road_lines.items()}
    area_polys = {k: unary_union(v).intersection(clip) for k, v in areas.items()}
    # The paths' ribbons tidied (plan 018), before they are cut to the chunk.
    keep_off = [*(road_polys[k] for k in ("road", "sett") if k in road_polys), area_polys.get("water", Polygon()),
                *(Polygon(b["rings"][0], b["rings"][1:]) for b in buildings)]
    for k in ("path", "dirt"):
        if k in road_polys and not pavements.DERIVED_ONLY:
            road_polys[k] = pavements.tidy(road_polys[k], keep_off)
    road_polys = {k: g.intersection(clip) for k, g in road_polys.items()}
    timer.lap("road_land_unions")
    area_polys.update(land)
    if not gardens.is_empty:
        area_polys["garden"] = unary_union([area_polys.get("garden", gardens), gardens])
    if not lawns.is_empty:
        area_polys["lawn"] = unary_union([area_polys.get("lawn", lawns), lawns])
    grass = unary_union([lawns, area_polys.get("meadow", Polygon()), area_polys.get("dtm_green", Polygon())])
    if not grass.is_empty:
        flats = {k: Polygon(b["rings"][0], b["rings"][1:]) for k, b in enumerate(buildings)}
        blocks = [k for k, b in enumerate(buildings)
                  if b["kind"] in ("apartments", "residential", "dormitory") and not b["part"] and flats[k].area >= 250]
        # A list, not one joined shape: worn_paths only asks whether a line crosses any.
        obstacles = [*flats.values(), area_polys.get("water", Polygon()), area_polys.get("parking", Polygon()),
                     road_polys.get("road", Polygon()), road_polys.get("bridge", Polygon()),
                     *(LineString(f["pts"]).buffer(0.3) for f in [*fences, *walls])]
        worn = worn_paths.worn_paths(grass, flats, blocks, stops,
                                     [ls for ls, _, _ in sidewalks], [w[0] for w in car_ways], obstacles)
        core, rim = worn_paths.ribbons(worn)
        if core is not None:
            area_polys["worn"] = _areas(core.intersection(clip))
            area_polys["worn_edge"] = _areas(rim.intersection(clip))
        if stats is not None:
            stats["worn_paths"] = len(worn)
    timer.lap("worn_paths")
    return {
        "area": area, "bbox": (w, s, e, n), "box": (x0, y0, x1, y1), "clip": clip,
        "buildings": buildings, "parts": parts, "areas": area_polys, "roads": road_polys, "rails": rails,
        "walls": walls, "fences": fences, "trees": trees, "weirs": weirs, "crossings": crossings, "passages": passages,
            "ground_ways": ground_ways, "marks": marks,
        "lots": lots, "kerbs": kerbs, "drives": drives, "setting": setting,
        # What stands on the plots of family houses (plots.py), drawn over the garden.
        "plots": [{"b": p["b"], "poly": p["poly"], **({"gate": p["gate"]} if p["gate"] else {}), **({"strip": 1} if p["strip"] else {})}
                  for p in on_plots.get("plots", [])],
        "patches": {kind: unary_union(on_plots[key]).intersection(clip) for kind, key in (("paving", "paving"), ("bed", "beds"), ("pool", "pools"))
                    if on_plots.get(key)},
        "sheds": on_plots.get("sheds", []),
    }


SQUARE_SURFACES = {
    "sett": "square_setts", "cobblestone": "square_setts", "unhewn_cobblestone": "square_setts",
    "paving_stones": "square", "concrete:plates": "square", "paved": "square", "concrete": "square",
    "asphalt": "square_asphalt",
    "compacted": "square_loose", "unpaved": "square_loose", "sand": "square_loose",
    "gravel": "square_loose", "fine_gravel": "square_loose",
}


def _square_surface(value):
    """The drawn surface of one square or of a line that crosses it."""
    return SQUARE_SURFACES.get(str(value).strip().lower()) if value is not None else None


def _ground_level(value):
    """A missing or single numeric zero level; ambiguous/multiple levels stay drawn."""
    if value is None:
        return True
    try:
        return float(str(value).strip()) == 0
    except (TypeError, ValueError):
        return False


def _walking_surfaces(ways, areas, natural=None):
    """Remove only a ground-level ribbon that repeats a square's material.

    Keep unknown explicit materials, unlike an untagged route, and keep bridges
    and raised ways. Use full polygons before chunk/tile clipping so an edge or
    a hole has the same treatment on both sides of a seam.
    """
    if natural is None:
        natural = unary_union([g for k in NATURAL_GROUND for g in areas.get(k, [])])
    squares, paving = {}, {}
    for kind in ("square", "square_setts", "square_asphalt", "square_loose"):
        poly = unary_union(areas.get(kind, []))
        paving[kind] = poly
        # Enlarge into surrounding paving, never into a lawn or pond. In particular
        # a green hole narrower than 1 m must not disappear under the edge margin.
        squares[kind] = poly.buffer(SQUARE_EDGE).difference(natural.difference(poly))
    all_squares = unary_union(list(squares.values()))
    green = natural.difference(unary_union(areas.get("water", [])))
    distinct = {kind: unary_union([green, *(p for k, p in paving.items() if k != kind)])
                for kind in {_square_surface(tag) for _, _, tag, _, route in ways if route and tag is not None}}
    for geom, cls, tag, at_ground, route in ways:
        kind = _square_surface(tag)
        if route:
            # A route tag is not evidence that an explicitly different material
            # is redundant (e.g. an asphalt link across granite setts).
            geom = _areas(geom.intersection(green if tag is None else distinct[kind]))
        if at_ground:
            mask = all_squares if tag is None else squares.get(kind)
            if mask is not None and not mask.is_empty:
                geom = _areas(geom.difference(mask))
        if not geom.is_empty:
            yield cls, geom


def _square_from_ways(poly, ways, tree):
    """Inherit only a clear majority of at least 30 m of mapped, ground-level ways."""
    if tree is None:
        return None
    lengths = {}
    total = 0.0
    for i in tree.query(poly, predicate="intersects"):
        line, kind = ways[i]
        length = line.intersection(poly).length
        total += length
        if kind:
            lengths[kind] = lengths.get(kind, 0.0) + length
    if not lengths or total == 0:
        return None
    kind, length = max(lengths.items(), key=lambda item: item[1])
    return kind if length >= 30 and length >= 0.6 * total else None


CONIFERS = ("picea", "pinus", "abies", "larix", "taxus", "thuja", "juniperus", "cedrus", "pseudotsuga", "cupressus", "tsuga", "chamaecyparis", "metasequoia")


def _conifer(leaf_type, genus, species):
    """Whether an OSM tree's tags say it is a conifer (needles, or a conifer's genus)."""
    if leaf_type:
        return str(leaf_type) == "needleleaved"
    name = str(genus or species or "").strip().lower()
    return name.startswith(CONIFERS)


def passage_tags(hw, get):
    """Whether a way is a passage through a building at street level, by its tags
    (`get`: a tag's value or None): True for tunnel=building_passage, "maybe" for a
    way tagged as a tunnel or as covered that could be one (it is if it runs through
    buildings, INSIDE), else False. Not below the street: a metro station's corridors,
    an underpass."""
    tunnel, covered = get("tunnel"), get("covered")
    layer = _float(get("layer")) or 0
    if tunnel == "building_passage":
        return layer >= -1
    if hw not in PASSAGE_WAYS or not (tunnel == "yes" or (not tunnel and covered in ("yes", "arcade"))):
        return False
    # Arcades are often put a layer down, under the building.
    if layer not in (0, -1) or (layer == -1 and not covered) or str(get("level") or "0").strip() != "0":
        return False
    return "maybe"


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
    if lu == "meadow" or na in ("scrub", "grassland"):
        return "meadow"
    if lu == "grass":
        return "lawn"
    if le in ("park", "garden") or lu in ("village_green", "recreation_ground"):
        return "park"
    if le in ("pitch", "playground", "sports_centre", "track"):
        return "pitch"
    if am == "parking":
        return "parking"
    if col(row, "area:highway") or col(row, "highway") == "pedestrian" or col(row, "place") == "square":
        return "square"
    if lu in ("cemetery",) or am == "grave_yard" or le == "golf_course" or na in ("wetland", "heath"):
        return "park"
    # Land that has a use but no mapped surface, which would otherwise stay plain:
    # fields round the city, work yards, railway land, and ground being dug up.
    if lu in ("farmland", "plant_nursery", "greenhouse_horticulture"):
        return "field"
    if lu in ("industrial", "garages", "farmyard"):
        return "yard"
    if lu == "railway":
        return "ballast"
    if lu in ("construction", "brownfield", "landfill", "quarry") or na in ("bare_rock", "sand"):
        return "bare"
    return None


INFERRED_WIDTH = 4.4  # least width of a stretch of paving that gets bays (a row of cars plus a bit)
INFERRED_AREA = 60  # m², the smallest inferred car park
INFERRED_REACH = 3  # m, how close to a car way it must be for cars to get in
COURTYARD = 0.65  # share of an outline touching buildings above which a yard is a courtyard, not a car park


def _inferred_lots(parking, yards, lots, buildings, drivable, natural, car_lines, clip):
    """Paved ground that is used for parking but that OSM doesn't map as a car park:
    what the survey colours as parking, and the open paving in work yards, less the
    mapped car parks, buildings, car ways and green ground. Kept where the paving is
    wide enough for a row of cars, big enough, and reached by a car way. The yards
    and not the surveyed parking are skipped where buildings round them on most sides
    (a courtyard). Each comes back as a lot marked "i" (inferred), which the game lays
    out with aisles."""
    shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in buildings]
    # (Grown one by one before joining: a footprint that crosses itself can't be joined.)
    walls = unary_union([s.buffer(1) for s in shapes]) if shapes else Polygon()
    taken = unary_union([*(lot["poly"] for lot in lots), walls, *drivable, natural]) if (lots or drivable) else unary_union([walls, natural])
    yard = unary_union([y for y in yards if not y.is_empty]) if any(not y.is_empty for y in yards) else Polygon()
    free = shapely.difference(unary_union([parking, yard]), taken, grid_size=GRID)
    if free.is_empty:
        return []
    free = _areas(free.buffer(-INFERRED_WIDTH / 2, join_style="mitre").buffer(INFERRED_WIDTH / 2, join_style="mitre"))
    near = STRtree(car_lines) if car_lines else None
    beside_walls = walls.buffer(0.5) if not walls.is_empty else None
    out = []
    for poly in _polys(free):
        if poly.area < INFERRED_AREA or near is None:
            continue
        if not len(near.query(poly.buffer(INFERRED_REACH), predicate="intersects")):
            continue
        survey = poly.intersection(parking).area / poly.area
        if survey < 0.5 and beside_walls is not None and poly.boundary.intersection(beside_walls).length > COURTYARD * poly.boundary.length:
            continue
        out.append({"o": None, "poly": poly, "i": 1})
    return out


# Buildings that don't decide what a block is: sheds and garages stand in gardens too.
OUTBUILDINGS = {"garage", "garages", "shed", "carport", "roof", "hut", "cabin", "greenhouse", "kiosk", "service"}
# Buildings that aren't homes: a block with much of these stays paved.
NOT_HOMES = {"commercial", "retail", "office", "industrial", "warehouse", "school", "university", "hospital",
             "public", "civic", "government", "church", "hotel", "dormitory", "kindergarten"}


def _gardens(homes, buildings, streets, clip, barriers=(), unmapped=None, ways=()):
    """OSM maps a suburb or a housing estate as one residential area and rarely maps
    the gardens and lawns in it, so the ground between the buildings would all be
    paved. Cut the residential areas along the streets (not service roads) into blocks.
    A block is green where it's mostly homes and either family houses covering less
    than 45 % of it, or blocks of flats with lots of room round them (under 30 %, a
    housing estate; inner-city blocks with paved courtyards are denser). All of it
    but a strip round each building: 0.8 m round a house, 2 m round anything bigger.
    Where the block is family houses, each gets a plot (_plots) with hedges and fences
    along its edges; these are returned as fences, apart from where OSM maps a barrier
    (`barriers`), places for cars on its drive, a paved strip from the gate and now and
    then a shed, a bed or a pool (plots.py; `ways` are the surfaces of the service roads
    and paths, which may run through a block and are kept clear). Returns (the gardens,
    the estate lawns, those fences, those places, the rest of what plots.furnish makes):
    the family houses' gardens are private and kept watered, a housing estate's lawn is
    mown public grass that dries out more."""
    region = unary_union(homes).intersection(clip) if homes else Polygon()
    shapes = [Polygon(b["rings"][0], b["rings"][1:]) for b in buildings]
    tree = STRtree(shapes)
    # Land in no residential area but round family houses, in no mapped use either
    # (`unmapped` is what is spoken for): green too, without plots and fences.
    implied = Polygon()
    if unmapped is not None:
        family = [shapes[k] for k, b in enumerate(buildings) if not b["part"] and shapes[k].area <= 350
                  and b["kind"] not in NOT_HOMES | OUTBUILDINGS | {"apartments"}]
        if family:
            implied = unary_union([h.buffer(SETTLED_REACH) for h in family]).intersection(clip)
            # The residential areas first: most family houses stand in one, so little is
            # left, and only the mapped land that touches what is left has to be joined.
            # (`unmapped` as a list of shapes; joining all of a chunk's mapped land into
            # one shape here took longer than the rest of the gardens together.)
            implied = implied.difference(region)
            if isinstance(unmapped, list):
                pieces = [g for g in shapely.get_parts(np.asarray(unmapped, dtype=object)) if g.area > 0] if unmapped and not implied.is_empty else []
                hits = STRtree(pieces).query(implied, predicate="intersects") if pieces else []
                unmapped = unary_union([pieces[k] for k in sorted(hits)]) if len(hits) else Polygon()
            implied = implied.difference(unmapped)
            implied = implied.buffer(-3).buffer(3)  # not the slivers between things
    if region.is_empty and implied.is_empty:
        return Polygon(), Polygon(), [], [], {}
    cut = unary_union(streets) if streets else None
    blocks = [(b, True) for b in _polys(region.difference(cut) if cut is not None else region)] if not region.is_empty else []
    if not implied.is_empty:
        blocks += [(b, False) for b in _polys(implied.difference(cut) if cut is not None else implied)]
    out, lawns, fences, drives = [], [], [], []
    made = {"plots": [], "paving": [], "beds": [], "pools": [], "sheds": []}
    # (Polygon by polygon: joined surfaces span the chunk, and each block needs only its own.)
    ways = [g for g in shapely.get_parts(np.asarray(ways, dtype=object)) if g.area > 0] if len(ways) else []
    way_tree = STRtree(ways) if len(ways) else None
    street_edge = unary_union(streets).buffer(1.5) if streets else Polygon()
    mapped = unary_union([b.buffer(1.0) for b in barriers]) if len(barriers) else Polygon()
    for block, fenced in blocks:
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
        if (other > 0.3 * covered and other > SPARSE_OTHER * block.area) or not (share < 0.3 or (houses >= 0.7 * covered and share < 0.45)):
            continue
        green = block.difference(unary_union([shapes[k].buffer(0.8 if shapes[k].area <= 350 else 2) for k in near]))
        if fenced and houses < 0.7 * covered:
            lawns.append(green)
            continue
        out.append(green)
        if fenced and houses >= 0.7 * covered:
            homes_here = [(buildings[k]["id"], shapes[k]) for k in main]
            through = unary_union([ways[k].intersection(block) for k in way_tree.query(block, predicate="intersects")]) if way_tree is not None else Polygon()
            got = garden_plots.furnish(_plots(block, homes_here), homes_here, [(buildings[k]["kind"], shapes[k]) for k in near],
                                       green, street_edge, mapped, through)
            fences.extend(got["fences"])
            drives.extend(got["drives"])
            for key in made:
                made[key].extend(got[key])
    return (unary_union(out) if out else Polygon()), (unary_union(lawns) if lawns else Polygon()), fences, drives, made


MIN_PLOT = 60  # m2: a smaller cell goes to the neighbour it shares most edge with


def _plots(block, homes):
    """Divide a block of family houses into one plot per house: the Voronoi cell round
    each footprint (sampled every 3 m along its outline, a little way in so terraced
    houses that share a wall don't coincide), cut to the block. A long house gets a long
    plot, and terraced houses plots running from the street to the back. Cells under
    MIN_PLOT merge into a neighbour. Returns [(building id, plot)]; `homes` is [(id, footprint)]."""
    if len(homes) < 2:
        return [(homes[0][0], block)] if homes else []
    pts, owner, seen = [], [], set()
    for k, (_, shape) in enumerate(homes):
        inner = shape.buffer(-0.3) if shape.area > 20 else shape
        if inner.is_empty:
            inner = shape
        ring = max(shapely.get_parts(inner), key=lambda g: g.area).exterior
        n = min(60, max(4, int(ring.length / 3)))
        for x, y in shapely.get_coordinates(shapely.line_interpolate_point(ring, np.linspace(0, 1, n, endpoint=False), normalized=True)):
            key = (round(x, 1), round(y, 1))
            if key not in seen:
                seen.add(key)
                pts.append(key)
                owner.append(k)
    if len(pts) < 3:
        return [(homes[0][0], block)]
    cells = shapely.get_parts(shapely.voronoi_polygons(shapely.multipoints(pts), extend_to=block.envelope, ordered=True))
    if len(cells) != len(pts):
        return []
    joined = {}
    for cell, k in zip(cells, owner):
        joined.setdefault(k, []).append(cell)
    plots = {}
    for k, cs in joined.items():
        plot = _areas(shapely.make_valid(shapely.intersection(shapely.union_all(shapely.buffer(cs, 0.01, join_style="mitre")), block)))
        if not plot.is_empty:
            plots[k] = plot
    for k in sorted(plots, key=lambda k: plots[k].area):
        if plots[k].area >= MIN_PLOT or len(plots) < 2:
            continue
        near = [(plots[k].boundary.intersection(plots[o].buffer(0.1)).length, o) for o in plots if o != k]
        length, o = max(near)
        if length > 0:
            plots[o] = _areas(shapely.make_valid(plots[o].union(plots[k].buffer(0.02, join_style="mitre"))))
            del plots[k]
    return [(homes[k][0], plot) for k, plot in plots.items()]


def _nearest(lines, surface):
    """The part of the surface nearer to a line marked True than to any marked False:
    Voronoi cells round points every 2 m along the lines."""
    pts, marks, seen = [], [], set()
    for ls, mark in lines:
        n = max(2, int(ls.length / 2) + 1)
        for x, y in shapely.get_coordinates(shapely.line_interpolate_point(ls, np.linspace(0, 1, n), normalized=True)):
            key = (round(x, 1), round(y, 1))
            if key not in seen:
                seen.add(key)
                pts.append(key)
                marks.append(mark)
    marks = np.array(marks, dtype=bool)
    if marks.all() or len(pts) < 3:
        return surface if marks.all() else Polygon()
    cells = shapely.get_parts(shapely.voronoi_polygons(shapely.multipoints(pts), extend_to=surface.envelope, ordered=True))
    try:
        union = shapely.coverage_union_all(cells[marks])
    except shapely.errors.GEOSException:
        # The fast union assumes cells that meet exactly; now and then they don't, and
        # a plain overlay trips over the same near-coincident edges. Grown by a
        # centimetre, the cells overlap and join cleanly.
        union = shapely.union_all(shapely.buffer(cells[marks], 0.01, join_style="mitre"))
    return _areas(shapely.make_valid(union))


def _areas(g):
    """Only the polygons of a geometry. Making it valid or snapping it to a grid can
    leave lines where a sliver collapsed, and an overlay of polygons with lines fails
    ("mixed-dimension")."""
    parts = shapely.get_parts(g)
    keep = parts[np.isin(shapely.get_type_id(parts), (3, 6))]  # Polygon, MultiPolygon
    return shapely.union_all(keep) if len(keep) else Polygon()


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


def _metres(v):
    """A height tag ("1.8", "1,8 m") in metres, or None."""
    try:
        return float(str(v).replace(",", ".").replace("m", "").strip()) if v is not None else None
    except ValueError:
        return None


def _rings(poly: Polygon, tolerance=0.15):
    poly = poly.simplify(tolerance)
    outer = [[round(x, 2), round(y, 2)] for x, y in list(poly.exterior.coords)[:-1]]
    holes = [[[round(x, 2), round(y, 2)] for x, y in list(i.coords)[:-1]] for i in poly.interiors]
    return [outer, *holes]
