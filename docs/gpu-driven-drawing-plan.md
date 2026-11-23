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

**Status (23 November 2026): stopped after stage 1.** On the Pixel 5 and a Pixel 11 Pro the
GPU, not the main thread, limits the frame, and the pool of buildings drawn by the GPU at
best matched the CPU culler (about 5 % quicker standing on the Pixel 11 Pro, the same
driving). The code is on branch `gpu-driven-drawing`, not merged. What came out of it for
the game is the draped ground (Progress, and the performance log).

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

## Progress (23 November 2026; the code is on branch `gpu-driven-drawing`)

Baseline for every comparison below: main at 6fcd476f, the CPU culler on by default
(`?cull=0` turns it off). Everything new is behind `?gpudraw`.

### Stage 0: checks (23 November)

`scripts/indirect-bench.js` (with `indirect-bench.sh`, which wraps it for `bench.mjs
--eval`) builds N small pieces in front of the camera and draws them either as N ordinary
meshes or as one mesh with N `drawIndexedIndirect` calls (`geometry.setIndirect(attr,
offsets[])`, an `IndirectStorageBufferAttribute` of 5 words a draw), and `--ab` switches
between them. The game's own scene is left out of the render so the draws are what is
measured; the game's per-frame JavaScript (about 18–20 ms on the phone) still runs. The
indirect pictures match the ordinary ones.

**What the Pixel 5 (Adreno 620, Chrome 153) offers.** The device three.js gets has
`indirect-first-instance`, `timestamp-query` and `shader-f16`, with the default limits
(three asks for none, `requiredLimits: {}`): 128 MiB `maxStorageBufferBindingSize`, 8
storage buffers a stage (and in the vertex stage), 256 MiB `maxBufferSize`, 256 texture
array layers, 8 vertex buffers, 16 inter-stage variables. The adapter itself offers more
(512 MiB storage bindings, 16 storage buffers a stage, 1 GiB buffers, 2048 array layers,
48 sampled textures a stage), reachable by passing `requiredLimits` when the renderer is
created. The M5's adapter has `indirect-first-instance` too.

**What 500 draws cost on the Pixel 5** (Medium at the tier's pixel ratio, first person
on the Old Town Square, lit Lambert pieces of 8 triangles, 30–36 s of 3 s windows, no
touches; the phone was 24 °C at the start of the first run and 31–34 °C in the later ones,
so read the differences, not the levels; window rates varied by ±3 ms):

| Pieces | Pair | Off | On |
|---|---|---|---|
| shared geometry and material | none → 500 meshes | 22.9 ms | 25.3 ms (+2.4) |
| | none → one indirect object | 26.2 ms | 25.7 ms (−0.5) |
| | 500 meshes → indirect | 27.9 ms | 22.9 ms (18 % quicker) |
| a geometry and material each (as tiles have) | none → 500 meshes | 23.8 ms | 34.0 ms (+10.2) |
| | 500 meshes → indirect | 32.1 ms | 22.5 ms (30 % quicker) |

So an ordinary draw costs about 5 µs of frame when the meshes share everything and about
20 µs when each has its own material and geometry, and 500 indirect calls from one object
cost nothing measurable beside the frame (the game's tile draws cost about 0.1 ms each
in the culler's measurements, with real materials and bigger bindings). On the M5 the same
test gains 6.5 %, as the desktop's draws are cheap. A first version that drew the game's
whole scene as well (80 ms frames, GPU-bound at Medium) couldn't resolve any of this.

**Stop rule:** not met. Indirect draws on the phone cost far less than ordinary ones, so
stage 1 goes ahead.

### Stage 1: the buildings from a pool (23 November)

`src/gpudraw.ts`, behind `?gpudraw` (WebGPU only; `?gpudraw=N` makes the pieces N × N a
tile, 1 keeping each mesh's triangle order). Each tile's building meshes are copied into
shared vertex buffers (chunks of 600k vertices, 56 bytes each, up to four), their
triangles sorted into pieces by the 31.25 m square they stand in. A compute pass each
frame tests every piece's box against the frustum and writes `drawIndirect` arguments,
and one mesh per chunk draws them (`gpuDraw.sorted` draws them nearest first, sorting
`geometry.indirectOffset` whenever the eye has moved a metre; off by default, see below). The tile's own mesh stays for the sun's shadow and
the mirror, so the buildings' GPU memory is doubled. The culler leaves pooled meshes
alone. Meshes with `drapeUv` (small OSM roofs) are refused and drawn the old way. On the
M5 standing on the Old Town Square: 12 tiles, 715 pieces, 0.81 M vertices, 11 meshes
refused. Dispatching the compute pass costs 0.12 ms of JavaScript a frame.

**Pictures.** `scripts/gpudraw-pixels.js` (24 still views): 23 identical, one with 1
pixel of 1,024,000. `scripts/gpudraw-popping.js` (the frame with the frustum test against
the same pool with every piece drawn, so both keep one draw order): no piece wrongly left
out in 210 steps over seven runs, driving and on foot. Every remaining difference from the
old drawing comes from surfaces at the same depth that the other triangle order resolves
the other way. With the order kept (`cells` 1) the 1-pixel view matches exactly, and with
every piece drawn the difference stays the same. In slot order it was up to 38 pixels a
step, and after sorting by distance 2. Two hooks keep the pool in step: the street
facades' hidden walls (`MASKED`), and the draw order where two surfaces tie
(`renderOrder` 0.5 for the pool, 0.75 for the passages' linings). No console warnings or
errors with `&dev` while tiles arrive, the pool is switched off and on, or the view
changes. (A browser pane that is hidden has a 0 × 0 canvas and logs WebGPU errors of its
own; that isn't the pool.)

**Pixel 5** (Medium at the tier's pixel ratio, first person standing on the Old Town
Square, `--ab` on `gpuDraw.enabled`, 60 s in 3 s windows, no touches, `&dev`). Every
baseline here is lower than the 20–22 fps of 22 November in the same scene, so read the
differences within each run:

| Pair | Off | On | |
|---|---|---|---|
| culler on in both (the stop rule's comparison), 25.4 °C | 13.6 fps, 73.6 ms, JS 38.1 ms | 10.3 fps, 97.7 ms, JS 40.8 ms | 33 % slower |
| culler off in both (`&cull=0`), 27.8 °C | 10.9 fps, 92.1 ms, JS 43.1 ms | 9.7 fps, 104.4 ms, JS 42.2 ms | 13 % slower |
| culler off, pieces sorted nearest first, 29.5 °C | 10–12 fps a window | 9–10 fps a window | slower (the WebGPU device was lost in the last two windows) |

The windows don't overlap in the first two runs. The pool saves no JavaScript: it
replaces one draw per tile (12–16), about 1.5 ms of frame at 0.1 ms a draw, and adds its
own per-frame work. Its GPU time is higher even with the culler off in both halves, and
drawing nearest first didn't remove that. With the culler on it also loses the culler's
occlusion: the pool draws every building piece in the frustum. On the M5 (High, headless
Chrome) it was 4.6 % quicker, within the windows' spread.

Not measured: driving on the phone, and hitches when tiles arrive (the compute pass's
cost is below).

**Later the same morning, the phone charging** (culler off in both halves, pieces in slot
order unless said, 60 s, no touches; the phone was slower than before, JavaScript about
50 ms a frame, 28–31 °C):

| Pair | Off | On | |
|---|---|---|---|
| compute pass run each frame → skipped (`frozen`) | 128.4 ms (7–9 fps a window) | 133.2 ms (7–8) | no difference |
| old drawing → pool with one piece a mesh (`?gpudraw=1`, about 14 indirect calls) | 113.9 ms (8–10) | 111.3 ms (8–10) | no difference |

So the compute pass costs nothing measurable, and neither do the pool's buffers: with one
piece per tile mesh the pool draws as fast as the old meshes. The GPU time lost at the
default 8 × 8 pieces goes on the indirect calls themselves, about 1,100 a frame of which
only 200–300 draw anything. Stage 0's 500 calls cost nothing beside a frame of
JavaScript, but here the GPU is the limit, and a tile-based GPU like the Adreno may go
through each call once for every screen tile it renders. A call list holding only the
visible pieces (a frustum test on the CPU writing `indirectOffset`), or bigger pieces, would
cut that. But with one piece a mesh the pool saves no JavaScript either (49.1 → 51.0 ms),
so even free it can only match the old drawing, without the culler's occlusion.

**The GPU process crashed** in all three runs made with the pieces sorted nearest first
(7a38f07f), and in none of the four without. Chrome logged "WebGPU Device Lost: A valid
external Instance reference no longer exists", and the phone's log shows the Adreno driver
refusing a GPU command ("IOCTL_KGSL_GPU_COMMAND failed: errno 35 Resource deadlock would
occur"), the GPU process dying and Chrome starting it again: a GPU hang, after 15–30 s of
drawing. Why the order matters isn't known. `gpuDraw.sorted` is now off by default.

**Stop rule: met.** The frame on the phone isn't quicker than with `?cull` alone; it is
clearly slower, so the plan stops after stage 1 and stages 2–7 are not started. Rescuing it would take a call list
holding only the visible pieces, then the culler's per-square verdicts applied to the
pieces. Even then stage 1 can save at most the 12–16 building draws a frame. The draws
worth moving are the ground layers (stage 3) and the nearby people, which the plan
already says to fix separately first.

### Stage 1, calling only the visible pieces (23 November, late morning)

`gpuDraw.visibleOnly`, on by default: each frame the CPU tests the pieces' boxes against
the frustum (about 1,100 boxes, the same test as the compute pass), writes the visible
pieces' arguments packed at the front of the indirect buffer, and hands three.js the plain
run of offsets 0, 16, 32… for them. The compute pass is skipped in this mode. Two things
had to be got right:

- **Calls at offsets out of plain order hung the phone's GPU.** A first version kept the
  compute pass's arguments and listed only the visible slots (offsets with gaps): the GPU
  process crashed in that run too, like all three sorted runs. Chrome's own GL context was
  "lost via EXT_robustness … GL_INNOCENT_CONTEXT_RESET_KHR", which means another context
  hung the GPU. Packing the arguments and calling them in a row hasn't crashed since.
- **three.js doesn't upload a changed indirect buffer by itself.** It uploads a geometry's
  buffers only when the mesh needs a full refresh, and a change to the indirect buffer
  alone doesn't cause one. Vertex changes do, and a buffer written by a compute pass never
  needs an upload, so this hadn't shown before. Without the upload the GPU kept stale
  arguments and 9 of the 24 views were wrong. The arguments are now written through
  `renderer.backend.updateAttribute` once the buffer exists.

Pictures: all 24 still views identical (the 1-pixel tie at Charles Bridge north is gone
too, the draw order being the slot order as before). No piece wrongly left out in 120
steps driving and on foot.

Pixel 5, charging, Medium at the tier's pixel ratio, standing on the Old Town Square, 60 s,
no touches, no crash in either run:

| Pair | Off | On | |
|---|---|---|---|
| culler off; every slot called → visible pieces only, 28.9 °C | 105.0 ms (8–11 fps a window), JS 40.8 ms | 94.2 ms (9–11), JS 40.1 ms | 10.3 % quicker |
| culler on in both (the stop rule's comparison), 30.1 °C | 76.4 ms (10–15), JS 36.6 ms | 78.5 ms (11–14), JS 36.1 ms | the same (−2.8 %) |

So the pool now draws about as fast as the culler alone, from −33 % in the first run.
It still saves no JavaScript and does no occlusion, so it isn't quicker, and the stop rule
still holds. Because the CPU now writes the call list, the next step would be cheap: leave
out the pieces in squares the culler finds hidden, so the pool gets the culler's
occlusion as well as fewer draws. Driving on the phone wasn't measured.

### Stage 1, with the culler's verdicts on the pieces (23 November, midday)

`gpuDraw.occlusion`, on by default with `visibleOnly`: a piece in the frustum is also left
out when the culler's latest sweep finds it hidden, the same test the culler makes for a
tile mesh's squares (`Culler.boxHidden`: its top plus the margin below the lowest height
seen over its box). It applies only while the culler is in use that frame, and each
piece's verdict is kept until the next sweep. Pictures: the 24 still views identical, no
piece wrongly left out in 180 steps driving and on foot (`gpuDraw.noFrustum` leaves both
tests out, so the popping check covers the verdicts). On the Old Town Square, heading 180,
226 pieces are called where the frustum alone left 318. Heading 90: 138 instead of 164.

Pixel 5, charging, Medium at the tier's pixel ratio, 60 s, no touches, `--ab` on
`gpuDraw.enabled` (the culler on in both halves):

| Scene | Culler alone | Pool with its verdicts | |
|---|---|---|---|
| standing on the Old Town Square, 29.2 °C | 77.8 ms (11–15 fps a window), JS 36.0 ms | 79.7 ms (12–14), JS 36.5 ms | the same (−2.5 %) |
| the drive scene, 30.0 °C | 280.6 ms, JS 52.3 ms | 281.3 ms, JS 51.7 ms | the same (−0.2 %) |

The drive scene didn't drive in that run. The car stood at 0 km/h at its start, at 3.6
fps with 14 M triangles, and it did the same in two runs without `?gpudraw`. The cause was
`&dev`: the developer panel's place search had the focus and kept the bench's keys. That is
fixed on main (77310a9d, merged into this branch), and the drive was measured again:

| Scene | Culler alone | Pool with its verdicts | |
|---|---|---|---|
| the drive scene, driving, 27.8 °C | 158.2 ms (4–10 fps a window), JS 67.6 ms | 164.4 ms (5–8), JS 69.4 ms | the same within the windows (−3.9 %) |

**Stage 1 ends here: the stop rule holds.** The pool, calling only the visible pieces and
leaving out what the culler hides, draws as fast as the culler alone. The first version was
33 % slower. It saves no JavaScript, because it replaces only the 12–16 building draws a
frame, about 1.5 ms at 0.1 ms each, and the per-piece occlusion adds nothing measurable over
the culler's per-mesh verdicts. Driving it is the same. What stage 1 leaves for later stages:

- Indirect draws on the Pixel 5 must be called as a plain run of offsets over packed
  arguments. Calls that skip or reorder offsets hung the GPU every time.
- Every indirect call costs the phone's GPU, even one that draws nothing. Call only what
  is drawn, with the list written by the CPU or compacted on the GPU.
- three.js r187 doesn't upload a CPU change to `geometry.indirect` without a full refresh
  of the mesh; write it through `renderer.backend.updateAttribute`.
- A compute pass before the frame costs nothing measurable there.
- The draws worth moving are where they are many: the ground layers (stage 3) and the
  nearby people. The buildings were the easy first layer, but too few draws to gain from.

### The nearby people, measured before instancing them (23 November, afternoon)

The plan says to fix the nearby people's draws first and separately. Before building that,
the ceiling: `--ab` on `lifeSize.enabled`, which sends every Rocketbox avatar back to its
instanced figure, the cheapest way the same people can be drawn. Pixel 5, Medium at the
tier's pixel ratio (12 avatars at most; 34 of their skinned meshes drawn in this view, counted
on the M5), standing on the Old Town Square, 60 s, no touches, 29.7 °C, without `&dev`:

| | fps | Frame | JavaScript |
|---|---|---|---|
| figures only | 18.9 (14–23 a window) | 54.0 ms | 25.5 ms |
| avatars | 18.7 (17–20) | 53.8 ms | 24.2 ms |

No difference. At Medium the avatars cost the phone nothing measurable over the instanced
figures, so drawing them as instances can't gain anything there, and it wasn't built. (The
17–29 % of draws counted above were on the M5 at High, with 24 avatars.)

**`&dev` costs the phone about 20 ms a frame.** The same scene with `&dev` ran at about 13 fps,
75–78 ms a frame with 36 ms of JavaScript, in the runs earlier that day. Without it: 18.9 fps,
54 ms, 25 ms. The differences within one page stand, but every phone run above with `&dev` had
its levels raised and its gains diluted. Leave `&dev` out of phone timings and use it only for
reading the console.

So at Medium the phone is limited by its GPU: 54 ms a frame against 25 ms of JavaScript. Fewer
draws pays little there. The lead is what the GPU spends per pixel (the ground was 30 % of
it at 2×, see the performance skill).

### Stage 3 checked before building (23 November, afternoon)

The ground costs the Pixel 5 about 26 ms of a 53 ms frame at Medium (performance log, 23
November): about 19 ms shading and 9 ms drawing the layers at all. Of those 9 ms, the
pixels are about 4 ms and the draws with their vertices about 5 ms, and the layers of every
tile merged into one draw were no quicker than the 52 draws (35.1 → 37.1 ms). The ground's
cost is in its triangles (6.1 M in the 13 tiles near the Old Town Square) and its shading,
which merging draws doesn't touch, so stage 3 wouldn't pay on the phone either. Not built.

### Stage 1 on a Pixel 11 Pro (23 November, evening)

The Pixel 5 is limited by its GPU, so the pool was measured again on a newer phone, where
the main thread might be the limit instead. Pixel 11 Pro (Android 17, Chrome 158), branch
with the draped ground, culler on in both halves, pool against the culler alone, 60 s,
no `&dev`, 27–37 °C:

| Scene | Off | On | JavaScript |
|---|---|---|---|
| standing, Medium | 22.9 ms (42–44 fps a window) | 45–46 fps a window but one at 9 fps (a stall when the pool is first used) | 12.5 ms |
| standing, High | 35.9 ms | 34.2 ms, 4.5 % quicker, every window | 15.6 ms |
| driving, Medium | 47.5 ms | 47.3 ms, the same | 18–19 ms |

JavaScript is about half the frame in every case, so this phone is limited by its GPU too.
The pool gains about 5 % standing and nothing driving: no reason to build the later
stages for phones. (2 and 4 touches in the Medium runs.)
