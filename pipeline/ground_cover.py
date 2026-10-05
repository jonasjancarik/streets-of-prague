"""Prototype (branch beige-ground): fill the plain beige ground, the part of a tile no
mapped area, street or building covers, from IPR Praha's aerial photographs.

Two ways, for comparing on a few tiles; the game shows them with ?cover=<method> and
?ortho (tiles.ts):

  ortho     the colour orthophoto itself, through an anisotropic Kuwahara filter so
            it reads as painted, baked into one JPEG per tile under the ground.
  classify  the photographs only decide what the ground is made of; the game draws it
            with its own procedural materials. The beige is cut into pieces (SLIC
            superpixels), and each piece is classified by one of:
              rules   fixed thresholds on greenness (infrared), height above the
                      ground (surface model minus terrain), brightness, colour, texture
              model   gradient boosting trained on the tiles round about, with labels
                      from what OSM and the tile data already say (roads are asphalt,
                      parks are grass, railway ballast is gravel, surface= tags...)
              jev     TypeSafe's Jev on a text summary of each piece (needs
                      TYPESAFE_API_KEY; without it the requests are only written out)
            Trees come from the surface model: the tops of the canopy.

    uv run --group cover ground_cover.py fetch praha 49 55 51 57     # tiles i0 i1 j0 j1
    uv run --group cover ground_cover.py ortho praha 51 53 53 55
    uv run --group cover ground_cover.py classify praha 51 53 53 55 --method rules
    uv run --group cover ground_cover.py train praha 49 55 51 57 --skip 51 53 53 55
    uv run --group cover ground_cover.py sheet praha 51 53 53 55      # crops to label by hand
    uv run --group cover ground_cover.py score praha 51 53 53 55      # every method against the labels

Sources (all downloaded once into pipeline/.cache/cover/):
  IPR Praha orthophoto 2024, colour and colour-infrared, 10 cm/px, ImageServer at
  gs-pub.praha.eu (CC BY 4.0, © IPR Praha); IPR's 2025 digital surface model, 1 m
  (AGO item "Digitální model povrchu - 1m", DSM_1m.zip, 1.5 GB, CC BY 4.0), unzipped
  into .cache/cover/dsm_ipr/ (without it, or with COVER_DSM=cuzk, ČÚZK's DMP 1G from
  2009-2013, 2 m, CC BY 4.0, © ČÚZK); IPR's technical land-use map (Mapa technického
  využití území, DTMP); the tile's own terrain heights (ipr_terrain.py).
"""

import argparse
import functools
import gzip
import io
import json
import math
import os
import pickle
import logging
import time
from collections import Counter
from pathlib import Path

import numpy as np
import requests
from PIL import Image, ImageDraw, ImageFont
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import LineString, Polygon, box as shapely_box, shape
from shapely.ops import transform as shapely_transform, unary_union
from skimage.feature import peak_local_max
from skimage.measure import find_contours, regionprops
from skimage.segmentation import slic

import build_cache
import layers
from osm_area import AREAS, OUT

CACHE = Path(__file__).parent / ".cache" / "cover"
RGB = "https://gs-pub.praha.eu/imgs/rest/services/ort/letecke_snimkovani/ImageServer"
CIR = "https://gs-pub.praha.eu/imgs/rest/services/ort/infracervene_letecke_snimkovani/ImageServer"
DSM = "https://ags.cuzk.gov.cz/arcgis2/rest/services/dmp1g/ImageServer"
DTMP = "https://gs-pub.praha.eu/arcgis/rest/services/dtmp/dtmp/MapServer/15/query"
RES = 0.25     # m per pixel for classifying
CELL = 0.5     # m per pixel for the pieces and the painted photo
TREE = 2.5     # m above the ground: taller and green is a tree
CLASSES = ["grass", "trees", "asphalt", "paving", "concrete", "gravel", "dirt", "structure"]
# How the game draws each (ground.ts, COVER): a colour and one of its patterns.
# Structures (unmapped roofs, sheds, parked lorries) stay beige.

logging.getLogger("tifffile").setLevel(logging.ERROR)  # (IPR's DSM carries a no-data tag it can't cast)
S = requests.Session()
S.headers["User-Agent"] = "streets-of-prague ground_cover prototype"


# --- Where things are ------------------------------------------------------------------

def local_proj(area):
    w, s, e, n = AREAS[area]
    return f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"


def tile_json(area, i, j):
    """The tile's map data, as first read: kept in the cache so the pieces (and the
    labels given to them by hand) stay put while the map is rebuilt."""
    snap = CACHE / "tiles" / area / f"{i}_{j}.json"
    if not snap.exists():
        snap.parent.mkdir(parents=True, exist_ok=True)
        snap.write_text((OUT / f"{area}_now" / "tiles" / f"{i}_{j}.json").read_text())
    return json.loads(snap.read_text())


def terrain(area, meta, t):
    """The tile's terrain heights (m a.s.l.) on the game's lattice, rows from the south.
    A tile's file holds n x n heights followed by one label byte each (ipr_terrain.py;
    the maps the prototype was first tried on had no labels)."""
    n, step = meta["terrain"]["n"], meta["terrain"]["step"]
    raw = gzip.decompress((OUT / f"{area}_now" / "tiles" / f"{t['i']}_{t['j']}.height.bin.gz").read_bytes())
    h = np.frombuffer(raw[: n * n * 2], dtype="<u2").astype(np.float32).reshape(n, n)
    return np.where(h > 0, h / 10 + 100, np.nan), step


def grid(t, res):
    """Pixel centres of a tile at `res` m, rows from the north."""
    x0, y0, x1, y1 = t["box"]
    w, h = round((x1 - x0) / res), round((y1 - y0) / res)
    xs = x0 + (np.arange(w) + 0.5) * res
    ys = y1 - (np.arange(h) + 0.5) * res
    return np.meshgrid(xs, ys)


@functools.lru_cache(maxsize=None)
def _transformers(area):
    # Through WGS84: the game's projection names only an ellipsoid, and straight to
    # S-JTSK PROJ falls back to a "ballpark" datum shift that is ~120 m off in Prague.
    to_ll = Transformer.from_crs(local_proj(area), "EPSG:4326", always_xy=True)
    return to_ll, Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)


SJTSK_NODES = 33  # a side of the lattice the tile's S-JTSK coordinates are worked out on
_sjtsk = (None, None)


def sjtsk(area, t, res):
    """S-JTSK easting and northing of the tile's pixel centres (flat, in grid() order).
    The projection is worked out on a lattice over the tile and the pixels are placed
    between its points: over a tile it bends by well under a millimetre, and projecting
    a million pixels one by one was most of a tile's time. The photographs and the
    surface model of a tile ask for the same pixels, so the last answer is kept."""
    global _sjtsk
    key = (area, tuple(t["box"]), res)
    if _sjtsk[0] == key:
        return _sjtsk[1]
    x0, y0, x1, y1 = t["box"]
    w, h = round((x1 - x0) / res), round((y1 - y0) / res)
    n = SJTSK_NODES
    NX, NY = np.meshgrid(np.linspace(x0, x1, n), np.linspace(y1, y0, n))
    to_ll, tf = _transformers(area)
    E, N = (np.reshape(a, (n, n)) for a in tf.transform(*to_ll.transform(NX.ravel(), NY.ravel())))

    def weights(m):  # (m, n): each pixel centre's share of the two lattice points round it
        at = (np.arange(m) + 0.5) / m * (n - 1)
        lo = np.minimum(at.astype(int), n - 2)
        W = np.zeros((m, n))
        W[np.arange(m), lo], W[np.arange(m), lo + 1] = 1 - (at - lo), at - lo
        return W
    Wy, Wx = weights(h), weights(w)
    _sjtsk = (key, ((Wy @ E @ Wx.T).ravel(), (Wy @ N @ Wx.T).ravel()))
    return _sjtsk[1]


def export(url, name, area, t, res, src_res, fmt="png", extra=None):
    """An ImageServer's picture of the tile, resampled onto the tile's own grid
    (S-JTSK is turned a few degrees against the game's grid), as float32 (h, w, bands)."""
    out = CACHE / "img" / name / f"{t['i']}_{t['j']}.npy"
    if out.exists():
        return np.load(out)
    X, Y = grid(t, res)
    E, N = sjtsk(area, t, res)
    bx0, by0, bx1, by1 = E.min() - 3, N.min() - 3, E.max() + 3, N.max() + 3
    w, h = math.ceil((bx1 - bx0) / src_res), math.ceil((by1 - by0) / src_res)
    params = {"bbox": f"{bx0},{by0},{bx1},{by1}", "bboxSR": 5514, "imageSR": 5514, "size": f"{w},{h}",
              "format": fmt, "f": "image", **(extra or {})}
    for attempt in range(4):
        try:
            r = S.get(f"{url}/exportImage", params=params, timeout=120)
            r.raise_for_status()
            break
        except requests.RequestException:
            if attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))
    if fmt == "tiff":
        import tifffile
        img = tifffile.imread(io.BytesIO(r.content)).astype(np.float32)
    else:
        img = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.float32) / 255
    if img.ndim == 2:
        img = img[:, :, None]
    cols = (E - bx0) / (bx1 - bx0) * img.shape[1] - 0.5
    rows = (by1 - N) / (by1 - by0) * img.shape[0] - 0.5
    bands = [ndimage.map_coordinates(img[:, :, b], [rows, cols], order=1, mode="nearest").reshape(X.shape)
             for b in range(img.shape[2])]
    arr = np.stack(bands, axis=-1).astype(np.float32)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, arr)
    return arr


IPR_DSM = CACHE / "dsm_ipr" / "DSM_1m.tif"  # unpacked from IPR's DSM_1m.zip (see ipr_dsm)
# Which height model the pieces' numbers come from: IPR's 2025 one once it's there.
DSM_SOURCE = os.environ.get("COVER_DSM") or ("ipr" if IPR_DSM.exists() else "cuzk")
_dsm = None


def ipr_dsm(area, t, res, cache=True):
    """IPR Praha's digital surface model (2025, 1 m, CC BY 4.0) on the tile's grid.
    One 35000 x 26000 float GeoTIFF for the whole city (AGO item "Digitální model
    povrchu - 1m", DSM_1m.zip), stored uncompressed in 128 px blocks, so only the
    blocks under the tile are read. Its world file puts the centre of the top-left
    pixel at S-JTSK (-757499.5, -1034000.5)."""
    global _dsm
    out = CACHE / "img" / "dsm_ipr" / f"{t['i']}_{t['j']}.npy"
    if cache and out.exists():
        return np.load(out)
    import tifffile
    if _dsm is None:
        tf_ = tifffile.TiffFile(IPR_DSM)
        page = tf_.pages[0]
        _dsm = (open(IPR_DSM, "rb"), page.shape, page.tilelength, page.tilewidth, page.dataoffsets)
    f, (H, W), th, tw, offsets = _dsm
    X, Y = grid(t, res)
    E, N = sjtsk(area, t, res)
    cols, rows = E + 757499.5, -1034000.5 - N
    c0, c1 = max(int(cols.min()) - 2, 0), min(int(cols.max()) + 3, W)
    r0, r1 = max(int(rows.min()) - 2, 0), min(int(rows.max()) + 3, H)
    win = np.full((r1 - r0, c1 - c0), np.nan, np.float32)
    per_row = -(-W // tw)
    for ty in range(r0 // th, (r1 - 1) // th + 1):
        for tx in range(c0 // tw, (c1 - 1) // tw + 1):
            f.seek(offsets[ty * per_row + tx])
            block = np.frombuffer(f.read(th * tw * 4), "<f4").reshape(th, tw)
            ys, xs = ty * th, tx * tw
            a0, a1 = max(ys, r0), min(ys + th, r1)
            b0, b1 = max(xs, c0), min(xs + tw, c1)
            win[a0 - r0:a1 - r0, b0 - c0:b1 - c0] = block[a0 - ys:a1 - ys, b0 - xs:b1 - xs]
    win[~(win > -1000)] = np.nan
    fill = np.nanmedian(win) if np.isfinite(win).any() else 0
    arr = ndimage.map_coordinates(np.nan_to_num(win, nan=fill), [rows - r0, cols - c0], order=1, mode="nearest").reshape(X.shape)
    arr = arr.astype(np.float32)
    if cache:
        out.parent.mkdir(parents=True, exist_ok=True)
        np.save(out, arr)
    return arr


def dtmp(area, t):
    """IPR's technical land-use polygons over the tile, in local metres: [(class, polygon)]."""
    out = CACHE / "dtmp" / f"{t['i']}_{t['j']}.pkl"
    if out.exists():
        return pickle.loads(out.read_bytes())
    x0, y0, x1, y1 = t["box"]
    to_ll = Transformer.from_crs(local_proj(area), "EPSG:4326", always_xy=True)
    lons, lats = to_ll.transform([x0, x1, x1, x0], [y0, y0, y1, y1])
    params = {"geometry": f"{min(lons)},{min(lats)},{max(lons)},{max(lats)}", "geometryType": "esriGeometryEnvelope",
              "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": "CTVUK_POPIS", "outSR": 4326,
              "f": "geojson", "resultRecordCount": 2000}
    r = S.get(DTMP, params=params, timeout=120)
    r.raise_for_status()
    to_local = Transformer.from_crs("EPSG:4326", local_proj(area), always_xy=True)
    clip = shapely_box(*t["box"])
    polys = []
    for f in r.json()["features"]:
        g = shapely_transform(to_local.transform, shape(f["geometry"])).buffer(0).intersection(clip)
        if not g.is_empty:
            polys.append(((f["properties"]["CTVUK_POPIS"] or "").strip(), g))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pickle.dumps(polys))
    return polys


# --- Rasterising -------------------------------------------------------------------------

def burn(mask, t, res, rings_list, value=True):
    """Fill polygons (lists of rings, even-odd within each) into a boolean/int raster.
    A pixel is filled when its centre is inside: along each row of pixels, every crossing
    of a ring's edge turns the filling on or off."""
    x0, _, _, y1 = t["box"]
    h, w = mask.shape
    for rings in rings_list:
        ext = np.asarray(rings[0])
        c0, c1 = max(int((ext[:, 0].min() - x0) / res) - 1, 0), min(int((ext[:, 0].max() - x0) / res) + 2, w)
        r0, r1 = max(int((y1 - ext[:, 1].max()) / res) - 1, 0), min(int((y1 - ext[:, 1].min()) / res) + 2, h)
        if c1 <= c0 or r1 <= r0:
            continue
        H, W = r1 - r0, c1 - c0
        turns = np.zeros(H * (W + 1), np.int64)  # (a column past the end takes the crossings beyond it)
        for ring in rings:
            ring = np.asarray(ring, float)
            ra, ca = (y1 - ring[:, 1]) / res - 0.5 - r0, (ring[:, 0] - x0) / res - 0.5 - c0
            rb, cb = np.roll(ra, -1), np.roll(ca, -1)
            first = np.clip(np.ceil(np.minimum(ra, rb)), 0, H).astype(int)
            n = np.clip(np.ceil(np.maximum(ra, rb)), 0, H).astype(int) - first
            e = np.repeat(np.arange(len(ra)), n)  # an edge, once for every row of centres it crosses
            if not len(e):
                continue
            rows = first[e] + np.arange(len(e)) - np.repeat(np.cumsum(n) - n, n)
            at = ca[e] + (rows - ra[e]) * (cb[e] - ca[e]) / (rb[e] - ra[e])
            turns += np.bincount(rows * (W + 1) + np.clip(np.ceil(at), 0, W).astype(int), minlength=len(turns))
        sub = (np.cumsum(turns.reshape(H, W + 1), axis=1)[:, :W] & 1).astype(bool)
        mask[r0:r1, c0:c1][sub] = value
    return mask


def rings_of(g):
    polys = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
    return [[list(p.exterior.coords), *[list(h.coords) for h in p.interiors]] for p in polys]


def beige_mask(t, res):
    """True where the game shows the plain base: no area, street or building on it."""
    shape_ = grid(t, res)[0].shape
    covered = np.zeros(shape_, bool)
    for polys in [*t["areas"].values(), *t["roads"].values()]:
        burn(covered, t, res, polys)
    burn(covered, t, res, [b["rings"] for b in t["buildings"]])
    return ~covered


# --- Features ------------------------------------------------------------------------------

def features(area, meta, t, rgb=None, cir=None):
    """Per-pixel measurements at RES: colour, infrared greenness, texture, height.
    The photographs are given (build) or read from the prototype's cache."""
    fresh = rgb is not None
    if not fresh:
        rgb = export(RGB, "rgb", area, t, RES, RES)
        cir = export(CIR, "cir", area, t, RES, RES)
    if DSM_SOURCE == "ipr":
        dsm = ipr_dsm(area, t, RES, cache=not fresh)
    else:
        dsm = export(DSM, "dsm", area, t, RES, 1.0, fmt="tiff", extra={"pixelType": "F32", "interpolation": "RSP_BilinearInterpolation"})[:, :, 0]
    hm, step = terrain(area, meta, t)
    X, Y = grid(t, RES)
    x0, y0 = t["box"][0], t["box"][1]
    dtm = ndimage.map_coordinates(np.nan_to_num(hm, nan=np.nanmean(hm)), [(Y - y0) / step, (X - x0) / step], order=1, mode="nearest")
    # Colour-infrared composite: near infrared, red, green.
    nir, red = cir[:, :, 0], cir[:, :, 1]
    ndvi = (nir - red) / (nir + red + 1e-3)
    lum = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / (mx + 1e-3)
    k = int(1 / RES) + 1
    m1 = ndimage.uniform_filter(lum, k)
    tex = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, k) - m1 * m1, 0))
    dsm = np.where(dsm > 0, dsm, dtm)
    if DSM_SOURCE == "ipr":
        # IPR's surface model and its terrain (the game's heights) come from the same
        # office and heights: the difference is how far things stand above the ground,
        # also inside a wood, where there's no open ground near by to measure from.
        ndsm = dsm - dtm
    else:
        # Height above the ground round about: the surface model minus its own lowest
        # points within 16 m (a morphological opening). The ČÚZK model is from
        # 2009-2013 and doesn't always meet IPR's terrain.
        f4 = 4
        low = ndimage.grey_opening(dsm[::f4, ::f4], size=int(16 / (RES * f4)))
        low = ndimage.zoom(ndimage.uniform_filter(low, 3), (dsm.shape[0] / low.shape[0], dsm.shape[1] / low.shape[1]), order=1)
        ndsm = dsm - low[: dsm.shape[0], : dsm.shape[1]]
    warm = rgb[:, :, 0] - rgb[:, :, 2]  # brown/ochre against grey
    return {"rgb": rgb, "ndvi": ndvi, "lum": lum, "sat": sat, "tex": tex, "ndsm": ndsm, "warm": warm}


def down(a, f):
    """Average `a` over f x f blocks (RES -> CELL)."""
    h, w = a.shape[:2]
    a = a[: h - h % f, : w - w % f]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def pieces(F, mask):
    """SLIC superpixels at CELL over `mask` (True: to classify), about 60 m2 each."""
    f = round(CELL / RES)
    stack = np.dstack([down(F["rgb"], f), down(F["ndvi"], f)[..., None] * 0.8,
                       np.clip(down(F["ndsm"], f), 0, 12)[..., None] / 12])
    m = down(mask.astype(np.float32), f) > 0.5
    n = max(int(m.sum() * CELL * CELL / 60), 1)
    labels = slic(stack, n_segments=n, compactness=0.12, mask=m, channel_axis=-1, start_label=1, enforce_connectivity=True)
    return labels, m


FEATURES = ["area", "r", "g", "b", "lum", "lum_sd", "sat", "tex", "warm", "ndvi", "green", "ndsm", "tall", "dark", "elong"]


def summarise(F, labels):
    """Per-piece numbers (dict per label) from the RES features and CELL labels."""
    f = round(CELL / RES)
    up = np.kron(labels, np.ones((f, f), labels.dtype))
    H, W = F["lum"].shape
    up = np.pad(up, ((0, H - up.shape[0]), (0, W - up.shape[1])))
    idx = np.arange(1, labels.max() + 1)
    inside = up > 0  # only the pixels of some piece are measured: often a small part of the tile
    up = up[inside]
    F = {k: v[inside] for k, v in F.items()}
    mean = lambda a: ndimage.mean(a, up, idx)
    rgb = F["rgb"]
    lum_m, lum_sq = mean(F["lum"]), mean(F["lum"] ** 2)
    cols = {
        "area": ndimage.sum(np.ones_like(F["lum"]), up, idx) * RES * RES,
        "r": mean(rgb[:, 0]), "g": mean(rgb[:, 1]), "b": mean(rgb[:, 2]),
        "lum": lum_m, "lum_sd": np.sqrt(np.maximum(lum_sq - lum_m ** 2, 0)),
        "sat": mean(F["sat"]), "tex": mean(F["tex"]), "warm": mean(F["warm"]),
        "ndvi": mean(F["ndvi"]), "green": mean((F["ndvi"] > 0.2).astype(np.float32)),
        "ndsm": ndimage.median(F["ndsm"], up, idx), "tall": mean((F["ndsm"] > TREE).astype(np.float32)),
        "dark": mean((F["lum"] < 0.16).astype(np.float32)),
    }
    elong = {p.label: (p.axis_major_length / max(p.axis_minor_length, 1)) for p in regionprops(labels)}
    out = {}
    for k, lab in enumerate(idx):
        if cols["area"][k] <= 0:
            continue
        d = {c: float(cols[c][k]) for c in cols}
        d["elong"] = float(elong.get(lab, 1))
        out[int(lab)] = d
    return out


# --- Classifying -------------------------------------------------------------------------

def rules(p):
    """Fixed thresholds on a piece's summary."""
    # Tuned by eye on the hand-labelled Smíchov pieces (so optimistic there). The June
    # 2024 photo is bright and hazy: asphalt isn't dark in it, it's grey (not warm, not
    # saturated). Tree canopy is darker than lawn. With IPR's 2025 surface model,
    # height says what isn't ground: anything standing over 2.5 m that isn't green
    # (sheds, site huts, containers, roofs missing from OSM), and building pits dug
    # below the terrain the game knows. (The 2009-2013 ČÚZK model predates the
    # building sites, so with it height only tells trees from lawn.)
    if p["green"] > 0.45 or p["ndvi"] > 0.2:
        return "trees" if p["tall"] > 0.4 or p["lum"] < 0.42 else "grass"
    if DSM_SOURCE == "ipr" and (p["tall"] > 0.5 or p["ndsm"] < -1.2):
        return "structure"
    if p["lum"] < 0.38 and p["warm"] < -0.03:
        return "structure"  # in a building's shadow, or a dark roof
    if p["tex"] > 0.075:
        return "structure"  # clutter: building sites, sheds, containers
    if p["warm"] > 0.075:
        return "dirt"
    if p["sat"] < 0.08 and p["warm"] < 0.05 and p["lum"] < 0.72:
        return "asphalt"
    if p["lum"] > 0.74:
        return "dirt"  # pale compacted ground
    return "gravel"


def contexts(t, polys_dtmp, labels):
    """IPR's land-use class under most of each piece: the classes rasterised at CELL,
    then a vote per piece."""
    names = sorted({cls for cls, _ in polys_dtmp})
    ras = np.full(labels.shape, -1, np.int16)
    for k, (cls, g) in enumerate(sorted(polys_dtmp, key=lambda cg: -cg[1].area)):  # small ones on top
        burn(ras, t, CELL, rings_of(g), names.index(cls))
    out = {}
    flat_l, flat_r = labels.ravel(), ras.ravel()
    ok = (flat_l > 0) & (flat_r >= 0)
    if ok.any():
        pairs = np.unique(np.stack([flat_l[ok], flat_r[ok]]), axis=1, return_counts=True)
        best = {}
        for (pid, r), n in zip(pairs[0].T, pairs[1]):
            if n > best.get(pid, (0, 0))[0]:
                best[pid] = (n, r)
        out = {int(pid): names[r] for pid, (n, r) in best.items()}
    return out


def piece_polygons(labels, t):
    """Each piece's outline in local metres (for context lookups and hand labelling)."""
    x0, _, _, y1 = t["box"]
    out = {}
    for p in regionprops(labels):
        r0, c0, r1, c1 = p.bbox
        sub = np.pad(p.image, 1)
        cs = find_contours(sub.astype(float), 0.5)
        polys = [Polygon([(x0 + (c + c0 - 1 + 0.5) * CELL, y1 - (r + r0 - 1 + 0.5) * CELL) for r, c in cs_]) for cs_ in cs if len(cs_) > 3]
        g = unary_union([q.buffer(0) for q in polys]) if polys else Polygon()
        out[p.label] = g
    return out


DTMP_CODES = {  # IPR land-use classes, shortened, as a model feature
    "zeleň": "green", "louky": "green", "les": "green", "zahrad": "green",
    "parkoviště": "parking", "chodník": "footway", "silnice": "road", "zpevněné": "paved",
    "dvory": "yard", "železnice": "rail", "průmysl": "industrial", "budovy": "building", "stavby": "structure",
}


def dtmp_code(cls):
    if not cls:
        return "none"
    return next((v for k, v in DTMP_CODES.items() if k in cls), "other")


def label_rasters(area, t, res):
    """Training labels from what the maps already say, per pixel (-1: none)."""
    shape_ = grid(t, res)[0].shape
    lab = np.full(shape_, -1, np.int8)
    L = {c: k for k, c in enumerate(CLASSES)}
    A, R = t["areas"], t["roads"]
    burn(lab, t, res, A.get("park", []) + A.get("garden", []) + A.get("meadow", []) + A.get("lawn", []), L["grass"])
    burn(lab, t, res, A.get("wood", []), L["trees"])
    burn(lab, t, res, R.get("road", []) + A.get("parking", []), L["asphalt"])
    burn(lab, t, res, R.get("path", []) + A.get("square", []) + A.get("square_setts", []) +
         A.get("square_asphalt", []) + A.get("square_loose", []) + R.get("sett", []), L["paving"])
    # Railway ballast: a metre and a half either side of a (non-tram) track.
    rails = [LineString(r["pts"]).buffer(1.5, cap_style="flat") for r in t["rails"] if r["kind"] == "rail" and len(r["pts"]) > 1]
    if rails:
        burn(lab, t, res, rings_of(unary_union(rails)), L["gravel"])
    for cls, key in osm_surfaces(area, t):
        burn(lab, t, res, rings_of(key), L[cls])
    # Roofs: what a piece of "ground" often turns out to be (buildings missing from OSM,
    # or the photo's buildings leaning out of their footprints).
    burn(lab, t, res, [b["rings"] for b in t["buildings"] if not b["part"]], L["structure"])
    return lab


SURFACE = {"asphalt": "asphalt", "concrete": "concrete", "concrete:plates": "concrete", "paving_stones": "paving",
           "sett": "paving", "gravel": "gravel", "fine_gravel": "gravel", "compacted": "gravel", "pebblestone": "gravel",
           "dirt": "dirt", "ground": "dirt", "earth": "dirt", "sand": "dirt", "mud": "dirt"}
_osm = None


def osm_surfaces(area, t):
    """OSM areas and tracks with a surface= tag over the tile (from osmium export of the
    area's extract into .cache/cover/surface.geojsonseq, see `fetch`)."""
    global _osm
    if _osm is None:
        from shapely.strtree import STRtree
        tf = Transformer.from_crs("EPSG:4326", local_proj(area), always_xy=True)
        geoms, cls = [], []
        src = CACHE / "surface.geojsonseq"
        if src.exists():
            for line in src.open():
                f = json.loads(line.lstrip("\x1e"))
                s = f["properties"].get("surface")
                if s not in SURFACE:
                    continue
                g = shapely_transform(tf.transform, shape(f["geometry"]))
                if g.geom_type == "LineString":
                    g = g.buffer(1.2 if f["properties"].get("highway") in ("track", "path", "footway") else 2.5, cap_style="flat")
                geoms.append(g.buffer(0))
                cls.append(SURFACE[s])
        _osm = (STRtree(geoms) if geoms else None, geoms, cls)
    tree, geoms, cls = _osm
    if tree is None:
        return []
    b = shapely_box(*t["box"])
    return [(cls[k], geoms[k].intersection(b)) for k in tree.query(b) if not geoms[k].intersection(b).is_empty]


def jev_state(p, ctx, near):
    """The text Jev sees for a piece."""
    return json.dumps({
        "area_m2": round(p["area"]), "elongation": round(p["elong"], 1),
        "mean_colour_rgb": [round(p[c] * 255) for c in "rgb"], "brightness": round(p["lum"], 2),
        "brightness_spread": round(p["lum_sd"], 3), "saturation": round(p["sat"], 2),
        "roughness_1m": round(p["tex"], 3), "red_minus_blue": round(p["warm"], 3),
        "infrared_greenness_ndvi": round(p["ndvi"], 2), "share_green": round(p["green"], 2),
        "height_above_ground_median_m": round(p["ndsm"], 1), "share_taller_than_2_5m": round(p["tall"], 2),
        "share_in_deep_shadow": round(p["dark"], 2),
        "city_land_use_map_class": ctx or "none", "nearby": near,
    }, ensure_ascii=False)


JEV_CRITERIA = {
    "grass": "Lawn, meadow, weeds or other low vegetation",
    "trees": "Tree canopy or tall shrubs",
    "asphalt": "Asphalt: a dark, smooth sealed surface (yards, driveways, car parks)",
    "paving": "Paving stones, setts, tiles or interlocking blocks",
    "concrete": "Poured concrete or concrete slabs, light grey",
    "gravel": "Gravel, crushed stone or railway ballast",
    "dirt": "Bare soil, sand, mud or a worn earth track",
    "structure": "Not ground: a roof, shed, parked lorry or other object seen from above",
}


def jev(states):
    """Ask Jev for each piece (one request per piece, answers cached by text)."""
    key = os.environ.get("TYPESAFE_API_KEY")
    cache_f = CACHE / "jev_answers.json"
    cache = json.loads(cache_f.read_text()) if cache_f.exists() else {}
    out, tokens = {}, 0
    for pid, state in states.items():
        if state in cache:
            out[pid] = cache[state]
            continue
        if not key:
            continue
        body = {"state": state, "model": "jev-latest", "questions": {"surface": {
            "type": "choice",
            "instructions": "Seen from above in a summer aerial photograph of Prague, what is this piece of unmapped ground mostly made of?",
            "criteria": JEV_CRITERIA}}}
        for attempt in range(5):
            r = S.post("https://api.typesafe.ai/v1/systemone", json=body, headers={"Authorization": f"Bearer {key}"}, timeout=60)
            if r.status_code == 429:
                time.sleep(2 ** attempt)
                continue
            r.raise_for_status()
            break
        d = r.json()
        a = d["answers"]["surface"]
        cache[state] = {"choice": a["choice"], "confidence": a.get("confidence"), "tokens": d.get("usage", {}).get("input_tokens")}
        out[pid] = cache[state]
    cache_f.write_text(json.dumps(cache, ensure_ascii=False))
    return out


# --- Per tile ----------------------------------------------------------------------------

def analyse(area, meta, i, j):
    """Features, pieces and summaries of a tile's beige (cached)."""
    out = CACHE / "pieces" / f"{i}_{j}.pkl"
    old = pickle.loads(out.read_bytes()) if out.exists() else None
    if old and old.get("dsm", "cuzk") == DSM_SOURCE:
        return old
    t = tile_json(area, i, j)
    F = features(area, meta, t)
    mask = beige_mask(t, RES)
    if old:  # the same pieces (and hand labels), measured again with this height model
        labels, m, polys, ctx = old["labels"], old["mask"], old["polys"], old["ctx"]
    else:
        labels, m = pieces(F, mask)
        polys = piece_polygons(labels, t)
        ctx = contexts(t, dtmp(area, t), labels)
    summ = summarise(F, labels)
    # Canopy tops in the beige: tall, green local maxima at least 4 m apart.
    canopy = (F["ndsm"] > 3) & (F["ndvi"] > 0.15) & mask
    peaks = peak_local_max(np.where(canopy, ndimage.gaussian_filter(F["ndsm"], 2), 0), min_distance=int(4 / RES), threshold_abs=3)
    x0, _, _, y1 = t["box"]
    trees = [[round(x0 + (c + 0.5) * RES, 1), round(y1 - (r + 0.5) * RES, 1)] for r, c in peaks]
    res = {"t": {"i": i, "j": j, "box": t["box"]}, "labels": labels, "mask": m, "summ": summ, "polys": polys, "ctx": ctx, "trees": trees, "dsm": DSM_SOURCE}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pickle.dumps(res))
    return res


def vectorise(labels, classes_by_piece, t):
    """Class rasters -> smooth polygons per class (local metres)."""
    x0, _, _, y1 = t["box"]
    # The class of every cell, then the most common class within ~10 m of it, so
    # small pieces merge into their surroundings instead of a speckled patchwork.
    lut = np.full(labels.max() + 1, -1, np.int16)
    for pid, c in classes_by_piece.items():
        lut[pid] = CLASSES.index(c)
    cls_map = lut[labels]
    inside = cls_map >= 0
    votes = np.stack([ndimage.uniform_filter((cls_map == k).astype(np.float32), 21) for k in range(len(CLASSES))])
    smooth = np.where(inside, votes.argmax(0), -1)
    out = {}
    for k, cls in enumerate(CLASSES):
        if cls == "structure" or not (smooth == k).any():
            continue
        m = (smooth == k).astype(float)
        m = ndimage.gaussian_filter(np.pad(m, 1), 0.8)
        rings = [np.asarray([(x0 + (c - 1 + 0.5) * CELL, y1 - (r - 1 + 0.5) * CELL) for r, c in cs]) for cs in find_contours(m, 0.5)]
        rings = [r for r in rings if len(r) > 3]
        if not rings:
            continue
        g = Polygon()
        for r in rings:  # even-odd: holes are rings inside rings
            g = g.symmetric_difference(Polygon(r).buffer(0))
        g = g.simplify(0.25).buffer(0).intersection(shapely_box(*t["box"]))
        rs = [[[[round(x, 2), round(y, 2)] for x, y in ring] for ring in poly] for poly in rings_of(g)]
        if rs:
            out[cls] = rs
    return out


def classify(area, meta, tiles, method, model=None):
    dest = OUT / f"{area}_now" / "cover" / method
    dest.mkdir(parents=True, exist_ok=True)
    counts, tokens, asked = Counter(), 0, 0
    for i, j in tiles:
        a = analyse(area, meta, i, j)
        t = tile_json(area, i, j)
        if method == "rules":
            cls = {pid: rules(p) for pid, p in a["summ"].items()}
        elif method == "model":
            X = np.array([vector(p, a["ctx"].get(pid), model["codes"]) for pid, p in a["summ"].items()])
            pred = model["clf"].predict(X) if len(X) else []
            cls = {pid: CLASSES[k] for pid, k in zip(a["summ"], pred)}
        elif method == "jev":
            near = nearby(t)
            states = {pid: jev_state(p, a["ctx"].get(pid), near) for pid, p in a["summ"].items()}
            tokens += sum(len(s) // 4 for s in states.values())
            ans = jev(states)
            asked += len(states)
            cls = {pid: v["choice"] for pid, v in ans.items()}
        counts.update(Counter({c: a["summ"][pid]["area"] for pid, c in cls.items()}))
        # Single trees from the canopy tops, except where the canopy is now a wood.
        x0, _, _, y1 = a["t"]["box"]
        L = a["labels"]
        def piece_at(x, y):
            r, c = int((y1 - y) / CELL), int((x - x0) / CELL)
            return int(L[r, c]) if 0 <= r < L.shape[0] and 0 <= c < L.shape[1] else 0
        lone = [p for p in a["trees"] if cls.get(piece_at(*p)) != "trees"]
        cover = {"areas": vectorise(L, cls, a["t"]), "trees": lone}
        layers.write(dest / f"{i}_{j}.json", layers.dumps(cover))
    total = sum(counts.values()) or 1
    print(f"{method}: " + ", ".join(f"{c} {v / total * 100:.0f}%" for c, v in counts.most_common()))
    if method == "jev":
        print(f"jev: {asked} pieces, about {tokens} input tokens (4 characters a token), "
              f"{'answered' if os.environ.get('TYPESAFE_API_KEY') else 'not sent: no TYPESAFE_API_KEY'}")


def nearby(t):
    """A few words on what's round the tile, for Jev: the kinds of building."""
    kinds = Counter(b["kind"] for b in t["buildings"] if b["kind"] not in ("yes", None))
    return ", ".join(f"{k} x{n}" for k, n in kinds.most_common(5)) or "no named building types"


def vector(p, ctx, codes):
    return [p[c] for c in FEATURES] + [1.0 if dtmp_code(ctx) == c else 0.0 for c in codes]


# --- Training ----------------------------------------------------------------------------

CODES = sorted(set(DTMP_CODES.values()) | {"none", "other"})


def train_rows(job):
    """One training tile's labelled pieces: (features with land-use codes, class)."""
    area, meta, i, j = job
    out = CACHE / "train_rows" / f"{i}_{j}.pkl"
    if out.exists():
        return pickle.loads(out.read_bytes())
    t = tile_json(area, i, j)
    F = features(area, meta, t)
    lab = label_rasters(area, t, RES)
    # In parks and gardens, what's tall and green is trees, not lawn.
    lab[(lab == CLASSES.index("grass")) & (F["ndsm"] > TREE) & (F["ndvi"] > 0.2)] = CLASSES.index("trees")
    labels, _ = pieces(F, np.ones_like(lab, bool))
    summ = summarise(F, labels)
    f = round(CELL / RES)
    up = np.kron(labels, np.ones((f, f), labels.dtype))[: lab.shape[0], : lab.shape[1]]
    ctx = contexts(t, dtmp(area, t), labels)
    X, y = [], []
    for pid, p in summ.items():
        vals = lab[up == pid]
        vals = vals[vals >= 0]
        if len(vals) < 0.6 * (up == pid).sum():
            continue
        k = np.bincount(vals, minlength=len(CLASSES)).argmax()
        if (vals == k).mean() < 0.6:
            continue
        X.append(vector(p, ctx.get(pid), CODES))
        y.append(int(k))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pickle.dumps((X, y)))
    print(f"  {i}_{j}: {len(y)} labelled pieces", flush=True)
    return X, y


def train(area, meta, tiles):
    """Gradient boosting on SLIC pieces over whole training tiles, each labelled by the
    map data under most (60 %) of it; once with IPR's land-use class as a feature and
    once without."""
    from concurrent.futures import ProcessPoolExecutor
    from sklearn.ensemble import HistGradientBoostingClassifier
    with ProcessPoolExecutor(4) as ex:
        rows = list(ex.map(train_rows, [(area, meta, i, j) for i, j in tiles]))
    X = np.array([x for xs, _ in rows for x in xs])
    y = np.array([k for _, ys in rows for k in ys])
    print("training pieces per class:", {CLASSES[k]: int((y == k).sum()) for k in range(len(CLASSES))})
    models = {}
    for name, codes, cols in [("model", CODES, X.shape[1]), ("model_nodtmp", [], len(FEATURES))]:
        clf = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.08, class_weight="balanced", random_state=1)
        clf.fit(X[:, :cols], y)
        models[name] = {"clf": clf, "codes": codes}
        (CACHE / f"{name}.pkl").write_bytes(pickle.dumps(models[name]))
    return models


# --- The painted photo (option 1) --------------------------------------------------------

def kuwahara(img, radius=5, q=8, stretch=2.0, angles=8):
    """Anisotropic Kuwahara (Kyprianidis et al. 2009, simplified): eight sectors of an
    ellipse stretched along the local edge direction; each pixel takes the sectors'
    means weighted towards the least varied. Orientations are quantised to `angles`."""
    from scipy.signal import fftconvolve
    lum = img @ np.array([0.299, 0.587, 0.114])
    gx, gy = ndimage.sobel(lum, 1), ndimage.sobel(lum, 0)
    jxx, jxy, jyy = (ndimage.gaussian_filter(a, 2.0) for a in (gx * gx, gx * gy, gy * gy))
    tr, det = jxx + jyy, np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2)
    l1, l2 = (tr + det) / 2, (tr - det) / 2
    aniso = np.where(l1 + l2 > 1e-6, (l1 - l2) / (l1 + l2 + 1e-9), 0)
    phi = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2  # along the edge
    rr = np.arange(-2 * radius, 2 * radius + 1)
    yy, xx = np.meshgrid(rr, rr, indexing="ij")

    def filt(theta, s):
        c, si = math.cos(theta), math.sin(theta)
        u = (xx * c + yy * si) / (radius * s)      # along
        v = (-xx * si + yy * c) / (radius / s)     # across
        r2 = u * u + v * v
        g = np.exp(-r2 * 2) * (r2 <= 1)
        ang = np.arctan2(v, u)
        num, den = 0, 0
        for k in range(8):
            d = np.angle(np.exp(1j * (ang - k * np.pi / 4)))
            w = g * np.exp(-(d / (np.pi / 8)) ** 2 * 2)
            w /= w.sum()
            m = np.stack([fftconvolve(img[:, :, b], w, mode="same") for b in range(3)], -1)
            m2 = np.stack([fftconvolve(img[:, :, b] ** 2, w, mode="same") for b in range(3)], -1)
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
            r = filt(b * np.pi / angles, stretch)
            out[sel] = r[sel]
    a = np.clip(aniso * 1.5, 0, 1)[..., None]
    return iso * (1 - a) + out * a


def ortho(area, meta, tiles):
    dest = OUT / f"{area}_now" / "cover" / "ortho"
    dest.mkdir(parents=True, exist_ok=True)
    sizes = []
    for i, j in tiles:
        t = tile_json(area, i, j)
        rgb = export(RGB, "rgb", area, t, RES, RES)
        img = down(rgb, round(CELL / RES))
        pad = 12  # mirrored, so the filter has something past the tile's edge
        img = kuwahara(np.pad(img.astype(np.float64), ((pad, pad), (pad, pad), (0, 0)), mode="reflect"))[pad:-pad, pad:-pad]
        # Towards the game's palette: a little less contrast and saturation.
        lum = img @ np.array([0.299, 0.587, 0.114])
        img = lum[..., None] + (img - lum[..., None]) * 0.8
        img = 0.5 + (img - 0.5) * 0.85 + 0.03
        f = dest / f"{i}_{j}.jpg"
        Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(f, quality=80, optimize=True)
        sizes.append(f.stat().st_size)
        print(f"  {i}_{j}: {sizes[-1] // 1024} KB", flush=True)
    print(f"ortho: {len(sizes)} tiles, {sum(sizes) / len(sizes) / 1024:.0f} KB a tile at {CELL} m/px")


# --- Hand labels and scoring -------------------------------------------------------------

def test_pieces(area, meta, tiles, n=120, seed=3):
    """A random sample of pieces (weighted by area) to label by hand."""
    rng = np.random.default_rng(seed)
    allp = [((i, j), pid, p["area"]) for i, j in tiles for pid, p in analyse(area, meta, i, j)["summ"].items() if p["area"] >= 8]
    w = np.array([a for *_, a in allp])
    pick = rng.choice(len(allp), size=min(n, len(allp)), replace=False, p=w / w.sum())
    return [allp[k][:2] for k in sorted(pick)]


def sheet(area, meta, tiles):
    """Contact sheets: each sampled piece outlined on the photo, 40 m round it."""
    sample = test_pieces(area, meta, tiles)
    font = ImageFont.load_default()
    per, size = 20, 256
    for s in range(0, len(sample), per):
        page = Image.new("RGB", (5 * size, 4 * (size + 16)), "white")
        for k, ((i, j), pid) in enumerate(sample[s:s + per]):
            a = analyse(area, meta, i, j)
            t = tile_json(area, i, j)
            rgb = export(RGB, "rgb", area, t, RES, RES)
            f = round(CELL / RES)
            up = np.kron(a["labels"] == pid, np.ones((f, f), bool))[: rgb.shape[0], : rgb.shape[1]]
            rows, cols = np.nonzero(up)
            cr, cc = int(rows.mean()), int(cols.mean())
            half = int(20 / RES)
            r0, c0 = max(cr - half, 0), max(cc - half, 0)
            crop = (rgb[r0:r0 + 2 * half, c0:c0 + 2 * half] * 255).astype(np.uint8)
            edge = up[r0:r0 + 2 * half, c0:c0 + 2 * half]
            edge = edge ^ ndimage.binary_erosion(edge, iterations=2)
            crop[edge] = [255, 0, 255]
            im = Image.fromarray(crop).resize((size, size))
            x, y = (k % 5) * size, (k // 5) * (size + 16)
            page.paste(im, (x, y + 16))
            ImageDraw.Draw(page).text((x + 4, y + 2), f"#{s + k} {i}_{j}/{pid}", fill="black", font=font)
        p = CACHE / f"sheet_{s // per}.png"
        page.save(p)
        print(p)
    (CACHE / "sample.json").write_text(json.dumps([[f"{i}_{j}", pid] for (i, j), pid in sample]))


def score(area, meta, tiles, model, model_nodtmp):
    """Every method against the hand labels (.cache/cover/truth.json: {"#": class})."""
    truth = json.loads((CACHE / "truth.json").read_text())
    sample = json.loads((CACHE / "sample.json").read_text())
    rows = {m: [] for m in ("rules", "model", "model_nodtmp", "dtmp_only", "jev")}
    DT = {"green": "grass", "paved": "concrete", "parking": "asphalt", "footway": "paving", "road": "asphalt", "rail": "gravel", "yard": "paving"}
    for n, (k, pid) in enumerate(sample):
        want = truth.get(str(n))
        if not want or want == "skip":
            continue
        i, j = map(int, k.split("_"))
        a = analyse(area, meta, i, j)
        p, ctx = a["summ"][pid], a["ctx"].get(pid)
        w = p["area"]
        rows["rules"].append((want, rules(p), w))
        rows["model"].append((want, CLASSES[model["clf"].predict([vector(p, ctx, model["codes"])])[0]], w))
        rows["model_nodtmp"].append((want, CLASSES[model_nodtmp["clf"].predict([vector(p, ctx, [])])[0]], w))
        rows["dtmp_only"].append((want, DT.get(dtmp_code(ctx), "paving"), w))
        t = tile_json(area, i, j)
        ans = jev({pid: jev_state(p, ctx, nearby(t))})
        if pid in ans:
            rows["jev"].append((want, ans[pid]["choice"], w))
    green = {"grass", "trees"}
    for m, r in rows.items():
        if not r:
            print(f"{m:13s} (no answers)")
            continue
        acc = sum(w for a, b, w in r if a == b) / sum(w for *_, w in r)
        coarse = sum(w for a, b, w in r if (a in green) == (b in green)) / sum(w for *_, w in r)
        hard = [(a, b, w) for a, b, w in r if a not in green and a != "structure"]
        hacc = sum(w for a, b, w in hard if a == b) / max(sum(w for *_, w in hard), 1e-9)
        gr = [(a, b, w) for a, b, w in r if a in green and b in green]
        gacc = sum(w for a, b, w in gr if a == b) / max(sum(w for *_, w in gr), 1e-9)
        st = [(a, b, w) for a, b, w in r if a == "structure"]
        sacc = sum(w for a, b, w in st if b == "structure") / max(sum(w for *_, w in st), 1e-9)
        print(f"{m:13s} n={len(r):3d}  exact {acc * 100:4.0f}%  green-or-not {coarse * 100:4.0f}%  "
              f"trees-or-grass {gacc * 100:4.0f}%  material on hard ground {hacc * 100:4.0f}%  not-ground caught {sacc * 100:4.0f}%")
    return rows


# --- The whole map (build) -----------------------------------------------------------------
#
# What build_tiles.py's layers do for the other things: every tile of an area, decided only
# from what the map says is unmapped there (the ground and buildings layers), the tile's
# terrain heights, IPR's photographs and surface model. Each tile's answer is kept in
# .cache/cover/results/<area>/ under a key of its inputs, so a second run redoes only what
# changed, and all of them go into the cover layer (layers.py), which layers.assemble() puts
# into the tiles as the areas the game already draws (cover_grass ... cover_asphalt, canopy
# as wood and single trees).

PHOTOS = CACHE / "photos"
MIN_BEIGE = 1000     # m2 of plain ground in a tile below which it isn't looked at
SEEN = 0.02          # a photo pixel darker than this (in every band) is outside IPR's pictures


def photo(url, kind, area, t, res=RES):
    """IPR's photograph of the tile on its own grid as float32 (h, w, 3), or None outside the
    pictures. The download (a lossy JPEG: about 0.26 MB a tile at 0.25 m, a tenth of the
    PNG, and classified the same on the hand-labelled pieces) is kept under photos/."""
    X, Y = grid(t, res)
    E, N = sjtsk(area, t, res)
    bx0, by0, bx1, by1 = E.min() - 3, N.min() - 3, E.max() + 3, N.max() + 3
    path = PHOTOS / area / kind / f"{t['i']}_{t['j']}.jpg"
    if not path.exists():
        w, h = math.ceil((bx1 - bx0) / res), math.ceil((by1 - by0) / res)
        params = {"bbox": f"{bx0},{by0},{bx1},{by1}", "bboxSR": 5514, "imageSR": 5514, "size": f"{w},{h}",
                  "format": "jpg", "f": "image"}
        for attempt in range(5):
            try:
                r = S.get(f"{url}/exportImage", params=params, timeout=120)
                r.raise_for_status()
                if not r.headers.get("content-type", "").startswith("image/"):
                    raise requests.RequestException(r.text[:200])
                Image.open(io.BytesIO(r.content)).load()
                break
            except (requests.RequestException, OSError):
                if attempt == 4:
                    raise
                time.sleep(3 * (attempt + 1))
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_bytes(r.content)
        tmp.replace(path)
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255
    cols = (E - bx0) / (bx1 - bx0) * img.shape[1] - 0.5
    rows = (by1 - N) / (by1 - by0) * img.shape[0] - 0.5
    bands = [ndimage.map_coordinates(img[:, :, b], [rows, cols], order=1, mode="nearest").reshape(X.shape)
             for b in range(3)]
    return np.stack(bands, axis=-1).astype(np.float32)


def tile_cover(area, meta, t):
    """One tile's ground cover, {"areas": {class: polygons}, "trees": [[x, y]]}, from the tile as
    the ground and buildings layers make it; None where IPR has no photograph."""
    rgb = photo(RGB, "rgb", area, t)
    seen = rgb.max(-1) >= SEEN
    if seen.mean() < 0.1:
        return None
    mask = beige_mask(t, RES)
    mask &= ndimage.binary_erosion(seen, iterations=3)
    if mask.sum() * RES * RES < MIN_BEIGE * 0.5:
        return {"areas": {}, "trees": []}
    cir = photo(CIR, "cir", area, t)
    F = features(area, meta, t, rgb, cir)
    labels, _ = pieces(F, mask)
    summ = summarise(F, labels)
    cls = {pid: rules(p) for pid, p in summ.items()}
    canopy = (F["ndsm"] > 3) & (F["ndvi"] > 0.15) & mask
    peaks = peak_local_max(np.where(canopy, ndimage.gaussian_filter(F["ndsm"], 2), 0), min_distance=int(4 / RES), threshold_abs=3)
    x0, _, _, y1 = t["box"]
    f = round(CELL / RES)

    def piece_at(x, y):
        r, c = int((y1 - y) / CELL), int((x - x0) / CELL)
        return int(labels[r, c]) if 0 <= r < labels.shape[0] and 0 <= c < labels.shape[1] else 0
    trees = [[round(x0 + (c + 0.5) * RES, 1), round(y1 - (r + 0.5) * RES, 1)] for r, c in peaks]
    lone = [p for p in trees if cls.get(piece_at(*p)) != "trees"]
    return {"areas": vectorise(labels, cls, t), "trees": lone}


def result_path(area, i, j):
    return CACHE / "results" / area / f"{i}_{j}.json"


@functools.lru_cache(maxsize=None)
def code_key():
    """What works a tile's cover out in this file (layers.cover_processing); the other
    layers' code key leaves the file out (build_cache.code_key)."""
    return layers.cover_processing()[0]


def runtime():
    import importlib.metadata as md
    return {name: md.version(name) for name in ("numpy", "scipy", "scikit-image", "pillow", "shapely")}


def tile_job(job):
    """(i, j, cover or None, inputs key, whether it was kept) for one tile."""
    area, meta, t, height = job
    i, j = t["i"], t["j"]
    inputs = layers.cover_key(t, height)

    def stamp():
        # The photographs kept are inputs too: a replaced file is a changed photo.
        photos = [PHOTOS / area / kind / f"{i}_{j}.jpg" for kind in ("rgb", "cir")]
        return {"code": code_key(), "runtime": runtime(), "inputs": inputs,
                "dsm": build_cache.identity(IPR_DSM),
                "photos": [build_cache.digest(p.read_bytes()) if p.exists() else None for p in photos]}
    stored = build_cache.read_json(result_path(area, i, j))
    if stored and stored.get("stamp") == stamp():
        return i, j, stored["cover"], inputs, True
    got = tile_cover(area, meta, t)
    build_cache.write_json(result_path(area, i, j), {"stamp": stamp(), "cover": got})
    return i, j, got, inputs, False


def build(area, meta, jobs, tiles=None, limit=None):
    """Classify the ground of every tile of the area (or `tiles`) that has enough plain
    ground, and write the cover layer."""
    from concurrent.futures import ProcessPoolExecutor
    terrain_layer = layers.read_layer(area, "terrain")
    if not terrain_layer:
        raise SystemExit(f"{area}: the terrain heights are needed first; run ipr_terrain.py {area}")
    if DSM_SOURCE != "ipr":
        raise SystemExit(f"{IPR_DSM} is missing: IPR's surface model (see the sources above)")
    payloads = terrain_layer["payloads"]
    meta = {**meta, "terrain": terrain_layer["index"]}
    want = set(tiles) if tiles else None

    def work():
        n = 0
        for i, j, t in layers.tiles(area):
            if want is not None and (i, j) not in want:
                continue
            t = {**t, "i": i, "j": j}
            # Cheap and rough: most tiles have nothing to look at, and need no photograph.
            if plain_ground(t) < MIN_BEIGE:
                continue
            n += 1
            if limit and n > limit:
                return
            yield area, meta, t, payloads.get(f"{i}_{j}.height.bin.gz", [None, None])[1]
    started, done, redone, covers, keys, nopic = time.time(), 0, 0, {}, {}, 0
    if want is not None:  # a trial on some tiles adds to what the layer already has
        before = layers.read_layer(area, "cover") or {}
        covers, keys = dict(before.get("tiles", {})), dict(before.get("inputs", {}))
    with ProcessPoolExecutor(jobs) as pool:
        for i, j, got, inputs, hit in pool.map(tile_job, work(), chunksize=1):
            done += 1
            redone += not hit
            keys[f"{i}_{j}"] = inputs
            covers.pop(f"{i}_{j}", None)
            if got is None:
                nopic += 1
            elif got["areas"] or got["trees"]:
                covers[f"{i}_{j}"] = got
            if done % 100 == 0:
                print(f"  {done} tiles ({redone} worked out, {nopic} outside the photographs) in {time.time() - started:.0f} s", flush=True)
    sources = build_cache.sources([IPR_DSM])
    layers.write_layer(area, "cover", {
        "tile": meta["tile"], "made_for": sorted(keys), "tiles": covers, "inputs": keys,
        "processing": layers.cover_processing(), "sources": sources})
    print(f"cover: {len(keys)} tiles looked at, {redone} worked out, {len(covers)} with cover, {nopic} outside the photographs")


def plain_ground(t):
    """Square metres of the tile no area, street or building covers (1 m raster: only to decide)."""
    return float(beige_mask(t, 1.0).sum())


def tiles_in(i0, i1, j0, j1, skip=None):
    out = [(i, j) for i in range(i0, i1 + 1) for j in range(j0, j1 + 1)]
    if skip:
        si0, si1, sj0, sj1 = skip
        out = [(i, j) for i, j in out if not (si0 <= i <= si1 and sj0 <= j <= sj1)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "fetch", "ortho", "classify", "train", "sheet", "score"])
    ap.add_argument("area", choices=AREAS)
    ap.add_argument("tiles", nargs="*", type=int, metavar="I0 I1 J0 J1", help="tile range (all but build need one)")
    ap.add_argument("--method", default="rules", choices=["rules", "model", "jev"])
    ap.add_argument("--skip", nargs=4, type=int)
    ap.add_argument("--jobs", type=int, default=6, help="build: tiles worked on side by side (IPR's server sees this many requests)")
    ap.add_argument("--limit", type=int, help="build: only the first N tiles with enough plain ground (a trial)")
    ap.add_argument("--no-assemble", action="store_true", help="build: leave the game's tiles alone")
    args = ap.parse_args()
    if args.cmd != "build" and len(args.tiles) != 4:
        ap.error(f"{args.cmd} needs I0 I1 J0 J1")
    if args.cmd == "build":
        if len(args.tiles) not in (0, 4):
            ap.error("build takes no tile range or I0 I1 J0 J1")
        meta = layers.read_meta(args.area)
        if not meta:
            ap.error(f"{args.area}: no layers yet; run build_tiles.py {args.area} first")
        wanted = tiles_in(*args.tiles) if args.tiles else None
        started = time.time()
        build(args.area, meta, args.jobs, wanted, args.limit)
        if not args.no_assemble:
            layers.assemble(args.area)
        print(f"build: {time.time() - started:.0f} s")
        return
    meta = json.loads((OUT / f"{args.area}_now" / "index.json").read_text())
    tiles = tiles_in(*args.tiles, skip=args.skip)
    t0 = time.time()
    if args.cmd == "fetch":
        from concurrent.futures import ThreadPoolExecutor

        def one(ij):
            t = tile_json(args.area, *ij)
            for url, name, src, extra in [(RGB, "rgb", RES, None), (CIR, "cir", RES, None),
                                          (DSM, "dsm", 1.0, {"pixelType": "F32", "interpolation": "RSP_BilinearInterpolation"})]:
                export(url, name, args.area, t, RES, src, fmt="tiff" if name == "dsm" else "png", extra=extra)
            dtmp(args.area, t)
            print(f"  {ij[0]}_{ij[1]}", flush=True)
        with ThreadPoolExecutor(4) as ex:
            list(ex.map(one, tiles))
    elif args.cmd == "ortho":
        ortho(args.area, meta, tiles)
    elif args.cmd == "classify":
        model = pickle.loads((CACHE / "model.pkl").read_bytes()) if args.method == "model" else None
        classify(args.area, meta, tiles, args.method, model)
    elif args.cmd == "train":
        train(args.area, meta, tiles)
    elif args.cmd == "sheet":
        sheet(args.area, meta, tiles)
    elif args.cmd == "score":
        score(args.area, meta, tiles, pickle.loads((CACHE / "model.pkl").read_bytes()), pickle.loads((CACHE / "model_nodtmp.pkl").read_bytes()))
    print(f"{args.cmd}: {len(tiles)} tiles in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
