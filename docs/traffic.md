# AI car traffic

read_when: changing how many cars are about, where they start or which way they turn;
regenerating the time-of-day table.

## How it works

**How many cars.** `trafficWanted(t)` in `src/traffic.ts` gives the number of AI cars to
keep about at a clock time (seconds into the week). It is `round(QUIET + (BUSY − QUIET) ×
√load)`, with QUIET 10 and BUSY 46. `load` comes from `TRAFFIC_LOAD`, three arrays of 24
numbers (weekday, Saturday, Sunday), from 0 (roads flowing freely) to 1 (the slowest hour
of the week). Each hour's number stands for the middle of that hour, with a straight line
between hours. The square root is there because travel times climb much faster than the
number of cars once roads are nearly full. The count includes buses and police.

In `src/main.ts` the first spawn and the top-up loop (every 0.25 s, offscreen only) use
the current target. When the target falls (evening, time moved on), the clean-up round
(every 0.5 s) releases up to 3 surplus cars, only where `offscreen()` says the player
can't see them, and never hired taxis, buses or police.

**Where they start and turn.** `Traffic.spawn` picks a street with probability
`length × roadWeight(class)` (`ROAD_WEIGHT` in `src/network.ts`: trunk/primary 3,
secondary 2.5, tertiary 2, residential 1, living street and service 0.3). At a junction
`nextEdge(…, lean)` weights each turn by the square root of that, so a main road wins
more often but side streets stay reachable. Both apply only to ordinary cars (spawned
without a type). Buses, taxis, police and pavement drivers are unchanged.

## The data

`TRAFFIC_LOAD` is made by `pipeline/build_traffic_profile.py`:

    cd pipeline && uv run build_traffic_profile.py [path/to/fact_v_route_travel_times.csv] [year]

It reads TSK Praha's main-road travel times (the Data Praha dashboard export, kept in
`~/projects/doprava-praha`, 592 MB, local only), keeps one year (default 2025, 73 routes),
takes the mean travel time per route, day type and hour, divides by that route's
free-flow time (its quickest hourly mean) and averages over routes. The result is scaled
so the quietest hour is 0 and the slowest 1, and printed as a TypeScript literal to paste
in. It takes about 11 seconds.

Travel times measure how slow the roads are, not how many cars there are. The game's
numbers are a starting point to tune by eye.

## What was checked (2026-09-29)

Car counts in Chrome: 14 at 03:00, 36 at Monday 08:00, 24 at Sunday 08:00, 46 at
Tuesday 17:00. Moving the clock from 17:00 to 03:00 thinned the traffic from 46 to 14
over about 8 s. The drive scene of `scripts/bench.mjs` kept the same frame time with 46
cars as with 14 (GPU time rose from 6 to 11 ms, part of it the daytime scene). Not done:
a `--ab` comparison against the old fixed 40, watching cars leave by eye, and a check
of the junction lean on its own.

## What is left

- **Queues on the real roads.** The travel times belong to 73 named routes.
  `~/projects/doprava-praha/output/route_lines.csv` has their lines (WKT, lon/lat). Match
  them to drive edges and slow or thicken traffic on those streets by their own ratio,
  instead of one city-wide number. Also gives a direction: the peak is inbound in the
  morning and outbound in the evening.
- **Real vehicle counts.** TSK's traffic detector counts (if published) would replace
  the square-root guess for how travel time turns into car numbers.
- **Tune the numbers** by looking: QUIET, BUSY, the road weights and the lean. In the
  centre almost every loaded street is residential, so the main-road effect only shows
  around Újezd, the embankments and other bigger roads.
- **Seasons and weather.** The profile is one year, all months together. Months (school
  holidays, August) and rain (slower roads) could shift it. Public holidays count as
  weekdays.
- **Car mix by hour.** Delivery vans and taxis at the morning peak, more buses, night
  taxis; today only the number changes.
- **Traffic lights and speed.** Congested roads could make cars drive slower, not only
  be more numerous.
- **Performance.** The peak of 46 is a little above the old 40. If more is wanted, run
  `scripts/bench.mjs --ab` in real Chrome first (see the `performance` skill).
- **Clean-up look.** Cars are released only offscreen, so a car that stays in view keeps
  the count above target until it isn't. Cars fade in and out nowhere, which is fine
  now but would matter with a bigger difference between day and night.
