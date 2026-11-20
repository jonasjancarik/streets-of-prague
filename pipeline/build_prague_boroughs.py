"""Build the Prague 1–10 outlines used on street signs from ČÚZK's RÚIAN layer 9.

    uv run build_prague_boroughs.py [downloaded.geojson]

Keep shared borders together while simplifying to roughly two metres. The
geometry is in longitude and latitude, so every game area can use the same file.
"""
import json
import sys
from pathlib import Path

import requests
import shapely
from shapely.geometry import shape

SOURCE = "https://ags.cuzk.gov.cz/arcgis/rest/services/RUIAN/MapServer/9/query"
DEST = Path(__file__).resolve().parents[1] / "src/map/pragueBoroughs.json"

if __name__ == "__main__":
    if len(sys.argv) > 1:
        doc = json.loads(Path(sys.argv[1]).read_text())
    else:
        response = requests.get(SOURCE, params={"where": "1=1", "outFields": "nazev", "outSR": 4326, "f": "geojson"}, timeout=60)
        response.raise_for_status()
        doc = response.json()
    features = sorted(doc["features"], key=lambda f: int(f["properties"]["nazev"].split()[-1]))
    if [f["properties"]["nazev"] for f in features] != [f"Praha {i}" for i in range(1, 11)]:
        raise ValueError("Expected the ten Prague boroughs")
    outlines = shapely.coverage_simplify([shape(f["geometry"]) for f in features], 0.000025)
    result = []
    for geom in outlines:
        polygons = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
        rings = [[round(v, 6) for xy in r.coords[:-1] for v in xy] for p in polygons for r in (p.exterior, *p.interiors)]
        result.append({"box": [round(v, 6) for v in geom.bounds], "rings": rings})
    DEST.write_text(json.dumps(result, separators=(",", ":")) + "\n")
    print(DEST, DEST.stat().st_size)
