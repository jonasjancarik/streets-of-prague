"""Prague's city limits for the start screen's map: src/prague.json.

    uv run build_prague_outline.py

The map of where to begin (src/startmap.ts) lets you pick only inside the city, and
greys out the rest. The outline is OSM's administrative boundary of Praha (the region,
the same line as the city's), cut from the area's extract, simplified to about 10 m and
kept in degrees: {"rings": [[lon, lat, lon, lat, …], …]}, the outer ring first. It is
small and the city limits don't move, so it is committed with the code, unlike the map.
"""

import json
import subprocess
import sys
from pathlib import Path

from shapely.geometry import MultiPolygon, shape

CACHE = Path(__file__).parent / ".cache" / "osm"
PBF = CACHE / "praha.osm.pbf"
BOUNDARIES = CACHE / "admin.osm.pbf"
DEST = Path(__file__).parent.parent / "src" / "prague.json"
SIMPLIFY = 0.0001  # degrees, about 7 m across and 11 m along


def outline():
    if not PBF.exists():
        sys.exit(f"needs the area's extract {PBF} (build_tiles.py praha makes it)")
    subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(BOUNDARIES), str(PBF), "r/boundary=administrative"],
                   check=True)
    out = subprocess.run(["osmium", "export", "-f", "geojsonseq", "-x", "print_record_separator=false", str(BOUNDARIES)],
                         check=True, capture_output=True, text=True).stdout
    for line in out.splitlines():
        f = json.loads(line)
        p = f["properties"]
        if p.get("name") == "Praha" and p.get("ref") == "PR" and f["geometry"]["type"] in ("Polygon", "MultiPolygon"):
            return shape(f["geometry"])
    sys.exit("no boundary of Praha (ref=PR) in the extract")


if __name__ == "__main__":
    g = outline().simplify(SIMPLIFY, preserve_topology=True)
    polys = g.geoms if isinstance(g, MultiPolygon) else [g]
    rings = [[round(v, 5) for xy in r.coords[:-1] for v in xy] for p in polys for r in (p.exterior, *p.interiors)]
    DEST.write_text(json.dumps({"rings": rings}, separators=(",", ":")) + "\n")
    print(f"{len(rings)} rings, {sum(len(r) for r in rings) // 2} points → {DEST} ({DEST.stat().st_size // 1024} kB)")
