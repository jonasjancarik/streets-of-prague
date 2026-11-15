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
