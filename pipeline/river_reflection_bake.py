"""Render water-level colour and distance panoramas from the prepared riverbank mesh.

Called by river_reflections.py with Blender in a separate, empty process.
"""
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from survey_render import survey_scene, survey_pass


def render(folder):
    scene = survey_scene(folder / "banks.glb")

    camera = bpy.data.objects.new("Water-level panorama", bpy.data.cameras.new("Panorama"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = "PANO"
    camera.data.panorama_type = "EQUIRECTANGULAR"
    camera.data.latitude_min = math.radians(-3)
    camera.data.latitude_max = math.radians(33)
    camera.data.longitude_min, camera.data.longitude_max = -math.pi, math.pi
    camera.data.clip_start, camera.data.clip_end = .3, 340
    camera.rotation_euler = Vector((0, 1, 0)).to_track_quat("-Z", "Y").to_euler()
    stations = json.loads((folder / "stations.json").read_text(encoding="utf-8"))

    for depth in (False, True):
        survey_pass(scene, "View Distance" if depth else None, 510)
        scene.render.resolution_x, scene.render.resolution_y = (384, 56) if depth else (640, 92)
        scene.cycles.samples = 1 if depth else 2
        name = "depth" if depth else "colour"
        for i, station in enumerate(stations):
            camera.location = station["p"]
            scene.render.filepath = str(folder / f"{name}-{i:02}.png")
            bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    render(Path(sys.argv[sys.argv.index("--") + 1]).resolve())
