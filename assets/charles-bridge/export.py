"""Export the packed, editable Charles Bridge sources.

blender -b assets/charles-bridge/nepomuk.blend -P assets/charles-bridge/export.py
blender -b assets/charles-bridge/arches.blend -P assets/charles-bridge/export.py
"""
from pathlib import Path

import bpy

source = Path(bpy.data.filepath).resolve()
ASSETS = {"nepomuk.blend": "street-nepomuk.glb", "arches.blend": "charles-arches.glb"}
if source.name not in ASSETS:
    raise ValueError("Open one of the two Charles Bridge source files before exporting")
objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
if not objects or len({mat for obj in objects for mat in obj.data.materials}) != 1:
    raise ValueError("The monument must use its shared metal and stone atlas")

bpy.ops.object.select_all(action="DESELECT")
for obj in objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = objects[0]
if source.name == "nepomuk.blend":
    bpy.ops.object.join()
target = source.parents[2] / "public" / ASSETS[source.name]
result = bpy.ops.export_scene.gltf(
    filepath=str(target), export_format="GLB", use_selection=True,
    export_yup=True, export_cameras=False, export_lights=False,
    export_animations=False, export_image_format="AUTO", export_normals=True,
    export_vertex_color="ACTIVE",
)
if result != {"FINISHED"}:
    raise RuntimeError("The monument could not be exported")
