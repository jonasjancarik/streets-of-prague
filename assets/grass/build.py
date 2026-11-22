"""Pack the street-level grass into public/grass-blades.webp.

blades.webp (generated from the brief in blades.txt) is a strip of lawn grass seen from
the side on a transparent ground. From the street the game stands pieces of it on the
lawns round you as flat cards (src/streetGrass.ts).

public/grass-blades.webp: 1024 × 512, the lower three quarters of the picture (the rest
is empty), stored without its hue, as light and dark only (the game gives it the lawn's
colour and the season's), brightened so that an average blade is about 0.7. What is
transparent takes the colour of what is nearest, so that the edges don't darken where
the picture is drawn small.

usage: cd pipeline && uv run python ../assets/grass/build.py   (Pillow, numpy, scipy)
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).parent
PUBLIC = HERE.parent.parent / "public"


def main():
    im = Image.open(HERE / "blades.webp").convert("RGBA")
    w, h = im.size
    im = im.crop((0, h // 4, w, h)).resize((1024, 512), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32) / 255
    rgb, alpha = a[..., :3], a[..., 3]
    light = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
    mean = light[alpha > 0.5].mean()
    # A little of the picture's own yellow and green kept, so dry blades stay dry.
    tint = rgb / np.maximum(light[..., None], 1e-3)
    tint = tint / tint[alpha > 0.5].mean(axis=0)
    grey = np.clip(light / mean * 0.7, 0, 1)[..., None] * (0.6 + 0.4 * np.clip(tint, 0.5, 1.6))
    solid = alpha > 0.5
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    out = np.dstack([np.clip(grey, 0, 1)[iy, ix], alpha])
    Image.fromarray((out * 255).round().astype(np.uint8), "RGBA").save(PUBLIC / "grass-blades.webp", quality=88, alpha_quality=95, method=6)


if __name__ == "__main__":
    main()
