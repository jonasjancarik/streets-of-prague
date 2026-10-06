"""What stands on and lies in the streets, from the surface marks of IPR Praha's
technical map (Hosted/DTMP_CUR_TMISZNAK_B, the layer build_lamps.py takes the lamps
from): manhole covers, storm drains, hydrants, phone boxes and traffic lights. CC BY.

    uv run ipr_utility.py download        # the whole city → .cache/utility/marks.json
    uv run ipr_utility.py build praha     # → .cache/layers/praha/utility.json, then the tiles

A tile gets `utility`: [x, y, kind] in local metres for each cover, drain, hydrant and
phone box in it (layers.assemble). The game draws the covers and drains flat on the
ground, all of a tile's in one mesh (src/ground.ts), and the hydrants and phone boxes
with the other street furniture (src/furniture.ts). The traffic lights' poles are kept
for the whole area in the layer's `signals`; build_signals.py stands each junction
light on the surveyed pole nearest to where it would put one.
"""

import argparse
import time
from pathlib import Path

from pyproj import Transformer

import build_cache
import ipr_open
import layers
from osm_area import AREAS

LAYER = "DTMP_CUR_TMISZNAK_B"
# ctmtp_kod → the game's kind of thing (src/map/utility.ts draws them by kind).
MANHOLE, DRAIN, HYDRANT, PHONE, HYDRANT_COVER, SIGNAL = 0, 1, 2, 3, 4, 5
KINDS = {
    106200: MANHOLE,  # kanalizace - kanalizační šachta: a sewer manhole
    # vstup. šachta do podz. vedení: the way down to the other networks' lines
    106081: MANHOLE, 206081: MANHOLE, 256081: MANHOLE, 306081: MANHOLE, 406081: MANHOLE, 506081: MANHOLE,
    606081: MANHOLE, 706081: MANHOLE,
    106300: DRAIN,  # kanalizace - vpusť: a storm drain at the kerb
    406120: HYDRANT,  # vodovod - hydrant nadzemní: a hydrant standing above the ground
    406130: HYDRANT_COVER,  # vodovod - hydrant podzemní: the small cover of one under it
    736750: PHONE,  # telefonní budka volně stojící: a phone box
    605250: SIGNAL,  # semafor: a traffic light's pole
}


def download():
    """[[lon, lat, kind], …] for the whole city."""
    def marks():
        return [[f["geometry"]["x"], f["geometry"]["y"], KINDS[f["attributes"]["ctmtp_kod"]]]
                for f in ipr_open.pages(LAYER, where=f"ctmtp_kod IN ({','.join(map(str, KINDS))})", fields="ctmtp_kod",
                                        what="marks") if f.get("geometry")]
    return ipr_open.cached("utility/marks.json", marks)


SAME = 0.5  # m: two marks of a kind this close are one (a shaft recorded by two networks)


def processing():
    return [build_cache.digest(Path(__file__).read_bytes())]


def local_marks(area, meta):
    """The marks in the area as (x, y, kind) in its local metres, without doubles."""
    w, s, e, n = AREAS[area]
    tf = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True)
    near = [m for m in download() if w <= m[0] <= e and s <= m[1] <= n]
    if not near:
        return []
    xs, ys = tf.transform([m[0] for m in near], [m[1] for m in near])
    seen, out = set(), []
    for x, y, (_, _, kind) in zip(xs, ys, near):
        cell = (kind, round(x / SAME), round(y / SAME))
        if cell not in seen:
            seen.add(cell)
            out.append((x, y, kind))
    return out


def build(area):
    meta = layers.read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: run build_tiles.py {area} first")
    started = time.time()
    T, (x0, y0, _, _) = meta["tile"], meta["box"]
    tiles, signals, counts = {}, [], {}
    for x, y, kind in local_marks(area, meta):
        counts[kind] = counts.get(kind, 0) + 1
        if kind == SIGNAL:
            signals.append([round(x, 1), round(y, 1)])
            continue
        i, j = int((x - x0) // T), int((y - y0) // T)
        if 0 <= i < meta["cols"] and 0 <= j < meta["rows"]:
            tiles.setdefault(f"{i}_{j}", []).append([round(x, 1), round(y, 1), kind])
    layers.write_layer(area, "utility", {
        "tile": meta["tile"], "tiles": tiles, "signals": signals, "processing": processing(),
        "sources": build_cache.sources([ipr_open.CACHE / "utility" / "marks.json"])})
    names = ["manhole covers", "storm drains", "hydrants", "phone boxes", "hydrant covers", "traffic lights"]
    print(f"{area}: {', '.join(f'{counts.get(k, 0)} {name}' for k, name in enumerate(names))} in {len(tiles)} tiles, "
          f"at most {max(map(len, tiles.values()), default=0)} in one, {time.time() - started:.0f} s")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=["download", "build"])
    ap.add_argument("area", nargs="?", default="praha", choices=AREAS)
    ap.add_argument("--no-assemble", action="store_true", help="build: leave the game's tiles alone")
    args = ap.parse_args()
    if args.cmd == "download":
        print(len(download()), "marks")
        return
    build(args.area)
    if not args.no_assemble:
        layers.assemble(args.area)


if __name__ == "__main__":
    main()
