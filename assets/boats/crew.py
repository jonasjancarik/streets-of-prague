"""Bake the cruise boat's skipper and saloon passengers from the seated Rocketbox poses.

    blender -b --factory-startup -P assets/boats/crew.py
"""
from pathlib import Path

import bmesh
import bpy

ROOT = Path(__file__).resolve().parents[2]


def simplify(obj, triangles):
    mesh = obj.data
    # The source car poses include a separate diagonal seatbelt strip. The
    # interior of a saloon boat has ordinary chairs and a helm bench.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    colours = bm.verts.layers.float_color.active or bm.verts.layers.color.active
    if colours is not None:
        # Delete complete triangles of the uniform-colour strip so a similarly
        # coloured vertex in a photographed shirt does not punch a hole in it.
        belt = [f for f in bm.faces if all(sum(abs(v[colours][i]-c) for i,c in enumerate((.028,.031,.032))) < .003
                                            for v in f.verts)]
        bmesh.ops.delete(bm, geom=belt, context="FACES")
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=.00004)
    bm.to_mesh(mesh)
    bm.free()
    modifier = obj.modifiers.new("Seated silhouette", "DECIMATE")
    modifier.ratio = min(1, triangles / len(mesh.polygons))
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / "public/car-drivers.glb"))
    seated = [bpy.data.objects[f"seated_driver_{i}"] for i in range(2)]
    for person in seated:
        simplify(person, 525)
    # In boat coordinates, +X is forward, Y is height and +Z is starboard.
    # The passengers' hands rest at the tables, the skipper's at the wheel.
    places = [(0,10.60,1.974,-.25,0), (1,-9.28,2.105,1.83,-.12),
              (0,-6.80,2.105,-1.83,.14), (1,.72,2.105,-1.83,-.06),
              (0,3.19,2.105,1.83,.08)]
    bpy.ops.object.select_all(action="DESELECT")
    people=[]
    for donor,x,y,z,turn in places:
        source=seated[donor]
        person=bpy.data.objects.new("Seated", source.data.copy())
        bpy.context.collection.objects.link(person)
        person.location=(x,-z,y)
        person.rotation_euler.z=turn
        people.append(person)
        person.select_set(True)
    bpy.context.view_layer.objects.active=people[0]
    bpy.ops.object.join()
    crew=people[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    crew.name="Cruiser occupants"
    # One vertex-colour material for the whole cabin, shared by every cruiser.
    crew.data.materials.clear()
    for face in crew.data.polygons:
        face.material_index=0
    crew.data.validate()
    bpy.ops.export_scene.gltf(filepath=str(ROOT / "public/cruiser-occupants.glb"),
                              use_selection=True, export_format="GLB", export_materials="NONE",
                              export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True,
                              export_meshopt_compression_enable=True, export_meshopt_extension="EXT_meshopt_compression",
                              export_animations=False, export_texcoords=False)
    print("Cabin triangles:",len(crew.data.polygons))


if __name__ == "__main__":
    build()
