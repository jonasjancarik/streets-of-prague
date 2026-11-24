"""Photo atlas and indexed glTF export for the Jan Hus Memorial."""

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt, gaussian_filter

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
from landmark_colours import pack_glb

# Reference-image crop and its upper left pixel in the shared 2048 x 1024 atlas.
PATCHES = {
    "plate": ((246, 88, 1035, 543), (4, 4)),
    "relief": ((350, 450, 1020, 701), (4, 468)),
    "exiles": ((0, 337, 448, 554), (4, 734)),
    "chalice": ((0, 81, 554, 554), (805, 4)),
    "reverse": ((40, 22, 565, 307), (804, 490)),
    "face": ((340, 117, 527, 363), (1370, 344)),
    "dedication": ((75, 210, 559, 304), (1370, 610)),
    "drapery": ((370, 146, 440, 322), (1600, 345)),
    "granite": ((0, 0, 240, 120), (1370, 4)),
    "bronze": ((0, 0, 180, 180), (1370, 145)),
}
ATLAS = HERE / "surfaces.webp"


class Model:
    def __init__(self):
        self.points, self.normals, self.uv, self.triangles = [], [], [], []
        self.mask = Image.new("L", (2048, 1024))
        self.pen = ImageDraw.Draw(self.mask)

    def patch(self, positions, pixels, name, flip=False):
        """A connected rectangular patch, sharing normals between adjacent quads."""
        p = np.asarray(positions, float)
        h, w, _ = p.shape
        indices = np.arange(h * w).reshape(h, w)
        a, b, c, d = indices[:-1, :-1], indices[:-1, 1:], indices[1:, 1:], indices[1:, :-1]
        tri = np.stack((a, b, c, a, c, d), axis=-1).reshape(-1, 3)
        if flip:
            tri = tri[:, ::-1]
        flat = p.reshape(-1, 3)
        cross = np.cross(flat[tri[:, 1]] - flat[tri[:, 0]], flat[tri[:, 2]] - flat[tri[:, 0]])
        good = np.linalg.norm(cross, axis=1) > 1e-9
        tri, cross = tri[good], cross[good]
        normals = np.zeros_like(flat)
        for corner in tri.T:
            np.add.at(normals, corner, cross)
        normals /= np.maximum(1e-10, np.linalg.norm(normals, axis=1)[:, None])
        (x, y, _, _), offset = PATCHES[name]
        uv = np.asarray(pixels).reshape(-1, 2) - (x, y) + offset
        for corners in uv[tri]:
            self.pen.polygon([tuple(q) for q in corners], fill=255)
        self.triangles.extend(tri + len(self.points))
        self.points.extend(flat)
        self.normals.extend(normals)
        self.uv.extend((uv + 0.5) / (2048, 1024))

    def save(self):
        raw, views, access = bytearray(), [], []

        def stream(data, target=None):
            raw.extend(b"\0" * (-len(raw) % 4))
            view = dict(buffer=0, byteOffset=len(raw), byteLength=len(data))
            if target:
                view["target"] = target
            views.append(view)
            raw.extend(data)
            return len(views) - 1

        def y_up(points):
            v = np.asarray(points)[:, [0, 2, 1]].copy()
            v[:, 2] *= -1
            return v.astype("<f4")

        used, remap = np.unique(np.asarray(self.triangles).ravel(), return_inverse=True)
        assert len(used) < 65536
        indices = remap.astype("<u2")
        for data, typ in [
            (y_up(self.points), "VEC3"),
            (y_up(self.normals), "VEC3"),
            (np.asarray(self.uv, dtype="<f4"), "VEC2"),
            (indices, "SCALAR"),
        ]:
            indexed = typ == "SCALAR"
            if not indexed:
                data = data[used]
            a = dict(
                bufferView=stream(data.tobytes(), 34963 if indexed else 34962),
                count=len(data),
                componentType=5123 if indexed else 5126,
                type=typ,
            )
            if not access:
                a.update(min=data.min(0).tolist(), max=data.max(0).tolist())
            access.append(a)
        tex = io.BytesIO()
        Image.open(ATLAS).save(tex, "JPEG", quality=90, subsampling=0, optimize=True)
        image = stream(tex.getvalue())
        doc = dict(
            asset=dict(
                version="2.0",
                copyright="Jan Hus Memorial reconstruction, CC BY-SA 4.0. Photographs: Enfo, VasuVR, Kawon Kez Sel, Wisniowy and the 1924 Matějček and Wirth plate. See assets/SOURCES.md.",
            ),
            scene=0,
            scenes=[dict(nodes=[0])],
            nodes=[dict(mesh=0, name="Jan Hus Memorial")],
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
                        baseColorTexture=dict(index=0), metallicFactor=0, roughnessFactor=0.9
                    )
                )
            ],
            textures=[dict(source=0)],
            images=[dict(bufferView=image, mimeType="image/jpeg")],
            buffers=[dict(byteLength=len(raw))],
            accessors=access,
            bufferViews=views,
        )
        target = ROOT / "public/jan-hus.glb"
        target.write_bytes(pack_glb(doc, bytes(raw)))
        print(f"{len(indices) // 3:,} triangles, one primitive, {target.stat().st_size:,} bytes")


def photo_atlas(model, folder):
    # Pixel coordinates in the sculpting profiles refer to these reference sizes.
    plate = Image.open(folder / "plate.jpg").convert("RGB").resize((1280, 897))
    inputs = {
        "plate": plate,
        "relief": plate,
        "exiles": Image.open(folder / "exiles.jpg").resize((960, 620)),
        "chalice": Image.open(folder / "chalice.jpg").resize((853, 640)),
        "reverse": Image.open(folder / "reverse.jpg").resize((1280, 389)),
        "face": Image.open(folder / "face.jpg").resize((800, 600)),
    }
    inputs["drapery"] = inputs["exiles"]
    inputs["dedication"] = inputs["reverse"]
    rng = np.random.default_rng(1915)
    out = Image.new("RGB", (2048, 1024), (78, 83, 75))
    for name, (box, (x, y)) in PATCHES.items():
        w, h = box[2] - box[0], box[3] - box[1]
        if name in inputs:
            grey = np.array(inputs[name].crop(box).convert("L"), float)
            if name == "dedication":
                v = 80 + np.sqrt(grey / 255) * 99
                pixels = np.stack((v * 1.055, v, v * 0.94), -1)
            elif name == "relief":
                v = 76 + 0.51 * grey
                pixels = np.stack((v * 1.055, v, v * 0.94), -1)
            else:
                if name == "reverse":
                    grey = np.sqrt(grey / 255) * 255
                v = 39 + grey * (0.63 if name == "plate" else 0.71)
                pixels = np.stack((v * 0.78, v * 1.05, v * 0.94), -1)
            # Pad only the projected sculpture. Sky and surrounding buildings would
            # otherwise bleed onto its outline at distant mip levels.
            mask = np.array(model.mask.crop((x, y, x + w, y + h)))
            near = distance_transform_edt(mask == 0, return_distances=False, return_indices=True)
            pixels = pixels[tuple(near)]
        else:
            grain = rng.normal(0, 10, (h, w))
            mottling = gaussian_filter(grain, 4, mode="wrap") * 3
            base = [155, 150, 141] if name == "granite" else [66, 84, 75]
            pixels = np.array(base) + (grain + mottling)[:, :, None]
        im = Image.fromarray(pixels.clip(0, 255).astype("uint8"))
        out.paste(im, (x, y))
    out.save(ATLAS, lossless=True, method=6)
