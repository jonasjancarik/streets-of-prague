"""What the bare ground is made of, decided cell by cell (ground_cover.py's build).

The first version cut a tile's bare ground into pieces (SLIC superpixels) and gave each
piece a class. The pieces of two tiles never met the same way at their shared edge, so a
patch could change class there. Here every 0.5 m cell is classified from what lies within a
few metres of it, the same numbers whichever tile is asking: a tile is worked out together
with a margin of its neighbours (MARGIN), and nothing below looks further than that margin,
so both tiles of an edge come to the same answer on both sides of it.

  measure()   per-pixel numbers from the photographs and the surface model (0.25 m)
  cells()     the same per 0.5 m cell
  local()     each cell's surroundings: means over the bare cells within a few metres
  rules()     the fixed thresholds of the first version, on those means
  material()  what hard ground is made of, from a model trained on OSM's surface= tags
              (cover_labels.py), in place of the rules' asphalt, gravel or dirt
  polygons()  class map -> smooth outlines, cut to the tile
"""

import json
from pathlib import Path

import numpy as np
from scipy import ndimage
from shapely.geometry import Polygon, box as shapely_box
from skimage.measure import find_contours

RES = 0.25      # m per pixel of the photographs as classified
CELL = 0.5      # m per cell of the class map
TREE = 2.5      # m above the ground: taller and green is a tree
MARGIN = 16.0   # m of the neighbouring tiles worked out with a tile
SIGMA = 2.5     # m: a cell's surroundings (about the 60 m2 of the first version's pieces)
WIDE = 4.0      # m: the wider surroundings the model also sees
NEAR = 8.0      # m: distances to buildings, streets, rails and green are only told apart up to here
VOTE = 21       # cells: the most common class within this window wins (about 10 m)
# The reach of everything above must stay inside the margin, or the tiles of an edge could
# disagree: surroundings (2.4 sigma), then the vote, then the smoothing of the outline.
assert max(SIGMA * 2.4, WIDE * 2.0, NEAR) + (VOTE // 2 + 4) * CELL <= MARGIN

CLASSES = ["grass", "trees", "asphalt", "paving", "concrete", "gravel", "dirt", "structure"]
HARD = ["asphalt", "paving", "concrete", "gravel", "dirt"]
MODEL = Path(__file__).with_name("cover_model.json")
LUMA = np.array([0.299, 0.587, 0.114], np.float32)


def down(a, f):
    """Average `a` over f x f blocks."""
    h, w = a.shape[:2]
    a = a[: h - h % f, : w - w % f]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def measure(rgb, cir, dsm, dtm, infrared=True):
    """Per-pixel numbers at RES. `cir` is the colour-infrared photograph (near infrared, red,
    green); without one (`infrared` False: ČÚZK's orthophoto) greenness comes from the colour
    photograph alone and is scaled to read like the infrared one on lawns and paving."""
    lum = rgb @ LUMA
    mx, mn = rgb.max(-1), rgb.min(-1)
    if infrared:
        nir, red, cg = cir[:, :, 0], cir[:, :, 1], cir[:, :, 2]
        ndvi = (nir - red) / (nir + red + 1e-3)
    else:
        r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        # (green leaf index: about 0.05 to 0.25 on vegetation, at or below 0 on bare ground)
        ndvi = np.clip((2 * g - r - b) / (2 * g + r + b + 1e-3) * 4.0 - 0.1, -0.5, 0.9)
        nir, red, cg = lum * (1 + ndvi), r, g
    k = int(1 / RES) + 1
    m1 = ndimage.uniform_filter(lum, k)
    tex = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, k) - m1 * m1, 0))
    ndsm = np.where(dsm > 0, dsm, dtm) - dtm
    return {"r": rgb[:, :, 0], "g": rgb[:, :, 1], "b": rgb[:, :, 2], "nir": nir, "cred": red, "cgreen": cg,
            "ndvi": ndvi, "lum": lum, "sat": (mx - mn) / (mx + 1e-3), "tex": tex,
            "warm": rgb[:, :, 0] - rgb[:, :, 2], "ndsm": ndsm}


def cells(P, mask):
    """The per-pixel numbers per CELL, and which cells are bare ground (most of their pixels)."""
    f = round(CELL / RES)
    C = {k: down(v, f) for k, v in P.items() if k != "ndsm"}
    ndsm = P["ndsm"]
    C["ndsm"] = down(np.clip(ndsm, -5, 30), f)
    C["green"] = down((P["ndvi"] > 0.2).astype(np.float32), f)
    C["tall"] = down((ndsm > TREE).astype(np.float32), f)
    C["low"] = down((ndsm < -1.2).astype(np.float32), f)
    C["dark"] = down((P["lum"] < 0.16).astype(np.float32), f)
    # How uneven the surface model is within 2 m: rubble and loose heaps against a sealed yard.
    C["rough"] = down(np.abs(np.clip(ndsm, -5, 30) - ndimage.uniform_filter(np.clip(ndsm, -5, 30), int(2 / RES) + 1)), f)
    return C, down(mask.astype(np.float32), f) > 0.5


def blur(a, sigma, reach):
    return ndimage.gaussian_filter(a, sigma / CELL, truncate=reach, mode="nearest")


def local(C, m, near=None):
    """Each cell's surroundings: the means of the bare cells round it (a Gaussian of SIGMA),
    their spread of brightness, how much bare ground there is, and for the model the wider
    means (WIDE) and how near buildings, streets, rails and green are (`near`: {name: mask})."""
    mf = m.astype(np.float32)
    w = blur(mf, SIGMA, 2.4)
    ok = np.maximum(w, 1e-3)
    L = {k: blur(v * mf, SIGMA, 2.4) / ok for k, v in C.items()}
    L["lum_sd"] = np.sqrt(np.maximum(blur(C["lum"] ** 2 * mf, SIGMA, 2.4) / ok - L["lum"] ** 2, 0))
    L["open"] = w
    w2 = blur(mf, WIDE, 2.0)
    ok2 = np.maximum(w2, 1e-3)
    for k in ("lum", "warm", "ndvi", "tex", "ndsm"):
        L[f"w_{k}"] = blur(C[k] * mf, WIDE, 2.0) / ok2
    L["w_open"] = w2
    total = L["r"] + L["g"] + L["b"] + 1e-3
    L["rn"], L["bn"] = L["r"] / total, L["b"] / total
    L["nir_lum"] = L["nir"] / (L["lum"] + 1e-3)
    for name in ("building", "road", "rail", "green"):
        mask = (near or {}).get(name)
        if mask is None or not mask.any():
            L[f"d_{name}"] = np.full(m.shape, NEAR, np.float32)
        else:
            L[f"d_{name}"] = np.minimum(ndimage.distance_transform_edt(~mask) * CELL, NEAR).astype(np.float32)
    return L


def rules(L, height=True):
    """The first version's thresholds (ground_cover.rules) on each cell's surroundings: the
    class of every cell, as an index into CLASSES. `height` False where no surface model newer
    than the building sites is at hand: then what stands tall and isn't green can't be told."""
    k = {c: n for n, c in enumerate(CLASSES)}
    green = (L["green"] > 0.45) | (L["ndvi"] > 0.2)
    trees = (L["tall"] > 0.4) | (L["lum"] < 0.42)
    not_ground = (L["lum"] < 0.38) & (L["warm"] < -0.03)   # a building's shadow, or a dark roof
    not_ground |= L["tex"] > 0.075                          # clutter: building sites, sheds, containers
    if height:
        not_ground |= (L["tall"] > 0.5) | (L["low"] > 0.5)  # sheds and roofs missing from OSM, building pits
    out = np.full(L["lum"].shape, k["gravel"], np.int8)
    out[L["lum"] > 0.74] = k["dirt"]                        # pale compacted ground
    out[(L["sat"] < 0.08) & (L["warm"] < 0.05) & (L["lum"] < 0.72)] = k["asphalt"]
    out[L["warm"] > 0.075] = k["dirt"]
    out[not_ground] = k["structure"]
    out[green & ~trees] = k["grass"]
    out[green & trees] = k["trees"]
    return out


FEATURES = ["r", "g", "b", "nir", "cred", "cgreen", "ndvi", "lum", "sat", "tex", "warm", "ndsm", "rough", "lum_sd",
            "dark", "green", "open", "rn", "bn", "nir_lum", "w_lum", "w_warm", "w_ndvi", "w_tex", "w_ndsm", "w_open",
            "d_building", "d_road", "d_rail", "d_green"]
_model = {}


def load_model(path=MODEL):
    path = Path(path)
    if path not in _model:
        _model[path] = json.loads(path.read_text()) if path.exists() else None
    return _model[path]


def vectors(L, where, names=FEATURES):
    return np.stack([L[k][where] for k in names], axis=1).astype(np.float64)


def predict(model, X):
    """Class index (into the model's own classes) for each row: a multinomial logistic
    regression on standardised features, kept as plain numbers in cover_model.json."""
    Z = (X - np.asarray(model["mean"])) / np.asarray(model["scale"])
    return (Z @ np.asarray(model["coef"]).T + np.asarray(model["intercept"])).argmax(1)


def material(cls, L, model):
    """Hard ground (what the rules call asphalt, gravel or dirt) given the model's material."""
    if not model:
        return cls
    hard = np.isin(cls, [CLASSES.index(c) for c in HARD])
    if hard.any():
        to = np.array([CLASSES.index(c) for c in model["classes"]], np.int8)
        cls = cls.copy()
        cls[hard] = to[predict(model, vectors(L, hard, model["features"]))]
    return cls


def classify(P, mask, near=None, model=None, height=True):
    """Class index per cell (-1: not bare ground) from the per-pixel numbers and the bare mask."""
    C, m = cells(P, mask)
    L = local(C, m, near)
    cls = material(rules(L, height), L, model)
    cls[~m] = -1
    return cls


def voted(cls):
    """The most common class within about 10 m of each bare cell, so small specks join what
    surrounds them instead of making a patchwork."""
    votes = np.stack([ndimage.uniform_filter((cls == k).astype(np.float32), VOTE, mode="nearest") for k in range(len(CLASSES))])
    return np.where(cls >= 0, votes.argmax(0), -1)


def polygons(smooth, origin, clip):
    """{class: polygons} in local metres from the voted class map, whose top-left cell corner
    is at `origin` (x, y), cut to the box `clip`. Structures (not ground) are left out."""
    x0, y1 = origin
    cut = shapely_box(*clip)
    out = {}
    for k, name in enumerate(CLASSES):
        if name == "structure" or not (smooth == k).any():
            continue
        m = ndimage.gaussian_filter(np.pad((smooth == k).astype(float), 1), 0.8)
        rings = [np.asarray([(x0 + (c - 1 + 0.5) * CELL, y1 - (r - 1 + 0.5) * CELL) for r, c in cs]) for cs in find_contours(m, 0.5)]
        g = Polygon()
        for r in rings:  # even-odd: holes are rings inside rings
            if len(r) > 3:
                g = g.symmetric_difference(Polygon(r).buffer(0))
        g = g.intersection(cut).simplify(0.25).buffer(0).intersection(cut)
        polys = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
        rs = [[[[round(x, 2), round(y, 2)] for x, y in ring.coords] for ring in (p.exterior, *p.interiors)] for p in polys if p.area > 0.5]
        if rs:
            out[name] = rs
    return out
