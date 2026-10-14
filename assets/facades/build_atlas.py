"""Cut the facade sheets into modules and pack them into public/facades.webp.

Each sheet (sheetN.webp, generated from the brief in sheetN.txt with the first sheet as
a style reference) is a grid of 6 × 2 cells, upper floors on top and ground floors below,
between pinkish-magenta gutters. The gutters are found from the colours, since the image
model never puts them exactly where asked. Every cell is scaled to 256 × 512 and the
sheets are stacked, one under another, in the order src/facades.js expects.

usage: python3 assets/facades/build_atlas.py   (needs Pillow and numpy)
"""
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
OUT = HERE.parent.parent / "public" / "facades.webp"
CELL = (256, 512)
COLS, ROWS = 6, 2


def runs(mask):
    """(start, end) of the runs of True in a 1-D bool array."""
    out, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def cells(path):
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    # Anywhere from dusky pink to magenta; failing that, the palest pink (sheet 5's
    # gutters came out barely tinted, next to neutral grey plaster).
    for gutter in ((r - g > 12) & (b - g > 8), (r - g > 7) & (b - g > 1) & (r - b > 2)):
        cols = [c for c in runs(~(gutter.mean(axis=0) > 0.6)) if c[1] - c[0] > a.shape[1] * 0.05]
        rows = [c for c in runs(~(gutter.mean(axis=1) > 0.6)) if c[1] - c[0] > a.shape[0] * 0.1]
        if (len(cols), len(rows)) == (COLS, ROWS):
            break
    else:
        raise SystemExit(f"{path.name}: found {len(cols)} x {len(rows)} cells, not {COLS} x {ROWS}")
    for y0, y1 in rows:
        for x0, x1 in cols:
            # Trim any gutter fringe left at the cell's edges, then a little more.
            edge = lambda: gutter[y0:y1, x0:x1]  # noqa: E731
            while edge()[:, 0].mean() > 0.2: x0 += 1  # noqa: E701
            while edge()[:, -1].mean() > 0.2: x1 -= 1  # noqa: E701
            while edge()[0].mean() > 0.2: y0 += 1  # noqa: E701
            while edge()[-1].mean() > 0.2: y1 -= 1  # noqa: E701
            yield im.crop((x0 + 3, y0 + 3, x1 - 3, y1 - 3)).resize(CELL, Image.LANCZOS)


def main():
    sheets = sorted(HERE.glob("sheet*.webp"), key=lambda p: int(p.stem[5:]))  # sheet10 after sheet9
    atlas = Image.new("RGB", (CELL[0] * COLS, CELL[1] * ROWS * len(sheets)))
    for s, path in enumerate(sheets):
        for i, cell in enumerate(cells(path)):
            atlas.paste(cell, ((i % COLS) * CELL[0], (s * ROWS + i // COLS) * CELL[1]))
    atlas.save(OUT, quality=88)
    print(f"{OUT}: {len(sheets)} sheets, {atlas.size[0]} x {atlas.size[1]}, {OUT.stat().st_size // 1024} kB")


if __name__ == "__main__":
    main()
