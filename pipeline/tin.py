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
            kept = thin(run, tol)
            ids = [P.add(run[i, 0], run[i, 1], {int(run[i, 4]): run[i, 2], int(run[i, 5]): run[i, 3]}, 1) for i in kept]
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
