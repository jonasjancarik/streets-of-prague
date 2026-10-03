# Ambulance crew movement

read_when: changing ambulance treatment, stretcher carrying or the crew's walk back to their vehicle.

The crew normally walks with the same short obstacle-avoidance steering as other people.
If a medic gets no nearer to their destination for 2.5 seconds, and it is within 25 metres,
they try a local route around the obstruction. The search uses one-metre steps, extends
10 metres around the medic and destination, and stops after 1,600 queue entries. An
unsuccessful search is retried at most once every two seconds per medic.

The medic follows the resulting waypoints until reached. Each segment is checked for
walls and vehicle clearance; a newly blocked segment discards the route. A change of
destination resets the route and progress tracking. This also applies while carrying a
stretcher and returning to the ambulance. Vehicle clearance includes their own
ambulance. On return, a clear point within boarding distance is the destination;
the occupied vehicle centre does not have to be reached. Treatment distance and duration, vehicle
routing, and the existing loading and return timeouts are unchanged.

## Regression check

Run `node scripts/check-ambulance.mjs` with Node 26. It executes `Ambulances.update`,
real walking animation, treatment and return logic. The test replaces only Vite's
`import.meta.env` macro, supplies render-only figure stubs and holds the ambulance
stationary during treatment. Vehicle clearance uses `Car.circles`; the test applies the
same stationary capsule push as `main.ts` after each service update.

The parked-car fixture was captured from the warmed native `ambulance` scene at Újezd,
using the centrum map built `2026-10-02T20:16:12Z` by pipeline `934283de3e`. Warming means
creating and immediately removing 20 hatchbacks before the scenario, advancing the
seeded random state without taking a simulation step. Before the fix, both medics
oscillated behind a row of parked cars, about 7.4 metres from the patient: treatment
remained zero after 150 seconds. The captured local positions and cars reproduce zero
treatment after 90 seconds in the update test without needing the map or browser.

The check covers treatment and return around this row, an unobstructed approach, an
unreachable patient, invalidation by a new obstruction, stretcher loading without the loading timeout, and boarding when approaching
the end of the ambulance. Use the native scene as well when changing this movement; the
local fixture deliberately isolates the walking stall from dispatch and driving.

## Native replay result

Implementation `9b5663073f064664a71e3184a3adbc97f7d60f7a` passed the first-patient
warmed replay in headless Chrome on 3 October 2026. The browser was reloaded before
warming, as in the captured failing replay. Both runs used the baseline map above,
10-03, Wednesday 14:00, clear weather, high graphics and a 1280×800 viewport.

The candidate patient was treated (`hurt: false`, `treated: 9`), the crew returned
in 9.15 seconds after treatment without the 20-second dismissal, and the ambulance
presence cleared (`t.rescue(p).ambulance === null`). Page errors were empty. Four
local route searches returned 18, 22, 14 and 15 waypoints; measured search times were
0.4–0.7 ms on this Mac. These are observations from this case, not a frame-rate
benchmark or a guarantee for the largest allowed search.

[Native result](evidence/ambulance-crew-2026-10-03/after-native.json),
[departure screenshot](evidence/ambulance-crew-2026-10-03/shots/after-departing.png)
and [cleared scene](evidence/ambulance-crew-2026-10-03/shots/after-cleared.png)
accompany the [original stall](evidence/ambulance-crew-2026-10-03/before-native.json)
and [stall screenshot](evidence/ambulance-crew-2026-10-03/shots/before-stalled.png).
The trace's waypoint arrays retained mutable references during this run; use the
immutable `routeCosts.points` counts for initial route lengths. The saved replay
script now copies those arrays for future runs; its gameplay operations are unchanged.
[Replay code](evidence/ambulance-crew-2026-10-03/native-replay.txt) is an `eval` body
for `scripts/scene.mjs`, to run after a fresh reload.

A separate launch-state attempt stayed in the driving phase, 243 m away, without
getting its crew out. That [arrival result](evidence/ambulance-crew-2026-10-03/after-initial-arrival.json)
is retained as evidence of the existing dispatch/driving variability. The successful
fresh-reload replay and exact captured update fixture establish the crew movement
fix; they do not establish recovery of every ambulance call. No full ambulance,
taxi/tow or frame-rate suite was repeated. The native departure check asserts
absence through the rescue API; it does not assert vehicle damage.

The browser was closed and the owned GPU lock released. The private map used for
this replay was moved aside, and the worktree's current surface map restored
(`2026-10-02T22:02:01Z`, pipeline `5efe19e9c5-dirty`). No shared data, main merge,
push or deployment was performed.
