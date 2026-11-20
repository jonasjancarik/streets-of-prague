"""Pack Poly Haven Fabric Pattern 05 from the colour-01 JPEG; see assets/SOURCES.md."""

from pathlib import Path
import sys

import numpy as np
from PIL import Image

if __name__ == "__main__":
    image = Image.open(sys.argv[1]).convert("L").resize((512, 512), Image.Resampling.LANCZOS)
    luma = np.asarray(image, dtype=float)
    tile = np.uint8(np.clip(129 + (luma - np.median(luma)) * 1.7, 0, 255))
    Image.fromarray(tile).save(
        Path(__file__).resolve().parents[2] / "public/sedan-upholstery.webp", quality=90, method=6
    )
