"""Sculpt the street fleet on the standard door, axle and cabin layouts.

blender -b --factory-startup --python-exit-code 1 -P assets/cars/street_shapes.py
Coordinates are metres, +X forward, +Y left, Z up.
"""

import math
import sys
from bisect import bisect_right
from pathlib import Path

import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build import Car, build
from sedan_surfaces import lerp, smooth

# Rearward belt rise, roof shoulder roll, trailing roof setback, fender flare.
FORMS = {
    "hatch": (0.077, 0.092, 0.23, 0.035),
    "estate": (0.042, 0.074, 0.23, 0.033),
    "suv": (0.092, 0.110, 0.31, 0.055),
    "taxi": (0.087, 0.095, 0.00, 0.034),
    "police": (0.048, 0.075, 0.22, 0.036),
    "police_city": (0.078, 0.090, 0.02, 0.035),
    "van": (0.012, 0.093, 0.03, 0.034),
    "pickup": (0.018, 0.076, 0.06, 0.061),
    "sedan": (0.083, 0.092, 0.02, 0.034),
}


class StreetCar(Car):
    def __init__(self, name):
        super().__init__(name)
        self.kind = name
        self.rise, self.roll, self.setback, self.flare = FORMS[name]
        self.utility = name in ("van", "pickup")

    def patch(self, mat, us, vs, point, outward, door=0):
        rows = [[self.v(*point(u, v)) for u in us] for v in vs]
        for a, b in zip(rows, rows[1:]):
            for i in range(len(a) - 1):
                verts = [a[i], a[i + 1], b[i + 1], b[i]]
                if (verts[2].co - verts[0].co).cross(verts[3].co - verts[1].co).dot(outward) < 0:
                    verts.reverse()
                f = self.face(verts, mat)
                f[self.door] = door
                f.smooth = True

    def station(self, x):
        i = max(0, min(len(self.xs) - 2, bisect_right(self.xs, x) - 1))
        a, b = self.stations[i : i + 2]
        t = max(0, min(1, (x - a[0]) / (b[0] - a[0])))
        return tuple(lerp(p, q, t) for p, q in zip(a[1:], b[1:]))

    def belt(self, x):
        # The waist climbs steadily from the front door to the rear wheel and stays
        # there: the tail lamps and the plate are fitted that much higher (build.py).
        return self.station(x)[1] + self.rise * smooth((self.front_door - x) / 1.6)

    def side_width(self, x, z):
        width, _, sill = self.station(x)
        h = max(0, min(1, (z - sill) / (self.belt(x) - sill)))
        arches = min(math.hypot(x - axle, z - self.radius) for axle in self.axles)
        shoulder = math.exp(-(((h - 0.78) / 0.085) ** 2))
        arch = math.exp(-(((arches - self.arch - 0.035) / 0.105) ** 2))
        return (
            width
            - 0.093 * (1 - smooth(h / 0.31))
            # (a van's box stands straight up from its waist, without a car's rolled shoulder)
            - (0.035 if self.kind == "van" else 0.100) * smooth((h - 0.76) / 0.24) ** 1.5
            - 0.033 * math.sin(math.pi * h) ** 2
            + 0.017 * shoulder
            - 0.008 * math.exp(-((min(abs(x - e) for e in self.shut_lines) / 0.011) ** 2)) * smooth(h / 0.15)
            + self.flare * arch
        )

    def deck_height(self, x, y):
        belt = self.belt(x)
        q = min(1, abs(y) / self.side_width(x, belt))
        hood = smooth((x - self.cowl) / 0.22)
        ridge = (
            0.024
            * smooth((self.end - x) / 0.18)
            * math.exp(-(((q - (0.73 - 0.16 * smooth((x - self.front_door) / 1.15))) / 0.14) ** 2))
        )
        return belt + (1 - q * q) * (0.018 + 0.026 * hood) + hood * ridge * (1 - q**6)

    def body(
        self,
        stations,
        wheels=(),
        r=0.31,
        stripe=None,
        bonnet_band=None,
        doors=(),
        cabin=None,
        livery=None,
        crown=None,
    ):
        self.stations = sorted(stations)
        self.xs = [p[0] for p in self.stations]
        self.end, self.front_door = self.xs[-1], doors[0][0]
        lead = {
            "hatch": 0.33,
            "estate": 0.20,
            "suv": 0.24,
            "taxi": 0.23,
            "police": 0.20,
            "police_city": 0.23,
        }.get(self.kind, 0.065)
        self.shut_lines = sorted({edge for a, b, _ in doors for edge in (a, b)})
        self.cowl = self.front_door + lead
        self.axles, self.radius, self.arch = wheels, r, r + 0.045
        self.arch_ends = [a + s * self.arch for a in wheels for s in [-1, 1]]
        xs = {self.cowl} | set(self.xs) | set(cabin) | {e for a, b, _ in doors for e in (a, b)}
        xs.update(edge + off for edge in self.shut_lines for off in (-0.016, -0.004, 0.004, 0.016))
        xs.update(-self.end + 2 * self.end * i / 56 for i in range(1, 56))
        for a in wheels:
            xs.update(a + self.arch * math.cos(math.pi * j / 24) for j in range(25))
            xs.update(a + s * (self.arch + 0.018) for s in (-1, 1))
        xs = sorted(xs)
        # Remove coincident stations without moving a door cut onto the neighbouring panel.
        xs = [v for i, v in enumerate(xs) if not i or v - xs[i - 1] > 0.00002]
        stripes = stripe or []

        def lower(x):
            low = self.station(x)[2]
            for a in wheels:
                d = abs(x - a)
                if d <= self.arch:
                    return r + math.sqrt(max(0, self.arch**2 - d * d))
                if d < self.arch + 0.018:
                    return lerp(r, low, smooth((d - self.arch) / 0.018))
            return low

        # The same ordinate count at every station keeps continuous quads across the arches.
        levels = [(0, "Trim"), (0.072, "Paint")]
        for z, mat in stripes:
            levels.append((z, mat))
        levels.append((1, "Paint"))

        def section(x):
            hi, lo = self.belt(x), lower(x)
            cuts = [lo, lerp(lo, hi, 0.072)]
            for z, _ in stripes:
                cuts.append(min(hi - 0.012, max(cuts[-1] + 0.001, z)))
            cuts.append(hi)
            row = []
            for j, (bottom, top) in enumerate(zip(cuts, cuts[1:])):
                count = 1 if j == 0 else (6 if stripes else 15)
                for k in range(count):
                    row.append((lerp(bottom, top, k / count), levels[j][1]))
            return row + [(hi, "Paint")]

        def cutback(x, z):
            # Roll the top and valance back into the nose and tail. Keep the
            # plate and the slats on the centre band at their existing mount.
            e = smooth((abs(x) - self.end + 0.45) / 0.45)
            h = (z - self.station(x)[2]) / (self.belt(x) - self.station(x)[2])
            return x - math.copysign(e * (0.045 * (1 - smooth(h / 0.30)) + 0.062 * smooth((h - 0.73) / 0.27)), x)

        def face_x(x, z, q):
            # The centre of each bumper bows beyond the ends of the wings.
            reach = smooth((abs(x) - self.end + 0.42) / 0.42)
            return cutback(x, z) + math.copysign(0.036 * reach * (1 - q * q), x)

        rows = [section(x) for x in xs]
        for side in [-1, 1]:
            grid = [
                [self.v(cutback(x, z), side * self.side_width(x, z), z) for z, _ in row]
                for x, row in zip(xs, rows)
            ]
            for k, (a, b) in enumerate(zip(grid, grid[1:])):
                mid = (xs[k] + xs[k + 1]) / 2
                door = next((d + (side < 0) for front, back, d in doors if back < mid < front), 0)
                for i, (_, mat) in enumerate(rows[k][:-1]):
                    vs = [a[i], b[i], b[i + 1], a[i + 1]]
                    finish = livery(mid, mat) if livery else mat
                    if i and min(abs(mid - edge) for edge in self.shut_lines) < 0.004:
                        finish = "DoorSeam"
                    f = self.face(vs if side < 0 else vs[::-1], finish)
                    f.smooth = True
                    if i:
                        f[self.door] = door
            # Roll the fixed sill under the arch and into the wheel well.
            for k, (x0, x1) in enumerate(zip(xs, xs[1:])):
                mid = (x0 + x1) / 2
                if min(abs(mid - a) for a in wheels) > self.arch + 0.02:
                    continue
                p, q = grid[k][0].co, grid[k + 1][0].co
                f = self.face(
                    [
                        grid[k][0],
                        grid[k + 1][0],
                        self.v(q.x, q.y - side * 0.045, q.z + 0.007),
                        self.v(p.x, p.y - side * 0.045, p.z + 0.007),
                    ],
                    "Trim",
                )
                f.smooth = True
            for axle in wheels:
                # The lip has a rolled outer edge and a flat return. Split at the
                # same door cuts so the rear portion swings clear with the door.
                trim = self.kind in ("suv", "pickup")
                reach = 0.060 if trim else 0.029
                radius = self.arch + reach * 0.5
                angles = {math.pi * i / 32 for i in range(33)}
                angles.update(
                    math.acos((edge - axle) / radius) for edge in self.shut_lines if abs(edge - axle) < radius
                )
                angles = sorted(angles)

                def archlip(angle, t):
                    r = self.arch + t * reach
                    x, z = axle + r * math.cos(angle), self.radius + r * math.sin(angle)
                    y = self.side_width(x, z) + 0.0025 + 0.011 * math.sin(math.pi * t)
                    return (x, side * y, z)

                for a, b in zip(angles, angles[1:]):
                    mid = axle + radius * math.cos((a + b) / 2)
                    k = next((n + (side < 0) for front, back, n in doors if back < mid < front), 0)
                    self.patch(
                        "RubStrip" if trim else "Paint",
                        [a, b],
                        [0, 0.22, 0.74, 1],
                        archlip,
                        Vector((0, side, 0.15)),
                        k,
                    )
        for end, x, row in [(-1, xs[0], rows[0]), (1, xs[-1], rows[-1])]:

            def fascia(u, z):
                q = 2 * u - 1
                top = self.belt(x)
                y = q * self.side_width(x, z)
                blend = smooth((z - top + 0.13) / 0.13)
                return (face_x(x, z, q), y, z + blend * (self.deck_height(x, y) - top))

            self.patch("Paint", steps(14), [z for z, _ in row], fascia, Vector((end, 0, 0)))
        for a, b in zip(xs, xs[1:]):
            mid = (a + b) / 2
            if cabin[1] < mid < self.cowl or (self.kind == "pickup" and mid < cabin[1]):
                continue

            def deck(x, u):
                z = self.belt(x)
                y = (2 * u - 1) * self.side_width(x, z)
                return (face_x(x, z, 2 * u - 1), y, self.deck_height(x, y))

            self.patch("Paint", [a, b], steps(14), deck, Vector((0, 0, 1)))

    def front_intakes(self, panels, shell, lamp, low):
        # The grille follows the crown of the actual bumper all the way round
        # its corners. An inset dark face, four returns and a raised edge give
        # each opening visible depth from oblique angles.
        def projected(across, height, proud):
            return shell(1, 1 if across >= 0 else -1, abs(across), height, proud)

        def opening(lo, hi, bottom, top, taper, frame, slats):
            def point(u, v, inset, proud):
                u, v = lerp(inset, 1 - inset, u), lerp(inset, 1 - inset, v)
                # Trim the lower corners and carry the upper edge towards the headlamps.
                trim = taper * (1 - v) ** 2 + 0.012 * v**5
                reach = lerp(lo + trim, hi - trim, u)
                h = lerp(bottom, top, v) + 0.023 * (abs(reach) / max(abs(lo), abs(hi))) ** 3
                return Vector(projected(reach, h, proud))

            out = Vector((1, 0, 0.1))
            panels.patch("Trim", 18, 5, lambda u, v: point(u, v, 0.035, 0.009), out)
            for edge in [lambda t: (t, 0), lambda t: (t, 1), lambda t: (0, t), lambda t: (1, t)]:

                def rim(t, v):
                    u, b = edge(t)
                    return point(u, b, 0, 0.027).lerp(point(u, b, 0.035, 0.009), v)

                panels.patch("Trim", 18, 2, rim, out)
                panels.patch(frame, 18, 1, lambda t, v: point(*edge(t), 0.005 * v, 0.028), out)
            for i in range(slats):
                y = (i + 1) / (slats + 1)
                panels.patch(
                    "DarkChrome",
                    18,
                    2,
                    lambda u, v: point(u, y + 0.063 * (v - 0.5), 0.052, 0.021 + 0.004 * v),
                    out,
                )

        tall = self.utility
        top = lamp + (0.075 if tall else 0.055)
        opening(-0.49, 0.49, top - (0.198 if tall else 0.128), top, 0.075, "DarkChrome", 3 if tall else 2)
        opening(-0.56, 0.56, low + 0.008, low + (0.14 if tall else 0.133), 0.053, "RubStrip", 2)
        # A pair of cheek pockets bracket the lower mouth. Their angled inner
        # walls leave a painted bridge beneath each headlight.
        for sign in [-1, 1]:
            a, b = sorted((sign * 0.62, sign * 0.88))
            opening(a, b, low + 0.032, low + (0.173 if tall else 0.155), 0.053, "RubStrip", 2)

    def cabin(
        self,
        belt,
        xa,
        xb,
        xm,
        xc,
        xd,
        wb,
        wr,
        top,
        glass_rear=True,
        glass_back_side=True,
        xm_top=None,
        rear_doors=True,
        xq=None,
        edge=None,
        **kwargs,
    ):
        tall = self.kind in ("suv", "van", "pickup")
        # The front header leads the roof into the screen, while the rear
        # header falls away towards the hatch instead of ending at a right angle.
        xa = self.cowl
        xb += 0.06 + 0.70 * (xa - self.front_door)
        xc += self.setback

        long_roof = self.kind in ("estate", "suv", "police")
        fall_front = 0.045 if tall else 0.06
        fall_back = 0.04 if self.utility else 0.03 if long_roof else 0.07

        def rail(t):
            x = lerp(xb, xc, t)
            # Widest over the front seats, drawn in evenly to the windscreen and the
            # tail: a pinch near either end shows as a notch above the pillar.
            w = wr + 0.040 - 0.045 * (1 - t / 0.42) ** 2 if t < 0.42 else wr + 0.040 - 0.035 * ((t - 0.42) / 0.58) ** 2
            z = top - 0.04 - fall_front * (1 - smooth(t / 0.38)) - fall_back * smooth((t - 0.55) / 0.45)
            return x, w, z

        def roof(t, q):
            x, w, z = rail(t)
            # Tight transverse radii along the drip rails blend into a broad crown.
            return (
                x + (0.125 * (1 - t) ** 4 - (0.02 if self.utility else 0.103) * t**4) * (1 - q * q),
                q * w,
                z + self.roll * (1 - q**8) + 0.027 * (1 - q * q),
            )

        self.roof_point = roof

        def sidepane(low, high, v, s):
            # From `low` of the way along the belt up to `high` of the way along the
            # roof, in a straight line: that keeps every pillar straight.
            x = lerp(xa, xd, low)
            xx, ww, zz = rail(high)
            z = self.belt(x) - 0.006
            return (
                lerp(x, xx, v),
                s * (lerp(self.side_width(x, z), ww, v) + 0.020 * math.sin(math.pi * v)),
                lerp(z, zz, v),
            )

        def screen(t, u, v):
            x = xa if t == 0 else xd
            q = u * 2 - 1
            z = self.belt(x)
            y = q * self.side_width(x, z)
            a = Vector((x, y, self.deck_height(x, y) - 0.006))
            b = Vector(roof(t, q))
            return a.lerp(b, v) + Vector(
                ((1 if t == 0 else -1) * 0.062 * (1 - q * q) * math.sin(math.pi * v), 0, 0)
            )

        # A planar windscreen reads as a slab even if the paint is smooth.
        for t in [0, 1]:
            direction = Vector((1 if t == 0 else -1, 0, 0.3))
            surf = lambda u, v: screen(t, u, v)
            if t == 1 and not glass_rear:
                self.patch("Paint", steps(12), steps(7), surf, direction)
            else:
                self.window(surf, direction, 0, (0.052, 0.066, 0.070), 18, 9)
        self.patch("Paint", steps(22), [2 * u - 1 for u in steps(16)], roof, Vector((0, 0, 1)))
        self.patch(
            "Seat",
            steps(12),
            steps(6),
            lambda t, q: (roof(t, 2 * q - 1)[0], roof(t, 2 * q - 1)[1], roof(t, 2 * q - 1)[2] - 0.025),
            Vector((0, 0, -1)),
        )
        b = (xa - xm) / (xa - xd)
        rear_cut = (xa - xq) / (xa - xd) if xq is not None else 1
        # Meet the same lower door cut, while the B and C pillars lean back
        # only slightly at the header (the roof is much shorter than the belt).
        top_b = min(0.83, max(0.16, (xb - (xm - (0.07 if tall else 0.10))) / (xb - xc)))
        top_q = min(0.92, max(top_b + 0.08, (xb - (xq + 0.04)) / (xb - xc))) if xq is not None else 1
        sail = (xa - self.front_door) / (xa - xd)
        spans = [
            (0, sail, 0, 0.018, 0),
            (sail, b, 0.018, top_b, 1),
            (b, rear_cut, top_b, top_q, 3 if rear_doors else 0),
        ]
        if xq is not None:
            spans.append((rear_cut, 1, top_q, 1, 0))
        for s in [-1, 1]:
            normal = Vector((0, s, 0.24))
            for lo, hi, lid0, lid1, door in spans:

                def panel(u, v):
                    return sidepane(lerp(lo, hi, u), lerp(lid0, lid1, u), v, s)

                k = door + (s < 0) if door else 0
                if hi == sail:
                    self.patch("GlassSeal", steps(3), steps(7), panel, normal)
                elif not glass_back_side and lo >= b:

                    def cargo(u, v):
                        p = Vector(panel(u, v))
                        # Broad stamped recess with rounded run-outs in the steel panel van.
                        fade = (
                            smooth((u - 0.045) / 0.08)
                            * smooth((0.95 - u) / 0.08)
                            * smooth((v - 0.12) / 0.13)
                            * smooth((0.9 - v) / 0.13)
                        )
                        p.y -= s * 0.034 * fade
                        return p

                    self.patch("Paint", steps(30), steps(14), cargo, normal)
                    self.patch(
                        "PanelGap",
                        steps(18),
                        [0, 1],
                        lambda t, v: (
                            Vector(cargo(0.08 + 0.0025 * v, 0.075 + 0.80 * t)) + Vector((0, s * 0.0025, 0))
                        ),
                        normal,
                    )
                    self.patch(
                        "DarkChrome",
                        steps(15),
                        [0, 1],
                        lambda t, v: Vector(cargo(0.46 + 0.41 * t, 0.42 + 0.018 * v)) + Vector((0, s * 0.004, 0)),
                        normal,
                    )
                else:
                    frames = (
                        "DarkChrome",
                        "Paint",
                        "GlassSeal" if lo >= b else "Paint",
                        "GlassSeal" if hi <= rear_cut else "Paint",
                    )
                    self.window(panel, normal, k, (0.050 if k else 0.095, 0.046, 0.075), 12, 7, frames)
        if not self.utility and self.kind not in ("taxi", "police_city", "sedan"):
            # The tailgate glass tucks under a shallow lip. Both surfaces of
            # the overhang are present when it is seen from underneath.
            def lip(u, v):
                q = u * 2 - 1
                x, y, z = roof(1, q)
                return (x - v * 0.055 * (1 - 0.8 * q**4), y, z - 0.004 - 0.022 * v * v)

            self.patch("Paint", steps(16), steps(3), lip, Vector((0, 0, 1)))
            self.patch(
                "Trim",
                steps(16),
                [0, 1],
                lambda u, v: Vector(lip(u, v)) - Vector((0, 0, 0.015 * v)),
                Vector((0, 0, -1)),
            )
        self.roof_range = (xb, xc)

    def window(self, surf, normal, door, margins, cols, rows, frames=("Paint",) * 4):
        side, base, header = margins

        def uv(u, v, seal):
            # Round each corner in panel space; the larger trailing pillars on
            # the quarter lights are made from the same surface as their glass.
            k = max(0, 1 - min(v, 1 - v) / 0.14)
            inset = 0.062 * (1 - math.sqrt(max(0, 1 - k * k)))
            x = lerp(side + inset + seal, 1 - side - inset - seal, u)
            y = lerp(base + seal, 1 - header - seal, v)
            return Vector(surf(x, y)) - normal * (0.003 + seal * 0.55)

        def glass(u, v):
            return uv(u, v, 0.010)

        edges = [lambda t: (t, 0), lambda t: (t, 1), lambda t: (0, t), lambda t: (1, t)]
        for edge, finish in zip(edges, frames):
            for inside, mat in [(False, finish), (True, "GlassSeal")]:

                def strip(t, v):
                    u, q = edge(t)
                    a, b = (uv(u, q, 0), glass(u, q)) if inside else (Vector(surf(u, q)), uv(u, q, 0))
                    return a.lerp(b, v)

                self.patch(mat, steps(cols), [0, 1], strip, normal, door)
        self.patch("Window", steps(cols), steps(rows), glass, normal, door)

    def bed(self, shape, front, rail):
        rear = -self.end + 0.095
        width = self.station((rear + front) / 2)[0] - 0.13
        z = self.belt(front)
        super().block(((front + rear) / 2, 0, 0.75), (front - rear, 2 * width, 0.080), "Trim")
        for side in [-1, 1]:
            super().block(
                ((front + rear) / 2, side * width, (z + 0.72) / 2), (front - rear, 0.055, z - 0.72), "Trim"
            )
            super().block(
                ((front + rear) / 2, side * (width + 0.05), z - 0.005), (front - rear, 0.13, 0.034), "Paint"
            )
            self.patch(
                "Trim",
                steps(22),
                steps(8),
                lambda u, v: (
                    self.axles[1] + (0.49 + 0.10 * math.cos(v * math.pi / 2)) * math.cos(math.pi * u),
                    side * (width - 0.21 * math.sin(v * math.pi / 2)),
                    0.755 + (0.21 + 0.05 * math.cos(v * math.pi / 2)) * math.sin(math.pi * u),
                ),
                Vector((0, -side, 0.5)),
            )
        for x in [front - 0.03, rear]:
            super().block((x, 0, (z + 0.73) / 2), (0.055, 2 * width, z - 0.73), "Trim")
        for i in range(-4, 5):
            super().block(((front + rear) / 2, i * width / 5, 0.795), (front - rear - 0.11, 0.037, 0.021), "Trim")
        super().block((rear, 0, z - 0.008), (0.11, 2 * width + 0.08, 0.044), "Paint")

    def screen(self, shape, xa, xb, z0, top, e):
        self.screen_layout = (self.cowl, self.roof_range[0], z0, top, e)

    def line(self, x0, x1, w, floor, belt, top, xb, xc, wr):
        # The floor reaches the sills between the wheels and stays inside the tyres
        # beside them, where it would show through the arches.
        cuts = sorted({x0, x1, *(min(x0, max(x1, e)) for e in self.arch_ends)}, reverse=True)
        for a, b in zip(cuts, cuts[1:]):
            beside = any(abs((a + b) / 2 - axle) < self.arch for axle in self.axles)
            if a - b > 0.001:
                super().block(((a + b) / 2, 0, floor), (a - b, 2 * w - (0.50 if beside else 0.06), 0.045), "Seat")
        for x in [x0 - 0.06, x1 + 0.08]:
            beside = any(abs(x - axle) < self.arch + 0.03 for axle in self.axles)
            super().block((x, 0, (floor + belt) / 2), (0.055, 2 * w - (0.50 if beside else 0.075), belt - floor), "Seat")
        if self.kind == "van":
            super().block((x1 + 0.06, 0, (top + floor) / 2), (0.07, 2 * wr, top - floor), "Seat")

    def block(self, c, size, mat):
        if mat.startswith("Simple") or mat in ("Lamp", "Tail", "Plate"):
            return
        super().block(c, size, mat)

    def roof_rails(self, xb, xc, wr, roof):
        # A low bar along each edge of the roof. It follows the roof a finger's width
        # above it and comes down onto a foot at each end and one in the middle.
        inset, clear = 0.80, 0.030

        def along(t, side):
            return Vector(self.roof_point(lerp(0.09, 0.90, t), side * inset))

        for side in (-1, 1):

            def cross(t, angle):
                p = along(t, side)
                stand = clear * smooth(t / 0.07) * smooth((1 - t) / 0.07)
                return (p.x, p.y + 0.017 * math.cos(angle), p.z + 0.010 + stand + 0.011 * math.sin(angle))

            for i in range(8):
                angle = math.tau * (i + 0.5) / 8
                self.patch(
                    "Trim",
                    steps(24),
                    [math.tau * i / 8, math.tau * (i + 1) / 8],
                    cross,
                    Vector((0, math.cos(angle), math.sin(angle))),
                )
            for t in (0.09, 0.5, 0.91):
                p = along(t, side)
                super().block((p.x, p.y, p.z + clear / 2), (0.10, 0.030, clear + 0.016), "Trim")

    def roof_pressings(self, xa, nb, wr, height):
        for y in [-0.66, -0.22, 0.22, 0.66]:
            self.patch(
                "Paint",
                steps(16),
                steps(6),
                lambda t, u: (
                    Vector(self.roof_point(lerp(0.12, 0.90, t), y + (u - 0.5) * 0.08))
                    + Vector((0, 0, 0.003 + 0.018 * math.sin(math.pi * u) * math.sin(math.pi * t)))
                ),
                Vector((0, 0, 1)),
            )

    def aerial(self, xc, roof):
        x, _, z = self.roof_point(0.86, 0)
        self.patch(
            "Trim",
            steps(8),
            steps(8),
            lambda t, u: (
                x + lerp(-0.082, 0.072, t),
                0.025 * (2 * u - 1) * math.sin(math.pi * t),
                z + 0.003 + 0.057 * math.sin(math.pi * t) ** 0.8 * (1 - u**4) * (1 - (1 - u) ** 4),
            ),
            Vector((0, 0, 1)),
        )

    def taxi_sign(self, mid, height):
        x, _, z = self.roof_point(0.48, 0)
        for y in [-0.21, 0.21]:
            super().block((x, y, z + 0.009), (0.22, 0.07, 0.04), "Trim")

        # Five rings form the low, tapered roof box with a rubber gasket.
        def at(t, a):
            w, h = [(0.30, 0.022), (0.315, 0.040), (0.297, 0.108), (0.252, 0.178), (0.225, 0.185)][int(t)]
            ca, sa = math.cos(a), math.sin(a)
            return (
                x + 0.122 * math.copysign(abs(ca) ** 0.52, ca) * (w / 0.3),
                w * math.copysign(abs(sa) ** 0.52, sa),
                z + h,
            )

        angles = [math.tau * i / 28 for i in range(29)]
        for i in range(28):
            a = (angles[i] + angles[i + 1]) / 2
            for k in range(4):
                self.patch(
                    "Trim" if k == 0 else "Sign",
                    [k, k + 1],
                    angles[i : i + 2],
                    at,
                    Vector((math.cos(a), math.sin(a), 0.15)),
                )
        self.face([self.v(*at(4, a)) for a in angles[:-1]], "Sign")

    def strip(self, x0, x1, ys, mat, z, lift=0.008):
        if mat == "Glass" and hasattr(self, "roof_range"):
            self.patch(
                "Glass",
                steps(12),
                steps(10),
                lambda t, u: (
                    Vector(self.roof_point(lerp(0.13, 0.61, t), lerp(-0.67, 0.67, u))) + Vector((0, 0, 0.003))
                ),
                Vector((0, 0, 1)),
            )
        else:
            super().strip(x0, x1, ys, mat, z, lift)

    def bumper(self, *args):
        pass  # Fitted bumper surfaces are exported by build_trim.

    def lamps(self, *args, **kwargs):
        pass

    def wheel(self, *args, **kwargs):
        pass  # Use the animated wheel mounts of the base car.


def steps(count):
    return [i / count for i in range(count + 1)]


def export():
    roots = build(factory=StreetCar)
    for root in roots:
        name = root.name
        if name not in FORMS or name == "sedan":
            continue
        trim = bpy.data.objects[name + "_street_trim"]
        bpy.ops.object.select_all(action="DESELECT")
        for obj in [root, *root.children_recursive, trim]:
            obj.select_set(True)
        file = HERE.parents[1] / "public" / f"{name}-street.glb"
        bpy.ops.export_scene.gltf(
            filepath=str(file),
            use_selection=True,
            export_format="GLB",
            export_texcoords=False,
            export_normals=True,
            export_extras=True,
            export_yup=True,
            export_meshopt_compression_enable=True,
            export_meshopt_extension="EXT_meshopt_compression",
            export_animations=False,
            export_cameras=False,
            export_lights=False,
        )
        print(f"Wrote {file.name}: {file.stat().st_size:,} bytes")


if __name__ == "__main__":
    export()
