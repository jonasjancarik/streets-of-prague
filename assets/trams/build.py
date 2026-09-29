"""Build Prague's trams into public/trams.glb.

Five types that run in Prague, each simplified to a low-poly shell made from code (as
assets/cars/build.py does for the cars), after their real lengths, widths and liveries:

  15T   Škoda 15T ForCity Alfa, 3 sections, 31.4 m: most of the fleet
  14T   Škoda 14T "Porsche", 5 sections, 30.25 m, silver nose and red side panels
  KT8   Tatra KT8D5R.N2P, 3 sections, 30.3 m, cabs at both ends
  T3    Tatra T3R.P, 14 m, two cars coupled
  52T   Škoda 52T ForCity Plus, 5 sections, 32 m, the newest

The game looks down on them, so what counts is the outline from above, the roof with its
pantograph and equipment, and a little of the sides: the livery in bands, the windows,
the doors, the cab's windscreen. Each section is lofted through cross-sections along its
length and painted cell by cell by a function of where the cell is (see Livery).

Conventions: metres, Z up, facing +X, left is +Y, rails at z = 0; each section is centred
on its own origin and named <type>_<n>, front first. Custom properties (glTF extras,
three.js userData) say where it goes: `front`, how far its front end is behind the
tram's front; `length`; `pivot`, half the distance between the two points on the track
it's laid between (its bogies, or its ends when it hangs between its neighbours); and on
the first section `sign`, where the line number goes on the roof ([x, z]). Materials are
named after the colour they take; src/trams.ts turns them into vertex colours.

usage: blender -b --factory-startup -P assets/trams/build.py
       blender -b --factory-startup -P assets/trams/build.py -- --preview DIR
       (renders the trams from above, as the game sees them, into DIR)
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "public" / "trams.glb"
WIRE = 5.6  # m above the rails: the contact wire, where the pantographs reach (WIRE_HEIGHT in src/trams.ts)

# The same colours as PART in src/trams.ts (linear here, for the preview renders only).
HEX = {
    "Red": "#c8161d", "Cream": "#efe5c8", "White": "#eeefeb", "Silver": "#b4b8bb", "Light": "#dcdedc",
    "Roof": "#8f9396", "Black": "#1d1c1b", "Dark": "#3a3d40", "Glass": "#1e2830", "Skirt": "#2b2a29",
    "Bellows": "#252423", "Lamp": "#fff6d8", "Tail": "#b3161b", "Metal": "#5d6064", "Pan": "#d9a21b",
}
MATS = list(HEX)


def linear(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x < 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*linear(HEX[name]), 1)
    bsdf.inputs["Roughness"].default_value = 0.6
    m.diffuse_color = (*linear(HEX[name]), 1)
    return m


# ---- Liveries ---------------------------------------------------------------


class Livery:
    """What colour the side of a section is at (x, z).

    bands: (top, material) from the bottom up. glass: the window band (z0, z1), with
    `windows` the stretches along the section that are glass and `pillar` the colour
    between them. doors: stretches (x0, x1) with the door's own bands from the bottom up,
    on the right side only (the kerb side of a one-ended tram) unless `both`. paint: a
    last say, (x, z, side) -> material or None, for accents."""

    def __init__(self, bands, glass, windows, pillar, doors=(), door_bands=(), frame=None, both=False, paint=None):
        self.bands, self.glass, self.windows, self.pillar = bands, glass, windows, pillar
        self.doors, self.door_bands, self.frame, self.both, self.paint = doors, door_bands, frame, both, paint

    def zcuts(self):
        return {t for t, _ in self.bands} | set(self.glass) | {t for t, _ in self.door_bands}

    def xcuts(self):
        xs = set()
        for a, b in self.windows:
            xs |= {a, b}
        for a, b in self.doors:
            xs |= {a, b, a + 0.07, b - 0.07}
        return xs

    def band(self, bands, z):
        for top, mat in bands:
            if z < top:
                return mat
        return bands[-1][1]

    def at(self, x, z, side):
        if self.paint:
            m = self.paint(x, z, side)
            if m:
                return m
        if side < 0 or self.both:
            for a, b in self.doors:
                if a < x < b and z < self.door_bands[-1][0]:
                    if self.frame and (x < a + 0.07 or x > b - 0.07) and z > self.door_bands[0][0]:
                        return self.frame
                    return self.band(self.door_bands, z)
        if self.glass[0] < z < self.glass[1]:
            return "Glass" if any(a < x < b for a, b in self.windows) else self.pillar
        return self.band(self.bands, z)


def windows_between(x0, x1, pane=1.35, pillar=0.12, skip=()):
    """Window panes from x0 to x1, split evenly by pillars, leaving out the stretches in
    `skip` (the doors)."""
    out = []
    spans = [(x0, x1)]
    for a, b in sorted(skip):
        nxt = []
        for s0, s1 in spans:
            if b <= s0 or a >= s1:
                nxt.append((s0, s1))
                continue
            if a - s0 > 0.3:
                nxt.append((s0, a - pillar))
            if s1 - b > 0.3:
                nxt.append((b + pillar, s1))
        spans = nxt
    for s0, s1 in spans:
        n = max(1, round((s1 - s0) / (pane + pillar)))
        w = (s1 - s0 - (n - 1) * pillar) / n
        for k in range(n):
            a = s0 + k * (w + pillar)
            out.append((a, a + w))
    return out


# ---- Shapes -----------------------------------------------------------------


class Shell:
    def __init__(self):
        self.bm = bmesh.new()
        self.under = []

    def v(self, x, y, z):
        return self.bm.verts.new((x, y, z))

    def face(self, verts, mat):
        f = self.bm.faces.new(verts)
        f.material_index = MATS.index(mat)
        return f

    def block(self, c, s, mat, rot=0.0):
        (cx, cy, cz), (sx, sy, sz) = c, s
        m = Matrix.Rotation(rot, 3, "Y")
        vs = [self.v(*(Vector((cx, cy, cz)) + m @ Vector((dx * sx / 2, dy * sy / 2, dz * sz / 2))))
              for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.face([vs[i] for i in q], mat)

    def bar(self, p0, p1, t, mat, wide=None):
        """A square bar from p0 to p1 (in the XZ plane), t thick, `wide` across."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        rot = math.atan2(-d.z, d.x)
        self.block(tuple((p0 + p1) / 2), (d.length, wide or t, t), mat, rot)

    def section(self, L, W, H, zr, z0, livery, front, back, roof="Roof", tumble=0.07):
        """The shell: sides from the skirt (z0) up to the roof's edge (zr), leaning in by
        `tumble` above the windows' bottom, then the roof curving up to H.

        front/back: the ends, dicts with `kind` ('cab', 'tail' or 'joint'), `r` (how
        rounded the corners are, in plan), `rake(z)` (how far back the end is at height z:
        the windscreen leaning back, the roof rounding down) and `end(z)` (its colour)."""
        n, w = L / 2, W / 2
        zt = livery.glass[0]

        def half_width(z):
            return w if z <= zt else w - tumble * min(1, (z - zt) / (zr - zt))

        zs = sorted({z0, zr, zt} | {z for z in livery.zcuts() if z0 < z < zr})
        # The roof: from the edge of the side, round to the flat top.
        yr = half_width(zr)
        roofpts = [(yr - 0.04, zr + 0.1), (yr - 0.14, zr + (H - zr) * 0.62), (yr - 0.32, H - 0.02), (w * 0.55, H)]
        profile = [(half_width(z), z) for z in zs] + roofpts
        zone = {"f": front, "b": back}
        reach = 1.6  # how far from an end the rake still bends the sides

        def corner(d, e):
            r = e["r"]
            if d >= r:
                return 1.0
            return (w - r + math.sqrt(max(0.0, r * r - (r - d) ** 2))) / w

        # Stations along the section: the features' edges and more round the ends.
        xs = {n, -n}
        for e, s in ((front, 1), (back, -1)):
            for d in (0.02, 0.07, 0.15, 0.27, 0.42, 0.62, 0.9, 1.25, reach):
                if d < n:
                    xs.add(s * (n - d))
        xs |= {x for x in livery.xcuts() if -n < x < n}
        xs = sorted(xs, reverse=True)

        rings = []
        for x in xs:
            df, db = n - x, x + n
            e, d, s = (front, df, 1) if df < db else (back, db, -1)
            k = corner(d, e)
            bend = max(0.0, 1 - d / reach)
            L_, R_ = [], []
            for y, z in profile:
                xx = x - s * e["rake"](z) * bend
                L_.append(self.v(xx, y * k, z))
                R_.append(self.v(xx, -y * k, z))
            rings.append((x, L_, R_))

        for (xa, L0, R0), (xb, L1, R1) in zip(rings, rings[1:]):
            xm = (xa + xb) / 2
            for i in range(len(profile) - 1):
                zm = (profile[i][1] + profile[i + 1][1]) / 2
                if zm < zr:
                    ml, mr = livery.at(xm, zm, 1), livery.at(xm, zm, -1)
                else:
                    ml = mr = (livery.paint and livery.paint(xm, zm, 1)) or roof_edge(livery, zr)
                self.face([L0[i], L1[i], L1[i + 1], L0[i + 1]], ml)
                self.face([R0[i], R0[i + 1], R1[i + 1], R1[i]], mr)
            self.face([L0[-1], L1[-1], R1[-1], R0[-1]], roof)
            self.under.append(self.face([L0[0], R0[0], R1[0], L1[0]], "Skirt"))
        for (_, L, R), e in ((rings[0], front), (rings[-1], back)):
            for i in range(len(profile) - 1):
                zm = (profile[i][1] + profile[i + 1][1]) / 2
                self.face([L[i], L[i + 1], R[i + 1], R[i]], e["end"](zm))
        return rings

    def bogie(self, x, w, z0):
        self.block((x, 0, (z0 + 0.06) / 2), (2.1, w * 2 - 0.35, z0 - 0.06), "Skirt")

    def bellows(self, x_end, gap, W, z0, H):
        """The folding gangway to the next section, filling the gap and a little over."""
        self.block((x_end - gap / 2, 0, (z0 + 0.1 + H - 0.25) / 2), (gap + 0.3, W - 0.24, H - 0.35 - z0), "Bellows")

    def lamps(self, x, w, z, tail=False):
        for s in (1, -1):
            self.block((x, s * w, z), (0.08, 0.22, 0.14), "Tail" if tail else "Lamp")

    def mirrors(self, x, w, z):
        for s in (1, -1):
            self.block((x, s * (w + 0.12), z), (0.12, 0.26, 0.34), "Black")

    def pantograph(self, x, z, flip=False):
        """A single-arm pantograph, raised to the contact wire (WIRE above the rails)."""
        s = -1 if flip else 1
        top = WIRE - 0.04
        self.block((x, 0, z + 0.06), (1.3, 1.1, 0.12), "Metal")
        for dy in (-0.45, 0.45):
            self.block((x + s * 0.5, dy, z + 0.16), (0.14, 0.14, 0.16), "Metal")
        knee = (x - s * 0.85, z + 0.2 + (top - z) * 0.42)
        for dy in (-0.2, 0.2):
            self.bar((x + s * 0.5, dy, z + 0.2), (knee[0], dy * 0.4, knee[1]), 0.07, "Pan")
        self.bar((knee[0], 0, knee[1]), (x + s * 0.1, 0, top - 0.05), 0.06, "Pan")
        self.block((x + s * 0.1, 0, top), (0.12, 1.5, 0.06), "Metal")
        for dy in (-1, 1):
            self.bar((x + s * 0.1, dy * 0.74, top), (x + s * 0.1, dy * 0.9, top - 0.12), 0.05, "Metal")

    def finish(self, name, **props):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.delete(bm, geom=[f for f in self.under if f.is_valid], context="FACES_ONLY")
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        for m in MATS:
            mesh.materials.append(material(m))
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        used = {p.material_index for p in mesh.polygons}
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for i in reversed(range(len(MATS))):
            if i not in used:
                obj.active_material_index = i
                bpy.ops.object.material_slot_remove()
        for k, v in props.items():
            obj[k] = v
        return obj


def roof_edge(livery, zr):
    """The colour the side carries on over the roof's curve."""
    return livery.band(livery.bands, zr - 0.01)


def rake(z_from, depth, z_to, power=1.6):
    """An end leaning back `depth` between z_from and z_to, more towards the top."""
    def f(z):
        if z <= z_from:
            return 0.0
        return depth * min(1.0, (z - z_from) / (z_to - z_from)) ** power
    return f


def joint():
    return {"kind": "joint", "r": 0.12, "rake": lambda z: 0.0, "end": lambda z: "Bellows"}


def layout(sections, gap):
    """Where each section's front end is, from the tram's front, and the total length."""
    at, fronts = 0.0, []
    for L in sections:
        fronts.append(at)
        at += L + gap
    return fronts, at - gap


# ---- The trams ----------------------------------------------------------------


def t15():
    """Škoda 15T: a glossy black window band the length of the tram over silver and a red
    skirt, the cab's big windscreen framed in red; one-ended, doors on the right."""
    W, H, zr, z0, gap = 2.46, 3.42, 3.08, 0.28, 0.3
    lengths = [10.75, 9.3, 10.75]
    fronts, total = layout(lengths, gap)
    bands = [(0.72, "Red"), (1.02, "Silver"), (2.98, "Black"), (3.03, "White"), (zr, "Black")]
    doors = [[(2.2, 3.5), (-3.6, -2.3)], [(0.9, 2.2), (-2.6, -1.3)], [(2.2, 3.5), (-3.6, -2.3)]]
    door_bands = [(0.34, "Red"), (2.3, "Glass")]

    def end_cab(z):
        return "Red" if z < 0.72 else "Silver" if z < 1.02 else "Black" if z < 1.22 else "Glass" if z < 2.98 else "Red"

    def end_tail(z):
        return "Red" if z < 0.72 else "Silver" if z < 1.02 else "Black" if z < 1.5 else "Glass" if z < 2.9 else "Red"

    objs = []
    for i, L in enumerate(lengths):
        n = L / 2
        cab, tail = i == 0, i == len(lengths) - 1
        wins = windows_between(-n + (1.2 if tail else 0.35), n - (1.6 if cab else 0.35), 1.5, 0.1, doors[i])

        def paint(x, z, side, n=n, cab=cab):
            if cab and x > n - 1.45 and 1.02 < z < 2.98:
                return "Glass" if z > 1.22 else "Black"
            return None
        liv = Livery(bands, (1.1, 2.9), wins, "Black", doors[i], door_bands, frame="Silver", paint=paint)
        front = {"kind": "cab", "r": 0.55, "rake": rake(1.1, 0.42, H), "end": end_cab} if cab else joint()
        back = {"kind": "tail", "r": 0.5, "rake": rake(1.4, 0.3, H), "end": end_tail} if tail else joint()
        s = Shell()
        s.section(L, W, H, zr, z0, liv, front, back)
        s.block((0, 0, H + 0.1), (L - (2.4 if cab or tail else 1.2), 1.7, 0.2), "Roof")
        s.bogie(n - 2.6 if not tail else -n + 2.6, W / 2, z0)
        if cab:
            s.lamps(n + 0.02, 0.85, 0.88)
            s.mirrors(n - 0.45, W / 2, 2.3)
            s.pantograph(1.2, H + 0.2)
        if tail:
            s.lamps(-n - 0.02, 0.85, 0.88, tail=True)
        else:
            s.bellows(-n, gap, W, z0, H)
        props = {"front": fronts[i], "length": L, "pivot": n}
        if cab:
            props["sign"] = [-2.6, H + 0.32]
        objs.append(s.finish(f"15T_{i}", **props))
    return objs


def t14():
    """Škoda 14T: a rounded silver nose and tail, silver roof, red panels under the
    windows; five sections, the second and fourth hung between the others."""
    W, H, zr, z0, gap = 2.46, 3.35, 2.98, 0.32, 0.22
    lengths = [7.9, 4.3, 5.9, 4.3, 7.0]
    fronts, total = layout(lengths, gap)
    bands = [(0.42, "Skirt"), (1.2, "Red"), (2.78, "Black"), (zr, "Silver")]
    doors = [[(1.4, 2.7)], [(-0.6, 0.7)], [(-0.65, 0.65)], [(-0.7, 0.6)], [(0.9, 2.2)]]
    door_bands = [(0.4, "Skirt"), (2.25, "Glass")]

    def end(z):
        return "Skirt" if z < 0.42 else "Silver" if z < 1.25 else "Glass" if z < 2.82 else "Silver"

    def tail_end(z):
        return "Skirt" if z < 0.42 else "Silver" if z < 1.6 else "Glass" if z < 2.65 else "Silver"

    objs = []
    for i, L in enumerate(lengths):
        n = L / 2
        cab, tail = i == 0, i == len(lengths) - 1
        wins = windows_between(-n + (1.4 if tail else 0.3), n - (1.9 if cab else 0.3), 1.3, 0.14, doors[i])

        def paint(x, z, side, n=n, cab=cab, tail=tail):
            if cab and x > n - 1.75 and z < 2.78:
                return "Glass" if z > 1.25 else "Silver"
            if tail and x < -n + 1.3 and z < 2.78:
                return "Silver"
            return None
        liv = Livery(bands, (1.2, 2.78), wins, "Black", doors[i], door_bands, frame="Silver", paint=paint)
        front = {"kind": "cab", "r": 0.95, "rake": rake(1.2, 0.75, H, 1.3), "end": end} if cab else joint()
        back = {"kind": "tail", "r": 0.8, "rake": rake(1.5, 0.45, H), "end": tail_end} if tail else joint()
        s = Shell()
        s.section(L, W, H, zr, z0, liv, front, back, roof="Silver")
        if i % 2 == 0:
            s.block((0 if not cab else -0.6, 0, H + 0.12), (L - 2.8, 1.8, 0.24), "Silver")
            s.bogie(0 if not cab else -0.4, W / 2, z0)
        if cab:
            s.lamps(n + 0.02, 0.8, 0.95)
            s.mirrors(n - 0.75, W / 2, 2.2)
            s.pantograph(-1.4, H + 0.24)
        if tail:
            s.lamps(-n - 0.02, 0.8, 1.0, tail=True)
        else:
            s.bellows(-n, gap, W, z0, H)
        props = {"front": fronts[i], "length": L, "pivot": n}
        if cab:
            props["sign"] = [1.3, H + 0.3]
        objs.append(s.finish(f"14T_{i}", **props))
    return objs


def kt8():
    """Tatra KT8D5R.N2P: angular, a cab at each end; white skirt, red band with a white
    line, dark grey round the windows; the middle section is the low-floor one."""
    W, H, zr, z0, gap = 2.48, 3.15, 2.95, 0.3, 0.3
    lengths = [11.7, 6.3, 11.7]
    fronts, total = layout(lengths, gap)
    bands = [(0.72, "White"), (1.18, "Red"), (1.3, "White"), (zr, "Dark")]
    mid_bands = [(0.95, "White"), (1.18, "Red"), (1.3, "White"), (zr, "Dark")]
    doors = [[(1.8, 3.1), (-3.9, -2.6)], [(-0.65, 0.65)], [(2.6, 3.9), (-3.1, -1.8)]]
    door_bands = [(0.42, "White"), (2.5, "Glass")]

    def end(z):
        return "White" if z < 0.55 else "Red" if z < 1.25 else "White" if z < 1.35 else "Glass" if z < 2.72 else "Dark"

    objs = []
    for i, L in enumerate(lengths):
        n = L / 2
        cab_f, cab_b = i == 0, i == len(lengths) - 1
        wins = windows_between(-n + (1.5 if cab_b else 0.3), n - (1.5 if cab_f else 0.3), 1.2, 0.16, doors[i])

        def paint(x, z, side, n=n, cab_f=cab_f, cab_b=cab_b):
            if (cab_f and x > n - 1.3 or cab_b and x < -n + 1.3) and 1.35 < z < 2.7:
                return "Glass"
            return None
        liv = Livery(mid_bands if i == 1 else bands, (1.38, 2.62), wins, "Dark", doors[i], door_bands,
                     frame="Dark", both=True, paint=paint)
        cab = {"kind": "cab", "r": 0.3, "rake": rake(1.3, 0.18, H, 1.2), "end": end}
        s = Shell()
        s.section(L, W, H, zr, z0 if i != 1 else 0.24, liv, cab if cab_f else joint(), cab if cab_b else joint(), roof="Roof")
        if cab_f or cab_b:
            sg = 1 if cab_f else -1
            s.lamps(sg * (n + 0.02), 0.78, 0.9, tail=False)
            s.lamps(sg * (n + 0.02), 0.95, 1.45, tail=True)
            s.mirrors(sg * (n - 0.3), W / 2, 2.25)
            s.bogie(sg * (n - 3.3), W / 2, z0)
            s.block((-sg * 1.8, 0, H + 0.15), (3.2, 1.5, 0.3), "Metal")
        else:
            s.bogie(0, W / 2, 0.24)
        if cab_f:
            s.pantograph(n - 3.6, H)
        if not cab_b:
            s.bellows(-n, gap, W, z0, H)
        props = {"front": fronts[i], "length": L, "pivot": n}
        if cab_f:
            props["sign"] = [-1.1, H + 0.45]
        objs.append(s.finish(f"KT8_{i}", **props))
    return objs


def t3():
    """Tatra T3R.P: the classic, rounded at both ends; cream and red, cream round the
    windows; three doors on the right; always two cars coupled."""
    W, H, zr, z0, L = 2.5, 3.05, 2.82, 0.42, 14.0
    n = L / 2
    bands = [(0.56, "Skirt"), (0.95, "Cream"), (1.62, "Red"), (zr, "Cream")]
    doors = [(4.3, 5.6), (-0.65, 0.65), (-5.9, -4.6)]
    door_bands = [(0.5, "Skirt"), (0.95, "Cream"), (2.5, "Glass")]
    wins = windows_between(-n + 1.1, n - 1.55, 1.25, 0.16, doors)

    def paint(x, z, side):
        if x > n - 1.3 and 1.62 < z < 2.55:
            return "Glass"
        if x < -n + 1.0 and 1.7 < z < 2.5:
            return "Glass"
        return None
    liv = Livery(bands, (1.66, 2.52), wins, "Cream", doors, door_bands, frame="Cream", paint=paint)

    def end(z):
        return "Skirt" if z < 0.56 else "Cream" if z < 0.95 else "Red" if z < 1.62 else "Glass" if z < 2.55 else "Cream"

    def tail(z):
        return "Skirt" if z < 0.56 else "Cream" if z < 0.95 else "Red" if z < 1.7 else "Glass" if z < 2.5 else "Cream"
    s = Shell()
    s.section(L, W, H, zr, z0, liv,
              {"kind": "cab", "r": 1.0, "rake": rake(1.6, 0.45, H, 2.2), "end": end},
              {"kind": "tail", "r": 1.0, "rake": rake(1.7, 0.4, H, 2.2), "end": tail}, roof="Roof")
    for x in (3.75, -3.75):
        s.bogie(x, W / 2, z0)
    s.lamps(n + 0.02, 0.62, 1.25)
    s.lamps(-n - 0.02, 0.62, 1.35, tail=True)
    s.mirrors(n - 0.9, W / 2, 2.0)
    for sg in (1, -1):
        s.block((sg * (n + 0.25), 0, 0.5), (0.6, 0.18, 0.14), "Skirt")  # coupler
    s.block((-2.6, 0, H + 0.13), (2.8, 1.3, 0.26), "Metal")  # resistors
    s.pantograph(1.0, H + 0.02)
    gap = 1.0
    a = s.finish("T3_0", front=0.0, length=L, pivot=3.75, sign=[-4.9, H + 0.34])
    b = a.copy()  # the second car shares the first's mesh
    b.name = "T3_1"
    b["front"] = L + gap
    del b["sign"]
    bpy.context.scene.collection.objects.link(b)
    return [a, b]


def t52():
    """Škoda 52T: pale grey with a black cab front and big windows, red panels in turn
    along the sections; five sections."""
    W, H, zr, z0, gap = 2.5, 3.5, 3.15, 0.28, 0.3
    lengths = [9.4, 4.0, 5.8, 4.0, 7.6]
    fronts, total = layout(lengths, gap)
    bands = [(1.02, "Light"), (2.92, "Black"), (zr, "Light")]
    doors = [[(2.0, 3.3), (-4.2, -2.9)], [], [(-0.65, 0.65)], [], [(0.8, 2.1)]]
    door_bands = [(0.32, "Light"), (2.4, "Glass")]
    # Red panels: (lower, upper) stretches, as fractions along the section from its front.
    red = [((0.62, 1), (0.45, 1)), ((0, 1), None), ((0, 1), (0, 1)), ((0, 1), None), ((0, 0.4), (0, 0.55))]

    def end(z):
        return "Light" if z < 0.3 else "Black" if z < 1.05 else "Glass" if z < 3.0 else "Black"

    def tail_end(z):
        return "Light" if z < 1.02 else "Glass" if z < 2.85 else "Light"

    objs = []
    for i, L in enumerate(lengths):
        n = L / 2
        cab, tail = i == 0, i == len(lengths) - 1
        wins = windows_between(-n + (1.1 if tail else 0.25), n - (1.8 if cab else 0.25), 1.6, 0.1, doors[i])
        lo, up = red[i]

        def paint(x, z, side, n=n, lo=lo, up=up, cab=cab):
            f = (n - x) / (2 * n)
            if cab and x > n - 1.6 and z < zr:
                return "Glass" if 1.05 < z < 3.0 else "Black" if z > 0.3 else "Light"
            if lo and z < 1.02 and z > 0.32 and lo[0] <= f <= lo[1]:
                return "Red"
            if up and z > 2.92 and up[0] <= f <= up[1]:
                return "Red"
            return None
        liv = Livery(bands, (1.08, 2.86), wins, "Black", doors[i], door_bands, frame="Light", paint=paint)
        front = {"kind": "cab", "r": 0.6, "rake": rake(1.05, 0.5, H, 1.3), "end": end} if cab else joint()
        back = {"kind": "tail", "r": 0.55, "rake": rake(1.3, 0.3, H), "end": tail_end} if tail else joint()
        s = Shell()
        s.section(L, W, H, zr, z0, liv, front, back, roof="Light")
        if L > 5:
            s.block((-0.6 if cab else 0, 0, H + 0.1), (L - 3.0, 1.8, 0.2), "Roof")
            s.bogie(0 if not cab else -1.5, W / 2, z0)
        if cab:
            s.lamps(n + 0.02, 0.85, 0.8)
            s.block((n + 0.03, 0, 0.66), (0.06, 0.55, 0.72), "Red")  # the red stripe down the bumper
            s.mirrors(n - 0.6, W / 2, 2.4)
            s.pantograph(1.6, H + 0.2)
        if tail:
            s.lamps(-n - 0.02, 0.85, 0.85, tail=True)
        else:
            s.bellows(-n, gap, W, z0, H)
        props = {"front": fronts[i], "length": L, "pivot": n}
        if cab:
            props["sign"] = [-2.2, H + 0.32]
        objs.append(s.finish(f"52T_{i}", **props))
    return objs


TYPES = {"15T": t15, "14T": t14, "KT8": kt8, "T3": t3, "52T": t52}


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return {k: f() for k, f in TYPES.items()}


def export():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), export_format="GLB", export_texcoords=False, export_normals=True,
        export_materials="EXPORT", export_yup=True, export_animations=False, export_cameras=False,
        export_lights=False, export_extras=True,
    )
    print("wrote", OUT, OUT.stat().st_size, "bytes")
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            print(f"  {o.name}: {len(o.data.loop_triangles)} triangles")


def preview(out_dir):
    """The trams side by side, from above and from above at an angle."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    types = build()
    scene = bpy.context.scene
    for j, objs in enumerate(types.values()):
        total = max(o["front"] + o["length"] for o in objs)
        for o in objs:
            o.location = (total / 2 - o["front"] - o["length"] / 2, (j - 2) * 6.5, 0)
    ground = bpy.data.meshes.new("ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=40)
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
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(38)
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    views = {
        "top": ((0, 0, 62), (0, 0, 0)),
        "angle": ((10, -40, 40), (6, 0, 0)),
        "fronts": ((36, -20, 9), (13, -2, 1.6)),
        "backs": ((-36, -20, 9), (-13, -2, 1.6)),
        "pan": ((18, -9, 6.5), (13.5, -13, 3.8)),
    }
    for v, (loc, at) in views.items():
        cam.location = loc
        cam.rotation_euler = (Vector(at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        scene.render.filepath = str(out / f"trams_{v}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if argv[:1] == ["--preview"]:
        preview(argv[1])
    else:
        build()
        export()
