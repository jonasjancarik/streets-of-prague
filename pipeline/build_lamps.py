"""Street lamps for the night, from IPR Praha's archived utility map (the surface marks
of the technical map, DTMP_CUR_TMISZNAK_B): about 121,000 lamps on poles, a few
thousand on walls and in underpasses, the festive floodlights of monuments and the
Old Town's gas lamps. OSM knows about a sixth of them.

    uv run build_lamps.py praha      # → public/data/praha_now/lamps.bin.gz

The download is cached in .cache/lamps/lamps.json (the whole city, WGS84); every
area takes the lamps in its box from there. The file is gzipped binary, little
endian: n (uint32), then n × (x, y) as float32 in the area's local metres (+x east,
+y north), then n kinds as uint8 (KINDS below, in that order).
"""

import gzip
import json
import struct
import sys
import time
from pathlib import Path

import requests
from pyproj import Transformer

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


def build(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    lamps = [(lon, lat, KINDS[k]) for lon, lat, k in download() if w <= lon <= e and s <= lat <= n]
    xs, ys = tf.transform([l[0] for l in lamps], [l[1] for l in lamps])
    body = struct.pack("<I", len(lamps))
    body += b"".join(struct.pack("<ff", x, y) for x, y in zip(xs, ys))
    body += bytes(l[2] for l in lamps)
    dest = OUT / f"{area}_now" / "lamps.bin.gz"
    dest.write_bytes(gzip.compress(body, 9))
    print(f"{area}: {len(lamps)} lamps → {dest} ({dest.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    for a in sys.argv[1:] or ["praha"]:
        build(a)
