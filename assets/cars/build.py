"""Build the car bodies into public/cars.glb.

One low-poly mesh per car type (hatch, sedan, estate, van, taxi, police), made from
code so they can be tweaked and rebuilt. The game looks down on them, so what counts is
the shape from above and a little of the sides: a body rounded off at the corners in
plan, the bonnet and boot, a cabin narrower than the body with the windscreen and rear
window raked back, pillars, the wheels, mirrors and lights.

Conventions: metres, Z up, facing +X, left is +Y, wheels on z = 0, centred on the
origin; the glTF exporter turns this into three.js's Y up, still facing +X. Each object
is named after its type in src/car.ts (TYPES), with the same length, width and height.
Materials are named after the part they colour (Paint, Glass, Trim, Tyre, Metal, Lamp,
Tail, Plate, Sign, Blue, Yellow, Bar); src/car.ts colours them by name and puts the
car's own colour on Paint.

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

    def face(self, verts, mat):
        f = self.bm.faces.new(verts)
        f.material_index = MATS.index(mat)
        return f

    def v(self, x, y, z):
        return self.bm.verts.new((x, y, z))

    def body(self, stations, wheels=(), r=0.31, stripe=None, bonnet_band=None):
        """stations: (x, half width, height of the top, height of the sill), front to
        back. Over each wheel (at x in `wheels`, radius `r`) the sill rises in an arch."""
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
        xs = sorted({s[0] for s in stations} | set(arch), reverse=True)
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
            for i in range(len(L0) - 1):
                self.face([L0[i], L1[i], L1[i + 1], L0[i + 1]], mats[i])
                self.face([R0[i], R0[i + 1], R1[i + 1], R1[i]], mats[i])
            top = "Blue" if bonnet_band and bonnet_band[0] < (xs[s] + xs[s + 1]) / 2 < bonnet_band[1] else "Paint"
            self.face([L0[-1], L1[-1], R1[-1], R0[-1]], top)
            self.under.append(self.face([L0[0], R0[0], R1[0], L1[0]], "Trim"))
        for L, R, mats in (rings[0], rings[-1]):
            for i in range(len(L) - 1):
                # Bumpers across the bottom, paint above.
                self.face([L[i], L[i + 1], R[i + 1], R[i]], "Trim" if i == 0 else "Paint")

    def cabin(self, belt, xa, xb, xm, xc, xd, wb, wr, top, glass_rear=True, glass_back_side=True, xm_top=None):
        """Windscreen from (xa, belt) up to (xb, top), roof to xc, rear window down to
        xd; sides from half width wb at the belt to wr at the roof, split at xm by the
        B pillar. Every window is inset, so the pillars and frames show in paint."""
        xm_top = xm if xm_top is None else xm_top
        z0 = belt - 0.02
        A, M, D = ([self.v(x, s * wb, z0) for s in (1, -1)] for x in (xa, xm, xd))
        B, T, C = ([self.v(x, s * wr, top) for s in (1, -1)] for x in (xb, xm_top, xc))
        screen = self.face([A[0], A[1], B[1], B[0]], "Glass")
        rear = self.face([D[1], D[0], C[0], C[1]], "Glass")
        sides_front = [self.face([A[0], B[0], T[0], M[0]], "Glass"), self.face([A[1], M[1], T[1], B[1]], "Glass")]
        sides_back = [self.face([M[0], T[0], C[0], D[0]], "Glass"), self.face([M[1], D[1], C[1], T[1]], "Glass")]
        self.face([B[0], B[1], T[1], T[0]], "Paint")
        self.face([T[0], T[1], C[1], C[0]], "Paint")
        self.face([A[0], M[0], D[0], D[1], M[1], A[1]], "Paint")
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
        ring = bmesh.ops.inset_individual(self.bm, faces=faces, thickness=t, depth=-0.012)["faces"]
        for f in ring:
            f.material_index = MATS.index("Paint")

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


def saloon(name, L, W, H, rear, stripe=None, sign=False, bar=None, rails=False):
    """A car: `rear` is 'hatch', 'sedan' or 'estate'; `bar` is where along the roof the
    light bar goes (the middle of `cabin` in src/car.ts, where src/police.ts flashes it)."""
    c = Car()
    w, n = W / 2, L / 2
    belt = 0.93 if H < 1.48 else 0.95
    boot = {"hatch": belt, "sedan": belt + 0.03, "estate": belt}[rear]
    stations = [
        (n, w * 0.8, 0.7, 0.3), (n - 0.12, w * 0.93, 0.76, 0.26), (n - 0.35, w * 0.985, 0.8, 0.24),
        (n - 0.8, w, 0.84, 0.22), (n - 1.25, w, belt - 0.01, 0.22), (n - 1.45, w, belt, 0.22),
        (-n + 0.7, w, boot, 0.22), (-n + 0.3, w * 0.985, boot, 0.24), (-n + 0.1, w * 0.95, boot - 0.02, 0.27),
        (-n, w * 0.86, boot - 0.06, 0.3),
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
    c.body(stations, wheels, 0.31, stripe=stripe, bonnet_band=(n - 1.0, n - 0.55) if stripe else None)
    c.cabin(belt, xa, xb, xm, xc, xd, w - 0.11, w * 0.74, H, xm_top=(xb + xc) / 2 + 0.05)
    c.wheels(wheels, w, 0.31)
    c.mirrors(xa - 0.08, w, belt + 0.07)
    c.lamps(n - 0.06, -n + 0.04, w * 0.6, w * 0.68, 0.64, boot - 0.12)
    mid = (xb + xc) / 2
    if sign:
        c.block((mid, 0, H + 0.1), (0.24, 0.62, 0.2), "Sign")
    if bar is not None:
        c.block((bar, 0, H + 0.06), (0.3, w * 1.45, 0.12), "Bar")
        for s in (1, -1):
            c.block((bar, s * w * 0.5, H + 0.13), (0.26, w * 0.4, 0.03), "Blue")
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
    c.body(stations, wheels, 0.34)
    # A tall box behind the cab: windows only in the cab doors, none in the back.
    c.cabin(belt, xa, xa - 0.72, xa - 1.05, -n + 0.06, -n + 0.02, w - 0.02, w * 0.93, H,
            glass_rear=False, glass_back_side=False, xm_top=xa - 1.05)
    c.wheels(wheels, w, 0.34, 0.23)
    c.mirrors(xa - 0.05, w + 0.03, belt + 0.1)
    c.lamps(n - 0.05, -n + 0.02, w * 0.66, w * 0.86, 0.72, 0.85)
    return c.finish(name)


POLICE_STRIPE = [(0.5, "Blue"), (0.66, "Yellow"), (0.73, "Paint")]


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return [
        saloon("hatch", 3.9, 1.75, 1.45, "hatch"),
        saloon("sedan", 4.6, 1.82, 1.45, "sedan"),
        saloon("estate", 4.7, 1.82, 1.5, "estate", rails=True),
        van(),
        saloon("taxi", 4.6, 1.82, 1.45, "sedan", sign=True),
        saloon("police", 4.7, 1.84, 1.5, "estate", stripe=POLICE_STRIPE, bar=-0.25),
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
        o.location = (0, (i - 2.5) * 3.0, 0)
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
    }
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
