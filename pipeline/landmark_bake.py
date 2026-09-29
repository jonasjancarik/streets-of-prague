"""Run by Blender in the background (landmarks.py starts it): bakes the colours of a
landmark's piece of IPR's photorealistic mesh onto its clean model from IPR's city
model (LOD3), and writes that as a GLB.

    blender -b --factory-startup -P landmark_bake.py -- low.obj high.glb out.glb [cm_per_px] [sources.glb]

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
from above instead. Anything still missing is filled in from around it.

`sources.glb`, if given, is the same model with each texel coloured by where its colour
came from, for checking a landmark: red from above on a roof, orange from above on a
wall (under something), green straight in, blue straight in from further off, white
filled in (no ray found the mesh).
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
low_path, high_path, out_path = map(os.path.abspath, args[:3])
CM = float(args[3]) if len(args) > 3 else 5.0
sources_path = os.path.abspath(args[4]) if len(args) > 4 else None

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


# For the bakes of which way the mesh faces where a ray met it: its normal's height,
# from 0.1 (straight down) to 1 (straight up), so that black still means a miss.
facing = bpy.data.materials.new("facing")
facing.use_nodes = True
fn = facing.node_tree
for n in list(fn.nodes):
    fn.nodes.remove(n)
geo, sep = fn.nodes.new("ShaderNodeNewGeometry"), fn.nodes.new("ShaderNodeSeparateXYZ")
mp, emit, out = fn.nodes.new("ShaderNodeMapRange"), fn.nodes.new("ShaderNodeEmission"), fn.nodes.new("ShaderNodeOutputMaterial")
mp.inputs["From Min"].default_value, mp.inputs["To Min"].default_value = -1.0, 0.1
fn.links.new(geo.outputs["True Normal"], sep.inputs[0])
fn.links.new(sep.outputs["Z"], mp.inputs["Value"])
fn.links.new(mp.outputs["Result"], emit.inputs["Color"])
fn.links.new(emit.outputs["Emission"], out.inputs["Surface"])


def bake_into(name, extrusion, reach, normals=False):
    """The mesh's base colour (or with `normals`, which way it faces, see `facing`) by
    rays from `extrusion` m outside the clean surface inwards, at most `reach` m long;
    black where none found it."""
    im = bpy.data.images.new(name, size, size, float_buffer=normals)
    tex.image = im
    bake.cage_extrusion = extrusion
    bake.max_ray_distance = reach
    select(high, low, active=low)
    own = [s.material for s in high.material_slots]
    if normals:
        for s in high.material_slots:
            s.material = facing
    bpy.ops.object.bake(type="EMIT" if normals else "DIFFUSE")
    for s, m in zip(high.material_slots, own):
        s.material = m
    px = np.empty(size * size * 4, np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(size, size, 4)


def roof_mask():
    """The texels of the roofs' UV islands."""
    mask = np.zeros((size, size), bool)
    uv = me.uv_layers.active.data
    ys, xs = np.mgrid[0:size, 0:size]
    for f in me.polygons:
        if f.normal.z <= ROOF:
            continue
        pts = [np.array(uv[i].uv) * size for i in f.loop_indices]
        for a, b, c in ((pts[0], pts[k], pts[k + 1]) for k in range(1, len(pts) - 1)):
            x0, y0 = np.floor(np.minimum(np.minimum(a, b), c)).astype(int).clip(0, size - 1)
            x1, y1 = np.ceil(np.maximum(np.maximum(a, b), c)).astype(int).clip(0, size - 1)
            px_, py_ = xs[y0:y1 + 1, x0:x1 + 1] + 0.5, ys[y0:y1 + 1, x0:x1 + 1] + 0.5
            e = [(q[0] - p[0]) * (py_ - p[1]) - (q[1] - p[1]) * (px_ - p[0]) for p, q in ((a, b), (b, c), (c, a))]
            inside = ((e[0] >= 0) & (e[1] >= 0) & (e[2] >= 0)) | ((e[0] <= 0) & (e[1] <= 0) & (e[2] <= 0))
            mask[y0:y1 + 1, x0:x1 + 1] |= inside
    return mask


def bake_from_above(name, rise=30.0):
    """Colours by rays straight down from `rise` m above, through a cage: the clean
    model lifted. On a wall, a ray runs down its face, meeting whatever is over it."""
    cage = low.copy()
    cage.data = low.data.copy()
    bpy.context.collection.objects.link(cage)
    for v in cage.data.vertices:
        v.co.z += rise
    bake.use_cage = True
    bake.cage_object = cage
    try:
        return bake_into(name, 0.0, rise + 20.0)
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
up = np.where(use_far, bake_into("far_n", 3.0, 8.0, True)[..., 0], bake_into("near_n", 1.5, 3.5, True)[..., 0])
under = ~missed(side) & (up > 0.1) & (up < 0.4)
above = bake_from_above("above")
roofs = roof_mask()
from_above = (roofs | under) & ~missed(above)
px = np.where(from_above[..., None], above, side)
hole = missed(px)
# Where each texel's colour came from, for sources.glb (see the top), later cases winning.
sources = np.ones_like(px)
for mask, colour in ((~hole, (0.2, 0.8, 0.2)), (~hole & use_far, (0.1, 0.3, 0.9)), (from_above & ~roofs, (1, 0.6, 0)),
                     (from_above & roofs, (0.8, 0.1, 0.1)), (hole, (1, 1, 1))):
    sources[mask, :3] = colour

# Fill the rest from around it (push-pull: average down, then back up), which also
# bleeds the islands' edges outwards for the texture's mipmaps.
levels = [(px[..., :3] * ~hole[..., None], (~hole).astype(np.float32))]
while levels[-1][1].shape[0] > 1:
    r, w = levels[-1]
    n = r.shape[0] // 2
    levels.append((r.reshape(n, 2, n, 2, 3).sum((1, 3)), w.reshape(n, 2, n, 2).sum((1, 3))))
fill = levels[-1][0] / np.maximum(levels[-1][1], 1e-6)[..., None]
for r, w in reversed(levels[:-1]):
    fill = np.repeat(np.repeat(fill, 2, 0), 2, 1)
    fill = np.where((w > 0)[..., None], r / np.maximum(w, 1e-6)[..., None], fill)
px[..., :3] = np.where(hole[..., None], fill, px[..., :3])
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
