"""Prague's tram lines along their real routes, from OpenStreetMap's route relations.

    uv run build_lines.py centrum      # → public/data/centrum_now/lines.json

Every tram line is mapped as two route relations, one per direction, listing its
track ways in driving order and its stops. They're stitched into one closed loop
per line (there and back; Prague's termini are turning loops), joining the two
directions and any gap in a relation along the tram-track network. Lines are kept
whole even where they leave the area, so trams come in from outside at the right
times.

Each line in lines.json: `ref`, `colour`, `night` (the 9x night lines), `from` and
`to`, `pts` (the loop in the area's local metres, first point repeated at the end),
`length`, `stops` ([distance along the loop, name] of each stop position), `ends`
(where the tram gets to `to` and back to `from`),
`speed` ([distance, km/h] wherever the limit changes: the track's maxspeed, and
less round tight curves) and `turns`, termini with no loop on the map: at `at` the
tram stops, and it sets off again from `to` (where the track doubles back on itself,
`to` = `at`: the tram reverses; otherwise it moves across to the other track).
"""

import heapq
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

import requests
from pyproj import Transformer
from shapely.geometry import LineString, Point, box

from osm_area import AREAS, OUT

CACHE = Path(__file__).parent / ".cache" / "osm"
PBF = Path(os.environ.get("OSM_PBF", CACHE / "czech-republic-latest.osm.pbf"))
MAX_TURN = math.radians(60)  # sharper than this at a node is not a way a tram can go
MARGIN = 0.03  # degrees of track kept around the area, for routes that leave it
HISTORIC = {"41", "42"}  # the nostalgic lines run old cars on a few days: left out


def load_pbf(bbox):
    """Tram route relations and tram tracks from the local extract, via osmium's OPL."""
    out = CACHE / "tram_routes.osm.pbf"
    if not out.exists() or out.stat().st_mtime < PBF.stat().st_mtime:
        subprocess.run(["osmium", "tags-filter", "--overwrite", "-o", str(out), str(PBF),
                        "r/route=tram", "w/railway=tram"], check=True)
    opl = subprocess.run(["osmium", "cat", "-f", "opl,add_metadata=false", str(out)],
                         check=True, capture_output=True, text=True).stdout
    unesc = lambda s: re.sub(r"%([0-9a-f]+)%", lambda m: chr(int(m.group(1), 16)), s)  # noqa: E731
    nodes, ways, rels = {}, {}, {}
    for line in opl.splitlines():
        head, *fields = line.split(" ")
        f = {x[0]: x[1:] for x in fields if x}
        tags = dict(unesc(kv).split("=", 1) for kv in f.get("T", "").split(",") if kv) if f.get("T") else {}
        oid = int(head[1:])
        if head[0] == "n":
            nodes[oid] = (float(f["x"]), float(f["y"]), tags.get("name"))
        elif head[0] == "w":
            ways[oid] = (tags, [int(n[1:]) for n in f.get("N", "").split(",") if n])
        elif head[0] == "r":
            members = []
            for m in f.get("M", "").split(","):
                if m:
                    ref, role = m.split("@", 1)
                    members.append((ref[0], int(ref[1:]), unesc(role)))
            rels[oid] = (tags, members)
    return nodes, ways, rels


def load_overpass(bbox):
    """The same from Overpass, without a local extract."""
    w, s, e, n = bbox
    url = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api") + "/interpreter"
    q = f'[out:json][timeout:180];(relation["route"="tram"]({s},{w},{n},{e});way["railway"="tram"]({s},{w},{n},{e}););(._;>;);out body;'
    data = requests.post(url, data={"data": q}, timeout=240).json()
    nodes, ways, rels = {}, {}, {}
    for el in data["elements"]:
        if el["type"] == "node":
            nodes[el["id"]] = (el["lon"], el["lat"], el.get("tags", {}).get("name"))
        elif el["type"] == "way":
            ways[el["id"]] = (el.get("tags", {}), el["nodes"])
        else:
            rels[el["id"]] = (el.get("tags", {}), [(m["type"][0], m["ref"], m["role"]) for m in el["members"]])
    return nodes, ways, rels


class Tracks:
    """The tram-track network, for joining pieces of a route: node → next nodes."""

    def __init__(self, ways, xy):
        self.xy = xy
        self.fwd, self.both = {}, {}
        for tags, nds in ways.values():
            if tags.get("railway") != "tram" or not all(n in xy for n in nds):
                continue
            oneway = tags.get("oneway") == "yes"
            for a, b in zip(nds, nds[1:]):
                for adj in (self.fwd, self.both):
                    adj.setdefault(a, set()).add(b)
                self.both.setdefault(b, set()).add(a)
                if not oneway:
                    self.fwd.setdefault(b, set()).add(a)

    def turn(self, a, b, c):
        (ax, ay), (bx, by), (cx, cy) = self.xy[a], self.xy[b], self.xy[c]
        t = abs(math.atan2(cy - by, cx - bx) - math.atan2(by - ay, bx - ax))
        return min(t, 2 * math.pi - t)

    def length(self, nds):
        return sum(math.dist(self.xy[a], self.xy[b]) for a, b in zip(nds, nds[1:]))

    def route(self, prev, start, goal, after=None):
        """The way along the tracks from `start` (reached from `prev`) to `goal` (to be
        left towards `after`), as (nodes, index of the node where the tram reverses or
        None). Tries the strict reading of the map first: one-way tracks, no turn
        sharper than a switch; then, for mapping slips at termini, ignores one-way,
        allows sharper turns, and last lets the tram reverse once."""
        limit = max(1500.0, 5 * math.dist(self.xy[start], self.xy[goal]))
        for adj, max_turn, reverse in ((self.fwd, MAX_TURN, False), (self.both, MAX_TURN, False),
                                       (self.both, math.radians(100), False), (self.both, MAX_TURN, True)):
            r = self._route(adj, max_turn, reverse, prev, start, goal, after, limit)
            if r:
                return r
        return None

    def _route(self, adj, max_turn, reverse, prev, start, goal, after, limit):
        if start == goal and (prev is None or after is None or self.turn(prev, start, after) <= max_turn):
            return [start], None
        # State: (previous node, node, reversed yet). Reversing costs 1 km, so it's
        # only used where there's no way round.
        s0 = (prev, start, False)
        dist, back, heap = {s0: 0.0}, {}, [(0.0, s0)]
        while heap:
            d, st = heapq.heappop(heap)
            p, u, rev = st
            if d > dist.get(st, math.inf) or d > limit + (1000 if rev else 0):
                continue
            for v in adj.get(u, ()):
                moves = []
                if v != p and (p is None or self.turn(p, u, v) <= max_turn):
                    moves.append((v, rev, 0.0))
                if reverse and not rev and p is not None and math.pi - self.turn(p, u, v) <= max_turn:
                    moves.append((v, True, 1000.0))
                for v, r2, extra in moves:
                    if v == goal and after is not None and self.turn(u, v, after) > max_turn:
                        continue
                    ns = (u, v, r2)
                    nd = d + extra + math.dist(self.xy[u], self.xy[v])
                    if nd >= dist.get(ns, math.inf):
                        continue
                    dist[ns], back[ns] = nd, st
                    if v == goal:
                        path, flip, k = [], None, ns
                        while k in back:
                            if k[2] and not back[k][2]:
                                flip = k[0]
                            path.append(k[1])
                            k = back[k]
                        path = [start] + path[::-1]
                        return path, (path.index(flip) if flip is not None else None)
                    heapq.heappush(heap, (nd, ns))
        return None


def stitch(members, ways, tracks):
    """A relation's ways as one node sequence in driving order, gaps routed along the
    tracks. None if a gap can't be closed."""
    seqs = [ways[i][1] for t, i, role in members if t == "w" and role in ("", "forward", "backward") and i in ways]
    seqs = [s for s in seqs if len(s) > 1 and all(n in tracks.xy for n in s)]
    if not seqs:
        return None
    first = seqs[0]
    if len(seqs) > 1 and first[0] in (seqs[1][0], seqs[1][-1]) and first[-1] not in (seqs[1][0], seqs[1][-1]):
        first = first[::-1]
    out = list(first)
    for s in seqs[1:]:
        end = out[-1]
        if s[0] == end:
            out += s[1:]
        elif s[-1] == end:
            out += s[::-1][1:]
        elif end in s:  # joined part-way along: go on the way that bends least
            k = s.index(end)
            if s[0] == s[-1]:  # a loop: all the way round, one way or the other
                fwd = s[k:-1] + s[:k + 1]
                ways_on = (fwd, fwd[::-1])
            else:
                ways_on = (s[k:], s[k::-1])
            out += min((x for x in ways_on if len(x) > 1), key=lambda x: tracks.turn(out[-2], end, x[1]))[1:]
        else:
            # A gap: route along the tracks to whichever end of the next way is nearer.
            options = []
            for nxt in (s, s[::-1]):
                r = tracks.route(out[-2], end, nxt[0], nxt[1])
                if r and r[1] is None:
                    options.append((tracks.length(r[0]), r[0], nxt))
            if not options:
                return None
            _, r, nxt = min(options, key=lambda o: o[0])
            out += r[1:] + nxt[1:]
    return out


def main(area: str = "centrum") -> None:
    w, s, e, n = AREAS[area]
    centre = ((w + e) / 2, (s + n) / 2)
    tf = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=tmerc +lat_0={centre[1]} +lon_0={centre[0]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
        always_xy=True,
    )
    wide = (w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN)
    nodes, ways, rels = load_pbf(wide) if PBF.exists() else load_overpass(wide)
    # Whole lines: every tram track in Prague's box, not only the area's.
    pw, ps, pe, pn = AREAS["praha"]
    xy = {k: tf.transform(lon, lat) for k, (lon, lat, _) in nodes.items() if pw - MARGIN < lon < pe + MARGIN and ps - MARGIN < lat < pn + MARGIN}
    tracks = Tracks(ways, xy)
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)

    legs = {}  # ref → [(relation id, tags, node sequence)]
    broken = []
    for rid, (tags, members) in sorted(rels.items()):
        ref = tags.get("ref")
        if tags.get("route") != "tram" or not ref or ref in HISTORIC:
            continue
        if not tags.get("network", "").startswith("Pražská") and tags.get("network:short") != "PID":
            continue
        seq = stitch(members, ways, tracks)
        if not seq:
            broken.append(f"{ref} (r{rid})")
            continue
        stops = [(xy[i], stop_name(i, members, nodes, ways, xy)) for t, i, role in members if t == "n" and role.startswith("stop") and i in xy]
        legs.setdefault(ref, []).append((rid, tags, seq, stops))
    if broken:
        print("couldn't follow:", ", ".join(broken))

    lines = []
    for ref, cands in sorted(legs.items(), key=lambda kv: int(re.sub(r"\D", "", kv[0]) or 0)):
        # Pair up the two directions: relations tagged as each other's reverse first,
        # then whichever ends join up with the least track between them. A line with
        # variants (a short working, a diversion) gets a loop for each pair.
        pairs = []
        for i, A in enumerate(cands):
            for B in cands[i + 1:]:
                ab, ba = join(tracks, A[2], B[2]), join(tracks, B[2], A[2])
                if ab and ba:
                    tagged = A[1].get("from") == B[1].get("to") and A[1].get("to") == B[1].get("from")
                    joins = sum(tracks.length(r[0]) + (1000 if r[1] else 0) for r in (ab, ba))
                    pairs.append(((not tagged, joins), A, B, ab, ba))
        used = set()
        for _, A, B, ab, ba in sorted(pairs, key=lambda p: p[0]):
            if A[0] in used or B[0] in used:
                continue
            used |= {A[0], B[0]}
            line = loop(ref, A, B, ab, ba, xy, ways)
            if LineString(line["pts"]).intersects(box(x0, y0, x1, y1)):
                lines.append(line)
                turns = "".join(f", {'reverses' if u['at'] == u['to'] else 'skips across'} at {u['where']}" for u in line["turns"])
                print(f"line {ref}: {A[1].get('from')} ↔ {A[1].get('to')}, {line['length'] / 1000:.1f} km there and back, "
                      f"{len(line['stops'])} stops{turns}")
        for c in cands:
            if c[0] not in used:
                print(f"line {ref}: {c[1].get('from')} → {c[1].get('to')} (r{c[0]}) has no way back; left out")

    out = OUT / f"{area}_now" / "lines.json"
    out.write_text(json.dumps({"lines": lines}, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(lines)} lines, {out.stat().st_size / 1e6:.2f} MB → {out.relative_to(OUT.parent)}")


def join(tracks, a, b):
    """How a tram gets from the end of one direction to the start of the other:
    (nodes, turn) where turn is None, ("flip", i) if it reverses at nodes[i], or
    ("jump", 0) where the map has no way round (a stub terminus, or tracks missing)
    and the ends are close: there the tram waits at the end and reappears at the start."""
    r = tracks.route(a[-2], a[-1], b[0], b[1])
    if r:
        return r[0], (("flip", r[1]) if r[1] is not None else None)
    if math.dist(tracks.xy[a[-1]], tracks.xy[b[0]]) < 150:
        return [a[-1], b[0]], ("jump", 0)
    return None


def stop_name(i, members, nodes, ways, xy):
    """A stop position's name, else the name of the nearest platform of the route
    (within 60 m), else None."""
    if nodes[i][2]:
        return nodes[i][2]
    best, near = None, 60.0
    for t, j, role in members:
        if not role.startswith("platform"):
            continue
        if t == "n" and j in xy and nodes[j][2]:
            name, p = nodes[j][2], xy[j]
        elif t == "w" and j in ways and ways[j][0].get("name") and all(n in xy for n in ways[j][1]):
            pts = [xy[n] for n in ways[j][1]]
            name, p = ways[j][0]["name"], (sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts))
        else:
            continue
        if math.dist(p, xy[i]) < near:
            best, near = name, math.dist(p, xy[i])
    return best


def loop(ref, A, B, ab, ba, xy, ways):
    """One line variant as a closed loop: there, round the terminus, back and round."""
    (_, ta, a, sa), (_, tb, b, sb) = A, B
    seq = a + ab[0][1:] + b[1:] + ba[0][1:-1]
    starts = [0, len(a) - 1, len(a) + len(ab[0]) - 2, len(a) + len(ab[0]) + len(b) - 3]  # a, ab, b, ba
    pts = [xy[k] for k in seq] + [xy[seq[0]]]
    cum = [0.0]
    for p, q in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.dist(p, q))
    ls = LineString(pts).simplify(0.15)
    scale = ls.length / cum[-1]  # simplifying makes it a hair shorter
    at = lambda i: round(cum[i] * scale, 1)  # noqa: E731
    # Stops: each direction's stop positions measured along that direction only, so a
    # stop isn't put on the opposite track a few metres away.
    stops = {cum[starts[0]] + LineString([xy[k] for k in a]).project(Point(p)): name for p, name in sa}
    stops |= {cum[starts[2]] + LineString([xy[k] for k in b]).project(Point(p)): name for p, name in sb}
    turns = []
    for j, (nodes, turn), where in ((1, ab, ta.get("to")), (3, ba, ta.get("from"))):
        if turn:
            kind, k = turn
            s = at(starts[j] + k)
            turns.append({"at": s, "to": s if kind == "flip" else at(starts[j] + k + 1), "where": where})
    return {
        "ref": ref, "colour": ta.get("colour") or tb.get("colour"), "night": len(ref) == 2 and ref.startswith("9"),
        "from": ta.get("from"), "to": ta.get("to"),
        "pts": [[round(x, 2), round(y, 2)] for x, y in ls.coords],
        "length": round(ls.length, 1),
        "stops": [[round(v * scale, 1), name] for v, name in sorted(stops.items())],
        "ends": [at(starts[1]), at(starts[3])],
        "turns": turns,
        "speed": speed_profile(ls, seq, ways, xy, scale),
    }


def speed_profile(ls, seq, ways, xy, scale):
    """[distance, km/h] where the limit changes: the track's maxspeed (50 where it's
    not mapped) and a comfortable speed round curves (about 1.2 m/s² sideways)."""
    maxspeed = {}
    for tags, nds in ways.values():
        v = re.match(r"\d+", tags.get("maxspeed", ""))
        if v:
            for a, b in zip(nds, nds[1:]):
                maxspeed[(a, b)] = maxspeed[(b, a)] = int(v.group())
    along, s = [], 0.0
    for a, b in zip(seq, seq[1:] + seq[:1]):
        along.append((s * scale, maxspeed.get((a, b), 50)))
        s += math.dist(xy[a], xy[b])
    # Sampled every 4 m; the radius from the heading change over 12 m either side, and
    # each sample takes the lowest of its neighbours so a curve is slow all the way round.
    L, step, half = ls.length, 4.0, 12.0
    raw, j = [], 0
    for k in range(int(L / step) + 1):
        d = k * step
        while j + 1 < len(along) and along[j + 1][0] <= d:
            j += 1
        p, q, r = (ls.interpolate((d + o) % L) for o in (-half, 0, half))
        h1 = math.atan2(q.y - p.y, q.x - p.x)
        h2 = math.atan2(r.y - q.y, r.x - q.x)
        turn = abs((h2 - h1 + math.pi) % (2 * math.pi) - math.pi)
        radius = half / max(turn, 1e-6)
        raw.append(min(along[j][1], max(10, 5 * int(math.sqrt(1.2 * radius) * 3.6 / 5))))
    out = []
    for k in range(len(raw)):
        kmh = min(raw[max(0, k - 2):k + 3])
        if not out or out[-1][1] != kmh:
            out.append([round(k * step, 1), kmh])
    return out


if __name__ == "__main__":
    main(*sys.argv[1:])
