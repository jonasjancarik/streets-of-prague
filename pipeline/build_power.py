"""Build the optional transmission tower and wire layer from a cached OSM extract."""

import argparse
from functools import lru_cache
import gzip
import json
import math
from pathlib import Path
import subprocess

import numpy as np
from pyproj import Transformer

import build_cache
from osm_area import AREAS, OUT


def read_osm(source):
    # Include the ways' referenced nodes, then keep only mapped tower supports.
    contents = subprocess.check_output(
        ["osmium", "tags-filter", "-f", "opl", str(source), "n/power=tower", "w/power=line"], text=True)
    towers, lines = {}, []
    for row in contents.splitlines():
        fields = row.split()
        if not fields:
            continue
        tags = dict(field.split("=", 1) for field in next((v[1:] for v in fields if v.startswith("T")), "").split(",") if "=" in field)
        if fields[0].startswith("n") and tags.get("power") == "tower":
            lon = next((v[1:] for v in fields if v.startswith("x")), None)
            lat = next((v[1:] for v in fields if v.startswith("y")), None)
            if lon is not None and lat is not None:
                towers[fields[0]] = (float(lon), float(lat), tags.get("height"))
        elif fields[0].startswith("w") and tags.get("power") == "line":
            nodes = next((v[1:].split(",") for v in fields if v.startswith("N")), [])
            voltages = [int(v) for v in tags.get("voltage", "").split(";") if v.isdecimal()]
            lines.append((nodes, max(voltages, default=0)))
    return towers, lines


def build(area, source):
    folder = OUT / f"{area}_now"
    index_path = folder / "index.json"
    original_index = index_path.read_bytes()
    index = json.loads(original_index)
    terrain = index.get("terrain")
    if not terrain:
        raise SystemExit(f"{area}: build terrain before the power layer")
    ox, oy = index["origin"]
    size = index["tile"]
    available = {(i, j) for i, j, *_ in index["tiles"]}
    west, south, east, north = index["bbox_wgs84"]
    projection = f"+proj=tmerc +lat_0={(south+north)/2} +lon_0={(west+east)/2} +k=1 +ellps=WGS84 +units=m"
    transform = Transformer.from_crs(4326, projection, always_xy=True)

    def tile(x, y):
        return math.floor((x + ox) / size), math.floor((y + oy) / size)

    @lru_cache(maxsize=80)
    def heights(i, j):
        binary = folder / "tiles" / f"{i}_{j}.height.bin"
        data = binary.read_bytes() if binary.exists() else gzip.decompress(binary.with_suffix(".bin.gz").read_bytes())
        n = terrain["n"]
        return 100 + terrain.get("unit", 0.1) * np.frombuffer(data, dtype="<u2", count=n*n).reshape(n, n)

    def ground(x, y, i, j):
        try:
            h = heights(i, j)
        except FileNotFoundError:
            return None
        step = terrain["step"]
        u = float(np.clip((x + ox - i * size) / step, 0, h.shape[1] - 1))
        v = float(np.clip((y + oy - j * size) / step, 0, h.shape[0] - 1))
        a, b = min(math.floor(u), h.shape[1] - 2), min(math.floor(v), h.shape[0] - 2)
        du, dv = u - a, v - b
        return float((h[b, a] * (1-du) + h[b, a+1] * du) * (1-dv)
                     + (h[b+1, a] * (1-du) + h[b+1, a+1] * du) * dv)

    towers, lines = read_osm(source)
    points = {key: transform.transform(lon, lat) for key, (lon, lat, _) in towers.items()}
    bearings, voltage, spans = {}, {}, set()
    for nodes, volts in lines:
        for a, b in zip(nodes, nodes[1:]):
            if a == b or a not in points or b not in points:
                continue
            ax, ay = points[a]
            bx, by = points[b]
            length = math.hypot(bx-ax, by-ay)
            if not 8 <= length <= 750:
                continue
            angle = math.atan2(by-ay, bx-ax) % math.pi
            for key in (a, b):
                voltage[key] = max(voltage.get(key, 0), volts)
                if length > bearings.get(key, (0, 0))[0]:
                    bearings[key] = (length, angle)
            spans.add(tuple(sorted((a, b))))

    data = {"area": area, "built": index["built"], "towers": [], "tiles": {}}
    tower_ids = {}
    def entry(i, j):
        return data["tiles"].setdefault(f"{i}_{j}", {"t": [], "w": []})

    for key in sorted(towers):
        x, y = points[key]
        i, j = tile(x, y)
        if (i, j) not in available:
            continue
        z = ground(x, y, i, j)
        if z is None or not 100 < z < 600:
            continue
        try:
            h = float(towers[key][2])
        except (TypeError, ValueError):
            h = 35 if voltage.get(key, 0) >= 400_000 else 27 if voltage.get(key, 0) >= 220_000 else 19
        if not 8 <= h <= 85:
            continue
        idx = tower_ids[key] = len(data["towers"])
        entry(i, j)["t"].append(idx)
        data["towers"].append([round(v, 3) for v in (x, y, z, h, bearings.get(key, (0, 0))[1])])

    for a, b in sorted(spans):
        if a not in tower_ids or b not in tower_ids:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        count = max(1, math.ceil(math.hypot(bx-ax, by-ay) / 50))
        for k in range(count):
            t = (k + 0.5) / count
            i, j = tile(ax + (bx-ax)*t, ay + (by-ay)*t)
            if (i, j) in available:
                entry(i, j)["w"].append([tower_ids[a], tower_ids[b], round(k/count, 6), round((k+1)/count, 6)])
    if index_path.read_bytes() != original_index:
        raise SystemExit(f"{area}: map changed while building power.json; rerun against the new map")
    build_cache.write_json(folder / "power.json", data)
    index["power"] = True
    build_cache.write_json(index_path, index)
    print(f"{area}: {len(data['towers'])} towers, {sum(len(t['w']) for t in data['tiles'].values())} wire sections")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("area", choices=AREAS)
    parser.add_argument("--source", type=Path, help="OSM extract for this area")
    args = parser.parse_args()
    source = args.source or Path(__file__).parent / ".cache" / "osm" / f"{args.area}.osm.pbf"
    build(args.area, source)
