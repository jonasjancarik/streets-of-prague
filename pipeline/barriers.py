"""Crash barriers along motorways and expressways.

OSM maps them (barrier=guard_rail) on some stretches only, so where it has none near a
motorway or trunk carriageway they are put along both its edges: the outer one, and the
one on the central reservation. They are left open wherever another road's surface
meets the carriageway (slip roads, the other carriageway where there is no reservation
between them), and bridges and tunnels have none: a bridge has its parapet.
"""

from shapely import STRtree
from shapely.geometry import LineString
from shapely.ops import unary_union

ROADS = ("motorway", "trunk")
OFFSET = 0.5  # m outside the carriageway's edge
MAPPED_NEAR = 8.0  # m: a mapped barrier this close to the edge already stands for it
OPENING = 0.3  # m kept clear of any road surface
SHORTEST = 8.0  # m: a shorter piece is left out
TOLERANCE = 0.25  # m: how far a barrier's line may be straightened


def _lines(g):
    if isinstance(g, LineString):
        return [g] if not g.is_empty else []
    return [ln for ln in getattr(g, "geoms", []) if isinstance(ln, LineString)]


def guard_rails(lines, hws, sides, skip, surfaces, mapped):
    """The barriers' lines: the mapped ones (`mapped`), and for each motorway or trunk
    line (centre lines `lines`, classes `hws`, (left, right) half widths `sides`) not
    marked in `skip` (bridges, tunnels), its two edges where no mapped barrier runs
    near and no road surface (`surfaces`, every car way's polygons) lies."""
    out = [ln for g in mapped for ln in _lines(g) if ln.length >= 1]
    pick = [k for k, hw in enumerate(hws) if hw in ROADS and not skip[k]]
    if not pick:
        return out
    roads = unary_union(surfaces).buffer(OPENING)
    tree = STRtree(out) if out else None
    for k in pick:
        left, right = sides[k]
        for d in (left + OFFSET, -(right + OFFSET)):
            edge = lines[k].offset_curve(d)
            if tree is not None:
                near = [out[i] for i in tree.query(edge, predicate="dwithin", distance=MAPPED_NEAR)]
                if near:
                    edge = edge.difference(unary_union(near).buffer(MAPPED_NEAR))
            for ln in _lines(edge.difference(roads)):
                if ln.length >= SHORTEST:
                    out.append(ln.simplify(TOLERANCE))
    return out
