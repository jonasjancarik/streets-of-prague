"""Build the Jan Hus Memorial in metres, X along the steps towards their eastern urn.

Run with the pipeline Python. The shipped atlas suffices for an offline rebuild.
--photos DIR repaints it from the reference photographs listed in SOURCES.md.
"""

import argparse
import math
from pathlib import Path

import numpy as np

from mesh import Model, photo_atlas

TAU = math.tau


def loft(m, texture, trace, base, height, scale, right=(1, 0), rear=None, folds=0):
    """Fit closed horizontal sections to a traced figure. Each row records image
    y, left and right edges, physical half-depth and optional shift into the foreground.
    A second trace, when present, registers the back of the same figure independently."""
    trace = np.asarray([(*row, 0) if len(row) == 4 else row for row in trace])
    right = np.asarray(right, float)
    right /= np.linalg.norm(right)
    front = np.array((right[1], -right[0]))
    x0 = (trace[-1, 1] + trace[-1, 2]) / 2
    for back in (False, True):
        material = texture if not back else ("reverse" if rear else "drapery")
        angles = np.linspace(0, math.pi, 25) + back * math.pi
        ca, sa = np.cos(angles), np.sin(angles)
        points, pixels = [], []
        for y, left, edge, depth, advance in trace:
            z = (trace[0, 0] - y) / (trace[0, 0] - trace[-1, 0])
            px = (left + edge + (edge - left) * ca) / 2
            flute = 1 + folds * np.cos(9 * angles + z * 2) * (1 - z**3)
            surface_depth = sa * depth * flute + advance
            if texture == "face" and not back:
                # Bridge of the nose and the jutting chin between the two cheeks.
                surface_depth += 0.09 * np.exp(-(((px - 445) / 13) ** 2) - ((y - 209) / 40) ** 2)
                surface_depth += 0.04 * np.exp(-(((px - 440) / 26) ** 2) - ((y - 265) / 17) ** 2)
            xy = base[:2] + np.outer((px - x0) * scale, right) + np.outer(surface_depth, front)
            points.append(np.column_stack((xy, np.full(len(ca), base[2] + z * height))))
            if not back:
                pixels.append(np.column_stack((px, np.full(len(ca), y))))
            elif rear:
                ry, l, r = [np.interp(z, rear[0], col) for col in rear[1:]]
                pixels.append(np.column_stack(((l + r - (r - l) * ca) / 2, np.full(len(ca), ry))))
            else:
                pixels.append(np.column_stack((405 - 28 * ca, np.full(len(ca), 314 - 159 * z))))
        m.patch(points, pixels, material, flip=True)
        # Close the crown and hem, including the narrow crowns of heads and the
        # much wider tops of the banner and bent shoulders.
        for i, flip in [(0, False), (-1, True)]:
            p = points[i]
            centre = (p[0] + p[-1]) / 2
            m.patch(
                [p, np.tile(centre, (len(p), 1))],
                [pixels[i], np.tile(np.mean(pixels[i], axis=0), (len(p), 1))],
                material,
                flip=flip,
            )


def sculpture(m):
    # The upright master, widening into a train at ground level. His head is
    # separate so the neck, chin and shoulders cast their own shadows.
    back = (
        [0, 0.18, 0.51, 0.87, 1],
        [145, 130, 93, 55, 40],
        [354, 356, 358, 363, 371],
        [397, 398, 402, 395, 387],
    )
    loft(
        m,
        "plate",
        [
            (435, 517, 689, 1.37, -0.43),
            (417, 519, 658, 1.13, -0.27),
            (396, 516, 637, 0.80, -0.13),
            (367, 517, 620, 0.66, -0.07),
            (330, 513, 607, 0.53),
            (306, 510, 601, 0.50),
            (280, 505, 598, 0.52),
            (253, 504, 596, 0.51),
            (222, 510, 594, 0.46),
            (190, 515, 591, 0.40),
            (163, 520, 585, 0.36),
            (152, 523, 582, 0.32),
            (143, 536, 567, 0.23),
            (137, 543, 560, 0.16),
        ],
        (-1.80, 0.05, 4.17),
        4.73,
        0.0155,
        rear=back,
        folds=0.16,
    )
    # Turn the bearded face east-southeast, towards the Týn church.
    loft(
        m,
        "face",
        [
            (347, 388, 451, 0.14),
            (309, 389, 468, 0.17),
            (292, 368, 488, 0.20, 0.018),
            (275, 363, 500, 0.25, 0.04),
            (246, 356, 512, 0.26, 0.04),
            (215, 371, 505, 0.24, 0.04),
            (189, 381, 496, 0.23, 0.03),
            (165, 396, 481, 0.21),
            (143, 408, 469, 0.16),
            (130, 425, 450, 0.09),
        ],
        (-1.80, 0.04, 8.77),
        0.78,
        0.0035,
        (0.56, 0.83),
        rear=([0, 0.3, 0.8, 1], [41, 38, 29, 26], [374, 370, 375, 377], [386, 386, 384, 381]),
    )
    # Drooping sleeve on Hus's right hand, visible in profile below his shoulder.
    loft(
        m,
        "plate",
        [
            (307, 510, 517, 0.08),
            (295, 507, 520, 0.13),
            (275, 505, 521, 0.17),
            (250, 506, 518, 0.18),
            (222, 510, 521, 0.17),
            (188, 516, 527, 0.16),
            (163, 521, 531, 0.12),
        ],
        (-2.20, -0.04, 6.12),
        2.21,
        0.016,
        folds=0.13,
    )

    # Exiles on the low western shoulder. The bowed figure leans across the
    # reclining one. The heavy cloth spills over the edge of the upper stone.
    loft(
        m,
        "exiles",
        [
            (541, 34, 290, 0.86),
            (528, 39, 299, 0.92),
            (508, 50, 309, 0.88),
            (484, 72, 324, 0.79),
            (459, 119, 345, 0.72),
            (438, 172, 364, 0.67),
            (421, 193, 378, 0.61),
            (402, 215, 370, 0.52),
            (385, 231, 353, 0.42),
            (371, 259, 348, 0.36),
            (356, 284, 335, 0.24),
        ],
        (-3.54, 0.15, 3.00),
        2.64,
        0.015,
        folds=0.13,
    )
    loft(
        m,
        "exiles",
        [
            (442, 208, 254, 0.13),
            (429, 212, 255, 0.20, 0.04),
            (410, 211, 259, 0.22, 0.06),
            (390, 218, 267, 0.25, 0.05),
            (378, 231, 262, 0.19),
            (370, 241, 254, 0.10),
        ],
        (-4.59, -0.39, 4.49),
        0.98,
        0.014,
    )
    loft(
        m,
        "exiles",
        [
            (545, 31, 183, 0.48),
            (531, 46, 186, 0.54),
            (514, 62, 182, 0.49),
            (492, 88, 168, 0.42),
            (473, 109, 180, 0.37),
            (460, 134, 179, 0.26),
            (450, 151, 172, 0.16),
        ],
        (-5.55, -0.12, 2.98),
        1.44,
        0.016,
    )
    loft(
        m,
        "exiles",
        [(471, 147, 176, 0.14), (461, 145, 183, 0.21), (449, 149, 178, 0.20), (444, 154, 170, 0.13)],
        (-5.58, -0.34, 4.14),
        0.45,
        0.014,
    )

    # Eastern group. The forward-facing carved tablet is seen nearly edge-on
    # from Hus's side. The chalice, its bearer and the outstretched arm face east.
    east = (0.14, 0.99)
    loft(
        m,
        "chalice",
        [
            (516, 176, 309, 0.53),
            (490, 178, 305, 0.49),
            (424, 184, 301, 0.46),
            (354, 191, 295, 0.43),
            (283, 195, 304, 0.44),
            (237, 191, 306, 0.48),
            (201, 179, 290, 0.50),
            (178, 185, 283, 0.42),
            (153, 205, 271, 0.29),
            (141, 232, 259, 0.15),
            (130, 230, 263, 0.20),
            (117, 226, 271, 0.22),
            (105, 233, 266, 0.20),
            (91, 240, 256, 0.13),
        ],
        (4.40, 3.08, 3.55),
        4.45,
        0.0102,
        east,
        folds=0.085,
    )
    # Bent sleeve, forearm and fingers around the stem, traced in the east view.
    loft(
        m,
        "chalice",
        [
            (238, 245, 293, 0.19, 0.03),
            (226, 224, 288, 0.21, 0.08),
            (213, 212, 268, 0.22, 0.17),
            (200, 211, 247, 0.20, 0.24),
            (189, 211, 234, 0.16, 0.32),
            (178, 214, 228, 0.11, 0.34),
            (171, 218, 226, 0.08, 0.35),
        ],
        (4.57, 2.80, 6.53),
        0.69,
        0.0104,
        east,
    )
    # The cup projects in front of the bearer's chest. Its flared lip
    # surrounds a shallow hollow so it also reads when seen from above.
    angle = np.linspace(0, TAU, 25)
    circle = np.column_stack((np.cos(angle), np.sin(angle)))
    cup = [
        (7.01, 0.08),
        (7.08, 0.12),
        (7.25, 0.055),
        (7.31, 0.10),
        (7.48, 0.18),
        (7.55, 0.19),
        (7.55, 0.15),
        (7.40, 0.035),
    ]
    rings = [np.column_stack(((4.89, 2.75) + radius * circle, np.full(len(angle), z))) for z, radius in cup]
    for lo, hi in zip(rings, rings[1:]):
        stone_face(m, lo, hi, 2, texture="bronze")
    loft(
        m,
        "chalice",
        [
            (489, 4, 97, 0.13),
            (451, 5, 117, 0.16),
            (396, 9, 139, 0.17),
            (328, 28, 166, 0.18),
            (256, 53, 190, 0.17),
            (218, 71, 201, 0.15),
            (185, 83, 133, 0.11),
        ],
        (4.67, 1.75, 3.60),
        3.02,
        0.0107,
        east,
    )
    loft(
        m,
        "plate",
        [
            (445, 797, 867, 0.52),
            (420, 806, 875, 0.53),
            (387, 815, 881, 0.52),
            (353, 836, 887, 0.46),
            (332, 848, 884, 0.34),
            (315, 859, 880, 0.19),
            (306, 860, 880, 0.19),
            (298, 868, 877, 0.10),
        ],
        (3.50, 2.43, 3.65),
        3.88,
        0.018,
        folds=0.12,
    )
    loft(
        m,
        "chalice",
        [
            (524, 346, 374, 0.18),
            (501, 345, 376, 0.24),
            (474, 338, 387, 0.29),
            (451, 310, 391, 0.41),
            (421, 309, 383, 0.46),
            (391, 301, 416, 0.50),
            (361, 306, 430, 0.47),
            (326, 312, 409, 0.43),
            (306, 317, 381, 0.34),
            (284, 322, 370, 0.25),
            (273, 331, 354, 0.18),
        ],
        (4.44, 4.11, 3.27),
        2.90,
        0.0115,
        east,
    )
    loft(
        m,
        "chalice",
        [
            (442, 411, 435, 0.18),
            (428, 392, 448, 0.23),
            (408, 381, 452, 0.28),
            (399, 372, 523, 0.19),
            (390, 368, 533, 0.17),
            (381, 373, 531, 0.11),
            (365, 371, 421, 0.15),
        ],
        (4.47, 4.84, 4.29),
        0.90,
        0.011,
        east,
    )

    # The folds of the standard run down from the huddled Hussites. Its
    # broad tablet inclines towards the beholder and hides part of the group.
    loft(
        m,
        "plate",
        [
            (445, 705, 947, 1.10),
            (432, 716, 944, 1.04),
            (416, 737, 940, 0.99),
            (394, 749, 938, 0.90),
            (380, 766, 936, 0.83),
            (373, 784, 936, 0.78),
            (364, 811, 934, 0.69),
            (348, 824, 929, 0.61),
            (338, 845, 926, 0.53),
            (327, 872, 924, 0.44),
            (316, 897, 923, 0.28),
        ],
        (3.93, 2.05, 3.78),
        3.23,
        0.0161,
        rear=([0, 0.35, 0.72, 1], [209, 153, 91, 62], [147, 145, 145, 152], [246, 228, 204, 180]),
        folds=0.09,
    )
    # Sunken faces, curling cloth and shields form a continuous diagonal
    # between Hus and the raised standard.
    loft(
        m,
        "plate",
        [
            (447, 624, 820, 0.73),
            (438, 665, 823, 0.78),
            (429, 707, 823, 0.71),
            (412, 726, 821, 0.65),
            (396, 743, 820, 0.58),
            (384, 752, 806, 0.48),
            (377, 773, 790, 0.30),
        ],
        (2.05, 1.08, 3.92),
        1.50,
        0.016,
        folds=0.17,
    )
    # The nearer edge of the standard projects beyond the folds. Model the
    # front, the return and the rim separately to retain the sharp cast edge.
    p = np.array(
        [
            [[2.64, 1.00, 3.90], [4.18, 1.60, 3.81]],
            [[3.15, 1.22, 5.55], [4.43, 1.76, 5.47]],
            [[3.80, 1.55, 6.85], [4.51, 1.88, 7.03]],
        ]
    )
    tex = np.array([[[848, 442], [926, 456]], [[867, 393], [926, 401]], [[894, 350], [923, 329]]])
    m.patch(p, tex, "plate")
    back = p + (0, 0.19, 0)
    m.patch(back, tex, "plate", flip=True)
    for j in (0, 1):
        m.patch(
            np.stack((p[:, j], back[:, j]), axis=1),
            np.stack((tex[:, j], tex[:, j] + (2, 0)), axis=1),
            "plate",
            flip=j == 0,
        )
    m.patch([p[-1], back[-1]], [tex[-1], tex[-1] + (0, 2)], "plate")

    # A seated mother and the crowded reverse of the group are lower than Hus.
    # The original reverse photograph looks south: screen right is towards the west.
    for trace, base, height, scale in [
        (
            [
                (210, 248, 357, 0.58),
                (195, 255, 356, 0.67),
                (176, 266, 347, 0.62),
                (159, 277, 339, 0.53),
                (141, 291, 325, 0.40),
                (135, 303, 317, 0.18),
                (130, 301, 320, 0.21),
                (120, 303, 317, 0.19),
                (115, 308, 314, 0.10),
            ],
            (0.48, 2.20, 3.03),
            2.61,
            0.031,
        ),
        (
            [
                (211, 198, 289, 0.55),
                (197, 200, 281, 0.59),
                (173, 207, 271, 0.54),
                (150, 211, 257, 0.47),
                (129, 222, 258, 0.37),
                (116, 242, 255, 0.18),
                (110, 237, 257, 0.24),
                (102, 241, 255, 0.21),
                (96, 245, 251, 0.11),
            ],
            (1.86, 2.60, 3.15),
            3.13,
            0.028,
        ),
        (
            [
                (209, 335, 485, 0.55),
                (195, 345, 485, 0.61),
                (176, 372, 467, 0.53),
                (160, 390, 450, 0.41),
                (152, 407, 441, 0.26),
                (148, 417, 430, 0.15),
            ],
            (-3.20, 1.48, 3.12),
            1.72,
            0.031,
        ),
    ]:
        loft(m, "reverse", trace, base, height, scale, (-1, 0), folds=0.12)


def stone_face(m, lower, upper, repeats=8, texture="granite"):
    """Break the circular courses into blocks. Each gets a full grain sample."""
    for lo, hi in zip(
        np.array_split(np.arange(len(lower) - 1), repeats), np.array_split(np.arange(1, len(lower)), repeats)
    ):
        if not len(lo):
            continue
        span = np.r_[lo, hi[-1]]
        u = np.linspace(3, 235 if texture == "granite" else 175, len(span))
        uv = [np.column_stack((u, np.full(len(u), y))) for y in (114, 4)]
        m.patch([lower[span], upper[span]], uv, texture)


def rim(m, rings, repeats):
    for lower, upper in zip(rings, rings[1:]):
        stone_face(m, lower, upper, repeats)


def pedestal(m):
    # The stepped southern approach follows the oval, with the two urns
    # standing at the ends of the stairs. Sink the first riser into the paving.
    angle = np.linspace(0, TAU, 97)
    c, s = np.cos(angle), np.sin(angle)

    def ellipse(inset, z):
        return np.column_stack((-0.35 + (11.35 - inset) * c, 0.66 + (9.33 - inset) * s, np.full(len(s), z)))

    rings = [ellipse(0, -0.70), ellipse(0, 0.12)]
    for i in range(5):
        inset = (i + 1) * 0.44
        rings.extend([ellipse(inset, 0.12 + i * 0.165), ellipse(inset, 0.12 + (i + 1) * 0.165)])
    rings.append(ellipse(2.55, 0.945))
    rim(m, rings, 24)
    stone_face(m, rings[-1], ellipse(8.9, 0.945), 12)
    centre = np.tile((-0.35, 0.66, 0.945), (len(s), 1))
    stone_face(m, ellipse(8.9, 0.945), centre, 4)

    # Survey sections give the lean of the oval base towards its north-east end.
    # Each end drops below the inscribed central wall; the bronze spills over it.
    profile = np.array(
        [
            (-7.04, 0.66, 0.72, 3.02),
            (-6.80, -0.10, 1.78, 3.06),
            (-6.28, -0.66, 2.69, 3.10),
            (-5.22, -1.29, 3.59, 3.10),
            (-4.10, -1.63, 4.05, 3.10),
            (-3.96, -1.72, 4.16, 3.24),
            (-3.70, -1.98, 4.27, 3.86),
            (-3.53, -2.10, 4.33, 4.08),
            (-2.75, -2.40, 4.67, 4.17),
            (-1.50, -2.63, 4.93, 4.23),
            (0, -2.72, 5.12, 4.27),
            (1.75, -2.43, 5.14, 4.18),
            (3.04, -1.93, 5.13, 4.02),
            (3.79, -1.61, 5.09, 3.86),
            (4.13, -1.38, 5.0, 3.54),
            (4.28, -1.20, 4.94, 3.26),
            (5.35, -0.73, 4.58, 3.24),
            (6.27, -0.18, 3.95, 3.23),
            (6.69, 0.53, 3.27, 3.22),
            (6.91, 1.54, 2.48, 3.18),
            (6.95, 2.01, 2.10, 3.16),
        ]
    )
    x, front, back, high = profile.T
    # The south face rises in the middle; the rear carries a lower, continuous inscription.
    north_high = np.minimum(high, 3.24)
    crown_y = front + (back - front) * 0.44

    def side(xs, ys, zs, forward):
        top = np.column_stack((xs, ys, zs))
        bottom = top.copy()
        bottom[:, 2] = 0.94
        joint = bottom.copy()
        joint[:, 2] = 1.90
        mid = joint.copy()
        mid[1:-1, 1] += 0.04 if forward else -0.04
        mid[:, 2] += 0.045
        if not forward:
            top, bottom, joint, mid = [a[::-1] for a in (top, bottom, joint, mid)]
        rim(m, [bottom, joint, mid, top], 8)

    # Leave the carved face open for the photographic relief.
    left, right = 6, 14
    side(x[: left + 1], front[: left + 1], high[: left + 1], True)
    side(x[right:], front[right:], high[right:], True)
    # The rear has its own dedication cut into the upper course.
    side(x[:3], back[:3], north_high[:3], False)
    side(x[-3:], back[-3:], north_high[-3:], False)
    nx, ny, nh = x[2:-2][::-1], back[2:-2][::-1], north_high[2:-2][::-1]
    frac = (nx[0] - nx) / (nx[0] - nx[-1])
    rear_base = np.column_stack((nx, ny, np.full(len(nx), 0.945)))
    rear_top = np.column_stack((nx, ny, nh))
    u = 80 + 470 * frac
    m.patch(
        [rear_base, rear_top],
        [np.column_stack((u, 300 - 7 * frac)), np.column_stack((u, 220 - 7 * frac))],
        "dedication",
    )
    xs, ys, hs = x[left : right + 1], front[left : right + 1], high[left : right + 1]
    frac = (xs - xs[0]) / (xs[-1] - xs[0])
    vtop = np.interp(frac, [0, 0.10, 0.30, 0.55, 0.78, 1], [487, 467, 461, 457, 467, 491])
    wall = []
    uv = []
    for t in (0, 0.24, 0.45, 0.68, 0.90, 1):
        wall.append(
            np.column_stack(
                (xs, ys - 0.055 * np.sin(t * math.pi) * np.sin(frac * math.pi), 0.945 + t * (hs - 0.945))
            )
        )
        u = (374 + 619 * frac) * (1 - t) + (413 + 549 * frac) * t
        uv.append(np.column_stack((u, 693 + t * (vtop - 693))))
    m.patch(wall, uv, "relief")
    south = np.column_stack((x, front, high))
    ridge = np.column_stack((x, crown_y, high))
    north = np.column_stack((x, back, north_high))
    stone_face(m, south, ridge, 9)
    stone_face(m, ridge, north, 9)
    for k in (0, -1):
        a, b = (north[k], south[k]) if k == 0 else (south[k], north[k])
        p = np.array((a, b))
        bottom = p.copy()
        bottom[:, 2] = 0.94
        stone_face(m, bottom, p, 1)

    # The cast pyre and drapery bind the figures into one group. The granite
    # shelf remains exposed around the casting, especially at the eastern end.
    px = np.linspace(-6.86, 6.73, 80)
    f = np.interp(px, x, front)
    b = np.interp(px, x, back)
    z = np.interp(px, x, high)
    zn = np.interp(px, x, north_high)
    across = np.linspace(0, 1, 27)
    points, uv = [], []
    for t in across:
        v = 0.07 + 0.86 * t
        y = f + (b - f) * v
        stone = z + (zn - z) * max(0, (v - 0.44) / 0.56)
        wave = np.sin(np.pi * t) ** 0.7 * np.clip((px + 6.86) * (6.73 - px) / 5, 0, 1)
        spine = 0.13 + 0.13 * np.cos(0.9 * px + 6 * t) ** 4 + 0.07 * np.sin(1.2 * px - 10 * t) ** 6
        spine += 0.57 * np.exp(-((px - 3.05) ** 2 / 5.4 + (y - 2.22) ** 2 / 1.1))
        spine += 0.80 * np.exp(-((px + 1.70) ** 2 / 2.2 + (y - 0.12) ** 2 / 1.7))
        points.append(np.column_stack((px, y, stone + 0.025 + wave * spine)))
        uv.append(np.column_stack((4 + np.linspace(0, 171, len(px)), np.full(len(px), 3 + 171 * t))))
    m.patch(points, uv, "bronze")

    # Low bowls on square stone piers mark the two ends of the fan of steps.
    for sign in (-1, 1):
        cx, cy = sign * 10.1 - 0.33, -2.35
        az = np.linspace(0, TAU, 33)
        circle = np.stack((np.cos(az), np.sin(az)), axis=1)
        square = circle / np.max(np.abs(circle), axis=1)[:, None]

        def ring(shape, r, z):
            return np.column_stack((np.array((cx, cy)) + shape * r, np.full(len(az), z)))

        rim(
            m,
            [
                ring(square, 0.64, -0.2),
                ring(square, 0.64, 0.94),
                ring(square, 0.55, 1.03),
                ring(square, 0.48, 1.36),
                ring(square, 0.55, 1.43),
                ring(circle, 0.36, 1.43),
                ring(circle, 0.34, 1.57),
                ring(circle, 0.69, 1.66),
                ring(circle, 0.79, 1.80),
                ring(circle, 0.77, 1.86),
                ring(circle, 0.64, 1.85),
                ring(circle, 0.24, 1.67),
                ring(circle, 0.001, 1.67),
            ],
            4,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--photos", type=Path)
    args = parser.parse_args()
    model = Model()
    pedestal(model)
    sculpture(model)
    if args.photos:
        photo_atlas(model, args.photos)
    model.save()
