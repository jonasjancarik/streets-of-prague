"""Surface patches for the street sedan. Blender coordinates are X forward, Y left, Z up."""

import math

import bpy
from mathutils import Vector

# Finish names shared with the game's vehicle material, plus colours for this model.
FINISHES = {
    "Paint": "#ffffff",
    "Window": "#263844",
    "LensCover": "#b8c9cb",
    "Lamp": "#ffefd0",
    "Tail": "#ed333c",
    "Plate": "#e3e5e0",
    "Rubber": "#212327",
    "Frit": "#171c20",
    "Graphite": "#353b40",
    "Intake": "#141719",
    "Nickel": "#989d9f",
    "Polished": "#c3cbcc",
    "Smoked": "#424a50",
    "Reflector": "#afbcc3",
    "RearWindow": "#1c2c35",
    "Cloth": "#525b60",
    "GaugeFace": "#f4f0e3",
    "DisplayFace": "#f1efeb",
    "Buckle": "#a54137",
    "BeltWebbing": "#292a2b",
    "SatinBlack": "#22262b",
    "SpeakerMesh": "#23282d",
    "DoorInsert": "#4d5256",
    "Ruby": "#8a1723",
    "LensRed": "#b12630",
    "AmberCell": "#c48643",
    "Carpet": "#37393a",
    "Upholstery": "#414549",
    "SoftTouch": "#303539",
    "Stitch": "#858882",
    "MirrorGlass": "#738b95",
    "EUBlue": "#24528a",
    "BrakeSteel": "#777977",
}


def material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    c = [int(FINISHES[name][i : i + 2], 16) / 255 for i in (1, 3, 5)]
    rgb = tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = (
        0.25 if name in ("Paint", "Window", "LensCover", "Polished") else 0.65
    )
    return m


def lerp(a, b, t):
    return a + (b - a) * t


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def curve(keys, x):
    """Cubic Hermite interpolation on unevenly spaced design stations."""
    if x <= keys[0][0]:
        return keys[0][1]
    if x >= keys[-1][0]:
        return keys[-1][1]
    for i in range(len(keys) - 1):
        a, b = keys[i : i + 2]
        if x <= b[0]:
            p, q = keys[max(0, i - 1)], keys[min(len(keys) - 1, i + 2)]
            dx = b[0] - a[0]
            t = (x - a[0]) / dx
            m = (b[1] - p[1]) / (b[0] - p[0]) * dx
            n = (q[1] - a[1]) / (q[0] - a[0]) * dx
            return lerp(a[1], b[1], smooth(t)) + t * (1 - t) * ((1 - t) * m - t * n)


class PatchMesh:
    def __init__(self):
        self.points = []
        self.faces = []
        self.finishes = []
        self.surface_normals = {}

    def patch(self, mat, cols, rows, at, out, shading_normal=None):
        start = len(self.points)
        for j in range(rows + 1):
            for i in range(cols + 1):
                p = Vector(at(i / cols, j / rows))
                if shading_normal:
                    self.surface_normals[len(self.points)] = shading_normal(p)
                self.points.append(p)
        for j in range(rows):
            for i in range(cols):
                a = start + j * (cols + 1) + i
                b = a + 1
                d = a + cols + 1
                c = d + 1
                normal = (self.points[c] - self.points[a]).cross(self.points[d] - self.points[b])
                target = out((i + 0.5) / cols, (j + 0.5) / rows) if callable(out) else out
                self.faces.append((a, b, c, d) if normal.dot(Vector(target)) >= 0 else (d, c, b, a))
                self.finishes.append(mat)

    def tube(self, mat, points, radius, sides=8):
        pts = [Vector(p) for p in points]

        # A flat grille blade or a straight seam needs its ends, not all the
        # samples used to find it on the body. Keep every perceptible bend.
        def simplify(path):
            if len(path) < 3:
                return path
            chord = path[-1] - path[0]
            length = chord.length_squared

            def distance2(p):
                t = max(0, min(1, (p - path[0]).dot(chord) / length)) if length else 0
                return (p - path[0] - t * chord).length_squared

            j = max(range(1, len(path) - 1), key=lambda i: distance2(path[i]))
            if distance2(path[j]) < max(0.00032, min(0.001, radius * 0.21)) ** 2:
                return [path[0], path[-1]]
            return simplify(path[: j + 1])[:-1] + simplify(path[j:])

        pts = simplify(pts)
        if radius < 0.007:
            sides = min(sides, 5)
        tangents = [
            (pts[min(i + 1, len(pts) - 1)] - pts[max(0, i - 1)]).normalized() for i in range(len(pts))
        ]
        seed = min(
            (Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))), key=lambda a: abs(a.dot(tangents[0]))
        )
        axes = []
        for t in tangents:
            n = (seed - t * t.dot(seed)).normalized()
            axes.append((n, t.cross(n)))
            seed = n
        start = len(self.points)
        for p, (a, b) in zip(pts, axes):
            for k in range(sides):
                ang = math.tau * k / sides
                self.points.append(p + radius * (a * math.cos(ang) + b * math.sin(ang)))
        for i in range(len(pts) - 1):
            for k in range(sides):
                a = start + i * sides + k
                b = start + i * sides + (k + 1) % sides
                self.faces.append((a, b, b + sides, a + sides))
                self.finishes.append(mat)

    def ellipsoid(self, mat, center, scale, cols=20, rows=10):
        def direction(u, v):
            a, b = math.tau * u, math.pi * (v - 0.5)
            return (math.cos(b) * math.cos(a), math.cos(b) * math.sin(a), math.sin(b))

        self.patch(
            mat,
            cols,
            rows,
            lambda u, v: tuple(p + d * r for p, r, d in zip(center, scale, direction(u, v))),
            direction,
        )

    def box(self, mat, center, size):
        for axis in range(3):
            a, b = (axis + 1) % 3, (axis + 2) % 3
            for s in (-1, 1):

                def point(u, v):
                    p = list(center)
                    p[axis] += s * size[axis] / 2
                    p[a] += (u - 0.5) * size[a]
                    p[b] += (v - 0.5) * size[b]
                    return p

                normal = [0, 0, 0]
                normal[axis] = s
                self.patch(mat, 1, 1, point, normal)

    def build(self, name, pivot=(0, 0, 0)):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([v - Vector(pivot) for v in self.points], [], self.faces)
        slots = list(dict.fromkeys(self.finishes))
        for m in slots:
            mesh.materials.append(material(m))
        ids = {m: i for i, m in enumerate(slots)}
        for polygon, finish in zip(mesh.polygons, self.finishes):
            polygon.material_index = ids[finish]
            polygon.use_smooth = True
        mesh.update()
        # Patches carry their own parameterisation. Match shading normals along
        # a continuous stamping but keep rolled edges, recesses and jambs hard.
        normals = [v.normal.copy() for v in mesh.vertices]
        by_position = {}
        for v in mesh.vertices:
            key = tuple(round(p, 6) for p in v.co)
            by_position.setdefault(key, []).append(v.index)
        continuous = [n.copy() for n in normals]
        for group in by_position.values():
            if len(group) < 2:
                continue
            for i in group:
                n = normals[i]
                contributors = [normals[j] for j in group if normals[j].dot(n) > 0.84]
                if contributors:
                    continuous[i] = sum(contributors, Vector()).normalized()
        for i, n in self.surface_normals.items():
            continuous[i] = n
        mesh.normals_split_custom_set_from_vertices(continuous)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = pivot
        return obj


def strip(mesh, mat, a, b, normal, steps=20):
    mesh.patch(mat, steps, 1, lambda u, v: Vector(a(u)).lerp(Vector(b(u)), v), normal)


def bake_occlusion(objects):
    """Short-range diffuse occlusion in the vertex colour: no texture fetch on the body."""
    from mathutils.bvhtree import BVHTree

    points = []
    faces = []
    clear = {"Window", "RearWindow", "LensCover", "Lamp", "Tail"}
    for obj in objects:
        start = len(points)
        points.extend(obj.matrix_world @ v.co for v in obj.data.vertices)
        for face in obj.data.polygons:
            if obj.material_slots[face.material_index].name not in clear:
                faces.append(tuple(start + i for i in face.vertices))
    tree = BVHTree.FromPolygons(points, faces)
    rays = []
    for i in range(20):
        r = math.sqrt((i + 0.5) / 20)
        a = i * 2.39996323
        rays.append((r * math.cos(a), r * math.sin(a), math.sqrt(1 - r * r)))
    for obj in objects:
        mesh = obj.data
        # The game needs one neutral factor, not four exported colour channels.
        cavity = mesh.attributes.new(name="_CAVITY", type="FLOAT", domain="POINT")
        for v in mesh.vertices:
            n = v.normal.normalized()
            p = obj.matrix_world @ v.co + n * 0.0018
            a = n.cross(Vector((0, 0, 1)) if abs(n.z) < 0.88 else Vector((1, 0, 0))).normalized()
            b = n.cross(a)
            blocked = 0.0
            for x, y, z in rays:
                hit = tree.ray_cast(p, a * x + b * y + n * z, 0.23)
                if hit[0] is not None:
                    blocked += (1 - hit[3] / 0.23) ** 1.4
            ao = 1 - 0.60 * blocked / len(rays)
            cavity.data[v.index].value = round(ao * 128) / 128
