"""Traffic lights at junctions, from the technical map's surveyed poles (ipr_utility.py, run
first), matched to the car network of the streets layer (build_tiles.py first).

    uv run build_signals.py praha     # → public/data/praha_now/signals.json

Every surveyed pole is a light, standing where the map has it. One that isn't a crossing's
(below) belongs to the street into a junction whose centre line it is nearest to (within POLE_REACH, on the right of it, up to
POLE_BEFORE before the junction) and faces the traffic coming along that street; the cars
stop at the nearest pole of the street, or, where it stands on the junction itself, short of
the streets crossing there. Poles no street claims are left out, and so are junctions with
too few poles (below). A street into such a junction with no pole of its own has no light
(the survey has none there). OSM's traffic_signals nodes are not used: they are not
reliable.

The map gives a pole's place only, not what kind of light it is or which way it faces.
A pole at an end of a zebra crossing (the ground layer's crossings, met with the streets'
centre lines; beside it along the street, at its kerb) is the pedestrians' light, facing
across to the crossing's other end; the cars' lights stand further back, before the stop
line. A crossing's light belongs to the junction within WALK_NEAR of it and is green
while the street it crosses has red; the cars stop before it. Crossings with lights and
no such junction (a crossing of their own) are left out. A junction has lights with
MIN_POLES poles, at least one a car's, or with lights at crossings over two of its
streets.

Junction nodes whose lights are close together (a crossing of two dual carriageways
is four nodes) are one junction with one cycle. Its streets get the green in two
phases by the way they run: along the most important street, and across it. Where
all of them run the same way, the second phase is the pedestrians'.

signals.json: {"junctions": [[green0, green1, offset], ...] (seconds; a cycle runs
green0, amber, all red, green1, amber, all red from its offset), "edges": {edge id:
[metres before the edge's end where cars stop, junction, phase, then the x and y of each of
its surveyed poles]}, "walk": {edge id: [junction, phase, x, y, the way it faces in
degrees anticlockwise from east, then the same for the next light] for the crossings'
lights over that edge}}. src/signals.ts reads it.
"""

import json
import math
import random
import sys

from shapely import STRtree
from shapely.geometry import LineString, Point

import layers
from osm_area import OUT

POLE_REACH = 14.0  # how far off a street's centre line a light's surveyed pole may be (m)
POLE_BEFORE = 40.0  # how far before its junction (m)
MIN_POLES = 2  # the fewest poles at a junction for it to have lights
# A pole at an end of a zebra crossing (as far along the street from its middle, as far
# in from the kerb towards the centre line, as far out over the pavement) is its light.
WALK_ALONG, WALK_IN, WALK_OUT = 2.5, 2.5, 4.0
ZEBRA = 3.0  # how far before a crossing's middle line cars stop (m)
WALK_NEAR = 30.0  # how far from a junction a crossing with lights is that junction's (m)
CLUSTER = 40.0  # junction nodes with lights this close work together (m)
RANK = ["motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link", "primary_link",
        "secondary_link", "tertiary_link", "unclassified", "residential", "living_street", "service"]


def drive_edges(area: str, meta: dict):
    edges = {}
    for ci, cj in layers.chunks(meta):
        for t in layers.read_chunk(area, "streets", ci, cj)["tiles"].values():
            for e in t["drive"]:
                edges.setdefault(e["id"], e)
    return list(edges.values())


def crossing_ends(area: str, meta: dict, edges: list, lines: list):
    """Where the zebra crossings (the ground layer's, OSM's lines) cross the car network's
    centre lines: the point, the street's way there and its kerbs, right and left
    (surveyed, or half its width), the edge, and how far along it from each end."""
    pieces = []
    for ci, cj in layers.chunks(meta):
        for t in layers.read_chunk(area, "ground", ci, cj)["tiles"].values():
            pieces += [LineString(c) for c in t.get("crossings", []) if len(c) > 1]
    ok = [k for k, e in enumerate(edges) if not e.get("tunnel") and not e.get("bridge")]
    tree = STRtree([lines[k] for k in ok])
    out, seen = [], set()
    for piece in pieces:
        for j in tree.query(piece, predicate="intersects"):
            k = ok[j]
            x = piece.intersection(lines[k])
            for p in getattr(x, "geoms", [x]):
                key = (k, round(p.x / 2), round(p.y / 2))  # (a crossing cut by a tile's edge)
                if p.geom_type != "Point" or key in seen:
                    continue
                seen.add(key)
                line, e = lines[k], edges[k]
                s = line.project(p)
                h = heading(line, min(line.length, s + 1.5))
                kerb = e.get("kerb") or [e["width"] / 2] * 2
                out.append({"at": (p.x, p.y), "r": (math.cos(h), math.sin(h)), "kerb": kerb, "k": k,
                            "to_u": s, "to_v": line.length - s})
    return out


def heading(line: LineString, s: float):
    a, b = line.interpolate(max(0.0, s - 4)), line.interpolate(min(line.length, s + 1))
    return math.atan2(b.y - a.y, b.x - a.x)


def build(area: str):
    meta = layers.read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: run build_tiles.py {area} first")
    edges = drive_edges(area, meta)
    lines = [LineString(e["pts"]) for e in edges]
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

    # The surveyed poles are where the lights stand. One at an end of a zebra crossing is
    # the pedestrians' light, facing across to the other end: the car network's lights
    # stand before the crossing, back along the street (see crossing_ends).
    poles = [Point(*p) for p in (layers.read_layer(area, "utility") or {}).get("signals", [])]
    ends = crossing_ends(area, meta, edges, lines)
    etree = STRtree([Point(*c["at"]) for c in ends]) if ends else None
    walk_of = {}  # pole index → (index in ends, which side of the street: + right)
    if etree is not None:
        for m, pt in enumerate(poles):
            best = None
            for i in etree.query(pt.buffer(WALK_ALONG + 12)):
                c = ends[i]
                dx, dy = pt.x - c["at"][0], pt.y - c["at"][1]
                along = dx * c["r"][0] + dy * c["r"][1]
                side = dx * c["r"][1] - dy * c["r"][0]  # + right of the street's way
                out = abs(side) - (c["kerb"][0] if side > 0 else c["kerb"][1])
                if abs(along) <= WALK_ALONG and -WALK_IN <= out <= WALK_OUT:
                    score = abs(along) + abs(out - 1)
                    if best is None or score < best[0]:
                        best = (score, i, side)
            if best:
                walk_of[m] = (best[1], best[2])

    # The rest each belong to the street into a junction whose centre line they are nearest
    # to, on its right-hand side, and face the traffic coming along it. Poles that no street
    # claims (a tram's, a crossing's far from any junction) are left out.
    ltree = STRtree(lines)
    claims = {}  # edge index → [(metres before its end, pole index)]
    for m, pt in enumerate(poles):
        if m in walk_of:
            continue
        best = None
        for k in ltree.query(pt.buffer(POLE_REACH)):
            line = lines[k]
            along = line.project(pt)
            before, d = line.length - along, line.distance(pt)
            h, q = heading(line, along), line.interpolate(along)
            side = (pt.x - q.x) * math.sin(h) - (pt.y - q.y) * math.cos(h)
            if len(near[edges[k]["v"]]) >= 3 and d <= POLE_REACH and before <= POLE_BEFORE and side > -1.0:
                if best is None or d < best[0]:
                    best = (d, k, before)
        if best:
            claims.setdefault(best[1], []).append((best[2], m))
    # The crossings' lights by the junction they're at: a crossing on a street into or out
    # of it, within WALK_NEAR of it.
    walk_at = {}  # junction node → [pole index]
    for m, (i, _) in walk_of.items():
        c = ends[i]
        for n, d in ((edges[c["k"]]["v"], c["to_v"]), (edges[c["k"]]["u"], c["to_u"])):
            if len(near[n]) >= 3 and d <= WALK_NEAR:
                walk_at.setdefault(n, []).append(m)
                break
    # A junction has lights where it has at least MIN_POLES of them, a car's among them, or
    # crossings with lights over two of its streets or more. A lone pole is a crossing's;
    # a crossing's pair on its own may be a crossing with lights of its own nearby.
    count, cars, over = {}, {}, {}
    for k, c in claims.items():
        count[edges[k]["v"]] = count.get(edges[k]["v"], 0) + len(c)
        cars[edges[k]["v"]] = cars.get(edges[k]["v"], 0) + len(c)
    for n, ms in walk_at.items():
        count[n] = count.get(n, 0) + len(ms)
        over[n] = {frozenset((edges[ends[walk_of[m][0]]["k"]][x] for x in "uv")) for m in ms}
    lit = {n for n in count if (count[n] >= MIN_POLES and cars.get(n, 0)) or len(over.get(n, ())) >= 2}
    stop = {}  # edge index → metres before its end
    pole_of = {}
    for k, c in claims.items():
        if edges[k]["v"] in lit:
            pole_of[k] = [m for _, m in sorted(c)]
            stop[k] = max(min(b for b, _ in c), clearance(k))

    # A junction with lights has phases for all its streets, those with no pole of their own
    # too; they just get no light (the survey has none there).
    phantom = set()
    for v in lit:
        for k in into.get(v, []):
            if k not in stop and lines[k].length > 5:
                stop[k] = clearance(k)
                phantom.add(k)
    # And the cars stop before a crossing with lights on their way in, not on it.
    lit_crossings = {(frozenset((edges[ends[i]["k"]][x] for x in "uv")), round(ends[i]["at"][0]), round(ends[i]["at"][1]))
                     for i, _ in walk_of.values()}
    for c in ends:
        k = c["k"]
        key = (frozenset((edges[k][x] for x in "uv")), round(c["at"][0]), round(c["at"][1]))
        if k in stop and c["to_v"] <= WALK_NEAR and key in lit_crossings:
            stop[k] = max(stop[k], c["to_v"] + ZEBRA)

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
    junctions, out, axes = [], {}, []
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
        axes.append(axis)
        for k in ks:
            if k in phantom:
                continue
            out[edges[k]["id"]] = [round(stop[k], 1), len(junctions) - 1, phase[k]]
            for m in pole_of.get(k, []):
                out[edges[k]["id"]] += [round(poles[m].x, 1), round(poles[m].y, 1)]

    # The crossings' lights: the junction's whose street they cross (or, where that street
    # meets it at a node of its own, the nearest junction node with lights), green while
    # the street's traffic has red; facing across to the crossing's other end.
    jof = {key: n for n, key in enumerate(sorted(groups))}
    walk, unlit = {}, 0
    for m, (i, side) in sorted(walk_of.items()):
        c = ends[i]
        e = edges[c["k"]]
        n = next((n for n, d in ((e["v"], c["to_v"]), (e["u"], c["to_u"])) if n in parent and d <= WALK_NEAR), None)
        if n is None:
            got = [nodes[j] for j in ntree.query(Point(*c["at"]).buffer(WALK_NEAR))]
            n = min(got, key=lambda n: math.dist(pos[n], c["at"]), default=None)
        if n is None:
            unlit += 1
            continue
        j = jof[root(n)]
        turn = abs(math.remainder(math.atan2(c["r"][1], c["r"][0]) - axes[j], math.pi))
        rx, ry = c["r"]
        face = math.atan2(rx, -ry) if side > 0 else math.atan2(-rx, ry)
        walk.setdefault(e["id"], []).extend([j, 1 if turn < math.pi / 4 else 0, round(poles[m].x, 1), round(poles[m].y, 1),
                                             round(math.degrees(face)) % 360])
    dest = OUT / f"{area}_now" / "signals.json"
    layers.write(dest, layers.dumps({"junctions": junctions, "edges": out, "walk": walk}))
    cars = sum(map(len, pole_of.values()))
    print(f"{area}: {len(out)} streets into {len(junctions)} junctions; of {len(poles)} surveyed poles {cars} cars' lights, "
          f"{len(walk_of) - unlit} crossings' ({unlit} more at crossings without a junction with lights), "
          f"{len(poles) - cars - len(walk_of)} left out → {dest}")


if __name__ == "__main__":
    for a in sys.argv[1:] or ["centrum"]:
        build(a)
