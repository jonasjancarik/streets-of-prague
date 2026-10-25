---
read_when: Optimizing modal pause CPU use or changing animation-loop physics dispatch.
---

# Plan 036: Skip physics steps while game time is paused

## Status and intent

- Status: TODO. Category: performance. Priority: P2.
- Effort: several hours to one day, including focused verification. Risk: medium: pause/resume and input handling must keep working.
- Depends on: none. Reconcile shared-file edits with plans 032–036.
- Planned at: `546620e027330e2d2f08ebcbaf1f0e3c6c68e8be`, 25 October 2026.
- Confidence: high in the repeated-work finding; frame-time benefit unmeasured.

The animation loop sets elapsed game time to zero while settings or related
modals are open, but it still chooses physics step count from the ride multiplier.
That calls simulate(0), rebuilding spatial hashes and running traffic/crowd logic.
Skip those zero-time animation-loop steps. The expected benefit is less CPU work
while paused; this plan does not claim normal-play FPS or total power savings.

Before editing, run `git status --short` and:

```sh
git diff --stat 546620e027330e2d2f08ebcbaf1f0e3c6c68e8be..HEAD -- src/main.ts scripts/check-paused-physics.mjs scripts/check-modal-pause.mjs README.md docs/performance-log.md todo.md plans/036-skip-paused-physics.md plans/README.md
```

Compare changed source with the excerpts below, and inspect any uncommitted changes
in these paths. Reconcile intended earlier-plan changes; stop on an unexplained
behavioral mismatch instead of applying stale excerpts.

## Current state

`src/main.ts:2048–2050`:

```ts
if (benchPause.paused) { last = now; return; }
const dt = settingsPanel.open ? 0 : Math.min(0.05, (now - last) / 1000);
if (settingsPanel.open !== soundHeld) sound.hold((soundHeld = settingsPanel.open));
```

Later, at 2095–2097:

```ts
const run = testkit?.paused ? 0 : scale * (testkit?.speed ?? 1);
const steps = metro.active ? 0 : Math.ceil(run - 1e-6);
for (let i = 0; i < steps; i++) simulate((dt * run) / steps, ctl);
```

`simulate` at 1586 has no zero-time early return. It rebuilds `hash` and `carHash`
and invokes traffic, trams and crowd. `last = now` is still updated while paused,
preventing a catch-up step on resume. `src/settings.ts:327` reports settings,
feedback, newsletter and credits/privacy as paused through one getter.
`world.update`, camera/render updates, sound hold, UI, input release and feedback
screenshot handling run outside the physics loop. The explicit `__drive.simulate`
and testkit simulation entry points at 2422 onward are separate callers.

Use `scripts/check-modal-pause.mjs` as the style for controlled production-source
checks and real modal behavior. It already checks modal handoffs, stacked dialogs,
Escape and captured key releases; retain all of those assertions.

## Scope

Only the animation-loop physics dispatch in `src/main.ts`, proposed
`scripts/check-paused-physics.mjs`, necessary additions to
`scripts/check-modal-pause.mjs`, `README.md`, `docs/performance-log.md`, `todo.md`,
this plan and the index. Do not rewrite `simulate`, modify explicit testkit stepping,
change physics dt, touch controls, modal semantics, weather, animation-loop cadence,
rendering, sound configuration, or the benchmark's pause protocol.

## Steps and verification

1. **Capture the dispatch contract.** Create proposed
   `scripts/check-paused-physics.mjs` with offline and `--url URL` browser modes.
   The offline mode may exercise the actual compact dispatch block through the
   production-source extraction pattern in `check-modal-pause.mjs`; it must not
   test a separately rewritten approximation. Add `--baseline` to report current
   zero-time calls before editing. Cover dt 0, normal positive dt, ride multipliers
   1/6/12, fractional developer speed, developer pause and metro. Run
   `node scripts/check-paused-physics.mjs --baseline`: exit 0, showing that dt 0
   currently calls simulation for positive run while positive-dt totals equal
   `dt * run` whenever street simulation is enabled.

2. **Gate only the animation-loop physics steps.** Make `steps` zero when elapsed
   simulation time is not positive, while preserving the existing calculation for
   positive time. Keep `last = now`, all UI/release handlers and every nonphysics
   portion of the loop. Do not place an early return at the top of the frame or
   inside the shared `simulate` entry point. Run `npm run typecheck` and
   `node scripts/check-paused-physics.mjs`: exit 0; dt 0 dispatches no physics and
   all positive-time cases retain the original step count, dt and total time.

3. **Exercise the real loop and modal lifecycle.** Browser mode must use the game
   lock and Chrome harness pattern from `check-car-pool.mjs`, open actual UI modals,
   and temporarily wrap exposed traffic/crowd update methods to count calls.
   Prove the animation loop continues (render/UI counters advance) while physics
   calls stay zero for at least 60 rendered frames. Check settings, credits,
   feedback and newsletter without submitting forms; test stacked privacy and
   handoffs. Verify clock/traffic positions stay fixed, resume advances once normal
   elapsed time resumes, and no paused duration is replayed. Check entry while a
   ride is accelerated and release movement/horn/cannon keys inside a modal.
   Also verify a graphics/weather choice and requested screenshot still work.
   Restore wrappers and close only test-owned dialogs/pages in finally blocks.

```sh
node scripts/check-paused-physics.mjs --url http://localhost:5191/
node scripts/check-modal-pause.mjs
node scripts/check-controls.mjs
node scripts/scene.mjs run input-release --url http://localhost:5191/
```

   All commands must exit 0. Explicit testkit stepping remains callable as before;
   do not use it to stand in for proof about the real animation loop.

4. **Measure paused CPU work.** Have the proposed browser check report matched
   fixed-duration paused/unpaused windows, update-call counts and per-frame CPU
   work, with identical place, camera, weather, time and graphics. Run it separately
   on the baseline and candidate (`--url http://localhost:5192/`, then 5191),
   reversing order once if differences are small. Do not infer battery savings from
   uncapped FPS or the absence of simulation calls; rendering still runs. Verify
   the real-loop normal-play counters/step totals remain unchanged, then run
   `npm run typecheck` and `git diff --check`: exit 0. Update scoped docs with the
   narrower pause-work claim, not an on-demand-rendering claim.

## Done criteria and limits

- Zero elapsed time dispatches zero animation-loop physics steps; positive elapsed
  time preserves the old step count and total simulated duration.
- Real modal checks show no traffic/crowd simulation while frames/UI continue, no
  catch-up on resume, working input releases and screenshot/settings interactions.
- Existing modal/control checks pass and explicit simulation APIs are unchanged.

Stop if a system relies on simulate(0) for housekeeping essential to pause or resume;
identify that dependency before moving it. Do not quietly skip additional frame
subsystems. Future changes must keep the pause clock separate from real-time UI
and streaming work. On-demand rendering and background-tab policies are deferred.

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

Draft, 25 October 2026 — implemented; browser checks and measurements pending, so not DONE.

- `src/main.ts`: `steps` is zero when `dt * run` is not positive
  (`metro.active || !(dt * run > 0) ? 0 : Math.ceil(run - 1e-6)`). Positive time
  keeps the old step count, per-step dt and total. Nothing else in the loop changed.
- `simulate(0)` housekeeping: none essential found. A zero-time step only reset
  `jolt` (read inside `simulate`), recomputed `assisted` and `held` from the current
  controls, rebuilt the hashes and could retry traffic spawns while `spawnT` was
  negative. While paused, `assisted` and `held` now keep their last values, so the
  lane-assist hint and the steering guide behind the modal show the moment before
  the pause; the first step after resuming recomputes them.
- `node scripts/check-paused-physics.mjs --baseline` (unmodified code): exit 0, 52
  cases, 30 positive-time cases matching dt × run, 46 zero-time `simulate(0)` calls
  across 10 dt-0 cases (1 at ×1, 6 at ×6, 12 at ×12). After the change the default
  mode passes with 0 zero-time calls.
- `npm run typecheck`, `node scripts/check-modal-pause.mjs`,
  `node scripts/check-controls.mjs` and `git diff --check`: exit 0.
- Pending: `node scripts/check-paused-physics.mjs --url …` (written, not yet run),
  `scene.mjs run input-release`, and step 4's paired paused/unpaused timings on the
  baseline and candidate. No CPU or frame-time gain is claimed yet.
