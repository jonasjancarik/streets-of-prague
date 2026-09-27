"""How often Prague's trams and metro run, from PID's timetables (GTFS).

    uv run pid_timetable.py            # print a summary

Downloads https://data.pid.cz/PID_GTFS.zip into .cache/pid/ (about 50 MB; again
when it's a week old) and reduces it to what the game needs, cached next to it as
summary.json: for every tram and metro trip on a typical weekday, Saturday and
Sunday, the line, where it starts and ends, when it leaves and how long it takes.
build_lines.py turns that into trips per hour for each line, and the metro's
station-to-station times.
"""

import csv
import datetime as dt
import io
import json
import sys
import time
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import requests

URL = "https://data.pid.cz/PID_GTFS.zip"
CACHE = Path(__file__).parent / ".cache" / "pid"
FEED = CACHE / "PID_GTFS.zip"
SUMMARY = CACHE / "summary.json"
DAYS = ("weekday", "saturday", "sunday")
KINDS = {"0": "tram", "1": "metro"}


def feed():
    CACHE.mkdir(parents=True, exist_ok=True)
    if not FEED.exists() or time.time() - FEED.stat().st_mtime > 7 * 86400:
        print("downloading PID's timetables…")
        r = requests.get(URL, timeout=300)
        r.raise_for_status()
        FEED.write_bytes(r.content)
    return FEED


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def seconds(hms):
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def typical_dates(z):
    """A Wednesday, a Saturday and a Sunday a few days into the feed (clear of the
    holiday or two a feed often starts on)."""
    info = next(rows(z, "feed_info.txt"))
    start = dt.datetime.strptime(info["feed_start_date"], "%Y%m%d").date() + dt.timedelta(days=3)
    out = {}
    for k in range(14):
        d = start + dt.timedelta(days=k)
        day = {2: "weekday", 5: "saturday", 6: "sunday"}.get(d.weekday())
        if day and day not in out:
            out[day] = d
    return out


def services_on(z, dates):
    """service_id → the day types it runs on (of the typical dates)."""
    on = defaultdict(set)
    for r in rows(z, "calendar.txt"):
        for day, d in dates.items():
            ymd = d.strftime("%Y%m%d")
            if r["start_date"] <= ymd <= r["end_date"] and r[d.strftime("%A").lower()] == "1":
                on[r["service_id"]].add(day)
    for r in rows(z, "calendar_dates.txt"):
        for day, d in dates.items():
            if r["date"] == d.strftime("%Y%m%d"):
                (on[r["service_id"]].add if r["exception_type"] == "1" else on[r["service_id"]].discard)(day)
    return on


def summary():
    """The cached summary, rebuilt when the feed is newer."""
    path = feed()
    if SUMMARY.exists() and SUMMARY.stat().st_mtime > path.stat().st_mtime:
        return json.loads(SUMMARY.read_text())
    with zipfile.ZipFile(path) as z:
        dates = typical_dates(z)
        on = services_on(z, dates)
        routes = {r["route_id"]: (KINDS[r["route_type"]], r["route_short_name"], r["route_color"], r["is_night"] == "1")
                  for r in rows(z, "routes.txt") if r["route_type"] in KINDS}
        trips = {}
        for r in rows(z, "trips.txt"):
            if r["route_id"] in routes and on.get(r["service_id"]):
                trips[r["trip_id"]] = (r["route_id"], sorted(on[r["service_id"]]), r["direction_id"])
        names = {r["stop_id"]: r["stop_name"] for r in rows(z, "stops.txt")}
        # Each trip's stops in order, with times.
        calls = defaultdict(list)
        for r in rows(z, "stop_times.txt"):
            if r["trip_id"] in trips:
                calls[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], seconds(r["arrival_time"]), seconds(r["departure_time"])))
    out = []
    for tid, (rid, days, direction) in trips.items():
        c = sorted(calls[tid])
        if len(c) < 2:
            continue
        kind, ref, colour, night = routes[rid]
        trip = {"kind": kind, "ref": ref, "colour": colour, "night": night, "days": days, "dir": direction,
                "from": names[c[0][1]], "to": names[c[-1][1]], "dep": c[0][3], "dur": c[-1][2] - c[0][3]}
        if kind == "metro":
            # Station by station, for the metro's travel times.
            trip["stops"] = [[names[s], a - c[0][3]] for _, s, a, _ in c]
        out.append(trip)
    data = {"dates": {k: str(v) for k, v in dates.items()}, "trips": out}
    SUMMARY.write_text(json.dumps(data, ensure_ascii=False))
    return data


def hourly(trips, day):
    """Trips per hour (0-23; after midnight counts in the early hours) for a set of trips."""
    per = [0] * 24
    for t in trips:
        if day in t["days"]:
            per[(t["dep"] // 3600) % 24] += 1
    return per


if __name__ == "__main__":
    data = summary()
    print("typical days:", data["dates"])
    by_ref = Counter((t["kind"], t["ref"]) for t in data["trips"])
    print(len(data["trips"]), "trips;", len(by_ref), "lines")
    for ref in sys.argv[1:] or ["22", "A"]:
        ts = [t for t in data["trips"] if t["ref"] == ref]
        for day in DAYS:
            print(ref, day, hourly(ts, day))
        print(ref, "variants:", Counter((t["from"], t["to"]) for t in ts).most_common(6))
