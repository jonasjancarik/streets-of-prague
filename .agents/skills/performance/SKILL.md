---
name: performance
description: How to measure and speed up Streets of Prague (frame rate, GPU shading, main-thread CPU, tile loading) without fooling yourself. Use when working on performance, frame rate, shader cost, stutter or hitches, when adding anything drawn on every pixel (ground patterns, weather, lighting), or when adding per-frame or per-step work in the simulation.
---

# Performance in Streets of Prague

What was learned measuring and optimising the game (29–30 September 2026, M5
MacBook Air). The state of play and the open items are in `todo.md` under
"Game performance"; read that too.

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
- **One benchmark at a time.** Two headless Chromes loading at once (or a bench plus
  a long `--eval`) push loads past the 120 s limit and skew each other.
- **Warm both A/B states before timing.** The benchmark now does that (`--warmup`,
  2 s each by default). The first cold shadow-off window measured 43 fps before
  recovering above 200, which made the combined average misleading.
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
  grep "Device Utilization"`. The Claude app's browser pane keeps rendering the
  game if it's open on the dev server, and takes most of the GPU. It's the user's,
  so don't kill it: ask them to close it, or rely on `--vs`/`--ab`.
- A hidden browser pane doesn't run `requestAnimationFrame` at all, so the game
  never gets past loading there.
- `--dpr 2` means GPU-bound (fragment cost). `--dpr 1 --cpu 4` stands in for a
  phone's CPU. `--profile` prints the hottest functions, and `--profile-load`
  profiles start-up; the `.cpuprofile` files are written to `/tmp`.
- The GPU timer query's numbers aren't reliable on Metal. Trust frame times.
  Headless Chrome still lines frames up to 16.7 ms slots, so a GPU-bound frame
  shows as 16 or 33 ms. Use the average.
- Before trusting a big speed-up, take a `--shot` (and run with `--extra "&dev"`,
  which prints shader compile errors). A shader that fails to compile draws
  nothing, and nothing is fast: a "3.8× faster" ground was really no ground.
- **Read the console lines the bench prints**, above the numbers. A WebGPU pipeline
  that fails (`Vertex input variable … exceeds the maximum (16)`, `Invalid
  RenderPipeline`) leaves its objects undrawn: fewer triangles, and a frame that looks
  quicker than it is.
- **Count work, not only time.** Counts don't drift with the machine. Wrap
  `renderer.backend.updateAttribute` (bytes: the attribute's, or its `.data`'s for an
  interleaved one, `updateRanges`), `backend.updateBinding`, `backend.draw` and
  `device.queue.writeBuffer` in an `--eval`, let it run 3 s, and divide by the frames
  (`window.__bench.frames`). That's how 3 MB a frame of uploads turned up (see below).
- Anything that should look the same: compare screenshots (`--shot`, `--zoom 0.3`
  for close-ups) and check that the stats match (e.g. the share of dark pixels),
  not that the pixels match. For simulation changes, compare an order-independent
  hash of results (parked car positions) between the servers.

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

## Uploads to the GPU

- **Send only what's drawn**: `send(attr, n)` / `sendInstances(mesh)` in `src/gpu.ts`
  set an update range for the first `n` items and skip empty meshes. Instance buffers
  are sized for the worst case (4000 of a lamp model), and `needsUpdate` alone sends
  the whole buffer.
- **No `DynamicDrawUsage`.** three.js's WebGPU renderer uploads such an attribute every
  frame whether it changed or not, and whole once its ranges are used up.
- An instanced mesh whose matrices fit a uniform buffer (≤ ~1000) is uploaded as a
  uniform buffer every frame it's drawn; past that, as vertex data only when changed.

## WebGPU

WebGPU is the default renderer (`?renderer=webgl` for the old one; see
`src/webgpu.ts`, the `webgpu-port` skill and `todo.md`).
Measure the ground's patterns in either renderer by swapping each ground material
for its `userData.flatten()` (the same ground without the pattern):

```
--ab 'window.__ab = (on) => { window.__drive.scene.traverse((o) => { const m = o.material; if (!m || Array.isArray(m)) return; const u = o.userData; if (!u.patterned && m.userData && m.userData.flatten) { u.patterned = m; u.flat = m.userData.flatten(); } if (u.patterned) o.material = on ? u.patterned : u.flat; }); }; window.__ab(false); window.__ab(true);'
```

Only compare such differences between the renderers, not whole frames: on WebGPU
everything written in GLSL is drawn plain or not at all. There's no GPU timer there.

## Stalls while driving (hitches)

Measured 30 September 2026: the drive from Újezd, 40 s, on an M5 at 1× and 4× and on a
Pixel 5 (see "On a phone" below).

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
  material. Each tile's tree meshes pay for the whole tuft shader (~14 ms at 1× on an
  M5, ~60 ms on a Pixel 5), and a car model's mesh pays when it first appears and each
  time it grows (`CarDrawer.render`). Keep and reuse instanced meshes rather than making
  new ones. Don't patch the key: a shared build would bind the first mesh's buffers.
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
  alternate A and B, and don't compare runs far apart.
- It's much slower than the M5 at 4×: ~23 fps on the drive at 1× and High (median frame
  ~33 ms), 40–60 long tasks in 40 s, the slowest 1% of frames 115–120 ms.

## Before you commit

Type check (`npm run typecheck`), check screenshots against the baseline, and put
the `--vs`/`--ab` numbers and what was checked in the commit body. Update `todo.md`
"Game performance" when the picture changes.
