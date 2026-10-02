"""Two runs' screenshots side by side, to show a change: <before tag>-<name>.png and
<after tag>-<name>.png from the scene server's folder ($TMPDIR/scene) as <out>/<name>.jpg.

    uv run --project pipeline python .agents/skills/terrain-steps/pairs.py before after out/ [name …]

Without names: every picture the two tags both have.
"""
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

before, after, out = sys.argv[1:4]
shots = os.path.join(os.environ.get("TMPDIR", "/tmp"), "scene")
names = sys.argv[4:] or sorted(os.path.basename(f)[len(after) + 1:-4] for f in glob.glob(f"{shots}/{after}-*.png")
                               if os.path.exists(f"{shots}/{before}-" + os.path.basename(f)[len(after) + 1:]))
os.makedirs(out, exist_ok=True)
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 34)
for name in names:
    a, b = (Image.open(f"{shots}/{tag}-{name}.png").convert("RGB") for tag in (before, after))
    w, h = a.size
    sheet = Image.new("RGB", (w * 2 + 12, h), "white")
    sheet.paste(a, (0, 0))
    sheet.paste(b, (w + 12, 0))
    draw = ImageDraw.Draw(sheet)
    for x, label in ((0, "before"), (w + 12, "after")):
        draw.rectangle([x + w - 190, h - 70, x + w - 20, h - 20], fill=(20, 20, 20))
        draw.text((x + w - 175, h - 64), label, font=font, fill="white")
    sheet.save(f"{out}/{name}.jpg", quality=85)
print(f"{len(names)} pairs → {out}")
