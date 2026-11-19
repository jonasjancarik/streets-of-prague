"""The steps in the ground as lines with their own heights (a trial).

A step in the ground (a quay wall, a retaining wall) is an outline in the tile (the
water's, a terrace's: dtm_heights.py) between lattice points of two labels. The game
used to read the ground on each side of it from the lattice alone, from the corners of
the cell on that side (src/terrain.ts, heightSampler). That is flat across a cell where
the side has one corner, so a wall running down a slope had a staircase for a top, and
the parapet on it a sawtooth. Here each outline gets, every metre or two along it, the
ground's height on its left and on its right, read from the source a few metres out on
that side (the scan's, or the lattice's own side) and carried in to the line, then
smoothed along it. The game takes a point near the step from its side of the line,
going over into the lattice a few metres out, so the walls, the parapets, the ground's
cut and the cars all meet the same smooth heights.

Per tile, a list of {"l": label on the left, "r": label on the right, "pts": [[x, y,
height on the left, height on the right], ...]} (heights in m a.s.l.), each a run of an
outline between the same two labels. The labels are those of src/stepEdges.ts's
stepSides: the flat terraces, then the water, then the other terraces, else 0.
"""

import math
import warnings

import numpy as np
import shapely

SPACING = 2.0  # m between a line's points at most
OUT = np.arange(1.5, 4.01, 0.5)  # m out from the line where each side's ground is read
SIGMA = 2.0  # m: how far along the line its heights are smoothed (a Gaussian's sigma)
GAP = 2 * SIGMA  # m along the line from the nearest reading: past it a side has no height
STEP_MIN = 0.3  # m between the sides: a lower step is none, both at their mean
SOFT = 0.5  # m from an outline that was only cut (for_tile's `soft`)
CROSS = 1.0  # m either side of a line where a car street crossing it is looked for
SIDE = 0.2  # m either side of an outline where its sides' labels are looked up
MARGIN = 0.0  # m: a lattice corner nearer the line than this counts for neither side
WALK = np.arange(0.0, 6.01, 0.5)  # m out from the line where a walk (walk_reader) reads the scan
FLAT = 0.5  # rise per metre under which the ground past a wall counts as its top or foot
MEDIAN = 3.0  # m either way along the line: a walked side's running median, before smoothing
WALK_ACROSS = False  # a walk may cross other terraces' outlines (it stops at the first flat ground).
# (Tried: the foot of Vyšehrad's rampart is on the strip of the wall below it and kept
# the lattice's, 4 m under the scan; across, its foot broke open and Československého
# exilu's top got a notch down to the street.)
TAPER = 6.0  # m: over this from a wall's end its walked heights come back to the lattice's
SPAN = 6.0  # m either side of the line: the scan's rise across it caps a half-walked step
STEP_SLACK = 0.5  # m over the scan's rise a half-walked step may be
WALKED = 0.6  # share of a side's points the walk must find a height for, or the side isn't walked
WATER = 1
# Trial (November 2026): each wall's top as straight pieces at an even grade
# (straight_tops), off by default.
STRAIGHT_TOPS = False
STRAIGHT_FILL = False  # and the lattice just behind the top raised to it
TOP_STEP = 0.5  # m: a point is on a wall where its step is this or more
TOP_GAP = 4.0  # m along a wall without a step (or with no heights, a street across it) ends a stretch
TOP_REACH = 6.0  # m either way along the wall: the top's upper envelope, TOP_PCT of the heights there
TOP_PCT = 80.0
TOP_TOL = 0.3  # m off the envelope before a straight piece is split in two
TOP_SEG = 8.0  # m: the shortest straight piece
TOP_RAISE = 3.0  # m: the most a top is raised
TOP_LOWER = 0.5  # m: the most a top is lowered
TOP_CORNER = 35.0  # degrees: where a wall turns this much over 4 m, a piece ends
TOP_JOIN = 0.3  # m between two lines' ends at a tile's edge that are one wall
TOP_GRADE = 0.2  # rise per metre along a piece over which it is a bank's slope and stays as it was
FILL_REACH = 4.0  # m behind the wall where STRAIGHT_FILL raises the lattice
FILL_MAX = 6.0  # m: the most STRAIGHT_FILL raises a lattice point
STRAIGHT_CROWN = False  # and the top read from the LiDAR where the wall's face ends (crown_at)
CROWN_FACE = 1.0  # rise per metre: steeper is the wall's face, gentler the bank behind it
CROWN_RISE = 1.0  # m: the least height of a face
CROWN_NEAR = 5.0  # m from the line toward the top: the face starts within this
CROWN_FAR = 10.0  # m: the furthest a profile is read
CROWN_SHARE = 0.5  # of a stretch's points with a crown, for it to take one
CROWN_GAP = 16.0  # m: a gap in a wall up to this long whose crown the scan has all along is wall


def sides(water, terraces):
    """The label at points (xs, ys): the flat terraces first (they lie over the water
    too), then the water, then the other terraces, else 0 (src/stepEdges.ts)."""
    flat = [(t["label"], shapely.Polygon(p[0], p[1:])) for t in terraces if t.get("h") is not None for p in t["polys"]]
    other = [(t["label"], shapely.Polygon(p[0], p[1:])) for t in terraces if t.get("h") is None and t["label"] != WATER for p in t["polys"]]
    wet = [shapely.Polygon(p[0], p[1:]) for p in water]
    for g in [g for _, g in flat + other] + wet:
        shapely.prepare(g)

    def at(xs, ys):
        out = np.zeros(len(xs), dtype=np.int32)
        done = np.zeros(len(xs), dtype=bool)
        for group in (flat, [(WATER, g) for g in wet], other):
            for label, g in group:
                hit = ~done & shapely.contains_xy(g, xs, ys)
                out[hit] = label
                done |= hit
        return out
    return at


def runs(rings, box, at):
    """The runs of the outlines between two labels: (left label, right label, points),
    densified to SPACING, with whether each end stops at the tile's edge."""
    x0, y0, x1, y1 = box
    on_edge = lambda a, b: any(abs(a[k] - v) < 0.05 and abs(b[k] - v) < 0.05 for k, v in ((0, x0), (0, x1), (1, y0), (1, y1)))  # noqa: E731
    out = []
    for ring in rings:
        m = len(ring)
        if m < 3:
            continue
        segs = []
        for k in range(m):
            a, b = ring[k], ring[(k + 1) % m]
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length < 1e-6 or on_edge(a, b):
                segs.append(None)
                continue
            nx, ny, mx, my = -dy / length, dx / length, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            segs.append((a, b, length, nx, ny, mx, my))
        live = [s for s in segs if s]
        if not live:
            continue
        lab = at(np.array([s[5] + s[3] * SIDE for s in live] + [s[5] - s[3] * SIDE for s in live]),
                 np.array([s[6] + s[4] * SIDE for s in live] + [s[6] - s[4] * SIDE for s in live]))
        labels, q = [], 0
        for s in segs:
            if s is None:
                labels.append(None)
            else:
                labels.append((int(lab[q]), int(lab[q + len(live)])))
                q += 1
        # Start at a break (a tile edge or a change of labels), so no run wraps round.
        start = next((k for k in range(m) if labels[k] is None or labels[k] != labels[k - 1]), 0)
        current = None
        for step in range(m):
            k = (start + step) % m
            s, lr = segs[k], labels[k]
            if s is None or lr[0] == lr[1]:
                current = None
                continue
            a, b, length = s[0], s[1], s[2]
            n = max(1, math.ceil(length / SPACING))
            pts = [(a[0] + (b[0] - a[0]) * f / n, a[1] + (b[1] - a[1]) * f / n) for f in range(n + 1)]
            if current is not None and current["lr"] == lr:
                current["pts"] += pts[1:]
            else:
                current = {"lr": lr, "pts": pts, "edge_start": segs[k - 1] is None}
                out.append(current)
            current["edge_end"] = segs[(k + 1) % m] is None
    return out


def heights(run, read, at, box, flat=()):
    """Each side's height at the run's points: the ground read at OUT on that side, a
    straight line through it carried in to the line, then smoothed along the line over
    SIGMA (past an end at the tile's edge the line runs on straight, so the neighbour,
    which does the same, meets it). Only what lies on that side counts (`at`, the labels
    inside the tile `box`): a terrace a few metres wide has the next one past it."""
    pts = np.array(run["pts"], dtype=float)
    # Run on past ends at the tile's edge, 3 sigma, so the smoothing there is the neighbour's.
    extra = int(math.ceil(3 * SIGMA))
    before = after = 0
    if len(pts) > 1:
        if run["edge_start"]:
            d = pts[0] - pts[1]
            d /= np.linalg.norm(d) or 1
            ext = pts[0] + d * np.arange(extra, 0, -1)[:, None]
            pts, before = np.vstack([ext, pts]), extra
        if run["edge_end"]:
            d = pts[-1] - pts[-2]
            d /= np.linalg.norm(d) or 1
            ext = pts[-1] + d * np.arange(1, extra + 1)[:, None]
            pts, after = np.vstack([pts, ext]), extra
    # The left normal at each point, from its neighbours along the line.
    ahead = np.gradient(pts, axis=0) if len(pts) > 1 else np.array([[1.0, 0.0]])
    ahead /= np.maximum(np.linalg.norm(ahead, axis=1, keepdims=True), 1e-9)
    normal = np.column_stack([-ahead[:, 1], ahead[:, 0]])
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]) if len(pts) > 1 else np.zeros(1)
    out, walks = [], []
    for sign, label in ((1, run["lr"][0]), (-1, run["lr"][1])):
        xs = pts[:, 0, None] + sign * normal[:, 0, None] * OUT
        ys = pts[:, 1, None] + sign * normal[:, 1, None] * OUT
        # (A reader that can, the lattice's, takes only what lies on this side of the line.)
        side = {}
        if getattr(read, "sided", False):
            k = np.repeat(np.arange(len(pts)), len(OUT))
            side = {"away": (pts[k, 0], pts[k, 1], sign * normal[k, 0], sign * normal[k, 1])}
        # (A flat terrace is flat at its own height: the lattice's side, not the scan's.)
        reader = getattr(read, "lattice", read) if label in flat else read
        z = reader(xs.ravel(), ys.ravel(), label, **side)
        inside = (xs.ravel() > box[0]) & (xs.ravel() < box[2]) & (ys.ravel() > box[1]) & (ys.ravel() < box[3])
        z[inside & (at(xs.ravel(), ys.ravel()) != label)] = np.nan
        z = z.reshape(xs.shape)
        on_line = {"away": (pts[:, 0], pts[:, 1], sign * normal[:, 0], sign * normal[:, 1])} if side else {}
        h = _carried_in_rows(z, reader(pts[:, 0], pts[:, 1], label, **on_line))
        # (A reader that walks, walk_reader: where the scan flattens out past the wall,
        # with a running median along the line, so a gate or a gap in the scan doesn't
        # take the top down with it.)
        walked = None
        walk = getattr(read, "walk", None)
        if walk is not None and label not in flat and label != WATER:
            def keep(qx, qy, label=label):
                inside = (qx > box[0]) & (qx < box[2]) & (qy > box[1]) & (qy < box[3])
                if WALK_ACROSS:  # (only not into the water)
                    return ~inside | (at(qx, qy) != WATER)
                return ~inside | (at(qx, qy) == label)
            hw = _running_median(s, walk(pts, sign * normal, keep), MEDIAN)
            # (All or nothing on a side: where it flattens along most of it, the gaps
            # between along the line; else the reading stands. Mixing the two along a
            # line made a top jump between them.)
            got = np.isfinite(hw)
            if got.mean() >= WALKED:
                walked = _smoothed(s, np.interp(s, s[got], hw[got]))
        out.append(_smoothed(s, h))
        walks.append(walked)
    if any(w is not None for w in walks):
        out = _walked(s, out, walks, run, pts, normal, read)
    keep = slice(before, len(pts) - after)
    return pts[keep], out[0][keep], out[1][keep]


def _smoothed(s, h):
    """Smoothed along the line over SIGMA (the points with no height left out), and no
    height where the nearest reading along it is further than GAP."""
    ok = np.isfinite(h)
    if ok.any():
        w = np.exp(-((s[:, None] - s[None, ok]) ** 2) / (2 * SIGMA * SIGMA))
        with np.errstate(invalid="ignore"):  # far from any reading: no height, below
            h = (w * h[ok]).sum(axis=1) / w.sum(axis=1)
        h[np.abs(s[:, None] - s[None, ok]).min(axis=1) > GAP] = np.nan
    return h


def _walked(s, read_, walks, run, pts, normal, read):
    """Each side's heights with its walk (heights()), where it has one: brought back to
    what was read without it over TAPER from an end of the step, where the line ends
    short of the tile's edge or the other side has no height (the game takes the
    lattice past it: a walked top 4 m over the lattice's ended in a cliff, Vyšehrad);
    and where one side is walked and the other not, the step no higher than the scan's
    own rise across the line, SPAN either way, and STEP_SLACK (on a sloping bank the
    walk found a top 8 m over the lattice's foot where the scan rises 5)."""
    out = []
    for k, (h, w) in enumerate(zip(read_, walks)):
        if w is None:
            out.append(h)
            continue
        other = read_[1 - k] if walks[1 - k] is None else walks[1 - k]
        ends = [s[0]] if not run["edge_start"] else []
        ends += [s[-1]] if not run["edge_end"] else []
        gone = ~np.isfinite(other)
        flip = np.flatnonzero(gone[1:] != gone[:-1])
        ends += [(s[q] + s[q + 1]) / 2 for q in flip]
        far = np.min(np.abs(s[:, None] - np.array(ends)[None, :]), axis=1) if ends else np.full(len(s), np.inf)
        f = np.clip(far / TAPER, 0.0, 1.0)
        out.append(np.where(np.isfinite(h), h + f * (w - h), w))
    walked = [w is not None for w in walks]
    if walked[0] != walked[1] and getattr(read, "span", None) is not None:
        rise = read.span(pts, normal)
        k = 0 if not walked[0] else 1  # (the side that wasn't walked moves)
        a, b = out[k], out[1 - k]
        with np.errstate(invalid="ignore"):
            over = np.abs(b - a) - (rise + STEP_SLACK)
            move = np.isfinite(over) & (over > 0)
        out[k] = np.where(move, a + np.sign(b - a) * np.where(move, over, 0.0), a)
    return out


def _carried_in(z, line):
    """One point's height on one side (see _carried_in_rows)."""
    return float(_carried_in_rows(np.asarray(z, dtype=float)[None, :], np.array([line], dtype=float))[0])


def _carried_in_rows(z, line):
    """Per row of `z` (the heights read out at OUT), a straight line through them (the
    worst two dropped), carried in to the line, and kept between the nearest of them and
    `line`, what's read on the line itself. A wall's line reads halfway up it (the scan
    blurs it over a metre or two), so its top and foot come through; a slope reads its
    own height there, so a bank rising away from the line gets no pit at its foot and a
    battered wall's face no step at its foot. With nothing read out on that side: `line`."""
    z = np.asarray(z, dtype=float)
    line = np.asarray(line, dtype=float)
    ok = np.isfinite(z)
    count = ok.sum(axis=1)
    d = np.broadcast_to(OUT, z.shape)
    v = np.where(ok, z, 0.0)

    def fit(m):
        n = m.sum(axis=1)
        sd, sv = (m * d).sum(axis=1), (m * v).sum(axis=1)
        sdd, sdv = (m * d * d).sum(axis=1), (m * d * v).sum(axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            b = (n * sdv - sd * sv) / (n * sdd - sd * sd)
            a = (sv - b * sd) / n
        return a, b

    m = ok.copy()
    for _ in range(2):
        a, b = fit(m)
        drop = m.sum(axis=1) > 3
        miss = np.where(m, np.abs(v - (a[:, None] + b[:, None] * d)), -np.inf)
        worst = np.argmax(miss, axis=1)
        rows = np.nonzero(drop)[0]
        m[rows, worst[rows]] = False
    a, b = fit(m)
    first = np.argmax(ok, axis=1)
    near = a + b * OUT[first]
    out = np.minimum(np.maximum(a, np.minimum(near, line)), np.maximum(near, line))
    out = np.where(np.isfinite(line), out, a)
    out = np.where(count == 1, z[np.arange(len(z)), first], out)
    return np.where(count == 0, line, out)


def for_tile(box, water, terraces, read, driven=None, soft=None):
    """The tile's step lines (see the top), from its map water (polygons as rings) and
    its terraces (dtm_heights.py; a label-1 one is its water as the terrain has it).
    `read(xs, ys, label)`: the ground's height on that side at the points. `driven(xs,
    ys)`: whether points are on a car street's carriageway; where one crosses a line (on
    both sides of it), the line has no heights and the lattice's ramp stays: a car
    street meets no sharp step. `soft`: where an outline was only cut (a wall's top
    strip's ends and far side, dtm_heights.SOFT_NEAR): a line within SOFT of it is level,
    at the sides' mean."""
    own_water = next((t["polys"] for t in terraces if t["label"] == WATER), None)
    water = own_water if own_water is not None else water
    at = sides(water, terraces)
    flat = {t["label"] for t in terraces if t.get("h") is not None}
    rings = [r for p in water for r in p] + [r for t in terraces if t["label"] != WATER for p in t["polys"] for r in p]
    lines = []
    for run in runs(rings, box, at):
        pts, hl, hr = heights(run, read, at, box, flat)
        if not len(pts):
            continue
        # Hardly a step: the ground runs on across the line, at the two sides' mean.
        low = np.abs(hl - hr) < STEP_MIN
        hl[low] = hr[low] = (hl[low] + hr[low]) / 2
        if soft is not None:
            cut = shapely.distance(soft, shapely.points(pts)) < SOFT
            if cut.any():
                with np.errstate(invalid="ignore"):
                    mean = np.where(np.isfinite(hl) & np.isfinite(hr), (hl + hr) / 2, np.where(np.isfinite(hl), hl, hr))
                hl[cut], hr[cut] = mean[cut], mean[cut]
        if driven is not None and len(pts) > 1:
            ahead = np.gradient(pts, axis=0)
            ahead /= np.maximum(np.linalg.norm(ahead, axis=1, keepdims=True), 1e-9)
            nx, ny = -ahead[:, 1] * CROSS, ahead[:, 0] * CROSS
            crossed = driven(pts[:, 0] + nx, pts[:, 1] + ny) & driven(pts[:, 0] - nx, pts[:, 1] - ny)
            hl[crossed], hr[crossed] = np.nan, np.nan
        if not (np.isfinite(hl) | np.isfinite(hr)).any():
            continue
        lines.append({"l": run["lr"][0], "r": run["lr"][1],
                      "pts": [[round(float(x), 2), round(float(y), 2), round(float(a), 2) if np.isfinite(a) else None,
                               round(float(b), 2) if np.isfinite(b) else None] for (x, y), a, b in zip(pts, hl, hr)]})
    return lines


def _normals(xy, idx, side):
    """Unit normals at points idx of a polyline, toward side 0 (left) or 1 (right)."""
    d = xy[np.minimum(idx + 1, len(xy) - 1)] - xy[np.maximum(idx - 1, 0)]
    d = d / np.maximum(np.linalg.norm(d, axis=1), 1e-9)[:, None]
    return np.stack([-d[:, 1], d[:, 0]], axis=1) * (1 if side == 0 else -1)


def crown(xy, nrm, scan_at, step=0.5):
    """Per point, the scan's height where the wall's face ends: along the normal
    (toward the top), the steepest rise starting within CROWN_NEAR, run on while steeper
    than CROWN_FACE; NaN where that face is under CROWN_RISE or the scan has nothing."""
    offs = np.arange(-2.0, CROWN_FAR + 1e-9, step)
    px = xy[:, 0:1] + offs[None, :] * nrm[:, 0:1]
    py = xy[:, 1:2] + offs[None, :] * nrm[:, 1:2]
    h = np.asarray(scan_at(px.ravel(), py.ravel()), dtype=float).reshape(px.shape)
    rise = np.diff(h, axis=1) / step
    out = np.full(len(xy), np.nan)
    near = offs[:-1] <= CROWN_NEAR
    for k in range(len(xy)):
        r = rise[k]
        if not np.isfinite(r[near]).any():
            continue
        top = int(np.nanargmax(np.where(near, r, -np.inf)))
        if not r[top] >= CROWN_FACE:
            continue
        a = top
        while a > 0 and r[a - 1] >= CROWN_FACE:
            a -= 1
        b = top
        while b + 1 < len(r) and r[b + 1] >= CROWN_FACE:
            b += 1
        if b + 1 >= len(r):  # (still rising at the profile's end: no crown seen)
            continue
        if h[k, b + 1] - h[k, a] >= CROWN_RISE:
            out[k] = h[k, b + 1]
    return out


def straight_tops(lines_by_tile, ids, boxes, lattice=None, driven=None, crown_at=None):
    """Trial: each wall's top as straight pieces at an even grade. The top read beside a
    wall sags where the scan or the lattice blurs it (a gate, a gap, a cell read on the
    wrong side). A survey retaining wall's top runs straight between its corners, so per
    wall, joined across the tiles' edges, the higher side's heights are replaced by a
    line through their upper envelope (TOP_PCT over TOP_REACH), split where it is more
    than TOP_TOL off it, into pieces of at least TOP_SEG, and always at a corner. A top
    moves up by TOP_RAISE at most and down by TOP_LOWER. `lines_by_tile`: per tile (i, j)
    its lines (for_tile), changed in place. `ids`: per tile its labels' common numbers.
    `boxes`: per tile its (x0, y0, x1, y1). `lattice`: (tiles, labels, N, T, step, gx0,
    gy0) to raise the top's own label's lattice points within FILL_REACH behind the wall
    to the new top (STRAIGHT_FILL), but none within a cell of a car street's carriageway
    (`driven`, see for_tile): those have the scan's road. `crown_at(xs, ys)`, the LiDAR
    (STRAIGHT_CROWN): a top read on a bank behind a low wall is the bank's height, so
    where the scan has a face (steeper than CROWN_FACE, CROWN_RISE or more) starting
    within CROWN_NEAR of the line, the top is no higher than where the face ends (crown()).
    Returns (walls, metres changed, lattice points raised)."""
    common = lambda key, v: ids.get(key, {}).get(int(v), int(v))  # noqa: E731
    items = [(key, n) for key, lines in lines_by_tile.items() for n in range(len(lines))]
    labs = {it: (common(it[0], lines_by_tile[it[0]][it[1]]["l"]), common(it[0], lines_by_tile[it[0]][it[1]]["r"])) for it in items}

    def end_at(it, e):
        p = lines_by_tile[it[0]][it[1]]["pts"][0 if e == 0 else -1]
        return p[0], p[1]

    def on_edge(key, x, y):
        b = boxes[key]
        return min(abs(x - b[0]), abs(x - b[2]), abs(y - b[1]), abs(y - b[3])) < 0.05

    # Ends at a tile's edge, by where they are, to find the neighbour's.
    grid = {}
    for it in items:
        for e in (0, 1):
            x, y = end_at(it, e)
            if on_edge(it[0], x, y):
                grid.setdefault((round(x), round(y)), []).append((it, e))
    link = {}
    for it in items:
        for e in (0, 1):
            x, y = end_at(it, e)
            if (it, e) in link or not on_edge(it[0], x, y):
                continue
            best = None
            for gx in (round(x) - 1, round(x), round(x) + 1):
                for gy in (round(y) - 1, round(y), round(y) + 1):
                    for other, f in grid.get((gx, gy), []):
                        if other[0] == it[0] or (other, f) in link:
                            continue
                        ox, oy = end_at(other, f)
                        d = math.hypot(ox - x, oy - y)
                        same = labs[other] == labs[it] if e != f else labs[other] == labs[it][::-1]
                        if same and d < TOP_JOIN and (best is None or d < best[0]):
                            best = (d, other, f)
            if best:
                link[(it, e)] = (best[1], best[2])
                link[(best[1], best[2])] = (it, e)
    # Walk the chains: from an end with no neighbour, else (a ring) from anywhere.
    seen, chains = set(), []
    for it in sorted(items, key=lambda it: ((it, 0) in link) + ((it, 1) in link)):
        if it in seen:
            continue
        forward = (it, 0) not in link or (it, 1) in link
        chain, cur, fwd = [], it, forward
        while cur not in seen:
            seen.add(cur)
            chain.append((cur, fwd))
            nxt = link.get((cur, 1 if fwd else 0))
            if nxt is None:
                break
            cur, fwd = nxt[0], nxt[1] == 0
        chains.append(chain)
    walls = changed = raised = 0
    behind = {}  # per tile: (x, y, new top, normal to the top's side, its label) to fill
    for chain in chains:
        xy, hl, hr, refs = [], [], [], []
        for (key, n), fwd in chain:
            pts = lines_by_tile[key][n]["pts"]
            order = range(len(pts)) if fwd else range(len(pts) - 1, -1, -1)
            for q in order:
                p = pts[q]
                a = np.nan if p[2] is None else p[2]
                b = np.nan if p[3] is None else p[3]
                xy.append((p[0], p[1]))
                hl.append(a if fwd else b)
                hr.append(b if fwd else a)
                refs.append((key, n, q, fwd))
        xy, hl, hr = np.array(xy, dtype=float), np.array(hl), np.array(hr)
        if len(xy) < 4:
            continue
        s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(xy, axis=0).T))])
        with np.errstate(invalid="ignore"):
            on = np.isfinite(hl) & np.isfinite(hr) & (np.abs(hl - hr) >= TOP_STEP)
        high = np.where(hl > hr, 0, 1)
        if crown_at is not None:
            # (Where the line runs at a slant to the lattice, the side's height is read on
            # the wall's foot every few cells: no step there, and the top had a notch. The
            # scan's profile says whether the wall goes on.)
            onk = np.flatnonzero(on)
            for a, b in zip(onk[:-1], onk[1:]):
                if b - a < 2 or high[a] != high[b] or s[b] - s[a] > CROWN_GAP:
                    continue
                mid = np.arange(a + 1, b)
                side = high[a]
                low = (hr if side == 0 else hl)[mid]
                low = np.where(np.isfinite(low), low, ((hr if side == 0 else hl)[a] + (hr if side == 0 else hl)[b]) / 2)
                cz = crown(xy[mid], _normals(xy, mid, side), crown_at)
                with np.errstate(invalid="ignore"):
                    if not np.all(cz - low >= TOP_STEP):
                        continue
                on[mid], high[mid] = True, side
                (hl if side == 0 else hr)[mid] = cz
                (hr if side == 0 else hl)[mid] = low
        # Corners: the turn between the 2 m before a point and the 2 m after it.
        px, py = np.interp(s - 2, s, xy[:, 0]), np.interp(s - 2, s, xy[:, 1])
        qx, qy = np.interp(s + 2, s, xy[:, 0]), np.interp(s + 2, s, xy[:, 1])
        a1 = np.arctan2(xy[:, 1] - py, xy[:, 0] - px)
        a2 = np.arctan2(qy - xy[:, 1], qx - xy[:, 0])
        turn = np.degrees(np.abs((a2 - a1 + np.pi) % (2 * np.pi) - np.pi))
        # Stretches: points on the wall with the same high side, gaps under TOP_GAP.
        pieces, cur = [], []
        for k in np.flatnonzero(on):
            if cur and (high[k] != high[cur[-1]] or s[k] - s[cur[-1]] > TOP_GAP):
                pieces.append(cur)
                cur = []
            cur.append(k)
        if cur:
            pieces.append(cur)
        for piece in pieces:
            idx = np.array(piece)
            sp = s[idx]
            if len(idx) < 4 or sp[-1] - sp[0] < TOP_SEG:
                continue
            side = high[idx[0]]
            z = (hl if side == 0 else hr)[idx]
            low = (hr if side == 0 else hl)[idx]
            z0 = z
            sp = s[idx]
            crowned = False
            if crown_at is not None:
                cz = crown(xy[idx], _normals(xy, idx, side), crown_at)
                with np.errstate(invalid="ignore"):
                    ok = np.isfinite(cz) & (cz > low + STEP_MIN)
                # (A wall has a crown along most of it or it isn't one: between the points
                # where one was seen, the crown runs on straight.)
                crowned = ok.mean() >= CROWN_SHARE
                if crowned:
                    # (Both ways: a top read short of it was read on the wall's face.)
                    z = np.interp(sp, sp[ok], cz[ok])
            # (Over and above the straight line through the heights round each point: a
            # bank's top rising along the line would lift a plain percentile.)
            env = np.empty(len(sp))
            for k, v in enumerate(sp):
                w = np.abs(sp - v) <= TOP_REACH
                u, zz = sp[w] - v, z[w]
                b = np.polyfit(u, zz, 1) if len(u) >= 3 and np.ptp(u) > 1 else (0.0, float(np.mean(zz)))
                env[k] = b[1] + np.percentile(zz - (b[0] * u + b[1]), TOP_PCT)
            # Corners inside the piece, at least half a piece from its ends and each other.
            breaks = [0, len(idx) - 1]
            for k in sorted(range(1, len(idx) - 1), key=lambda k: -turn[idx[k]]):
                if turn[idx[k]] < TOP_CORNER:
                    break
                if all(abs(sp[k] - sp[b]) >= TOP_SEG / 2 for b in breaks):
                    breaks.append(k)
            breaks.sort()
            # Douglas–Peucker on (along, height), no piece under TOP_SEG.
            todo = list(zip(breaks[:-1], breaks[1:]))
            while todo:
                a, b = todo.pop()
                if b - a < 2:
                    continue
                f = (sp[a + 1:b] - sp[a]) / max(sp[b] - sp[a], 1e-9)
                dev = np.abs(env[a + 1:b] - (env[a] + f * (env[b] - env[a])))
                ok = (sp[a + 1:b] - sp[a] >= TOP_SEG) & (sp[b] - sp[a + 1:b] >= TOP_SEG)
                if not ok.any():
                    continue
                dev = np.where(ok, dev, -1)
                k = int(np.argmax(dev))
                if dev[k] > TOP_TOL:
                    breaks.append(a + 1 + k)
                    todo += [(a, a + 1 + k), (a + 1 + k, b)]
            breaks.sort()
            fit = np.interp(sp, sp[breaks], env[breaks])
            # (A piece steeper than TOP_GRADE is a bank's slope, not a wall's top: as it was.)
            spans = list(zip(breaks[:-1], breaks[1:]))
            steep = [abs(env[b] - env[a]) > TOP_GRADE * max(sp[b] - sp[a], 1e-9) for a, b in spans]
            for m, (a, b) in enumerate(spans):
                if steep[m]:
                    # (The heights as read: the crown, a profile at each point, scatters
                    # by half a metre where it isn't straightened. But not under both of
                    # its ends: going down from a bridge head to the quay at nábřeží
                    # Kapitána Jaroše, the reading slipped to the wall's foot and the top
                    # dipped 4 m toward the water. An end's height is the straight top
                    # it joins, the middle of its first TOP_SEG metres as read; where it
                    # joins none, as read there. Not the envelope: where a wall runs out
                    # down a slope or meets a bridge's abutment, the envelope's end is
                    # metres over it, and the last metres of a wall at Malá Strana stood
                    # flat over a 6 m cliff.)
                    ends = []
                    for end, n in ((a, m - 1), (b, m + 1)):
                        if 0 <= n < len(spans) and not steep[n]:
                            near = np.arange(*spans[n]) if n > m else np.arange(spans[n][0] + 1, spans[n][1] + 1)
                            near = near[(np.abs(sp[near] - sp[end]) <= TOP_SEG) & (near != end)]
                            ends.append(float(np.median(z[near])) if len(near) else z0[end])
                        else:
                            ends.append(z0[end])
                    fit[a:b + 1] = np.maximum(z0[a:b + 1], min(ends) - TOP_TOL)
            new = np.clip(fit, np.minimum(z, z0) - TOP_LOWER, np.maximum(z, z0) + TOP_RAISE)
            new = np.maximum(new, low + STEP_MIN)
            walls += 1
            moved = np.abs(new - z0) > 0.05
            changed += float(np.sum(np.diff(sp)[moved[1:]])) if len(sp) > 1 else 0.0
            for k, v in zip(idx, new):
                key, n, q, fwd = refs[k]
                p = lines_by_tile[key][n]["pts"][q]
                # (The top's side in the line as stored: left is index 2.)
                slot = 2 + (side if fwd else 1 - side)
                p[slot] = round(float(v), 2)
                if lattice is not None:
                    d = xy[min(k + 1, len(xy) - 1)] - xy[max(k - 1, 0)]
                    d = d / (np.linalg.norm(d) or 1)
                    nrm = np.array([-d[1], d[0]]) * (1 if side == 0 else -1)
                    line = lines_by_tile[key][n]
                    label = line["l"] if (slot == 2) else line["r"]
                    behind.setdefault(key, []).append((xy[k][0], xy[k][1], float(v), nrm[0], nrm[1], int(label), float(crowned)))
    if lattice is not None and behind:
        tiles, labels, N, T, step, gx0, gy0 = lattice
        for key, got in behind.items():
            arr, lab = tiles.get(key), labels.get(key)
            if arr is None or lab is None:
                continue
            g = np.array(got)
            qq, pp = np.mgrid[0:N + 1, 0:N + 1]
            cx, cy = gx0 + key[0] * T + pp * step, gy0 + key[1] * T + qq * step
            for label in np.unique(g[:, 5]).astype(int):
                mine = g[g[:, 5] == label]
                cand = np.flatnonzero(lab.ravel() == label)
                if not len(cand):
                    continue
                X, Y = cx.ravel()[cand], cy.ravel()[cand]
                dx, dy = X[:, None] - mine[None, :, 0], Y[:, None] - mine[None, :, 1]
                dist = np.hypot(dx, dy)
                near = np.argmin(dist, axis=1)
                r = np.arange(len(cand))
                ahead = dx[r, near] * mine[near, 3] + dy[r, near] * mine[near, 4]
                top = mine[near, 2]
                h = arr.ravel()[cand]
                # (Behind a wall with a crown, the bank as the scan has it, not under the top.)
                crowned = mine[near, 6] > 0
                if crowned.any():
                    seen = np.asarray(crown_at(X, Y), dtype=float)
                    bank = np.where(crowned & np.isfinite(seen), np.maximum(top, seen), top)
                    top = np.where(crowned, np.minimum(bank, np.maximum(h, top)), top)
                lift = (dist[r, near] <= FILL_REACH) & (ahead > 0) & (np.abs(top - h) > 0.05) & (top - h <= FILL_MAX) & ((h < top) | crowned)
                if driven is not None and lift.any():
                    k = np.flatnonzero(lift)
                    for ox in (-step, 0.0, step):
                        for oy in (-step, 0.0, step):
                            lift[k[driven(X[k] + ox, Y[k] + oy)]] = False
                if lift.any():
                    arr[qq.ravel()[cand[lift]], pp.ravel()[cand[lift]]] = top[lift]
                    raised += int(lift.sum())
    return walls, changed, raised


def crossing(streets, decks=()):
    """for_tile's `driven`: whether points are on a car street's carriageway on the ground.
    `streets`: (centre line, half width) pairs; `decks`: the map's bridges' outlines. Not
    under a deck: the carriageway is drawn up to where its bridge starts, and where the
    wall under the bridge's end runs at a slant to the street, the carriageway's corner
    reached over it. The wall lost its heights there and the lattice's 4 m ramp showed as
    a tear in front of the bridge (5. května over Hvězdova)."""
    tree = shapely.STRtree([line.buffer(half, cap_style="flat") for line, half in streets])
    over = shapely.STRtree(list(decks)) if len(decks) else None

    def driven(xs, ys):
        pts = shapely.points(xs, ys)
        on = np.zeros(len(xs), dtype=bool)
        on[tree.query(pts, predicate="within")[0]] = True
        if over is not None and on.any():
            k = np.flatnonzero(on)
            on[k[over.query(pts[k], predicate="within")[0]]] = False
        return on
    return driven


def lattice_reader(tiles, labels, N, T, step, gx0, gy0, ids=None):
    """The ground's height at points from the lattice, on one side of the steps: the
    cell's corners with that label, else that label's points a cell further out (the
    nearer the more), else NaN. `tiles`, `labels`: per tile (i, j), its (N + 1)² heights
    and labels (no labels: all plain ground). `away`, if given, is per point a point on
    the step's line and the normal pointing to the point's side: only corners on that
    side count. The plain ground on a wall's low side has the same label as the street
    behind the terrace's strip on its top, and where the line passed a few centimetres
    from one of the street's points, the foot took a share of the street's height: 5.
    května's carriageway before its bridge over Hvězdova came down to the wall's foot
    over 4 m, torn, instead of stepping down at the wall.
    `ids`: per tile, its terraces' labels as numbers the same in every tile (dtm_heights);
    `read.home`: the tile whose labels `label` is in. A tile numbers its terraces from 2,
    so past its edge another terrace had the label, and a wall's top strip read the
    neighbouring tile's foot there (a 7 m hole at Československého exilu)."""
    ids = ids or {}
    common = {key: (np.vectorize(lambda v, m=ids[key]: m.get(int(v), int(v)), otypes=[np.int64])(lab) if key in ids else lab.astype(np.int64))
              for key, lab in labels.items()}

    def read(xs, ys, label, away=None):
        if read.home is not None:
            label = ids.get(read.home, {}).get(int(label), label)
        out = np.full(len(xs), np.nan)
        i = np.floor((xs - gx0) / T).astype(int)
        j = np.floor((ys - gy0) / T).astype(int)
        for key in set(zip(i.tolist(), j.tolist())):
            arr = tiles.get(key)
            if arr is None:
                continue
            lab = common.get(key)
            own = (lab == label) if lab is not None else np.full(arr.shape, label == 0)
            sel = (i == key[0]) & (j == key[1])
            if away is not None:
                px, py, nx, ny = (np.asarray(c, dtype=float)[sel] for c in away)

                def beyond(qq, pp, k=slice(None)):
                    # (Whether lattice corners (column pp, row qq) lie on points k's side.)
                    cx, cy = gx0 + key[0] * T + pp * step, gy0 + key[1] * T + qq * step
                    return (cx - px[k]) * nx[k] + (cy - py[k]) * ny[k] > MARGIN
            u = np.clip((xs[sel] - gx0 - key[0] * T) / step, 0, N - 0.001)
            v = np.clip((ys[sel] - gy0 - key[1] * T) / step, 0, N - 0.001)
            a, b = np.floor(u).astype(int), np.floor(v).astype(int)
            fu, fv = u - a, v - b
            total, acc = np.zeros(len(u)), np.zeros(len(u))
            for da, db, w in ((0, 0, (1 - fu) * (1 - fv)), (1, 0, fu * (1 - fv)), (0, 1, (1 - fu) * fv), (1, 1, fu * fv)):
                m = own[b + db, a + da]
                if away is not None:
                    m = m & beyond(b + db, a + da)
                total += np.where(m, w, 0.0)
                acc += np.where(m, w * arr[b + db, a + da], 0.0)
            res = np.full(len(u), np.nan)
            hit = total > 1e-4
            res[hit] = acc[hit] / total[hit]
            # None of the cell's corners: that label's points a cell further out.
            far = np.nonzero(~hit)[0]
            if len(far):
                t2, a2 = total[far].copy(), acc[far].copy()
                for dq in range(-1, 3):
                    for dp in range(-1, 3):
                        q, p = b[far] + dq, a[far] + dp
                        m = (q >= 0) & (q <= N) & (p >= 0) & (p <= N)
                        qc, pc = np.clip(q, 0, N), np.clip(p, 0, N)
                        m &= own[qc, pc]
                        if away is not None:
                            m &= beyond(qc, pc, far)
                        w = 1 / ((pc - u[far]) ** 2 + (qc - v[far]) ** 2 + 0.01)
                        t2 += np.where(m, w, 0.0)
                        a2 += np.where(m, w * arr[qc, pc], 0.0)
                got = t2 != 0
                res[far[got]] = a2[got] / t2[got]
            out[sel] = res
        return out
    read.sided = True
    read.home = None
    return read


def scan_reader(own, scan_at, decks=()):
    """The ground's height at points from IPR's 2023 LiDAR (`scan_at(xs, ys)`, the bare
    earth every metre), else from the lattice's own side (`own`, lattice_reader): for the
    water, for a flat terrace (heights() asks `.lattice` for those), under a bridge's
    deck (`decks`, polygons: the scan there is the ground under it) and where the scan
    has nothing. On the 4 m lattice a wall is a ramp across a cell, and a point of the
    lattice next to the wall's line may have its foot's height on its top's side: read
    from the lattice, the top dipped to the street over metres (Československého exilu,
    7 m). The scan has the ground a metre or two from the wall as it is."""
    tree = shapely.STRtree(list(decks)) if len(decks) else None

    def read(xs, ys, label, away=None):
        xs, ys = np.asarray(xs, dtype=float), np.asarray(ys, dtype=float)
        out = own(xs, ys, label, away)
        if label == WATER or not len(xs):
            return out
        z = np.asarray(scan_at(xs, ys), dtype=float)
        use = np.isfinite(z)
        if tree is not None and use.any():
            under = np.zeros(len(xs), dtype=bool)
            under[np.unique(tree.query(shapely.points(xs, ys), predicate="intersects")[0])] = True
            use &= ~under
        out[use] = z[use]
        return out
    read.sided = True
    read.lattice = own
    return read


def _running_median(s, h, reach):
    """Per point, the median of the finite heights within `reach` along the line (s, the
    distance along it); NaN where there are none."""
    out = np.full(len(h), np.nan)
    ok = np.isfinite(h)
    if not ok.any():
        return out
    for k in range(len(h)):
        near = ok & (np.abs(s - s[k]) <= reach)
        if near.any():
            out[k] = np.median(h[near])
    return out


def walk_reader(own, scan_at, decks=()):
    """The lattice's own side (`own`, lattice_reader), and a walk for each side of a wall
    (heights() asks `.walk`): IPR's bare-earth scan leaves the walls out and bridges the
    gap with a slope, 3–6 m wide where the wall is high (Československého exilu: 254 to
    262 m over 6 m, the line at its foot). A side read at a fixed distance lands on that
    slope, and the top sagged by metres. The walk goes out along the normal and takes the
    first height past which the ground rises or falls less than FLAT a metre over the
    next metre: the top's edge on the high side, the foot's on the low side. Not under a
    bridge's deck (`decks`), not across another label (`keep`), and none where the
    ground doesn't flatten within WALK: then the lattice's reading stands."""
    tree = shapely.STRtree(list(decks)) if len(decks) else None

    def walk(pts, normal, keep):
        n = len(pts)
        xs = pts[:, 0, None] + normal[:, 0, None] * WALK
        ys = pts[:, 1, None] + normal[:, 1, None] * WALK
        z = np.asarray(scan_at(xs.ravel(), ys.ravel()), dtype=float)
        ok = np.isfinite(z) & keep(xs.ravel(), ys.ravel())
        if tree is not None and ok.any():
            k = np.flatnonzero(ok)
            under = tree.query(shapely.points(xs.ravel()[k], ys.ravel()[k]), predicate="intersects")[0]
            ok[k[np.unique(under)]] = False
        z, ok = z.reshape(n, -1), ok.reshape(n, -1)
        # (A side's own stretch: up to the first point that isn't on it. The line's own
        # point is on neither side's outline: it doesn't count.)
        ok[:, 0] = True
        ok = np.cumprod(ok, axis=1).astype(bool)
        dz = WALK[1] - WALK[0]
        span = int(round(1.0 / dz))  # samples in a metre
        out = np.full(n, np.nan)
        for i in range(n):
            for k in range(1, len(WALK) - span):  # (not the line itself: a wall's middle)
                if not ok[i, k + span]:
                    break
                if abs(z[i, k + span] - z[i, k]) < FLAT and all(abs(z[i, k + q + 1] - z[i, k + q]) < FLAT * dz * 1.5 for q in range(span)):
                    out[i] = z[i, k]
                    break
        return out

    def span(pts, normal):
        # (The scan's highest less its lowest across the line, SPAN either way.)
        offs = np.arange(-SPAN, SPAN + 0.01, 0.5)
        xs = pts[:, 0, None] + normal[:, 0, None] * offs
        ys = pts[:, 1, None] + normal[:, 1, None] * offs
        z = np.asarray(scan_at(xs.ravel(), ys.ravel()), dtype=float).reshape(xs.shape)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # (no scan there: NaN, no cap)
            return np.nanmax(z, axis=1) - np.nanmin(z, axis=1)

    def read(xs, ys, label, away=None):
        return own(xs, ys, label, away)
    read.sided = True
    read.lattice = own
    read.walk = walk
    read.span = span
    return read
