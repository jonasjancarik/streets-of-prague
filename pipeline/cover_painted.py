"""The painted photo (?ortho) tried other ways, for judging side by side. Nothing here
changes what `ground_cover.py ortho` bakes: each variant is written as one picture of a
block of tiles (from the photographs `ground_cover.py fetch` left in .cache/cover/img/rgb),
with the map's buildings and streets drawn over it the way the game covers them.

    uv run --group cover cover_painted.py praha 51 53 53 55 --out <folder>
    uv run --group cover cover_painted.py praha 51 53 53 55 --out <folder> --only brush,palette

Variants (todo.md, "Painted photo"):
  photo     the photograph itself, for reference
  current   what `ortho` bakes: every tile filtered on its own (mirrored at its edges), 0.5 m
  margin    the same brush over the tiles joined together, so strokes cross the tile edges
  brush     a bigger, more stretched brush (9 px, 3.5 to 1)
  metre     1 m a pixel (the same brush is then twice as big on the ground)
  two       2 m a pixel
  shadows   cast shadows lifted to the brightness of the lit ground round them, then painted
  palette   painted, then every colour pulled towards the nearest of the game's ground colours
  all       1 m, the bigger brush, shadows lifted, the game's colours, across tile edges
"""

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import fft, ndimage

CACHE = Path(__file__).parent / ".cache" / "cover"
LUM = np.array([0.299, 0.587, 0.114], np.float32)
# The game's ground colours (src/ground.ts, COLORS and the cover layers).
PALETTE = ["#92908c", "#d7d3cb", "#9c958a", "#d8cbb6", "#bfa87e", "#79a24c", "#80a552", "#394a2b", "#b9b27a",
           "#85837e", "#99948a", "#bba888", "#6b6a68", "#8fa860", "#b39d78", "#a39d92", "#aeaaa0", "#6e7174", "#cdbfa8"]


def hex_rgb(h):
    return np.array([int(h[k:k + 2], 16) for k in (1, 3, 5)], np.float32) / 255


def kuwahara(img, radius=5, q=8, stretch=2.0, angles=8):
    """ground_cover.kuwahara (anisotropic Kuwahara), with the picture transformed once and
    every sector's mean taken in the frequency domain: the same result, several times faster."""
    img = img.astype(np.float32)
    h, w = img.shape[:2]
    lum = img @ LUM
    gx, gy = ndimage.sobel(lum, 1), ndimage.sobel(lum, 0)
    jxx, jxy, jyy = (ndimage.gaussian_filter(a, 2.0) for a in (gx * gx, gx * gy, gy * gy))
    tr, det = jxx + jyy, np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2)
    l1, l2 = (tr + det) / 2, (tr - det) / 2
    aniso = np.where(l1 + l2 > 1e-6, (l1 - l2) / (l1 + l2 + 1e-9), 0)
    phi = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2
    R = int(math.ceil(radius * max(stretch, 1)))
    rr = np.arange(-R, R + 1)
    yy, xx = np.meshgrid(rr, rr, indexing="ij")
    shape = (fft.next_fast_len(h + 2 * R, real=True), fft.next_fast_len(w + 2 * R, real=True))
    pad = np.pad(img, ((R, shape[0] - h - R), (R, shape[1] - w - R), (0, 0)), mode="reflect")
    FI = fft.rfft2(pad, axes=(0, 1), workers=2)
    FS = fft.rfft2(pad * pad, axes=(0, 1), workers=2)

    def filt(theta, s):
        c, si = math.cos(theta), math.sin(theta)
        u = (xx * c + yy * si) / (radius * s)
        v = (-xx * si + yy * c) / (radius / s)
        r2 = u * u + v * v
        g = np.exp(-r2 * 2) * (r2 <= 1)
        ang = np.arctan2(v, u)
        num, den = 0, 0
        for k in range(8):
            d = np.angle(np.exp(1j * (ang - k * np.pi / 4)))
            wk = g * np.exp(-(d / (np.pi / 8)) ** 2 * 2)
            wk /= wk.sum()
            ker = np.zeros(shape, np.float32)
            ker[:2 * R + 1, :2 * R + 1] = wk
            FK = fft.rfft2(np.roll(ker, (-R, -R), (0, 1)), workers=2)[..., None]
            m = fft.irfft2(FI * FK, s=shape, axes=(0, 1), workers=2)[R:R + h, R:R + w]
            m2 = fft.irfft2(FS * FK, s=shape, axes=(0, 1), workers=2)[R:R + h, R:R + w]
            var = np.maximum(m2 - m * m, 0).sum(-1)
            a = 1 / (1 + 255 * var) ** q
            num = num + m * a[..., None]
            den = den + a
        return num / den[..., None]

    iso = filt(0, 1)
    out = iso.copy()
    bins = np.round(phi / (np.pi / angles)).astype(int) % angles
    for b in range(angles):
        sel = bins == b
        if sel.any():
            out[sel] = filt(b * np.pi / angles, stretch)[sel]
    a = np.clip(aniso * 1.5, 0, 1)[..., None]
    return iso * (1 - a) + out * a


def tone(img):
    """ortho()'s step towards the game's look: a little less contrast and saturation."""
    lum = img @ LUM
    img = lum[..., None] + (img - lum[..., None]) * 0.8
    return 0.5 + (img - 0.5) * 0.85 + 0.03


def down(a, f):
    h, w = a.shape[:2]
    a = a[: h - h % f, : w - w % f]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def lift_shadows(img, px):
    """Cast shadows brought up to the lit ground round them. A shadow in the photograph is
    darker than its surroundings and bluer (lit by the sky alone); its brightness is scaled
    to the mean of the lit pixels within about 40 m, and its blue cast taken off."""
    lum = img @ LUM
    k = max(int(40 / px) | 1, 3)
    around = ndimage.uniform_filter(lum, k)
    blue = img[..., 2] - img[..., 0]
    shade = np.clip((0.72 * around - lum) / (0.25 * around + 1e-3), 0, 1) * np.clip((blue + 0.03) / 0.05, 0, 1)
    shade = ndimage.gaussian_filter(shade, max(1.0 / px, 0.6))
    lit = 1 - shade
    lit_mean = ndimage.uniform_filter(lum * lit, k) / (ndimage.uniform_filter(lit, k) + 1e-3)
    dark_mean = ndimage.uniform_filter(lum * shade, k) / (ndimage.uniform_filter(shade, k) + 1e-3)
    gain = np.clip(lit_mean / (dark_mean + 1e-3), 1, 2.6)
    g = 1 + (gain - 1) * shade
    out = img * g[..., None]
    cast = (shade * 0.5)[..., None] * np.array([0.5, 0.0, -0.5], np.float32) * np.clip(blue, 0, None)[..., None]
    return np.clip(out + cast * g[..., None], 0, 1)


def to_palette(img, pull=0.65):
    """Every colour pulled towards the game's nearest ground colour (softly: the nearest few
    share the pull by closeness), keeping part of the photograph's own shading."""
    pal = np.stack([hex_rgb(h) for h in PALETTE])
    flat = img.reshape(-1, 3)
    d = ((flat[:, None, :] - pal[None]) ** 2).sum(-1)
    wgt = np.exp(-(d - d.min(1, keepdims=True)) / 0.004)
    target = (wgt[..., None] * pal[None]).sum(1) / wgt.sum(1, keepdims=True)
    lum, tl = flat @ LUM, target @ LUM
    target = target + ((lum - tl) * 0.35)[:, None]  # (some of the photo's light and dark stays)
    return (flat * (1 - pull) + target * pull).reshape(img.shape)


def mosaic(tiles, f):
    """The photographs of a block of tiles joined, at 0.25 m x f a pixel, and the tile size in pixels."""
    rows = []
    js = sorted({j for _, j in tiles}, reverse=True)
    for j in js:
        rows.append(np.concatenate([down(np.load(CACHE / "img" / "rgb" / f"{i}_{j}.npy"), f) for i in sorted({i for i, _ in tiles})], 1))
    img = np.concatenate(rows, 0)
    return img, img.shape[0] // len(js)


def per_tile(img, n, fn, pad=12):
    out = np.empty_like(img)
    for r in range(0, img.shape[0], n):
        for c in range(0, img.shape[1], n):
            t = np.pad(img[r:r + n, c:c + n], ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
            out[r:r + n, c:c + n] = fn(t)[pad:-pad, pad:-pad]
    return out


VARIANTS = {
    # name: (0.25 m pixels joined into one, every tile on its own, brush radius, stretch, shadows, palette)
    "photo": (2, False, None, None, False, False),
    "current": (2, True, 5, 2.0, False, False),
    "margin": (2, False, 5, 2.0, False, False),
    "brush": (2, False, 9, 3.5, False, False),
    "metre": (4, False, 5, 2.0, False, False),
    "two": (8, False, 4, 2.0, False, False),
    "shadows": (2, False, 5, 2.0, True, False),
    "palette": (2, False, 5, 2.0, False, True),
    "all": (4, False, 7, 3.0, True, True),
}


def paint(name, tiles):
    f, alone, radius, stretch, shadows, palette = VARIANTS[name]
    img, n = mosaic(tiles, f)
    px = 0.25 * f
    if shadows:
        img = lift_shadows(img, px)
    if radius:
        fn = lambda a: kuwahara(a, radius=radius, stretch=stretch)
        img = per_tile(img, n, fn) if alone else fn(img)
        if palette:
            img = to_palette(img)
        img = tone(img)
    return np.clip(img, 0, 1), px


def overlay(img, px, area, tiles, scale):
    """The map drawn over the picture as the game covers it: areas, streets and buildings in
    the game's colours (flat, no patterns), so only the plain ground shows the painting."""
    from ground_cover import tile_json
    colours = {"road": "#6b6a68", "sett": "#8a847a", "path": "#d8cbb6", "park": "#79a24c", "garden": "#80a552", "wood": "#394a2b",
               "water": "#4d7680", "parking": "#72706c", "square": "#d7d3cb", "square_setts": "#9c958a", "dtm_yard": "#85837e",
               "dtm_green": "#79a24c", "dtm_garden": "#80a552", "dtm_wood": "#394a2b", "pitch": "#6c9c55", "meadow": "#8fa860",
               "lawn": "#79a24c", "pavement": "#92908c"}
    up = Image.fromarray((img * 255).astype(np.uint8)).resize((round(img.shape[1] * px * scale), round(img.shape[0] * px * scale)), Image.BICUBIC)
    d = ImageDraw.Draw(up)
    i0, j1 = min(i for i, _ in tiles), max(j for _, j in tiles)
    first = tile_json(area, i0, j1)
    x0, y1 = first["box"][0], first["box"][3]
    xy = lambda ring: [((x - x0) * scale, (y1 - y) * scale) for x, y in ring]
    for i, j in tiles:
        t = tile_json(area, i, j)
        for kind, polys in [*t["areas"].items(), *t["roads"].items()]:
            if kind.startswith("cover_"):
                continue
            col = colours.get(kind, "#92908c")
            for rings in polys:
                if len(rings[0]) > 2:
                    d.polygon(xy(rings[0]), fill=col)
        for b in t["buildings"]:
            if len(b["rings"][0]) > 2:
                d.polygon(xy(b["rings"][0]), fill="#b9a488", outline="#8f7f6a")
    return up


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("area")
    ap.add_argument("tiles", nargs=4, type=int, metavar="I0 I1 J0 J1")
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", help="comma-separated variant names")
    ap.add_argument("--scale", type=float, default=2.0, help="pixels a metre in the pictures written")
    args = ap.parse_args()
    i0, i1, j0, j1 = args.tiles
    tiles = [(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for name in (args.only.split(",") if args.only else VARIANTS):
        started = time.time()
        img, px = paint(name, tiles)
        raw = Image.fromarray((img * 255).astype(np.uint8))
        raw.save(out / f"{name}-ground.jpg", quality=80, optimize=True)
        kb = (out / f"{name}-ground.jpg").stat().st_size / 1024 / len(tiles)
        overlay(img, px, args.area, tiles, args.scale).save(out / f"{name}.jpg", quality=88)
        (out / f"{name}.json").write_text(json.dumps({"variant": name, "m_per_px": px, "kb_per_tile": round(kb, 1), "seconds": round(time.time() - started)}))
        print(f"{name}: {px} m/px, {kb:.0f} KB a tile, {time.time() - started:.0f} s", flush=True)


if __name__ == "__main__":
    main()
