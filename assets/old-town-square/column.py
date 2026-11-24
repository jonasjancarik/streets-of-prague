"""Reconstruction of the restored Marian Column, including its four corner groups."""

import math
import numpy as np

from craft import at, edges, rect, band, lathe, rod, ROOT
import sys

sys.path.insert(0, str(ROOT / "assets/national-theatre"))
from statuary import sweep

PANELS = ("mary", "inscription", "angel-justice", "angel-sword")


def angel(m, x, y, base, turn, pose):
    c, s = math.cos(turn), math.sin(turn)

    def pt(u, v, z):
        return np.array([x + c * u - s * v, y + s * u + c * v, base + z])

    def body(points, w, d, fold=0):
        sweep(m, [pt(*p) for p in points], w, d, "statue", 10, fold)

    # Two of the restored figures are known from close frontal photographs.
    # The nearer arm and the metal attribute stand in front of the cast body.
    justice = pose in (0, 3)
    if justice:
        trace = [
            (607, 178, 356, 0.29),
            (585, 173, 352, 0.30),
            (555, 190, 314, 0.29),
            (526, 205, 311, 0.28),
            (495, 212, 318, 0.30),
            (467, 231, 318, 0.28),
            (446, 218, 315, 0.26),
            (419, 209, 310, 0.27),
            (390, 225, 316, 0.28),
            (368, 240, 314, 0.24),
            (350, 250, 307, 0.20),
            (340, 254, 303, 0.14),
            (325, 254, 305, 0.18),
            (294, 255, 310, 0.18),
            (272, 255, 302, 0.17),
            (255, 263, 296, 0.13),
            (244, 278, 289, 0.08),
        ]
        box = (141, 225, 232, 398)
        tex = "angel-justice"
        mid = 279
        scale = 0.006
    else:
        trace = [
            (513, 147, 299, 0.27),
            (493, 151, 291, 0.29),
            (471, 164, 281, 0.28),
            (450, 168, 278, 0.29),
            (427, 176, 289, 0.31),
            (401, 175, 295, 0.32),
            (379, 174, 287, 0.32),
            (353, 179, 278, 0.30),
            (326, 180, 278, 0.28),
            (296, 188, 282, 0.27),
            (266, 204, 289, 0.26),
            (242, 214, 288, 0.26),
            (221, 234, 278, 0.17),
            (207, 233, 286, 0.18),
            (188, 231, 290, 0.19),
            (170, 239, 288, 0.17),
            (160, 250, 273, 0.11),
        ]
        box = (140, 155, 226, 372)
        tex = "angel-sword"
        mid = 251
        scale = 0.0064
    last = None
    for py, l, r, depth in trace:
        frac = (trace[0][0] - py) / (trace[0][0] - trace[-1][0])
        ring = []
        texcoords = []
        for a in np.linspace(0, math.tau, 25):
            px = 0.5 * (l + r + (r - l) * math.cos(a))
            ring.append(
                pt((px - mid) * scale, math.sin(a) * depth * (1 + 0.08 * math.cos(6 * a + frac)), frac * 2.02)
            )
            texcoords.append(((px - box[0]) / box[2], (py - box[1]) / box[3]))
        if last:
            prev, uv = last
            for j in range(24):
                points = [prev[j], prev[j + 1], ring[j + 1], ring[j]]
                m.face(
                    points, tex if j < 12 else "statue", [uv[j], uv[j + 1], texcoords[j + 1], texcoords[j]]
                )
        last = ring, texcoords
    m.face(last[0][:-1], "statue")
    high = 0.21 if pose % 2 else -0.17
    body(
        [(high, 0.03, 1.48), (0.34, 0.09, 1.40), (0.41, 0.18, 1.76), (0.33, 0.19, 1.96)],
        [0.12, 0.12, 0.085, 0.07],
        [0.11, 0.12, 0.08, 0.07],
    )
    body(
        [(-0.16, 0.02, 1.45), (-0.29, 0.15, 1.16), (0.12, 0.24, 1.38)],
        [0.12, 0.10, 0.075],
        [0.12, 0.095, 0.07],
    )
    tip = pt(0.59, 0.19, 2.95 if justice else 2.78)
    rod(m, pt(-0.22, 0.25, 0.42), tip, 0.024, "gold" if justice else "iron")
    if justice:
        rod(m, pt(0.32, 0.19, 2.69), pt(0.75, 0.19, 2.60), 0.030, "gold")
    # Each wing is a layered fan. The flight feathers are broad in silhouette
    # and taper individually down the back of the figure.
    for side in (-1, 1):
        for i in range(5):
            t = i / 4
            body(
                [
                    (side * 0.19, -0.13, 1.32),
                    (side * 0.32, -0.26, 1.60),
                    (side * (0.48 + 0.08 * t), -0.35, 1.82),
                    (side * (0.75 + 0.16 * t), -0.43, 1.85 - 0.44 * t),
                    (side * (0.85 + 0.08 * t), -0.48, 1.69 - 0.64 * t),
                ],
                [0.07, 0.13, 0.14, 0.095, 0.013],
                [0.065, 0.075, 0.075, 0.052, 0.01],
            )
    # Low forms beneath the angel's feet distinguish the groups from standing figures.
    body(
        [
            (-0.45, 0.14, 0.10),
            (-0.22, 0.14, 0.20),
            (0.18, 0.21, 0.20),
            (0.44, 0.26, 0.32),
            (0.53, 0.29, 0.40),
        ],
        [0.06, 0.17, 0.17, 0.13, 0.065],
        [0.07, 0.18, 0.18, 0.12, 0.06],
    )


def virgin(m, x, y, z):
    side = np.array([0.16, -0.987])
    front = np.array([side[1], -side[0]])
    # Trace the forward silhouette and project Gampe's photograph over horizontal
    # sections. Give the reverse a continuous mantle with twisting folds.
    rows = [
        (572, 258, 320, 0.40, -0.04),
        (553, 265, 326, 0.42, -0.08),
        (525, 271, 332, 0.38, -0.08),
        (490, 272, 337, 0.35, -0.06),
        (461, 275, 341, 0.35),
        (433, 273, 345, 0.33),
        (413, 275, 342, 0.30),
        (401, 282, 332, 0.24),
        (391, 282, 312, 0.17),
        (386, 284, 306, 0.13),
        (379, 281, 306, 0.155),
        (369, 283, 302, 0.15),
        (362, 289, 300, 0.11),
    ]
    angles = np.linspace(0, math.tau, 33)
    for j in range(32):
        last = None
        for row in rows:
            py, left, right, depth, *off = row
            f = (572 - py) / 210
            pts = []
            uv = []
            for a in angles[j : j + 2]:
                px = (left + right + (right - left) * math.cos(a)) / 2
                xy = (
                    (x, y)
                    + side * (px - 294) * 0.013
                    + front
                    * (depth * math.sin(a) * (1 + 0.13 * math.cos(8 * a + f * 2)) + (off[0] if off else 0))
                )
                pts.append(at(xy, z + f * 2.76))
                uv.append(((px - 251) / 101, (py - 355) / 219))
            if last:
                lp, lu = last
                m.face(
                    [lp[1], lp[0], pts[0], pts[1]],
                    "mary" if j < 16 else "statue",
                    [lu[1], lu[0], uv[0], uv[1]],
                )
            last = pts, uv
    # Close the crown and bring the praying forearms out of the cloak.
    crown = at((x, y) + side * 0.01, z + 2.76)
    lathe(m, *crown[:2], [(z + 2.74, 0.10), (z + 2.79, 0.07), (z + 2.80, 0.02)], "statue", 12)
    for sgn in (-1, 1):

        def hand(u, v, h):
            return at((x, y) + side * u + front * v, z + h)

        sweep(
            m,
            [
                hand(sgn * 0.29, 0.16, 1.94),
                hand(sgn * 0.32, 0.27, 1.72),
                hand(0.14 + sgn * 0.085, 0.41, 1.90),
                hand(0.23 + sgn * 0.045, 0.38, 2.15),
            ],
            [0.115, 0.106, 0.064, 0.035],
            [0.11, 0.10, 0.06, 0.032],
            "statue",
            9,
        )
    # The starry halo stands free of her head. Each gilt star has five points.
    r = 0.49

    def halo(a, radius):
        return at((x, y) + side * (math.cos(a) * radius) - front * 0.06, z + 2.70 + math.sin(a) * radius)

    for a, b in zip(angles, angles[1:]):
        rod(m, halo(a, r), halo(b, r), 0.022, "gold", 6)
    for i in range(12):
        p = halo(i * math.tau / 12, r)
        rim = []
        for j in range(10):
            a = math.pi / 2 + j * math.pi / 5
            rr = 0.083 if j % 2 == 0 else 0.038
            rim.append(p + np.array([*side, 0]) * rr * math.cos(a) + [0, 0, rr * math.sin(a)])
        for a, b in edges(rim):
            m.face([p + [*(0.025 * front), 0], a, b], "gold")
            m.face([p - [*(0.025 * front), 0], b, a], "gold")


def build(m):
    x, y = 1.05, -1.58
    for size, z, h in [(8.5, -0.28, 0.88), (8.03, 0.60, 0.18), (7.52, 0.78, 0.18), (7.04, 0.96, 0.17)]:
        band(m, x, y, size, size * 0.88, z, h, "granite")
    floor = 1.13
    rail = rect(x, y, 6.50, 5.66)
    for a, b in edges(rail):
        # The south side opens between the two gate piers.
        spans = [(0, 0.34), (0.66, 1)] if a[1] == b[1] and a[1] < y else [(0, 1)]
        for f, g in spans:
            lo = a + f * (b - a)
            hi = a + g * (b - a)
            delta = hi - lo
            for z, h, r in [(floor, 0.19, 0.20), (1.99, 0.14, 0.19)]:
                m.box(
                    min(lo[0], hi[0]) - r,
                    min(lo[1], hi[1]) - r,
                    max(lo[0], hi[0]) + r,
                    max(lo[1], hi[1]) + r,
                    z,
                    z + h,
                    "carving",
                )
            for t in np.linspace(0, 1, max(3, round(np.linalg.norm(delta) / 0.41) + 1))[1:-1]:
                px, py = lo + t * delta
                lathe(
                    m,
                    px,
                    py,
                    [
                        (1.28, 0.13),
                        (1.40, 0.15),
                        (1.49, 0.11),
                        (1.58, 0.086),
                        (1.73, 0.155),
                        (1.84, 0.15),
                        (1.96, 0.094),
                        (2.00, 0.13),
                    ],
                    "statue",
                    9,
                )
        for p in [a, a + 0.34 * (b - a), a + 0.66 * (b - a)] if len(spans) == 2 else [a]:
            band(m, *p, 0.49, 0.49, floor, 1.00, "carving")
            lathe(m, *p, [(2.12, 0.16), (2.22, 0.11), (2.29, 0.18), (2.42, 0.18), (2.52, 0.06)], "statue", 12)
    # The four piers enclose a small shrine with a gilded grille.
    band(m, x, y, 3.32, 3.32, 1.12, 0.30, "carving")
    for a, b in edges(rect(x, y, 2.67, 2.67)):
        for t in np.linspace(0.08, 0.92, 9):
            p = a + t * (b - a)
            rod(m, at(p, 1.44), at(p, 2.95), 0.026, "gold")
        for z in [1.70, 2.35, 2.77]:
            rod(m, at(a, z), at(b, z), 0.025, "gold")
    for i, p in enumerate(rect(x, y, 2.85, 2.85)):
        band(m, *p, 0.93, 0.93, 1.35, 1.67, "carving")
        band(m, *p, 1.12, 1.12, 2.91, 0.20)
        angel(m, *p, 3.10, math.atan2(y - p[1], x - p[0]) + math.pi / 2, i)
    band(m, x, y, 3.64, 3.64, 2.98, 0.28)
    ring = rect(x, y, 1.65, 1.65)
    for a, b in edges(ring):
        m.wall(a, b, 3.26, 5.62, "inscription")
    for size, z, h in [(2.02, 3.24, 0.19), (1.86, 3.43, 0.11), (1.90, 5.60, 0.15), (2.06, 5.75, 0.16)]:
        band(m, x, y, size, size, z, h)
    lathe(
        m,
        x,
        y,
        [
            (5.90, 0.79),
            (6.01, 0.83),
            (6.11, 0.76),
            (6.26, 0.67),
            (6.33, 0.62),
            (8.9, 0.60),
            (10.9, 0.55),
            (12.25, 0.49),
            (12.33, 0.56),
            (12.43, 0.54),
        ],
        "rose",
        36,
    )
    lathe(m, x, y, [(12.42, 0.50), (12.60, 0.62), (12.85, 0.70), (13.08, 0.83), (13.26, 0.79)], "carving", 16)
    for a in np.arange(12) * math.tau / 12:
        vec = np.array([math.cos(a), math.sin(a)])
        root = np.array((x, y)) + 0.55 * vec
        tip = np.array((x, y)) + 0.82 * vec
        rod(m, at(root, 12.48), at(tip, 13.0), 0.088, "statue", 7)
        lathe(m, *tip, [(12.93, 0.10), (13.04, 0.14), (13.13, 0.08)], "carving", 8)
    band(m, x, y, 1.71, 1.71, 13.23, 0.15)
    lathe(m, x, y, [(13.37, 0.61), (13.49, 0.69), (13.64, 0.55)], "statue", 15)
    virgin(m, x, y, 13.58)
