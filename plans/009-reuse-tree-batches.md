---
read_when: Implementing step 3 of the driving-stutter work, or changing streamed tree mesh ownership.
---

# Plan 009: Reuse spatial tree batches across tile loads

This is step 3 of the driving-stutter work. Preserve every tree and its appearance while retaining the instanced meshes that draw them. The aim is to stop paying a new shader-build cost every time a tile's vegetation first enters view.

## Status and starting point

- Status: DONE (local); retained pages verified, whole-frame timing inconclusive.
- Priority: P1. Effort: several days. Risk: medium–high because rendering ownership and tile disposal change.
- Category: performance. Dependencies: none technically; follow 007 and 008 for separate before/after attribution. Retain their work if present.
- Planned at: `5162c1fcf11e51df8ceda46049cac217fc7a12cd`, 2026-09-30.
- Confidence: high in the per-mesh shader rebuild mechanism. Pool size, memory and culling trade-offs require later verification.

Run `git status --short`, then:

```sh
git diff --stat 5162c1fcf11e51df8ceda46049cac217fc7a12cd..HEAD -- src/map/vegetation.ts src/trees.ts src/tiles.ts src/main.ts src/gpu.ts scripts/check-tree-pool.mjs scripts/bench-stalls.js
```

Compare the named symbols and ownership below with the current code. Expected preceding-plan edits must be understood; unexplained ownership or shader changes require revising this plan. Do not change branches, commit, push or deploy without separate authorization.

## Current state

The game uses npm, Vite, strict TypeScript and three.js r186. WebGPU is the default and legacy WebGL remains at `?renderer=webgl`. Read `.agents/skills/performance/SKILL.md` and `.agents/skills/webgpu-port/SKILL.md`; preserve the documented 16-vertex-input workaround for large tree instance buffers.

The worker builds sorted tree instance arrays in `src/map/vegetation.ts` and returns `matrices`, `colours`, `evergreen`, `count`, `shrubs` and `conifers` (`src/contracts.ts:90–94`). Collision trunks are stamped into the tile grid in `src/tileWorker.ts:158–193`; rendering changes must not alter that data or the generation RNG.

`treeMeshes()` in `src/map/vegetation.ts:501–527` constructs three new meshes per tile:

```ts
geom.setAttribute('evergreen', new THREE.InstancedBufferAttribute(n ? evergreen.slice(from, to) : new Float32Array(1), 1));
const mesh = new THREE.InstancedMesh(geom, mat, n);
(mesh.instanceMatrix.array as Float32Array).set(matrices.subarray(from * 16, to * 16));
if (n) mesh.instanceColor = new THREE.InstancedBufferAttribute(colours.slice(from * 3, to * 3), 3);
```

The slices are broadleaf `[0, count-shrubs-conifers)`, then shrubs, then conifers. Shape attributes are shared; evergreen/matrices/colours are per mesh. Each mesh casts and receives shadows.

`src/tiles.ts:870,884,908` creates these meshes, parents them to the tile and includes them in `disposables`. `drop()` at 952–977 disposes them. Tile groups freeze their matrix traversal at 885–889, which matters if a retained mesh is reparented.

Three.js includes each instanced mesh UUID in the build-cache key (`node_modules/three/src/renderers/common/RenderObject.js:846–850`). Reusing geometry/material alone is insufficient. `src/webgpu/trees.ts:55–79` binds matrices to the object, using uniform or storage buffers depending on capacity. Do not remove the UUID from the key or swap those buffers casually.

## Scope and design

In scope: a new `src/trees.ts` containing a renderer-side pool; small reusable mesh-factory changes in `src/map/vegetation.ts`; integration in `src/tiles.ts` and startup/test handles in `src/main.ts`; `src/gpu.ts` only for a demonstrably needed range helper; new `scripts/check-tree-pool.mjs`; narrowly scoped attribution in `scripts/bench-stalls.js`; `README.md`, `todo.md`, this plan and its index row.

Keep the pool out of worker-imported modules' top-level browser state. Leave `src/webgpu/trees.ts` and its buffer-layout logic unchanged unless verification reveals a necessary compatibility fix; stop and explain that additional scope first. Do not change tree density, crown geometry, shrub triangles, season rules, collision stamping, map files, renderer cache keys, or the worker scheduler.

Use a pool of fixed-capacity pages per tree shape. Lease one or more pages to a tile; release them to the free pool when the tile leaves. Each active page contains only one tile's instances, preserving tile-sized spatial culling. This is simpler to verify than a global forest mesh or a moving ring with mixed ownership. Capacity and initial page count are execution-time choices based on the existing loaded-tile envelope and vegetation counts; no arbitrary maximum may silently drop trees.

## Implementation steps

### 1. Establish a pool with explicit ownership

Separate shared shape/material creation from filling a page. Allocate every page's matrix, colour and evergreen attributes at its fixed capacity from the beginning, including initially empty pages; adding `instanceColor` later changes the shader variant. Keep the buffer objects and mesh UUID stable while a page is leased/released/refilled.

Expose a small typed API, for example `add(tileKey, instances)`, `remove(tileKey)`, `prepare(...)` and final `dispose()`. Duplicate `add` must not leak or duplicate pages. Keep free pages at count zero and hidden, but retain them and their material resources; final teardown alone disposes owned buffers. Make shared shape and material lifetime independent of tile lifetime.

Create `scripts/check-tree-pool.mjs` following `scripts/check-graphics.mjs`: browser assertions through the benchmark/Vite, with `--url` and `--case lifecycle|render|all`. Use synthetic inputs for zero trees, all shrubs, all conifers and mixed arrays, including more instances than a single page holds. These are proposed test commands.

**Verify:** `npm run typecheck`, `node --check scripts/check-tree-pool.mjs`, and `node scripts/check-tree-pool.mjs --url http://localhost:5191/ --case lifecycle` pass. Assert exact instance counts and order-independent matrix/colour/evergreen hashes, no duplicate leases, and stable UUIDs/attributes across reuse.

### 2. Integrate tile leases without changing collision data

Let `TileWorld` own the pool. Attach pooled meshes to a persistent scene group, not to a group that `drop()` disposes. Replace `treeMeshes(land.trees)` in `make()` with registration of that tile's unchanged worker arrays, and release its lease in `drop()`. Remove pooled meshes from the tile's `disposables` list.

Commit the lease only once the tile is ready to be installed. If construction fails after allocation, release that lease; retrying the same tile must be safe. Preserve startup `loadNow()`/`build()` deduplication. Recompute bounding boxes/spheres for active instances whenever a page is filled so a page reused hundreds of metres away is not culled using its former tile's bounds. Empty pages must not retain visible shadows.

Do not depend on the frozen tile group's matrix walk. Use world-space instance matrices as supplied by the worker and explicit correct matrix-world state in the persistent group. Preserve cast/receive-shadow flags and the legacy custom depth material.

**Verify:** `npm run typecheck` and the lifecycle test pass after integration. The test must add A/B, remove A, reuse its pages for distant C, and remove C/B, comparing tree counts/hashes with the input arrays each time. Simulate an interrupted registration and retry; no lease remains orphaned. Dropping A must leave B visible and its shared buffers valid.

### 3. Prepare reusable capacity and upload only on changes

During authorized execution, inventory initial/peak active tiles and trees per shape on the drive, woods and garden-suburb scenes. Choose documented page capacities and startup reserves with enough room for that envelope. Make reserve pages participate in the existing startup warm-up using actual retained meshes, then restore them to empty state. Keep `loadFacadeAtlas()` before scene compilation and preserve the ten-second compile fallback.

When an unexpected density or zoom needs more pages, allocate additional retained pages rather than replacing old ones, clipping trees, or allocating an unbounded reserve up front. Count these events. The intended drive should reuse warmed pages after startup; unusual teleports/zooms may cause finite growth, which must be reported honestly.

Dirty only the written matrix, colour and evergreen ranges on tile changes. Do not repack all loaded trees every frame. `send()`/`sendInstances()` in `src/gpu.ts` are the range-upload exemplar; avoid `DynamicDrawUsage`. Small-capacity WebGPU uniform instance buffers may still upload each frame internally: distinguish renderer work from application dirty flags. Check both sides of the uniform/storage threshold and do not force a capacity solely to hide a counter.

**Verify:** the lifecycle check asserts no application attribute-version increment on unchanged frames and no allocation when reusing free capacity. The render check covers both small pages and a page above the device's uniform-buffer threshold, with no vertex-input/pipeline errors and no missing trees.

### 4. Verify appearance, shadows and driving stalls

Run the focused render checks and the existing graphics-switch regression. Compare baseline/candidate scenes `woods`, `slatiny`, and `park`, with clear daytime, winter/snow, and a tunnel cutaway. Count triangles/instances and inspect screenshots; a faster image with missing crowns is a failed result. Confirm shadows from off-camera trees still reach the visible street.

```sh
node scripts/check-tree-pool.mjs --url http://localhost:5191/ --case all
node scripts/check-graphics.mjs --url http://localhost:5191/
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu
```

Expected: tests exit 0, the benchmark runs on WebGPU with no errors, and warmed page reuse adds no tree builder states for equivalent rendering conditions. Record reserve/page counts, memory, overflow growth, tree build count/time, uploads, long tasks and frame p95/p99. Also check normal-frame cost in the dense suburb: poorer culling or extra draw calls can undo a hitch improvement.

**Verify:** `npm run build` and `git diff --check` pass. Record matched images and comparison results in this plan and `todo.md`. Do not declare a numerical improvement if alternating runs are inconclusive.

## Execution environment

Use existing npm scripts: `npm run typecheck`, `npm run build`, and `npm run dev`. No generic npm test/lint script exists. Chrome/Playwright are used by `scripts/bench.mjs`; reuse its lookup or `PLAYWRIGHT_PATH`, without adding dependencies. The new runner follows the error-propagating wrapper in `scripts/check-graphics.mjs`.

Only during implementation, verify port ownership before starting candidate/baseline servers on 5191/5192. Run `PORT=5192 npm run dev` from a separate stable baseline checkout; follow the user's PortPilot registration/runtime and access-URL requirements. Keep generated `public/data` read-only and do not modify a checkout while benchmarking it. Save screenshots with distinct `--shot /tmp/trees-candidate-%s.png` and baseline prefixes. Do not compare absolute timings from separate busy-machine runs; alternate with `--vs`, and use a real phone for phone conclusions.

## Done criteria and stop conditions

- [x] Lifecycle tests prove exact tree data preservation, correct overflow/reuse, valid bounds and cleanup.
- [x] Tile unloads do not dispose pooled meshes, shared materials or shared shape attributes.
- [x] Reusing prepared pages retains UUIDs/buffers and avoids a new tree build under the same variant.
- [x] Unchanged frames do not dirty all tree arrays; memory and normal-frame costs are recorded.
- [x] Visual/shadow/season/cutaway checks, legacy WebGL smoke check, graphics switching, typecheck and build pass.
- [x] Controlled drive evidence and remaining pool-growth cases are documented; changes stay in scope.

Stop if retaining pages still causes per-reassignment builds, if another object's buffers are bound, if the 16-input limit is exceeded, or if correct spatial culling cannot be preserved. Do not solve any of these by disabling shadows or thinning vegetation. If a viable reserve needs unacceptable memory or startup time, report the measured trade-off before further redesign.

Future tree kinds need their own shape pages and inventory. Pool sizing depends on maximum supported view radius and dense vegetation, not only the first tile. Review any disposal change against the shared-buffer guard in `configureRenderer()`.

## Result

Implementation checkpoint: `c0c40c1d944fab6c7f3f243492b7ef9588be1fe4` in the dedicated plan-009 worktree. No generated map data changed. `public/data` was linked read-only from the main checkout for local rendering; no asset conversion or deployment is involved.

The renderer now owns fixed pages of 1,200 broadleaf, 128 shrub and 128 conifer instances. Startup prepares totals of 30, 20 and 24 pages respectively, about 3.33 MB of matrix, colour and evergreen arrays. The broadleaf capacity is above the 64 KiB uniform-matrix threshold on the test device, so WebGPU uses its existing shared storage-buffer path and avoids full uniform-matrix uploads on ordinary frames. This is also closer to the one-mesh-per-tile draw-call count. An extra page is allocated only when all free pages of that shape are leased. Each page holds one tile's instances, keeps its UUID and attribute objects across releases, recomputes both bounds on refill, and stays hidden with count zero while free. Tile groups no longer own or dispose these meshes. The worker's tree arrays and collision stamping are unchanged.

The inventory that informed these sizes used the actual WebGPU game at 1×, High, clear 14:00. Initial loaded tiles/trees by shape were: drive 14 tiles, 6,127 broadleaf and 154 conifer; Petřín woods 14 tiles, 7,790 broadleaf and 453 conifer; Slatiny 12 tiles, 2,000 broadleaf, 385 shrubs and 405 conifer; Letná park 13 tiles, 1,548 broadleaf and 294 conifer. The one-second inventory runs were for counts, not comparable timing; the park run logged one transient `Failed to fetch` console message.

Verified after the capacity change: `node scripts/check-tree-pool.mjs --url http://localhost:5239/ --case all` passed on WebGPU. It covered empty, all-shrub, all-conifer and mixed arrays; overflow; A/B removal and distant C reuse; exact counts and order-independent attribute hashes; stable UUIDs and buffer objects; new bounds; no allocation from free capacity; an interrupted registration and retry; unchanged attribute versions across idle frames; final teardown; and rendering with 16- and 2048-slot pages without a new builder state on reuse. `node scripts/check-graphics.mjs --url http://localhost:5239/` passed on WebGPU and legacy WebGL with no reported page or console errors. `npm run build`, `node --check scripts/check-tree-pool.mjs` and `git diff --check` passed on the final source.

Matched WebGPU screenshots from the initial 256-slot broadleaf candidate were inspected at 1×, High, clear 14:00 for Petřín woods (`/tmp/trees-{baseline,candidate}-day-woods.png`), Slatiny (`...-day-slatiny.png`) and a tree-rich Letná camera at 50.0955, 14.424 (`/tmp/trees-{baseline,candidate}-park-view-park.png`). Crowns, evergreen shapes and tree shadows looked equivalent. The runner's default `park` start framed the bridge and water, so those initial images were excluded from the tree check. Petřín with `--weather snow` (`/tmp/trees-{baseline,candidate}-snow-woods.png`) preserved bare twigs, evergreen crowns and snowy shading. At the same real Strahov tunnel cell (-5358.84, 2135.67, level -1), both versions opened the same cutaway through the nearby tree and terrain (`/tmp/trees-{baseline,candidate}-real-cutaway-tunnel.png`); the game reported `covered: true`. Dynamic cars, people and snowflakes vary between captures. The 1,200-slot candidate was checked again against the baseline Petřín view (`/tmp/trees-candidate-storage-woods.png`) with no missing crowns or shadows; its Slatiny, snow and tunnel views need a final spot check. These one-second runs were for visual checks, not comparable frame-time measurements.

The first controlled drive compared the 256-slot candidate against `a3032fbf` from a separate baseline archive on ports 5239/5249: `node scripts/bench.mjs --url http://localhost:5239/ --vs http://localhost:5249/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu`. The paired frame times were 18.3→11.9, 11.0→17.6 and 11.7→24.3 ms. Machine drift was large and the mean was worse for the candidate; no timing benefit can be claimed. No candidate page growth occurred, but each drive still had three broadleaf and two conifer first-use main-material builds plus tree shadow builds. Outside long tasks, candidate uploads were about 0.53 MB/frame versus 0.36–0.44 MB/frame baseline, consistent with smaller pages' uniform-matrix work. The full log and data are `/tmp/plan009-drive-256.log` and `/tmp/plan009-drive-256.json`. These findings motivated the 1,200-slot storage-backed broadleaf pages.

The second three-pair comparison, with 1,200-slot broadleaf pages (`c467563`), used the same settings and showed no page growth. Ordinary-frame uploads fell to about 0.41 MB/frame, close to baseline's 0.36–0.44 MB/frame. Paired frame times were 16.4→11.4, 13.8→11.5 and 12.9→19.0 ms; the last baseline loaded three tiles while the candidate loaded six, and the machine's GPU and other processes were busy. The 14.4→14.0 ms mean is inconclusive. Every candidate drive still had exactly three broadleaf and two conifer main-material first-use builds, plus shadow variants. The full log and data are `/tmp/plan009-drive.log` and `/tmp/plan009-drive.json`.

Those five pages were already allocated. Startup `compileAsync` had excluded active pages outside the initial camera frustum; it also did not draw the tree-shadow pass. The current candidate temporarily disables culling for all retained pages during preparation and renders one frame behind the loading screen before restoring empty pages and normal culling. A focused 40-second WebGPU drive (`/tmp/plan009-diagnostic.log`) then showed **zero tree builder events**, zero page growth, six tiles built, zero long tasks and 0.33 MB/frame of uploads outside long tasks. Its 14.4-second startup was in the range of the preceding measured starts, but one run alone does not establish a startup-time effect. The expanded browser test verifies first use of a prepared page and active-page culling restoration; graphics switching passed on both renderers after this change.

The final candidate (`80c8dd1`) passed three alternating 40-second WebGPU drives with the same CPU, graphics, time and weather settings. Baseline and candidate each built six tiles per drive. **Tree builder events were zero in all three candidate drives; pool growth stayed [0,0,0].** Total material-build counts were 120/109/114 baseline versus 93/94/99 candidate, but those totals include unrelated cars, ground and other objects. Long tasks were 4/11/10 baseline versus 0/19/2 candidate. Paired mean frame times were 10.7→11.6, 14.8→19.0 and 12.2→13.5 ms, or 12.6→14.7 ms across the set. This is not evidence of a whole-frame speedup; the candidate ran second in each pair while GPU use reached 87% and Spotlight, media analysis and other processes were busy. The drive's mean draw calls were 241–244 baseline and 242–246 candidate; triangles remained about 1.2–1.25 million per frame. Outside long tasks, candidate uploads were about 0.33–0.34 MB/frame versus 0.36–0.44 baseline. Full output is `/tmp/plan009-drive.log` and `/tmp/plan009-drive.json`.

A reversed-order startup check (candidate first, baseline second, three one-second drive loads) found candidate load times of 14.3/15.4/15.6 seconds versus baseline 14.4/13.8/15.1. That does not confirm the 4–9-second candidate penalty seen with candidate always second in the full drive; startup cost remains uncertain under this machine load (`/tmp/plan009-startup.log`). In dense Slatiny, two 20-second paired runs drew 187–191 calls and about 1.22 million triangles in both versions. Mean frame time was 9.0→8.9 ms, within noise, and candidate uploads outside long tasks were about 0.28 MB/frame versus 0.30–0.38 baseline (`/tmp/plan009-suburb.log`). Small uniform-matrix buffers for shrubs and conifers may still upload internally each drawn frame, but the application leaves their attribute versions unchanged until a lease changes.

The final candidate's snow, Slatiny, tree-rich Letná and real tunnel-cell images were inspected against the baseline: `/tmp/trees-final-snow-woods.png`, `/tmp/trees-final-day-slatiny.png`, `/tmp/trees-final-park-view-park.png`, `/tmp/trees-final-real-cutaway-tunnel.png`. Bare twigs, evergreen crowns, the park canopy, nearby street shadows and the tunnel cutaway remain visible; no `exceeds the maximum (16)` or pipeline errors appeared. `node scripts/check-tree-pool.mjs --url http://localhost:5239/ --case all`, `node scripts/check-graphics.mjs --url http://localhost:5239/` (WebGPU and WebGL), `node --check scripts/check-tree-pool.mjs`, `npm run typecheck`, `npm run build` and `git diff --check` passed on the final source. One earlier graphics-check attempt encountered a WebGPU device-startup fallback and was discarded; the retry passed. No shared generated data was rebuilt or replaced. Timed phone performance and a quieter machine comparison remain unverified, so no numerical driving-frame benefit is claimed.
