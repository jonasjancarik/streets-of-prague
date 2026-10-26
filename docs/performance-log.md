# Performance log

<!-- read_when: measuring or changing frame time, shader cost, stalls or tile loading; porting to WebGPU -->

Measurements and findings from the performance work since 27 September 2026, moved
here from `todo.md` on 5 October 2026 and kept as written. What is still open is
listed in [`todo.md`](../todo.md) under "Performance"; how to measure is in the
performance skill (`.agents/skills/performance/SKILL.md`).

On 6 October 2026 the Pixel 5 (Android 14, WebGPU, battery 25.6–32.6 °C) was measured
again on main (`27bc5ef`), one run each unless said, so these are first readings:

- **The bench had been counting too many frames.** The page has other
  `requestAnimationFrame` loops now (the gamepad's polling, the feedback form's frame
  counter), and `bench.mjs` took each callback for a frame: twice the frame rate, a
  median frame of 0.0 ms and half the JavaScript time. It now counts a callback only
  if `renderer.render` ran in it. Phone and desktop figures taken between the day
  those loops arrived and this fix are suspect. `--dpr tier` leaves `?dpr` out, so a
  tier's own pixel ratio applies (with `?dpr` Auto can't scale the ratio).
- **Auto on a touch device doesn't hold Medium.** Driving east from the Old Town
  Square, Auto began at Medium (1.5×), went to Low after 3 s and to Lowest after 8 s
  (30 °C). Standing on the square it had settled on Low (1×) before timing began and
  stayed there for 60 s at 63 fps. Fixed tiers, 30 s each: Medium 39.8 fps standing
  (median frame 22.3 ms, 95th 44.6) and 22.7 fps driving (33.4 / 111.4 ms); Low
  61.6 fps standing (11.2 / 33.4 ms) and 36.3 fps driving (22.3 / 55.7 ms). JavaScript
  was 14–16 ms a frame standing and 19–20 ms driving on both, so at 1× the drive is
  limited by the main thread and at 1.5× by pixels as well. Starting touch devices at
  Low would spare the two step-downs; that is a decision about the look.
- **Sun shadows cost about 4 ms a frame at 1×**, High, standing on the square
  (`--ab` on the sun's `castShadow`: about 62 fps without, 50 with, 28.7 °C), not the
  11 ms estimated on 1 October. Three of twenty windows drew 0–2 frames (the switch
  rebuilds shaders), so the bench's own mean is useless for this run; the figure is
  from the windows that ran.
- **Trees (plan 017's opening measurement):** in the Petřín woods at 1×, High, hiding
  the tree pages took a frame from 28.9 to 12.6 ms, and stopping them casting shadows
  from 28.6 to 20.8 ms; an unchanged-build control differed by 1.1%. At the garden
  suburb: 17.6 to 13.8 ms hidden, 17.8 to 16.2 ms without their shadows. JavaScript
  moved by 1–3 ms, the rest is the GPU. So trees are over half the frame in a wood
  and their shadow pass alone over a quarter; in a suburb about a fifth and a tenth.
  The low-detail crown swap wasn't measured.
- **Long tasks on the drive** (40 s, High, 1×, 31.9–32.6 °C): 28 over 50 ms. In them
  `traffic.update` took up to 11.7 ms (three times over 10), `trams.update` up to
  7.5 ms and `crowd.update` up to 5 ms; six held a shader build of 29–56 ms. The
  20–24 ms `crowd.update` spikes seen on a warmer phone didn't appear at this
  temperature. 35.1 fps, median frame 22.3 ms, JavaScript 20.4 ms.

Plans 007–011 and plan 012 Part A are selected for main; see
[the findings and merge summary](optimisation-findings-007-012.md). Part B
(the incremental resting-car index) stays experimental: it was consistently 3.5%
slower per frame on desktop despite fewer index updates. Main retains the original
collision index. An isolated retest is pending (see plan 012's follow-up); competing
game instances have not been established as the cause of that result. No general
FPS improvement is established for this set.

Tile loading also handles return visits while earlier mesh work is still pending:
each tile object owns its scheduling entry, so an old completion cannot erase the
replacement's work or mark streaming idle. A successful rebuild removes its old
failure cooldown. With `?ortho`, prefetched photos outside the retained tiles and
live builds are discarded, including images that finish downloading later.
`node scripts/check-tile-lifecycle.mjs` covers these cases without a renderer.

The Mist developer controls now offer a second, optional WebGPU mode: separate
low raymarched volumes with 3D noise and opaque-depth clipping. It uses the full
game resolution and 12 samples by default; half-resolution rendering remains
unimplemented. A short 3 October A/B at 2×, High, 14:00 compared layered banks
with volumes: Old Town Square 5.8/5.8 ms, river 6.1/6.8 ms. Window-to-window drift
was substantial, so these are preliminary costs, not a resolved performance
comparison. The targeted depth/stencil, inside-volume, MSAA and resize checks pass
(`scripts/check-local-mist.mjs`); phone cost has not been measured.

River mist now follows water polygons, broadens to overlapping banks and uses
three times the density over the surface, tapering along the shore. The added
water-surface and shoreline regressions pass. A short 2× High WebGPU A/B near
Charles Bridge measured 13.3/14.2 ms with river emphasis off/on; this single run
is an approximate cost check, with phone cost and a clean repeated comparison
still unmeasured.

Landmark colour warming now has a pipeline conversion and a browser marker check
(`plans/010-prebake-landmark-colours.md`). The original GLBs remain the live assets;
the staged `.warm-v1.glb` files passed local visual and cold-load checks. Activate
them only after the new client is live.

`scripts/bench.mjs` measures frame times in Google Chrome (headless, on the GPU) at
fixed places; `--vs` compares with another server taking turns, `--ab` switches a
change on and off within one page. Neither removes changing background contention:
use one active game instance, reverse the starting order for small differences,
and check an unchanged build against itself when results are noisy (see the
performance skill). `--cpu 4` slows the main thread, not the workers or GPU, so it
does not reproduce a whole phone. After the work of 29 September 2026 (noise from a
texture, the ground's broad variation baked per tile, cheaper stones, the ground
shaded once a pixel, less per-frame bookkeeping), at 2× on an M5 in Chrome: 32–41%
less time a frame than before it, and 32–42% less with the CPU slowed 4× at 1×.
Still worth checking on a real phone.

On 1 October 2026 the Pixel 5 turned out to be limited by pixels, and by one thing in
them. At the Old Town Square a frame took about 17 ms plus 28 ms for every 1×-screen
of pixels (22 ms at 0.5×, 45 at 1×, 78 at 1.5×, 128 at 2×, High). Swapping pieces of
the building material in and out on the phone found nearly all of it in the wall
branch of the buildings' colour graph: its five facade lookup tables were TSL arrays
with `.toVar()`, which three.js writes as WGSL variables filled in again for every
pixel. The Adreno driver handles that very badly; a Mac shows no cost. As uniform
arrays (`b978d56`): 142 → 61 ms a frame standing and 163 → 69 ms driving at 2×, and
about 45 fps standing at 1× (21–23 ms, of which JavaScript 16–20 ms) on a phone at
35 °C. A hot phone (37–38 °C) is slower by half again, in JavaScript. Also measured
there at 1×: sun shadows about 11 ms, MSAA 2 ms, the sky's shading of walls 2 ms,
ground patterns 1 ms; the roof patterns, branches a pixel doesn't take and the
cutaway's `discard` nothing measurable; hiding the trees nothing. Open:
- Touch devices start Auto at Medium (1.5×). With the shader fixed, check on the
  phone whether that holds 40 fps or still steps down to 1×.
- Sun shadows are now the largest single piece of shading on the phone.
- The crowd in a worker (plan 019) gave no gain on the M5 or, after the shader fix,
  on the phone; shelved on its branch.
- The same check on another phone GPU (Mali, Apple) would say whether this was
  Adreno's alone.

On 30 September 2026 (WebGPU, the default now) the main thread, not the GPU, was
the limit on an M5 at 2×. Fixed then: the lamps re-gathered every frame (their cache
check never held), instance buffers went up whole, and DynamicDrawUsage makes
three.js's WebGPU renderer upload a buffer every frame: 3.0–3.5 MB a frame of
uploads down to ~0.2 MB. The crowd is drawn and animated only in view. Open:

Tree rendering now leases retained pages by tile and shape (1,200 broadleaf or 128
shrub/conifer instances). Startup prepares a finite envelope (30 broadleaf, 20 shrub,
24 conifer pages); later tiles
reuse their mesh UUIDs, attributes and shader bindings. A denser view can grow the
pool without thinning trees. See plan 009 for the measured startup, visual and drive
checks; WebGPU uniform instance buffers may still upload on a drawn frame even when
the application has not marked an attribute dirty.
Startup also draws the prepared pages once behind the loading screen so later tree
shadows use the same retained render objects.
Three controlled drives recorded zero tree shader builds and zero pool growth after
startup. Frame-time comparisons under heavy machine load did not establish an overall
speedup; see plan 009 for the paired results. A Pixel 5 or quieter desktop run would
be useful before claiming a player-visible frame-time improvement.

The tiers now control MSAA, sun shadow size, roof detail and the crowd cap too:

| | High | Medium | Low | Lowest |
|---|---|---|---|---|
| Pixel ratio maximum | 2 | 1.5 | 1 | 1 |
| WebGPU MSAA | 4 | 4 | 4 | 0 |
| Sun shadow map | 2048² | 2048² | 1024² | 1024² |
| Dirt, grime, small leaves, tone curve | On | On | On | Off |
| Roof detail (tiles, gravel, weathering) | On | On | On | Off |
| Car shadows in lamplight | Full (2) | Soft (1) | Soft (1) | None (0) |
| Maximum crowd | 1200 | 1200 | 1200 | 600 |

Auto still starts High (Medium on touch devices) and steps by frame time. `?dpr`
changes only resolution. Lowest retires surplus people out of sight; the 330 m
simulation radius stays the same. Ground patterns and facade pictures stay on to
keep the street surfaces and buildings readable. Sun shadows stay on for the same
reason; halving their map saves three quarters of its texels, with little measured
frame-time benefit here. Detail goes only on Lowest as an option for weak GPUs;
the smaller crowd cap also gives Auto a CPU-saving step on 1× screens.

WebGPU costs on 30 September, M5, Chrome 154, 1440×900 at 2×, High, clear 14:00:
32 s `--ab`, 2 s windows, one process at a time. Values are added milliseconds per
frame, feature on minus off; a negative small difference is noise. These supersede
the old WebGL costs below.

| Feature | Old Town Square | Malá Strana |
|---|---:|---:|
| MSAA, 4 samples vs none | +0.20 (+6.1%) | +0.49 (+8.7%) |
| Sun shadows, on vs off | +1.18 (+27.8%) | +1.56 (+34.3%) |
| Shadow map, 2048 vs 1024 | +0.05 (+0.9%) | −0.04 (−0.6%): noise |
| Dirt and grime | −0.14 | −0.21: within 3% noise |
| Facade pictures | −0.02 | +0.04: within 1% noise |
| Ground patterns vs `flatten()` | +0.70 (+11.8%) | +0.57 (+8.7%) |
| Roof tiles and weathering | +0.06 | −0.17: within 2% noise |

Small leaves in Petřín: +0.02 ms (0.4%, noise). At 22:00, Old Town Square / Karlovo
náměstí: full car shadows over soft −0.02 / +0.11 ms (within 2%); soft over none
+0.24 / +0.06 ms (4.1% / 1.0%). These CPU-limited results do not establish how
cheap detail will be on another GPU. GPU use was 6% before the batch; Spotlight
later used a core and CodexBar rose to 46% CPU, so CodexBar was quit as authorized.
Within-page alternation controls drift better than comparing the absolute rates.

MSAA needed a correction: `_samples` alone produced byte-identical screenshots,
because the tone-mapping target retained its startup sample count. `Graphics` now
updates the cached canvas target too, without disposing it. Matched zoomed images
at 1× and 2× show smoother edges. Shadow resizing also required refreshing material
render caches to release stale depth-texture bindings. Repeated lowest/high/low/
medium switches pass on both WebGPU and WebGL, with actual map sizes and GPU sample
counts checked. MSAA and sun-shadow costs above were repeated with both paths warmed
and no console errors; the cold shadow window and target-disposal runs were discarded.

Before/after: `cac0d0b` against the perf snapshot with these tiers, High, clear 14:00,
1440×900, `--vs --runs 2`, stand / drive / strana. Mean milliseconds per frame
(mean of each run's reciprocal fps); positive change means more time:

| Scene | 2× before → after | Time change | 1×, CPU slowed 4× | Time change |
|---|---:|---:|---:|---:|
| Old Town Square, standing | 5.40 → 5.57 | +3.1% | 12.42 → 7.28 | −41.4% |
| Drive from Újezd | 5.32 → 5.45 | +2.3% | 11.15 → 9.85 | −11.6% |
| Malá Strana | 7.95 → 6.76 | −14.9% | 13.67 → 8.37 | −38.8% |

The 2× stand/drive differences are small relative to run-to-run drift; this does not
show a consistent 2× speedup. The slower-CPU gains repeat in both rounds. All 24
completed comparisons used WebGPU and had no console errors; no fallback or aborted
run was averaged. Most loads took 13–16 s; one baseline device wait took 83 s.

Baseline qualification: `cac0d0b` is not runnable unchanged: `people.ts` imports
`fences.ts`, absent from that commit. The comparison-only baseline added an empty
`fences.blocks()` shim returning false, matching its lack of fence meshes/sections.
Its sources otherwise stay at `cac0d0b`; the later fence implementation was not
backported. The current perf branch includes the subsequent fence feature too.
Chrome runs were isolated with `--fresh-browser`. The remaining second-round 2×
drive/strana pairs and all CPU-4× pairs used a loading-only RAF heartbeat, equivalent
to `--loading-frames`; it stopped before sampling. Completed pairs were preserved
when startup hung. Raw results and console logs are under `/tmp/perfab`.

Open:

- **Loading stall located:** reproduced beyond 120 s at `Preparing graphics…`, with
  the adapter ready, `GPUAdapter.requestDevice()` pending and no outstanding network
  requests. It occurs even in a fresh Chrome process; tiles and shader compilation
  have not started. Startup now bounds the adapter request at 5 s and renderer
  initialization at 15 s, then uses the legacy WebGL renderer. GPU material factories
  are installed only after successful initialization, and any device that arrives
  late is released. Forced never-returning and delayed-device checks both completed
  loading in ~18 s, with no console errors. The underlying browser/driver reason
  remains open. `--load-progress` identifies future waits and `--require-webgpu`
  prevents a fallback from being reported as WebGPU performance.
- **Simulating fewer people far away** (a crowd radius round the view, not 330 m)
  halved the people in view, since the crowd bunches round you: tried and dropped.

Earlier WebGL measurements, at 2× standing by the Old Town Square (switched off
one at a time with `--ab`; these are not the current WebGPU costs): the ground's patterns about 29% (the mosaic's stones 14%; the dirt on
the paving was 12% until 30 September 2026, when it was baked into a texture: now under 1%), shadows on the ground 11%, roof tiles 12%, the facade pictures 7%,
grime on the walls 6%, the shadow map's own pass 7%.

- **WebGL MSAA costs about a fifth of a frame at 2×** (57 → 71 fps without it, Chrome on
  an M5). At a pixel ratio of 2 the jagged edges are small. The renderer picks
  antialiasing once, when it's made, so leaving it out at 2× (or in some graphics
  tiers) means either choosing at start or drawing into a multisampled render
  target that Auto can switch, with a pass to the screen after. A decision on the
  look first. (Playwright's own Chromium makes MSAA look far costlier, 4.5× a
  fragment against Chrome's 1.5×: benchmark in Chrome.)
- **The mosaic's stones** are a texture on WebGPU since 30 September 2026
  (`src/webgpu/mosaic.ts`), one read a pixel instead of the stones worked out anew,
  which cost 14% of a frame on WebGL; not measured on WebGPU yet. The WebGL renderer
  still works them out. Laying the old Prague patterns along the kerbs was tried
  (branch `mosaic-ornaments`) and set aside: the pavements' and roads' shapes break
  them up at every junction and parking bay.
- **Ground overdraw** is gone: the stencil lets only the top solid layer shade a pixel
  (1.4–2.1 layers a pixel before). Apple's GPUs skipped covered pixels on their own,
  so it measured the same on a Mac; the gain is for GPUs that don't, untested. The
  ground under buildings is still shaded where a GPU doesn't skip it: drawing the
  ground after the buildings would need the tunnels' contents to be drawn after it
  too.
- **Street and lamp indexes forget distant tiles.** The drive/walk graphs, street
  names, crowd and police indexes keep the loading radius plus 500 m, with extra
  tiles around vehicles still following routes. Lamps follow the same tile keys:
  street directions, cable anchors, generated lamps and posts, queued fills and
  bridge candidates retire with their last owning tile. Shared tiles retain their
  lamps and valid survey cable anchors. Generated lamp slots are reused, so their
  arrays retain peak simultaneous capacity rather than every place ever visited.
  The map's survey lamps remain resident and retain their damage; generated posts
  reset after all their tiles have been forgotten. Generated lamp colour is based
  on position, so reusing slots does not change it on return. Newly loaded streets
  also invalidate cached arm directions, allowing a nearer street to orient a lamp.
  `node scripts/check-lamp-forget.mjs` covers 500 synthetic tile visits, shared
  ownership, return visits, delayed downloads and bridge posts without a browser;
  `node scripts/check-graph-forget.mjs --km 8` compares real map graphs and police
  routes. These are lifecycle checks, not frame-rate measurements.
- **three.js's WebGPU renderer** (the default since 29 September 2026, `src/webgpu.ts`; the old WebGL renderer
  and the GLSL stay unmaintained at `?renderer=webgl` until they're deleted). The ground, the tone curve, the buildings,
  the trees and the lamps' light (on the ground with the wet ground's mirror, the buildings,
  landmarks, trees and poles) are ported (to TSL); the ground's soft shading is ported too (+0.7 ms on WebGPU
  against +0.2 ms on WebGL, Old Town Square, 2×; about 10% stronger on WebGPU because it blends
  before the tone curve); the cars, trams, funicular and boats are ported (+0.0–0.4 ms on WebGL against +0.8–1.0 ms on WebGPU, Old Town Square and the drive, 2×, GPU about 80% busy); the people are ported too (+0.1–0.3 ms on WebGL against −0.1–+0.3 ms on WebGPU, same scenes); the lamp and signal glows, spray, fire and skid marks are ported too (colours matched by eye, see the skill file); rain, snow and mist are ported too (much fainter at night on WebGPU); everything is ported now. Whole frame at 2×, WebGL against WebGPU, frames a second (Old Town Square standing and walking, Petřín woods, drive from Újezd): clear noon 154/144, 145/137, 160/167, 115/131; rain at 22:00 119/123, 129/139, 154/153, 120/136 (the GPU was 78–91% busy from other apps on WebGPU runs, 21–80% on WebGL, so not a fair race). Trees cost +0.5 ms a frame on WebGPU against +0.6 ms on WebGL (Petřín woods, 2×;
  the GPU was 52% busy before). Open: some low buildings show no windows by day on WebGPU
  where WebGL does (the tile north-east of the woods start). Buildings cost 0.6–1.4 ms a frame on WebGPU against 0.7–1.3 ms on WebGL
  (`--ab`, 2×, Old Town Square, the drive from Újezd, Karlovo náměstí; the GPU was
  17–20% busy before each run). The lamps at night cost +0.7–0.8 ms a frame on WebGPU
  against +0.2–0.5 ms on WebGL (Old Town Square, Karlovo náměstí, glows not included).
  Open: fog looks stronger on WebGPU in rain and snow
  (it is probably mixed in before the tone curve, where the game means it after). The same ground patterns cost about half
  as much there: switched on and off with `--ab` at 2× on an M5, +1.2 ms a frame
  on WebGPU against +2.4–3.1 ms on WebGL (Old Town Square, Karlovo náměstí,
  Petřín), with another app keeping the GPU 70–80% busy. Headless Chrome with `--disable-frame-rate-limit` never
  finishes `compileAsync` on WebGPU (webgpu.ts gives up after 10 s).
- **Sky view** (`src/map/skyView.ts`, 30 September 2026): how much sky each spot sees, baked per tile in the
  worker and applied to the ambient light only. Loose ends: the wall values are made once, so a wall at a tile's
  edge doesn't learn about a neighbour that arrives later (the ground's texture is refreshed); landmarks have no
  sky view; `fill()` could skip buildings far from the tile instead of testing every one.
- **Cloud shadows** (`src/clouds.ts`, `src/webgpu/clouds.ts`, 30 September 2026): one 256² tiling rank map read once a
  pixel, drifting with the wind, dims the sun only (never the sky's light or the lamps). WebGPU swaps the sun's light
  node (`CloudSunNode`); the GLSL path multiplies `directDiffuse` in `lampLit`. Strength comes from `Sky.update`: none at
  night, under cloud, in mist, rain or snow. `&nocloud` leaves them out. Cost is within the noise of the bench.
  Loose ends: at gameplay zoom (~100 m) a patch is ~340 m across, so most frames sit fully inside or outside one and it
  reads as a slow brightness drift; the edges show when zoomed out. Patch size and coverage (`CLOUD_EDGE`, the octaves in
  `makeMap`) are tunable. Trees have no cloud shadow on the GLSL path, and the wet ground's mirror ignores the mask.
- **Roof weathering** (`roofWeather` in `src/shading.ts` and `src/webgpu/buildings.ts`, 30 September 2026): moss in clumps
  (more on north slopes), dark streaks running down each face and stains, on top of whatever colour the roof has, so it
  stays valid when plan 005 changes the colours. The per-building number comes from the roof's colour (roofs carry no
  building id). Flat roofs get little. It adds about four noise reads on roofs.
  The WebGPU roof-detail A/B above includes the tile pattern and weathering together;
  their net cost here is within 2% noise. Deferred, needs a decision: roof clutter (chimneys, vents, dormers, aerials); moss barely shows on red clay, so
  strengthen it if wanted; landmarks use their own roof and are not weathered.
- **What's left on the main thread** (the supplied profile after the upload and crowd
  fixes, with the CPU slowed 4×): the crowd's `spot` / `follow` / `avoid`, `simulate`,
  `traffic.update`, `trams.clearAhead`, then `writeBuffer` (~6%, uniform buffers of
  ~160 KB a frame and ~1200 figure matrices).
- **Spawn sampling** (plan 011): pedestrian and ordinary-traffic weights are reused
  within each replenishment pass, and pavement-driving cars are gathered once per
  simulation step. `scripts/check-spawn-work.mjs` compares the selectors and their RNG
  calls with the previous loops. The `--stalls` report separates preparation,
  spawning and update totals. Two three-run alternating drives gave opposite
  frame-time results, so there is no confirmed timing benefit; see plan 011.
- **Stalls while driving** (30 September 2026; details and how to measure them in the
  performance skill). The 50–100 ms stalls on the drive from Újezd are mostly three.js
  building shaders for things drawn for the first time (~180 builds in 40 s: 0.7 s at 1×
  on an M5, 2–4 s at 4×, 1.4 s on a Pixel 5), plus the GPU process compiling their
  pipelines, which once held the main thread 253 ms in `writeBuffer`. Tile loading on the
  main thread, the street-graph merge and parking are small. Fixed: the ground's layers
  now share one shader per kind of layer across tiles (ground builds ~70 → ~4 a drive on
  the M5, 16 → 2 on the Pixel 5). `--vs --runs 2 --fresh-browser`, 4×: long tasks 9, 11 →
  3, 3; 10.4, 10.2 → 9.2, 9.4 ms a frame; build time 2.0 → 0.8 s; and `writeBuffer`
  calls ~630 → ~360 a frame. At 1× no change beyond drift. On the Pixel 5 the time in
  long tasks with a build fell from 2.5–2.7 s to 1.2–1.8 s a drive, but its slowest 1% of
  frames stayed at 115–120 ms (the frames below). The phone draws the drive at 1× and
  High at ~23 fps (median frame ~33 ms; before the wall shader's tables were fixed on 1 October). Plan 007 now shares the complete building,
  landmark, cutaway and lamp-light graphs across equivalent materials. Its IPR and OSM
  binding checks pass. In three alternating 4× WebGPU drives on the M5, the mean frame
  time was 15.3 → 13.0 ms, but individual pairs disagreed (11.2 → 13.9, 20.1 → 12.7,
  14.5 → 12.4 ms), total material builds were 339 → 344, and no new building shader
  builds appeared in the stall logs. The timing benefit is inconclusive; details and
  matched visual checks are in `plans/007-share-building-shader-graphs.md`. Open,
  biggest first:
  - **Tree meshes:** plan 009 retains and warms pages, including shadow variants.
    Final comparison drives had zero tree builder events and zero pool growth.
    A quieter desktop and real-phone comparison remain useful before claiming
    an overall frame-time or startup benefit.
  - **Car models:** plan 008 introduced ordinary-model preparation during loading,
    hidden empty pages and retained 16-car pages instead of replacing live meshes.
    The measured dense taxi and hatchback colours reserved a second page. On a 40 s drive,
    car-body builder events fell from 74–76 to 13–15 with no overflow; the paired
    frame times averaged 13.8 → 13.5 ms, too close and variable for a firm speedup
    claim. Benchmark loading took about 0.8 s longer and 164 prepared pages reserved
    168 KB of matrices. Late colours and burnt bodies could still build once. See
    [plan 008](../plans/008-prepare-car-meshes.md) for tests and trade-offs.
    Plan 015 now separates paint from body geometry on both renderers, retaining
    128-car pages per type and courier-box variant. Car-body draws fell about 84%
    on the counting drive (72 → 12 per pass) and 81% standing (36 → 7), with no
    overflow or late pages. Pool checks, palette/wreck equivalence, seeded and
    parked-car hashes, WebGPU day/night/snow screenshots and the build passed.
    Both renderers passed day/night/snow screenshot comparisons. Three alternating
    drive pairs favoured the change (12.7 → 9.6 ms/frame), but loading-time drift
    and the lack of an unchanged-build control leave the timing benefit provisional. See
    [plan 015](../plans/015-paint-cars-per-instance.md) for evidence and limits.
  - **Worker scheduling:** plan 012 Part A prioritizes required jobs, allows one
    job per worker and coalesces optional sky refreshes. A refresh rejected before
    dispatch (for example, when no worker could start) waits for a new neighbour
    change before retrying; it cannot spin through rejected promises. The offline
    `node scripts/check-sky-refresh.mjs` covers unavailable workers and a queued
    refresh losing its last worker. Desktop and Pixel 5
    comparisons had no missing player/ahead-tile frames. Frame-time differences
    were inconclusive; keep the existing worker count.
  - On a warm Pixel 5 there are also 20–24 ms spikes in `crowd.update` and 12 ms in
    `trams.update`.

## Weather and night

Measured on 29 September 2026, 2× on an M5 in Chrome, standing by the Old Town
Square, rather noisy: rain, a storm and mist about 10–15% more a frame than a clear
day, snow about 20%; night about the same as day.

## Garden trees

The scattered garden trees and shrubs roughly doubled the triangles in view in a
garden suburb (0.57 M → 1.19 M near Na Slatinách). Shrubs now have a mesh of their
own, 92 triangles instead of the crown's 340 (30 September 2026): 1.22 M → 1.06 M at
a fixed spot there, on both renderers. A park spot with no shrubs didn't change
(0.38 M). It didn't show in frame time: on a Pixel 5 (WebGPU, 1×, `--android --vs`,
three pairs) 24.7 → 25.0 ms a frame with 15 ms of JavaScript, so that phone is
CPU-limited; on the M5 the pairs were too noisy to read (the machine was busy, the
new build always ran second, and one run fell to 37 fps). The cost is per tree and
per mesh, not per triangle.

## Road markings

17 October 2026: lane, edge, parking and zebra paint now uses sports lines' existing
minimum of 1.6 drawing-buffer pixels. Physical widths and dash lengths stay unchanged
nearby; rails stay physical. Legacy WebGL intentionally gains the same minimum by
reusing its existing `held()` implementation, with no GLSL changes. At the National
Museum, matched top-down 50/120/260 m views on both renderers showed unchanged close
widths and clearer distant lines; a roughly 15% road slope showed no lost paint edge.
Different-width strips, camera/viewport changes and disposing one material while
another remained all passed. `check-ground-areas.mjs` checks ground, parking, zebra,
bridge/tunnel paint, terrain vertices and transferable buffers; eleven terrain-seam
checks and typecheck passed too. Raised bridge/tunnel paint has CPU coverage here,
not a new live visual check.

The original physical-paint baseline shared one builder state in the measured view.
The first candidate, enabling hold without sharing, created ten states (50–59 ms
total on transitions): each
material had its own identical position graph. Sharing that complete graph in
`webgpu.ts` keeps the final candidate at one state, preventing that added compilation
work rather than improving on the original baseline. Nine real tile inputs retained
identical positions, normals and indices; their added attributes totalled 158,196 B
(4,656–26,304 B/tile). Twenty warmed, alternating CPU builds per state measured
0.05–0.28 ms more at each tile's median (summed medians 126.46 → 128.05 ms).

Eight warmed 1.8 s WebGPU windows compared the original materials with their held
position graph disabled/enabled, excluding transitions. Paired values below are in
that physical/held order. Both states drew 117 calls
and 779,306 triangles/frame; attribute updates averaged 4.52/4.53 calls and
34.1/38.1 KB/frame, queue writes 45.02/45.04 calls and 235.1/235.3 KB/frame. These
whole-scene uploads include changing simulation buffers. Frame intervals were
8.29–8.31 ms, while render CPU means varied 1.23–1.85 ms. GPU utilisation was already
49% before our browser and 69% after closing it: timing cannot establish an overall
cost or FPS change. Source HEAD/diff, raw samples, worker inputs and valid captures
are in `/tmp/sop-paint`; initial black-paint material-clone captures are invalid and
excluded. No phone benchmark or full scenario rerun was needed for this rendering
change.

## Plans 032–036 (25–26 October 2026)

Five reductions of repeated per-frame work, implemented on main in plan order and each
measured against the commit before it on the M5 MacBook Air (headless Chrome,
WebGPU, 1×, High, 14:00 unless said, clear, `--cpu 4`, 40 s windows). The machine
was not quiet: other apps held the GPU at 56–78 % throughout. Each change was timed
at the function it touches, by wrapping it in `--eval`, because whole-frame pairs
swung by up to ±13 % between runs of the same build:

| Plan | What no longer happens every frame | Function, a frame, old → new |
| --- | --- | --- |
| 032 | Parked four-wheelers sampling the ground under four wheels and rebuilding their matrix | `CarPool.render` 0.82 → 0.47 ms on the drive (in-page A/B), 0.11 → 0.09 ms standing |
| 033 | Traffic lights rewriting and re-sending unchanged glows and lamp colours | `Signals.update` 0.024 → 0.012 ms on the drive (0.021 → 0.007 at 22:00); 3–4 fewer attribute uploads |
| 034 | Every traffic car building its lane ahead, and every piece's length per parked-car circle | `Traffic.update` 1.32 → 1.14 ms on the drive, 0.60 → 0.57 ms in the suburb; identical traces |
| 035 | Sorting tile queries used only as sets; re-selecting tiles for the very same view | `TileWorld.update` 0.070 → 0.022 ms standing, 0.100 → 0.088 ms on the drive |
| 036 | Stepping the city with zero time behind a modal | traffic and crowd updates ≈0.95 ms → 0 while settings are open |

None of the five on its own gave a whole-frame difference that held when the run order
was reversed. All five together (`c1000f3` against `e8c95bb`, stand/drive/suburb,
3 pairs in each order, `--stalls`): standing on the Old Town Square the new build was
quicker in all 6 pairs (by 1.4–7 %), on the drive in 4 of 6, in the garden suburb in
about half. The 99th percentiles, long tasks (0–4 a run on the drive, on both) and tile
arrivals (6 built, 6 drawn on the drive) didn't change. A same-build control wasn't
run, so the standing result is suggestive rather than established. Plan 035's
selection cache can only hit when the camera is exactly still; while moving, only its
unsorted retention queries help. The details, checks and commands are in each plan's
Result.

## Tree shadow experiment, 26 October 2026

`?treeShadows=simple` keeps the full visible crown but draws an eight-point tuft rim
in the shadow pass, reusing the same vertices, shaders and instance buffers. Normal
broadleaf shadow triangles fall from 340 to 148; big crowns from 564 to 292, with no
extra draw calls. Shrubs and conifers are unchanged. The additional shared indices
occupy 2,640 bytes. Full shadows remain the default.

On the Pixel 5, WebGPU, High, DPR 1, clear 14:00 in summer, alternating warmed
four-second windows gave about 26.4–26.5 → 29.8–30.0 fps in woods and
32.4–32.7 → 35.9–36.2 fps in the suburb, with the gains repeating in reversed order.
That is roughly 9–12% less frame time, against a 2.2% unchanged-build control.
One winter woods comparison gave 19.9 → 23.2 fps; its reverse is unmeasured.
Verified driving comparisons disagreed, so no driving improvement is established.
Desktop comparisons favoured the mode by 1.7–2%, but background GPU load was high
and the order was not reversed; no firm desktop gain is claimed.

Build/typecheck, topology/range recovery, all-season and snow renderer checks on
WebGPU/WebGL, retained-page checks in both modes, and the tunnel-layer scenario
passed. The visual checks found close top-down results with coarser shadow edges;
visible crown geometry and the seasonal twig mask remain intact. Keep the experiment
opt-in pending stronger route/desktop evidence. Raw windows, limitations, screenshots
and exact reproduction instructions are in
[the evidence record](evidence/tree-shadows-2026-10-26/README.md).
