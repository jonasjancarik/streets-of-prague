"""Pavements, traffic islands and tram beds as the technical map surveyed them, and
the shapes of the footpaths OSM maps as lines (plan 018, phases 3 and 4).

OSM has a pavement as a line beside the street, which osm_area.py widens into a
ribbon 3 m wide whatever the pavement really is. Inside Prague the technical map
(dtm.walks) has every pavement as a polygon from the kerb to the wall, with the
islands in the junctions and the beds of the tram tracks that don't run in the
street. Where it has them:

- they are drawn (surveyed()), paved with what OSM's footways on them say: the pale
  mosaic of Prague's pavements, or asphalt;
- the ribbons of the footways that run on them are not (without_survey()), so only
  the paths the survey doesn't know keep a ribbon: through parks, across estates,
  and everywhere past the city limits.

The ribbons that remain get square ends and are tidied (ribbon(), tidy()).
"""

import os

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import Polygon

# DERIVED_PAVEMENTS=1 builds the ground as before plan 018's phases 3 and 4 (round
# ribbons along every footway, nothing from the survey), to compare the two.
DERIVED_ONLY = os.environ.get("DERIVED_PAVEMENTS") == "1"
GRID = 0.01  # metres, as osm_area overlays the survey's surfaces
# A ribbon is tidied by closing what is narrower than twice CLOSE: the gap between two
# footways a step apart, the notch where two ribbons meet at an angle.
CLOSE = 0.5
SMALL = 4.0  # m²: a piece of path smaller than this is left out
TOLERANCE = 0.15  # m: how far a path's outline may be straightened (as the tiles' areas are)
MITRE = 2.0  # a ribbon's corner is cut off once it would reach this many half widths out
# The surveyed pavement and the carriageway beside it often miss by a hand's width,
# and rounding the carriageway's corners (dtm.py) leaves a little triangle at each:
# gaps and holes this small between the two are pavement.
GAP = 0.3
HOLE = 25.0  # m²
# The carriageway's rounded corners (dtm.py) are hundreds of thousands of points a
# chunk, which growing it trips over; within this they make no difference here.
COARSE = 0.03
# A surveyed surface with no tagged footway on it is paved like the nearest one that
# has, within this distance; further, with the mosaic.
ALIKE = 60.0
MIN_TAGGED = 3.0  # m of tagged footway on a pavement before the tag counts
# A footway's ribbon is left out where it runs on a surveyed surface, a little
# enlarged so no sliver is left along its edge; a pavement's own line (footway=sidewalk)
# altogether once this share of it does, and any other piece narrower than THIN.
EDGE = 0.5
MOSTLY = 0.5
THIN = 0.6

# What a footway's surface tag makes of the pavement under it.
ASPHALT = {"asphalt", "concrete", "chipseal"}
STONES = {"sett", "cobblestone", "unhewn_cobblestone", "paving_stones", "concrete:plates", "paved", "bricks", "brick"}
SETTS = {"sett", "cobblestone", "unhewn_cobblestone"}
LOOSE = {"unpaved", "dirt", "ground", "earth", "gravel", "fine_gravel", "compacted", "pebblestone", "sand", "mud", "grass", "woodchips"}


def ribbon(line, half, joints):
    """A footpath's line widened to `half` on each side, with square ends and mitred
    corners. An end where other ways meet it (`joints`: how many way points there are
    at each rounded coordinate) is rounded instead, so the ribbons join without a notch."""
    if DERIVED_ONLY:
        return line.buffer(half, cap_style="round", join_style="round")
    body = line.buffer(half, cap_style="flat", join_style="mitre", mitre_limit=MITRE)
    if line.geom_type != "LineString" or len(line.coords) < 2:
        return body
    ends = [shapely.Point(c).buffer(half) for c in (line.coords[0], line.coords[-1]) if joints.get(_at(c), 0) > 1]
    return shapely.union_all([body, *ends]) if ends else body


def joints(lines):
    """How many of the lines' points lie at each place (see ribbon)."""
    count = {}
    for line in lines:
        for part in shapely.get_parts(line):
            if part.geom_type == "LineString":
                for c in part.coords:
                    count[_at(c)] = count.get(_at(c), 0) + 1
    return count


def _at(c):
    return round(c[0], 1), round(c[1], 1)


def tidy(geom, keep_off):
    """The joined ribbons of one kind of path with the narrow gaps and notches closed,
    small pieces gone and the outline straightened a little. What closing adds never
    lies on `keep_off` (a list of shapes: the carriageways, buildings and water)."""
    geom = _areas(geom)
    if geom.is_empty:
        return geom
    closed = geom.buffer(CLOSE, join_style="mitre", mitre_limit=MITRE).buffer(-CLOSE, join_style="mitre", mitre_limit=MITRE)
    added = _areas(closed.difference(geom))
    if not added.is_empty and keep_off:
        # (Only the shapes near what was added: a building's outline may cross itself,
        # and joining a whole chunk's buildings is slow.)
        shapes = shapely.get_parts(np.array([g for g in keep_off if not g.is_empty], dtype=object))
        shapes = shapes[np.isin(shapely.get_type_id(shapes), (3, 6))]
        shapes = shapely.simplify(shapes, COARSE)  # (the carriageways' many points: see COARSE)
        hits = np.unique(STRtree(shapes).query(shapely.get_parts(added), predicate="intersects")[1]) if len(shapes) else []
        if len(hits):
            added = _areas(shapely.difference(added, shapely.union_all(shapely.make_valid(shapes[hits])), grid_size=GRID))
    if not added.is_empty:
        geom = _areas(shapely.union(geom, added, grid_size=GRID))
    parts = shapely.get_parts(geom)
    parts = shapely.simplify(parts[shapely.area(parts) >= SMALL], TOLERANCE, preserve_topology=True)
    return _areas(shapely.union_all(shapely.make_valid(parts))) if len(parts) else Polygon()


def surveyed(walks, streets, ways, green, clip, stats=None):
    """What to draw of the survey's pavements, islands and tram beds.

    `walks`: dtm.walks(); `streets`: the surveyed carriageways as drawn (dtm.streets);
    `ways`: [(line, surface tag, a street people walk in?)] of OSM's ways for walking;
    `green`: the surveyed greenery, which a tree pit or a small bed in the pavement
    stays. Returns ({key: shape}
    with "pavement" (mosaic), "pavement_asphalt", "sett" (a cobbled walking street), "dirt"
    (an earth path) and "trambed", only those there are; the shape of everything walked on, for
    without_survey())."""
    kinds = [k for k in ("pavement", "driveway", "island", "median", "platform", "cycleway") if k in walks]
    polys = np.concatenate([walks[k] for k in kinds]) if kinds else np.array([], dtype=object)
    labels = np.concatenate([np.full(len(walks[k]), k, dtype=object) for k in kinds]) if kinds else np.array([], dtype=object)
    # (Only what reaches the chunk: the survey's box is wider than it.)
    near = shapely.intersects(polys, clip) if len(polys) else np.zeros(0, bool)
    polys, labels = polys[near], labels[near]
    out = {}
    if len(polys):
        paving = _paving(polys, labels, ways)
        for key in ("pavement", "pavement_asphalt", "sett", "dirt"):
            chosen = polys[paving == key]
            if len(chosen):
                out[key] = shapely.union_all(chosen, grid_size=GRID)
        if stats is not None:
            for kind in kinds:
                stats[f"surveyed_{kind}_m2"] = round(float(shapely.area(shapely.intersection(polys[labels == kind], clip)).sum()))
    bed = walks.get("trambed")
    if bed is not None and len(bed):
        bed = bed[shapely.intersects(bed, clip)]
        if len(bed):
            out["trambed"] = shapely.union_all(bed, grid_size=GRID)
            if stats is not None:
                stats["surveyed_trambed_m2"] = round(float(out["trambed"].intersection(clip).area))
    if not out:
        return {}, Polygon()
    walked = shapely.union_all([g for k, g in out.items() if k != "trambed"], grid_size=GRID) if len(polys) else Polygon()
    if not walked.is_empty and not streets.is_empty:
        # The little gaps and holes between pavement and carriageway go to the
        # pavement beside them (the larger of the kinds there, which is drawn last).
        streets = _areas(shapely.make_valid(shapely.simplify(streets, COARSE)))
        both = _areas(shapely.union(walked, streets, grid_size=GRID))
        fill = _gaps(polys, streets, both)
        if not fill.is_empty:
            both = _areas(shapely.union(both, fill, grid_size=GRID))
        holes = np.array([Polygon(r) for p in shapely.get_parts(both) if p.geom_type == "Polygon" for r in p.interiors], dtype=object)
        if len(holes):
            holes = holes[shapely.area(holes) <= HOLE]
        if len(holes):  # (none small enough left: an empty list of indices is not an integer array)
            holes = holes[np.unique(STRtree(polys).query(holes, predicate="dwithin", distance=0.05)[0])]
        if len(holes):
            fill = _areas(shapely.union_all([fill, *holes]))
        if not fill.is_empty and green is not None and not green.is_empty:
            fill = _areas(shapely.difference(fill, green, grid_size=GRID))
        if not fill.is_empty:
            key = max((k for k in out if k != "trambed"), key=lambda k: (k != "dirt", out[k].area))
            out[key] = _areas(shapely.union(out[key], fill, grid_size=GRID))
            walked = _areas(shapely.union(walked, fill, grid_size=GRID))
    return {k: g for k, g in out.items() if not g.is_empty}, walked


def outside(paved, kept):
    """surveyed()'s shapes without the mapped squares, which keep the paving plan 013
    gave them, and the mapped car parks, which keep their asphalt and bays (`kept`).
    A tram bed stays whole."""
    if kept is None or kept.is_empty:
        return paved
    out = {k: g if k == "trambed" else _areas(shapely.difference(g, kept, grid_size=GRID)) for k, g in paved.items()}
    return {k: g for k, g in out.items() if not g.is_empty}


def _gaps(polys, streets, both):
    """The ground within 2 GAP of both a surveyed polygon and the carriageway that is
    neither of them."""
    reach = 2 * GAP
    band = streets.buffer(reach, join_style="mitre", mitre_limit=MITRE)
    grown = shapely.buffer(polys, reach, join_style="mitre", mitre_limit=MITRE)
    shapely.prepare(band)
    grown = grown[shapely.intersects(band, grown)]
    if not len(grown):
        return Polygon()
    near = _areas(shapely.intersection(_areas(shapely.union_all(grown, grid_size=GRID)), band, grid_size=GRID))
    # (Snapping to the grid can squash a sliver into a line, which an overlay refuses.)
    return _areas(shapely.difference(near, both, grid_size=GRID))


def _paving(polys, labels, ways):
    """What each surveyed polygon is paved with: "pavement" (mosaic), "pavement_asphalt",
    "sett" or "dirt", from the tagged ways for walking that run on it, else like the nearest
    one that has any."""
    paving = np.full(len(polys), None, dtype=object)
    paving[labels == "cycleway"] = "pavement_asphalt"
    tagged = [(line, _look(tag, street)) for line, tag, street in ways if _look(tag, street)]
    if tagged:
        lines = np.array([line for line, _ in tagged], dtype=object)
        looks = np.array([look for _, look in tagged], dtype=object)
        pi, li = STRtree(lines).query(polys, predicate="intersects")
        length = shapely.length(shapely.intersection(polys[pi], lines[li]))
        totals = {}
        for p, look, m in zip(pi, looks[li], length):
            if paving[p] is None:
                totals.setdefault(int(p), {}).setdefault(look, 0.0)
                totals[int(p)][look] += float(m)
        for p, by in totals.items():
            look, m = max(sorted(by.items()), key=lambda item: item[1])
            if m >= MIN_TAGGED:
                paving[p] = look
    # (An earth path says nothing about the pavement of the street it ends at.)
    known = np.array([v is not None and v != "dirt" for v in paving])
    if known.any() and not known.all():
        tree = STRtree(polys[known])
        rest = np.array([v is None for v in paving]).nonzero()[0]
        # (Each unknown one's nearest known one; the first, where several are as near.)
        if len(rest):
            qi, ki = tree.query_nearest(polys[rest], max_distance=ALIKE, all_matches=False)
            paving[rest[qi]] = paving[known][ki]
    paving[np.array([v is None for v in paving])] = "pavement"
    # Only a street people walk in is cobbled like a carriageway; an island or a
    # driveway that took "sett" from one beside it is mosaic, like a pavement.
    paving[(paving == "sett") & (labels != "pavement")] = "pavement"
    paving[(paving == "dirt") & (labels != "pavement")] = "pavement"
    return paving


def _look(tag, street):
    """The paving a way's surface tag stands for (None: it doesn't say)."""
    tag = str(tag).strip().lower() if tag is not None else None
    if tag in SETTS and street:
        return "sett"
    if tag in STONES:
        return "pavement"
    if tag in ASPHALT:
        return "pavement_asphalt"
    if tag in LOOSE:
        return "dirt"  # a park's surveyed path: earth, as its ribbon was
    return None


def without_survey(ways, sidewalk, walked):
    """The footways' ribbons less what the survey draws: `ways` as osm_area's
    walking_surfaces [(ribbon, class, surface tag, on the ground?, route only?)],
    `sidewalk`: for each, whether it is tagged as a street's pavement, `walked`: the
    surveyed shape. Bridges and raised ways keep their ribbon whole."""
    if walked.is_empty or not ways:
        return ways
    parts = shapely.get_parts(walked)
    grown = shapely.buffer(parts, EDGE, join_style="mitre", mitre_limit=MITRE)
    tree = STRtree(grown)
    out = []
    for (geom, cls, tag, at_ground, route), beside in zip(ways, sidewalk):
        hits = tree.query(geom, predicate="intersects") if at_ground and not geom.is_empty else []
        if len(hits):
            left = _areas(shapely.difference(geom, shapely.union_all(grown[np.sort(hits)]), grid_size=GRID))
            if beside and left.area <= (1 - MOSTLY) * geom.area:
                continue
            # What hangs over the kerb or sticks out between two surveyed pieces goes.
            pieces = [p for p in shapely.get_parts(left)
                      if p.area >= SMALL and not p.buffer(-THIN / 2).is_empty]
            if not pieces:
                continue
            geom = shapely.union_all(pieces)
        out.append((geom, cls, tag, at_ground, route))
    return out


def _areas(g):
    """Only the polygons of a geometry (as osm_area._areas)."""
    parts = shapely.get_parts(g)
    keep = parts[np.isin(shapely.get_type_id(parts), (3, 6))]
    return shapely.union_all(keep) if len(keep) else Polygon()
