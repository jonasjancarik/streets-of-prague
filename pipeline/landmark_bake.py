"""Run by Blender in the background (landmarks.py starts it): bakes the colours of a
landmark's piece of IPR's photorealistic mesh onto its clean model from IPR's city
model (LOD3), and writes that as a GLB.

    blender -b --factory-startup -P landmark_bake.py -- low.obj high.glb out.glb [cm_per_px]

Both inputs are in the game's coordinates (y up), as is the result. The clean model is
welded, its coplanar triangles merged into faces and its undersides dropped; it gets
UVs and one texture of about `cm_per_px` (default 5) cm per pixel. Each texel's colour
comes from a ray cast inwards from a little outside the clean surface; where the two
models are further apart than that, from a second, longer ray, and anything still
missing is filled in from around it.
"""
import math
import os
import sys

import bmesh
import bpy
import numpy as np

args = sys.argv[sys.argv.index("--") + 1:]
low_path, high_path, out_path = map(os.path.abspath, args[:3])
CM = float(args[3]) if len(args) > 3 else 5.0

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

me = low.data
bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.02)
bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=bm.verts, edges=bm.edges)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
# Undersides (floors over the ground or the water) are never seen from above.
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z < -0.7], context="FACES")
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


def bake_into(name, extrusion, reach):
    """The mesh's base colour by rays from `extrusion` m outside the clean surface
    inwards, at most `reach` m long; black where none found it."""
    im = bpy.data.images.new(name, size, size)
    tex.image = im
    bake.cage_extrusion = extrusion
    bake.max_ray_distance = reach
    select(high, low, active=low)
    bpy.ops.object.bake(type="DIFFUSE")
    px = np.empty(size * size * 4, np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(size, size, 4)


def missed(px):
    """What the bake left black: no ray found the mesh, or outside the UV islands (a
    photograph is next to never pure black)."""
    return px[..., :3].max(-1) < 1e-4


near = bake_into("near", 0.8, 2.0)  # where the two models agree
far = bake_into("far", 3.0, 8.0)    # parts the clean model has a little off
px = np.where(missed(near)[..., None], far, near)
hole = missed(px)

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
bpy.ops.export_scene.gltf(filepath=out_path, use_selection=True, export_format="GLB", export_image_format="JPEG",
                          export_jpeg_quality=88, export_normals=False, export_materials="EXPORT")
