"""How tall each tree is and how wide its crown, measured in the surface models.

The game used to give a mapped tree a made-up size: a crown 6 to 11 m across, 7 to 16 m
high. Prague's grown street and park trees are mostly bigger. The surface model minus the
terrain heights says how high the canopy stands round each tree:

- the top is the highest point within TOP_SEARCH metres of the tree (a crown seldom stands
  straight over its surveyed trunk);
- the crown's radius is the mean, over RAYS directions from the top, of how far the canopy
  stays above CROWN_SHARE of the top. A ray stops at a building, and where it gets nearer
  another tree than its own: in a row of trees each gets its own share. In a closed stand
  the crown still reaches CLOSE of the way to the nearest tree, so the canopy stays closed.
- its outline is how far the rays reach, seen from the trunk, in OUTLINE directions: a
  crown leans off a wall, spreads into a gap or is squeezed in a row, as it does there;
- its colour is the median of its leaves in IPR's summer photo (crown_colour).

Two surface models, and the higher of the two at each metre. IPR Praha's (2025, 1 m) is
the newer, but it reads many broadleaf crowns as a few scattered points, or as the ground
under them (see young_woods.py); ČÚZK's older DMP 1G, made from summer photographs, has
every crown whole. A tree that both read as lower than MIN_TOP gets a radius of 0: it was
planted a few years ago (the game gives it a small crown); or -1 where the photo shows
leaves all round it, a crown neither model sees (the game makes its size up, as before).

    uv run --group cover tree_sizes.py build praha              # every tile with a tree
    uv run --group cover tree_sizes.py build praha 50 52 59 61  # tiles i0 i1 j0 j1
    uv run --group cover tree_sizes.py survey praha 50 52 59 61 # the sizes found, no files written

It measures the trees of the game's tiles as they were last assembled (public/data), and
writes the layer `treesize`: per tile, [x, y, top, radius, *outline, r, g, b] (metres; the
outline in hundredths of the radius; the colour only when the photo shows the crown).
layers.assemble puts each into the tile's tree at that place, as [x, y, kind, top, radius,
*outline, r, g, b] (kind 0 when the map doesn't know it). A tree that moved since keeps a
made-up size until this runs again. The layer's `canopy` (canopy_cells) is what grows in
each tile, for the trees the game makes up; it goes into the tile as `canopy`. Every tile
with trees or green ground is looked at. The ČÚZK model and the photos are fetched once
per tile into .cache/cover/ (dsm_1m_wide is shared with young_woods.py).
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
from scipy import ndimage

import build_cache
import layers
import ground_cover as gc
from osm_area import AREAS

RES = 1.0
MARGIN = 16        # m of the neighbouring tiles read with each tile (the same as young_woods.py, for its cache)
TOP_SEARCH = 2.5   # m round the tree in which its top is looked for
MIN_TOP = 3.0      # m: lower than this the tree isn't measured
CROWN_SHARE = 0.4  # the crown reaches as far as the canopy stays above this share of the top
RAYS, REACH, STEP = 16, 12.0, 0.5  # directions; how far (m) and in what steps they are followed
VORONOI = 0.5      # m: a ray stops where another tree is this much nearer than its own
OUTLINE, OUTLINE_RANGE = 8, (0.5, 1.7)  # the crown's outline: its reach in this many directions, kept within this share of its radius
CLOSE = 0.7        # ...but the crown reaches this share of the way to the nearest tree, where the canopy does
COLOUR_SHARE, COLOUR_REACH = 0.5, 3.5  # the crown's colour is taken within this share of its radius from the top, and these metres
MIN_PIXELS = 3     # ...from at least this many metres of it
HAZE = 0.1         # %: the darkest pixels of the photo, which show only its haze
# The ground the game makes trees up on (vegetation.ts), where the canopy layer is wanted.
GREEN = ("wood", "park", "garden", "lawn", "meadow", "orchard", "grass", "verge", "cover_grass", "dtm_green",
         "dtm_garden", "dtm_wood", "dtm_yard", "ipr_lawn", "ipr_meadow", "ipr_bed", "ipr_grove", "wood_clearing", "young_wood")
BANDS = (2.5, 8.0, 16.0)  # m: where the canopy layer's low, middle and tall bands begin
CELL = 2           # m: the canopy layer's grid
TEXTURE, GRAINY = 2.25, 0.04  # m over which the photo's grain is taken, and the grain of a crown (a lawn's is about 0.03)
LONE_PATCH = 30    # m2: a patch of leaves this small, on its own, is a young tree or a shrub
TOP_OFF_WALL = 2   # m from a building in which the top is taken only from leaves
# A crown the models miss, measured in the photo: looked for within PHOTO_SEARCH m of the
# trunk, at least PHOTO_MIN_LEAVES m2 of leaves and PHOTO_MIN_RADIUS m across; its top is
# worked out from its radius r as PHOTO_TOP[0] + PHOTO_TOP[1] r, at most PHOTO_TOP[2] m.
PHOTO_SEARCH, PHOTO_MIN_LEAVES, PHOTO_MIN_RADIUS, PHOTO_TOP = 4.0, 8, 1.5, (3.0, 2.2, 20.0)
PHOTO_MAX_LEAVES = 250  # m2: more leaves in one patch are a lawn or a wood, not one crown
PHOTO_WIDER = 1.3  # the photo's crown is taken when it's this much wider than the models' one
SEEN_CROWN = 0.6   # a tree too low to measure, with leaves on more than this share round it, has a crown the models miss
LEAVES = 0.1       # the vegetation index above which the photo shows leaves (paving is about -0.2, dry grass 0, a shaded street tree 0.12)


def processing():
    return [build_cache.digest(Path(__file__).read_bytes())]


def placed_tile(area, i, j):
    p = gc.OUT / f"{area}_now" / "tiles" / f"{i}_{j}.json"
    return json.loads(p.read_text()) if p.exists() else {}


def canopy(area, meta, t):
    """Heights above the terrain over the tile with MARGIN of its neighbours (rows from the
    north), the higher of the two surface models; and where buildings stand, with a metre
    round them (the models' walls lean out past the outlines)."""
    x0, y0, x1, y1 = t["box"]
    ext = {**t, "box": [x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN]}
    dtm = gc.terrain_wide(area, meta, t, ext, RES)
    heights = []
    if gc.DSM_SOURCE == "ipr":
        try:
            dsm = gc.ipr_dsm(area, ext, RES, cache=False)
            heights.append(np.where(dsm > 100, dsm - dtm, np.nan))
        except ValueError:  # (past the edge of IPR's model, which covers only the city)
            pass
    try:
        dsm = gc.export(gc.DSM, "dsm_1m_wide", area, ext, RES, 1.0, fmt="tiff",
                        extra={"pixelType": "F32", "interpolation": "RSP_BilinearInterpolation"})[:, :, 0]
        heights.append(np.where(dsm > 100, dsm - dtm, np.nan))
    except Exception as e:  # noqa: BLE001
        print(f"  no ČÚZK surface model for tile {t['i']}_{t['j']} ({e})", flush=True)
    if not heights:
        return None
    nd = np.fmax.reduce(heights) if len(heights) > 1 else heights[0]
    built = np.zeros(nd.shape, bool)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            gc.burn(built, ext, RES, [b["rings"] for b in placed_tile(area, t["i"] + di, t["j"] + dj).get("buildings", [])])
    try:
        rgb = gc.photo(gc.RGB, "rgb_1m_wide", area, ext, RES)
        # The photo's haze (bluish, and the same over a tile's picture) is added to every
        # colour: what the darkest shadows show is taken off, so a crown's own hue shows.
        seen = (rgb > gc.SEEN).any(axis=2)
        if seen.sum() > 1000:
            sums = rgb[seen].sum(axis=1)
            rgb = np.clip(rgb - rgb[seen][sums <= np.percentile(sums, HAZE)].mean(axis=0), 0, 1)
        # Only what grows: leaves are bright in the near infrared (the colour-infrared
        # photo's first band, then red), a purple beech's as much as a lime's. Where the
        # models still have a crown that was felled, or the photo shows it leaning off
        # its place, the paving or the roof under it is left out.
        cir = gc.photo(gc.CIR, "cir_1m_wide", area, ext, RES)
        ndvi = (cir[:, :, 0] - cir[:, :, 1]) / (cir[:, :, 0] + cir[:, :, 1] + 1e-3)
        rgb = np.where((seen & (ndvi > LEAVES))[:, :, None], rgb, np.nan)
    except Exception as e:  # noqa: BLE001 - no photo: the crowns keep the game's colours
        print(f"  no photo for tile {t['i']}_{t['j']} ({e})", flush=True)
        rgb = None
    return nd, ndimage.binary_dilation(built), ext["box"], rgb


def measure(nd, built, box, own, others, rgb=None):
    """[x, y, top, radius, *outline] for each of `own` trees ([x, y, ...]) that stands high
    enough, followed by its crown's colour in the photo `rgb` ([r, g, b], 0 to 255) when there
    is one; [x, y, top, 0] for a young one, lower than MIN_TOP ([x, y, top, -1] when the
    photo shows leaves all round it but no crown can be told). A crown the models miss but
    the photo shows (photo_crown) is measured in the photo, its top worked out from its width;
    one the photo shows clearly wider than the models (PHOTO_WIDER) takes the photo's width.
    `others`: every tree near, own included, as an (n, 2) array."""
    X0, Y1 = box[0], box[3]
    H, W = nd.shape
    ok = np.isfinite(nd) & ~built
    leaves = None
    if rgb is not None:
        leaves = leafy(rgb, built)
        # The top is not looked for by a wall unless there are leaves: the models' walls
        # lean out past the outlines, and a tree beside a house took the eaves for its top.
        ok_top = ok & (~ndimage.binary_dilation(built, iterations=TOP_OFF_WALL) | leaves)
    else:
        ok_top = ok
    angles = np.linspace(0, 2 * np.pi, RAYS, endpoint=False)
    steps = np.arange(STEP, REACH + 1e-6, STEP)

    def rays_from(tx, ty, x, y, inner):
        """How far each ray from (tx, ty) stays in the crown (`inner` says, for the sampled
        rows and columns, what counts), shared with the trees near as in the docstring."""
        px = tx + np.cos(angles)[:, None] * steps
        py = ty + np.sin(angles)[:, None] * steps
        cols, rows = (px - X0).astype(int), (Y1 - py).astype(int)
        inside = (cols >= 0) & (cols < W) & (rows >= 0) & (rows < H)
        cols, rows = np.clip(cols, 0, W - 1), np.clip(rows, 0, H - 1)
        crown = inside & ok[rows, cols] & inner(rows, cols)
        def reach(along):  # how far each ray stays in the crown
            return np.where(along.all(axis=1), REACH, np.argmin(along, axis=1) * STEP) + RES / 2
        rays = free = reach(crown)
        near = others[np.abs(others[:, 0] - x) + np.abs(others[:, 1] - y) < 2 * REACH + 2]
        gap = np.hypot(near[:, 0] - x, near[:, 1] - y)
        gap = gap[gap > 0.3]
        if len(gap):
            d = np.hypot(near[:, 0, None, None] - px, near[:, 1, None, None] - py).min(axis=0)
            # In a closed stand the shares are small; the crowns still close over the gaps.
            rays = np.maximum(reach(crown & (d >= np.hypot(px - x, py - y) - VORONOI)),
                              np.minimum(free, CLOSE * float(gap.min())))
        return rays

    def photo_rays(seen):
        """The rays over the photo's crown (photo_crown) from its middle."""
        tx, ty, mask, (pr0, pc0) = seen
        def inner(rows, cols):
            r_, c_ = rows - pr0, cols - pc0
            ok_ = (r_ >= 0) & (r_ < mask.shape[0]) & (c_ >= 0) & (c_ < mask.shape[1])
            return ok_ & mask[np.clip(r_, 0, mask.shape[0] - 1), np.clip(c_, 0, mask.shape[1] - 1)]
        return tx, ty, rays_from(tx, ty, x_now[0], x_now[1], inner)

    x_now = [0.0, 0.0]
    out = []
    for x, y, *_ in own:
        x_now[:] = [x, y]
        # The top: the highest open metre round the tree.
        c0, r0 = int(x - X0 - TOP_SEARCH), int(Y1 - y - TOP_SEARCH)
        c1, r1 = int(x - X0 + TOP_SEARCH) + 1, int(Y1 - y + TOP_SEARCH) + 1
        if c0 < 0 or r0 < 0 or c1 > W or r1 > H:
            continue
        win = np.where(ok_top[r0:r1, c0:c1], nd[r0:r1, c0:c1], -np.inf)
        r, c = np.unravel_index(np.argmax(win), win.shape)
        top = float(win[r, c])
        if not np.isfinite(top):
            top = 0.0  # (nothing open round it that the models see: perhaps the photo does)
        if top < MIN_TOP:
            seen = photo_crown(leaves, X0, Y1, x, y) if leaves is not None else None
            if seen is not None:
                tx, ty, rays = photo_rays(seen)
                radius = float(rays.mean())
                if radius >= PHOTO_MIN_RADIUS:
                    top = min(PHOTO_TOP[0] + PHOTO_TOP[1] * radius, PHOTO_TOP[2])
                    out.append([round(x, 1), round(y, 1), round(top, 1), round(radius, 1), *outline(x, y, tx, ty, angles, rays, radius),
                                *crown_colour(nd, built, box, rgb, tx, ty, 0.0, radius)])
                    continue
            # Young (radius 0), unless the photo shows leaves all round it: then a crown the
            # models miss (radius -1: the game makes its size up).
            share = leaves[r0:r1, c0:c1].mean() if leaves is not None else 0.0
            out.append([round(x, 1), round(y, 1), round(max(top, 0.0), 1), -1 if share > SEEN_CROWN else 0])
            continue
        tx, ty = X0 + c0 + c + 0.5, Y1 - (r0 + r + 0.5)
        rays = rays_from(tx, ty, x, y, lambda rows, cols: np.nan_to_num(nd[rows, cols], nan=-1) >= max(1.5, CROWN_SHARE * top))
        radius = float(rays.mean())
        # The photo's crown when it's clearly wider: the models' is cut short where a crown
        # hangs over a roof (the buildings are left out of it) or where they see it thin.
        seen = photo_crown(leaves, X0, Y1, x, y) if leaves is not None else None
        if seen is not None:
            ptx, pty, prays = photo_rays(seen)
            if prays.mean() > PHOTO_WIDER * radius:
                tx, ty, rays, radius = ptx, pty, prays, float(prays.mean())
                # (Where the models saw it thin they saw it low too.)
                top = max(top, min(PHOTO_TOP[0] + PHOTO_TOP[1] * radius, PHOTO_TOP[2]))
        out.append([round(x, 1), round(y, 1), round(top, 1), round(radius, 1), *outline(x, y, tx, ty, angles, rays, radius),
                    *crown_colour(nd, built, box, rgb, tx, ty, top, radius)])
    return out


def photo_crown(leaves, X0, Y1, x, y):
    """The tree at (x, y)'s crown in the photo: of the patches of leaves (within REACH) that come
    within PHOTO_SEARCH metres of its trunk, the biggest. (its middle x, y, the patch, the row
    and column of its corner), or None when it's too small or too big to be one crown."""
    H, W = leaves.shape
    c0, r0 = max(int(x - X0 - REACH), 0), max(int(Y1 - y - REACH), 0)
    c1, r1 = min(int(x - X0 + REACH) + 1, W), min(int(Y1 - y + REACH) + 1, H)
    patch, n = ndimage.label(ndimage.binary_closing(leaves[r0:r1, c0:c1]))
    if not n:
        return None
    # The patches that come within PHOTO_SEARCH of the trunk; the biggest of them.
    tr, tc = Y1 - y - r0, x - X0 - c0
    rr, cc = np.ogrid[:patch.shape[0], :patch.shape[1]]
    close = np.unique(patch[(np.hypot(rr - tr, cc - tc) <= PHOTO_SEARCH) & (patch > 0)])
    if not len(close):
        return None
    size = np.bincount(patch.ravel())
    best = close[np.argmax(size[close])]
    # (Too few leaves are no crown; too many, a lawn or a wood, aren't one tree's.)
    if not PHOTO_MIN_LEAVES <= size[best] <= PHOTO_MAX_LEAVES:
        return None
    rows, cols = np.nonzero(patch == best)
    return X0 + c0 + cols.mean() + 0.5, Y1 - (r0 + rows.mean() + 0.5), patch == best, (r0, c0)


def outline(x, y, tx, ty, angles, rays, radius):
    """How far the crown reaches from the trunk (x, y) towards the east, north-east, north
    and so on (OUTLINE directions), in hundredths of its radius. The rays start at the top
    (tx, ty), which seldom stands straight over the trunk: their ends are seen from the
    trunk and the reach in each direction read between them, then smoothed a little."""
    ex, ey = tx + np.cos(angles) * rays - x, ty + np.sin(angles) * rays - y
    seen, dist = np.arctan2(ey, ex) % (2 * np.pi), np.hypot(ex, ey)
    order = np.argsort(seen)
    seen, dist = seen[order], dist[order]
    want = np.linspace(0, 2 * np.pi, OUTLINE, endpoint=False)
    reach = np.interp(want, np.concatenate([seen - 2 * np.pi, seen, seen + 2 * np.pi]), np.tile(dist, 3))
    reach = 0.5 * reach + 0.25 * (np.roll(reach, 1) + np.roll(reach, -1))
    return [int(round(v)) for v in np.clip(reach / radius, *OUTLINE_RANGE) * 100]


def crown_colour(nd, built, box, rgb, tx, ty, top, radius):
    """The colour of the crown round its top (tx, ty) in the photo, its haze taken off: the median of its leaves
    within COLOUR_SHARE of its radius (and COLOUR_REACH metres), where its neighbours' crowns
    seldom reach. [] if too little is seen."""
    if rgb is None:
        return []
    X0, Y1 = box[0], box[3]
    reach = min(max(1.0, COLOUR_SHARE * radius), COLOUR_REACH)
    c0, c1 = max(int(tx - X0 - reach), 0), int(tx - X0 + reach) + 1
    r0, r1 = max(int(Y1 - ty - reach), 0), int(Y1 - ty + reach) + 1
    cols, rows = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
    cols, rows = cols[(rows < nd.shape[0]) & (cols < nd.shape[1])], rows[(rows < nd.shape[0]) & (cols < nd.shape[1])]
    inside = np.hypot(X0 + cols + 0.5 - tx, Y1 - rows - 0.5 - ty) <= reach
    rows, cols = rows[inside], cols[inside]
    leaves = ~built[rows, cols] & (np.nan_to_num(nd[rows, cols], nan=-1) >= max(1.5, CROWN_SHARE * top))
    px = rgb[rows[leaves], cols[leaves]]
    px = px[np.isfinite(px).all(axis=1)]
    if len(px) < MIN_PIXELS:
        return []
    return [int(round(v * 255)) for v in np.median(px, axis=0)]


def leafy(rgb, built):
    """Where the photo shows leaves (rgb is NaN elsewhere: crown_colour), buildings left out."""
    return np.isfinite(rgb).all(axis=2) & ~built


def leaf_texture(area, t):
    """How grainy IPR's summer photo is at 0.25 m round each metre of the tile (rows from the
    north): the spread of its brightness over TEXTURE metres. A crown is grainy, leaf and
    shadow; a lawn, dry or green, is smooth. None without the photo."""
    try:
        hi = gc.photo(gc.RGB, "rgb", area, t)  # (the tile alone, as ground_cover.py keeps it)
    except Exception:  # noqa: BLE001
        return None
    lum = hi @ np.array([0.3, 0.59, 0.11], np.float32)
    k = round(TEXTURE / 0.25)
    mean = ndimage.uniform_filter(lum, k)
    spread = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, k) - mean * mean, 0))
    h, w = spread.shape[0] // 4, spread.shape[1] // 4
    return spread[:h * 4, :w * 4].reshape(h, 4, w, 4).mean(axis=(1, 3))


def canopy_cells(nd, built, box, rgb, clip, texture=None):
    """What grows in the tile, on a grid of CELL metres (rows from the south): 0 nothing with
    leaves (paving, water, dry grass), 1 leaves that the surface models see no higher than
    BANDS[0] (a lawn, a shrub, or trees too young for ČÚZK's older model that IPR's misses),
    and 2, 3, 4 canopy in the low, middle and tall BANDS. A cell takes the most of its metres.
    Leaves that the models see low but the photo shows grainy (`texture`, leaf_texture) are
    taken for low canopy: trees the models miss (IPR's reads many broadleaf crowns as the
    ground, and ČÚZK's is older than many trees), not a lawn; so is a small patch of leaves
    on its own (LONE_PATCH), a young tree in dry grass.
    The game makes trees up only where there are leaves, and in a band as high as it says
    (vegetation.ts), and fills the canopy that the mapped trees' crowns leave uncovered.
    {"w", "h", "runs"}: `runs` the cells row by row as runs of three characters each, the
    value and its length in base 36. None without a photo."""
    if rgb is None:
        return None
    seen = leafy(rgb, built)
    leaves = ndimage.binary_opening(seen)
    high = ndimage.median_filter(np.nan_to_num(nd, nan=0.0), size=3)
    cls = leaves.astype(np.uint8)
    for k, low in enumerate(BANDS):
        band = ndimage.binary_opening(leaves & (high >= low))
        cls[band] = k + 2
    # A small patch of leaves on its own, in dry grass or on paving: a young tree or a shrub
    # (too small for the models), not a lawn, which is one wide patch.
    patches, n = ndimage.label(seen)
    if n:
        size = np.bincount(patches.ravel())
        alone = (size <= LONE_PATCH) & (size >= 2)
        alone[0] = False
        cls[alone[patches] & (cls < 2)] = 2
    # The tile's own metres (MARGIN round it in `box`), in CELL-metre cells.
    x0, y0, x1, y1 = clip
    r0, c0 = round(box[3] - y1), round(x0 - box[0])
    own = cls[r0:r0 + round(y1 - y0), c0:c0 + round(x1 - x0)]
    if texture is not None:
        h, w = min(own.shape[0], texture.shape[0]), min(own.shape[1], texture.shape[1])
        grainy = (own[:h, :w] == 1) & (ndimage.uniform_filter(texture[:h, :w], 3) > GRAINY)
        own = own.copy()
        own[:h, :w][ndimage.binary_opening(grainy, iterations=2)] = 2
    h, w = -(-own.shape[0] // CELL), -(-own.shape[1] // CELL)
    padded = np.zeros((h * CELL, w * CELL), np.uint8)
    padded[:own.shape[0], :own.shape[1]] = own
    cells = padded.reshape(h, CELL, w, CELL).max(axis=(1, 3))[::-1]
    flat, runs, k = cells.ravel(), [], 0
    while k < len(flat):
        n = 1
        while k + n < len(flat) and flat[k + n] == flat[k] and n < 36 * 36 - 1:
            n += 1
        runs.append(f"{flat[k]}{np.base_repr(n, 36).lower():0>2}")
        k += n
    return {"w": w, "h": h, "runs": "".join(runs)}


def tile_job(job):
    """(key, sizes, canopy cells or None, how many trees) for one tile."""
    area, meta, i, j = job
    t = {"i": i, "j": j, "box": [round(v, 2) for v in layers.tile_box(meta, i, j)]}
    own = placed_tile(area, i, j).get("trees", [])
    got = canopy(area, meta, t)
    if got is None:
        return f"{i}_{j}", [], None, len(own)
    nd, built, box, rgb = got
    bands = canopy_cells(nd, built, box, rgb, t["box"], leaf_texture(area, t) if rgb is not None else None)
    if not own:
        return f"{i}_{j}", [], bands, 0
    others = [p[:2] for di in (-1, 0, 1) for dj in (-1, 0, 1) for p in
              (own if (di, dj) == (0, 0) else placed_tile(area, i + di, j + dj).get("trees", []))]
    return f"{i}_{j}", measure(nd, built, box, own, np.asarray(others, float), rgb), bands, len(own)


def run(area, tiles, jobs, write=True):
    from concurrent.futures import ProcessPoolExecutor
    meta = layers.read_meta(area)
    terrain = layers.read_layer(area, "terrain")
    if not meta or not terrain:
        raise SystemExit(f"{area}: the layers and the terrain heights are needed first (build_tiles.py, ipr_terrain.py)")
    meta = {**meta, "terrain": terrain["index"]}
    def wanted(t):  # a tile with trees, or with ground where the game makes some up
        return t.get("trees") or any(t.get("areas", {}).get(k) for k in GREEN)
    todo = [(area, meta, i, j) for ci, cj in layers.chunks(meta) for i, j in layers.chunk_tiles(meta, ci, cj)
            if (tiles is None or (i, j) in tiles) and wanted(placed_tile(area, i, j))]
    found, bands = {}, {}
    if tiles is not None and write:  # a trial on some tiles adds to what the layer already has
        before = layers.read_layer(area, "treesize") or {}
        found, bands = dict(before.get("tiles", {})), dict(before.get("canopy", {}))
    started, total, sized, young, tops, radii = time.time(), 0, 0, 0, [], []
    with ProcessPoolExecutor(jobs) as pool:
        for n, (k, sizes, canopy_, count) in enumerate(pool.map(tile_job, todo, chunksize=2), 1):
            found.pop(k, None)
            bands.pop(k, None)
            if sizes:
                found[k] = sizes
            if canopy_ is not None:
                bands[k] = canopy_
            total += count
            grown = [s for s in sizes if s[3] > 0]
            sized += len(grown)
            young += len(sizes) - len(grown)
            tops += [s[2] for s in grown]
            radii += [s[3] for s in grown]
            if n % 100 == 0:
                print(f"  {n}/{len(todo)} tiles in {time.time() - started:.0f} s", flush=True)
    if tops:
        print(f"{sized} of {total} trees measured, {young} young; top 10/50/90 %: {np.percentile(tops, [10, 50, 90]).round(1).tolist()} m, "
              f"crown radius 10/50/90 %: {np.percentile(radii, [10, 50, 90]).round(1).tolist()} m")
    if not write:
        return
    layers.write_layer(area, "treesize", {"tile": meta["tile"], "tiles": found, "canopy": bands, "processing": processing(),
                                          "sources": build_cache.sources([gc.IPR_DSM] if gc.DSM_SOURCE == "ipr" else [])})
    print(f"treesize: {len(found)} tiles with trees, {len(bands)} with the canopy, {time.time() - started:.0f} s")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "survey"])
    ap.add_argument("area", choices=AREAS)
    ap.add_argument("tiles", nargs="*", type=int, metavar="I0 I1 J0 J1")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--no-assemble", action="store_true", help="build: leave the game's tiles alone")
    args = ap.parse_args()
    if len(args.tiles) not in (0, 4):
        ap.error("takes no tile range or I0 I1 J0 J1")
    wanted = gc.tiles_in(*args.tiles) if args.tiles else None
    run(args.area, wanted, args.jobs, write=args.cmd == "build")
    if args.cmd == "build" and not args.no_assemble:
        layers.assemble(args.area)


if __name__ == "__main__":
    main()
