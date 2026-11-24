"""The square-facing elevations of Týn and St Nicholas, with freestanding roof silhouettes."""

import math
import numpy as np
from craft import at, edges, lathe, rod, finial, rect, drum, band, panel, shell

TYN_PANELS = ("tyn-belfry", "tyn-lower", "tyn-gable", "tyn-tracery")
NICHOLAS_PANELS = (
    "nicholas-portal",
    "nicholas-tower",
    "nicholas-bell",
    "nicholas-bay",
    "nicholas-drum",
    "pediment",
)


def tyn(m, survey):
    c = survey[:, :, :3].mean(1)
    towers = (c[:, 1] < -4.3) & ((c[:, 0] < -3.15) | (c[:, 0] > 4.30))
    shell(m, survey[~towers], 51)
    shell(m, survey[towers], 34.75)
    for x, y, w, tip in [(-9.29, -10.56, 9.43, 78.9), (10.63, -10.66, 9.94, 79.9)]:
        ring = rect(x, y, w, 9.58)
        drum(m, ring, 34.60, 50.42, "sandstone")
        for a, b in edges(ring):
            direction = (b - a) / np.linalg.norm(b - a)
            out = np.array((direction[1], -direction[0])) * 0.045
            m.wall(a + out, b + out, 35.45, 49.92, "tyn-belfry")
        for zz, hh, extra in [
            (34.50, 0.48, 0.42),
            (35.02, 0.20, 0.63),
            (49.94, 0.26, 0.30),
            (50.20, 0.43, 0.64),
            (50.68, 0.22, 0.48),
        ]:
            band(m, x, y, w + extra, 9.58 + extra, zz, hh)
        lathe(
            m,
            x,
            y,
            [
                (50.84, w * 0.676),
                (52.00, w * 0.49),
                (57.1, w * 0.337),
                (63.7, w * 0.228),
                (69.4, w * 0.137),
                (76.7, 0.35),
                (tip - 1.4, 0.08),
            ],
            "slate",
            8,
            math.pi / 8,
        )
        # Four corner watchtowers, and the four smaller turrets suspended
        # halfway up the octagonal spire.
        for tier in (0, 1):
            for i in range(4):
                a = math.pi / 4 + i * math.pi / 2 + (math.pi / 4 if tier else 0)
                distance = 2.65 if tier else w * 0.637
                xx, yy = x + distance * math.cos(a), y + distance * math.sin(a)
                z = 59.20 if tier else 47.05
                if not tier:
                    lathe(
                        m,
                        xx,
                        yy,
                        [(33.7, 0.36), (34.55, 0.77), (35.15, 0.64), (46.82, 0.60), (47.4, 0.84)],
                        "sandstone",
                        8,
                    )
                lathe(
                    m,
                    xx,
                    yy,
                    [
                        (z, 0.36),
                        (z + 0.75, 0.85),
                        (z + 1.08, 1.03),
                        (z + 3.0, 0.91),
                        (z + 3.25, 1.07),
                        (z + (11.2 if tier else 11.5), 0.055),
                    ],
                    "slate",
                    8,
                )
                for a2 in np.arange(4) * math.pi / 2:
                    dx, dy = math.cos(a2), math.sin(a2)
                    rod(
                        m,
                        (xx + 0.87 * dx, yy + 0.87 * dy, z + 1.05),
                        (xx + 0.87 * dx, yy + 0.87 * dy, z + 2.90),
                        0.095,
                        "carving",
                    )
                finial(m, xx, yy, z + (11.2 if tier else 11.5), 1.55)
        finial(m, x, y, tip - 1.45, 1.9)
    # The upper west wall is visible above the school. Replace the blue,
    # permanently shaded portion of the aerial bake with continuous stone bays.
    front_y = -16.52
    for cx, w in [(-9.29, 9.43), (10.63, 9.94)]:
        panel(m, cx - w / 2, cx + w / 2, front_y, 15.8, 35.25, "tyn-lower")
        for xx in (cx - w * 0.45, cx + w * 0.45):
            band(m, xx, front_y + 0.15, 0.62, 0.75, 16.1, 18.6, "sandstone")
        band(m, cx, front_y + 0.2, w + 0.2, 0.72, 33.8, 0.32)
    # Ashlar shoulders around the central pointed window.
    for a, b in [(-4.8, -3.25), (4.33, 5.65)]:
        panel(m, a, b, front_y, 17.3, 34.7, "tyn-belfry", (0.02, 0.20, 0.14, 0.83))
    # Carved western gable and its recessed rose/tracery window behind the Týn School.
    x = 0.54
    y = -16.56
    panel(m, x - 3.90, x + 3.90, y, 21.6, 34.4, "tyn-tracery")
    band(m, x, y + 0.37, 11.05, 1.25, 34.35, 0.56)
    lo, hi = 34.90, 46.1
    w = 5.42
    a, b, top = (x - w, y, lo), (x + w, y, lo), (x, y, hi)
    m.face([a, b, top], "tyn-gable", [(0.012, 0.995), (0.973, 0.995), (0.465, 0.025)])
    m.face([(x + w, y + 0.86, lo), (x - w, y + 0.86, lo), (x, y + 0.86, hi)], "sandstone")
    for sign in (-1, 1):
        rod(m, (x + sign * w, y, lo), (x, y, hi), 0.125, "carving")
        for j, (offset, h) in enumerate([(5.28, 4.8), (3.8, 4.5), (2.44, 4.3), (1.12, 4.25)]):
            z = lo + (hi - lo) * (1 - offset / w) - 0.12
            lathe(
                m,
                x + sign * offset,
                y + 0.12,
                [(z, 0.21), (z + h * 0.58, 0.16), (z + h * 0.63, 0.25), (z + h * 0.83, 0.15), (z + h, 0.03)],
                "sandstone",
                6,
            )
    rod(m, (x, y, hi - 0.2), (x, y, hi + 2.5), 0.13, "iron")
    rod(m, (x - 0.98, y, hi + 1.65), (x + 0.98, y, hi + 1.65), 0.11, "iron")
    lathe(
        m,
        x,
        y - 0.38,
        [(35.48, 0.20), (35.62, 0.28), (36.25, 0.10), (36.32, 0.14), (36.86, 0.37), (37.07, 0.36)],
        "gold",
        12,
    )
    lathe(m, x, y - 0.38, [(37.03, 0.10), (37.23, 0.28), (37.45, 0.12), (37.50, 0.02)], "gold", 12)


def nicholas(m, survey):
    c = survey[:, :, :3].mean(1)
    dome = (c[:, 0] > -12.1) & (c[:, 0] < 5.5) & (c[:, 1] > -10.2) & (c[:, 1] < 8.1)
    shell(m, survey[dome], 21.7)
    shell(m, survey[~dome], 30.9)
    x, y = -3.24, -1.08
    drum_ring = np.array(
        [(x + 9.46 * math.cos(a), y + 9.46 * math.sin(a)) for a in (np.arange(8) + 0.5) * math.pi / 4]
    )
    drum(m, drum_ring, 21.55, 30.88, "plaster")
    for a, b in edges(drum_ring):
        outward = (a + b) * 0.5 - [x, y]
        outward *= 0.055 / np.linalg.norm(outward)
        m.face(
            [at(a + outward, 21.55), at(b + outward, 21.55), at(b + outward, 30.88), at(a + outward, 30.88)],
            "nicholas-drum" if outward[1] < -0.05 else "nicholas-bell",
            [(0.02, 0.98), (0.98, 0.98), (0.98, 0.01), (0.02, 0.01)],
        )
        for t in [0.07, 0.93]:
            xx, yy = a + t * (b - a)
            lathe(
                m,
                xx,
                yy,
                [(21.6, 0.32), (22.0, 0.37), (22.4, 0.30), (30.25, 0.28), (30.66, 0.41)],
                "cream",
                10,
            )
    m.course(drum_ring, (30.54, 0), (30.96, 0.24), "carving")
    # The south elevation has three projecting bays and two recessed links.
    # Each photographic bay is set on its surveyed plane, with returned sides.
    for x0, x1, y, h, tex in [
        (-22.25, -11.80, -14.47, 19.5, "nicholas-tower"),
        (-11.80, -10.18, -10.99, 15.6, "nicholas-bay"),
        (-10.18, 3.30, -14.54, 19.25, "nicholas-portal"),
        (3.30, 4.91, -10.91, 15.6, "nicholas-bay"),
        (4.91, 14.82, -14.51, 19.56, "nicholas-tower"),
    ]:
        m.box(x0, y + 0.05, x1, y + 0.65, -1.85, h, "cream")
        panel(m, x0, x1, y, -1.7, h, tex)
        for z, hh in [(1.43, 0.21), (h - 0.47, 0.28), (h - 0.10, 0.24)]:
            m.box(x0 - 0.12, y - 0.21, x1 + 0.12, y + 0.55, z, z + hh, "carving")
    # Monumental paired columns framing the central window. Keep the niches
    # and sculpture on the wall visible between the shafts.
    for xx in [-9.38, -7.85, 1.13, 2.65]:
        band(m, xx, -14.65, 1.36, 1.18, -0.05, 2.69, "carving")
        lathe(
            m,
            xx,
            -14.69,
            [
                (2.6, 0.60),
                (3.0, 0.69),
                (3.30, 0.59),
                (3.53, 0.50),
                (15.04, 0.38),
                (15.18, 0.52),
                (15.54, 0.61),
                (15.79, 0.62),
            ],
            "cream",
            14,
        )
    # Segmented pediments break the parapet over the doorway and outer pairs.
    for xx, w, z, rise in [(-8.10, 4.4, 18.80, 1.55), (1.18, 4.4, 18.80, 1.55), (-3.4, 5.02, 19.4, 2.1)]:
        for t0, t1 in zip(np.linspace(0, math.pi, 21), np.linspace(0, math.pi, 21)[1:]):
            a = (xx + w * 0.50 * math.cos(t0), -14.76, z + rise * math.sin(t0))
            b = (xx + w * 0.50 * math.cos(t1), -14.76, z + rise * math.sin(t1))
            # Solid curved pediment: project its photographed tympanum onto the
            # stone between the horizontal sill and the crown of the arch.
            pts = [(b[0], b[1], z - 0.18), (a[0], a[1], z - 0.18), a, b]
            uv = [((p[0] - xx) / w + 0.5, 0.94 - (p[2] - z) / rise * 0.69) for p in pts]
            m.face(pts, "pediment", uv)
            m.face([(p[0], p[1] + 0.42, p[2]) for p in pts[::-1]], "cream")
            rod(m, a, b, 0.17, "carving", 7)
        m.box(xx - w / 2, -14.84, xx + w / 2, -14.12, z - 0.28, z - 0.08, "carving")
    for x, y in [(-17.0, -9.46), (10.0, -9.13)]:
        # Bell chambers above the projecting side bays; chamfered corners
        # soften their transition to the copper roofs.
        ring = np.array(
            [
                (-3.15, -4.65),
                (3.15, -4.65),
                (4.56, -3.1),
                (4.56, 3.1),
                (3.15, 4.63),
                (-3.15, 4.63),
                (-4.56, 3.1),
                (-4.56, -3.1),
            ]
        ) + (x, y)
        drum(m, ring, 20.0, 31.03, "cream")
        for i, (a, b) in enumerate(edges(ring)):
            if i % 2 == 0:
                outward = np.array([b[1] - a[1], a[0] - b[0]])
                outward *= 0.16 / np.linalg.norm(outward)
                m.wall(a + outward, b + outward, 20.15, 30.82, "nicholas-bell")
            lathe(
                m,
                *a,
                [(20, 0.28), (20.54, 0.36), (21, 0.30), (30.36, 0.26), (30.58, 0.43), (30.88, 0.36)],
                "cream",
                10,
            )
        m.course(ring, (30.85, 0.04), (31.25, 0.28), "carving")
        lathe(
            m,
            x,
            y,
            [
                (31.19, 4.68),
                (31.73, 4.84),
                (32.05, 4.37),
                (32.57, 4.06),
                (33.12, 4.04),
                (33.58, 3.64),
                (34.25, 3.01),
                (35.20, 2.52),
                (35.72, 2.40),
            ],
            "copper",
            16,
            math.pi / 8,
        )
        # The copper lanterns have eight open round-headed arches.
        lantern = np.array(
            [(x + 2.18 * math.cos(a), y + 2.18 * math.sin(a)) for a in np.arange(8) * math.pi / 4]
        )
        for a, b in edges(lantern):
            lathe(m, *a, [(35.69, 0.28), (36.0, 0.34), (39.0, 0.24), (39.70, 0.37)], "seam", 8)
            for f, g in zip(np.linspace(0, 1, 9), np.linspace(0, 1, 9)[1:]):
                p, q = a + (b - a) * f, a + (b - a) * g
                zp = 38.48 + 0.70 * math.sin(f * math.pi)
                zq = 38.48 + 0.70 * math.sin(g * math.pi)
                face = [at(p, zp), at(q, zq), at(q, 39.77), at(p, 39.77)]
                m.face(face, "seam")
                m.face(face[::-1], "copper")
                rod(m, face[0], face[1], 0.075, "copper", 6)
        m.face([at(p, 39.78) for p in lantern[::-1]], "seam")
        lathe(
            m,
            x,
            y,
            [
                (39.70, 2.53),
                (40.02, 2.60),
                (40.42, 2.22),
                (40.88, 2.43),
                (41.52, 2.42),
                (42.16, 2.04),
                (42.96, 1.32),
                (43.75, 0.69),
                (44.34, 0.61),
                (45.26, 0.20),
            ],
            "copper",
            16,
        )
        finial(m, x, y, 45.20, 4.10, True)
    # Broad eight-sided copper dome, its raised seams and the smaller lantern.
    x, y = -3.24, -1.08
    profile = [
        (30.82, 9.02),
        (31.18, 9.27),
        (31.55, 8.91),
        (32.30, 8.53),
        (33.27, 7.80),
        (34.35, 6.81),
        (35.20, 5.54),
        (36.0, 4.10),
        (36.54, 2.94),
    ]
    lathe(m, x, y, profile, "copper", 24)
    for a in np.arange(16) * math.tau / 16:
        for (z, r), (zz, rr) in zip(profile, profile[1:]):
            rod(
                m,
                (x + r * math.cos(a), y + r * math.sin(a), z),
                (x + rr * math.cos(a), y + rr * math.sin(a), zz),
                0.055,
                "seam",
                5,
            )
    ring = np.array([(x + 2.65 * math.cos(a), y + 2.65 * math.sin(a)) for a in np.arange(8) * math.pi / 4])
    drum(m, ring, 36.5, 40.5, "cream")
    for a, b in edges(ring):
        mid = (a + b) / 2
        off = 0.04 * (mid - [x, y])
        m.wall(0.76 * a + 0.24 * b + off, 0.24 * a + 0.76 * b + off, 37.30, 39.94, "recess")
    lathe(
        m,
        x,
        y,
        [
            (40.41, 2.96),
            (40.83, 2.98),
            (41.05, 2.54),
            (41.68, 2.36),
            (42.25, 1.60),
            (43.23, 0.73),
            (44.06, 0.36),
            (44.52, 0.18),
        ],
        "copper",
        16,
    )
    finial(m, x, y, 44.42, 3.6, True)
