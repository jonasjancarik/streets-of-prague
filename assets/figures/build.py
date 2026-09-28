"""Build the people and two-wheeler kit into public/figures.glb.

A small low-poly person with a skeleton and a handful of clips (standing, walking,
running, jumping, being knocked over and getting up, riding a bike and a motorbike),
plus a bike and a motorbike to ride. Everything is made from code here, so the kit
can be tweaked and rebuilt; src/figures.ts bakes the clips into textures at load.

Conventions: metres, Z up, facing +X, left is +Y, feet on z = 0. The glTF exporter
turns this into three.js's Y up, and the figure still faces +X there. Materials are
named after the part they colour (Skin, Shirt, Sleeve, Trousers, Shoes, Hair, and
Paint, Tyre, Metal, Seat, Lamp, Engine on the vehicles); src/figures.ts relies on the
names.

usage: blender -b --factory-startup -P assets/figures/build.py
       blender -b --factory-startup -P assets/figures/build.py -- --preview DIR
       (renders a few frames of every clip into DIR, to check the poses)
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "public" / "figures.glb"
FPS = 24

# ---- Skeleton ---------------------------------------------------------------

# Rest joints of the left side; the right side mirrors them in y.
HIPS = Vector((0, 0, 0.96))
SPINE = Vector((0, 0, 1.06))
NECK = Vector((0, 0, 1.43))
HEAD = Vector((0, 0, 1.54))
CROWN = Vector((0, 0, 1.80))
SHOULDER = Vector((0, 0.215, 1.405))
ELBOW = Vector((-0.01, 0.232, 1.13))
WRIST = Vector((0, 0.24, 0.89))
HIP = Vector((0, 0.097, 0.93))
KNEE = Vector((0.012, 0.1, 0.51))
ANKLE = Vector((0, 0.1, 0.1))
TOE = Vector((0.17, 0.1, 0.03))


def mirror(v, side):
    return Vector((v.x, v.y * side, v.z))


def bone_table():
    """name -> (head, tail, parent)"""
    t = {
        "hips": (HIPS, SPINE, None),
        "spine": (SPINE, NECK, "hips"),
        "neck": (NECK, HEAD, "spine"),
        "head": (HEAD, CROWN, "neck"),
    }
    for side, s in (("L", 1), ("R", -1)):
        t[f"upper_arm.{side}"] = (mirror(SHOULDER, s), mirror(ELBOW, s), "spine")
        t[f"forearm.{side}"] = (mirror(ELBOW, s), mirror(WRIST, s), f"upper_arm.{side}")
        t[f"thigh.{side}"] = (mirror(HIP, s), mirror(KNEE, s), "hips")
        t[f"shin.{side}"] = (mirror(KNEE, s), mirror(ANKLE, s), f"thigh.{side}")
        t[f"foot.{side}"] = (mirror(ANKLE, s), mirror(TOE, s), f"shin.{side}")
    return t


BONES = bone_table()
ORDER = list(BONES)  # parents come before children


def make_armature():
    arm = bpy.data.armatures.new("Rig")
    obj = bpy.data.objects.new("Rig", arm)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    for name in ORDER:
        head, tail, parent = BONES[name]
        b = arm.edit_bones.new(name)
        b.head, b.tail = head, tail
        if parent:
            b.parent = arm.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


# ---- Materials --------------------------------------------------------------

COLOURS = {
    "Skin": (0.85, 0.66, 0.54), "Shirt": (0.3, 0.4, 0.55), "Sleeve": (0.3, 0.4, 0.55),
    "Trousers": (0.18, 0.2, 0.25), "Shoes": (0.08, 0.07, 0.07), "Hair": (0.2, 0.13, 0.08),
    "Paint": (0.7, 0.15, 0.12), "Tyre": (0.05, 0.05, 0.05), "Metal": (0.55, 0.56, 0.58),
    "Seat": (0.09, 0.08, 0.08), "Lamp": (1.0, 0.95, 0.8), "Engine": (0.25, 0.26, 0.28),
}


def material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*COLOURS[name], 1)
    bsdf.inputs["Roughness"].default_value = 0.8
    m.diffuse_color = (*COLOURS[name], 1)
    return m


# ---- Person mesh ------------------------------------------------------------


class Builder:
    """Low-poly shapes into one bmesh, each vertex weighted to one or two bones."""

    def __init__(self, groups, mats):
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()
        self.groups = {g: i for i, g in enumerate(groups)}
        self.mats = {m: i for i, m in enumerate(mats)}

    def vert(self, co, weights):
        v = self.bm.verts.new(co)
        for g, w in weights.items():
            v[self.dl][self.groups[g]] = w
        return v

    def face(self, verts, mat, smooth=True):
        f = self.bm.faces.new(verts)
        f.material_index = self.mats[mat]
        f.smooth = smooth
        return f

    def tube(self, rings, n, cap0=True, cap1=True, phase=0.0):
        """rings: (centre, rx, ry, weights, material of the band up to the next ring).
        Rings lie flat (in the xy plane): fine for the upright torso and hanging limbs."""
        loops = []
        for c, rx, ry, w, _ in rings:
            loops.append([self.vert(c + Vector((math.cos(a) * rx, math.sin(a) * ry, 0)), w)
                          for a in (phase + 2 * math.pi * i / n for i in range(n))])
        for k in range(len(loops) - 1):
            a, b, mat = loops[k], loops[k + 1], rings[k][4]
            # Rings are listed top down or bottom up; keep the faces facing out.
            down = rings[k + 1][0].z < rings[k][0].z
            for i in range(n):
                j = (i + 1) % n
                q = [b[i], b[j], a[j], a[i]] if down else [a[i], a[j], b[j], b[i]]
                self.face(q, mat)
        top_first = rings[-1][0].z < rings[0][0].z
        if cap0:
            self.face(loops[0] if top_first else loops[0][::-1], rings[0][4], smooth=False)
        if cap1:
            self.face(loops[-1][::-1] if top_first else loops[-1], rings[-2][4], smooth=False)

    def box(self, lo, hi, w, mat, taper=1.0):
        """Axis-aligned box; `taper` shrinks the +x end in y and z (shoes, hands)."""
        vs = []
        for x in (lo.x, hi.x):
            k = taper if x == hi.x else 1.0
            cy, cz = (lo.y + hi.y) / 2, lo.z
            for y in (lo.y, hi.y):
                for z in (lo.z, hi.z):
                    vs.append(self.vert(Vector((x, cy + (y - cy) * k, cz + (z - cz) * (k if z == hi.z else 1))), w))
        # index = xi*4 + yi*2 + zi
        F = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        for f in F:
            self.face([vs[i] for i in f], mat, smooth=False)

    def head(self, c, r, w):
        """A slightly squashed ball; the top and back faces are hair."""
        rx, ry, rz = r
        n, m = 10, 7
        rows = []
        for j in range(1, m):
            t = math.pi * j / m
            rows.append([self.vert(c + Vector((math.sin(t) * math.cos(a) * rx, math.sin(t) * math.sin(a) * ry, math.cos(t) * rz)), w)
                         for a in (2 * math.pi * i / n for i in range(n))])
        top = self.vert(c + Vector((0, 0, rz)), w)
        bot = self.vert(c + Vector((0, 0, -rz)), w)

        def mat(pts):
            p = sum((v.co for v in pts), Vector()) / len(pts) - c
            return "Hair" if p.z > 0.02 or (p.x < -0.035 and p.z > -0.06) else "Skin"

        for i in range(n):
            j = (i + 1) % n
            self.face([top, rows[0][i], rows[0][j]], mat([top, rows[0][i], rows[0][j]]))
            self.face([bot, rows[-1][j], rows[-1][i]], mat([bot, rows[-1][j], rows[-1][i]]))
            for k in range(m - 2):
                q = [rows[k][i], rows[k + 1][i], rows[k + 1][j], rows[k][j]]
                self.face(q, mat(q))


def make_person(rig):
    mats = ["Skin", "Shirt", "Sleeve", "Trousers", "Shoes", "Hair"]
    b = Builder(ORDER, mats)
    V = Vector
    H, S = {"hips": 1}, {"spine": 1}
    # Torso, from the seat of the trousers up to the collar.
    b.tube([
        (V((0, 0, 0.84)), 0.11, 0.16, H, "Trousers"),
        (V((0, 0, 0.95)), 0.12, 0.175, H, "Trousers"),
        (V((0.005, 0, 1.02)), 0.115, 0.165, {"hips": 0.5, "spine": 0.5}, "Shirt"),
        (V((0.01, 0, 1.13)), 0.11, 0.16, S, "Shirt"),
        (V((0.015, 0, 1.3)), 0.12, 0.185, S, "Shirt"),
        (V((0.005, 0, 1.4)), 0.115, 0.205, S, "Shirt"),
        (V((0, 0, 1.46)), 0.07, 0.09, {"spine": 0.5, "neck": 0.5}, "Shirt"),
    ], 10)
    b.tube([
        (V((0.005, 0, 1.43)), 0.05, 0.05, {"neck": 1}, "Skin"),
        (V((0.01, 0, 1.57)), 0.045, 0.045, {"neck": 0.5, "head": 0.5}, "Skin"),
    ], 6)
    b.head(V((0.015, 0, 1.665)), (0.112, 0.1, 0.125), {"head": 1})
    for side, s in (("L", 1), ("R", -1)):
        ua, fa = {f"upper_arm.{side}": 1}, {f"forearm.{side}": 1}
        el = {f"upper_arm.{side}": 0.5, f"forearm.{side}": 0.5}
        b.tube([
            (mirror(V((0, 0.215, 1.43)), s), 0.06, 0.06, ua, "Shirt"),
            (mirror(V((-0.005, 0.225, 1.27)), s), 0.058, 0.056, ua, "Shirt"),
            (mirror(V((-0.01, 0.232, 1.13)), s), 0.05, 0.05, el, "Sleeve"),
            (mirror(V((-0.005, 0.237, 1.0)), s), 0.046, 0.044, fa, "Sleeve"),
            (mirror(V((0, 0.24, 0.895)), s), 0.04, 0.038, fa, "Sleeve"),
        ], 7)
        y0, y1 = sorted((0.215 * s, 0.265 * s))
        b.box(V((-0.03, y0, 0.8)), V((0.04, y1, 0.9)), fa, "Skin")
        th, sh, ft = {f"thigh.{side}": 1}, {f"shin.{side}": 1}, {f"foot.{side}": 1}
        b.tube([
            (mirror(V((0, 0.095, 0.93)), s), 0.085, 0.085, th, "Trousers"),
            (mirror(V((0.005, 0.098, 0.72)), s), 0.077, 0.075, th, "Trousers"),
            (mirror(V((0.012, 0.1, 0.51)), s), 0.064, 0.062, {f"thigh.{side}": 0.5, f"shin.{side}": 0.5}, "Trousers"),
            (mirror(V((0.006, 0.1, 0.3)), s), 0.057, 0.055, sh, "Trousers"),
            (mirror(V((0, 0.1, 0.12)), s), 0.05, 0.048, sh, "Trousers"),
        ], 7)
        y0, y1 = sorted((0.048 * s, 0.152 * s))
        b.box(V((-0.065, y0, 0.0)), V((0.2, y1, 0.115)), {f"shin.{side}": 0.3, f"foot.{side}": 0.7}, "Shoes", taper=0.75)

    me = bpy.data.meshes.new("Figure")
    b.bm.to_mesh(me)
    b.bm.free()
    for m in mats:
        me.materials.append(material(m))
    obj = bpy.data.objects.new("Figure", me)
    bpy.context.scene.collection.objects.link(obj)
    for g in ORDER:
        obj.vertex_groups.new(name=g)
    # The builder wrote weights by index into the deform layer; names line up with ORDER.
    obj.parent = rig
    mod = obj.modifiers.new("Rig", "ARMATURE")
    mod.object = rig
    return obj


# ---- Vehicles ---------------------------------------------------------------


def join(parts, name):
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def part(obj, mat, smooth=False):
    obj.data.materials.clear()
    obj.data.materials.append(material(mat))
    for p in obj.data.polygons:
        p.use_smooth = smooth
    return obj


def rod(a, b, r, mat, n=6):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=n, radius=r, depth=d.length, location=(a + b) / 2,
                                        rotation=Vector((0, 0, 1)).rotation_difference(d).to_euler())
    return part(bpy.context.object, mat, smooth=True)


def ball(c, s, mat, seg=10, rings=6):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=1, location=c)
    o = bpy.context.object
    o.scale = s
    return part(o, mat, smooth=True)


def block(c, s, mat):
    bpy.ops.mesh.primitive_cube_add(size=1, location=c)
    o = bpy.context.object
    o.scale = s
    return part(o, mat)


def wheel(x, r, t, mat_hub="Metal", z=None):
    z = r + t if z is None else z
    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=t, major_segments=18, minor_segments=6,
                                     location=(x, 0, z), rotation=(math.pi / 2, 0, 0))
    tyre = part(bpy.context.object, "Tyre", smooth=True)
    hub = rod((x, -0.03, z), (x, 0.03, z), r * 0.25, mat_hub, n=8)
    return [tyre, hub]


# Where the rider meets each vehicle (used by the riding clips as well).
BIKE = {
    "rear": -0.52, "front": 0.53, "r": 0.31, "t": 0.024,
    "bb": Vector((-0.03, 0, 0.3)), "crank": 0.17, "pedal_y": 0.11,
    "saddle": Vector((-0.25, 0, 0.93)), "grip": Vector((0.37, 0.25, 1.04)),
}
MOTO = {
    "rear": -0.7, "front": 0.72, "r": 0.26, "t": 0.07,
    "seat": Vector((-0.2, 0, 0.83)), "peg": Vector((-0.1, 0.19, 0.36)), "grip": Vector((0.33, 0.34, 1.02)),
}


def make_bike():
    B = BIKE
    z = B["r"] + B["t"]
    rear, front, bb = Vector((B["rear"], 0, z)), Vector((B["front"], 0, z)), B["bb"]
    seat_top = Vector((-0.2, 0, 0.85))
    head_top, head_bot = Vector((0.4, 0, 0.9)), Vector((0.44, 0, 0.72))
    parts = wheel(B["rear"], B["r"], B["t"]) + wheel(B["front"], B["r"], B["t"])
    for s in (1, -1):
        parts.append(rod(rear + Vector((0, 0.04 * s, 0)), bb + Vector((0, 0.02 * s, 0)), 0.014, "Paint"))
        parts.append(rod(rear + Vector((0, 0.04 * s, 0)), seat_top + Vector((0, 0.012 * s, -0.04)), 0.012, "Paint"))
        parts.append(rod(front + Vector((0, 0.04 * s, 0)), head_bot + Vector((0, 0.02 * s, 0)), 0.014, "Paint"))
    parts += [
        rod(bb, seat_top, 0.02, "Paint"),
        rod(seat_top + Vector((0, 0, -0.03)), head_top, 0.02, "Paint"),
        rod(bb, head_bot, 0.023, "Paint"),
        rod(head_bot, head_top, 0.026, "Paint"),
        rod(seat_top, B["saddle"] + Vector((0.03, 0, -0.03)), 0.012, "Metal"),
        block(B["saddle"] + Vector((0, 0, -0.01)), (0.26, 0.1, 0.05), "Seat"),
        rod(head_top, Vector((0.37, 0, 1.02)), 0.014, "Metal"),
        rod(Vector((0.37, -0.29, 1.03)), Vector((0.37, 0.29, 1.03)), 0.013, "Metal"),
        rod(Vector((0.37, -0.29, 1.03)), Vector((0.37, -0.2, 1.03)), 0.02, "Seat"),
        rod(Vector((0.37, 0.2, 1.03)), Vector((0.37, 0.29, 1.03)), 0.02, "Seat"),
        rod(bb + Vector((0, -0.07, 0)), bb + Vector((0, 0.07, 0)), 0.03, "Metal"),
        # Cranks and pedals, level: the pedalling shows in the legs.
        rod(bb + Vector((0, 0.07, 0)), bb + Vector((0.17, 0.08, 0)), 0.01, "Metal"),
        rod(bb + Vector((0, -0.07, 0)), bb + Vector((-0.17, -0.08, 0)), 0.01, "Metal"),
        block(bb + Vector((0.17, 0.11, 0)), (0.08, 0.06, 0.02), "Seat"),
        block(bb + Vector((-0.17, -0.11, 0)), (0.08, 0.06, 0.02), "Seat"),
        # Mudguards and a lamp, so it reads as a town bike from above.
        block(Vector((B["rear"] - 0.04, 0, z + 0.33)), (0.4, 0.07, 0.015), "Paint"),
        block(Vector((B["front"] + 0.02, 0, z + 0.33)), (0.34, 0.07, 0.015), "Paint"),
        ball(Vector((0.47, 0, 0.9)), (0.04, 0.04, 0.035), "Lamp"),
        block(Vector((B["rear"] - 0.02, 0, z + 0.2)), (0.32, 0.16, 0.02), "Metal"),  # carrier
    ]
    return join(parts, "Bike")


def make_moto():
    M = MOTO
    z = M["r"] + M["t"]
    rear, front = Vector((M["rear"], 0, z)), Vector((M["front"], 0, z))
    parts = wheel(M["rear"], M["r"], M["t"]) + wheel(M["front"], M["r"], M["t"])
    for s in (1, -1):
        parts.append(rod(front + Vector((0, 0.09 * s, 0)), Vector((0.5, 0.09 * s, 0.95)), 0.025, "Metal"))
        parts.append(rod(rear + Vector((0, 0.1 * s, 0)), Vector((-0.1, 0.1 * s, 0.42)), 0.022, "Engine"))
        parts.append(block(M["peg"] * Vector((1, s, 1)), (0.1, 0.07, 0.02), "Metal"))
        parts.append(rod(Vector((0.36, 0.14 * s, 1.0)), Vector((0.33, 0.37 * s, 1.02)), 0.017, "Metal"))
        parts.append(rod(Vector((0.33, 0.26 * s, 1.02)), Vector((0.33, 0.38 * s, 1.02)), 0.024, "Seat"))
        parts.append(rod(Vector((0.36, 0.27 * s, 1.03)), Vector((0.33, 0.3 * s, 1.15)), 0.007, "Metal"))
        parts.append(ball(Vector((0.33, 0.3 * s, 1.16)), (0.035, 0.05, 0.025), "Seat"))
    parts += [
        ball(Vector((0.18, 0, 0.84)), (0.25, 0.16, 0.12), "Paint"),  # tank
        block(Vector((-0.28, 0, 0.8)), (0.5, 0.26, 0.09), "Seat"),
        block(Vector((-0.62, 0, 0.8)), (0.3, 0.2, 0.05), "Paint"),  # tail
        block(Vector((0.02, 0, 0.5)), (0.44, 0.24, 0.3), "Engine"),
        block(Vector((-0.22, 0, 0.62)), (0.3, 0.2, 0.18), "Paint"),  # side panels
        ball(Vector((0.55, 0, 0.98)), (0.14, 0.18, 0.13), "Paint"),  # front fairing
        ball(Vector((0.66, 0, 0.95)), (0.04, 0.08, 0.06), "Lamp"),
        rod(Vector((0.36, -0.14, 1.0)), Vector((0.36, 0.14, 1.0)), 0.02, "Metal"),
        block(Vector((M["front"], 0, z + 0.3)), (0.36, 0.12, 0.03), "Paint"),
        rod(Vector((-0.05, -0.17, 0.3)), Vector((-0.8, -0.17, 0.48)), 0.045, "Metal"),  # exhaust
        block(Vector((-0.8, 0, 0.72)), (0.06, 0.14, 0.05), "Lamp"),  # tail light (shown red in game)
    ]
    return join(parts, "Moto")


# ---- Posing -----------------------------------------------------------------


def Rx(a):
    return Matrix.Rotation(a, 3, "X")


def Ry(a):
    return Matrix.Rotation(a, 3, "Y")


def Rz(a):
    return Matrix.Rotation(a, 3, "Z")


I3 = Matrix.Identity(3)


def pose(P):
    """Joint angles (radians) -> per-bone rotation in the rest (armature) frame, applied
    about the bone's head after its parent's. Positive: `pitch`/`spine`/`head` lean the
    body forward, `thigh`/`arm`/`elbow` swing forward, `knee` bends, `out` spreads a limb
    sideways, `toe` points the foot down (feet stay flat on their own). `t` moves the hips."""
    g = lambda k, d=0.0: P.get(k, d)
    D = {
        "hips": Rz(g("yaw")) @ Ry(g("pitch")) @ Rx(g("roll")),
        "spine": Ry(g("spine")) @ Rz(g("twist")) @ Rx(g("bend")),
        "neck": I3,
        "head": Ry(g("head")) @ Rz(g("look")),
    }
    for side, s in (("L", 1), ("R", -1)):
        k = lambda n, d=0.0: P.get(f"{n}{side}", P.get(n, d))
        thigh, knee = k("thigh"), k("knee")
        D[f"thigh.{side}"] = Ry(-thigh) @ Rx(s * k("legout"))
        D[f"shin.{side}"] = Ry(knee)
        D[f"foot.{side}"] = Ry(thigh - knee - g("pitch") + k("toe"))
        D[f"upper_arm.{side}"] = Ry(-k("arm")) @ Rx(s * k("out", 0.06))
        D[f"forearm.{side}"] = Ry(-k("elbow", 0.15))
    return D, Vector(P.get("t", (0, 0, 0)))


def fk(D, t):
    """World transform of every bone for a pose (4x4, applied to rest-space points)."""
    W = {}
    for name in ORDER:
        head, _, parent = BONES[name]
        local = Matrix.Translation(head) @ D[name].to_4x4() @ Matrix.Translation(-head)
        if parent is None:
            W[name] = Matrix.Translation(t) @ local
        else:
            W[name] = W[parent] @ local
    return W


def aim(D, W, bone, parent, want):
    """Set bone's rotation so that it points along `want` (world), given its parent."""
    head, tail, _ = BONES[bone]
    rest = (tail - head).normalized()
    R = W[parent].to_3x3() if parent else I3
    local = R.inverted() @ want.normalized()
    D[bone] = rest.rotation_difference(local).to_matrix()


def two_bone(root, target, a, b, pole):
    """Middle joint of a two-bone chain from root reaching for target, bent towards pole."""
    d = target - root
    L = min(max(d.length, abs(a - b) + 1e-3), a + b - 1e-3)
    u = d.normalized()
    cos_a = (a * a + L * L - b * b) / (2 * a * L)
    n = (pole - u * pole.dot(u)).normalized()
    return root + (u * cos_a + n * math.sqrt(max(0, 1 - cos_a * cos_a))) * a


def reach(D, t, side, grip, foot_at, knee_pole, elbow_pole, foot_dir):
    """Arms to the grips and legs to the pedals/pegs, for the riding poses."""
    s = 1 if side == "L" else -1
    W = fk(D, t)
    hip = W["hips"] @ BONES[f"thigh.{side}"][0]
    knee = two_bone(hip, foot_at, (KNEE - HIP).length, (ANKLE - KNEE).length, knee_pole)
    aim(D, W, f"thigh.{side}", "hips", knee - hip)
    W = fk(D, t)
    aim(D, W, f"shin.{side}", f"thigh.{side}", foot_at - knee)
    W = fk(D, t)
    aim(D, W, f"foot.{side}", f"shin.{side}", foot_dir)
    shoulder = W["spine"] @ BONES[f"upper_arm.{side}"][0]
    g = grip * Vector((1, s, 1))
    elbow = two_bone(shoulder, g, (ELBOW - SHOULDER).length, (WRIST - ELBOW).length + 0.05, elbow_pole * Vector((1, s, 1)))
    aim(D, W, f"upper_arm.{side}", "spine", elbow - shoulder)
    W = fk(D, t)
    aim(D, W, f"forearm.{side}", f"upper_arm.{side}", g - elbow)


def lerp_pose(a, b, u):
    out = {}
    for k in set(a) | set(b):
        va, vb = a.get(k, 0.0), b.get(k, 0.0)
        if k == "t":
            va, vb = Vector(a.get(k, (0, 0, 0))), Vector(b.get(k, (0, 0, 0)))
            out[k] = tuple(va.lerp(vb, u))
        else:
            out[k] = va + (vb - va) * u
    return out


def keyed(keys, frames):
    """Poses at key frames -> a pose for every frame, eased between keys."""
    out = []
    for f in range(frames):
        for (f0, p0), (f1, p1) in zip(keys, keys[1:]):
            if f0 <= f <= f1:
                u = (f - f0) / max(1, f1 - f0)
                out.append(lerp_pose(p0, p1, u * u * (3 - 2 * u)))
                break
        else:
            out.append(keys[-1][1])
    return out


# ---- Clips ------------------------------------------------------------------


def idle(frames=72):
    out = []
    for f in range(frames):
        a = 2 * math.pi * f / frames
        out.append({
            "spine": 0.03 + 0.015 * math.sin(a), "head": -0.02 - 0.015 * math.sin(a),
            "look": 0.18 * math.sin(a) * max(0, math.sin(a)), "roll": 0.015 * math.sin(a),
            "t": (0, 0.012 * math.sin(a), -0.004 + 0.003 * math.sin(2 * a)),
            "legoutL": -0.015 * math.sin(a), "legoutR": 0.015 * math.sin(a),
            "out": 0.07, "elbow": 0.12 + 0.02 * math.sin(a), "arm": 0.02,
        })
    return out


def gait(frames, stride, knee_lift, arm, elbow, lean, bob, drop):
    out = []
    for f in range(frames):
        a = 2 * math.pi * f / frames
        P = {"spine": lean, "head": -lean * 0.7, "yaw": 0.1 * math.sin(a), "twist": -0.16 * math.sin(a),
             "t": (0, 0, -drop + bob * math.cos(2 * a)), "out": 0.08}
        for side, s in (("L", 1), ("R", -1)):
            ph = a if s > 0 else a + math.pi
            P[f"thigh{side}"] = stride * math.sin(ph)
            P[f"knee{side}"] = 0.08 + knee_lift * max(0, math.cos(ph + 0.55)) ** 1.6 + 0.1 * max(0, -math.sin(ph)) * (knee_lift > 1)
            P[f"toe{side}"] = -0.18 * max(0, math.sin(ph)) + 0.45 * max(0, -math.sin(ph + 0.35)) ** 2
            P[f"arm{side}"] = -arm * math.sin(ph)
            P[f"elbow{side}"] = elbow + 0.25 * max(0, -math.sin(ph))
        out.append(P)
    return out


STAND = {}
LIE = {"pitch": -1.54, "t": (-0.32, 0, -0.84), "outL": 1.1, "outR": 0.9, "elbowL": 0.4, "elbowR": 0.2,
       "armL": 0.3, "armR": 0.1, "thighL": 0.45, "kneeL": 0.9, "thighR": 0.05, "kneeR": 0.15, "head": 0.25, "look": 0.3}


def jump():
    crouch = {"t": (0, 0, -0.2), "pitch": 0.3, "spine": 0.15, "head": -0.3, "thigh": 0.75, "knee": 1.3, "arm": -0.8, "elbow": 0.3}
    return keyed([
        (0, STAND),
        (4, crouch),
        (7, {"t": (0, 0, 0.03), "pitch": 0.05, "thigh": -0.1, "knee": 0.05, "toe": 0.6, "arm": 2.5, "out": 0.25, "elbow": 0.2}),
        (12, {"t": (0, 0, 0), "spine": 0.15, "thigh": 1.05, "knee": 1.5, "toe": 0.2, "arm": 1.3, "out": 0.4, "elbow": 0.6}),
        (16, {"t": (0, 0, 0), "thigh": 0.45, "knee": 0.4, "arm": 0.9, "out": 0.6, "elbow": 0.3}),
        (18, {**crouch, "arm": 0.4, "out": 0.5, "t": (0, 0, -0.17)}),
        (22, STAND),
    ], 23)


def fall():
    return keyed([
        (0, STAND),
        (5, {"pitch": -0.55, "t": (-0.08, 0, -0.06), "arm": 1.9, "out": 0.35, "elbow": 0.4, "thighL": 0.5, "kneeL": 0.4, "knee": 0.2, "head": 0.4}),
        (12, {"pitch": -1.45, "t": (-0.3, 0, -0.82), "arm": 0.8, "out": 1.0, "elbow": 0.3, "thighL": 0.3, "kneeL": 0.2, "head": 0.2}),
        (15, {**LIE, "t": (-0.32, 0, -0.78)}),
        (19, LIE),
        (24, LIE),
    ], 25)


def getup():
    sit = {"pitch": -1.45, "t": (-0.3, 0, -0.8), "spine": 1.35, "head": 0.1, "thigh": 0.55, "knee": 1.2, "arm": -0.6, "out": 0.25, "elbow": 0.1}
    squat = {"pitch": 0.35, "t": (-0.05, 0, -0.5), "spine": 0.3, "head": -0.4, "thigh": 1.55, "knee": 2.3, "arm": 0.5, "elbow": 0.5, "out": 0.2}
    return keyed([(0, LIE), (9, sit), (19, squat), (29, STAND), (30, STAND)], 31)


def ride_bike(frames=24):
    B = BIKE
    out = []
    for f in range(frames):
        a = math.pi / 2 - 2 * math.pi * f / frames
        P = {"pitch": 0.1, "spine": 0.42, "head": -0.45, "roll": 0.02 * math.sin(2 * a)}
        t = B["saddle"] + Vector((0.02, 0, 0.1)) - HIPS
        P["t"] = tuple(t)
        D, tv = pose(P)
        for side, ph in (("L", a), ("R", a + math.pi)):
            s = 1 if side == "L" else -1
            pedal = B["bb"] + Vector((math.cos(ph) * B["crank"], s * B["pedal_y"], math.sin(ph) * B["crank"]))
            ankle = pedal + Vector((-0.07, 0, 0.075))
            reach(D, tv, side, B["grip"], ankle, Vector((1, 0.12 * s, 0.4)), Vector((-0.4, 0.5, -1)),
                  Vector((1, 0, -0.15 - 0.2 * math.sin(ph))))
        out.append((D, tv))
    return out


def ride_moto(frames=48):
    M = MOTO
    out = []
    for f in range(frames):
        a = 2 * math.pi * f / frames
        P = {"pitch": 0.12, "spine": 0.3, "head": -0.35 + 0.03 * math.sin(a), "look": 0.08 * math.sin(a),
             "t": tuple(M["seat"] + Vector((0.03, 0, 0.1 + 0.006 * math.sin(2 * a))) - HIPS)}
        D, tv = pose(P)
        for side in ("L", "R"):
            s = 1 if side == "L" else -1
            reach(D, tv, side, M["grip"], M["peg"] * Vector((1, s, 1)) + Vector((-0.05, 0, 0.07)),
                  Vector((1, 0.35 * s, 0.6)), Vector((-0.3, 0.8, -0.6)), Vector((1, 0, -0.25)))
        out.append((D, tv))
    return out


CLIPS = {
    "idle": (idle(), True),
    "walk": (gait(24, 0.42, 0.62, 0.36, 0.2, 0.05, 0.018, 0.012), True),
    "run": (gait(16, 0.78, 1.45, 0.75, 1.25, 0.26, 0.03, 0.05), True),
    "jump": (jump(), False),
    "fall": (fall(), False),
    "getup": (getup(), False),
    "bike": (ride_bike(), True),
    "moto": (ride_moto(), True),
}


def bake_actions(rig):
    rig.animation_data_create()
    pbs = rig.pose.bones
    rests = {b.name: b.bone.matrix_local.to_3x3() for b in pbs}
    for b in pbs:
        b.rotation_mode = "QUATERNION"
    for name, (frames, loop) in CLIPS.items():
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        # A looping clip repeats its first frame at the end, so the loop closes.
        seq = frames + ([frames[0]] if loop else [])
        for f, P in enumerate(seq):
            D, t = P if isinstance(P, tuple) else pose(P)
            for b in pbs:
                R = rests[b.name]
                b.rotation_quaternion = (R.inverted() @ D[b.name] @ R).to_quaternion()
                b.keyframe_insert("rotation_quaternion", frame=f)
            pbs["hips"].location = rests["hips"].inverted() @ t
            pbs["hips"].keyframe_insert("location", frame=f)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
    for b in pbs:
        b.rotation_quaternion = (1, 0, 0, 0)
        b.location = (0, 0, 0)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    rig = make_armature()
    person = make_person(rig)
    bike = make_bike()
    moto = make_moto()
    bake_actions(rig)
    return scene, rig, person, bike, moto


def export():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), export_format="GLB", export_animations=True, export_animation_mode="NLA_TRACKS",
        export_texcoords=False, export_normals=True, export_materials="EXPORT", export_yup=True,
        export_skins=True, export_morph=False, export_cameras=False, export_lights=False,
        export_force_sampling=True, export_optimize_animation_size=False, export_reset_pose_bones=True,
        export_anim_slide_to_zero=True,
    )
    print("wrote", OUT, OUT.stat().st_size, "bytes")


def preview(out_dir):
    """Side and three-quarter views of a few frames of every clip."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    scene, rig, person, bike, moto = build()
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x = scene.render.resolution_y = 320
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = 2.6
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    views = {"side": ((0.1, -6, 0.9), (math.pi / 2, 0, 0)), "top": ((0.1, -3.5, 5), (math.radians(35), 0, 0))}
    for name, (frames, loop) in CLIPS.items():
        for t in rig.animation_data.nla_tracks:
            t.mute = True
        rig.animation_data.action = bpy.data.actions[name]
        rig.animation_data.action_slot = bpy.data.actions[name].slots[0]
        bike.hide_render = name != "bike"
        moto.hide_render = name != "moto"
        n = len(frames)
        for i, f in enumerate(sorted({round(k * (n - 1) / 5) for k in range(6)})):
            scene.frame_set(f)
            bpy.context.view_layer.update()
            for v, (loc, rot) in views.items():
                cam.location, cam.rotation_euler = loc, rot
                scene.render.filepath = str(out / f"{name}_{v}_{i}.png")
                bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if argv[:1] == ["--preview"]:
        preview(argv[1])
    else:
        build()
        export()
