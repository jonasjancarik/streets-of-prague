"""Pack the street-level trees' textures into public/street-trees.webp and public/bark.webp.

leaf.webp and twig.webp (generated from the briefs in leaf.txt and twig.txt) are a spray
of a broadleaf branch in leaf and a bare one in winter, needle.webp (needle.txt) a spruce
bough, each on a transparent ground; bark.webp (bark.txt) is a trunk's bark. The game hangs the sprays in a tree's crown as
flat cards (src/map/streetTree.ts) and wraps the bark round its trunk and boughs.

public/street-trees.webp: 1536 × 512, three pictures side by side: the leaves, the twigs,
the spruce bough. The leaves and the bough are stored without their hue, as light and dark only (the game gives
each tree its own colour and turns it through the year), brightened so that an average
leaf is nearly white. What is transparent takes the colour of what is nearest, so that
the edges don't darken where the picture is drawn small; the twigs are thickened a
little, since at a tree's distance each is thinner than a pixel.

public/bark.webp: 512 × 512, the middle of the picture (the game repeats it mirrored, so
its edges need not match).

usage: cd pipeline && uv run python ../assets/trees/build.py   (Pillow, numpy, scipy)
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).parent
PUBLIC = HERE.parent.parent / "public"
SIZE = 512


def spread(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Every transparent pixel takes the colour of the nearest one that isn't."""
    solid = alpha > 0.5
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    return rgb[iy, ix]


def card(name: str, grey: bool, thicken: float) -> np.ndarray:
    im = Image.open(HERE / f"{name}.webp").convert("RGBA")
    # Trimmed to what is drawn, with a margin, and squared up from the bottom (the stem
    # stays at the middle of the lower edge).
    box = im.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    side = max(box[2] - box[0], box[3] - box[1]) + 24
    cx = (box[0] + box[2]) // 2
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(im, (side // 2 - cx, side - 12 - box[3]))
    a = np.asarray(square.resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float32) / 255
    rgb, alpha = a[..., :3], a[..., 3]
    if thicken:
        alpha = np.clip(ndimage.maximum_filter(alpha, size=3) * thicken, 0, 1)
    if grey:
        light = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
        mean = light[alpha > 0.5].mean()
        rgb = np.repeat(np.clip(light / mean * 0.72, 0, 1)[..., None], 3, axis=2)
    rgb = spread(rgb, alpha)
    return np.dstack([rgb, alpha])


def main():
    atlas = np.hstack([card("leaf", True, 0), card("twig", False, 1.6), card("needle", True, 0)])
    Image.fromarray((atlas * 255 + 0.5).astype(np.uint8), "RGBA").save(PUBLIC / "street-trees.webp", quality=90, method=6, exact=True)
    bark = Image.open(HERE / "bark.webp").convert("RGB")
    w, h = bark.size
    m = min(w, h) * 3 // 4
    bark = bark.crop(((w - m) // 2, (h - m) // 2, (w + m) // 2, (h + m) // 2)).resize((SIZE, SIZE), Image.LANCZOS)
    bark.save(PUBLIC / "bark.webp", quality=86, method=6)
    print("wrote", PUBLIC / "street-trees.webp", PUBLIC / "bark.webp")


if __name__ == "__main__":
    main()
