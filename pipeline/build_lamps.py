"""Street lamps for the night, from IPR Praha's archived utility map (the surface marks
of the technical map, DTMP_CUR_TMISZNAK_B): about 121,000 lamps on poles, a few
thousand on walls and in underpasses, the festive floodlights of monuments and the
Old Town's gas lamps. OSM knows about a sixth of them; the ones it has that the survey
lacks (outside the city's border above all) are added.

    uv run build_lamps.py praha      # → public/data/praha_now/lamps.bin.gz, lit.bin.gz

The download is cached in .cache/lamps/lamps.json (the whole city, WGS84); every
area takes the lamps in its box from there. The file is gzipped binary, little
endian: n (uint32), then n × (x, y) as float32 in the area's local metres (+x east,
+y north), then n kinds as uint8 (KINDS below, in that order).

lit.bin.gz says which streets OSM knows to be lit or dark (the `lit` tag on its ways),
for the game to decide where the survey's gaps get a lamp of the game's own
(src/lamps.ts, fill) and which streets stay dark: n ways (uint32), then for each a
flag (uint8: 1 lit, 0 dark), its number of points (uint16), the first point as (x, y)
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
from pyproj import Transformer
from shapely.geometry import LineString

from osm_area import AREAS, OUT

URL = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/DTMP_CUR_TMISZNAK_B/FeatureServer/0/query"
CACHE = Path(__file__).parent / ".cache" / "lamps" / "lamps.json"

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
# may put lamps of its own on (the streets cars drive, which is what src/lamps.ts fills).
OSM = Path(__file__).parent / ".cache" / "osm"
MOUNTS = {"wall": 1, "ceiling": 5, "ground": 6}
HUNG_MOUNTS = ("suspended", "cable", "wire", "catenary")
LIT = {"yes": 1, "24/7": 1, "automatic": 1, "limited": 1, "sunset-sunrise": 1, "interval": 1, "no": 0, "disused": 0}
LIT_WAYS = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
            "tertiary", "tertiary_link", "residential", "unclassified", "living_street", "service", "pedestrian", "busway"}
NEAR = 8.0  # m: an OSM lamp this close to one of the survey's is the same lamp
STEP, STRAIGHTEN, EDGE = 0.25, 1.0, 300.0  # m: lit.bin.gz's unit, how far a way may be straightened, how far past the area's box ways are kept


def download():
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    where = f"ctmtp_kod IN ({','.join(map(str, KINDS))})"
    out, offset = [], 0
    while True:
        params = {"where": where, "outFields": "ctmtp_kod", "outSR": 4326, "f": "json", "orderByFields": "objectid",
                  "resultOffset": offset, "resultRecordCount": 2000}
        for attempt in range(5):
            try:
                r = requests.get(URL, params=params, timeout=60)
                r.raise_for_status()
                page = r.json()
                break
            except (requests.RequestException, ValueError):
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        feats = page.get("features", [])
        out += [[round(f["geometry"]["x"], 7), round(f["geometry"]["y"], 7), f["attributes"]["ctmtp_kod"]]
                for f in feats if f.get("geometry")]
        offset += len(feats)
        print(f"\r{offset} lamps", end="", flush=True)
        if not feats or not page.get("exceededTransferLimit"):
            break
    print()
    CACHE.write_text(json.dumps(out))
    return out


def osm_lighting(area):
    """What the area's OSM cut says about lighting: its street lamps as (lon, lat, kind),
    and its ways with a `lit` tag as (lit, [(lon, lat), …]). None without the cut."""
    pbf = OSM / f"{area}.osm.pbf"
    if not pbf.exists():
        return None
    lamps, ways = [], []
    with tempfile.TemporaryDirectory() as tmp:
        picked, out = Path(tmp) / "lit.osm.pbf", Path(tmp) / "lit.geojsonseq"
        subprocess.run(["osmium", "tags-filter", str(pbf), "n/highway=street_lamp", "w/lit", "-o", str(picked)], check=True)
        subprocess.run(["osmium", "export", str(picked), "-f", "geojsonseq", "-o", str(out)], check=True)
        # (One feature a line, each after a record separator, which splitlines would split at too.)
        for line in out.read_text().split("\n"):
            if not line.strip("\x1e "):
                continue
            f = json.loads(line.lstrip("\x1e"))
            tags, geom = f["properties"], f["geometry"]
            if geom["type"] == "Point":
                mount = tags.get("lamp_mount") or tags.get("support") or ""
                # (One hung on cables is left to the game, which knows the walls to hang it from.)
                if tags.get("highway") == "street_lamp" and not any(m in mount for m in HUNG_MOUNTS):
                    lamps.append((*geom["coordinates"], next((k for m, k in MOUNTS.items() if m in mount), 0)))
            elif geom["type"] == "LineString" and tags.get("highway") in LIT_WAYS and tags.get("lit") in LIT:
                ways.append((LIT[tags["lit"]], geom["coordinates"]))
    return lamps, ways


def build(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    lamps = [(lon, lat, KINDS[k]) for lon, lat, k in download() if w <= lon <= e and s <= lat <= n]
    xs, ys = (list(v) for v in tf.transform([l[0] for l in lamps], [l[1] for l in lamps]))
    kinds = [l[2] for l in lamps]
    dest = OUT / f"{area}_now" / "lamps.bin.gz"
    osm = osm_lighting(area)
    added = 0
    if osm:
        # OSM's lamps the survey doesn't have: none of its own within NEAR of them.
        cells = {}
        for x, y in zip(xs, ys):
            cells.setdefault((int(x // NEAR), int(y // NEAR)), []).append((x, y))
        for lon, lat, kind in osm[0]:
            if not (w <= lon <= e and s <= lat <= n):
                continue
            x, y = tf.transform(lon, lat)
            cx, cy = int(x // NEAR), int(y // NEAR)
            if any(math.hypot(x - px, y - py) < NEAR for i in (-1, 0, 1) for j in (-1, 0, 1) for px, py in cells.get((cx + i, cy + j), ())):
                continue
            cells.setdefault((cx, cy), []).append((x, y))
            xs.append(x), ys.append(y), kinds.append(kind)
            added += 1
        # Its lit and dark streets: those reaching into the area, straightened a little
        # (the game matches them to its streets within a few metres) and packed small.
        x0, y0 = tf.transform(w, s)
        x1, y1 = tf.transform(e, n)
        ways = []
        for lit, pts in osm[1]:
            px, py = tf.transform([p[0] for p in pts], [p[1] for p in pts])
            if max(px) < x0 - EDGE or min(px) > x1 + EDGE or max(py) < y0 - EDGE or min(py) > y1 + EDGE:
                continue
            line = [(round(x / STEP), round(y / STEP)) for x, y in LineString(list(zip(px, py))).simplify(STRAIGHTEN).coords]
            # (A step is an int16, a way's point count a uint16: both far beyond any street's.)
            if len(line) < 65536 and all(abs(b[0] - a[0]) < 32768 and abs(b[1] - a[1]) < 32768 for a, b in zip(line, line[1:])):
                ways.append((lit, line))
        body = struct.pack("<I", len(ways))
        for lit, line in ways:
            body += struct.pack("<BHii", lit, len(line), *line[0])
            body += b"".join(struct.pack("<hh", b[0] - a[0], b[1] - a[1]) for a, b in zip(line, line[1:]))
        lit_dest = dest.with_name("lit.bin.gz")
        lit_dest.write_bytes(gzip.compress(body, 9))
        dark = sum(1 for lit, _ in ways if not lit)
        print(f"{area}: {len(ways) - dark} lit and {dark} dark streets → {lit_dest} ({lit_dest.stat().st_size // 1024} kB)")
    else:
        print(f"{area}: no OSM cut ({OSM / f'{area}.osm.pbf'}): the survey's lamps only, and no lit.bin.gz")
    body = struct.pack("<I", len(kinds))
    body += b"".join(struct.pack("<ff", x, y) for x, y in zip(xs, ys))
    body += bytes(kinds)
    dest.write_bytes(gzip.compress(body, 9))
    print(f"{area}: {len(kinds)} lamps ({added} of them only in OSM) → {dest} ({dest.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    for a in sys.argv[1:] or ["praha"]:
        build(a)
