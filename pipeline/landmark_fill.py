"""What a landmark's bake could not see, or should not have seen, made up from what it
did see. Used by landmark_bake.py inside Blender; only NumPy here, so that a change
can be tried on a bake's saved images without baking again (LANDMARK_DEBUG there), and
tested without Blender (test_landmark_fill.py).

All images are square, `size` texels a side, row 0 at the bottom as Blender has them:
`px` the colours, `face` the clean model's face under each texel (-1: none), `where`
the place on it in metres (z up), `normals` each face's normal.
"""
import numpy as np

BAND = 3.0   # m of a face next to a gap that is repeated into it
REACH = 1.0  # m to either side over which a gap's edge is evened out
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def push_pull(rgb: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Colours for every texel from the known ones around it: averaged down level by
    level, then back up, each unknown texel taking the finest level that knows."""
    levels = [(rgb * known[..., None], known.astype(np.float32))]
    while levels[-1][1].shape[0] > 1:
        r, w = levels[-1]
        n = r.shape[0] // 2
        levels.append((r.reshape(n, 2, n, 2, 3).sum((1, 3)), w.reshape(n, 2, n, 2).sum((1, 3))))
    fill = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)[..., None]
    for r, w in reversed(levels[:-1]):
        fill = np.repeat(np.repeat(fill, 2, 0), 2, 1)
        fill = np.where((w > 0)[..., None], r / np.maximum(w, 1e-6)[..., None], fill)
    return fill


def by_face(face: np.ndarray):
    """Each face's texels: (face, their indices in the flattened image)."""
    flat = face.ravel()
    order = np.argsort(flat, kind="stable")
    ids, starts = np.unique(flat[order], return_index=True)
    for f, a, b in zip(ids, starts, list(starts[1:]) + [len(order)]):
        if f >= 0:
            yield int(f), order[a:b]


def _from_above(valid: np.ndarray, gap: np.ndarray, band: int, reach: int) -> np.ndarray:
    """For a face laid out flat (row 0 lowest), the row each gap cell takes its colour
    from in its own column: the face just above the gap, repeated down into it there
    and back (so that it joins up at every turn). -1 where the column has nothing
    above. The gap's upper edge is taken as the highest within `reach` columns, so that
    neighbouring columns copy the same rows and the pattern is not sheared."""
    rows = np.arange(valid.shape[0])[:, None]
    far = valid.shape[0] * 4
    first = np.minimum.accumulate(np.where(valid, rows, far)[::-1], axis=0)[::-1]  # the first known row at or above
    edge = np.where(gap & (first < far), first, -1)
    even = edge.copy()
    for k in range(1, min(reach, valid.shape[1] - 1) + 1):
        even[:, k:] = np.maximum(even[:, k:], edge[:, :-k])
        even[:, :-k] = np.maximum(even[:, :-k], edge[:, k:])
    depth = even - rows - 1  # 0 just under the edge
    src = even + (band - np.abs(depth % (2 * band) - band))
    cols = np.broadcast_to(np.arange(valid.shape[1]), valid.shape)
    # Where that row is not known in this column either, the nearest known row above it.
    src = np.where(src < valid.shape[0], first[np.clip(src, 0, valid.shape[0] - 1), cols], far)
    return np.where(gap & (even >= 0) & (src < far), src, -1)


def copy_along(px, gap, known, face, where, normals, min_texels=30) -> np.ndarray:
    """Gaps in a face take the same face's colours from further up it (up a wall, up a
    roof's slope), or failing that from further down, or from the column beside them:
    sharp, and in step with whatever runs up the face (masonry, buttresses). For a
    wall's lowest metres hidden behind neighbouring houses.
    `known` are the texels with a colour to copy. Changes `px` in place; returns the
    texels it gave a colour."""
    size = face.shape[0]
    flat = px.reshape(-1, px.shape[-1])
    gapf, knownf = gap.ravel(), known.ravel() & ~gap.ravel()
    filled = np.zeros(size * size, bool)
    for f, idx in by_face(face):
        g = gapf[idx]
        if g.sum() < min_texels or not knownf[idx].any():
            continue
        n = normals[f].astype(np.float64)
        up = np.array([0.0, 0.0, 1.0]) - n * n[2]
        if np.linalg.norm(up) < 0.05:  # a flat roof: any direction on it will do
            up = np.array([1.0, 0.0, 0.0]) - n * n[0]
        up /= np.linalg.norm(up)
        side = np.cross(up, n)
        p = where.reshape(-1, 3)[idx].astype(np.float64)
        s, h = p @ side, p @ up
        # The texture is a flat picture of the face: a texel's column and row are
        # straight-line functions of the place along the face and up it.
        coef = np.linalg.lstsq(np.column_stack((s, h, np.ones(len(s)))), np.column_stack(np.divmod(idx, size)[::-1]), rcond=None)[0]
        mx, my = coef[:, 0], coef[:, 1]
        cell = 1.0 / max(np.hypot(mx[1], my[1]), 1e-6)  # metres a texel
        s0, h0 = s.min(), h.min()
        S, H = int(round((s.max() - s0) / cell)) + 1, int(round((h.max() - h0) / cell)) + 1
        if S * H > 4 * size * size:
            continue
        gs, gh = np.meshgrid(s0 + np.arange(S) * cell, h0 + np.arange(H) * cell)
        gx = np.rint(mx[0] * gs + mx[1] * gh + mx[2]).astype(np.int64)
        gy = np.rint(my[0] * gs + my[1] * gh + my[2]).astype(np.int64)
        inside = (gx >= 0) & (gx < size) & (gy >= 0) & (gy < size)
        texel = gy.clip(0, size - 1) * size + gx.clip(0, size - 1)
        on = inside & (face.ravel()[texel] == f)
        hollow = on & gapf[texel]
        valid = on & knownf[texel]
        band, reach = max(1, round(BAND / cell)), round(REACH / cell)
        rows, cols = np.broadcast_to(np.arange(H)[:, None], (H, S)), np.broadcast_to(np.arange(S), (H, S))
        above = _from_above(valid, hollow, band, reach)
        below = _from_above(valid[::-1], hollow[::-1], band, reach)[::-1]
        row = np.where(above >= 0, above, np.where(below >= 0, H - 1 - below, -1))
        source = np.where(valid, texel, np.where(row >= 0, texel[row.clip(0), cols], -1))
        # Columns with nothing known in them at all: from the nearest column that has.
        got, far = source >= 0, S * 4
        left = np.maximum.accumulate(np.where(got, cols, -1), axis=1)
        right = np.minimum.accumulate(np.where(got, cols, far)[:, ::-1], axis=1)[:, ::-1]
        beside = np.where((left >= 0) & ((cols - left <= right - cols) | (right >= far)), left, np.where(right < far, right, -1))
        source = np.where(got, source, np.where(beside >= 0, source[rows, beside.clip(0)], -1))
        # Back to the texels: each gap texel from the cell it is in.
        i = np.rint((h[g] - h0) / cell).astype(int).clip(0, H - 1)
        j = np.rint((s[g] - s0) / cell).astype(int).clip(0, S - 1)
        take = source[i, j] >= 0
        to = idx[g][take]
        flat[to, :3] = flat[source[i, j][take], :3]
        filled[to] = True
    return filled.reshape(size, size)


def dark_spots(px, face, where, usable, spots, darker=0.6, grow=4) -> np.ndarray:
    """The texels to paint over: within `spots` (x, y, radius; metres, seen from above),
    those much darker than their face is elsewhere (a tree's crown and its shadow on a
    roof), and a few texels round them for the soft edge."""
    inside = np.zeros(face.shape, bool)
    for x, y, r in spots:
        inside |= (where[..., 0] - x) ** 2 + (where[..., 1] - y) ** 2 < r * r
    inside &= usable
    luma = px[..., :3] @ LUMA
    paint = np.zeros(face.shape, bool)
    for f in np.unique(face[inside]):
        on = (face == f) & usable
        rest = on & ~inside
        typical = np.median(luma[rest] if rest.sum() > 100 else luma[on])
        paint |= on & inside & (luma < darker * typical)
    for _ in range(grow):
        wider = paint.copy()
        wider[1:] |= paint[:-1]
        wider[:-1] |= paint[1:]
        wider[:, 1:] |= paint[:, :-1]
        wider[:, :-1] |= paint[:, 1:]
        paint = wider & inside
    return paint
