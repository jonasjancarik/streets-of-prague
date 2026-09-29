"""Cut the character sheets into single portraits in public/portraits/.

Each sheet (sheetN.webp, generated with ChatGPT) holds 5 × 2 half-length portraits on
a transparent background: every figure stands in its own opaque panel, with the head
rising free above it. The image model never lines the panels up between the rows, so
the seams are found per row, where the colour jumps from one panel to the next. Each
portrait keeps a few pixels less than its panel on the sides and at the bottom, where
the neighbours bleed in; whatever shows it (src/portraits.ts) covers the cut edges.

Faces that came out too alike were regenerated one by one with Codex, from the cut
portrait and the rest of the cast, keeping the clothes and pose: those are in
faces/<id>.webp (lossless) and take the place of their cell (at most 1000 px tall).

usage: python3 assets/portraits/cut.py   (needs Pillow and numpy)
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
OUT = HERE.parent.parent / "public" / "portraits"
FACES = HERE / "faces"
MAX_H = 1000
COLS = 5
TRIM = 5  # pixels dropped at each cut edge

# Per sheet, row by row, left to right: an id and who they are.
CAST = [
    [("marek", "man in an olive jacket"), ("clerk", "woman with glasses and files"),
     ("driver", "older man in a transport company vest"), ("student", "curly-haired lad with headphones"),
     ("butcher", "heavy, balding man in an apron, arms crossed"),
     ("courier", "young food courier in a cap, black bob"), ("veteran", "old man in a sheepskin jacket"),
     ("tattooed", "tattooed woman in a black top"), ("neighbour", "stocky woman with a curly perm, green jacket"),
     ("drifter", "man in a beanie with a cigarette")],
    [("rocker", "woman with a bleached buzz cut, leather jacket"), ("conductor", "old tram conductor in uniform"),
     ("foreman", "woman in a hi-vis jacket, smoking"), ("bouncer", "bald man with tattoos"),
     ("mechanic", "lanky young man in a cap and overalls"),
     ("barmaid", "copper-haired barmaid with tattoos and a glass"), ("grandma", "grandmother with newspapers"),
     ("punk", "teenager in a hoodie with badges"), ("inspector", "old detective in a trench coat"),
     ("hacker", "man with glasses and headphones")],
    [("boss", "man in a pinstripe suit"), ("lawyer", "silver-haired woman in a suit with a tablet"),
     ("journalist", "man with glasses in tweed"), ("policeman", "young police officer"),
     ("policewoman", "police officer"),
     ("detective", "grey-haired detective in a trench coat"), ("paramedic-f", "grey-haired paramedic with glasses"),
     ("paramedic", "paramedic with a walrus moustache"), ("guard", "security guard with a ponytail and sunglasses"),
     ("official", "official with glasses and a lanyard")],
]


def runs(mask):
    """(start, end) of the runs of True in a 1-D bool array."""
    edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(np.int8), [0]])))
    return list(zip(edges[::2], edges[1::2]))


def row_split(alpha):
    """The row between the two rows of panels with the least opaque pixels."""
    h = alpha.shape[0]
    cover = (alpha > 0).mean(1)
    lo, hi = int(h * 0.42), int(h * 0.58)
    return lo + int(np.argmin(cover[lo:hi]))


def seams(rgb, alpha, y0, y1):
    """x of the four seams between the panels of one row, where the colour jumps
    along the panels' lower part (all opaque there)."""
    band = rgb[y1 - int((y1 - y0) * 0.35):y1 - 10].astype(float)
    jump = np.median(np.abs(np.diff(band, axis=1)).sum(2), axis=0)
    w = rgb.shape[1]
    out = []
    for k in range(1, COLS):
        c = round(w * k / COLS)
        lo = c - w // 25
        out.append(lo + int(np.argmax(jump[lo:c + w // 25])))
    return out


def regenerated(path):
    """A regenerated portrait: near-opaque alpha made solid (the model leaves the
    panel faintly see-through), cropped to the figure, no taller than MAX_H."""
    p = Image.open(path).convert("RGBA")
    a = np.asarray(p).copy()
    alpha = a[..., 3]
    alpha[alpha > 224] = 255
    alpha[alpha < 16] = 0
    p = Image.fromarray(a)
    p = p.crop(p.getbbox())
    if p.height > MAX_H:
        p = p.resize((round(p.width * MAX_H / p.height), MAX_H), Image.LANCZOS)
    return p


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cast = []
    for n, people in enumerate(CAST, 1):
        im = Image.open(HERE / f"sheet{n}.webp").convert("RGBA")
        a = np.asarray(im)
        rgb, alpha = a[..., :3], a[..., 3]
        mid = row_split(alpha)
        for r, (y0, y1) in enumerate([(0, mid), (mid, a.shape[0])]):
            # The panels' bottom: the last row that is mostly opaque.
            filled = np.where((alpha[y0:y1] > 200).mean(1) > 0.5)[0]
            bottom = y0 + int(filled[-1]) + 1
            xs = [0, *seams(rgb, alpha, y0, bottom), a.shape[1]]
            for c in range(COLS):
                pid, who = people[r * COLS + c]
                p = im.crop((xs[c], y0, xs[c + 1], bottom - TRIM))
                # Sideways, the panel is the widest run of columns whose lower part is
                # opaque: the outer panels don't reach the sheet's edge, and a sliver of
                # a neighbour can sit past a gap.
                low = np.asarray(p)[-p.height // 5:, :, 3]
                x0, x1 = max(runs((low > 200).mean(0) > 0.9), key=lambda r: r[1] - r[0])
                top = p.getbbox()[1]
                p = p.crop((x0 + TRIM, top, x1 - TRIM, p.height))
                if (FACES / f"{pid}.webp").exists():
                    p = regenerated(FACES / f"{pid}.webp")
                p.save(OUT / f"{pid}.webp", quality=88, method=4)
                cast.append({"id": pid, "who": who, "w": p.width, "h": p.height})
                print(f"{pid:12} {p.width}×{p.height}")
    (OUT / "cast.json").write_text(json.dumps(cast, indent=1) + "\n")


if __name__ == "__main__":
    main()
