"""Young woods: where a mapped wood is not yet tall.

OSM and the technical map call a young plantation or an overgrown field "wood", and the
game fills every wood with full-grown trees. IPR Praha's 2025 surface model (1 m, the same
file ground_cover.py uses) minus the terrain heights says how high the canopy really is.
Inside a wood, the places where it tops out between 1.5 and 7 m are written to the young
layer as polygons; assemble() puts them into the tile as `areas.young_wood`, and
src/map/vegetation.ts plants small, close trees there. IPR's model alone is not to be
trusted for that either (it reads many closed broadleaf stands as a few metres high, or as
bare ground), so a low place counts as young only if ČÚZK's older surface model (DMP 1G)
was low there too (under 4 m: scrub, a hedge, an overgrown field), or if IPR's summer photo
shows it bright (a canopy that was tall then and is low and sunlit now was felled and is
growing back; one that is dark with its own shadows is still a closed wood). Where nothing stands higher than
1.5 m and IPR's summer aerial photo shows open, sunlit ground (a clearing, a meadow or a
field inside the wood's outline, the strip under a power line) the place is written as a
clearing, `areas.wood_clearing`: the game draws grass there and plants only the shrubs of a
wood's edge. The photo is needed because the surface model alone is not enough: over many
closed stands in the city's woods it lies at ground level (in Divoká Šárka whole tiles of
tall forest read as bare), and a rock face, a road or a pond is low too. The photos and the
older model are fetched once, at 1 m, for the tiles with a low patch
(.cache/cover/photos/<area>/rgb_1m_wide, .cache/cover/img/dsm_1m_wide). Every tile is worked
out together with a MARGIN of its neighbours' ground, so a patch has the same outline on
both sides of a tile border. The surface model only covers the city, so a wood outside it
stays as it was.

    uv run --group cover young_woods.py build praha            # every tile with a wood
    uv run --group cover young_woods.py build praha 60 70 20 30  # tiles i0 i1 j0 j1
    uv run --group cover young_woods.py survey praha             # share of young wood, no files written

It reads the ground layer's wood outlines and the terrain layer's heights, so it does not
depend on the ground cover, and ground_cover.py's results stay valid.
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
from scipy import ndimage
from shapely.geometry import Polygon, box as shapely_box
from skimage.measure import find_contours

import build_cache
import layers
import ground_cover as gc
from osm_area import AREAS

RES = 1.0          # m per pixel: the surface model's own
LOW, HIGH = 1.5, 7.0   # canopy tops between these (m above the ground) are a young wood
WINDOW = 9         # the canopy top is taken as the 80th percentile over this many metres
MIN_AREA = 250.0   # m2: smaller patches are left out
CLEAR_MIN = 400.0  # m2: the smallest clearing (a gap between crowns is not one)
# Open ground in the photo, against a canopy: the brightness (the largest of red, green
# and blue, 0 to 1) averaged over OPEN_WINDOW metres is above OPEN_BRIGHT (a closed canopy in
# the July photos is 0.29 to 0.33 with its own shadows, mown or dry grass 0.45 to 0.75), and
# the colour is not grey (rock, asphalt, gravel and roofs are under OPEN_COLOUR in saturation).
OPEN_WINDOW, OPEN_BRIGHT, OPEN_COLOUR = 9, 0.42, 0.11
STEEP = 0.7        # rise over run: steeper ground (35 degrees) is a rock face or a cutting, not a clearing
# A young wood, apart from a closed one that IPR's surface model reads as low: under
# EARLIER_LOW m in ČÚZK's older surface model as well, or brighter than REGROWTH_BRIGHT in the
# photo (the same measure as OPEN_BRIGHT; closed canopy is 0.29 to 0.33).
EARLIER_LOW, REGROWTH_BRIGHT = 4.0, 0.37
MARGIN = 16        # m of the neighbouring tiles worked out with each tile
MIN_WOOD = 2000.0  # m2 of wood in a tile below which it isn't looked at


def wood_of(ground_tile):
    """The tile's wood outlines (OSM's and the technical map's) as polygons-with-holes."""
    a = ground_tile.get("areas", {})
    return [*a.get("wood", []), *a.get("dtm_wood", [])]


def wide(t, meta):
    """The tile with MARGIN metres of its neighbours on every side."""
    x0, y0, x1, y1 = t["box"]
    return {**t, "box": [x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN], "tile": t["box"], "size": meta.get("tile", x1 - x0)}


def wide_terrain(area, meta, tw):
    """Terrain heights over the widened tile at RES (rows from the north), from the tile's own
    lattice and its neighbours' (their outer rows are shared). Past the map's edge, or where
    a neighbour has no heights, the nearest known height."""
    i, j, T = tw["i"], tw["j"], tw["size"]
    n = meta["terrain"]["n"]
    mosaic = np.full((3 * (n - 1) + 1, 3 * (n - 1) + 1), np.nan, np.float32)
    step = None
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            try:
                hm, step_ = gc.terrain(area, meta, {"i": i + di, "j": j + dj})
            except OSError:
                continue
            step = step or step_
            r, c = (dj + 1) * (n - 1), (di + 1) * (n - 1)
            mosaic[r:r + n, c:c + n] = np.where(np.isnan(hm), mosaic[r:r + n, c:c + n], hm)
    if step is None or np.isnan(mosaic).all():
        raise OSError(f"no terrain heights for tile {i}_{j}")
    if np.isnan(mosaic).any():
        near = ndimage.distance_transform_edt(np.isnan(mosaic), return_distances=False, return_indices=True)
        mosaic = mosaic[tuple(near)]
    X, Y = gc.grid(tw, RES)
    x0, y0 = tw["tile"][0] - T, tw["tile"][1] - T
    return ndimage.map_coordinates(mosaic, [(Y - y0) / step, (X - x0) / step], order=1, mode="nearest")


def brightness(area, tw):
    """(brightness, saturation) of IPR's summer photo over the widened tile at RES (rows from
    the north), each averaged over OPEN_WINDOW metres. None where there is no photo."""
    try:
        rgb = gc.photo(gc.RGB, "rgb_1m_wide", area, tw, RES)
    except Exception as e:  # noqa: BLE001 - no photo: nothing is told apart by it
        print(f"  no photo for tile {tw['i']}_{tw['j']} ({e})", flush=True)
        return None
    bright, dull = rgb.max(axis=2), rgb.min(axis=2)
    colour = (bright - dull) / np.maximum(bright, 1e-3)
    return ndimage.uniform_filter(bright, OPEN_WINDOW), ndimage.uniform_filter(colour, OPEN_WINDOW)


def earlier_top(area, tw, dtm):
    """The canopy top in ČÚZK's older surface model (DMP 1G), as `top` is taken from IPR's.
    None if it can't be had."""
    try:
        dsm = gc.export(gc.DSM, "dsm_1m_wide", area, tw, RES, 1.0, fmt="tiff",
                        extra={"pixelType": "F32", "interpolation": "RSP_BilinearInterpolation"})[:, :, 0]
    except Exception as e:  # noqa: BLE001
        print(f"  no earlier surface model for tile {tw['i']}_{tw['j']} ({e})", flush=True)
        return None
    return ndimage.percentile_filter(np.where(dsm > 100, dsm - dtm, 99.0), 80, size=WINDOW)


def wide_masks(area, meta, t, wood, around=()):
    """(young mask, clearing mask, wood mask, the widened tile) over the tile and MARGIN metres
    round it at RES, rows from the north. `around`: the neighbouring tiles' wood outlines."""
    tw = wide(t, meta)
    try:
        dsm = gc.ipr_dsm(area, tw, RES, cache=False)
    except ValueError:  # the tile lies wholly outside IPR's file
        dsm = np.zeros(gc.grid(tw, RES)[0].shape, np.float32)
    dtm = wide_terrain(area, meta, tw)
    known = dsm > 100  # (IPR's file is zero, or filled in with the tile's median, outside the city)
    ndsm = np.where(known, dsm - dtm, np.nan)
    in_wood = gc.burn(np.zeros(dsm.shape, bool), tw, RES, [*wood, *around])
    top = ndimage.percentile_filter(np.nan_to_num(ndsm, nan=-10), 80, size=WINDOW)
    young = tidy(in_wood & known & (top >= LOW) & (top < HIGH), in_wood, MIN_AREA)
    clear = tidy(in_wood & known & (top < LOW), in_wood, CLEAR_MIN)
    photo = brightness(area, tw) if young.any() or clear.any() else None
    if young.any():
        earlier = earlier_top(area, tw, dtm)
        was_low = earlier < EARLIER_LOW if earlier is not None else False
        regrowth = (photo[0] > REGROWTH_BRIGHT) & (photo[1] > OPEN_COLOUR) if photo is not None else False
        young = tidy(young & (was_low | regrowth), in_wood, MIN_AREA)
    if clear.any():
        rise_y, rise_x = np.gradient(ndimage.gaussian_filter(dtm, 2), RES)
        open_ = (photo[0] > OPEN_BRIGHT) & (photo[1] > OPEN_COLOUR) if photo is not None else False
        clear = tidy(clear & open_ & (np.hypot(rise_x, rise_y) < STEEP), in_wood, CLEAR_MIN)
    return young, clear, in_wood, tw


def young_mask(area, meta, t, wood, around=()):
    """(young mask, clearing mask, wood mask) over the tile at RES, rows from the north: True
    where the wood's canopy is young, and where there is none. Where the surface model has
    nothing the answer is False."""
    young, clear, in_wood, _ = wide_masks(area, meta, t, wood, around)
    own = (slice(MARGIN, young.shape[0] - MARGIN), slice(MARGIN, young.shape[1] - MARGIN)) if MARGIN else (slice(None), slice(None))
    return young[own], clear[own], in_wood[own]


def tidy(mask, in_wood, min_area):
    """The mask without specks, pinholes and patches under `min_area`."""
    # (padded with the tile's own edge, so a patch does not shrink away from the tile border)
    mask = np.pad(mask, 4, mode="edge")
    mask = ndimage.binary_closing(ndimage.binary_opening(mask, iterations=2), iterations=2)[4:-4, 4:-4] & in_wood
    labels, n = ndimage.label(mask)
    if n:
        sizes = ndimage.sum(mask, labels, range(1, n + 1))
        # A patch cut by the tile's border may be smaller: the rest of it is next door.
        edge = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
        edge = edge[(edge > 0) & (sizes[np.maximum(edge, 1) - 1] >= min_area / 4)]
        mask &= np.isin(labels, np.union1d(1 + np.flatnonzero(sizes >= min_area), edge))
    return mask


def vectorise(mask, t, wood, min_area=MIN_AREA, clip=None):
    """The mask (over `t`, which may be a widened tile) as smooth polygons in local metres, kept
    inside the wood outlines and the box `clip` (the tile itself)."""
    x0, _, _, y1 = t["box"]
    # Carried on past the tile's edge before smoothing (and closed off beyond it), so a patch
    # that goes on next door reaches the edge squarely instead of leaving a gap along it.
    PAD = 4
    m = ndimage.gaussian_filter(np.pad(np.pad(mask.astype(float), PAD - 1, mode="edge"), 1), 0.8)
    g = Polygon()
    for cs in find_contours(m, 0.5):
        if len(cs) > 3:
            g = g.symmetric_difference(Polygon([(x0 + (c - PAD + 0.5) * RES, y1 - (r - PAD + 0.5) * RES) for r, c in cs]).buffer(0))
    if g.is_empty:
        return []
    inside = Polygon()
    for rings in wood:
        inside = inside.union(Polygon(rings[0], rings[1:]).buffer(0))
    g = g.simplify(0.5).buffer(0).intersection(inside).intersection(shapely_box(*(clip or t["box"])))
    return [r for r in gc.rings_of(g) if Polygon(r[0], r[1:]).area >= min(min_area / 2, 25)]


def round_rings(polys):
    return [[[[round(x, 1), round(y, 1)] for x, y in ring] for ring in poly] for poly in polys]


def tile_job(job):
    """(key, young polygons, clearing polygons, young share, clear share, wood m2) for one tile."""
    area, meta, i, j, box, wood, height, around = job
    t = {"i": i, "j": j, "box": box}
    mask, clear, in_wood, tw = wide_masks(area, meta, t, wood, around)
    own = (slice(MARGIN, mask.shape[0] - MARGIN), slice(MARGIN, mask.shape[1] - MARGIN)) if MARGIN else (slice(None), slice(None))
    wood_m2 = float(in_wood[own].sum()) * RES * RES
    total = max(in_wood[own].sum(), 1)
    return (f"{i}_{j}", round_rings(vectorise(mask, tw, wood, clip=box)) if mask[own].any() else [],
            round_rings(vectorise(clear, tw, wood, CLEAR_MIN, clip=box)) if clear[own].any() else [],
            float(mask[own].sum()) / total, float(clear[own].sum()) / total, wood_m2)


def tile_key(wood, height):
    return build_cache.digest(layers.dumps([wood, height]).encode())


def processing():
    return [build_cache.digest(Path(__file__).read_bytes())]


def jobs_for(area, meta, terrain, want):
    woods = {}  # every tile's wood outlines: a tile is worked out with its neighbours'
    for ci, cj in layers.chunks(meta):
        ground = layers.read_chunk(area, "ground", ci, cj)["tiles"]
        for i, j in layers.chunk_tiles(meta, ci, cj):
            wood = wood_of(ground.get(f"{i}_{j}") or {})
            if wood:
                woods[i, j] = wood
    for (i, j), wood in woods.items():
        if want is not None and (i, j) not in want:
            continue
        if sum(Polygon(r[0], r[1:]).buffer(0).area for r in wood) < MIN_WOOD:
            continue
        box = [round(v, 2) for v in layers.tile_box(meta, i, j)]
        around = [r for dj in (-1, 0, 1) for di in (-1, 0, 1) if (di or dj) for r in woods.get((i + di, j + dj), [])]
        yield area, meta, i, j, box, wood, layers.height_digest(terrain, f"{i}_{j}"), around


def run(area, tiles, jobs, write=True):
    from concurrent.futures import ProcessPoolExecutor
    meta = layers.read_meta(area)
    terrain = layers.read_layer(area, "terrain")
    if not meta or not terrain:
        raise SystemExit(f"{area}: the layers and the terrain heights are needed first (build_tiles.py, ipr_terrain.py)")
    if gc.DSM_SOURCE != "ipr":
        raise SystemExit(f"{gc.IPR_DSM} is missing: IPR's surface model (see ground_cover.py)")
    meta = {**meta, "terrain": terrain["index"]}
    want = set(tiles) if tiles else None
    todo = list(jobs_for(area, meta, terrain, want))
    found, cleared, keys, started, shares = {}, {}, {}, time.time(), []
    if want is not None and write:  # a trial on some tiles adds to what the layer already has
        before = layers.read_layer(area, "young") or {}
        found, cleared, keys = dict(before.get("tiles", {})), dict(before.get("clear", {})), dict(before.get("inputs", {}))
    by_key = {f"{j[2]}_{j[3]}": tile_key(j[5], j[6]) for j in todo}
    with ProcessPoolExecutor(jobs) as pool:
        for n, (k, polys, clear, share, clear_share, wood_m2) in enumerate(pool.map(tile_job, todo, chunksize=2), 1):
            shares.append((k, share, wood_m2, clear_share))
            keys[k] = by_key[k]
            found.pop(k, None)
            cleared.pop(k, None)
            if polys:
                found[k] = polys
            if clear:
                cleared[k] = clear
            if n % 50 == 0:
                print(f"  {n}/{len(todo)} tiles in {time.time() - started:.0f} s", flush=True)
    wood_total = sum(w for _, _, w, _ in shares)
    young_total = sum(s * w for _, s, w, _ in shares)
    clear_total = sum(c * w for _, _, w, c in shares)
    print(f"{len(todo)} tiles with a wood: {wood_total / 1e4:.0f} ha of wood, {young_total / 1e4:.0f} ha of it young ({100 * young_total / max(wood_total, 1):.1f} %), "
          f"{clear_total / 1e4:.0f} ha clearings ({100 * clear_total / max(wood_total, 1):.1f} %); "
          f"{sum(1 for _, s, w, _ in shares if s * w >= MIN_AREA)} tiles with a young wood, "
          f"{sum(1 for _, _, w, c in shares if c * w >= CLEAR_MIN)} with a clearing")
    if not write:
        for k, s, w, c in sorted(shares, key=lambda r: -(r[1] + r[3]) * r[2])[:25]:
            print(f"  {k:>8}  wood {w / 1e4:5.2f} ha  young {100 * s:4.0f} %  clear {100 * c:4.0f} %")
        return
    layers.write_layer(area, "young", {
        "tile": meta["tile"], "tiles": found, "clear": cleared, "inputs": keys,
        "processing": processing(), "sources": build_cache.sources([gc.IPR_DSM])})
    print(f"young: {len(found)} tiles with young woods, {len(cleared)} with clearings, {time.time() - started:.0f} s")


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
