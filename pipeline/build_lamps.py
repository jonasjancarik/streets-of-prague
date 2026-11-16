"""Street lamps for the night, from IPR Praha's archived utility map (the surface marks
of the technical map, DTMP_CUR_TMISZNAK_B): about 121,000 lamps on poles, a few
thousand on walls and in underpasses, the festive floodlights of monuments and the
Old Town's gas lamps. The survey has holes, so the lamps of the works' documentation
(URL_BUILT below) that it lacks are added, and then those only OSM has (outside the
city's border above all).

    uv run build_lamps.py praha      # → public/data/praha_now/lamps.bin.gz, lit.bin.gz

The download is cached in .cache/lamps/lamps.json (the whole city, WGS84); every
area takes the lamps in its box from there. The file is gzipped binary, little
endian: n (uint32), then n × (x, y) as float32 in the area's local metres (+x east,
+y north), then n kinds as uint8 (KINDS below, in that order; and 7 for a lamp that
hangs over a street on cables). Two consecutive entries of kind 9 share a cable.
Build the area's tiles first: the roadways are read from them.

lit.bin.gz says which streets are lit and which dark, for the game to decide where the
survey's gaps get a lamp of the game's own (src/lamps.ts, fill): by OSM's `lit` tag
where a way has one, otherwise by the lamps and buildings along it and the lit streets
round it (street_lighting.py). n stretches (uint32), then for each a flag (uint8: 0
tagged dark, 1 tagged lit, 2 lit by a lamp nearby, 3 by the buildings along it, 4 as the
way from a lit stretch to the next; a street not in the file is dark), its number of
points (uint16), the first point as (x, y)
int32 and every further one as its step from the one before (int16 each way), all in
quarters of a metre of the same local grid. Both come from the area's OSM cut (.cache/osm/<area>.osm.pbf,
made by build_tiles.py); without it only the survey's lamps are written.
"""

import gzip
import json
import math
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests
from shapely import points
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

import build_cache
import ipr_open
import street_lighting
from osm_area import AREAS, OUT

URL = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/DTMP_CUR_TMISZNAK_B/FeatureServer/0/query"
CACHE = Path(__file__).parent / ".cache" / "lamps" / "lamps.json"
# The same marks from the documentation of finished building works that the lamps'
# keeper (THMP) and others hand in (DTMP_CUR_TMISZNAK_ADS_B, same codes, CC BY like the
# rest): 102,000 lamps, 34,000 of them not in the survey above, which has whole
# neighbourhoods missing (parts of Spořilov, Roztyly, Lhotka, Pankrác, Košíře…). With them,
# the built-up streets inside the city with no lamp within 45 m go from 417 km to 162 km.
URL_BUILT = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/DTMP_CUR_TMISZNAK_ADS_B/FeatureServer/0/query"
CACHE_BUILT = CACHE.with_name("lamps_built.json")

# ctmtp_kod → the game's kind of lamp (src/lamps.ts draws and lights them by kind).
KINDS = {
    606560: 0,  # silnoproud - svítidlo na stožáru: a street lamp on a pole
    606561: 1,  # svítidlo na objektu: on a wall
    306560: 2,  # plynovod - plynová lampa VO: a gas lamp
    306561: 2,  # plynová lampa VO na objektu: a gas lamp on a wall
    606570: 3,  # svítidlo slav. osvět. na stožáru: festive lighting on a pole
    606571: 4,  # svítidlo slav. osvět. na objektu: a floodlight on a building
    606580: 4,  # svítidlo slav. osvět. na soklu: a floodlight on a plinth
    606562: 5,  # svítidlo na stropě tunelu (podchodu…): in a tunnel or underpass
    606563: 6,  # svítidlo v úrovni komunikace, tunelu…: set into the ground
}
# OSM: where the area's cut is (build_tiles.py makes it), how its lamps' mounts map to
# the kinds above, which values of `lit` mean lit (1) and dark (0), and the ways the game
# may put lamps of its own on (the streets cars drive and the footpaths, which is what
# src/lamps.ts fills).
OSM = Path(__file__).parent / ".cache" / "osm"
MOUNTS = {"wall": 1, "ceiling": 5, "ground": 6}
HUNG_MOUNTS = ("suspended", "cable", "wire", "catenary")
# Limit inference to local streets, where a tight row is less likely to be on a median.
CABLE_ROADS = {"residential", "living_street", "unclassified"}
PAIRED_CABLE = 9
PAIR_REACH = 4.0  # metres from the centre line for Zborovská's surveyed fixtures
PAIR_OFFSET = 3.2  # metres each side of the centre line on Zborovská
PAIR_JUNCTION_CLEARANCE = 7.0  # the façades end before the junction
LIT = {"yes": 1, "24/7": 1, "automatic": 1, "limited": 1, "sunset-sunrise": 1, "interval": 1, "no": 0, "disused": 0}
LIT_WAYS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
            "tertiary", "tertiary_link", "residential", "unclassified", "living_street", "service", "pedestrian", "busway",
            *street_lighting.PATHS}
NEAR = 8.0  # m: an OSM lamp this close to one of the survey's is the same lamp
ROADWAYS = ("road", "sett")  # the tiles' kinds of road surface that cars drive on
MIN_ROADWAY = 3.0  # m: the narrowest a driven street is taken to be
TRAM_LANE = 3.5  # m: the width a tram takes along its track (a post between two tracks, about 2.3 m from each, is left)
NEAR_BUILT = 12.0  # m: the same for the works' lamps (a lamp put up again a few steps away in a rebuilt street)
STEP, STRAIGHTEN, EDGE = 0.25, 1.0, 300.0  # m: lit.bin.gz's unit, how far a way may be straightened, how far past the area's box ways are kept


def download(url=URL, cache=CACHE):
    if cache.exists():
        return json.loads(cache.read_text())
    cache.parent.mkdir(parents=True, exist_ok=True)
    where = f"ctmtp_kod IN ({','.join(map(str, KINDS))})"
    out, offset = [], 0
    while True:
        params = {"where": where, "outFields": "ctmtp_kod", "outSR": 4326, "f": "json", "orderByFields": "objectid",
                  "resultOffset": offset, "resultRecordCount": 2000}
        for attempt in range(5):
            try:
                r = requests.get(url, params=params, timeout=60)
                r.raise_for_status()
                page = r.json()
                feats = ipr_open.page_features(page, url, offset)
                break
            except (requests.RequestException, ValueError):
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        out += [[round(f["geometry"]["x"], 7), round(f["geometry"]["y"], 7), f["attributes"]["ctmtp_kod"]]
                for f in feats if f.get("geometry")]
        offset += len(feats)
        print(f"\r{offset} lamps", end="", flush=True)
        if not feats or not page.get("exceededTransferLimit"):
            break
    print()
    build_cache.atomic(cache, json.dumps(out).encode())
    return out


def osm_lighting(area):
    """What the area's OSM cut says about lighting: its street lamps as (lon, lat, kind),
    its streets as (1 lit / 0 dark / None untagged, highway class, [(lon, lat), …]; none
    of those in tunnels), its buildings' outlines and candidate cable-lit street
    lines as (name, highway class, [(lon, lat), …]). None without the cut."""
    pbf = OSM / f"{area}.osm.pbf"
    if not pbf.exists():
        return None
    lamps, ways, buildings, cable_streets = [], [], [], []
    with tempfile.TemporaryDirectory() as tmp:
        picked, out = Path(tmp) / "lit.osm.pbf", Path(tmp) / "lit.geojsonseq"
        subprocess.run(["osmium", "tags-filter", str(pbf), "n/highway=street_lamp", f"w/highway={','.join(sorted(LIT_WAYS))}", "nwr/building",
                        "-o", str(picked)], check=True)
        subprocess.run(["osmium", "export", str(picked), "-f", "geojsonseq", "-o", str(out)], check=True)
        # (One feature a line, each after a record separator, which splitlines would split at too.)
        with out.open() as lines:
            for line in lines:
                if not line.strip("\x1e \n"):
                    continue
                f = json.loads(line.lstrip("\x1e"))
                tags, geom = f["properties"], f["geometry"]
                if geom["type"] == "Point":
                    mount = tags.get("lamp_mount") or tags.get("support") or ""
                    # (One hung on cables is left to the game, which knows the walls to hang it from.)
                    if tags.get("highway") == "street_lamp" and not any(m in mount for m in HUNG_MOUNTS):
                        lamps.append((*geom["coordinates"], next((k for m, k in MOUNTS.items() if m in mount), 0)))
                elif geom["type"] == "LineString" and tags.get("highway") in LIT_WAYS:
                    lit = LIT.get(tags.get("lit"))
                    if lit is not None or tags.get("tunnel", "no") == "no":
                        ways.append((lit, tags["highway"], geom["coordinates"]))
                    name = tags.get("name")
                    if tags.get("tunnel", "no") == "no" and tags.get("bridge", "no") == "no":
                        cable_streets.append((name, tags["highway"], geom["coordinates"]))
                elif tags.get("building") and geom["type"] in ("Polygon", "MultiPolygon"):
                    buildings += [geom["coordinates"][0]] if geom["type"] == "Polygon" else [p[0] for p in geom["coordinates"]]
    return lamps, ways, buildings, cable_streets


def suspend_paired_lamps(xy, kinds, streets):
    """Replace each surveyed station on a documented cable with two lamp heads."""
    if not streets:
        return
    tree = STRtree(streets)
    pairs = {}
    for i, kind in enumerate(kinds):
        if kind != 0:
            continue
        point = Point(xy[i])
        nearby = tree.query(point, predicate="dwithin", distance=PAIR_REACH)
        if not len(nearby):
            continue
        street = streets[min(nearby, key=lambda j: point.distance(streets[j]))]
        along = street.project(point)
        centre = street.interpolate(along)
        if not PAIR_JUNCTION_CLEARANCE < along < street.length - PAIR_JUNCTION_CLEARANCE:
            continue
        a, b = street.interpolate(max(0, along - 1)), street.interpolate(along + 1)
        dx, dy = b.x - a.x, b.y - a.y
        scale = PAIR_OFFSET / math.hypot(dx, dy)
        xy[i] = (centre.x - dy * scale, centre.y + dx * scale)
        pairs[i] = (centre.x + dy * scale, centre.y - dx * scale)
        kinds[i] = PAIRED_CABLE
    for i, position in reversed(list(pairs.items())):
        xy.insert(i + 1, position)
        kinds.insert(i + 1, PAIRED_CABLE)


def road_geometry(area):
    """The roadways cars drive on, from the area's tiles, as polygons in local metres:
    the asphalt and setts within each driven street's width of its centre line, or
    along a tram track (Lidická by Anděl is trams and buses only, its lamps hung over
    the tracks; a cobbled square is no roadway beyond the street across it, and a
    bridge's deck has its lamps on it). Also returns the full paved road surfaces,
    which can extend past the mapped lane widths."""
    out, surfaces = [], []
    for path in sorted((OUT / f"{area}_now" / "tiles").glob("*_*.json")):
        if path.name.count(".") > 1:
            continue
        tile = json.loads(path.read_text())
        # Round ends: where a street is split into two ways at a slight bend, flat ends
        # leave a thin wedge open across it, and a post beside the joint looked like
        # one on a kerb (Sokolská). Past the street's end the asphalt still limits it.
        driven = [LineString(e["pts"]).buffer(max(e.get("width") or 0, MIN_ROADWAY) / 2, cap_style="round")
                  for e in tile.get("drive", ()) if not e.get("tunnel") and not e.get("bridge") and len(e["pts"]) > 1]
        driven += [LineString(r["pts"]).buffer(TRAM_LANE / 2, cap_style="flat")
                   for r in tile.get("rails", ()) if r["kind"] == "tram" and len(r["pts"]) > 1]
        surface = [shape for kind in ROADWAYS for rings in tile.get("roads", {}).get(kind, ()) if len(rings[0]) >= 3
                   for shape in [Polygon(rings[0], [h for h in rings[1:] if len(h) >= 3])] if shape.is_valid]
        if not driven or not surface:
            continue
        paving = unary_union(surface)
        surfaces.extend(p for p in getattr(paving, "geoms", [paving]) if p.geom_type == "Polygon")
        both = unary_union(driven).intersection(paving)
        out += [g for g in getattr(both, "geoms", [both]) if g.geom_type == "Polygon" and g.area > 1]
    return out, surfaces


def build(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    lamps = [(lon, lat, KINDS[k]) for lon, lat, k in download() if w <= lon <= e and s <= lat <= n]
    xs, ys = (list(v) for v in tf.transform([l[0] for l in lamps], [l[1] for l in lamps]))
    kinds = [l[2] for l in lamps]
    dest = OUT / f"{area}_now" / "lamps.bin.gz"
    # Lamps only the works' documentation has, then those only OSM has: none already
    # there within NEAR of them.
    cells = {}
    for x, y in zip(xs, ys):
        cells.setdefault((int(x // NEAR), int(y // NEAR)), []).append((x, y))

    def add(found, near=NEAR):
        added = 0
        for lon, lat, kind in found:
            if not (w <= lon <= e and s <= lat <= n):
                continue
            x, y = tf.transform(lon, lat)
            cx, cy = int(x // NEAR), int(y // NEAR)
            if any(math.hypot(x - px, y - py) < near for i in (-2, -1, 0, 1, 2) for j in (-2, -1, 0, 1, 2) for px, py in cells.get((cx + i, cy + j), ())):
                continue
            cells.setdefault((cx, cy), []).append((x, y))
            xs.append(x), ys.append(y), kinds.append(kind)
            added += 1
        return added
    surveyed = len(kinds)
    built = add(((lon, lat, KINDS[k]) for lon, lat, k in download(URL_BUILT, CACHE_BUILT)), NEAR_BUILT)
    osm = osm_lighting(area)
    added = 0
    if osm:
        added = add(osm[0])
    # No lamp on a post in a roadway (street_lighting.off_the_road): it hangs over the
    # street or stands on the kerb. Before the streets are judged, which go by the lamps.
    roads, surfaces = road_geometry(area)
    local = lambda pts: tf.transform([p[0] for p in pts], [p[1] for p in pts])
    positions = list(zip(xs, ys))
    houses = [b for b in (Polygon(list(zip(*local(pts)))) for pts in (osm[2] if osm else []) if len(pts) >= 4) if b.is_valid]
    if osm:
        streets = [(name, hw, LineString(list(zip(*local(pts))))) for name, hw, pts in osm[3]]
        # The photographed Zborovská block between the two junctions.
        paired = [line for (name, _, pts), (_, _, line) in zip(osm[3], streets)
                  if name == "Zborovská" and 50.07541 < sum(p[1] for p in pts) / len(pts) < 50.07612]
        paired_stations = set(STRtree(paired).query(
            points(positions), predicate="dwithin", distance=PAIR_REACH)[0]) if paired else set()
        inferred = street_lighting.infer_suspended_lamps(
            positions, kinds, surveyed + built, streets, CABLE_ROADS, houses, surfaces, paired_stations)
        suspend_paired_lamps(positions, kinds, paired)
        print(f"{area}: {inferred} surveyed lamps suspended from street and façade geometry")
    if roads:
        positions, kinds, (kerbed, hung, far) = street_lighting.off_the_road(positions, kinds, roads, houses)
        left = len(street_lighting.posts_in_road(positions, kinds, roads))
        print(f"{area}: of the lamps on posts in a roadway, {hung} hang over the street, {kerbed} are put on the kerb beside them "
              f"and {far} on the nearest kerb from further in; {left} left")
    else:
        print(f"{area}: no tiles in {OUT / f'{area}_now' / 'tiles'}: lamps on posts in a roadway are not looked for (build the tiles first)")
    if osm:
        # Its streets, lit and dark: those reaching into the area, judged by their tags,
        # the lamps and the buildings (street_lighting.py), then straightened a little
        # (the game matches them to its streets within a few metres) and packed small.
        x0, y0 = tf.transform(w, s)
        x1, y1 = tf.transform(e, n)
        inside = lambda px, py: not (max(px) < x0 - EDGE or min(px) > x1 + EDGE or max(py) < y0 - EDGE or min(py) > y1 + EDGE)
        streets = [(lit, hw, list(zip(px, py))) for lit, hw, (px, py) in ((lit, hw, local(pts)) for lit, hw, pts in osm[1]) if inside(px, py)]
        outlines = [b for b in houses if inside(*b.exterior.xy)]
        runs, metres = street_lighting.lighting(streets, outlines, positions)
        ways = []
        for lit, pts in runs:
            line = [(round(x / STEP), round(y / STEP)) for x, y in LineString(pts).simplify(STRAIGHTEN).coords]
            # (A step is an int16, a way's point count a uint16: both far beyond any street's.)
            if len(line) < 65536 and all(abs(b[0] - a[0]) < 32768 and abs(b[1] - a[1]) < 32768 for a, b in zip(line, line[1:])):
                ways.append((lit, line))
        body = struct.pack("<I", len(ways))
        for lit, line in ways:
            body += struct.pack("<BHii", lit, len(line), *line[0])
            body += b"".join(struct.pack("<hh", b[0] - a[0], b[1] - a[1]) for a, b in zip(line, line[1:]))
        lit_dest = dest.with_name("lit.bin.gz")
        lit_dest.write_bytes(gzip.compress(body, 9))
        km = lambda f: f"{(metres.get(f, 0) - metres.get((f, 'paths'), 0)) / 1000:.0f} km (and {metres.get((f, 'paths'), 0) / 1000:.0f} km of paths)"
        print(f"{area}: streets lit by tag {km(street_lighting.TAGGED)}, by a lamp nearby {km(street_lighting.BY_LAMP)}, by buildings "
              f"{km(street_lighting.BY_BUILDINGS)}, by the way to the next lit street {km(street_lighting.BY_LINK)}; tagged dark "
              f"{km(street_lighting.DARK)}, left dark {km(None)} → {lit_dest} ({lit_dest.stat().st_size // 1024} kB)")
    else:
        print(f"{area}: no OSM cut ({OSM / f'{area}.osm.pbf'}): the survey's lamps only, and no lit.bin.gz")
    body = struct.pack("<I", len(kinds))
    body += b"".join(struct.pack("<ff", x, y) for x, y in positions)
    body += bytes(kinds)
    dest.write_bytes(gzip.compress(body, 9))
    print(f"{area}: {len(kinds)} lamps ({surveyed} surveyed, {built} more from finished works, {added} only in OSM) → {dest} ({dest.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    for a in sys.argv[1:] or ["praha"]:
        build(a)
