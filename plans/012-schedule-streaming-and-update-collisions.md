---
read_when: Implementing step 6 of the driving-stutter work, or changing tile-worker scheduling and resting-car collision indexes.
---

# Plan 012: Schedule streaming work and update parked-car collisions incrementally

This is step 6 of the driving-stutter work. It has two independently verifiable parts: prioritize necessary tile construction over repeated sky-lighting refreshes, then avoid rebuilding every parked-car collision entry after one tile or car changes. Implement and compare the parts separately so their effects remain attributable.

## Status and starting point

- Status: implementation and separate verification DONE locally. Merge decision on 1 October 2026: Part A accepted; Part B held off main after an observed 3.5% desktop regression. An isolated Part B retest is pending to check whether competing game instances or machine load affected that result.
- Priority: P2. Effort: several days. Risk: medium–high because jobs and collision entries have lifetimes that outlast individual frames.
- Category: performance. Dependencies: none technically; execute after 007–011 to isolate residual streaming hitches and reconcile their edits to `tiles.ts`/`main.ts`.
- Planned at: `5162c1fcf11e51df8ceda46049cac217fc7a12cd`, 2026-09-30.
- Confidence: high in redundant refresh/index work; worker contention is device-dependent.

Run `git status --short` and:

```sh
git diff --stat 5162c1fcf11e51df8ceda46049cac217fc7a12cd..HEAD -- src/tiles.ts src/tileWorkers.ts src/contracts.ts src/main.ts src/network.ts src/restingCars.ts scripts/check-streaming.mjs scripts/check-resting-cars.mjs scripts/bench-stalls.js
```

Reconcile expected changes from earlier steps rather than restoring the original code. Stop on unexplained changes to worker protocol, tile ownership or collision snapshots. Branch changes, commits, pushes and deployment require separate authorization.

## Current state

The game uses npm/Vite/strict TypeScript, three.js r186, and WebGPU by default. Read `.agents/skills/performance/SKILL.md`. Workers build geometry off the main thread, but still compete for CPU on a phone; main-thread CPU throttling alone cannot reproduce that contention. Existing phone results in `todo.md` found fewer workers reduced some stalls but slowed tile arrivals. No new result is assumed here.

### Worker and sky jobs

`TileWorkers` is currently inside `src/tiles.ts:69–109`. It creates up to three workers using reported hardware concurrency and immediately posts jobs round-robin:

```ts
const id = this.next++;
const worker = this.workers[id % this.workers.length];
this.jobs.set(id, { worker, resolve: (result) => resolve(result as WorkerResults[K]), reject });
worker.postMessage({ id, type, data }, transfer);
```

`TileWorld.update()` at 686–706 starts the nearest missing tile builds up to `workers.size`. That limits whole tile builds, not individual worker jobs. Each `make()` submits several geometry jobs, then an initial sky job whose result is needed before tile installation. `loadNow()` is a separate parallel startup/teleport path. `build()` deduplicates requests and transfers IPR buffers only once.

`src/contracts.ts:97–123` defines typed job/result messages. `src/tileWorker.ts` returns transferable arrays. Keep that typed protocol and failure handling; scheduling can stay in the main-thread wrapper.

On tile completion, `make()` refreshes neighbouring sky textures. The current refresh at `src/tiles.ts:939–949` debounces timers but not in-flight work:

```ts
if (entry.timer) clearTimeout(entry.timer);
entry.timer = setTimeout(async () => {
  entry.timer = null;
  const result = await this.workers.run('sky', { box: entry.tileBox, ground: entry.ground, shapes: this.shadowersFor(i, j, entry.shapes), meshes: [] }).catch(() => null);
  if (!result || this.sky.get(i * 65536 + j) !== entry || !entry.texture) return;
  (entry.texture.image.data as Uint8Array).set(result.texels);
  entry.texture.needsUpdate = true;
}, 400);
```

The object-identity guard prevents writing into a dropped/replaced tile, but does not prevent concurrent refreshes on the same still-live entry completing out of order. Initial sky calculation and optional neighbour refresh must have different scheduling priorities even though both have job type `sky`.

### Resting-car collision entries

`src/main.ts:183–188` invalidates the resting index when tile cars arrive or leave. `syncResting()` at 993–1009 scans loose cars, then rebuilds the entire index when any pose/membership changes:

```ts
if (!stale && n === restingCount) return;
resting.clear();
for (const c of loose) {
  c.resting = !moving(c);
  if (!c.resting) continue;
  pushCar(resting, c);
  c.restAt = [c.x, c.y, c.h];
}
```

The movement predicate is `mode === 'player' || vx*vx + vy*vy > 0.0025 || abs(w) > 0.01`. `pushCar()` creates one obstacle per circle and stores `x,y,z,r,vx,vy,kind,car`. Dynamic `hash` and `carHash` are rebuilt separately; `resting` is added to queries by `obstacles()`, `carsNear()` and `carsOnly()`. Query arrays are reused and must not be invalidated by a nested lookup.

`SpatialHash` in `src/network.ts:394–414` currently supports clear/add/near, not removal. `Trams.file()/unfile()` in `src/trams.ts:391–412` is the local exemplar for retaining entry identity and removing from a previous numeric bucket. Its swap-remove strategy can alter order; consider that explicitly for car collision resolution.

## Scope

In scope: `src/tiles.ts`; optionally extract the worker wrapper into new `src/tileWorkers.ts`; `src/contracts.ts` only if a small typed scheduler contract is needed; `src/main.ts`; `src/network.ts` for precise removal support; new `src/restingCars.ts` if it keeps collision ownership testable; new `scripts/check-streaming.mjs` and `scripts/check-resting-cars.mjs`; narrow counters in `scripts/bench-stalls.js`; `README.md`, `todo.md`, this plan and the index row.

Do not change worker geometry algorithms, sky resolution/formula, street graph retention, parked-car placement, collision shapes/thresholds, physics, shader pooling from earlier plans, or data/deployment formats. Offline sky baking, predictive route-based prefetch, adaptive quality UI, broader AI scheduling and moving parking into a worker are deferred. No new dependency is needed.

## Part A: Streaming scheduling

### A1. Queue jobs and dispatch to idle workers

Represent queued and running jobs separately; post at most one job to each idle worker. Prefer required tile jobs over optional neighbour-lighting refreshes, FIFO within an equal priority. Required jobs include the initial sky calculation awaited by `make()`. Keep nearest-tile selection in `TileWorld.update()` and preserve `loadNow()` and `build()` deduplication.

Retain transfer arrays until dispatch and transfer them exactly once. `postMessage` failure must reject the affected promise and release the worker slot. A worker error must settle its running job, retire the failed worker, and either safely replace it or reject pending work if no usable workers remain; no unresolved promises. Normal job errors free a slot and allow later work to proceed. Do not terminate workers carrying unrelated jobs to cancel one refresh.

Create `scripts/check-streaming.mjs` with `--url` and `--case queue|sky|all`, using browser-eval assertions as in `scripts/check-graphics.mjs`. Factor the queue so tests can inject fake worker endpoints and control completion order without real expensive geometry. Assert single assignment, priority, FIFO, transferred-buffer ownership, failure settlement and continued progress.

**Verify:** `npm run typecheck`, `node --check scripts/check-streaming.mjs`, and `node scripts/check-streaming.mjs --url http://localhost:5191/ --case queue` pass. Tests should deliberately complete workers in a different order from submission and simulate a failed post/message/worker.

### A2. Coalesce neighbour refreshes and reject stale results

Give each live sky entry a monotonically increasing requested revision, applied revision, running/queued state and at most one follow-up request. Multiple neighbour arrivals while a job runs should request one recalculation with the latest shapes, not enqueue one calculation per arrival. Construct the neighbour snapshot at dispatch rather than retaining a large obsolete snapshot in the queue.

Apply a result only if it still belongs to the same entry and the requested revision it represents is current. If superseded, discard it and dispatch the latest requested revision when allowed. On tile drop, cancel queued refresh/timer state; a running job may finish but cannot write into a disposed texture. Removing and reloading the same coordinate must not make an old entry's result valid again. Failed refreshes should not retry every frame; preserve a controlled retry opportunity without blocking required tiles.

Allow optional work to progress when there is capacity, including after driving stops. Avoid starvation by aging optional jobs at dispatch opportunities when required tiles are not at risk; do not start multiple optional jobs merely because several workers are idle. Keep the existing visual formula, texture identity and wall-versus-ground behaviour.

**Verify:** the new `--case sky` check passes for repeated arrivals during one running refresh, reversed completion attempts, drop/reload at the same key, refresh failure and eventual latest-result application. Assert at most one running refresh per entry and no upload from an obsolete revision.

### A3. Compare scheduling before changing worker-count policy

Add counters for queued/running required/optional jobs, coalesced/cancelled refreshes, required-tile completion time and whether the player's/ahead-of-car tile is missing. Keep the current worker-count default initially. Use the comparison command below, and repeat on a real phone if phone contention is the target.

For a controlled one-versus-three-worker experiment, the existing benchmark supports `--init "Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 3 })"`; the current constructor maps that to one worker. Do not promote a lower global default on the strength of core count alone. Change a device policy only if the comparison shows smoother frames without new road-loading gaps, and record the policy/trade-off for approval. Scheduling/coalescing can complete independently of that decision.

**Verify:** `node scripts/check-streaming.mjs --url http://localhost:5191/ --case all` and `npm run build` pass; a real drive and `teleportTo` finish loading, job counts drain when idle, and no required promise is stranded. Record Part A results before editing the collision index.

## Part B: Incremental resting-car collision updates

### B1. Add reversible per-car entries

Maintain a map from resting car to its obstacle objects and their previous bucket memberships. Add exact removal to `SpatialHash`, or keep this functionality local to a typed `RestingCars` index using the same numeric key and `near()` contract. Remove using the stored old bucket, before changing coordinates; searching only the new bucket leaves stale entries.

Retain the existing once-per-substep scan of `loose` initially. It is an inexpensive way to detect all state transitions without editing every car mutation site. During the scan, add new eligible cars, update only cars whose pose or relevant obstacle fields changed, and remove cars now moving or absent. A generation stamp plus a sweep of indexed cars handles removals from `loose`. Tile callbacks can mark arrivals/departures, but they must not be the only removal source: theft, traffic adoption, explosions, towing by collisions, arrests and distance cleanup also change membership.

Track ground height and stored velocity/radius/kind as well as x/y/heading so retained obstacles are not stale. Preserve obstacle object identity for unchanged cars and do not duplicate resting entries in `carHash`. Keep the `Car` fields used elsewhere (`resting`, `restAt`) consistent or remove them only after inspecting every caller.

Create `scripts/check-resting-cars.mjs`, following the browser runner pattern, with `--url` and `--case index|simulation|all`. Compare query results against a fresh full-rebuild oracle using stable car/circle identifiers. A test-only traversal or counter is preferable to new game UI.

**Verify:** `npm run typecheck`, `node --check scripts/check-resting-cars.mjs`, and `node scripts/check-resting-cars.mjs --url http://localhost:5191/ --case index` pass. Cover negative coordinates, crossing hash cells, heading/height changes, a bus with many circles, rest/move/rest, tile arrival/drop, absence from loose, and repeated no-op sync. No-op sync must reuse entries; a one-car change must not allocate all other cars' circles.

### B2. Preserve query and collision behaviour in the main loop

Replace the clear/rebuild branch of `syncResting()` with the incremental sync at the same point before traffic and pedestrian queries. Keep the dynamic hashes, `moving()` predicate, collision tolerances and callback ordering unchanged. Each returned car must still be deduplicated by `carsNear()`.

Collision order can affect a multi-car pile-up. Preserve `SpatialHash.near()`'s cell traversal order and the existing dynamic-results-before-resting-results order. Within each resting bucket, entries must follow loose-car traversal order and each car's circle order, including after a moved car is reinserted. Sorting the entire combined query by car ID would change the reference order. Test the actual chosen approach rather than assuming unordered set equality proves physics equivalence. Do not sort every entry in the whole city each frame; order maintenance belongs to changed buckets or the small returned bucket lists.

In scripted simulation tests, compare reference/new collisions for a car approaching parked cars, a tram pushing a car, a car adopted onto the pavement, player entry/exit, a car knocked into motion, and removal of a tile. Also test two nearby vehicles on different heights. After each transition, compare the index query multiset and ordered candidates to the full-rebuild oracle; verify there are no ghost obstacles or vehicles that have become passable.

**Verify:** the new `--case simulation` and then `--case all` commands pass. Instrumented one-tile arrival updates only its cars plus genuinely changed existing cars; no normal-play `resting.clear()` rebuild remains. Run `npm run typecheck` after integration.

### B3. Compare and document both parts separately

Use stable candidate/baseline servers and the same generated map files. For Part A compare against the start of this plan; for Part B compare against completed Part A. This prevents a worker gain from masking a collision regression.

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu
```

For a real connected phone, use the same command with `--android SERIAL` and `--cpu 1` in place of `--cpu 4`. Record serial/model/browser, temperature and completion state. Benchmark one process at a time and alternate candidate/baseline. Report p95/p99, long tasks, tile arrival/gap counters, refresh counts and changed-car versus total-indexed-car counts. Do not count hidden/missing scenery or altered collision behaviour as an improvement.

**Verify:** both new regression scripts, `npm run build` and `git diff --check` pass. Record Part A and Part B independently in this plan, update `todo.md` and `README.md`, and mark the index DONE only when both required parts are verified. A worker-default decision can remain explicitly deferred; required scheduling and collision correctness cannot.

## Execution environment

Existing npm gates are `typecheck` and `build`; there is no generic npm test/lint script. Use Chrome and the benchmark's existing Playwright lookup/`PLAYWRIGHT_PATH`, without adding a test framework. New runner commands above are to be implemented, not commands that already exist.

During authorized execution, verify port ownership before starting `npm run dev` and `PORT=5192 npm run dev` in the candidate and stable baseline checkouts. Follow the user's PortPilot and access-URL requirements. Keep `public/data` read-only, do not change a checkout during a timed run, and stop only processes owned by this work. CPU-throttled desktop results establish main-thread costs, not phone worker contention.

## Done criteria and stop conditions

- [x] Worker tests prove priority, one-job-per-worker dispatch, single transfer, error settlement and continued progress.
- [x] Sky tests prove coalescing, revision checks, drop/reload safety and eventual refresh when work settles.
- [x] Loading/startup/teleport paths remain usable; required-tile latency and road gaps are reported with frame timing.
- [x] Resting-car tests match the full-rebuild oracle across movement, membership, height and multi-collision cases.
- [x] Unchanged cars retain obstacle entries; one changed tile/car does not trigger a full resting-index rebuild.
- [x] Both parts pass focused checks, typecheck/build, scope review and documentation; comparisons are separate.

Stop if queued buffers are detached before dispatch, cancellation leaves a hanging promise, stale jobs touch disposed textures, collision order cannot be preserved, or ghost obstacles appear. Do not compensate by increasing streaming distance, reducing population, weakening collisions, or changing sky quality. If lower concurrency causes new visible road gaps, keep the existing worker-count default and report the result.

Maintain worker job priority separately from job type. Future optional bakes must declare their scheduling class and disposal rule. Future parked-car state fields must be included in the dirty comparison whenever they affect obstacle data; reference-oracle tests should accompany those changes.

## Result

Part A (`ac90ca1`) queues required jobs ahead of optional neighbour lighting,
dispatches one job per worker, retains transfers until dispatch, settles failures,
and coalesces refreshes with revision checks. The worker-count default remains
unchanged. `check-streaming --case all` passes reverse completion, transfer,
cancellation, worker failure, stale result, drop/reload and retry cases. A real
teleport completed with the destination tile loaded and both queues drained: 74
required and 14 optional jobs completed, with no worker failures.

Part B (`35b141a`, `2e91f54`, `1bb1585`, `3d60b16`) retains unchanged obstacle
objects, removes changed entries from their old numeric buckets, and restores
loose-car/circle order only in affected buckets. The fast scan keeps `Car.restAt`
numeric and compares height, radius, velocity and constructor-owned circle-offset
array identity separately. Existing code never mutates offset elements after
construction; future shape changes must replace that array or add an explicit dirty
signal. `check-resting-cars --case all` matches a full-rebuild
ordered oracle across pose, height, bus circles, rest/move/rest, tile changes and
membership loss; its live-game transitions pass. No normal-play `resting.clear()`
remains. In the final desktop drives, about 1,500 cars changed across roughly
5.2 million indexed-car scans per 40-second run; on the phone, 756–765 changed
across 0.84–0.85 million scans. The original incremental version measured 5.1%
slower than Part A on desktop; the final fast-scan version narrowed that to 3.5%
slower. This is a measured steady-driving cost, not a speedup claim.

The table reports three alternating 40-second WebGPU drives per comparison at
14:00, clear weather, High graphics. Desktop used DPR 1 and CPU throttle 4;
Pixel 5 used its own display with CPU throttle 1. Values are means across runs.

| Comparison | Mean frame ms | p95 / p99 frame ms | Long tasks | Loading s | Missing player / ahead tile frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| Part A desktop: base → queue | 10.18 → 10.04 | 12.60 / 27.40 → 12.37 / 27.03 | 6 → 6 | 13.44 → 13.40 | 0 / 0 on both |
| Part A Pixel 5: base → queue | 55.83 → 56.29 | 137.17 / 196.60 → 133.77 / 189.67 | 207 → 208 | 25.43 → 24.19 | 0 / 0 on both |
| Part B desktop: queue → index | 10.10 → 10.46 | 12.57 / 27.47 → 13.00 / 27.93 | 5 → 8 | 14.43 → 13.76 | 0 / 0 on both |
| Part B Pixel 5: queue → index | 56.46 → 56.79 | 126.47 / 190.00 → 130.13 / 189.10 | 283 → 233 | 25.46 → 24.97 | 0 / 0 on both |

All 24 full runs used WebGPU, reported no page errors and built three tiles during
each Pixel 5 drive. Part A's candidate completed 92 required and 28 optional jobs
per desktop drive, coalescing 41 refresh requests; on the phone it completed 77
required and 23–24 optional jobs, coalescing 36–37. Its required-tile build p95 was
1.25–1.30 seconds on desktop and 5.28–5.99 seconds on the phone. Both queues drained
at the end of every candidate drive. The phone runs used serial `09081FDD4001DA`,
Pixel 5, Android 14, Chrome 154.0.8037.57. Battery readings rose from 27.4 to
31.5 °C in Part A and 31.8 to 33.6 °C in Part B; later candidates were warmer.
The phone long-task reduction in Part B is dominated by one 151-task baseline run.
The small Part A timing difference and Part B phone difference are inconclusive;
the Part B desktop steady-frame regression is consistent across three pairs.
No worker-count policy change follows from these results.

The first phone connection failed before loading because Chrome's DevTools socket
was not ready. A subsequent attempt was excluded: Chrome was dozing behind the
notification shade and recorded zero frames. After waking it, a short smoke test
and both full comparisons recorded frames. The temporary AC keep-awake setting
was restored to its original value of zero, and ADB port mappings were removed.
One `scene.mjs run all` pass had a transient wall-crash zero-damage assertion;
the isolated scenario and the next full pass succeeded. Both browser check scripts,
`npm run build` (including
typecheck), `node --check` for both scripts, and `git diff --check` pass. Matched
WebGPU screenshots show the same streets, buildings, parked cars and sky shading.

Evidence: `/private/tmp/streets-012-part-a-compare.{json,log}`,
`/private/tmp/streets-012-part-b-numeric-compare.{json,log}`,
`/private/tmp/streets-012-phone-part-a.{json,log}`,
`/private/tmp/streets-012-phone-part-b.{json,log}`, and matched
`/private/tmp/streets-012-{a,b}-drive.png` screenshots. Fixed snapshots at
`/private/tmp/streets-012-base` (`a3032fb`), `streets-012-part-a` (`ac90ca1`)
and `streets-012-part-b-numeric` (`3d60b16`) read the same untouched shared map
data. Their test servers are stopped. No generated assets were changed or deployed.

## Merge decision, 1 October 2026

Part A is selected for main with the original worker-count default. Part B remains
only in the experiment worktree `~/.codex/worktrees/811c/streets-of-prague`
and the separately launched plan-013 integration worktree. Its correctness tests
passed, but a consistent desktop regression is insufficient reason to replace the
existing collision implementation. Main keeps `syncResting()` and its existing
full-rebuild-on-change behavior; it does not contain `src/restingCars.ts` or the
experimental `check-resting-cars.mjs`. References to that runner and the Part B
Result above describe the completed experiment, not main.

See [the findings and merge summary](../docs/optimisation-findings-007-012.md).

## Follow-up: retest Part B in isolation

Requested on 1 October 2026. A first attempt on 6 October was inconclusive (see the end of this file). The recorded desktop change from 10.10
to 10.46 ms was consistent across three pairs, but the difference is small enough
to warrant confirmation under controlled load. Overlapping game/browser instances
and other machine activity could affect timings; their contribution to this
particular comparison has not been established. Preserve the original results
above and keep Part B off main pending the retest.

- [ ] Arrange a quiet test session with only one actively rendering game instance
  at a time, including headless Chrome and in-app browser views. Coordinate before
  closing user-owned or shared sessions. Record CPU/GPU load and relevant thermal
  state; multiple idle dev servers are not equivalent to multiple rendering games.
- [ ] First compare the same unchanged build against itself through the alternating
  harness. If that control varies by an amount comparable to 3.5%, resolve the
  measurement noise before drawing a conclusion about Part B.
- [ ] Compare matched stable snapshots with Part A in both and only the incremental
  collision-index change in the candidate. The original `ac90ca1` and `3d60b16`
  revisions above are the starting references; verify their diff before use. Do not
  mix in plan 013 or other graphics changes. Use the same generated data and the
  original 40-second drive, WebGPU, High, clear 14:00, DPR 1 and CPU throttle 4.
- [ ] Run at least three alternating pairs serially and reverse the starting order
  in a second series. Confirm the previous browser has exited before starting the
  next. Record per-run mean, p95/p99, long tasks, index-work counters and road gaps,
  rather than relying only on pooled averages. If retesting on a phone, track its
  temperature separately; desktop isolation does not establish phone performance.
- [ ] Append the new evidence and update the merge decision and findings summary.
  A repeated regression under stable conditions supports keeping the current
  implementation. If the result becomes neutral or inconclusive, do not call it a
  speedup; reconsider integration only with a demonstrated net benefit and the
  existing collision-correctness checks still passing.

## Retest of Part B, 6 October 2026: inconclusive, left off

Part B was ported onto main (`src/restingCars.ts`, `scripts/check-resting-cars.mjs`)
behind a switch that is off by default: `?resting=incremental`, or
`__drive.restingIndex(true | false)` in the page, which lets `bench.mjs --ab` compare
the two indexes in one page (each starts again from nothing at a switch, so every
window opens with one full indexing on either side).

The machine was not quiet: about ten sessions were working and the load average was
over 100. One pair of runs was made before time ran out, the drive, High, 14:00,
clear, DPR 1, CPU throttle 4, 48 s in alternating 4-second windows:

| Run | Off | On | Windows off (fps) | Windows on (fps) |
| --- | ---: | ---: | --- | --- |
| existing index against incremental | 34.9 ms | 38.2 ms (9.5% slower) | 32 32 30 30 25 25 | 31 27 29 24 26 22 |
| existing against existing (control) | 32.2 ms | 34.7 ms (7.9% slower) | 28 33 26 34 33 34 | 30 28 32 29 33 23 |

The unchanged control differed by nearly as much as the comparison, so this says
nothing either way; it certainly does not show the incremental index to be quicker.
It stays off. The checklist above is still owed on a quiet machine: the control
first, three pairs, then the order reversed. `check-resting-cars.mjs` was not rerun
against the port (the browser queue was too long); run it before turning the
switch on anywhere.
