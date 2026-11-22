"""Pack the street-level hedges' textures into public/hedge-leaves.webp and public/hedge-face.webp.

cluster.webp (generated from the brief in cluster.txt) is a round cluster of hornbeam
leaves on a transparent ground; face.webp (face.txt) is the clipped face of a hornbeam
hedge, made to repeat. From the street the game wraps the face round a hedge's body and
stands the clusters on it as flat cards (src/streetHedges.ts).

public/hedge-leaves.webp: 768 × 768, the cluster trimmed to what is drawn. What is
transparent takes the colour of what is nearest, so that the edges don't darken where
the picture is drawn small.

public/hedge-face.webp: 1024 × 1024.

usage: cd pipeline && uv run python ../assets/hedges/build.py   (Pillow, numpy, scipy)
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).parent
PUBLIC = HERE.parent.parent / "public"


def main():
    im = Image.open(HERE / "cluster.webp").convert("RGBA")
    box = im.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    side = max(box[2] - box[0], box[3] - box[1]) + 24
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.alpha_composite(im, (side // 2 - (box[0] + box[2]) // 2, side // 2 - (box[1] + box[3]) // 2))
    a = np.asarray(square.resize((768, 768), Image.LANCZOS)).astype(np.float32) / 255
    rgb, alpha = a[..., :3], a[..., 3]
    solid = alpha > 0.5
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    out = np.dstack([rgb[iy, ix], alpha])
    Image.fromarray((out * 255).round().astype(np.uint8), "RGBA").save(PUBLIC / "hedge-leaves.webp", quality=88, alpha_quality=95, method=6)
    Image.open(HERE / "face.webp").convert("RGB").resize((1024, 1024), Image.LANCZOS).save(PUBLIC / "hedge-face.webp", quality=84, method=6)


if __name__ == "__main__":
    main()
