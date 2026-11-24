"""A triangulated ground (TIN) for each tile: stage 1 of docs/terrain-tin-plan.md.

Stage 1 builds the TIN from today's heights exactly as the game draws them, read out of
the game's own sampler by scripts/tin-target.mjs, and measures what it costs: vertices,
triangles and bytes per tile. Nothing in the game reads these files yet.

Per tile:
- The steps (the outlines of the water and the terraces, where the label changes) become
  breaklines: their points thinned until each side's height and the outline's shape are
  within the tolerance, every vertex with a height for each side.
- The tile's edges get vertices the same way, so a tile meets its neighbours.
- The rest is greedy insertion: Delaunay over the points so far, and in every triangle
  the sample furthest off goes in, until all are within the tolerance. Breakline
  segments that the Delaunay misses are split until they're edges (a conforming
  Delaunay; scipy has no constrained one).
- Each triangle gets the label of its side, found by flooding from the breaklines
  without crossing them.

    uv run tin.py [area, ujezd] [--tol 0.02] [--tiles i_j,…] [--out .cache/tin/<area>]
"""
from __future__ import annotations

import argparse
import gzip
import json
import time
from collections import deque
from pathlib import Path

import numpy as np
from scipy.spatial import Delaunay, cKDTree

HERE = Path(__file__).resolve().parent
NEAR_LINE = 0.35  # m: grid samples this close to a step are on it, not on either side
SNAP = 0.01  # m: points closer than this are one
DUP = 0.1  # m: a step this close all along to one already taken is the same wall
MAX_SPLITS = 40  # rounds of splitting a step segment the triangulation misses at its midpoint
END_JUMP, END_REACH = 2.0, 1.5  # m: a side of a step jumping this much this near its end is the lattice's mistake (build)


def load(target: Path, k: str):
    meta = json.loads((target / f"{k}.json").read_text())
    nx, ny = meta["nx"], meta["ny"]
    raw = (target / f"{k}.grid.bin").read_bytes()
    heights = np.frombuffer(raw, np.float32, nx * ny).reshape(ny, nx).astype(np.float64)
    sides = np.frombuffer(raw, np.uint8, nx * ny, offset=4 * nx * ny).reshape(ny, nx)
    paved = np.frombuffer(raw, np.uint8, nx * ny, offset=5 * nx * ny).reshape(ny, nx).astype(bool)
    lines = np.frombuffer((target / f"{k}.lines.bin").read_bytes(), np.float32).reshape(-1, 6).astype(np.float64)
    pieces, at = [], 0
    for m in meta["lengths"]:
        pieces.append(lines[at:at + m])
        at += m
    return meta, heights, sides, paved, pieces


def load_kerbs(target: Path, k: str) -> list[np.ndarray]:
    """The kerbs tin_tiles.py put beside the target: runs of (x, y, h, h, side, side)."""
    f = target / f"{k}.kerbs.bin"
    if not f.exists():
        return []
    lengths = json.loads((target / f"{k}.json").read_text()).get("kerbs", [])
    rows = np.frombuffer(f.read_bytes(), np.float32).reshape(-1, 6).astype(np.float64)
    out, at = [], 0
    for m in lengths:
        out.append(rows[at:at + m])
        at += m
    return out


def runs(piece: np.ndarray):
    """A piece of outline split where the labels on its two sides change; only where
    they differ (a step) is it kept."""
    out, start = [], 0
    ll, rl = piece[:, 4].astype(int), piece[:, 5].astype(int)
    for i in range(1, len(piece) + 1):
        if i == len(piece) or ll[i] != ll[start] or rl[i] != rl[start]:
            if ll[start] != rl[start] and i - start >= 1:
                # (The point where the labels change belongs to both runs.)
                end = min(i + 1, len(piece))
                if end - start >= 2:
                    out.append(piece[start:end])
            start = i
    return out


def thin(run: np.ndarray, tol: float) -> list[int]:
    """Douglas-Peucker on the outline's shape and both sides' heights."""
    keep = {0, len(run) - 1}
    stack = [(0, len(run) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = run[a + 1:b]
        t = np.linspace(0, 1, b - a + 1)[1:-1]
        p, q = run[a], run[b]
        d = q[:2] - p[:2]
        length = np.hypot(*d)
        side_off = np.abs((seg[:, 0] - p[0]) * d[1] - (seg[:, 1] - p[1]) * d[0]) / length if length > 1e-9 else np.hypot(seg[:, 0] - p[0], seg[:, 1] - p[1])
        hl = np.abs(seg[:, 2] - (p[2] + t * (q[2] - p[2])))
        hr = np.abs(seg[:, 3] - (p[3] + t * (q[3] - p[3])))
        err = np.maximum(side_off, np.maximum(hl, hr))
        worst = int(np.argmax(err))
        if err[worst] > tol:
            m = a + 1 + worst
            keep.add(m)
            stack += [(a, m), (m, b)]
    return sorted(keep)


def thin_profile(h: np.ndarray, tol: float) -> list[int]:
    keep = {0, len(h) - 1}
    stack = [(0, len(h) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        t = np.linspace(0, 1, b - a + 1)[1:-1]
        err = np.abs(h[a + 1:b] - (h[a] + t * (h[b] - h[a])))
        worst = int(np.argmax(err))
        if err[worst] > tol:
            m = a + 1 + worst
            keep.add(m)
            stack += [(a, m), (m, b)]
    return sorted(keep)


class Points:
    """The TIN's points so far, each with a height for each side it has."""

    def __init__(self):
        self.xy: list[tuple[float, float]] = []
        self.h: list[dict[int, float]] = []
        self.kind: list[int] = []  # 0 tile edge, 1 step, 2 inside
        self.index: dict[tuple[int, int], int] = {}

    def add(self, x: float, y: float, heights: dict[int, float], kind: int) -> int:
        key = (round(x / SNAP), round(y / SNAP))
        i = self.index.get(key)
        if i is None:
            i = self.index[key] = len(self.xy)
            self.xy.append((x, y))
            self.h.append(dict(heights))
            self.kind.append(kind)
        else:
            for s, v in heights.items():
                self.h[i].setdefault(s, v)
            self.kind[i] = min(self.kind[i], kind)
        return i


def build(target: Path, k: str, tol: float, loose: float | None = None):
    """`tol` on paved ground, the steps and the tile's edges; `loose` elsewhere."""
    meta, heights, sides, paved, pieces = load(target, k)
    x0, y0, x1, y1 = meta["box"]
    nx, ny, g = meta["nx"], meta["ny"], meta["grid"]
    gx = np.where(np.arange(nx) == nx - 1, x1, x0 + np.arange(nx) * g)
    gy = np.where(np.arange(ny) == ny - 1, y1, y0 + np.arange(ny) * g)
    P = Points()

    def side_at(x, y):
        """The target's side label at points (its nearest sample)."""
        i = np.clip(np.round((np.asarray(x) - x0) / g).astype(int), 0, nx - 1)
        j = np.clip(np.round((np.asarray(y) - y0) / g).astype(int), 0, ny - 1)
        return sides[j, i].astype(int)

    # The steps.
    steps = []  # [run, kept sample indices, vertex ids]
    # The same wall can come twice, once from each side's outline (labels swapped) with
    # its own samples; the two copies cross each other in a zigzag and can't both be edges.
    seen: dict[tuple[int, int], list[cKDTree]] = {}
    for piece in pieces:
        for run in runs(piece):
            lr = (int(run[0, 4]), int(run[0, 5]))
            twin = seen.get((lr[1], lr[0]), []) + seen.get(lr, [])
            if any(np.all(t.query(run[:, :2])[0] < DUP) for t in twin):
                continue
            seen.setdefault(lr, []).append(cKDTree(run[:, :2]))
            # (Every point with the run's two sides: its last is where the labels change,
            # and with its own labels a wall's last point had one side, the plain ground's.)
            run = run.copy()
            # Such a point has one side's height for both: at a corner where an outline
            # turns off (Divadelní's floor at the underpass's mouth), the street's floor
            # took the street's on top, a spike 4–5 m high. It takes the heights of the
            # nearest point that has the run's two sides.
            own = (run[:, 4] == lr[0]) & (run[:, 5] == lr[1])
            if own.any() and not own.all():
                good = np.flatnonzero(own)
                for i in np.flatnonzero(~own):
                    j = good[np.argmin(np.abs(good - i))]
                    run[i, 2], run[i, 3] = run[j, 2], run[j, 3]
            run[:, 4], run[:, 5] = lr
            # One side jumping by more than END_JUMP within END_REACH of a run's end: the
            # lattice's cell there has that side's corner on other ground (at Divadelní's
            # mouth the plaza's top beside its wall read the street's height under it, the
            # cell's only plain-ground corner). The end takes the height from past the jump.
            for c in (2, 3):
                for ends in (run, run[::-1]):
                    along = np.r_[0, np.cumsum(np.hypot(*np.diff(ends[:, :2], axis=0).T))]
                    jump = np.flatnonzero((np.abs(np.diff(ends[:, c])) > END_JUMP) & (along[1:] <= END_REACH))
                    if len(jump) and len(ends) > jump[-1] + 2:
                        ends[:jump[-1] + 1, c] = ends[jump[-1] + 1, c]
            kept = thin(run, tol)
            ids = [P.add(run[i, 0], run[i, 1], {lr[0]: run[i, 2], lr[1]: run[i, 3]}, 1) for i in kept]
            steps.append([run, kept, ids])
    # The kerbs: breaklines with one height (the same side either way).
    for run in load_kerbs(target, k):
        kept = thin(run, tol)
        ids = [P.add(run[i, 0], run[i, 1], {int(run[i, 4]): run[i, 2]}, 1) for i in kept]
        steps.append([run, kept, ids])
    line_xy = np.concatenate([r[:, :2] for r, _, _ in steps]) if steps else np.zeros((0, 2))

    # The tile's edges: the grid's outer rows and columns, thinned between the corners and
    # the steps that reach them.
    def edge(xs, ys, hs, ss):
        fixed = [0, len(xs) - 1]
        on = [P.index.get((round(x / SNAP), round(y / SNAP))) for x, y in zip(xs, ys)]
        if len(line_xy):
            d, _ = cKDTree(line_xy).query(np.c_[xs, ys])
            fixed += [int(i) for i in np.flatnonzero(d < g / 2)]
        fixed = sorted(set(fixed))
        for a, b in zip(fixed, fixed[1:]):
            for i in thin_profile(hs[a:b + 1], tol):
                P.add(xs[a + i], ys[a + i], {int(ss[a + i]): hs[a + i]}, 0)
        del on

    edge(gx, np.full(nx, y0), heights[0], sides[0])
    edge(gx, np.full(nx, y1), heights[-1], sides[-1])
    edge(np.full(ny, x0), gy, heights[:, 0], sides[:, 0])
    edge(np.full(ny, x1), gy, heights[:, -1], sides[:, -1])

    # The samples inside: not on the tile's edge, not on a step.
    J, I = np.mgrid[1:ny - 1, 1:nx - 1]
    sx, sy = gx[I.ravel()], gy[J.ravel()]
    sh, ss = heights[1:-1, 1:-1].ravel(), sides[1:-1, 1:-1].ravel().astype(int)
    st = np.where(paved[1:-1, 1:-1].ravel(), tol, tol if loose is None else loose)
    if len(line_xy):
        d, _ = cKDTree(line_xy).query(np.c_[sx, sy])
        free = d >= NEAR_LINE
    else:
        free = np.ones(len(sx), bool)
    fx, fy, fh, fs, ft = sx[free], sy[free], sh[free], ss[free], st[free]
    near = ~free

    rounds = splits = 0
    while True:
        rounds += 1
        xy = np.asarray(P.xy)
        tri = Delaunay(xy)
        # Conforming: split the step segments the triangulation doesn't have.
        edges = set()
        simp = tri.simplices
        for a, b in ((0, 1), (1, 2), (2, 0)):
            lo, hi = np.minimum(simp[:, a], simp[:, b]), np.maximum(simp[:, a], simp[:, b])
            edges.update(zip(lo.tolist(), hi.tolist()))
        missing = 0
        for st in steps:
            run, kept, ids = st
            nk, nids = [kept[0]], [ids[0]]
            for (ka, ia), (kb, ib) in zip(zip(kept, ids), zip(kept[1:], ids[1:])):
                if ia != ib and (min(ia, ib), max(ia, ib)) not in edges:
                    if kb - ka > 1:
                        m = (ka + kb) // 2
                        nk.append(m)
                        nids.append(P.add(run[m, 0], run[m, 1], {int(run[m, 4]): run[m, 2], int(run[m, 5]): run[m, 3]}, 1))
                        missing += 1
                    elif splits < MAX_SPLITS:
                        # (No sample left between: the midpoint, its heights halfway.)
                        (xa, ya), (xb, yb) = P.xy[ia], P.xy[ib]
                        ha, hb = P.h[ia], P.h[ib]
                        hm = {s_: (ha[s_] + hb[s_]) / 2 if s_ in hb else ha[s_] for s_ in ha}
                        hm.update({s_: v for s_, v in hb.items() if s_ not in hm})
                        mid = P.add((xa + xb) / 2, (ya + yb) / 2, hm, 1)
                        if mid not in (ia, ib):
                            nk.append(ka)
                            nids.append(mid)
                            missing += 1
                nk.append(kb)
                nids.append(ib)
            st[1], st[2] = nk, nids
        if missing:
            splits += 1
            continue
        labels = label_triangles(tri, P, steps, side_at)
        err, where, wrong = errors(tri, P, labels, fx, fy, fh, fs)
        over = err - ft
        bad = np.flatnonzero(over > 0)
        if not len(bad):
            break
        order = bad[np.argsort(-over[bad])]
        _, first = np.unique(where[order], return_index=True)
        for i in order[first]:
            P.add(fx[i], fy[i], {int(fs[i]): fh[i]}, 2)

    # How close the samples by the steps come (they aren't inserted).
    near_err, _, near_wrong = errors(tri, P, labels, sx[near], sy[near], sh[near], ss[near])
    return dict(meta=meta, tri=tri, P=P, labels=labels, steps=steps, rounds=rounds,
                err=float(err.max()) if len(err) else 0.0, err_paved=float(err[ft == tol].max()) if np.any(ft == tol) else 0.0,
                paved=float(paved.mean()), wrong=int(wrong),
                near=int(near.sum()), near_err=near_err, near_wrong=int(near_wrong))


def label_triangles(tri: Delaunay, P: Points, steps, side_at=None) -> np.ndarray:
    """Each triangle's side: from the steps' segments it touches, then flooded across the
    edges that aren't steps; failing those, from a vertex with only one side."""
    simp, nb = tri.simplices, tri.neighbors
    xy = np.asarray(P.xy)
    seg = {}
    for run, kept, ids in steps:
        for (ka, ia), (kb, ib) in zip(zip(kept, ids), zip(kept[1:], ids[1:])):
            seg[(ia, ib)] = (int(run[ka, 4]), int(run[ka, 5]))
    labels = np.full(len(simp), -1)
    q = deque()
    blocked = set()
    for t, (a, b, c) in enumerate(simp):
        for u, v, w in ((a, b, c), (b, c, a), (c, a, b)):
            for p, r, flip in ((u, v, False), (v, u, True)):
                s = seg.get((p, r))
                if s is None:
                    continue
                blocked.add((min(u, v), max(u, v)))
                d = xy[r] - xy[p]
                e = xy[w] - xy[p]
                left = d[0] * e[1] - d[1] * e[0] > 0
                if labels[t] < 0:
                    labels[t] = s[0] if left else s[1]
                    q.append(t)
    if side_at is not None:
        # (No triangle crosses a step, so the side at its middle is its side; the flood
        # below leaked through gaps in the outlines and put water on the land's side.)
        free = labels < 0
        mid = xy[simp[free]].mean(axis=1)
        labels[free] = side_at(mid[:, 0], mid[:, 1])
        return labels
    for t, vs in enumerate(simp):
        if labels[t] >= 0:
            continue
        for v in vs:
            if P.kind[v] != 1 and len(P.h[v]) == 1:
                labels[t] = next(iter(P.h[v]))
                q.append(t)
                break
    while q:
        t = q.popleft()
        for kk in range(3):
            o = nb[t, kk]
            if o < 0 or labels[o] >= 0:
                continue
            u, v = [simp[t, m] for m in range(3) if m != kk]
            if (min(u, v), max(u, v)) in blocked:
                continue
            labels[o] = labels[t]
            q.append(o)
    labels[labels < 0] = 0
    return labels


def corner_heights(tri: Delaunay, P: Points, labels: np.ndarray) -> np.ndarray:
    simp = tri.simplices
    out = np.empty(simp.shape)
    for t in range(len(simp)):
        s = labels[t]
        for m in range(3):
            hv = P.h[simp[t, m]]
            out[t, m] = hv.get(s, next(iter(hv.values())))
    return out


def errors(tri: Delaunay, P: Points, labels, x, y, h, s):
    pts = np.c_[x, y]
    where = tri.find_simplex(pts)
    ok = where >= 0
    T = tri.transform[where]
    b = np.einsum("ijk,ik->ij", T[:, :2], pts - T[:, 2])
    bary = np.c_[b, 1 - b.sum(1)]
    H = corner_heights(tri, P, labels)[where]
    err = np.abs((bary * H).sum(1) - h)
    err[~ok] = np.inf
    wrong = np.count_nonzero(labels[where] != s)
    return err, where, wrong


def encode(res) -> dict[str, int]:
    """The tile's file as the plan has it: vertices once per side they're used with, x and
    y as uint16 across the tile, heights in cm above the tile's lowest, triangles as
    differences of vertex indices, a label per triangle, the steps as vertex pairs."""
    tri, P, labels = res["tri"], res["P"], res["labels"]
    x0, y0, x1, y1 = res["meta"]["box"]
    simp = tri.simplices
    ids, verts = {}, []
    tris = np.empty_like(simp)
    for t in range(len(simp)):
        s = int(labels[t])
        for m in range(3):
            v = int(simp[t, m])
            hv = P.h[v]
            key = (v, s if s in hv else next(iter(hv)))
            if key not in ids:
                ids[key] = len(verts)
                verts.append((P.xy[v][0], P.xy[v][1], hv[key[1]]))
            tris[t, m] = ids[key]
    V = np.asarray(verts)
    qx = np.round((V[:, 0] - x0) / (x1 - x0) * 65535).astype(np.uint16)
    qy = np.round((V[:, 1] - y0) / (y1 - y0) * 65535).astype(np.uint16)
    lo = V[:, 2].min()
    qh = np.round((V[:, 2] - lo) * 100).astype(np.uint16)
    flat = tris.ravel().astype(np.int64)
    delta = np.diff(np.r_[0, flat])
    zig = ((delta << 1) ^ (delta >> 63)).astype(np.uint32)
    idx = zig.astype(np.uint16) if zig.max() < 65536 else zig
    pairs = []
    for run, kept, vids in res["steps"]:
        for ia, ib in zip(vids, vids[1:]):
            pairs.append((ia, ib))
    body = b"".join([np.diff(np.r_[0, qx.astype(np.int32)]).astype(np.int16).tobytes(),
                     np.diff(np.r_[0, qy.astype(np.int32)]).astype(np.int16).tobytes(),
                     qh.tobytes(), idx.tobytes(), labels.astype(np.uint8).tobytes(),
                     np.asarray(pairs, np.uint16).tobytes()])
    # Points only: the game triangulates them itself (the steps' segments are Delaunay
    # edges already, the conforming split put in the points that make them so), and
    # floods the labels from the steps. A vertex once, with a second height where it is
    # on a step; the steps as runs of vertex indices.
    order = np.lexsort((np.asarray(P.xy)[:, 0], np.asarray(P.xy)[:, 1]))
    rank = np.empty(len(order), np.int64)
    rank[order] = np.arange(len(order))
    XY = np.asarray(P.xy)[order]
    px = np.round((XY[:, 0] - x0) * 100).astype(np.int64)
    py = np.round((XY[:, 1] - y0) * 100).astype(np.int64)
    lo2 = min(min(h.values()) for h in P.h)
    first = np.array([round((next(iter(P.h[v].values())) - lo2) * 100) for v in order], np.int64)
    second = [round((list(P.h[v].values())[1] - lo2) * 100) if len(P.h[v]) > 1 else -1 for v in order]
    second = np.array([v for v in second if v >= 0], np.uint16)
    runs_ix = np.concatenate([np.r_[len(vids), rank[np.asarray(vids)]] for run, kept, vids in res["steps"]]) if res["steps"] else np.zeros(0, np.int64)
    pts = b"".join([np.diff(np.r_[0, py]).astype(np.int32).tobytes(), np.diff(np.r_[0, px]).astype(np.int32).tobytes(),
                    first.astype(np.uint16).tobytes(), second.tobytes(), runs_ix.astype(np.uint16).tobytes()])
    return dict(vertices=len(V), points=len(P.xy), triangles=len(simp), steps=len(pairs), raw=len(body),
                gz=len(gzip.compress(body, 9)), gz_points=len(gzip.compress(pts, 9)), body=body)


FORMAT = 1


def write(res) -> bytes:
    """A tile's mesh file (tiles/<k>.tin.bin.gz once gzipped), little-endian. The game
    builds the triangles itself (src/tin.ts): the fit's breakline segments are Delaunay
    edges already, its conforming split put in the points that make them so.

    Header (44 bytes): b"TIN1", u16 FORMAT, u16 flags (1: point ids are u32), f32 x0 y0 x1
    y1 (the tile's box in the map's metres), f32 base (the lowest height, m a.s.l.), u32
    points, u32 extra heights, u32 breaklines, u32 point ids in the breaklines.
    Then, the points sorted by y and x: u16 x across the box (0 its west edge, 65535 its
    east), u16 y the same but as the difference from the point before; u16 the first
    height in cm above base; u8 its side (0 plain ground, 1 water, 2 and up the tile's
    terraces); u8 how many more sides the point has (on a wall: the other side's height).
    Then those extra heights, u16 cm above base each, and their sides, u8 each.
    Then the breaklines: u16 points in each, u8 its left side and u8 its right (the same
    for a kerb), and the point ids, one line after another (u16, or u32 with flag 1)."""
    P = res["P"]
    x0, y0, x1, y1 = res["meta"]["box"]
    xy = np.asarray(P.xy)
    qx = np.clip(np.round((xy[:, 0] - x0) / (x1 - x0) * 65535), 0, 65535).astype(np.int64)
    qy = np.clip(np.round((xy[:, 1] - y0) / (y1 - y0) * 65535), 0, 65535).astype(np.int64)
    order = np.lexsort((qx, qy))
    rank = np.empty(len(order), np.int64)
    rank[order] = np.arange(len(order))
    base = min(min(h.values()) for h in P.h)
    hs = [sorted(P.h[v].items()) for v in order]
    first_h = np.array([round((x[0][1] - base) * 100) for x in hs], np.int64)
    first_s = np.array([x[0][0] for x in hs], np.int64)
    more = np.array([len(x) - 1 for x in hs], np.int64)
    extra = [(s_, round((v - base) * 100)) for x in hs for s_, v in x[1:]]
    if first_h.max(initial=0) > 65535 or max((e for _, e in extra), default=0) > 65535:
        raise ValueError("heights span more than 655 m")
    if max(first_s.max(initial=0), max((s_ for s_, _ in extra), default=0)) > 255:
        raise ValueError("more than 256 sides")
    lines = []
    for run, kept, ids in res["steps"]:
        seq = [int(rank[v]) for i, v in enumerate(ids) if i == 0 or v != ids[i - 1]]
        if len(seq) >= 2:
            lines.append((int(run[0, 4]), int(run[0, 5]), seq))
    wide = len(order) > 65535
    idt = np.uint32 if wide else np.uint16
    nid = sum(len(q) for _, _, q in lines)
    head = b"TIN1" + np.array([FORMAT, 1 if wide else 0], np.uint16).tobytes() + \
        np.array([x0, y0, x1, y1, base], np.float32).tobytes() + \
        np.array([len(order), len(extra), len(lines), nid], np.uint32).tobytes()
    body = [qx[order].astype(np.uint16).tobytes(), np.diff(np.r_[0, qy[order]]).astype(np.uint16).tobytes(),
            first_h.astype(np.uint16).tobytes(), first_s.astype(np.uint8).tobytes(), more.astype(np.uint8).tobytes(),
            np.array([e for _, e in extra], np.uint16).tobytes(), np.array([s_ for s_, _ in extra], np.uint8).tobytes(),
            np.array([len(q) for _, _, q in lines], np.uint16).tobytes(),
            np.array([[l, r] for l, r, _ in lines], np.uint8).reshape(-1).tobytes(),
            np.array([v for _, _, q in lines for v in q], idt).tobytes()]
    return head + b"".join(body)


def game_labels(tri: Delaunay, P: Points, steps) -> np.ndarray:
    """Each triangle's side as the game finds it (src/tin.ts), without the side lattice:
    a triangle with a breakline for an edge is on the side of it it lies on (of two such
    edges, the side all its corners have wins); else the side of a corner with one side;
    the rest (all its corners on breaklines, as across a narrow arm of water) from its
    neighbours, flooding across the edges that aren't breaklines; failing that, the side
    its corners share."""
    xy = np.asarray(P.xy)
    simp, nb = tri.simplices, tri.neighbors
    seg = {}
    for run, kept, ids in steps:
        for ia, ib in zip(ids, ids[1:]):
            if ia != ib:
                seg[(ia, ib)] = (int(run[0, 4]), int(run[0, 5]))
                seg[(ib, ia)] = (int(run[0, 5]), int(run[0, 4]))
    out = np.full(len(simp), -1)
    for t, vs in enumerate(simp):
        got = None
        for u, v, w in ((vs[0], vs[1], vs[2]), (vs[1], vs[2], vs[0]), (vs[2], vs[0], vs[1])):
            s_ = seg.get((u, v))
            if s_ is None:
                continue
            d, e = xy[v] - xy[u], xy[w] - xy[u]
            side = s_[0] if d[0] * e[1] - d[1] * e[0] > 0 else s_[1]
            if got is None:
                got = side
            if all(side in P.h[x] for x in vs):
                got = side
                break
        if got is None:
            got = next((next(iter(P.h[v])) for v in vs if len(P.h[v]) == 1), None)
        if got is not None:
            out[t] = got
    q = deque(np.flatnonzero(out >= 0).tolist())
    while q:
        t = q.popleft()
        for m in range(3):
            o = nb[t, m]
            if o < 0 or out[o] >= 0:
                continue
            u, v = [simp[t, x] for x in range(3) if x != m]
            if (u, v) in seg:
                continue
            out[o] = out[t]
            q.append(o)
    for t in np.flatnonzero(out < 0):
        common = set(P.h[simp[t, 0]]) & set(P.h[simp[t, 1]]) & set(P.h[simp[t, 2]])
        out[t] = min(common) if common else 0
    return out


def label_check(res) -> tuple[int, float]:
    """Triangles the game's rule (game_labels) puts on another side than the fit did, and
    their area in m² (the flat ones along the tile's edge, which Delaunator doesn't make,
    left out)."""
    tri, P, labels = res["tri"], res["P"], res["labels"]
    got = game_labels(tri, P, res["steps"])
    xy = np.asarray(P.xy)[tri.simplices]
    d1, d2 = xy[:, 1] - xy[:, 0], xy[:, 2] - xy[:, 0]
    area = np.abs(d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / 2
    off = (got != labels) & (area > 1e-6)
    return int(off.sum()), float(area[off].sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("area", nargs="?", default="ujezd")
    ap.add_argument("--tol", type=float, default=0.02)
    ap.add_argument("--loose", type=float, help="the tolerance off paved ground (default: --tol)")
    ap.add_argument("--tiles")
    ap.add_argument("--out")
    ap.add_argument("--target", help="the folder tin-target.mjs wrote (default .cache/tin/target)")
    a = ap.parse_args()
    target = (Path(a.target) if a.target else HERE / ".cache/tin/target") / a.area
    out = Path(a.out) if a.out else HERE / ".cache/tin" / a.area
    out.mkdir(parents=True, exist_ok=True)
    keys = a.tiles.split(",") if a.tiles else sorted(p.stem for p in target.glob("*.json"))
    total, rows = dict(vertices=0, points=0, triangles=0, gz=0, gz_points=0, seconds=0.0), []
    for k in keys:
        t0 = time.time()
        res = build(target, k, a.tol, a.loose)
        enc = encode(res)
        sec = time.time() - t0
        (out / f"{k}.tin.bin.gz").write_bytes(gzip.compress(enc.pop("body"), 9))
        ne = res["near_err"]
        row = dict(k=k, **enc, rounds=res["rounds"], err=round(res["err"], 4), err_paved=round(res["err_paved"], 4),
                   paved=round(res["paved"], 2), wrong=res["wrong"],
                   near=res["near"], near_over=int((ne > a.tol).sum()), near_worst=round(float(ne.max()), 3) if len(ne) else 0,
                   near_wrong=res["near_wrong"], seconds=round(sec, 2))
        rows.append(row)
        for f in total:
            total[f] += row[f] if f != "seconds" else sec
        print(json.dumps(row))
    print(json.dumps(dict(area=a.area, tol=a.tol, loose=a.loose, tiles=len(keys), **{f: round(v, 1) for f, v in total.items()})))
    (out / "report.json").write_text(json.dumps(dict(tol=a.tol, loose=a.loose, rows=rows, total=total), indent=1))


if __name__ == "__main__":
    main()
