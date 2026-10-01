"""Count square surface decisions from an area's OSM extract.

    pipeline/.venv/bin/python pipeline/square_report.py centrum \
      pipeline/.cache/osm/centrum.osm.pbf

Uses the same grouping and majority rule as osm_area.extract(), including the
ground-level way exclusions. This report reads source OSM and writes no map data.
"""

import argparse
import json
import subprocess
import tempfile
from collections import Counter
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import box, shape

from osm_area import AREAS, _float, _lines, _polys, _square_from_ways, _square_surface


def report(area, pbf):
    w, s, e, n = AREAS[area]
    crs = f"+proj=tmerc +lat_0={(s+n)/2} +lon_0={(w+e)/2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    tf = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)
    clip = box(x0, y0, x1, y1)
    squares, ways = [], []
    with tempfile.TemporaryDirectory() as tmp:
        exported = Path(tmp) / "features.geojsonseq"
        subprocess.run(["osmium", "export", "--geometry-types=linestring,polygon",
                        "-u", "type_id", "-f", "geojsonseq", "-o", str(exported), str(pbf)], check=True)
        for line in exported.open():
            item = json.loads(line.lstrip("\x1e"))
            tags = item["properties"]
            hw = tags.get("highway")
            square = hw == "pedestrian" or tags.get("area:highway") or tags.get("place") == "square"
            way = hw in ("pedestrian", "footway", "living_street", "service")
            if not square and not way:
                continue
            geom = shape(item["geometry"])
            if geom.is_empty:
                continue
            geom = shapely.transform(geom, lambda xy: np.column_stack(tf.transform(xy[:, 0], xy[:, 1])))
            if not geom.intersects(clip):
                continue
            if geom.geom_type in ("LineString", "MultiLineString") and way:
                if (tags.get("footway") == "crossing" or tags.get("tunnel") not in (None, "no")
                        or (_float(tags.get("layer")) or 0) != 0):
                    continue
                ways.extend((part, _square_surface(tags.get("surface"))) for part in _lines(geom.intersection(clip)))
            elif geom.geom_type in ("Polygon", "MultiPolygon") and square:
                squares.extend((part, tags.get("surface"), tags.get("name"), item.get("id"))
                               for part in _polys(geom.buffer(0).intersection(clip)))
    tree = STRtree([line for line, _ in ways]) if ways else None
    counts = Counter()
    undecided = []
    named = []
    for poly, surface, name, osm_id in squares:
        own = _square_surface(surface) if surface is not None else None
        inherited = _square_from_ways(poly, ways, tree) if surface is None else None
        kind = own or inherited or "square"
        rule = "explicit" if own else "inherited" if inherited else "undecided"
        counts[(rule, kind)] += 1
        if name:
            named.append({"name": name, "id": osm_id, "rule": rule, "kind": kind,
                          "area_m2": round(poly.area)})
        if rule == "undecided" and name:
            undecided.append({"name": name, "id": osm_id, "area_m2": round(poly.area)})
    return {"area": area, "squares": len(squares), "rules": {
        rule: {kind: counts[(rule, kind)] for kind in ("square", "square_setts", "square_asphalt", "square_loose") if counts[(rule, kind)]}
        for rule in ("explicit", "inherited", "undecided")},
        "named_undecided": sorted(undecided, key=lambda item: -item["area_m2"]),
        "named_decisions": sorted(named, key=lambda item: -item["area_m2"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("area", choices=AREAS)
    parser.add_argument("pbf", type=Path)
    args = parser.parse_args()
    print(json.dumps(report(args.area, args.pbf), indent=2, ensure_ascii=False))
