"""The terrain's lattice round a place, as the game gets it: each point's ground height
and label, and the height of every bridge or tunnel level that has one there.

    uv run --project pipeline python .agents/skills/terrain-steps/terrain_at.py praha 50.08127 14.40807 [cells either way, 7]

Rows from the north, columns from the west, a lattice step (about 4 m) apart. A cell
reads `190.6.0|1:197.5`: ground 190.6 m a.s.l., label 0 (0 plain ground, 1 water, 2 and
up the tile's terraces), level number 1 of the tile's structures at 197.5 m. Above the
table: the tile's structures (index, level, kind) and terraces (label, flat height if it
has one). A lone value metres off its neighbours with the same label is a spike you'll
see in the game; a step between two labels is a wall.
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from osm_area import AREAS  # noqa: E402


def read(path):
    raw = (path.parent / (path.name + ".gz")).read_bytes() if (path.parent / (path.name + ".gz")).exists() else path.read_bytes()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def main():
    area, lat, lon = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    reach = int(sys.argv[4]) if len(sys.argv) > 4 else 7
    w, s, e, n = AREAS[area]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    x, y = Transformer.from_crs("EPSG:4326", local, always_xy=True).transform(lon, lat)
    data = ROOT / "public" / "data" / f"{area}_now"
    index = json.loads((data / "index.json").read_text())
    T, (ox, oy), size, step = index["tile"], index["origin"], index["terrain"]["n"], index["terrain"]["step"]
    i, j = int((x + ox) // T), int((y + oy) // T)
    raw = read(data / "tiles" / f"{i}_{j}.height.bin")
    h = np.frombuffer(raw[:size * size * 2], "<u2").reshape(size, size) / 10 + 100
    label = np.frombuffer(raw[size * size * 2:], "u1").reshape(size, size) if len(raw) >= size * size * 3 else np.zeros((size, size), int)
    tile = json.loads(read(data / "tiles" / f"{i}_{j}.json"))
    structures = tile.get("structures", [])
    print(f"tile {i}_{j}, local ({x:.0f}, {y:.0f})")
    print("structures:", [(k, st["level"], st["kind"]) for k, st in enumerate(structures)])
    print("terraces:", [(t["label"], t.get("h")) for t in tile.get("terraces", [])])
    levels = None
    if structures and (data / "tiles" / f"{i}_{j}.levels.bin.gz").exists():
        levels = np.frombuffer(read(data / "tiles" / f"{i}_{j}.levels.bin"), "<u2").reshape(len(structures), size, size) / 100 + 100
        levels = np.where(levels <= 100.001, np.nan, levels)
    ci, cj = int(round((x + ox - i * T) / step)), int(round((y + oy - j * T) / step))
    for q in range(min(size - 1, cj + reach), max(0, cj - reach) - 1, -1):
        cells = []
        for p in range(max(0, ci - reach), min(size - 1, ci + reach) + 1):
            c = f"{h[q, p]:5.1f}.{label[q, p]}"
            if levels is not None:
                c += "".join(f"|{k}:{levels[k, q, p]:.1f}" for k in range(len(structures)) if not np.isnan(levels[k, q, p]))
            cells.append(f"{c:<22s}")
        print(" ".join(cells))


if __name__ == "__main__":
    main()
