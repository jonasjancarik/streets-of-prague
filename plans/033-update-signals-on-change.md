---
read_when: Optimizing traffic-light updates, instance uploads or signal display invalidation.
---

# Plan 033: Update traffic-light buffers when their display changes

## Status and intent

- Status: DONE (53a50d8, 26 October 2026). Category: performance. Priority: P2.
- Effort: several hours to one day, including focused verification. Risk: low: phase, visibility and brightness changes need explicit handling.
- Depends on: none. Reconcile shared-file edits with plans 032–036.
- Planned at: `546620e027330e2d2f08ebcbaf1f0e3c6c68e8be`, 25 October 2026.
- Confidence: high in the repeated-work finding; frame-time benefit unmeasured.

Traffic lights rebuild glow matrices and lamp colours between phase changes.
An offline probe of production `Signals.update`, with one road head and one crossing
head, fixed time/camera/brightness and 60 frames, found five identical arrays whose
attribute versions each advanced 60 times. This proves redundant dirty marking,
not GPU transfers or an FPS gain. Make unchanged visual states leave buffers alone.

Before editing, run `git status --short` and:

```sh
git diff --stat 546620e027330e2d2f08ebcbaf1f0e3c6c68e8be..HEAD -- src/signals.ts scripts/check-signal-updates.mjs docs/performance-log.md README.md todo.md plans/033-update-signals-on-change.md plans/README.md
```

Compare changed source with the excerpts below, and inspect any uncommitted changes
in these paths. Reconcile intended earlier-plan changes; stop on an unexplained
behavioral mismatch instead of applying stale excerpts.

## Current state

`src/signals.ts:238` caches the nearby roster for up to three seconds, with padded
camera coverage. `gather` rewrites static matrices and packs road heads before
pedestrian heads. `add` and `forget` invalidate that roster; retirement already works.
`update` at 284 runs every frame from `src/main.ts:2244`:

```ts
const show = light(h.sig, t);
const on = [show === RED || show === READY, show === AMBER || show === READY, show === GREEN];
for (let k = 0; k < 3; k++) this.lamps.setColorAt(i * 3 + k, on[k] ? COLOURS[2 - k] : OFF[2 - k]);
```

The same method rebuilds glow matrices and colours, and beam colour uses
`0.22 + 0.3 * LAMP_ON.value`. It ends with `sendInstances(this.glows)` and `send`
for beam, road-lamp and pedestrian-lamp colours. `src/gpu.ts:7` clears update ranges
and increments the attribute version. Match the small local buffers and explicit
state already used here. `Figures.wear` in `src/figures.ts:261` is an exemplar for
skipping a write when its logical slot state is unchanged, not a helper to modify.

## Scope

Only `src/signals.ts`, proposed `scripts/check-signal-updates.mjs`,
`docs/performance-log.md`, `README.md`, `todo.md`, this plan and the index.
Do not modify `light`, `ahead`, traffic stopping rules, lamp-map rendering, global
upload helpers, shaders, phase durations, population or the signal placement data.

## Steps and verification

1. **Capture display equivalence.** Create the proposed offline script using
   `scripts/check-lamp-forget.mjs`'s TypeScript loader and production-class fixtures,
   with real Three.js attributes and fake signal JSON. Support `--baseline` to check
   original outputs and report dirty-mark counts. Keep a test-only original display
   writer as the oracle. Run `node scripts/check-signal-updates.mjs --baseline`:
   exit 0, unchanged arrays across 60 frames, version deltas of 60 on each of the
   five populated dynamic attributes in the two-head fixture.

2. **Cache displayed states.** Track each slot's displayed phase (or crossing go/stop)
   and invalidate all relevant slots whenever `gather` repacks or rebuilds matrices.
   Update glow position/colour and lamp colours only when their displayed state
   changes. Track beam brightness separately: a change in `LAMP_ON` must still
   update beams even if the phase is unchanged. Counts and visibility must update
   even when no attribute needs writing. Initially inspect phases each frame; do
   not introduce timers that can miss clock jumps or accelerated rides.
   Run `npm run typecheck` and `node scripts/check-signal-updates.mjs`: both exit 0;
   the primed unchanged fixture now has zero version increments and identical data.

3. **Send only dirty data safely.** Keep range tracking local to Signals. Merge dirty
   ranges rather than clearing writes still waiting for a renderer submission.
   A full live-prefix upload on roster rebuild is fine; phase-only changes should
   mark the affected contiguous span(s). Include two updates before one simulated
   submission, especially changes in different slots: neither may disappear from
   the pending ranges. Avoid a broad refactor of `gpu.send`. Run the proposed check:
   it must compare all live output elements against the original oracle and prove
   that dirty ranges cover every changed element after deferred submission.

4. **Cover transitions and actual rendering.** Test RED, AMBER, GREEN and READY,
   crossing lights, exact phase edges, backwards/forwards clock jumps, accelerated
   time, changing night brightness, empty rosters, add/forget, same-sized reorders,
   three-second regather, camera/zoom changes and the MAX_HEADS cap. Add `--url URL`
   browser mode to the proposed script, following `check-car-pool.mjs` and the game
   lock, to compare fixed phase/brightness output on WebGPU and legacy WebGL via
   `?renderer=webgl`. Run `node scripts/check-signal-updates.mjs --url http://localhost:5191/`:
   both backends must show the same heads, lit colours and glows without console errors.

5. **Measure an intersection and the normal drive.** Run the comparison below and
   reverse URL order. Also run at `--time 22:00`, since beam brightness and night
   rendering matter. Record live head counts, attribute bytes/versions, CPU time
   and frame distributions; the five-buffer fixture is not a city-wide savings
   estimate. `npm run typecheck` and `git diff --check` must pass; update scoped docs.

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes stand,drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --extra '&date=10-20' --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu --json /tmp/plan-033-day.json
```

## Done criteria and limits

- Baseline and optimized checks pass; fixed unchanged states dirty no dynamic
  attributes, and transition outputs match the original arrays.
- Consecutive pre-render updates retain all pending writes; empty/repopulated
  rosters and both renderers remain correct.
- Report measured whole-frame results even if only upload/work savings resolve.

Stop if a phase change requires different light logic or if range handling depends
on an unverified renderer assumption. Do not throttle phase checks or lower signal
visibility to improve counts. Future visual inputs must join display invalidation;
traffic's `ahead` logic remains independent of this render cache.

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

Implemented in `53a50d8` (on main after plan 032, `36b50fc`), 25–26 October 2026.
Offline checks:

- `scripts/check-signal-updates.mjs --baseline` against the unmodified code
  (`7da5a84`): passes; the two-head fixture marks each of the five buffers 60 times
  in 60 unchanged frames. Over the whole check, 8341 marks and 4,044,277 floats sent.
- `node scripts/check-signal-updates.mjs` after `d949ddf`: passes; 0 marks in the
  same 60 frames, every frame equal to the original writer's arrays, and the GPU
  stand-in current through deferred renders. Over the whole check, 3895 marks and
  2,032,434 floats sent. (The whole check is mostly transitions and regathers by
  design; it is not an estimate of the saving in the city.)
- Covered offline: all four phases and the crossings, exact phase edges, clock jumps
  both ways, a fast clock, brightness changes, empty rosters, add/forget, the same
  lights in other slots, camera moves and zoom, the three-second regather, the
  MAX_HEADS cap, and two lights changing in two updates before one render. Removing
  the range merge or the regather invalidation makes the check fail.
- `npm run typecheck` and `git diff --check` pass.
- On WebGPU the glow matrices (800 at most) fit a uniform buffer, which goes up every
  frame it's drawn whatever the version, so the saving there is in the colours.
- `node scripts/check-signal-updates.mjs --url …` on the candidate: passes on WebGPU
  and WebGL (`?renderer=webgl`), the same 8 road heads, 19 crossing heads and 27 glows
  at three fixed phase/brightness states, no console errors.

Timing on the M5 MacBook Air, headless Chrome, WebGPU, 1×, High, `--cpu 4`, clear,
40 s, 3 runs each, `36b50fc` against `53a50d8`, with `Signals.update` and
`backend.updateAttribute` wrapped to count time, uploads and bytes:

| Scene, time, order | `Signals.update` a frame | Attribute uploads a frame | Whole frame |
| --- | --- | --- | --- |
| drive 14:00, base first | 0.024 → 0.012 ms | 20.3 → 16.3 | 12.8 → 12.5 ms |
| drive 14:00, candidate first | 0.027 → 0.013 ms | 19.6 → 16.1 | 13.4 → 13.0 ms |
| drive 22:00, base first | 0.021 → 0.007 ms | 25.8 → 22.3 | 13.3 → 13.0 ms |
| stand (Old Town Square) | 0.005–0.008 ms either way | ≈13 either way | within ±4 % |

Bytes uploaded a frame didn't change measurably (8 KB by day, 27 KB at night on the
drive): the colour ranges are small. The whole-frame differences are inside this
machine's run-to-run noise (they changed sign with the order), so no frame-rate gain
is claimed: what's shown is a halved `Signals.update` and three or four fewer buffer
uploads a frame where lights are in view.
