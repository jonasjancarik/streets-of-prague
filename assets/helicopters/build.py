"""Build the game's helicopter into public/helicopters.glb.

A light twin-engined utility helicopter, made from code as assets/cars/build.py and
assets/trams/build.py make theirs, the size of the one it replaces in src/helicopter.ts
(the rotor 11.2 m across, nose to fin 9 m), so it flies, lands and lets you in as before.
The game looks down on it, so what counts is the outline from above: the glazed nose,
the engine cowling behind the rotor's mast, the boom with its stabiliser and fin, the
skids, and the four blades, their tips light so the turning reads. The fuselage and
the cowling are lofted through rounded cross-sections along the length and painted
face by face by where the face is (see paint()).

Conventions: metres, Z up, facing +X, left is +Y, the skids on z = 0. Three objects:
heli_body; heli_rotor, its origin on the rotor's hub; heli_tail, the tail rotor, its
origin on its hub, turning about Y. Materials are named after what they are: Paint,
Band and Stripe take the livery in the game (src/helicopter.ts), the rest are fixed.

usage: blender -b --factory-startup -P assets/helicopters/build.py
       blender -b --factory-startup -P assets/helicopters/build.py -- --preview DIR
       (renders it from above, as the game sees it, and at an angle into DIR)
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "public" / "helicopters.glb"
HUB = (0.2, 0.0, 2.98)       # the main rotor's hub (the old model's)
TAIL_HUB = (-6.2, -0.2, 2.45)  # the tail rotor's, on the right of the fin
BLADE = 5.6                   # m from the hub to a blade's tip

# For the preview renders only; src/helicopter.ts has the game's colours (the red one's
# livery here).
HEX = {
    "Paint": "#c8312b", "Band": "#f2efe8", "Stripe": "#2a2d31", "Glass": "#1b232b",
    "Dark": "#2a2d31", "Metal": "#7b7f84", "Blade": "#26282c", "Tip": "#e9e4d6",
    "Lamp": "#fff6d8", "Beacon": "#d0242a",
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
    bsdf.inputs["Roughness"].default_value = 0.5
    m.diffuse_color = (*linear(HEX[name]), 1)
    return m


def smooth(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def through(stations, x):
    """The station values at x, eased between the given stations (sorted by x, falling)."""
    for a, b in zip(stations, stations[1:]):
        if b[0] <= x <= a[0]:
            u = smooth(b[0], a[0], x)
            return tuple(bv + (av - bv) * u for av, bv in zip(a[1:], b[1:]))
    return tuple((stations[0] if x > stations[0][0] else stations[-1])[1:])


# ---- Shapes -----------------------------------------------------------------


class Shape:
    def __init__(self):
        self.bm = bmesh.new()

    def v(self, p):
        return self.bm.verts.new(p)

    def face(self, verts, mat):
        f = self.bm.faces.new(verts)
        f.material_index = MATS.index(mat)
        return f

    def loft(self, xs, section, paint, ring=40, power=2.6, smooth=True):
        """Rings at each x of xs (from the front back), section(x) -> (yc, zc, half width,
        half height) with the ring a superellipse of that power; each face painted by
        paint(x, y, z) at its middle; the ends closed."""
        rings = []
        for x in xs:
            yc, zc, w, h = section(x)
            pts = []
            for k in range(ring):
                a = 2 * math.pi * k / ring
                c, s = math.cos(a), math.sin(a)
                pts.append(self.v((x, yc + w * math.copysign(abs(c) ** (2 / power), c), zc + h * math.copysign(abs(s) ** (2 / power), s))))
            rings.append(pts)
        for r0, r1 in zip(rings, rings[1:]):
            for k in range(ring):
                q = [r0[k], r0[(k + 1) % ring], r1[(k + 1) % ring], r1[k]]
                mid = sum((p.co for p in q), Vector()) / 4
                self.face(q, paint(*mid)).smooth = smooth
        for r, flip in ((rings[0], False), (rings[-1], True)):
            mid = sum((p.co for p in r), Vector()) / len(r)
            c = self.v(mid)
            for k in range(ring):
                tri = [r[k], r[(k + 1) % ring], c]
                self.face(tri[::-1] if flip else tri, paint(*mid))

    def block(self, c, s, mat):
        (cx, cy, cz), (sx, sy, sz) = c, s
        vs = [self.v((cx + dx * sx / 2, cy + dy * sy / 2, cz + dz * sz / 2)) for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)]
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.face([vs[i] for i in q], mat)

    def tube(self, path, r, mat, sides=8):
        """A round tube r thick through the points of `path`, its ends closed."""
        path = [Vector(p) for p in path]
        rings = []
        for i, p in enumerate(path):
            d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
            u = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized()
            w = d.cross(u)
            rings.append([self.v(p + (u * math.cos(2 * math.pi * k / sides) + w * math.sin(2 * math.pi * k / sides)) * r) for k in range(sides)])
        for r0, r1 in zip(rings, rings[1:]):
            for k in range(sides):
                self.face([r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]], mat)
        self.face(rings[0][::-1], mat)
        self.face(rings[-1], mat)

    def plate(self, outline, y, t, mat):
        """A flat plate t thick in the XZ plane at y, of the outline's (x, z) points."""
        a = [self.v((x, y - t / 2, z)) for x, z in outline]
        b = [self.v((x, y + t / 2, z)) for x, z in outline]
        self.face(a, mat)
        self.face(b[::-1], mat)
        n = len(outline)
        for k in range(n):
            self.face([a[(k + 1) % n], a[k], b[k], b[(k + 1) % n]], mat)

    def wing(self, outline, z, t, mat):
        """A flat plate t thick in the XY plane at z, of the outline's (x, y) points."""
        a = [self.v((x, y, z - t / 2)) for x, y in outline]
        b = [self.v((x, y, z + t / 2)) for x, y in outline]
        self.face(a[::-1], mat)
        self.face(b, mat)
        n = len(outline)
        for k in range(n):
            self.face([a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]], mat)

    def finish(self, name, origin=(0, 0, 0)):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bmesh.ops.translate(bm, verts=bm.verts, vec=-Vector(origin))
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        used = sorted({p.material_index for p in mesh.polygons})
        for p in mesh.polygons:
            p.material_index = used.index(p.material_index)
        for i in used:
            mesh.materials.append(material(MATS[i]))
        obj = bpy.data.objects.new(name, mesh)
        obj.location = origin
        bpy.context.scene.collection.objects.link(obj)
        return obj


# ---- The helicopter ---------------------------------------------------------

# The fuselage from the nose back: (x, half width, bottom, top).
CABIN = [
    (2.78, 0.06, 1.18, 1.32),
    (2.62, 0.42, 0.86, 1.72),
    (2.30, 0.70, 0.66, 2.06),
    (1.80, 0.86, 0.56, 2.30),
    (1.00, 0.93, 0.52, 2.44),
    (0.00, 0.93, 0.52, 2.48),
    (-0.80, 0.86, 0.62, 2.44),
    (-1.50, 0.62, 0.92, 2.32),
    (-2.10, 0.36, 1.38, 2.18),
    (-2.50, 0.28, 1.62, 2.12),
]
# The cowling over the engines, on the cabin's roof: (x, half width, top).
COWL = [
    (1.05, 0.12, 2.42),
    (0.70, 0.50, 2.80),
    (-0.40, 0.56, 2.90),
    (-1.40, 0.46, 2.80),
    (-1.95, 0.18, 2.50),
]


def paint(x, y, z):
    """The fuselage's colour at a face's middle."""
    side = abs(y)
    # The canopy: the nose's upper half, a slim post down its middle.
    if x > 1.62 and z > 1.36:
        return "Paint" if side < 0.05 and z > 1.9 else "Glass"
    # The cabin's side windows, a pillar between them.
    if -0.25 < x < 1.05 and 1.45 < z < 2.15 and side > 0.62 and not 0.42 < x < 0.52:
        return "Glass"
    if 0.62 < z < 1.04:
        return "Band"
    if 1.04 < z < 1.14:
        return "Stripe"
    return "Paint"


def body():
    s = Shape()

    def cabin(x):
        w, zb, zt = through(CABIN, x)
        return 0.0, (zb + zt) / 2, w, (zt - zb) / 2

    xs = [2.78 - 0.06 * i for i in range(int((2.78 + 2.5) / 0.06) + 1)]
    s.loft(xs, cabin, paint, ring=52, power=2.5)

    def cowl(x):
        w, zt = through(COWL, x)
        return 0.0, 2.3 + (zt - 2.3) / 2, w, (zt - 2.3) / 2 + 0.04

    s.loft([1.05 - 0.1 * i for i in range(31)], cowl, lambda x, y, z: "Paint", ring=32, power=2.2)
    # The engines' intakes either side of the mast, and the exhausts at the back.
    for side in (-1, 1):
        s.block((0.45, side * 0.47, 2.7), (0.42, 0.12, 0.16), "Dark")
        s.block((-1.62, side * 0.26, 2.66), (0.34, 0.16, 0.12), "Dark")
    s.tube([(HUB[0], 0, 2.82), (HUB[0], 0, HUB[2] - 0.04)], 0.13, "Dark", sides=10)

    # The boom, tapering back to the fin.
    def boom(x):
        u = (x + 2.3) / (-6.4 + 2.3)
        return 0.0, 1.92 + 0.34 * u, 0.3 - 0.14 * u, 0.3 - 0.14 * u

    s.loft([-2.3 - 0.2 * i for i in range(21)], boom, lambda x, y, z: "Paint", ring=16, power=2.0)
    # The fin: swept back above the boom, a small one under it.
    s.plate([(-5.55, 2.1), (-6.2, 2.1), (-6.68, 3.3), (-6.3, 3.32), (-5.85, 2.6)], 0.0, 0.14, "Band")
    s.plate([(-5.9, 2.05), (-6.35, 2.05), (-6.5, 1.55), (-6.25, 1.52)], 0.0, 0.1, "Band")
    s.block((-6.55, 0.0, 3.36), (0.12, 0.1, 0.08), "Beacon")
    # The stabiliser across the boom, with end plates.
    s.wing([(-4.8, 1.2), (-5.25, 1.2), (-5.3, -1.2), (-4.85, -1.2)], 2.16, 0.07, "Paint")
    for side in (-1, 1):
        s.plate([(-4.85, 2.0), (-5.3, 2.0), (-5.38, 2.42), (-5.0, 2.42)], side * 1.22, 0.05, "Band")

    # The skids, turned up at the front, and the two bows under the cabin.
    for side in (-1, 1):
        s.tube([(-1.55, side * 1.05, 0.06), (1.55, side * 1.05, 0.06), (1.85, side * 1.05, 0.14), (2.0, side * 1.05, 0.34)], 0.055, "Metal")
    for x in (-0.65, 1.15):
        s.tube([(x, -1.05, 0.06), (x, -1.02, 0.32), (x, -0.84, 0.6), (x, 0.84, 0.6), (x, 1.02, 0.32), (x, 1.05, 0.06)], 0.05, "Metal")
    # The searchlight under the nose.
    s.block((1.8, 0.0, 0.62), (0.3, 0.26, 0.24), "Lamp")
    return s.finish("heli_body")


def rotor():
    s = Shape()
    hx, hy, hz = HUB
    s.tube([(hx, hy, hz - 0.08), (hx, hy, hz + 0.1)], 0.3, "Dark", sides=12)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        ca, sa = math.cos(a), math.sin(a)

        def at(r, across, z=hz + 0.02):
            return (hx + ca * r - sa * across, hy + sa * r + ca * across, z)

        # Tapered from the root to the tip, the last stretch light.
        for r0, r1, c0, c1, mat in ((0.25, BLADE - 0.45, 0.18, 0.15, "Blade"), (BLADE - 0.45, BLADE, 0.15, 0.1, "Tip")):
            outline = [at(r0, -c0), at(r1, -c1 * 0.9), at(r1, c1 * 1.1), at(r0, c0)]
            a_ = [s.v((p[0], p[1], p[2] - 0.025)) for p in outline]
            b_ = [s.v((p[0], p[1], p[2] + 0.025)) for p in outline]
            s.face(a_[::-1], mat)
            s.face(b_, mat)
            for i in range(4):
                s.face([a_[i], a_[(i + 1) % 4], b_[(i + 1) % 4], b_[i]], mat)
    return s.finish("heli_rotor", HUB)


def tail_rotor():
    s = Shape()
    x, y, z = TAIL_HUB
    s.tube([(x, y + 0.08, z), (x, y - 0.06, z)], 0.1, "Dark", sides=10)
    for k in (-1, 1):
        s.plate([(x - 0.07, z), (x + 0.07, z), (x + 0.05, z + k * 0.95), (x - 0.05, z + k * 0.95)][:: k], y - 0.02, 0.03, "Blade")
        s.plate([(x - 0.05, z + k * 0.8), (x + 0.05, z + k * 0.8), (x + 0.05, z + k * 0.95), (x - 0.05, z + k * 0.95)][:: k], y - 0.045, 0.02, "Tip")
    return s.finish("heli_tail", TAIL_HUB)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return [body(), rotor(), tail_rotor()]


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
    """From above, as the game sees it, and from above at an angle."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    build()
    scene = bpy.context.scene
    ground = bpy.data.meshes.new("ground")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=30)
    bm.to_mesh(ground)
    g = bpy.data.objects.new("ground", ground)
    mg = bpy.data.materials.new("GroundPreview")
    mg.diffuse_color = (0.25, 0.27, 0.28, 1)
    ground.materials.append(mg)
    scene.collection.objects.link(g)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 1200, 900
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(38)
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    views = {
        "top": ((-0.6, 0, 19), (-0.6, 0, 0)),
        "angle": ((7, -11, 8), (-1.2, 0, 1.6)),
        "side": ((-1.5, -15, 2.2), (-1.5, 0, 1.8)),
    }
    for v, (loc, at) in views.items():
        cam.location = loc
        cam.rotation_euler = (Vector(at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.view_layer.update()
        scene.render.filepath = str(out / f"heli_{v}.png")
        bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if argv[:1] == ["--preview"]:
        preview(argv[1])
    else:
        build()
        export()
