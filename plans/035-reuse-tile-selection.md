---
read_when: Optimizing TileWorld.update selections, retention or streaming scheduler reuse.
---

# Plan 035: Reuse tile selections without delaying streaming

## Status and intent

- Status: DONE (819c3d6, 26 October 2026). Category: performance. Priority: P2.
- Effort: one to two days, including focused verification. Risk: medium: stale selections must not stall arrivals or retirement.
- Depends on: none. Reconcile shared-file edits with plans 032–036.
- Planned at: `546620e027330e2d2f08ebcbaf1f0e3c6c68e8be`, 25 October 2026.
- Confidence: high in the repeated-work finding; frame-time benefit unmeasured.

TileWorld.update normally computes four sorted spatial lists each frame: wanted,
shown, retained and retained-with-meshes. Repeated exact camera inputs need not
repeat that geometry work, and retention sets need no distance ordering. Separate
spatial selection from the live scheduler; this plan does not throttle streaming.

Before editing, run `git status --short` and:

```sh
git diff --stat 546620e027330e2d2f08ebcbaf1f0e3c6c68e8be..HEAD -- src/tiles.ts scripts/check-tile-selection.mjs scripts/check-tile-lifecycle.mjs docs/performance-log.md README.md todo.md plans/035-reuse-tile-selection.md plans/README.md
```

Compare changed source with the excerpts below, and inspect any uncommitted changes
in these paths. Reconcile intended earlier-plan changes; stop on an unexplained
behavioral mismatch instead of applying stale excerpts.

## Current state

`src/main.ts:2072` calls `world.update` every frame. In `src/tiles.ts:923`:

```ts
const want = this.around(x, y, r).filter((k) => !((this.retry.get(k) ?? 0) > now));
for (const k of want.slice(0, 12)) this.fetchTile(k);
const show = this.reach(x, y, r, drawn);
this.shown = new Set(show);
```

Later it builds `new Set(this.around(x, y, r + this.T * 0.5))`, and when
`drawn < r`, `new Set(this.near(x, y, drawn + DRAWN_KEEP))`.
`around` (760) sorts tile-centre distance adjusted by `T * 0.71`; `near` (824)
sorts exact distance to a tile rectangle. Their membership tests differ; do not
replace one with the other. `reach` (853) chooses which query supplies draw order.
The first 12 wanted tiles are prefetched; drawing is admitted before further builds.
Retries and `drawAfter` depend on wall time. Completions free worker capacity while
the camera stays still. `forget` runs on a one-second timer and considers anchors.
Photos, pending fetches and the JSON halo have separate retirement rules.

Match the existing local caches (`jsonRange` in `TileWorld.update`) and CPU fixtures
in `scripts/check-tile-lifecycle.mjs`. Retain instance-owned scheduling in `dressing`
and `builds`; an old completion must never remove its replacement's work.

## Scope

Only `src/tiles.ts`, proposed `scripts/check-tile-selection.mjs`, necessary fixture
updates in `scripts/check-tile-lifecycle.mjs`, `docs/performance-log.md`, `README.md`,
`todo.md`, this plan and the index. Do not change tile distances, worker count or
priority, terrain/parking data, graphs, fetch contracts, retry duration, shader work
or `src/tileWorkers.ts`. Existing lifecycle assertions must not be weakened.

## Steps and verification

1. **Characterize selection and scheduling.** Create the proposed offline check
   with real TileWorld selection/update methods, fake workers/files and controlled
   time, following `check-tile-lifecycle.mjs`. Keep original selection functions as
   test-only oracles. Cover random and edge-of-tile camera positions, zoom, teleports,
   finite and infinite drawn radius, sparse coverage, and countryside availability.
   Compare ordered want/show lists; compare keep sets by membership. Record dispatch,
   drop and undress event order. `node scripts/check-tile-selection.mjs --baseline`
   must exit 0 on the old code, report spatial-query counts and prove fixtures can
   drain work while the camera stays stationary.

2. **Avoid sorting retention-only queries.** Add a local optional ordering control
   or equivalent small helper in `tiles.ts`, retaining default sorted behavior for
   all existing callers. Use unordered results only where consumed as membership
   sets. Keep enumeration/tie order for scheduling exactly as before. Run
   `npm run typecheck` and the proposed baseline check: all ordered outputs,
   membership sets and lifecycle events must still match their original oracles.

3. **Cache spatial outputs with exact validity.** Keep only the latest selection,
   keyed by exact `x`, `y`, `r`, `drawn`, tile size/origin and availability state.
   Audit mutations to `available` and countryside coverage before choosing a
   revision or immutable-identity contract; do not assume a Set identity means its
   contents are unchanged. Reuse raw spatial candidates and show/keep membership.
   Reapply retry-time filtering, fetch/admission checks, `drawAfter`, retirement and
   timed graph forgetting on every update. Do not early-return from the whole
   update. If availability cannot be tracked safely, bypass reuse for that mode.
   `node scripts/check-tile-selection.mjs` must exit 0: after priming, 60 identical
   inputs with unchanged coverage perform zero spatial recomputations, while
   scheduled work and retry deadlines continue to progress.

4. **Prove lifecycle and mutation behavior.** Add fixtures for worker completion
   without camera motion, failed fetch cooldown expiry, dress cooldown expiry,
   stale completion after a replacement, new/removed available tiles at a fixed
   camera, changed countryside coverage, moving graph anchors, pending photos and
   repeated return visits. Move by tiny amounts within the same tile and check
   exact membership/order: no tile-centre quantization or movement threshold is
   allowed in this first implementation. Run:

```sh
node scripts/check-tile-selection.mjs
node scripts/check-tile-lifecycle.mjs
node scripts/check-tile-fetch.mjs
node scripts/check-streaming.mjs --url http://localhost:5191/ --case all
```

   All must exit 0 with no stranded builds, skipped retries or premature disposal.

5. **Measure standing and movement separately.** Run the comparison below and
   reverse URLs. Track selection CPU time, sorts, allocation/GC evidence, required
   tile arrival latency and missing player/ahead tiles as well as frame times.
   Exact caching may rarely hit while the smoothed camera moves; say so. Verify
   zoom-out and a real countryside transition in the browser. Run
   `npm run typecheck` and `git diff --check`: exit 0; update scoped docs.

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes stand,drive,suburb --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --extra '&date=10-20' --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu --json /tmp/plan-035.json
```

## Done criteria and limits

- Original ordered selection and retention-membership oracles match across fixtures.
- Stationary frames reuse spatial work; scheduler/retries/retirement remain live.
- Existing lifecycle/streaming checks pass; measured required-tile arrival does not
  regress or introduce player/ahead-tile gaps.
- Cache memory holds only the latest spatial state, not every view ever visited.

Stop if exact reuse has no worthwhile hit rate and bookkeeping slows the drive.
Retain only a demonstrated useful subset, or report the result as rejected. Do not
add movement thresholds, larger prefetch radii or scheduling delays to manufacture
hits. Future availability changes must invalidate spatial caches explicitly.

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

Implemented 25 October 2026 (on main as `727163f`, `b7e0480`, `819c3d6`, after plan
034; the hashes below are the subagent branch's).

- `d8ba1ef` adds `scripts/check-tile-selection.mjs`: every fixture runs through
  test-only copies of the original `around`/`near`/`reach`/`update` and through the
  real methods side by side, comparing every event and the scheduling state after
  each frame. `aec6a5e` adds drive moves that change `drawn`, `r` or `y` alone.
- `8acd715` (step 2): `around`/`near` take `sorted = true`; the four membership-only
  queries (kept loaded, kept drawn, forget's camera and anchors) pass `false`.
- `aec6a5e` (step 3): `TileWorld.picks` keeps the latest selection keyed by exact
  `x`, `y`, `r`, `drawn`, `T`, origin, `available` identity plus `availableRevision`,
  and the countryside's identity plus the contents of its box. Retry filtering,
  prefetch, dispatch, `drawAfter`, retirement and forgetting still run every frame.
- Availability: `available` is never changed after the constructor in `src/`
  (anything that does must bump `availableRevision`); countryside coverage changes
  only when `CountrysideTiles.box` is set on opening or cleared on failure.
- Offline counts (old → new): 60 identical views 240 → 0 spatial queries; the
  fixture's random drive 3232 sorted → 1142 sorted + 1142 unsorted; return visits
  160 → 80. Typecheck, the selection, lifecycle and fetch checks and the whitespace
  check pass.
- Expected hit rate: none while moving, since the smoothed camera's x/y change every
  frame. Standing still, the script's model of `main.ts`'s smoothing first repeats
  the exact view about 6 s after a walk stops and about 33 s after stopping a car at
  12 m/s (the height eases slowly); the settings pause (dt = 0) repeats at once.
  The browser timings below show it is worth keeping.
- Browser, on the candidate: `check-streaming.mjs --case all` passes;
  `countryside-traffic` and `countryside-taxi` (with `&countryside`) pass; zooming out
  to 3× drew all 10 tiles in view after 8 s, with nothing missing, and zooming back
  left 6 in view and 8 drawn (within `DRAWN_KEEP`).
- Timing on the M5 MacBook Air, headless Chrome, WebGPU, 1×, High, 14:00, clear,
  `--cpu 4`, `--stalls`, 40 s, 3 runs in each order, `9f870d0` against `5d7ad7a`, with
  `TileWorld.update` wrapped. A frame, old → new (6 pairs each):
  standing on the Old Town Square 0.070 → 0.022 ms, in the garden suburb
  0.052 → 0.020 ms, on the drive 0.100 → 0.088 ms (the cache can't hit while moving;
  that's the unsorted retention queries). On the drive, 6 tiles were built and 6 drawn
  in every run of both builds but one baseline run (4 built), and long tasks ranged
  1–6 a run on both. Whole frames: within ±3.4 % with the sign following the order,
  so no frame-rate gain is claimed.
