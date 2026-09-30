"""One sheet to check a landmark by: its piece of the mesh as cut, the baked model the
game draws and that model coloured by where each texel came from (columns), each from
straight above, from the north-east and the south-west as the game's camera sees it,
and from the side (rows). Flat, unlit texture colours.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \\
        -P .claude/skills/landmarks/views.py -- praha manes /tmp/manes.png

Run `pipeline/landmarks.py <area> <name>` first; it keeps the files this reads in
pipeline/.cache/landmarks/<area>/.
"""

import math
import os
import sys
import tempfile
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

area, name, out = sys.argv[sys.argv.index("--") + 1:][:3]
root = Path(__file__).resolve().parents[3]
keep = root / "pipeline" / ".cache" / "landmarks" / area
models = [keep / f"{name}.mesh.glb", root / "public" / "data" / f"{area}_now" / "landmarks" / f"{name}.glb",
          keep / f"{name}.sources.glb"]
VIEWS = [(0, 0), (35, 45), (35, 225), (72, 160)]  # (tilt from straight down, azimuth from north)
SIZE = 480


def render(model: Path, tilt: float, az: float, path: str, one_sided: bool):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(model))
    pts = [o.matrix_world @ Vector(c) for o in bpy.context.scene.objects if o.type == "MESH" for c in o.bound_box]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    centre, extent = (lo + hi) / 2, (hi - lo).length
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "FLAT"
    sc.display.shading.color_type = "TEXTURE"
    sc.display.shading.show_backface_culling = one_sided  # as the game draws a baked model
    sc.render.resolution_x = sc.render.resolution_y = SIZE
    sc.world = bpy.data.worlds.new("w")
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    cam.data.lens = 50
    th, ph, d = math.radians(tilt), math.radians(az), extent * 1.25
    cam.location = centre + Vector((d * math.sin(th) * math.sin(ph), d * math.sin(th) * math.cos(ph), d * math.cos(th)))
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


sheet = np.ones((len(VIEWS) * (SIZE + 8), len(models) * (SIZE + 8), 4), np.float32)
with tempfile.TemporaryDirectory() as tmp:
    for c, model in enumerate(models):
        if not model.exists():
            print(f"missing: {model}")
            continue
        for r, (tilt, az) in enumerate(VIEWS):
            path = os.path.join(tmp, f"{c}_{r}.png")
            render(model, tilt, az, path, one_sided=c > 0)
            im = bpy.data.images.load(path)
            px = np.empty(SIZE * SIZE * 4, np.float32)
            im.pixels.foreach_get(px)
            # Blender's rows run bottom up, as the sheet's do.
            y = (len(VIEWS) - 1 - r) * (SIZE + 8)
            sheet[y:y + SIZE, c * (SIZE + 8):c * (SIZE + 8) + SIZE] = px.reshape(SIZE, SIZE, 4)
    img = bpy.data.images.new("sheet", sheet.shape[1], sheet.shape[0])
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = os.path.abspath(out)
    img.file_format = "PNG"
    img.save()
print(f"wrote {out}: columns mesh as cut, baked, sources; rows above, north-east, south-west, side")
