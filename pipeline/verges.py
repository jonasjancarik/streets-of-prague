"""Roadside verges: the rough grass beside a street, a kind of ground of its own.

Two things make one (plans 027 and 031):

- inside mapped or surveyed grass, the strips narrower than STRIP that run along a
  carriageway: the green band between the kerb and the pavement, a median, the grass
  between a road and a fence. A lawn is mown and a park is partly watered; these are
  neither, and dry out first in summer (src/groundSeason.ts);
- outside the technical map's survey (past the city limits), the land nobody mapped at all. The game paves what
  is unmapped, which is right between the houses of a town and wrong along a country road,
  where it leaves grey aprons between the carriageway and the fields. There it is verge,
  except round buildings that are not homes (a yard stays paved) and a pavement's width
  beside the streets OSM says have one (sidewalk=*): a pavement only where one is mapped.
"""

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import Polygon
from shapely.ops import unary_union

STRIP = 6.0        # m: grass narrower than this beside a carriageway is a verge
BESIDE = 1.5       # m: how near the carriageway a strip must come
MIN_STRIP = 12.0   # m2: smaller pieces are left to the grass they are part of
YARD = 12.0        # m round a building that is not a home: left paved
PAVEMENT = 1.8     # m of paving kept beside a street tagged as having a pavement
MIN_PATCH = 20.0   # m2: the smallest piece of unmapped land turned to verge
THIN = 0.4         # m: slivers thinner than twice this are dropped


def _polygons(g):
    return [p for p in shapely.get_parts(g) if p.geom_type == "Polygon" and not p.is_empty]


def _areal(g):
    """Only the polygons of a shape (an overlay can leave lines and points behind, and the
    next overlay refuses them)."""
    return g if g.geom_type in ("Polygon", "MultiPolygon") else unary_union(_polygons(g))


def _overlay(op, a, b):
    """An overlay of two polygonal shapes; on a fixed grid only if the exact one trips."""
    try:
        return _areal(op(a, b))
    except shapely.errors.GEOSException:
        return _areal(op(a, b, grid_size=0.01))


def strips(grass, carriageway):
    """The parts of `grass` that are narrow strips along `carriageway` (both one shape)."""
    grass, carriageway = _areal(grass), _areal(carriageway)
    if grass.is_empty or carriageway.is_empty:
        return Polygon()
    # Only the grass within a strip's width of a carriageway is looked at; a lawn wider
    # than STRIP is still wider than STRIP inside that band, and comes back out of the
    # opening whole. (All of a chunk at once, on outlines thinned a little: one lawn at a
    # time, or at the survey's full detail, this took minutes a chunk.)
    roads = carriageway.simplify(0.3)
    beside = roads.buffer(STRIP + BESIDE + 1.0, quad_segs=2)
    band = _overlay(shapely.intersection, grass, beside).simplify(0.25)
    if band.is_empty:
        return Polygon()
    wide = band.buffer(-STRIP / 2, quad_segs=1, join_style="mitre").buffer(STRIP / 2 + 0.05, quad_segs=1, join_style="mitre")
    narrow = np.asarray(_polygons(_overlay(shapely.difference, band, _areal(wide))), dtype=object)
    if not len(narrow):
        return Polygon()
    # (A corner the opening rounded off a wide lawn is compact; a strip is long.)
    keep = (shapely.area(narrow) >= MIN_STRIP) & (shapely.length(narrow) ** 2 > 28 * shapely.area(narrow))
    close = roads.buffer(BESIDE, quad_segs=1)
    shapely.prepare(close)
    keep[keep] = shapely.intersects(close, narrow[keep])
    return _areal(unary_union(list(narrow[keep]))) if keep.any() else Polygon()


CELL = 25.0  # m: the grid on which the survey's reach is asked


def beyond_survey(clip, surveyed):
    """The part of `clip` the survey doesn't reach, in cells of CELL metres. `surveyed(xs, ys)`
    says whether it reaches each place (None: it reaches nowhere)."""
    if surveyed is None:
        return clip
    x0, y0, x1, y1 = clip.bounds
    nx, ny = int(np.ceil((x1 - x0) / CELL)), int(np.ceil((y1 - y0) / CELL))
    ix, iy = np.meshgrid(np.arange(nx), np.arange(ny))
    reached = np.asarray(surveyed((x0 + (ix + 0.5) * CELL).ravel(), (y0 + (iy + 0.5) * CELL).ravel()), bool)
    if reached.all():
        return Polygon()
    cells = shapely.box(x0 + ix * CELL, y0 + iy * CELL, x0 + (ix + 1) * CELL, y0 + (iy + 1) * CELL).ravel()
    return _areal(shapely.union_all(cells[~reached]).intersection(clip))


def unmapped(clip, taken, surveyed, yards, pavements):
    """The land in `clip` that nothing claims and the survey doesn't reach, as verge.

    taken: every mapped or inferred shape (areas, streets and paths, buildings, parking);
    surveyed: whether the technical map reaches a place (see beyond_survey); yards: the buildings that are not homes;
    pavements: (centre line, half width to the kerb on that side, side: 1 left, -1 right)
    for the street sides OSM says have a pavement."""
    region = beyond_survey(clip, surveyed)
    if region.is_empty or region.area < MIN_PATCH:
        return Polygon()
    taken = [g for g in taken if g is not None and not g.is_empty]
    keep_out = [*taken, *(b.buffer(YARD, quad_segs=2) for b in yards),
                *(line.buffer(side * (half + PAVEMENT), single_sided=True) for line, half, side in pavements)]
    if keep_out:
        parts = np.asarray([p for g in keep_out for p in _polygons(g)], dtype=object)
        hits = STRtree(parts).query(region, predicate="intersects")
        if len(hits):
            region = _overlay(shapely.difference, region, shapely.union_all(parts[np.sort(hits)]))
    free = region.buffer(-THIN, quad_segs=2).buffer(THIN, quad_segs=2)
    pieces = [p for p in _polygons(free) if p.area >= MIN_PATCH]
    return unary_union(pieces) if pieces else Polygon()
