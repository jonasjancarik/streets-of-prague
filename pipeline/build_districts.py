"""Prague's neighbourhoods for the game's titles: public/data/<area>_now/districts.json.

    uv run build_districts.py praha centrum

The names people give the parts of town (Smíchov, Malá Strana, Vinohrady, Nové
Město…) are the cadastral areas (katastrální území), which OSM maps as relations
tagged boundary=cadastral. They tile the city without gaps, so wherever you are you're
in exactly one. Each one that reaches into the area's box is kept whole, simplified to
a few metres, in the area's local metres (+x east, +y north):

    {"districts": [{"name": "Smíchov", "box": [x0, y0, x1, y1], "rings": [[x, y, x, y, …], …]}, …]}

`rings` are all of its outlines, outer and inner alike: a point is inside when it's
inside an odd number of them. The cadastral boundaries are cut from the local extract
(build_tiles.PBF) once and cached in .cache/osm/cadastral.osm.pbf.
"""

import json
import subprocess
import sys
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import MultiPolygon, box, shape
from shapely.ops import transform

from build_tiles import PBF
from osm_area import AREAS, OUT

CACHE = Path(__file__).parent / ".cache" / "osm" / "cadastral.osm.pbf"
SIMPLIFY = 4.0  # metres


def boundaries():
    """Every cadastral area in the extract as GeoJSON features (WGS84)."""
    if not CACHE.exists():
        if not PBF.exists():
            sys.exit(f"needs the OSM extract {PBF} (see "Building the map" in docs/handbook.md)")
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(CACHE), str(PBF), "r/boundary=cadastral"],
                       check=True)
    out = subprocess.run(["osmium", "export", "-f", "geojsonseq", "-x", "print_record_separator=false", str(CACHE)],
                         check=True, capture_output=True, text=True).stdout
    feats = (json.loads(line) for line in out.splitlines())
    return [f for f in feats if f["geometry"] and f["geometry"]["type"] in ("Polygon", "MultiPolygon")
            and f["properties"].get("boundary") == "cadastral" and f["properties"].get("name")]


def build(area, feats):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    frame = box(w, s, e, n)
    districts = []
    for f in feats:
        g = shape(f["geometry"])
        if not g.intersects(frame):
            continue
        g = transform(tf.transform, g).simplify(SIMPLIFY, preserve_topology=True)
        polys = g.geoms if isinstance(g, MultiPolygon) else [g]
        rings = [[round(v, 1) for xy in r.coords[:-1] for v in xy]
                 for p in polys for r in (p.exterior, *p.interiors)]
        districts.append({"name": f["properties"]["name"], "box": [round(v, 1) for v in g.bounds], "rings": rings})
    districts.sort(key=lambda d: d["name"])
    dest = OUT / f"{area}_now" / "districts.json"
    dest.write_text(json.dumps({"districts": districts}, ensure_ascii=False, separators=(",", ":")))
    print(f"{area}: {len(districts)} districts → {dest} ({dest.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    feats = boundaries()
    for a in sys.argv[1:] or ["praha"]:
        build(a, feats)
