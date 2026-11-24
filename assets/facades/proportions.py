"""Map the artist's padded elevations to the proportions of a real storey.

Stretch the lights between four fixed edges and take the extra space from
the surrounding wall. The edge of the bay, lintel ornament and apron survive
even when the window grows substantially. Coordinates are source-atlas pixels.
"""
import numpy as np
from PIL import Image, ImageDraw


def axes(layer):
    x, y = (), ()
    if layer in (28, 122, 123, 125):  # loggia soffit, handrail and slab
        y = ((64, 15), (265, 319), (418, 493))
    elif layer in (27, 120, 121, 131):
        y = ((140, 89), (274, 365))
        if layer == 27:
            x = ((53, 35), (205, 221))
    elif layer in (108, 109, 110, 112):  # small early burgher-house casement
        x, y = ((85, 65), (170, 191)), ((181, 122), (296, 365))
    elif layer in (0, 1, 2, 3, 12, 13, 15, *range(48, 54), *range(60, 66),
                    *range(72, 77), *range(84, 90), *range(132, 138)):
        x, y = ((68, 47), (185, 207)), ((150, 106), (360, 395))
    elif layer == 25:  # steel ribbon, narrow posts between adjacent glazed units
        x, y = ((19, 7), (236, 249)), ((187, 93), (264, 363))
    elif layer in (24, 36, 37, 39, 96, 98):
        y = ((144, 110), (300, 360))
    elif layer in (21, 43, 54, 55, 68, 78, 92, 116, 140):
        # Raised ground-floor apartments. Keep the cellar row beneath them.
        x, y = ((63, 46), (192, 208)), ((100, 78), (295, 322), (380, 380))
    return ([(0, 0), *x, (256, 256)], [(0, 0), *y, (512, 512)])


def remap(cell, layer):
    xs, ys = axes(layer)
    if len(xs) == len(ys) == 2:
        return cell
    out = Image.new(cell.mode, cell.size)
    for (left, l), (right, r) in zip(xs, xs[1:]):
        for (top, t), (bottom, b) in zip(ys, ys[1:]):
            out.paste(cell.resize((r - l, b - t), Image.Resampling.LANCZOS,
                                  box=(left, top, right, bottom)), (l, t))
    return out


def remap_rect(rect, layer):
    xs, ys = axes(layer)
    def at(q, axis):
        old, new = zip(*axis)
        return round(float(np.interp(q, old, new)))
    l, t, r, b, rise = rect
    return [at(l, xs), at(t, ys), at(r, xs), at(b, ys), at(t + rise, ys) - at(t, ys)]


# Areas that retain their glass, metal, terrazzo or shaded balcony finish
# when the surrounding render is repainted. Includes sashes and canopy edges.
PANEL_FITTINGS = {
    27: [(48, 151, 212, 294)], 28: [(11, 60, 246, 434)], 29: [(70, 0, 186, 512)],
    32: [(24, 48, 230, 428)], 33: [(32, 312, 225, 399)], 35: [],
    120: [(22, 133, 233, 284)], 121: [(28, 132, 231, 278)],
    122: [(10, 58, 247, 426)], 123: [(8, 58, 247, 426)], 124: [(77, 38, 186, 439)],
    125: [(10, 58, 247, 426)],
    126: [(10, 50, 247, 373)], 127: [(17, 300, 235, 400)], 128: [(12, 68, 243, 299)],
    129: [], 130: [(54, 95, 201, 407)], 131: [(21, 83, 231, 237)],
}


def panel_mask(layer):
    mask = Image.new("L", (256, 512), 255)
    draw = ImageDraw.Draw(mask)
    for box in PANEL_FITTINGS[layer]:
        draw.rectangle(box, fill=0)
    return remap(mask, layer)


def enclosed_loggia(open_bay):
    """The same loggia retrofitted with sliding glass above its parapet."""
    rgb = np.asarray(open_bay, dtype=float).copy()
    glass = rgb[15:319, 12:244]
    reflection = np.linspace(.34, .13, glass.shape[0])[:, None, None]
    glass[:] = glass * (1 - reflection) + np.array([164, 185, 197]) * reflection
    cell = Image.fromarray(rgb.astype(np.uint8))
    d = ImageDraw.Draw(cell)
    for x in (89, 167):
        d.rectangle((x - 1, 15, x + 1, 319), fill='#bfc4c4')
        d.line((x + 2, 15, x + 2, 319), fill='#727879')
    d.rectangle((12, 15, 244, 19), fill='#bfc4c4')
    return cell


def precast_joints(cell):
    # A metre-wide patch seen obliquely needs filtered joints. Bake them
    # into the colour atlas so the existing mipmaps and anisotropy apply.
    rgb = np.asarray(cell, dtype=float).copy()
    rgb[:, :3] *= .78
    rgb[:, 3:4] *= 1.04
    rgb[:3] *= .77
    rgb[3:5] *= 1.05
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))

def interwar_cell(plaster, glazing, layer):
    """A divided casement or a glazed terrace door in undecorated render.
    Cell 113 adds the distant view of the balcony to the door in cell 41.
    """
    cell = plaster.crop((0, 8, 32, 504)).resize((256, 512), Image.Resampling.BICUBIC)
    box = (54, 106, 202, 384) if layer == 77 else (55, 98, 201, 484)
    cell.paste(glazing.resize((box[2]-box[0], box[3]-box[1]), Image.Resampling.LANCZOS), box)
    if layer == 113:
        draw = ImageDraw.Draw(cell)
        draw.rounded_rectangle((7, 336, 249, 502), radius=8, fill='#a6a49e')
        draw.rounded_rectangle((8, 336, 248, 484), radius=6, fill='#c2c0b9')
        draw.line((11, 337, 245, 337), fill='#e0ded7', width=3)
        for left in (32, 134):
            draw.rectangle((left, 451, left+74, 466), fill='#585a59')
        draw.line((13, 485, 244, 485), fill='#8b8984', width=3)
    return cell
