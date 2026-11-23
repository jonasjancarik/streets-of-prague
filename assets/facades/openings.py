"""Measure the openings in the shipped artwork. Per cell, store pixel edges
(left, top, right, bottom), arch rise and any separate panes, all in atlas pixels.
Run with pipeline/.venv/bin/python assets/facades/openings.py.
"""

from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd
from proportions import remap_rect

ROOT = Path(__file__).resolve().parents[2]
# Decorative blind niches and wall-only modules have no opening.
blank = {5, 11, 17, 23, 35, 41, 47, 113, 118, 129}
arched = {9, 18, 19, 20, 57, 67, 69, 73, 90, 93, 114, 115, 117, 141}
# The facade sheet includes shutters, grilles, balconies and basement lights.
# Crop to each actual opening before looking for its dark glass or joinery.
regions = {
    14: [(0.31, 0.10, 0.74, 0.83)],
    37: [(0.29, 0.22, 0.73, 0.75)],
    55: [(0.10, 0.11, 0.9, 0.72), (0.17, 0.76, 0.84, 0.99)],
    68: [(0.10, 0.08, 0.9, 0.69), (0.22, 0.74, 0.84, 0.98)],
    92: [(0.14, 0.05, 0.89, 0.69), (0.19, 0.73, 0.84, 0.98)],
    140: [(0.1, 0.07, 0.90, 0.73), (0.17, 0.74, 0.85, 0.99)],
    33: [(0, 0.45, 0.51, 0.94), (0.51, 0.45, 1, 0.94)],
    83: [(0, 0.39, 0.5, 0.96), (0.5, 0.39, 1, 0.96)],
    127: [(0, 0.45, 0.5, 0.94), (0.5, 0.45, 1, 0.94)],
}
manual = {
    10: [[72, 110, 184, 245, 0]],
    22: [[68, 331, 187, 426, 34]],
    19: [[27, 62, 226, 459, 105]],
    28: [[18, 65, 238, 418, 0]],
    29: [[75, 13, 178, 486, 0]],
    32: [[44, 84, 214, 417, 0]],
    40: [[58, 88, 202, 383, 0]],
    54: [[76, 89, 184, 290, 0]],
    56: [[48, 87, 202, 461, 0]],
    57: [[18, 85, 234, 464, 83]],
    64: [[47, 149, 209, 374, 0]],
    67: [[47, 89, 205, 451, 0]],
    68: [[60, 89, 193, 309, 0], [84, 393, 171, 449, 0]],
    73: [[61, 116, 191, 367, 44]],
    90: [[49, 76, 203, 459, 69]],
    101: [[96, 122, 175, 378, 0]],
    104: [[9, 64, 247, 411, 0]],
    114: [[48, 90, 207, 448, 76]],
    117: [[29, 264, 228, 434, 62]],
    122: [[12, 61, 244, 416, 0]],
    123: [[12, 61, 244, 416, 0]],
    124: [[83, 45, 179, 430, 0]],
    125: [[12, 61, 244, 416, 0]],
    138: [[53, 102, 199, 452, 0]],
    141: [[18, 85, 231, 459, 99]],
    143: [[62, 92, 194, 451, 0]],
    26: [[77, 165, 182, 279, 0]],
    34: [[16, 101, 241, 441, 0]],
    105: [[36, 133, 232, 441, 0]],
    130: [[62, 103, 192, 395, 0]],
}


def measure(im, i):
    if i in blank:
        return []
    if i in manual:
        return [remap_rect(rect, i) for rect in manual[i]]
    rgb = np.asarray(im, dtype=float)
    lum = rgb @ np.array([0.28, 0.57, 0.15])
    wall = np.percentile(lum, 83)
    r, g, b = rgb.transpose(2, 0, 1)
    mask = (lum < min(145, wall * 0.77)) & ((b - r > 3) | (r - b > 11) | (lum < 52))
    found = []
    for x0, y0, x1, y1 in regions.get(i, [(0, 0.015, 1, 0.985)]):
        x, y, X, Y = round(x0 * 256), round(y0 * 512), round(x1 * 256), round(y1 * 512)
        m = nd.binary_closing(mask[y:Y, x:X], structure=np.ones((15, 23)))
        lab, n = nd.label(m)
        if not n:
            continue
        sizes = np.bincount(lab.ravel())
        sizes[0] = 0
        target = lab == np.argmax(sizes)
        yy, xx = np.where(target)
        if len(xx) < 280:
            continue
        left, right = np.percentile(xx, [1, 99])
        top, bot = np.percentile(yy, [1, 99])
        if right - left < 19 or bot - top < 20:
            continue
        if (right - left) * (bot - top) > 0.9 * 256 * 512:
            continue
        rise = min((right - left) * 0.40, (bot - top) * 0.28) if i in arched else 0
        # In sash windows the white meeting rail may split the glazing into
        # disconnected panes. Measure all of the coloured glass, not just one.
        if i % 12 < 6 and i not in {28, 29, 40, 97, 100, 101, 122, 123, 124}:
            ink = (b - r > 5) & (lum < 124)
            ink[:20] = False
            ink[-20:] = False
            yy2, xx2 = np.where(ink[y:Y, x:X])
            if len(xx2) > 250:
                left, right = np.percentile(xx2, [0.8, 99.2])
                top, bot = np.percentile(yy2, [0.8, 99.2])
                rise = min((right - left) * 0.4, (bot - top) * 0.28) if i in arched else 0
        found.append([round(left + x), round(top + y), round(right + x), round(bot + y), round(rise)])
    return found


def bake(preview=None):
    atlas = Image.open(ROOT / "public/facades.webp").convert("RGB")
    ornament = Image.open(ROOT / "public/facades-mask.webp").convert("L")
    finish = Image.new("RGB", (6 * 64, 24 * 128))
    caps = []
    out = []
    review = Image.new("RGB", (12 * 70, 12 * 132), "#252627")
    d = ImageDraw.Draw(review)
    for i in range(144):
        x, y = i % 6 * 256, i // 6 * 512
        im = atlas.crop((x, y, x + 256, y + 512))
        rects = measure(im, i)
        # Preserve the original sash and transom between individual panes.
        # Only accept fairly rectangular islands of blue glass inside the aperture.
        rgb = np.asarray(im, dtype=float)
        red, green, blue = rgb.transpose(2, 0, 1)
        glass = (blue > red + 4) & (rgb.mean(2) < 128)
        for rect in rects:
            l, t, r, b, arch = rect
            if i in {
                19,
                26,
                28,
                29,
                34,
                40,
                44,
                54,
                57,
                68,
                69,
                92,
                93,
                97,
                100,
                104,
                105,
                114,
                117,
                122,
                123,
                125,
                130,
                140,
                141,
            }:
                continue
            crop = nd.binary_closing(glass[t:b, l:r], structure=np.ones((3, 3)))
            lab, n = nd.label(crop)
            panes = []
            for j, sl in enumerate(nd.find_objects(lab), 1):
                if not sl:
                    continue
                sy, sx = sl
                w, h = sx.stop - sx.start, sy.stop - sy.start
                if w < 11 or h < 13 or w * h < 0.025 * (r - l) * (b - t) or np.mean(lab[sl] == j) < 0.72:
                    continue
                x0 = max(l + 5, l + sx.start)
                x1 = min(r - 5, l + sx.stop)
                y0 = max(t + 5, t + sy.start)
                y1 = min(b - 5, t + sy.stop)
                if x1 - x0 > 7 and y1 - y0 > 8:
                    panes.extend([x0, y0, x1, y1])
            if 2 <= len(panes) // 4 <= 9:
                rect.extend(panes)
        out.append(rects)
        lum = rgb @ np.array([0.28, 0.57, 0.15])
        edge = np.median(np.hstack([lum[:, :12], lum[:, -12:]]), axis=1)
        ratio = np.clip(nd.gaussian_filter1d(edge, 0.8) / max(1, np.median(edge)), 0.40, 1.20)
        footprint = Image.new("L", (256, 512))
        pen = ImageDraw.Draw(footprint)
        for l, t, r, b, rise, *_ in rects:
            pen.rounded_rectangle((l - 16, t - 20, r + 16, b + 22), radius=12, fill=255)
        mask = np.maximum(np.asarray(footprint), np.asarray(ornament.crop((x, y, x + 256, y + 512))))
        cap = []
        if rects and i in {
            *range(0, 5),
            12,
            13,
            15,
            *range(48, 54),
            *range(60, 66),
            *range(72, 77),
            *range(84, 90),
            *range(132, 138),
        }:
            l, t, r, b, *_ = rects[0]
            # Trace the hood above this sash against its row of plain plaster. A
            # Baroque arch and a triangular pediment retain their different outlines.
            area = abs(lum - edge[:, None]) > 16
            area[:5] = False
            area[max(0, t - 7) :] = False
            area[:, : max(3, round(l - (r - l) * 0.43))] = False
            area[:, min(253, round(r + (r - l) * 0.43)) :] = False
            area = nd.binary_closing(area, structure=np.ones((5, 9)))
            labels, count = nd.label(area)
            if count:
                sizes = np.bincount(labels.ravel())
                sizes[0] = 0
                selected = labels == np.argmax(sizes)
                yy, xx = np.where(selected)
                if len(xx) > 350 and xx.max() - xx.min() > (r - l) * 0.72:
                    bottom = min(t - 4, int(yy.max()) + 2)
                    xs = np.unique(np.linspace(xx.min(), xx.max(), 13).astype(int))
                    for q in xs:
                        ys = yy[abs(xx - q) < 5]
                        if len(ys):
                            cap.append([int(q), max(4, int(np.percentile(ys, 4)) - 1)])
                    if len(cap) > 3 and bottom - min(q[1] for q in cap) > 7:
                        cap += [[cap[-1][0], bottom], [cap[0][0], bottom]]
                    else:
                        cap = []
        caps.append(cap)
        if cap:
            pen.polygon([tuple(q) for q in cap], fill=255)
        # Keep carved cartouches, shutters and aprons outside the aperture.
        # Only the outer pier needs to lose the picture's background: otherwise
        # the highest carvings on the portal can disappear into bare render.
        ornament_region = np.zeros_like(lum, dtype=bool)
        for l, t, r, b, *_ in rects:
            ornament_region[max(0, t - 115) : min(512, b + 78), max(0, l - 52) : min(256, r + 52)] = True
        relief = nd.binary_closing(
            (abs(lum - edge[:, None]) > 10) & ornament_region, structure=np.ones((7, 9))
        )
        relief = nd.binary_dilation(nd.binary_fill_holes(relief), iterations=5)
        mask = np.maximum.reduce([mask, np.asarray(footprint), relief.astype(np.uint8) * 255]).astype(float)
        mask = nd.gaussian_filter(mask, 3)
        mask *= np.clip(np.minimum(np.arange(256), np.arange(255, -1, -1)) / 7, 0, 1)[None, :]
        # R isolates local joinery / ornament, G carries a tileable horizontal
        # profile taken from that wall's actual stone joints.
        packed = np.stack(
            [mask, np.broadcast_to(((ratio - 0.25) / 1.25 * 255)[:, None], mask.shape), np.zeros_like(mask)],
            axis=-1,
        )
        finish.paste(
            Image.fromarray(np.uint8(packed)).resize((64, 128), Image.Resampling.LANCZOS),
            (i % 6 * 64, i // 6 * 128),
        )
        box = ImageDraw.Draw(im)
        for l, t, r, b, a, *panes in rects:
            box.rectangle((l, t, r, b), outline="#ff3838", width=4)
            for j in range(0, len(panes), 4):
                box.rectangle(panes[j : j + 4], outline="#ffdc55", width=2)
        x, y = i % 12 * 70, i // 12 * 132
        review.paste(im.resize((64, 110)), (x, y))
        d.text((x, y + 110), str(i))
    (ROOT / "src/map/facadeOpenings.json").write_text(
        "[\n" + ",\n".join(json.dumps(row, separators=(",", ":")) for row in out) + "\n]\n"
    )
    (ROOT / "src/map/facadeCaps.json").write_text(
        "[\n" + ",\n".join(json.dumps(row, separators=(",", ":")) for row in caps) + "\n]\n"
    )
    finish.save(ROOT / "public/street-facade-masks.webp", quality=95, method=6)
    if preview:
        review.save(preview)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="optional annotated contact sheet")
    bake(parser.parse_args().preview)
