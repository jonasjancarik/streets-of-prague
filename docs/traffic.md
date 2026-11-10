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

**Bags.** A courier whose bike is taken (`enterOrExit` in `src/main.ts`) or hit hard by a
car or tram (`throwRider`; any rider in traffic goes over the handlebars then, couriers
too) runs off and leaves the bag on the ground by the bike, and the bike loses its box
(`Car.setBox`). `src/bags.ts` keeps the bags lying about: pictures only, nothing in traffic
or on the tram tracks sees them, and they sink out of sight after three minutes or when you
are 150 m away. E on foot picks up one within reach (unless a vehicle is closer) and puts
it on your back (`BOX_AT.foot`); with a bag and no vehicle in reach, E puts it down.
You keep it in vehicles; on a bike or moped it rides in the box position of the bike
model. It isn't saved and has no other use yet. `scenarios/courier-bag.ts` and
`scenarios/bike-hit.ts` cover it.

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
with `Route`. Sharp bends inside a street also reserve a pickup's collision circles
while its heading catches up; duplicate points do not invent or hide a bend.
Ordinary junction curves reserve a pickup's collision circles, while the wider
bus curves also allow for its axle placement and heading rotation on approach and
exit. Parked cars must leave those swept paths clear; pavement parking also checks
the neighbouring carriageways. The mapped street's middle also reserves a fire
engine's width, because emergency routes use it even on a wide one-way street whose
ordinary lane lies to one side. Bridges and tunnels are excluded so parking under
or above them stays possible. Parking candidates, tile ownership, paid-section
shares and day/night occupancy targets stay the same; fewer cars fit where the
mapped bays would obstruct traffic. Clearance is built once per parking pass,
never in the frame loop.

Run `node scripts/check-parking-clearance.mjs` for CPU regressions using the shipped
car models and the actual traffic updater: neighbouring lane offsets, opposite
tile/completion orders, retry and cache lifetime, narrow streets, paid-section
targets, body clearance through right, left and short curved junctions, and the
captured Pobřežní interior bend at different speeds and time steps. Duplicate-point
and cropped-index controls cover that bend too. These
checks cover normal route following on fixtures; `check-parking-city.mjs` (below) looks
at a whole map and at the middle of the streets emergency vehicles use.

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

Two-way streets narrower than `SINGLE_LANE` (4.6 m, `src/network.ts`) are single lane:
cars drive a little off the axis (width/2 - 0.95 m, at least 0.5 m) and slowly (5 m/s
at most), and meet by squeezing past. Streets outside the technical map get their
width from `pipeline/lanes.py` (by class and setting, cut to the room between the
buildings), so many village streets are 5.5 m, and some under 4.6 m.
`node scripts/check-narrow-lanes.mjs` runs two cars head-on through the real updater on
3.75, 4.0 and 4.5 m streets.

The width these rules use is OSM's, or the room between the surveyed kerbs (`kerb`,
`pipeline/kerbs.py`) where that is less: about a fifth of two-way streets are mapped
more than 1.5 m wider than their kerbs (Pod křížkem: 8 m between kerbs 5 m apart), and
the lane put by OSM's width ran half over the pavement. A car's right side also stays
1 m inside the right-hand kerb. Kerbs further apart than OSM's width (a parking lane, a
bay) leave the lane where OSM's width puts it.

**Parking up on the pavement.** Where a side of a street is too narrow for a car at the
kerb beside the lane (untagged by OSM), the pavement spots on that side come every 6 m
instead of 12, stand fully up (1.45 m past the kerb, clear of the lane even at bends) and
fill as the buildings round them call for (`occupancy`), like kerb spots elsewhere.
Elsewhere a few cars stand on the pavement at random, as before. A pavement car may reach
0.8 m in from the kerb (two wheels up) before it counts as on the carriageway. On the
southern suburbs (praha tiles 50,36 to 60,46) this took parked cars from 6476 to 11815;
cars in a bus's turning sweep (`check-parking-city.mjs`) went from 9 to 25, at most 0.44 m.

**Driving off along the pavement** (`pavement.ts`). Now and then a car parked up on the
pavement sets off along it before it comes down into the lane. It goes only when the
whole way is clear, along the street's line as `Traffic.adopt` will drive it (beside the
lane, then easing in): no wall, other car, lamp or wire post, fence or hedge within half
its width and 0.2 m. Before, only walls and cars were checked, along a straight line, and
on Pod křížkem four of six such cars in four minutes drove through a lamp post; after,
one set off in four minutes and touched none (most of that narrow pavement has a lamp
post or a garden fence in the way).

**Standing cars and bends.** A car measures what stands in its way along the lane
ahead (`Route.ahead`: the lane as straight pieces, round bends and through the junction
curve), not along a straight line from where it is. A standing car is in the way only
when the passing car's side would come within `TOUCH` (0.1 m) of it, which is less than
the 1.25 m `parkingClearance` leaves beside a lane; on a street the driver pulls out
round it where there's room (`SWERVE`, `PASS`), and in a junction or past it waits and
then squeezes by. Before 6 October 2026 a car parked outside a bend looked as if it
stood in the lane, and a taxi, bus or pickup stopped behind it for good.
The lane ahead is built only when the first standing car near it needs measuring, at
most once a car a step, and each piece's direction and length are worked out once
then rather than for every circle of every standing car (plan 034;
`node scripts/check-traffic-lanes.mjs --compare FILE` replays seeded traffic against a
trace recorded from the code before, step by step). Once the lane is built, a box round
its pieces (`laneBox`, measured along and across the lane where the car is, with the
margin a standing car of that size could matter within) rules out the many parked cars
nowhere near it before they are measured against every piece; the bound is exact, so
nothing a car does changes (11 November 2026). A standing car's speed is not worked out
with a square root when it is surely under 0.3 m/s, and `mergeDistance` is asked only
about moving obstacles, since a standing car is never followed into a shared lane.

Traffic already queuing on a car's current or immediately upcoming directed lane
remains an obstacle during jam escape, even when a sharp turn makes it face across the
following car. Otherwise the following car can drive into the queue and leave
both cars blocking each other. Unrelated crossing and opposing traffic retain
their existing escape behaviour. `node scripts/check-traffic-queues.mjs` checks
the captured Zdibsko turn, normal queues and move-off with every collision circle,
plus crossing, opposing and pedestrian controls, without a browser. An edge only
later in the route preview does not turn crossing traffic into a queue.
The comparison uses directed edge IDs, so routes retained while a tile leaves and
reloads still recognise cars on the same lane.

**Merging traffic.** Cars on separate approaches also compare distance along their
routes to a shared current or immediately next road. A moving car already ahead
can make the other brake before their junction curves meet. The distance stays
continuous when a car enters the road. This applies only within the existing
forward route horizon; a stopped car on a different approach does not reserve a
future junction. Stationary connector cars still use the ordinary path checks,
and cars already on the same road keep the existing following and lateral rules.
The lookup uses live agents and memoizes each encountered car during the current
car's step, without taking a new route-position snapshot.

`node scripts/check-traffic-merges.mjs` checks actual car bodies across 360 merge
cases plus yielding, pavement adoption, distant/winding approaches and held-car
release controls. Two pre-existing bus-turn overlaps remain on a 2 m outgoing
road with a right-angle exit; the check reports them and prevents their recorded
envelope from worsening. It does not claim every case is collision-free.
The [frozen evidence and portable replay](evidence/local-pass-2026-10-17/connector-merges/README.md)
also correct an earlier false collision measurement that included a removed car.
In a 46-car Node CPU comparison, the paired median update cost increased by
0.01166 ms at the captured merge and 0.17182 ms in a packed synthetic stress case.
These are update-cost measurements, not FPS or live frame-pacing claims.

**Buses off their line.** `BusRun` (`src/buses.ts`) judges a street shorter than 25 m
together with the best street after it, and where no street out of a junction lies
along the line it looks for the shortest way by street (2.5 km at most) to a street
the line takes further on. On that way round the bus makes for no stop; back on the
line, the stops it passed are skipped.

## Offline checks

`scripts/offline-city.mjs` loads a built map in Node: tiles, the street graph, each
tile's parked cars placed as `TileWorld.make` places them (same seed, neighbours'
streets and buildings; the collision grid is rasterised without trees or street
furniture, so a few more cars stand than in the game). On it:

- `node scripts/check-street-flow.mjs [area] [--type taxi]`: a fixture (a bent narrow
  street between parked cars), then a car down every street of the area. Centrum, 2,131
  streets: 15 stalls for a taxi before the fix, none after for a taxi or a pickup. (Buses
  sent along their lines for 150 s, 84 runs: four stalled before, one after, an AE bus
  near Na Poříčí that hasn't been looked into.)
- `node scripts/check-bus-lines.mjs [area]`: fixtures, then every line followed through
  the street network. Centrum: 40 breaks inside the map before, 3 of 10 m after. The
  whole city (602 lines, 6,727 km, 90 % of it on the map's streets) still has 581 breaks
  longer than 30 m, the longest on the motorways out of town; they haven't been gone
  through, so for `praha` pass `--most` with the number to hold it to.
- `node scripts/check-parking-city.mjs [area]`: sweeps a pickup and a bus along every
  lane and junction curve and a fire engine down the middle of every street, and lists
  the parked cars they would touch. It reports; `--strict` makes it fail. Centrum on
  6 October: 6 of 20,349 cars in a pickup's way, 288 in a bus's, 21 in the middle of a
  street. Under heavy machine load these runs take minutes, not seconds.
- `node scripts/check-parking-overlap.mjs [area]`: counts the parked cars whose bodies touch
  each other, in a tile or across a tile's edge. It reports; `--strict` makes it fail.
  Centrum on 8 October: none of 21,731 cars (138 pairs before cars were checked against
  each other's bodies and kept inside their tile).

On 17 October, the current centre map had 21,731 parked cars: 311 in a lane or
turning sweep (310 bus, one pickup) and 20 on an emergency centreline. Reserving the
centreline reduced the total to 21,689, with no centreline overlaps; 291 lane/turn
overlaps remain (290 bus, one pickup). These are offline body sweeps, not a claim
that every emergency route drives without obstruction. Nine warmed tile-clearance
builds, alternated against the previous implementation twenty times each, changed
their medians by -0.32 to +1.49 ms on a busy machine; frame cost was not measured.

The remaining pickup finding was confirmed with the shipped models: actual
`Traffic.update` put a pickup's front collision circle 0.70–0.81 m into a parked
sedan at local `[1406.48, 1240.72]` on Pobřežní, at a sharp bend inside one road edge.
The interior-bend sweep now refuses parking at that position. The approximate city
sweep then has 21,591 parked cars versus 21,689 before (98 fewer, 0.45%), no pickup
or emergency-centreline findings, and 222 remaining bus findings. The reduction is
conservative; it does not prove that all 98 removed cars caused collisions. Index
segments/references grow about 10% versus the previous lane/junction index, only
during a parking pass. Thirty retained alternating build samples after ten warmups
on each of three real tile halos (`14_10`, `13_10`, `4_4`) measured median changes of
5.18→5.30 ms, 10.92→12.23 ms and 8.15→8.64 ms respectively. Tails were noisy,
including a 26.38 ms candidate
sample; this is a measured construction cost, not an FPS claim. Independent actual
pickup-body checks passed additional bend angles, tight S bends, time steps, crop,
duplicate points and separate levels. Broad bus clearance remains unchanged.

Open findings from the lane/turn sweeps:

- **Bus bodies at sharp bends inside a street.** The pickup envelope does not cover
  a bus's rear-axle placement at every internal kink. A bus (rear axle on the lane,
  body along the chord) cuts 1–2 m across the inside,
  into parked cars (Dřevná, Legerova and Seifertova, Melounová). The body sweep should
  run along the whole lane wherever it bends, for buses on the streets buses use.
- **Buses beside cars parked at the least distance.** A bus is 2.55 m wide, more than
  the 1.25 m kept each side of a lane's middle. Raising the figure to 1.45 m everywhere
  costs 3 % of centrum's parked cars (20,349 to 19,752); better only on bus streets.

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
