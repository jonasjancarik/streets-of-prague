"""The exposed surface of Wilsonova over the main station's concourse.

DTM records the upper carriageways in pieces on three survey levels. At either
end it also records the lower entrance road and its kerbs across the same lanes.
These cross-sections follow the upper kerbs in DTM and IPR's orthophoto. Outside
them the mapped stopping bays, pavements and access roads retain their shape.
"""
import math

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from pyproj import Transformer

# Stairs from the lower concourse to the platforms and paths through the lower
# pick-up area. All eight run beneath the measured carriageways. Some stairs
# reach indoor floor 0, which is still below the roof carrying Wilsonova.
LOWER_WAYS = {431095208, 431095231, 431095280, 431095506,
              431095424, 894258317, 1388498701, 1393474698}

# Longitude, latitude on the longitudinal baseline, then signed metres east to
# the west kerb, the two faces of the central reservation, and the east kerb.
SOUTH_APPROACH = [
    (14.43368105, 50.08164741, -14.4, -0.90, 11.9, 23.3),
    (14.43375158, 50.08174529, -13.6, -1.20,  8.9, 20.8),
]
# The roof over the lower pick-up lane, between sound asphalt on both sides.
CROSSING = [
    (14.43378096, 50.08178607, -13.3, -1.40,  7.8, 19.6),
    (14.43383973, 50.08186763, -13.0, -1.50,  5.8, 17.5),
    (14.43388087, 50.08192472, -12.9, -1.40,  4.7, 16.3),
    (14.43392788, 50.08198997, -12.9, -1.30,  3.7, 15.1),
    (14.43397490, 50.08205522, -12.9, -1.30,  2.6, 14.1),
    (14.43403367, 50.08213679, -12.8, -1.30,  1.9, 13.3),
]
SECTIONS = [*SOUTH_APPROACH, *CROSSING,
    (14.43413946, 50.08228360, -13.1, -1.60,  0.9, 12.3),
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


def _edges(sections, transform):
    centres = [transform(*s[:2]) for s in sections]
    dx = centres[-1][0] - centres[0][0]
    dy = centres[-1][1] - centres[0][1]
    length = math.hypot(dx, dy)
    edges = [[(x + dy / length * d, y - dx / length * d) for d in s[2:]]
             for (x, y), s in zip(centres, sections)]
    return np.asarray(edges).transpose(1, 0, 2)


def surfaces(transform):
    west, left, right, east = _edges(SECTIONS, transform)
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


class StationCrossing:
    """Reconcile the two inferred short bridges with the surveyed upper road.

    The lower drive and its open ramps stay on the original terrain. The narrow
    opening in the median admits daylight between its two covered sections.
    """

    def __init__(self, crs, ways):
        project = Transformer.from_crs(4326, crs, always_xy=True).transform
        west, left, right, east = _edges(CROSSING, project)
        probes = [Point(project(14.43378948, 50.08195608)), Point(project(14.43402378, 50.08195390))]
        # Only a build which has the two synthetic carriageway spans needs this fit.
        levels = [
            next((w["level"] for w in ways if w.get("cut") and LineString(w["pts"]).distance(q) < 1.5), None)
            for q in probes
        ]
        self.level = levels[0] if levels[0] == levels[1] else None
        normal = (east[0] - west[0]) / np.linalg.norm(east[0] - west[0])
        self.outline = Polygon([*(west - 1.4 * normal), *reversed(east + 0.55 * normal)])
        well = Polygon(
            [
                project(x, y)
                for x, y in [
                    (14.43386070, 50.08190101),
                    (14.43390760, 50.08188702),
                    (14.43393399, 50.08193860),
                    (14.43389470, 50.08195033),
                ]
            ]
        )
        self.deck = self.outline.difference(well)
        self.asphalt = Polygon([*west, *reversed(left)]).union(Polygon([*right, *reversed(east)]))
        centre = (west + east) / 2
        axis = centre[-1] - centre[0]
        axis /= np.linalg.norm(axis)
        # A short height profile (metres Bpv) supplies the top on the widened
        # deck, including points beyond the original bridge height raster.
        self.profile = {
            "w": 42,
            "pts": [
                [*np.round(centre[0] - 4 * axis, 2), 209.65],
                [*np.round(centre[-1] + 4 * axis, 2), 209.85],
            ],
        }
        self.near = self.outline.buffer(200).envelope

    def fit(self, tile):
        from osm_area import _polys, _rings

        bounds = box(*tile["box"])
        if self.level is None or self.near.disjoint(bounds):
            return
        # Graph edges are stored whole, including copies in the adjacent tiles.
        for e in (*tile["drive"], *tile["walk"]):
            if e.get("name") != "Wilsonova" or e.get("bridge") or e.get("tunnel"):
                continue
            line = LineString(e["pts"])
            segment = line.intersection(self.outline)
            if segment.geom_type != "LineString" or segment.length < 0.1:
                continue
            start, end = sorted(line.project(Point(p)) for p in [segment.coords[0], segment.coords[-1]])
            # Preserve any other bridge on the same OSM edge outside this span.
            previous = e.get("levels") or [[0.0, e.get("level", 0)]]
            start, end = round(start, 2), round(end, 2)
            transitions = [[s, lv] for s, lv in previous if s < start]
            transitions.append([start, self.level])
            if end < line.length - 0.01:
                transitions.append([end, next(lv for s, lv in reversed(previous) if s <= end)])
                transitions.extend([s, lv] for s, lv in previous if s > end)
            spans = [p for i, p in enumerate(transitions) if not i or transitions[i - 1][1] != p[1]]
            if len(spans) == 1:
                e["level"] = self.level
                e.pop("levels", None)
            else:
                e["levels"] = spans
                e.pop("level", None)
        if self.deck.disjoint(bounds):
            return
        for i, level in enumerate(tile.get("structures", [])):
            if level["level"] != self.level or level["kind"] != "bridge":
                continue
            old = level["polys"]
            # A tile border can split one old deck into pieces which don't
            # all contain its centre. The short inferred rectangles fit wholly
            # inside the replacement and the opening between them.
            extent = self.outline.buffer(0.05)
            keep = [r for r in old if not extent.covers(Polygon(r[0], r[1:]))]

            def rings(geometry):
                return [_rings(p, 0) for p in _polys(geometry.intersection(bounds)) if p.area > 0.01]

            tile["structures"] = list(tile["structures"])
            tile["structures"][i] = {
                **level,
                "polys": [*keep, *rings(self.deck)],
                "ramps": [*[r for r in level.get("ramps", []) if r != self.profile], self.profile],
                "deckSurface": {
                    "road": rings(self.asphalt),
                    "pavement": rings(self.deck.difference(self.asphalt)),
                },
            }
