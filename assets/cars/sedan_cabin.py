"""A formed dashboard and upholstered seating for the sedan, in metres."""

import math
from mathutils import Vector
from sedan_surfaces import lerp


def cabin(mesh):
    for y in [-0.437, 0.437]:
        seat(mesh, 0.225, y, 0.49)
        # Seat buckle between the console and the inboard bolster.
        sign = 1 if y > 0 else -1
        for dy in [-0.143, 0.143]:
            mesh.box("SatinBlack", (0.18, y + dy, 0.391), (0.49, 0.031, 0.038))
        # Bound carpet mat in each front footwell.
        mesh.box("Carpet", (0.526, y, 0.369), (0.39, 0.45, 0.011))
        mesh.ellipsoid("Rubber", (0.025, y - sign * 0.254, 0.50), (0.038, 0.022, 0.052), 14, 6)
        mesh.box("Buckle", (0.025, y - sign * 0.254, 0.537), (0.044, 0.026, 0.014))
    for y in [-0.441, 0, 0.441]:
        seat(mesh, -0.695, y, 0.44 if y else 0.385, rear=True)
    # Top roll and passenger-side brow run across the cabin. The cluster rises
    # inside its own cowling, while the passenger sees a longer, lower shelf.
    rows = [
        (0.945, 0.884),
        (0.84, 0.916),
        (0.69, 0.917),
        (0.54, 0.889),
        (0.473, 0.844),
        (0.494, 0.791),
        (0.542, 0.750),
        (0.586, 0.692),
        (0.555, 0.574),
    ]

    def dash(j, u):
        q = 2 * u - 1
        x, z = rows[j]
        arc = 1 - q * q
        z += 0.031 * arc + 0.041 * math.exp(-(((q - 0.52) / 0.32) ** 2)) * math.exp(-(((j - 3) / 2.0) ** 2))
        return Vector((x + 0.045 * arc, q * 0.789, z))

    for j in range(len(rows) - 1):
        mesh.patch(
            "SoftTouch" if j < 5 else "DoorInsert",
            32,
            4,
            lambda u, v: dash(j, u).lerp(dash(j + 1, u), v),
            (-0.6, 0, 1 if j < 4 else -0.1),
        )
    mesh.tube("Smoked", [dash(5, j / 40) - Vector((0.003, 0, 0)) for j in range(41)], 0.006)
    for y in [-0.664, -0.134, 0.137, 0.666]:
        mesh.box("Intake", (0.505, y, 0.807), (0.042, 0.117, 0.049))
        for z in [0.793, 0.805, 0.818]:
            mesh.box("Smoked", (0.480, y, z), (0.016, 0.105, 0.004))
    # Shaded instrument binnacle and crystal. The printed dial faces are
    # mapped in the street material; the panel is dark when viewed from behind.
    # The driver's side of the binnacle is open: a visor can shade the
    # gauges without placing an opaque ellipsoid across them.
    mesh.patch(
        "Graphite",
        24,
        8,
        lambda u, v: (
            lerp(0.427, 0.64, v),
            0.437 + 0.188 * math.cos(math.pi * u),
            0.840 + 0.110 * math.sin(math.pi * u) - 0.018 * v,
        ),
        lambda u, v: (0, math.cos(math.pi * u), math.sin(math.pi * u)),
    )
    mesh.patch(
        "GaugeFace",
        24,
        4,
        lambda u, v: (
            0.435 + 0.020 * v,
            0.437 + (0.5 - u) * 0.323,
            0.844 + 0.091 * v * math.sqrt(1 - (0.93 * (2 * u - 1)) ** 2),
        ),
        (-1, 0, 0.2),
    )
    mesh.box("SatinBlack", (0.491, 0, 0.774), (0.040, 0.279, 0.13))
    mesh.patch(
        "DisplayFace",
        1,
        1,
        lambda u, v: (0.468 + 0.008 * v, (0.5 - u) * 0.242, 0.723 + 0.098 * v),
        (-1, 0, 0.1),
    )
    for y in [-0.071, 0.071]:
        # A readable physical rotary control under the centre screen.
        mesh.ellipsoid("Nickel", (0.483, y, 0.679), (0.015, 0.022, 0.022), 15, 6)
        mesh.ellipsoid("Graphite", (0.470, y, 0.679), (0.009, 0.017, 0.018), 15, 6)
    wheel(mesh)
    # The centre tunnel slopes towards the instrument panel, exposing the
    # selector and the stitched armrest between the two front seats.
    mesh.box("Graphite", (0.111, 0, 0.487), (0.845, 0.224, 0.200))
    mesh.ellipsoid("Upholstery", (-0.088, 0, 0.600), (0.193, 0.119, 0.056), 24, 9)
    mesh.ellipsoid("Smoked", (0.296, 0, 0.594), (0.144, 0.090, 0.012), 22, 6)
    mesh.tube("Nickel", [(0.279, 0, 0.593), (0.288, 0, 0.655)], 0.014, 10)
    mesh.ellipsoid("SoftTouch", (0.281, 0, 0.667), (0.044, 0.032, 0.026), 18, 6)
    for s in [-1, 1]:
        mesh.tube(
            "Nickel",
            [(0.065, s * 0.106, 0.592), (0.28, s * 0.105, 0.601), (0.461, s * 0.096, 0.640)],
            0.004,
            6,
        )
    # A solid rear parcel shelf closes the boot and supports two speaker grilles.
    mesh.patch(
        "Carpet",
        16,
        5,
        lambda u, v: (lerp(-1.60, -1.037, v), lerp(-0.75, 0.75, u), 0.923 + 0.025 * (1 - v)),
        (0, 0, 1),
    )
    for y in [-0.51, 0.51]:
        mesh.ellipsoid("SpeakerMesh", (-1.322, y, 0.938), (0.085, 0.103, 0.014), 16, 6)
    mesh.tube("SatinBlack", [(0.074, 0, 1.388), (0.163, 0, 1.303)], 0.015, 8)
    mesh.ellipsoid("Graphite", (0.177, 0, 1.290), (0.027, 0.121, 0.042), 24, 8)
    mesh.ellipsoid("MirrorGlass", (0.154, 0, 1.290), (0.006, 0.110, 0.034), 24, 8)


def seat(mesh, x, y, width, rear=False):
    w = width / 2

    def cushion(u, v):
        q = 2 * u - 1
        xx = x + lerp(-0.219, 0.24, v) - 0.029 * abs(q) ** 4 * max(0, 2 * v - 1)
        z = (
            0.499
            - 0.018 * abs(q) ** 6
            - 0.027 * max(0, (v - 0.81) / 0.19) ** 2
            + 0.020 * math.sin(v * math.pi)
            + 0.054 * math.exp(-(((abs(q) - 0.82) / 0.20) ** 2))
            - 0.017 * (1 - q * q) * math.sin(math.pi * v)
        )
        return Vector((xx, y + q * w * (0.91 + 0.09 * math.sin(math.pi * v)), z))

    for lo, hi, mat in [(0, 0.17, "Upholstery"), (0.17, 0.83, "Cloth"), (0.83, 1, "Upholstery")]:
        mesh.patch(mat, 10, 12, lambda u, v: cushion(lerp(lo, hi, u), v), (0, 0, 1))
    for point, out in [
        (lambda t: (t, 0), (-1, 0, 0)),
        (lambda t: (t, 1), (1, 0, 0)),
        (lambda t: (0, t), (0, -1, 0)),
        (lambda t: (1, t), (0, 1, 0)),
    ]:

        def edge(t, v):
            p = cushion(*point(t))
            p.z -= 0.102 * v
            p.y = y + (p.y - y) * (1 - 0.13 * v + 0.054 * math.sin(math.pi * v))
            p.x = x + (p.x - x) * (1 - 0.13 * v + 0.045 * math.sin(math.pi * v))
            return p

        mesh.patch("Upholstery", 16, 5, edge, out)

    def back(u, v):
        q = 2 * u - 1
        ww = w * (0.90 + 0.10 * math.sin(math.pi * v) - 0.23 * v**3)
        z = 0.485 + (0.518 if rear else 0.56) * v - 0.041 * v**3 * abs(q) ** 2
        xx = (
            x
            - 0.215
            - 0.117 * v
            + 0.040 * math.sin(math.pi * v)
            + (0.026 + 0.044 * math.sin(math.pi * v)) * abs(q) ** 2
        )
        return Vector((xx, y + q * ww, z))

    for lo, hi, mat in [(0, 0.17, "Upholstery"), (0.17, 0.83, "Cloth"), (0.83, 1, "Upholstery")]:
        mesh.patch(mat, 10, 14, lambda u, v: back(lerp(lo, hi, u), v), (1, 0, 0.1))

    def back_shell(u, v):
        p = back(u, v)
        p.x -= 0.085 - 0.025 * v
        p.y = y + (p.y - y) * 0.97
        return p

    mesh.patch("SoftTouch", 16, 10, back_shell, (-1, 0, 0))
    for point, out in [
        (lambda t: (t, 1), (0, 0, 1)),
        (lambda t: (0, t), (0, -1, 0)),
        (lambda t: (1, t), (0, 1, 0)),
    ]:
        mesh.patch("Upholstery", 16, 4, lambda u, v: back(*point(u)).lerp(back_shell(*point(u)), v), out)
    for u in [0.17, 0.83]:
        mesh.tube("Stitch", [back(u, j / 16) + Vector((0.0014, 0, 0)) for j in range(1, 16)], 0.0016, 5)
        mesh.tube("Stitch", [cushion(u, j / 16) + Vector((0, 0, 0.0014)) for j in range(1, 16)], 0.0017, 5)
    # Formed horizontal seams in the inset fabric.
    for v in [0.27, 0.44, 0.61, 0.78]:
        mesh.tube(
            "DoorInsert",
            [back(lerp(0.18, 0.82, j / 12), v) + Vector((0.001, 0, 0)) for j in range(13)],
            0.0021,
            5,
        )
    hx = x - 0.325
    hz = 1.133 if rear else 1.174
    for dy in [-0.063, 0.063]:
        mesh.tube("Nickel", [(hx, y + dy, hz - 0.154), (hx - 0.008, y + dy, hz - 0.027)], 0.006, 8)
    mesh.ellipsoid("Upholstery", (hx - 0.014, y, hz), (0.071, 0.137, 0.090), 24, 12)
    if not rear:
        mesh.tube(
            "DoorInsert",
            [
                back_shell(j / 16, 0.48) + Vector((-0.006, 0, -0.015 * math.sin(math.pi * j / 16)))
                for j in range(1, 16)
            ],
            0.0055,
        )


def wheel(mesh):
    # A raked, three-spoke wheel with a flattened lower rim and two stalks.
    cy, cz = 0.437, 0.789

    def at(y, z, depth=0):
        return Vector((0.347 + 0.32 * z + depth, cy + y, cz + z))

    ring = []
    for i in range(65):
        t = i * math.tau / 64
        y = 0.159 * math.cos(t)
        z = max(-0.137, 0.156 * math.sin(t))
        ring.append(at(y, z))
    mesh.tube("SoftTouch", ring, 0.016, 10)
    # Broad cast spokes curve out of the airbag carrier into the rim.
    for side in [-1, 1]:
        for layer, tone in [(0, "SoftTouch"), (0.006, "Smoked")]:

            def spoke(u, v):
                y = side * lerp(0.043, 0.151, u)
                z = lerp(-0.026 + 0.033 * u, 0.029 - 0.009 * u, v)
                if layer:
                    z = lerp(-0.024 + 0.031 * u, -0.016 + 0.030 * u, v)
                return at(y, z, 0.008 - 0.011 * math.sin(math.pi * v) - layer)

            mesh.patch(tone, 10, 4, spoke, (-1, 0, 0))
    mesh.patch(
        "SoftTouch",
        6,
        9,
        lambda u, v: at((u - 0.5) * lerp(0.078, 0.041, v), lerp(-0.027, -0.139, v), 0.004),
        (-1, 0, 0),
    )

    def pad(u, v):
        a = math.tau * u
        co, si = math.cos(a), math.sin(a)
        y = 0.074 * math.copysign(abs(co) ** 0.70, co) * v
        z = 0.052 * math.copysign(abs(si) ** 0.74, si) * v
        return at(y, z, -0.019 - 0.013 * (1 - v * v))

    mesh.patch("Graphite", 32, 8, pad, (-1, 0, 0))
    mesh.patch(
        "SoftTouch",
        32,
        3,
        lambda u, v: pad(u, 1) + Vector((0.056 * v, 0, 0)),
        lambda u, v: (0, math.cos(math.tau * u), math.sin(math.tau * u)),
    )
    for y in [-0.071, 0.071]:
        mesh.box("SatinBlack", at(y, 0.008, -0.006), (0.019, 0.039, 0.023))
        mesh.tube("Graphite", [at(y, 0.008, 0.068), at(y * 2.03, 0.035, 0.065)], 0.010)
    mesh.tube("SoftTouch", [at(0, 0, 0.055), at(0, 0, 0.151)], 0.045, 12)
