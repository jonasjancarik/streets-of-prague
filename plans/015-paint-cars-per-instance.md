---
read_when: Reducing the number of car draw calls, changing how cars get their colour, or working on CarPool and the car material in src/car.ts and src/webgpu/vehicles.ts.
---

# Plan 015: Paint cars per instance

Every car type is drawn once per paint colour today. Give each car its paint as a
per-instance colour instead, so one retained mesh per type covers every colour, and
the number of car draw calls falls from the number of type-and-paint pairs in play to
the number of types.

## Status and starting point

- Status: DONE (local; draw reduction verified, frame-time benefit provisional).
- Priority: P1. Effort: one to two days. Risk: low–medium (two shader paths and the
  shadow pass have to agree; the look must not change).
- Category: performance (draw calls and per-draw main-thread work). Dependencies: none.
  Builds on plan 008's retained pages.
- Planned at: `1b5756cdf775c7fbde3e5522fb57de5658664bcf`, 1 October 2026, from reading
  the code only. Nothing was run or measured while planning.
- Confidence: high that draws fall; unknown how much frame time that buys. Step 1
  measures the share before anything is changed.

Before editing run `git status --short` and:

```sh
git diff --stat 1b5756cdf775c7fbde3e5522fb57de5658664bcf..HEAD -- src/car.ts src/webgpu/vehicles.ts src/main.ts scripts/check-car-pool.mjs
```

Branch changes, commits, pushes and deployment need separate authorization.

## Why

On WebGPU the main thread, not the GPU, was the limit on 30 September 2026 (see
`todo.md` and the performance skill). Main-thread render cost grows with the number
of objects drawn: each one has its bindings checked, and an instanced mesh whose
matrices fit a uniform buffer is uploaded every frame it is drawn. Cars are never
frustum-culled (`mesh.frustumCulled = false`), cast shadows, and are drawn again in
the shadow pass, so every active page costs two draws.

## Current state

`src/car.ts`:

- `carGeometry(type, paint, box)` (around line 241) bakes the paint into the vertex
  colours and caches one geometry per `type|paint` (or `type|paint|box` for a
  courier's box). Parts named `Paint` in `cars.glb` take the paint; the others take a
  fixed colour from `PART`. Trucks, buses and the fire engine are built in code
  (`truckGeometry`, `busGeometry`, `fireGeometry`).
- `PAINT` has 12 colours, `TWO_PAINT` 7–9 for bikes, trucks, articulated lorries and
  motorbikes, `COURIER_BOXES` 3. `ordinaryCarBodies()` enumerates every pair for
  startup preparation.
- `Car.key` is that cache key. `Car.burn()` clones the geometry, darkens its colours
  and sets the key to `type|burnt`.
- `CarPool` keeps `meshes: Map<key, InstancedMesh[]>` in pages of 16
  (`pageCapacity`), groups the cars by key every frame in `render()`, and adds a page
  when a key overflows (`overflowPages`) or appears late (`latePages`).
- One shared `material` (`MeshLambertMaterial({ vertexColors: true })`, with snow added
  in `onBeforeCompile`) and one `depthMaterial`. The WebGPU port is
  `addPort(/^cars$/, …)` in `src/webgpu/vehicles.ts`.

`scripts/check-car-pool.mjs` checks page reuse and overflow (README, around line 503).

## Design

Keep one geometry per type. Its vertex colours hold the fixed parts' colours as now,
and for painted parts the shade only (white, or the multiplier a hand-built body
uses). A new per-vertex float `painted` (1 on painted parts, 0 elsewhere) and a
per-instance `paint` colour give the final colour:

```
colour = vertexColour * mix(vec3(1), paint, painted)
```

Do not use three.js's own `instanceColor`: it multiplies every vertex, which would
tint the glass and tyres too.

- **Couriers' boxes:** keep them as separate geometries keyed `type|box:<colour>`
  (two-wheelers only, three colours). The rider's vehicle paint still comes per
  instance. This keeps the shader to one instance colour.
- **Burnt wrecks:** keep `type|burnt` as its own geometry and key, as now. Wrecks are
  rare, and their darkening touches every part, not only the paint.
- **Types with one fixed colour** (`spec.color`: taxis, police and so on) pass that
  colour as the instance paint.
- **Page size:** with one key per type, 16 is too small for the common types. Size the
  pages from the measured peaks in step 1 (plan 008 measured 28 taxis and 17 silver
  hatchbacks at once, so hatchbacks of every colour together will be far more). Keep
  each page at or under the uniform-buffer limit (about 1,000 matrices) and keep the
  overflow counters.
- WebGPU allows 16 vertex inputs per pipeline. Cars use position, normal, colour,
  `painted` and `paint`; the matrices come from a uniform buffer at these sizes. Check
  the count stays well under 16 after the change.

## Scope

In scope: `src/car.ts`, `src/webgpu/vehicles.ts`, the two-wheeler builders in
`src/figures.ts` only as far as they need to mark painted vertices,
`src/main.ts` saved-game capture (paint and courier-box fields only),
`scripts/check-car-pool.mjs`, `README.md`, `todo.md`, this plan and its index row.

Out of scope: culling cars to the view, changing the palette or which colours spawn,
the riders (`Figures`), line boards, lamp-light car shadows, and the seeded random
sequence (a car must draw the same numbers and get the same colour as before).

## Implementation steps

### 1. Count what cars cost now

With measurement authorized, on the `drive` and `stand` scenes, record per frame: the
number of visible car pages, the number of distinct keys with at least one car, cars
per type at the peak, and the car pages' share of all draw calls (main and shadow
passes separately). Use the counting method in the performance skill, not timings.

**Stop here** if car pages are under about a tenth of the frame's draws: record the
numbers in the Result and close the plan as not worth doing.

### 2. Mark painted vertices and split paint from geometry

Change `carGeometry` to take `(type, box?)`, write `painted`, and leave paint out of
the cache key. Do the same in the hand-built bodies and the kit's two-wheelers.
`Car` keeps its chosen paint in a new field (`paint: string`) and its key becomes the
type (or the box or burnt variant). The constructor must consume exactly the random
numbers it does now.

**Verify:** `npm run typecheck`; a unit-style check that for every `(type, paint)` the
new geometry's colours, with the formula above applied, equal the old baked colours
vertex for vertex.

### 3. Add the instance paint to both renderers and the pool

Add an `InstancedBufferAttribute` `paint` (vec3, linear colour) to each page and send
it with `send(attr, n)` alongside the matrices, only for the instances in use. Apply
the formula in the WebGL material's `onBeforeCompile` and in the `cars` port in
`src/webgpu/vehicles.ts`. The depth material needs no change (paint doesn't affect
shadows). Update `CarPool.prepare()`, `ordinaryCarBodies()` and `PREPARED_PAGES` to
types and page sizes from step 1.

**Verify:** `check-car-pool.mjs` passes with its expectations updated to per-type
pages; no overflow or late pages on the drive; `?renderer=webgl` and the default
renderer both draw every colour.

### 4. Compare the look and the counts

Screenshots of a busy street and a car park on both renderers, by day, at night under
lamps, in snow and with a burnt wreck and a courier, next to the baseline: colours
must match (compare the picture's statistics, not single pixels). Then repeat step 1's
counts, and an alternating `--vs` drive for frame time with an unchanged-build control
if the difference is small.

## Done criteria and stop conditions

Done when the car draw count per frame is the number of types in play (plus box and
burnt variants), the look matches on both renderers, the seeded colours are unchanged
(same order-independent hash of car positions and paints as the baseline), and the
pool check passes.

Stop and report if the paint formula can't reproduce a hand-built body's colours
exactly, if the vertex-input count approaches the limit, or if startup preparation
grows (it should shrink: fewer shader builds and pages).

Report the draw-count change separately from any frame-time change, and don't claim a
speed-up from an inconclusive comparison.

## Result

Implemented, verified and committed locally on 1 October 2026. No branch change, push or deployment.
The source snapshot used for the baseline was `79afa0b`, with the unrelated existing
startup-screen edits copied into both snapshots. The four plan-gated files had no
committed delta from the planned starting revision before implementation.

### Draw counts

Ten-second counting windows on WebGPU, 1440 × 900, DPR 1, high graphics, Wednesday
14:00, clear weather. Wrapped `backend.draw`, excluded null draw parameters and
failed pipelines, separated the main camera from `isShadowPassMaterial`, and counted
only retained car-body meshes (riders and line boards excluded).

| Scene | Car draws/pass before → after | Main draws/frame before → after | Shadow draws/frame before → after | Car share of both passes before → after | Peak active pages / keys before → after |
| --- | --- | --- | --- | --- | --- |
| drive | 72.06 → 11.54 | 146.47 → 86.06 | 104.00 → 43.48 | 57.54% → 17.81% | 74 / 73 → 12 / 12 |
| stand | 36.07 → 7.00 | 80.54 → 51.00 | 56.07 → 27.00 | 52.81% → 17.95% | 37 / 37 → 7 / 7 |

Before, cars made 49.20% / 44.78% of main draws and 69.28% / 64.33% of shadow draws
(drive / stand), comfortably exceeding the stop threshold. After, the main shares
were 13.41% / 13.73%, shadow shares 26.53% / 25.93%. No late or overflow pages in
either counting run. Car-body draws fell about 84% on the drive and 81% standing.
Driving and standing each had 14 loaded tiles; driving population differed by one
loose car and one police car, so these are equivalent scene windows, not identical
simulation-frame samples.

Peak cars per type on the drive: hatch 104, sedan 83, estate 42, SUV 59, van 20,
taxi 25, pickup 5, bike 12, moto 7. One 128-instance page covers those measured peaks;
exceptional populations retain additional pages. Preparation now has 21 keys/pages
(15 types and six courier-box variants). Each page reserves 8 KiB of matrices and
1.5 KiB of paint, or 199.5 KiB across the prepared inventory. Fixed vertex and index
buffers are shared between pages; paint buffers are independent.

### Correctness checks

- `npm run typecheck`, `npm run build`, and `git diff --check` passed. The production
  build retains the existing large-chunk warning.
- `node scripts/check-car-pool.mjs --case all --baseline http://localhost:5192/`
  passed on WebGPU and WebGL. Tests cover preparation without RNG calls, 259 cars
  over three retained pages, independent linear paint buffers and active upload
  ranges, custom bike colours, late wrecks, riders/boards across pages, empty-page
  reuse and zero first-visible-use builder states for prepared bodies.
- Compared 159 baseline type/paint/box combinations and 166,006 vertices: maximum
  colour error `2.8760079318068676e-8` (Float32 rounding); positions and normals
  exactly unchanged. Burnt colours matched for all 15 types; wreck masks are zero.
- 1,000 seeded constructor results matched colour, variant, RNG call count, and
  order-independent SHA-256 `cb52adce3a83df39fa907315f7d157e63e79155099f42b733fba069030bceb79`.
- Actual parked population: 1,400 cars, identical order-independent position/type/
  paint hash `76545e050a6691f2d8a64c6186d6c72a460c4badc14baeed58c135a6914c1db3`.
- Matched WebGPU and WebGL screenshots at Staroměstské náměstí and Újezd by day, at night and
  in snow, with staged colours, two couriers and a burnt van. Visual inspection
  found matching paint, fixed parts and shadows. Across the six pairs, mean RGB
  changes over the scene crop were below 0.15 on WebGPU and 0.26 on WebGL on a 0–255 scale.
- Live WebGPU vertex-input counts were five for the main pass and two for shadows,
  below the limit of 16. All six alternating-drive metadata samples report zero
  late and overflow pages.
- Saved-game capture depended on the old `type|paint|box` key. Updated those two
  fields to read `Car.paint` and `Car.courier`, preserving the existing save format
  and compatibility with older saves. Typecheck passed after this follow-up.

### Verification limits

An uncapped screenshot attempt timed out while another chat was running GPU
benchmarks from `.claude/worktrees/nearby-tiles` on port 5194. The capped scene runner
completed both renderers' screenshot pairs; these establish appearance, not timing.
The remaining WebGL screenshots were collected once that benchmark finished.

### Frame-time comparison

Three alternating baseline-first pairs on frozen snapshots, WebGPU, drive, high,
DPR 1, 14:00 clear, 10 s per sample, fresh Chrome per sample, loading heartbeat and
stall instrumentation. No concurrent game benchmark was present in process checks
during this series. These are uncapped headless results, not displayed smoothness.

| Pair | ms/frame before → after (throughput-derived) | Median before → after | p99 before → after | Long tasks before → after | Loading seconds before → after |
| --- | --- | --- | --- | --- | --- |
| 1 | 13.3 → 9.0 | 10.9 → 8.4 | 26.3 → 20.4 | 1 / 1108 ms → 1 / 55 ms | 33.9 → 30.8 |
| 2 | 12.1 → 9.6 | 11.0 → 8.9 | 27.1 → 20.0 | 0 → 0 | 40.7 → 69.0 |
| 3 | 12.9 → 10.1 | 11.9 → 9.5 | 30.3 → 19.8 | 0 → 2 / 101 ms | 59.9 → 68.3 |

The harness aggregates to 12.7 → 9.6 ms/frame and 11.5 → 8.7 ms of JavaScript,
favouring the change in all three pairs. Keep the first baseline's 1.1 s stall in
the result; it is a valid slow sample. This is provisional timing evidence: loading
and frame times drifted, all pairs ran baseline first, and an unchanged-build
control/reversed-order series was not collected. The printed stall logs retain p99
but not frame p95 or the complete frame-interval sequence. No firm speed-up,
startup-time improvement, phone benefit or smoother presentation is claimed.

The live inventory shrank from 159–165 retained baseline pages to 21. Reserved
matrices grew from 162,816–168,960 bytes to 172,032 bytes, with another 32,256 bytes
for paint. Outside long tasks, aggregate writeBuffer traffic rose from roughly
0.39–0.40 to 0.42–0.43 MB/frame, while writes fell from roughly 353 to 232–240/frame.
This trades a little buffer capacity/upload volume for fewer objects and bindings;
wall-clock loading variability cannot establish whether preparation took longer.
No missing player or ahead-road frames occurred in any of the six samples.

Initial counting-run timing snippets were not controlled comparisons (one also
overlapped a build) and are excluded from the timing conclusion. Broad gameplay
scenarios were intentionally skipped for this rendering change. Both temporary
snapshot servers and all owned test browsers were stopped after verification;
the pre-existing development server was left running.

Raw local evidence: `/tmp/paint-baseline-counts.log`,
`/tmp/paint-candidate-counts.log`, `/tmp/paint-pool-check.log`,
`/tmp/paint-build.log`, `/tmp/paint-scenes/`, `/tmp/paint-timing.log`,
`/tmp/paint-gpu-contact.png` and `/tmp/paint-gl-contact.png`.
