"""Run by Blender in the background (landmarks.py starts it): bakes the colours of a
landmark's piece of IPR's photorealistic mesh onto its clean model from IPR's city
model (LOD3), and writes that as a GLB.

    blender -b --factory-startup -P landmark_bake.py -- low.obj high.glb out.glb [cm_per_px] [sources.glb] [spots]

Both inputs are in the game's coordinates (y up), as is the result. The clean model is
welded, its coplanar triangles merged into faces and its undersides dropped; it gets
UVs and one texture of about `cm_per_px` (default 5) cm per pixel.

A roof's colours come from straight above, as the game's camera sees it (the mesh
comes from aerial photographs too): the first surface of the mesh a ray from high
above meets, so a dome the clean model has simpler than it is still looks right. A
wall's come from a ray cast inwards from a little outside it, or where the two models
are further apart than that, from a second, longer ray. Where that ray meets the
underside of something (an onion dome bulging out over the simpler drum the clean
model has, whose shaded underside the camera never sees), the wall takes what's seen
from above instead. A wall's texels no ray found the mesh for (its lowest metres behind
neighbouring houses) repeat the same wall from above them, and `spots` ("x,y,radius;…",
metres, the model's x and its north) are places on roofs where what is much darker
than the roof (a tree reaching over it) is painted over with the roof's colour round it
(landmark_fill.py). Anything still missing is filled in from around it.

`sources.glb`, if given, is the same model with each texel coloured by where its colour
came from, for checking a landmark: red from above on a roof, orange from above on a
wall (under something), green straight in, blue straight in from further off, yellow
taken from elsewhere on the same face (a gap on a wall, a spot painted over), white
filled in from around it (no ray found the mesh).

LANDMARK_DEBUG=<file.npz> keeps the images the fills work on, to try landmark_fill.py
on them without baking again.
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_fill as fill  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:]
low_path, high_path, out_path = map(os.path.abspath, args[:3])
CM = float(args[3]) if len(args) > 3 else 5.0
sources_path = os.path.abspath(args[4]) if len(args) > 4 and args[4] != "-" else None
spots = [tuple(map(float, t.split(","))) for t in args[5].split(";")] if len(args) > 5 and args[5] not in ("", "-") else []

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def select(*objs, active=None):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


bpy.ops.wm.obj_import(filepath=low_path)
low = bpy.context.selected_objects[0]
bpy.ops.import_scene.gltf(filepath=high_path)
highs = [o for o in bpy.context.selected_objects if o.type == "MESH"]
select(*highs)
if len(highs) > 1:
    bpy.ops.object.join()
high = bpy.context.view_layer.objects.active
# The importers turn y-up into Blender's z-up with the objects' rotation: put it into
# the meshes, so z is up in them too (and the GLB comes out without a rotation).
for o in (low, high):
    select(o)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

ROOF = 0.35  # a face whose normal points up at least this much is a roof

me = low.data
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.02)
# A triangle or two the city model lacks (a wall with half of it missing): small holes
# are filled, the new faces turned to match the faces around them. The model's own
# normals are kept otherwise: they face out (CityGML), where Blender's guess on a set of
# touching solids goes wrong.
filled = bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=4)["faces"]
bmesh.ops.recalc_face_normals(bm, faces=filled)
print(f"filled {len(filled)} holes")
bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=bm.verts, edges=bm.edges)
# Undersides (floors over the ground or the water) are never seen from above.
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z < -0.7], context="FACES")
# Roofs and walls baked in different ways, so they share no vertices.
bmesh.ops.split_edges(bm, edges=[e for e in bm.edges if len(e.link_faces) == 2
                                 and (e.link_faces[0].normal.z > ROOF) != (e.link_faces[1].normal.z > ROOF)])
area = sum(f.calc_area() for f in bm.faces)
bm.to_mesh(me)
bm.free()

select(low)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
bpy.ops.object.mode_set(mode="OBJECT")
# Islands fill about 70% of the texture; a power of two, 512–4096 px.
size = min(4096, max(512, 2 ** math.ceil(math.log2(math.sqrt(area / 0.7) / (CM / 100)))))
print(f"clean model: {len(me.polygons)} faces, {area:.0f} m², texture {size}×{size}")

mat = bpy.data.materials.new("landmark")
mat.use_backface_culling = True  # the faces face out: the GLB says one-sided
mat.use_nodes = True
nt = mat.node_tree
bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
tex = nt.nodes.new("ShaderNodeTexImage")
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
nt.nodes.active = tex
me.materials.clear()
me.materials.append(mat)

scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 4
bake = scene.render.bake
bake.use_selected_to_active = True
bake.margin = 0
bake.use_pass_direct = False
bake.use_pass_indirect = False
bake.use_pass_color = True


def emitting(name, value):
    """A material that shows one number of the mesh where a ray met it, for a bake:
    `value(nodes, links)` builds the nodes and returns the socket to show."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    t = m.node_tree
    for n in list(t.nodes):
        t.nodes.remove(n)
    emit, out = t.nodes.new("ShaderNodeEmission"), t.nodes.new("ShaderNodeOutputMaterial")
    t.links.new(value(t.nodes, t.links), emit.inputs["Color"])
    t.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return m


def _facing(nodes, links):
    geo, sep, mp = nodes.new("ShaderNodeNewGeometry"), nodes.new("ShaderNodeSeparateXYZ"), nodes.new("ShaderNodeMapRange")
    mp.inputs["From Min"].default_value, mp.inputs["To Min"].default_value = -1.0, 0.1
    links.new(geo.outputs["True Normal"], sep.inputs[0])
    links.new(sep.outputs["Z"], mp.inputs["Value"])
    return mp.outputs["Result"]


# Which way the mesh faces where a ray met it: its normal's height, from 0.1 (straight
# down) to 1 (straight up), so that black still means a miss.
facing = emitting("facing", _facing)


def bake_into(name, extrusion, reach, value=None):
    """The mesh's base colour (or with `value`, a material from `emitting`, that
    number) by rays from `extrusion` m outside the clean surface inwards, at most
    `reach` m long; black where none found it."""
    im = bpy.data.images.new(name, size, size, float_buffer=value is not None)
    tex.image = im
    bake.cage_extrusion = extrusion
    bake.max_ray_distance = reach
    select(high, low, active=low)
    own = [s.material for s in high.material_slots]
    if value:
        for s in high.material_slots:
            s.material = value
    bpy.ops.object.bake(type="EMIT" if value else "DIFFUSE")
    for s, m in zip(high.material_slots, own):
        s.material = m
    px = np.empty(size * size * 4, np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(size, size, 4)


def texels():
    """Which face of the clean model each texel is on (-1: none), and where on it (the
    model's coordinates, metres)."""
    face = np.full((size, size), -1, np.int32)
    pos = np.zeros((size, size, 3), np.float32)
    uvs = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get("uv", uvs)
    uvs = uvs.reshape(-1, 2) * size
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    ys, xs = np.mgrid[0:size, 0:size]
    me.calc_loop_triangles()
    for t in me.loop_triangles:
        a, b, c = (uvs[i] for i in t.loops)
        area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(area) < 1e-9:
            continue
        x0, y0 = np.floor(np.minimum(np.minimum(a, b), c)).astype(int).clip(0, size - 1)
        x1, y1 = np.ceil(np.maximum(np.maximum(a, b), c)).astype(int).clip(0, size - 1)
        px_, py_ = xs[y0:y1 + 1, x0:x1 + 1] + 0.5, ys[y0:y1 + 1, x0:x1 + 1] + 0.5
        # Each corner's weight at the texel's middle: inside where none is negative.
        w = [((q[0] - p[0]) * (py_ - p[1]) - (q[1] - p[1]) * (px_ - p[0])) / area for p, q in ((b, c), (c, a), (a, b))]
        inside = (w[0] >= 0) & (w[1] >= 0) & (w[2] >= 0)
        face[y0:y1 + 1, x0:x1 + 1][inside] = t.polygon_index
        pa, pb, pc = (co[i] for i in t.vertices)
        pos[y0:y1 + 1, x0:x1 + 1][inside] = (w[0][..., None] * pa + w[1][..., None] * pb + w[2][..., None] * pc)[inside]
    return face, pos


def bake_from_above(name, value=None, rise=30.0):
    """Colours (or `value`, as in bake_into) by rays straight down from `rise` m above,
    through a cage: the clean model lifted. On a wall, a ray runs down its face, meeting
    whatever is over it."""
    cage = low.copy()
    cage.data = low.data.copy()
    bpy.context.collection.objects.link(cage)
    for v in cage.data.vertices:
        v.co.z += rise
    bake.use_cage = True
    bake.cage_object = cage
    try:
        return bake_into(name, 0.0, rise + 20.0, value)
    finally:
        bake.use_cage = False
        bpy.data.objects.remove(cage)


def missed(px):
    """What the bake left black: no ray found the mesh, or outside the UV islands (a
    photograph is next to never pure black)."""
    return px[..., :3].max(-1) < 1e-4


near = bake_into("near", 1.5, 3.5)  # where the two models agree
far = bake_into("far", 3.0, 8.0)    # parts the clean model has further off
use_far = missed(near)
side = np.where(use_far[..., None], far, near)
# Which way the mesh faces where those rays met it (see `facing`): below 0.4, its
# normal points down at least a little.
up = np.where(use_far, bake_into("far_n", 3.0, 8.0, facing)[..., 0], bake_into("near_n", 1.5, 3.5, facing)[..., 0])
under = ~missed(side) & (up > 0.1) & (up < 0.4)
above = bake_from_above("above")
face, where = texels()
roofs = (face >= 0) & np.array([f.normal.z > ROOF for f in me.polygons])[face]
from_above = (roofs | under) & ~missed(above)
px = np.where(from_above[..., None], above, side)
hole = missed(px)
del near, far, side, above
normals = np.array([f.normal[:] for f in me.polygons])
if os.environ.get("LANDMARK_DEBUG"):
    np.savez(os.environ["LANDMARK_DEBUG"], px=px, hole=hole, face=face, where=where, roofs=roofs, normals=normals)
# The walls' gaps repeat the same wall from above them. What is to be painted over on
# the roofs takes the colour of its own faces round it, smoothly: a roof's seams
# copied along the slope showed as stripes.
seen = ~hole & (face >= 0)
copied = fill.copy_along(px, hole & (face >= 0) & ~roofs, seen, face, where, normals)
paint = fill.dark_spots(px, face, where, roofs & seen, spots) if spots else np.zeros_like(hole)
if paint.any():
    around = seen & ~paint & np.isin(face, np.unique(face[paint]))
    px[paint, :3] = fill.push_pull(px[..., :3], around)[paint]
print(f"{int(copied.sum())} texels of walls copied from above them, {int(paint.sum())} of roofs painted over")
hole &= ~copied
# Where each texel's colour came from, for sources.glb (see the top), later cases winning.
sources = np.ones_like(px)
for mask, colour in ((~hole, (0.2, 0.8, 0.2)), (~hole & use_far, (0.1, 0.3, 0.9)), (from_above & ~roofs, (1, 0.6, 0)),
                     (from_above & roofs, (0.8, 0.1, 0.1)), (copied | paint, (1, 0.9, 0.3)), (hole, (1, 1, 1))):
    sources[mask, :3] = colour

# Fill the rest from around it, which also bleeds the islands' edges outwards for the
# texture's mipmaps.
px[..., :3] = np.where(hole[..., None], fill.push_pull(px[..., :3], ~hole), px[..., :3])
px[..., 3] = 1
img = bpy.data.images.new("landmark", size, size)
img.pixels.foreach_set(px.ravel())
img.pack()
tex.image = img

bpy.data.objects.remove(high)
select(low)
export = dict(use_selection=True, export_format="GLB", export_image_format="JPEG", export_jpeg_quality=88,
              export_normals=False, export_materials="EXPORT")
bpy.ops.export_scene.gltf(filepath=out_path, **export)
if sources_path:
    img.pixels.foreach_set(sources.ravel())
    img.pack()
    bpy.ops.export_scene.gltf(filepath=sources_path, **export)
