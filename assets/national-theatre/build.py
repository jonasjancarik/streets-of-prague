"""Reconstruct the National Theatre exterior. Run with the pipeline Python environment."""

import io
import math

import numpy as np

from surfaces import ROOT, Atlas, read_survey
from statuary import sculpture
from landmark_colours import pack_glb


# Plans from horizontal sections of IPR's city model, in metres. Counterclockwise
# from the north-west corner. The river elevation changes direction at the rear wing.
BODY = np.array([(-18.52, -1.88), (-9.22, -55.08), (23.90, -52.52), (18.92, -0.84)])
REAR = np.array([(-9.22, -55.08), (5.68, -98.70), (27.24, -94.26), (26.10, -52.22)])
DRUM = np.array([(-13.14, -7.34), (-4.2, -54.34), (18.64, -50.64), (14.10, -6.72)])
CREST = np.array([(-6.5, -14.0), (-0.35, -45.5), (10.0, -44.0), (6.6, -13.8)])
LOFT = np.array([(-6.86, -60.5), (-1.3, -77.58), (25.14, -75.42), (24.64, -53.96)])
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
                round(float(v), 5) for v in (p[0], p[2], -p[1], n[0], n[2], -n[1], *self.atlas.uv(material, t))
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

    def save(self):
        vertices = np.array(self.vertices, dtype="<f4")
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
            (np.rint(vertices[:, :3] * 32767 / 104).astype("<i2"), "VEC3", 5122),
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
                assert np.abs(vertices[:, :3]).max() < 104
                access[-1].update(min=arr.min(0).tolist(), max=arr.max(0).tolist())
        access.append(
            dict(
                bufferView=view(indices.tobytes(), 34963), componentType=5123, count=len(indices), type="SCALAR"
            )
        )
        jpeg = io.BytesIO()
        self.atlas.image.save(jpeg, format="JPEG", quality=93, subsampling=0, optimize=True)
        image = view(jpeg.getvalue())
        doc = dict(
            asset=dict(version="2.0", copyright="Survey details: IPR Praha, CC BY 4.0"),
            extensionsUsed=["KHR_mesh_quantization"],
            extensionsRequired=["KHR_mesh_quantization"],
            scene=0,
            scenes=[dict(nodes=[0])],
            nodes=[dict(mesh=0, name="Národní divadlo", scale=[104] * 3)],
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
        out = ROOT / "public/national-theatre.glb"
        out.write_bytes(pack_glb(doc, bytes(raw)))
        print(
            f"{out.name}: {len(indices) // 3:,} triangles, {len(vertices):,} vertices, {out.stat().st_size:,} bytes"
        )


def elevation(m, a, b, bays, paired=(), niches=()):
    # Local bay axes follow each street, including the bend by the former Provisional Theatre.
    edge = b - a
    normal = unit(np.array([edge[1], -edge[0]]))
    for i in range(bays):
        lo = a + edge * i / bays
        hi = a + edge * (i + 1) / bays

        def point(f, d, z):
            return at(lo + (hi - lo) * f + normal * d, z)

        def panel(l, r, z, h, depth, mat):
            m.face([point(l, depth, z), point(r, depth, z), point(r, depth, h), point(l, depth, h)], mat)

        m.wall(lo, hi, -1, 3.2, "ashlar")
        m.wall(lo, hi, 3.2, 9.9, "ashlar")
        for z, h in [(2.0, 3.7), (5.5, 8.25)]:
            panel(0.32, 0.68, z, h, 0.035, "lowerWindow")
        upper = "niche" if i in niches else "paired" if i in paired else "classic"
        m.wall(lo, hi, 9.9, 18.9, upper)
        m.wall(lo, hi, 18.9, 22.05, "oculus")
        # Projecting stone pilasters and their capitals catch the changing game light.
        for z, h, w, d, mat in [
            (10.25, 10.55, 0.085, 0.20, "trim"),
            (10.55, 18.07, 0.052, 0.15, "stone"),
            (18.07, 18.45, 0.083, 0.23, "trim"),
        ]:
            A, B, C, D = point(0, 0, z), point(w, 0, z), point(w, d, z), point(0, d, z)
            ring = np.array([A[:2], D[:2], C[:2], B[:2]])
            m.course(ring, (z, 0), (h, 0), mat)
    for z in [9.58, 18.55, 21.9]:
        # A strip per elevation avoids building a solid floor in the loggia.
        for z0, z1, d0, d1, mat in [
            (z, z + 0.12, 0, 0.17, "shadow"),
            (z + 0.12, z + 0.33, 0.17, 0.38, "trim"),
            (z + 0.33, z + 0.46, 0.38, 0.38, "trim"),
            (z + 0.46, z + 0.46, 0.38, 0, "stone"),
        ]:
            m.face(
                [
                    at(a + normal * d0, z0),
                    at(b + normal * d0, z0),
                    at(b + normal * d1, z1),
                    at(a + normal * d1, z1),
                ],
                mat,
            )


def arcade(m, a, b, count, bottom, spring, top, radius, depth):
    """Open voussoir arches, with a continuous underside through to the inner edge."""
    a, b = np.array(a), np.array(b)
    tangent = unit(b - a)
    inside = np.array([-tangent[1], tangent[0]])
    span = np.linalg.norm(b - a) / count

    def pt(x, d, z):
        return at(a + tangent * x + inside * d, z)

    for i in range(count):
        mid = (i + 0.5) * span

        def masonry(pts):
            uv = [(np.dot(p[:2] - a, tangent) / span - i, (top - p[2]) / (top - bottom)) for p in pts]
            m.face(pts, "ashlar" if bottom < 10 else "stone", uv)

        for lo, hi in [(i * span, mid - radius), (mid + radius, (i + 1) * span)]:
            masonry([pt(lo, 0, bottom), pt(hi, 0, bottom), pt(hi, 0, top), pt(lo, 0, top)])
            m.face(
                [pt(hi, depth, bottom), pt(lo, depth, bottom), pt(lo, depth, top), pt(hi, depth, top)], "stone"
            )
        for s in [-1, 1]:
            x = mid + s * radius
            pts = [pt(x, 0, bottom), pt(x, depth, bottom), pt(x, depth, spring), pt(x, 0, spring)]
            m.face(pts if s < 0 else pts[::-1], "shadow")
        theta = np.linspace(math.pi, 0, 15)
        for t, u in zip(theta, theta[1:]):

            def arc(angle, r, d):
                return pt(mid + math.cos(angle) * r, d, spring + math.sin(angle) * r)

            l, r = arc(t, radius, 0), arc(u, radius, 0)
            masonry([l, r, at(r[:2], top), at(l[:2], top)])
            back = [arc(t, radius, depth), arc(u, radius, depth)]
            m.face([back[1], back[0], at(back[0][:2], top), at(back[1][:2], top)], "stone")
            m.face([r, l, back[0], back[1]], "shadow")
            m.face(
                [
                    arc(t + 0.002, radius, -0.06),
                    arc(u - 0.002, radius, -0.06),
                    arc(u - 0.002, radius + 0.25, -0.10),
                    arc(t + 0.002, radius + 0.25, -0.10),
                ],
                "trim",
            )


def loggia(m):
    # Five open ground-floor arches and the five taller column bays above them.
    west, east = -12.85, 12.40
    front, back = 5.65, -0.65
    ring = np.array([(west, front), (west, back), (east, back), (east, front)])
    for side0, side1, n in [
        ((east, front), (west, front), 5),
        ((west, front), (west, back), 1),
        ((east, back), (east, front), 1),
    ]:
        arcade(m, side0, side1, n, 2.9, 6.62, 9.92, 1.63, 0.87)
    for z, h in [(3.14, 3.35), (9.83, 10.27), (19.9, 22.6)]:
        m.course(ring, (z, 0), (h, 0), "stone")
        m.face([at(p, z) for p in ring[::-1]], "shadow")
    for z in [9.68, 19.77, 22.38]:
        m.moulding(ring, z, 0.35)
    for i in range(6):
        x = west + 0.60 + i * (east - west - 1.2) / 5
        c = np.array([x, front - 0.56])
        m.box(x - 0.56, c[1] - 0.57, x + 0.56, c[1] + 0.57, 10.2, 11.05, "stone")
        m.turned(c, [(11.05, 0.58), (11.22, 0.62), (11.44, 0.48), (11.69, 0.43)], "trim", 14)
        m.turned(c, [(11.68, 0.43), (18.62, 0.355)], "fluting", 14)
        m.turned(c, [(18.60, 0.355), (18.73, 0.46), (19.08, 0.51), (19.62, 0.60)], "capital", 10)
        m.box(x - 0.65, c[1] - 0.65, x + 0.65, c[1] + 0.65, 19.35, 19.96, "trim")
    arcade(m, (east - 0.60, front - 0.62), (west + 0.60, front - 0.62), 5, 17.78, 17.78, 19.94, 1.89, 0.40)
    railing(m, np.array([east - 0.3, front - 0.37]), np.array([west + 0.3, front - 0.37]), 10.26)
    railing(m, np.array([east - 0.28, front - 0.34]), np.array([west + 0.28, front - 0.34]), 22.86, 0.84)
    for i in range(5):
        x = west + (i + 0.5) * (east - west) / 5
        # Door surrounds on the recessed north wall and the spandrel above the columns.
        for z, h in [(3.4, 9.58), (10.35, 18.95)]:
            m.wall(np.array([x + 1.67, back + 0.10]), np.array([x - 1.67, back + 0.10]), z, h, "doorway")
        m.wall(
            np.array([x + (east - west) / 10, front + 0.01]),
            np.array([x - (east - west) / 10, front + 0.01]),
            20.28,
            22.25,
            "frieze",
        )


def hip_roof(m, ring, z, ridge, h):
    # Project the rear roof survey in plan onto the four hand-built copper pitches.
    raised = [ridge[0], ridge[1], ridge[1], ridge[0]]
    for i in range(4):
        j = (i + 1) % 4
        p = [at(ring[i], z), at(ring[j], z), at(raised[j], h)]
        if not np.array_equal(raised[i], raised[j]):
            p.append(at(raised[i], h))
        m.face(p, "rearRoof", [((x + 10) / 39, (-53 - y) / 47) for x, y, _ in p])


def rear(m):
    for i, n in [(0, 10), (1, 5), (2, 10)]:
        elevation(m, REAR[i], REAR[(i + 1) % 4], n)
    m.course(REAR, (22.0, 0.08), (22.8, 0.28), "trim")
    ring = inset(REAR, 0.6)
    hip_roof(m, ring, 22.8, [(7.8, -68), (14, -88)], 26.1)
    # The upstage block rises above the former theatre towards the auditorium.
    for a, b in edges(LOFT):
        n = max(1, round(np.linalg.norm(b - a) / 3.8))
        for i in range(n):
            m.wall(a + (b - a) * i / n, a + (b - a) * (i + 1) / n, 22.7, 27.8, "attic")
    m.moulding(LOFT, 27.55)
    hip_roof(m, inset(LOFT, 0.32), 28.02, [(5, -68.25), (15.1, -67.1)], 31.95)


def railing(m, a, b, z, height=0.92):
    """Stone balustrade between two returns, with square piers at intervals."""
    vec = b - a
    n = unit(np.array([vec[1], -vec[0]]))
    length = np.linalg.norm(vec)
    ring = np.array([a + n * 0.16, b + n * 0.16, b - n * 0.16, a - n * 0.16])
    m.course(ring, (z, 0), (z + 0.16, 0.02), "trim")
    m.course(ring, (z + height - 0.16, 0.02), (z + height, 0.06), "trim")
    count = max(2, round(length / 0.70))
    for i in range(count + 1):
        c = a + vec * (i / count)
        if i % 6 == 0 or i == count:
            m.box(c[0] - 0.23, c[1] - 0.23, c[0] + 0.23, c[1] + 0.23, z, z + height + 0.08, "stone")
        else:
            m.turned(
                c,
                [(z + 0.12, 0.155), (z + 0.29, 0.095), (z + 0.48, 0.159), (z + height - 0.15, 0.085)],
                "trim",
                5,
            )


def carriage_porch(m):
    # West carriage entrance (way/379386266), projecting over the pavement.
    ring = np.array([(-24.57, -9.27), (-22.12, -21.83), (-16.76, -20.81), (-18.51, -7.93)])
    for i, bays in [(0, 3), (1, 1), (3, 1)]:
        a, b = ring[i], ring[(i + 1) % 4]
        r = np.linalg.norm(b - a) / bays * 0.345
        arcade(m, a, b, bays, 2.8, 6.85, 10.02, r, 0.63)
    m.course(ring, (9.95, 0), (10.32, 0.12), "trim")
    m.moulding(ring, 10.19)
    for a, b in list(edges(ring))[:2] + [list(edges(ring))[-1]]:
        railing(m, a, b, 10.67)


def roof(m):
    for a, b in edges(DRUM):
        count = round(np.linalg.norm(b - a) / 4.6)
        for i in range(count):
            m.wall(a + (b - a) * i / count, a + (b - a) * (i + 1) / count, 24.0, 34.05, "attic")
    m.moulding(DRUM, 33.72, 0.36)
    # Curved mansard: round at the eaves, flattening under the gilded lantern.
    rings = []
    for angle in np.linspace(0, math.pi / 2, 13):
        ring = DRUM + (CREST - DRUM) * (1 - math.cos(angle))
        rings.append((ring, 34.15 + 8.75 * math.sin(angle)))
    for k, ((lo, z), (hi, h)) in enumerate(zip(rings, rings[1:])):
        for i in range(4):
            j = (i + 1) % 4
            n = round(np.linalg.norm(DRUM[j] - DRUM[i]) / 3.35)
            for s in range(n):
                pts = [at(lo[i] + (lo[j] - lo[i]) * u, z) for u in (s / n, (s + 1) / n)]
                pts.extend(at(hi[i] + (hi[j] - hi[i]) * u, h) for u in ((s + 1) / n, s / n))
                v = 1 - (k % 4) / 4
                m.face(pts, "slate", [(0, v), (1, v), (1, v - 0.25), (0, v - 0.25)])
            # Broad moulded gilt arrises, one wrapping each corner from eave to crest.
            left = unit(lo[(i - 1) % 4] - lo[i]) * 0.27
            right = unit(lo[j] - lo[i]) * 0.27
            a = at(lo[i], z + 0.035)
            b = at(hi[i], h + 0.035)
            for side in (left, right):
                p = [a, a + at(side, 0), b + at(side, 0), b]
                if side is left:
                    p = p[::-1]
                m.face(p, "giltEdge")
    for ring, z in [(DRUM, 34.08), (CREST, 42.90)]:
        m.course(ring, (z, 0.04), (z + 0.24, 0.10), "gold")
    m.course(CREST, (43.12, 0.03), (43.62, 0), "gold", cap=False)
    m.face([at(p, 43.62) for p in CREST], "copper")
    # Openwork crest. Each spear rises above paired rails with a diamond below.
    for a, b in edges(CREST):
        out = unit(np.array([(b - a)[1], -(b - a)[0]]))
        n = round(np.linalg.norm(b - a) / 0.75)
        for z, h in [(43.67, 43.79), (44.12, 44.20)]:
            m.wall(a, b, z, h, "giltEdge")
            m.wall(b - out * 0.07, a - out * 0.07, z, h, "gold")
        for i in range(n):
            mid = a + (b - a) * (i + 0.5) / n
            side = (b - a) / n
            points = [
                at(mid, 43.62),
                at(mid + side * 0.30, 44.04),
                at(mid, 44.63),
                at(mid - side * 0.30, 44.04),
            ]
            m.face(points, "gold")
            m.face(points[::-1], "giltEdge")
    for corner in CREST:
        m.turned(
            corner,
            [
                (43.3, 0.24),
                (44.1, 0.22),
                (44.2, 0.36),
                (44.53, 0.18),
                (45.5, 0.12),
                (45.7, 0.34),
                (46.17, 0.24),
                (46.65, 0.09),
                (47.05, 0.025),
            ],
            "giltEdge",
            8,
        )
    # The long glazed ventilation lantern sits inside the crown.
    lantern = inset(CREST, 2.55)
    m.course(lantern, (43.47, 0), (43.90, 0), "lead")
    m.course(lantern, (43.90, 0), (44.46, -0.65), "copper")
    # Four bull's-eyes along each long slope, two on each end.
    for i, n in enumerate([4, 2, 4, 2]):
        j = (i + 1) % 4
        for f in np.linspace(0.19, 0.81, n):
            base = DRUM[i] * (1 - f) + DRUM[j] * f
            towards = (CREST[i] * (1 - f) + CREST[j] * f) - base
            centre = base + towards * 0.013
            u = unit(DRUM[j] - DRUM[i])
            inward = np.array([-u[1], u[0]])
            spring = 37.8
            arc = [
                at(centre + u * (0.90 * math.cos(t)), spring + 1.17 * math.sin(t))
                for t in np.linspace(math.pi, 0, 13)
            ]
            front = [at(centre - u * 0.9, 36.68), *arc, at(centre + u * 0.9, 36.68)]
            m.face(front[::-1], "shadow")
            for a, b in zip(front, front[1:]):
                m.face([a, b, b + at(inward * 1.55, 0), a + at(inward * 1.55, 0)], "copper")
            glass = [
                at(centre + u * (0.52 * math.cos(t)) - inward * 0.02, spring - 0.15 + 0.64 * math.sin(t))
                for t in np.linspace(0, math.tau, 17)[:-1]
            ]
            m.face(glass, "glass")
            inner = [
                at(centre + u * (0.59 * math.cos(t)) - inward * 0.03, spring - 0.15 + 0.71 * math.sin(t))
                for t in np.linspace(0, math.tau, 17)[:-1]
            ]
            for (a, b), (c, d) in zip(edges(inner), edges(glass)):
                m.face([a, b, d, c], "gold")


def build():
    survey = read_survey()
    m = Building(Atlas(survey))
    for i, bays in [(0, 13), (1, 8), (2, 13)]:
        elevation(
            m,
            BODY[i],
            BODY[(i + 1) % 4],
            bays,
            range(4, 9) if i == 0 else (),
            (0,) if i == 0 else (bays - 1,) if i == 2 else (),
        )
    west, east = BODY[0], BODY[3]
    for outer, inner in [(east, 0.175), (west, 0.165)]:
        other = west if outer is east else east
        end = outer + (other - outer) * inner
        a, b = (outer, end) if outer is east else (end, outer)
        elevation(m, a, b, 1, niches=(0,))
    a, b = east + (west - east) * 0.175, west + (east - west) * 0.165
    for i in range(5):
        start, end = a + (b - a) * i / 5, a + (b - a) * (i + 1) / 5
        m.wall(start, end, -1, 10, "ashlar")
        m.wall(start, end, 10, 22.08, "stone")
    m.course(BODY, (22.05, 0), (22.88, 0.12), "trim")
    m.course(inset(BODY, 0.60), (22.88, 0), (24.55, -1.20), "lead", cap=False)
    m.face([at(p, 24.55) for p in inset(BODY, 1.80)], "copper")
    for i in (0, 2):
        a, b = BODY[i], BODY[(i + 1) % 4]
        railing(m, a + (b - a) * (0.15 if i == 0 else 0.015), a + (b - a) * (0.985 if i == 0 else 0.85), 22.88)
    carriage_porch(m)
    rear(m)
    loggia(m)
    for x, y in [(-14.94, -5.08), (15.78, -4.6)]:
        ring = np.array([(x - 3.45, y + 3.6), (x - 3.45, y - 3.6), (x + 3.45, y - 3.6), (x + 3.45, y + 3.6)])
        m.course(ring, (22.7, 0), (25.35, 0), "stone")
        m.course(ring, (25.35, 0), (26.82, 0), "carving")
        m.moulding(ring, 26.78, 0.32)
        m.course(ring, (27.26, 0.18), (27.95, 0.08), "trim")
    roof(m)
    sculpture(m)
    m.save()


if __name__ == "__main__":
    build()
