"""Paid-parking sections (zóny placeného stání) from TSK Praha for the driving game:
how many spaces each street section has and how full it is by day and by night.

    uv run build_parking.py          # default: Újezd → public/data/ujezd_parking.json

Reads the monthly occupancy GeoJSON downloaded by ~/projects/parkovani-praha
(set PARKING_DATA to point elsewhere) and keeps the latest month for every
district that overlaps the area.
"""

import json
import os
import re
import sys
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import box, shape
from shapely.ops import transform

from osm_area import AREAS, OUT, _polys, _rings

SRC = Path(os.environ.get("PARKING_DATA", Path.home() / "projects/parkovani-praha/data/downloaded/parked_cars"))
NAME = re.compile(r"^(P\d+)-OB_(\d{6})([DN])_NA\.json$")


def latest(files):
    """{district: (month, {'D': path, 'N': path})} for the newest month with both."""
    by = {}
    for f in files:
        m = NAME.match(f.name)
        if m:
            by.setdefault(m[1], {}).setdefault(m[2], {})[m[3]] = f
    out = {}
    for dist, months in by.items():
        full = [k for k, v in months.items() if "D" in v and "N" in v]
        if full:
            out[dist] = (max(full), months[max(full)])
    return out


def main(area: str = "ujezd") -> None:
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
        always_xy=True,
    )
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)
    clip = box(x0, y0, x1, y1)
    bbox = box(w, s, e, n)

    sections, months = [], set()
    for dist, (month, f) in sorted(latest(SRC.glob("P*-OB_*_NA.json")).items()):
        day = json.loads(f["D"].read_text())["features"]
        night = {ft["properties"]["CODE"]: ft["properties"] for ft in json.loads(f["N"].read_text())["features"]}
        for ft in day:
            g = shape(ft["geometry"])
            if not g.intersects(bbox):
                continue
            p = ft["properties"]
            local = transform(tf.transform, g).buffer(0)
            inside = local.intersection(clip)
            if inside.is_empty:
                continue
            months.add(month)
            sections.append({
                "code": p["CODE"],
                "category": p.get("CATEGORY"),  # RES resident, MIX mixed, VIS visitor
                "spaces": p.get("CELKEM_PS") or 0,
                "occDay": p.get("Obs"),        # % of spaces taken, can exceed 100
                "occNight": night.get(p["CODE"], {}).get("Obs"),
                "inside": round(inside.area / local.area, 3),  # share of the section in the area
                "polys": [_rings(q) for q in _polys(inside)],
            })

    out = {"area": area, "source": "TSK Praha, zóny placeného stání", "months": sorted(months), "sections": sections}
    path = OUT / f"{area}_parking.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    spaces = sum(x["spaces"] * x["inside"] for x in sections)
    print(f"{len(sections)} sections, ~{spaces:.0f} spaces inside the area, months {sorted(months)} → {path.name}")


if __name__ == "__main__":
    main(*sys.argv[1:])
