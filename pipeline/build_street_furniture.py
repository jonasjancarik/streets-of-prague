"""The furniture OpenStreetMap maps along Prague's streets, for the street models.

    uv run build_street_furniture.py praha    # → public/data/praha_now/street-furniture.json

Litter bins (`amenity=waste_basket`), bike stands (`amenity=bicycle_parking`, stands or
unspecified; one inverted U for every two bikes of `capacity`, in a row along the
street), parking machines (`vending=parking_tickets`), bollards (`barrier=bollard`, a
point, or every 1.6 m along a mapped row), post boxes (`amenity=post_box`) and the
recycling containers of a collection point (`amenity=recycling` with
`recycling_type=container`: one container in its colour for each kind it takes, in a
row along the street), benches, street cabinets (`man_made=street_cabinet`), advertising
columns, poster cases (`advertising=poster_box|totem|board`), drinking fountains,
Stolpersteine (`memorial=stolperstein`, brass cobbles in the
pavement) and memorial plaques (`memorial=plaque`: a ray from the nearest street to the
point, as build_shops.py has, for the game to find the wall). Each item turns with the street it stands by, the nearest
mapped way within 30 m: its local x runs along that street and its local +z faces it.

street-furniture.json: {"kinds": [name, ...], "points": [[x, y, kind, angle], ...],
"plaques": [[sx, sy, px, py], ...]} in
the area's local metres (+x east, +y north); the angle is the street's, in whole
degrees anticlockwise from east. The game's kinds are by name (MAPPED in
src/map/furniture.ts), so this file's order can't drift out of step with them. Without the osmium
command-line tool it reads the extract with pyosmium
(`uv run --with osmium build_street_furniture.py praha`).
"""

import json
import math
import sys
from collections import Counter

from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import Point
from shapely.ops import nearest_points, transform

from build_shops import features
from build_tiles import PBF, cut
from osm_area import AREAS, OUT

KINDS = ["bin", "bike stand", "parking machine", "bollard", "post box",
         "glass", "clear glass", "paper", "plastic", "cartons", "metal", "stolperstein",
         "bench", "cabinet", "advertising column", "poster case", "drinking fountain"]
# Prague's colours: green bells for coloured glass, white for clear, blue paper, yellow
# plastic, orange cartons, grey metal (the city's sorting guide).
RECYCLING = [("recycling:glass_bottles", "glass"), ("recycling:glass", "glass"), ("recycling:white_glass", "clear glass"),
             ("recycling:paper", "paper"), ("recycling:plastic", "plastic"), ("recycling:plastic_bottles", "plastic"),
             ("recycling:plastic_packaging", "plastic"), ("recycling:beverage_cartons", "cartons"),
             ("recycling:cans", "metal"), ("recycling:scrap_metal", "metal")]
CONTAINER_GAP = 1.6  # m between the middles of neighbouring containers
STAND_GAP = 0.9
BOLLARD_GAP = 1.6


def furniture(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    pbf = PBF.parent / f"{area}.osm.pbf"
    if not pbf.exists():
        if not PBF.exists():
            sys.exit(f"needs the OSM extract {PBF} (see 'Building the map' in docs/handbook.md)")
        pbf = cut((w - 0.01, s - 0.01, e + 0.01, n + 0.01), pbf)

    lines = [transform(tf.transform, g) for tags, g in features(pbf, ["highway"])
             if g.geom_type == "LineString" and tags.get("highway") not in ("construction", "proposed", "platform")]
    tree = STRtree(lines)

    def angle_at(p):
        """The way the nearest street runs by p, turned so that the item's local +z (the
        right of that way: (sin a, -cos a)) points at the street."""
        i = tree.query_nearest(p, max_distance=30)
        if not len(i):
            return 0.0
        line = lines[i[0]]
        d = line.project(p)
        a, b, foot = line.interpolate(max(0, d - 1)), line.interpolate(min(line.length, d + 1)), line.interpolate(d)
        angle = math.atan2(b.y - a.y, b.x - a.x)
        if (foot.x - p.x) * math.sin(angle) - (foot.y - p.y) * math.cos(angle) < 0:
            angle += math.pi
        return angle

    points, counts = [], Counter()

    def add(x, y, kind, angle):
        points.append([round(x, 1), round(y, 1), KINDS.index(kind), round(math.degrees(angle)) % 360])
        counts[kind] += 1

    def row(p, kind, count, gap, angle):
        dx, dy = math.cos(angle), math.sin(angle)
        for k in range(count):
            off = (k - (count - 1) / 2) * gap
            add(p.x + dx * off, p.y + dy * off, kind, angle)

    plaques = []
    for tags, g in features(pbf, ["amenity", "barrier", "vending", "memorial", "man_made", "advertising"]):
        amenity, barrier, memorial = tags.get("amenity"), tags.get("barrier"), tags.get("memorial")
        geo = transform(tf.transform, g)
        if barrier == "bollard" and geo.geom_type == "LineString":
            steps = max(1, int(geo.length // BOLLARD_GAP))
            for k in range(steps + 1):
                q = geo.interpolate(k * geo.length / steps)
                if w <= tf.transform(q.x, q.y, direction="INVERSE")[0] <= e:
                    add(q.x, q.y, "bollard", angle_at(q))
            continue
        if g.geom_type != "Point":
            if amenity not in ("bicycle_parking", "recycling") and tags.get("man_made") != "street_cabinet":
                continue
            g = g.representative_point() if g.is_closed else g.interpolate(.5, normalized=True)
            geo = transform(tf.transform, g)
        if not (w <= g.x <= e and s <= g.y <= n):
            continue
        p = geo
        if memorial == "stolperstein":
            add(p.x, p.y, "stolperstein", angle_at(p))
        elif memorial == "plaque":
            i = tree.query_nearest(p, max_distance=30)
            if len(i):
                foot = nearest_points(lines[i[0]], p)[0]
                if foot.distance(p) > 1:
                    plaques.append([round(foot.x, 1), round(foot.y, 1), round(p.x, 1), round(p.y, 1)])
        elif barrier == "bollard":
            add(p.x, p.y, "bollard", angle_at(p))
        elif amenity == "bench":
            # (A bench faces its street or path: its seat is towards local -z, so turn it round.)
            add(p.x, p.y, "bench", angle_at(p) + math.pi)
        elif tags.get("man_made") == "street_cabinet":
            add(p.x, p.y, "cabinet", angle_at(p))
        elif tags.get("advertising") == "column":
            add(p.x, p.y, "advertising column", angle_at(p))
        elif tags.get("advertising") in ("poster_box", "totem", "board"):
            add(p.x, p.y, "poster case", angle_at(p))
        elif amenity == "drinking_water":
            add(p.x, p.y, "drinking fountain", angle_at(p))
        elif amenity == "waste_basket":
            add(p.x, p.y, "bin", angle_at(p))
        elif amenity == "post_box":
            add(p.x, p.y, "post box", angle_at(p))
        elif tags.get("vending") == "parking_tickets":
            add(p.x, p.y, "parking machine", angle_at(p))
        elif amenity == "bicycle_parking" and tags.get("bicycle_parking", "stands") in ("stands", "wall_loops", "rack") \
                and tags.get("access") != "private" and tags.get("covered") != "yes":
            try:
                capacity = int(tags.get("capacity", "4"))
            except ValueError:
                capacity = 4
            row(p, "bike stand", max(1, min(8, (capacity + 1) // 2)), STAND_GAP, angle_at(p))
        elif amenity == "recycling" and tags.get("recycling_type") == "container":
            kinds = []
            for key, kind in RECYCLING:
                if tags.get(key) == "yes" and kind not in kinds:
                    kinds.append(kind)
            if "glass" in kinds and "clear glass" not in kinds:
                kinds.insert(kinds.index("glass") + 1, "clear glass")
            angle = angle_at(p)
            dx, dy = math.cos(angle), math.sin(angle)
            for k, kind in enumerate(kinds):
                off = (k - (len(kinds) - 1) / 2) * CONTAINER_GAP
                add(p.x + dx * off, p.y + dy * off, kind, angle)
    points.sort()
    plaques.sort()
    print(f"{len(points)} items:", ", ".join(f"{k} {v}" for k, v in counts.most_common()), f"and {len(plaques)} plaques")
    return {"kinds": KINDS, "points": points, "plaques": plaques}


if __name__ == "__main__":
    area = sys.argv[1] if len(sys.argv) > 1 else "centrum"
    path = OUT / f"{area}_now" / "street-furniture.json"
    path.write_text(json.dumps(furniture(area), separators=(",", ":")), encoding="utf-8")
    print("wrote", path, path.stat().st_size, "bytes")
