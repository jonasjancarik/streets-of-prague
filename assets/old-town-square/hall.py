"""Staroměstská radnice. The clock projects from the south wall; the oriel faces east."""

import math
import numpy as np
from craft import at, edges, lathe, rod, finial, rect, drum, band, panel, shell

PANELS = (
    "orloj",
    "apostles",
    "tower-clock",
    "chapel-window",
    "chapel-front",
    "council-house",
    "kriz-house",
    "hall-masonry",
    "tower-shaft",
    "lower-tower",
)


def build(m, survey):
    # Preserve the town hall's irregular rear ranges. Cut only the clock tower
    # where the new shaft starts; it stands clear of the council-house roofs.
    c = survey[:, :, :3].mean(1)
    tower = (c[:, 0] > -7.3) & (c[:, 0] < 5.0) & (c[:, 1] > -8.2) & (c[:, 1] < 4.8)
    shell(m, survey[tower], 16.85)
    shell(m, survey[~tower], 39.50)
    x, y = -1.18, -1.32
    shaft = rect(x, y, 9.70, 9.78)
    for a, b in edges(shaft):
        m.wall(a, b, 16.70, 39.50, "tower-shaft")
    # The projecting stone case and side walls hide the old aerial clock.
    x0, x1 = -6.02, 3.64
    south = -8.05
    m.box(x0, south + 0.03, x1, -6.13, -0.16, 16.92, "sandstone")
    panel(m, x0, x1, south, -0.16, 16.82, "lower-tower")
    m.box(x0 - 0.10, south - 0.10, x1 + 0.10, -6.02, 16.66, 16.97, "carving")
    # Clock storey and projecting stone gallery above the original tower shaft.
    band(m, x, y, 10.14, 10.16, 39.35, 0.46)
    ring = rect(x, y, 9.82, 9.85)
    for a, b in edges(ring):
        m.wall(a, b, 39.8, 46.6, "tower-clock")
    band(m, x, y, 10.12, 10.15, 46.55, 0.42)
    band(m, x, y, 10.75, 10.78, 46.96, 0.36, "sandstone")
    gallery = rect(x, y, 10.52, 10.54)
    drum(m, rect(x, y, 8.15, 8.20), 47.28, 49.65, "recess")
    for a, b in edges(gallery):
        for t in np.linspace(0, 1, 9, endpoint=False):
            p = a + t * (b - a)
            lathe(m, *p, [(47.28, 0.20), (47.50, 0.18), (49.30, 0.14), (49.56, 0.23)], "carving", 8)
    band(m, x, y, 10.93, 10.96, 49.55, 0.3)
    # A steep hipped crown with a short ridge and a gilt finial at either end.
    bottom = rect(x, y, 10.55, 10.55)
    ridge = np.array([[x - 1.48, y, 59.6], [x + 1.48, y, 59.6]])
    m.face([at(bottom[0], 49.83), at(bottom[1], 49.83), ridge[1], ridge[0]], "slate")
    m.face([at(bottom[1], 49.83), at(bottom[2], 49.83), ridge[1]], "slate")
    m.face([at(bottom[2], 49.83), at(bottom[3], 49.83), ridge[0], ridge[1]], "slate")
    m.face([at(bottom[3], 49.83), at(bottom[0], 49.83), ridge[0]], "slate")
    for p in ridge:
        finial(m, *p, 1.55)
    for cx, cy in rect(x, y, 9.60, 9.60):
        lathe(
            m, cx, cy, [(46.8, 0.66), (47.5, 0.89), (49.85, 0.83), (50.15, 1.04), (54.45, 0.07)], "slate", 8
        )
        finial(m, cx, cy, 54.44, 1.22)
    # Rectified photographic face. The brass rings and stone frames step forward
    # from it, as does the narrow balcony below the astrolabe.
    cx = -1.06
    fy = -8.26
    w = 4.55
    z0 = 0.19
    h = 10.0
    m.box(cx - w / 2 - 0.16, fy + 0.02, cx + w / 2 + 0.16, -7.65, -0.30, 10.24, "hall-masonry")
    panel(m, cx - w / 2, cx + w / 2, fy, z0, z0 + h, "orloj")
    for u, v, rx, ry in [(0.574, 0.288, 0.356, 0.149), (0.574, 0.641, 0.330, 0.147)]:
        # Register a broad carved bezel to its actual dial and carry the dial
        # forward with it, preserving the hour marks, calendar and hands.
        coords = []
        for t in np.linspace(0, math.tau, 65):
            co, si = math.cos(t), math.sin(t)
            coords.append(
                (cx + w * (u - 0.5 + rx * co), z0 + h * (1 - v + ry * si), u + rx * co, v - ry * si)
            )
        for a, b in zip(coords, coords[1:]):
            xp, zp, up, vp = a
            xq, zq, uq, vq = b
            m.face(
                [
                    (cx + w * (u - 0.5), fy - 0.085, z0 + h * (1 - v)),
                    (xp, fy - 0.085, zp),
                    (xq, fy - 0.085, zq),
                ],
                "orloj",
                [(u, v), (up, vp), (uq, vq)],
            )
            m.face([(xp, fy, zp), (xq, fy, zq), (xq, fy - 0.085, zq), (xp, fy - 0.085, zp)], "lead")
    for xx in [cx - w / 2 - 0.16, cx + w / 2 + 0.16]:
        lathe(
            m,
            xx,
            fy + 0.015,
            [(0, 0.19), (2.1, 0.18), (3, 0.12), (4.6, 0.17), (5.2, 0.18), (9.6, 0.13), (10.35, 0.02)],
            "sandstone",
            8,
        )
    m.box(cx - 2.47, fy - 0.44, cx + 2.47, fy + 0.05, 5.51, 5.73, "carving")
    for xx in np.linspace(cx - 2.36, cx + 2.36, 11):
        rod(m, (xx, fy - 0.41, 5.72), (xx, fy - 0.41, 6.12), 0.027, "iron")
    rod(m, (cx - 2.40, fy - 0.41, 6.12), (cx + 2.40, fy - 0.41, 6.12), 0.04, "iron")
    panel(m, cx - 1.9, cx + 1.9, fy - 0.01, 9.56, 11.57, "apostles")
    # Arched copper hood with a dark visible underside and a gilded rim.
    pts = []
    for t in np.linspace(math.pi, 0, 25):
        pts.append((cx + 2.66 * math.cos(t), 11.24 + 1.33 * math.sin(t)))
    for (a, z), (b, q) in zip(pts, pts[1:]):
        p = [(a, fy + 0.28, z + 0.10), (a, fy - 0.85, z), (b, fy - 0.85, q), (b, fy + 0.28, q + 0.10)]
        m.face(p, "copper")
        m.face(p[::-1], "recess")
        rod(m, p[1], p[2], 0.05, "gold")
    for xx in (cx - 2.47, cx + 2.47):
        rod(m, (xx, fy + 0.04, 9.80), (xx, fy - 0.75, 11.31), 0.13, "sandstone")
    # The finial rises from the hood against the tower, with a square lantern.
    lathe(
        m,
        cx,
        fy + 0.16,
        [
            (12.43, 0.38),
            (12.78, 0.62),
            (13.02, 0.54),
            (14.47, 0.38),
            (14.65, 0.47),
            (16.45, 0.09),
            (16.65, 0.04),
        ],
        "copper",
        4,
        math.pi / 4,
    )
    # Lower chapel range and its two tall lancets, beside the projecting bay.
    panel(m, 3.66, 8.18, -6.46, -0.14, 16.40, "chapel-front")
    east_x = 8.30
    for ya, yb in [(-6.4, -2.3), (1.24, 5.55), (5.55, 10.98)]:
        a, b = np.array([east_x, ya]), np.array([east_x, yb])
        m.wall(a, b, -0.12, 6.40, "hall-masonry")
        m.wall(a, b, 6.40, 13.28, "chapel-window")
        m.wall(a, b, 13.28, 16.41, "hall-masonry")
    m.box(3.58, -6.59, 8.44, 10.96, 16.40, 16.72, "carving")
    # Oriel chapel. Its polygonal bay rests on a corbel rather than a column.
    c = np.array((8.02, -0.55))
    angles = np.radians([-90, -54, -18, 18, 54, 90])
    outline = c + 2.98 * np.column_stack((np.cos(angles), np.sin(angles)))
    for a, b in zip(outline, outline[1:]):
        m.face([at(c, 3.15), at(b, 6.25), at(a, 6.25)], "sandstone")
        m.wall(a, b, 6.25, 7.04, "carving")
        m.wall(a, b, 7.04, 12.85, "chapel-window")
        m.wall(a, b, 12.85, 13.23, "carving")
        m.face([at(a, 13.2), at(b, 13.2), at(c, 20.9)], "slate")
        lathe(m, *a, [(6.38, 0.17), (7.1, 0.21), (12.66, 0.14), (13.3, 0.22), (14.08, 0.035)], "carving", 7)
    finial(m, *c, 20.87, 1.3)

    # The two adjoining council houses follow a slightly oblique building line.
    # Map whole measured bays, so the portal, lintels and both rows of windows align.
    def street(x):
        return -5.93 + (x + 7) * 0.036

    for left, right, tex, bottom, top in [
        (-23.9, -6.95, "council-house", -0.22, 16.25),
        (-40.45, -23.9, "kriz-house", 4.54, 16.62),
    ]:
        a = np.array([left, street(left)])
        b = np.array([right, street(right)])
        m.wall(a, b, bottom, top, tex)
        m.wall(a - [0, 0.12], b - [0, 0.12], top, top + 0.24, "carving")
        if tex == "kriz-house":
            # Ground-floor doors below the decorated council window.
            for j in range(2):
                lo = a + (b - a) * (0.50 * j)
                hi = a + (b - a) * (0.50 * (j + 1))
                m.face(
                    [at(lo, -0.22), at(hi, -0.22), at(hi, bottom), at(lo, bottom)],
                    "council-house",
                    [(0.015, 0.99), (0.33, 0.99), (0.33, 0.721), (0.015, 0.721)],
                )
