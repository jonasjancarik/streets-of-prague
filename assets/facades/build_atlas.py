"""Cut the facade sheets into modules and pack them into public/facades.webp.

Each sheet (sheetN.webp, generated from the brief in sheetN.txt with the first sheet as
a style reference) is a grid of 6 × 2 cells, upper floors on top and ground floors below,
between pinkish-magenta gutters. The gutters are found from the colours, since the image
model never puts them exactly where asked. Every cell is scaled to 256 × 512 and the
sheets are stacked, one under another, in the order src/facades.ts expects.

It also writes public/facades-mask.webp, the same size: white where an upper floor's
module has ornament round its window (frames, pediments, sills, stucco panels), black on
the flat wall, so the game can draw a building's stucco a lighter shade than its wall.
Ground floors stay black: their rustication and grooves read as ornament and came out in
patches.

usage: cd pipeline && uv run python ../assets/facades/build_atlas.py   (Pillow, numpy, scipy)
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

HERE = Path(__file__).parent
OUT = HERE.parent.parent / "public" / "facades.webp"
MASK = OUT.with_name("facades-mask.webp")
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


def ornament(cell):
    """The ornament mask of an upper floor's module (see the docstring), 0-255."""
    c = np.asarray(cell).astype(np.float32) / 255
    hi, lo = c.max(2), c.min(2)
    sat = (hi - lo) / np.maximum(hi, 1e-3)
    lum = c @ np.array([0.299, 0.587, 0.114], np.float32)
    plaster = (sat < 0.12) & (lum > 0.35)
    # Detail: changes in brightness. A band across the whole cell (a string course, a
    # groove) counts by its vertical edges only.
    gx = np.abs(np.diff(lum, axis=1, append=lum[:, -1:]))
    gy = np.abs(np.diff(lum, axis=0, append=lum[-1:]))
    d = np.maximum(gx, gy) > 0.03
    rows = d.mean(1) > 0.8
    d[rows] = gx[rows] > 0.03
    m = Image.fromarray((d & plaster).astype(np.uint8) * 255)
    for f in (ImageFilter.MaxFilter(15), ImageFilter.MinFilter(15), ImageFilter.MinFilter(5), ImageFilter.MaxFilter(5)):
        m = m.filter(f)  # close the outlines of frames into solid shapes
    m = np.asarray(m) > 127
    # Thin horizontal lines between the windows are wall; so is anything far from an opening.
    m = ndimage.binary_opening(m, structure=np.ones((11, 1)))
    m &= ndimage.binary_dilation(~plaster & (lum < 0.5) | (sat > 0.2), iterations=36)
    lab, n = ndimage.label(m)
    if n:
        size = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        m = np.isin(lab, 1 + np.flatnonzero(size >= 900))
    m = Image.fromarray(m.astype(np.uint8) * 255).filter(ImageFilter.GaussianBlur(1.5))
    return (np.asarray(m) * plaster).astype(np.uint8)


def main():
    sheets = sorted(HERE.glob("sheet*.webp"), key=lambda p: int(p.stem[5:]))  # sheet10 after sheet9
    atlas = Image.new("RGB", (CELL[0] * COLS, CELL[1] * ROWS * len(sheets)))
    mask = Image.new("L", atlas.size)
    for s, path in enumerate(sheets):
        for i, cell in enumerate(cells(path)):
            at = ((i % COLS) * CELL[0], (s * ROWS + i // COLS) * CELL[1])
            atlas.paste(cell, at)
            if i < COLS:
                mask.paste(Image.fromarray(ornament(cell)), at)
    atlas.save(OUT, quality=88)
    mask.convert("RGB").save(MASK, quality=80)
    print(f"{OUT}: {len(sheets)} sheets, {atlas.size[0]} x {atlas.size[1]}, {OUT.stat().st_size // 1024} kB; mask {MASK.stat().st_size // 1024} kB")


if __name__ == "__main__":
    main()
