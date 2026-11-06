"""Restore lower roadside shelves supported by the independent IPR elevation raster."""

import argparse
from collections import Counter, defaultdict
from functools import lru_cache
import json
import math
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, box

from ipr_lidar import sampler as lidar_sampler
from layers import write
from road_profile import edge_key, polygons, terrain_at
from road_surfaces import smooth

REACH = 12  # metres from the ground road


class Map:
    def __init__(self, data, lidar):
        self.data = data
        self.index = json.loads((data / "index.json").read_text())
        w, s, e, n = self.index["bbox_wgs84"]
        local = f"+proj=tmerc +lat_0={(s+n)/2} +lon_0={(w+e)/2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
        self.lidar, self.source = lidar_sampler(lidar, local)
        self.to_wgs = Transformer.from_crs(local, 4326, always_xy=True)
        self.keys = {(i, j) for i, j, *_ in self.index["tiles"]}
        self.origin = np.asarray(self.index["origin"])
        self.size = self.index["tile"]

    @lru_cache(maxsize=256)
    def tile(self, i, j):
        return json.loads((self.data / "tiles" / f"{i}_{j}.json").read_text())

    def tiles(self, bounds):
        (i0, j0), (i1, j1) = np.floor((np.asarray(bounds).reshape(2, 2) + self.origin) / self.size).astype(int)
        return {f"{i}_{j}": self.tile(i, j) for i in range(i0, i1+1) for j in range(j0, j1+1)
                if (i, j) in self.keys}

    @lru_cache(maxsize=256)
    def ground_tile(self, i, j):
        key = f"{i}_{j}"
        return terrain_at(self.data, self.index, {key: self.tile(i, j)})

    def ground(self, points):
        ids, inverse = np.unique(np.floor((points + self.origin) / self.size).astype(int), axis=0, return_inverse=True)
        out = np.full(len(points), np.nan)
        for k, (i, j) in enumerate(ids):
            if (i, j) in self.keys:
                mask = inverse == k
                out[mask] = self.ground_tile(i, j)(*points[mask].T)
        return out


def road_on_ground(edge):
    return len(edge["pts"]) > 1 and not any(edge.get(k) for k in ("bridge", "tunnel", "level", "levels"))


def shelf_samples(ground, lidar, line, half):
    """Return evidence for a continuous low strip beside a matching road centre."""
    station = np.arange(2, line.length-2, 2.)
    if len(station) < 7:
        return None
    points = shapely.get_coordinates(shapely.line_interpolate_point(line, station))
    tangents = shapely.get_coordinates(shapely.line_interpolate_point(line, station + .25)) - points
    tangents /= np.linalg.norm(tangents, axis=1)[:, None]
    normal = np.column_stack([-tangents[:, 1], tangents[:, 0]])
    level = lidar(*points.T)
    prior = ground(points)
    agree = np.isfinite(level) & np.isfinite(prior) & (np.abs(level-prior) <= .6)
    if agree.mean() < .75:
        return None
    offsets = np.arange(max(half, 3.), REACH, 1.5)
    evidence = []
    for side in (-1, 1):
        sample = (points[:, None, :] + side * offsets[None, :, None] * normal[:, None, :]).reshape(-1, 2)
        low = lidar(*sample.T).reshape(len(points), -1)
        excess = ground(sample).reshape(low.shape) - low
        # A second source places these samples at the same height as the
        # lower carriageway. High LiDAR samples can be a real bank or deck.
        support = np.isfinite(excess) & (np.abs(low-level[:, None]) <= .8) & (excess >= 1.2)
        rows = support.any(axis=1)
        runs = np.split(np.flatnonzero(rows), np.flatnonzero(np.diff(np.flatnonzero(rows)) > 1) + 1)
        if max(map(len, runs)) >= 6:
            evidence.append((int(rows.sum()), float(np.max(excess[support])), side))
    return max(evidence, default=None)


def fits_grid(line):
    xmin, ymin, xmax, ymax = line.bounds
    return max(math.ceil(xmax+REACH)-math.floor(xmin-REACH),
               math.ceil(ymax+REACH)-math.floor(ymin-REACH)) < 128


def join_edges(edge, at_node, detected):
    """Follow one compatible continuation at either end of a ground road."""
    points = edge["pts"]
    members = [edge["id"]]
    if not edge.get("name"):
        return LineString(points), members
    for end in (0, 1):
        node = edge["uv"[end]]
        end_pts = points if end else points[::-1]
        origin, previous = np.array(end_pts[-1]), np.array(end_pts[-2])
        onward = origin - previous
        candidates = []
        for neighbour in at_node[node]:
            key = edge_key(neighbour)
            if key == edge_key(edge) or key not in detected or neighbour.get("name") != edge["name"]:
                continue
            if bool(neighbour.get("oneway")) != bool(edge.get("oneway")):
                continue
            if edge.get("oneway") and node != neighbour["uv"[1-end]]:
                continue
            tail = neighbour["pts"] if neighbour["u"] == node else neighbour["pts"][::-1]
            if tail[0] != end_pts[-1]:
                continue
            direction = np.array(tail[1]) - origin
            length = np.linalg.norm(onward) * np.linalg.norm(direction)
            if not length:
                continue
            dot = float(onward @ direction / length)
            if dot >= .85 and fits_grid(LineString(end_pts + tail[1:])):
                candidates.append((dot, neighbour["id"], tail[1:]))
        if candidates:
            _, ident, tail = max(candidates)
            points = points + tail if end else tail[::-1] + points
            members.append(ident)
    return LineString(points), members


def fit(city, line, ident):
    x0, y0, x1, y1 = line.buffer(REACH).bounds
    bounds = [math.floor(x0), math.floor(y0), math.ceil(x1), math.ceil(y1)]
    tiles = city.tiles(bounds)
    if any(s["kind"] == "tunnel" for t in tiles.values() for s in t.get("structures", [])):
        raise ValueError("tile has tunnel depth mask")
    protected = []
    for tile in tiles.values():
        protected.extend(polygons(tile["areas"].get("water", [])))
        protected.extend(p for terrace in tile.get("terraces", []) for p in polygons(terrace["polys"]))
        protected.extend(polygons(b["rings"] for b in tile["buildings"]))
        protected.extend(LineString(r["pts"]).buffer(1.5) for r in tile["rails"] if len(r["pts"]) > 1)
    protected = shapely.union_all(protected)
    bridge_ends = shapely.multipoints(np.asarray([p for t in tiles.values() for e in t.get("drive", [])
                                                 if len(e["pts"]) > 1 and (e.get("bridge") or e.get("level") or e.get("levels"))
                                                 for p in (e["pts"][0], e["pts"][-1])]).reshape(-1, 2))
    road_margin = line.buffer(2)
    paved = shapely.union_all([p for t in tiles.values() for kind in ("road", "sett", "pavement", "pavement_asphalt")
                               for p in polygons(t["roads"].get(kind, [])) if p.intersects(road_margin)])
    if not paved.buffer(1.25).covers(line):
        raise ValueError("road is not continuously paved")
    xs, ys = np.meshgrid(np.arange(bounds[0], bounds[2]+1), np.arange(bounds[1], bounds[3]+1))
    xy = np.column_stack([xs.ravel(), ys.ravel()])
    points = shapely.points(xy)
    distance = shapely.distance(points, line)
    along = shapely.line_locate_point(line, points)
    foot = shapely.get_coordinates(shapely.line_interpolate_point(line, along))
    level = city.lidar(*foot.T)
    lidar = city.lidar(*xy.T)
    ground = city.ground(xy)
    weight = smooth(along/10) * smooth((line.length-along)/10) * smooth((REACH-distance)/2)
    weight *= smooth((1.3 - np.abs(lidar-level)) / .65)
    # The disagreement selects the whole supported shelf. Weighting individual
    # nodes by how far they disagree would leave waves where the sources cross.
    # Fade only where the LiDAR surface would substantially raise the ground.
    weight *= smooth((.70 + ground - lidar) / .35)
    if not protected.is_empty:
        # A grid vertex can affect a point up to one cell diagonal away.
        weight *= smooth((shapely.distance(points, protected) - math.sqrt(2)) / 2)
    if not bridge_ends.is_empty:
        weight *= smooth((shapely.distance(points, bridge_ends)-4) / 4)
    weight[~np.isfinite(weight)] = 0
    encoded = np.round(weight*255).astype(int)
    encoded.reshape(xs.shape)[[0, -1], :] = 0
    encoded.reshape(xs.shape)[:, [0, -1]] = 0
    active = encoded > 0
    if not active.any():
        raise ValueError("no room outside the protected terrain")
    lowering = (ground[active] - lidar[active]) * encoded[active] / 255
    if np.sum(lowering >= 1.) < 12 or lowering.max() > 10:
        raise ValueError("lower shelf lacks enough supported area")
    # All four grid heights are read where a weight is nonzero. Use existing
    # terrain for missing values, and reject a gap in a cell that contributes.
    invalid = ~np.isfinite(lidar.reshape(xs.shape))
    support = encoded.reshape(xs.shape) > 0
    for a in (-1, 0, 1):
        for b in (-1, 0, 1):
            if (support & np.roll(invalid, (a, b), axis=(0, 1))).any():
                raise ValueError("LiDAR gap in the supported shelf")
    values = np.where(np.isfinite(lidar), lidar, np.nan_to_num(ground, nan=200.))
    return dict(id=ident, kind="lidar-shelf", box=bounds, n=[xs.shape[1], xs.shape[0]],
                weights=encoded.tolist(), heights=values.round(3).tolist(), tiles=sorted(tiles)), {
                    "nodes": int(active.sum()), "lowering_m": float(lowering.max()), "length_m": line.length,
                }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for arg in ("data", "lidar", "current", "out", "report"):
        ap.add_argument(f"--{arg}", type=Path, required=True)
    ap.add_argument("--limit", type=int, default=12, help="maximum number of nonoverlapping pilot fits")
    ap.add_argument("--priority-edge", help="check a named edge first without changing any acceptance criteria")
    args = ap.parse_args()
    if args.limit < 1:
        ap.error("--limit must be positive")
    city = Map(args.data, args.lidar)
    current = json.loads(args.current.read_text())
    if (current.get("version"), current.get("area"), current.get("built")) != (1, city.index["area"], city.index["built"]):
        ap.error("current sidecar does not match the assembled map")

    edges, at_node = {}, defaultdict(list)
    for key in city.index["terrain"]["structures"]:
        t = city.tile(*map(int, key.split("_")))
        if not any(s["kind"] == "bridge" for s in t.get("structures", [])):
            continue
        for e in t.get("drive", []):
            if road_on_ground(e) and e["hw"] in {"primary", "secondary", "tertiary", "residential", "unclassified",
                                                 "primary_link", "secondary_link", "tertiary_link", "trunk", "trunk_link"}:
                key = edge_key(e)
                if key not in edges or len(edges[key]["pts"]) < len(e["pts"]) or e["id"] == args.priority_edge:
                    edges[key] = e
    detected = {}
    for key, edge in edges.items():
        for node in ("u", "v"):
            at_node[edge[node]].append(edge)
        line = LineString(edge["pts"])
        if line.length <= 160 and fits_grid(line):
            evidence = shelf_samples(city.ground, city.lidar, line, edge["width"]/2)
            if evidence:
                detected[key] = evidence
    ranked = sorted(detected, key=lambda k: (edges[k]["id"] == args.priority_edge, *detected[k]), reverse=True)
    patches, reports, rejected, occupied = [], [], Counter(), []
    for key in ranked:
        if len(patches) >= args.limit:
            break
        edge = edges[key]
        line, members = join_edges(edge, at_node, detected)
        ident = f"shelf:{edge['id']}"
        footprint = box(*line.buffer(REACH+1).bounds)
        if any(p.intersects(footprint) for p in occupied):
            rejected["overlaps another shelf"] += 1
            continue
        try:
            patch, stats = fit(city, line, ident)
        except ValueError as exc:
            rejected[str(exc)] += 1
            continue
        patches.append(patch)
        occupied.append(footprint)
        lon, lat = city.to_wgs.transform(*line.interpolate(.5, normalized=True).coords[0])
        reports.append(dict(id=ident, name=edge.get("name"), at=[lat, lon], edges=members, **stats))
    write(args.out, json.dumps({**current, "patches": [*patches, *current["patches"]]}, separators=(",", ":")) + "\n")
    write(args.report, json.dumps(dict(built=current["built"], source=city.source, scanned=len(edges),
                                       detected=len(detected), rejected=dict(rejected), fits=reports), indent=2) + "\n")
    print(f"{len(edges)} ground roads near bridges, {len(detected)} with a supported shelf, {len(patches)} pilot fits")


if __name__ == "__main__":
    main()
