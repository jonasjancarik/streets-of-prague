"""Downloads from IPR Praha's open data (CC BY), the hosted feature services at
https://mp.iprpraha.cz/arcgis/rest/services/Hosted/<name>/FeatureServer/0: a whole
layer, or the part of it a `where` picks, in pages of 2,000 features one after the
other, each tried again a few times, with a short pause between them. What comes back
is kept in a JSON file under .cache/, so nothing is fetched twice; delete the file to
fetch it again.

ipr_greenery.py and ipr_utility.py use it. (ipr_trees.py and build_lamps.py have the
same loop of their own, from before this was written.)
"""

import json
import time
from pathlib import Path

import requests

BASE = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/{}/FeatureServer/0/query"
CACHE = Path(__file__).parent / ".cache"
PAGE = 2000
PAUSE = 0.25  # seconds between pages


def pages(name, where="1=1", fields="objectid", what="features"):
    """Every feature of the layer `name` that `where` picks, page by page: their
    attributes (`fields`, comma separated) and geometry in WGS84."""
    offset = 0
    while True:
        params = {"where": where, "outFields": fields, "outSR": 4326, "f": "json", "orderByFields": "objectid",
                  "geometryPrecision": 7, "resultOffset": offset, "resultRecordCount": PAGE}
        for attempt in range(5):
            try:
                r = requests.get(BASE.format(name), params=params, timeout=120)
                r.raise_for_status()
                page = r.json()
                if "error" in page:
                    raise ValueError(page["error"])
                break
            except (requests.RequestException, ValueError):
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        feats = page.get("features", [])
        yield from feats
        offset += len(feats)
        print(f"\r{offset} {what}", end="", flush=True)
        if not feats or not page.get("exceededTransferLimit"):
            break
        time.sleep(PAUSE)
    print()


def cached(path, make):
    """What `make()` gives, kept as JSON at .cache/<path>."""
    file = CACHE / path
    if file.exists():
        return json.loads(file.read_text())
    file.parent.mkdir(parents=True, exist_ok=True)
    data = make()
    tmp = file.with_suffix(".part")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    tmp.replace(file)
    return data
