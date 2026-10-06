"""Chimneys and roof windows, added to IPR's buildings as triangles of their own.

IPR's city model has walls, roofs and big dormers, but no chimneys or roof windows.
Roof windows are found on the photo mesh (mesh_colours.py, detect_windows); the mesh is
too coarse for chimneys, so they're placed by rule: on each ridge, near its ends (where
the party walls and their flues are) and every ten metres or so between, each a
little different; the ones between stand over the piers between the window bays of the
wall below, not over a window. Used by ipr_buildings.py.
"""

import zlib

import numpy as np

WINDOW = 10  # material byte of a roof window's two triangles (tileWorker.ts, shading.ts)
CHIMNEY = 11  # and of a chimney's triangles: they keep their colour, and the game can tell them apart
WINDOW_LIFT = 0.05  # m above the roof, against z-fighting
WINDOW_COLOUR = (40, 46, 56)

RIDGE_MIN = 3.0  # m; shorter ridges get no chimney
CHIMNEY_EVERY = 10.0  # m between chimneys along a long ridge
CHIMNEY_END = 1.5  # m in from a ridge's end
CHIMNEY_SKIP = 0.2  # share of places left without one
# Prague's chimneys are nearly all plastered white, greyed by the weather; bare brick
# is rare.
PLASTER = [(214, 210, 200), (204, 201, 193), (196, 194, 188), (210, 204, 190), (186, 184, 179)]
BRICK = [(139, 74, 54), (128, 70, 52)]
BRICK_SHARE = 0.05
CAP = (150, 147, 141)  # a concrete or sheet cap
FLUE = (70, 67, 64)  # its top, with the flues


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


def piers(t: np.ndarray, codes: np.ndarray, a: np.ndarray, d: np.ndarray, length: float, bay: float):
    """Where the piers between the window bays of the wall under a ridge are, in metres
    along the ridge from `a` in direction `d`: the wall is the longest one running along
    the ridge and beside most of it, and it has as many bays as the game gives it (its
    length over `bay`, rounded; src/facades.ts). None where there's no such wall."""
    w = t[codes == 0]
    if not len(w):
        return None
    n = np.cross(w[:, 1] - w[:, 0], w[:, 2] - w[:, 0])[:, :2]
    ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-6
    w, n = w[ok], n[ok] / ln[ok][:, None]
    side = np.array([-d[1], d[0]])
    ok = np.abs(n @ d) < 0.12
    w, n = w[ok], n[ok]
    if not len(w):
        return None
    # Walls by the line they stand on (which side of the ridge, how far from it).
    off = np.round(((w[:, :, :2] - a[:2]) @ side).mean(1) / 0.4).astype(int) * np.where(n @ side > 0, 1, -1) * 2 + (n @ side > 0)
    s = (w[:, :, :2] - a[:2]) @ d
    best = None
    for k in np.unique(off):
        lo, hi = s[off == k].min(), s[off == k].max()
        shared = min(hi, length) - max(lo, 0.0)
        if shared > 0.6 * length and (best is None or hi - lo > best[1] - best[0]):
            best = (lo, hi)
    if best is None:
        return None
    lo, hi = best
    bays = int(np.floor((hi - lo) / bay + 0.5))
    return lo + np.arange(1, bays) * (hi - lo) / bays if bays >= 2 else None


def chimneys(bid: str, t: np.ndarray, codes: np.ndarray, bay: float | None = None):
    """Chimneys for one building: triangles (k, 3, 3), a code per triangle (0 wall, 2
    flat top) and an RGB colour per triangle. With `bay` (the width of the facade's
    window bays, m), the chimneys between a ridge's ends move onto the nearest pier."""
    rng = np.random.default_rng(zlib.crc32(bid.encode()))
    colours_ = BRICK if rng.random() < BRICK_SHARE else PLASTER
    body = np.array(colours_[rng.integers(len(colours_))], dtype=np.uint8)
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
            between = list(np.linspace(CHIMNEY_END, length - CHIMNEY_END, n + 2)[1:-1])
            at_piers = piers(t, codes, a, d, length, bay) if bay and between else None
            if at_piers is not None:
                free = [p for p in at_piers if CHIMNEY_END + 1.2 < p < length - CHIMNEY_END - 1.2]
                moved = []
                for s in between:
                    if free:
                        p = min(free, key=lambda q: abs(q - s))
                        free.remove(p)
                        moved.append(float(p))
                between = moved
            at = [CHIMNEY_END, *between, length - CHIMNEY_END]
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
            colours += [[body] * 8 + [FLUE] * 2, [CAP] * 8 + [FLUE] * 2]
    if not tris:
        return np.empty((0, 3, 3)), np.empty(0, np.uint8), np.empty((0, 3), np.uint8)
    return (np.concatenate(tris), np.concatenate([np.array(c, np.uint8) for c in codes_out]),
            np.concatenate([np.array(c, np.uint8) for c in colours]))


def keep_windows(windows):
    """The roof windows found on the photo mesh without the doubles: one window is often
    found twice, as a bright patch (the sky in the glass) and as a dark one beside it
    (its frame's shadow), and the two overlap. Of windows whose middles are closer than
    half their sizes, the bigger stays."""
    kept = []
    for w in sorted(windows, key=lambda w: -w[9] * w[10]):
        c = np.array(w[0:3])
        if all(np.linalg.norm(c - np.array(k[0:3])) > 0.5 * max(min(w[9], w[10]), min(k[9], k[10])) for k in kept):
            kept.append(w)
    return kept


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
