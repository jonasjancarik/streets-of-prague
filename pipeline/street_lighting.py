"""Which streets are lit at night, for the lamps the game adds where the survey has none
(build_lamps.py writes the answer to lit.bin.gz, src/lamps.ts reads it).

A street tagged in OSM as lit or dark is what its tag says. An untagged street is lit:

- where a lamp stands near it (the survey's or OSM's, within LAMP_NEAR);
- where buildings stand along it (one of at least MIN_BUILDING m² within BUILT of it);
- on the way from a lit stretch to the nearest other lit stretch along the streets, if
  that way is no longer than LINK, so a lit stretch isn't an island in the dark.

Everything else stays dark: a road between fields, a street tagged dark. Streets are
judged piece by piece (PIECE long at most, cut at junctions too), so a long road is lit
past the houses along it and dark beyond them.

LINK is 300 m: about ten lamps of the game's own at their spacing of 30 m. It joins a
row of houses to the village it belongs to and two halves of a built-up street across
a park or a field's corner, and leaves a lone farm half a kilometre out by itself.
"""

import heapq
from collections import Counter

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString

# What a stretch of street is lit by (lit.bin.gz's flag; 0 is a street tagged dark).
DARK, TAGGED, BY_LAMP, BY_BUILDINGS, BY_LINK = 0, 1, 2, 3, 4
REASONS = {TAGGED: "tagged lit", BY_LAMP: "a lamp nearby", BY_BUILDINGS: "buildings along it", BY_LINK: "the way to the next lit street", DARK: "tagged dark"}
LAMP_NEAR = 45.0   # m
BUILT = 25.0       # m, from the street's centre line
MIN_BUILDING = 40.0  # m²: not a garden shed or a garage
LINK = 300.0       # m
PIECE = 25.0       # m
# The streets the rules for untagged ones apply to: those the game puts lamps on, without
# the trunk roads (lit, where they are, by lamps the survey has).
INFERRED = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link", "residential",
            "unclassified", "living_street", "pedestrian", "busway"}


def _key(p):
    return (round(p[0], 2), round(p[1], 2))


def pieces(ways):
    """The ways cut into pieces at the points they share and every PIECE metres:
    [(way index, [(x, y), …])]."""
    uses = Counter(k for _, _, pts in ways for k in {_key(p) for p in pts})
    out = []
    for w, (_, _, pts) in enumerate(ways):
        run, length = [pts[0]], 0.0
        for a, b in zip(pts, pts[1:]):
            seg = float(np.hypot(b[0] - a[0], b[1] - a[1]))
            n = max(1, int(np.ceil(seg / PIECE)))
            for i in range(1, n + 1):
                p = b if i == n else (a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)
                run.append(p)
                length += seg / n
                if length >= PIECE or (i == n and uses[_key(b)] > 1):
                    out.append((w, run))
                    run, length = [p], 0.0
        if len(run) > 1:
            out.append((w, run))
    return out


def lighting(ways, buildings, lamps):
    """`ways`: [(1 lit / 0 dark / None untagged, highway class, [(x, y), …])] in metres
    (a way in a tunnel: leave it out); `buildings`: shapely polygons; `lamps`: [(x, y)].
    Returns the lit and the tagged-dark stretches as [(flag, [(x, y), …])], and the
    metres of street by flag, with None for what is left dark untagged."""
    cut = pieces(ways)
    lines = [LineString(pts) for _, pts in cut]
    length = np.array([l.length for l in lines])
    flag = [ways[w][0] for w, _ in cut]
    open_ = np.array([f is None and ways[w][1] in INFERRED for f, (w, _) in zip(flag, cut)], dtype=bool)
    if lines:
        tree = STRtree(lines)
        big = [b for b in buildings if b.area >= MIN_BUILDING]
        by_building = set(tree.query(big, predicate="dwithin", distance=BUILT)[1].tolist()) if big else set()
        by_lamp = set(tree.query(shapely.points(np.asarray(lamps, dtype=float).reshape(-1, 2)), predicate="dwithin", distance=LAMP_NEAR)[1].tolist()) if len(lamps) else set()
        for i in np.flatnonzero(open_):
            if i in by_lamp:
                flag[i] = BY_LAMP
            elif i in by_building:
                flag[i] = BY_BUILDINGS

    # The lit stretches as they hang together, and the dark streets between them as a graph.
    ends = [(_key(pts[0]), _key(pts[-1])) for _, pts in cut]
    group = {}

    def find(k):
        while group.setdefault(k, k) != k:
            group[k] = group[group[k]]
            k = group[k]
        return k
    for (a, b), f in zip(ends, flag):
        if f:
            group[find(a)] = find(b)
    lit_nodes = {}
    for k in list(group):
        lit_nodes.setdefault(find(k), []).append(k)
    ways_out = {}
    for i, ((a, b), f) in enumerate(zip(ends, flag)):
        if f is None and open_[i]:
            ways_out.setdefault(a, []).append((b, i))
            ways_out.setdefault(b, []).append((a, i))
    linked = set()
    for own, nodes in sorted(lit_nodes.items()):
        best = {k: 0.0 for k in nodes}
        came = {}
        heap = [(0.0, k) for k in sorted(nodes) if k in ways_out]
        heapq.heapify(heap)
        while heap:
            d, k = heapq.heappop(heap)
            if d > best.get(k, np.inf):
                continue
            if d > 0 and k in group and find(k) != own:
                while k in came:
                    k, i = came[k]
                    linked.add(i)
                break
            for other, i in ways_out.get(k, ()):
                nd = d + float(length[i])
                if nd <= LINK and nd < best.get(other, np.inf):
                    best[other] = nd
                    came[other] = (k, i)
                    heapq.heappush(heap, (nd, other))
    for i in linked:
        flag[i] = BY_LINK

    metres = Counter()
    for i, f in enumerate(flag):
        if f is not None or open_[i]:
            metres[f] += float(length[i])
    # Neighbouring pieces of a way with the same flag, as one line again.
    runs = []
    for (w, pts), f in zip(cut, flag):
        if f is None:
            continue
        if runs and runs[-1][0] == (w, f) and runs[-1][1][-1] == pts[0]:
            runs[-1][1].extend(pts[1:])
        else:
            runs.append(((w, f), list(pts)))
    return [(f, pts) for (_, f), pts in runs], dict(metres)
