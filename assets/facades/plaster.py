"""Pack Poly Haven's Plastered Wall 1K diffuse and OpenGL normal maps (CC0)."""

from pathlib import Path
import sys

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter


def pack(diffuse, normal):
    albedo = np.asarray(Image.open(diffuse).convert("L"), dtype=np.float32)
    slopes = np.asarray(Image.open(normal).convert("RGB"))
    if albedo.shape != (1024, 1024) or slopes.shape[:2] != albedo.shape:
        raise ValueError("Expected matching 1K maps")
    # Suppress the photograph's broad patches; the mapped building supplies the
    # colour of its render. Retain trowel marks and small chips in the surface.
    detail = albedo - gaussian_filter(albedo, 22, mode="wrap")
    rgb = np.stack(
        [np.clip(128 + 2.6 * detail, 0, 255).astype(np.uint8), slopes[..., 0], slopes[..., 1]], axis=-1
    )
    out = Path(__file__).resolve().parents[2] / "public" / "street-plaster.webp"
    Image.fromarray(rgb).resize((640, 640), Image.Resampling.LANCZOS).save(out, quality=89, method=6)
    print(out.stat().st_size)


if __name__ == "__main__":
    pack(*sys.argv[1:])
