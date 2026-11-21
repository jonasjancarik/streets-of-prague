"""Pack the 1K diffuse, ambient occlusion and OpenGL normal JPEGs (in that order)
from Charlotte Baglioni's Cobblestone Pavement, CC0, polyhaven.com/a/cobblestone_pavement.
"""
from pathlib import Path
import sys

import numpy as np
from PIL import Image

diffuse, ao, normal = (Image.open(path).convert("RGB") for path in sys.argv[1:])
if any(image.size != (1024, 1024) for image in (diffuse, ao, normal)):
    raise ValueError("Expected matching 1K maps")
rgb = np.asarray(diffuse, dtype=np.float32) / 255
linear = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
value = (linear @ [0.2126, 0.7152, 0.0722]) * (np.asarray(ao.convert("L")) / 255) ** 0.7
# Preserve the street's surveyed base colour. Two stops of reflectance to either
# side of middle grey are enough to keep both the joints and the mineral flecks.
stops = np.log2(np.maximum(value, 0.001) / np.median(value))
packed = np.array(normal)
packed[..., 0] = np.rint(255 * np.clip(0.5 + 0.25 * stops, 0, 1))
packed[..., 1:] = np.asarray(normal)[..., :2]
out = Path(__file__).resolve().parents[2] / "public" / "street-setts.webp"
Image.fromarray(packed).save(out, quality=94, method=6)
print(out, out.stat().st_size)
