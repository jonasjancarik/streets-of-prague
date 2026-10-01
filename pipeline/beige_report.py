"""Measure plain ground in built tiles and its overlap with one DTM district.

Run from the repository root, for example::

    pipeline/.venv/bin/python pipeline/beige_report.py centrum \
      --dtm-package pipeline/.cache/dtm/ZPS_OPL/VS_CZ010_MOMC_500054_20260831_ZPS_OPL.gpkg.zip

The DTM split is measured against OSM ground before the new DTM area layers, so
the before and after reports remain comparable. All areas are square metres in
the area's local projected CRS, converted to hectares for the report.
"""

import argparse
import json
import sqlite3
import tempfile
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest
from shapely import STRtree
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

import dtm
from osm_area import OUT

GREEN = {"park", "garden", "wood", "orchard"}
DTM_CLASSES = {
    "010000018903": "yard", "010000000703": "sidewalk",
    "010000021503": "green", "010000020903": "garden",
    "010000015203": "pitch", "010000021103": "wood",
}


def polygons(rings):
    out = []
    for part in rings:
        if part and len(part[0]) >= 3:
            poly = Polygon(part[0], part[1:])
            if not poly.is_empty:
                out.append(shapely.make_valid(poly))
    return unary_union(out) if out else Polygon()


def tile_masks(tile):
    """The tile, OSM green, other OSM mapped ground, and plain ground."""
    bounds = box(*tile["box"])
    areas = tile.get("areas", {})
    green = unary_union([polygons(areas[k]) for k in GREEN if k in areas])
    mapped = unary_union(
        [polygons(v) for k, v in areas.items() if not k.startswith("dtm_")]
        + [polygons(v) for v in tile.get("roads", {}).values()]
        + [polygons([b["rings"]]) for b in tile.get("buildings", [])]
    )
    current = unary_union(
        [mapped] + [polygons(v) for k, v in areas.items() if k.startswith("dtm_")]
    )
    return bounds, green.intersection(bounds), mapped.intersection(bounds), bounds.difference(current)


def dtm_geometries(package, crs):
    """Ground-level shapes from a single DTM district, transformed as dtm.surfaces()."""
    to_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                  area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))
    to_local = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    found = defaultdict(list)
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(package) as archive:
        name = next(n for n in archive.namelist() if n.endswith(".gpkg"))
        db = sqlite3.connect(archive.extract(name, tmp))
        try:
            for (table,) in db.execute("select table_name from gpkg_contents"):
                kind = DTM_CLASSES.get(table.split("#")[-1][:12])
                if not kind:
                    continue
                cols = {row[1] for row in db.execute(f'pragma table_info("{table}")')}
                level = "UrovenUmisteniObjektuZPS" if "UrovenUmisteniObjektuZPS" in cols else "0"
                for blob, lv in db.execute(f'select shape, {level} from "{table}" where shape is not null'):
                    if int(lv or 0) != 0:
                        continue
                    geom = shapely.from_wkb(dtm._wkb(blob))
                    if geom is None or geom.is_empty:
                        continue
                    geom = shapely.transform(geom, lambda xy: np.column_stack(
                        to_local.transform(*to_wgs.transform(xy[:, 0], xy[:, 1]))))
                    found[kind].append(geom)
        finally:
            db.close()
    return found


def report(area, package=None, tiles_root=None):
    root = tiles_root or OUT / f"{area}_now" / "tiles"
    meta = json.loads((Path(__file__).parent / ".cache" / "layers" / area / "meta.json").read_text())
    masks = [tile_masks(json.loads(path.read_text())) for path in sorted(root.glob("*.json"))]
    total = sum(bounds.area for bounds, _, _, _ in masks)
    plain = sum(ground.area for _, _, _, ground in masks)
    result = {"area": area, "tiles": len(masks), "total_ha": round(total / 10000, 2),
              "plain_beige_ha": round(plain / 10000, 2)}
    if package:
        source = dtm_geometries(package, meta["crs"])
        split = {}
        for kind, geoms in source.items():
            tree = STRtree(geoms)
            counts = defaultdict(float)
            for bounds, green, mapped, _ in masks:
                hits = tree.query(bounds, predicate="intersects")
                if not len(hits):
                    continue
                surface = unary_union([geoms[i] for i in hits]).intersection(bounds)
                if surface.is_empty:
                    continue
                counts["area"] += surface.area
                counts["osm_green"] += surface.intersection(green).area
                counts["other_mapped"] += surface.intersection(mapped.difference(green)).area
                counts["pre_dtm_plain"] += surface.difference(mapped).area
            split[kind] = {key + "_ha": round(value / 10000, 2) for key, value in counts.items()}
        result["dtm_package"] = Path(package).name
        result["dtm_split"] = split
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("area")
    parser.add_argument("--dtm-package", type=Path)
    parser.add_argument("--tiles-root", type=Path, help="compare against a copied tile set")
    args = parser.parse_args()
    print(json.dumps(report(args.area, args.dtm_package, args.tiles_root), indent=2, ensure_ascii=False))
