"""Recover the shape of a deck from surveyed faces, with continuous approaches."""

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box

from ipr_buildings import krovak_to_local


def flat_faces(path, local, bounds):
    import geopandas as gpd

    transform = krovak_to_local(local)
    for face in gpd.read_file(path).geometry:
        if face is None or face.is_empty or face.geom_type != "Polygon":
            continue
        points = np.asarray(face.exterior.coords)
        if points.shape[1] != 3:
            continue
        x, y = transform.transform(*points[:, :2].T)
        if not bounds.intersects(box(min(x), min(y), max(x), max(y))):
            continue
        shape = Polygon(np.column_stack([x, y]))
        if not shape.is_valid or shape.area < 2:
            continue
        # Work in local metres. Nearly horizontal faces can be curved a few
        # decimetres over a long deck, but the sides and piers are much steeper.
        design = np.column_stack([x, y, np.ones(len(x))])
        plane = np.linalg.lstsq(design, points[:, 2], rcond=None)[0]
        if np.linalg.norm(plane[:2]) <= .24 and np.max(np.abs(design @ plane-points[:, 2])) <= .4:
            yield shape, plane


def deck_top(tile, level, original, faces):
    observed = []
    nearby = original.buffer(1)
    for shape, plane in faces:
        here = shape.intersection(tile.box)
        if here.area < 2 or here.intersection(nearby).area < .7*here.area:
            continue
        p = here.representative_point()
        z = plane @ [p.x, p.y, 1.]
        height = tile.height(level, p.x, p.y)
        if np.isfinite(height) and abs(z-height) <= .45:
            observed.append(shape)
    # Close small survey joints before clipping to the tile. At a boundary
    # the uncut source can support a complete face right up to the edge.
    return shapely.union_all(observed, grid_size=.02).buffer(.25).buffer(-.25).intersection(tile.box)


def connect_outline(original, observed, disputed, bounds):
    """Use the observed middle, tapering its outer edges into the old outline."""
    b = disputed.bounds
    axis = int(b[3] - b[1] > b[2] - b[0])
    low, high = b[axis]-12, b[axis+2]+12
    if low <= bounds[axis]+1 or high >= bounds[axis+2]-1:
        return None  # no room to make both transitions inside this tile

    def xy(station, across):
        return (across, station) if axis == 1 else (station, across)

    cross_min, cross_max = bounds[1-axis]-1, bounds[3-axis]+1

    def window(a, b):
        p, q = xy(a, cross_min), xy(b, cross_max)
        return box(*p, *q)

    def section(shape, station):
        pieces = [p for p in shapely.get_parts(shape.intersection(
            LineString([xy(station, cross_min), xy(station, cross_max)]))) if p.length > .02]
        return (pieces[0].bounds[1-axis], pieces[0].bounds[3-axis]) if len(pieces) == 1 else None

    inner = observed.intersection(window(low+4, high-4))
    # A partial survey could otherwise create new holes or hanging pieces.
    if inner.geom_type != "Polygon" or inner.is_empty or inner.interiors:
        return None
    ends = []
    for outer, inside in ((low, low+4), (high, high-4)):
        old = section(original, outer)
        new = section(observed, inside)
        if old is None or new is None or min(old[1], new[1]) <= max(old[0], new[0]):
            return None
        ends.append(Polygon([xy(outer, old[0]), xy(outer, old[1]), xy(inside, new[1]), xy(inside, new[0])]))
    joined = shapely.union_all([original.difference(window(low, high)), inner, *ends], grid_size=.001)
    if joined.geom_type != "Polygon" or joined.interiors:
        return None
    return joined


def surveyed_outline(tile, level, original, trimmed, faces, paths):
    """Keep the measured outline only if it preserves the supported routes."""
    if original.geom_type != "Polygon":
        return None
    observed = deck_top(tile, level, original, faces)
    if observed.is_empty:
        return None
    joined = connect_outline(original, observed, original.difference(trimmed), tile.box.bounds)
    if joined is None:
        return None
    tolerance = joined.buffer(.04)
    for line, edge in paths:
        if edge["level"] != level:
            continue
        covered = line.intersection(original)
        if covered.difference(tolerance).length > .1:
            return None
        core = line.buffer((edge.get("width") or 6) * .25).intersection(original)
        if core.difference(tolerance).area > max(.5, .01*core.area):
            return None
    return joined
