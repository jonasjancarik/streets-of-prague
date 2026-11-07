"""Fit a surveyed asphalt corridor and feather it into a screened road preview."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

import numpy as np
import shapely
from pyproj.enums import TransformDirection
from scipy.interpolate import BSpline
from scipy.optimize import least_squares
from shapely.geometry import LineString, box

from dtm_heights import _along
from layers import write
from road_profile import edge_key, polygons, terrain_at
from road_surfaces import Map, smooth


def fit_corridor(city, edge):
    pts = np.asarray(edge["pts"])
    line = LineString(pts)
    segments = np.diff(pts, axis=0)
    lengths = np.linalg.norm(segments, axis=1)
    longest = lengths.argmax()
    if lengths[longest] == 0:
        raise ValueError("corridor has no length")
    tangent = segments[longest] / lengths[longest]
    normal = np.array([-tangent[1], tangent[0]])
    extent = (pts[-1] - pts[0]) @ tangent
    if extent < 30 or extent < .85 * line.length:
        raise ValueError("corridor needs one dominant direction")
    zone = line.buffer(5.7)
    footprint = zone.buffer(2.5)
    bounds = np.r_[np.floor(footprint.bounds[:2]), np.ceil(footprint.bounds[2:])].astype(int)
    if max(bounds[2:] - bounds[:2]) >= 128:
        raise ValueError("corridor exceeds the supported patch grid")
    tiles = city.tiles(bounds)
    if not shapely.union_all([box(*t["box"]) for t in tiles.values()]).buffer(.02).covers(footprint):
        raise ValueError("corridor is outside the built tiles")
    for tile in tiles.values():
        if any(s["kind"] == "tunnel" for s in tile.get("structures", [])):
            raise ValueError("tile uses a tunnel depth mask")
        protected = [p for s in tile.get("terraces", []) + tile.get("structures", []) for p in polygons(s["polys"])]
        protected += polygons(tile["areas"].get("water", []))
        protected += [LineString(r["pts"]) for r in tile["rails"] if len(r["pts"]) > 1]
        if any(footprint.intersects(p) for p in protected):
            raise ValueError("corridor reaches a step, structure, rail or water")
    if len(city.wall_tree.query(footprint, predicate="intersects")):
        raise ValueError("corridor reaches a surveyed wall")
    houses = shapely.union_all([p for t in tiles.values() for p in polygons(b["rings"] for b in t["buildings"])
                               if p.intersects(footprint)])
    asphalt = shapely.union_all([p for t in tiles.values() for p in polygons(t["roads"].get("road", []))
                                if p.intersects(zone)])
    if not asphalt.buffer(.35).covers(line):
        raise ValueError("corridor is not continuously paved")
    road = asphalt.intersection(zone)
    at = terrain_at(city.data, city.index, tiles)
    lines = [city.lines[city.line_offsets[k]:city.line_offsets[k+1]]
             for k in city.line_tree.query(zone, predicate="intersects")]
    samples = [_along(l, 1.) for l in lines if np.isfinite(l).all()]
    if not samples:
        raise ValueError("no surveyed road edges")
    xyz = np.concatenate(samples)
    points = shapely.points(xyz[:, :2])
    xyz = xyz[shapely.covers(zone, points) & shapely.dwithin(points, asphalt.boundary, .65)]
    _, unique = np.unique(np.round(xyz[:, :2], 1), axis=0, return_index=True)
    xyz = xyz[unique]
    old = at(*xyz[:, :2].T)
    station = (xyz[:, :2] - pts[0]) @ tangent / extent
    across = (xyz[:, :2] - pts[0]) @ normal
    valid = (station >= 0) & (station <= 1) & np.isfinite(old) & (np.abs(old - xyz[:, 2]) <= 1.8)
    xyz, old, station, across = (a[valid] for a in (xyz, old, station, across))
    cells = np.floor(xyz[:, :2] / 2).astype(int)
    held = (cells[:, 0] + 2*cells[:, 1]) % 5 == 0
    for side in (across < 0, across >= 0):
        along = np.sort(station[side & ~held])
        if len(along) < 15 or (np.diff(np.r_[0, along, 1]) * extent).max() > 12:
            raise ValueError("unsupported stretch of kerb")
    if held.sum() < 10:
        raise ValueError("insufficient withheld heights")

    # A smooth grade with a few knots, and crossfall that can change near the ends.
    knots = [0]*4 + [.19, .49, .81] + [1]*4
    bank = [0]*2 + [.17, .85] + [1]*2
    def design(s, d):
        grade = BSpline.design_matrix(s, knots, 3).toarray()
        crossfall = BSpline.design_matrix(s, bank, 1).toarray()
        return np.column_stack([grade, crossfall * d[:, None]])
    X = design(station, across)
    if np.linalg.cond(X[~held]) > 50:
        raise ValueError("survey does not constrain the corridor grade and crossfall")
    def residual(c):
        return np.r_[X[~held] @ c - xyz[~held, 2], np.diff(c[:7], 2) * .35, c[7:] * .6]
    fit = least_squares(residual, np.r_[np.full(7, np.median(xyz[:, 2])), np.zeros(4)],
                        loss="soft_l1", f_scale=.08).x
    err = np.abs(X @ fit - xyz[:, 2])
    old_error = np.abs(old[held] - xyz[held, 2]).mean()
    if err[held].mean() > min(.20, old_error) or np.quantile(err, .9) > .35 or abs(fit[7:]).max() > .15:
        raise ValueError("fit disagrees with the survey")

    x0, y0, x1, y1 = bounds
    xs, ys = np.meshgrid(np.arange(x0, x1+1), np.arange(y0, y1+1))
    xy = np.column_stack([xs.ravel(), ys.ravel()])
    grid = shapely.points(xy)
    along = shapely.line_locate_point(line, grid)
    ends = np.minimum(along / 12, (line.length - along) / 10)
    weight = smooth(ends) * smooth((2.5 - shapely.distance(grid, road)) / 2.5)
    weight *= smooth((6 - shapely.distance(grid, line)) / 2)
    if not houses.is_empty:
        weight *= smooth(shapely.distance(grid, houses) / 2)
    encoded = np.round(255 * weight).astype(int)
    encoded.reshape(xs.shape)[[0, -1], :] = 0
    encoded.reshape(xs.shape)[:, [0, -1]] = 0
    grid_s = np.clip((xy - pts[0]) @ tangent / extent, 0, 1)
    heights = design(grid_s, (xy - pts[0]) @ normal) @ fit
    active = encoded > 0
    delta = np.abs(heights[active] - at(*xy[active].T)) * encoded[active] / 255
    if not len(delta) or not np.isfinite(delta).all() or delta.max() > 1.8:
        raise ValueError("unsupported height change")
    return dict(id=f"corridor:{edge['id']}", kind="corridor", box=bounds.tolist(),
                n=[xs.shape[1], xs.shape[0]], weights=encoded.tolist(),
                heights=heights.round(4).tolist(), tiles=sorted(tiles)), dict(
                    length=line.length, observations=len(xyz), held=int(held.sum()),
                    residual=float(err[held].mean()), oldResidual=float(old_error),
                    maxCrossfall=float(abs(fit[7:]).max()), maxChange=float(delta.max()))


def collect_candidates(city, current, rows):
    """Fit flagged ground-level asphalt roads, giving the roughest first choice."""
    eligible = {edge_key(r): max(abs(r["bump"]) / .15, abs(r["twist"]) / 9, abs(r["lean"]) / 15)
                for r in rows if r.get("level") in (None, 0) and 30 <= r["length"] <= 160
                and r["hw"] in {"residential", "unclassified", "living_street", "tertiary", "secondary", "primary", "service"}}
    eligible = {k: v for k, v in eligible.items() if v >= 1}
    edges = {}
    for i, j, *_ in city.index["tiles"]:
        for e in city.tile(i, j).get("drive", []):
            if len(e["pts"]) < 2 or any(e.get(k) for k in ("bridge", "tunnel", "level", "levels")):
                continue
            key = edge_key(e)
            if key not in eligible:
                continue
            if key not in edges or len(e["pts"]) > len(edges[key]["pts"]):
                edges[key] = e
    occupied = [box(*p["box"]) for p in current["patches"] if "heights" in p]
    cases, patches = [], []
    rejected = Counter()
    for key, edge in sorted(edges.items(), key=lambda kv: (-eligible[kv[0]], kv[0])):
        line = LineString(edge["pts"])
        corridor = line.buffer(9)
        if any(corridor.intersects(b) for b in occupied):
            rejected["overlaps another corridor"] += 1
            continue
        try:
            patch, report = fit_corridor(city, edge)
            footprint = box(*patch["box"])
            if any(footprint.intersects(b) for b in occupied):
                raise ValueError("overlaps another corridor")
        except ValueError as exc:
            rejected[str(exc)] += 1
            continue
        # Measure other ground roads the fit can reach, plus the target's ends.
        # The masks fade before the box, so this deliberately includes a margin.
        neighbourhood = footprint.buffer(8)
        nearby = {edge_key(e): e for t in city.tiles(neighbourhood.bounds).values() for e in t.get("drive", [])
                  if len(e["pts"]) > 1 and not any(e.get(k) for k in ("bridge", "tunnel", "level", "levels"))}
        guard = []
        affected = [edge["id"]]
        for other_key, other in nearby.items():
            if other_key == key:
                continue
            parts = shapely.get_parts(LineString(other["pts"]).intersection(neighbourhood))
            used = False
            for part in parts:
                if part.geom_type != "LineString" or part.length < .5:
                    continue
                used = True
                guard.append(dict(id=other["id"], width=other["width"], kerb=other.get("kerb"), pts=list(part.coords)))
            if used:
                affected.append(other["id"])
        lon, lat = city.tf.to_local.transform(*line.interpolate(.5, normalized=True).coords[0],
                                              direction=TransformDirection.INVERSE)
        patches.append(patch)
        occupied.append(footprint.buffer(8))
        cases.append(dict(edge=edge["id"], id=patch["id"], at=[lat, lon], guard=guard, affected=affected,
                          name=edge.get("name", ""), tiles=patch["tiles"], **report))
    return patches, dict(flagged=len(eligible), located=len(edges), rejected=dict(rejected), cases=cases)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for flag in ("data", "survey-snapshot", "current", "out", "report"):
        ap.add_argument(f"--{flag}", type=Path, required=True)
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--edge")
    source.add_argument("--baseline-roads", type=Path, help="citywide flatness report for the current sidecar")
    ap.add_argument("--tile", help="assembled tile containing a single requested edge")
    args = ap.parse_args()
    city = Map(args.data, args.survey_snapshot)
    raw = args.current.read_bytes()
    current = json.loads(raw)
    if (current.get("version"), current.get("area"), current.get("built")) != (
            1, city.index["area"], city.index["built"]):
        ap.error("screened surfaces do not match this map build")
    if args.baseline_roads:
        baseline = json.loads(args.baseline_roads.read_text())
        digest = hashlib.sha256(raw).hexdigest()
        if baseline.get("built") != current["built"] or baseline.get("patchDigest") != digest:
            ap.error("baseline road report does not match the current sidecar")
        patches, report = collect_candidates(city, current, baseline["rows"])
        write(args.out, json.dumps({**current, "patches": [*patches, *current["patches"]]}, separators=(",", ":")) + "\n")
        write(args.report, json.dumps({**report, "built": current["built"], "baselineDigest": digest}, indent=2) + "\n")
        print(f"{len(patches)} proposals from {report['located']} mapped stretches ({report['flagged']} flagged)")
        return
    if not args.tile:
        ap.error("--tile is required with --edge")
    tile = city.tile(*map(int, args.tile.split("_")))
    edge = next((e for e in tile.get("drive", []) if e["id"] == args.edge), None)
    if not edge or len(edge["pts"]) < 2 or any(edge.get(k) for k in ("bridge", "tunnel", "level", "levels")):
        ap.error("expected a ground-level edge in the selected tile")
    patch, report = fit_corridor(city, edge)
    if any(p["id"] == patch["id"] for p in current["patches"]):
        ap.error("current preview already includes this corridor")
    write(args.out, json.dumps({**current, "patches": [patch, *current["patches"]]}, separators=(",", ":")) + "\n")
    write(args.report, json.dumps(report, indent=2) + "\n")
    print(report)


if __name__ == "__main__":
    main()
