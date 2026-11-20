"""Bake timber, aggregate, foliage and the phone's printed face into one shared atlas.
Run with pipeline/.venv/bin/python assets/furniture/build.py.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter, distance_transform_edt

HERE = Path(__file__).resolve().parent
rng = np.random.default_rng(2841)
atlas = Image.new("RGBA", (512, 512), "white")

# Grain runs along the slat. Slowly bending growth rings survive the mip levels;
# the pore marks and silver weathering are visible only from a few steps away.
y, x = np.mgrid[:128, :512]
fibres = gaussian_filter(rng.normal(size=x.shape), (0.45, 9))
knots = 6 * np.exp(-((x-318)/39)**2 - ((y-47)/12)**2) + 3 * np.exp(-((x-100)/22)**2 - ((y-99)/9)**2)
rings = (y + 2.2*np.sin(x/98+y/32) + knots) * 1.5
grain = 227 - 19*np.maximum(0, np.cos(rings))**6 + 21*fibres + 5*np.sin(rings/3) + rng.normal(0, 3, x.shape)
def neutral(a):
    return Image.fromarray(np.uint8(np.clip(a, 0, 255))).convert("RGBA")
atlas.paste(neutral(grain), (0, 0))

grit = rng.normal(230, 7, (118, 512))
grit[rng.random(grit.shape) < .045] -= 24
atlas.paste(neutral(grit), (0, 132))
leaf = Image.open(HERE.parent / "trees" / "leaf.webp").convert("RGBA").resize((256, 256), Image.Resampling.LANCZOS)
a = np.array(leaf)
outside = a[:, :, 3] < 32
yy, xx = distance_transform_edt(outside, return_distances=False, return_indices=True)
a[outside, :3] = a[yy[outside], xx[outside], :3]
atlas.paste(Image.fromarray(a), (0, 256))

# One printed enamel fascia and the inset keypad. Markings are generic.
d = ImageDraw.Draw(atlas)
font = ImageFont.load_default(size=35)
d.rectangle((262, 260, 509, 315), fill='#f2c34b')
d.text((385, 286), 'TELEFON', font=font, fill='#192d38', anchor='mm', stroke_width=1)
d.rectangle((264, 327, 426, 501), fill='#9ca5a5')
d.rounded_rectangle((275, 337, 412, 377), 3, fill='#343e3e', outline='#d4d7d3', width=2)
d.rectangle((283, 344, 405, 371), fill='#8b9d87')
d.text((344, 357), 'VLOŽTE KARTU', font=ImageFont.load_default(size=13), fill='#36423a', anchor='mm')
for i, label in enumerate('123456789*0#'):
    cx, cy = 286 + i % 3 * 45, 398 + i // 3 * 26
    d.rounded_rectangle((cx-13, cy-10, cx+14, cy+9), 4, fill='#d3d4cd', outline='#6a6f70', width=2)
    d.text((cx, cy-1), label, font=ImageFont.load_default(size=15), fill='#242a2b', anchor='mm')
out = HERE.parent.parent / 'public' / 'furniture-surfaces.webp'
atlas.save(out, quality=88, method=6, exact=True)
print(out, out.stat().st_size)
