"""Worn paths across the lawns of housing estates and meadows.

People don't walk the mapped way round a block when a straight line over the grass
saves them a third of the walk, so the grass wears bare along it. For each door of a
block of flats this finds the place people walk to from it (a public transport stop,
another block's door, or a node of the mapped walking network: where a footway ends
or branches) and, where a straight line across grass is at most MAX_WALK long and at
most 2/3 of the way round by the mapped network, draws that line as a bare ribbon.

Everything here comes from the map (OSM ids give the slight bend of each ribbon and
its width), so a path is the same in every build and in both of the chunks that
overlap at a seam. The footfall map is not used.
"""

import math
import zlib

import networkx as nx
import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, unary_union

MAX_WALK = 80.0  # m: the longest straight line drawn
MIN_WALK = 8.0
SAVING = 1 / 3  # the straight walk must save at least this share of the mapped one
DOOR_REACH = 30.0  # m: a door further from any mapped way than this isn't used
STEP = 4.0  # m between the network's nodes (OSM ways have few vertices)
FAR = 300.0  # m: the mapped walk where the network doesn't connect, or only by a long way
ON_GRASS = 0.9  # share of the line (bar its ends) that must be over grass
ENDS = 2.0  # m at each end that may be over paving
SIMILAR = 3.0  # m: a line this close to one already drawn along most of its length is dropped
WIDTH = (0.6, 0.9)
STOP_WIDTH = 1.0
EDGE = 0.4  # m: the soft rim round a ribbon


def _seed(*parts):
    return zlib.crc32("|".join(str(p) for p in parts).encode())


def _network(lines):
    """A graph of the mapped ways, noded where they cross and with a node every STEP m."""
    graph = nx.Graph()
    if not len(lines):
        return graph
    merged = shapely.union_all(shapely.segmentize(np.asarray(lines, dtype=object), STEP))
    for line in shapely.get_parts(merged):
        if not isinstance(line, LineString):
            continue
        pts = [(round(x, 1), round(y, 1)) for x, y in line.coords]
        for a, b in zip(pts, pts[1:]):
            if a != b:
                graph.add_edge(a, b, weight=math.dist(a, b))
    return graph


def _bend(a, b, seed):
    """Points from a to b, bowed a little to one side: a track is never ruler-straight."""
    length = math.dist(a, b)
    amp = ((seed % 2001) / 1000 - 1) * min(1.2, 0.04 * length)
    nx_, ny_ = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
    steps = max(2, int(length / 3))
    out = []
    for k in range(steps + 1):
        t = k / steps
        off = amp * math.sin(math.pi * t)
        out.append((a[0] + (b[0] - a[0]) * t + nx_ * off, a[1] + (b[1] - a[1]) * t + ny_ * off))
    return out


def worn_paths(grass, buildings, doors, stops, foot_lines, car_lines, obstacles):
    """The bare ribbons across `grass` (a polygon: estate lawns and meadows).

    buildings: {id: footprint}; doors: the ids of the blocks of flats to start from;
    stops: points of public transport stops; foot_lines: the mapped footways, paths and
    sidewalks (their ends and branches are places to walk to); car_lines: the streets,
    which people also walk along; obstacles: what a path can't cross (buildings, water,
    roads, walls). Returns [(centre line points, width, to a stop)] in local metres."""
    if grass.is_empty or not doors:
        return []
    near = grass.buffer(DOOR_REACH)
    doors = sorted(k for k in doors if buildings[k].intersects(near))
    region = grass.buffer(FAR / 2)
    foot_lines = [l for l in foot_lines if l.intersects(region)]
    car_lines = [l for l in car_lines if l.intersects(region)]
    graph = _network(foot_lines + car_lines)
    if not doors or not graph:
        return []
    nodes = list(graph.nodes)
    node_tree = STRtree(shapely.points(np.array(nodes)))

    def snap(point):
        node = nodes[int(node_tree.nearest(point))]
        return node, point.distance(Point(node))

    net = unary_union(foot_lines + car_lines)
    # Where a footway ends or branches: its nodes with other than two neighbours.
    foot = _network(foot_lines)
    places = [n for n, degree in foot.degree if degree != 2 and n in graph]
    door_at = {}
    for k in doors:
        point = nearest_points(buildings[k].boundary, net)[0]
        if point.distance(net) <= DOOR_REACH:
            door_at[k] = point
    targets = [(Point(n), "place", None) for n in places]
    targets += [(Point(p), "stop", None) for p in stops]
    targets += [(p, "door", k) for k, p in door_at.items()]
    target_tree = STRtree([t[0] for t in targets])
    grass_wide = grass.buffer(0.5)
    out, taken = [], []
    for k in sorted(door_at):
        d = door_at[k]
        own = buildings[k].buffer(-0.5)
        start, extra = snap(d)
        lengths = nx.single_source_dijkstra_path_length(graph, start, cutoff=FAR)
        options = []
        for t in target_tree.query(d.buffer(MAX_WALK)):
            point, kind, other = targets[t]
            straight = d.distance(point)
            if other == k or not MIN_WALK <= straight <= MAX_WALK:
                continue
            end, extra_end = snap(point)
            mapped = min(FAR, lengths.get(end, FAR) + extra + extra_end)
            if straight > (1 - SAVING) * mapped:
                continue
            line = LineString([d, point])
            if line.intersects(own):
                continue
            if straight > 2 * ENDS + 1:  # the ends may be over paving, the rest over grass
                a, b = shapely.line_interpolate_point(line, [ENDS, straight - ENDS])
                line = LineString([a, b])
            if line.intersection(grass_wide).length < ON_GRASS * line.length or line.intersects(obstacles):
                continue
            options.append((mapped - straight, kind, (point.x, point.y), other))
        if not options:
            continue
        options.sort(key=lambda o: (-round(o[0], 1), o[2]))
        _, kind, to, other = options[0]
        seed = _seed(k, other if other is not None else f"{to[0]:.0f},{to[1]:.0f}")
        pts = _bend((d.x, d.y), to, seed)
        centre = LineString(pts)
        near_ones = [t for t in taken if t.distance(centre) < SIMILAR]
        if near_ones and centre.intersection(unary_union(near_ones).buffer(SIMILAR)).length >= 0.7 * centre.length:
            continue
        taken.append(centre)
        width = STOP_WIDTH if kind == "stop" else round(WIDTH[0] + (seed % 4) * (WIDTH[1] - WIDTH[0]) / 3, 2)
        out.append((pts, width, kind == "stop"))
    return out


def ribbons(paths):
    """(the bare earth, its soft rim) as polygons."""
    if not paths:
        return None, None
    core = unary_union([LineString(pts).buffer(w / 2, cap_style="round", join_style="round") for pts, w, _ in paths])
    return core, unary_union([LineString(pts).buffer(w / 2 + EDGE, cap_style="round", join_style="round") for pts, w, _ in paths])
