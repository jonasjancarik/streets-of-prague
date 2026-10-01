---
read_when: Reducing the number of car draw calls, changing how cars get their colour, or working on CarPool and the car material in src/car.ts and src/webgpu/vehicles.ts.
---

# Plan 015: Paint cars per instance

Every car type is drawn once per paint colour today. Give each car its paint as a
per-instance colour instead, so one retained mesh per type covers every colour, and
the number of car draw calls falls from the number of type-and-paint pairs in play to
the number of types.

## Status and starting point

- Status: PLANNED.
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

Not started.
