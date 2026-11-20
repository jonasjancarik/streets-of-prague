"""Bake shipped Rocketbox drivers as static, vertex-coloured meshes for car-drivers.glb."""
import array
import json
from pathlib import Path
import subprocess
import tempfile

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def build_driver(donor, name, public, uniform=None):
    with tempfile.TemporaryDirectory(prefix="sop-seated-driver-") as tmp:
        work = Path(tmp)
        subprocess.run(["node", str(Path(__file__).with_name("pose_driver.mjs")),
                        str(public / "rocketbox" / (donor + ".glb")),
                        str(public / "rocketbox/actions.bin"), str(work)] + ([str(public / "rocketbox" / uniform)] if uniform else []), check=True)
        vertices, triangles, colours = [], [], []
        for part in json.loads((work / "driver.json").read_text()):
            mat = part["name"]
            fmt = ["-format_only", "1"] if mat.endswith("_opacity") else ["-etc1_only"]
            subprocess.run(["basisu", "-unpack", "-no_ktx", *fmt, "-file", mat + ".ktx2"],
                           cwd=work, check=True, stdout=subprocess.DEVNULL)
            def pixels(pattern, linear=False):
                matches = list(work.glob(mat + pattern))
                if not matches:
                    return None
                image = bpy.data.images.load(str(matches[0]))
                if linear:
                    image.colorspace_settings.name = 'Non-Color'
                width, height = image.size
                data = array.array("f", [0]) * (width * height * 4)
                image.pixels.foreach_get(data)
                bpy.data.images.remove(image)
                return width, height, data
            colour = pixels("*_rgb_*_level_0_*.png")
            alpha = pixels("*_a_*_level_0_*.png", True) if mat.endswith("_opacity") else None
            def sample(texture, uv):
                width, height, data = texture
                x = round((uv[0] % 1) * (width-1))
                y = round((1 - uv[1] % 1) * (height-1))
                offset = (y * width + x) * 4
                return tuple(data[offset:offset+3])
            pts = part["positions"]
            uv = part["uv"]
            base = len(vertices)
            texcoords = []
            def vertex(p, coord):
                # three.js x-forward/y-up/z-right to Blender x-forward/z-up/y-left.
                vertices.append((p[0], -p[2], p[1] if p[1] > -.23 else -.23+(p[1]+.23)*.40))
                colours.append((*sample(colour, coord), 1.0))
                texcoords.append(coord)
            for p, coord in zip(pts, uv):
                vertex(p, coord)
            edges = {}
            def mid(i, j):
                edge = (min(i,j),max(i,j))
                if edge not in edges:
                    edges[edge] = len(vertices)
                    vertex([(a+b)*.5 for a,b in zip(pts[i],pts[j])],
                           [(a+b)*.5 for a,b in zip(uv[i],uv[j])])
                return edges[edge]
            indices = part["indices"]
            for k in range(0,len(indices),3):
                i,j,l = indices[k:k+3]
                face_x = (pts[i][0] + pts[j][0] + pts[l][0]) / 3
                if alpha or (mat.endswith("_head") and face_x > .025):
                    # Preserve the face markings and cutout hair silhouette
                    # without taking either original texture into the renderer.
                    a,b,c = mid(i,j),mid(j,l),mid(l,i)
                    faces = ((base+i,a,c),(base+j,b,a),(base+l,c,b),(a,b,c))
                else:
                    faces = [(base+i,base+j,base+l)]
                for face in faces:
                    if alpha:
                        centre = [sum(texcoords[v-base][n] for v in face)/3 for n in range(2)]
                        if sample(alpha,centre)[0] < .5:
                            continue
                    triangles.append(face)
    # Fit the webbing to the posed jacket. Restrict the projection to the
    # torso so the hands out on the wheel do not lift the belt off the chest.
    torso = [f for f in triangles if all(vertices[v][0] < .25 for v in f)]
    tree = BVHTree.FromPolygons(vertices,torso,all_triangles=True)
    start = len(vertices)
    for i in range(13):
        t=i/12
        for across in (-.020,.020):
            y=.155-.282*t+across
            z=.49-.50*t+across*.54
            hit=tree.ray_cast(Vector((.27,y,z)),Vector((-1,0,0)),.55)[0]
            x=(hit.x if hit is not None else .065) + .009
            vertices.append((x,y,z))
            colours.append((.028,.031,.032,1.0))
        if i:
            a = start+2*i
            triangles.extend(((a-2,a,a+1),(a-2,a+1,a-1)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], triangles)
    mesh.update()
    color = mesh.color_attributes.new(name="Albedo",type="FLOAT_COLOR",domain="POINT")
    color.data.foreach_set("color", [v for col in colours for v in col])
    mesh.color_attributes.active_color = color
    for f in mesh.polygons:
        f.use_smooth = True
    obj = bpy.data.objects.new(name,mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj
