"""Bake the central Vltava's bank reflections without rendering the city twice in play.

    uv run river_reflections.py

Requires the generated praha map and Blender. IPR Praha's CC BY 2023 aerial mesh
provides the stationary banks. Boat wakes, vessels and the modelled bridge are live.
"""
import gzip
import io
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import CRS, Transformer
from scipy.ndimage import distance_transform_edt, label
from shapely import contains_xy
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from landmarks import BLENDER, write_glb
from photomesh import fetch, nodes_over, prefetch, triangles

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public/data/praha_now"
CACHE = ROOT / "pipeline/.cache/vltava-reflections"
ORIGIN = (14.410235, 50.08661)


def waterways(points, origin, tile):
    indices = np.floor((points + origin) / tile).astype(int)
    keys = {(i + di, j + dj) for i, j in indices for di in range(-3, 4) for dj in range(-3, 4)}
    wet, bridges = [], []
    for i, j in sorted(keys):
        path = DATA / f"tiles/{i}_{j}.json"
        if not path.exists():
            continue
        source = json.loads(path.read_text(encoding="utf-8"))
        outlines = [(wet, source["areas"].get("water", []))]
        outlines.extend((bridges, st["polys"]) for st in source.get("structures", []) if st["kind"] == "bridge")
        for destination, polygons in outlines:
            for outer, *holes in polygons:
                shape = Polygon(outer, holes)
                destination.append(shape if shape.is_valid else shape.buffer(0))
    return unary_union(wet), unary_union(bridges)


def open_channel(points, water):
    # The navigable channel sometimes follows a lock beside an island. The
    # reflection point needs the broad, unobstructed stretch alongside it.
    centres = []
    for k, p in enumerate(points):
        along = points[min(k+2, len(points)-1)] - points[max(0, k-2)]
        normal = np.array([-along[1], along[0]]) / np.linalg.norm(along)
        cross = LineString([p - normal*280, p + normal*280]).intersection(water)
        parts = [cross] if cross.geom_type == "LineString" else getattr(cross, "geoms", [])
        candidates = [s for s in parts if s.geom_type == "LineString" and s.length >= 36 and s.distance(Point(p)) < 195]
        if candidates:
            section = max(candidates, key=lambda s: s.length - .65*s.distance(Point(p)))
            centre = section.interpolate(.5, normalized=True)
            centres.append([centre.x, centre.y])
        else:
            centres.append(p)
    line = LineString(centres)
    result = []
    for at in np.linspace(0, line.length, min(40, round(line.length/94)+1)):
        p = line.interpolate(at)
        if not water.contains(p) or water.boundary.distance(p) < 11:
            p = Point(min(centres, key=lambda c: p.distance(Point(c))))
        result.append([p.x, p.y])
    return result


def bank_mesh(points, water, bridges, crs, anchor, datum):
    to_merc = Transformer.from_crs(crs, "EPSG:3857", always_xy=True)
    local = Transformer.from_crs("EPSG:3857", crs, always_xy=True)
    mx, my = to_merc.transform(points[:, 0], points[:, 1])
    nodes = nodes_over((mx.min()-600, my.min()-600, mx.max()+600, my.max()+600), 12)
    selected = []
    for node in nodes:
        cx, cy, _, radius = node["mbs"]
        x, y = local.transform(cx, cy)
        if np.hypot(points[:, 0]-x, points[:, 1]-y).min() < 330 + radius*.65:
            selected.append(node)
    shore, middle, span, edge = water.buffer(360), water.buffer(-1.4), bridges.buffer(2.5), water.buffer(12)

    def read(node):
        xyz, uvs = triangles(node)
        x, y = local.transform(xyz[:, 0], xyz[:, 1])
        p = np.column_stack((x, y, xyz[:, 2]-datum)).reshape(-1, 3, 3)
        c = p.mean(1)
        # Remove the survey's water, frozen boats and the often solid curtain
        # of triangles beneath a scanned bridge. The real city shows through.
        river = contains_xy(water, c[:, 0], c[:, 1])
        across = contains_xy(middle, p[:, :, 0], p[:, :, 1]).any(1)
        on_span = contains_xy(span, c[:, 0], c[:, 1]) & contains_xy(edge, c[:, 0], c[:, 1]) & (c[:, 2] < 28)
        keep = contains_xy(shore, c[:, 0], c[:, 1]) & ~river & ~across & ~on_span
        if not keep.any():
            return None
        selected = p[keep].copy()
        selected[:, :, :2] -= anchor
        return selected.reshape(-1, 3), uvs.reshape(-1, 3, 2)[keep].reshape(-1, 2), fetch(f"nodes/{node['id']}/textures/0")

    prefetch(selected, workers=6)
    # GEOS lazily indexes the shared bank polygons on their first query.
    # Fetch the node files in parallel, then clip against those polygons in order.
    parts = [part for node in selected if (part := read(node)) is not None]
    write_glb(CACHE / "banks.glb", parts)


def prepare():
    index = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
    west, south, east, north = index["bbox_wgs84"]
    crs = CRS.from_proj4(f"+proj=tmerc +lon_0={(west+east)/2} +lat_0={(south+north)/2} +ellps=WGS84 +units=m")
    to_local = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
    to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    anchor = np.array(to_local.transform(*ORIGIN))
    points = []
    for reach in json.loads((DATA / "river.json").read_text(encoding="utf-8"))["fairway"]:
        pts = np.array(reach["pts"])[:, :2]
        lon, lat = to_wgs.transform(pts[:, 0], pts[:, 1])
        pts = pts[(lat > 50.0728) & (lat < 50.0970) & (lon > 14.396) & (lon < 14.4365)]
        if len(pts) < 2:
            continue
        line = LineString(pts)
        for at in np.linspace(0, line.length, max(1, round(line.length/82))+1):
            p = line.interpolate(at)
            if not any(math.hypot(p.x-x, p.y-y) < 40 for x, y in points):
                points.append([p.x, p.y])
    if len(points) < 2:
        raise ValueError("The Prague map has no fairway along the central Vltava")
    points = np.asarray(points)
    origin, tile, datum = np.array(index["origin"]), index["tile"], index.get("iprRef", 180)
    water, bridges = waterways(points, origin, tile)
    bank_mesh(points, water, bridges, crs, anchor, datum)
    stations = []
    n = index["terrain"]["n"]
    for x, y in open_channel(points, water):
        i, j = np.floor((np.array([x, y])+origin)/tile).astype(int)
        data = gzip.decompress((DATA / f"tiles/{i}_{j}.height.bin.gz").read_bytes())
        hm = np.frombuffer(data, dtype="<u2", count=n*n).reshape(n, n)
        col, row = (np.clip((np.array([x, y])+origin)/tile - [i, j], 0, 1)*(n-1)).astype(int)
        height = float(np.clip(100 + index["terrain"].get("unit", .1)*float(hm[row, col]), 184, 189)) - datum
        shore = []
        for angle in np.linspace(-math.pi, math.pi, 360, endpoint=False):
            ray = LineString([(x, y), (x+510*math.sin(angle), y+510*math.cos(angle))])
            hit = ray.intersection(water.boundary)
            shore.append(510 if hit.is_empty else round(np.clip(Point(x, y).distance(hit), 5, 510)))
        stations.append({"wgs": to_wgs.transform(x, y), "p": [x-anchor[0], y-anchor[1], height+.35],
                         "water": height+datum-180, "shore": shore})
    (CACHE / "stations.json").write_text(json.dumps(stations), encoding="utf-8")
    return stations


def pad(image):
    # Wrap azimuth, extend the edge in elevation. Bilinear samples cannot
    # pick up the adjacent station's skyline or its distance data.
    block = np.pad(image, ((2, 2), (2, 2), (0, 0)), mode="edge")
    block[:, :2] = block[:, -4:-2]
    block[:, -2:] = block[:, 2:4]
    return Image.fromarray(block)


def pack(stations):
    atlas = Image.new("RGBA", (2048, 1024), (70, 85, 72, 0))
    positions = []
    for i, station in enumerate(stations):
        rgba = np.asarray(Image.open(CACHE / f"colour-{i:02}.png").convert("RGBA"))
        mask = rgba[:, :, 3] > 120
        if mask[:28].mean() > .145 or np.percentile(station["shore"], 10) < 17:
            continue
        components, _ = label(mask)
        keep = np.bincount(components.ravel())[components] >= 7
        mask &= keep
        iy, ix = distance_transform_edt(~mask, return_distances=False, return_indices=True)
        rgb = rgba[iy, ix, :3].astype(float)
        lum = rgb @ np.array([.24, .60, .16])
        rgb = (lum[:, :, None]*.16 + rgb*.84)*1.03
        alpha = np.where(keep, rgba[:, :, 3], 0)
        colour = Image.fromarray(np.dstack((np.uint8(np.clip(rgb, 0, 255)), alpha)))
        k = len(positions)
        atlas.paste(pad(np.asarray(colour.resize((508, 62), Image.Resampling.LANCZOS))), (k%4*512, k//4*66))
        depth = np.asarray(Image.open(CACHE / f"depth-{i:02}.png").convert("RGBA").resize((252, 44), Image.Resampling.BILINEAR))
        coast = np.interp(np.arange(252)*360/252, np.arange(361), station["shore"] + station["shore"][:1])/2
        distances = np.where((depth[:, :, 3] > 160) & (depth[:, :, 0] > 1), depth[:, :, 0], np.clip(coast, 2, 255))
        depth_pixels = np.full((44, 252, 4), 120, dtype=np.uint8)
        depth_pixels[:, :, 3] = distances
        atlas.paste(pad(depth_pixels), (k%8*256, 736 + k//8*48))
        positions.append([round(v, 7) for v in station["wgs"]] + [round(station["water"], 2)])
    if not 2 <= len(positions) <= 44:
        raise ValueError(f"Unexpected number of river stations: {len(positions)}")
    atlas.save(ROOT / "public/vltava-banks.webp", quality=87, method=6, exact=True)
    (ROOT / "src/riverBankStations.json").write_text(json.dumps(positions, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(positions)} water-level views")


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    stations = prepare()
    subprocess.run([BLENDER, "-b", "--factory-startup", "-P", str(Path(__file__).with_name("river_reflection_bake.py")), "--", str(CACHE)], check=True)
    pack(stations)
