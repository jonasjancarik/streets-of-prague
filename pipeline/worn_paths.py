"""Worn paths across the lawns of housing estates and meadows.

People don't walk the mapped way round a block when a straight line over the grass
saves them a third of the walk, so the grass wears bare along it. For each door of a
block of flats this finds the place people walk to from it (a public transport stop,
another block's door, or a node of the mapped walking network: where a footway ends
or branches) and, where a straight line across grass is at most MAX_WALK long and at
most 2/3 of the way round by the mapped network, draws that line as a bare ribbon.

A block's doors are its OSM entrances (entrance=main, yes, staircase, home…) where the
block has any mapped; where it has none, one door is assumed at the point of its outline
nearest a mapped way. Where the area has a footfall map (build_footfall.py: how busy each
place is, the same map the game's crowd follows), a door's path goes to the place that
saves the most walking weighted by how busy that place is, and the busier it is the wider
the path is worn; without the map every place counts the same and the width comes from
the OSM ids, as it did before.

Everything here comes from the map (OSM ids give the slight bend of each ribbon), so a
path is the same in every build and in both of the chunks that overlap at a seam.
"""

import json
import math
import zlib
from pathlib import Path

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
DOORS = ("main", "yes", "staircase", "home", "residential", "secondary", "entrance")  # OSM entrance=* that people use
ON_OUTLINE = 1.5  # m: an entrance this close to a block's outline is that block's door
BUSY_PULL = 2.0  # a place as busy as the Old Town Square draws 1 + this times a quiet one's share
BUSY_WIDTH = (0.6, 1.2)  # m: a path's width from the quietest to the busiest places


class Footfall:
    """The area's footfall map (footfall.png and footfall.json, see build_footfall.py):
    busy(x, y) is 0 where nobody is about and 1 at the Old Town Square's level."""

    def __init__(self, share, box, cell):
        self.share, self.box, self.cell = share, box, cell

    @classmethod
    def load(cls, folder):
        """The map kept in `folder` (public/data/<area>_now), or None if there is none."""
        try:
            from PIL import Image
            meta = json.loads((Path(folder) / "footfall.json").read_text())
            grey = np.asarray(Image.open(Path(folder) / "footfall.png").convert("L"), dtype=np.float32)
        except (OSError, ValueError):
            return None
        return cls((grey / 255) ** 2, meta["box"], meta["cell"])  # (the grey is the square root)

    def busy(self, x, y):
        x0, _, _, y1 = self.box
        i, j = int((x - x0) / self.cell), int((y1 - y) / self.cell)
        h, w = self.share.shape
        return float(self.share[j, i]) if 0 <= i < w and 0 <= j < h else 0.0


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


def worn_paths(grass, buildings, doors, stops, foot_lines, car_lines, obstacles, entrances=(), footfall=None):
    """The bare ribbons across `grass` (a polygon: estate lawns and meadows).

    buildings: {id: footprint}; doors: the ids of the blocks of flats to start from;
    stops: points of public transport stops; foot_lines: the mapped footways, paths and
    sidewalks (their ends and branches are places to walk to); car_lines: the streets,
    which people also walk along; obstacles: what a path can't cross (buildings, water,
    roads, walls), as a list of shapes or one shape; entrances: the points of OSM's
    entrances; footfall: the area's Footfall, if it has one. Returns [(centre line points, width, to a stop)] in local metres."""
    if grass.is_empty or not doors:
        return []
    # Distances to the grass, not the grass grown by them: buffering a chunk's lawns and
    # meadows by 150 m took a third of the whole chunk's time.
    shapely.prepare(grass)
    doors = sorted(k for k in doors if shapely.dwithin(buildings[k], grass, DOOR_REACH))

    def close(lines):
        if not lines:
            return []
        keep = shapely.dwithin(np.asarray(lines, dtype=object), grass, FAR / 2)
        return [l for l, yes in zip(lines, keep) if yes]

    foot_lines, car_lines = close(foot_lines), close(car_lines)
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
    # Each block's doors: (block, number) → point. The mapped entrances on its outline, or
    # failing those the point of the outline nearest a mapped way.
    door_at = {}
    entrance_points = shapely.points(np.array(entrances, dtype=float).reshape(-1, 2)) if len(entrances) else np.array([], dtype=object)
    entrance_tree = STRtree(entrance_points) if len(entrance_points) else None
    for k in doors:
        outline = buildings[k].boundary
        mapped = sorted(entrance_tree.query(outline, predicate="dwithin", distance=ON_OUTLINE)) if entrance_tree is not None else []
        found = [entrance_points[m] for m in mapped] or [nearest_points(outline, net)[0]]
        for number, point in enumerate(found):
            if point.distance(net) <= DOOR_REACH:
                door_at[k, number] = point
    targets = [(Point(n), "place", None) for n in places]
    targets += [(Point(p), "stop", None) for p in stops]
    targets += [(p, "door", key) for key, p in door_at.items()]
    target_tree = STRtree([t[0] for t in targets])
    # The grass in pieces and the obstacles one by one, each found through an index: a
    # candidate line is tested against what is near it, not against the whole chunk.
    grass_parts = [g for g in shapely.get_parts(grass.buffer(0.5)) if not g.is_empty]
    grass_tree = STRtree(grass_parts)
    blocking = [g for g in (obstacles if isinstance(obstacles, (list, tuple)) else shapely.get_parts(obstacles)) if not g.is_empty]
    blocking_tree = STRtree(blocking)

    def on_grass(line):
        return sum(line.intersection(grass_parts[i]).length for i in grass_tree.query(line, predicate="intersects"))

    out, taken = [], []
    for key in sorted(door_at):
        k = key[0]
        d = door_at[key]
        own = buildings[k].buffer(-0.5)
        start, extra = snap(d)
        lengths = nx.single_source_dijkstra_path_length(graph, start, cutoff=FAR)
        options = []
        for t in target_tree.query(d.buffer(MAX_WALK)):
            point, kind, other = targets[t]
            straight = d.distance(point)
            if (other is not None and other[0] == k) or not MIN_WALK <= straight <= MAX_WALK:
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
            if on_grass(line) < ON_GRASS * line.length or len(blocking_tree.query(line, predicate="intersects")):
                continue
            pull = 1 + BUSY_PULL * math.sqrt(footfall.busy(point.x, point.y)) if footfall else 1.0
            options.append(((mapped - straight) * pull, kind, (point.x, point.y), other))
        if not options:
            continue
        options.sort(key=lambda o: (-round(o[0], 1), o[2]))
        _, kind, to, other = options[0]
        seed = _seed(*key, other if other is not None else f"{to[0]:.0f},{to[1]:.0f}")
        pts = _bend((d.x, d.y), to, seed)
        centre = LineString(pts)
        near_ones = [t for t in taken if t.distance(centre) < SIMILAR]
        if near_ones and centre.intersection(unary_union(near_ones).buffer(SIMILAR)).length >= 0.7 * centre.length:
            continue
        taken.append(centre)
        if footfall:
            here = math.sqrt(max(footfall.busy(*to), footfall.busy((d.x + to[0]) / 2, (d.y + to[1]) / 2)))
            width = round(BUSY_WIDTH[0] + min(1.0, 2.5 * here) * (BUSY_WIDTH[1] - BUSY_WIDTH[0]), 2)
        else:
            width = STOP_WIDTH if kind == "stop" else round(WIDTH[0] + (seed % 4) * (WIDTH[1] - WIDTH[0]) / 3, 2)
        out.append((pts, width, kind == "stop"))
    return out


def ribbons(paths):
    """(the bare earth, its soft rim) as polygons."""
    if not paths:
        return None, None
    core = unary_union([LineString(pts).buffer(w / 2, cap_style="round", join_style="round") for pts, w, _ in paths])
    return core, unary_union([LineString(pts).buffer(w / 2 + EDGE, cap_style="round", join_style="round") for pts, w, _ in paths])
