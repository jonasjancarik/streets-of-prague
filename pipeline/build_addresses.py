"""House numbers from OpenStreetMap, for the plates beside the street façades' doors.

    uv run build_addresses.py praha     # → public/data/praha_now/addresses.json, addresses/*.json

Prague's address points come from RÚIAN, imported into OSM: each has the conscription
number (číslo popisné, the red plate, `addr:conscriptionnumber`) and, on a named street,
the street number (číslo orientační, the blue plate, `addr:streetnumber`). The point
usually sits inside the building. As with shops (build_shops.py) the game casts a ray
from the address's street to that point and hangs the plates beside the door of the
wall the ray crosses (src/houseNumbers.ts). Which door, and where on the wall, are the
game's.

addresses.json: {"cell": 500, "cells": ["cx_cy", ...]}, the cells (in the area's local
metres, +x east, +y north, cx = floor(x / cell)) that have a file. addresses/cx_cy.json:
[[sx, sy, px, py, "č.p.", "č.o."], ...] for the addresses whose street foot is in that
cell: the nearest point of the address's street, the address point, and the two numbers
("" when the address has none). The street is the one in `addr:street` within 60 m,
otherwise the nearest street within 25 m. Without the osmium command-line tool it reads
the files with pyosmium (`uv run --with osmium build_addresses.py praha`).
"""

import json
import shutil
import sys
from collections import Counter, defaultdict

from pyproj import Transformer
from shapely import STRtree
from shapely.ops import nearest_points, transform

from build_shops import STREETS, features
from build_tiles import PBF, cut
from osm_area import AREAS, OUT

CELL = 500  # m
KEYS = ["addr:conscriptionnumber", "addr:streetnumber"]


def addresses(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    pbf = PBF.parent / f"{area}.osm.pbf"
    if not pbf.exists():
        if not PBF.exists():
            sys.exit(f"needs the OSM extract {PBF} (see 'Building the map' in docs/handbook.md)")
        pbf = cut((w - 0.01, s - 0.01, e + 0.01, n + 0.01), pbf)

    lines, names = [], []
    for tags, g in features(pbf, ["highway"]):
        if tags.get("highway") in STREETS and g.geom_type == "LineString" and (tags.get("highway") != "service" or "name" in tags):
            lines.append(transform(tf.transform, g))
            names.append(tags.get("name"))
    tree = STRtree(lines)

    cells, skipped, count = defaultdict(list), Counter(), 0
    for tags, g in features(pbf, KEYS):
        cp, co = tags.get("addr:conscriptionnumber", "").strip(), tags.get("addr:streetnumber", "").strip()
        if not cp and not co:
            continue
        c = g if g.geom_type == "Point" else g.representative_point() if g.is_closed else g.interpolate(.5, normalized=True)
        if not (w <= c.x <= e and s <= c.y <= n):
            continue
        p = transform(tf.transform, c)
        street = None
        wanted = tags.get("addr:street")
        if wanted:
            near = [i for i in tree.query(p.buffer(60)) if names[i] == wanted]
            if near:
                street = min((lines[i] for i in near), key=p.distance)
        if street is None:
            i = tree.query_nearest(p, max_distance=25)
            street = lines[i[0]] if len(i) else None
        if street is None:
            skipped["no street near"] += 1
            continue
        foot = nearest_points(street, p)[0]
        if foot.distance(p) < 2:
            skipped["on the street itself"] += 1
            continue
        cells[f"{int(foot.x // CELL)}_{int(foot.y // CELL)}"].append(
            [round(foot.x, 1), round(foot.y, 1), round(p.x, 1), round(p.y, 1), cp[:6], co[:5]])
        count += 1
    print(f"{count} addresses in {len(cells)} cells")
    print("left out:", ", ".join(f"{k} {v}" for k, v in skipped.most_common()) or "none")
    return cells


if __name__ == "__main__":
    area = sys.argv[1] if len(sys.argv) > 1 else "centrum"
    base = OUT / f"{area}_now"
    folder = base / "addresses"
    if folder.exists():
        shutil.rmtree(folder)
    folder.mkdir(parents=True)
    cells = addresses(area)
    total = 0
    for key, rows in cells.items():
        rows.sort()
        path = folder / f"{key}.json"
        path.write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
        total += path.stat().st_size
    (base / "addresses.json").write_text(json.dumps({"cell": CELL, "cells": sorted(cells)}, separators=(",", ":")), encoding="utf-8")
    print("wrote", base / "addresses.json", "and", len(cells), "cells,", total, "bytes")
