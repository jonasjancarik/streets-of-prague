"""Fit a local level-zero road profile on Italská, just north of Vozová.

Reads assembled tiles and the existing DTM ZPS survey cache. The experimental
road-profile.json is a separate, map-versioned file; the ordinary tiles, terrain,
structures and assembly are unchanged. Source: datový podklad © IPR Praha (CC BY 4.0).
"""

import argparse
import gzip
import json
import pickle
from pathlib import Path

import numpy as np
import shapely
from pyproj.enums import TransformDirection
from scipy.optimize import least_squares
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import substring

import dtm_heights
from ipr_buildings import krovak_to_local
from ipr_terrain import sampler
from layers import write
from osm_area import OUT

# The geometry is deliberately chosen and reviewed for one street. A broad, flat
# cross-section for the whole city would erase genuinely banked or crowned roads.
EDGE = "1449046826>2245320227>0"
SEED_TILE = "61_62"
START, END = 13.0, 63.0  # metres along the edge from the Vozová junction
HALF, SHOULDER, TAPER = 5.5, 2.0, 6.0
CHECK_EVERY = 1.0
KERB_MATCH = 1.0
OTHER_LEVEL = 1.2  # m from existing road heights: don't use a second surface
MAX_BANK = 0.08


def polygons(rings):
    return [Polygon(p[0], p[1:]).buffer(0) for p in rings if p and len(p[0]) >= 3]


def edge_key(edge):
    a, b, n = edge["id"].split(">")
    return *sorted((a, b)), n


def frames(data, index, axis, normal):
    width = HALF + SHOULDER
    a, b = np.asarray(axis.coords)
    footprint = Polygon([a - width * normal, b - width * normal, b + width * normal, a + width * normal])
    ox, oy = index["origin"]
    tile = index["tile"]
    tiles = {}
    forbidden = []
    roads = []
    target = edge_key({"id": EDGE})
    minx, miny, maxx, maxy = footprint.bounds
    for i, j, *_ in index["tiles"]:
        x, y = i * tile - ox, j * tile - oy
        if x > maxx or x + tile < minx or y > maxy or y + tile < miny:
            continue
        if not footprint.intersects(box(x, y, x + tile, y + tile)):
            continue
        key = f"{i}_{j}"
        t = json.loads((data / "tiles" / f"{key}.json").read_text())
        tiles[key] = t
        for step in t.get("terraces", []) + t.get("structures", []):
            forbidden += polygons(step["polys"])
        # The tunnel's depth-only terrain still uses the old lattice. Exclude such
        # tiles in the pilot even when the mapped tunnel itself is well away.
        if any(s["kind"] == "tunnel" for s in t.get("structures", [])):
            raise ValueError(f"{key} has a tunnel")
        forbidden += polygons(t["areas"].get("water", []))
        forbidden += polygons(b["rings"] for b in t["buildings"])
        forbidden += [LineString(e["pts"]) for e in t["rails"] + t["walls"] if len(e["pts"]) >= 2]
        for e in t["drive"]:
            if edge_key(e) != target:
                forbidden.append(LineString(e["pts"]).buffer((e.get("width") or 6) / 2))
        for kind in ("road", "sett"):
            roads += polygons(t["roads"].get(kind, []))
    if not tiles or not shapely.union_all([box(*t["box"]) for t in tiles.values()]).buffer(1e-6).covers(footprint):
        raise ValueError("the pilot must lie entirely inside built tiles")
    if any(footprint.intersects(f) for f in forbidden):
        raise ValueError("the pilot intersects water, a building, a wall, rail, another street or a mapped level")
    return tiles, footprint, shapely.union_all(roads)


def terrain_at(data, index, tiles):
    hm = {}
    labels = {}
    n, step = index["terrain"]["n"], index["terrain"]["step"]
    for key, t in tiles.items():
        p = data / "tiles" / f"{key}.height.bin"
        raw = p.read_bytes() if p.is_file() else gzip.decompress(p.with_suffix(".bin.gz").read_bytes())
        ij = t["i"], t["j"]
        hm[ij] = (np.frombuffer(raw, "<u2", n * n).astype(float) / 10 + 100).reshape(n, n)
        if len(raw) == 3 * n * n:
            labels[ij] = np.frombuffer(raw, np.uint8, n * n, offset=2 * n * n).reshape(n, n)
    return sampler(hm, n - 1, index["tile"], step, *(-np.asarray(index["origin"])), labels)


def local_survey(index, footprint, snapshot):
    west, south, east, north = index["bbox_wgs84"]
    local = f"+proj=tmerc +lat_0={(south + north) / 2} +lon_0={(west + east) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    to_local = krovak_to_local(local)
    a, b, c, d = footprint.bounds
    inv = TransformDirection.INVERSE
    lon, lat = to_local.to_local.transform([a, a, c, c], [b, d, b, d], direction=inv)
    x, y = to_local.to_wgs.transform(lon, lat, direction=inv)
    x0, y0, x1, y1 = min(x), min(y), max(x), max(y)
    # Use the normal project's cached original 3D survey lines. Only retain lines
    # within this strip before projecting or fitting. Wall lines are separate.
    if snapshot:
        # An explicitly chosen, trusted local snapshot avoids reparsing the whole
        # city after cloning its cache (the normal cache checks file identities).
        with snapshot.open("rb") as source:
            saved = pickle.load(source)
        if saved["key"][0] != dtm_heights.VERSION or saved["key"][2] != index["bbox_wgs84"]:
            raise ValueError("survey snapshot does not match the map coverage or format")
        lines, walls = saved["lines"], saved["walls"]
    else:
        _, lines, walls = dtm_heights.survey(index["area"], index["bbox_wgs84"])

    def nearby(line):
        x, y = line[:, :2].T
        return x.min() < x1 + 4 and x.max() > x0 - 4 and y.min() < y1 + 4 and y.max() > y0 - 4

    def project(line):
        x, y = to_local.transform(*line[:, :2].T)
        return np.column_stack([x, y, line[:, 2:]])

    # Raw surveyed walls can catch places where the terrain classified no step.
    if any(LineString(project(w)).intersects(footprint) for w in walls if nearby(w)):
        raise ValueError("a surveyed wall crosses the pilot")
    return [project(line) for line in lines if nearby(line)]


def survey_samples(axis, tangent, normal, road, lines, at):
    origin = np.asarray(axis.coords[0])
    candidates = []
    for line in lines:
        xy = line[:, :2] - origin
        values = np.column_stack([xy @ tangent, xy @ normal, line[:, 2]])
        candidates.extend(zip(values[:-1], values[1:]))
    if not candidates:
        raise ValueError("no surveyed kerbs near the pilot")
    a, b = np.asarray(candidates).transpose(1, 0, 2)
    sa, sb = a[:, 0], b[:, 0]
    result = []
    for k, station in enumerate(np.arange(CHECK_EVERY / 2, axis.length, CHECK_EVERY)):
        centre = origin + station * tangent
        section = LineString([centre - 12 * normal, centre + 12 * normal])
        pieces = shapely.get_parts(road.intersection(section))
        connected = [p for p in pieces if p.geom_type == "LineString" and p.distance(Point(centre)) < 1e-5]
        if not connected:
            raise ValueError(f"no continuous carriageway at {station:g} m")
        edge = np.sort((np.asarray(connected[0].coords)[[0, -1]] - centre) @ normal)
        if np.any(np.abs(edge) < 2.5) or np.any(np.abs(edge) > HALF + 0.5):
            raise ValueError(f"carriageway outside the reviewed width at {station:g} m: {edge}")
        hits = (((sa <= station) & (sb > station)) | ((sb <= station) & (sa > station)))
        t = (station - sa[hits]) / (sb[hits] - sa[hits])
        obs = a[hits, 1:] + t[:, None] * (b[hits, 1:] - a[hits, 1:])
        paired = []
        for target in edge:
            options = obs[np.abs(obs[:, 0] - target) <= KERB_MATCH]
            if not len(options):
                break
            xy = centre + options[:, :1] * normal
            same = options[np.abs(at(*xy.T) - options[:, 1]) <= OTHER_LEVEL]
            if not len(same):
                break
            best = same[np.argmin(np.abs(same[:, 0] - target))]
            # Close alternatives at another height are evidence of ambiguity.
            close = np.abs(same[:, 0] - best[0]) <= 0.3
            if np.ptp(same[close, 1]) > 0.45:
                break
            paired.append(best)
        if len(paired) == 2:
            result.append((k, station, *paired))
    return result


def fit_profile(length, samples):
    """Use equal weights for the two kerbs; reserve every fourth station for checking."""
    train = [(s, l, r) for k, s, l, r in samples if k % 4 != 1]
    if len(train) < max(10, 0.5 * length / CHECK_EVERY):
        raise ValueError(f"too few pairs of reliable kerb observations ({len(train)})")
    stations, across, height = np.array([
        (s, cross, h) for s, l, r in train for cross, h in (l, r)
    ]).T
    u = stations / length
    if np.diff(np.r_[0, stations, length]).max() > 8.0:
        raise ValueError("an unmeasured stretch of road is longer than 8 m")
    X = np.column_stack([np.ones_like(u), u, u**2, u**3, across])
    initial = np.linalg.lstsq(X, height, rcond=None)[0]
    fit = least_squares(lambda coeff: X @ coeff - height, initial, loss="soft_l1", f_scale=0.12).x
    if abs(fit[4]) > MAX_BANK:
        raise ValueError("measured banking exceeds the pilot's supported range")
    return fit, len(train)


def generate(data, survey_snapshot=None):
    index = json.loads((data / "index.json").read_text())
    built = index["built"]
    if index["area"] != "praha":
        raise ValueError("this pilot is specific to the Prague map")
    seed = json.loads((data / "tiles" / f"{SEED_TILE}.json").read_text())
    edge = next((e for e in seed["drive"] if e["id"] == EDGE), None)
    if not edge or edge["name"] != "Italská" or any(edge.get(f) for f in ("level", "levels", "bridge", "tunnel")):
        raise ValueError("expected the same at-grade Italská edge")
    full = LineString(edge["pts"])
    centreline = substring(full, START, END)
    axis = LineString([centreline.coords[0], centreline.coords[-1]])
    if full.length < END + 8 or axis.hausdorff_distance(centreline) > 0.5:
        raise ValueError("edge changed or isn't straight enough for this pilot")
    a, b = np.asarray(axis.coords)
    tangent = (b - a) / axis.length
    normal = np.array([-tangent[1], tangent[0]])
    tiles, footprint, road = frames(data, index, axis, normal)
    terrain = terrain_at(data, index, tiles)
    samples = survey_samples(axis, tangent, normal, road, local_survey(index, footprint, survey_snapshot), terrain)
    fit, train = fit_profile(axis.length, samples)
    p = {"from": a.tolist(), "to": b.tolist(), "half": HALF, "shoulder": SHOULDER, "taper": TAPER,
         "elevation": fit[:4].tolist(), "cross": fit[4]}
    profile = {"version": 1, "area": index["area"], "built": built, "tiles": sorted(tiles), "profile": p}
    held = [
        {"station": s, "points": [[*(a + s * tangent + cross * normal), height] for cross, height in (l, r)]}
        for k, s, l, r in samples if k % 4 == 1 and TAPER < s < axis.length - TAPER
    ]
    source_heights = [h for _, _, l, r in samples for _, h in (l, r)]
    return profile, {"edge": EDGE, "trainingPairs": train, "heldOutPairs": held,
                     "sourceElevations": [min(source_heights), max(source_heights)]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=OUT / "praha_now", help="directory containing an assembled Prague map")
    parser.add_argument("--write", action="store_true", help="write the optional road-profile.json beside index.json")
    parser.add_argument("--survey-snapshot", type=Path, help="read a trusted, previously built DTM ZPS heights pickle")
    parser.add_argument("--report", type=Path, help="write held-out kerb observations to a local JSON file")
    args = parser.parse_args()
    profile, report = generate(args.data, args.survey_snapshot)
    print(json.dumps({**profile, "trainingPairs": report["trainingPairs"], "heldOutPairs": len(report["heldOutPairs"]),
                      "sourceElevations": report["sourceElevations"]}, indent=2))
    if args.write:
        built = json.loads((args.data / "index.json").read_text())["built"]
        if built != profile["built"]:
            raise ValueError("map changed during the fit; rerun on a stable build")
        write(args.data / "road-profile.json", json.dumps(profile, indent=2) + "\n")
    if args.report:
        write(args.report, json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
