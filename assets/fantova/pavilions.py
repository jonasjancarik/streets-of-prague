"""The terminal pavilions on Wilsonova, in the local frame of Fantova budova."""

import itertools
import math

import numpy as np
import shapely
from craft import at, band, edges, lathe, rect, rod, unit
from shapely.geometry import Polygon, box

# Window openings on the rectified photographs, in texture coordinates from
# the top left. The cut stone surrounds stay on the wall in front of the glass.
OPENINGS = {
    "street-bay": [
        (0.285, 0.12, 0.435, 0.25),
        (0.535, 0.12, 0.69, 0.25),
        (0.37, 0.425, 0.575, 0.595),
        (0.31, 0.765, 0.555, 0.90),
    ],
    "oval-bay": [(0.315, 0.165, 0.705, 0.265), (0.35, 0.43, 0.63, 0.515)],
    "red-bays": [
        (0.264, 0.09, 0.391, 0.212),
        (0.713, 0.089, 0.846, 0.21),
        (0.264, 0.42, 0.412, 0.584),
        (0.711, 0.419, 0.846, 0.578),
        (0.403, 0.787, 0.472, 0.894),
        (0.51, 0.786, 0.625, 0.894),
        (0.673, 0.785, 0.752, 0.893),
    ],
    "north-oriel": [
        (0.245, 0.041, 0.437, 0.111),
        (0.538, 0.041, 0.735, 0.111),
        (0.265, 0.276, 0.747, 0.441),
        (0.265, 0.579, 0.747, 0.754),
        (0.307, 0.914, 0.731, 0.986),
    ],
    "end-oriel": [
        (0.227, 0.039, 0.334, 0.102),
        (0.408, 0.039, 0.574, 0.102),
        (0.682, 0.041, 0.778, 0.102),
        (0.255, 0.317, 0.719, 0.553),
        (0.255, 0.746, 0.721, 0.956),
    ],
    "lower-bays": [
        (0.218, 0.15, 0.367, 0.368),
        (0.681, 0.15, 0.839, 0.373),
        (0.221, 0.56, 0.375, 0.929),
        (0.683, 0.56, 0.837, 0.93),
    ],
}

# Sections through IPR's city model. The two ends sit at different grades and
# the steps in plan are slightly different. X increases towards the south.
ENDS = {
    "south": {
        "sign": 1,
        "inner": 73.50,
        "shoulder": 103.03,
        "outer": 108.89,
        "front": -10.81,
        "back": 15.31,
        "end_front": -8.07,
        "end_back": 12.30,
        "base": -0.46,
        "eave": 19.54,
        "ridge": 26.25,
        "lantern": 30.36,
        "tower_x": 104.20,
        "tower_y": 2.72,
        "summit": 37.38,
    },
    "north": {
        "sign": -1,
        "inner": 73.36,
        "shoulder": 102.97,
        "outer": 108.57,
        "front": -9.22,
        "back": 16.84,
        "end_front": -6.38,
        "end_back": 13.96,
        "base": -3.17,
        "eave": 20.38,
        "ridge": 26.13,
        "lantern": 31.34,
        "tower_x": 105.18,
        "tower_y": 3.66,
        "summit": 36.40,
    },
}


def gallery_triangles(triangles):
    """Terminate the old shell at the two gallery joints, including long platform walls."""
    result = []
    for tri in triangles:
        polygon = list(tri)
        for side, limit in ((1, ENDS["south"]["inner"]), (-1, ENDS["north"]["inner"])):
            if not polygon:
                break
            clipped = []
            for a, b in zip(polygon, polygon[1:] + polygon[:1]):
                u, v = side * a[0] - limit, side * b[0] - limit
                if u <= 0:
                    clipped.append(a)
                if u * v < 0:
                    clipped.append(a + u / (u - v) * (b - a))
            polygon = clipped
        for i in range(1, len(polygon) - 1):
            face = np.array([polygon[0], polygon[i], polygon[i + 1]])
            xyz = face[:, :3]
            # A joint can graze an existing survey corner. Sub-millimetre
            # edges collapse to a single vertex when the GLB is quantized.
            if np.min(np.linalg.norm(xyz - np.roll(xyz, 1, axis=0), axis=1)) >= 0.001:
                result.append(face)
    return np.asarray(result)


def panel(m, a, b, lo, hi, material, *, recesses=False, outset=0, uv=(0, 0, 1, 1)):
    """Face a single bay outwards along a→b, with inset photographic windows."""
    a, b = np.asarray(a), np.asarray(b)
    along = b - a
    outward = unit(np.array([along[1], -along[0]]))

    def point(u, v, depth=0):
        return at(a + along * u + outward * (outset + depth), hi + (lo - hi) * v)

    def photo(coords, depth=0):
        m.face(
            [point(u, v, depth) for u, v in coords],
            material,
            [(uv[0] + (uv[2] - uv[0]) * u, uv[1] + (uv[3] - uv[1]) * v) for u, v in coords],
        )

    apertures = OPENINGS.get(material, ()) if recesses else ()
    if not apertures:
        photo([(0, 1), (1, 1), (1, 0), (0, 0)])
        return
    wall = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)], [box(*q).exterior.coords for q in apertures])
    for tri in shapely.constrained_delaunay_triangles(wall).geoms:
        coords = list(tri.exterior.coords)[:3]
        photo(coords[::-1] if tri.exterior.is_ccw else coords)
    for l, t, r, bottom in apertures:
        outline = [(l, bottom), (r, bottom), (r, t), (l, t)]
        photo(outline, -0.16)
        for p, q in zip(outline, outline[1:] + outline[:1]):
            m.face([point(*p), point(*q), point(*q, -0.16), point(*p, -0.16)], "sandstone")


def shelf(m, a, b, z, depth=0.24, height=0.24, mat="carving"):
    along = np.asarray(b) - a
    out = unit(np.array([along[1], -along[0]]))
    a, b = np.asarray(a), np.asarray(b)
    ring = np.array([a + out * depth, b + out * depth, b - out * 0.025, a - out * 0.025])
    m.course(ring, (z, 0), (z + height, 0), mat)


def balcony(m, a, b, z, depth=0.68):
    a, b = np.asarray(a), np.asarray(b)
    direction = unit(b - a)
    out = np.array([direction[1], -direction[0]])
    front = [a + (b - a) * t + out * (0.26 + depth * math.sin(math.pi * t)) for t in np.linspace(0, 1, 9)]
    ring = np.array([*front, b, a])
    m.course(ring, (z, 0), (z + 0.22, 0), "sandstone")
    for h, radius in ((0.36, 0.025), (0.76, 0.023), (1.11, 0.04)):
        for p, q in itertools.pairwise(front):
            rod(m, at(p, z + h), at(q, z + h), radius, "iron", 4)
    for i, p in enumerate(front):
        rod(m, at(p, z + 0.21), at(p, z + 1.11), 0.022, "iron", 4)
        if i % 2 == 0 and i < len(front) - 2:
            # Scrolls between the uprights, following the swell of the balcony.
            q = front[i + 2]
            loop = [
                at((p + q) / 2 + (q - p) * 0.39 * math.cos(t), z + 0.69 + 0.22 * math.sin(t))
                for t in np.linspace(0, math.tau, 9)
            ]
            for l, r in itertools.pairwise(loop):
                rod(m, l, r, 0.018, "iron", 4)
    for t in (0.12, 0.5, 0.88):
        p = a + (b - a) * t
        rod(
            m,
            at(p, z - 0.55),
            at(p + out * (0.25 + depth * math.sin(t * math.pi)), z + 0.02),
            0.12,
            "carving",
            6,
        )


def span(a, b, u, v):
    return a + (b - a) * u, a + (b - a) * v


def faces(m, data, north):
    s = data["sign"]
    inner, shoulder, end = (s * data[k] for k in ("inner", "shoulder", "outer"))
    front, back, ef, eb = (data[k] for k in ("front", "back", "end_front", "end_back"))
    base, eave = data["base"], data["eave"]
    # Counterclockwise footprint with the narrower end bay projecting past the main block.
    rim = np.array(
        [
            (inner, front),
            (shoulder, front),
            (shoulder, ef),
            (end, ef),
            (end, eb),
            (shoulder, eb),
            (shoulder, back),
            (inner, back),
        ]
    )
    if s < 0:
        rim = rim[::-1]
    for a, b in edges(rim):
        length = np.linalg.norm(b - a)
        out = unit(np.array([(b - a)[1], -(b - a)[0]]))

        # Extend the plinth down to the lower pavement at the north end.
        m.wall(a, b, base, 0.12, "granite")
        if north and out[1] < -0.9 and length > 24:
            for l, r in ((0, 0.40), (0.60, 1)):
                shelf(m, *span(a, b, l, r), 6.92, 0.27, 0.28)
        else:
            shelf(m, a, b, 6.92, 0.27, 0.28)
        shelf(m, a, b, eave - 0.67, 0.29, 0.24)
        shelf(m, a, b, eave - 0.40, 0.49, 0.30)
        if abs(a[0] - end) < 0.01 and abs(b[0] - end) < 0.01:
            # The south elevation has red infill around paired windows; the
            # north central bay has stained glass and a pale stone surround.
            for l, r in ((0, 0.337), (0.663, 1)):
                lpt, rpt = span(a, b, l, r)
                panel(m, lpt, rpt, 0, 6.93, "lower-bays", recesses=True)
                if north:
                    for u, v in ((l, (l + r) / 2), ((l + r) / 2, r)):
                        panel(m, *span(a, b, u, v), 7.14, eave, "street-bay", recesses=True)
                else:
                    panel(m, lpt, rpt, 7.14, eave, "red-bays", recesses=True)
            # Three-light oriel. The splayed cheeks meet the wall behind the fascia.
            l, r = span(a, b, 0.337, 0.663)
            offset = 0.46
            m.wall(l, l + out * offset, 7.06, eave, "plaster")
            m.wall(r + out * offset, r, 7.06, eave, "plaster")
            panel(m, l, r, 7.06, eave, "north-oriel" if north else "end-oriel", outset=offset, recesses=True)
            shelf(m, l, r, 7.01, 0.55, 0.21)
            shelf(m, l, r, 12.24, 0.48, 0.14)
            shelf(m, l, r, eave - 0.42, 0.73, 0.3)
            for u, v, mat in ((0.337, 0.417, "ashlar"), (0.417, 0.583, "end-door"), (0.583, 0.663, "ashlar")):
                panel(m, *span(a, b, u, v), 0.03, 6.98, mat)
        elif length > 24:
            # Five principal bays face Wilsonova. The north portal rises
            # through the first floor, flanked by iron balconies and oval windows.
            count = 5
            street = out[1] < -0.9
            for i in range(count):
                p, q = span(a, b, i / count, (i + 1) / count)
                if north and street and i == 2:
                    # Four timber-and-glass doors below the full-height carved arch.
                    for j in range(4):
                        l, r = p + (q - p) * j / 4, p + (q - p) * (j + 1) / 4
                        panel(m, l, r, 0.06, 4.33, "end-door", uv=(0.39, 0.59, 0.62, 1))
                    panel(m, p, q, 4.33, 15.25, "north-portal")
                    balcony(m, p + 0.13 * (q - p), q - 0.13 * (q - p), 14.92, 0.28)
                    panel(m, p, q, 15.25, eave, "street-bay", uv=(0, 0, 1, 0.33))
                else:
                    if street and i == 2:
                        # Set the sculpted arch over a pair of timber entrance leaves.
                        panel(m, p, q, 0, 3.05, "end-door", uv=(0, 0.64, 1, 0.99))
                        panel(m, p, q, 3.05, 6.95, "carved-arch")
                    elif north and street:
                        panel(m, p, q, 0, 6.96, "wing-bay", uv=(0, 0.42, 1, 1))
                    else:
                        panel(m, p, q, 0, 6.96, "lower-bays", recesses=True)
                    mat = "oval-bay" if north and street else "street-bay"
                    panel(m, p, q, 7.14, eave, mat, recesses=True)
                    if mat == "oval-bay":
                        balcony(m, p + 0.20 * (q - p), q - 0.20 * (q - p), 7.14 + 0.31 * (eave - 7.14), 0.57)
                    else:
                        shelf(
                            m,
                            p + 0.26 * (q - p),
                            q - 0.26 * (q - p),
                            7.14 + 0.615 * (eave - 7.14),
                            0.18,
                            0.17,
                        )
        elif length > 5:
            panel(m, a, b, 0, 6.96, "lower-bays", recesses=True)
            panel(m, a, b, 7.14, eave, "street-bay", recesses=True)
        else:
            panel(m, a, b, 0, 6.96, "ashlar")
            panel(m, a, b, 7.14, eave, "street-bay", uv=(0.08, 0, 0.25, 1))


def hipped_roof(m, x0, x1, y0, y1, eave, ridge):
    """Four pitched, tiled planes with lead hips and a capped ridge."""
    ring = rect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0)
    ridge_half = (x1 - x0) * 0.26
    mid = (x0 + x1) / 2
    y = (y0 + y1) / 2
    ends = [np.array((mid - ridge_half, y)), np.array((mid + ridge_half, y))]
    tips = [ends[0], ends[1], ends[1], ends[0]]
    for i, (a, b) in enumerate(edges(ring)):
        c, d = tips[i], tips[(i + 1) % 4]
        # UVs follow the eaves so tile courses run horizontally on the hips too.
        tangent = unit(b - a)
        width = np.linalg.norm(b - a)
        inward = np.array([-tangent[1], tangent[0]])
        run = (c - a) @ inward
        # Clip the pitched plane in eave coordinates. The hip tiles keep their
        # width right up to the ridge, including on the triangular end slopes.
        face = Polygon([(0, 0), (width, 0), ((d - a) @ tangent, 1), ((c - a) @ tangent, 1)])
        sections = max(1, round(width / 13))
        step = width / sections
        for j in range(sections):
            tile = face.intersection(box(step * j, 0, step * (j + 1), 1))
            if tile.area < 1e-7:
                continue
            coords = list(tile.exterior.coords)[:-1]
            if not tile.exterior.is_ccw:
                coords.reverse()
            m.face(
                [at(a + tangent * u + inward * v * run, eave + v * (ridge - eave)) for u, v in coords],
                "pantiles",
                [(np.clip(u / step - j, 0, 1), 1 - v) for u, v in coords],
            )
        rod(m, at(a, eave + 0.035), at(c, ridge + 0.035), 0.085, "tile", 7)
    rod(m, at(ends[0], ridge + 0.07), at(ends[1], ridge + 0.07), 0.12, "tile", 8)


def lantern(m, x, y, z, top):
    # The ridge lantern is glazed on a steel frame, with a pitched glass roof.
    length, width = 9.5, 6.5
    sx, sy = length / 2, width / 2
    spring = top - 1.55
    band(m, x, y, length + 0.32, width + 0.32, z, 0.55, "chimney-brick")
    for v in (-1, 1):
        a = (x - v * sx, y - v * sy)
        b = (x + v * sx, y - v * sy)
        m.wall(a, b, z + 0.32, spring, "roof-glass")
        m.face([at(a, spring), at(b, spring), (b[0], y, top), (a[0], y, top)], "roof-glass")
        for u in np.linspace(-sx, sx, 9):
            foot = (x + u, y - v * sy)
            rod(m, at(foot, z + 0.26), at(foot, spring), 0.055, "lead", 6)
            rod(m, at(foot, spring), (x + u, y, top + 0.03), 0.053, "lead", 6)
        rod(m, at(a, spring), at(b, spring), 0.07, "iron", 6)
        rod(m, at(a, (spring + z) / 2), at(b, (spring + z) / 2), 0.05, "iron", 5)
    for v in (-1, 1):
        a, b = (x + v * sx, y - v * sy), (x + v * sx, y + v * sy)
        m.wall(a, b, z + 0.28, spring, "roof-glass")
        m.face([at(a, spring), at(b, spring), (x + v * sx, y, top)], "roof-glass")
        rod(m, at(a, spring), at(b, spring), 0.075, "iron", 6)
        rod(m, at(a, (spring + z) / 2), at(b, (spring + z) / 2), 0.055, "iron", 5)
        for t in (-0.65, 0, 0.65):
            rod(
                m,
                at((x + v * sx, y + t * sy), z + 0.28),
                (x + v * sx, y + t * sy, top - 1.55 * abs(t)),
                0.055,
                "lead",
                6,
            )
    rod(m, (x - sx, y, top), (x + sx, y, top), 0.085, "lead", 8)


def gilded_wing(m, centre, sign):
    # Trace the scalloped primaries of the photographed railway emblem. The
    # ridge stands proud of both faces; the edge has thickness in profile.
    rim = [
        (370, 459),
        (338, 453),
        (305, 460),
        (280, 457),
        (260, 442),
        (257, 428),
        (270, 417),
        (252, 417),
        (248, 406),
        (249, 394),
        (269, 383),
        (250, 386),
        (248, 377),
        (252, 367),
        (270, 360),
        (252, 358),
        (241, 349),
        (238, 341),
        (255, 339),
        (245, 336),
        (235, 326),
        (234, 317),
        (255, 315),
        (232, 309),
        (216, 302),
        (201, 293),
        (198, 284),
        (220, 286),
        (203, 274),
        (181, 262),
        (157, 250),
        (154, 243),
        (171, 245),
        (154, 233),
        (123, 217),
        (116, 211),
        (122, 204),
        (146, 195),
        (168, 190),
        (191, 192),
        (218, 202),
        (249, 219),
        (277, 239),
        (309, 264),
        (334, 291),
        (352, 319),
        (366, 352),
        (377, 389),
    ]

    def vertex(p, face):
        u, v = p
        spread = (370 - u) / 254
        rise = (459 - v) / 269
        depth = 0.095 + 0.12 * math.sin(math.pi * np.clip(rise, 0, 1))
        return centre + np.array(
            [face * depth - 0.16 * spread, sign * (0.38 + spread * 2.25), -0.38 + rise * 2.06]
        )

    def uv(p):
        return ((p[0] - 111) / 273, (p[1] - 182) / 284)

    for tri in shapely.constrained_delaunay_triangles(Polygon(rim)).geoms:
        pts = list(tri.exterior.coords)[:3]
        for face in (-1, 1):
            vs = [vertex(p, face) for p in pts]
            tex = [uv(p) for p in pts]
            if np.cross(vs[1] - vs[0], vs[2] - vs[0])[0] * face < 0:
                vs.reverse()
                tex.reverse()
            m.face(vs, "gilt-wing", tex)
    for a, b in zip(rim, rim[1:] + rim[:1]):
        vs = [vertex(a, -1), vertex(b, -1), vertex(b, 1), vertex(a, 1)]
        m.face(vs if sign > 0 else vs[::-1], "gold")


def winged_wheel(m, x, y, z):
    # Seen end-on from the street, the wheel stands upright between two
    # upswept feathered wings. The opening through the spokes is real.
    r = 0.69
    centre = np.array((x, y, z + 0.65))
    circle = [centre + (0, r * math.cos(t), r * math.sin(t)) for t in np.arange(24) * math.tau / 24]
    for i, (a, b) in enumerate(zip(circle, circle[1:] + circle[:1])):
        rod(m, a, b, 0.10, "gold", 6)
        if i % 3 == 0:
            rod(m, centre, a, 0.052, "gold", 6)
    rod(m, centre - (0.24, 0, 0), centre + (0.24, 0, 0), 0.16, "gold", 10)
    for sign in (-1, 1):
        gilded_wing(m, centre, sign)
    rod(m, (x, y, z + 1.15), (x, y, z + 2.55), 0.023, "iron", 6)


def clock_face(m, a, b, dial_h):
    along = unit(b - a)
    out = np.array([along[1], -along[0]])
    mid = (a + b) / 2

    def disc(angle, r, depth):
        return at(mid + out * depth + along * (r * math.cos(angle)), dial_h + r * math.sin(angle))

    def tex(v):
        return (0.50 + 0.49 * math.cos(v), 0.50 - 0.49 * math.sin(v))

    for i in range(40):
        t, u = i * math.tau / 40, (i + 1) * math.tau / 40

        m.face(
            [at(mid + out * 0.16, dial_h), disc(t, 1.99, 0.16), disc(u, 1.99, 0.16)],
            "clock",
            [(0.5, 0.5), tex(t), tex(u)],
        )
        m.face(
            [disc(t, 2.12, 0.02), disc(u, 2.12, 0.02), disc(u, 1.99, 0.16), disc(t, 1.99, 0.16)],
            "sandstone",
        )


def clocks(m, x, y, eave, top):
    side = 6.36
    lower = top - 11.1
    dial_h = top - 8.25
    corners = rect(x, y, side, side)
    for a, b in edges(corners):
        panel(m, a, b, eave - 0.4, lower, "clock-balcony")
        if (a[0] + b[0] - 2 * x) * np.sign(x) > side - 0.1:
            balcony(m, a + 0.25 * (b - a), b - 0.25 * (b - a), eave + 0.24 * (lower - eave), 0.30)
    band(m, x, y, side + 0.25, side + 0.25, lower - 0.25, 0.40, "sandstone")
    ring = rect(x, y, side - 0.34, side - 0.34)
    for a, b in edges(ring):
        m.wall(a, b, lower, top - 5.70, "clock-stone")
        clock_face(m, a, b, dial_h)
    for a, b in edges(ring):
        shelf(m, a, b, top - 5.75, 0.20, 0.24)
    for a in ring:
        lathe(
            m,
            *a,
            [
                (lower + 0.15, 0.34),
                (top - 6.2, 0.34),
                (top - 6.1, 0.48),
                (top - 5.85, 0.45),
                (top - 5.57, 0.27),
                (top - 5.26, 0.07),
            ],
            "sandstone",
            10,
        )
    # Bell-shaped stone crown surrounded by seated figures, below the winged wheel.
    lathe(
        m,
        x,
        y,
        [
            (top - 5.64, 2.91),
            (top - 5.33, 2.72),
            (top - 4.8, 2.55),
            (top - 4.35, 2.66),
            (top - 3.6, 2.53),
            (top - 3.0, 2.19),
            (top - 2.45, 1.40),
            (top - 2.12, 0.54),
        ],
        "sandstone",
        24,
    )
    for k in range(8):
        angle = k * math.pi / 4
        d = np.array((math.cos(angle), math.sin(angle)))
        t = np.array((-d[1], d[0]))
        mid = np.array((x, y)) + d * 2.52
        panel(m, mid - t * 0.73, mid + t * 0.73, top - 4.78, top - 3.06, "crown-relief", outset=0.09)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        d = np.array([math.cos(a), math.sin(a)])
        p = np.array([x, y]) + d * 2.58
        lathe(
            m,
            *p,
            [
                (top - 5.0, 0.46),
                (top - 4.72, 0.53),
                (top - 4.12, 0.42),
                (top - 3.48, 0.36),
                (top - 3.32, 0.40),
                (top - 3.14, 0.19),
            ],
            "statue",
            9,
        )
        lathe(
            m,
            *p,
            [(top - 3.17, 0.15), (top - 3.05, 0.24), (top - 2.83, 0.23), (top - 2.70, 0.09)],
            "statue",
            9,
        )
        for hand in (-1, 1):
            shoulder = p + hand * np.array([-d[1], d[0]]) * 0.26
            rod(m, at(shoulder, top - 3.38), at(shoulder + d * 0.25, top - 3.90), 0.12, "statue", 7)
    winged_wheel(m, x, y, top - 2.14)


def roof_eagle(m, xy, direction, z):
    """Weathered stone eagles hunch over the outer corners of the eaves."""
    direction = unit(np.asarray(direction, dtype=float))
    across = np.array([-direction[1], direction[0]])

    def form(rows, side=0, mat="statue"):
        rings = []
        for h, forward, length, width in rows:
            centre = xy + direction * forward + side * across
            rings.append(
                [
                    at(centre + direction * (length * math.cos(t)) + across * (width * math.sin(t)), z + h)
                    for t in np.arange(8) * math.tau / 8
                ]
            )
        for lower, upper in itertools.pairwise(rings):
            for i in range(8):
                j = (i + 1) % 8
                m.face([lower[i], lower[j], upper[j], upper[i]], mat)
        m.face(rings[-1], mat)

    lathe(m, *xy, [(z, 0.54), (z + 0.22, 0.58), (z + 0.30, 0.45)], "sandstone", 8)
    form(
        [
            (0.21, -0.25, 0.46, 0.28),
            (0.40, -0.13, 0.58, 0.38),
            (0.83, 0.02, 0.51, 0.39),
            (1.13, 0.20, 0.35, 0.28),
            (1.36, 0.32, 0.22, 0.17),
            (1.47, 0.34, 0.19, 0.14),
        ]
    )
    form([(1.21, 0.58, 0.07, 0.08), (1.36, 0.49, 0.23, 0.14), (1.41, 0.48, 0.13, 0.11)], mat="sandstone")
    for sign in (-1, 1):
        form(
            [
                (0.20, -0.57, 0.20, 0.05),
                (0.51, -0.34, 0.43, 0.10),
                (0.89, -0.12, 0.47, 0.16),
                (1.14, 0.03, 0.32, 0.12),
                (1.19, 0.07, 0.17, 0.06),
            ],
            sign * 0.32,
            "sandstone",
        )


def pavilion(m, name):
    d = ENDS[name]
    s = d["sign"]
    front, back, ef, eb = (d[k] for k in ("front", "back", "end_front", "end_back"))
    inner, shoulder, end = (s * d[k] for k in ("inner", "shoulder", "outer"))
    faces(m, d, name == "north")
    # Shallow entrance vestibules sit in the returns either side of each end.
    # Their sloping tile roofs meet the main wall below the upper floors.
    for v, outer, inner_y in ((-1, front, ef), (1, back, eb)):
        x0, x1 = sorted((shoulder, end - 1.55 * s))
        y0, y1 = sorted((outer, inner_y))
        ring = rect((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0)
        for a, b in edges(ring):
            panel(
                m,
                a,
                b,
                0.02,
                6.88,
                "lower-bays" if abs(a[1] - outer) < 0.02 and abs(b[1] - outer) < 0.02 else "ashlar",
            )
            shelf(m, a, b, 6.75, 0.13, 0.13)
        m.face([at(q, 6.87 + 0.38 * (q[1] - outer) * -v) for q in ring], "pantiles")
    lo, hi = sorted((inner, shoulder))
    eave = d["eave"]
    y = (front + back) / 2
    hipped_roof(m, lo - 0.32, hi + 0.32, front - 0.36, back + 0.36, eave, d["ridge"])
    l, r = sorted((shoulder - s * 3.4, end))
    hipped_roof(m, l - 0.23, r + 0.23, ef - 0.25, eb + 0.25, eave - 0.13, eave + 4.45)
    lantern(m, s * 88.30, y, d["ridge"] - 0.87, d["lantern"])
    for xx, yy in [(78.95, y - 3), (79.25, y + 3.4), (97.5, y + 4.3)]:
        band(m, s * xx, yy, 1.0, 1.28, eave + 2.7, 3.65, "chimney-brick")
        band(m, s * xx, yy, 1.17, 1.47, eave + 6.21, 0.26, "lead")
    # Low hooded vents along the street-facing pitch.
    for xx in np.linspace(lo + 4.1, hi - 4.1, 4):
        fy = front + 2.15
        h = eave + 0.80
        band(m, xx, fy, 1.25, 1.25, h, 0.55, "lead")
        m.face(
            [
                (xx - 0.78, fy - 0.80, h + 0.55),
                (xx + 0.78, fy - 0.80, h + 0.55),
                (xx + 0.65, fy + 0.65, h + 1.02),
                (xx - 0.65, fy + 0.65, h + 1.02),
            ],
            "tile",
        )
    for xx in (lo + 0.75, hi - 0.75):
        for yy in (front + 0.64, back - 0.64):
            roof_eagle(m, np.array([xx, yy]), [np.sign(xx - (lo + hi) / 2), np.sign(yy - y)], eave + 0.27)
    clocks(m, s * d["tower_x"], d["tower_y"], eave, d["summit"])
