---
read_when: Implementing step 2 of the driving-stutter work, or changing CarPool allocation and startup warm-up.
---

# Plan 008: Prepare and retain car meshes

This is step 2 of the driving-stutter work. Its goal is to move common car-mesh creation and shader preparation behind the loading screen, and avoid replacing live meshes when the visible car count increases. The implementation must keep every car visible and preserve vehicle behaviour.

## Status and starting point

- Status: DONE (local) at `eb988f2`; builder work fell, while the frame-time benefit remains inconclusive.
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

Implementation commits, in order: `aeca62c` (explicit preparation, retained pages,
warm-up and regression runner), `de6e1c3` (a maximum 250 ms wait for the optional
already-started bike feed after the facade atlas), and `eb988f2` (hide empty pages
and reserve the two dense keys). The worktree was dedicated to this plan. Preparation
does not consume the gameplay RNG. All ordinary body, paint and courier-box keys,
including any operator colours loaded by that short deadline, get a retained page.
Every intended page is temporarily visible with one valid instance for the existing
startup compile, then its count, visibility and matrix are restored. A genuinely
late colour or burnt key gets a retained page on first use. No page or shared geometry
is disposed when car counts rise.

### Capacity and startup

The unchanged `a3032fbf` drive had 70 active car meshes and 299 visible instances
after settling, with 16 under the busiest key. A separate 40 s diagnostic drive
measured peaks of 28 yellow taxis and 17 silver hatchbacks. The final inventory
therefore prepares two 16-instance pages for each of those keys and one for every
other key. With two bike-operator colours loaded, it has 162 keys and 164 pages.
Each page reserves 1,024 matrix bytes: 167,936 bytes total before play, compared
with 38,336 bytes in the baseline after settling and about 56–57 KB after its drive.
At the end of the comparison drive, 388–395 visible cars marked about 24.8–25.3 KB
of active matrix ranges in either version. The renderer's total `writeBuffer` volume
outside long tasks was 0.35–0.44 MB/frame on the baseline and 0.40–0.49 MB/frame on
the candidate; these are whole-scene uploads, not car-only bytes.

Alternating benchmark load times were 13.7, 15.3, 15.2 s on the baseline and 14.1,
16.0, 16.6 s on the candidate: about 0.8 s more on average, before CPU throttling.
A first cold candidate load took 50.2 s, but there is no matched cold baseline for
that outlier. In regular capped headless Chrome, two baseline loads took roughly 8
and 3 s and two candidate loads 4 and 5 s, so that small sample does not isolate a
startup difference. A real phone was not available for a phone-startup conclusion.

### Drive and visual checks

On 1 October 2026, Chrome/WebGPU on an M5 MacBook Air, 1× DPR, High, clear 14:00,
the 40 s Újezd drive was alternated three times with a 4× main-thread CPU throttle,
fresh browser per run and loading-frame heartbeat. The exact command was:

```sh
node scripts/bench.mjs --url http://localhost:5238/ --vs http://localhost:5192/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu --shot /tmp/car-pool-%v-%s.png
```

Car-body builder events during play fell from 76/74/76 to 13/13/15, and total
material-builder events from 116/113/115 to 53/53/54. No final candidate drive
created an overflow or late-colour page; an exceptional future density still uses
retained overflow pages. Paired frame times were 11.8→11.3, 15.4→15.3 and
14.3→13.8 ms/frame. Their 13.8→13.5 ms average (2.5%) is too small and variable
to claim a measured frame-time improvement. Frame p99 was 32.3/36.9/48.4 ms on
the baseline and 31.1/49.4/44.6 ms on the candidate; long-task counts were
7/12/25 and 7/20/12. Both measures are mixed. An earlier version with visible
zero-count pages was 17.6% slower on average despite fewer builders; hiding those
pages removed the excess per-frame renderer work.

Matched [drive baseline](/tmp/car-pool-baseline-drive.png) and
[candidate](/tmp/car-pool-candidate-drive.png), plus `stand` and `square` shots with
the same `/tmp/car-pool-{baseline,candidate}-{stand,square}.png` pattern, were
inspected. Static parked vehicles and model details match. Moving traffic and
pedestrians are not pixel-identical, so their differing positions are not treated
as an optimization. One square screenshot timed out in Chrome and succeeded on a
single-scene retry. No shader, page or console errors were reported in the successful
comparison runs.

### Verification and remaining first use

`npm run typecheck`, `node --check scripts/check-car-pool.mjs`,
`node --check scripts/bench.mjs`, `node --check scripts/bench-stalls.js`,
`node scripts/check-car-pool.mjs --url http://localhost:5238/ --case all`,
`node scripts/check-graphics.mjs --url http://localhost:5238/`, `npm run build`,
and `git diff --check` passed. The car-pool runner checked 35 cars over three pages,
shrink-to-zero, refill and repeat overflow; UUID and buffer retention; zero-count
visibility; shadow settings; custom and burnt fallbacks; continuous rider and bus
board indices across pages; and zero fresh builder states when an idle ordinary or
reserved page first became visible, in WebGPU and WebGL. A scene check mounted and
exited a bike. It did not test every possible traffic, slope or weather situation.

No generated asset was staged or migrated. `public/data` was read through a local
symlink and was not rebuilt. First-use builds remain possible for bike operator
colours arriving after the 250 ms deadline, arbitrary custom colours, the first
burnt body of each type (still derived from the first actual car), and density beyond
the measured page reservations. The startup/memory cost is modest on this Mac, but
the frame-time benefit and phone startup remain unproven.
