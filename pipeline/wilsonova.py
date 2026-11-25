"""The exposed surface of Wilsonova over the main station's concourse.

DTM records the upper carriageways in pieces on three survey levels. At either
end it also records the lower entrance road and its kerbs across the same lanes.
These cross-sections follow the upper kerbs in DTM and IPR's orthophoto. Outside
them the mapped stopping bays, pavements and access roads retain their shape.
"""
import math

import shapely
from shapely.geometry import Polygon

# Stairs from the lower concourse to the platforms and paths through the lower
# pick-up area. All eight run beneath the measured carriageways. Some stairs
# reach indoor floor 0, which is still below the roof carrying Wilsonova.
LOWER_WAYS = {431095208, 431095231, 431095280, 431095506,
              431095424, 894258317, 1388498701, 1393474698}

# Longitude, latitude on the longitudinal baseline, then signed metres east to
# the west kerb, the two faces of the central reservation, and the east kerb.
SECTIONS = [
    (14.43429226, 50.08249566, -13.2, -1.70,  0.40, 11.8),
    (14.43436866, 50.08260169, -13.3, -1.78,  0.33, 16.2),
    (14.43440980, 50.08265879, -13.4, -1.85,  0.30, 15.3),
    (14.43447445, 50.08274851, -13.5, -1.92,  0.22, 13.9),
    (14.43463314, 50.08296873, -13.6, -2.00,  0.04, 13.8),
    (14.43487411, 50.08330313, -13.9, -2.22, -0.24, 15.0),
    (14.43513271, 50.08366201, -14.1, -2.41, -0.43, 15.2),
    (14.43531491, 50.08391485, -14.2, -2.61, -0.60, 15.6),
    (14.43539719, 50.08402904, -14.2, -2.58, -0.60, 15.7),
]


def surfaces(transform):
    centres = [transform(*s[:2]) for s in SECTIONS]
    dx = centres[-1][0] - centres[0][0]
    dy = centres[-1][1] - centres[0][1]
    length = math.hypot(dx, dy)
    edges = [[(x + dy / length * d, y - dx / length * d) for d in s[2:]]
             for (x, y), s in zip(centres, SECTIONS)]
    west, left, right, east = zip(*edges)
    return Polygon([*west, *reversed(east)]), Polygon([*left, *reversed(right)])


def upper_road(roads, areas, lots, clip, transform):
    deck, median = surfaces(transform)
    if not deck.intersects(clip):
        return lots
    deck = deck.intersection(clip)
    median = median.intersection(clip)
    for kind in ("road", "sett", "path", "dirt", "pavement", "pavement_asphalt"):
        if kind in roads:
            # Clipping at the chunk edge can leave line remnants in the street layer.
            roads[kind] = shapely.difference(roads[kind].buffer(0), deck, grid_size=0.01).buffer(0)
    roads["road"] = shapely.union(roads.get("road", Polygon()), deck.difference(median), grid_size=0.01).buffer(0)
    roads["pavement_asphalt"] = shapely.union(roads.get("pavement_asphalt", Polygon()), median, grid_size=0.01).buffer(0)
    if "parking" in areas:
        areas["parking"] = areas["parking"].difference(deck)
    kept = []
    for lot in lots:
        if deck.disjoint(lot["poly"]):
            kept.append(lot)
        else:
            kept.extend({**lot, "poly": part} for part in shapely.get_parts(lot["poly"].difference(deck))
                        if part.geom_type == "Polygon" and not part.is_empty)
    return kept
