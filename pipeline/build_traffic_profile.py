"""How busy Prague's main roads are, hour by hour, from TSK's travel times.

    uv run build_traffic_profile.py [fact_v_route_travel_times.csv] [year]

Reads the travel times TSK measures on the main roads (published by Data Praha,
in the export kept in ~/projects/doprava-praha) and prints a TypeScript literal:
three arrays of 24 numbers (weekday, saturday, sunday; one per hour of the day),
from 0 (roads flowing freely) to 1 (the slowest, busiest hour). Paste it into
TRAFFIC_LOAD in src/traffic.ts.

For each route, day type and hour it takes the mean travel time and divides it by
the route's free-flow time (its quickest hourly mean of the day types together), so
a long route doesn't count for more than a short one. Those ratios are averaged
over the routes and scaled so the quietest hour is 0 and the slowest 1. Travel
times say how slow the roads are, not how many cars there are, so the game turns
this into a number of cars with a square root (see trafficWanted).

The file is 12 million rows, so it is read one row at a time.
"""

import csv
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_CSV = Path.home() / "projects/doprava-praha/output-fact/fact_v_route_travel_times.csv"
KINDS = ["weekday", "saturday", "sunday"]


def kind_of(dow: int) -> int:
    # dow: 0 = Sunday … 6 = Saturday
    return 2 if dow == 0 else 1 if dow == 6 else 0


def main(path: Path = DEFAULT_CSV, year: int = 2025) -> None:
    # (route, day type, hour) → [sum of travel times, count]
    acc: dict[tuple[str, int, int], list[float]] = defaultdict(lambda: [0.0, 0])
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            if row["year"] != str(year):
                continue
            try:
                secs = float(row["travel_time"])
            except ValueError:
                continue  # no measurement
            if secs <= 0:
                continue
            a = acc[(row["route_id"], kind_of(int(row["dow"])), int(row["hour"]))]
            a[0] += secs
            a[1] += 1

    means = {k: s / n for k, (s, n) in acc.items()}
    free = {}
    for (route, _, _), m in means.items():
        free[route] = min(m, free.get(route, m))

    # Average of the routes' slowdown at each day type and hour.
    ratio = [[0.0] * 24 for _ in KINDS]
    for kind in range(len(KINDS)):
        for hour in range(24):
            r = [m / free[route] for (route, k, h), m in means.items() if k == kind and h == hour]
            ratio[kind][hour] = sum(r) / len(r)

    top = max(max(row) for row in ratio)
    print(f"// {len(free)} routes, {year}; slowest hour is {top:.2f} times free flow", file=sys.stderr)
    print("[")
    for kind, row in zip(KINDS, ratio):
        print("  [" + ", ".join(f"{(v - 1) / (top - 1):.2f}" for v in row) + f"], // {kind}")
    print("]")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CSV, int(sys.argv[2]) if len(sys.argv) > 2 else 2025)
