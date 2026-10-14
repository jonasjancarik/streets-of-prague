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
every crown whole. A tree that both read as lower than MIN_TOP is left out: it is young, or
the models miss it, and the game keeps making its size up.

    uv run --group cover tree_sizes.py build praha              # every tile with a tree
    uv run --group cover tree_sizes.py build praha 50 52 59 61  # tiles i0 i1 j0 j1
    uv run --group cover tree_sizes.py survey praha 50 52 59 61 # the sizes found, no files written

It measures the trees of the game's tiles as they were last assembled (public/data), and
writes the layer `treesize`: per tile, [x, y, top, radius, *outline, r, g, b] (metres; the
outline in hundredths of the radius; the colour only when the photo shows the crown).
layers.assemble puts each into the tile's tree at that place, as [x, y, kind, top, radius,
*outline, r, g, b] (kind 0 when the map doesn't know it). A tree that moved since keeps a made-up size until this runs again. The
ČÚZK model is fetched once per tile into .cache/cover/img/dsm_1m_wide (shared with
young_woods.py).
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
LEAVES = 0.2       # the vegetation index above which the photo shows leaves (as ground_cover.py takes it)


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
    enough, followed by its crown's colour in the photo `rgb` ([r, g, b], 0 to 255) when there is one.
    `others`: every tree near, own included, as an (n, 2) array."""
    X0, Y1 = box[0], box[3]
    H, W = nd.shape
    ok = np.isfinite(nd) & ~built
    angles = np.linspace(0, 2 * np.pi, RAYS, endpoint=False)
    steps = np.arange(STEP, REACH + 1e-6, STEP)
    out = []
    for x, y, *_ in own:
        # The top: the highest open metre round the tree.
        c0, r0 = int(x - X0 - TOP_SEARCH), int(Y1 - y - TOP_SEARCH)
        c1, r1 = int(x - X0 + TOP_SEARCH) + 1, int(Y1 - y + TOP_SEARCH) + 1
        if c0 < 0 or r0 < 0 or c1 > W or r1 > H:
            continue
        win = np.where(ok[r0:r1, c0:c1], nd[r0:r1, c0:c1], -np.inf)
        r, c = np.unravel_index(np.argmax(win), win.shape)
        top = float(win[r, c])
        if top < MIN_TOP:
            continue
        tx, ty = X0 + c0 + c + 0.5, Y1 - (r0 + r + 0.5)
        # The rays from the top, sampled at once: (RAYS, steps).
        px = tx + np.cos(angles)[:, None] * steps
        py = ty + np.sin(angles)[:, None] * steps
        cols, rows = (px - X0).astype(int), (Y1 - py).astype(int)
        inside = (cols >= 0) & (cols < W) & (rows >= 0) & (rows < H)
        cols, rows = np.clip(cols, 0, W - 1), np.clip(rows, 0, H - 1)
        crown = inside & ok[rows, cols] & (np.nan_to_num(nd[rows, cols], nan=-1) >= max(1.5, CROWN_SHARE * top))
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
        radius = float(rays.mean())
        out.append([round(x, 1), round(y, 1), round(top, 1), round(radius, 1), *outline(x, y, tx, ty, angles, rays, radius),
                    *crown_colour(nd, built, box, rgb, tx, ty, top, radius)])
    return out


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


def tile_job(job):
    area, meta, i, j = job
    t = {"i": i, "j": j, "box": [round(v, 2) for v in layers.tile_box(meta, i, j)]}
    own = placed_tile(area, i, j).get("trees", [])
    if not own:
        return f"{i}_{j}", [], 0
    got = canopy(area, meta, t)
    if got is None:
        return f"{i}_{j}", [], len(own)
    nd, built, box, rgb = got
    others = [p[:2] for di in (-1, 0, 1) for dj in (-1, 0, 1) for p in
              (own if (di, dj) == (0, 0) else placed_tile(area, i + di, j + dj).get("trees", []))]
    return f"{i}_{j}", measure(nd, built, box, own, np.asarray(others, float), rgb), len(own)


def run(area, tiles, jobs, write=True):
    from concurrent.futures import ProcessPoolExecutor
    meta = layers.read_meta(area)
    terrain = layers.read_layer(area, "terrain")
    if not meta or not terrain:
        raise SystemExit(f"{area}: the layers and the terrain heights are needed first (build_tiles.py, ipr_terrain.py)")
    meta = {**meta, "terrain": terrain["index"]}
    todo = [(area, meta, i, j) for ci, cj in layers.chunks(meta) for i, j in layers.chunk_tiles(meta, ci, cj)
            if (tiles is None or (i, j) in tiles) and placed_tile(area, i, j).get("trees")]
    found = {}
    if tiles is not None and write:  # a trial on some tiles adds to what the layer already has
        found = dict((layers.read_layer(area, "treesize") or {}).get("tiles", {}))
    started, total, sized, tops, radii = time.time(), 0, 0, [], []
    with ProcessPoolExecutor(jobs) as pool:
        for n, (k, sizes, count) in enumerate(pool.map(tile_job, todo, chunksize=2), 1):
            found.pop(k, None)
            if sizes:
                found[k] = sizes
            total += count
            sized += len(sizes)
            tops += [s[2] for s in sizes]
            radii += [s[3] for s in sizes]
            if n % 100 == 0:
                print(f"  {n}/{len(todo)} tiles in {time.time() - started:.0f} s", flush=True)
    if tops:
        print(f"{sized} of {total} trees measured; top 10/50/90 %: {np.percentile(tops, [10, 50, 90]).round(1).tolist()} m, "
              f"crown radius 10/50/90 %: {np.percentile(radii, [10, 50, 90]).round(1).tolist()} m")
    if not write:
        return
    layers.write_layer(area, "treesize", {"tile": meta["tile"], "tiles": found, "processing": processing(),
                                          "sources": build_cache.sources([gc.IPR_DSM] if gc.DSM_SOURCE == "ipr" else [])})
    print(f"treesize: {len(found)} tiles, {time.time() - started:.0f} s")


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
