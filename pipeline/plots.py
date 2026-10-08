"""What stands on the plots of family houses (plans 025 and 029): the gate, the paved
strip from it to the house or the garage, the hedges and fences along the edges, the
places for cars on the drive, and now and then a shed, a vegetable bed or a pool.

osm_area._gardens divides a block into plots (osm_area._plots) and calls furnish()
with them. Everything is chosen from the OSM ids of the houses, so a plot looks the
same in every build.
"""

import math
import random
import zlib

import numpy as np
import shapely
import shapely.affinity
from shapely import STRtree
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, unary_union

PLOT_TOLERANCE = 1.0  # m: plot edges are straightened more than mapped fences, so they read as boundaries and not as Voronoi curves
GATE = 1.6  # m each side of the gate that the street's fence leaves open
SHORTEST = 0.4  # m: a piece of fence or hedge shorter than this is left out
NEIGHBOURS = 15.0  # m: houses further apart than this have no hedge or fence between their gardens
GARDEN = 18.0  # m: no hedge or fence stands further from the house it belongs to (a plot is the Voronoi cell, so in a sparse block its edges run across open lawn)
DRIVE_IN = 3.3  # m from the gate to the middle of a car on the drive
DRIVE_ROOM = 6.2  # m of plot between the gate and the house that a car needs
CAR = (4.6, 2.2)  # m, what has to be free of buildings
DRIVE_WIDTH = 3.0  # m of paving where a car can stand
PATH_WIDTH = 1.3  # m: the path to the door where there is no room for a car
PAVEMENT = 4.5  # m from a street's edge within which a way through the block is its pavement
BEFORE_GARAGE = 3.0  # m from a garage's door to the middle of the car in front of it
GARAGES = {"garage", "garages", "carport"}
# How often a plot has each of the small things. A shed only where OSM maps no
# outbuilding on the plot, a pool only on a plot of POOL_PLOT m² or more.
SHED, BED, POOL = 0.3, 0.25, 0.09
POOL_PLOT = 350
EDGE = 0.8  # m of grass kept between a small thing and the plot's edge, the house or the paving


def _lines(g):
    if isinstance(g, LineString):
        return [g] if not g.is_empty else []
    return [ln for ln in getattr(g, "geoms", []) if isinstance(ln, LineString)]


def _coords(ls):
    return [[round(x, 2), round(y, 2)] for x, y in ls.coords]


def _seed(*parts):
    return zlib.crc32("|".join(str(p) for p in parts).encode())


def _rect(x, y, length, width, angle):
    return shapely.affinity.rotate(box(x - length / 2, y - width / 2, x + length / 2, y + width / 2),
                                   angle, origin=(x, y), use_radians=True)


def _gate(front, aim):
    """The point of a plot's street edge nearest `aim`, a gate's half-width or more from
    the ends of the edge where it is long enough (so not in the plot's corner)."""
    best = None
    for ls in _lines(shapely.line_merge(front) if front.geom_type == "MultiLineString" else front):
        if ls.length <= 2 * GATE + 0.5:
            continue
        pts = shapely.line_interpolate_point(ls, np.arange(GATE, ls.length - GATE, 0.5))
        d = shapely.distance(pts, aim)
        k = int(d.argmin())
        if best is None or d[k] < best[0]:
            best = (d[k], pts[k])
    return best[1] if best else front.interpolate(front.project(aim))


def layout(plots, homes, buildings, street_edge):
    """Where each plot's gate is and what it leads to. `plots` is [(house id, plot)],
    `homes` [(id, footprint)], `buildings` [(kind, footprint)] of everything standing
    in or beside the block. The gate is the point of the plot's street edge nearest the
    house, or nearest a garage that stands far enough back for a car in front of it.
    Returns one record a plot: b, plot, house, outline (the edge it shares with no
    other plot), front (the part of that along a street), and where the plot has a
    street edge: gate, dir (the unit vector from the gate to what it leads to), run
    (metres from the gate to the first building that way) and garage (it leads to one)."""
    shape_of = dict(homes)
    shapes = [s for _, s in buildings]
    roofs = STRtree(shapes) if shapes else None
    garages = [s for kind, s in buildings if kind in GARAGES]
    garage_tree = STRtree(garages) if garages else None
    tree = STRtree([p for _, p in plots])
    out = []
    for a, (ida, plot) in enumerate(plots):
        house = shape_of[ida]
        beside = [plots[b][1] for b in tree.query(plot.buffer(0.2), predicate="intersects") if b != a]
        outline = plot.boundary.difference(unary_union(beside).buffer(0.1)) if beside else plot.boundary
        front = outline.intersection(street_edge)
        rec = {"b": ida, "plot": plot, "house": house, "outline": outline, "front": front, "gate": None}
        out.append(rec)
        if front.is_empty or front.geom_type not in ("LineString", "MultiLineString"):
            continue
        aim, garage = house, False
        if garage_tree is not None:
            mine = [garages[k] for k in garage_tree.query(plot, predicate="intersects")
                    if plot.contains(garages[k].representative_point())]
            if mine:
                nearest = min(mine, key=front.distance)
                if front.distance(nearest) >= DRIVE_ROOM:
                    aim, garage = nearest, True
        gate = _gate(front, aim.centroid)
        dx, dy = aim.centroid.x - gate.x, aim.centroid.y - gate.y
        far = math.hypot(dx, dy)
        if far < 1e-6:
            continue
        ray = LineString([gate, aim.centroid])
        # (A footprint that crosses itself can't be cut with the ray; its distance will do.)
        hits = [gate.distance(shapes[k]) for k in roofs.query(ray, predicate="intersects")] if roofs is not None else []
        rec.update(gate=gate, dir=(dx / far, dy / far), run=min([far, *hits]), garage=garage)
    return out


def paving(rec):
    """The paved strip from a plot's gate: a drive as wide as a car to the house or the
    garage where one can stand on it, a path to the door otherwise, and a path from
    the house to the drive where the drive leads to a garage. None without a gate."""
    if rec["gate"] is None or rec["run"] < 1.5:
        return None
    gate, (dx, dy), run = rec["gate"], rec["dir"], rec["run"]
    width = DRIVE_WIDTH if run >= DRIVE_ROOM else PATH_WIDTH
    # From just outside the gate to the wall, across the bare strip round the house.
    line = LineString([(gate.x - dx * 0.4, gate.y - dy * 0.4), (gate.x + dx * (run + 0.3), gate.y + dy * (run + 0.3))])
    strip = line.buffer(width / 2, cap_style="flat")
    if rec["garage"]:
        door, on_drive = nearest_points(rec["house"], line)
        if door.distance(on_drive) > 1:
            strip = strip.union(LineString([door, on_drive]).buffer(PATH_WIDTH / 2, cap_style="flat"))
    strip = strip.intersection(rec["plot"].buffer(0.4))
    return None if strip.is_empty else strip


def drive_spots(layout_, shapes):
    """Where cars would stand on each plot's drive: one just inside the gate, nose to
    the house, where there is room between the gate and the house for it; and where
    the drive leads to a garage far enough back, a second in front of the garage
    (marked "g"). `shapes` are the footprints nothing may stand on. Returns [{"b": the
    house's id, "x", "y", "h": the way the car faces}]; the game decides which have a car."""
    # Each footprint grown before they are joined: OSM has a few that cross themselves,
    # and joining those as they are fails.
    roofs = unary_union([s.buffer(0.6) for s in shapes]) if shapes else Polygon()
    out = []
    for rec in layout_:
        if rec["gate"] is None or rec["run"] < DRIVE_ROOM:
            continue
        gate, (dx, dy) = rec["gate"], rec["dir"]
        heading = math.atan2(dy, dx)
        along = [DRIVE_IN]
        if rec["garage"] and rec["run"] - BEFORE_GARAGE - DRIVE_IN >= CAR[0] + 0.6:
            along.append(rec["run"] - BEFORE_GARAGE)
        for n, d in enumerate(along):
            x, y = gate.x + dx * d, gate.y + dy * d
            spot = _rect(x, y, *CAR, heading)
            if rec["plot"].buffer(0.3).contains(spot) and not spot.intersects(roofs):
                out.append({"b": rec["b"], "x": round(x, 2), "y": round(y, 2), "h": round(heading, 3), **({"g": 1} if n else {})})
    return out


def fences(layout_, green, street_edge, mapped, ways=None):
    """Hedges and fences along the edges of the plots in a block, on the grass only:
    between neighbours a hedge, a fence or nothing (the same for both sides, from the
    two buildings' ids); along the street a fence or hedge with a gap for the gate, or
    a bare frontage; along the block's other edges (a field, a wood, the next block) a
    fence or hedge more often than not, so the side hedges don't end in nothing.
    Never within a metre of a mapped barrier (`mapped`), nor across a service road or
    a path through the block (`ways`). Plot edges are Voronoi bisectors, which in a
    block of scattered houses run far from both of them across open lawn: there is no
    hedge between houses NEIGHBOURS apart or more, and none further than GARDEN from
    its house, so the hedges stay with the gardens and don't wander over the block."""
    if len(layout_) < 2:
        return []
    grass = green.buffer(0.3)
    if ways is not None and not ways.is_empty:
        grass = grass.difference(ways.buffer(-0.1))  # (not what runs along a way's edge)
    out = []

    def emit(line, kind, seed):
        line = line.intersection(grass).difference(mapped) if not mapped.is_empty else line.intersection(grass)
        r = random.Random(seed)
        h = round((r.uniform(1.0, 1.9) if kind == "hedge" else r.uniform(0.9, 1.6)), 1)
        for ls in _lines(shapely.line_merge(line) if line.geom_type == "MultiLineString" else line):
            if ls.length >= SHORTEST:
                out.append({"kind": kind, "h": h, "pts": _coords(ls.simplify(PLOT_TOLERANCE))})

    tree = STRtree([rec["plot"] for rec in layout_])
    for a, rec in enumerate(layout_):
        ida, plot = rec["b"], rec["plot"]
        for b in sorted(tree.query(plot.buffer(0.1), predicate="intersects")):
            if b <= a:
                continue
            idb = layout_[b]["b"]
            seed = _seed(min(ida, idb), max(ida, idb))
            roll = (seed % 100) / 100
            kind = "hedge" if roll < 0.5 else "fence" if roll < 0.85 else None
            if kind and rec["house"].distance(layout_[b]["house"]) <= NEIGHBOURS:
                shared = layout_[b]["plot"].boundary.intersection(plot.buffer(0.1))
                emit(shared.intersection(rec["house"].buffer(GARDEN)).intersection(layout_[b]["house"].buffer(GARDEN)), kind, seed)
        # The rest of the outline faces the street or other land.
        seed = _seed(ida, "front")
        roll = (seed % 100) / 100
        kind = "fence" if roll < 0.45 else "hedge" if roll < 0.75 else None
        line = rec["front"]
        if kind and not line.is_empty:
            if rec["gate"] is not None:
                line = line.difference(rec["gate"].buffer(GATE))
            emit(line, kind, seed)
        back = rec["outline"].difference(street_edge)
        seed = _seed(ida, "back")
        roll = (seed % 100) / 100
        kind = "fence" if roll < 0.5 else "hedge" if roll < 0.8 else None
        if kind and not back.is_empty:
            emit(back.intersection(rec["house"].buffer(GARDEN)), kind, seed)
    return out


def things(rec, lawn):
    """The small things on one plot, most plots having none: a shed where the plot has
    no outbuilding (`rec["bare"]`), a vegetable bed, a pool. Each is tried at a few
    spots on the plot's grass (`lawn()` gives it, clear of the paving), turned to lie
    along the nearest edge of the plot, and the best spot for its kind is kept: a shed
    in a back corner, a bed beside the fence, a pool behind the house. Returns
    {"sheds": [[x, y, heading, length, width, height]], "beds", "pools", "pads"
    (paving under a shed and round a sunken pool): polygons}."""
    r = random.Random(_seed(rec["b"], "things"))
    wants = [kind for kind, chance, ok in (("shed", SHED, rec.get("bare", True)), ("bed", BED, True),
                                           ("pool", POOL, rec["plot"].area >= POOL_PLOT)) if r.random() < chance and ok]
    out = {"sheds": [], "beds": [], "pools": [], "pads": []}
    if not wants:
        return out
    free = lawn()
    # (A plot can be in pieces, where a way cuts through the block: its largest piece's edge.)
    edge = max(shapely.get_parts(rec["plot"]), key=lambda g: g.area).exterior
    front, house = rec["front"], rec["house"]
    for kind in wants:
        if free.is_empty:
            break
        round_pool = kind == "pool" and r.random() < 0.5  # a round one stands on the grass
        if kind == "shed":
            length, width = r.uniform(2.4, 3.8), r.uniform(2.0, 2.8)
        elif kind == "bed":
            length, width = r.uniform(3.5, 7.0), r.uniform(1.4, 2.4)
        elif round_pool:
            length = width = r.uniform(3.2, 4.6)
        else:
            length, width = r.uniform(5.5, 8.0), r.uniform(3.0, 4.0)
        shapely.prepare(free)
        x0, y0, x1, y1 = free.bounds
        best, valid = None, 0
        for _ in range(30):
            p = Point(r.uniform(x0, x1), r.uniform(y0, y1))
            if not free.contains(p):
                continue
            s = edge.project(p)
            a, b = edge.interpolate((s - 0.5) % edge.length), edge.interpolate((s + 0.5) % edge.length)
            angle = math.atan2(b.y - a.y, b.x - a.x)
            shape = p.buffer(length / 2, 6) if round_pool else _rect(p.x, p.y, length, width, angle)
            if not free.contains(shape):
                continue
            from_street = p.distance(front) if not front.is_empty else 0
            score = {"shed": from_street - 2 * edge.distance(p), "bed": 0.3 * from_street - edge.distance(p),
                     "pool": from_street - abs(p.distance(house) - 5)}[kind]
            if best is None or score > best[0]:
                best = (score, p, angle, shape)
            valid += 1
            if valid >= 5:
                break
        if best is None:
            continue
        _, p, angle, shape = best
        if kind == "shed":
            out["sheds"].append([round(p.x, 2), round(p.y, 2), round(angle, 3), round(length, 1), round(width, 1), round(r.uniform(2.1, 2.5), 1)])
            out["pads"].append(shape.buffer(0.25, join_style="mitre"))
        elif kind == "bed":
            out["beds"].append(shape)
        else:
            out["pools"].append(shape)
            if not round_pool:
                out["pads"].append(shape.buffer(0.6, join_style="mitre"))
        free = free.difference(shape.buffer(EDGE + 0.4))
    return out


def furnish(plots, homes, buildings, green, street_edge, mapped, ways=None):
    """Everything on the plots of one block. `plots`: [(house id, plot)] from
    osm_area._plots; `homes`: [(id, footprint)] of the houses; `buildings`: [(kind,
    footprint)] of all that stands in or beside the block; `green`: the block's garden;
    `street_edge`: the streets grown by 1.5 m; `mapped`: the mapped barriers, grown;
    `ways`: the service roads and paths (as surfaces) that may run through the block.
    Returns {"fences", "drives", "plots": [{"b", "poly", "gate": (x, y, heading) or
    None, "strip": whether it has paving from the gate}], "paving", "beds", "pools":
    polygons, "sheds"}."""
    shapes = [s for _, s in buildings]
    if ways is not None and not ways.is_empty:
        # A block's edge is the kerb. Where a pavement or another way is mapped inside
        # it, a plot is what lies behind that (the piece its house stands on), and the
        # back of a pavement beside the street counts as the plot's street edge, so
        # the gate, the fence and the car on the drive stand clear of the pavement.
        shape_of, behind = dict(homes), []
        for ida, plot in plots:
            pieces = [g for g in shapely.get_parts(plot.difference(ways)) if g.geom_type == "Polygon" and g.area > 1]
            if pieces:
                behind.append((ida, min(pieces, key=shape_of[ida].centroid.distance)))
        plots = behind
        street_edge = unary_union([street_edge, ways.intersection(street_edge.buffer(PAVEMENT)).buffer(0.3)])
    recs = layout(plots, homes, buildings, street_edge)
    out = {"fences": fences(recs, green, street_edge, mapped, ways), "drives": drive_spots(recs, shapes),
           "plots": [], "paving": [], "beds": [], "pools": [], "sheds": []}
    home_shapes = {id(s) for _, s in homes}
    outbuildings = [s for _, s in buildings if id(s) not in home_shapes]
    sheds = STRtree(outbuildings) if outbuildings else None
    for rec in recs:
        strip = paving(rec)
        if strip is not None and ways is not None and not ways.is_empty:
            strip = strip.difference(ways)
        if strip is not None and not strip.is_empty:
            out["paving"].append(strip)
        else:
            strip = None
        rec["bare"] = sheds is None or not len(sheds.query(rec["plot"].buffer(-0.5), predicate="intersects"))

        def lawn(rec=rec, strip=strip):
            free = rec["plot"].intersection(green).buffer(-EDGE)
            if strip is not None:
                free = free.difference(strip.buffer(EDGE))
            if ways is not None and not ways.is_empty:
                free = free.difference(ways.buffer(EDGE))
            return free

        got = things(rec, lawn)
        out["sheds"].extend(got["sheds"])
        out["beds"].extend(got["beds"])
        out["pools"].extend(got["pools"])
        out["paving"].extend(got["pads"])
        gate = rec["gate"]
        out["plots"].append({"b": rec["b"], "poly": rec["plot"], "strip": strip is not None,
                             "gate": (round(gate.x, 2), round(gate.y, 2), round(math.atan2(rec["dir"][1], rec["dir"][0]), 3)) if gate is not None else None})
    return out
