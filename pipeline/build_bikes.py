"""Shared bikes' stations (Rekola, nextbike…), where the game stands clusters of their bikes.

    uv run build_bikes.py praha      # → public/data/praha_now/bikes.json

PID's own open data has no shared bikes; the stations the PID Lítačka app shows come
from the operators' GBFS feeds. nextbike Praha's is public. Rekola's and the others'
are gathered by Prague's data platform Golemio (/v2/vehiclesharing/gbfs), which
needs a free API key from https://api.golemio.cz/api-keys: with GOLEMIO_API_KEY set,
every system there with stations is added too. The feeds are cached in .cache/bikes/
(again when a day old).

bikes.json: the systems (a colour for their bikes, and what's needed later to charge
for a ride: the pricing plans as GBFS gives them, and the rental links), and the
stations as [x, y, system, capacity, id, name], x and y in the area's local metres
(+x east, +y north). The game makes up how many bikes stand at each (src/bikeshare.ts);
the feeds' own counts are of one moment, when most stations happen to be empty.
"""

import json
import os
import sys
import time
from pathlib import Path

import requests
from pyproj import Transformer

from osm_area import AREAS, OUT

CACHE = Path(__file__).parent / ".cache" / "bikes"
NEXTBIKE = "https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_tg/gbfs.json"
GOLEMIO = "https://api.golemio.cz/v2/vehiclesharing/gbfs"
# The colour of a system's bikes, by a word in its name; any other gets GREY.
COLOURS = {"rekola": "#e4007c", "nextbike": "#1f6fb5"}
GREY = "#8a9099"


def get(url, name, headers=None):
    """A feed as JSON, cached a day under `name`."""
    path = CACHE / f"{name}.json"
    if path.exists() and time.time() - path.stat().st_mtime < 86400:
        return json.loads(path.read_text())
    for attempt in range(4):
        try:
            r = requests.get(url, headers=headers, timeout=60)
            r.raise_for_status()
            data = r.json()
            break
        except (requests.RequestException, ValueError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    return data


def text(v):
    """GBFS 3 gives names as [{text, language}], GBFS 2 as a string."""
    if isinstance(v, list):
        return next((t["text"] for t in v if t.get("language") == "cs"), v[0]["text"] if v else "")
    return v or ""


def feeds(gbfs):
    """Feed name → URL from a gbfs.json (v2: by language, Czech first; v3: a flat list)."""
    data = gbfs["data"]
    if "feeds" in data:
        return {f["name"]: f["url"] for f in data["feeds"]}
    lang = data.get("cs") or data.get("en") or next(iter(data.values()))
    return {f["name"]: f["url"] for f in lang["feeds"]}


def system(sid, gbfs_url, headers=None):
    urls = feeds(get(gbfs_url, f"{sid}.gbfs", headers))
    if "station_information" not in urls:
        return None
    info = get(urls["system_information"], f"{sid}.system_information", headers)["data"] if "system_information" in urls else {}
    stations = get(urls["station_information"], f"{sid}.station_information", headers)["data"]["stations"]
    plans = get(urls["system_pricing_plans"], f"{sid}.system_pricing_plans", headers)["data"]["plans"] \
        if "system_pricing_plans" in urls else []
    name = text(info.get("name")) or sid
    colour = next((c for word, c in COLOURS.items() if word in f"{sid} {name}".lower()), GREY)
    return {
        "id": sid, "name": name, "operator": text(info.get("operator")), "url": info.get("url"),
        "colour": colour, "apps": info.get("rental_apps"), "plans": plans, "stations": stations,
    }


def systems():
    out = [system("nextbike_tg", NEXTBIKE)]
    key = os.environ.get("GOLEMIO_API_KEY")
    if not key:
        print("GOLEMIO_API_KEY is not set: nextbike only (Rekola and the others come through Golemio)")
        return out
    headers = {"X-Access-Token": key}
    listed = get(f"{GOLEMIO}/systems_list", "golemio.systems_list", headers)
    for s in listed.get("systems", listed.get("data", {}).get("systems", [])) if isinstance(listed, dict) else listed:
        sid = s.get("system_id") or s.get("id")
        if not sid or "nextbike" in sid.lower():  # nextbike is fetched from nextbike itself
            continue
        try:
            got = system(sid, f"{GOLEMIO}/{sid}/gbfs", headers)
        except requests.RequestException as e:
            print(f"{sid}: {e}")
            continue
        if got and got["stations"]:
            out.append(got)
    return out


def build(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    out = {"systems": [], "stations": []}
    for sys_ in systems():
        i = len(out["systems"])
        here = [st for st in sys_.pop("stations") if w <= st["lon"] <= e and s <= st["lat"] <= n]
        for st in here:
            x, y = tf.transform(st["lon"], st["lat"])
            out["stations"].append([round(x, 1), round(y, 1), i, st.get("capacity") or 0, st["station_id"], text(st.get("name"))])
        out["systems"].append(sys_)
        print(f"{area}: {sys_['name']}: {len(here)} stations")
    dest = OUT / f"{area}_now" / "bikes.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"→ {dest} ({dest.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    for a in sys.argv[1:] or ["praha"]:
        build(a)
