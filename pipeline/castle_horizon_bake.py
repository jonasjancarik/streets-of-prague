"""Photograph the ridge and record the depth used for parallax in each view."""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from survey_render import survey_scene, survey_pass

# Clockwise from geographic north. The south-east view is from Charles Bridge.
VIEWS = [(0,1500,78), (45,1370,56), (90,1130,27), (123.6,833,19.5),
         (165,1360,24), (215,1350,66), (265,1300,89), (315,1420,91)]


def bake(cache):
    scene = survey_scene(cache / "palace.glb")
    scene.cycles.samples = 1
    camera = bpy.data.objects.new("City viewpoint", bpy.data.cameras.new("Camera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.clip_start, camera.data.clip_end = .1, 7500
    camera.data.lens, camera.data.sensor_width = 33, 36
    w, h = 1536, 552
    scene.render.resolution_x, scene.render.resolution_y = w, h
    graph = bpy.context.evaluated_depsgraph_get()
    views = []
    for depth in (False, True):
        survey_pass(scene, "View Z Depth" if depth else None, 4096, 16 if depth else 8)
        for i, (angle, radius, height) in enumerate(VIEWS):
            az = math.radians(angle)
            eye = Vector((radius*math.sin(az), radius*math.cos(az), height))
            aim = Vector((0, 0, 71))
            camera.location = eye
            camera.rotation_euler = (aim-eye).to_track_quat("-Z", "Y").to_euler()
            bpy.context.view_layer.update()
            name = "depth" if depth else "colour"
            scene.render.filepath = str(cache / f"{name}-{i}.png")
            bpy.ops.render.render(write_still=True)
            if not depth:
                projection = camera.calc_matrix_camera(graph, x=w, y=h) @ camera.matrix_world.inverted()
                views.append({"az": angle, "eye": list(eye), "aim": list(aim), "matrix": [list(row) for row in projection]})
    (cache / "views.json").write_text(json.dumps(views))


if __name__ == "__main__":
    bake(Path(sys.argv[sys.argv.index("--")+1]).resolve())
