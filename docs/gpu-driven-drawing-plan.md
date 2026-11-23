---
read_when:
  - Planning work on how the game issues its draws (draw counts, per-draw JavaScript, the main thread on phones)
  - Thinking of pooling tile geometry, merging materials, indirect draws or culling on the GPU
  - Extending occlusion culling beyond the street views (docs/occlusion-culling.md)
---

# Drawing driven by the GPU: plan

Written 23 November 2026, before any prototype. Today the main thread tells the GPU what
to draw, one three.js mesh at a time. This plan sets out how the WebGPU renderer could
instead keep the city's geometry in a few big buffers, let a compute pass decide each
frame what is visible, and draw it with indirect draws. It is in stages that can each
stop without harm (the times given are rough guesses), and the first stage is there to show whether the rest is worth doing.

It builds on [occlusion-culling.md](occlusion-culling.md), the sweep that leaves out what
the buildings hide (`?cull`). VR stays on the WebGL renderer
([webgpu-vr.md](webgpu-vr.md)), so it keeps that CPU culler and gains nothing from this
plan until WebXR works with WebGPU.

## Why

On the Pixel 5 the main thread is the limit. Much of its time goes on three.js's work
for each draw: choosing the pipeline, binding the material, updating uniforms and
issuing the call. That is why leaving hidden draws out made the frame 25 % quicker in
first person there, and why `?cull` gains 8–15 % while driving. When the GPU picks and
issues the draws, the main thread's cost of drawing barely depends on how many objects
there are.

What that buys:

- **Room for more things:** street furniture, trees, parked cars and building detail
  (balconies, cornices, signs) would cost GPU time, not main-thread time.
- **Cheaper shadows on the CPU:** the shadow passes issue their draws again today.
- **Culling everywhere:** the overhead view and the countryside too, and not only for
  what buildings hide.
- **Level of detail chosen per object on the GPU,** with no bookkeeping on the main
  thread.

What it doesn't buy: anything paid for per pixel. Lights, shading detail, weather,
reflections and resolution cost the same. Many lights need a separate technique
(clustered lighting), and merging materials can make shading a little slower per pixel.

## Where the draws go today

Measured on 23 November on the M5 (headless Chrome, WebGPU, High), standing in first
person: one frame's draws, by the `backend.draw` they go through.

| | Old Town Square, heading 50 | Karlova, heading 240 |
|---|---:|---|
| Draws in the frame (all passes) | 499 | 542 |
| Tile meshes, main pass (ground layers, buildings, landmarks, fixtures, furniture) | 181 | 240 |
| Tile meshes, shadow and other passes | 28 | 25 |
| Instanced pages (trees, cars, poles, birds…), main / other passes | 77 / 43 | 79 / 48 |
| Nearby people (each a mesh in three parts), main / shadow | 72 / 72 | 47 / 47 |
| Other meshes | 26 | 56 |
| Distinct materials / geometries / pipelines | 251 / 305 / 103 | 299 / 388 / 119 |
| Triangles | 5.8 M | 6.7 M |

In VR on the Pixel 5, Medium, it was 631 draws a frame (performance log, 22 November).

From this:

- **Tile meshes are the biggest group,** and each has its own material. A ground layer's
  material binds that tile's own textures: relief, sky view, level masks, aerial photo
  and coverage rasters (`surfaceMaterial` in `src/surface.ts`). That is the main
  obstacle to merging them.
- **Nearby people come to 17–29 % of the frame's draws,** since each person is three
  meshes drawn in both the main and the shadow pass. That cost can be cut without any of
  this plan, for example by drawing them as instances with their animation in a texture,
  as `figures.ts` does. It is worth doing first, on its own.
- **The instanced pages are already close to what this plan wants:** one draw for many
  objects, each with its data in a buffer.

## What three.js r187 already has

- **Compute** in TSL, and storage buffers (`storage()`, `instancedArray`).
- **Indirect draws:** `geometry.setIndirect(attribute, offsets)`, an
  `IndirectStorageBufferAttribute` that compute can write to. Given an array of
  offsets, `WebGPUBackend` issues one `drawIndexedIndirect` for each from a single
  render object, so the JavaScript per draw is paid once per object, not once per
  piece.
- **No multi-draw-indirect:** WebGPU hasn't shipped it (Chrome has it as an experiment).
  So a bucket of N pieces is N indirect calls in the command encoder, cheap but not
  free.
- **`BatchedMesh`** draws its ranges with ordinary `drawIndexed` calls, chosen on the
  CPU; it is not a way to do this.
- **`indirect-first-instance`** is an optional WebGPU feature. Without it, an indirect
  draw can't say which instance it starts at, and each piece needs its own slot, or the
  vertex shader reads a compacted list by `instance_index`. Whether the Pixel 5's
  Adreno 620 has it isn't known yet.

## Hard parts in this codebase

- **Tile textures:** the relief, sky view, masks, photo and coverage rasters are
  separate textures for each tile. Merged materials need them in texture arrays (one
  layer per tile slot, one size each) or an atlas, indexed by the tile's slot. The
  default limit is 256 layers, well above the tiles drawn at once.
- **Ground layers are drawn in order, not by depth:** each layer's `renderOrder`, the
  stencil that draws each pixel once (`onceAPixel`), and the depth-only passes for walls
  and the ground's base. Buckets have to follow that order: one bucket per layer order,
  drawn in turn. Tiles don't overlap, so the order of tiles within a bucket doesn't
  matter.
- **Tunnels:** inside a tunnel some ground is drawn only up to a range (`tunnelRange`),
  and the cutaway round the player changes what is drawn. Both have to become data the
  compute pass reads.
- **The many looks:** facades have 11 looks and era codes, roofs their patterns, the
  ground its patterns (`PATTERNS_GLSL`). These are already mostly chosen by data in one
  shader for buildings (`src/webgpu/buildings.ts`). The ground's layers are the ones
  that would need merging.
- **The limit of 16 vertex outputs** (met before, see the performance skill): merged
  shaders should read per-object data from storage buffers in the fragment shader, not
  pass it down.
- **Lookup tables in shader variables** cost 20–80 ms a frame on the Adreno. Tables
  must be uniform arrays or storage buffers.
- **Everything that walks the meshes today:** roof lookups, raycasts, the culler's
  verdicts, `disposeTileMaterial` and the WebGL program cache, the developer panel's
  checks. Each needs the pooled data instead, or a CPU copy of it.
- **Two paths:** the WebGL renderer (VR, browsers without WebGPU) keeps today's meshes.
  The pooled data should be built from the same tile arrays, so both paths draw the
  same thing and can be compared pixel for pixel.

## Stages

Each stage ends with a measurement on the Pixel 5 and a pixel check against today's
drawing, and the plan can stop after any of them.

### 0. Checks before building (a day)

- What the Pixel 5's adapter offers: `indirect-first-instance`, the storage-buffer
  limits (`maxStorageBufferBindingSize`, `maxStorageBuffersPerShaderStage`), and
  `maxBufferSize`.
- A small benchmark in the game's page: 500 indirect draws from one render object
  against 500 ordinary meshes of the same geometry and material, on the phone. That is
  the ceiling of what moving the draws can save, before any culling.

Stop if indirect draws on the phone cost about as much as ordinary ones.

### 1. One layer: the buildings (one to two weeks)

- A pool per vertex layout: one vertex and one index buffer for the buildings of every
  drawn tile, with ranges allocated and freed as tiles come and go (a simple free list;
  compaction when it fragments).
- An object table in a storage buffer: each piece's box, index range, tile slot and
  material data. Pieces are small enough to be worth culling (a block of buildings, say
  a 31.25 m square as in the culler), and not so small that the indirect calls add up.
- A compute pass that does frustum culling only, writes the visible pieces' draw
  arguments, and one render object that draws them through `setIndirect`.
- The buildings' shader reads the tile's sky view and other per-tile data by slot.
- `?gpudraw` switches it on, so `--ab` can compare it with today's drawing in one page.

Measure: main-thread time, the frame on the phone standing and driving, the GPU time
added by the compute pass. Pixel check: no changed pixel in the 24 views
(`scripts/hidden-draws.js` adapted), and while driving (`scripts/cull-popping.js`).

Stop if the frame on the phone isn't clearly quicker than with `?cull` alone.

### 2. Occlusion on the GPU (a week)

- After the main pass, a depth pyramid (each level the farthest depth of four texels
  below it).
- In the next frame, test each piece's box against the pyramid level its screen size
  fits.
- Two phases, so nothing pops: draw what was visible last frame, rebuild the pyramid
  from that, test the rest against it and draw what has come into view.
- Compare with the sweep (`?cull`): the pyramid catches more (any occluder, not only
  buildings, and the overhead view), and costs GPU time the sweep doesn't. The sweep
  could stay as a cheap first test.

### 3. The ground (two to three weeks)

- Per-tile textures into texture arrays by tile slot.
- One bucket per layer order, drawn in order, keeping the stencil and the depth-only
  passes.
- Tunnel ranges and the cutaway as data in the object table.

This is the hardest stage, and the one with the most draws.

### 4. Roofs, landmarks, fixtures and furniture

Landmarks have their own baked textures, so they go in an array or stay as ordinary
meshes. Furniture and fixtures are already instanced in part.

### 5. The instanced pages

Trees, cars, poles and people: the compute pass culls each instance and writes a
compacted list per page, which the vertex shader reads by `instance_index`. Tree crowns
widened by the shader need the same care as in the culler (`crownsHidden`).

### 6. Shadows

The sun's shadow map and the lamp shadows get their own culling against their own
cameras (frustum only at first), and draw from the same pools.

### 7. Tidying up

On WebGPU the CPU culler's tests for tile meshes go, as the GPU does them. The worker's
sweep stays for WebGL and VR. The docs (handbook, performance skill, webgpu-port skill)
describe the new path.

## Risks and open questions

- **The phone's GPU:** the compute pass, the depth pyramid and the second phase cost
  GPU time on a GPU that is itself close to its limit on the Pixel 5. Stage 1 shows
  whether that trade pays.
- **Merged shaders cost more per pixel:** each merge has to be measured on the phone
  (`--ab` on a material swap, as in the performance skill).
- **Mobile drivers:** indirect draws and atomics through Chrome's Vulkan backend on
  Adreno are less tried than on desktop. A failing pipeline draws nothing, so every
  stage needs the pixel checks and the console lines (`--extra "&dev"`).
- **Streaming hitches:** uploading into pools replaces creating meshes. The upload of a
  tile has to be spread out as it is now, and the pool's compaction must not stall a
  frame.
- **Memory:** pools with headroom, texture arrays sized for the largest tile, and the
  pyramid. The budget on phones has to be set in stage 1.
- **three.js updates:** the custom path touches the renderer's internals less than a
  renderer of our own would, but `setIndirect` and compute nodes are young and may
  change between releases.

## Not in this plan

- Cheaper shading per pixel and clustered lighting for many lamps.
- VR on WebGPU (waiting on WebXR with WebGPU in Chrome, see webgpu-vr.md).
- The nearby people's draws: worth fixing first and separately (see above).

## Where this stands (23 November 2026)

Stages 0 and 1 were built and measured on branch `gpu-driven-drawing`, which isn't merged:
on the Pixel 5 the pool of buildings drawn by the GPU at best matched the CPU culler alone,
standing and driving, so stage 1's stop rule held. The progress notes and the code are on
that branch. On a Pixel 11 Pro, also limited by its GPU (JavaScript about half the
frame), the pool was about 5 % quicker standing and the same driving.

### Stage 3 checked before building (23 November, afternoon)

The ground costs the Pixel 5 about 26 ms of a 53 ms frame at Medium (performance log, 23
November): about 19 ms shading and 9 ms drawing the layers at all. Of those 9 ms, the
pixels are about 4 ms and the draws with their vertices about 5 ms, and the layers of every
tile merged into one draw were no quicker than the 52 draws (35.1 → 37.1 ms). The ground's
cost is in its triangles (6.1 M in the 13 tiles near the Old Town Square) and its shading,
which merging draws doesn't touch, so stage 3 wouldn't pay on the phone either. Not built.
