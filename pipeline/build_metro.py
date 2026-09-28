"""Prague's metro for the game, from PID's timetables: public/data/<area>_now/metro.json.

    uv run build_metro.py centrum

The metro runs underground, so in the game it's a way across town: walk into an
entrance, pick a station, and come up at one of its entrances. For each line (A, B,
C): its colour, its stations in order with the minutes from the first one, their
entrances (in the area's local metres), and trips per hour in each direction by hour
of the day on a weekday, Saturday and Sunday. Everything comes from pid_timetable.py.

Each line also has its track (`path`, from the feed's shapes, first station to last)
and each station how far along it the station is (`d`, in metres), so the game can
follow a train through the tunnels on the way.
"""

import json
import sys
import zipfile
from collections import Counter

from pyproj import Transformer
from shapely import LineString, Point

from osm_area import AREAS, OUT
from pid_timetable import DAYS, feed, hourly, rows, summary


def shapes(refs):
    """Every shape the metro's trips one way (direction 0) follow, by line: {ref:
    {shape_id: [(lon, lat), …]}}."""
    with zipfile.ZipFile(feed()) as z:
        routes = {r["route_id"]: r["route_short_name"] for r in rows(z, "routes.txt")
                  if r["route_type"] == "1" and r["route_short_name"] in refs}
        ids = {r["shape_id"]: routes[r["route_id"]] for r in rows(z, "trips.txt")
               if r["route_id"] in routes and r["direction_id"] == "0" and r["shape_id"]}
        points = {}
        for r in rows(z, "shapes.txt"):
            if r["shape_id"] in ids:
                points.setdefault(r["shape_id"], []).append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
    out = {ref: {} for ref in refs}
    for k, pts in points.items():
        out[ids[k]][k] = [(lon, lat) for _, lon, lat in sorted(pts)]
    return out


def track(candidates, at):
    """The line's track through its stations `at` (local metres, in order): the shape
    that passes closest to all of them (the shortest of those, as a tie-break), cut to
    run from the first station to the last. Returns the path and each station's
    distance along it."""
    def fit(line):
        return round(sum(line.distance(Point(p)) for p in at)), line.length

    line = min(candidates, key=fit)
    far = max(line.distance(Point(p)) for p in at)
    if far > 60:
        print(f"  a station is {far:.0f} m off the track")
    # Stations along the track, each at or after the one before.
    ds = []
    for p in at:
        d = line.project(Point(p))
        ds.append(max(d, ds[-1] if ds else 0))
    cut = LineString([line.interpolate(ds[0]).coords[0]]
                     + [c for c, d in ((c, line.project(Point(c))) for c in line.coords) if ds[0] < d < ds[-1]]
                     + [line.interpolate(ds[-1]).coords[0]]).simplify(1.0)
    path = [[round(x, 1), round(y, 1)] for x, y in cut.coords]
    return path, [round(cut.project(Point(line.interpolate(d).coords[0])), 1) for d in ds]


def main(area: str = "centrum") -> None:
    w, s, e, n = AREAS[area]
    centre = ((w + e) / 2, (s + n) / 2)
    tf = Transformer.from_crs(
        "EPSG:4326",
        f"+proj=tmerc +lat_0={centre[1]} +lon_0={centre[0]} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m",
        always_xy=True,
    )
    xy = lambda p: [round(v, 1) for v in tf.transform(p["lon"], p["lat"])]  # noqa: E731
    data = summary()
    stations = data["stations"]
    refs = sorted({t["ref"] for t in data["trips"] if t["kind"] == "metro"})
    tracks = shapes(refs)
    lines = []
    for ref in refs:
        trips = [t for t in data["trips"] if t["ref"] == ref]
        # The whole line: the most common route among the longest trips, one way.
        longest = max(len(t["stops"]) for t in trips)
        route = Counter(tuple(s for s, _ in t["stops"]) for t in trips if len(t["stops"]) == longest and t["dir"] == "0").most_common(1)[0][0]
        runs = [t for t in trips if tuple(s for s, _ in t["stops"]) == route and t["dir"] == "0"]
        # Minutes from the first station: the middle value over the day's trips.
        times = [sorted(t["stops"][i][1] for t in runs)[len(runs) // 2] for i in range(len(route))]
        path, ds = track([LineString([tf.transform(*p) for p in pts]) for pts in tracks[ref].values()],
                         [tf.transform(stations[k]["lon"], stations[k]["lat"]) for k in route])
        lines.append({
            "ref": ref, "colour": "#" + trips[0]["colour"], "path": path,
            "stations": [{
                "name": stations[k]["name"], "at": xy(stations[k]), "t": times[i], "d": ds[i],
                "entrances": [xy(en) for en in stations[k]["entrances"]] or [xy(stations[k])],
            } for i, k in enumerate(route)],
            # Both directions count, so halve.
            "perHour": {day: [x / 2 for x in hourly(trips, day)] for day in DAYS},
        })
        print(f"line {ref}: {stations[route[0]]['name']} – {stations[route[-1]]['name']}, "
              f"{len(route)} stations, {times[-1] / 60:.0f} min and {ds[-1] / 1000:.1f} km end to end, {len(path)} track points")
    out = OUT / f"{area}_now" / "metro.json"
    out.write_text(json.dumps({"lines": lines}, ensure_ascii=False, separators=(",", ":")))
    print(f"{out.stat().st_size / 1e3:.0f} kB → {out.relative_to(OUT.parent)}")


if __name__ == "__main__":
    main(*sys.argv[1:])
