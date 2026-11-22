"""Build the unbadged four-door street model: blender -b --factory-startup -P assets/cars/sedan.py."""

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from sedan_surfaces import PatchMesh, curve, lerp, smooth, strip

FRONT, REAR = 2.02, -2.035
AXLES = (1.48, -1.50)
XA, XB, XC, XD = 0.85, 0.04, -0.805, -1.57
B = -0.20
Q = -1.225
ARCH = 0.350
TOP = [
    (REAR, 0.916),
    (-1.81, 0.952),
    (-1.40, 0.984),
    (-0.73, 0.971),
    (-0.15, 0.942),
    (0.55, 0.914),
    (0.90, 0.908),
    (1.45, 0.881),
    (1.77, 0.845),
    (FRONT, 0.774),
]
WIDTH = [
    (REAR, 0.811),
    (-1.81, 0.869),
    (-1.46, 0.905),
    (-1.04, 0.892),
    (0, 0.885),
    (0.82, 0.893),
    (1.45, 0.904),
    (1.84, 0.866),
    (FRONT, 0.813),
]


def belt(x):
    return curve(TOP, x)


def sill(x):
    return 0.205 + 0.037 * smooth((abs(x) - 1.72) / 0.3)


def bottom(x):
    low = sill(x)
    for axle in AXLES:
        d = abs(x - axle)
        if d < ARCH:
            return 0.31 + math.sqrt(max(0, ARCH * ARCH - d * d))
        if d < ARCH + 0.034:
            return lerp(0.31, low, smooth((d - ARCH) / 0.034))
    return low


def side_width(x, z):
    h = (z - sill(x)) / (belt(x) - sill(x))
    # Lower door tuck, taut shoulder crease, and flared metal around the tyres.
    w = curve(WIDTH, x) - 0.065 * (1 - smooth(h / 0.32)) - 0.074 * smooth((h - 0.775) / 0.225) ** 1.65
    w -= 0.027 * math.exp(-(((h - 0.43) / 0.20) ** 2))
    w += 0.010 * math.exp(-(((h - 0.78) / 0.052) ** 2))
    radial = min(math.hypot(x - a, z - 0.31) for a in AXLES)
    return w + 0.019 * math.exp(-(((radial - ARCH - 0.029) / 0.060) ** 2))


def sidepoint(x, z, s, depth=0):
    return (x, s * (side_width(x, z) + depth), z)


def crown(s, q):
    return (0.032 if s > 0 else 0.028) * (1 - q * q)


def cap(s, q, z, offset=0):
    x = FRONT if s > 0 else REAR
    # Tuck the valance back under the bumper and round the bonnet's leading edge.
    forward = [
        (0.18, 0.18),
        (0.26, 0.22),
        (0.41, 0.273),
        (0.49, 0.280),
        (0.57, 0.268),
        (0.69, 0.251),
        (0.775, 0.202),
        (0.90, 0.195),
    ]
    rear = [
        (0.18, 0.17),
        (0.29, 0.21),
        (0.43, 0.265),
        (0.52, 0.25),
        (0.65, 0.211),
        (0.81, 0.198),
        (0.90, 0.175),
        (0.96, 0.145),
    ]
    rx = curve(forward if s > 0 else rear, z)
    if s < 0:
        rx -= (
            0.062
            * (1 - smooth((abs(q) - 0.33) / 0.19))
            * smooth((z - 0.51) / 0.075)
            * (1 - smooth((z - 0.685) / 0.066))
        )
    a = math.sqrt(max(0, 1 - q * q))
    slope = (side_width(x, z) - side_width(x - s * 0.012, z)) / (s * 0.012)
    return (
        x + s * (rx * a + offset * (0.23 + 0.77 * a)),
        q * (side_width(x, z) + s * slope * rx * a * q * q + offset * 0.68),
        z,
    )


def cap_top(s, q):
    return belt(FRONT if s > 0 else REAR) + crown(s, q)


def deck(s, t, q):
    a, b = (XA, FRONT) if s > 0 else (XD, REAR)
    x = lerp(a, b, t)
    z = belt(x)
    h = z + lerp(0.030 if s > 0 else 0.042, crown(s, 0), t) * (1 - q * q)
    ridge = (0.027 if s > 0 else 0.008) * math.sin(math.pi * t) ** 0.8
    h += ridge * (math.exp(-(((abs(q) - lerp(0.67, 0.49, t)) / 0.115) ** 2)) - 0.32 * (1 - q * q))
    if s < 0:
        h += 0.015 * math.exp(-(((t - 0.84) / 0.13) ** 2)) * (1 - q * q)
    face = cap(s, q, cap_top(s, q))
    xx = x + lerp(s * (0.156 if s > 0 else 0.12) * (1 - q * q), face[0] - b, t)
    yy = lerp(q * side_width(x, z), face[1], t**3)
    return (xx, yy, h)


def sideglass(u, v, s):
    x0 = lerp(XA, XD, u)
    x1 = lerp(XB + .062, XC - .13, u) - .044 * math.sin(math.pi * u)
    y0 = side_width(x0, belt(x0))
    y1 = .642 + .041 * math.sin(math.pi * u) - .021*u**3
    z1 = 1.327 + .082 * math.sin(math.pi * u) - .032*u**3
    return (lerp(x0, x1, v), s * (lerp(y0, y1, v) + 0.026 * math.sin(math.pi * v)), lerp(belt(x0), z1, v))


def roof(t, q):
    x, w, z = sideglass(t, 1, 1)
    return (x + 0.104 * (1 - 2 * t) * (1 - q * q), q * w, z + .027 * (1 - q * q) + .040 * (1 - q**8))


def screen(s, u, v):
    t = 0 if s > 0 else 1
    q = 2 * u - 1
    p = Vector(deck(s, 0, q)).lerp(Vector(roof(t, q)), v)
    p.x += s * 0.018 * math.sin(math.pi * v) * (1 - q * q)
    p.y += q * 0.026 * math.sin(math.pi * v)
    return p


def framed(mesh, surf, out, insets, edge="Paint", cols=20, rows=9, glass="Window"):
    """Ruled outer frame, recessed ceramic frit and gently double-curved glass."""
    l, r, b, t = insets

    def inner(u, v, pad):
        ry = 0.094
        rx = min(0.073, (1 - l - r) * 0.14)
        k = max(0, 1 - min(v, 1 - v) / ry)
        bite = rx * (1 - math.sqrt(1 - k * k))
        return (lerp(l + pad + bite, 1 - r - pad - bite, u), lerp(b + pad, 1 - t - pad, v))

    normal = Vector(out)

    def pane(u, v, layer):
        if layer == 0:
            return Vector(surf(u, v))
        x, y = inner(u, v, 0 if layer == 1 else 0.012)
        return Vector(surf(x, y)) - normal * (0.002 if layer == 1 else 0.006)

    for rim, steps in [
        (lambda k: (k, 0), cols),
        (lambda k: (k, 1), cols),
        (lambda k: (0, k), rows),
        (lambda k: (1, k), rows),
    ]:
        for layer, mat in [(0, edge), (1, "Frit")]:
            mesh.patch(
                mat, steps, 2, lambda u, v: pane(*rim(u), layer).lerp(pane(*rim(u), layer + 1), v), out
            )
    mesh.patch(glass, cols, rows, lambda u, v: pane(u, v, 2), out)


def mirror(mesh, s):
    centre = (0.69, s * 0.974, 0.993)
    mesh.tube(
        "Graphite", [(0.75, s * 0.836, 0.916), (0.737, s * 0.877, 0.940), (0.697, s * 0.94, 0.972)], 0.029
    )
    rows = [
        (0.094, 0.008, 0.010),
        (0.080, 0.071, 0.042),
        (0.055, 0.108, 0.058),
        (0.013, 0.124, 0.068),
        (-0.031, 0.126, 0.065),
        (-0.058, 0.115, 0.057),
        (-0.065, 0.103, 0.050),
    ]

    def ring(k, theta):
        x, w, h = rows[k]
        co, si = math.cos(theta), math.sin(theta)
        return (
            centre[0] + x,
            centre[1] + w * math.copysign(abs(co) ** 0.78, co),
            centre[2] + h * math.copysign(abs(si) ** 0.78, si),
        )

    for i in range(len(rows) - 1):
        for lower in (False, True):
            angle = lambda u: (u + int(lower)) * math.pi
            mesh.patch(
                "Rubber" if lower or i >= 5 else "Paint",
                18,
                2,
                lambda u, v: Vector(ring(i, angle(u))).lerp(Vector(ring(i + 1, angle(u))), v),
                lambda u, v: (0, math.cos(angle(u)), math.sin(angle(u))),
            )

    def glass(u, v):
        p = Vector(ring(len(rows) - 1, math.tau * u))
        c = Vector((centre[0] - 0.071, centre[1], centre[2]))
        return c.lerp(p, v)

    mesh.patch("MirrorGlass", 32, 4, glass, (-1, 0, 0))


def doorskin(mesh, s, i, start, end):
    def edge(x, t):
        offset = {XA: -0.093, B: 0.061, Q: 0.12}.get(x, 0)
        return x + offset * (1 - smooth(t))

    def pos(x, t, dim=0):
        z = lerp(bottom(x), belt(x), t)
        return sidepoint(x, z, s, dim)

    cuts = {0.0, 1.0}
    for j in range(1, max(3, round((end - start) / 0.067))):
        cuts.add(j / max(3, round((end - start) / 0.067)))
    for a in AXLES:
        for j in range(29):
            x = a + ARCH * math.cos(math.pi * j / 28)
            if start < x < end:
                cuts.add((x - start) / (end - start))
        for k in [-1, 1]:
            x = a + k * (ARCH + 0.034)
            if start < x < end:
                cuts.add((x - start) / (end - start))
    cuts = sorted(cuts)

    def at(u, t):
        x = lerp(edge(start, t), edge(end, t), u)
        return pos(x, t)

    # Small actual gaps keep reflected highlights from bridging between panels.
    def gap(u, t):
        return lerp(0.0017 if start > REAR else 0, -0.0017 if end < FRONT else 0, u) / (end - start)

    def skin_normal(p):
        # Reflections can reveal a tangent break long before a silhouette does.
        # Sample the continuous sheet instead of the individual arch segments.
        e = 0.0005
        dx = (side_width(p.x + e, p.z) - side_width(p.x - e, p.z)) / (2 * e)
        dz = (side_width(p.x, p.z + e) - side_width(p.x, p.z - e)) / (2 * e)
        return Vector((-dx, s, -dz)).normalized()

    for a, b in zip(cuts, cuts[1:]):
        mesh.patch(
            "Paint", 1, 15, lambda u, v: at(lerp(a, b, u) + gap(lerp(a, b, u), v), v), (0, s, 0), skin_normal
        )
    if not i:
        return
    for u in (0, 1):
        strip(
            mesh,
            "Rubber",
            lambda v: at(u + gap(u, v), v),
            lambda v: Vector(at(u, v)) + Vector((0, -s * 0.055, 0)),
            (1 if u == 1 else -1, 0, 0),
            18,
        )
    strip(
        mesh,
        "SoftTouch",
        lambda u: at(u, 0.997),
        lambda u: Vector(at(u, 0.997)) + Vector((0, -s * 0.078, -0.019)),
        (0, 0, 1),
    )

    def liner(u, v):
        x = lerp(edge(start, v) + 0.012, edge(end, v) - 0.012, u)
        z = lerp(max(0.317, bottom(x) + 0.026), belt(x) - 0.017, v)
        return (x, s * (side_width(x, z) - 0.064 - 0.025 * math.sin(math.pi * u) * math.sin(math.pi * v)), z)

    mesh.patch("SoftTouch", 18, 8, liner, (0, -s, 0))
    handleX = start + 0.155
    handleZ = belt(handleX) - 0.128
    w = side_width(handleX, handleZ)
    mesh.ellipsoid("Frit", (handleX, s * (w + 0.002), handleZ), (0.098, 0.007, 0.021), 22, 6)
    mesh.ellipsoid("Paint", (handleX + 0.005, s * (w + 0.014), handleZ + 0.006), (0.090, 0.021, 0.016), 24, 8)
    mid = (start + end) * 0.5
    mesh.ellipsoid(
        "Upholstery", (mid, s * (side_width(mid, 0.65) - 0.094), 0.63), ((end - start) * 0.34, 0.044, 0.050)
    )

    # Stitched bolster, lower storage pocket and the inset speaker face on the
    # cabin side. The fittings follow the open door rather than the fixed sill.
    def inner(u, v, d):
        p = Vector(liner(u, v))
        p.y -= s * d
        return p

    def insert(u, v):
        k = 0.034 * abs(2 * v - 1) ** 4
        return inner(
            lerp(0.12 + k, 0.90 - k, u),
            lerp(0.47 + 0.032 * u, 0.705 + 0.037 * u, v),
            0.010 + 0.015 * math.sin(math.pi * v),
        )

    mesh.patch("DoorInsert", 20, 6, insert, (0, -s, 0))
    runpts = [inner(lerp(0.14, 0.89, j / 24), 0.728 + 0.032 * j / 24, 0.012) for j in range(25)]
    mesh.tube("Stitch", runpts, 0.0017, 5)
    mesh.patch(
        "Graphite",
        16,
        5,
        lambda u, v: inner(lerp(0.10, 0.62, u), lerp(0.13, 0.32 + 0.035 * u, v), 0.022 + 0.027 * v),
        (0, -s, 0.1),
    )
    mesh.tube(
        "SatinBlack",
        [inner(lerp(0.10, 0.62, j / 16), 0.321 + 0.035 * j / 16, 0.048) for j in range(17)],
        0.007,
    )
    sp = inner(0.80, 0.31, 0.012)
    mesh.ellipsoid("SpeakerMesh", sp, (0.078, 0.008, 0.068), 18, 7)
    for row in range(-3, 4):
        for col in range(-4, 5):
            if (col / 4.5) ** 2 + (row / 3.7) ** 2 > 1:
                continue
            x = sp.x + col * 0.013 + (row % 2) * 0.005
            z = sp.z + row * 0.014
            mesh.patch(
                "Intake",
                1,
                1,
                lambda u, v: (x + 0.003 * (u + v - 1), sp.y - s * 0.009, z + 0.003 * (u - v)),
                (0, -s, 0),
            )
    mesh.ellipsoid(
        "Nickel", (end - 0.20, s * (side_width(end - 0.20, 0.77) - 0.085), 0.776), (0.052, 0.014, 0.014)
    )
    if i <= 2:
        mirror(mesh, s)


def shell():
    body = PatchMesh()
    doors = {k: PatchMesh() for k in range(1, 5)}
    for s in [-1, 1]:
        front = 1 if s > 0 else 2
        rear = front + 2
        for a, b, k in [(REAR, Q, 0), (Q, B, rear), (B, XA, front), (XA, FRONT, 0)]:
            doorskin(doors[k] if k else body, s, k, a, b)
        for axle in AXLES:

            def lip(u, depth):
                a = 0.002 + u * (math.pi - 0.004)
                x = axle + ARCH * math.cos(a)
                z = 0.31 + ARCH * math.sin(a)
                return sidepoint(x, z, s, -depth)

            strip(body, "Graphite", lambda u: lip(u, 0.001), lambda u: lip(u, 0.093), (0, -s, -0.5), 42)

        # Box section under the door openings and the structural B-pillar behind them.
        def rocker(u, v):
            x = lerp(-1.13, 1.09, u)
            return sidepoint(x, 0.175 + 0.072 * v, s, -0.022 + 0.016 * math.sin(math.pi * v))

        body.patch("Paint", 30, 5, rocker, (0, s, 0))
        body.box("Rubber", (-0.01, s * 0.78, 0.285), (2.19, 0.12, 0.064))
        body.box("Smoked", (-0.02, s * 0.795, 0.322), (1.94, 0.052, 0.015))
        for post in [XA, B, Q]:
            x = post - 0.025

            def jamb(v, d):
                z = lerp(max(bottom(x) + 0.018, 0.302), belt(x) - 0.023, v)
                return sidepoint(x + (0.05 if post == B else -0.05) * (1 - v), z, s, -d)

            strip(body, "Paint", lambda v: jamb(v, 0.026), lambda v: jamb(v, 0.091), (1, 0, 0), 13)
            body.tube("Frit", [jamb(j / 15, 0.046) for j in range(16)], 0.008)
        # Retracted shoulder belt, upper guide and a real striker at the B pillar.
        bp = Vector(sideglass((XA - B) / (XA - XD), 0.76, s))
        bp.y -= s * 0.058
        body.ellipsoid("SoftTouch", bp, (0.045, 0.025, 0.039), 12, 6)
        body.patch(
            "BeltWebbing",
            2,
            9,
            lambda u, v: bp + Vector((0.038 * (u - 0.5) - 0.046 * v, -s * 0.010, 0.008 - 0.68 * v)),
            (0, -s, 0),
        )
        body.tube(
            "Nickel",
            [
                (B - 0.018, s * 0.808, 0.673),
                (B - 0.002, s * 0.830, 0.673),
                (B - 0.001, s * 0.832, 0.646),
                (B - 0.019, s * 0.808, 0.646),
            ],
            0.004,
            6,
        )
        ub = (XA - B) / (XA - XD)
        uq = (XA - Q) / (XA - XD)
        # The A- and C-pillars are broad pressings continuous with the roof
        # and quarter panels. Only the glazed door frames move with their hinges.
        af = lambda v: 0.030 + 0.038 * (1 - v) ** 2
        aft = lambda v: lerp(uq, 0.745, v)
        for lo, hi in [(lambda v: 0, af), (aft, lambda v: 1)]:
            body.patch("Paint", 9, 16, lambda u, v: sideglass(lerp(lo(v), hi(v), u), v, s), (0, s, 0.2))
        body.patch("Paint", 42, 4, lambda u, v: sideglass(u, lerp(0.895, 1, v), s), (0, s, 0.44))
        for lo, hi, k in [(af, lambda v: ub, front), (lambda v: ub, aft, rear)]:
            mesh = doors[k]

            def surf(u, v):
                v = lerp(0, 0.895, v)
                return sideglass(lerp(lo(v), hi(v), u), v, s)

            framed(
                mesh,
                surf,
                (0, s, 0.19),
                (0.032, 0.034, 0.048, 0.041),
                edge="SatinBlack",
                cols=18,
                rows=14,
                glass="Window" if k < 3 else "RearWindow",
            )
            strip(mesh, "Nickel", lambda u: surf(u, 0.006), lambda u: surf(u, 0.030), (0, s, 0.25), 21)
        # A single glazing channel follows the upper daylight opening.
        body.tube(
            "Smoked", [sideglass(lerp(af(0.897), aft(0.897), j / 36), 0.897, s) for j in range(37)], 0.005
        )
        a = Vector(sideglass(ub, 0, s))
        b = Vector(sideglass(ub, 0.92, s))
        body.tube(
            "Frit",
            [
                a + Vector((0, -s * 0.055, -0.59)),
                a + Vector((0, -s * 0.055, 0)),
                b + Vector((0, -s * 0.043, 0)),
            ],
            0.031,
        )
        for u in (0, 1):
            # A folded return into the cabin gives the pillar thickness when
            # seen through the opposite pane.
            strip(
                body,
                "Upholstery",
                lambda v: sideglass(u, v, s),
                lambda v: (
                    Vector(sideglass(u, v, s)) + Vector((-0.023 if u == 0 else 0.032, -s * 0.043, -0.015))
                ),
                (0, -s, -0.1),
                20,
            )
        # Fuel flap on the passenger quarter, in the crown of the rear wing.
        if s < 0:
            pts = []
            for j in range(49):
                a = math.tau * j / 48
                dx = 0.105 * math.copysign(abs(math.cos(a)) ** 0.48, math.cos(a))
                dz = 0.076 * math.copysign(abs(math.sin(a)) ** 0.48, math.sin(a))
                pts.append(sidepoint(-1.58 + dx, 0.796 + dz, s, 0.0015))
            body.tube("Graphite", pts, 0.0025, 5)
    for s in [-1, 1]:
        body.patch("Paint", 36, 20, lambda u, v: deck(s, v, math.sin((u - 0.5) * math.pi)), (0, 0, 1))
        for side in [-1, 1]:
            pts = [
                Vector(deck(s, j / 32, side * lerp(0.91, 0.79, j / 32))) + Vector((0, 0, 0.0013))
                for j in range(33)
            ]
            body.tube("Graphite", pts, 0.0028, 6)
        framed(
            body,
            lambda u, v: screen(s, u, v),
            (s, 0, 0.75),
            (0.033, 0.033, 0.035, 0.047),
            cols=24,
            rows=12,
            glass="Window" if s > 0 else "RearWindow",
        )
    # The overhead sedan already has a sunroof. Cut its recess into the roof
    # panel and put the laminated pane just above the closed fabric shade.
    for t0, t1, q0, q1 in [
        (0, 0.19, -1, 1),
        (0.76, 1, -1, 1),
        (0.19, 0.76, -1, -0.62),
        (0.19, 0.76, 0.62, 1),
    ]:
        body.patch("Paint", 20, 10, lambda u, v: roof(lerp(t0, t1, v), lerp(q0, q1, u)), (0, 0, 1))
    framed(
        body,
        lambda u, v: roof(lerp(0.19, 0.76, v), lerp(-0.62, 0.62, u)),
        (0, 0, 1),
        (0.014, 0.014, 0.023, 0.023),
        cols=16,
        rows=10,
        glass="RearWindow",
    )
    for j in range(9):
        v = 0.15 + 0.078 * j
        body.tube(
            "Smoked",
            [screen(-1, 0.065 + 0.87 * k / 22, v) - Vector((-0.006, 0, 0.001)) for k in range(23)],
            0.0009,
            4,
        )
    # Headlining follows the roof and stays clear of the open side windows.
    body.patch(
        "Upholstery", 16, 8, lambda u, v: Vector(roof(v, 2 * u - 1)) + Vector((0, 0, -0.023)), (0, 0, -1)
    )
    # Closed underside follows the width between the wheel tubs. The undertray
    # and muffler also read from below when the car tips onto its side.
    body.patch(
        "Rubber",
        22,
        6,
        lambda u, v: (
            lerp(REAR + 0.09, FRONT - 0.08, v),
            (2 * u - 1) * (0.62 + 0.13 * math.sin(math.pi * v)),
            0.176 + 0.023 * (2 * u - 1) ** 2,
        ),
        (0, 0, -1),
    )
    body.ellipsoid("Smoked", (-1.73, 0.32, 0.200), (0.28, 0.155, 0.060), 18, 6)
    body.tube("BrakeSteel", [(-0.92, 0.12, 0.203), (-1.32, 0.25, 0.206), (-1.60, 0.32, 0.202)], 0.025)
    body.box("Carpet", (-0.27, 0, 0.346), (2.20, 1.62, 0.034))
    for x in [0.79, -1.34]:
        body.box("SoftTouch", (x, 0, 0.622), (0.065, 1.53, 0.54))
    for start, end in [(0.73, 0.045), (-0.025, -0.735)]:

        def windshield(u, v):
            return Vector(screen(1, u, v)) + Vector((0.004, 0, 0.003))

        body.tube(
            "Rubber",
            [windshield((lerp(start, end, j / 12) + 1) / 2, 0.098 + 0.055 * j / 12) for j in range(13)],
            0.009,
        )
        body.tube(
            "Graphite",
            [windshield((start + 1) / 2, 0.033), windshield(((start + end) / 2 + 1) / 2, 0.13)],
            0.009,
        )
    from sedan_cabin import cabin

    cabin(body)
    from sedan_fascia import ends

    headlamp = ends(body, cap, cap_top, sidepoint)
    root = body.build("sedan_coachwork")
    root["headlamp"] = headlamp
    for k, mesh in doors.items():
        pivot = ((XA if k <= 2 else B), (1 if k % 2 else -1) * (0.9077628 if k <= 2 else 0.9053244), 0)
        obj = mesh.build(f"sedan_coachwork_door{k}", pivot)
        obj.parent = root
    return root


if __name__ == "__main__":
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root = shell()
    bpy.context.view_layer.update()
    from sedan_surfaces import bake_occlusion

    bake_occlusion([root, *root.children])
    out = HERE.parents[1] / "public" / "sedan-street.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(out),
        export_format="GLB",
        export_texcoords=False,
        export_normals=True,
        export_meshopt_compression_enable=True,
        export_meshopt_extension="EXT_meshopt_compression",
        export_attributes=True,
        export_extras=True,
        export_yup=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
    print(out, out.stat().st_size)
