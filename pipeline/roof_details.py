"""Chimneys and roof windows, added to IPR's buildings as triangles of their own.

IPR's city model has walls, roofs and big dormers, but no chimneys or roof windows.
Roof windows are found on the photo mesh (mesh_colours.py, detect_windows); the mesh is
too coarse for chimneys, so they're placed by rule: on each ridge, near its ends (where
the party walls and their flues are) and every ten metres or so between, each a
little different. Used by ipr_buildings.py.
"""

import zlib

import numpy as np

WINDOW = 10  # material byte of a roof window's two triangles (tileWorker.ts, shading.ts)
WINDOW_LIFT = 0.05  # m above the roof, against z-fighting
WINDOW_COLOUR = (40, 46, 56)

RIDGE_MIN = 3.0  # m; shorter ridges get no chimney
CHIMNEY_EVERY = 10.0  # m between chimneys along a long ridge
CHIMNEY_END = 1.5  # m in from a ridge's end
CHIMNEY_SKIP = 0.2  # share of places left without one
BRICK = [(139, 74, 54), (128, 70, 52), (150, 86, 62)]
SOOT = (58, 54, 51)


def ridges(t: np.ndarray, codes: np.ndarray):
    """A building's ridges as segments (start, end, both (3,)): edges where two pitched
    roof faces meet with both falling away, joined where they continue one another."""
    roof = np.nonzero(codes == 1)[0]
    if len(roof) < 2:
        return []
    nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1), 1e-12)[:, None]
    edges = {}
    for k in roof:
        for a, b in ((0, 1), (1, 2), (2, 0)):
            key = tuple(sorted((tuple(np.round(t[k, a], 2)), tuple(np.round(t[k, b], 2)))))
            edges.setdefault(key, []).append((k, 3 - a - b))
    found = []
    for (p, q), owners in edges.items():
        if len(owners) != 2:
            continue
        (k1, o1), (k2, o2) = owners
        p, q = np.array(p), np.array(q)
        if abs(p[2] - q[2]) > 0.2 or np.linalg.norm(p[:2] - q[:2]) < 0.3 or nrm[k1] @ nrm[k2] > 0.9:
            continue
        top = max(p[2], q[2])
        if t[k1, o1, 2] < top - 0.3 and t[k2, o2, 2] < top - 0.3:
            found.append((p, q))
    # Join the pieces of one ridge: along one line, touching or overlapping.
    lines = {}
    for p, q in found:
        d = q - p
        if d[0] < 0 or (d[0] == 0 and d[1] < 0):
            p, q, d = q, p, -d
        d = d / np.linalg.norm(d)
        off = p[0] * -d[1] + p[1] * d[0]
        key = (round(np.arctan2(d[1], d[0]) / 0.05), round(off / 0.3), round(p[2] / 0.3))
        lines.setdefault(key, []).append((p @ d, q @ d, p, q))
    out = []
    for pieces in lines.values():
        pieces.sort(key=lambda x: x[0])
        _, s1, a, b = pieces[0]
        for u0, u1, c, e in pieces[1:]:
            if u0 <= s1 + 0.5:
                if u1 > s1:
                    s1, b = u1, e
            else:
                out.append((a, b))
                s1, a, b = u1, c, e
        out.append((a, b))
    return out


def box(centre, along, across, size_along, size_across, bottom, top):
    """The triangles of an upright box (sides and top, no bottom), outward-facing: sides
    first (8 triangles), then the top (2)."""
    cx, cy = centre
    ha, hc = along * size_along / 2, across * size_across / 2
    corners = [np.array([cx, cy]) + sa * ha + sc * hc for sa, sc in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    # Counter-clockwise seen from above, so outward normals.
    u, v = corners[1] - corners[0], corners[2] - corners[1]
    if u[0] * v[1] - u[1] * v[0] < 0:
        corners = corners[::-1]
    tris = []
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        a0, b0, a1, b1 = [*a, bottom], [*b, bottom], [*a, top], [*b, top]
        tris += [[a0, b0, b1], [a0, b1, a1]]
    c = [[*p, top] for p in corners]
    tris += [[c[0], c[1], c[2]], [c[0], c[2], c[3]]]
    return np.array(tris, dtype=np.float64)


def chimneys(bid: str, t: np.ndarray, codes: np.ndarray, wall):
    """Chimneys for one building: triangles (k, 3, 3), a code per triangle (0 wall, 2
    flat top) and an RGB colour per triangle."""
    rng = np.random.default_rng(zlib.crc32(bid.encode()))
    brick = rng.random() < 0.45
    body = np.array(BRICK[rng.integers(len(BRICK))] if brick else [round(v * 0.88) for v in wall], dtype=np.uint8)
    tris, codes_out, colours = [], [], []
    for a, b in ridges(t, codes):
        length = float(np.linalg.norm(b[:2] - a[:2]))
        if length < RIDGE_MIN:
            continue
        d = (b[:2] - a[:2]) / length
        if length < 2 * CHIMNEY_END + 3:
            at = [length / 2]
        else:
            n = max(0, int(round((length - 2 * CHIMNEY_END) / CHIMNEY_EVERY)) - 1)
            at = [CHIMNEY_END, *np.linspace(CHIMNEY_END, length - CHIMNEY_END, n + 2)[1:-1], length - CHIMNEY_END]
        for s in at:
            if rng.random() < CHIMNEY_SKIP:
                continue
            ridge_z = a[2] + (b[2] - a[2]) * s / length
            side = np.array([-d[1], d[0]])
            centre = a[:2] + d * s + side * rng.uniform(-0.4, 0.4)
            along, across = rng.uniform(0.5, 1.3), rng.uniform(0.55, 0.85)
            top = ridge_z + rng.uniform(0.8, 1.5)
            body_tris = box(centre, d, side, along, across, ridge_z - 1.5, top)
            cap = box(centre, d, side, along + 0.12, across + 0.12, top, top + 0.08)
            tris += [body_tris, cap]
            codes_out += [[0] * 8 + [2] * 2, [0] * 8 + [2] * 2]
            colours += [[body] * 8 + [SOOT] * 2, [SOOT] * 10]
    if not tris:
        return np.empty((0, 3, 3)), np.empty(0, np.uint8), np.empty((0, 3), np.uint8)
    return (np.concatenate(tris), np.concatenate([np.array(c, np.uint8) for c in codes_out]),
            np.concatenate([np.array(c, np.uint8) for c in colours]))


def window_quad(win) -> np.ndarray:
    """A roof window's two triangles, lifted off the roof and facing up: (A, B, C) and
    (A, C, D), A a bottom corner, B across the slope from it and D up the slope from it.
    The tile worker takes the window's own coordinates from that order."""
    c, e, d = np.array(win[0:3]), np.array(win[3:6]), np.array(win[6:9])
    w, h = win[9], win[10]
    n = np.cross(e, d)
    n = n if n[2] > 0 else -n
    if np.cross(e, -d) @ n < 0:
        e = -e  # so that A, B, C go round counter-clockwise from above
    c = c + n * WINDOW_LIFT
    A = c - e * w / 2 + d * h / 2  # d points down the slope
    B, D = A + e * w, A - d * h
    C = B - d * h
    return np.array([[A, B, C], [A, C, D]])
