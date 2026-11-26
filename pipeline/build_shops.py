"""Which ground-floor bays are shops, from OpenStreetMap, for the street façades.

    uv run build_shops.py praha      # → public/data/praha_now/shops.json

OSM puts a shop, café, restaurant or pub at a point, usually inside the building just
behind its window. The game casts a ray from the street to that point and turns the
ground-floor bay it crosses into a shopfront, with the trade's stock in the window and
its word on the fascia (src/mappedFrontages.ts, src/map/streetFacade.ts). OSM says
nothing about the window itself: which bay, how wide, the sign are the game's.

shops.json: {"trades": [name, ...], "shops": [[sx, sy, px, py, trade], ...]}, in the
area's local metres (+x east, +y north): the nearest point of the shop's street, the
shop's own point, and an index into "trades". Trades are by name so the game's table
(TRADES in src/mappedFrontages.ts) can't drift out of step with this file's order.
The street is the one in `addr:street` when it runs within 25 m, otherwise the nearest
street within 20 m. Shops tagged on another `level` (upstairs, in a basement) are left
out: their windows aren't the ground-floor bay. Kinds without a trade of their own are
"shop": a shopfront with no word on the fascia.

It reads the points of interest build_footfall.py filters out of the OSM extract (making
that file the same way if it isn't there), and the area's streets from its cut of the
extract. Without the osmium command-line tool it reads the files with pyosmium
(`uv run --with osmium build_shops.py praha`).
"""

import json
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString, Point, shape
from shapely.ops import nearest_points, transform

from build_tiles import PBF, cut
from osm_area import AREAS, OUT

# OSM's value (amenity first, then shop) → the game's trade. Commonest in the centre
# first; anything else with a shop tag is "shop".
TRADE = {
    "restaurant": "restaurant", "food_court": "restaurant",
    "cafe": "cafe",
    "bar": "bar", "pub": "pub", "biergarten": "pub",
    "fast_food": "fast_food",
    "ice_cream": "ice_cream",
    "pharmacy": "pharmacy", "chemist": "chemist",
    "bank": "bank", "bureau_de_change": "exchange",
    "clothes": "clothes", "boutique": "clothes", "fashion": "clothes", "shoes": "shoes",
    "convenience": "grocery", "supermarket": "grocery", "greengrocer": "grocery", "deli": "grocery", "butcher": "butcher",
    "gift": "gift", "souvenir": "gift",
    "hairdresser": "hairdresser", "beauty": "beauty", "cosmetics": "beauty",
    "jewelry": "jewelry",
    "bakery": "bakery", "pastry": "confectionery", "confectionery": "confectionery", "chocolate": "confectionery",
    "books": "books", "stationery": "stationery",
    "florist": "florist", "garden_centre": "florist",
    "alcohol": "wine", "wine": "wine", "beverages": "wine",
    "optician": "optician",
    "tobacco": "tobacco", "newsagent": "tobacco", "kiosk": "tobacco",
    "art": "art", "craft": "art", "antiques": "antiques", "ceramics": "art",
    "toys": "toys", "electronics": "electronics", "mobile_phone": "electronics",
    "sports": "sports", "travel_agency": "travel", "massage": "massage", "tattoo": "tattoo",
}
AMENITIES = {"restaurant", "food_court", "cafe", "bar", "pub", "biergarten", "fast_food", "ice_cream",
             "pharmacy", "bank", "bureau_de_change"}
NOT_SHOPS = {"vacant", "no", "yes;vacant"}
STREETS = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "residential",
           "unclassified", "living_street", "pedestrian", "service", "trunk", "trunk_link"}
POI_KEYS = ["shop", "amenity", "tourism", "historic", "leisure"]  # (as build_footfall.py keeps them)


def _osmium_cli(pbf, keys):
    """(tags, geometry in WGS84) of everything in the file with one of these keys."""
    with tempfile.TemporaryDirectory() as tmp:
        tagged = Path(tmp) / "tagged.osm.pbf"
        subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(tagged), str(pbf), *[f"nwr/{k}" for k in keys]], check=True)
        out = subprocess.run(["osmium", "export", "-f", "geojsonseq", "-x", "print_record_separator=false", str(tagged)],
                             check=True, capture_output=True, text=True, encoding="utf-8").stdout
    for line in out.splitlines():
        f = json.loads(line)
        if f["geometry"]:
            yield f["properties"], shape(f["geometry"])


def _pyosmium(pbf, keys):
    import osmium  # only on machines without the command-line tool
    for o in osmium.FileProcessor(str(pbf)).with_locations():
        if not any(k in o.tags for k in keys):
            continue
        tags = dict(o.tags)
        if o.is_node():
            yield tags, Point(o.location.lon, o.location.lat)
        elif o.is_way():
            try:
                pts = [(n.lon, n.lat) for n in o.nodes]
            except osmium.InvalidLocationError:
                continue
            if len(pts) >= 2:
                yield tags, LineString(pts)


def features(pbf, keys):
    return (_osmium_cli if shutil.which("osmium") else _pyosmium)(pbf, keys)


def ground_floor(tags):
    level = tags.get("level", "0").split(";")[0].strip()
    try:
        return float(level) == 0
    except ValueError:
        return True


def shops(area):
    w, s, e, n = AREAS[area]
    # The area's local metres, as the game and the other small data files have them.
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    pois = PBF.parent / f"{area}_poi.osm.pbf"
    streets_pbf = PBF.parent / f"{area}.osm.pbf"
    if not pois.exists() or not streets_pbf.exists():
        if not PBF.exists():
            sys.exit(f"needs the OSM extract {PBF} (see 'Building the map' in docs/handbook.md)")
        streets_pbf = cut((w - 0.01, s - 0.01, e + 0.01, n + 0.01), streets_pbf)
        subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(pois), str(streets_pbf), *[f"nwr/{k}" for k in POI_KEYS]], check=True)

    lines, names = [], []
    for tags, g in features(streets_pbf, ["highway"]):
        if tags.get("highway") in STREETS and g.geom_type == "LineString" and (tags.get("highway") != "service" or "name" in tags):
            lines.append(transform(tf.transform, g))
            names.append(tags.get("name"))
    tree = STRtree(lines)

    trades, found, kinds, skipped = [], [], Counter(), Counter()
    for tags, g in features(pois, ["shop", "amenity"]):
        amenity, shop = tags.get("amenity"), tags.get("shop")
        if amenity not in AMENITIES and (not shop or shop in NOT_SHOPS):
            continue
        if not ground_floor(tags):
            skipped["another level"] += 1
            continue
        c = g if g.geom_type == "Point" else g.representative_point() if g.is_closed else g.interpolate(.5, normalized=True)
        if not (w <= c.x <= e and s <= c.y <= n):
            continue
        p = transform(tf.transform, c)
        street = None
        wanted = tags.get("addr:street")
        if wanted:
            near = [i for i in tree.query(p.buffer(25)) if names[i] == wanted]
            if near:
                street = min((lines[i] for i in near), key=p.distance)
        if street is None:
            i = tree.query_nearest(p, max_distance=20)
            street = lines[i[0]] if len(i) else None
        if street is None:
            skipped["no street within 20 m"] += 1
            continue
        foot = nearest_points(street, p)[0]
        if foot.distance(p) < 2:
            skipped["on the street itself"] += 1
            continue
        trade = TRADE.get(amenity if amenity in AMENITIES else shop, "shop")
        if trade not in trades:
            trades.append(trade)
        found.append([round(foot.x, 1), round(foot.y, 1), round(p.x, 1), round(p.y, 1), trades.index(trade)])
        kinds[trade] += 1
    found.sort()
    print(f"{len(found)} shops:", ", ".join(f"{k} {v}" for k, v in kinds.most_common()))
    print("left out:", ", ".join(f"{k} {v}" for k, v in skipped.most_common()) or "none")
    return {"trades": trades, "shops": found}


if __name__ == "__main__":
    area = sys.argv[1] if len(sys.argv) > 1 else "centrum"
    path = OUT / f"{area}_now" / "shops.json"
    path.write_text(json.dumps(shops(area), separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print("wrote", path, path.stat().st_size, "bytes")
