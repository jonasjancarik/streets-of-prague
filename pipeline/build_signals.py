"""Traffic lights at junctions, from OSM's highway=traffic_signals nodes, matched to the
car network of the streets layer (build_tiles.py first).

    uv run build_signals.py centrum     # → public/data/centrum_now/signals.json

OSM maps a junction's lights either on its node or on each street leading into it,
usually at the stop line, and then mostly with traffic_signals:direction saying which
way along the street they face. Each light is put on the car network's edges that
pass it and run the way it faces (or, without a direction, towards the nearer end),
if that end is a junction within MAX_BEFORE. The cars stop at the light, or, where it
stands on the junction itself, short of the streets crossing there. Streets into a
junction that has lights but none mapped for them get one at the usual distance.

Junction nodes whose lights are close together (a crossing of two dual carriageways
is four nodes) are one junction with one cycle. Its streets get the green in two
phases by the way they run: along the most important street, and across it. Where
all of them run the same way, the second phase is the pedestrians'.

signals.json: {"junctions": [[green0, green1, offset], ...] (seconds; a cycle runs
green0, amber, all red, green1, amber, all red from its offset), "edges": {edge id:
[metres before the edge's end where cars stop, junction, phase]}}. src/signals.ts
reads it.
"""

import json
import math
import random
import subprocess
import sys
import tempfile
from pathlib import Path

from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import LineString, Point

import layers
from osm_area import OUT

PBF_DIR = Path(__file__).parent / ".cache" / "osm"
MAX_BEFORE = 60.0  # the furthest a light stands before its junction (m)
NEAR = 2.5  # how far off a street's centre line a light may be mapped (m)
CLUSTER = 40.0  # junction nodes with lights this close work together (m)
# Lights that aren't a junction's: a crossing's for pedestrians, a railway crossing's.
NOT_JUNCTION = {"pedestrian_crossing", "pedestrian", "crossing", "level_crossing", "emergency", "blinker", "ramp_meter"}
RANK = ["motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link", "primary_link",
        "secondary_link", "tertiary_link", "unclassified", "residential", "living_street", "service"]


def opl(args):
    """osmium's OPL output as (id, tags, rest) per line."""
    out = subprocess.run(["osmium", *args, "-f", "opl", "-o", "-"], check=True, capture_output=True, text=True).stdout
    for line in out.splitlines():
        head, *fields = line.split(" ")
        rest = {f[0]: f[1:] for f in fields if f}
        tags = dict(t.split("=", 1) for t in rest.get("T", "").split(",") if "=" in t)
        yield int(head[1:]), tags, rest


def lights(pbf: Path, tf):
    """(x, y, (dx, dy) the way the light faces or None) of every junction light."""
    found = {}
    for nid, tags, rest in opl(["tags-filter", str(pbf), "n/highway=traffic_signals"]):
        if tags.get("traffic_signals") in NOT_JUNCTION:
            continue
        found[nid] = (float(rest["x"]), float(rest["y"]), tags.get("traffic_signals:direction"))
    # Which way the street runs at a light with a direction: from the way's node before
    # it to the one after.
    facing = {n for n, f in found.items() if f[2] in ("forward", "backward")}
    around = {}
    for _, tags, rest in opl(["tags-filter", "-R", str(pbf), "w/highway"]):
        refs = [int(r[1:]) for r in rest.get("N", "").split(",") if r]
        for i, n in enumerate(refs):
            if n in facing and n not in around:
                around[n] = (refs[max(0, i - 1)], refs[min(len(refs) - 1, i + 1)])
    at = {}
    wanted = {m for pair in around.values() for m in pair}
    if wanted:
        with tempfile.NamedTemporaryFile("w", suffix=".txt") as ids:
            ids.write("\n".join(f"n{n}" for n in wanted))
            ids.flush()
            at = {n: (float(r["x"]), float(r["y"])) for n, _, r in opl(["getid", str(pbf), "-i", ids.name])}
    out = []
    for n, (lon, lat, direction) in found.items():
        x, y = tf.transform(lon, lat)
        d = None
        if n in around and around[n][0] in at and around[n][1] in at:
            (ax, ay), (bx, by) = (tf.transform(*at[m]) for m in around[n])
            k = math.hypot(bx - ax, by - ay)
            if k > 0:
                s = 1 if direction == "forward" else -1
                d = (s * (bx - ax) / k, s * (by - ay) / k)
        out.append((x, y, d))
    return out


def drive_edges(area: str, meta: dict):
    edges = {}
    for ci, cj in layers.chunks(meta):
        for t in layers.read_chunk(area, "streets", ci, cj)["tiles"].values():
            for e in t["drive"]:
                edges.setdefault(e["id"], e)
    return list(edges.values())


def heading(line: LineString, s: float):
    a, b = line.interpolate(max(0.0, s - 4)), line.interpolate(min(line.length, s + 1))
    return math.atan2(b.y - a.y, b.x - a.x)


def build(area: str):
    meta = layers.read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: run build_tiles.py {area} first")
    pbf = PBF_DIR / f"{area}.osm.pbf"
    tf = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)
    found = lights(pbf, tf)
    edges = drive_edges(area, meta)
    lines = [LineString(e["pts"]) for e in edges]
    tree = STRtree(lines)
    # Junctions: nodes where three or more streets meet.
    near = {}
    for e in edges:
        near.setdefault(e["u"], set()).add(e["v"])
        near.setdefault(e["v"], set()).add(e["u"])
    into = {}
    for k, e in enumerate(edges):
        into.setdefault(e["v"], []).append(k)

    def clearance(k):
        """How far short of its end a car on edge k stops for a light on the junction:
        clear of the streets crossing there and the zebra before them."""
        e = edges[k]
        other = [edges[m]["width"] for m in into[e["v"]] if edges[m]["u"] != e["u"] and m != k]
        return min(20.0, max(5.0, max(other, default=6.0) / 2 + 3))

    stop = {}  # edge index → metres before its end
    for x, y, d in found:
        p = Point(x, y)
        for k in tree.query(p.buffer(NEAR), predicate="intersects"):
            e, line = edges[k], lines[k]
            along = line.project(p)
            before = line.length - along
            if len(near[e["v"]]) < 3 or before > MAX_BEFORE:
                continue
            if d:
                h = heading(line, along)
                if math.cos(h) * d[0] + math.sin(h) * d[1] < 0.5:
                    continue
            elif before > along and line.length > 2 * NEAR:
                continue  # nearer the other end: the light is for the junction there
            s = max(before, clearance(k))
            stop[k] = min(stop.get(k, math.inf), s)

    # A junction with lights has them on every street leading in, mapped or not.
    for v in {edges[k]["v"] for k in stop}:
        for k in into[v]:
            if k not in stop and lines[k].length > 2 * NEAR:
                stop[k] = clearance(k)

    # Junction nodes whose lights work together.
    nodes = sorted({edges[k]["v"] for k in stop})
    pos = {n: edges[into[n][0]]["pts"][-1] for n in nodes}
    parent = {n: n for n in nodes}

    def root(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n
    ntree = STRtree([Point(*pos[n]) for n in nodes])
    for i, n in enumerate(nodes):
        for j in ntree.query(Point(*pos[n]).buffer(CLUSTER)):
            a, b = root(n), root(nodes[j])
            if a != b:
                parent[max(a, b)] = min(a, b)
    groups = {}
    for k in stop:
        groups.setdefault(root(edges[k]["v"]), []).append(k)

    rank = lambda k: RANK.index(edges[k]["hw"]) if edges[k]["hw"] in RANK else len(RANK)
    junctions, out = [], {}
    for key in sorted(groups):
        ks = sorted(groups[key], key=lambda k: (rank(k), -lines[k].length, edges[k]["id"]))
        axis = heading(lines[ks[0]], lines[ks[0]].length - stop[ks[0]])
        phase = {}
        for k in ks:
            turn = abs(math.remainder(heading(lines[k], lines[k].length - stop[k]) - axis, math.pi))
            phase[k] = 0 if turn < math.pi / 4 else 1
        across = [rank(k) for k in ks if phase[k] == 1]
        # The main street's green is longer when it's the more important one; with nobody
        # across, the pedestrians get a short green of their own.
        g0, g1 = (20, 20) if across and min(across) <= rank(ks[0]) else (24, 16) if across else (26, 10)
        rnd = random.Random(key)
        junctions.append([g0, g1, round(rnd.uniform(0, g0 + g1 + 10), 1)])
        for k in ks:
            out[edges[k]["id"]] = [round(stop[k], 1), len(junctions) - 1, phase[k]]
    dest = OUT / f"{area}_now" / "signals.json"
    layers.write(dest, layers.dumps({"junctions": junctions, "edges": out}))
    print(f"{area}: {len(found)} lights, {len(out)} streets into {len(junctions)} junctions → {dest}")


if __name__ == "__main__":
    for a in sys.argv[1:] or ["centrum"]:
        build(a)
