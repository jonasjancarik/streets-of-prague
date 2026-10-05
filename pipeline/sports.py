"""Pitches, courts, playgrounds and running tracks: what each is made of, and the
lines painted on it (plan 030).

`classify` turns a feature's OSM tags (leisure, sport, surface) and its outline into
a look, one of LOOKS, and the painted lines. The pipeline puts each look in its own
area kind (`pitch` is the plain grass one, the rest are `pitch_<look>`), so the game
colours them without knowing about sports; the lines travel with the tile as `marks`.
"""

import math
import zlib

import numpy as np
from shapely.geometry import LinearRing, LineString, MultiLineString, MultiPolygon, Polygon
from shapely.ops import unary_union

# Area kinds, in the order the game draws them (the grass on top, so that a pitch laid
# in a sports centre or a running track's infield stays grass).
LOOKS = ("site", "tartan", "sand", "play", "clay", "grey", "blue", "green", "red", "turf", "grass")
PITCH_KINDS = ("pitch", *(f"pitch_{look}" for look in LOOKS if look != "grass"))
# Looks that get white lines round them where nothing more specific is painted.
OUTLINED = {"clay", "grey", "blue", "green", "red", "turf", "grass", "sand"}

SMALL_PITCH = 1500  # m2: an untagged or football pitch smaller than this is a hard court, not mown grass
RING_WIDTH = 6.0  # m: a track's outline is its centre line when the shape is an oval at least this wide on average

HARD = {"asphalt", "concrete", "paved", "acrylic", "rubber", "plastic", "paving_stones", "metal", "wood", "tartan",
        "rubbercrumb", "synthetic", "artificial", "carpet", "paving_stone", "bricks", "sett", "cobblestone"}
LOOSE = {"sand", "dirt", "ground", "gravel", "fine_gravel", "pebblestone", "compacted", "unpaved", "earth", "mud",
         "dirt/sand", "grass_paver", "woodchips", "bark", "clay_sand"}
GRASS_SPORTS = {"soccer", "football", "rugby", "rugby_union", "rugby_league", "field_hockey", "hockey", "baseball", "softball",
                "american_football", "cricket", "lacrosse", "ultimate", "frisbee", "gaelic_games", "disc_golf", "golf", "croquet"}
HARD_SPORTS = {"basketball", "volleyball", "handball", "futsal", "multi", "netball", "badminton", "table_tennis", "skateboard",
               "roller_skating", "rollerblading", "inline_skating", "streetball", "korfball", "floorball", "tennis_wall", "basketball;multi"}
# Share of hard courts that are [grey, blue, green, red], by what the tags say about the surface.
HARD_COLOURS = {"plain": [0.5, 0.25, 0.15, 0.1], "coloured": [0.1, 0.45, 0.3, 0.15]}
PLAIN = {"asphalt", "concrete", "paved", "paving_stones", "paving_stone", "bricks", "sett", "cobblestone", "metal", "wood"}


def tokens(value):
    """The values of a tag that may hold several ("soccer;basketball", "clay, grass"), in order."""
    if not value:
        return []
    return [t.strip().lower().replace(" ", "_") for t in str(value).replace(",", ";").split(";") if t.strip()]


def fit(poly):
    """(centre, angle, long side, short side) of the rectangle a polygon is within 10 %
    of, or None. The angle is that of the long side, radians."""
    if poly.is_empty or poly.geom_type != "Polygon":
        return None
    with np.errstate(all="ignore"):  # (GEOS makes numpy warn on every call)
        box = poly.minimum_rotated_rectangle
    if box.geom_type != "Polygon" or poly.area < 0.9 * box.area:
        return None
    c = np.array(box.exterior.coords)[:4]
    a, b = c[1] - c[0], c[2] - c[1]
    la, lb = float(np.hypot(*a)), float(np.hypot(*b))
    if min(la, lb) < 1:
        return None
    d, long_, short = (a, la, lb) if la >= lb else (b, lb, la)
    centre = box.centroid
    return (centre.x, centre.y), math.atan2(d[1], d[0]), long_, short


# ---- Lines of each court, in a frame with the long side along u, centred on 0 -----------------

def _rect(l, w):
    return [(-l / 2, -w / 2), (l / 2, -w / 2), (l / 2, w / 2), (-l / 2, w / 2), (-l / 2, -w / 2)]


def _arc(cu, cv, r, a0, a1, n=16):
    return [(cu + r * math.cos(a0 + (a1 - a0) * i / n), cv + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def tennis_lines():
    l, w, s = 23.77, 10.97, 4.115
    return [_rect(l, w), [(-l / 2, s), (l / 2, s)], [(-l / 2, -s), (l / 2, -s)],
            [(-6.4, -s), (-6.4, s)], [(6.4, -s), (6.4, s)], [(-6.4, 0), (6.4, 0)]]


def basketball_lines():
    l, w = 28.0, 15.0
    out = [_rect(l, w), [(0, -w / 2), (0, w / 2)], _arc(0, 0, 1.8, 0, 2 * math.pi, 24)]
    a = math.asin(6.6 / 6.75)
    for s in (-1, 1):
        base = s * l / 2
        out.append([(base, -2.45), (base - s * 5.8, -2.45), (base - s * 5.8, 2.45), (base, 2.45)])
        out.append(_arc(base - s * 5.8, 0, 1.8, 0, 2 * math.pi, 24))
        cu = base - s * 1.575
        arc = [(cu - s * 6.75 * math.cos(t), 6.75 * math.sin(t)) for t in np.linspace(-a, a, 24)]
        out.append(arc)
        for v in (-6.6, 6.6):
            out.append([(base, v), (arc[0][0] if v < 0 else arc[-1][0], v)])
    return out


def volleyball_lines():
    l, w = 18.0, 9.0
    return [_rect(l, w), [(0, -w / 2), (0, w / 2)], [(-3, -w / 2), (-3, w / 2)], [(3, -w / 2), (3, w / 2)]]


def hall_lines():
    """Handball and futsal on 40 x 20: the halfway line, its circle and the 6 m lines."""
    l, w = 40.0, 20.0
    out = [_rect(l, w), [(0, -w / 2), (0, w / 2)], _arc(0, 0, 3.0, 0, 2 * math.pi, 24)]
    for s in (-1, 1):
        east = [(s * (l / 2 - 6 * math.sin(p)), -1.5 - 6 * math.cos(p)) for p in np.linspace(0, math.pi / 2, 10)]
        west = [(u, -v) for u, v in reversed(east)]
        out.append(east + west)
    return out


def football_lines(l, w):
    """A football pitch of l x w: halfway line and circle, penalty and goal areas, drawn
    to the pitch's own size (a school's 60 x 35 gets proportionally smaller ones)."""
    out = [_rect(l, w), [(0, -w / 2), (0, w / 2)]]
    if l < 40 or w < 20:
        return out
    ku, kv = l / 105, w / 68
    out.append(_arc(0, 0, 9.15 * min(ku, kv), 0, 2 * math.pi, 28))
    for s in (-1, 1):
        for depth, half in ((16.5, 20.15), (5.5, 9.16)):
            d, h = depth * ku, half * kv
            out.append([(s * l / 2, -h), (s * (l / 2 - d), -h), (s * (l / 2 - d), h), (s * l / 2, h)])
    return out


# What each court needs of the rectangle: (long side range, short side range, lines, exact),
# `exact` = the rectangle is the court, so the lines are stretched to it; otherwise the
# court stands in the middle with run-off round it.
COURTS = {
    "tennis": [((22.0, 27.5), (9.5, 12.5), tennis_lines, True)],
    "basketball": [((22.0, 32.0), (12.0, 17.5), basketball_lines, True)],
    "volleyball": [((17.0, 19.5), (8.5, 9.8), volleyball_lines, True)],
    "hall": [((36.0, 44.0), (18.0, 23.0), hall_lines, True)],
}
# Courts of the sports a pitch is tagged with; `multi` and a missing tag try them in turn.
SPORT_COURT = {"tennis": "tennis", "basketball": "basketball", "streetball": "basketball", "volleyball": "volleyball",
               "handball": "hall", "futsal": "hall"}
GUESS = ("tennis", "basketball", "volleyball")


def _frame(points, centre, angle):
    c, s = math.cos(angle), math.sin(angle)
    return [[round(centre[0] + u * c - v * s, 2), round(centre[1] + u * s + v * c, 2)] for u, v in points]


def _scaled(lines, sx, sy):
    return [[(u * sx, v * sy) for u, v in line] for line in lines]


def court_lines(sports, f, guess):
    """The painted lines of a pitch that is a rectangle `f` (see `fit`) of a standard
    size for one of its sports (or, with no sport tagged and `guess`, for a sport the
    size suggests), or None."""
    centre, angle, long_, short = f
    names = [SPORT_COURT[s] for s in sports if s in SPORT_COURT]
    if "multi" in sports or (guess and not sports):
        names += [n for n in GUESS if n not in names]
    for name in names:
        for (lo_l, hi_l), (lo_w, hi_w), lines_of, _ in COURTS[name]:
            if lo_l <= long_ <= hi_l and lo_w <= short <= hi_w:
                lines = lines_of()
                std = max(u for line in lines for u, _ in line) * 2, max(v for line in lines for _, v in line) * 2
                return [_frame(line, centre, angle) for line in _scaled(lines, long_ / std[0], short / std[1])]
    if "tennis" in sports and 33 <= long_ <= 41:
        # One court with its run-off, or several in a row, 18.3 m apart.
        n = round(short / 18.3)
        if n >= 1 and abs(short - n * 18.3) <= 2.5 * n:
            out = []
            for k in range(n):
                v0 = (k - (n - 1) / 2) * short / n
                out += [_frame([(u, v + v0) for u, v in line], centre, angle) for line in tennis_lines()]
            return out
    if sports and any(s in GRASS_SPORTS for s in sports) or (guess and not sports and 90 <= long_ <= 125 and 45 <= short <= 85):
        if 25 <= long_ <= 125 and 1.2 <= long_ / short <= 2.4 and short >= 12:
            return [_frame(line, centre, angle) for line in football_lines(long_, short)]
    return None


# ---- Surfaces ------------------------------------------------------------------------------------

def _roll(seed, weights):
    r = (zlib.crc32(str(seed).encode()) % 1000) / 1000
    for k, w in enumerate(weights):
        if r < w:
            return k
        r -= w
    return len(weights) - 1


def look_of(leisure, sports, surface, area, seed, ring=False):
    """What a pitch, playground or track looks like: one of LOOKS, or "park" for a
    playground on grass (a lawn)."""
    surface = surface[0] if surface else None
    primary = sports[0] if sports else None
    if leisure == "playground":
        if surface == "grass":
            return "park"
        return "play" if surface in HARD or surface == "rubbercrumb" else "sand"
    if leisure == "sports_centre":
        # A whole site, with its own pitches and courts mapped on top.
        return "site" if not surface or surface in ("grass",) else look_of("pitch", sports, [surface], area, seed)
    if leisure == "track":
        if primary in ("horse_racing", "equestrian", "motor", "karting", "motocross", "bmx", "dog_racing") or surface in LOOSE:
            return "sand"
        if primary == "cycling" or surface in PLAIN:
            return "grey"
        return "tartan"
    # A pitch.
    if "beachvolleyball" in sports or surface == "sand":
        return "sand"
    if surface == "clay":
        return "clay"
    if surface in ("artificial_turf", "astroturf"):
        return "turf"
    if surface == "grass":
        return "grass"
    if surface == "tartan":
        return "tartan" if primary in ("athletics", "running") else _hard(surface, seed)
    if surface in HARD:
        return _hard(surface, seed)
    if surface in LOOSE:
        return "clay" if primary == "tennis" else "sand"
    if surface in ("ice", "water", "snow"):
        return "grass"
    # No surface tagged: the sport, then the size.
    if primary in ("athletics", "running"):
        return "tartan"
    if "tennis" in sports:
        return "clay"
    if primary in ("boules", "petanque", "equestrian", "horse_racing", "bmx", "cycling", "model_aerodrome", "motocross", "shooting", "archery"):
        return "sand" if primary in ("boules", "petanque", "equestrian", "horse_racing", "bmx", "motocross") else "grass"
    if sports and all(s in HARD_SPORTS or s in ("chess", "table_tennis") for s in sports):
        return _hard(None, seed)
    if not sports or any(s in GRASS_SPORTS for s in sports):
        return "grass" if area >= SMALL_PITCH or sports and area >= 3000 else _hard(None, seed)
    return "grass"


def _hard(surface, seed):
    plain = surface in PLAIN
    k = _roll(seed, HARD_COLOURS["plain" if plain else "coloured"])
    return ("grey", "blue", "green", "red")[k]


# ---- A feature ------------------------------------------------------------------------------------

def _parts(g):
    return [g] if isinstance(g, Polygon) else list(getattr(g, "geoms", []))


def _lines(geom):
    if isinstance(geom, LineString):
        return [list(geom.coords)]
    return [list(g.coords) for g in getattr(geom, "geoms", []) if isinstance(g, LineString)]


def classify(leisure, sport, surface, area_tag, geom, seed):
    """[(kind, polygon geometry, lines)] for one OSM feature: its look as an area kind
    (`pitch` for plain grass, `pitch_<look>` for the rest, or `park` for a lawn), and the
    painted lines [[(x, y), ...]], in metres. A running track mapped as its centre line
    (a closed way, not an area) becomes a band round it with the lane lines, and grass inside."""
    sports, surfaces = tokens(sport), tokens(surface)
    out = []
    for part in _parts(geom):
        if part.is_empty or part.area < 1:
            continue
        look = look_of(leisure, sports, surfaces, part.area, seed, False)
        kind = look if look == "park" else "pitch" if look == "grass" else f"pitch_{look}"
        lines = []
        if leisure == "track" and look == "tartan" and area_tag != "yes" and not part.interiors \
                and part.area / part.length >= RING_WIDTH:
            band, infield, lines = track_ring(part)
            out.append((kind, band, lines))
            if not infield.is_empty:
                out.append(("pitch", infield, []))
            continue
        if leisure == "playground" or look in ("site", "play", "park"):
            pass
        else:
            f = fit(part)
            court = court_lines(sports, f, not sports and leisure == "pitch") if f else None
            if court:
                lines = court
            elif look in OUTLINED or (look == "tartan"):
                lines = [[(round(x, 2), round(y, 2)) for x, y in part.exterior.simplify(0.25).coords]]
        out.append((kind, part, lines))
    return out


def track_ring(poly):
    """A closed way mapped as a track's centre line: (the band of lanes along it, the
    infield inside, lane lines). Six lanes of 1.22 m on a full-size track (its length
    from 250 m), four on a smaller one."""
    length = poly.exterior.length
    lanes = 6 if length >= 250 else 4
    width = lanes * 1.22
    band = poly.exterior.buffer(width / 2, join_style="round")
    infield = poly.difference(band)
    lines = []
    if length <= 700:
        for k in range(lanes + 1):
            d = (k - lanes / 2) * 1.22
            ring = poly.buffer(d, join_style="round") if d else poly
            for part in _parts(ring if not ring.is_empty else Polygon()):
                lines.append([(round(x, 2), round(y, 2)) for x, y in part.exterior.simplify(0.2).coords])
    return band, infield, lines
