# AI car traffic

read_when: changing traffic counts, routes, bus displays, police lights, parking
clearance or tile street loading; regenerating the time-of-day table.

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

**Bus displays.** Buses working a PID line keep its actual `ref` and destination from
the loaded `buses.json`. The front board shows a larger line number, the side board
also shows the destination, and the roof number can be read from the game's overhead
camera. Board textures are cached per number/destination and reused as cars move or
leave view. A wandering bus without a line, an empty identifier or a burnt wreck has
no route label. Taking a bus preserves its assigned line; it does not assign a new one.

**Police lights after theft.** A police car driven by the player keeps its blue
flashing lamps and street illumination on, including at a stop or in reverse. They
switch off on exit and return on re-entry; burnt wrecks are excluded. Police cars in
an active chase retain their existing lights, while those that stand down or return
to patrol do not flash. Player ownership does not add a siren or make traffic give way.

**Couriers.** In `Traffic.spawn`, half of the ordinary bikes and a third of the mopeds are
delivery couriers: a box on the rider's back in pink, green or blue (`COURIER_BOXES` in
`src/car.ts`, baked into the two-wheeler's geometry, so one draw call per colour) and a
jacket in the same colour (`courierLook`). Bikes are 1.6 of the traffic mix's weights, up
from 0.5. `BOX_AT` in `src/car.ts` puts the box on the back; it was placed by eye from the
riding pose in `assets/figures/build.py`, so change it if that pose changes.

**Parking beside traffic.** Before publishing a tile's parked cars, `TileWorld`
fetches the JSON for its eight neighbours and builds a separate, deduplicated street
graph for clearance. It does not fetch their height grids or IPR meshes just for
parking, add their roads to live traffic early, or replace cars when they arrive.
Failed neighbour JSON blocks that parking pass and is retried; it never counts as
an empty road. When the index announces tile graphs, both `drive` and `walk` arrays
must be present; explicit empty arrays are valid. Older maps with a separately
loaded graph may omit those fields. The JSON cache is pruned when the camera changes
tile or view range.

`parkingClearance` indexes the ground-level lanes and the junction curves shared
with `Route`. Ordinary curves reserve a pickup's collision circles, while the wider
bus curves also allow for its axle placement and heading rotation on approach and
exit. Parked cars must leave those swept paths clear; pavement parking also checks
the neighbouring carriageways. Bridges and tunnels are excluded so parking under
or above them stays possible. Parking candidates, tile ownership, paid-section
shares and day/night occupancy targets stay the same; fewer cars fit where the
mapped bays would obstruct traffic. Clearance is built once per parking pass,
never in the frame loop.

Run `node scripts/check-parking-clearance.mjs` for CPU regressions using the shipped
car models and the actual traffic updater: neighbouring lane offsets, opposite
tile/completion orders, retry and cache lifetime, narrow streets, paid-section
targets, and body clearance through right, left and short curved junctions. These
checks cover normal route following; collisions can still move cars out of their
lanes, and emergency routes are separate.

The 3 October 2026 controlled scene replay used a 12 m bus on Ostrovní → Opatovická,
past the old accepted hatchback at `50.080753948, 14.418088551` (tile `8_5`). Its
collision circles overlapped by 0.377 m. With candidate parking the same actor
completed the turn without touching parked cars. This used the private `centrum`
map built `2026-10-02T20:16:12Z`, WebGPU, Wednesday 14:00 and clear weather; camera
height 48 m, tilt 0°, heading 0°. Nearby ordinary-car overlap was not reproduced;
the ordinary turning checks use the actual traffic updater in CPU fixtures.
Neighbouring tiles `8_5` and `7_5` also produced identical parked-car layouts in
opposite reload orders (103 and 78 cars), with zero duplicate centres. This is
targeted behaviour evidence, not a citywide driving or performance comparison.
The [durable captures, measurements and replay snippets](evidence/parking-clearance-2026-10-03/README.md)
record the baseline reconstruction and the controls used.

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
