"""How busy the streets are, all over an area: a map of footfall the game uses to put
more people where more people are (the Old Town, Wenceslas Square, round the metro)
and fewer in the suburbs.

    uv run build_footfall.py centrum     # → public/data/centrum_now/footfall.png

There's no open data on where people walk, so it's pieced together from what draws
them, each spread over its surroundings as a soft blob:

- shops, cafés, restaurants, bars, museums, sights, theatres, schools and the rest
  of OSM's points of interest, by kind, and OSM's pedestrian streets and squares;
- public transport stops, by how many buses, trams, trains and metro trains leave
  them on a weekday (PID's timetables, see pid_timetable.py), the metro counting most;
- a short hand-made list of the places tourists crowd (HOTSPOTS), which the rest
  can't tell apart from an ordinary busy street.

The map is a greyscale PNG over the area's box in local metres (CELL m per pixel,
row 0 in the north): 0 is nobody about, 255 as busy as the Old Town Square or more.
The grey is the square root of that share, for more steps among the quiet streets.
Its box and cell size go in footfall.json next to it. An area without the Old Town
(ujezd) measures against the last area built that has it.
"""

import csv
import io
import json
import math
import subprocess
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.ops import transform

from build_tiles import PBF, cut
from osm_area import AREAS, OUT

CELL = 25.0
CACHE = Path(__file__).parent / ".cache"

# Points of interest by OSM tag, in "shops": how many people one draws compared with
# an ordinary shop. Anything not listed counts for nothing.
WEIGHTS = {
    "shop": {"*": 1, "mall": 30, "department_store": 8, "supermarket": 3, "convenience": 1, "kiosk": 0.5,
             "vacant": 0, "car": 0.3, "car_repair": 0.2, "tyres": 0.2, "funeral_directors": 0.2},
    "amenity": {"restaurant": 1.5, "cafe": 1.5, "fast_food": 1.5, "bar": 1.5, "pub": 1.5, "ice_cream": 1,
                "biergarten": 3, "nightclub": 2, "marketplace": 6, "theatre": 4, "cinema": 4, "arts_centre": 2,
                "concert_hall": 4, "library": 1, "university": 6, "college": 3, "school": 2, "hospital": 4,
                "clinic": 1, "doctors": 0.5, "pharmacy": 0.7, "bank": 0.5, "post_office": 1, "townhall": 2,
                "place_of_worship": 1, "exhibition_centre": 5, "events_venue": 2, "fountain": 1, "casino": 1,
                "food_court": 3, "community_centre": 1, "courthouse": 1},
    "tourism": {"attraction": 8, "museum": 6, "gallery": 2, "viewpoint": 3, "zoo": 25, "theme_park": 10,
                "aquarium": 5, "artwork": 0.5, "hotel": 1.5, "hostel": 1.5, "guest_house": 0.5, "information": 0.2},
    "historic": {"monument": 3, "castle": 10, "city_gate": 3, "ruins": 1, "memorial": 0.3, "church": 1},
    "leisure": {"water_park": 5, "stadium": 4, "sports_centre": 1, "fitness_centre": 1, "amusement_arcade": 1},
}
PEDESTRIAN = 1.5  # per 20 m of pedestrian street, or 20 x 20 m of pedestrian square
POI_SIGMA = 45.0  # metres a point of interest's blob spreads (one standard deviation)

# Public transport: how many people one departure brings onto the street, in
# shops (GTFS route_type → weight), and how far round the stop they spread.
TRANSIT = {"0": (0.04, 70.0), "1": (0.10, 120.0), "2": (0.08, 90.0), "3": (0.015, 60.0),
           "7": (0.03, 60.0), "11": (0.015, 60.0)}

# The places tourists crowd: weight (shops), spread (m), and a point or a line
# (lon, lat, ...) the weight is spread along.
HOTSPOTS = [
    (350, 70, [(14.4211, 50.0874)]),                       # Staroměstské náměstí
    (120, 30, [(14.4206, 50.0869)]),                       # the Astronomical Clock
    (700, 40, [(14.4077, 50.0867), (14.4136, 50.0863)]),   # Karlův most
    # The Royal Route, from the Powder Tower to the Castle
    (80, 40, [(14.4276, 50.0870)]),                        # Prašná brána
    (200, 35, [(14.4273, 50.0870), (14.4228, 50.0873)]),   # Celetná
    (250, 40, [(14.4140, 50.0862), (14.4166, 50.0863), (14.4180, 50.0866), (14.4193, 50.0866)]),  # Karlova
    (120, 30, [(14.4063, 50.0866), (14.4043, 50.0877)]),   # Mostecká
    (60, 30, [(14.3955, 50.0882), (14.3975, 50.0893)]),    # Ke Hradu
    (80, 40, [(14.4193, 50.0866)]),                        # Malé náměstí
    (450, 50, [(14.4238, 50.0842), (14.4292, 50.0800)]),   # Václavské náměstí
    (150, 40, [(14.4238, 50.0845), (14.4275, 50.0869)]),   # Na Příkopě
    (100, 60, [(14.4278, 50.0874)]),                       # Náměstí Republiky
    (80, 40, [(14.4205, 50.0852)]),                        # Havelská tržnice
    (250, 70, [(14.4003, 50.0906)]),                       # Pražský hrad, St Vitus
    (120, 60, [(14.3975, 50.0895)]),                       # Hradčanské náměstí
    (80, 40, [(14.4036, 50.0922)]),                        # Zlatá ulička
    (120, 35, [(14.3955, 50.0880), (14.4027, 50.0883)]),   # Nerudova
    (120, 60, [(14.4035, 50.0880)]),                       # Malostranské náměstí
    (60, 40, [(14.4067, 50.0862)]),                        # Lennon Wall
    (60, 60, [(14.4077, 50.0846)]),                        # Kampa
    (60, 40, [(14.4187, 50.0880), (14.4176, 50.0916)]),    # Pařížská
    (40, 40, [(14.4141, 50.0755)]),                        # Tančící dům
    (80, 40, [(14.4143, 50.0740), (14.4155, 50.0680)]),    # Náplavka
    (50, 80, [(14.4186, 50.0645)]),                        # Vyšehrad
    (40, 60, [(14.3950, 50.0834)]),                        # Petřín lookout tower
    (200, 70, [(14.4038, 50.0707)]),                       # Anděl
]
REFERENCE = 0  # the hotspot whose peak counts as "as busy as it gets"


def local(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    return tf, (*tf.transform(w, s), *tf.transform(e, n))


def pois(area, tf):
    """(x, y, weight) for OSM's points of interest and pedestrian streets and squares."""
    w, s, e, n = AREAS[area]
    pad = 0.01
    src = cut((w - pad, s - pad, e + pad, n + pad), PBF.parent / f"{area}.osm.pbf") if PBF.exists() else None
    if not src:
        sys.exit(f"needs the OSM extract {PBF} (see 'Building the map' in docs/handbook.md)")
    tagged = PBF.parent / f"{area}_poi.osm.pbf"
    expr = [f"nwr/{k}" for k in WEIGHTS] + ["w/highway=pedestrian", "w/area:highway=pedestrian", "w/place=square"]
    subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(tagged), str(src), *expr], check=True)
    out = subprocess.run(["osmium", "export", "-f", "geojsonseq", "-x", "print_record_separator=false",
                          str(tagged)], check=True, capture_output=True, text=True).stdout
    pts, kinds = [], Counter()
    for line in out.splitlines():
        f = json.loads(line)
        tags, g = f["properties"], f["geometry"]
        if not g:
            continue
        geom = transform(tf.transform, shape(g))
        if tags.get("highway") == "pedestrian" or tags.get("area:highway") == "pedestrian" or tags.get("place") == "square":
            if geom.geom_type in ("LineString", "MultiLineString"):
                for d in np.arange(10, geom.length, 20):
                    p = geom.interpolate(d)
                    pts.append((p.x, p.y, PEDESTRIAN))
            elif geom.geom_type in ("Polygon", "MultiPolygon"):
                x0, y0, x1, y1 = geom.bounds
                pts += [(gx, gy, PEDESTRIAN) for gx in np.arange(x0 + 10, x1, 20) for gy in np.arange(y0 + 10, y1, 20)
                        if geom.contains(Point(gx, gy))]
            kinds["pedestrian"] += 1
            continue
        weight = 0
        for key, table in WEIGHTS.items():
            v = tags.get(key)
            if v:
                weight = max(weight, table.get(v, table.get("*", 0)))
                if weight:
                    kinds[f"{key}={v}" if v in table else key] += 1
        if weight:
            c = geom.representative_point() if geom.geom_type != "Point" else geom
            pts.append((c.x, c.y, weight))
    print(f"{len(pts)} points of interest:", ", ".join(f"{k} {n}" for k, n in kinds.most_common(12)), "…")
    return pts


def transit(tf):
    """(x, y, weight, spread) for every stop, by its departures on a typical weekday."""
    try:
        from pid_timetable import feed, rows, services_on, typical_dates
        path = feed()
    except Exception as e:  # noqa: BLE001 - offline: fine without
        print(f"no timetables ({e}); leaving public transport out")
        return []
    cache = CACHE / "pid" / "departures.json"
    if cache.exists() and cache.stat().st_mtime > path.stat().st_mtime:
        stops = json.loads(cache.read_text())
    else:
        print("counting departures at every stop…")
        with zipfile.ZipFile(path) as z:
            dates = typical_dates(z)
            on = services_on(z, {"weekday": dates["weekday"]})
            kind = {r["route_id"]: r["route_type"] for r in rows(z, "routes.txt")}
            trips = {r["trip_id"]: kind[r["route_id"]] for r in rows(z, "trips.txt") if on.get(r["service_id"])}
            where = {r["stop_id"]: (float(r["stop_lon"]), float(r["stop_lat"])) for r in rows(z, "stops.txt")}
            count = defaultdict(Counter)
            with z.open("stop_times.txt") as f:
                for r in csv.reader(io.TextIOWrapper(f, encoding="utf-8-sig")):
                    t = trips.get(r[0])
                    if t:
                        count[r[3]][t] += 1
        stops = [[*where[s], dict(c)] for s, c in count.items() if s in where]
        cache.write_text(json.dumps(stops))
    out = []
    for lon, lat, deps in stops:
        x, y = tf.transform(lon, lat)
        for t, n in deps.items():
            weight, spread = TRANSIT.get(t, (0.015, 60.0))
            out.append((x, y, n * weight, spread))
    print(f"{len(stops)} stops, {sum(sum(d.values()) for *_, d in stops)} departures on a weekday")
    return out


def blur(grid, sigma):
    """A gaussian blur of `sigma` metres, one axis at a time."""
    s = sigma / CELL
    r = max(1, int(math.ceil(3 * s)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / s) ** 2)
    k /= k.sum()
    grid = np.apply_along_axis(lambda row: np.convolve(row, k, mode="same"), 1, grid)
    return np.apply_along_axis(lambda col: np.convolve(col, k, mode="same"), 0, grid)


def grid(area):
    """How busy each cell of the area is, before scaling: (tf, box, cells)."""
    tf, (x0, y0, x1, y1) = local(area)
    w, h = int(math.ceil((x1 - x0) / CELL)), int(math.ceil((y1 - y0) / CELL))
    print(f"{area}: {w} x {h} cells of {CELL:.0f} m")

    # Each source into the layer of its spread; every layer blurred, then added up.
    layers = defaultdict(lambda: np.zeros((h, w)))

    def put(x, y, weight, sigma):
        i, j = int((x - x0) / CELL), int((y1 - y) / CELL)
        if 0 <= i < w and 0 <= j < h:
            layers[sigma][j, i] += weight

    for x, y, weight in pois(area, tf):
        put(x, y, weight, POI_SIGMA)
    for x, y, weight, sigma in transit(tf):
        put(x, y, weight, sigma)
    for weight, sigma, where in HOTSPOTS:
        line = LineString([tf.transform(*p) for p in where]) if len(where) > 1 else None
        steps = np.arange(5, line.length, 10) if line else [0]
        for d in steps:
            p = line.interpolate(d) if line else Point(tf.transform(*where[0]))
            put(p.x, p.y, weight / len(steps), sigma)
    # Blurring spreads each point's weight; per square metre, so a blob's peak
    # doesn't depend on how wide it is drawn.
    total = sum(blur(g, sigma) for sigma, g in layers.items()) / (CELL * CELL)
    return tf, (x0, y0, x1, y1), total


def peak(tf, box, total):
    """The peak round the reference hotspot, with everything else near it added, or None
    if the area doesn't reach it. It doesn't depend on the area's box."""
    x0, _, _, y1 = box
    rx, ry = tf.transform(*HOTSPOTS[REFERENCE][2][0])
    ri, rj = int((rx - x0) / CELL), int((y1 - ry) / CELL)
    if 0 <= ri < total.shape[1] and 0 <= rj < total.shape[0]:
        return float(total[max(0, rj - 4):rj + 5, max(0, ri - 4):ri + 5].max())
    return None


def main(area="centrum"):
    tf, (x0, y0, x1, y1), total = grid(area)
    h, w = total.shape

    # The reference, as busy as it gets: the Old Town Square. An area without it takes
    # the last one measured, or measures it on centrum's grid.
    kept = CACHE / "footfall_reference.json"
    ref = peak(tf, (x0, y0, x1, y1), total)
    if ref is None and kept.exists():
        ref = json.loads(kept.read_text())["ref"]
    if ref is None:
        print("measuring the Old Town Square on centrum's grid, for reference")
        ref = peak(*grid("centrum"))
    kept.write_text(json.dumps({"ref": ref}))
    share = np.clip(total / ref, 0, 1)

    out_dir = OUT / f"{area}_now"
    grey = np.round(np.sqrt(share) * 255).astype(np.uint8)
    Image.fromarray(grey, "L").save(out_dir / "footfall.png", optimize=True)
    (out_dir / "footfall.json").write_text(json.dumps({"box": [round(v, 2) for v in (x0, y0, x1, y1)], "cell": CELL,
                                                       "size": [w, h]}))
    size = (out_dir / "footfall.png").stat().st_size
    print(f"→ {out_dir.name}/footfall.png ({size / 1e3:.0f} kB); share of cells busier than "
          + ", ".join(f"{t}: {(share > t).mean() * 100:.1f} %" for t in (0.02, 0.1, 0.3, 0.6)))


if __name__ == "__main__":
    main(*sys.argv[1:])
