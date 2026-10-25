---
read_when: Optimizing CarPool.render or changing terrain invalidation for parked-car rendering.
---

# Plan 032: Reuse parked-car ground samples and transforms

## Status and intent

- Status: TODO. Category: performance. Priority: P1.
- Effort: one to two days, including focused verification. Risk: medium: terrain and instance-slot changes must remain correct.
- Depends on: none. Reconcile shared-file edits with plans 032–036.
- Planned at: `546620e027330e2d2f08ebcbaf1f0e3c6c68e8be`, 25 October 2026.
- Confidence: high in the repeated-work finding; frame-time benefit unmeasured.

A parked car currently samples the ground under four wheels and rebuilds its
render matrix every frame. Cache those calculations for eligible unchanged cars.
Keep instance packing, uploads, paint, doors and riders as they are: this first
change removes CPU work without introducing persistent GPU slots. This develops
the parked-car transform follow-up previously deferred in `plans/README.md`.

Before editing, run `git status --short` and:

```sh
git diff --stat 546620e027330e2d2f08ebcbaf1f0e3c6c68e8be..HEAD -- src/car.ts src/tiles.ts src/main.ts scripts/check-car-pool.mjs scripts/check-car-transforms.mjs docs/performance-log.md README.md todo.md plans/032-cache-parked-car-transforms.md plans/README.md
```

Compare changed source with the excerpts below, and inspect any uncommitted changes
in these paths. Reconcile intended earlier-plan changes; stop on an unexplained
behavioral mismatch instead of applying stale excerpts.

## Current state

`src/car.ts:1209–1278`, `CarPool.render`, groups visible cars each frame, with 128
instances per retained page. The current calculation is:

```ts
const hf = height(c.x + fx * L, c.y + fy * L, c), hb = height(c.x - fx * L, c.y - fy * L, c);
const hl = height(c.x - fy * W, c.y + fx * W, c), hr = height(c.x + fy * W, c.y - fx * W, c);
d.position.set(c.x, (hf + hb + hl + hr) / 4, -c.y);
d.rotation.set(Math.atan2(hl - hr, 2 * W) - c.lean, c.h, Math.atan2(hf - hb, 2 * L), 'YZX');
```

Then `d.updateMatrix()` and `m.setMatrixAt(slot, d.matrix)` run for every car.
`sendInstances(m)` and paint upload run for each populated page. Slot numbers
change when visible cars enter/leave; a car-level cached matrix is not a cached slot.
Bus boards and rider transforms also read `d.matrix`.

`src/main.ts:279` defines `ground` through `world.groundFor(who, x, y)`;
`src/main.ts:2161` calls `carPool.render(drawn, ground, dt)`. `TileWorld.track`
(`src/tiles.ts:614`) can update `level`, `gz`, `_tx`, `_ty` and consume `hint`.
Tile insertion/rollback and removal mutate `byIndex` at 1178, 1190 and 1422.
The existing `tileAt` last-tile cache is invalidated with `this.last.i = NaN`.
Follow that explicit invalidation style rather than using elapsed time as validity.
`CarPool` already uses WeakMap caches for geometry attributes; weak per-car ownership
fits that convention and avoids retaining cars from unloaded tiles.

## Scope

Modify only `src/car.ts`, `src/tiles.ts`, the `CarPool.render` caller in `src/main.ts`,
`scripts/check-car-pool.mjs`, proposed `scripts/check-car-transforms.mjs`,
`docs/performance-log.md`, `README.md`, `todo.md`, this plan and the plan index.
Do not change collision indexes, parking placement, terrain interpolation, shaders,
page capacity, packing order or `src/gpu.ts`. Two-wheelers and moving vehicles may
remain on the uncached path. Do not add a second rendering system.

## Steps and verification

1. **Characterize the uncached calculation.** Create the proposed browser check
   `scripts/check-car-transforms.mjs --url URL --baseline` using the real-module,
   Chrome/game-lock pattern in `scripts/check-car-pool.mjs`. Compare matrices with a
   test-only copy of the original calculation; count the supplied height callback.
   Include a stationary four-wheel loose car, a slope, a moving car and changing
   visible order. `--baseline` checks existing semantics and reports counts without
   demanding reuse. Run `node scripts/check-car-transforms.mjs --url http://localhost:5191/ --baseline`:
   it must exit 0 and report four height calls per height-sampled car per render.

2. **Give terrain sampling an explicit revision.** Add a monotonic sampling revision
   to `TileWorld`, advancing whenever loaded terrain/level data affecting samples is
   installed, replaced, removed or rolled back. Audit all `byIndex` writers; purely
   visual dressing must not advance it. Start with a global revision, accepting
   conservative invalidation when any tile changes. Pass it explicitly to CarPool;
   callers without a reliable revision must use the original path. Do not use the
   identity of the stable `ground` callback as proof that terrain is unchanged.
   Extend the proposed check to assert a revision change on real tile lifecycle
   fixture mutations, including failed insertion. Run `npm run typecheck` and
   `node scripts/check-tile-lifecycle.mjs`: both must exit 0.

3. **Cache only safe transforms.** Start with four-wheel loose cars; retain the
   original calculation for other vehicles. Use weak per-car records holding a
   matrix and a validity signature: height provider/revision, exact position,
   heading, lean, dimensions and relevant tracking inputs (`level`, `gz`, `hint`,
   `grounded`, `_tx`, `_ty`, and any street hint actually used). On a miss, run the
   original path and store the signature AFTER its tracking side effects. On a hit,
   copy the cached matrix into `d.matrix`, then continue normal instance, paint,
   door and board work. Do not skip drawing or animations. Never reuse non-finite
   inputs or an unversioned height provider. No tolerance-based position rounding.
   Run `npm run typecheck` and the proposed check without `--baseline`: unchanged
   eligible cars must make zero additional height calls after priming, while their
   matrices match the uncached oracle within `1e-6` per element.

4. **Exercise invalidation and visibility changes.** The proposed check must cover
   movement, rotation, lean/dimension change, level/grounded/hint changes, height
   callback replacement, absent/replaced terrain, adjacent wheel tiles, tile removal,
   re-entry into view, slot/page reorder, empty groups, door closing, braking/broken
   lamps and burnt-body changes. Verify noneligible vehicles retain old behavior.
   Run `node scripts/check-car-pool.mjs --url http://localhost:5191/ --case all` and
   `node scripts/scene.mjs run car-doors bridge-exit tunnel-layers --url http://localhost:5191/`:
   both must pass. Inspect matched top-down screenshots including slopes and shadows.

5. **Measure and document.** Use the comparison below, then reverse the two URLs.
   Record ground-call reductions, cache hits/misses, CarPool CPU cost, retained cache
   memory and whole-frame results. Upload-byte reductions are not expected here.
   Run `npm run typecheck` and `git diff --check`: exit 0. Update the scoped docs.

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes stand,drive,suburb --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --extra '&date=10-20' --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu --json /tmp/plan-032.json
```

## Done criteria and limits

- All commands above pass; unchanged eligible cars produce identical matrices with
  no repeated height calls after priming, and every invalidation case recomputes.
- Page identity, count, order, doors, paint and shadow appearance remain unchanged.
- Results distinguish CPU work removed from measured frame-time benefit. A consistent
  slowdown is a reason to revise or reject the cache, not claim success from hit rate.
- No new strong registry retains all cars ever seen; cache storage follows car lifetime.

Stop if reproducing old matrices requires changing terrain semantics or clearing
tracking state beyond this optimization. Future ground providers or tracking fields
must extend the revision/signature contract. Persistent slots and dirty matrix/paint
uploads are explicitly deferred; do not add them to rescue an inconclusive result.

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

TODO — planning only. No implementation or performance gain established.
