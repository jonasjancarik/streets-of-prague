"""Where cafés, restaurants and pubs put tables outside, for the game's parasols.

    uv run build_terraces.py praha      # → public/data/praha_now/terraces.json

Nothing is made up here: these are OpenStreetMap's cafés, restaurants, pubs, bars,
ice-cream shops and fast-food places tagged `outdoor_seating` (anything but "no"), and
its beer gardens. OSM says that a place has tables outside, not where they stand or how
many there are; the game finds room on the pavement in front (src/terraces.ts).

terraces.json: {"terraces": [[x, y, kind], ...]}, x and y in the area's local metres
(+x east, +y north), kind 0 a café or ice-cream shop, 1 a restaurant or fast food, 2 a
pub, bar or beer garden. It reads the points of interest build_footfall.py filters
out of the OSM extract, and makes that file the same way if it isn't there yet.
"""

import json
import subprocess
import sys
from collections import Counter

from pyproj import Transformer
from shapely.geometry import shape
from shapely.ops import transform

from build_tiles import PBF, cut
from osm_area import AREAS, OUT

KINDS = {"cafe": 0, "ice_cream": 0, "restaurant": 1, "fast_food": 1, "food_court": 1, "pub": 2, "bar": 2, "biergarten": 2}


# (The tag keys build_footfall.py keeps in <area>_poi.osm.pbf.)
POI_KEYS = ["shop", "amenity", "tourism", "historic", "leisure"]


def terraces(area):
    w, s, e, n = AREAS[area]
    # The area's local metres, as the game and the other small data files have them.
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    tagged = PBF.parent / f"{area}_poi.osm.pbf"
    if not tagged.exists():
        if not PBF.exists():
            sys.exit(f"needs the OSM extract {PBF} (see 'Building the map' in docs/handbook.md)")
        src = cut((w - 0.01, s - 0.01, e + 0.01, n + 0.01), PBF.parent / f"{area}.osm.pbf")
        subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(tagged), str(src), *[f"nwr/{k}" for k in POI_KEYS]], check=True)
    out = subprocess.run(["osmium", "export", "-f", "geojsonseq", "-x", "print_record_separator=false", str(tagged)],
                         check=True, capture_output=True, text=True).stdout
    found, kinds = [], Counter()
    for line in out.splitlines():
        f = json.loads(line)
        tags, g = f["properties"], f["geometry"]
        kind = KINDS.get(tags.get("amenity"))
        if kind is None or not g:
            continue
        if tags.get("amenity") != "biergarten" and tags.get("outdoor_seating", "no") == "no":
            continue
        geom = shape(g)
        c = geom if geom.geom_type == "Point" else geom.representative_point()
        if not (w <= c.x <= e and s <= c.y <= n):
            continue
        p = transform(tf.transform, c)
        found.append([round(p.x, 1), round(p.y, 1), kind])
        kinds[tags["amenity"]] += 1
    found.sort()
    print(f"{len(found)} places with tables outside:", ", ".join(f"{k} {v}" for k, v in kinds.most_common()))
    return found


if __name__ == "__main__":
    area = sys.argv[1] if len(sys.argv) > 1 else "centrum"
    path = OUT / f"{area}_now" / "terraces.json"
    path.write_text(json.dumps({"terraces": terraces(area)}, separators=(",", ":")))
    print("wrote", path, path.stat().st_size, "bytes")
