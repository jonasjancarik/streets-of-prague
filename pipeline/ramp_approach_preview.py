"""Join reviewed road approaches to their surveyed ramp decks."""

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import substring

from bridge_surface_preview import Tile, local_crs
from ipr_buildings import krovak_to_local
from ipr_lidar import sampler as lidar_sampler
from layers import write
from osm_area import _rings
from road_profile import polygons, terrain_at
from road_surfaces import smooth
from structures import bridge_shapefile


def splice(old, surveyed, seam, extent):
    west, south, east, north = extent
    def section(shape, y):
        parts = [p for p in shapely.get_parts(shape.intersection(LineString([(west, y), (east, y)])))
                 if p.length > .03]
        if len(parts) != 1:
            raise ValueError("ramp does not have a single section at its join")
        return parts[0].bounds[0], parts[0].bounds[2]

    a, b = section(surveyed, seam-2)
    c, d = section(old, seam+2)
    join = Polygon([(a, seam-2), (b, seam-2), (d, seam+2), (c, seam+2)])
    out = shapely.union_all([surveyed.intersection(box(west, south, east, seam-2)), join,
                             old.intersection(box(west, seam+2, east, north))], grid_size=.001)
    if out.geom_type != "Polygon" or out.interiors:
        raise ValueError("surveyed approach would leave deck gaps")
    return out


def level_spans(line, shape, level):
    intervals = []
    for part in shapely.get_parts(line.intersection(shape)):
        if part.geom_type != "LineString" or part.length < .2:
            continue
        a, b = sorted((line.project(Point(part.coords[0])), line.project(Point(part.coords[-1]))))
        intervals.append((a, b))
    out = [[0, 0]]
    for start, end in sorted(intervals):
        if start < .05:
            out[-1] = [0, level]
        else:
            out.append([round(start, 3), level])
        if end < line.length-.05:
            out.append([round(end, 3), 0])
    return out


def section_profile(surveyed, faces):
    west, south, east, north = surveyed.bounds
    def height(y):
        at = float(np.clip(y, south+.15, north-.15))
        q = surveyed.intersection(LineString([(west-1, at), (east+1, at)]))
        x = (q.bounds[0]+q.bounds[2])/2
        plane = min(faces, key=lambda f: f[0].distance(Point(x, at)))[1]
        return float(plane @ [x, y, 1])
    return height


def apron_patch(tile, name, paths, profile, terrain):
    """Tie the ground to the surveyed elevation just outside the ramp."""
    support = shapely.union_all([line.buffer(width/2 + 2.8) for line, width, _ in paths])
    bounds = np.r_[np.floor(support.bounds[:2]), np.ceil(support.bounds[2:])].astype(int)
    if not tile.box.buffer(-1).covers(box(*bounds)):
        raise ValueError("approach crosses a tile seam")
    x0, y0, x1, y1 = bounds
    xs, ys = np.meshgrid(np.arange(x0, x1+1), np.arange(y0, y1+1))
    xy = np.column_stack([xs.ravel(), ys.ravel()])
    points = shapely.points(xy)
    protected = shapely.union_all([
        *polygons(b["rings"] for b in tile.raw["buildings"]),
        *polygons(tile.raw["areas"].get("water", [])),
        *(LineString(r["pts"]).buffer(.8) for r in tile.raw["rails"] if len(r["pts"]) > 1),
    ])
    clearance = smooth((shapely.distance(points, protected)-math.sqrt(2))/1.5) if not protected.is_empty else 1.
    strongest = np.zeros(xs.size)
    total = np.zeros(xs.size)
    weighted = np.zeros(xs.size)
    for line, width, contact in paths:
        # Travel out from 1.5 m within the deck. At its lip the full weight
        # ties the ground to the deck, then fades along the ground road.
        distance = shapely.distance(points, line)
        station = shapely.line_locate_point(line, points)
        weight = smooth((width/2+2.8-distance)/1.8) * smooth((line.length-station)/(line.length-2))
        start, ahead = (np.asarray(line.interpolate(s).coords[0]) for s in (0, .5))
        direction = ahead-start
        direction /= np.linalg.norm(direction)
        behind = (xy-start) @ direction
        weight *= smooth((behind+1.5)/1.5)*clearance
        height = profile(contact.y)
        x, y = line.coords[-1]
        end = float(terrain([x], [y])[0])
        if not np.isfinite(end) or abs(end-height) > 2.5:
            raise ValueError("street height at the far end of the apron is unsupported")
        transition = smooth((station-1.5)/(line.length-1.5))
        weighted += (height+(end-height)*transition)*weight
        total += weight
        strongest = np.maximum(strongest, weight)
    encoded = np.round(strongest*255).astype(int).reshape(xs.shape)
    encoded[[0,-1],:] = 0
    encoded[:,[0,-1]] = 0
    heights = np.divide(weighted, total, out=np.full_like(weighted, 200.), where=total > 0)
    return dict(id="ramp-apron:" + name, kind="ramp-apron", box=bounds.tolist(),
                n=[xs.shape[1], xs.shape[0]], tiles=[tile.key],
                weights=encoded.ravel().tolist(), heights=heights.round(3).tolist())


def build(data, lidar_dir, current, spec):
    import geopandas as gpd

    shape_file = bridge_shapefile()
    with shape_file.open("rb") as f:
        if hashlib.file_digest(f, "sha256").hexdigest() != spec["source_sha256"]:
            raise ValueError("survey file differs from the reviewed ramp source")
    surveyed = gpd.read_file(shape_file)
    index = json.loads((data / "index.json").read_text())
    key, level = spec["tile"], spec["level"]
    tile = Tile(data, key, index)
    ground_at = terrain_at(data, index, {key: tile.raw})
    local = local_crs(index)
    lidar, _ = lidar_sampler(lidar_dir, local)
    tf = krovak_to_local(local)
    west, south, east, north = tile.box.bounds
    offsets = np.arange(tile.n)*tile.step
    xs, ys = np.meshgrid(west+offsets, south+offsets)
    points = shapely.points(xs.ravel(), ys.ravel())
    binary = gzip.decompress((data / "tiles" / f"{key}.height.bin.gz").read_bytes())
    size = tile.n**2
    labels = np.frombuffer(binary, np.uint8, count=size, offset=size*2)
    original = tile.levels[level][0]
    remaining = list(shapely.get_parts(original))
    edges = {e["id"]: e for e in tile.raw["drive"]}
    corrected, heights, ground, pads, spans, report, aprons = [], {}, [], [], {}, [], []
    for ramp in spec["ramps"]:
        faces = []
        for i in ramp["faces"]:
            if surveyed["ID_BUD"].iloc[i] != spec["structure"]:
                raise ValueError("reviewed face is on a different structure")
            a = np.asarray(surveyed.geometry.iloc[i].exterior.coords)
            x, y = tf.transform(*a[:, :2].T)
            A = np.column_stack([x, y, np.ones(len(x))])
            faces.append((Polygon(np.column_stack([x, y])), np.linalg.lstsq(A, a[:, 2], rcond=None)[0]))
        actual = shapely.union_all([p for p, _ in faces], grid_size=.02).buffer(.25).buffer(-.25)
        old = min(remaining, key=lambda p: p.distance(Point(ramp["deck"])))
        remaining.remove(old)
        seam = ramp["seam_y"]
        new = splice(old, actual, seam, tile.box.bounds)
        corrected.append(new)
        profile = section_profile(actual, faces)
        height_seam = ramp.get("height_seam_y", seam)
        near = shapely.dwithin(points, new, 6)
        for idx in np.flatnonzero(near & (ys.ravel() < height_seam)):
            y = ys.ravel()[idx]
            if y < actual.bounds[1]-6:
                continue
            z = profile(y)
            prior = tile.levels[level][1].ravel()[idx]
            weight = float(smooth((height_seam-y)/12)) if prior else 1.
            heights[int(idx)] = round(weight*z + (1-weight)*(prior/100+100), 2)
        pad = next((t for t in tile.raw.get("terraces", []) if t["label"] == ramp["pad"]), None)
        if pad is None or pad.get("h") is None:
            raise ValueError("reviewed flat approach pad is missing")
        pad_shape = shapely.union_all(polygons(pad["polys"]))
        if pad_shape.area <= 0 or pad_shape.intersection(new).area < .9*pad_shape.area:
            raise ValueError("surveyed deck does not replace the flat pad")
        pads.append(ramp["pad"])
        for idx in np.flatnonzero(labels == ramp["pad"]):
            z = lidar([xs.ravel()[idx]], [ys.ravel()[idx]])[0]
            if not np.isfinite(z):
                raise ValueError("no terrain measurement beneath the removed pad")
            ground.append([int(idx), round(float(z), 1)])
        paths = []
        for eid in ramp["approaches"]:
            edge = edges[eid]
            line = LineString(edge["pts"])
            span = level_spans(line, new, level)
            if len(span) != 2:
                raise ValueError(f"expected one deck-to-ground transition on {eid}")
            spans[eid] = span
            junction = edge["u"] if span[0][1] else edge["v"]
            for foot in tile.raw.get("walk", []):
                if foot.get("bridge") or foot.get("tunnel") or foot["hw"] != edge["hw"] or junction not in (foot["u"], foot["v"]):
                    continue
                walking = level_spans(LineString(foot["pts"]), new, level)
                if len(walking) == 2:
                    spans[foot["id"]] = walking
            at = span[1][0]
            contact = line.interpolate(at)
            out = 15 if span[0][1] else -15
            apron = substring(line, max(0, min(line.length, at-np.sign(out)*1.5)), max(0, min(line.length, at+out)))
            if apron.length <= 2:
                raise ValueError("no ground approach beyond the surveyed deck")
            paths.append((apron, edge["width"], contact))
        aprons.append(apron_patch(tile, ramp["name"], paths, profile, ground_at))
        # Verify that known elevated centre lines still have deck support.
        for e in edges.values():
            if e.get("level") == level:
                carried = LineString(e["pts"]).intersection(old)
                if carried.difference(new.buffer(.20)).length > .15:
                    raise ValueError(f"surveyed outline clips elevated edge {e['id']}")
        report.append(dict(name=ramp["name"], pad=ramp["pad"], covered_m2=round(new.area, 1)))
    shape = shapely.union_all([*remaining, *corrected])
    current["decks"].setdefault(key, {})[str(level)] = [_rings(p, .04) for p in shapely.get_parts(shape)]
    current["approaches"] = {key: dict(pads=pads, ground=ground,
                                        decks={str(level): [[i, z] for i, z in sorted(heights.items())]})}
    current["spans"] = spans
    current["ground"] = [*aprons, *current.get("ground", [])]
    return current, report


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    for name in ("data", "lidar", "current", "out", "report"):
        ap.add_argument(f"--{name}", type=Path, required=True)
    ap.add_argument("--spec", type=Path, default=Path(__file__).with_name("ramp_approaches.json"))
    args = ap.parse_args()
    current = json.loads(args.current.read_text())
    index = json.loads((args.data / "index.json").read_text())
    if (current.get("version"), current.get("area"), current.get("built")) != (1, index["area"], index["built"]):
        ap.error("bridge preview does not match this map")
    result, report = build(args.data, args.lidar, current, json.loads(args.spec.read_text()))
    write(args.out, json.dumps(result, separators=(",", ":")) + "\n")
    write(args.report, json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
