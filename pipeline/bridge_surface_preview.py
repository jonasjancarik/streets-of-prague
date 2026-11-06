"""Separate overlapping ramp surfaces and identify railway decks on an assembled map."""

import argparse
from functools import lru_cache
import gzip
import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, box
from shapely.ops import substring

from ipr_lidar import sampler as lidar_sampler
from layers import write
from osm_area import _coords, _rings
from road_profile import polygons
from road_shelves import Map as GroundMap, road_on_ground
from road_surfaces import smooth
from structures import ipr_decks


def local_crs(index):
    w, s, e, n = index["bbox_wgs84"]
    return f"+proj=tmerc +lat_0={(s+n)/2} +lon_0={(w+e)/2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"


class Tile:
    def __init__(self, data, key, index):
        self.key = key
        self.raw = json.loads((data / "tiles" / f"{key}.json").read_text())
        self.box = box(*self.raw["box"])
        self.n, self.step = (index["terrain"][k] for k in ("n", "step"))
        rows = self.raw.get("structures", [])
        levels = data / "tiles" / f"{key}.levels.bin.gz"
        grids = np.frombuffer(gzip.decompress(levels.read_bytes()), "<u2").reshape(len(rows), self.n, self.n) if rows else []
        self.levels = {s["level"]: (shapely.union_all(polygons(s["polys"])), g)
                       for s, g in zip(rows, grids) if s["kind"] == "bridge"}

    def height(self, level, x, y):
        west, south, *_ = self.raw["box"]
        u, v = np.clip((np.array([x, y]) - (west, south)) / self.step, 0, self.n-1.000001)
        i, j = int(u), int(v)
        heights = self.levels[level][1][j:j+2, i:i+2]
        weights = np.outer([1-v+j, v-j], [1-u+i, u-i]) * (heights > 0)
        return 100 + (weights * heights).sum() / (100 * weights.sum()) if weights.sum() else np.nan


def routes(tiles, kind="drive"):
    """Each elevated road edge once, keeping the longest tile record."""
    by_id = {}
    for tile in tiles:
        for edge in tile.raw.get(kind, []):
            if (edge.get("level", 0) or 0) <= 0 or edge.get("levels") or len(edge["pts"]) < 2:
                continue
            old = by_id.get(edge["id"])
            if old is None or len(edge["pts"]) > len(old["pts"]):
                by_id[edge["id"]] = edge
    return [(LineString(e["pts"]), e) for e in by_id.values()]


def supported(samples, elevation, tolerance=.55):
    return bool(samples is not None and np.any(np.abs(samples - elevation) <= tolerance))


def direction_at(line, s):
    a, b = (line.interpolate(d) for d in (max(0, s-1), min(line.length, s+1)))
    return np.array([b.x-a.x, b.y-a.y])


def ramp_cuts(tiles, measured):
    edges = routes(tiles)
    paths = edges + routes(tiles, "walk")
    # The evidence is collected across tile edges before clipping the result
    # back to each tile, so the opening does not end at a tile boundary.
    @lru_cache(maxsize=16)
    def envelope(level):
        return shapely.union_all([line.buffer((e.get("width") or 7)/2 + .65)
                                  for line, e in paths if e["level"] == level])

    def parallel(upper, point, ramp_direction):
        for line, edge in edges:
            if edge["level"] != upper or line.distance(point) > 16:
                continue
            direction = direction_at(line, line.project(point))
            scale = np.linalg.norm(direction) * np.linalg.norm(ramp_direction)
            if scale and abs(direction @ ramp_direction) >= .85 * scale:
                return True
        return False

    by_pair = {}
    for line, e in edges:
        if not e["hw"].endswith("_link") or line.length < 8:
            continue
        lower = e["level"]
        intervals = {}
        for s in np.arange(0.5, line.length, 1):
            point = line.interpolate(s)
            tile = next((t for t in tiles if t.box.covers(point)), None)
            if tile is None or lower not in tile.levels or not tile.levels[lower][0].covers(point):
                continue
            x, y = point.x, point.y
            sample = measured.get((round(x), round(y)))
            h = tile.height(lower, x, y)
            if not supported(sample, h):
                continue
            for upper, (poly, _) in tile.levels.items():
                if upper == lower or not poly.covers(point):
                    continue
                top = tile.height(upper, x, y)
                if (not np.isfinite(top) or top - h < 1.0 or supported(sample, top)
                        or envelope(upper).covers(point) or not parallel(upper, point, direction_at(line, s))):
                    continue
                intervals.setdefault(upper, []).append(s)
        for upper, ss in intervals.items():
            split = np.flatnonzero(np.diff(ss) > 1.01) + 1
            for part in np.split(ss, split):
                if len(part) < 8:
                    continue
                span = substring(line, part[0]-.5, part[-1]+.5)
                by_pair.setdefault((upper, lower), []).append(span.buffer((e.get("width") or 7)/2 + 1.25,
                                                                         cap_style="flat", join_style="round"))
    cuts = []
    for tile in tiles:
        for upper, (poly, _) in tile.levels.items():
            overlaps = [q.intersection(tile.levels[lower][0].buffer(1.25)) for (up, lower), parts in by_pair.items()
                        if up == upper and lower in tile.levels for q in parts if q.intersects(poly)]
            if not overlaps:
                continue
            cut = poly.intersection(shapely.union_all(overlaps)).difference(envelope(upper))
            if cut.area < 10:
                continue
            # Keep every observed face at the higher level. Lower faces
            # supply evidence for the cut, never for erasing a crossing deck.
            xmin, ymin, xmax, ymax = cut.bounds
            high = []
            for x in range(math.floor(xmin)-1, math.ceil(xmax)+2):
                for y in range(math.floor(ymin)-1, math.ceil(ymax)+2):
                    if supported(measured.get((x, y)), tile.height(upper, x, y), .45):
                        high.append(box(x-.75, y-.75, x+.75, y+.75))
            cut = cut.difference(shapely.union_all(high))
            after = poly.difference(cut)
            kept = [_rings(p) for p in shapely.get_parts(after) if p.geom_type == "Polygon" and p.area > .5]
            if kept and cut.area > 10:
                cuts.append((tile.key, upper, kept, round(cut.area, 1)))
    return cuts


def railway_decks(tiles, measured, lidar):
    edges = routes(tiles)
    result = {}
    for tile in tiles:
        records = []
        for level, (poly, _) in tile.levels.items():
            # A road deck may cross the railway below, so its plan outline
            # alone is insufficient to place a track there.
            if any(e["level"] == level and poly.intersection(line).length > 5 for line, e in edges):
                continue
            tracks = []
            for r in tile.raw["rails"]:
                if r["kind"] != "rail" or len(r["pts"]) < 2:
                    continue
                line = LineString(r["pts"])
                for part in shapely.get_parts(line.intersection(poly)):
                    if part.geom_type != "LineString" or part.length < 2:
                        continue
                    points = shapely.get_coordinates(shapely.line_interpolate_point(part, [.15, .5, .85], normalized=True))
                    ground = lidar(*points.T)
                    top = [tile.height(level, *p) for p in points]
                    if sum(z > g + 2 and supported(measured.get(tuple(np.rint(p).astype(int))), z)
                           for p, g, z in zip(points, ground, top)) >= 2:
                        tracks.append(_coords(part))
            if len(tracks) >= 2:
                records.extend(dict(level=level, pts=p) for p in tracks)
        if records:
            result[tile.key] = records
    return result


def lower_cutting(city, tiles, tracks, ids):
    edges = {e["id"]: e for t in tiles for e in t.raw.get("drive", []) if road_on_ground(e)}
    if any(ident not in edges for ident in ids):
        raise ValueError("underpass needs ground-level edges")
    first, *rest = (edges[ident]["pts"] for ident in ids)
    points = list(first)
    for tail in rest:
        if points[-1] != tail[0]:
            raise ValueError("underpass edges must be in route order")
        points.extend(tail[1:])
    axis = LineString(points)
    above = shapely.union_all([t.levels[level][0] for t in tiles
                              for level in {v["level"] for v in tracks.get(t.key, [])}])
    under = axis.intersection(above)
    if under.length < 10:
        raise ValueError("ground route does not pass beneath the surveyed railway")
    stations = shapely.line_locate_point(axis, shapely.points(shapely.get_coordinates(under)))
    line = substring(axis, max(0, stations.min()-36), min(axis.length, stations.max()+10))
    # Keep the contiguous part of the crossing with corroborated ground
    # returns. Short gaps can be the very bumps we are trying to repair.
    sampled = np.arange(1., line.length, 2)
    center = shapely.get_coordinates(shapely.line_interpolate_point(line, sampled))
    source = city.lidar(*center.T)
    old = city.ground(center)
    agreement = np.isfinite(source) & np.isfinite(old) & (np.abs(source-old) <= .7)
    good = np.flatnonzero(agreement)
    choices = [part for part in np.split(good, np.flatnonzero(np.diff(good) > 6)+1) if len(part) >= 12]
    if not choices:
        raise ValueError("insufficient agreement along the lower road")
    chosen = max(choices, key=len)
    line = substring(line, max(0, sampled[chosen[0]]-1), min(line.length, sampled[chosen[-1]]+1))
    if line.intersection(above).length < 10 or len(chosen) / (chosen[-1] - chosen[0] + 1) < .7:
        raise ValueError("insufficient agreement through the railway crossing")
    lower = float(np.median(source[chosen]))
    bounds = np.r_[np.floor(line.buffer(11).bounds[:2]), np.ceil(line.buffer(11).bounds[2:])].astype(int)
    if max(bounds[2:] - bounds[:2]) >= 128:
        raise ValueError("lower cutting exceeds the patch grid")
    ground_tiles = city.tiles(bounds)
    if any(s["kind"] == "tunnel" for t in ground_tiles.values() for s in t.get("structures", [])):
        raise ValueError("lower cutting reaches a tunnel tile")
    road = shapely.union_all([p for t in ground_tiles.values() for p in polygons(t["roads"].get("road", []))
                             if p.intersects(line.buffer(12))])
    protected = []
    for key, t in ground_tiles.items():
        protected.extend(polygons(b["rings"] for b in t["buildings"]))
        protected.extend(polygons(t["areas"].get("water", [])))
        protected.extend(p for terrace in t.get("terraces", []) for p in polygons(terrace["polys"]))
        confirmed = shapely.union_all([LineString(r["pts"]) for r in tracks.get(key, [])])
        protected.extend(LineString(r["pts"]).difference(confirmed.buffer(.25)) for r in t["rails"]
                         if len(r["pts"]) > 1)
    protected = shapely.union_all(protected)
    # Only use the LiDAR returns that lie near the surveyed lower carriageway.
    # This cuts out returns at deck height and holes where the track hides the road.
    x0, y0, x1, y1 = bounds
    xs, ys = np.meshgrid(np.arange(x0, x1+1), np.arange(y0, y1+1))
    xy = np.column_stack([xs.ravel(), ys.ravel()])
    p = shapely.points(xy)
    station = shapely.line_locate_point(line, p)
    raw = city.lidar(*xy.T)
    ground = city.ground(xy)
    strength = smooth(station/10) * smooth((line.length-station)/10)
    strength *= smooth((11-shapely.distance(p, line))/2)
    strength *= smooth((1.2-shapely.distance(p, road))/1.2)
    strength *= smooth((.75-np.abs(raw-lower))/.28) * smooth((.8+ground-raw)/.5)
    if not protected.is_empty:
        strength *= smooth((shapely.distance(p, protected)-math.sqrt(2))/2)
    strength[~np.isfinite(strength)] = 0
    weights = np.round(strength*255).astype(int).reshape(xs.shape)
    weights[[0,-1],:] = 0
    weights[:,[0,-1]] = 0
    active = weights.ravel() > 0
    change = np.maximum(ground[active]-lower, 0)*strength[active]
    if not len(change) or change.max() < 1 or change.max() > 8:
        raise ValueError(f"no supported distortion on the lower road (maximum {change.max(initial=0):.2f} m)")
    if any((active.reshape(xs.shape) & np.roll(~np.isfinite(raw.reshape(xs.shape)), (a,b), axis=(0,1))).any()
           for a in (-1,0,1) for b in (-1,0,1)):
        raise ValueError("LiDAR gap at the lower road")
    values = np.full(len(raw), lower)
    return dict(id="rail-cutting:" + ids[0], kind="rail-cutting", box=bounds.tolist(),
                n=[xs.shape[1], xs.shape[0]], tiles=sorted(ground_tiles), weights=weights.ravel().tolist(),
                heights=values.round(3).tolist(), lowerOnly=True), dict(length_m=line.length, lowering_m=float(change.max()),
                                                        lower_m=lower, nodes=int(active.sum()))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for name in ("data", "lidar", "out", "report"):
        ap.add_argument(f"--{name}", type=Path, required=True)
    ap.add_argument("--tiles", required=True, help="comma-separated tiles around the structures")
    ap.add_argument("--underpass", help="comma-separated ground road edges through the railway in route order")
    args = ap.parse_args()
    index = json.loads((args.data / "index.json").read_text())
    tiles = [Tile(args.data, key, index) for key in args.tiles.split(",")]
    local = local_crs(index)
    measured = ipr_decks(local)
    lidar, _ = lidar_sampler(args.lidar, local)
    adjusted, report = {}, []
    for key, level, polys, area in ramp_cuts(tiles, measured):
        adjusted.setdefault(key, {})[str(level)] = polys
        report.append(dict(tile=key, level=level, removed_m2=area))
    tracks = railway_decks(tiles, measured, lidar)
    patches, cutting = [], None
    if args.underpass:
        patch, cutting = lower_cutting(GroundMap(args.data, args.lidar), tiles, tracks, args.underpass.split(","))
        patches.append(patch)
    write(args.out, json.dumps(dict(version=1, area=index["area"], built=index["built"],
                                    decks=adjusted, tracks=tracks, ground=patches), separators=(",", ":")) + "\n")
    write(args.report, json.dumps(dict(deckCuts=report, railwayTracks={k: len(v) for k, v in tracks.items()}, cutting=cutting),
                                      indent=2) + "\n")
    print(report, {k: len(v) for k, v in tracks.items()})


if __name__ == "__main__":
    main()
