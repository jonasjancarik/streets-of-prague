"""The terrain build (ipr_terrain.py's main) for a few tiles round a place only: to try a
rule or a hand-drawn wall in half a minute, not the 17–55 minutes of a `praha` build. It
never touches the map in public/data or the build's caches.

    cd pipeline
    uv run python ../.agents/skills/terrain-steps/window.py praha <lat> <lon> --npz out.npz
    uv run python ../.agents/skills/terrain-steps/window.py praha <lat> <lon> --data /tmp/try/data --set SCAN_OFF=1.0

--npz: x, y (the lattice points' local metres), h and label (rows from the south), and
bare (the terrain model before the survey). window_diff.py compares two of them.
--data: a map folder the offline checks can read (`--data` of check-road-flatness.mjs,
check-bridge-decks.mjs and check-step-edges.mjs) with `--near <lat>,<lon>,120`: no
further, or the checks walk streets across the window's edge, where this build meets the
built map's tiles in a seam that counts as a step. Compare two such folders, both built
here; not one with the built map.
--set NAME=value: a constant of dtm_heights.py or structures.py for this run.
--walls: another terrain_walls.json.

The tiles at the window's rim lack what reaches in from outside (walls, feathering, a
bridge's far end), so only the middle counts: with --tiles 2, the three by three tiles
round the place's own. Against the built map the middle differs by 0.2–0.6 m at a
handful of points a tile (9 November 2026, Pankrác).
"""
import argparse
import gzip
import json
import math
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Polygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
import dtm_heights  # noqa: E402
import ipr_lidar  # noqa: E402
import ipr_terrain  # noqa: E402
import layers  # noqa: E402
import step_lines  # noqa: E402
import structures  # noqa: E402
from ipr_buildings import krovak_to_local, sheet, sheet_name  # noqa: E402
from osm_area import AREAS, OUT  # noqa: E402

KEPT = ROOT / "pipeline" / ".cache" / "window"


def survey_piece(area, key, to_krovak, x0, y0, x1, y1):
    """The survey within 200 m of a box, as dtm_heights.survey gives it for the area.
    Read straight from the area's cache as the last build left it: survey()'s cache key
    takes in the function of that name, so calling it with another in its place would
    miss the cache, read every package again and write the cache under a key no build has."""
    kept = KEPT / f"survey-{area}-{key}.pkl"
    whole = dtm_heights.CACHE / "heights" / f"{area}.pkl"
    if kept.exists() and kept.stat().st_mtime > whole.stat().st_mtime:
        return pickle.loads(kept.read_bytes())
    got = pickle.loads(whole.read_bytes())
    kx, ky = to_krovak.transform([x0 - 200, x0 - 200, x1 + 200, x1 + 200], [y0 - 200, y1 + 200, y0 - 200, y1 + 200])
    k = box(min(kx), min(ky), max(kx), max(ky))
    a0, b0, a1, b1 = k.bounds
    near = lambda c: c[:, 0].max() >= a0 and c[:, 0].min() <= a1 and c[:, 1].max() >= b0 and c[:, 1].min() <= b1  # noqa: E731
    piece = ([p for p in got["polys"] if p.intersects(k)], [c for c in got["lines"] if near(c)], [c for c in got["walls"] if near(c)])
    KEPT.mkdir(parents=True, exist_ok=True)
    kept.write_bytes(pickle.dumps(piece, protocol=5))
    return piece


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("area")
    ap.add_argument("lat", type=float)
    ap.add_argument("lon", type=float)
    ap.add_argument("--npz", type=Path)
    ap.add_argument("--data", type=Path, help="a map folder for the offline checks (see above)")
    ap.add_argument("--tiles", type=int, default=2, help="tiles either side of the place's own")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=value")
    ap.add_argument("--walls", type=Path, help="another terrain_walls.json to try")
    for name in ("cuttings", "level", "feather", "sunk-kerbs", "scan-levels", "scan-streets", "bridges"):
        ap.add_argument(f"--no-{name}", action="store_true")
    args = ap.parse_args()
    if args.data and args.data.resolve() == OUT.resolve():
        ap.error("--data is the built map's own folder")
    for pair in args.set:
        name, value = pair.split("=")
        module = next((m for m in (dtm_heights, structures, ipr_terrain) if hasattr(m, name)), None)
        if module is None:
            ap.error(f"no constant {name}")
        setattr(module, name, type(getattr(module, name))(float(value)))
    started = time.perf_counter()
    area = args.area
    meta = layers.read_meta(area)
    w, s, e, n = AREAS[area]
    T = meta["tile"]
    ox, oy = meta["origin"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    N, step = ipr_terrain.grid_step(T)
    gx0, gy0 = -ox, -oy
    px, py = Transformer.from_crs("EPSG:4326", local, always_xy=True).transform(args.lon, args.lat)
    ti, tj = int((px + ox) // T), int((py + oy) // T)
    wanted = {(i, j) for i in range(ti - args.tiles, ti + args.tiles + 1) for j in range(tj - args.tiles, tj + args.tiles + 1)}
    C = meta["chunk_tiles"]
    chunks = sorted({(i // C, j // C) for i, j in wanted})

    # As ipr_terrain.main from here on, for the window's tiles.
    tiles, boxes, outlines, roads, ways, water, by_water, driven = {}, {}, [], [], [], [], [], []
    weirs, streets, street_edges, tile_water, kerbs = [], {}, {}, {}, {}
    for ci, cj in chunks:
        parts = {layer: layers.read_chunk(area, layer, ci, cj)["tiles"] for layer in layers.CHUNKED}
        for i, j in layers.chunk_tiles(meta, ci, cj):
            if (i, j) not in wanted:
                continue
            t = {}
            for layer in layers.CHUNKED:
                t.update(parts[layer].get(f"{i}_{j}") or layers.EMPTY[layer])
            if not (t["buildings"] or t["areas"] or t["roads"] or t["walk"]):
                continue
            tiles[(i, j)] = np.full((N + 1, N + 1), np.nan, dtype=np.float32)
            boxes[(i, j)] = box(*layers.tile_box(meta, i, j))
            tile_water[(i, j)] = t["areas"].get("water", [])
            water += [Polygon(r[0], r[1:]).buffer(0) for r in t["areas"].get("water", [])]
            weirs += t.get("weirs") or []
            for ed in t.get("drive") or []:
                if not ed.get("bridge") and len(ed["pts"]) > 1 and ed["id"] not in streets:
                    half = min(ed["width"] / 2, *(ed.get("kerb") or [ed["width"] / 2]))
                    streets[ed["id"]] = (LineString(ed["pts"]), half)
                    kerbs[ed["id"]] = tuple(ed.get("kerb") or (ed["width"] / 2, ed["width"] / 2))
                    street_edges[ed["id"]] = ed
            if t["areas"].get("water"):
                for kind in ("road", "sett", "path", "dirt"):
                    here = [Polygon(r[0], r[1:]).buffer(0) for r in t["roads"].get(kind, [])]
                    by_water += here
                    if kind in ("road", "sett"):
                        driven += here
            here = t["areas"].get("bridge", [])
            outlines += [Polygon(r[0], r[1:]).buffer(0.05) for r in here]
            if here or t["roads"].get("bridge"):
                for kind in ("road", "sett", "path", "dirt"):
                    roads += [Polygon(r[0], r[1:]) for r in t["roads"].get(kind, [])]
    x0, y0 = min(i for i, _ in tiles) * T - ox, min(j for _, j in tiles) * T - oy
    x1, y1 = (max(i for i, _ in tiles) + 1) * T - ox, (max(j for _, j in tiles) + 1) * T - oy
    window = box(x0 - 100, y0 - 100, x1 + 100, y1 + 100)
    seen = set()
    for ci, cj in sorted({(a + da, b + db) for a, b in chunks for da in (-1, 0, 1) for db in (-1, 0, 1)}):
        if not layers.chunk_path(area, "streets", ci, cj).exists():
            continue
        for way in layers.read_chunk(area, "streets", ci, cj).get("structures", []):
            key = json.dumps(way, sort_keys=True)
            if key not in seen and len(way["pts"]) > 1 and LineString(way["pts"]).intersects(window):
                seen.add(key)
                ways.append(way)

    # The terrain model's sheets over the window.
    to_krovak = Transformer.from_crs(local, "EPSG:5514", always_xy=True)
    corners = [sheet(*to_krovak.transform(x, y)) for x in (x0, x1) for y in (y0, y1)]
    names = [name for X in range(min(c[0] for c in corners), max(c[0] for c in corners) + 1)
             for Y in range(min(c[1] for c in corners), max(c[1] for c in corners) + 1) if (name := sheet_name(X, Y))]
    items = ipr_terrain.catalogue()
    for suffix in names:
        name = f"TER_{suffix}"
        path = ipr_terrain.download(name, items)
        if not path:  # (past the edge of IPR's model)
            continue
        _, (gi0, gj0, sub, _, _, _) = ipr_terrain.read_sheet((name, str(path), local, gx0, gy0, step))
        gi1, gj1 = gi0 + sub.shape[1] - 1, gj0 + sub.shape[0] - 1
        for (i, j), arr in tiles.items():
            ci, cj = i * N, j * N
            a0, a1 = max(ci, gi0), min(ci + N, gi1)
            b0, b1 = max(cj, gj0), min(cj + N, gj1)
            if a0 > a1 or b0 > b1:
                continue
            part = sub[b0 - gj0:b1 - gj0 + 1, a0 - gi0:a1 - gi0 + 1]
            view = arr[b0 - cj:b1 - cj + 1, a0 - ci:a1 - ci + 1]
            ok = ~np.isnan(part)
            view[ok] = part[ok]
    unknown = {k: np.isnan(arr) for k, arr in tiles.items() if np.isnan(arr).any()}
    ipr_terrain.fill_gaps(tiles, N, T, step)
    bare = {k: arr.copy() for k, arr in tiles.items()}
    dropped, cut_bridges = structures.cuttings(ways, street_edges, ipr_terrain.sampler(tiles, N, T, step, gx0, gy0), None)
    if dropped:
        ways = [way for way in ways if way["id"] not in dropped] + cut_bridges

    piece = survey_piece(area, f"{ti}_{tj}-{args.tiles}", to_krovak, x0, y0, x1, y1)
    dtm_heights.survey = lambda area_, bbox: piece
    drawn = ipr_terrain.drawn_walls(local)
    if args.walls:
        to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
        drawn = [LineString(zip(*to_local.transform(*zip(*wall["line"])))) for wall in json.loads(args.walls.read_text())]
    bridge_lines = [(LineString(way["pts"]), way["w"]) for way in ways if way["kind"] == "bridge" and len(way["pts"]) > 1]
    surveyed = dtm_heights.apply(
        area, AREAS[area], krovak_to_local(local), tiles, N, step, gx0, gy0, unary_union(water) if water else None, boxes, by_water,
        [(LineString(way["pts"]), way["w"]) for way in ways if way["kind"] == "tunnel" and len(way["pts"]) > 1], ipr_terrain.kept_places(local), driven,
        list(streets.values()), args.no_feather, True, False, weirs=weirs, unknown=unknown, valley_smooth=True,
        bridges=[line.buffer(width / 2) for line, width in bridge_lines] + list(outlines),
        bridge_ends=dtm_heights.bridge_ends([line for line, _ in bridge_lines]),
        bridge_ways=[] if args.no_cuttings else bridge_lines,
        drawn=drawn, level_across=not args.no_level,
        cuts=[LineString(way["pts"]).buffer(way["w"] / 2) for way in ways if way.get("cut")], sharp=False,
        scan=ipr_lidar.range_sampler(ipr_lidar.CACHE)[0] if all(p.exists() for p in ipr_lidar.source_paths(ipr_lidar.CACHE)) else None, sunk_kerbs=not args.no_sunk_kerbs, scan_levels=not args.no_scan_levels,
        street_sides=list(kerbs.values()), scan_streets=not args.no_scan_streets)
    labels, terraces = surveyed.pop("labels"), surveyed.pop("terraces")
    print(f"  survey: {surveyed}")
    found, steep = {}, {}
    if not args.no_bridges:
        merged = unary_union(outlines) if outlines else None
        found = structures.build(ways, list(getattr(merged, "geoms", [merged])) if merged else [], roads,
                                 ipr_terrain.sampler(tiles, N, T, step, gx0, gy0, labels), local, tiles, N, T, step, gx0, gy0, boxes,
                                 way_levels=[], ramps_out=steep, streets=[line for line, _ in streets.values()])
        ring = lambda r: np.round(shapely.get_coordinates(r)[:-1], 2).tolist()  # noqa: E731
        for pad, height in structures.pads(ways, list(streets.values())):
            bx0, by0, bx1, by1 = pad.bounds
            for i in range(math.floor((bx0 - gx0) / T), math.floor((bx1 - gx0) / T) + 1):
                for j in range(math.floor((by0 - gy0) / T), math.floor((by1 - gy0) / T) + 1):
                    arr = tiles.get((i, j))
                    if arr is None:
                        continue
                    here = [q for q in shapely.get_parts(pad.intersection(boxes[(i, j)])) if q.geom_type == "Polygon" and q.area > 0.5]
                    listed = terraces.setdefault((i, j), [])
                    label = max([t["label"] for t in listed] + [1]) + 1
                    if not here or label > 255:
                        continue
                    listed.append({"label": label, "h": round(height, 2), "polys": [[ring(q.exterior), *(ring(r) for r in q.interiors)] for q in here]})
                    xs, ys = np.meshgrid(gx0 + i * T + np.arange(N + 1) * step, gy0 + j * T + np.arange(N + 1) * step)
                    on = shapely.contains_xy(pad, xs, ys)
                    arr[on] = height
                    labels.setdefault((i, j), np.zeros((N + 1, N + 1), dtype=np.uint8))[on] = label
        ipr_terrain.pull_to_bridges(tiles, labels, found, N)

    if args.npz:
        i0, j0 = min(i for i, _ in tiles), min(j for _, j in tiles)
        ni, nj = max(i for i, _ in tiles) - i0 + 1, max(j for _, j in tiles) - j0 + 1
        h = np.full((nj * N + 1, ni * N + 1), np.nan, dtype=np.float32)
        lab = np.zeros(h.shape, dtype=np.uint8)
        raw = h.copy()
        for (i, j), arr in tiles.items():
            a, b = (i - i0) * N, (j - j0) * N
            h[b:b + N + 1, a:a + N + 1] = arr
            raw[b:b + N + 1, a:a + N + 1] = bare[(i, j)]
            if (i, j) in labels:
                lab[b:b + N + 1, a:a + N + 1] = labels[(i, j)]
        np.savez(args.npz, x=gx0 + (i0 * N + np.arange(h.shape[1])) * step, y=gy0 + (j0 * N + np.arange(h.shape[0])) * step, h=h, label=lab, bare=raw)
    if args.data:
        write_map(args.data / f"{area}_now", OUT / f"{area}_now", tiles, labels, terraces, found, steep, tile_water, boxes, streets,
                  N, T, step, gx0, gy0, ti, tj, args.tiles,
                  [LineString(way["pts"]).buffer(way["w"] / 2) for way in ways if way["kind"] == "bridge" and len(way["pts"]) > 1])
    print(f"{len(tiles)} tiles round {ti}_{tj} in {time.perf_counter() - started:.0f} s")


def write_map(out, built, tiles, labels, terraces, found, steep, tile_water, boxes, streets, N, T, step, gx0, gy0, ti, tj, reach, decks=()):
    """A map folder for the offline checks: the window's tiles as built here (their
    heights and labels, bridge and tunnel levels, terraces and step lines, as
    ipr_terrain.main and layers.assemble write them), and a ring of tiles round them and
    the index linked from the built map."""
    (out / "tiles").mkdir(parents=True, exist_ok=True)
    for old in (out / "tiles").iterdir():
        old.unlink()
    inner = set(tiles)
    plain = np.zeros((N + 1, N + 1), dtype=np.uint8)
    own = step_lines.lattice_reader(tiles, labels, N, T, step, gx0, gy0)
    driven = step_lines.crossing(list(streets.values()), decks)
    for i in range(ti - reach - 1, ti + reach + 2):
        for j in range(tj - reach - 1, tj + reach + 2):
            k = f"{i}_{j}"
            if (i, j) not in inner:
                for p in (built / "tiles").glob(f"{k}.*"):
                    if not p.name.startswith(f"{k}.ipr"):
                        (out / "tiles" / p.name).symlink_to(p)
                continue
            arr = tiles[(i, j)]
            raw = np.clip(np.round((arr - 100) / 0.1), 0, 65535).astype("<u2").tobytes() + labels.get((i, j), plain).astype(np.uint8).tobytes()
            (out / "tiles" / f"{k}.height.bin.gz").write_bytes(gzip.compress(raw, 1))
            t = json.loads((built / "tiles" / f"{k}.json").read_text())
            was = [(lv["level"], lv["kind"]) for lv in t.get("structures", [])]
            for key in ("structures", "terraces", "stepLines"):
                t.pop(key, None)
            if (i, j) in found:
                fine = lambda a: np.clip(np.round((np.nan_to_num(a, nan=100.0) - 100) * 100), 0, 65535).astype("<u2").tobytes()  # noqa: E731
                (out / "tiles" / f"{k}.levels.bin.gz").write_bytes(gzip.compress(b"".join(fine(h) for _, _, h, _ in found[(i, j)]), 1))
                t["structures"] = [{"level": lv, "kind": kind, "polys": polys, **({"ramps": steep[(i, j)][lv]} if steep.get((i, j), {}).get(lv) else {})}
                                   for lv, kind, _, polys in found[(i, j)]]
            if [(lv["level"], lv["kind"]) for lv in t.get("structures", [])] != was:
                print(f"  note: tile {k} has other bridge and tunnel levels here than in the built map ({was}); its streets' levels are the built map's")
            if terraces.get((i, j)):
                t["terraces"] = terraces[(i, j)]
                lines = step_lines.for_tile(boxes[(i, j)].bounds, tile_water.get((i, j), []), terraces[(i, j)], own, driven)
                if lines:
                    t["stepLines"] = lines
            (out / "tiles" / f"{k}.json").write_text(layers.dumps(t))
    for name in ("index.json", "road-profile.json"):
        if (built / name).exists() and not (out / name).exists():
            (out / name).symlink_to(built / name)


if __name__ == "__main__":
    sys.exit(main())
