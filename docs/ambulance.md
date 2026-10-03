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
