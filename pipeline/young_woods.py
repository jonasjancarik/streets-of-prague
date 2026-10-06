"""Young woods: where a mapped wood is not yet tall.

OSM and the technical map call a young plantation or an overgrown field "wood", and the
game fills every wood with full-grown trees. IPR Praha's 2025 surface model (1 m, the same
file ground_cover.py uses) minus the terrain heights says how high the canopy really is.
Inside a wood, the places where it tops out between 1.5 and 7 m are written to the young
layer as polygons; assemble() puts them into the tile as `areas.young_wood`, and
src/map/vegetation.ts plants small, close trees there. Where nothing stands higher than
1.5 m and IPR's summer aerial photo shows open, sunlit ground (a clearing, a meadow or a
field inside the wood's outline, the strip under a power line) the place is written as a
clearing, `areas.wood_clearing`: the game draws grass there and plants only the shrubs of a
wood's edge. The photo is needed because the surface model alone is not enough: over many
closed stands in the city's woods it lies at ground level (in Divoká Šárka whole tiles of
tall forest read as bare), and a rock face, a road or a pond is low too. The photos are
fetched once, at 1 m, for the tiles with a low patch (.cache/cover/photos/<area>/rgb_1m).
The surface model only covers the city, so a wood outside
it stays as it was.

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
MIN_WOOD = 2000.0  # m2 of wood in a tile below which it isn't looked at


def wood_of(ground_tile):
    """The tile's wood outlines (OSM's and the technical map's) as polygons-with-holes."""
    a = ground_tile.get("areas", {})
    return [*a.get("wood", []), *a.get("dtm_wood", [])]


def open_ground(area, t):
    """Where IPR's summer photo shows open ground rather than a canopy, rock or paving, over
    the tile at RES (rows from the north). None where there is no photo."""
    try:
        rgb = gc.photo(gc.RGB, "rgb_1m", area, t, RES)
    except Exception as e:  # noqa: BLE001 - no photo, no clearings: the wood stays as it was
        print(f"  no photo for tile {t['i']}_{t['j']} ({e})", flush=True)
        return None
    bright, dull = rgb.max(axis=2), rgb.min(axis=2)
    colour = (bright - dull) / np.maximum(bright, 1e-3)
    return ((ndimage.uniform_filter(bright, OPEN_WINDOW) > OPEN_BRIGHT)
            & (ndimage.uniform_filter(colour, OPEN_WINDOW) > OPEN_COLOUR))


def young_mask(area, meta, t, wood):
    """(young mask, clearing mask, wood mask) over the tile at RES, rows from the north: True
    where the wood's canopy is young, and where there is none. Where the surface model has
    nothing the answer is False."""
    try:
        dsm = gc.ipr_dsm(area, t, RES, cache=False)
    except ValueError:  # the tile lies wholly outside IPR's file
        dsm = np.zeros(gc.grid(t, RES)[0].shape, np.float32)
    hm, step = gc.terrain(area, meta, t)
    X, Y = gc.grid(t, RES)
    x0, y0 = t["box"][0], t["box"][1]
    dtm = ndimage.map_coordinates(np.nan_to_num(hm, nan=np.nanmean(hm)), [(Y - y0) / step, (X - x0) / step], order=1, mode="nearest")
    known = dsm > 100  # (IPR's file is zero, or filled in with the tile's median, outside the city)
    ndsm = np.where(known, dsm - dtm, np.nan)
    in_wood = gc.burn(np.zeros(dsm.shape, bool), t, RES, wood)
    top = ndimage.percentile_filter(np.nan_to_num(ndsm, nan=-10), 80, size=WINDOW)
    young = tidy(in_wood & known & (top >= LOW) & (top < HIGH), in_wood, MIN_AREA)
    clear = tidy(in_wood & known & (top < LOW), in_wood, CLEAR_MIN)
    if clear.any():
        rise_y, rise_x = np.gradient(ndimage.gaussian_filter(dtm, 2), RES)
        open_ = open_ground(area, t)
        clear = tidy(clear & open_ & (np.hypot(rise_x, rise_y) < STEEP), in_wood, CLEAR_MIN) if open_ is not None else clear & False
    return young, clear, in_wood


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


def vectorise(mask, t, wood, min_area=MIN_AREA):
    """The mask as smooth polygons in local metres, kept inside the wood outlines."""
    x0, _, _, y1 = t["box"]
    m = ndimage.gaussian_filter(np.pad(mask.astype(float), 1), 0.8)
    g = Polygon()
    for cs in find_contours(m, 0.5):
        if len(cs) > 3:
            g = g.symmetric_difference(Polygon([(x0 + (c - 1 + 0.5) * RES, y1 - (r - 1 + 0.5) * RES) for r, c in cs]).buffer(0))
    if g.is_empty:
        return []
    inside = Polygon()
    for rings in wood:
        inside = inside.union(Polygon(rings[0], rings[1:]).buffer(0))
    g = g.simplify(0.5).buffer(0).intersection(inside).intersection(shapely_box(*t["box"]))
    return [r for r in gc.rings_of(g) if Polygon(r[0], r[1:]).area >= min(min_area / 2, 25)]


def round_rings(polys):
    return [[[[round(x, 1), round(y, 1)] for x, y in ring] for ring in poly] for poly in polys]


def tile_job(job):
    """(key, young polygons, clearing polygons, young share, clear share, wood m2) for one tile."""
    area, meta, i, j, box, wood, height = job
    t = {"i": i, "j": j, "box": box}
    mask, clear, in_wood = young_mask(area, meta, t, wood)
    wood_m2 = float(in_wood.sum()) * RES * RES
    total = max(in_wood.sum(), 1)
    return (f"{i}_{j}", round_rings(vectorise(mask, t, wood)) if mask.any() else [],
            round_rings(vectorise(clear, t, wood, CLEAR_MIN)) if clear.any() else [],
            float(mask.sum()) / total, float(clear.sum()) / total, wood_m2)


def tile_key(wood, height):
    return build_cache.digest(layers.dumps([wood, height]).encode())


def processing():
    return [build_cache.digest(Path(__file__).read_bytes())]


def jobs_for(area, meta, terrain, want):
    for ci, cj in layers.chunks(meta):
        ground = layers.read_chunk(area, "ground", ci, cj)["tiles"]
        for i, j in layers.chunk_tiles(meta, ci, cj):
            k = f"{i}_{j}"
            if want is not None and (i, j) not in want:
                continue
            wood = wood_of(ground.get(k) or {})
            if not wood:
                continue
            if sum(Polygon(r[0], r[1:]).buffer(0).area for r in wood) < MIN_WOOD:
                continue
            box = [round(v, 2) for v in layers.tile_box(meta, i, j)]
            yield area, meta, i, j, box, wood, layers.height_digest(terrain, k)


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
