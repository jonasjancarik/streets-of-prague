"""The Vltava for the boats: public/data/<area>_now/river.json.

    uv run build_river.py centrum      # after build_tiles.py: it reads the tiles' water

Two things the game can't work out from the water polygons alone:

`fairway`: the way a cruise boat sails through the area, as stretches of the river
between the places it can't pass. Each is a line down the middle of the navigable
water (`pts`: x, y in the area's local metres and the distance to the nearest bank),
found as the cheapest way through the tiles' water from where OSM's line of the Vltava
enters the area to where it leaves, keeping clear of the banks and never crossing a
weir. So it goes round an island on the side with room for a boat, and past a weir
through the lock beside it, where the map's water has one wide enough; where it
hasn't, the fairway ends there and the next stretch begins on the far side.

`ferries`: PID's ferries (P1, P2, …) from the timetables pid_timetable.py downloads:
each line's landings in order (`stops`: the name, where the boat lies (`berth`) and
the nearest spot on the bank (`gate`)), the way across between them (`legs`), the
minutes each leg takes, how often it sails and between which hours on a weekday.
Only two of them sail all year (`allYear`); the others from April to October.
"""

import json
import statistics
import subprocess
import sys
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import unquote

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from shapely.geometry import LineString, Point, box
from shapely.ops import linemerge, unary_union

from osm_area import AREAS, OUT
from pid_timetable import feed, rows, seconds, services_on, typical_dates

PBF_DIR = Path(__file__).parent / ".cache" / "osm"
RES = 2.0  # metres per cell of the water raster
CORRIDOR = 500  # tiles this near OSM's line of the river are read (m)
CLEAR = 5.0  # a cruise boat keeps this far from the bank (its half beam and a margin)
FERRY_CLEAR = 2.5  # and a ferry this far, between its landings
BERTH = 8.0  # where it lies at a landing: room for its length, bow or stern to the bank
WEIR = 5.0  # no boat within this of a weir's line (as waterAt in src/tiles.ts)
SLUICE = 40  # a gap this narrow between two weirs is a sluice, not a way through (m)
MIN_REACH = 400  # a stretch of fairway shorter than this isn't worth sailing (m)
ALL_YEAR = {"P1", "P2"}  # the others are seasonal (PID: from late March to the end of October)
VERSION = 1


def osm(pbf: Path, tf):
    """Nodes (local metres), ways (tags, node ids) of the waterways, weirs and locks."""
    out = subprocess.run(["osmium", "tags-filter", str(pbf), "w/waterway=river,canal,weir,dam", "w/lock=yes",
                          "-f", "opl,add_metadata=false", "-o", "-"], check=True, capture_output=True, text=True).stdout
    nodes, ways = {}, []
    for line in out.splitlines():
        kind, *rest = line.split(" ")
        f = {p[0]: p[1:] for p in rest if p}
        if kind[0] == "n":
            nodes[int(kind[1:])] = tf.transform(float(f["x"]), float(f["y"]))
        elif kind[0] == "w":
            tags = dict((unquote(k), unquote(v)) for k, v in (kv.split("=", 1) for kv in f.get("T", "").split(",") if "=" in kv))
            ways.append((tags, [int(n[1:]) for n in f.get("N", "").split(",") if n]))
    return nodes, ways


class Water:
    """The tiles' water near the river as a raster: where a boat can be, and how far
    from the bank (or a weir) each cell is."""

    def __init__(self, area: str, near):
        tiles = OUT / f"{area}_now" / "tiles"
        index = json.loads((OUT / f"{area}_now" / "index.json").read_text())
        ox, oy = index["origin"]
        size = index["tile"]
        zone = near.buffer(CORRIDOR)
        picked = [(i, j) for i, j, *_ in index["tiles"]
                  if zone.intersects(box(i * size - ox, j * size - oy, (i + 1) * size - ox, (j + 1) * size - oy))]
        # The raster's cells line up with the tiles. Each tile's water is drawn four times
        # finer and a cell counts as water only if all of it is: a lock's wall or a mole a
        # metre thick still parts the water either side of it.
        i0, i1 = min(i for i, _ in picked), max(i for i, _ in picked) + 1
        j0, j1 = min(j for _, j in picked), max(j for _, j in picked) + 1
        x0, y1 = i0 * size - ox, j1 * size - oy
        self.x0, self.y1 = x0, y1
        per, fine = round(size / RES), 4
        wet = np.zeros(((j1 - j0) * per, (i1 - i0) * per), dtype=bool)
        weirs = []
        for i, j in picked:
            path = tiles / f"{i}_{j}.json"
            if not path.exists():
                continue
            t = json.loads(path.read_text())
            weirs += [w for w in t.get("weirs", []) if len(w) > 1]
            polys = t["areas"].get("water", [])
            if not polys:
                continue
            tx, ty = i * size - ox, (j + 1) * size - oy
            img = Image.new("L", (per * fine, per * fine), 0)
            draw = ImageDraw.Draw(img)
            sub = lambda ring: [((x - tx) / RES * fine, (ty - y) / RES * fine) for x, y in ring]  # noqa: E731
            for rings in polys:
                # (Each polygon on its own sheet: a hole mustn't rub out a neighbour.)
                one = Image.new("L", img.size, 0)
                d1 = ImageDraw.Draw(one)
                d1.polygon(sub(rings[0]), fill=1)
                for hole in rings[1:]:
                    d1.polygon(sub(hole), fill=0)
                img.paste(1, mask=one.point(lambda v: 255 * v))
            # The banks themselves are dry, however thin what they outline (not the
            # tile's own edge, where the water carries on in the next tile).
            edge = lambda a, b: any(abs(a[k] - v) < 0.05 and abs(b[k] - v) < 0.05  # noqa: E731
                                    for k, v in ((0, tx), (0, tx + size), (1, ty - size), (1, ty)))
            for rings in polys:
                for ring in rings:
                    for a, b in zip(ring, ring[1:] + ring[:1]):
                        if not edge(a, b):
                            draw.line(sub([a, b]), fill=0, width=1)
            cells = np.array(img, dtype=bool).reshape(per, fine, per, fine).all(axis=(1, 3))
            r, c = (j1 - 1 - j) * per, (i - i0) * per
            wet[r:r + per, c:c + per] = cells
        img = Image.fromarray(wet.astype(np.uint8))
        draw = ImageDraw.Draw(img)
        px = lambda ring: [((x - x0) / RES, (y1 - y) / RES) for x, y in ring]  # noqa: E731
        # A weir's line in OSM often stops either side of a sluice for rafts and canoes:
        # no way through for a boat, so the loose ends of two weirs near each other are joined.
        ends = [(w[k], n) for n, w in enumerate(weirs) for k in (0, -1)]
        loose = [(p, n) for p, n in ends if not any(m != n and abs(q[0] - p[0]) + abs(q[1] - p[1]) < 1 for q, m in ends)]
        for p, n in loose:
            others = [(np.hypot(q[0] - p[0], q[1] - p[1]), q) for q, m in loose if m != n]
            if others and min(others)[0] < SLUICE:
                weirs.append([p, min(others)[1]])
        for wr in weirs:
            draw.line(px(wr), fill=0, width=int(2 * WEIR / RES) + 1)
        self.wet = np.array(img, dtype=bool)
        self.dist = ndimage.distance_transform_edt(self.wet) * RES
        self.weirs = [LineString(w) for w in weirs]
        self.tiles = len(picked)

    def cell(self, x, y):
        return int((self.y1 - y) / RES), int((x - self.x0) / RES)

    def point(self, r, c):
        return self.x0 + (c + 0.5) * RES, self.y1 - (r + 0.5) * RES

    def nearest(self, x, y, clear, reach=150):
        """The cell nearest (x, y) that's at least `clear` from the bank, or None."""
        r, c = self.cell(x, y)
        k = int(reach / RES)
        r0, c0 = max(0, r - k), max(0, c - k)
        win = self.dist[r0:r + k + 1, c0:c + k + 1] >= clear
        if not win.any():
            return None
        rr, cc = np.nonzero(win)
        best = np.argmin((rr + r0 - r) ** 2 + (cc + c0 - c) ** 2)
        return int(rr[best] + r0), int(cc[best] + c0)

    def dry(self, x, y, reach=60):
        """The spot on the bank nearest (x, y): the middle of the nearest dry cell."""
        r, c = self.cell(x, y)
        k = int(reach / RES)
        r0, c0 = max(0, r - k), max(0, c - k)
        rr, cc = np.nonzero(~self.wet[r0:r + k + 1, c0:c + k + 1])
        if not len(rr):
            return None
        best = np.argmin((rr + r0 - r) ** 2 + (cc + c0 - c) ** 2)
        return self.point(int(rr[best] + r0), int(cc[best] + c0))

    def graph(self, clear, window=None):
        """The cells at least `clear` from the bank as a graph (8 neighbours), dearer
        near the bank so a way through it keeps to the middle. `window`: (r0, r1, c0, c1)."""
        r0, r1, c0, c1 = window or (0, self.dist.shape[0], 0, self.dist.shape[1])
        d = self.dist[r0:r1, c0:c1]
        ok = d >= clear
        ids = np.full(d.shape, -1, dtype=np.int64)
        ids[ok] = np.arange(ok.sum())
        cost = 1 + 40 / np.minimum(np.maximum(d, 1), 80)
        ii, jj, ww = [], [], []
        for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
            a = ids[max(0, -dr):d.shape[0] - max(0, dr), max(0, -dc):d.shape[1] - max(0, dc)]
            b = ids[max(0, dr):, max(0, dc):d.shape[1] + min(0, dc)] if dc >= 0 else ids[dr:, :d.shape[1] + dc]
            ca = cost[max(0, -dr):d.shape[0] - max(0, dr), max(0, -dc):d.shape[1] - max(0, dc)]
            cb = cost[max(0, dr):, max(0, dc):d.shape[1] + min(0, dc)] if dc >= 0 else cost[dr:, :d.shape[1] + dc]
            both = (a >= 0) & (b >= 0)
            ii.append(a[both])
            jj.append(b[both])
            ww.append((ca[both] + cb[both]) / 2 * RES * (2 ** 0.5 if dr and dc else 1))
        n = int(ok.sum())
        g = coo_matrix((np.concatenate(ww), (np.concatenate(ii), np.concatenate(jj))), shape=(n, n)).tocsr()
        return g, ids, (r0, c0)

    def route(self, a, b, clear, graph=None):
        """The way from cell a to cell b through water, as local points, or None."""
        if graph is None:
            m = int(120 / RES)
            graph = self.graph(clear, (max(0, min(a[0], b[0]) - m), max(a[0], b[0]) + m, max(0, min(a[1], b[1]) - m), max(a[1], b[1]) + m))
        g, ids, (r0, c0) = graph
        ia, ib = ids[a[0] - r0, a[1] - c0], ids[b[0] - r0, b[1] - c0]
        if ia < 0 or ib < 0:
            return None
        _, before = dijkstra(g, directed=False, indices=ia, return_predecessors=True)
        if before[ib] < 0:
            return None
        cells = np.argwhere(ids >= 0)
        path = [ib]
        while path[-1] != ia:
            path.append(before[path[-1]])
        return [self.point(int(cells[k][0]) + r0, int(cells[k][1]) + c0) for k in reversed(path)]

    def clearance(self, x, y):
        r, c = self.cell(x, y)
        return float(self.dist[r, c]) if 0 <= r < self.dist.shape[0] and 0 <= c < self.dist.shape[1] else 0.0


def smooth(pts, water: Water, clear, every=12.0):
    """A path of raster cells as a line a boat can follow: straightened, its corners
    rounded, a point every `every` metres, none of them nearer the bank than `clear`."""
    line = LineString(pts).simplify(RES * 1.5)
    for _ in range(3):  # Chaikin's corner cutting
        c = list(line.coords)
        out = [c[0]]
        for (ax, ay), (bx, by) in zip(c, c[1:]):
            out += [(ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25), (ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75)]
        line = LineString(out + [c[-1]])
    n = max(1, round(line.length / every))
    out = [line.interpolate(k / n, normalized=True).coords[0] for k in range(n + 1)]
    if any(water.clearance(x, y) < clear - RES * 1.5 for x, y in out):
        out = [LineString(pts).interpolate(k / n, normalized=True).coords[0] for k in range(n + 1)]  # the raster's own path
    return out


def fairway(water: Water, river: LineString):
    """The stretches a cruise boat can sail: in each connected piece of navigable water
    OSM's line of the river runs through, from where the line comes into it to where
    it goes out."""
    ok = water.dist >= CLEAR
    labels, _ = ndimage.label(ok, structure=np.ones((3, 3)))
    # Which piece the river's line is in, every few metres along it.
    spans = {}
    for s in np.arange(0, river.length, RES):
        x, y = river.interpolate(s).coords[0]
        r, c = water.cell(x, y)
        if not (0 <= r < labels.shape[0] and 0 <= c < labels.shape[1]):
            continue
        k = labels[r, c]
        if not k:  # the line's on a weir or by the bank here: the navigable water beside it
            near = water.nearest(x, y, CLEAR, 40)
            k = labels[near] if near else 0
            r, c = near if near else (r, c)
        if k:
            first = spans.setdefault(int(k), [s, (r, c), s, (r, c)])
            first[2:] = [s, (r, c)]
    graph = water.graph(CLEAR)
    out = []
    for k, (s0, a, s1, b) in sorted(spans.items(), key=lambda kv: kv[1][0]):
        if s1 - s0 < MIN_REACH:
            continue
        pts = water.route(a, b, CLEAR, graph)
        if not pts:
            continue
        line = smooth(pts, water, CLEAR)
        out.append({"pts": [[round(x, 1), round(y, 1), round(min(water.clearance(x, y), 99), 1)] for x, y in line]})
        print(f"  fairway: {LineString(line).length:.0f} m, from {s0:.0f} to {s1:.0f} m along the river")
    return out


def ferries(water: Water, tf, inside):
    z = zipfile.ZipFile(feed())
    routes = {r["route_id"]: r for r in rows(z, "routes.txt") if r["route_type"] == "4"}
    weekday = {"weekday": typical_dates(z)["weekday"]}
    on = services_on(z, weekday)
    trips = {t["trip_id"]: t for t in rows(z, "trips.txt") if t["route_id"] in routes and on.get(t["service_id"])}
    calls = defaultdict(list)
    for r in rows(z, "stop_times.txt"):
        if r["trip_id"] in trips:
            calls[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], seconds(r["arrival_time"]), seconds(r["departure_time"])))
    stops = {r["stop_id"]: r for r in rows(z, "stops.txt")}
    out = []
    for rid, route in sorted(routes.items(), key=lambda kv: kv[1]["route_short_name"]):
        ref = route["route_short_name"]
        mine = [sorted(calls[k]) for k, t in trips.items() if t["route_id"] == rid and t["direction_id"] == "0" and len(calls[k]) > 1]
        if not mine:
            print(f"  {ref}: no trips on a weekday")
            continue
        # The usual run: its landings in order, and how long between them.
        usual = Counter(tuple(c[1] for c in t) for t in mine).most_common(1)[0][0]
        runs = [t for t in mine if tuple(c[1] for c in t) == usual]
        deps = sorted(t[0][3] for t in runs)
        gaps = [b - a for a, b in zip(deps, deps[1:]) if b > a]
        mins = [max(1, round(statistics.median(t[k + 1][2] - t[k][3] for t in runs) / 60)) for k in range(len(usual) - 1)]
        landings = []
        for sid in usual:
            s = stops[sid]
            x, y = tf.transform(float(s["stop_lon"]), float(s["stop_lat"]))
            cell = water.nearest(x, y, BERTH) if inside(x, y) else None
            if not cell:
                break
            bx, by = water.point(*cell)
            gate = water.dry(bx, by)
            if not gate:
                break
            landings.append({"name": s["stop_name"], "berth": [round(bx, 1), round(by, 1)], "gate": [round(gate[0], 1), round(gate[1], 1)], "cell": cell})
        if len(landings) < len(usual):
            print(f"  {ref}: a landing is outside the area or has no water by it")
            continue
        legs = []
        for a, b in zip(landings, landings[1:]):
            pts = water.route(a["cell"], b["cell"], FERRY_CLEAR)
            if not pts:
                break
            legs.append([[round(x, 1), round(y, 1)] for x, y in smooth(pts, water, FERRY_CLEAR, 8.0)])
        if len(legs) < len(landings) - 1:
            print(f"  {ref}: no way across on the map's water")
            continue
        for s in landings:
            del s["cell"]
        out.append({"ref": ref, "name": route["route_long_name"], "colour": "#" + route["route_color"], "stops": landings, "legs": legs, "mins": mins,
                    "every": round(statistics.median(gaps) / 60) if gaps else 30, "hours": [round(deps[0] / 3600, 2), round((deps[-1] + 60 * sum(mins)) / 3600, 2)],
                    "allYear": ref in ALL_YEAR})
        print(f"  {ref} {route['route_long_name']}: {len(landings)} landings, {sum(LineString(leg).length for leg in legs):.0f} m, every {out[-1]['every']} min, {out[-1]['hours']}")
    return out


def main(area: str = "centrum") -> None:
    w, s, e, n = AREAS[area]
    centre = ((w + e) / 2, (s + n) / 2)
    tf = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=tmerc +lat_0={centre[1]} +lon_0={centre[0]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
        always_xy=True,
    )
    x0, y0 = tf.transform(w, s)
    x1, y1 = tf.transform(e, n)
    clip = box(x0, y0, x1, y1)
    nodes, ways = osm(PBF_DIR / f"{area}.osm.pbf", tf)
    line = lambda nds: LineString([nodes[k] for k in nds if k in nodes])  # noqa: E731
    vltava = [line(nds) for tags, nds in ways if tags.get("waterway") == "river" and tags.get("name") == "Vltava" and sum(k in nodes for k in nds) > 1]
    river = linemerge(unary_union(vltava)).intersection(clip.buffer(-60)) if vltava else None
    if river is None or river.is_empty:
        print(f"{area}: the Vltava isn't in this area")
        (OUT / f"{area}_now" / "river.json").write_text(json.dumps({"version": VERSION, "fairway": [], "ferries": []}))
        return
    # One line, south to north (the longest piece, should the area's edge cut it in several).
    if river.geom_type != "LineString":
        river = max(river.geoms, key=lambda g: g.length)
    if river.coords[0][1] > river.coords[-1][1]:
        river = LineString(river.coords[::-1])
    # The locks and canals count as places to look for water too.
    side = [line(nds) for tags, nds in ways if (tags.get("lock") == "yes" or tags.get("waterway") == "canal") and sum(k in nodes for k in nds) > 1]
    near = unary_union([river] + [g for g in side if g.distance(river) < CORRIDOR]).intersection(clip)
    water = Water(area, near)
    print(f"{area}: {river.length / 1000:.1f} km of the Vltava, {water.tiles} tiles, {len(water.weirs)} weirs in them")
    locks = [[[round(x, 1), round(y, 1)] for x, y in g.coords] for tags, nds in ways if tags.get("lock") == "yes"
             for g in [line(nds)] if g.distance(river) < CORRIDOR and clip.contains(g)]
    data = {"version": VERSION, "fairway": fairway(water, river), "locks": locks,
            "ferries": ferries(water, tf, lambda x, y: clip.contains(Point(x, y)))}
    out = OUT / f"{area}_now" / "river.json"
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    main(*sys.argv[1:])
