"""Compare check-road-flatness reports inside a road-fit area.

    uv run --project pipeline python pipeline/road_fit_compare.py --area nusle \\
      plain=plain-roads.json preview=preview-roads.json fit=fit-roads.json
"""

import argparse
import json
import math
from pathlib import Path

from road_fit import AREAS

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "public" / "data" / "praha_now"
LIMITS = {"step": (0.25, 1), "bump": (0.15, 0.5), "lean": (8, 15), "crown": (0.3, 1), "twist": (5, 12), "off": (4, 10)}
NAMES = {"step": "Steps along the street", "bump": "Bumps", "lean": "Leaning across", "crown": "Ridge or trough",
         "twist": "Twisting", "off": "Off the road"}


def inside_ids(area):
    """Car streets whose whole axis lies inside the area (the checker's approximate degrees)."""
    index = json.loads((DATA / "index.json").read_text())
    w, s, e, n = index["bbox_wgs84"]
    lat0, lon0, rad = (s + n) / 2, (w + e) / 2, math.pi / 180
    m_lat = 111132.92 - 559.82 * math.cos(2 * lat0 * rad)
    aw, as_, ae, an = area
    ids, out = set(), set()
    for i, j, *_ in index["tiles"]:
        p = DATA / "tiles" / f"{i}_{j}.json"
        t = json.loads(p.read_text())
        for edge in t["drive"]:
            for x, y in edge["pts"]:
                lat = lat0 + y / m_lat
                m_lon = 111412.84 * math.cos(lat * rad) - 93.5 * math.cos(3 * lat * rad)
                lon = lon0 + x / m_lon
                (ids if aw <= lon <= ae and as_ <= lat <= an else out).add(edge["id"])
    return ids - out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--area", default="nusle", choices=AREAS)
    ap.add_argument("--worst", type=int, default=12)
    ap.add_argument("reports", nargs="+", help="label=report.json")
    args = ap.parse_args()
    ids = inside_ids(AREAS[args.area])
    runs = {}
    for item in args.reports:
        label, path = item.split("=", 1)
        rows = json.loads(Path(path).read_text())["rows"]
        runs[label] = {r["id"]: r for r in rows if r["id"] in ids}
    labels = list(runs)
    common = set.intersection(*(set(r) for r in runs.values()))
    print(f"{len(common)} car streets inside the area")
    print(f"{'':34s}" + "".join(f"{l:>18s}" for l in labels))
    for k, (flag, hard) in LIMITS.items():
        cells = []
        for l in labels:
            v = [abs(runs[l][i][k]) for i in common]
            cells.append(f"{sum(x > flag for x in v):7d} / {sum(x > hard for x in v):4d}  ")
        print(f"{NAMES[k] + f' (> {flag} / {hard})':34s}" + "".join(f"{c:>18s}" for c in cells))
    ground = [i for i in common if runs[labels[0]][i]["why"] == "ground"]
    print(f"\n{len(ground)} of them on the ground")
    a, b = labels[0], labels[-1]
    for k in ("bump", "step", "twist", "lean"):
        flag, hard = LIMITS[k]
        worse = sorted(common, key=lambda i: abs(runs[b][i][k]) - abs(runs[a][i][k]), reverse=True)
        print(f"\nMost worse {k}, {a} → {b}:")
        for i in worse[:args.worst]:
            ra, rb = runs[a][i], runs[b][i]
            if abs(rb[k]) - abs(ra[k]) <= 0.01:
                break
            print(f"  {ra[k]:6.2f} → {rb[k]:6.2f}  {rb[k + 'At'][0]}, {rb[k + 'At'][1]}  {rb['why']:7s} {rb['hw']:12s} {rb['name']}")


if __name__ == "__main__":
    main()
