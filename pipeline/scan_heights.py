"""IPR's 2023 LiDAR ground at points of a built map, for scripts/check-road-flatness.mjs.

    uv run scan_heights.py praha points.f32 heights.f32 [--lidar .cache/ipr_lidar/2023]

points.f32 holds x, y, h triples: the map's local metres and its height a.s.l. there
(float32, as the tiles have them). heights.f32 gets two floats per point: the LiDAR's
height a.s.l. (Bpv), NaN where the scan has none; and the top of IPR's bridge model
within a few metres of the map's height (structures.deck_at), NaN where it has none.
The bare-earth LiDAR has no bridges: where the map's street is on a deck IPR has and OSM
doesn't call a bridge, it isn't off the ground.
"""
import argparse
from pathlib import Path

import numpy as np

import ipr_lidar
import structures
from osm_area import AREAS

BATCH = 4_000_000  # points per transform: pyproj's arrays are float64, 32 bytes a point
OFF = 1.0  # m: only points this far off the LiDAR are looked up in the bridge model


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("area")
    ap.add_argument("points", type=Path)
    ap.add_argument("heights", type=Path)
    ap.add_argument("--lidar", type=Path, default=ipr_lidar.CACHE)
    args = ap.parse_args()
    w, s, e, n = AREAS[args.area]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    at, _ = ipr_lidar.sampler(args.lidar, local)
    xyh = np.fromfile(args.points, dtype="<f4").reshape(-1, 3)
    out = np.full((len(xyh), 2), np.nan, dtype="<f4")
    for i in range(0, len(xyh), BATCH):
        part = xyh[i:i + BATCH].astype(np.float64)
        out[i:i + BATCH, 0] = at(part[:, 0], part[:, 1])
    with np.errstate(invalid="ignore"):
        far = np.flatnonzero(~(np.abs(xyh[:, 2] - out[:, 0]) <= OFF))
    if len(far):
        decks = structures.ipr_decks(local)
        out[far, 1] = [structures.deck_at(decks, x, y, h) for x, y, h in xyh[far].astype(np.float64)]
    out.tofile(args.heights)


if __name__ == "__main__":
    main()
