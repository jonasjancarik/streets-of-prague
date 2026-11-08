"""IPR's 2023 LiDAR ground at points of a built map, for scripts/check-road-flatness.mjs.

    uv run scan_heights.py praha points.f32 heights.f32 [--lidar .cache/ipr_lidar/2023]

points.f32 holds x, y pairs in the map's local metres (float32, as the tiles have them);
heights.f32 gets one height a.s.l. (Bpv) per point, NaN where the scan has none.
"""
import argparse
from pathlib import Path

import numpy as np

import ipr_lidar
from osm_area import AREAS

BATCH = 4_000_000  # points per transform: pyproj's arrays are float64, 32 bytes a point


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
    xy = np.fromfile(args.points, dtype="<f4").reshape(-1, 2)
    out = np.empty(len(xy), dtype="<f4")
    for i in range(0, len(xy), BATCH):
        part = xy[i:i + BATCH].astype(np.float64)
        out[i:i + BATCH] = at(part[:, 0], part[:, 1])
    out.tofile(args.heights)


if __name__ == "__main__":
    main()
