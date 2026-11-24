"""Small silhouette models of the Trigas of Victory and Schnirch's loggia figures."""

import math

import numpy as np


def length(v):
    return v / np.linalg.norm(v)


def sweep(mesh, centres, widths, depths, material, sides=8, fold=0):
    """Elliptical sections along a limb or a drape, with shared curved normals."""
    p = np.array(centres, dtype=float)
    rings = []
    for i, (c, w, d) in enumerate(zip(p, widths, depths)):
        axis = length(p[min(i + 1, len(p) - 1)] - p[max(0, i - 1)])
        across = length(np.cross((0, 1, 0) if abs(axis[1]) < 0.80 else (0, 0, 1), axis))
        if rings and across @ previous < 0:
            across = -across
        previous = across
        along = np.cross(axis, across)
        ring = []
        for j in range(sides):
            t = j * math.tau / sides
            f = 1 + fold * math.cos(5 * t + 0.4 * i)
            ring.append(c + f * (across * w * math.cos(t) + along * d * math.sin(t)))
        rings.append(np.array(ring))
    for i in range(len(rings) - 1):
        for j in range(sides):
            k = (j + 1) % sides
            ids = [(i, j), (i, k), (i + 1, k), (i + 1, j)]
            pts = [rings[a][b] for a, b in ids]
            normals = [
                length(
                    np.cross(
                        rings[a][(b + 1) % sides] - rings[a][(b - 1) % sides],
                        rings[min(a + 1, len(rings) - 1)][b] - rings[max(a - 1, 0)][b],
                    )
                )
                for a, b in ids
            ]
            mesh.face(pts, material, normals=normals)
    mesh.face(rings[0][::-1], material)
    mesh.face(rings[-1], material)


def figure(m, base, size, pose, material):
    """Draped standing figures. The hem, head, bent arms and attributes read in profile."""

    def shape(points, w, d=None, sides=8, fold=0):
        sweep(
            m,
            base + np.array(points) * size,
            np.array(w) * size,
            np.array(d or w) * size,
            material,
            sides,
            fold,
        )

    sway = 0.08 if pose % 2 else -0.08
    shape(
        [(0, 0, 0), (0, 0.01, 0.10), (sway, -0.01, 0.72), (sway, 0, 1.09), (0, 0.02, 1.45), (0, 0, 1.55)],
        [0.35, 0.37, 0.22, 0.20, 0.28, 0.13],
        [0.24, 0.27, 0.17, 0.16, 0.17, 0.13],
        12,
        0.13,
    )
    shape(
        [(0, 0.02, 1.47), (0, 0.01, 1.58), (0, 0.05, 1.66), (0, 0.025, 1.80), (0, 0, 1.88)],
        [0.11, 0.095, 0.14, 0.14, 0.06],
        [0.10, 0.095, 0.14, 0.13, 0.065],
    )
    shape([(0, 0.135, 1.76), (0, 0.177, 1.68), (0, 0.14, 1.66)], [0.035, 0.04, 0.025], sides=5)
    for hand in (-1, 1):
        high = hand == (1 if pose % 2 else -1)
        wrist = (hand * 0.39, 0.16, 1.58 if high else 0.91)
        elbow = (hand * 0.36, 0.03, 1.14 if high else 1.17)
        shape([(hand * 0.22, 0, 1.46), elbow, wrist], [0.11, 0.082, 0.059], sides=7)
        shape(
            [wrist, (wrist[0] + hand * 0.025, 0.16, wrist[2] + (0.11 if high else -0.11))],
            [0.069, 0.048],
            sides=6,
        )


def horse(m, base, stagger):
    def body(points, w, d=None, sides=8):
        sweep(m, base + np.array(points), w, d or w, "bronze", sides)

    body(
        [(0, -1.15, 1.83), (0, -0.9, 1.91), (0, -0.35, 2.12), (0, 0.46, 2.38), (0, 0.75, 2.69)],
        [0.24, 0.46, 0.49, 0.46, 0.30],
        [0.33, 0.55, 0.60, 0.58, 0.36],
        10,
    )
    body(
        [(0, 0.44, 2.45), (0, 0.64, 2.85), (0, 0.80, 3.31), (0, 1.03, 3.53)],
        [0.38, 0.34, 0.21, 0.20],
        [0.42, 0.39, 0.25, 0.21],
        10,
    )
    body(
        [(0, 0.78, 3.49), (0, 1.08, 3.51), (0, 1.41, 3.32), (0, 1.66, 3.23)],
        [0.16, 0.21, 0.14, 0.15],
        [0.22, 0.28, 0.18, 0.12],
    )
    for s in (-1, 1):
        body([(s * 0.12, 0.87, 3.65), (s * 0.16, 0.83, 3.98)], [0.095, 0.017], [0.065, 0.018], 6)
        # Hind legs take the load; the forelegs lift at different stages of the stride.
        body(
            [
                (s * 0.29, -0.82, 1.99),
                (s * 0.32, -0.54, 1.28),
                (s * 0.34, -1.02, 0.74),
                (s * 0.32, -0.78, 0.11),
            ],
            [0.24, 0.15, 0.105, 0.085],
            sides=7,
        )
        body([(s * 0.32, -0.78, 0.19), (s * 0.32, -0.71, 0.03)], [0.12, 0.14], [0.13, 0.17], 6)
        advance = 0.27 * s + stagger
        body(
            [
                (s * 0.29, 0.49, 2.47),
                (s * 0.32, 0.63, 1.93),
                (s * 0.32, 1.16 + advance, 1.66),
                (s * 0.34, 1.04 + advance, 1.12 + advance * 0.35),
            ],
            [0.22, 0.14, 0.11, 0.08],
            sides=7,
        )
        body(
            [
                (s * 0.34, 1.04 + advance, 1.18 + advance * 0.35),
                (s * 0.34, 1.02 + advance, 1.04 + advance * 0.35),
            ],
            [0.11, 0.135],
            sides=6,
        )
    body(
        [(0, -0.99, 2.13), (0, -1.40, 1.72), (0.10, -1.63, 1.01), (0.22, -1.88, 0.70)],
        [0.13, 0.19, 0.125, 0.045],
        [0.17, 0.23, 0.17, 0.055],
    )
    # Mane follows the nape, visible against the sky.
    body(
        [(0, 0.87, 3.66), (0, 0.64, 3.47), (0, 0.49, 3.13), (0, 0.32, 2.73)], [0.09, 0.11, 0.13, 0.12], sides=6
    )


def sculpture(m):
    for x, y in [(-14.94, -4.75), (15.78, -4.35)]:
        base = np.array([x, y, 27.95])
        for i in (-1, 0, 1):
            horse(m, base + np.array([i * 1.45, 1.05 - 0.32 * abs(i), 0]), i * 0.17)
        # The wheels are open rings. Each has four cast spokes.
        for s in (-1, 1):
            c = base + [s * 1.20, -1.68, 0.94]
            for i in range(16):
                t, u = i * math.tau / 16, (i + 1) * math.tau / 16

                def wheel(angle, r):
                    return c + np.array([0, math.cos(angle) * r, math.sin(angle) * r])

                wall = [wheel(t, 0.75), wheel(t, 0.96), wheel(u, 0.96), wheel(u, 0.75)]
                m.face(wall, "patina")
                m.face(wall[::-1], "bronze")
                if i % 4 == 0:
                    sweep(m, [c, wheel(t, 0.81)], [0.075, 0.065], [0.075, 0.065], "bronze", 5)
        m.box(x - 1.23, y - 2.67, x + 1.23, y - 0.67, 28.77, 29.5, "bronze")
        figure(m, base + [0, -1.72, 1.50], 2.42, 1, "patina")
        # Victoria's two swept wings rise behind her shoulders.
        for s in (-1, 1):
            sweep(
                m,
                base
                + np.array(
                    [
                        (s * 0.35, -1.8, 4.65),
                        (s * 0.67, -2.25, 5.22),
                        (s * 1.06, -2.96, 6.02),
                        (s * 1.38, -3.39, 6.64),
                    ]
                ),
                [0.17, 0.35, 0.24, 0.025],
                [0.17, 0.28, 0.18, 0.025],
                "bronze",
                8,
            )
        sweep(
            m,
            base + np.array([(0.93, -1.33, 5.3), (1.04, -1.28, 6.86), (1.15, -1.23, 7.85)]),
            [0.085, 0.064, 0.032],
            [0.085, 0.064, 0.032],
            "patina",
            6,
        )
    # Apollo and the muses stand on the parapet of the projecting north loggia.
    for i, x in enumerate(np.linspace(-11.6, 11.6, 10)):
        m.box(x - 0.46, 4.17, x + 0.46, 5.08, 23.54, 24.02, "trim")
        figure(m, np.array([x, 4.61, 24.02]), 1.70, i, "stone")
