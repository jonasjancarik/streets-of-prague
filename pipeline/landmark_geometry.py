"""Shared indexed geometry and single-atlas GLB export for custom landmarks (east, north, up)."""

import io
import math

import numpy as np

from landmark_colours import pack_glb

FULL = [(0, 1), (1, 1), (1, 0), (0, 0)]


def at(p, z):
    return np.array([*p, z])


def unit(vec):
    return vec / np.linalg.norm(vec)


def edges(ring):
    return zip(ring, np.roll(ring, -1, axis=0))


def inset(ring, metres):
    # Intersect parallel offset lines. Keeps the masonry bands a constant width
    # on the oblique rear wing as well as on the front.
    d = np.roll(ring, -1, axis=0) - ring
    n = np.column_stack((-d[:, 1], d[:, 0])) / np.linalg.norm(d, axis=1)[:, None]
    return np.array([p + np.linalg.solve(n[[i - 1, i]], [metres, metres]) for i, p in enumerate(ring)])


class Building:
    def __init__(self, atlas):
        self.atlas = atlas
        self.vertices, self.indices, self.known = [], [], {}

    def face(self, points, material, uv=None, normals=None):
        points = np.array(points, dtype=float)
        normal = np.cross(points[1] - points[0], points[2] - points[0])
        length = np.linalg.norm(normal)
        if length < 1e-7:
            return
        normal /= length
        corners = []
        if uv is None:
            uv = FULL if len(points) == 4 else [(0.5, 0.5)] * len(points)
        if self.atlas.tiles[material][2] <= 12:
            uv = [(0.5, 0.5)] * len(points)
        for i, (p, t) in enumerate(zip(points, uv)):
            n = normal if normals is None else normals[i]
            # glTF is Y-up and looks south along +Z.
            vertex = tuple(
                round(float(v), 5)
                for v in (p[0], p[2], -p[1], n[0], n[2], -n[1], *self.atlas.uv(material, t))
            )
            idx = self.known.get(vertex)
            if idx is None:
                idx = len(self.vertices)
                self.known[vertex] = idx
                self.vertices.append(vertex)
            corners.append(idx)
        for i in range(1, len(corners) - 1):
            self.indices.extend((corners[0], corners[i], corners[i + 1]))

    def wall(self, a, b, z, h, mat):
        self.face([at(a, z), at(b, z), at(b, h), at(a, h)], mat)

    def course(self, ring, lower, upper, mat, cap=True):
        zb, db = lower
        zt, dt = upper
        lo, hi = inset(ring, -db), inset(ring, -dt)
        for i, j in zip(range(len(lo)), np.roll(np.arange(len(lo)), -1)):
            self.face([at(lo[i], zb), at(lo[j], zb), at(hi[j], zt), at(hi[i], zt)], mat)
        if cap:
            self.face([at(p, zt) for p in hi], mat)

    def moulding(self, ring, z, depth=0.27):
        for lo, hi, mat in [
            ((z, 0), (z + 0.11, depth * 0.6), "shadow"),
            ((z + 0.11, depth * 0.6), (z + 0.31, depth), "trim"),
            ((z + 0.31, depth), (z + 0.48, depth), "stone"),
        ]:
            self.course(ring, lo, hi, mat, cap=False)
        self.course(ring, (z + 0.48, depth), (z + 0.48, -0.02), "trim", cap=False)

    def box(self, x0, y0, x1, y1, z0, z1, mat):
        ring = np.array([(x0, y1), (x0, y0), (x1, y0), (x1, y1)])
        self.course(ring, (z0, 0), (z1, 0), mat)

    def turned(self, centre, profile, material, sides=10):
        circle = np.array(
            [(math.cos(i * math.tau / sides), math.sin(i * math.tau / sides)) for i in range(sides)]
        )
        for (z, r), (h, s) in zip(profile, profile[1:]):
            for i in range(sides):
                j = (i + 1) % sides
                self.face(
                    [
                        at(centre + circle[i] * r, z),
                        at(centre + circle[j] * r, z),
                        at(centre + circle[j] * s, h),
                        at(centre + circle[i] * s, h),
                    ],
                    material,
                )
        z, r = profile[-1]
        if r > 0:
            self.face([at(centre + c * r, z) for c in circle], material)

    def save(self, out, name, copyright, extent=104):
        vertices = np.array(self.vertices, dtype="<f4")
        assert np.abs(vertices[:, :3]).max() < extent
        indices = np.array(self.indices, dtype="<u2")
        assert len(vertices) < 65536 and int(indices.max()) == len(vertices) - 1
        raw = bytearray()
        views = []

        def view(data, target=None):
            raw.extend(b"\0" * (-len(raw) % 4))
            views.append(dict(buffer=0, byteOffset=len(raw), byteLength=len(data)))
            if target:
                views[-1]["target"] = target
            raw.extend(data)
            return len(views) - 1

        access = []
        # Millimetre-scale resolution is enough even for the gilding. Keep the
        # normal and UV streams compact and every VEC3 aligned to four bytes.
        for arr, typ, component in [
            (np.rint(vertices[:, :3] * 32767 / extent).astype("<i2"), "VEC3", 5122),
            (np.rint(vertices[:, 3:6] * 127).astype("i1"), "VEC3", 5120),
            (np.rint(vertices[:, 6:8] * 65535).astype("<u2"), "VEC2", 5123),
        ]:
            padded = np.pad(arr, ((0, 0), (0, 1))) if typ == "VEC3" else arr
            stream = view(padded.tobytes(), 34962)
            views[stream]["byteStride"] = padded.shape[1] * arr.itemsize
            access.append(
                dict(bufferView=stream, componentType=component, count=len(arr), type=typ, normalized=True)
            )
            if component == 5122:
                access[-1].update(min=arr.min(0).tolist(), max=arr.max(0).tolist())
        access.append(
            dict(
                bufferView=view(indices.tobytes(), 34963),
                componentType=5123,
                count=len(indices),
                type="SCALAR",
            )
        )
        jpeg = io.BytesIO()
        self.atlas.image.save(jpeg, format="JPEG", quality=93, subsampling=0, optimize=True)
        image = view(jpeg.getvalue())
        doc = dict(
            asset=dict(version="2.0", copyright=copyright),
            extensionsUsed=["KHR_mesh_quantization"],
            extensionsRequired=["KHR_mesh_quantization"],
            scene=0,
            scenes=[dict(nodes=[0])],
            nodes=[dict(mesh=0, name=name, scale=[extent] * 3)],
            meshes=[
                dict(
                    primitives=[
                        dict(attributes=dict(POSITION=0, NORMAL=1, TEXCOORD_0=2), indices=3, material=0)
                    ]
                )
            ],
            materials=[
                dict(
                    pbrMetallicRoughness=dict(
                        baseColorTexture=dict(index=0), metallicFactor=0, roughnessFactor=0.88
                    )
                )
            ],
            textures=[dict(source=0)],
            images=[dict(bufferView=image, mimeType="image/jpeg")],
            accessors=access,
            bufferViews=views,
            buffers=[dict(byteLength=len(raw))],
        )
        out.write_bytes(pack_glb(doc, bytes(raw)))
        print(
            f"{out.name}: {len(indices) // 3:,} triangles, {len(vertices):,} vertices, {out.stat().st_size:,} bytes"
        )
