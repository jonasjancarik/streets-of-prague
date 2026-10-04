"""Build the car bodies into public/cars.glb.

One low-poly mesh per car type (hatch, sedan, estate, suv, van, pickup, taxi, police), and the
ram frame some police cars carry (police_ram, put on the body in src/car.ts), made from
code so they can be tweaked and rebuilt. The game looks down on them, so what counts is
the shape from above and a little of the sides: a body rounded off at the corners in
plan, the bonnet and boot, a cabin narrower than the body with the windscreen and rear
window raked back, pillars, the wheels, mirrors and lights.

Conventions: metres, Z up, facing +X, left is +Y, wheels on z = 0, centred on the
origin; the glTF exporter turns this into three.js's Y up, still facing +X. Each object
is named after its type in src/car.ts (TYPES), with the same length, width and height.
Materials are named after the part they colour (Paint, Glass, Trim, Tyre, Metal, Lamp,
Tail, Plate, Sign, Blue, Yellow, Bar, Seat); src/car.ts colours them by name and puts the
car's own colour on Paint.

Doors are objects of their own, children of the body: <type>_door1 (front left), 2 (front
right), 3 and 4 (rear), each with its origin on its hinge line, so the game can swing
them open (src/car.ts). Inside there's a floor, walls and seats, seen only through an
open door.

usage: blender -b --factory-startup -P assets/cars/build.py
       blender -b --factory-startup -P assets/cars/build.py -- --preview DIR
       (renders the cars from above, as the game sees them, into DIR)
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "public" / "cars.glb"

# Only for the preview renders; the game picks its own colours.
COLOURS = {
    "Paint": (0.35, 0.05, 0.05), "Glass": (0.02, 0.03, 0.04), "Trim": (0.02, 0.02, 0.02),
    "Tyre": (0.01, 0.01, 0.01), "Metal": (0.35, 0.37, 0.4), "Lamp": (0.95, 0.9, 0.7),
    "Tail": (0.5, 0.02, 0.02), "Plate": (0.85, 0.85, 0.82), "Sign": (0.95, 0.9, 0.55),
    "Blue": (0.02, 0.08, 0.4), "Yellow": (0.7, 0.75, 0.05), "Bar": (0.02, 0.02, 0.03),
    "Seat": (0.07, 0.07, 0.075),
}
MATS = list(COLOURS)


def material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*COLOURS[name], 1)
    bsdf.inputs["Roughness"].default_value = 0.6
    m.diffuse_color = (*COLOURS[name], 1)
    return m


# ---- Shapes -----------------------------------------------------------------
#
# The body is lofted through cross-sections along the car. Each section is the left
# half from the sill up to the edge of the bonnet (mirrored for the right), the bands
# between its points coloured one by one: black plastic along the bottom, paint above,
# and on the police car the blue and yellow stripe.


class Car:
    def __init__(self):
        self.bm = bmesh.new()
        self.under = []  # faces that close the body for working out normals, then go
        self.door = self.bm.faces.layers.int.new("door")  # which door a face is part of (0: none)
        self.inside = []  # the interior, added once the normals are worked out
        self.decals = []  # flat quads lying on the body (lettering), added then too

    def face(self, verts, mat):
        f = self.bm.faces.new(verts)
        f.material_index = MATS.index(mat)
        return f

    def v(self, x, y, z):
        return self.bm.verts.new((x, y, z))

    def body(self, stations, wheels=(), r=0.31, stripe=None, bonnet_band=None, doors=(), cabin=None, livery=None):
        """stations: (x, half width, height of the top, height of the sill), front to
        back. Over each wheel (at x in `wheels`, radius `r`) the sill rises in an arch.
        doors: (x of the front edge, x of the back edge, number of the left door), the
        right one being the next number. cabin: (front, back), where the top is left open
        under the cabin, so the seats show through an open door. livery: (x, material)
        to the material a band of the side has at x, for a stripe that changes along the car."""
        def at(x):
            for (x0, *a), (x1, *b) in zip(stations, stations[1:]):
                if x1 <= x <= x0:
                    u = (x0 - x) / (x0 - x1)
                    return [p + (q - p) * u for p, q in zip(a, b)]
            return list(stations[0 if x > 0 else -1][1:])
        ra = r + 0.05
        arch = {}
        for xw in wheels:
            for k in range(5):
                t = math.pi * k / 4
                arch[xw + ra * math.cos(t)] = r + ra * math.sin(t)
            for e in (1, -1):
                arch[xw + e * (ra + 0.002)] = None
        xs = {s[0] for s in stations} | set(arch)
        for x0, x1, _ in doors:
            xs |= {x for x in (x0, x1) if all(abs(x - k) > 1e-4 for k in xs)}
        xs = sorted(xs, reverse=True)
        rings = []
        for x in xs:
            w, zt, z0 = at(x)
            z0 = max(z0, arch.get(x) or 0)
            lo = max(z0 + 0.01, min(z0 + 0.13, zt - 0.15))
            hi = max(lo + 0.01, zt - 0.13)
            pts = [(w - 0.05, z0, "Trim"), (w, lo, "Paint")]
            for z, mat in stripe or ():
                pts.append((w, min(max(z, pts[-1][1] + 0.002), hi - 0.002), mat))
            pts += [(w, hi, "Paint"), (w - 0.035, zt - 0.035, "Paint"), (w - 0.11, zt, "Paint")]
            L = [self.v(x, y, z) for y, z, _ in pts]
            R = [self.v(x, -y, z) for y, z, _ in pts]
            rings.append((L, R, [m for _, _, m in pts]))
        for s in range(len(rings) - 1):
            (L0, R0, mats), (L1, R1, _) = rings[s], rings[s + 1]
            mid = (xs[s] + xs[s + 1]) / 2
            door = next((k for x0, x1, k in doors if x1 < mid < x0), 0)
            for i in range(len(L0) - 1):
                mat = livery(mid, mats[i]) if livery else mats[i]
                left = self.face([L0[i], L1[i], L1[i + 1], L0[i + 1]], mat)
                right = self.face([R0[i], R0[i + 1], R1[i + 1], R1[i]], mat)
                # (The black sill under a door stays on the body.)
                if door and i:
                    left[self.door], right[self.door] = door, door + 1
            top = "Blue" if bonnet_band and bonnet_band[0] < mid < bonnet_band[1] else "Paint"
            lid = self.face([L0[-1], L1[-1], R1[-1], R0[-1]], top)
            if cabin and cabin[1] < mid < cabin[0]:
                self.under.append(lid)
            self.under.append(self.face([L0[0], R0[0], R1[0], L1[0]], "Trim"))
        for L, R, mats in (rings[0], rings[-1]):
            for i in range(len(L) - 1):
                # Bumpers across the bottom, paint above.
                self.face([L[i], L[i + 1], R[i + 1], R[i]], "Trim" if i == 0 else "Paint")

    def cabin(self, belt, xa, xb, xm, xc, xd, wb, wr, top, glass_rear=True, glass_back_side=True, xm_top=None,
              rear_doors=True, xq=None):
        """Windscreen from (xa, belt) up to (xb, top), roof to xc, rear window down to
        xd; sides from half width wb at the belt to wr at the roof, split at xm by the
        B pillar. Every window is inset, so the pillars and frames show in paint.
        The front side windows are part of doors 1 and 2, the back ones of 3 and 4 (with
        rear_doors): as far back as xq, where another pillar ends the door, if xq is given."""
        xm_top = xm if xm_top is None else xm_top
        z0 = belt - 0.02
        A, M, D = ([self.v(x, s * wb, z0) for s in (1, -1)] for x in (xa, xm, xd))
        B, T, C = ([self.v(x, s * wr, top) for s in (1, -1)] for x in (xb, xm_top, xc))
        screen = self.face([A[0], A[1], B[1], B[0]], "Glass")
        rear = self.face([D[1], D[0], C[0], C[1]], "Glass")
        sides_front = [self.face([A[0], B[0], T[0], M[0]], "Glass"), self.face([A[1], M[1], T[1], B[1]], "Glass")]
        for k, f in enumerate(sides_front):
            f[self.door] = 1 + k
        self.face([B[0], B[1], T[1], T[0]], "Paint")
        if xq is None:
            sides_back = [self.face([M[0], T[0], C[0], D[0]], "Glass"), self.face([M[1], D[1], C[1], T[1]], "Glass")]
            behind = sides_back
            self.face([T[0], T[1], C[1], C[0]], "Paint")
            floor = self.face([A[0], M[0], D[0], D[1], M[1], A[1]], "Paint")
        else:
            Q = [self.v(xq, s * wb, z0) for s in (1, -1)]
            P = [self.v(xq - 0.06, s * wr, top) for s in (1, -1)]
            behind = [self.face([M[0], T[0], P[0], Q[0]], "Glass"), self.face([M[1], Q[1], P[1], T[1]], "Glass")]
            sides_back = behind + [self.face([Q[0], P[0], C[0], D[0]], "Glass"), self.face([Q[1], D[1], C[1], P[1]], "Glass")]
            self.face([T[0], T[1], P[1], C[1], C[0], P[0]], "Paint")
            floor = self.face([A[0], M[0], Q[0], D[0], D[1], Q[1], M[1], A[1]], "Paint")
        if rear_doors:
            for k, f in enumerate(behind):
                f[self.door] = 3 + k
        # (The floor under the windows is only there to close the shape.)
        self.under.append(floor)
        self.inset([screen], 0.055)
        self.inset(sides_front + (sides_back if glass_back_side else []), 0.06)
        if not glass_back_side:
            for f in sides_back:
                f.material_index = MATS.index("Paint")
        if glass_rear:
            self.inset([rear], 0.06)
        else:
            rear.material_index = MATS.index("Paint")

    def inset(self, faces, t):
        for face in faces:
            ring = bmesh.ops.inset_individual(self.bm, faces=[face], thickness=t, depth=-0.012)["faces"]
            for f in ring:
                f.material_index = MATS.index("Paint")
                f[self.door] = face[self.door]

    def interior(self, x0, x1, w, floor, belt, top, xb, xc, wr, seats):
        """What shows through an open door: a floor and walls from x0 back to x1 up to
        the belt, the lining of the roof (from xb to xc, half width wr) and the seats:
        (x, y, width) of each."""
        self.inside.append((x0, x1, w, floor, belt, top, xb, xc, wr))
        for x, y, width in seats:
            self.block((x, y, floor + 0.13), (0.5, width, 0.26), "Seat")
            self.block((x - 0.3, y, floor + 0.45), (0.14, width, 0.62), "Seat")

    def line(self, x0, x1, w, floor, belt, top, xb, xc, wr):
        """The inside faces of the cabin, each facing the middle of it."""
        middle = Vector(((x0 + x1) / 2, 0, (floor + top) / 2))

        def quad(*points):
            f = self.face([self.v(*p) for p in points], "Seat")
            f.normal_update()
            if f.normal.dot(middle - f.calc_center_median()) < 0:
                f.normal_flip()

        lo = [(x0, w), (x0, -w), (x1, -w), (x1, w)]
        hi = [(xb, wr), (xb, -wr), (xc, -wr), (xc, wr)]
        quad(*((x, y, floor) for x, y in lo))
        quad(*((x, y, top) for x, y in hi))
        for (a, b), (c, d) in zip(zip(lo, lo[1:] + lo[:1]), zip(hi, hi[1:] + hi[:1])):
            quad((*a, floor), (*b, floor), (*b, belt), (*a, belt))
            quad((*a, belt), (*b, belt), (*d, top), (*c, top))

    def text(self, word, x, px, top, mat):
        """A word lying on the bonnet, read from in front of the car: the tops of its
        letters at x, each pixel px across, `top(x)` the height of the bonnet there."""
        pitch = 6 * px
        y0 = -(len(word) * pitch - px) / 2
        for i, ch in enumerate(word):
            for r, row in enumerate(GLYPHS[ch]):
                c = 0
                while c < 5:
                    if row[c] != "1":
                        c += 1
                        continue
                    e = c
                    while e < 5 and row[e] == "1":
                        e += 1
                    xa, xb = x + r * px, x + (r + 1) * px
                    ya, yb = y0 + i * pitch + c * px, y0 + i * pitch + e * px
                    self.decals.append(([(xa, ya, top(xa) + 0.006), (xb, ya, top(xb) + 0.006),
                                         (xb, yb, top(xb) + 0.006), (xa, yb, top(xa) + 0.006)], mat))
                    c = e

    def block(self, c, s, mat):
        (cx, cy, cz), (sx, sy, sz) = c, s
        vs = [self.v(cx + dx * sx / 2, cy + dy * sy / 2, cz + dz * sz / 2)
              for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.face([vs[i] for i in q], mat)

    def wheel(self, x, y, r, width, n=10):
        """A tyre with a hub on the outside, at (x, y) with y the outer face."""
        s = 1 if y > 0 else -1

        def ring(rad, dy):
            return [self.v(x + rad * math.cos(a), y - s * dy, r + rad * math.sin(a))
                    for a in (2 * math.pi * k / n for k in range(n))]

        # The inside of the tyre is left open: it's never seen.
        rings = [ring(r * 0.55, 0.015), ring(r * 0.9, 0), ring(r, 0.035), ring(r, width)]
        for A, B in zip(rings, rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                self.face([A[i], A[j], B[j], B[i]], "Tyre")
        self.face(rings[0], "Metal")

    def wheels(self, xs, w, r, width=0.21):
        for x in xs:
            for s in (1, -1):
                self.wheel(x, s * (w - 0.04), r, width)

    def mirrors(self, x, w, z):
        for s in (1, -1):
            self.block((x, s * (w - 0.02), z), (0.1, 0.22, 0.11), "Paint")

    def lamps(self, front, back, w_front, w_back, z_front, z_back):
        for s in (1, -1):
            self.block((front + 0.02, s * w_front, z_front), (0.1, 0.3, 0.1), "Lamp")
            self.block((back - 0.02, s * w_back, z_back), (0.1, 0.26, 0.13), "Tail")
        self.block((front + 0.03, 0, 0.42), (0.04, 0.5, 0.11), "Plate")
        self.block((back - 0.03, 0, 0.62), (0.04, 0.5, 0.11), "Plate")

    def finish(self, name):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.delete(bm, geom=self.under, context="FACES_ONLY")
        for box in self.inside:
            self.line(*box)
        for points, mat in self.decals:
            f = self.face([self.v(*p) for p in points], mat)
            f.normal_update()
            if f.normal.z < 0:
                f.normal_flip()
        doors = [self.hang(k) for k in sorted({f[self.door] for f in bm.faces} - {0})]
        obj = self.object(name, bm)
        for k, (door, hinge) in doors:
            d = self.object(f"{name}_door{k}", door)
            d.parent = obj
            d.location = hinge
        return obj

    def hang(self, k):
        """Takes door k's faces off the body: a mesh of its own, lined on the inside,
        with its hinge (the front edge, on the ground) at the origin."""
        faces = [f for f in self.bm.faces if f[self.door] == k]
        side = 1 if faces[0].calc_center_median().y > 0 else -1
        points = [v.co for f in faces for v in f.verts]
        front = max(p.x for p in points)
        hinge = Vector((front, side * max(abs(p.y) for p in points if p.x > front - 0.02), 0))
        door = bmesh.new()
        glass = MATS.index("Glass")
        for f in faces:
            skin = [door.verts.new(v.co - hinge) for v in f.verts]
            door.faces.new(skin).material_index = f.material_index
            lining = [door.verts.new(v.co - hinge - Vector((0, side * 0.035, 0))) for v in reversed(f.verts)]
            door.faces.new(lining).material_index = glass if f.material_index == glass else MATS.index("Seat")
        bmesh.ops.delete(self.bm, geom=faces, context="FACES")
        bmesh.ops.remove_doubles(door, verts=door.verts, dist=1e-5)
        return k, (door, hinge)

    @staticmethod
    def object(name, bm):
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        for m in MATS:
            mesh.materials.append(material(m))
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(38))
        # Drop the material slots nothing uses, so the export stays small.
        used = {p.material_index for p in mesh.polygons}
        for i in reversed(range(len(MATS))):
            if i not in used:
                obj.active_material_index = i
                bpy.ops.object.material_slot_remove()
        return obj


# ---- The cars ---------------------------------------------------------------
# Lengths, widths and heights as in src/car.ts TYPES.


def saloon(name, L, W, H, rear, stripe=None, sign=False, bar=None, rails=False, r=0.31, lift=0.0, word=None):
    """A car: `rear` is 'hatch', 'sedan' or 'estate'; `bar` is where along the roof the
    light bar goes (the middle of `cabin` in src/car.ts, where src/police.ts flashes it).
    `r` is the wheel radius and `lift` how much higher the bonnet and sills sit (an SUV).
    `word` is written across the bonnet, and the stripe then turns into yellow and blue
    blocks on the front wings and behind the rear doors (the Czech police's colours)."""
    c = Car()
    w, n = W / 2, L / 2
    belt = 0.93 if H < 1.48 else 0.95 if H < 1.6 else 1.03
    boot = {"hatch": belt, "sedan": belt + 0.03, "estate": belt}[rear]
    stations = [
        (n, w * 0.8, 0.7 + lift, 0.3 + lift), (n - 0.12, w * 0.93, 0.76 + lift, 0.26 + lift),
        (n - 0.35, w * 0.985, 0.8 + lift, 0.24 + lift), (n - 0.8, w, 0.84 + lift, 0.22 + lift),
        (n - 1.25, w, belt - 0.01, 0.22 + lift), (n - 1.45, w, belt, 0.22 + lift),
        (-n + 0.7, w, boot, 0.22 + lift), (-n + 0.3, w * 0.985, boot, 0.24 + lift),
        (-n + 0.1, w * 0.95, boot - 0.02, 0.27 + lift), (-n, w * 0.86, boot - 0.06, 0.3 + lift),
    ]
    xa = n - 1.45
    if rear == "hatch":
        xb, xc, xd = xa - 0.72, -n + 0.45, -n + 0.12
    elif rear == "sedan":
        xb, xc, xd = xa - 0.78, -n + 1.55, -n + 0.85
    else:
        xb, xc, xd = xa - 0.78, -n + 0.3, -n + 0.1
    xm = (xa + xd) / 2 + 0.1
    wheels = (n - 0.82, -n + 0.8)
    # The rear doors end over the wheel, their bottom edge following its arch; a window
    # going on behind that (a hatchback's, an estate's) gets a pillar there.
    xq = max(wheels[1] + 0.05, xm - 0.95)
    back = max(xd + 0.05, -n + 0.3)
    def livery(x, mat):
        if mat != "Blue" or xq < x < xa:
            return mat
        return "Paint" if x > n - 0.3 or x < -n + 0.25 else "Yellow" if int((x + n) / 0.19) % 2 else "Blue"

    c.body(stations, wheels, r, stripe=stripe, doors=[(xa, xm, 1), (xm, xq, 3)], cabin=(xa, back),
           livery=livery if word else None)
    if word:
        def top(x):
            for (x0, _, z0, _), (x1, _, z1, _) in zip(stations, stations[1:]):
                if x1 <= x <= x0:
                    return z0 + (z1 - z0) * (x0 - x) / (x0 - x1)
            return stations[0][2]
        c.text(word, n - 1.17, 0.038, top, "Blue")
    c.cabin(belt, xa, xb, xm, xc, xd, w - 0.11, w * 0.74, H, xm_top=(xb + xc) / 2 + 0.05,
            xq=xq if xq - 0.06 > xc + 0.3 else None)
    floor = 0.36 + lift
    c.interior(xa - 0.01, back, w - 0.08, floor, belt - 0.02, H - 0.03, xb - 0.03, xc + 0.03, w * 0.74 - 0.03,
               [((xa + xm) / 2 - 0.1, s * w * 0.48, 0.5) for s in (1, -1)] + [((xm + xq) / 2 - 0.05, 0, W - 0.4)])
    c.wheels(wheels, w, r)
    c.mirrors(xa - 0.08, w, belt + 0.07)
    c.lamps(n - 0.06, -n + 0.04, w * 0.6, w * 0.68, 0.64 + lift, boot - 0.12)
    mid = (xb + xc) / 2
    if sign:
        c.block((mid, 0, H + 0.1), (0.24, 0.62, 0.2), "Sign")
    if bar is not None:
        # A long low bar nearly as wide as the roof: blue lenses at the ends, clear between.
        c.block((bar, 0, H + 0.035), (0.36, W * 0.8, 0.07), "Bar")
        c.block((bar, 0, H + 0.095), (0.3, W * 0.26, 0.05), "Metal")
        for s in (1, -1):
            c.block((bar, s * W * 0.265, H + 0.1), (0.32, W * 0.25, 0.06), "Blue")
    if rails:
        for s in (1, -1):
            c.block(((xb + xc) / 2, s * (w * 0.74 - 0.05), H + 0.03), (xb - xc - 0.1, 0.05, 0.05), "Trim")
    return c.finish(name)


def van(name="van", L=5.2, W=2.0, H=2.3):
    c = Car()
    w, n = W / 2, L / 2
    belt = 1.05
    stations = [
        (n, w * 0.84, 0.8, 0.34), (n - 0.12, w * 0.95, 0.88, 0.3), (n - 0.4, w, 0.96, 0.28),
        (n - 0.62, w, belt, 0.28), (-n + 0.2, w, belt, 0.28), (-n, w * 0.97, belt, 0.32),
    ]
    xa = n - 0.62
    wheels = (n - 0.9, -n + 0.95)
    xm = xa - 1.05
    c.body(stations, wheels, 0.34, doors=[(xa, xm, 1)], cabin=(xa, xm - 0.3))
    # A tall box behind the cab: windows only in the cab doors, none in the back.
    c.cabin(belt, xa, xa - 0.72, xm, -n + 0.06, -n + 0.02, w - 0.02, w * 0.93, H,
            glass_rear=False, glass_back_side=False, xm_top=xm, rear_doors=False)
    c.interior(xa - 0.01, xm - 0.3, w - 0.08, 0.5, belt - 0.02, H - 0.03, xa - 0.75, xm - 0.3, w * 0.93 - 0.03,
               [(xa - 0.6, s * w * 0.5, 0.55) for s in (1, -1)])
    c.wheels(wheels, w, 0.34, 0.23)
    c.mirrors(xa - 0.05, w + 0.03, belt + 0.1)
    c.lamps(n - 0.05, -n + 0.02, w * 0.66, w * 0.86, 0.72, 0.85)
    return c.finish(name)


def pickup(name="pickup", L=5.9, W=2.03, H=1.95):
    """A full-size American pickup (an F-150): a long bonnet, a crew cab and an open bed."""
    c = Car()
    w, n = W / 2, L / 2
    belt, rail, r = 1.24, 1.2, 0.4
    stations = [
        (n, w * 0.82, 1.02, 0.44), (n - 0.15, w * 0.94, 1.1, 0.42), (n - 0.5, w * 0.985, 1.17, 0.4),
        (n - 1.0, w, rail, 0.38), (-n + 0.1, w, rail, 0.38), (-n, w * 0.97, rail - 0.05, 0.4),
    ]
    xa = n - 1.5
    xd = xa - 2.4
    wheels = (n - 1.05, -n + 1.05)
    xm = xa - 1.2
    c.body(stations, wheels, r, doors=[(xa, xm, 1), (xm, xd + 0.08, 3)], cabin=(xa, xd + 0.05))
    c.cabin(belt, xa, xa - 0.65, xm, xd + 0.1, xd, w - 0.12, w * 0.8, H, xm_top=xa - 1.15)
    c.interior(xa - 0.01, xd + 0.05, w - 0.08, 0.6, belt - 0.02, H - 0.03, xa - 0.68, xd + 0.13, w * 0.8 - 0.03,
               [(xa - 0.65, s * w * 0.48, 0.55) for s in (1, -1)] + [(xm - 0.6, 0, W - 0.4)])
    c.wheels(wheels, w, r, 0.28)
    c.mirrors(xa - 0.1, w + 0.02, belt + 0.1)
    c.lamps(n - 0.06, -n + 0.04, w * 0.72, w * 0.8, 0.86, 0.98)
    # The bed: a dark floor between paint rails, and the tailgate.
    end = -n + 0.06
    c.block(((xd + end) / 2 - 0.02, 0, rail + 0.012), (xd - end - 0.2, W - 0.3, 0.024), "Trim")
    for s in (1, -1):
        c.block(((xd + end) / 2, s * (w - 0.07), rail + 0.03), (xd - end, 0.14, 0.06), "Paint")
    c.block((end + 0.04, 0, rail + 0.04), (0.08, W - 0.04, 0.08), "Paint")
    c.block((xd - 0.06, 0, rail + 0.04), (0.1, W - 0.04, 0.08), "Paint")
    return c.finish(name)


POLICE_STRIPE = [(0.55, "Blue"), (0.77, "Paint")]

# The letters on the police car's bonnet, 5 × 7 pixels each.
GLYPHS = {
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
    "C": ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
}


def ram(name, L, W):
    """The black tube frame some police cars carry on the nose, for pushing a car they're
    chasing off the road: a part of its own, which src/car.ts puts on the body."""
    c = Car()
    w, n = W / 2, L / 2
    c.block((n + 0.14, 0, 0.5), (0.09, W * 0.94, 0.1), "Trim")  # the bar across the bumper
    c.block((n + 0.13, 0, 0.74), (0.07, W * 0.6, 0.07), "Trim")  # and the one over the grille
    c.block((n + 0.1, 0, 0.33), (0.16, W * 0.7, 0.07), "Trim")  # the plate under the nose
    for s in (1, -1):
        c.block((n + 0.13, s * w * 0.56, 0.55), (0.08, 0.08, 0.46), "Trim")  # the uprights
        c.block((n - 0.05, s * (w * 0.94), 0.5), (0.36, 0.08, 0.1), "Trim")  # round the corners
        c.block((n + 0.11, s * w * 0.8, 0.66), (0.06, w * 0.5, 0.06), "Trim")  # hoops before the lamps
    return c.finish(name)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return [
        saloon("hatch", 3.9, 1.75, 1.45, "hatch"),
        saloon("sedan", 4.6, 1.82, 1.45, "sedan"),
        saloon("estate", 4.7, 1.82, 1.5, "estate", rails=True),
        saloon("suv", 4.65, 1.88, 1.65, "estate", rails=True, r=0.36, lift=0.07),
        van(),
        pickup(),
        saloon("taxi", 4.6, 1.82, 1.45, "sedan", sign=True),
        saloon("police", 4.7, 1.84, 1.5, "estate", stripe=POLICE_STRIPE, bar=-0.25, rails=True, word="POLICIE"),
        ram("police_ram", 4.7, 1.84),
    ]


def export():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), export_format="GLB", export_texcoords=False, export_normals=True,
        export_materials="EXPORT", export_yup=True, export_animations=False, export_cameras=False,
        export_lights=False,
    )
    print("wrote", OUT, OUT.stat().st_size, "bytes")
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            print(f"  {o.name}: {len(o.data.loop_triangles)} triangles")


def preview(out_dir):
    """The cars in a row, from straight above and from above at an angle."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cars = build()
    scene = bpy.context.scene
    for i, o in enumerate(cars):
        o.location = (0, (min(i, 7) - 3.5) * 3.2, 0)  # (the ram goes on the police car)
    ground = bpy.data.meshes.new("ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
    bm.to_mesh(ground)
    g = bpy.data.objects.new("ground", ground)
    mg = bpy.data.materials.new("GroundPreview")
    mg.diffuse_color = (0.25, 0.25, 0.25, 1)
    ground.materials.append(mg)
    scene.collection.objects.link(g)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(38)
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    # (camera, looking at): the game looks straight down, so cars off the middle of the
    # screen show a little of their sides.
    views = {
        "top": ((0, 0, 26), (0, 0, 0)),
        "offset": ((-4, 0, 13), (-4, 0, 0)),
        "close": ((7, -9, 7), (0, -1.5, 0.6)),
        "wheel": ((3.5, -6.5, 1.2), (1.5, -3, 0.4)),
        "police": ((4.5, 7, 6), (0, 11.2, 0.6)),
        "police_top": ((0, 11.2, 9), (0, 11.2, 0)),
    }
    for v, (loc, at) in views.items():
        cam.location = loc
        cam.rotation_euler = (Vector(at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        scene.render.filepath = str(out / f"cars_{v}.png")
        bpy.ops.render.render(write_still=True)
    # And with every door open (no shadows: the open shells confuse the preview's).
    scene.display.shading.show_shadows = False
    for o in scene.objects:
        if "_door" in o.name:
            o.rotation_euler = (0, 0, math.radians(-62 if o.location.y > 0 else 62))
    views = {"doors": ((-1, -7.5, 5), (0, -1.6, 0.5)), "doors_back": ((-7, -5, 4.5), (0, -1.6, 0.5)), "doors_top": ((0, 0, 20), (0, 0, 0))}
    for v, (loc, at) in views.items():
        cam.location = loc
        cam.rotation_euler = (Vector(at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        scene.render.filepath = str(out / f"cars_{v}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if argv[:1] == ["--preview"]:
        preview(argv[1])
    else:
        build()
        export()
