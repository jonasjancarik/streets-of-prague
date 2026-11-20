"""Recessed fascias, lighting units and plate plinths for the close street sedan."""

import math
from mathutils import Vector
from sedan_surfaces import lerp, smooth


def ends(mesh, cap, cap_top, sidepoint):
    def skin(s, u, z, d=0):
        return Vector(cap(s, math.sin(u * math.pi / 2), z, d))

    def run(mat, points, r=0.006, sides=8):
        mesh.tube(mat, points, r, sides)

    headlamp = None
    for s in (1, -1):
        normal = lambda u, v: (s, 0, 0.04)

        def mid(u):
            return math.sin(abs(u) * math.pi / 2)

        def low0(u):
            return 0.248 + 0.04 * mid(u) ** 2

        def low1(u):
            return (0.452 if s > 0 else 0.363) + 0.023 * mid(u) ** 2

        def upper0(u):
            return (0.566 + 0.102 * mid(u) ** 1.6) if s > 0 else (0.762 + 0.058 * mid(u) ** 1.5)

        def upper1(u):
            return (0.733 + 0.018 * mid(u) ** 2) if s > 0 else (0.874 + 0.027 * mid(u) ** 2)

        def height(u):
            return cap_top(s, math.sin(u * math.pi / 2))

        def band(mat, a, b, bot, top, depth=0, cols=18, rows=3):
            def at(i, j):
                u = lerp(a, b, i)
                return skin(s, u, lerp(bot(u), top(u), j), depth)

            mesh.patch(
                mat,
                cols,
                rows,
                at,
                lambda i, j: (
                    s * math.cos(lerp(a, b, i) * math.pi / 2),
                    math.sin(lerp(a, b, i) * math.pi / 2),
                    0.03,
                ),
            )

        # Cut apertures out of the bumper skin. The four return faces reach the
        # recessed back: the grille blades and projector bowls sit in a cavity.
        def socket(a, b, bot, top, depth, back, lip):
            def face(i, j, layer):
                u = lerp(a, b, i)
                return skin(s, u, lerp(bot(u), top(u), j), layer)

            def at(i, j, layer):
                # Rounded stamping corners and sloping cheeks catch a thin
                # highlight before the full depth of the reveal.
                k = 1 - min(1, min(j, 1 - j) / 0.21)
                corner = 0.044 * (1 - math.sqrt(1 - k * k))
                central = a < 0 < b
                taper = (0.071 * (1 - j) if top == upper1 else 0.079 * j) if central else 0.030 * (1 - j)
                inset = 0.012 + corner + taper
                return face(lerp(inset, 1 - inset, i), lerp(0.020, 0.980, j), layer)

            mesh.patch(back, 16, 3, lambda i, j: at(i, j, -depth), normal)
            for edge, direction in [
                (lambda t: (t, 0), (0, 0, 1)),
                (lambda t: (t, 1), (0, 0, -1)),
                (lambda t: (0, t), (0, 1, 0)),
                (lambda t: (1, t), (0, -1, 0)),
            ]:
                mesh.patch(
                    "Paint", 18, 3, lambda u, v: face(*edge(u), 0).lerp(at(*edge(u), -0.003), v), normal
                )
                mesh.patch("Graphite", 16, 2, lambda u, v: at(*edge(u), lerp(0.001, -depth, v)), direction)
                if lip:
                    run(lip, [at(*edge(j / 18), 0.002) for j in range(19)], 0.0037, 6)
            return at

        starts = [-1, -0.92, -0.82, -0.52, -0.40, -0.32, 0, 0.32, 0.40, 0.52, 0.82, 0.92, 1]
        lower_holes = [(-0.4, 0.4), (-0.82, -0.52), (0.52, 0.82)] if s > 0 else []
        lamps = [(-0.988, -0.40), (0.40, 0.988)] if s > 0 else [(-0.992, -0.29), (0.29, 0.992)]
        upper_holes = lamps + ([(-0.32, 0.32)] if s > 0 else [])
        bounds = sorted(set(starts + [v for interval in upper_holes + lower_holes for v in interval]))
        for a, b in zip(bounds, bounds[1:]):
            u = (a + b) / 2
            cols = max(2, math.ceil((b - a) * 30))
            band("Graphite", a, b, lambda k: 0.185 + 0.060 * mid(k) ** 2, low0, -0.002, cols)
            if not any(lo < u < hi for lo, hi in lower_holes):
                band("Paint" if s > 0 else "Graphite", a, b, low0, low1, cols=cols)
            band("Paint", a, b, low1, upper0, cols=cols, rows=6)
            if not any(lo < u < hi for lo, hi in upper_holes):
                band("Paint", a, b, upper0, upper1, cols=cols)
            band("Paint", a, b, upper1, height, cols=cols, rows=5)
        for a, b in lower_holes + ([(-0.32, 0.32)] if s > 0 else []):
            upper = (a, b) == (-0.32, 0.32)
            bot, top = (upper0, upper1) if upper else (low0, low1)
            depth = 0.052 if upper else 0.065
            at = socket(a, b, bot, top, depth, "Intake", "Nickel" if upper else "Graphite")
            if upper or abs(a) > 0.45:
                for v in [0.24, 0.49, 0.74] if upper else [0.30, 0.65]:
                    mesh.patch(
                        "Graphite",
                        20,
                        3,
                        lambda i, j: at(
                            0.025 + 0.95 * i, v + 0.066 * j, -0.031 + 0.021 * math.sin(math.pi * j)
                        ),
                        normal,
                    )
                    if upper:
                        run(
                            "Smoked",
                            [at(0.03 + 0.94 * j / 20, v + 0.06, -0.018) for j in range(21)],
                            0.0032,
                            5,
                        )
            else:
                # Open diamond lattice in front of the dark radiator.
                for tilt in [-1, 1]:
                    for k in range(-3, 19):
                        path = []
                        for j in range(21):
                            v = 0.055 + 0.89 * j / 20
                            u = (k + tilt * 1.8 * v) / 16
                            if 0.015 < u < 0.985:
                                path.append(at(u, v, -0.029))
                        if len(path) > 1:
                            run("Graphite", path, 0.004, 5)
        for a, b in lamps:
            at = socket(a, b, upper0, upper1, 0.046, "Frit" if s > 0 else "Ruby", "Graphite")
            side = 1 if a > 0 else -1
            if s > 0:
                for c, r in [(0.44, 0.040), (0.72, 0.030)]:
                    ci = c if side > 0 else 1 - c
                    u = lerp(a, b, ci)
                    q = math.sin(u * math.pi / 2)
                    z = lerp(upper0(u), upper1(u), 0.45)

                    if side > 0 and c == 0.44:
                        headlamp = tuple(cap(1, q, z, 0.006))

                    def optic(theta, rad, depth):
                        return cap(
                            s, q + side * rad * math.cos(theta) / 0.81, z + rad * math.sin(theta), depth
                        )

                    for r0, r1, d0, d1, mat in [
                        (r * 1.18, r, -0.013, -0.007, "Nickel"),
                        (r, r * 0.65, -0.007, -0.032, "Reflector"),
                        (r * 0.65, r * 0.48, -0.032, -0.023, "Smoked"),
                        (r * 0.48, r * 0.05, -0.023, -0.012, "Lamp"),
                    ]:
                        mesh.patch(
                            mat,
                            24,
                            3,
                            lambda i, j: optic(math.tau * i, lerp(r0, r1, j), lerp(d0, d1, j)),
                            (1, 0, 0),
                        )
                # A continuous light guide along the brow and a short outboard return.
                run(
                    "Lamp",
                    [at(j / 28, 0.83 - 0.13 * (j / 28 - 0.5) ** 2, -0.009) for j in range(1, 28)],
                    0.006,
                    8,
                )
                k = 0.965 if side > 0 else 0.035
                run("Lamp", [at(k, 0.81, -0.009), at(k, 0.52, -0.01)], 0.005, 6)
                for j in range(5):
                    k = 0.78 + j * 0.032 if side > 0 else 0.22 - j * 0.032
                    run("AmberCell", [at(k, 0.21, -0.021), at(k, 0.43, -0.021)], 0.0036, 6)
            else:
                for v in [0.28, 0.69]:
                    run(
                        "Tail",
                        [
                            at(0.027 + 0.946 * j / 24, v + 0.13 * (j / 24 - 0.5) ** 2, -0.009)
                            for j in range(25)
                        ],
                        0.011,
                        8,
                    )
                for j in range(7):
                    k = 0.27 + j * 0.064
                    run("LensRed", [at(k, 0.29, -0.022), at(k + 0.029, 0.66, -0.022)], 0.006, 6)
            mesh.patch(
                "LensCover",
                22,
                5,
                lambda i, j: at(i, j, 0.002),
                lambda i, j: (s, math.sin(lerp(a, b, i) * math.pi / 2), 0.1),
            )
        # Wrap the lamp tip onto the front wing and rear quarter. The opening
        # narrows towards its end, preserving an uninterrupted shoulder line.
        for side in [-1, 1]:
            edge = cap(s, 1, upper1(1))[0]

            def wing(u, v, depth):
                x = edge - s * u * (0.255 if s > 0 else 0.335)
                bottom = upper0(1) + (0.068 if s > 0 else 0.087) * u
                h = (upper1(1) - upper0(1)) * (1 - 0.92 * smooth(u))
                return sidepoint(x, lerp(bottom, bottom + h, v), side, depth)

            for mat, offset in [("Graphite", 0.002), ("Smoked" if s > 0 else "Ruby", 0.005)]:
                mesh.patch(mat, 16, 3, lambda u, v: wing(u, v, offset), (0, side, 0.05))
            run("Lamp" if s > 0 else "Tail", [wing(j / 22, 0.81, 0.008) for j in range(22)], 0.0058)
            if s < 0:
                run("Tail", [wing(j / 22, 0.35, 0.009) for j in range(19)], 0.006)
            else:
                run("AmberCell", [wing(0.58 + j * 0.019, 0.47, 0.009) for j in range(15)], 0.005)
        # A break between the bumper cover and the bonnet or deck lid, formed
        # along the same rolled leading edge as the steel skin.
        run(
            "Graphite",
            [skin(s, -0.72 + 1.44 * j / 50, height(-0.72 + 1.44 * j / 50) - 0.017, 0.002) for j in range(51)],
            0.0032,
        )
        # The boot shutline drops between the inner lamp and the outer wing.
        if s < 0:
            for side in [-1, 1]:
                path = [
                    skin(s, side * lerp(0.40, 0.28, j / 12), lerp(0.88, 0.53, j / 12), 0.002)
                    for j in range(13)
                ]
                run("Graphite", path, 0.003)
            run("Graphite", [skin(s, lerp(-0.28, 0.28, j / 20), 0.531, 0.002) for j in range(21)], 0.003)
            # Rolled exhaust outlet set into the lower dark valance.
            x0 = cap(-1, 0.54, 0.252)[0]
            for rad, depth, mat in [(0.052, 0.018, "Nickel"), (0.042, 0.020, "Intake")]:
                mesh.patch(
                    mat,
                    20,
                    3,
                    lambda u, v: (
                        x0 - depth * v,
                        0.465 + rad * v * math.cos(math.tau * u),
                        0.254 + 0.65 * rad * v * math.sin(math.tau * u),
                    ),
                    (-1, 0, 0),
                )
            for side in [-1, 1]:
                band(
                    "LensRed",
                    side * 0.53,
                    side * 0.76,
                    lambda u: 0.39 + 0.026 * mid(u),
                    lambda u: 0.411 + 0.025 * mid(u),
                    0.004,
                    12,
                    2,
                )
        z = 0.508 if s > 0 else 0.637
        x = cap(s, 0, z)[0]
        mesh.box("Rubber", (x + s * 0.002, 0, z), (0.032, 0.535, 0.132))
        # One outward-facing plate at each end; the game lays its persistent
        # registration glyphs on these two planes.
        mesh.patch(
            "Plate", 1, 1, lambda u, v: (x + s * 0.020, (u - 0.5) * 0.509, z + (v - 0.5) * 0.109), (s, 0, 0)
        )
        mesh.patch(
            "EUBlue",
            1,
            1,
            lambda u, v: (x + s * 0.021, -s * (0.215 + 0.039 * u), z + (v - 0.5) * 0.107),
            (s, 0, 0),
        )
        # Painted bumper sensors and a restrained lower splitter.
        for q in [-0.79, -0.42, 0.42, 0.79]:
            p = Vector(cap(s, q, 0.491 + 0.019 * abs(q), 0.002))
            mesh.ellipsoid("Graphite", p, (0.003, 0.010, 0.010), 12, 4)
        run(
            "Smoked",
            [
                skin(s, -0.87 + 1.74 * j / 46, 0.220 + 0.039 * mid(-0.87 + 1.74 * j / 46) ** 2, 0.003)
                for j in range(47)
            ],
            0.006,
        )
    return headlamp
