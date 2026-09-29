"""The OSM buildings of an area by name or near a place: their ids for LANDMARKS in
pipeline/landmarks.py, how tall they are, and where they are (game x, y for
window.__drive.teleport, lon,lat for ?start=).

    cd pipeline
    uv run ../.claude/skills/landmarks/find.py praha Týn
    uv run ../.claude/skills/landmarks/find.py praha --near 14.4213,50.0875 [--radius 60]
"""

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))  # run from pipeline/
from pyproj import Transformer

from layers import CACHE as LAYERS
from osm_area import OUT

ap = argparse.ArgumentParser()
ap.add_argument("area")
ap.add_argument("name", nargs="?", help="part of the building's name (any case)")
ap.add_argument("--near", help="lon,lat")
ap.add_argument("--radius", type=float, default=60, help="metres around --near (default 60)")
a = ap.parse_args()
if not a.name and not a.near:
    ap.error("give a name or --near")

crs = json.loads((LAYERS / a.area / "meta.json").read_text())["crs"]
fwd = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
inv = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
at = fwd.transform(*map(float, a.near.split(","))) if a.near else None

seen = {}
for f in sorted((OUT / f"{a.area}_now" / "tiles").glob("*.json")):
    for b in json.loads(f.read_text())["buildings"]:
        if b["id"] in seen or not b.get("own"):
            continue
        ring = b["rings"][0]
        cx, cy = sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
        d = math.hypot(cx - at[0], cy - at[1]) if at else 0
        if a.name and a.name.lower() not in (b.get("name") or "").lower():
            continue
        if at and d > a.radius:
            continue
        seen[b["id"]] = (d, b, cx, cy, f.stem)

for d, b, cx, cy, tile in sorted(seen.values(), key=lambda r: r[0]):
    lon, lat = inv.transform(cx, cy)
    near = f"{d:4.0f} m  " if at else ""
    print(f"{near}{b['id']:<18} {b.get('name') or '–':<40} {b.get('kind') or '':<12} h {b.get('h') or '?':<5} "
          f"part {bool(b.get('part'))!s:<5} x,y {cx:.0f},{cy:.0f}  start={lon:.5f},{lat:.5f}  tile {tile}")
if not seen:
    print("nothing found")
