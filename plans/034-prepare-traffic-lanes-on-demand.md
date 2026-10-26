---
read_when: Optimizing Traffic.update lane lookahead or stationary-obstacle projection.
---

# Plan 034: Prepare traffic lane geometry on demand

## Status and intent

- Status: DONE (9fee5cf, 26 October 2026). Category: performance. Priority: P2.
- Effort: one day, including focused verification. Risk: medium: floating-point and obstacle ordering affect traffic decisions.
- Depends on: none. Reconcile shared-file edits with plans 032–036.
- Planned at: `546620e027330e2d2f08ebcbaf1f0e3c6c68e8be`, 25 October 2026.
- Confidence: high in the repeated-work finding; frame-time benefit unmeasured.

Every traffic agent currently obtains forward lane pieces each simulation step,
even when it has no eligible parked obstruction. The obstruction loop then repeats
each piece's length calculation for every obstacle circle. Prepare the pieces only
when needed, and reuse their geometry for the rest of that agent's step. Preserve
existing stopping, passing and merging decisions.

Before editing, run `git status --short` and:

```sh
git diff --stat 546620e027330e2d2f08ebcbaf1f0e3c6c68e8be..HEAD -- src/traffic.ts scripts/check-traffic-lanes.mjs docs/performance-log.md docs/traffic.md todo.md plans/034-prepare-traffic-lanes-on-demand.md plans/README.md
```

Compare changed source with the excerpts below, and inspect any uncommitted changes
in these paths. Reconcile intended earlier-plan changes; stop on an unexplained
behavioral mismatch instead of applying stale excerpts.

## Current state

`src/traffic.ts:300` eagerly calls:

```ts
const pieces = a.route.ahead(L / 2 + 3, reach + 4, lane);
```

Only the branch at 321 uses those pieces:

```ts
if (o.kind === 'car' && o.car?.mode !== 'traffic' && ov < 0.3) {
  if (pieces > 1) {
    for (let k = 0, last = (pieces - 1) * 5; k <= last; k += 5) {
      const ax = lane[k], ay = lane[k + 1], ux = lane[k + 2] - ax, uy = lane[k + 3] - ay, len = Math.hypot(ux, uy);
```

`Route.ahead` in `src/network.ts:350` reads current route legs and fills the reused
`lane` array with groups of five numbers: endpoints and route distance. It does not
advance a route or consume randomness. The array is shared sequentially across
agents, so its values cannot be cached across agents or frames without ownership.
The obstacle provider likewise reuses its result storage: never call it again
while iterating its previous result. Keep the existing collision candidate order.

Use the deterministic real-Car/DriveGraph fixtures and Node TypeScript loader from
`scripts/check-traffic-queues.mjs` and `check-traffic-merges.mjs`. The latter records
two known bus-turn overlaps; preserve its explicit baseline envelope, do not hide
or expand it and do not claim that every existing case is overlap-free.

## Scope

Only `src/traffic.ts`, proposed `scripts/check-traffic-lanes.mjs`,
`docs/performance-log.md`, `docs/traffic.md`, `todo.md`, this plan and the index.
`src/network.ts` and existing traffic regression scripts are read-only references.
No routing, obstacle geometry, merge rules, thresholds, RNG, worker, cadence,
population, or collision-index changes. Do not optimize other route methods here.

## Steps and verification

1. **Create deterministic before/after evidence.** The proposed Node script supports
   `--record /tmp/traffic-lanes-before.json` before edits and `--compare FILE` after.
   Use seeded real production agents, log their state each step (pose, velocity,
   speed, route legs/distance, offsets, timers, blocker/stop outcomes and RNG draws),
   and instrument `Route.ahead` call counts. Include no obstacles, moving traffic
   only, one/multiple parked cars with repeated circles, bent roads, junction
   connectors, endpoints, bridges and cars pulling off pavements. Run
   `node scripts/check-traffic-lanes.mjs --record /tmp/traffic-lanes-before.json`:
   exit 0 and retain a baseline from the unmodified code, stamped with its revision.

2. **Make preparation lazy.** Reset a local unprepared sentinel for each agent.
   Call `ahead` once, at the first stationary-obstacle branch after the existing
   self, height and distance rejection checks. Preserve argument values and all
   downstream branches. Zero pieces is a valid prepared result, not the sentinel.
   Do not perform a preliminary obstacle query. Run `npm run typecheck` and
   `node scripts/check-traffic-lanes.mjs --compare /tmp/traffic-lanes-before.json`:
   identical behavioral traces/RNG, zero `ahead` calls in ineligible-only fixtures,
   at most one call per agent step in eligible fixtures.

3. **Reuse segment geometry within that step.** When preparation occurs, fill
   reusable numeric scratch storage for `ax`, `ay`, `ux`, `uy`, length and starting
   distance. Compute lengths once per piece; retain original projection divisions,
   nearest-piece tie order and endpoint extension rules. Do not combine this with
   reciprocal multiplication, squared-distance changes or threshold rounding: each
   could change floating-point decisions. Reuse storage with a logical length;
   do not allocate one object per piece or retain values for another agent.
   Repeat the comparison command and typecheck: identical traces, and segment-length
   work scales with prepared pieces rather than pieces times obstacle circles.

4. **Run existing traffic regressions and a real route.** Run:

```sh
node scripts/check-traffic-queues.mjs
node scripts/check-traffic-merges.mjs
node scripts/scene.mjs run countryside-traffic countryside-taxi --url http://localhost:5191/
```

   All must exit 0 with the known overlap reporting unchanged. Add the short-segment,
   zero/one-piece, multi-agent scratch reuse and same-lane cases to the proposed
   fixture if missing. Compare output fields separately from diagnostic counters.

5. **Measure traffic cost.** Run the command below and reverse URLs. Record calls
   avoided, eligible obstacles, prepared pieces, Traffic.update CPU time, whole-frame
   times and long tasks. Also use the same sped-up tram/taxi ride on each revision,
   keeping simulated time and population equal. No speedup claim without matched
   timing. Run `npm run typecheck` and `git diff --check`: exit 0; update scoped docs.

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --extra '&date=10-20' --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu --json /tmp/plan-034.json
```

## Done criteria and limits

- Before/after deterministic traces and RNG use match; all focused regressions pass.
- Ineligible-only steps do zero lane builds, eligible steps do at most one, and
  segment lengths are not recomputed for each parked-car circle.
- Existing traffic behavior, candidate ordering and known overlap limits are preserved.

Stop at a trace mismatch or new overlap; do not widen tolerances to make it pass.
If lane preparation later gains side effects, reassess whether it may be skipped.
Scratch storage belongs to one synchronous agent update at a time. Worker migration
and longer-lived route caches are deferred.

## Working and measuring

Read `AGENTS.md` and `.agents/skills/performance/SKILL.md` before implementation;
use the scene-testing skill for gameplay checks. The game is viewed from above.
Preserve its appearance, population, collision rules and graphics settings.
Use npm and the existing Node check scripts; there is no general npm test, lint
or docs-list script. Do not add dependencies. Do not delegate unless requested.

Preserve unrelated working-tree changes. Obtain consent before changing branches;
do not push or deploy. Follow current commit instructions when implementation is
authorized. This document authorizes no implementation by itself.

For browser commands below, `http://localhost:5191/` means the candidate and
`http://localhost:5192/` its immediately preceding baseline. First verify port owners
with `lsof -nP -iTCP:5191 -sTCP:LISTEN` and the corresponding command for 5192.
Use stable snapshots, the same generated map data, and one rendering game at a time.
If starting persistent servers, use `npm run dev` (binds `0.0.0.0`), follow the repo's
PortPilot registration/annotation instructions, and provide the actual localhost,
LAN and Tailscale URLs. Do not stop pre-existing services. Snapshot cleanup must not
follow symlinks into shared map data or dependencies; follow the performance skill.

All commands in this plan are instructions for later implementation. They were
checked against source during planning, not executed as validation of a change.
New scripts are explicitly marked **proposed**; create them before running them.
Do not claim an FPS gain from reduced operation counts. Report paired mean and
p95/p99 frame times, long tasks, relevant work counts and any memory/loading tradeoff.
Reverse comparison order for small differences; use an unchanged-build control if
noise could explain the result. Reject shader errors, missing scenery or fallback
runs, but retain valid slow runs. Record an inconclusive timing result honestly.

## Closeout

Update this plan's Result and its row in `plans/README.md`, plus the scoped runtime
documentation. Record the exact implementation revision, commands, device, settings,
counts, timing results, visual/behavior checks and remaining limitations. Mark DONE
only after required checks pass; if a device is unavailable, record the missing
check and do not imply it passed. Stop and report a reproducible regression, a
material source mismatch, or a need to expand scope; do not compensate by lowering
visual quality or weakening tests.

## Result

Implemented 25 October 2026 (`a2bb0bd`, `9fee5cf` on main, after plan 033); the
hashes below are the subagent branch's.

- `f107ea6` adds `scripts/check-traffic-lanes.mjs` (12 real-Car/DriveGraph fixtures:
  empty lane, moving traffic, people and a tram, parked cars on straight and bent
  two-way streets, a junction connector, a street's end, a bridge over parked cars,
  a car leaving the pavement, tiny and repeated line points, a car parked in the
  lane, and a 4×3 grid of 14 spawned cars turning at random). The baseline was
  recorded from unmodified `e8c95bb`.
- `b8018e4` builds the lane at the first eligible standing car (`-1` sentinel);
  `f11bc9b` stores each piece's start, direction, length and distance along in a
  reused `pieceAt` array, read back for every circle.
- `--compare` matches the baseline traces exactly (pose, velocity, speed, route
  legs, offsets, timers, kerb state, braking and every random draw, each step) after
  both steps. A 1e-7 m change to `PASS` is caught at step 659 of "parked straight".
- `Route.ahead` calls: 6900 → 0 in the three fixtures with nothing parked in reach;
  0–54% fewer elsewhere (bridge 882 → 408, junction 4800 → 4717, endpoint
  2165 → 2074, same lane 4800 → 4756; never more than one per car step). Where a
  parked car is in reach on every step (grid, parked bends) the count is unchanged.
- Piece lengths: before, one `Math.hypot` per piece per eligible circle; after, one
  per built piece. `Math.hypot` calls inside `Traffic.update` fall 39–43% in the
  bent-lane fixtures (grid 13.95M → 7.94M, parked bends 2.95M → 1.73M, junction
  745k → 439k), so at least 6.0M of the grid's roughly 6.0–6.3M length evaluations
  go; one-piece lanes are unchanged.
- `npm run typecheck`, `check-traffic-queues.mjs`, `check-traffic-merges.mjs`
  (358 collision-free cases, the 2 known bus-turn overlaps; output byte-identical to
  `e8c95bb`) and `git diff --check` pass.
- `node scripts/scene.mjs run countryside-traffic countryside-taxi --extra '&countryside'`
  passes on the candidate (without `&countryside` both scenarios skip themselves).
- Timing on the M5 MacBook Air, headless Chrome, WebGPU, 1×, High, 14:00, clear,
  `--cpu 4`, 40 s, 3 runs in each order (6 pairs), `64963c0` against `9f870d0`, with
  `Traffic.update` wrapped: on the drive 1.32 → 1.14 ms a frame on average (lower in
  5 of 6 pairs), in the garden suburb 0.60 → 0.57 ms. Whole frames: −10 % in one
  order (one slow run) and −0.1 % in the other on the drive, +0.6 % and +2.1 % in the
  suburb: inside the noise, so no frame-rate gain is claimed.
