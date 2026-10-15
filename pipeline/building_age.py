"""When Prague's buildings were built, from IPR Praha's open data "Stáří zástavby"
(Hosted/URK_CUR_URK_STARIZASTAVBY_P): about 137,000 outlines of buildings and groups of
buildings, each with the period it was built in (twelve periods, from "before 1842" to
"2011-2020").

    uv run building_age.py          # downloads the whole city to .cache/age/age.json.gz

ipr_buildings.py gives each IPR building the period of the outline its middle stands
in (Ages below) and picks its facade's style by it (Styles), where the game used to go
by the distance from the centre and a random pick; the game draws the style it's given.

Source: IPR Praha, Stáří zástavby (datový podklad © IPR Praha, CC BY).
"""

import gzip
import json
import time
from pathlib import Path

import numpy as np
import requests
import shapely
from pyproj import Transformer

URL = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/URK_CUR_URK_STARIZASTAVBY_P/FeatureServer/0/query"
CACHE = Path(__file__).parent / ".cache" / "age" / "age.json.gz"
# The dataset's period codes ("obdobi") as an era number for the tiles, 1 the oldest;
# 0 is "not known". Codes with a plus say only "no later than": they count as the
# period most such buildings are from.
ERAS = {"11": 1,  # before 1842
        "10": 2,  # 1843-1875
        "9": 3,  # 1876-1889
        "8": 4,  # 1890-1914
        "7": 5,  # 1915-1924
        "6": 6,  # 1925-1938
        "5": 7,  # 1939-1953
        "4": 8,  # 1954-1975
        "3": 9,  # 1976-1989
        "2": 10,  # 1990-2001
        "1": 11,  # 2002-2010
        "0": 12,  # 2011-2020
        "9+": 2, "8+": 3, "7+": 4, "6+": 4, "5+": 4}
NEAR = 3.0  # m; a building just outside every outline takes the nearest one's period

# Facade styles, as src/facades.ts numbers them, the style buildings of each era get, and
# how wide a window bay is in each (m between window axes; F_BAY in src/facades.ts).
TENEMENT, BAROQUE, FUNCTIONALIST, PANEL, HOUSE = range(5)
ERA_STYLE = (None, BAROQUE, TENEMENT, TENEMENT, TENEMENT, TENEMENT, FUNCTIONALIST, FUNCTIONALIST, PANEL, PANEL,
             FUNCTIONALIST, FUNCTIONALIST, FUNCTIONALIST)
BAY = (2.9, 3.1, 2.6, 2.4, 2.8)
# What ipr_buildings.py writes in the upper half of a wall's material byte (WALL_CODES in
# src/facades.ts): the style plus one, or for buildings of these eras a code that also
# tells the game the period's looks: tenements of 1843-1875 (mostly plain), 1876-1889
# (neo-Renaissance), 1890-1914 (Art Nouveau) and 1915-1924 (rondocubism and the
# geometric late Art Nouveau), buildings of 1939-1953 (late functionalism, the plain
# post-war houses and Socialist Realism) and infill since 1990.
ERA_CODE = {2: 6, 3: 7, 4: 8, 5: 9, 7: 11, 10: 10, 11: 10, 12: 10}
LOW = 8.5  # m; lower buildings are family houses whatever their age
CORE = ((14.4213, 50.0875, 750.0), (14.4034, 50.0880, 550.0), (14.3975, 50.0890, 450.0))  # Staré Město, Malá Strana, Hradčany


class Styles:
    """A building's facade style: by its era where IPR's data has one, else by where it
    stands and how tall it is, the way the game picks for buildings without this
    (styleFor in src/facades.ts: baroque and older in the historic core, panel housing
    for tall blocks far out, some functionalism in between, tenements otherwise)."""

    def __init__(self, crs: str, bounds=None):
        self.ages = Ages(crs, bounds)
        tf = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        self.core = [(*tf.transform(lon, lat), r) for lon, lat, r in CORE]
        self.known = self.all = 0

    def at(self, x: float, y: float, height: float, key: str) -> int:
        return self.code(x, y, height, key)[0]

    def code(self, x: float, y: float, height: float, key: str) -> tuple[int, int]:
        """The style, and the code for the wall byte (ERA_CODE)."""
        era = self.ages.at(x, y)
        self.all += 1
        self.known += era > 0
        if height < LOW:
            return HOUSE, HOUSE + 1
        if era:
            style = ERA_STYLE[era]
            return style, ERA_CODE.get(era, style + 1)
        style = self.guess(x, y, height)
        return style, style + 1

    def guess(self, x: float, y: float, height: float) -> int:
        import zlib
        # By 60 m squares, so a block keeps to one style.
        pick = (zlib.crc32(f"{int(x // 60)},{int(y // 60)}".encode()) & 0xFFFF) / 0xFFFF
        if any(np.hypot(x - cx, y - cy) < r for cx, cy, r in self.core):
            return BAROQUE if pick < 0.65 else TENEMENT
        d = np.hypot(x - self.core[0][0], y - self.core[0][1])
        if height > 20 and d > 3500:
            return PANEL
        if d > 1800 and pick < 0.25:
            return FUNCTIONALIST
        return TENEMENT


def download():
    """[[era, [ring, ...]]] for every outline, rings as [[lon, lat], ...], cached."""
    if CACHE.exists():
        return json.loads(gzip.decompress(CACHE.read_bytes()))
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    out, offset = [], 0
    while True:
        params = {"where": "1=1", "outFields": "obdobi", "outSR": 4326, "geometryPrecision": 6, "f": "json",
                  "orderByFields": "objectid", "resultOffset": offset, "resultRecordCount": 2000}
        for attempt in range(5):
            try:
                r = requests.get(URL, params=params, timeout=120)
                r.raise_for_status()
                page = r.json()
                if "features" not in page:
                    raise ValueError(page)
                break
            except (requests.RequestException, ValueError):
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        feats = page["features"]
        for f in feats:
            era = ERAS.get((f["attributes"].get("obdobi") or "").strip(), 0)
            rings = (f.get("geometry") or {}).get("rings")
            if era and rings:
                out.append([era, rings])
        offset += len(feats)
        print(f"\r{offset} outlines", end="", flush=True)
        if not feats or not page.get("exceededTransferLimit"):
            break
    print()
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(json.dumps(out, separators=(",", ":")).encode()))
    tmp.replace(CACHE)
    return out


class Ages:
    """The era (1-12, 0 where the data says nothing) of points in an area's local
    metres. `bounds`: the area's (west, south, east, north), to leave the rest of the
    city out."""

    def __init__(self, crs: str, bounds=None):
        tf = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        eras, polys = [], []
        for era, rings in download():
            if bounds is not None:
                lon, lat = rings[0][0]
                if not (bounds[0] - 0.01 <= lon <= bounds[2] + 0.01 and bounds[1] - 0.01 <= lat <= bounds[3] + 0.01):
                    continue
            # ArcGIS rings: outer ones and holes in one list; even-odd fill gives the area.
            parts = [shapely.Polygon(np.column_stack(tf.transform(*np.array(r).T))) for r in rings if len(r) >= 4]
            shape = None
            for p in parts:
                p = p if p.is_valid else p.buffer(0)
                shape = p if shape is None else shape.symmetric_difference(p)
            if shape is not None and not shape.is_empty:
                eras.append(era)
                polys.append(shape)
        self.eras = np.array(eras, dtype=np.uint8)
        self.polys = polys
        self.tree = shapely.STRtree(polys) if polys else None

    def at(self, x: float, y: float) -> int:
        if self.tree is None:
            return 0
        pt = shapely.Point(x, y)
        hit = self.tree.query(pt, predicate="within")
        if len(hit):
            # The smallest outline: a house inside a block's outline keeps its own period.
            return int(self.eras[min(hit, key=lambda k: self.polys[k].area)])
        k = self.tree.nearest(pt)
        return int(self.eras[k]) if self.polys[k].distance(pt) <= NEAR else 0


if __name__ == "__main__":
    data = download()
    count = np.bincount([e for e, _ in data], minlength=13)
    print(f"{len(data)} outlines with a period; by era 1-12: {count[1:].tolist()}")
