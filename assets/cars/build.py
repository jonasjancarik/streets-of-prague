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
# How far in from the side a rounded body's top begins (see Car.body's crown).
LID = 0.12
# How much of the crown's height the top has already gained halfway in from its edge.
SHOULDER = 0.8


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

    def body(self, stations, wheels=(), r=0.31, stripe=None, bonnet_band=None, doors=(), cabin=None, livery=None,
             crown=None):
        """stations: (x, half width, height of the top, height of the sill), front to
        back. Over each wheel (at x in `wheels`, radius `r`) the sill rises in an arch.
        doors: (x of the front edge, x of the back edge, number of the left door), the
        right one being the next number. cabin: (front, back), where the top is left open
        under the cabin, so the seats show through an open door. livery: (x, material)
        to the material a band of the side has at x, for a stripe that changes along the car.
        crown: x to how far the middle of the top stands above its edges (a bonnet and boot
        that bulge, so the light runs across them), with the sides rounded off into it
        over LID metres instead of the usual square shoulder."""
        def at(x):
            for (x0, *a), (x1, *b) in zip(stations, stations[1:]):
                if x1 <= x <= x0:
                    u = (x0 - x) / (x0 - x1)
                    return [p + (q - p) * u for p, q in zip(a, b)]
            return list(stations[0 if x > 0 else -1][1:])
        ra = r + 0.05
        arch = set()
        for xw in wheels:
            arch |= {xw + ra * math.cos(math.pi * k / 6) for k in range(7)}
            arch |= {xw + e * (ra + 0.002) for e in (1, -1)}

        def over(x):
            # The sill's height over a wheel (any section that falls there, not only
            # the arch's own, or it pulls the sill down across the tyre), or None.
            for xw in wheels:
                if abs(x - xw) <= ra + 1e-6:
                    return r + math.sqrt(max(0.0, ra * ra - (x - xw) ** 2))
            return None
        xs = {s[0] for s in stations} | arch
        for x0, x1, _ in doors:
            xs |= {x for x in (x0, x1) if all(abs(x - k) > 1e-4 for k in xs)}
        xs = sorted(xs, reverse=True)
        rings = []
        for x in xs:
            w, zt, z0 = at(x)
            z0 = max(z0, over(x) or 0)
            lo = max(z0 + 0.01, min(z0 + 0.13, zt - 0.15))
            hi = max(lo + 0.01, zt - 0.13)
            if crown:
                pts = [(w - 0.06, z0, "Trim"), (w - 0.01, lo, "Paint")]
            else:
                pts = [(w - 0.05, z0, "Trim"), (w, lo, "Paint")]
            for z, mat in stripe or ():
                pts.append((w, min(max(z, pts[-1][1] + 0.002), hi - 0.002), mat))
            if crown:
                pts += [(w, hi, "Paint"), (w - 0.012, zt - 0.055, "Paint"), (w - 0.045, zt - 0.017, "Paint"),
                        (w - LID, zt, "Paint")]
            else:
                pts += [(w, hi, "Paint"), (w - 0.035, zt - 0.035, "Paint"), (w - 0.11, zt, "Paint")]
            L = [self.v(x, y, z) for y, z, _ in pts]
            R = [self.v(x, -y, z) for y, z, _ in pts]
            # The top's middle line and, halfway out to each edge, a shoulder standing
            # SHOULDER of the way up to it: a dome rather than a tent.
            ridge = ([self.v(x, s * (w - LID) / 2, zt + SHOULDER * crown(x)) for s in (1, -1)] +
                     [self.v(x, 0, zt + crown(x))]) if crown else None
            rings.append((L, R, [m for _, _, m in pts], ridge))
        for s in range(len(rings) - 1):
            (L0, R0, mats, C0), (L1, R1, _, C1) = rings[s], rings[s + 1]
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
            lids = ([self.face([L0[-1], L1[-1], C1[0], C0[0]], top), self.face([C0[0], C1[0], C1[2], C0[2]], top),
                     self.face([C0[2], C1[2], C1[1], C0[1]], top), self.face([C0[1], C1[1], R1[-1], R0[-1]], top)] if crown
                    else [self.face([L0[-1], L1[-1], R1[-1], R0[-1]], top)])
            if cabin and cabin[1] < mid < cabin[0]:
                self.under += lids
            self.under.append(self.face([L0[0], R0[0], R1[0], L1[0]], "Trim"))
        for L, R, mats, C in (rings[0], rings[-1]):
            for i in range(len(L) - 1):
                # Bumpers across the bottom, paint above.
                self.face([L[i], L[i + 1], R[i + 1], R[i]], "Trim" if i == 0 else "Paint")
            if C:
                self.face([L[-1], C[0], C[2], C[1], R[-1]], "Paint")

    def cabin(self, belt, xa, xb, xm, xc, xd, wb, wr, top, glass_rear=True, glass_back_side=True, xm_top=None,
              rear_doors=True, xq=None, edge=None, crown=0.0, bow=0.0):
        """Windscreen from (xa, belt) up to (xb, top), roof to xc, rear window down to
        xd; sides from half width wb at the belt to wr at the roof, split at xm by the
        B pillar. Every window is inset, so the pillars and frames show in paint.
        The front side windows are part of doors 1 and 2, the back ones of 3 and 4 (with
        rear_doors): as far back as xq, where another pillar ends the door, if xq is given.
        edge: x to the half width at the belt, where the body narrows (instead of wb).
        crown: how far the middle of the roof stands above its sides; bow: how much
        further the roof reaches over the windscreen and the rear window in the middle
        (or a pair: front, back), so seen from above it's rounded, not a rectangle."""
        xm_top = xm if xm_top is None else xm_top
        z0 = belt - 0.02
        half = edge or (lambda x: wb)
        A, M, D = ([self.v(x, s * half(x), z0) for s in (1, -1)] for x in (xa, xm, xd))
        B, T, C = ([self.v(x, s * wr, top) for s in (1, -1)] for x in (xb, xm_top, xc))
        bow_front, bow_back = bow if isinstance(bow, tuple) else (bow, bow)
        if crown or bow_front or bow_back:
            # The roof's middle line: the windscreen and the rear window take it on their top edge.
            for row, x in ((B, xb + bow_front), (T, xm_top), (C, xc - bow_back)):
                row.append(self.v(x, 0, top + crown))
            screen = self.face([A[0], A[1], B[1], B[2], B[0]], "Glass")
            rear = self.face([D[1], D[0], C[0], C[2], C[1]], "Glass")
        else:
            screen = self.face([A[0], A[1], B[1], B[0]], "Glass")
            rear = self.face([D[1], D[0], C[0], C[1]], "Glass")

        def roof(*rows):
            for a, b in zip(rows, rows[1:]):
                if len(a) > 2:
                    self.face([a[0], a[2], b[2], b[0]], "Paint")
                    self.face([a[2], a[1], b[1], b[2]], "Paint")
                else:
                    self.face([a[0], a[1], b[1], b[0]], "Paint")
        sides_front = [self.face([A[0], B[0], T[0], M[0]], "Glass"), self.face([A[1], M[1], T[1], B[1]], "Glass")]
        for k, f in enumerate(sides_front):
            f[self.door] = 1 + k
        roof(B, T)
        if xq is None:
            sides_back = [self.face([M[0], T[0], C[0], D[0]], "Glass"), self.face([M[1], D[1], C[1], T[1]], "Glass")]
            behind = sides_back
            roof(T, C)
            floor = self.face([A[0], M[0], D[0], D[1], M[1], A[1]], "Paint")
        else:
            Q = [self.v(xq, s * half(xq), z0) for s in (1, -1)]
            P = [self.v(xq - 0.06, s * wr, top) for s in (1, -1)]
            if len(B) > 2:
                P.append(self.v(xq - 0.06, 0, top + crown))
            behind = [self.face([M[0], T[0], P[0], Q[0]], "Glass"), self.face([M[1], Q[1], P[1], T[1]], "Glass")]
            sides_back = behind + [self.face([Q[0], P[0], C[0], D[0]], "Glass"), self.face([Q[1], D[1], C[1], P[1]], "Glass")]
            roof(T, P, C)
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
        letters at x, each pixel px across, `top(x, y)` the height of the bonnet there."""
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
                    self.decal([(xa, ya), (xb, ya), (xb, yb), (xa, yb)], mat, top)
                    c = e

    def bumper(self, outline, z0, z1, out=0.04):
        """A black bumper standing `out` proud of the body round `outline` (x, y points
        along the body's edge, from one side round the end to the other), from z0 up to z1."""
        pts = []
        for i, (x, y) in enumerate(outline):
            (xa, ya), (xb, yb) = outline[max(i - 1, 0)], outline[min(i + 1, len(outline) - 1)]
            dx, dy = xb - xa, yb - ya
            d = math.hypot(dx, dy) or 1
            # Outwards is to the left of the way round.
            pts.append((x, y, x - dy / d * out, y + dx / d * out))
        rows = [[self.v(xo, yo, z) for _, _, xo, yo in pts] for z in (z0, z1)]
        back = [self.v(x, y, z1) for x, y, _, _ in pts]
        for i in range(len(pts) - 1):
            self.face([rows[0][i], rows[0][i + 1], rows[1][i + 1], rows[1][i]], "Trim")
            self.face([rows[1][i], rows[1][i + 1], back[i + 1], back[i]], "Trim")
        for end in (0, len(pts) - 1):
            # (The ends of the rim, against the body.)
            self.face([rows[0][end], rows[1][end], back[end]], "Trim")

    def decal(self, points, mat, z, lift=0.008):
        """A flat shape lying on the body (lettering, a lamp): `points` (x, y) round it,
        `z(x, y)` the height of the body under each."""
        self.decals.append(([(x, y, z(x, y) + lift) for x, y in points], mat))

    def strip(self, x0, x1, ys, mat, z, lift=0.008):
        """A band across the car from x0 to x1, bent at each y of `ys` to follow the body."""
        for ya, yb in zip(ys, ys[1:]):
            self.decal([(x0, ya), (x1, ya), (x1, yb), (x0, yb)], mat, z, lift)

    def screen(self, shape, xa, xb, z0, top, e):
        """What shows round a windscreen from above: the black scuttle between the bonnet
        and the glass (out to half width e), and the two wipers lying at the bottom of the
        glass, which runs from (xa, z0) up to (xb, top)."""
        self.strip(xa + 0.085, xa + 0.005, [-e, -e / 2, 0, e / 2, e], "Trim", shape.top)

        def glass(x, y):
            return z0 + (xa - x) / (xa - xb) * (top - z0)
        for ya, yb in ((0.72 * e, 0.06), (-0.1, -0.76 * e)):
            self.decal([(xa - 0.04, ya), (xa - 0.13, yb), (xa - 0.165, yb), (xa - 0.075, ya)], "Trim", glass, 0.03)

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

    def mirrors(self, x, w, z, stalk=False):
        """With `stalk`: a housing in paint out on a black arm, the glass facing back."""
        for s in (1, -1):
            if not stalk:
                self.block((x, s * (w - 0.02), z), (0.1, 0.22, 0.11), "Paint")
                continue
            self.block((x, s * w, z - 0.02), (0.06, 0.12, 0.05), "Trim")
            self.block((x - 0.02, s * (w + 0.1), z), (0.11, 0.17, 0.11), "Paint")
            self.block((x - 0.08, s * (w + 0.1), z), (0.012, 0.15, 0.09), "Glass")

    def lamps(self, front, back, w_front, w_back, z_front, z_back, plates=None):
        """plates: (x, height) of the number plates at the front and the back, if they
        aren't just in front of the lamps."""
        for s in (1, -1):
            self.block((front + 0.02, s * w_front, z_front), (0.1, 0.3, 0.1), "Lamp")
            self.block((back - 0.02, s * w_back, z_back), (0.1, 0.26, 0.13), "Tail")
        (xf, zf), (xr, zr) = plates or ((front + 0.03, 0.42), (back - 0.03, 0.62))
        self.block((xf, 0, zf), (0.04, 0.5, 0.11), "Plate")
        self.block((xr, 0, zr), (0.04, 0.5, 0.11), "Plate")

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


class Shape:
    """A body's outline and the heights along it, for Car.body: from above, a car is its
    outline, so each end's corners are an ellipse (`nose`, `tail`: along, across), the
    body narrows towards them, the sides bow out a little (`bow`) and black bumpers
    stand `bump` proud round the ends. profile: (x, height of the top, height of the
    sill) along the car, front to back, from +n to -n. `bulge` (x to how far the middle
    of the top stands above its edges) is set by the car once it knows where its glass is."""

    def __init__(self, n, w, profile, nose, tail, bow=0.018, bump=0.04):
        self.n, self.w, self.nose, self.tail, self.bump = n, w, nose, tail, bump
        self.nb = nb = n - bump
        self.bow = bow
        self.bulge = lambda x: 0.0

        def along(x, i):
            for (x0, *a), (x1, *b) in zip(profile, profile[1:]):
                if x1 <= x <= x0:
                    return a[i] + (b[i] - a[i]) * (x0 - x) / (x0 - x1)
            return profile[0 if x > 0 else -1][1 + i]
        xs = {x for x, *_ in profile if abs(x) < nb - 0.02}
        for a, sign in ((nose[0], 1), (tail[0], -1)):
            xs |= {sign * (nb - a + a * math.sin(math.radians(t))) for t in (20, 40, 55, 68, 80, 90)}
        xs = sorted(xs, reverse=True)
        self.xs = [x for i, x in enumerate(xs) if i == 0 or xs[i - 1] - x > 0.012]
        self.stations = [(x, self.half(x), along(x * n / nb, 0), along(x * n / nb, 1)) for x in self.xs]

    def half(self, x):
        h = self.w * (1 - self.bow * (x / self.n) ** 2)
        for (a, b), d in ((self.nose, x - (self.nb - self.nose[0])), (self.tail, (-self.nb + self.tail[0]) - x)):
            if d > 0:
                h -= b * (1 - math.sqrt(max(0.0, 1 - (d / a) ** 2)))
        return h

    def top(self, x, y):
        """The height of the bonnet or boot at (x, y), as Car.body lays it."""
        for (x0, w0, z0, _), (x1, w1, z1, _) in zip(self.stations, self.stations[1:]):
            if x1 <= x <= x0:
                u = (x0 - x) / (x0 - x1)
                edge = w0 + (w1 - w0) * u - LID
                t = min(abs(y) / edge, 1.0)
                dome = 1 - 2 * (1 - SHOULDER) * t if t < 0.5 else 2 * SHOULDER * (1 - t)
                return z0 + (z1 - z0) * u + self.bulge(x) * dome
        return self.stations[0][2]

    def bumpers(self, c, front, back):
        """The bumpers, each (bottom, top), round the ends from a little back from the corners."""
        for end, (z0, z1), corner in ((1, front, self.nose), (-1, back, self.tail)):
            start = end * (self.nb - corner[0] - 0.12)
            xs = sorted({x for x in self.xs if end * x > end * start} | {start}, key=lambda x: end * x)
            side = [(x, end * self.half(x)) for x in xs]
            c.bumper(side + [(x, -y) for x, y in reversed(side)], z0, z1, self.bump)

    def lamps(self, c, front=True, back=False, size=(0.15, 0.3)):
        """The lamps from above: headlamps wrapping over the corners of the nose and (with
        `back`, where there's a boot or a bonnet-like top behind) tail lamps over the
        tail's; `size` is how far each reaches along and across."""
        along, across = size
        for s in (1, -1):
            for end, on, mat in ((1, front, "Lamp"), (-1, back, "Tail")):
                if not on:
                    continue
                x0, x1 = end * (self.nb - 0.04), end * (self.nb - 0.04 - along)
                outer = [(x, s * (self.half(x) - LID - 0.02)) for x in (x0, (x0 + x1) / 2, x1)]
                c.decal([(x0, s * (abs(outer[0][1]) - across))] + outer +
                        [(x1, s * (abs(outer[-1][1]) - across + 0.04))], mat, self.top)


# ---- The cars ---------------------------------------------------------------
# Lengths, widths and heights as in src/car.ts TYPES.


def saloon(name, L, W, H, rear, stripe=None, sign=False, bar=None, rails=False, r=0.31, lift=0.0, word=None,
           sunroof=0.0, fin=True):
    """A car: `rear` is 'hatch', 'sedan' or 'estate'; `bar` is where along the roof the
    light bar goes (the middle of `cabin` in src/car.ts, where src/police.ts flashes it).
    `r` is the wheel radius and `lift` how much higher the bonnet and sills sit (an SUV).
    `word` is written across the bonnet, and the stripe then turns into yellow and blue
    blocks on the front wings and behind the rear doors (the Czech police's colours).
    `sunroof` is the length of a glass panel in the roof, and `fin` an aerial at the back of it.

    Seen from above (and from above at a slant, away from the middle of the screen) a
    car is its outline, its glass and how the light runs over it, so: corners rounded
    off and the body narrowing to the nose and tail, sides that bow out a little, black
    bumpers round the ends, a bonnet, boot and roof that bulge in the middle, a roof
    rounded where it meets the windscreen and the rear window, and the lamps showing on
    top of the nose and tail."""
    c = Car()
    w, n = W / 2, L / 2
    belt = 0.93 if H < 1.48 else 0.95 if H < 1.6 else 1.03
    boot = {"hatch": belt, "sedan": belt + 0.03, "estate": belt}[rear]
    # The heights of the top and of the sill along the car: (x, top, sill).
    profile = [
        (n, 0.7 + lift, 0.3 + lift), (n - 0.12, 0.76 + lift, 0.26 + lift), (n - 0.35, 0.8 + lift, 0.24 + lift),
        (n - 0.8, 0.84 + lift, 0.22 + lift), (n - 1.25, belt - 0.01, 0.22 + lift), (n - 1.45, belt, 0.22 + lift),
        (-n + 0.7, boot, 0.22 + lift), (-n + 0.3, boot, 0.24 + lift), (-n + 0.1, boot - 0.02, 0.27 + lift),
        (-n, boot - 0.06, 0.3 + lift),
    ]

    # The back corners of an estate or a hatchback squarer than a saloon's.
    shape = Shape(n, w, profile, nose=(0.5, 0.36), tail={"hatch": (0.26, 0.24), "sedan": (0.36, 0.3), "estate": (0.24, 0.22)}[rear])
    half, nb, stations = shape.half, shape.nb, shape.stations

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

    def bulge(x):
        # Most in the middle of the bonnet and boot, nothing where they meet the glass.
        return 0.035 * min(abs(x - xa), abs(x - back), 0.3) / 0.3
    shape.bulge = bulge

    def livery(x, mat):
        if mat != "Blue" or xq < x < xa:
            return mat
        return "Paint" if x > n - 0.3 or x < -n + 0.25 else "Yellow" if int((x + n) / 0.19) % 2 else "Blue"

    c.body(stations, wheels, r, stripe=stripe, doors=[(xa, xm, 1), (xm, xq, 3)], cabin=(xa, back),
           livery=livery if word else None, crown=bulge)
    shape.bumpers(c, (0.3 + lift, 0.52 + lift), (0.32 + lift, 0.56 + lift))
    if word:
        c.text(word, n - 1.17, 0.038, shape.top, "Blue")
    roof = H - 0.035
    c.cabin(belt, xa, xb, xm, xc, xd, w - 0.11, w * 0.74, roof, xm_top=(xb + xc) / 2 + 0.05,
            xq=xq if xq - 0.06 > xc + 0.3 else None, edge=lambda x: half(x) - LID, crown=0.035, bow=0.05)
    floor = 0.36 + lift
    c.interior(xa - 0.01, back, w - 0.08, floor, belt - 0.02, H - 0.03, xb - 0.03, xc + 0.03, w * 0.74 - 0.03,
               [((xa + xm) / 2 - 0.1, s * w * 0.48, 0.5) for s in (1, -1)] + [((xm + xq) / 2 - 0.05, 0, W - 0.4)])
    c.wheels(wheels, w, r)
    c.mirrors(xa - 0.1, half(xa - 0.1), belt + 0.08, stalk=True)
    front, end = nb - 0.06, -nb + 0.06
    # (Placed by the width at the very end: the corners round off in front of the lamps.)
    c.lamps(front, end, half(nb) - 0.17, half(-nb) - 0.15, 0.64 + lift, boot - 0.12,
            plates=((n - 0.01, 0.42 + lift), (-n + 0.01, 0.46 + lift)))
    # (Tail lamps from above only on a saloon, with a boot behind the rear window.)
    shape.lamps(c, back=rear == "sedan")
    mid = (xb + xc) / 2
    wr = w * 0.74
    c.screen(shape, xa, xb, belt - 0.02, roof, half(xa) - LID - 0.03)
    if sunroof:
        x0 = xb - 0.16
        c.strip(x0, max(x0 - sunroof, xc + 0.2), [-0.6 * wr, 0, 0.6 * wr], "Glass", lambda x, y: roof + 0.035 * (1 - abs(y) / wr))
    if fin:
        c.block((xc + 0.2, 0, roof + 0.06), (0.17, 0.045, 0.06), "Trim")
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
            c.block(((xb + xc) / 2, s * (w * 0.74 - 0.05), roof + 0.02), (xb - xc - 0.1, 0.05, 0.05), "Trim")
    return c.finish(name)


def van(name="van", L=5.2, W=2.0, H=2.3):
    c = Car()
    w, n = W / 2, L / 2
    belt = 1.05
    profile = [
        (n, 0.8, 0.34), (n - 0.12, 0.88, 0.3), (n - 0.4, 0.96, 0.28),
        (n - 0.62, belt, 0.28), (-n + 0.2, belt, 0.28), (-n, belt, 0.32),
    ]
    # A short rounded nose, and a box behind that's square but for its corners.
    shape = Shape(n, w, profile, nose=(0.42, 0.34), tail=(0.1, 0.08), bow=0.01)
    half, nb = shape.half, shape.nb
    xa = n - 0.62
    wheels = (n - 0.9, -n + 0.95)
    xm = xa - 1.05
    shape.bulge = lambda x: 0.03 * min(max(x - xa, 0.0), 0.25) / 0.25
    c.body(shape.stations, wheels, 0.34, doors=[(xa, xm, 1)], cabin=(xa, xm - 0.3), crown=shape.bulge)
    shape.bumpers(c, (0.34, 0.56), (0.36, 0.6))
    # A tall box behind the cab: windows only in the cab doors, none in the back; the
    # roof bulges a little and reaches over the windscreen in the middle.
    c.cabin(belt, xa, xa - 0.72, xm, -nb + 0.06, -nb + 0.02, w - 0.02, w * 0.93, H - 0.06,
            glass_rear=False, glass_back_side=False, xm_top=xm, rear_doors=False,
            edge=lambda x: half(x) - 0.03, crown=0.06, bow=(0.08, 0.0))
    c.interior(xa - 0.01, xm - 0.3, w - 0.08, 0.5, belt - 0.02, H - 0.07, xa - 0.75, xm - 0.3, w * 0.93 - 0.03,
               [(xa - 0.6, s * w * 0.5, 0.55) for s in (1, -1)])
    c.screen(shape, xa, xa - 0.72, belt - 0.02, H - 0.06, half(xa) - 0.1)
    # The ribs pressed into the roof, along it.
    wr, x0, x1 = w * 0.93, xa - 1.05, -nb + 0.3
    for y in (-0.66, -0.22, 0.22, 0.66):
        c.block(((x0 + x1) / 2, y * wr, H - 0.06 + 0.06 * (1 - abs(y)) + 0.004), (x0 - x1, 0.09, 0.03), "Paint")
    c.wheels(wheels, w, 0.34, 0.23)
    c.mirrors(xa - 0.05, half(xa - 0.05) + 0.03, belt + 0.1, stalk=True)
    c.lamps(nb - 0.06, -nb + 0.06, half(nb) - 0.17, half(-nb) - 0.15, 0.72, 0.85,
            plates=((n - 0.01, 0.45), (-n + 0.01, 0.48)))
    shape.lamps(c)
    return c.finish(name)


def pickup(name="pickup", L=5.9, W=2.03, H=1.95):
    """A full-size American pickup (an F-150): a long bonnet, a crew cab and an open bed."""
    c = Car()
    w, n = W / 2, L / 2
    belt, rail, r = 1.24, 1.2, 0.4
    profile = [
        (n, 1.02, 0.44), (n - 0.15, 1.1, 0.42), (n - 0.5, 1.17, 0.4),
        (n - 1.0, rail, 0.38), (-n + 0.1, rail, 0.38), (-n, rail - 0.05, 0.4),
    ]
    # A blunt, square-shouldered nose, and a bed square at the back.
    shape = Shape(n, w, profile, nose=(0.4, 0.26), tail=(0.06, 0.05), bow=0.01)
    half, nb = shape.half, shape.nb
    xa = n - 1.5
    xd = xa - 2.4
    wheels = (n - 1.05, -n + 1.05)
    xm = xa - 1.2
    # Only the bonnet bulges: the bed lies flat behind the cab.
    shape.bulge = lambda x: 0.03 * min(max(x - xa, 0.0), 0.3) / 0.3
    c.body(shape.stations, wheels, r, doors=[(xa, xm, 1), (xm, xd + 0.08, 3)], cabin=(xa, xd + 0.05),
           crown=shape.bulge)
    shape.bumpers(c, (0.44, 0.72), (0.46, 0.76))
    c.cabin(belt, xa, xa - 0.65, xm, xd + 0.1, xd, w - 0.12, w * 0.8, H - 0.035, xm_top=xa - 1.15,
            edge=lambda x: half(x) - LID, crown=0.035, bow=(0.05, 0.0))
    c.interior(xa - 0.01, xd + 0.05, w - 0.08, 0.6, belt - 0.02, H - 0.06, xa - 0.68, xd + 0.13, w * 0.8 - 0.03,
               [(xa - 0.65, s * w * 0.48, 0.55) for s in (1, -1)] + [(xm - 0.6, 0, W - 0.4)])
    c.screen(shape, xa, xa - 0.65, belt - 0.02, H - 0.035, half(xa) - LID - 0.03)
    c.wheels(wheels, w, r, 0.28)
    c.mirrors(xa - 0.1, half(xa - 0.1) + 0.02, belt + 0.1, stalk=True)
    c.lamps(nb - 0.06, -nb + 0.06, half(nb) - 0.17, half(-nb) - 0.14, 0.86, 0.98,
            plates=((n - 0.01, 0.6), (-n + 0.01, 0.62)))
    shape.lamps(c, size=(0.14, 0.32))
    # The bed: a dark floor between paint rails, and the tailgate.
    end = -nb + 0.04
    side = half((xd + end) / 2)
    c.block(((xd + end) / 2 - 0.02, 0, rail + 0.012), (xd - end - 0.2, 2 * side - 0.3, 0.024), "Trim")
    for s in (1, -1):
        c.block(((xd + end) / 2, s * (side - 0.07), rail + 0.03), (xd - end, 0.14, 0.06), "Paint")
    c.block((end + 0.04, 0, rail + 0.04), (0.08, 2 * half(end + 0.04) - 0.04, 0.08), "Paint")
    c.block((xd - 0.06, 0, rail + 0.04), (0.1, 2 * half(xd) - 0.04, 0.08), "Paint")
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
        saloon("sedan", 4.6, 1.82, 1.45, "sedan", sunroof=0.5),
        saloon("estate", 4.7, 1.82, 1.5, "estate", rails=True),
        saloon("suv", 4.65, 1.88, 1.65, "estate", rails=True, r=0.36, lift=0.07, sunroof=1.0),
        van(),
        pickup(),
        saloon("taxi", 4.6, 1.82, 1.45, "sedan", sign=True),
        saloon("police", 4.7, 1.84, 1.5, "estate", stripe=POLICE_STRIPE, bar=-0.25, rails=True, word="POLICIE", fin=False),
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
