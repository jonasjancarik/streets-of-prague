"""Prague's metro for the game, from PID's timetables: public/data/<area>_now/metro.json.

    uv run build_metro.py centrum

The metro runs underground, so in the game it's a way across town: walk into an
entrance, pick a station, and come up at one of its entrances. For each line (A, B,
C): its colour, its stations in order with the minutes from the first one, their
entrances (in the area's local metres), and trips per hour in each direction by hour
of the day on a weekday, Saturday and Sunday. Everything comes from pid_timetable.py.
"""

import json
import sys
from collections import Counter

from pyproj import Transformer

from osm_area import AREAS, OUT
from pid_timetable import DAYS, hourly, summary


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
    lines = []
    for ref in sorted({t["ref"] for t in data["trips"] if t["kind"] == "metro"}):
        trips = [t for t in data["trips"] if t["ref"] == ref]
        # The whole line: the most common route among the longest trips, one way.
        longest = max(len(t["stops"]) for t in trips)
        route = Counter(tuple(s for s, _ in t["stops"]) for t in trips if len(t["stops"]) == longest and t["dir"] == "0").most_common(1)[0][0]
        runs = [t for t in trips if tuple(s for s, _ in t["stops"]) == route and t["dir"] == "0"]
        # Minutes from the first station: the middle value over the day's trips.
        times = [sorted(t["stops"][i][1] for t in runs)[len(runs) // 2] for i in range(len(route))]
        lines.append({
            "ref": ref, "colour": "#" + trips[0]["colour"],
            "stations": [{
                "name": stations[k]["name"], "at": xy(stations[k]), "t": times[i],
                "entrances": [xy(en) for en in stations[k]["entrances"]] or [xy(stations[k])],
            } for i, k in enumerate(route)],
            # Both directions count, so halve.
            "perHour": {day: [x / 2 for x in hourly(trips, day)] for day in DAYS},
        })
        print(f"line {ref}: {stations[route[0]]['name']} – {stations[route[-1]]['name']}, "
              f"{len(route)} stations, {times[-1] / 60:.0f} min end to end")
    out = OUT / f"{area}_now" / "metro.json"
    out.write_text(json.dumps({"lines": lines}, ensure_ascii=False, separators=(",", ":")))
    print(f"{out.stat().st_size / 1e3:.0f} kB → {out.relative_to(OUT.parent)}")


if __name__ == "__main__":
    main(*sys.argv[1:])
