"""Prague's city buses along their real routes, from PID's timetables (GTFS).

    uv run build_buses.py centrum      # → public/data/centrum_now/buses.json

For every day bus line through the area, each direction's most used shape (the
street-by-street path its trips follow) and its stops in order, from the feed
pid_timetable.py downloads. The shape is cut down to the part in and around the
area and simplified; the game follows it from junction to junction along its own
street network and pulls up at the stops.

Each line in buses.json: `ref`, `dir` (0 or 1), `to` (the headsign), `pts` (the
path in the area's local metres, in driving order) and `stops` ([distance along
the path, name, platform ID] of each stop on it).
"""

import csv
import io
import json
import math
import sys
import zipfile
from collections import Counter, defaultdict

from pyproj import Transformer
from shapely.geometry import LineString, Point

from build_cache import atomic
from osm_area import AREAS, OUT
from pid_timetable import feed, seconds, services_on, typical_dates

MARGIN = 400  # metres of route kept round the area, so buses come in from off the map
NEAR_STOP = 30  # a stop further than this from the path isn't on it (m)


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


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
    inside = lambda x, y, m=0: x0 - m < x < x1 + m and y0 - m < y < y1 + m  # noqa: E731

    z = zipfile.ZipFile(feed())
    routes = {r["route_id"]: r for r in rows(z, "routes.txt")
              if r["route_type"] == "3" and r["is_night"] == "0" and r["is_substitute_transport"] == "0"}
    # Each direction's most used shape, and a headsign for it.
    service_days = services_on(z, typical_dates(z))
    trips = {}
    pilot_trips = {}
    shapes, heads = defaultdict(Counter), defaultdict(Counter)
    for t in rows(z, "trips.txt"):
        if t["route_id"] in routes and service_days.get(t["service_id"]):
            trips[t["trip_id"]] = (routes[t["route_id"]]["route_short_name"], t["trip_headsign"], service_days[t["service_id"]])
            if area == "praha" and trips[t["trip_id"]][0] == "227" and t["shape_id"]:
                pilot_trips[t["trip_id"]] = t["shape_id"]
        if t["route_id"] in routes and t["shape_id"]:
            key = (t["route_id"], t["direction_id"])
            shapes[key][t["shape_id"]] += 1
            heads[key][t["trip_headsign"]] += 1
    wanted = {key: c.most_common(1)[0][0] for key, c in shapes.items()}
    want_ids = set(wanted.values()) | set(pilot_trips.values())
    pts = defaultdict(list)
    for r in rows(z, "shapes.txt"):
        if r["shape_id"] in want_ids:
            pts[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
    stops = {r["stop_id"]: (r["stop_name"], *tf.transform(float(r["stop_lon"]), float(r["stop_lat"]))) for r in rows(z, "stops.txt")}
    # PID uses a P suffix for some modes at the same physical platform.
    platform_ids = {sid: sid[:-1] for sid, row in stops.items()
                    if sid.endswith("P") and stops.get(sid[:-1]) == row}
    order = defaultdict(list)
    for r in rows(z, "route_stops.txt"):
        order[(r["route_id"], r["direction_id"])].append((int(r["stop_sequence"]), r["stop_id"]))

    lines = []
    platforms = set()
    for (rid, d), sid in sorted(wanted.items(), key=lambda kv: (int("".join(c for c in routes[kv[0][0]]["route_short_name"] if c.isdigit()) or 0), kv[0][1])):
        xy = [tf.transform(lon, lat) for _, lon, lat in sorted(pts[sid])]
        # From the first point near the area to the last one.
        near = [i for i, p in enumerate(xy) if inside(*p, MARGIN)]
        if not near or not any(inside(*p) for p in xy):
            continue
        xy = xy[near[0]:near[-1] + 1]
        if len(xy) < 2:
            continue
        ls = LineString(xy).simplify(1.0)
        if ls.length < 200:
            continue
        # Stops in order, each measured along the path no earlier than the one before.
        on, last = [], -1.0
        for _, stop in sorted(order[(rid, d)]):
            if stop not in stops:
                continue
            name, sx, sy = stops[stop]
            p = Point(sx, sy)
            if ls.distance(p) > NEAR_STOP:
                continue
            at = ls.project(p)
            if at <= last or at < 10 or at > ls.length - 5:
                continue
            platform = platform_ids.get(stop, stop)
            on.append([round(at, 1), name, platform])
            platforms.add(platform)
            last = at
        ref = routes[rid]["route_short_name"]
        lines.append({
            "ref": ref, "dir": int(d), "to": heads[(rid, d)].most_common(1)[0][0],
            "pts": [[round(x, 1), round(y, 1)] for x, y in ls.coords],
            "stops": on,
        })
        print(f"bus {ref} → {lines[-1]['to']}: {ls.length / 1000:.1f} km, {len(on)} stops")

    pilot_calls = defaultdict(list)
    departures = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for r in rows(z, "stop_times.txt"):
        stop, trip = platform_ids.get(r["stop_id"], r["stop_id"]), r["trip_id"]
        if trip in pilot_trips and r["stop_id"] in stops and r["departure_time"] and r["arrival_time"]:
            pilot_calls[trip].append((int(r["stop_sequence"]), r["stop_id"], seconds(r["arrival_time"]), seconds(r["departure_time"])))
        if stop not in platforms or trip not in trips or r["pickup_type"] == "1" or not r["departure_time"]:
            continue
        ref, to, days = trips[trip]
        for day in days:
            departures[stop][ref][day].append([seconds(r["departure_time"]), r["stop_headsign"] or to, trip])
    for platform in departures.values():
        for line in platform.values():
            for calls in line.values():
                calls.sort()

    shards = defaultdict(dict)
    for platform, calls in sorted(departures.items()):
        shard = 0
        for character in platform:
            shard = (31 * shard + ord(character)) % 64
        shards[shard][platform] = calls
    directory = OUT / f"{area}_now"
    for shard, calls in shards.items():
        atomic(directory / f"bus-timetable-{shard}.json",
               json.dumps(calls, ensure_ascii=False, separators=(",", ":")).encode())

    pilot_shapes = {}
    for shape in sorted(set(pilot_trips.values())):
        xy = [tf.transform(lon, lat) for _, lon, lat in sorted(pts[shape])]
        if len(xy) >= 2:
            pilot_shapes[shape] = LineString(xy).simplify(1.0)
    pilot = []
    for trip, calls in sorted(pilot_calls.items()):
        shape = pilot_trips[trip]
        path = pilot_shapes.get(shape)
        if path is None:
            continue
        visits = []
        for _, sid, arrival, departure in sorted(calls):
            name, x, y = stops[sid]
            point = Point(x, y)
            at = path.project(point)
            if path.distance(point) > NEAR_STOP or (visits and at <= visits[-1][0]):
                break
            visits.append([round(at, 1), name, platform_ids.get(sid, sid), arrival, departure])
        if len(visits) == len(calls) and len(visits) >= 2:
            _, destination, days = trips[trip]
            pilot.append([trip, shape, destination, sorted(days), visits])
    pilot_data = {
        "shapes": {sid: [[round(x, 1), round(y, 1)] for x, y in path.coords]
                   for sid, path in pilot_shapes.items()},
        "trips": pilot,
    }

    out = directory / "buses.json"
    atomic(out, json.dumps({"lines": lines, "timetables": sorted(shards), "pilot227": pilot_data if pilot else None}, ensure_ascii=False, separators=(",", ":")).encode())
    print(f"{len(lines)} bus routes, {out.stat().st_size / 1e3:.0f} kB → {out.relative_to(OUT.parent)}")


if __name__ == "__main__":
    main(*sys.argv[1:])
