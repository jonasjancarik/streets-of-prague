"""What window.py's builds say round a point, and where two of them differ.

    cd pipeline
    uv run python ../.agents/skills/terrain-steps/window_diff.py table a.npz <x> <y> [metres either way, 20]
    uv run python ../.agents/skills/terrain-steps/window_diff.py diff before.npz after.npz [--all]
    uv run python ../.agents/skills/terrain-steps/window_diff.py built a.npz

table: the terrain model, the build's heights with each point's label, IPR's 2023 LiDAR
and the build minus the LiDAR, as tables round a point in the map's local metres (rows
from the north), heights less 200 m.
diff: the lattice points that differ by more than 0.15 m, each with the LiDAR's height
there, the largest changes first (the first 40 unless --all), and how many moved nearer
the LiDAR. The LiDAR is the bare earth: under a bridge, on a viaduct the map doesn't
draw and on a wall's face it isn't the street, so read the list, not only the count.
built: the same against the built map's tiles in public/data (how far the window is off
the real build: a handful of points a tile by 0.2–0.6 m, more at the window's rim).
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
import ipr_lidar  # noqa: E402
from osm_area import AREAS  # noqa: E402

AREA = "praha"
w_, s_, e_, n_ = AREAS[AREA]
LOCAL = f"+proj=tmerc +lat_0={(s_ + n_) / 2} +lon_0={(w_ + e_) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
BASE = 200


def scan_at(x, y):
    at, _ = ipr_lidar.sampler(ipr_lidar.CACHE, LOCAL)
    return at(np.asarray(x, float), np.asarray(y, float))


def table(path, cx, cy, r=20.0):
    w = np.load(path)
    x, y = w["x"], w["y"]
    ps, qs = np.flatnonzero(np.abs(x - cx) <= r), np.flatnonzero(np.abs(y - cy) <= r)[::-1]
    gx, gy = np.meshgrid(x[ps], y[qs])
    scan = scan_at(gx.ravel(), gy.ravel()).reshape(gx.shape)
    for name in ("terrain model", "built", "LiDAR", "built minus LiDAR"):
        print(f"{name} (less {BASE} m); x {x[ps[0]]:.0f} … {x[ps[-1]]:.0f}")
        for a, q in enumerate(qs):
            cells = []
            for b, p in enumerate(ps):
                if name == "LiDAR":
                    cells.append(f"{scan[a, b] - BASE:6.1f}  ")
                elif name == "terrain model":
                    cells.append(f"{w['bare'][q, p] - BASE:6.1f}  ")
                elif name == "built":
                    cells.append(f"{w['h'][q, p] - BASE:6.1f}.{w['label'][q, p]}")
                else:
                    cells.append(f"{w['h'][q, p] - scan[a, b]:+6.1f}  ")
            print(f"{y[q]:8.0f} " + " ".join(cells))


def built(x, y):
    """The built map's heights and labels on a window's lattice."""
    data = ROOT / "public" / "data" / f"{AREA}_now"
    index = json.loads((data / "index.json").read_text())
    T, (ox, oy), size = index["tile"], index["origin"], index["terrain"]["n"]
    N = size - 1
    h = np.full((len(y), len(x)), np.nan, dtype=np.float32)
    lab = np.zeros(h.shape, np.uint8)
    i0, j0 = round((x[0] + ox) / T), round((y[0] + oy) / T)
    for a in range((len(x) - 1) // N):
        for b in range((len(y) - 1) // N):
            p = data / "tiles" / f"{i0 + a}_{j0 + b}.height.bin.gz"
            if not p.exists():
                continue
            raw = gzip.decompress(p.read_bytes())
            h[b * N:b * N + size, a * N:a * N + size] = np.frombuffer(raw[:size * size * 2], "<u2").reshape(size, size) * index["terrain"].get("unit", 0.1) + 100
            lab[b * N:b * N + size, a * N:a * N + size] = np.frombuffer(raw[size * size * 2:], "u1").reshape(size, size)
    return h, lab


def diff(x, y, ha, hb, everything=False):
    q, p = np.nonzero(np.abs(np.round(ha, 1) - np.round(hb, 1)) > 0.15)
    scan = scan_at(x[p], y[q])
    ea, eb = np.abs(ha[q, p] - scan), np.abs(hb[q, p] - scan)
    ok = np.isfinite(scan)
    print(f"{len(q)} points differ" + (f"; from the LiDAR {np.mean(ea[ok]):.2f} m before and {np.mean(eb[ok]):.2f} m after on average, "
                                       f"nearer it at {int((eb[ok] < ea[ok] - 0.1).sum())} and further at {int((eb[ok] > ea[ok] + 0.1).sum())}" if ok.any() else ""))
    order = np.argsort(-np.abs(ha[q, p] - hb[q, p]))
    for k in order if everything else order[:40]:
        print(f"  ({x[p[k]]:8.1f}, {y[q[k]]:8.1f})  {ha[q[k], p[k]]:6.1f} -> {hb[q[k], p[k]]:6.1f}   LiDAR {scan[k]:6.1f}")


def main():
    what, args = sys.argv[1], sys.argv[2:]
    if what == "table":
        table(args[0], *map(float, args[1:]))
    elif what == "diff":
        a, b = np.load(args[0]), np.load(args[1])
        diff(a["x"], a["y"], a["h"], b["h"], "--all" in args)
    elif what == "built":
        a = np.load(args[0])
        diff(a["x"], a["y"], built(a["x"], a["y"])[0], a["h"], "--all" in args)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
