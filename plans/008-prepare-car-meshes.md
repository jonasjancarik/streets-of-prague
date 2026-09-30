---
read_when: Implementing step 2 of the driving-stutter work, or changing CarPool allocation and startup warm-up.
---

# Plan 008: Prepare and retain car meshes

This is step 2 of the driving-stutter work. Its goal is to move common car-mesh creation and shader preparation behind the loading screen, and avoid replacing live meshes when the visible car count increases. The implementation must keep every car visible and preserve vehicle behaviour.

## Status and starting point

- Status: PLANNED; no implementation or new measurements.
- Priority: P1. Effort: one to two days, including startup-cost checks. Risk: medium.
- Category: performance. Depends on: none technically; execute after 007 so shader-sharing costs are already separated.
- Planned at: `5162c1fcf11e51df8ceda46049cac217fc7a12cd`, 2026-09-30.
- Confidence: high in the allocation/cache issue; spare capacity and startup trade-offs must be established during execution.

Run `git status --short` and the following before editing:

```sh
git diff --stat 5162c1fcf11e51df8ceda46049cac217fc7a12cd..HEAD -- src/car.ts src/main.ts src/bikeshare.ts scripts/check-car-pool.mjs scripts/bench-stalls.js
```

Reconcile intervening edits with the current-state excerpts. Preserve the current tram-driving, fare, and other gameplay work in `main.ts`. Work in the authorized checkout; branch changes, commits, pushes and deployment need separate authorization.

## Current state and conventions

This npm/Vite/TypeScript game uses three.js r186, with WebGPU by default and legacy WebGL at `?renderer=webgl`. Read `.agents/skills/performance/SKILL.md` and `.agents/skills/webgpu-port/SKILL.md` before implementation.

`src/car.ts:380–394` picks a paint and geometry key, then calls the cached geometry factory:

```ts
this.key = box ? `${type}|${paint}|${box}` : `${type}|${paint}`;
carGeometry(type, paint, box);
```

Keys include body type, paint, and optional courier-box colour. `TYPES`, `PAINT`, `TWO_PAINT`, and `COURIER_BOXES` are in the same module. Physics variants such as Fabia/Octavia change handling, not the body key. Shared bikes can supply colours from loaded data (`src/bikeshare.ts:119`), so the palette constants are not an exhaustive list. `Car.burn()` creates a `type|burnt` key lazily; its current geometry is derived from the first actual car of that type to burn. Preserve that behaviour in this step.

`CarPool` is constructed at `src/main.ts:243` but starts with no body meshes. Inside `CarPool.render()` (`src/car.ts:686–697`):

```ts
if (!m || m.instanceMatrix.count < list.length) {
  if (m) { this.scene.remove(m); m.dispose(); }
  const geometry = cache.get(k);
  if (!geometry) throw new Error(`Missing car geometry: ${k}`);
  m = new THREE.InstancedMesh(geometry, material, Math.max(8, Math.ceil(list.length * 1.5)));
  // ...shadow settings and scene registration...
}
```

Three.js includes `object.uuid` for instanced meshes in `RenderObject.js:846–850`, so a replacement needs a new builder state even with the same material. Compiling a disposable stand-in does not warm the later mesh.

`src/main.ts:1329–1342` awaits `loadFacadeAtlas()`, compiles the scene with ground samples and the metro, then removes the samples. The WebGPU compile wrapper in `src/webgpu.ts:301–304` times out after ten seconds because headless Chrome can leave the promise pending. Promise resolution alone is not proof that all intended meshes are warm.

Reuse `sendInstances()` from `src/gpu.ts` for active ranges; do not introduce `DynamicDrawUsage`, which triggers uploads every frame on this renderer. Keep the existing style of named module-level caches and small typed methods.

## Scope

In scope: `src/car.ts`; startup/test-handle changes in `src/main.ts`; a small read-only colour/preparation hook in `src/bikeshare.ts` only if needed to register loaded operator colours; new `scripts/check-car-pool.mjs`; focused attribution in `scripts/bench-stalls.js` if needed; `README.md`, `todo.md`, this plan and its index row.

Out of scope: per-instance paint shaders, changing car geometry/colours, handling, spawning distributions, parked-car transform caching, collision indexing, bus-board texture redesign, shrinking draw distance, changes to renderer timeout/fallback, dependencies, or three.js internals. Burnt or genuinely unknown data-driven variants may still have one first-use build; report them rather than claiming all possible builds are eliminated.

## Implementation steps

### 1. Make preparation independent of gameplay randomness

Add a preparation API to `CarPool`, supplied with explicit geometry keys/descriptors rather than constructing dummy `Car` objects with the game's RNG. Enumerate ordinary body/palette combinations and courier-box combinations from existing constants, respecting fixed-colour types. Include known shared-bike colours when their data is ready, without adding a new network wait that can hang startup. Build geometries through the existing cache.

Create `scripts/check-car-pool.mjs`, modelled on `scripts/check-graphics.mjs`, with `--url` and `--case prepare|capacity|render|all`. These are new test commands. In its preparation case, call the API twice and assert stable keys, mesh identities, capacities and zero additional consumption of a supplied counting RNG. Test ordinary cars, bikes, courier boxes and a custom colour; preserve a fallback for colours absent at startup.

**Verify:** `npm run typecheck` and `node --check scripts/check-car-pool.mjs` exit 0. `node scripts/check-car-pool.mjs --url http://localhost:5191/ --case prepare` passes after the preparation API is in place.

### 2. Retain body meshes and define overflow explicitly

Use persistent per-key fixed-capacity pages, rather than disposing and replacing the primary mesh. Render excess instances into another page of the same key. Reuse empty pages on later frames; reset counts on every unused page. Do not silently cap visible cars and do not replace an instance-buffer object in place without validating the renderer's binding lifetime.

Choose capacities from an authorized baseline inventory of visible counts and reserved bytes, not an unexplained giant allocation. Start with one prepared page per ordinary key and reserve additional pages for keys whose measured maximum needs them. Record the chosen capacities, page count, matrix bytes and startup cost. Overflow must remain correct for exceptional density: creating an extra retained page is an honest fallback, with a counter recording the event. Target zero overflow creation on the defined comparison drive, not an impossible guarantee for arbitrary future content.

Continue sharing geometry and body material. Preserve shadow settings and `frustumCulled = false`, since `main.ts` already supplies visible cars. Iterate each car exactly once for rider animation, slope sampling and bus boards even if its key spans pages. Do not reset the rider/board index at each page.

**Verify:** `npm run typecheck` and the new `--case capacity` check pass. The test must exceed a page's capacity, shrink to zero, refill, and exceed it again: every requested instance is present exactly once, old UUIDs persist, pages are reused, and stale instances are not drawn. Check late custom-colour and burnt-key fallback too.

### 3. Warm the actual retained meshes during loading

Invoke preparation after the car bodies and figure kit are loaded, before the existing startup compile. Make every intended page participate in preparation; invisible or zero-count meshes can be skipped by renderer paths. Use a temporary valid instance/count and restore all counts/transforms in `finally`. Warm with the same scene lighting and relevant shadow configuration used in play, without putting fake cars into simulation or collision lists.

Retain the exact meshes, buffers, and materials that were warmed. Do not remove and dispose them like the ground sample group. Keep the existing facade-atlas ordering. Do not remove the compile timeout to force a benchmark to finish. Have the regression runner verify that first visible use of prepared pages does not create fresh body builder states in a normal browser run. In timed headless runs, report any incomplete warm-up separately.

**Verify:** the new `--case render` check and `node scripts/check-graphics.mjs --url http://localhost:5191/` pass. No temporary car appears when loading ends; rider animations, bikes leaning, slope alignment, bus boards, shadows and entering/exiting vehicles work. Startup completes even when compilation times out. Legacy WebGL loads and draws the same cars.

### 4. Compare startup and the drive separately

Serve an unchanged baseline on 5192 and the candidate on 5191, using stable snapshots and identical map data. Use the existing benchmark:

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu
```

Record car-body builder counts after startup, page allocations during play, long tasks, frame p95/p99, loading time, and reserved/uploaded bytes. Preserve correctness for each page before calling reduced uploads a success. The benchmark's CPU throttle starts after loading, so it does not establish throttled startup cost. Check ordinary-browser startup separately and use a real phone if phone startup is the acceptance target.

**Verify:** `node scripts/check-car-pool.mjs --url http://localhost:5191/ --case all`, `npm run build`, and `git diff --check` pass. Matching screenshots at `stand`, `drive`, and `square` show the same vehicle types and details. Document any startup/memory increase; if it outweighs the hitch reduction, report the trade-off before declaring the plan complete.

## Verification environment

`npm run typecheck` and `npm run build` are the existing static/build gates. There is no general npm test/lint script. The proposed runner should use Chrome through `bench.mjs`, import browser TypeScript modules through Vite, fail on assertion/console errors, and add no dependency. Playwright must be available through the benchmark's existing lookup or `PLAYWRIGHT_PATH`.

Only start servers during authorized execution: check port ownership first, use `npm run dev` / `PORT=5192 npm run dev` in the appropriate checkout, and follow the user's PortPilot and access-URL instructions. Do not switch an existing checkout under its running server. Generated `public/data` remains read-only. Save matched screenshots with the benchmark's `--shot /tmp/car-pool-candidate-%s.png` option and a different baseline prefix. Do not compare screenshots containing different seeded scenes and call a missing vehicle an optimization.

## Done criteria and stop conditions

- [ ] Focused preparation, overflow, reuse and render checks pass on the implementation.
- [ ] Ordinary prepared pages retain UUIDs and buffer identities; no live primary mesh is discarded for capacity growth.
- [ ] No missing/duplicate cars, stale page counts, changed random sequence, rider loss or bus-board regression.
- [ ] Startup and drive costs are reported separately; rare unprepared variants are listed explicitly.
- [ ] Typecheck/build and graphics-switch checks pass; scope and documentation are checked.

Stop if the solution requires changing paint representation, hard-capping cars, a three.js cache-key patch, or unreasonably large preallocation/startup delay. A failed warm-up in the headless compile path must be diagnosed, not hidden by delaying the sampling window until the drive has already built everything.

Future vehicle types, operator colours and box variants must be considered in the preparation inventory. Geometry ownership and per-page buffer ownership must remain distinct so disposing one overflow page never destroys shared geometry.

## Result

Not started. Record implementation revision, capacity inventory, startup and memory costs, tests, screenshots, alternating drive results and residual first-use variants here.
