"""Trees from IPR Praha's open data (Hosted/OPK_CUR_OPK_SMZ_VP_B, kod_vp 71): about
171,000 trees on city-managed land, surveyed as points. OSM has a tenth as many.

    uv run ipr_trees.py --refresh   # replaces the cached citywide inventory on success

build_tiles.py merges them with OSM's trees (merge below): where both have a tree
within DUPLICATE metres, IPR's stands (its position is surveyed), and OSM's is left
out. OSM's trees elsewhere (private gardens, which IPR doesn't cover) stay.

A tree is [x, y] in local metres, or [x, y, kind] when the kind is known:
1 = conifer, 2 = fruit tree. Everything else is a broadleaf tree with no third number.
"""

import argparse
from collections import Counter
import json
import time
from pathlib import Path

import numpy as np
import requests
import shapely

import build_cache
import ipr_open

URL = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/OPK_CUR_OPK_SMZ_VP_B/FeatureServer/0/query"
CACHE = Path(__file__).parent / ".cache" / "trees" / "trees.json"
DUPLICATE = 2.5
# kod_drevin → kind (1 jehličnatý = conifer, 3 ovocný = fruit; listnatý, smíšený and vřesovištní are plain).
KINDS = {1: 1, 3: 2}


def download(*, refresh=False):
    """[[lon, lat, kind]] for every tree, cached."""
    if CACHE.exists() and not refresh:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    out, offset = [], 0
    while True:
        params = {"where": "kod_vp=71", "outFields": "kod_drevin", "outSR": 4326, "f": "json", "orderByFields": "objectid",
                  "resultOffset": offset, "resultRecordCount": 2000}
        for attempt in range(5):
            try:
                r = requests.get(URL, params=params, timeout=60)
                r.raise_for_status()
                page = r.json()
                feats = ipr_open.page_features(page, URL, offset)
                break
            except (requests.RequestException, ValueError):
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
        out += [[round(x, 7), round(y, 7), KINDS.get(f["attributes"].get("kod_drevin"), 0)]
                for f in feats if f.get("geometry") for x, y in f["geometry"]["points"]]
        offset += len(feats)
        print(f"\r{offset} trees", end="", flush=True)
        if not feats or not page.get("exceededTransferLimit"):
            break
    print()
    build_cache.atomic(CACHE, json.dumps(out, separators=(",", ":")).encode())
    return out


_table = None


def _all():
    global _table
    if _table is None:
        _table = np.array(download(), dtype=float).reshape(-1, 3)
    return _table


def displaced_road_row(osm_xy, ipr_xy, ipr, road, survey, parking):
    """OSM indices duplicated by a nearby surveyed row displaced as a group."""
    if len(osm_xy) < 3 or road.is_empty or survey.is_empty:
        return set()
    osm = shapely.points(osm_xy)
    # Road edges and parking are ambiguous. Require the OSM point inside both
    # the rendered carriageway and the survey, with its replacement off the lane.
    inside = shapely.contains(road, osm) & shapely.contains(survey, osm) & ~shapely.covers(parking, osm)
    candidates = np.flatnonzero(inside)
    if len(candidates) < 3:
        return set()
    pairs, distance = ipr.query_nearest(osm, max_distance=7, return_distance=True)
    uses = Counter(pairs[1])
    options = Counter(pairs[0])
    replacements = {o: (p, d) for (o, p), d in zip(pairs.T, distance) if options[o] == 1 and uses[p] == 1}
    road_edge = road.boundary
    pairs = [(i, p) for i in candidates if i in replacements for p, d in [replacements[i]]
             if DUPLICATE < d and road_edge.distance(osm[i]) >= 0.7
             and (not road.covers(shapely.Point(ipr_xy[p])) or parking.covers(shapely.Point(ipr_xy[p])))]
    if len(pairs) < 3:
        return set()

    indices, matches = np.asarray(pairs).T
    positions = osm_xy[indices]
    shifts = ipr_xy[matches] - positions
    near = shapely.STRtree(shapely.points(positions))
    left, right = near.query(shapely.points(positions), predicate="dwithin", distance=24)
    delta = positions[right] - positions[left]
    lengths = np.linalg.norm(delta, axis=1)
    # Three distinct trunks with a similar sideways shift make a row. An
    # isolated point, or a shift along the row to the next tree, stays as mapped.
    sideways = np.abs(np.sum(delta * shifts[left], axis=1)) <= 0.65 * lengths * np.linalg.norm(shifts[left], axis=1)
    agrees = (lengths >= 3) & sideways & (np.linalg.norm(shifts[left] - shifts[right], axis=1) <= 1.25)
    support = np.bincount(left[agrees], minlength=len(indices))
    return set(indices[support >= 2].tolist())


def merge(osm, bbox, tf, *, road=None, survey=None, parking=None, stats=None):
    """OSM's trees (local metres, [x, y] or [x, y, kind]) and IPR's inside `bbox`
    (WGS84 w, s, e, n; `tf` takes lon, lat to local metres), as one list."""
    w, s, e, n = bbox
    t = _all()
    t = t[(t[:, 0] >= w) & (t[:, 0] <= e) & (t[:, 1] >= s) & (t[:, 1] <= n)]
    if not len(t):
        return osm
    xs, ys = tf.transform(t[:, 0], t[:, 1])
    xs, ys = np.asarray(xs, dtype=float).tolist(), np.asarray(ys, dtype=float).tolist()
    kinds = t[:, 2].astype(int)
    if not osm:
        return [[round(x, 1), round(y, 1), int(k)] if k else [round(x, 1), round(y, 1)] for x, y, k in zip(xs, ys, kinds)]
    ipr_xy = np.column_stack([xs, ys])
    osm_xy = np.asarray([o[:2] for o in osm])
    ipr = shapely.STRtree(shapely.points(ipr_xy))
    near_ipr, near_osm = ipr.query(shapely.points(osm_xy), predicate="dwithin", distance=DUPLICATE)[::-1]
    # (query gives pairs of (osm index, ipr index); an IPR tree of no known kind takes OSM's.)
    kinds = kinds.copy()
    for a, b in zip(near_ipr, near_osm):
        if kinds[a] == 0 and len(osm[b]) > 2:
            kinds[a] = osm[b][2]
    dropped = set(near_osm.tolist())
    if road is not None and survey is not None and parking is not None:
        rows = displaced_road_row(osm_xy, ipr_xy, ipr, road, survey, parking)
        dropped.update(rows)
        if stats is not None:
            stats["osm_trees_in_displaced_rows"] = len(rows)
    kept = [o for i, o in enumerate(osm) if i not in dropped]
    return kept + [[round(x, 1), round(y, 1), int(k)] if k else [round(x, 1), round(y, 1)] for x, y, k in zip(xs, ys, kinds)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cache the IPR tree inventory.")
    parser.add_argument("--refresh", action="store_true", help="fetch a fresh inventory even if cached")
    print(len(download(refresh=parser.parse_args().refresh)), "trees")
