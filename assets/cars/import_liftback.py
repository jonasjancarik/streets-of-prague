"""Trial: turn a downloaded liftback model into the game's taxi street shell.

blender -b --factory-startup -P oct_convert.py -- SOURCE.glb OUT.glb [--clay DIR]

Game frame: metres, +X forward, +Y left, Z up, wheels on z = 0, centred on the origin.
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

REPO = Path("/Users/janca/projects/streets-of-prague")
sys.path.insert(0, str(REPO / "assets/cars"))
argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
CLAY = argv[argv.index("--clay") + 1] if "--clay" in argv else None
NAME = "taxi"
LENGTH = 4.6  # the game's taxi (TYPES in src/car.ts)

bpy.ops.wm.read_factory_settings(use_empty=True)
import build  # noqa: E402  (after the reset: it makes materials)
from build import COLOURS, MATS, material  # noqa: E402

bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
# The file carries a door cycle: take the frame where the doors reach out least.
doors_in = [o for o in bpy.data.objects if o.name.startswith("OCT_Door_")]
def reach():
    bpy.context.view_layer.update()
    return max(abs((c.matrix_world @ Vector(b)).y) for d in doors_in for c in d.children_recursive if c.type == "MESH" for b in c.bound_box)
frames = range(int(scene.frame_start), int(max([a.frame_range[1] for a in bpy.data.actions] + [scene.frame_end])) + 1)
best = None
for f in frames:
    scene.frame_set(f)
    r = reach()
    if best is None or r < best[0] - 1e-5:
        best = (r, f)
scene.frame_set(best[1])
bpy.context.view_layer.update()
print("doors closed at frame", best[1], "reach", round(best[0], 3))
shut = {o: o.matrix_world.copy() for o in bpy.data.objects}
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data_clear()
for o, m in shut.items():
    if o.parent is None:
        o.matrix_world = m
bpy.context.view_layer.update()

# ---- What to keep, and as what ------------------------------------------------
# Source material (without its numeric suffix) to the game's material.
FINISH = {
    "e_Carpaint": "Paint",
    "e_glass": "Window", "e_glass_Darken": "Window",
    "e_glass_Aqua": "LensCover", "E_Lens": "Optic", "E_Light": "Lamp", "e_parabola": "Optic",
    "e_glass_Red": "Tail", "E_light_Rear": "Tail", "e_glass_AF": "LensBed", "e_glass_Blinker": "Indicator",
    "e_plastic_K31_Black_fine": "Trim", "e_plastic_Black_Textured_AF": "Trim", "e_plastic_Podbehy": "Trim",
    "flatblack": "Trim", "e_rubber": "RubStrip", "i_plastic_Black_smooth": "Trim",
    "e_plastic_Black_gloss": "GlassSeal", "E_Chrome": "DarkChrome", "e_chrome_Unique_Dark": "DarkChrome",
    "e_mirror_reflection": "DoorMirror",
}
EXTRA = {"LensCover": (0.05, 0.07, 0.09), "DoorMirror": (0.10, 0.14, 0.16), "GlassSeal": (0.02, 0.022, 0.024)}
BODY = ("___LPWLY___body_lak", "___LWPLY___glass_mlhovka", "Shell27", "Surface_01", "EXT_ELROQ_", "EXT_WIPERS")
DROP = ("___LPWLY___body_lak.091",)  # lettering and boot fittings
DOORS = {"OCT_Door_Front_L_Animation": 1, "OCT_Door_Front_R_Animation": 2, "OCT_Door_Rear_L_Animation": 3, "OCT_Door_Rear_R_Animation": 4}
# How much of each finish's triangles to keep.
KEEP = {"Trim": 0.22, "DarkChrome": 0.3, "RubStrip": 0.3, "GlassSeal": 0.5, "Paint": 0.8, "Optic": 0.5, "Tail": 0.6}


def finish_of(mat):
    if mat is None:
        return None
    base = mat.name.rsplit(".", 1)[0] if mat.name.rsplit(".", 1)[-1].isdigit() else mat.name
    if base.startswith("e_Carpaint"):
        return "Paint"
    return FINISH.get(base)


def game_material(name):
    if name in COLOURS:
        return material(name)
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.diffuse_color = (*EXTRA[name], 1)
    return m


tops = {o.name: o for o in bpy.data.objects if o.parent is None}
groups = {0: []}  # door number (0: the body) to its mesh objects
for name, top in tops.items():
    fam = [o for o in [top, *top.children_recursive] if o.type == "MESH"]
    if name in DOORS:
        groups[DOORS[name]] = fam
    elif name.startswith(BODY) and name not in DROP:
        groups[0] += fam

# The source faces -X with its wheels 10 cm off the floor; find the body's extent.
shell = [o for o in groups[0] if any(finish_of(s.material) == "Paint" for s in o.material_slots)]
pts = [o.matrix_world @ Vector(c) for o in shell for c in o.bound_box]
x0, x1 = min(p.x for p in pts), max(p.x for p in pts)
tyres = tops["TIRE.002"]
ground = min((tyres.matrix_world @ Vector(c)).z for c in tyres.bound_box)
scale = LENGTH / (x1 - x0)
to_game = Matrix.Scale(scale, 4) @ Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Translation((-(x0 + x1) / 2, 0, -ground))
print(f"source length {x1 - x0:.3f} m, ground at {ground:.3f}, scale {scale:.4f}")
tp = [to_game @ (tyres.matrix_world @ v.co) for v in tyres.data.vertices]
front = [p for p in tp if p.x > 0]
rear = [p for p in tp if p.x < 0]
axles = [(max(p.x for p in g) + min(p.x for p in g)) / 2 for g in (front, rear)]
radius = max(p.z for p in tp) / 2
track = max(abs(p.y) for p in tp)
print(f"axles at {axles[0]:.3f} and {axles[1]:.3f}, tyre radius {radius:.3f}, outer faces at {track:.3f}")
plates = tops.get("RZ_znacka.001")
plate_at = []
if plates:
    pp = [to_game @ (plates.matrix_world @ v.co) for v in plates.data.vertices]
    for end in (1, -1):
        g = [p for p in pp if p.x * end > 0 and abs(p.y) < 0.27]
        far = max(abs(p.x) for p in g)
        g = [p for p in g if abs(p.x) > far - 0.03]
        plate_at.append((end * far, (min(p.z for p in g) + max(p.z for p in g)) / 2,
                         max(p.z for p in g) - min(p.z for p in g), max(abs(p.y) for p in g)))
    print("plates (x, z, height, half width):", [[round(v, 3) for v in p] for p in plate_at])


def gather(objs, label):
    """One bmesh per game finish from these objects, in the game's frame."""
    out = {}
    for o in objs:
        mesh = o.data
        world = to_game @ o.matrix_world
        slots = [finish_of(s.material) for s in o.material_slots] or [None]
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bm.transform(world)
        if world.determinant() < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces)
        by = {}
        for f in bm.faces:
            fin = slots[f.material_index] if f.material_index < len(slots) else None
            if fin:
                by.setdefault(fin, []).append(f)
        for fin, faces in by.items():
            part = out.setdefault(fin, bmesh.new())
            verts = {}
            for f in faces:
                vs = []
                for v in f.verts:
                    if v.index not in verts:
                        verts[v.index] = part.verts.new(v.co)
                    vs.append(verts[v.index])
                try:
                    part.faces.new(vs).smooth = True
                except ValueError:
                    pass
        bm.free()
    return out


def to_object(name, bm, fin, parent=None):
    if fin not in ("Paint", "Window"):
        # No maker's badge: any small separate piece on the centre line of the nose or
        # the tailgate (the emblem, its backing) goes.
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
        bm.verts.ensure_lookup_table()
        seen, gone = set(), []
        for v in bm.verts:
            if v in seen:
                continue
            island, stack = [], [v]
            seen.add(v)
            while stack:
                a = stack.pop()
                island.append(a)
                for e in a.link_edges:
                    o = e.other_vert(a)
                    if o not in seen:
                        seen.add(o)
                        stack.append(o)
            xs, ys, zs = ([p.co[i] for p in island] for i in range(3))
            if max(abs(y) for y in ys) < 0.09 and min(abs(x) for x in xs) > 2.0 and min(zs) > 0.69 and max(zs) - min(zs) < 0.2:
                gone += island
        if gone:
            print("badge pieces removed from", fin, len(gone), "vertices")
            bmesh.ops.delete(bm, geom=gone, context="VERTS")
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(game_material(fin))
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    tris = sum(len(p.vertices) - 2 for p in mesh.polygons)
    keep = KEEP.get(fin, 1.0)
    if keep < 1 and tris > 400:
        mod = obj.modifiers.new("thin", "DECIMATE")
        mod.ratio = keep
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(42))
    if parent:
        obj.parent = parent
    return obj


def join(name, objs, parent=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    if parent:
        obj.parent = parent
    return obj


LAMPS = ("Lamp", "Tail", "Optic", "LensBed", "LensCover")
made = []
body_parts = gather(groups[0], "body")
trim_parts = {k: body_parts.pop(k) for k in list(body_parts) if k in LAMPS}
root = join(NAME, [to_object(f"{NAME}_{fin}", bm, fin) for fin, bm in body_parts.items()])
for k in (1, 2, 3, 4):
    parts = gather(groups.get(k, []), f"door{k}")
    if parts:
        join(f"{NAME}_door{k}", [to_object(f"{NAME}_door{k}_{fin}", bm, fin) for fin, bm in parts.items()], root)

# The fittings the game lights and letters: lamps, and a flat plate at each end.
trim_objs = [to_object(f"{NAME}_trim_{fin}", bm, fin) for fin, bm in trim_parts.items()]
bm = bmesh.new()
for x, z, h, half in plate_at:
    end = 1 if x > 0 else -1
    for mat_half, mat_h, off in ((0.265, 0.064, 0.004), (0.254, 0.055, 0.008)):
        vs = [bm.verts.new((x + end * off, s * mat_half * u, z + mat_h * v)) for u, v, s in ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1))]
        f = bm.faces.new(vs if end > 0 else vs[::-1])
        f.material_index = 0 if mat_half > 0.26 else 1
mesh = bpy.data.meshes.new("plates")
bm.to_mesh(mesh)
bm.free()
mesh.materials.append(game_material("RubStrip"))
mesh.materials.append(game_material("Plate"))
plate_obj = bpy.data.objects.new("plates", mesh)
scene.collection.objects.link(plate_obj)
# The roof sign, from the generator the other taxis use, set on this roof.
import street_shapes  # noqa: E402
roof_z = max(v.co.z for v in root.data.vertices if abs(v.co.y) < 0.2 and -0.6 < v.co.x < 0.1)
sign = street_shapes.StreetCar(NAME)
sign.roof_point = lambda t, q: (-0.25, 0.0, roof_z - 0.004)
sign.taxi_sign(0, 0)
sign_obj = build.Car.object("sign", sign.bm)
trim = join(f"{NAME}_street_trim", trim_objs + [plate_obj, sign_obj])
lamp = [v.co for v in trim.data.vertices if v.co.x > 1.5 and v.co.y > 0.3]
if lamp:
    trim["headlamp"] = [max(p.x for p in lamp) - 0.03, sum(p.y for p in lamp) / len(lamp), sum(p.z for p in lamp) / len(lamp)]

for o in list(bpy.data.objects):
    if o not in (root, trim) and o.parent is not root:
        bpy.data.objects.remove(o, do_unlink=True)

def span(obj, mat, axis, keep=lambda c: True):
    i = [s.material.name for s in obj.material_slots].index(mat)
    vs = [obj.data.vertices[k].co for p in obj.data.polygons if p.material_index == i for k in p.vertices]
    vs = [c for c in vs if keep(c)]
    return round(min(c[axis] for c in vs), 3), round(max(c[axis] for c in vs), 3)
d1, d3 = bpy.data.objects[f"{NAME}_door1"], bpy.data.objects[f"{NAME}_door3"]
print("front door paint x", span(d1, "Paint", 0), "glass z", span(d1, "Window", 2), "glass x", span(d1, "Window", 0), "glass y", span(d1, "Window", 1))
print("rear door paint x", span(d3, "Paint", 0), "glass z", span(d3, "Window", 2), "glass x", span(d3, "Window", 0))
print("body glass: windscreen x", span(root, "Window", 0, lambda c: c.x > 0), "z", span(root, "Window", 2, lambda c: c.x > 0), "rear x", span(root, "Window", 0, lambda c: c.x < 0), "z", span(root, "Window", 2, lambda c: c.x < 0))
print("roof z", round(roof_z, 3), "sill z", span(d1, "Paint", 2))
total = 0
for o in [root, *root.children, trim]:
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    total += n
    lo = [min(v.co[i] for v in o.data.vertices) for i in range(3)]
    hi = [max(v.co[i] for v in o.data.vertices) for i in range(3)]
    print(f"{o.name:22} {n:6} tris  x[{lo[0]:.2f},{hi[0]:.2f}] y[{lo[1]:.2f},{hi[1]:.2f}] z[{lo[2]:.2f},{hi[2]:.2f}]  {[s.material.name for s in o.material_slots]}")
print("total", total, "triangles")

if CLAY:
    scene.render.engine = "BLENDER_WORKBENCH"
    sh = scene.display.shading
    sh.light, sh.color_type, sh.show_cavity, sh.cavity_type = "STUDIO", "MATERIAL", True, "BOTH"
    scene.render.resolution_x, scene.render.resolution_y = 1000, 600
    scene.world = bpy.data.worlds.new("w")
    scene.world.color = (.5, .5, .5)
    for m in bpy.data.materials:
        if m.name in ("Window", "LensCover"):
            m.diffuse_color = (.1, .14, .17, 1)
        m.roughness = .35
    cd = bpy.data.cameras.new("cam")
    cd.lens = 70
    cam = bpy.data.objects.new("cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    views = {"side": (0, 1, .1), "f34": (.8, .62, .3), "r34": (-.8, .62, .34), "top": (-.2, .45, 1.0), "front": (1, .08, .12), "rear": (-1, .1, .14)}
    for v, d in views.items():
        d = Vector(d).normalized()
        at = Vector((0, 0, .7))
        cam.location = at + d * (LENGTH * 1.55 + 2.2)
        cam.rotation_euler = (at - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(Path(CLAY) / f"oct-{v}.png")
        bpy.ops.render.render(write_still=True)
    scene.collection.objects.unlink(cam)

bpy.ops.object.select_all(action="DESELECT")
for o in [root, *root.children_recursive, trim]:
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT, use_selection=True, export_format="GLB", export_texcoords=False, export_normals=True,
    export_extras=True, export_yup=True, export_meshopt_compression_enable=True,
    export_meshopt_extension="EXT_meshopt_compression", export_animations=False, export_cameras=False, export_lights=False,
)
print("wrote", OUT, Path(OUT).stat().st_size, "bytes")
