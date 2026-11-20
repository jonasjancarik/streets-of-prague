"""Pack Poly Haven's CC0 Asphalt 04, photographed by Sergej Majboroda.
Pass the diffuse and OpenGL normal 1k JPEGs as the two arguments.
Source files and credits: https://polyhaven.com/a/asphalt_04
"""
from pathlib import Path
import sys

import numpy as np
from PIL import Image

diffuse, normal = (Image.open(path).convert("RGB") for path in sys.argv[1:])
if diffuse.size != (1024, 1024) or normal.size != diffuse.size:
    raise ValueError("Expected the matching 1k diffuse and OpenGL normal maps")
# Preserve a neutral road's colour at a distance. Store the aggregate's relative
# reflectance around 0.5 and two tangent-space slopes in one non-colour texture.
rgb = np.asarray(diffuse, dtype=np.float32) / 255
linear = np.where(rgb <= .04045, rgb / 12.92, ((rgb + .055) / 1.055) ** 2.4)
luma = linear @ [.2126, .7152, .0722]
reflectance = np.clip(.5 + .27 * np.log2(np.maximum(.001, luma) / np.median(luma)), 0, 1)
packed = np.array(normal)
packed[..., 0] = np.rint(reflectance * 255).astype(np.uint8)
packed[..., 1:] = np.asarray(normal)[..., :2]
out = Path(__file__).resolve().parents[2] / "public" / "street-asphalt.webp"
Image.fromarray(packed).save(out, quality=93, method=6)
print(out, out.stat().st_size)
