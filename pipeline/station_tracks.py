"""Build the Hlavní nádraží rail and platform preview from the local OSM extract."""

import argparse
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from pyproj import Transformer
from shapely import make_valid, union_all
from shapely.geometry import LineString, box, shape
from shapely.ops import transform

from bridge_surface_preview import local_crs
from layers import write
from osm_area import _coords, _lines, _polys, _rings
from road_profile import polygons

# The two approaches, from the Vinohrady tunnel portals to Nové spojení.
STATION = (14.4316, 50.0777, 14.4445, 50.0895)
PLATFORMS = box(14.4325, 50.0795, 14.4395, 50.0840)


def station_features(osm):
    with TemporaryDirectory() as tmp:
        clip, tags = (Path(tmp) / f"{name}.osm.pbf" for name in ("clip", "tags"))
        subprocess.run(["osmium", "extract", "-s", "smart", "-b", ",".join(map(str, STATION)),
                        osm, "-o", clip], check=True)
        subprocess.run(["osmium", "tags-filter", clip, "w/railway=rail",
                        "wr/railway=platform", "-o", tags], check=True)
        raw = subprocess.check_output(["osmium", "export", tags, "-f", "geojson",
                                       "--geometry-types", "linestring,polygon"])
    return json.loads(raw)["features"]


def deck_tracks(raised, outlines, surveyed):
    # Where decks overlap, use only the part that belongs to one unambiguous
    # outline. OSM's bridge tag is required for this fallback.
    found = []
    for level, outline in outlines.items():
        other = union_all([p for key, p in outlines.items() if key != level])
        unique = outline.difference(other)
        parts = [part for line in raised if line.intersects(unique)
                 for part in _lines(line.intersection(unique))]
        covered = union_all([line.buffer(.2) for line in parts])
        for track in surveyed:
            if track["level"] == level:
                parts.extend(_lines(LineString(track["pts"]).difference(covered)))
        found.extend({"level": level, "pts": _coords(line)} for line in parts if line.length > .05)
    return found


def build(index, features, bridge, tiles_dir):
    project = Transformer.from_crs("EPSG:4326", local_crs(index), always_xy=True).transform
    limits = transform(project, box(*STATION))
    rails, raised, platforms = [], [], []
    for feature in features:
        tags = feature["properties"]
        geom = shape(feature["geometry"])
        if (tags.get("railway") == "rail" and geom.geom_type == "LineString"
                and tags.get("tunnel", "no") == "no"
                and tags.get("covered", "no") == "no" and not tags.get("layer", "").startswith("-")):
            tracks = rails if tags.get("bridge", "no") == "no" else raised
            tracks.extend(_lines(transform(project, geom).intersection(limits)))
        elif (tags.get("railway") == "platform" and tags.get("train") == "yes"
              and geom.geom_type in ("Polygon", "MultiPolygon") and PLATFORMS.covers(geom.centroid)):
            platforms.append(make_valid(transform(project, geom)))
    if not rails or not platforms:
        raise ValueError("Missing station tracks or platforms in the OSM extract")
    platforms = union_all(platforms)
    # Clip the real outline separately so a tile seam never becomes a platform edge.
    edges = platforms.boundary
    ox, oy = index["origin"]
    size = index["tile"]
    x0, y0, x1, y1 = limits.bounds
    tiles = {}
    for i in range(int((x0+ox)//size), int((x1+ox)//size)+1):
        for j in range(int((y0+oy)//size), int((y1+oy)//size)+1):
            key = f"{i}_{j}"
            extent = box(i*size-ox, j*size-oy, (i+1)*size-ox, (j+1)*size-oy)
            # The surveyed deck can extend beyond the bridge tag. Suppress the
            # matching alignment below it, while keeping nearby parallel tracks.
            path = tiles_dir / f"{key}.json"
            if not path.is_file():
                continue
            tile = json.loads(path.read_text())
            overrides = bridge["decks"].get(key, {})
            outlines = {s["level"]: union_all(polygons(overrides.get(str(s["level"]), s["polys"])))
                        for s in tile.get("structures", []) if s["kind"] == "bridge"}
            elevated = deck_tracks(raised, outlines, bridge["tracks"].get(key, []))
            excluded = union_all([LineString(t["pts"]).buffer(.2) for t in elevated])
            lines = [piece for rail in rails if rail.intersects(extent)
                     for piece in _lines(rail.intersection(extent).difference(excluded))]
            surfaces = _polys(platforms.intersection(extent))
            borders = _lines(edges.intersection(extent))
            if lines or surfaces or borders or elevated:
                tiles[key] = {"rails": [_coords(line) for line in lines if line.length > .05],
                              "platforms": [_rings(p) for p in surfaces if p.area > .01],
                              "platformEdges": [_coords(line) for line in borders if line.length > .05],
                              "bridgeTracks": elevated}
    return {"version": 1, "area": index["area"], "built": index["built"], "tiles": tiles}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path)
    parser.add_argument("osm", type=Path)
    args = parser.parse_args()
    index = json.loads((args.data / "index.json").read_text())
    bridge = json.loads((args.data / "bridge-surfaces.json").read_text())
    if (bridge["area"], bridge["built"]) != (index["area"], index["built"]):
        parser.error("bridge-surfaces.json must match this map build")
    result = build(index, station_features(args.osm), bridge, args.data / "tiles")
    write(args.data / "station-tracks.json", json.dumps(result, separators=(",", ":")))
    print(f"Wrote station tracks and platforms in {len(result['tiles'])} tiles")


if __name__ == "__main__":
    main()
