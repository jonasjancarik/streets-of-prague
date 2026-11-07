"""Where the road bumps in a flatness report come from: the terrain data or the build.

    uv run --project pipeline python pipeline/road_bump_causes.py REPORT.json [REPORT.json ...] \
        [--out docs/evidence/road-bumps/causes.json]

Each REPORT is a `check-road-flatness.mjs --save` file for a Prague build. The script
walks every car street of the current map (public/data/praha_now) as the checker does
(a sample a metre, ends trimmed) and measures the same bump (the middle against the
straight line 3 m either side) in IPR's raw 1 m LiDAR terrain. For each street over the
report's hard limit it says what is around the bump (a bridge or tunnel, a retaining
wall or quay, a junction, or plain ground) and whether the raw LiDAR has the bump too.
It also measures the bump in the LiDAR sampled on the game's 4 m lattice (in decimetres,
as the map stores it), to tell bumps the lattice makes from those the later corrections
and structures add, and counts the streets whose raw LiDAR alone would be over the limit.
"""
import argparse
import gzip
import json
import math
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import shapely
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import ipr_lidar  # noqa: E402
from osm_area import AREAS  # noqa: E402

DATA = ROOT / "public" / "data" / "praha_now"
LIDAR = HERE / ".cache" / "ipr_lidar" / "2023"
STEP, END, BUMP = 1.0, 4.0, 3.0  # as check-road-flatness.mjs
LIMIT = 0.5
INHERITED, CLEAN = 0.3, 0.15  # m: the raw LiDAR's own bump there
NEAR_STRUCTURE, NEAR_TERRACE, NEAR_JUNCTION = 20.0, 8.0, 15.0  # m from the bump


def read(path: Path) -> bytes:
    raw = path.read_bytes()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def load_map():
    index = json.loads((DATA / "index.json").read_text())
    T, (ox, oy) = index["tile"], index["origin"]
    edges, structures, terraces = {}, {}, {}
    for n, (i, j, *_) in enumerate(index["tiles"]):
        f = DATA / "tiles" / f"{i}_{j}.json"
        if not f.exists():
            continue
        t = json.loads(read(f))
        for e in t.get("drive", []):
            u, v, k = e["id"].split(">")
            key = e["id"] if u < v else f"{v}>{u}>{k}"
            had = edges.get(key)
            if not had or len(had["pts"]) < len(e["pts"]):
                edges[key] = e
        if t.get("structures"):
            structures[(i, j)] = t["structures"]
        if t.get("terraces"):
            terraces[(i, j)] = t["terraces"]
        if n % 5000 == 0:
            print(f"  read {n:,} of {len(index['tiles']):,} tiles", flush=True)
    return index, T, ox, oy, edges, structures, terraces


def walk(e):
    """Centreline samples a metre apart, as the checker walks a street."""
    out = []
    pts = e["pts"]
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        length = math.hypot(bx - ax, by - ay)
        if length < 1e-6:
            continue
        n = max(1, round(length / STEP))
        for k in range(n):
            out.append((ax + (bx - ax) * k / n, ay + (by - ay) * k / n))
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(np.array(out), axis=0).T))] if len(out) > 1 else np.zeros(len(out))
    return np.array(out).reshape(-1, 2), s


def bumps(h, s, width):
    """Each sample's bump against the line BUMP m either side, NaN where the checker skips it."""
    out = np.full(len(h), np.nan)
    if len(h) == 0:
        return out
    end = max(END, width or 0)
    inner = (s >= end) & (s <= s[-1] - end)
    b = round(BUMP / STEP)
    if len(h) > 2 * b:
        mid = h[b:-b] - (h[:-2 * b] + h[2 * b:]) / 2
        ok = inner[b:-b] & inner[:-2 * b] & inner[2 * b:]
        out[b:-b] = np.where(ok, mid, np.nan)
    return out


def on_lattice(at, xs, ys, step, ox, oy, quantum=0.1):
    """`at` sampled at the game's lattice points round each point (rounded to `quantum`
    as the map stores them), then bilinear between them: what the lattice alone keeps."""
    gx, gy = (xs + ox) / step, (ys + oy) / step
    i0, j0 = np.floor(gx), np.floor(gy)
    fa, fb = gx - i0, gy - j0
    h = {}
    for di in (0, 1):
        for dj in (0, 1):
            v = at((i0 + di) * step - ox, (j0 + dj) * step - oy).astype(float)
            h[di, dj] = np.round(v / quantum) * quantum
    return ((1 - fa) * (1 - fb) * h[0, 0] + fa * (1 - fb) * h[1, 0]
            + (1 - fa) * fb * h[0, 1] + fa * fb * h[1, 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("reports", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "evidence" / "road-bumps" / "causes.json")
    args = ap.parse_args()
    w, s_, e_, n_ = AREAS["praha"]
    local = f"+proj=tmerc +lat_0={(s_ + n_) / 2} +lon_0={(w + e_) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    lidar_at, _ = ipr_lidar.sampler(LIDAR, local)
    index, T, ox, oy, edges, structures, terraces = load_map()
    step = index["terrain"]["step"]
    print(f"{len(edges):,} car edges", flush=True)

    # Raw LiDAR along every street, in one batch.
    walks = {k: walk(e) for k, e in edges.items()}
    allpts = np.concatenate([p for p, _ in walks.values() if len(p)])
    heights = lidar_at(allpts[:, 0], allpts[:, 1]).astype(float)
    raw, start = {}, 0
    for k, (p, s) in walks.items():
        h = heights[start:start + len(p)]
        start += len(p)
        raw[k] = bumps(h, s, edges[k].get("width"))

    # Junctions: nodes where three or more streets meet.
    degree = Counter()
    for e in edges.values():
        degree[e["u"]] += 1
        degree[e["v"]] += 1
    ends = {}
    for e in edges.values():
        ends[e["u"]] = e["pts"][0]
        ends[e["v"]] = e["pts"][-1]
    junctions = cKDTree(np.array([ends[n] for n, d in degree.items() if d >= 3]))

    # The checker names places with its own transverse Mercator approximation.
    bw, bs, be, bn = index["bbox_wgs84"]
    lat0, lon0, rad = (bs + bn) / 2, (bw + be) / 2, math.pi / 180
    m_lat = 111132.92 - 559.82 * math.cos(2 * lat0 * rad)

    def to_wgs(x, y):
        lat = lat0 + y / m_lat
        m_lon = 111412.84 * math.cos(lat * rad) - 93.5 * math.cos(3 * lat * rad)
        return [round(lat, 5), round(lon0 + x / m_lon, 5)]

    def to_local(lat, lon):
        lat, lon = float(lat), float(lon)
        m_lon = 111412.84 * math.cos(lat * rad) - 93.5 * math.cos(3 * lat * rad)
        return (lon - lon0) * m_lon, (lat - lat0) * m_lat

    shapes = {}

    def around(x, y, kind, reach):
        """The tiles' structure or terrace outlines within reach of a point."""
        i, j = int((x + ox) // T), int((y + oy) // T)
        point = shapely.Point(x, y)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                key = (kind, i + di, j + dj)
                if key not in shapes:
                    src = (structures if kind == "structure" else terraces).get((i + di, j + dj), [])
                    geoms = []
                    for st in src:
                        for p in st["polys"]:
                            rings = [r for r in p if len(r) >= 3]
                            if rings:
                                geoms.append(shapely.make_valid(shapely.Polygon(rings[0], rings[1:])))
                    shapes[key] = shapely.union_all(geoms) if geoms else None
                g = shapes[key]
                if g is not None and g.distance(point) <= reach:
                    return True
        return False

    summary = {"lidar_alone": {}, "reports": {}}
    # What the raw LiDAR alone would give, on streets on the ground.
    over, alone = Counter(), []
    for k, e in edges.items():
        if e.get("bridge") or e.get("tunnel") or e.get("level") is not None or e.get("levels"):
            continue
        b = raw[k]
        if np.isfinite(b).any() and np.nanmax(np.abs(b)) > LIMIT:
            p, _ = walks[k]
            at = int(np.nanargmax(np.abs(b)))
            x, y = p[at]
            where = ("structure" if around(x, y, "structure", NEAR_STRUCTURE) else
                     "terrace" if around(x, y, "terrace", NEAR_TERRACE) else
                     "junction" if junctions.query([x, y])[0] <= NEAR_JUNCTION else "plain")
            over[where] += 1
            alone.append({"id": k, "name": e.get("name"), "hw": e.get("hw"), "at": to_wgs(x, y),
                          "lidar_bump": round(float(b[at]), 2), "where": where})
    summary["lidar_alone"] = {"streets_over_limit": sum(over.values()), "by_place": dict(over), "streets": alone}
    print("raw LiDAR alone, streets on the ground over the limit:", dict(over), flush=True)

    for report in args.reports:
        rows = json.loads(report.read_text())["rows"]
        table = Counter()
        examples = []
        for r in rows:
            if abs(r["bump"]) <= LIMIT:
                continue
            k = r["id"]
            u, v, kk = k.split(">")
            key = k if u < v else f"{v}>{u}>{kk}"
            e = edges.get(key)
            x, y = to_local(*r["bumpAt"])
            if e is None:
                table[("missing", "?")] += 1
                continue
            p, s = walks[key]
            near = np.hypot(p[:, 0] - x, p[:, 1] - y) <= 3.0
            b = raw[key][near]
            lidar_bump = float(np.nanmax(np.abs(b))) if np.isfinite(b).any() else float("nan")
            g = bumps(on_lattice(lidar_at, p[:, 0], p[:, 1], step, ox, oy), s, e.get("width"))[near]
            grid_bump = float(np.nanmax(np.abs(g))) if np.isfinite(g).any() else float("nan")
            on_level = bool(e.get("bridge") or e.get("tunnel") or e.get("level") is not None or e.get("levels"))
            where = ("on a structure" if on_level else
                     "beside a structure" if around(x, y, "structure", NEAR_STRUCTURE) else
                     "beside a terrace" if around(x, y, "terrace", NEAR_TERRACE) else
                     "at a junction" if junctions.query([x, y])[0] <= NEAR_JUNCTION else "plain ground")
            source = ("no LiDAR" if not math.isfinite(lidar_bump) else
                      "in the LiDAR" if lidar_bump >= INHERITED else
                      "made by the 4 m grid" if grid_bump >= INHERITED else
                      "added later" if max(lidar_bump, grid_bump) < CLEAN else "partly")
            table[(where, source)] += 1
            examples.append({"id": k, "name": r["name"], "hw": r["hw"], "at": r["bumpAt"], "bump": r["bump"],
                             "lidar_bump": round(lidar_bump, 2), "grid_bump": round(grid_bump, 2),
                             "where": where, "source": source,
                             "step": r["step"], "why": r["why"]})
        places = sorted({w for w, _ in table})
        sources = ["added later", "made by the 4 m grid", "partly", "in the LiDAR", "no LiDAR"]
        print(f"\n{report}: {sum(table.values())} streets with a bump over {LIMIT} m")
        print(f"  {'':22s}" + "".join(f"{s:>20s}" for s in sources) + f"{'all':>8s}")
        for w in places:
            print(f"  {w:22s}" + "".join(f"{table[(w, s)]:>20d}" for s in sources)
                  + f"{sum(table[(w, s)] for s in sources):>8d}")
        summary["reports"][str(report)] = {"table": {f"{w} | {s}": n for (w, s), n in table.items()}, "streets": examples}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
