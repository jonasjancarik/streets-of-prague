"""Fit local level-zero road surfaces from DTM road edges (© IPR Praha, CC BY 4.0).

The same small two-dimensional fit covers a bend or an intersection. Keep
the published terrain under the fitted surface and feather into it around
the patch. Existing retaining-wall labels still separate the two surfaces.
"""

import argparse
from functools import lru_cache
import json
import math
from pathlib import Path
import pickle

import numpy as np
import shapely
from scipy.optimize import least_squares
from shapely.geometry import LineString, Point, box

from dtm_heights import VERSION, _along
from ipr_buildings import krovak_to_local
from layers import write
from road_profile import edge_key, polygons, terrain_at


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def design(xy, bounds):
    lo = np.array(bounds[:2])
    s, t = (2 * (xy - lo) / (np.array(bounds[2:]) - lo) - 1).T
    return np.column_stack([np.ones(len(xy)), s, t, s*s, s*t, t*t])


class Map:
    def __init__(self, data, snapshot):
        self.data = data
        self.index = json.loads((data / "index.json").read_text())
        w, s, e, n = self.index["bbox_wgs84"]
        local = f"+proj=tmerc +lat_0={(s+n)/2} +lon_0={(w+e)/2} +k=1 +ellps=WGS84 +units=m"
        self.tf = krovak_to_local(local)
        self.keys = {(i, j) for i, j, *_ in self.index["tiles"]}
        with snapshot.open("rb") as f:
            survey = pickle.load(f)
        if survey["key"][0] != VERSION or survey["key"][2] != self.index["bbox_wgs84"]:
            raise ValueError("survey snapshot does not match this map area")
        self.lines = self.project(survey["lines"])
        self.walls = self.project(survey["walls"])
        self.line_tree = shapely.STRtree(shapely.linestrings(self.lines[:, :2], indices=self.line_ids))
        self.wall_tree = shapely.STRtree(shapely.linestrings(self.walls[:, :2], indices=self.wall_ids))

    def project(self, lines):
        lengths = [len(line) for line in lines]
        coords = np.concatenate(lines)
        x, y = self.tf.transform(*coords[:, :2].T)
        ids = np.repeat(np.arange(len(lines)), lengths)
        if coords.shape[1] == 3:
            self.line_ids = ids
            self.line_offsets = np.r_[0, np.cumsum(lengths)]
        else:
            self.wall_ids = ids
        return np.column_stack([x, y, coords[:, 2:]])

    @lru_cache(maxsize=64)
    def tile(self, i, j):
        return json.loads((self.data / "tiles" / f"{i}_{j}.json").read_text())

    def tiles(self, bounds):
        ox, oy = self.index["origin"]
        t = self.index["tile"]
        i0, j0, i1, j1 = (math.floor((x + o) / t) for x, o in zip(bounds, [ox, oy, ox, oy]))
        return {f"{i}_{j}": self.tile(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)
                if (i, j) in self.keys}


def fit(city, ident, centre, radius):
    cx, cy = centre
    disk = Point(centre).buffer(radius)
    bounds = [math.floor(cx-radius)-1, math.floor(cy-radius)-1,
              math.ceil(cx+radius)+1, math.ceil(cy+radius)+1]
    tiles = city.tiles(bounds)
    if not tiles or not shapely.union_all([box(*t["box"]) for t in tiles.values()]).buffer(.02).covers(disk):
        raise ValueError("outside built tiles")
    # The depth-only tunnel mesh still follows the coarse lattice across the
    # whole tile. Lowering a surface anywhere in that tile can occlude traffic.
    if any(s["kind"] == "tunnel" for t in tiles.values() for s in t.get("structures", [])):
        raise ValueError("tile uses a tunnel depth mask")
    support = disk.buffer(1.5)
    if any(support.intersects(p) for t in tiles.values()
           for s in t.get("structures", []) for p in polygons(s["polys"])):
        raise ValueError("mapped bridge or tunnel in patch")
    steps = shapely.union_all([p for t in tiles.values()
                               for s in t.get("terraces", []) for p in polygons(s["polys"])])
    water = shapely.union_all([p for t in tiles.values() for p in polygons(t["areas"].get("water", []))])
    protected = steps.union(water)
    asphalt = shapely.union_all([p for t in tiles.values() for k in ("road", "sett")
                                for p in polygons(t["roads"].get(k, [])) if p.intersects(disk)])
    choices = [g for g in shapely.get_parts(asphalt.intersection(disk).difference(protected))
               if g.geom_type == "Polygon" and g.area > 15]
    if not choices:
        raise ValueError("no connected carriageway")
    road = min(choices, key=lambda g: g.distance(Point(centre)))
    if road.distance(Point(centre)) > 2:
        raise ValueError("centre not on carriageway")
    # Guard nearby carriageways on the other side of a wall from the shoulder.
    other = shapely.union_all([g for g in choices if g is not road])
    houses = shapely.union_all([p for t in tiles.values() for p in polygons(b["rings"] for b in t["buildings"])
                               if p.intersects(disk)])
    wall = city.wall_tree.query(road.buffer(1), predicate="intersects")
    walls = shapely.union_all(city.wall_tree.geometries[wall])
    if not walls.intersection(road.buffer(-.6)).difference(steps.buffer(1)).is_empty:
        raise ValueError("unmodelled wall crosses carriageway")
    rails = shapely.union_all([LineString(r["pts"]) for t in tiles.values() for r in t["rails"]
                               if len(r["pts"]) > 1])

    # Use actual surveyed road edges rather than the artificial circumference
    # of the patch. The road-side edge of a mapped step can also supply anchors.
    border = asphalt.boundary
    if not steps.is_empty:
        border = border.union(steps.boundary.intersection(road.buffer(.8)))
    zone = road.buffer(.8).intersection(disk)
    at = terrain_at(city.data, city.index, tiles)
    obs = []
    for k in city.line_tree.query(zone, predicate="intersects"):
        line = city.lines[city.line_offsets[k]:city.line_offsets[k+1]]
        if not np.isfinite(line).all():
            continue
        obs.append(_along(line, 1.2))
    if not obs:
        raise ValueError("no measured road edges")
    xyz = np.concatenate(obs)
    points = shapely.points(xyz[:, :2])
    use = shapely.covers(zone, points) & shapely.dwithin(points, border, .65)
    xyz = xyz[use]
    if not other.is_empty:
        xyz = xyz[~shapely.contains_xy(other, *xyz[:, :2].T)]
    # Keep the measurements on this storey. This is a conservative bound,
    # particularly near retaining walls, where the opposite face is metres away.
    old = at(*xyz[:, :2].T)
    keep = np.isfinite(old) & (np.abs(old - xyz[:, 2]) <= 1.8)
    xyz, old = xyz[keep], old[keep]
    if len(xyz) < 25:
        raise ValueError("too few same-side road heights")
    # Repeated samples along coincident survey edges do not get extra influence.
    _, unique = np.unique(np.round(xyz[:, :2], 1), axis=0, return_index=True)
    xyz, old = xyz[unique], old[unique]
    cells = np.floor(xyz[:, :2] / 2).astype(int)
    held = (cells[:, 0] + 2*cells[:, 1]) % 5 == 0
    if held.sum() < 5 or (~held).sum() < 15:
        raise ValueError("insufficient held-out stations")
    X = design(xyz[:, :2], bounds)
    terms = 6 if np.linalg.cond(X[~held]) <= 30 else 3
    if np.linalg.cond(X[~held, :3]) > 30:
        raise ValueError("road heights do not constrain a surface")
    def residual(c):
        return np.r_[X[~held, :terms] @ c - xyz[~held, 2], c[3:] * .5]
    coef = least_squares(residual, np.r_[np.median(xyz[:, 2]), np.zeros(terms-1)],
                         loss="soft_l1", f_scale=.12).x
    z = np.pad(coef, (0, 6-terms))
    err = np.abs(X @ z - xyz[:, 2])
    if err[held].mean() > min(.32, np.abs(old[held]-xyz[held, 2]).mean() + .025) or np.quantile(err, .9) > .6:
        raise ValueError("fit disagrees with withheld road heights")

    x0, y0, x1, y1 = bounds
    xs, ys = np.meshgrid(np.arange(x0, x1+1), np.arange(y0, y1+1))
    xy = np.column_stack([xs.ravel(), ys.ravel()])
    pts = shapely.points(xy)
    feather = 2.5
    weight = smooth((radius - np.linalg.norm(xy-centre, axis=1)) / 9)
    weight *= smooth((feather - shapely.distance(pts, road)) / feather)
    for exclusion in (houses, other, water):
        if not exclusion.is_empty:
            weight *= smooth(shapely.distance(pts, exclusion) / 2)
    # Do not extrapolate past measured approaches. The 3 m allowance covers a
    # kerb just beyond a sampled end, and fades before leaving its evidence.
    hull = shapely.convex_hull(shapely.multipoints(xyz[~held, :2]))
    weight *= smooth((4 - shapely.distance(pts, hull)) / 4)
    quantized = np.round(weight * 255).astype(int)
    # A positive grid vertex contributes to the cells touching it. A track
    # within one cell diagonal can therefore receive part of the blend.
    if not rails.is_empty and shapely.dwithin(pts[quantized > 0], rails, math.sqrt(2)).any():
        raise ValueError("rail crosses the blend footprint")
    if not (weight > .4).any():
        raise ValueError("no supported surface interior")
    active = (weight > .01) & ~shapely.covers(protected, pts)
    delta = np.abs(design(xy[active], bounds) @ z - at(*xy[active].T))
    if not len(delta) or not np.isfinite(delta).all() or delta.max() > 2.0:
        raise ValueError("unsupported height change")

    edges = {edge_key(e): e for t in tiles.values() for e in t.get("drive", [])
             if len(e["pts"]) > 1 and not any(e.get(k) for k in ("bridge", "tunnel", "level", "levels"))
             and LineString(e["pts"]).intersects(road)}
    degree = {}
    for e in edges.values():
        for k, p in ((e["u"], e["pts"][0]), (e["v"], e["pts"][-1])):
            if np.linalg.norm(np.subtract(p, centre)) < radius - 6:
                degree[k] = degree.get(k, 0) + 1
    kind = "wall" if (not steps.is_empty and road.distance(steps) < .6) else "junction" if max(degree.values(), default=0) >= 3 else "street"
    if kind == "street":
        for e in edges.values():
            part = LineString(e["pts"]).intersection(disk)
            if part.geom_type == "LineString" and part.length > 10 and part.hausdorff_distance(
                    LineString([part.coords[0], part.coords[-1]])) > .5:
                kind = "curve"
                break
    return dict(id=ident, kind=kind, box=bounds, n=[xs.shape[1], xs.shape[0]], z=z.round(6).tolist(),
                weights=quantized.tolist(), tiles=sorted(tiles)), {
                    "observations": len(xyz), "held": int(held.sum()), "residual": float(err[held].mean()),
                    "oldResidual": float(np.abs(old[held]-xyz[held, 2]).mean()),
                    "centre": list(centre), "edges": [e["id"] for e in edges.values()],
                    "heldPoints": xyz[held].round(3).tolist(),
                }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--survey-snapshot", type=Path, required=True, help="trusted local DTM heights pickle")
    ap.add_argument("--baseline", type=Path, required=True, help="matching check-road-flatness JSON")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--report", type=Path, required=True)
    ap.add_argument("--seed", action="append", default=[], help="name,latitude,longitude,radius")
    ap.add_argument("--count", type=int, default=1000)
    args = ap.parse_args()
    city = Map(args.data, args.survey_snapshot)
    base = json.loads(args.baseline.read_text())
    if base["built"] != city.index["built"]:
        ap.error("baseline map build differs")
    candidates = [(name, float(lat), float(lon), float(r))
                  for name, lat, lon, r in [item.split(",") for item in args.seed]]
    rows = [r for r in base["rows"] if r.get("level") in (None, 0)]
    limits = {"bump": .5, "lean": 15, "twist": 12, "crown": 1}
    def finding(r):
        k = max(limits, key=lambda k: abs(r[k]) / limits[k])
        return k, abs(r[k]) / limits[k]
    # Include moderate roughness and large failures. The latter often indicate
    # a misplaced wall or crossing that needs a different reconstruction.
    bands = [[], [], []]
    for r in rows:
        k, score = finding(r)
        if score > 1 and r[k+"At"]:
            lat, lon = map(float, r[k+"At"])
            bands[0 if score < 1.8 else 1 if score < 3 else 2].append(
                (score, r["id"], lat, lon, 18))
    for band in bands:
        band.sort(reverse=True)
    for i in range(max(map(len, bands))):
        candidates.extend(band[i][1:] for band in bands if i < len(band))
    patches, report, attempted = [], [], []
    for ident, lat, lon, radius in candidates:
        if len(attempted) >= args.count:
            break
        centre = np.array(city.tf.to_local.transform(lon, lat))
        if not 10 <= radius <= 40 or any(np.linalg.norm(centre-p) < radius+r+4 for p,r in attempted):
            continue
        attempted.append((centre, radius))
        try:
            patch, stats = fit(city, ident, centre, radius)
            patches.append(patch)
            report.append(dict(id=ident, at=[lat,lon], kind=patch["kind"], **stats))
        except ValueError as exc:
            report.append(dict(id=ident, at=[lat,lon], rejected=str(exc)))
    out = dict(version=1, area=city.index["area"], built=city.index["built"], patches=patches)
    write(args.out, json.dumps(out, separators=(",", ":"))+"\n")
    write(args.report, json.dumps(report, ensure_ascii=False, indent=2)+"\n")
    print(f"{len(patches)} fitted patches from {len(attempted)} locations")


if __name__ == "__main__":
    main()
