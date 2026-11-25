"""Tile-local road profiles from Wilsonova at the station to the end of V Holešovičkách.

The two directed paths are sampled on their own transport levels. Controls are
longitude/latitude in ten-millionths of a degree, centimetres Bpv and signed
crossfall in thousandths towards the right-hand kerb. The heights follow a 12 m
Gaussian fit to the median of the three inner lane samples at 1 m intervals.
"""
import json
import math
from collections import defaultdict
from pathlib import Path

from pyproj import Transformer


def tile_profiles(meta):
    if meta["area"] not in ("praha", "centrum"):
        return {}
    project = Transformer.from_crs(4326, meta["crs"], always_xy=True).transform
    ox, oy = meta["origin"]
    size = meta["tile"]
    out = defaultdict(list)
    routes = json.loads(Path(__file__).with_name("magistrala_profiles.json").read_text())
    def tiles_between(a, b, pad, origin, count):
        first = math.floor((min(a, b) - pad + origin) / size)
        last = math.floor((max(a, b) + pad + origin) / size)
        return range(max(0, first), min(count, last + 1))

    for route in routes:
        for level, half, controls in route:
            pts = []
            for lon, lat, z, cross in controls:
                x, y = project(lon / 1e7, lat / 1e7)
                pts.append([round(x, 2), round(y, 2), z, cross])
            for a, b in zip(pts, pts[1:]):
                if a[:2] == b[:2]:
                    continue
                pad = half + 4
                for i in tiles_between(a[0], b[0], pad, ox, meta["cols"]):
                    for j in tiles_between(a[1], b[1], pad, oy, meta["rows"]):
                        out[f"{i}_{j}"].append([level, half, *a, *b])
    return out
