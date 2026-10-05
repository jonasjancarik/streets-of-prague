---
name: performance
description: How to measure and speed up Streets of Prague (frame rate, GPU shading, main-thread CPU, tile loading) without fooling yourself. Use when working on performance, frame rate, shader cost, stutter or hitches, when adding anything drawn on every pixel (ground patterns, weather, lighting), or when adding per-frame or per-step work in the simulation.
---

# Performance in Streets of Prague

What was learned measuring and optimising the game (29 September–1 October 2026,
M5 MacBook Air and Pixel 5). Read `docs/performance-log.md` for current
work and `docs/optimisation-findings-007-012.md` for the completed experiments and
integration decisions. Historical timings below describe those runs, not a
performance baseline for every later revision.

## Measuring

Use `scripts/bench.mjs` (it documents its options at the top). It loads the game in
headless **Google Chrome** on the GPU at fixed places (`stand`, `drive`, `woods`,
`suburb`, `river`, `tunnel`), a fixed time (`--time`) and weather (`--weather`).

- **Compare, don't read absolute numbers.** Run-to-run drift is large (seen: 28 →
  14 fps with no code change), so a single before/after pair proves nothing.
  - Code changes: run a second dev server from a detached worktree of the baseline
    commit, then `--vs http://127.0.0.1:5192/ --runs 3`, which takes turns between
    the two. In the worktree, symlink `node_modules` and `public/data` from the main
    checkout (the map data is not in git). When cleaning up, move the symlinks to
    the Trash before `git worktree remove`, so the removal can't touch the targets.
  - A change you can switch in the page: `--ab "window.__ab = (on) => { … }"`
    toggles it every 2 s in one page. It's the most reliable way to find what a
    piece costs. To patch a shader piece out: clone the material, wrap its
    `onBeforeCompile`, string-replace the GLSL, give it a new
    `customProgramCacheKey`, and swap materials in `__ab`.
  - `--ab` (and `--eval`) code can `await import('/src/shading.ts')`: Vite hands the
    page the same module instance the game uses, so any exported `{ value }` switch
    (`DIRT`, `LEAVES`, `FACADE_ON`, `LAMP_SHADOWS`) toggles without changing code.
    Wrap it in an async function; the bench waits for the promise.
  - **Benchmark a snapshot, not the checkout you're editing.** Saving a file makes Vite
    reload the page mid-run, and the run dies waiting for the map (`waitForFunction`
    timeout). Serve a detached worktree of your branch on its own port and move it
    forward (`git checkout --detach <branch>`) after each commit.
- **One actively rendering game at a time on the test device.** This includes
  benchmark Chrome, browser QA runs, ordinary game tabs and in-app browser views,
  even when they belong to different worktrees. Two headless Chromes loading at
  once have pushed loads past the 120 s limit. Multiple idle Vite servers are not
  equivalent to multiple running games.
  - The scripts keep to this by themselves (`scripts/game-lock.mjs`). `bench.mjs`
    waits until no other session's scene, check or benchmark is running, saying on
    stderr whom it waits for, and scenes and checks started meanwhile queue behind
    it. A long wait is the queue, not a hang: leave it, don't kill the other
    session's process. Start every browser through these scripts so it is counted.
  - A game open from a dev server (a tab, the in-app browser, a resting scene
    server) stands still while a benchmark runs and says so on the page.
  - Not covered: a game served from a checkout older than this (no pause in its
    page) and production or preview builds. Close those tabs yourself. Scripts
    running from an older checkout are found among the processes and waited for;
    after five minutes a benchmark goes ahead and names them in a warning, and
    its timings are then suspect.
- **Reverse run order when judging small differences.** `--vs` currently runs
  baseline then candidate in every pair. Run a second series with `--url` and
  `--vs` exchanged, and label results by revision rather than URL role. Alternation
  helps with gradual drift; it does not correct another game starting or loading
  tiles midway through a comparison. Confirm each owned browser has closed before
  starting the next. On a phone, close the test page; do not quit the user's browser.
- **Warm both A/B states for steady-state cost.** The benchmark does this for
  `--ab` (`--warmup`, 2 s each by default). The first cold shadow-off window measured
  43 fps before recovering above 200. For first-use hitches, use a separate cold
  transition with instrumentation installed before it; warming away the work
  being investigated would invalidate that test. `--stalls` is installed after
  startup and settling, and `--cpu 4` is applied after loading, so neither measures
  the corresponding startup work by default.
- **Chrome/Metal can leave the next GPU device request pending even after cleanup.**
  `--fresh-browser` starts one Chrome process per scene while retaining the --vs
  alternation. `--loading-frames` runs a loading-only frame heartbeat, stopping before
  timing. The diagnostic with a heartbeat loaded reliably; the comparison without one
  hit long device waits even in a fresh process. Do not include aborted/fallback runs.
- **Require the backend you mean to measure:** `--require-webgpu` rejects a recovery
  fallback. `--load-progress` prints startup stages, adapter/device state and pending
  requests. The intermittent 120 s startup stall was traced to `requestDevice`,
  before tile loading; do not infer slow tile workers from the old generic label.
- **Use Chrome, not Playwright's bundled Chromium.** The bundled build's MSAA costs
  about 4.5× per fragment on a Mac, against 1.5× in Chrome, which inflates every
  per-pixel cost. The bench uses `channel: 'chrome'` by default.
- **Check what else is using the CPU too** (`ps aux | sort -k3 -nr | head`), not only
  the GPU: menu-bar apps and Spotlight took 2–3 cores one morning, and the same code
  measured 13 ms a frame of JavaScript, then 4 ms once they were gone. Ask the user
  before quitting their apps.
- **Check what else is using the GPU first**: `ioreg -r -d 1 -c IOAccelerator |
  grep "Device Utilization"`. The Claude app's browser pane has kept rendering an
  open game and consumed most of the GPU during other tests. Ask the user to close
  their active game view or defer the clean comparison. `--vs`/`--ab` do not make
  changing background contention harmless. Record load before and after the run.
- Browser visibility can suspend animation: a hidden pane has stalled loading by
  stopping `requestAnimationFrame`. Other background views can keep rendering.
  Check actual activity rather than assuming an obscured or minimized view is idle.
  Hussite Wars also recorded roughly 1 Hz callbacks while `document.hidden` was
  false. Probe callback intervals before trusting browser-pane FPS; the visibility
  flag alone does not establish normal cadence. This is a cross-project warning,
  not a diagnosis of every slow Streets of Prague session.
- `--dpr 2` increases fragment work; it does not prove the game is GPU-bound.
  `--dpr 1 --cpu 4` stresses main-thread JavaScript, not a whole phone's CPU/GPU,
  memory bandwidth or workers. `--profile` prints the hottest functions and
  `--profile-load` profiles startup; the `.cpuprofile` files are written to `/tmp`.
- The GPU timer query's numbers aren't reliable on Metal. Trust frame times.
  Headless Chrome still lines frames up to 16.7 ms slots, so a GPU-bound frame
  shows as 16 or 33 ms. Compare the distribution and sequence as well as the average.
- Before trusting a big speed-up, take a `--shot` (and run with `--extra "&dev"`,
  which prints shader compile errors). A shader that fails to compile draws
  nothing, and nothing is fast: a "3.8× faster" ground was really no ground.
- **Read the console lines the bench prints**, above the numbers. A WebGPU pipeline
  that fails (`Vertex input variable … exceeds the maximum (16)`, `Invalid
  RenderPipeline`) leaves its objects undrawn: fewer triangles, and a frame that looks
  quicker than it is.
- **Count work, not only time.** Counts are less sensitive to machine load, but
  compare the same route, loaded tiles and population: a slower simulation or
  missing scenery can change the work too. Wrap
  `renderer.backend.updateAttribute` (bytes: the attribute's, or its `.data`'s for an
  interleaved one, `updateRanges`), `backend.updateBinding`, `backend.draw` and
  `device.queue.writeBuffer` in an `--eval`, let it run 3 s, and divide by the frames
  (`window.__bench.frames`). That's how 3 MB a frame of uploads turned up (see below).
- Anything that should look the same: compare screenshots (`--shot`, `--zoom 0.3`
  for close-ups) and check that the stats match (e.g. the share of dark pixels),
  not that the pixels match. For simulation changes, compare an order-independent
  hash of results (parked car positions) between the servers.
  Observe the loading/streaming transition too: a settled screenshot cannot prove
  that trees, cars or shadows did not briefly disappear or pop into place.

### Checking measurement noise

When results change direction, the machine is busy, or the claimed change is only
a few percent, compare the same unchanged build against itself before interpreting
another A/B result. The existing harness accepts the same URL for both roles:

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5191/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu
```

Run this only when measurement is authorized, on a stable server whose port owner
is known. If unchanged-build differences are comparable to the proposed gain or
regression, the setup cannot resolve it yet. Report the comparison as inconclusive
and address load/order/thermal effects before collecting more optimization numbers.
A quiet control run improves confidence; it does not prove every later run is clean.

Keep individual paired results, not just their pooled mean. Report mean and
p95/p99 frame time, long-task count and duration, relevant work counts, and any
loading/memory costs. A single extreme run can dominate an apparent tail benefit.
Retain valid slow runs; exclude runs only for a documented test failure such as
fallback, zero frames, missing geometry or a known interruption, not because they
make the result inconvenient. Overlapping games are a possible confounder, not an
established explanation for every regression; preserve the original evidence.

### Throughput and visible smoothness

The desktop benchmark launches Chrome with `--disable-frame-rate-limit` and
`--disable-gpu-vsync`. Use that setup for matched cost comparisons, then verify
the same driving route in a normally paced browser on the target device before
claiming smoother play. Keep those results separate; an uncapped headless run
does not establish displayed-frame pacing.

Quiet Blocks documented a Pixel 5 change that removed unused bloom passes and
improved throughput by about 10%, yet worsened p95 frame intervals from 89 to
145 ms and median consecutive-interval variation from 11 to 33 ms. This is evidence
that less work can deliver less evenly, not a recommendation to keep redundant
rendering in this game.

Record the raw frame-interval sequence alongside mean and tail times. A useful
additional signal is `abs(interval[n] - interval[n - 1])`: compare its distribution
and repeated short/long bursts at matching display cadence. Animation callbacks
are a proxy for presentation, not proof of displayed frames; use a compositor or
device trace if the visual result and callback timings disagree. Use raw timestamps,
not clamped simulation `dt`, and retain genuine long stalls in the hitch report.
Auto-quality sampling may exclude pauses, but that filter is not a stutter metric.

### Follow mutations through rendering

For a tile arrival or departure, distinguish worker completion, main-thread
assembly, scene insertion/removal, first colour/shadow use, and retirement of GPU
resources. A short JavaScript mutation can leave expensive work for the next
renderer submission. A slow submission can in turn appear as a large frame
interval on the following callback. Correlate adjacent frames and the preceding
mutation instead of requiring all peaks to have the same timestamp.

Keep main-thread preparation, CPU time inside renderer calls, frame gaps and GPU
execution as separate measurements. A long interval with a short renderer call
does not identify the GPU as the cause; inspect simulation, other tasks and browser
scheduling too. `queue.onSubmittedWorkDone()` observes completion of previously
submitted work and can alter pacing if awaited every frame; it is not an isolated
GPU timer. Unsupported counters are unknown, not zero. Global counter changes
during a particular object's render are leads, not proof that object caused them.

### Interpreting optimization results

The work from plans 007–012 illustrates several distinctions worth keeping:

- **A work reduction is not an FPS claim.** Shared graphs, fewer first-use builders
  and fewer index mutations prove specific work was removed. They do not prove
  lower mean frame time or fewer visible hitches. Attribute remaining long frames
  before assuming the original bottleneck still dominates.
- **Preparation moves costs.** Retained car/tree pages can avoid driving-time
  builds while adding loading time and reserved buffers. Report startup, normal
  frames, first-use frames, memory and overflow separately. Warm the exact retained
  objects and relevant shadow passes; count-zero/hidden stand-ins can miss them.
- **Incremental bookkeeping must pay for itself.** Dirty scans, maps, ordering and
  removals have a cost even when few entries change. Compare the full per-step
  cost with the old rebuild-on-change path, not just the number of mutations.
  Plan 012 B remains held off main with an isolated retest pending; its measured
  desktop regression has not been shown to be caused by background load.
- **Worker changes need both frame and arrival evidence.** Track required-tile
  latency and missing player/ahead tiles alongside hitches. Reducing contention is
  not a win if the road arrives too late. Keep optional refreshes coalesced and
  distinguish them from initial work required to display a tile.
- **Code and asset activation are different.** Offline processing can remove a
  browser pixel pass but increase asset size, and a compatible reader alone does
  not activate staged assets. Test a cold load with the intended asset version;
  include download/decode/upload costs as well as the eliminated JavaScript.
- **Do not add independent speedups together.** Separate candidates compared with
  one common baseline can interact when combined. Verify the selected integration,
  then compare that exact combined revision against its matching baseline once
  concurrent work has settled. Keep excluded experiments out of later merges.

## Where the time goes (2× on an M5, Chrome, by the Old Town Square)

On WebGPU (30 September) the main thread, not the GPU, was the limit at 2×, and
`writeBuffer` (uploads) was its biggest item: profile before assuming the shaders.
On WebGL (29 September) the GPU was the limit at 2×. Per frame, roughly:
- **Ground patterns: ~29%.** The mosaic's stones 14%, dirt on the paving was 12% until it was baked into a texture (`GRIT` in `shading.ts`, one read: now under 1%).
- **Shadows on the ground: 11%.**
- **Roof tiles: 12%.**
- **Facade pictures: 7%.**
- **Wall grime: 6%.**
- **The shadow map pass: 7%.**
- **MSAA: ~20% at 2×.**

The ground is shaded on every pixel. Measure anything you add to `PATTERNS_GLSL`,
`WEATHER_GLSL` or `patterned()` with `--ab`.

## GPU gotchas

- **Value noise reads its lattice from a texture** (`NOISE` in `src/shading.ts`,
  one filtered `textureLod` a call). Don't go back to hashing four corners per
  call. Each `vnoise` is still a texture read, and a 4-octave `fbm` is 4 reads,
  which added up to ~10% of a frame for one `fbm` on the ground. Count the reads.
- **Anything that changes over tens of metres or more goes in a per-tile
  texture**, not the shader. That's how `broad()` is baked into the hill-shading
  texture (`relief()` in `src/tiles.ts`). The JS noise in `shading.ts` matches the
  GLSL.
- **Gate sub-pixel detail with a branch.** Compute `detail()` (which uses `fwidth`)
  outside the `if`, then `if (d > 0.) { … }`. Derivatives inside non-uniform
  branches are undefined. `textureLod` is safe inside them.
- **A random number per cell: use `hash32`** (three numbers for one hash), not
  several `hash12` calls. Compare squared distances; take `sqrt` once at the end.
- **GLSL name clashes** (e.g. a second `float d` in one function) fail the whole
  ground program silently unless the page runs with `?dev`.
- **Apple GPUs skip covered opaque pixels on their own** (hidden surface removal),
  so reordering or stencilling layers measures ~0% on a Mac. On Apple, the
  **stencil test is not early; the depth test is.** The ground's layers are drawn
  top-down with a stencil (`onceAPixel` in `src/surface.ts`, needs `stencil: true`
  in `main.ts`) for GPUs without that, which is most Windows PCs and many phones;
  it can't be measured here. Overdraw can be counted by rendering with an additive
  material and reading pixels back: it was 1.4–2.1 solid ground layers per pixel.
- **Don't order the ground layers by a fake depth** (`gl_Position.z` by rank). It
  works at 24 bits but breaks on 16-bit depth buffers. And drawing the ground
  after the buildings breaks the view down into tunnels (the cars inside would be
  painted over).
- **Changing the random lattice changes where patches fall** (asphalt cracks
  appear on other streets, stones change). That's acceptable if the character
  holds, but say so in the commit.
- **No lookup tables in shader variables.** In TSL, `array([...]).toVar()` becomes a
  WGSL variable that is filled in again for every pixel. On a Pixel 5 (Adreno) the
  facade tables in `src/webgpu/buildings.ts` cost 20–80 ms a frame that way, more than
  the rest of the shading together; on a Mac nothing. Use `uniformArray`. Branches a
  pixel doesn't take and `discard` measured free there, and the roof patterns cheap.
- **On a phone, find a shader's cost by swapping materials, not by its switches.**
  Clone the material with another `customProgramCacheKey` and register a port for that
  key that leaves a piece out, then `--ab` between the two on `--android`. A uniform
  switch (`ROOF_DETAIL`, `FACADE_ON`) only skips what sits inside its branch.
- **Measured and not worth it:** folding the shadow filter's trigonometry together
  (Metal copes already), and 4× instead of 8× anisotropy on the facade pictures.
- Changes that would help but alter the look are decisions for the user: MSAA off
  at 2× (antialiasing can only be chosen when the renderer is created), a tighter
  fade for the stones, a cheaper shadow filter.

## CPU gotchas

- **Don't use generators or per-call allocations in per-step code.**
  `SpatialHash.near` fills an array. `obstacles()` in `main.ts` reuses one list,
  which holds until the next call, so never look up obstacles while going through
  a list. `Polyline`/`Loop` keep each segment's heading, so there's no `atan2` per
  `at()`.
- **Update only what changed.** The tram grid re-files only trams that moved
  (`file`/`unfile` in `src/trams.ts`); when a tram leaves service it's taken out in
  `remove`. Most of the ~300 trams are far away and step four times a second.
- **Instanced meshes that cast shadows need their own `customDepthMaterial`**,
  one per kind (trees have `instanceColor`, cars don't). With three.js's single
  shared depth material, every switch between instanced and plain meshes rebuilds
  shader parameters (`getParameters` shows in the profile).
- **Static groups skip the per-frame matrix walk:** tile groups set
  `updateMatrixWorld = () => {}` once their matrices are made.
- **Skip work nobody sees:** by day the lamps return right after gathering the
  poles. The crowd draws and animates only the people in view (`Crowd.render`,
  packed into the first slots; `Figures.wear` copies each one's colours in).
- **Check that a "re-gather only when needed" cache ever holds.** The lamps' check
  compared the radius asked for with the padded radius gathered, so at the usual view
  it failed every frame and rebuilt and re-uploaded every lamp. Count how often the
  expensive branch runs, don't assume.
- **Don't shrink the crowd's radius to save work.** People bunch round you (those who
  wander off are moved to just outside the view), so keeping them within ~190 m instead
  of 330 m halved the people in view even with the cap scaled to the area. Tried and
  dropped; off-screen people cost little now that they're neither drawn nor animated.
- **Spatial lookups for one kind shouldn't walk the others.** `carsNear` ran for every
  person near you through a hash holding the whole crowd; cars now also go into
  `carHash` of their own.
- **Tile loading happens on the main thread** after the workers finish: meshes,
  street graphs, and parking. Numeric map keys, not template strings; share per-type data;
  compute outlines once.
- **Parking isn't worth moving to the worker** (measured 30 September 2026). `parkCars`
  takes 21–23 ms for the first tile, behind the loading screen, then 1.6 ms a tile on
  average during play (7 ms at most) on an M5, and 5 ms (10–24 ms at most) with the CPU
  slowed 4×. On a 4×-slowed drive the main thread stalls for 50–100 ms at a time for
  other reasons (shader builds, see "Stalls while driving"), and `parkCars` isn't among the hottest functions. Moving it would
  also be costly: `place()` makes a real `Car` for each spot tried (its outline, and
  random draws mixed with the placement's, from `car.ts`, which pulls in three.js),
  checks the shared `posts` of all loaded tiles, and hands back `DriveEdge` objects
  from the shared street graph (`onPavement`). The bench only slows the CPU after
  loading; to time tile loads slowed, set the throttle before `--eval`.
- Check behaviour after simulation changes: trams, traffic and people still move,
  some stop for obstacles, and the grids hold no stale entries.

## Streaming and resource lifetime

These checks adapt Quiet Blocks' edit/reuse lessons to a moving city:

- **Test warm reuse and exploration separately.** Repeated trips over the same
  blocks exercise release/refill; a long route through new districts and variants
  exercises cache growth. Track active objects, reserved pages, retained bytes and
  final disposal separately. Hidden or empty pooled objects still own resources;
  ten stable reuse cycles do not prove memory stays flat across the whole city.
- **Preserve the whole reusable assembly.** Keep parent attachment, mesh,
  geometry, attributes, typed arrays and materials stable where possible. A stable
  root or UUID alone does not prove the renderer reused its buffers or bindings.
  Check the first use after reactivation, including shadows, as well as later frames.
- **Stage against real renderer progress if staging is needed.** Several animation
  callbacks can occur between renders when pacing or idle logic skips submissions.
  Wait for the intended render checkpoint before the next mutation; that checkpoint
  need not block on GPU queue completion. Include removal/disposal and weight a
  group by its descendant render work, not just one top-level object. Smaller
  chunks can multiply draws, shadow refreshes and repeated hitches: compare p99,
  worst frame and total time until the required tile is usable.
- **Check final convergence after cancellation.** A new location can supersede
  queued work while the old tile is partly installed. Reconcile from the actual
  attached and pending state, and verify the latest required tiles finish once
  movement settles. A capture ending with required work pending cannot establish
  complete load time, even if its last recorded frame was fast.

## Uploads to the GPU

- **Send only what's drawn**: `send(attr, n)` / `sendInstances(mesh)` in `src/gpu.ts`
  set an update range for the first `n` items and skip empty meshes. Instance buffers
  are sized for the worst case (4000 of a lamp model), and `needsUpdate` alone sends
  the whole buffer.
- **Preserve writes pending the next upload.** If several tile updates touch an
  attribute before it renders, combine their dirty ranges or send one final active
  range covering every required write. A later partial update must not clear an
  earlier unsent range. Test two disjoint writes before one render and unchanged
  frames afterward; do not infer a bug from `clearUpdateRanges()` alone when the
  final range already covers all drawn data.
- **No `DynamicDrawUsage`.** three.js's WebGPU renderer uploads such an attribute every
  frame whether it changed or not, and whole once its ranges are used up.
- An instanced mesh whose matrices fit a uniform buffer (≤ ~1000) is uploaded as a
  uniform buffer every frame it's drawn; past that, as vertex data only when changed.

## WebGPU

WebGPU is the default renderer (`?renderer=webgl` for the old one; see
`src/webgpu.ts`, the `webgpu-port` skill and `docs/performance-log.md`).
Measure the ground's patterns in either renderer by swapping each ground material
for its `userData.flatten()` (the same ground without the pattern):

```
--ab 'window.__ab = (on) => { window.__drive.scene.traverse((o) => { const m = o.material; if (!m || Array.isArray(m)) return; const u = o.userData; if (!u.patterned && m.userData && m.userData.flatten) { u.patterned = m; u.flat = m.userData.flatten(); } if (u.patterned) o.material = on ? u.patterned : u.flat; }); }; window.__ab(false); window.__ab(true);'
```

For a partially ported feature, compare only equivalent rendered work: an unported
GLSL customization can be plain or missing on WebGPU. The main effects are now
ported, so whole-frame comparisons are useful once visual parity, backend and test
conditions are checked. Do not assume GPU timer support or reliability on WebGPU.

## Stalls while driving (hitches)

Measured 30 September 2026: the drive from Újezd, 40 s, on an M5 at 1× and 4× and on a
Pixel 5 (see "On a phone" below). These observations motivated the later shared
building graphs and retained car/tree pools. Plans 007–012 reduced first-use work,
but their results do not establish a general frame-rate gain; see the findings doc.

- **Most stalls are three.js building a material's shader** (TSL into WGSL, on the main
  thread) the first time something is drawn with it: 7 ms at 1× on an M5, 15–60 ms at
  4×, 10–90 ms on a Pixel 5. They come as things come into view, not when a tile loads.
  The pipeline compile that follows runs in the GPU process (50–380 ms there on a Mac)
  and can block the main thread inside `writeBuffer` when the GPU process falls behind
  (one 253 ms stall).
- **three.js reuses a build only for the same node objects.** A node's cache key is its
  `id` unless its type overrides `customCacheKey`, so a material whose node graph is made
  afresh is built afresh, however alike. Make each graph once per variant and let it
  read per-material values with `materialReference(name, type)`, as three.js does for
  `map` and `color` (a texture at your own coordinates: `.context({ getUV: () => uv })`).
  That's what `groundGraph` in `webgpu.ts` does: the ground's builds went from ~70 to ~4
  a drive.
- **Every `InstancedMesh` gets a build of its own:** three.js puts `object.uuid` into the
  render cache key (its instancing nodes bind that mesh's buffers), whatever the
  material. Before pooling, each tile's new tree meshes paid for the tuft shader
  (~14 ms at 1× on an M5, ~60 ms on a Pixel 5), and `CarPool.render` replaced meshes
  on growth. Keep and reuse instanced meshes rather than making new ones. Check
  stable UUIDs/buffers, bounds after reuse, overflow, and shared-resource disposal.
  Don't patch the key: a shared build would bind the first mesh's buffers.
- **Tile loading itself is cheap on the main thread** (each lap of `make` 1–30 ms; the
  graph merge under 1 ms). The workers and the sky view take 100–500 ms, off it.
- **Chrome's CPU throttling slows only the page's main thread**, not the tile workers or
  the GPU process, so `--cpu 4` shows JavaScript costs but hides contention. On a Pixel 5,
  frames also swell while tiles load (render ~17 → ~30 ms, no build involved). With 1 tile
  worker instead of 3, about half as many long tasks without a build, but a tile takes
  2–3× as long to arrive.
- **`--stalls`** (`scripts/bench-stalls.js`) prints what each long task was: builds (a new
  entry in `renderer._nodes.nodeBuilderCache`, sorted by kind of object), pipelines,
  uploads, new buffers, tiles finished (with their laps) and the world's slow updates,
  then the same counters for the frames outside long tasks. Start there.
- **`renderer.render` is called more than once a frame:** three.js renders the shadow maps
  from inside the main render (`ShadowNode.renderShadow`), and the lamps' light map is a
  render of its own. Count frames at the outermost render of `__drive.scene`, and add
  the render times up per frame. (Until 30 September 2026 the bench averaged them per
  call, so its `render` read about half the real time.)
- **A Chrome trace** shows what ran inside a stall, including the GPU process: from a
  browser CDP session, `Tracing.start` with `transferMode: 'ReturnAsStream'` and the
  `disabled-by-default-v8.cpu_profiler` category, then `IO.read` the stream. 40 s is
  ~0.5 GB, one event a line: parse it line by line. Samples from the tile workers are in
  the same process: keep the main thread's `Profile` id only.

### On a phone

`node scripts/bench.mjs --android [serial] --url http://localhost:5196/ --scenes drive
--dpr 1 --stalls` runs the bench on a phone attached over adb (a Pixel 5: Android 14,
Chrome 153, WebGPU on its Adreno 6xx). It passes the dev servers' ports through
(`adb reverse`; the phone's `localhost` is a secure context, which WebGPU needs), starts
Chrome, connects to its DevTools (`adb forward` to port 9333, `--android-port` to
change it), prints the battery temperature after each scene, and removes the port
routes at the end. `--vs` works too. Name the serial (or set `ANDROID_SERIAL`) when more
than one device is attached. The phone's screen size and pixel ratio apply, not
1440×900; `?dpr` still caps the ratio. To change the number of tile workers, fake the
core count: `--init "Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 3 })"`
(3 cores → 1 worker).

- Tracing slows the phone several times over: use a trace to see what runs, not how long.
- The phone warms over repeated runs (battery 33 → 35 °C in eight drives) and gets slower:
  alternate A and B, reverse starting order, record temperature and let it cool if
  the later runs keep getting warmer. Battery temperature is a useful indicator,
  not a direct measurement of GPU throttling. Mac game instances do not directly
  contend for the phone's GPU, though a busy local server can delay asset delivery.
- It's much slower than the M5 at 4×. Until 1 October 2026: ~23 fps on the drive at 1×
  and High (median frame ~33 ms), 40–60 long tasks in 40 s, the slowest 1% of frames
  115–120 ms. Since the wall shader's tables became uniform arrays: about 45 fps
  standing on the Old Town Square and 30–36 fps on the drive at 1× and High, and about
  16 fps standing at 2×.
- **Find out what limits the phone before optimising for it.** Run the same scene at
  `--dpr 0.5`, `1`, `1.5` and `2`: frame time that rises in a straight line with the
  pixels is shading, and the part left at zero pixels is roughly the JavaScript. The
  bench's `js` figure against the frame time says the same. A frame five times its
  JavaScript time is not a main-thread problem, whatever the desktop profile says.
- **A hot phone is a different phone.** At 37–38 °C the Pixel 5's JavaScript took
  28–36 ms a frame, against 16–20 ms at 35 °C. Note the temperature with every result.
- The phone has no GPU timer here (`gpu –`), and vsync holds frames to multiples of
  11.1 ms, so small costs show only in the mean over a window, not in the median.

## Cross-project references

Reviewed on 1 October 2026; use the methods, not the other projects' timings or
renderer policies, as evidence for Streets of Prague:

- `~/projects/quiet-blocks/docs/web-performance.md`: the bloom frame-pacing
  regression, delayed renderer work and separate resource-lifetime workloads.
- `~/projects/quiet-blocks/.agents/skills/quiet-blocks-renderer-performance/`:
  `SKILL.md` and `references/edit-performance.md` cover completed-render staging,
  pending upload ranges, cancellation and retention growth.
- `~/projects/oss/hussite-wars-threejs/.claude/skills/3d-performance/SKILL.md`:
  browser-pane cadence and renderer-counter caveats. Its on-demand idle battle
  loop is not a drop-in policy for this continuously simulated city.

## Before you commit

Type check (`npm run typecheck`), check screenshots against the baseline, and put
the `--vs`/`--ab` numbers and what was checked in the commit body. Update
`docs/performance-log.md` when the picture changes, and `todo.md` "Performance" with
what is left open.
