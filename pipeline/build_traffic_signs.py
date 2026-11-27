"""The traffic signs of Prague's streets, inferred from the rules OpenStreetMap records.

    uv run --with osmium build_traffic_signs.py praha   # → public/data/praha_now/traffic-signs.json

OSM maps almost no signs as such (a few hundred `traffic_sign` points in the city), but
it records what the signs say: which streets are one-way, the speed limits, the 30 km/h
zones, living streets and pedestrian zones, give-way and stop lines, crossings, speed
bumps, weight, height and access limits, turn bans and the lanes' arrows. Czech rules
then put each sign in a known place. Each sign stands on the right of the traffic it is
for, KERB_GAP beyond half the street's width, facing that traffic:

- one way and no entry: where a one-way town street starts from a junction, a one-way
  sign for those turning in; where it runs into one, a no-entry sign for those who would
  turn in against it.
- give way and stop: where OSM maps them (`highway=give_way|stop`, facing the way their
  `direction` says, or towards the nearer junction). At a junction with neither those nor
  traffic lights (within SIGNALS_NEAR), where a road of tertiary class or above runs
  through, a give-way sign on each lesser street running into it (not living streets:
  leaving one, drivers give way by the rules alone). Into a roundabout, a give-way
  sign over a roundabout sign. A main-road sign on the through road as it leaves a
  junction whose side streets give way.
- crossings: a crossing sign on each side for the traffic coming up to every marked
  crossing (`highway=crossing` without lights, marked). A crossing sign is a lit box
  where IPR's survey has a powered sign within LIT_REACH (its `dopravní značka` marks,
  which carry no more than a position).
- speed bumps: a sign at each bump, table or cushion, for the traffic coming up to it.
- zones: where a street of a 20, 30 or 40 km/h zone, a living street or a pedestrian
  street meets one outside it, the zone's sign for those going in and its end sign for
  those coming out.
- speed limits and vehicle limits: a prohibition holds only to the next junction, so
  the sign stands after every junction along the street, and where the limit starts
  between junctions. A limit back to the town's 50 km/h between junctions has an end
  sign. Weight, height, lorry and motor-vehicle bans the same way, with an "except
  access" plate where OSM says `destination` or `delivery`.
- turn bans: the restriction relations' no-left, no-right and ahead-, left- or
  right-only signs on the street coming up to the junction (no U-turn bans: most are
  there for the routing of dual carriageways).
- lanes: `turn:lanes` for the street coming up to a junction, for the game to paint the
  arrows on its own lanes.

traffic-signs.json: {"signs": [name, ...], "points": [[x, y, sign, angle], ...],
"turns": [[junction node id, heading, "left|through;right", x, y], ...]}: in the area's local
metres (+x east, +y north), the angle in whole degrees anticlockwise from east as
street-furniture.json has it (the sign's local x to the traffic's right, its face to
the traffic), the heading the way the traffic drives up to the junction. The game draws
the signs by name (src/signs.ts).
"""

import json
import math
import re
import sys
from collections import Counter, defaultdict

from pyproj import Transformer

from build_tiles import PBF, cut
from osm_area import AREAS, OUT, road_width

# The streets' classes, most important first: a give-way sign goes on the lesser street.
RANK = {"trunk": 6, "trunk_link": 6, "primary": 5, "primary_link": 5, "secondary": 4, "secondary_link": 4,
        "tertiary": 3, "tertiary_link": 3, "unclassified": 2, "residential": 2, "living_street": 1}
PUBLIC = set(RANK)  # the streets whose meetings are junctions (a service road's mouth is not one)
CAR = PUBLIC | {"service"}
SIGNED_ONE_WAY = {"secondary", "tertiary", "residential", "unclassified", "living_street"}
KERB_GAP = 0.8  # m beyond half the street's width
SIGNALS_NEAR = 30  # m: a junction this near traffic lights has them
LIT_REACH = 6  # m from a crossing sign to the survey's powered sign
DEDUPE = 3  # m: the same sign for the same traffic once
BUMPS = {"bump", "hump", "table", "cushion", "mini_bumps"}
MARKED = {"uncontrolled", "marked", "zebra"}
TURN_BANS = {"no_left_turn": "no left turn", "no_right_turn": "no right turn"}
TURN_ONLY = {"only_straight_on": "ahead only", "only_left_turn": "left only", "only_right_turn": "right only"}
ACCESS = {"destination", "delivery"}
ZONE_KEYS = ("maxspeed:type", "source:maxspeed", "zone:maxspeed", "maxspeed:zone")


def number(value):
    """A plain number in a tag (6, 3.5, 3,5), or None."""
    m = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*(?:t|m)?\s*", value or "")
    return float(m.group(1).replace(",", ".")) if m else None


def speed(value):
    v = number(value)
    return int(v) if v and v == int(v) else None


def zone(tags):
    """The zone a street is in: 'pedestrian zone', 'living street', 'zone 30' (20, 40), or None."""
    hw = tags.get("highway")
    if hw == "pedestrian":
        return "pedestrian zone"
    if hw == "living_street":
        return "living street"
    for key in ZONE_KEYS:
        v = tags.get(key)
        if not v or v == "no":
            continue
        if "zone" in v or key in ("zone:maxspeed", "maxspeed:zone"):
            m = re.search(r"(\d+)", v)
            n = int(m.group(1)) if m else speed(tags.get("maxspeed"))
            if n in (20, 30, 40):
                return f"zone {n}"
    return None


def oneway(tags):
    v = tags.get("oneway")
    if v in ("yes", "true", "1"):
        return 1
    if v == "-1":
        return -1
    if v != "no" and tags.get("junction") in ("roundabout", "circular"):
        return 1
    return 0


def limits(tags):
    """The vehicle limits a street's signs show, by name."""
    out = []
    w = number(tags.get("maxweight"))
    if w and w <= 60:  # (a few are in kilograms)
        out.append(f"weight {w:g}")
    h = number(tags.get("maxheight"))
    if h and h < 6:
        out.append(f"height {h:g}")
    hgv = tags.get("hgv")
    if hgv == "no":
        out.append("no lorries")
    elif hgv in ACCESS:
        out += ["no lorries", "except access"]
    mv = tags.get("motor_vehicle") or tags.get("motorcar") or tags.get("access")
    if mv == "no":
        out.append("no motor vehicles")
    elif mv in ACCESS:
        out += ["no motor vehicles", "except access"]
    return out


class Way:
    def __init__(self, osm_id, tags, nodes, pts):
        self.id, self.tags, self.nodes, self.pts = osm_id, tags, nodes, pts
        self.hw = tags.get("highway")
        self.oneway = oneway(tags)
        self.zone = zone(tags)
        self.half = road_width(self.hw, number(tags.get("width")), number(tags.get("lanes"))) / 2
        self.limits = limits(tags) if self.hw in PUBLIC else []
        self.length = sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))

    def allowed(self, d):
        """Whether traffic may drive along the way in direction d (+1 along its nodes)."""
        return self.oneway in (0, d)

    def speed(self, d):
        """The posted speed for traffic in direction d, or None for the town's 50."""
        t = self.tags
        if t.get("maxspeed:type") == "CZ:urban" or t.get("source:maxspeed") == "CZ:urban":
            return None
        s = speed(t.get("maxspeed:forward" if d > 0 else "maxspeed:backward")) or speed(t.get("maxspeed"))
        return s if s and s != 50 else None

    def end(self, d):
        """The index of its last node for traffic in direction d."""
        return len(self.nodes) - 1 if d > 0 else 0

    def along(self, i, d, dist):
        """The point `dist` m from node i along the way in direction d, and the heading of
        that direction there; None if the way ends first."""
        pts, j, left = self.pts, i, dist
        while 0 <= j + d < len(pts):
            (ax, ay), (bx, by) = pts[j], pts[j + d]
            seg = math.hypot(bx - ax, by - ay)
            if seg > 1e-6 and seg >= left:
                t = left / seg
                return (ax + (bx - ax) * t, ay + (by - ay) * t), math.atan2(by - ay, bx - ax)
            left -= seg
            j += d
        return None


def network(ways):
    """{node: [(way, index)]} and {node: the public way ends meeting there (a way through
    it counts twice)}."""
    at, ends = defaultdict(list), Counter()
    for w in ways:
        last = len(w.nodes) - 1
        for i, n in enumerate(w.nodes):
            if i == last and w.nodes[0] == n and last:
                continue  # a closed way's last node is its first
            at[n].append((w, i))
            if w.hw in PUBLIC:
                ends[n] += 1 if i in (0, last) and w.nodes[0] != w.nodes[last] else 2
    return at, ends


def arms_at(at, n, kinds=PUBLIC):
    """(way, index, d): the streets leaving node n, d the way along each."""
    out = []
    for w, i in at[n]:
        if w.hw not in kinds:
            continue
        closed = w.nodes[0] == w.nodes[-1]
        if i < len(w.nodes) - 1:
            out.append((w, i, 1))
        if i > 0:
            out.append((w, i, -1))
        elif closed:
            out.append((w, len(w.nodes) - 1, -1))
    return out


def traffic_signs(ways, nodes, restrictions, lit=()):
    """The signs: ([(x, y, name, angle in radians)], [(node, heading in radians, turn lanes, (x, y))]).
    `ways`: [Way]; `nodes`: {node id: (tags, (x, y))} for the tagged nodes;
    `restrictions`: [(restriction, from way id, via node id, to way id)]; `lit`: [(x, y)]."""
    by_id = {w.id: w for w in ways}
    at, ends = network(ways)
    junction = lambda n: ends[n] >= 3

    def arms(n, kinds=PUBLIC):
        return arms_at(at, n, kinds)

    signs = []

    def sign(name, w, i, d, dist, toward=False):
        """`name` for the traffic leaving node i along w in direction d, `dist` m on, or
        (toward) for the traffic coming the other way up to node i."""
        r = w.along(i, d, dist)
        if r is None:
            return False
        (x, y), h = r
        if toward:
            h += math.pi
        off = w.half + KERB_GAP
        signs.append((x + math.sin(h) * off, y - math.cos(h) * off, name, h - math.pi / 2))
        return True

    # Ways the traffic lights are near.
    lights = [xy for tags, xy in nodes.values() if tags.get("highway") == "traffic_signals"
              or tags.get("crossing") == "traffic_signals"]
    grid = defaultdict(list)
    for x, y in lights:
        grid[(int(x // SIGNALS_NEAR), int(y // SIGNALS_NEAR))].append((x, y))

    def signalled(n):
        x, y = node_xy(n)
        gx, gy = int(x // SIGNALS_NEAR), int(y // SIGNALS_NEAR)
        return any(math.dist((x, y), p) < SIGNALS_NEAR for i in (-1, 0, 1) for j in (-1, 0, 1) for p in grid[(gx + i, gy + j)])

    def node_xy(n):
        w, i = at[n][0]
        return w.pts[i]

    # One way and no entry.
    for w in ways:
        if not w.oneway or w.hw not in SIGNED_ONE_WAY or w.length < 15 or w.tags.get("bridge") or w.tags.get("tunnel") \
                or w.tags.get("junction") in ("roundabout", "circular"):
            continue
        d = w.oneway
        start, end = w.end(-d), w.end(d)
        if junction(w.nodes[start]):
            sign("one way", w, start, d, 3)
        if junction(w.nodes[end]):
            sign("no entry", w, end, -d, 3)

    # Give way and stop where they are mapped, and the junction each is for.
    yields = defaultdict(set)  # junction node → the ways that give way into it
    for n, (tags, _) in nodes.items():
        kind = {"give_way": "give way", "stop": "stop"}.get(tags.get("highway"))
        if not kind:
            continue
        on = [(w, i) for w, i in at[n] if w.hw in CAR]
        if not on:
            continue
        w, i = on[0]
        given = tags.get("direction") or tags.get("traffic_sign:direction")
        ds = [1] if given == "forward" else [-1] if given == "backward" else [1, -1]
        best = None
        for d in ds:
            if not w.allowed(d):
                continue
            j, run = i, 0.0
            while 0 <= j + d < len(w.nodes) and run < 60:
                run += math.dist(w.pts[j], w.pts[j + d])
                j += d
                if junction(w.nodes[j]):
                    if best is None or run < best[0]:
                        best = (run, d, w.nodes[j])
                    break
        if best is None and len(ds) == 1 and w.allowed(ds[0]):
            best = (0, ds[0], None)
        if best is None:
            continue
        _, d, j = best
        sign(kind, w, i, -d, 0.01, toward=True)
        if j is not None:
            yields[j].add(w.id)

    # Give way inferred at junctions without lights, and into roundabouts; the main road.
    mapped = set(yields)
    for n in list(at):
        if not junction(n) or n in mapped:
            continue
        out = arms(n)
        round_ways = {w.id for w, _, _ in out if w.tags.get("junction") in ("roundabout", "circular")}
        if round_ways:
            for w, i, d in out:
                if w.id not in round_ways and w.allowed(-d) and sign("give way", w, i, d, 4, toward=True):
                    sign("roundabout", w, i, d, 4, toward=True)
            continue
        if signalled(n):
            continue
        top = max(RANK[w.hw] for w, _, _ in out)
        if top < RANK["tertiary"] or sum(RANK[w.hw] == top for w, _, _ in out) < 2:
            continue
        for w, i, d in out:
            if RANK[w.hw] < top and w.hw != "living_street" and w.allowed(-d) and sign("give way", w, i, d, 4, toward=True):
                yields[n].add(w.id)
    mains = []
    for n, minor in yields.items():
        for w, i, d in arms(n):
            if w.id in minor or w.hw == "living_street" or not w.allowed(d):
                continue
            r = w.along(i, d, 6)
            if r and not any(math.dist(r[0], p) < 40 and abs(math.remainder(r[1] - h, 2 * math.pi)) < 0.5 for p, h in mains):
                mains.append(r)
                sign("main road", w, i, d, 6)

    # Crossings and speed bumps, for the traffic coming up to them.
    crossings = []
    for n, (tags, _) in nodes.items():
        crossing = tags.get("highway") == "crossing" and (tags.get("crossing") in MARKED or tags.get("crossing:markings") in ("yes", "zebra")) \
            and tags.get("crossing") != "traffic_signals" and tags.get("crossing:markings") != "no"
        bump = tags.get("traffic_calming") in BUMPS
        if not crossing and not bump:
            continue
        for w, i in at[n]:
            if w.hw not in PUBLIC:
                continue
            for d in (1, -1):
                if w.allowed(d):
                    if crossing and sign("crossing", w, i, -d, 1, toward=True):
                        crossings.append(len(signs) - 1)
                    if bump:
                        sign("speed bump", w, i, -d, 0.5, toward=True)
            break
    # The survey's powered signs light the crossing signs nearest them.
    pairs = _near_pairs(signs, crossings, lit)
    used_sign, used_lit = set(), set()
    for _, k, m in pairs:
        if k not in used_sign and m not in used_lit:
            used_sign.add(k)
            used_lit.add(m)
            x, y, _, a = signs[k]
            signs[k] = (x, y, "crossing lit", a)

    # Zones: their signs where a street of one meets a street outside it.
    for n in list(at):
        cars = arms(n)
        if not cars:
            continue
        for w, i, d in cars + arms(n, {"pedestrian"}):
            if not w.zone:
                continue
            if not any(o.id != w.id and o.zone != w.zone for o, _, _ in cars):
                continue
            if w.allowed(d):
                sign(w.zone, w, i, d, 4)
            if w.allowed(-d):
                sign(w.zone + " end", w, i, d, 4, toward=True)

    # Speed and vehicle limits: after every junction, and where they start between them.
    for w in ways:
        if w.hw not in PUBLIC:
            continue
        for d in (1, -1):
            if not w.allowed(d):
                continue
            i = w.end(-d)
            n = w.nodes[i]
            before = [(o, j, e) for o, j, e in arms(n) if o.id != w.id]
            if not junction(n) and not before:
                continue  # a dead end
            prev = before[0][0] if not junction(n) and before else None
            prev_d = -before[0][2] if prev else 0
            s = None if w.zone else w.speed(d)
            p = prev.speed(prev_d) if prev and not prev.zone else None
            if s and (junction(n) or p != s):
                sign(f"speed {s}", w, i, d, 8)
            elif not s and not w.zone and p:
                sign(f"speed {p} end", w, i, d, 8)
            had = set(prev.limits) if prev else set()
            for name in w.limits:
                if junction(n) or name not in had:
                    sign(name, w, i, d, 6)

    # Turn bans, on the street coming up to the junction.
    approach = defaultdict(list)
    for kind, f, via, _ in restrictions:
        w = by_id.get(f)
        if w is None or w.hw not in PUBLIC or (kind not in TURN_BANS and kind not in TURN_ONLY) or via not in w.nodes:
            continue
        i = w.nodes.index(via)
        if i not in (0, len(w.nodes) - 1):
            continue
        d = 1 if i == 0 else -1  # from the junction back along the street
        if w.allowed(-d) and w.along(i, d, 14):
            approach[(f, i, d)].append(kind)
    for (f, i, d), kinds in sorted(approach.items()):
        only = [TURN_ONLY[k] for k in kinds if k in TURN_ONLY]
        for name in only[:1] or sorted({TURN_BANS[k] for k in kinds}):
            sign(name, by_id[f], i, d, 12, toward=True)

    # The lanes' arrows, for the street coming up to a junction.
    turns = []
    for w in ways:
        if w.hw not in PUBLIC:
            continue
        for d in (1, -1):
            if not w.allowed(d):
                continue
            lanes = w.tags.get("turn:lanes") if w.oneway else w.tags.get("turn:lanes:forward" if d > 0 else "turn:lanes:backward")
            e = w.end(d)
            if lanes and junction(w.nodes[e]) and len(w.nodes) > 1:
                (ax, ay), (bx, by) = w.pts[e - d], w.pts[e]
                turns.append((w.nodes[e], math.atan2(by - ay, bx - ax), lanes, (bx, by)))

    # The same sign for the same traffic once.
    kept, cells = [], defaultdict(list)
    for s in signs:
        x, y, name, a = s
        key = (int(x // DEDUPE), int(y // DEDUPE))
        near = [cells[(key[0] + i, key[1] + j)] for i in (-1, 0, 1) for j in (-1, 0, 1)]
        if any(o[2] == name and math.dist(o[:2], (x, y)) < DEDUPE and abs(math.remainder(o[3] - a, 2 * math.pi)) < math.pi / 4
               for cell in near for o in cell):
            continue
        cells[key].append(s)
        kept.append(s)
    return kept, turns


# Direction signs: at a junction, an arrow plate for each way on that leads somewhere OSM
# names (`destination` on the street leaving it); on the bigger roads also a board
# BOARD_BACK m before it with the junction drawn and the places on each branch.
STRAIGHT = 30  # degrees either side of straight on
BOARD_ON = {"trunk", "primary", "secondary"}
BOARD_BACK = 70
PLATES_BACK = 6
FOLLOW = 40  # m: a branch this short into another junction (across a dual carriageway) is followed on
LANE_TURNS = {"through": 0, "left": 90, "right": -90, "slight_left": 45, "slight_right": -45, "sharp_left": 135, "sharp_right": -135}
GREEN = ("motorway", "motorway_link")


def destination(w, d):
    """Where the traffic on w in direction d is signed to: (places, road numbers, symbol,
    colour), or None. A plain `destination` on a two-way street is taken as its forward one."""
    t = w.tags

    def get(key):
        if w.oneway:
            return t.get(key)
        return t.get(f"{key}:{'forward' if d > 0 else 'backward'}") or (t.get(key) if d > 0 else None)
    to, ref = get("destination"), get("destination:ref") or get("destination:int_ref")
    if not to and not ref:
        return None
    return to or "", ref or "", get("destination:symbol") or "", get("destination:colour") or ""


def sign_colour(w, to, ref, sym, given, local):
    """The plate's colour: as OSM gives it, else green to the motorway, white where every
    place is a part of the city (`local`), blue otherwise."""
    given = given.split(";")[0]
    if given in ("green", "blue", "white", "brown"):
        return given
    if w.hw in GREEN or "motorway" in sym or re.match(r"D\d", ref):
        return "green"
    names = [p.strip() for p in to.split(";") if p.strip()]
    return "white" if names and all(p in local or p.lower() == "centrum" for p in names) else "blue"


def direction_signs(ways, local=frozenset()):
    """[(x, y, 'plates' | 'board', angle, [(turn in degrees, left positive; places; road
    numbers; symbol; colour)])] for the traffic coming up to each junction, the straight
    on first, then left to right."""
    at, ends = network(ways)
    junction = lambda n: ends[n] >= 3
    out = []

    def heading(w, i, d, dist=15):
        r = w.along(i, d, min(dist, max(.5, w.length - .1)))
        if r is None:
            return None
        x0, y0 = w.pts[i]
        return math.atan2(r[0][1] - y0, r[0][0] - x0)

    def follow(w, i, d):
        """The signed destination of w leaving node i in direction d, or of the way straight
        on from it where w only crosses to another junction; and the way it is on."""
        got = destination(w, d)
        if got or w.length > FOLLOW:
            return got, w
        e = w.end(d)
        h = heading(w, e, -d, 10)
        if not junction(w.nodes[e]) or h is None:
            return None, w
        h += math.pi
        best = None
        for o, j, f in arms_at(at, w.nodes[e]):
            ho = None if (o is w and f == -d) or not o.allowed(f) else heading(o, j, f)
            if ho is not None:
                turn = abs(math.degrees(math.remainder(ho - h, 2 * math.pi)))
                if turn < 35 and (best is None or turn < best[0]):
                    best = (turn, o, f)
        return (destination(best[1], best[2]), best[1]) if best else (None, w)

    for n in list(at):
        if not junction(n):
            continue
        here = arms_at(at, n)
        for a, i, d in here:
            # (Not on a short link from another junction, across a dual carriageway: the
            # signs before that junction show the way on.)
            if a.length <= FOLLOW and junction(a.nodes[a.end(d)]):
                continue
            h_in = heading(a, i, d) if a.allowed(-d) else None
            if h_in is None:
                continue
            h_in += math.pi
            branches = []
            for b, j, e in here:
                if (b is a and e == d) or not b.allowed(e):
                    continue
                h_out = heading(b, j, e)
                if h_out is None:
                    continue
                turn = math.degrees(math.remainder(h_out - h_in, 2 * math.pi))
                got, way = follow(b, j, e) if abs(turn) <= 150 else (None, b)
                if got:
                    branches.append((round(turn), *got[:3], sign_colour(way, *got, local)))
            if not branches:
                # The lanes' own destinations, where the street coming up names them.
                t, side = a.tags, "backward" if d > 0 else "forward"
                to_lanes = t.get("destination:lanes") if a.oneway else t.get(f"destination:lanes:{side}")
                turn_lanes = t.get("turn:lanes") if a.oneway else t.get(f"turn:lanes:{side}")
                if to_lanes and turn_lanes and len(to_lanes.split("|")) == len(turn_lanes.split("|")):
                    seen = {}
                    for to, turn in zip(to_lanes.split("|"), turn_lanes.split("|")):
                        first = (turn.split(";")[0] or "through").strip()
                        if to and first in LANE_TURNS:
                            seen.setdefault(to, LANE_TURNS[first])
                    branches = [(turn, to, "", "", sign_colour(a, to, "", "", "", local)) for to, turn in seen.items()]
            if not branches:
                continue
            branches.sort(key=lambda b: (abs(b[0]) >= STRAIGHT, -b[0]))
            for kind, back in (("plates", PLATES_BACK), ("board", BOARD_BACK)):
                if kind == "board" and (a.hw not in BOARD_ON or len(branches) < 2):
                    continue
                r = a.along(i, d, back)
                if r is None:
                    continue
                (x, y), h = r
                h += math.pi
                off = a.half + KERB_GAP
                out.append((x + math.sin(h) * off, y - math.cos(h) * off, kind, h - math.pi / 2, branches))
    return out


def _near_pairs(signs, crossings, lit):
    grid = defaultdict(list)
    for m, (x, y) in enumerate(lit):
        grid[(int(x // LIT_REACH), int(y // LIT_REACH))].append(m)
    out = []
    for k in crossings:
        x, y = signs[k][:2]
        gx, gy = int(x // LIT_REACH), int(y // LIT_REACH)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for m in grid[(gx + i, gy + j)]:
                    dist = math.dist((x, y), lit[m])
                    if dist < LIT_REACH:
                        out.append((dist, k, m))
    return sorted(out)


def read(pbf, tf):
    """Ways, tagged nodes and turn restrictions from an extract, in local metres."""
    import osmium

    ways, nodes, restrictions = [], {}, []

    class Handler(osmium.SimpleHandler):
        def node(self, n):
            t = n.tags
            if t.get("highway") in ("give_way", "stop", "crossing", "traffic_signals") or "traffic_calming" in t:
                nodes[n.id] = ({tag.k: tag.v for tag in t}, tf.transform(n.location.lon, n.location.lat))

        def way(self, w):
            hw = w.tags.get("highway")
            if (hw not in CAR and hw != "pedestrian") or w.tags.get("area") == "yes" or len(w.nodes) < 2:
                return
            try:
                refs = [n.ref for n in w.nodes]
                pts = [tf.transform(n.lon, n.lat) for n in w.nodes]
            except osmium.InvalidLocationError:
                return
            ways.append(Way(w.id, {tag.k: tag.v for tag in w.tags}, refs, pts))

        def relation(self, r):
            if r.tags.get("type") != "restriction":
                return
            kind = r.tags.get("restriction") or r.tags.get("restriction:motorcar")
            f = [m.ref for m in r.members if m.type == "w" and m.role == "from"]
            via = [m.ref for m in r.members if m.type == "n" and m.role == "via"]
            to = [m.ref for m in r.members if m.type == "w" and m.role == "to"]
            if kind and len(f) == 1 and len(via) == 1 and len(to) == 1:
                restrictions.append((kind, f[0], via[0], to[0]))

    Handler().apply_file(str(pbf), locations=True)
    return ways, nodes, restrictions


def powered_signs(tf):
    """The survey's powered traffic signs (IPR's `dopravní značka` marks), in local metres."""
    import ipr_open
    pts = ipr_open.cached("utility/powered-signs.json", lambda: [
        [f["geometry"]["x"], f["geometry"]["y"]]
        for f in ipr_open.pages("DTMP_CUR_TMISZNAK_B", where="ctmtp_kod = 605270", what="powered signs") if f.get("geometry")])
    return [tf.transform(x, y) for x, y in pts]


def build(area):
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 "
                              "+y_0=0 +ellps=WGS84 +units=m", always_xy=True)
    pbf = PBF.parent / f"{area}.osm.pbf"
    if not pbf.exists():
        if not PBF.exists():
            sys.exit(f"needs the OSM extract {PBF} (see 'Building the map' in docs/handbook.md)")
        pbf = cut((w - 0.01, s - 0.01, e + 0.01, n + 0.01), pbf)
    ways, nodes, restrictions = read(pbf, tf)
    signs, turns = traffic_signs(ways, nodes, restrictions, powered_signs(tf))
    # The city's parts (build_districts.py), for the white plates of local destinations.
    districts = OUT / f"{area}_now" / "districts.json"
    local = frozenset(d["name"] for d in json.loads(districts.read_text(encoding="utf-8"))["districts"]) if districts.exists() else frozenset()
    directions = direction_signs(ways, local)
    names = sorted({name for _, _, name, _ in signs})
    index = {name: k for k, name in enumerate(names)}
    points = sorted([round(x, 1), round(y, 1), index[name], round(math.degrees(a)) % 360] for x, y, name, a in signs)
    counts = Counter(name for _, _, name, _ in signs)
    print(f"{len(points)} signs:", ", ".join(f"{k} {v}" for k, v in counts.most_common()), f"and {len(turns)} lane arrow sets")
    print(f"{len(directions)} direction signs:", dict(Counter(kind for _, _, kind, _, _ in directions)),
          "plates", dict(Counter(b[4] for *_, bs in directions for b in bs)))
    return {"signs": names, "points": points,
            "directions": sorted([round(x, 1), round(y, 1), round(math.degrees(a)) % 360, kind, [list(b) for b in bs]] for x, y, kind, a, bs in directions),
            "turns": sorted([str(n), round(math.degrees(h)) % 360, lanes, round(x, 1), round(y, 1)] for n, h, lanes, (x, y) in turns)}


if __name__ == "__main__":
    area = sys.argv[1] if len(sys.argv) > 1 else "centrum"
    path = OUT / f"{area}_now" / "traffic-signs.json"
    path.write_text(json.dumps(build(area), separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print("wrote", path, path.stat().st_size, "bytes")
