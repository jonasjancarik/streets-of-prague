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
occupy 2,640 bytes. Full shadows were the default during this experiment.

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
visible crown geometry and the seasonal twig mask remain intact. The initial
recommendation was to keep the experiment opt-in pending stronger route/desktop
evidence. Raw windows, limitations, screenshots
and exact reproduction instructions are in
[the evidence record](evidence/tree-shadows-2026-10-26/README.md).

Later on 26 October, the user approved the comparison images and requested simpler
shadows by default at every tier, including Ultra. That policy is now active;
`?treeShadows=full` opts into the original detail, and `?treeShadows=simple` still
explicitly selects the simpler mode. This adoption does not resolve the timing
limitations recorded above.

## Driving hitches on new and revisited streets, 26 October 2026

What makes the long frames when the drive reaches new streets, measured on the
Pixel 5 (Android 14, Chrome 155.0.8059.84, WebGPU), High, DPR 1, 14:00, fixed clear
weather, the date's own season, with the default simpler tree shadows. Map
`praha_now` format 2, built 2026-10-24T17:43:55Z (pipeline `89d590d47d-dirty`).
Code at `2fbfc15`, served from detached worktrees, one game on the phone. The route
is the bench's drive (lane assist east from Újezd, then south): 120 s with
`--again-at 60`, which puts the car back at the start to drive the same streets
again, so the second minute revisits tiles that were undressed or dropped.

The new tooling: `bench.mjs --hitches` records every frame from the end of loading,
before the player gets in, with no settling (cold first visits);
`scripts/bench-hitches.js` keeps node builds (flagging keys three.js had evicted),
pipelines and programs made or released, time in `createRenderPipeline`, submits and
`writeBuffer`, buffers and textures made and destroyed, the simulation updates, each
tile's laps, undress and drop, tile arrival (first wanted drawn → drawn) and long
animation frames with their scripts. `scripts/hitch-report.mjs` charges each hitch to
the frame before, the tasks between and the frame itself, keeping those kinds apart
(`--table` compares runs). The bench now waits for the seat after E instead of
checking 300 ms later, when the entry animation is still playing. `scripts/time-parking.mjs`
times parking per tile without a browser and prints a hash of the parked cars.

First readings, two cool runs (30–31 °C): about 30 fps, frame intervals median 22.4,
p95 66.8, p99 89 ms, 27–29 intervals over 100 ms in 120 s (9–15 once the warm-up
below has finished). Most 50–70 ms intervals are the phone's ordinary pace on this
drive, not hitches. What the longer ones were:

- **A tile finishing `make()`: 110–220 ms.** The worker's reply runs the rest of
  `make()` in one task (a long animation frame of ~190 ms, script
  `tileWorkers.ts`): the `meshes` lap (up to 24 ms) and the `parking` lap
  (92–177 ms). About one per new tile, 3–5 over 100 ms in two minutes of this
  route. A phone CPU profile put `parkCars` at 754 of 1,041 ms of `make()` in a 60 s
  drive: `parkingClearance` (building the lane-clearance index, with the bus and
  pickup sweeps added 3–18 October) 296 ms, and its queries in `place` 162 ms.
  Offline on the M5 it is 12–21 ms a route tile, the index 5–12 ms; the 30 September
  finding that parking is cheap predates the clearance work.
- **Returning to streets left behind: one 0.65–1 s shader build.** When a tile is
  undressed, three.js drops a node builder state once no render object uses it
  (`NodeManager.delete`, `usedTimes` 0), and builds it again on the next draw. In
  each of three baseline runs, 26 states were evicted and 5 rebuilt on the second
  pass, always the same: a building material (`MeshLambertMaterial`,
  `[position,normal,color,drapeUv,facade,sky]`) 652, 981 and 804 ms, three ground
  layers 27–184 ms and one `MeshBasicMaterial` 13–15 ms. It is the longest single
  frame of each drive. (Here it follows the jump back; a drive back would draw the
  same tiles again in the same way.) Return-visit tile arrival was quicker than first
  visits (median 1.08–1.16 s against 1.5–1.9 s).
- **The loading screen's warm-up runs on into the drive.** `compileAsync` is raced
  against 10 s (`webgpu.ts`); on the phone it went on building one material and
  pipeline at a time until 16–19 s after the player sat down, as 15–50 ms promise
  continuations in `three.core`. The bench skips the start screen (`&go`), so a
  player who lingers there would see less of it.
- **Long intervals while the main thread is idle: unknown.** 19–22 over 100 ms in
  two minutes (up to 300 ms) had a short callback before and almost no script
  between; Chrome started the next frame late. 4–8 of them came within three frames
  of a new pipeline, against 5–6 % of all frames, so GPU pipeline compiling is a lead
  for some, not an explanation. GPU work is not observable from the page here. Next
  diagnostic: a Chrome trace on the phone with the `gpu` and `viz` categories round
  these frames (it slows the phone, so use it to see what runs, not for timings).

Traffic, crowd and trams rarely led a hitch (3–10 of the over-100 ms intervals per
run were mostly simulation, usually the catch-up after another long frame). Buffer
uploads and disposal were small in hitch frames (`writeBuffer` under 5 ms a frame;
undress 1–2 ms a tile).

**Tried and reverted: a cheaper clearance index built earlier.** The index kept its
segments as plain numbers and its sweeps stopped allocating points (identical parked
cars: hashes over 400 sampled `praha` tiles and all 234 `centrum` tiles, and per tile
in the game; `parkCars` 30–44 % quicker offline on the M5), and it was built while the
land worker ran instead of in the reply task. On the phone, three cooled pairs in
both orders (each run started at ≤ 31.0 °C; baseline / candidate):

| | Baseline (runs 3, 6, 8) | Candidate (runs 4, 5, 7) |
|---|---|---|
| p99 frame interval | 144.9 / 155.9 / 144.9 ms | 123.0 / 133.7 / 156.5 ms |
| Intervals over 100 ms, ms in them | 73, 80, 72; 12.5 / 12.1 / 11.7 s | 70, 78, 88; 11.9 / 13.0 / 14.8 s |
| Reply task per tile, worst | 276 / 222 / 180 ms | 104 / 104 / 157 ms |
| Index task per tile (send + lanes), worst | 86 / 70 / 39 ms | 213 / 147 / 251 ms |
| Both tile tasks, sum over 15 tiles | 2.05 / 1.89 / 1.55 s | 1.85 / 1.76 / 2.48 s |
| Tile arrival median / max | 1.44 / 5.6, 1.08 / 5.1, 1.38 / 5.8 s | 1.51 / 5.1, 1.09 / 7.3, 1.62 / 6.2 s |

The long task moved rather than shrank: on the phone the index took 100–250 ms in its
new place, and hitch counts did not change. A direct timing of both indexes on the
phone was dominated by heat (the old one slowed 2–3× between two rounds as the phone
went from 32 to 34.5 °C). Not kept. The patch is not in git; the measurements are
summarised here.

Limitations and exclusions: in the A/B, run 1 (baseline) never got the player seated
within 10 s although the game had loaded, and run 2 (candidate) loaded in 66 s and
held one 7.2 s frame; both excluded. An earlier A/B was discarded entirely: the
worktrees' symlinked `node_modules` shared one Vite cache, so starting the second
server made pages reload mid-load (every candidate run failed to get in, and the
phone rose from 31 to 38 °C). The performance skill now says how to set up worktrees.
The phone was slower in the A/B session than in the first readings at the same
temperature (median interval 33.4 against 22.4 ms) for a reason not found, so
compare within a session only. The route has 15 new tiles; three pairs cannot resolve
small changes in hitch counts. No desktop timing was taken (the M5 was busy with other
apps throughout).

### Held builder states for the tiles' shared graphs

Fixed the return-visit rebuild above: `configureRenderer` (`src/webgpu.ts`) gives
the builder states of the ground (`groundGraph`) and of the building and cutaway
ports (`buildings-procedural`, `cut-*`) one extra use, so three.js keeps them when
the last tile drawn with a variant is undressed. Their graphs are shared across
tiles, so the states hold a few dozen variants at most: the builder cache ended a
drive at 367 states against 364, with the same number of pipelines. Pipelines
are still released and made again on return (each call under 1 ms on the main
thread here). Screens after a drive away and back, and standing on the Old Town
Square, matched apart from moving traffic and people (0.2 % and 0.8 % of pixels).

Pixel 5, the same route and settings as above, `d6eecfa` against it with the
change, four pairs in alternating order (B C B C C B C B), every run started at
31.5–32.0 °C, none excluded or retried. "Return" is the 10 s after the jump back
to the start:

| | Baseline (runs 1, 3, 6, 8) | Held states (runs 2, 4, 5, 7) |
|---|---|---|
| Rebuilds of evicted keys a drive | 5, 5, 5, 5 | 0, 0, 0, 0 |
| Node build time a drive | 0.90 / 0.95 / 0.99 / 1.04 s | 0.52 / 0.45 / 0.36 / 0.46 s |
| Return: worst frame interval | 713 / 769 / 758 / 758 ms | 357 / 245 / 178 / 299 ms |
| Return: node build time | 671 / 678 / 643 / 627 ms | 40 / 77 / 26 / 24 ms |
| Rest of the drive: over 100 ms | 25 / 21 / 29 / 28 | 16 / 22 / 19 / 29 |
| Rest: median / p99 interval | 22.3–33.4 / 89.1–89.2 ms | 22.3–22.4 / 89.1–89.2 ms |
| Tile arrival median | 0.77 / 0.77 / 0.75 / 0.88 s | 0.76 / 0.78 / 0.72 / 0.78 s |

The return hitch fell to a third in every pair; the candidates' worst return
frames had no build in them (another kind of hitch, still unexplained). Over the
rest of the drive the hitch counts overlap, as expected: only return visits
change. On the M5 (CPU slowed 4×, load average 4–8, the same order): rebuilds
11 → 0 a drive, worst frame in the 5 s after the jump 690–866 → 111–147 ms.

Two earlier phone attempts at this A/B were discarded: one overlapped the Mac
comparison (its wait for it never matched the process), and in the other the
phone's Chrome stopped answering (`connectOverCDP: socket hang up`) after a long
cool-down with the screen off; the script now retries. In that second attempt, a
clean baseline run held one 6.2 s interval with an idle main thread near its end,
not seen again and not explained.

### Parking a few milliseconds a frame

Fixed the new-tile hitch above: `parkCarsSteps` and `clearanceSteps` are the same
work as `parkCars` and `parkingClearance` with pauses after each street and each
spot tried, and `TileWorld` advances a tile's parking from `update()` for at most
`sliceMs` (8 ms) a frame, oldest tile first. `loadNow` (the start, a jump, the
tests) still parks at once, so nothing waits for frames that may not come. Offline
the cars are identical (hashes over 120 sampled `praha` and all 234 `centrum`
tiles); in the game, all ten tiles parked over frames on the M5 drive matched the
baseline. One tile differed between runs of either build: parked cars keep clear of
the posts of the tiles already loaded, so they depend on arrival order.
`check-tile-lifecycle.mjs` covers the slices, their order, a failing job and
`loadNow`.

Pixel 5, the same route and settings, `ebe3b8b` against it with the change, four
pairs in alternating order (B C B C C B C B), runs started at 25.7–30.8 °C (the
cooling gate is ≤ 31 °C; the first three began cooler), none excluded or retried:

| | Baseline (runs 1, 3, 6, 8) | Sliced parking (runs 2, 4, 5, 7) |
|---|---|---|
| Longest tile task (reply) | 137 / 179 / 248 / 215 ms | 11 / 12 / 27 / 14 ms |
| `tileWorkers.ts` scripts over 50 ms | 7 / 9 / 9 / 9 | 0 / 0 / 0 / 0 |
| Intervals over 100 ms (ms in them) | 20 / 23 / 26 / 22 (2.5 / 3.0 / 3.5 / 2.8 s) | 12 / 12 / 7 / 17 (1.6 / 1.5 / 0.9 / 2.1 s) |
| The same after the warm-up | 17 / 14 / 12 / 14 | 6 / 10 / 4 / 9 |
| Median / p99 interval | 22.3–22.4 / 89.0–89.2 ms | 22.3–22.4 / 89.0–89.1 ms |
| Tile arrival median / max | 0.78 / 1.10, 0.78 / 1.11, 0.78 / 1.19, 0.82 / 1.56 s | 0.73 / 1.12, 0.76 / 1.42, 0.80 / 1.14, 0.73 / 1.08 s |
| Parking finished later by (median / max) | – | 0.15–0.22 / 0.50–0.82 s |

The player's tile was drawn in every frame of every run. Parking takes as long on
the main thread as before (busiest tile 135–164 ms), only spread out, and a tile
is ready that much later; its drawing waits for the workers and the sky view
anyway, so arrival didn't change. The intervals over 100 ms that are left are
mostly the idle-thread kind. On the M5 (CPU slowed 4×): longest tile task 53 →
5 ms, arrival median 113 → 112 ms.

## Cars mirror a street (plan 037 phase 1), 27 October 2026

The car paint and glass shader (car.ts `carStreet`/`carCoat`, webgpu/vehicles.ts)
looks up a made-up street by the reflected direction: sky, a ragged band of walls,
ground and a sun glint. `--ab` can't separate it (`CAR_MIRROR` only blends two
results that are both worked out), so the four changed files were swapped on the
one dev server between runs, old and new in turn, three rounds, stand and drive
at 2× High on the M5:

| Round | Old stand / drive (ms a frame) | New stand / drive |
|---|---|---|
| 1 (seven Codex jobs starting) | 4.9 / 8.3 | 6.7 / 11.2 |
| 2 | 6.9 / 10.1 | 6.7 / 9.0 |
| 3 | 5.9 / 8.8 | 6.0 / 9.1 |

The same draw calls and triangles. Rounds 2 and 3 are within noise; round 1 is the
machine getting busy, not the shader. No GPU timer on this machine, so the
per-pixel cost (cars cover a few per cent of the screen) is not measured directly.

## The Ultra reflection probe (plan 037 phase 3), 27 October 2026

`--ab` toggling `PROBE_ON` on Ultra, 2× on the M5, stand and drive, 12 s each:

| Probe | Stand off → on (ms a frame) | Drive off → on |
|---|---|---|
| A face every frame, 400 m | 3.6 → 4.8 | 6.1 → 7.8 |
| A face every third frame, 150 m (kept) | 4.6 → 5.1 | 8.9 → 9.8 |

Nearly all of it is main-thread time (js followed the frame time): one more pass
of three.js over the scene's lists, not GPU work. The second run was on a busier
machine (higher baselines). The kept setting is under the plan's 1 ms limit.

## Car dents and crazed windows, 27 October 2026

The dents (car.ts `DENT_GLSL`, `CRACKS_GLSL`; webgpu/vehicles.ts) run on every car
vertex and the crack pattern on every car pixel, dented or not, so the cost doesn't
depend on how many cars are damaged. Measured on the Pixel 5 over adb, WebGPU, the
tier's own pixel ratio, High, 14:00, clear: `76b4fed` (before) against `ac73875`
(the dents), each served from a detached worktree, `--vs`, three pairs a scene,
then the same with the order reversed. Battery 24.6 → 36.1 °C over the twelve pairs.

| Scene | Before (ms a frame, six runs) | Dents (six runs) | Means |
|---|---|---|---|
| stand | 49.4, 42.1, 49.1, 41.9, 54.3, 43.1 | 42.5, 42.2, 51.5, 42.2, 42.5, 43.2 | 46.7 / 44.0 |
| drive | 86.6, 85.2, 84.2, 86.8, 87.7, 87.5 | 82.8, 86.8, 83.4, 86.3, 87.8, 86.3 | 86.3 / 85.6 |

Same draw calls (90 standing, 155–158 driving). The spread with no code change
(42–54 ms standing) is far larger than any difference, so the dents cost nothing
measurable here, which puts them under about 1 ms a frame. One drive in the reversed
series first failed to get into the car and was retried by the bench.

## Auto's tier changes and hitches, 2 November 2026

Two reports: a stutter on an M5 at night with Auto on Medium ("maybe should have
downgraded"), and a phone (PowerVR, WebGPU) that froze right after Auto dropped to Low.

**Auto's own step was the freeze.** On WebGPU, `Graphics.apply` disposed every material
in the scene whenever the sun's shadow map or the lamps' light map changed size, so
every render object was built again (TSL to WGSL on the main thread, then pipelines).
High → Medium changes the lamp map (2048 → 1024), Medium → Low the shadow map
(2048 → 1024), and Auto retries a tier after 2 minutes, so a session could pay this
several times. On WebGL nothing is rebuilt and the steps cost 20–110 ms.

Measured on the M5 (headless Chrome, WebGPU, 2×, 23:00, standing on the Old Town
Square), stepping tiers the way Auto does, worst frame in the 3 s after each step,
`f0909e9` against this change, `--vs`, one page each. The machine was heavily loaded by
other sessions (load average 400–600, no idle CPU), so read the sizes, not the
milliseconds:

| Step | Before | After |
|---|---|---|
| High → Medium | 567, 625 ms | 16, 47 ms |
| Medium → Low | 604, 606 ms | 45, 31 ms |
| Low → Medium | 663, 577 ms | 29, 17 ms |
| Low → Lowest | 1081 ms | 731 ms |

What changed: three r186 binds the resized sun shadow map by itself (no validation
errors; day screenshots after three resizes match the baseline's shadows, same
dark-pixel share), so the shadow resize no longer disposes anything. The lamps' maps
are not rebound (without the dispose: `Destroyed texture … RGBA16Float used in a
submit`), so Auto now keeps the lamp map at the size it started with (2048 on desktop,
1024 on touch devices, which start on Medium) and only a chosen tier still resizes it
and rebuilds. Entering Lowest still builds 69 shaders (0.7 s here): MSAA off and the
looks off change the pipelines. Not addressed.

**Auto never saw hitches.** It judged 60-frame windows by their mean without the
slowest tenth, skipped frames over 250 ms and frames while tiles were being built.
Now it also adds up the time spent in frames over 50 ms (up to 1 s; longer is a
pause): two windows in a row that spend a quarter of their time in them step down
(with the usual retry back-off), and a choppy window never steps up. Tile builds are
still not counted. `scripts/check-graphics.mjs` checks both cases.

**Other hitches on a night drive** (`--hitches`, Újezd, 04:48, cloudy, Auto, 90 s with a
return at 60 s, one run each, no tier change in either): the largest code hitch was the
first build of the lamps' light-pool material with cars in it
(`NodeMaterial [position,iCarsA,iCarsB,iCarsC,iAt,iShape,iColour]`, 249 / 367 ms),
10 s in; ground material builds 20–30 ms; the baseline run also had 300–590 ms
stalls inside GPU calls (writeBuffer), likely the loaded machine. Tile insertion
stayed at 2–4 ms.

## Sky lighting during tile streaming, 4 November 2026

Precomputing the 240 ray sample offsets used by every exposed ground texel reduced
the mean CPU time to bake six Praha tiles from 356.8 to 120.9 ms per set of six.
`node scripts/check-sky-rays.mjs` compares against `b35c0ca` with three warmups
and six pairs in alternating order (Node 26.12.1, arm64). Ground textures and
wall lighting were byte-identical on all six real tiles and 18 synthetic cases.

Tile assembly now lets the worker message clone the mesh inputs directly. The three
explicit slices it replaces copied 40 bytes per vertex. On centrum_now tiles
0_0, 7_4 and 16_6 this removed 787,080, 2,892,720 and 2,247,120 bytes of copying
respectively. `node scripts/check-sky-copy.mjs` checks worker results and renderer
buffer ownership. End-to-end tile arrival times and gameplay FPS remain unmeasured.


## 6 November 2026: Italská road profile

Compared the frozen `3dfafe52` baseline with the integrated profile at `bc11e5a2`,
using the same Prague map built at `2026-11-05T22:58:30Z`. The generated profile was
enabled only in the candidate; the baseline code ignores `?roadprofiles`. Both
used headless Google Chrome with WebGPU, High graphics, DPR 1, clear weather,
14:00 and game date 10-20. Other task-owned scene browsers and heavy map builds
were stopped for the measurement.

Three alternating pairs of eight-second static captures used the same camera
position `[-1858.0375213601621, 141.43067411084718, -2534.1520985763214]`, looking
straight down over 50.08243, 14.43964. The camera's relative height was adjusted
for each variant's ground height. Simulation was paused.

| Run | Baseline mean frame | Profile mean frame |
|---|---:|---:|
| 1 | 3.9 ms | 4.2 ms |
| 2 | 4.6 ms | 4.5 ms |
| 3 | 4.2 ms | 4.0 ms |

The reported aggregate was 4.2 → 4.3 ms, with the direction changing between
pairs. This does not establish a performance improvement or a stable regression.
Draw calls stayed at 140, while renderer triangle counts rose from 2,513,591 to
2,535,938 (about 0.9%). These include the scene's rendering passes; the affected
tile's road/sett geometry alone grew from 11,050 to 15,603 triangles. GPU timing
was unavailable. Driving through the profile and phone frame times were not measured.

The command used `scripts/bench.mjs --url http://localhost:5261/ --vs
http://localhost:5260/ --scenes stand --runs 3 --seconds 8 --dpr 1 --graphics high
--time 14:00 --weather clear --extra "&roadprofiles&date=10-20" --require-webgpu`,
with an `--eval` that moved the free camera to the coordinate above, paused
simulation and fixed its absolute eye height. Logs and raw measurements are
`docs/evidence/road-reconstruction/profile-performance.{log,json}` in the
integration worktree. See [the pilot findings](road-profile-pilot.md) for the
geometry and driving smoke checks.


## 6 November 2026: traffic road-level tracking

Compared frozen `3dfafe52` with runtime `2a875efc`, using `scripts/bench.mjs`'s
Old Town `drive` scene. The candidate map contained the surveyed Kongresová
addition, whose off-target tiles were byte-identical to baseline; that addition
is outside this drive. The Italská profile was disabled. Both variants used
headless Chrome/WebGPU, High, DPR 1, 14:00, clear weather and date 10-20. No other
task-owned scene browser or map rebuild was active.

Three alternating eight-second pairs were followed by three with the server
order reversed. In the table the columns always identify the actual code variant.

| Order | Baseline mean frame | Candidate mean frame |
|---|---:|---:|
| Baseline first, pair 1 | 3.7 ms | 3.9 ms |
| Baseline first, pair 2 | 3.9 ms | 4.3 ms |
| Baseline first, pair 3 | 4.2 ms | 4.2 ms |
| Candidate first, pair 1 | 3.8 ms | 3.5 ms |
| Candidate first, pair 2 | 4.0 ms | 3.9 ms |
| Candidate first, pair 3 | 4.3 ms | 4.3 ms |

The six-sample means were 3.99 ms baseline and 4.02 ms candidate; JavaScript
means were 3.83 and 3.86 ms. The second variant tended to be slower in both
orders, and scene draw counts varied slightly. These short whole-game runs do
not isolate a stable tracking cost. GPU timing was unavailable and no phone
measurement was made. Deterministic traffic lane traces and their Math.hypot
counts also matched the baseline in the regression checks.

Command: `node scripts/bench.mjs --url http://localhost:5261/ --vs
http://localhost:5260/ --scenes drive --runs 3 --seconds 8 --dpr 1 --graphics high
--time 14:00 --weather clear --extra "&date=10-20" --require-webgpu`, then the
same command with the two server URLs swapped. Raw results are
`docs/evidence/road-reconstruction/traffic-performance.json` and
`traffic-performance-reversed.json`, with corresponding `.log` files.

## 6 November 2026 — wider Cidlinská curve

Four six-second static headless Chrome/WebGPU runs used the same top-down
camera, High graphics, DPR 1, 14:00 and paused simulation. Baseline-first
frame means were 6.99 and 7.30 ms. Candidate-first means were 7.18 and 7.63 ms.
The ordering changed which variant ran faster. Draw calls stayed at 211,
and renderer triangle counts rose from about 5.02 million to 5.04 million.
The measured curve fit was identical in the final screened preview.
These samples cover a static desktop view. Logs are in
`docs/evidence/wider-road-surfaces/perf-*.log`.

## 6 November 2026 — shared terrain asphalt

The opt-in asphalt mask uses the tile's terrain triangles with extra subdivision
where road height probes depart from the mesh edge. At three fixed top-down
views, the loaded ground triangle count fell 7–10%. Draw calls in the timed
Kongresová view stayed at 175. Mean frame time switched direction with run
order, and the raster variant's slow-frame tail was higher in both pairs.
See [the shared asphalt trial](tiny-prague-road-rendering.md#shared-asphalt-trial-6-november-2026)
for frame, worker and raw buffer measurements.

## 9 November 2026 — Auto and a 30 fps cap

Telemetry from 1 October to 9 November showed 22 sessions on fast GPUs (Apple silicon,
RTX, RDNA), all in Chrome, running at a steady 33 ms; 14 of them ended on Lowest.
Auto aims for 40 frames a second, so a frame rate the browser holds at 30 (Chrome's
Energy Saver) or a 30 Hz screen read as too slow, and Auto stepped down to the bottom,
counting windows towards the "needs a better computer" hint on the way.

On WebGPU, Auto now also times each frame's work: the longer of the main thread's part
and the time from handing the frame to the GPU to `onSubmittedWorkDone`. A slow window
whose median work is under half its median frame interval is held (`cappedWindows` in
the `frames` report). In the in-app browser on an M5 at 2560 × 1600, with
requestAnimationFrame thinned to every other frame (33.3 ms), the old behaviour went
High → Medium → Low → Lowest in 16 s; the new one stayed on High for 26 s, holding 12
windows. Uncapped it stayed on High. With the CPU slowed 6× in headless Chrome (frames
of 50 ms that are all work) it still stepped down to Lowest. The GPU's answer comes
late: from the start of drawing it read 17–18 ms even on Low under the cap, so timing
it from there sent Auto down to Low; from the hand-over it read 10–14 ms across the
tiers. A hidden pane never presents, so its GPU work piles up and the timing grows
without bound (80 ms at pixel ratio 4 while frames came every 17 ms); that only makes
frames look busier. WebGL is unchanged. No phone or Windows machine was measured.

## 9 November 2026 — what makes a frame over 100 ms

The statistics (1 October–9 November) put weak machines at 60 fps on the lowest levels
but with many frames over 100 ms: about 30 a minute on older Intel graphics, 11–12 on
older Android, 1.5–2 on fast GPUs, and 50 a minute on weak GPUs with four cores or
fewer. They didn't say why. `src/hitches.ts` now puts each such frame down to one cause
in the `frames` report (`hitchShaders`, `hitchTiles`, `hitchDrawing`, `hitchGame`,
`hitchScripts`, `hitchGpu`, `hitchWaiting`, `hitchUnknown`; docs/telemetry.md), so the
players' own machines will say.

Checked against `bench.mjs --hitches` on the M5 (headless Chrome, WebGPU, High, 1×,
the drive, 60 s), `e54f7365` served from a detached worktree:

- **The GPU's answer can't be compared with main-thread time.** In a first version the
  GPU took the blame for 9 of 19 frames over 100 ms with the CPU slowed 4×, frames the
  detailed recorder put down to builds and tiles: `onSubmittedWorkDone` is answered
  only when the main thread is free, so a busy frame looks like a busy GPU. The GPU is
  now blamed only when nothing on the main thread explains the frame.
- **A tile's first drawing is the tile's.** The frame after a tile joins the scene drew
  for 121 ms with no build in it (CPU 4×); it now counts as `hitchTiles`, not drawing.
- **Agreement:** with the CPU slowed 6× (machine quieter, 30 fps), two frames over
  100 ms in the timed minute: a build (102 ms, both say shaders) and one the detailed
  recorder couldn't place (118 ms; the game's verdict: the GPU).
- **What the drives showed:** with the CPU slowed 4× on a loaded machine (other
  sessions at load average 20–50), 9 of 18 frames over 100 ms were shader builds, 4 a
  tile's first drawing, 1 a 320 ms `writeBuffer`. Builds were 34–39 a drive, and
  `MeshLambertNodeMaterial ground` 15 of them each time (443–670 ms, up to 46–76 ms
  each): ground variants (`groundGraph`'s key: pattern, relief, sky, deck, mask,
  photo, raster, dig, sheltered, seasonal) meeting the camera for the first time,
  which the loading warm-up can't cover because they aren't in the first tiles. That is
  the lead for the main thread; whether it is what players feel waits for the
  statistics, since the weak machines are mostly limited by their GPUs.

## 11 November 2026 — instance matrices sent only when they change

three.js (r187) keeps an instanced mesh's matrices in a uniform buffer when the mesh has
too many attributes for its shared build (geometry attributes + matrix + colour over 8:
the tree pages with 9 + 2, the people with 9 + 1) and no more than 1024 instances, and
`Bindings._update` sends every uniform buffer again each frame its object is drawn. The
tree shaders read the matrix more than once, so each visible 128- or 256-tree page sent
its whole array up to five times a frame: by Újezd about 0.75 MB a frame in some 60
`writeBuffer` calls, in the Petřín woods 1.5 MB.

`configureRenderer` now sends such a buffer only when its attribute's version has moved
on (`needsUpdate`, which `send()` sets) or its GPU buffer is new (`SEND_CHANGED_MATRICES`
in `src/webgpu.ts` switches it off, for `--ab`). Counted by `--stalls` on the M5 (WebGPU,
High, 1×): `writeBuffer` 1.02 MB in 345 calls a frame → 0.03 MB in 229 on the drive,
1.58 MB in 371 → 0.03 MB in 237 in the woods.

`--ab` in one page, 30 s a scene, headless Chrome on the M5 at 1× and High (load average
about 8 from other sessions; every window agreed in direction):

| Scene | Off | On |
|---|---|---|
| woods | 16.4 ms (61 fps) | 7.2 ms (140 fps) |
| drive | 3.9 ms (258 fps) | 3.1 ms (320 fps) |
| stand | 3.4 ms | 3.2 ms |
| woods, CPU 4× | 11.8 ms | 10.0 ms |
| drive, CPU 4× | 13.8 ms | 12.0 ms |

On the Pixel 5 (Medium, 1.5×, 60 s of the drive, `--ab`) it made no difference that could
be measured: 55.1 against 55.5 ms a frame, JavaScript 22.7 against 23.0 ms. (A first run
read 9 % quicker, but something was touching the phone's screen during it and its windows
swung between 8 and 20 fps.) The phone is not held back by the main thread at that tier:
see the sweep below.

Checked: screenshots in the woods and Letná park match with the switch on and off (0.2 %
and 1.0 % of pixels differ, the same as two runs with it on); after four 45–50 s drives no
matrix buffer on the GPU differed from its array except pages changed but not drawn since
(their version ahead of the one sent, so they go at the next draw).

The same change marks matrices that are too many for a uniform buffer as storage before
anything is built for their mesh (`userData.sharedMatrices`). Until now `shareInstances`
did that while the colour shader was built. If the shadow shader is built first, three.js's
own instancing has already made the buffer for vertex input, and the storage binding is
refused: the phone logged exactly that once on the Old Town Square ("Binding usage
(CopySrc|CopyDst|Vertex) … doesn't match expected usage (Storage)", then invalid bind
groups and command buffers). It could not be made to happen again, so the cause is
reasoned, not reproduced.

### What limits the Pixel 5 (standing on the Old Town Square, 20 s each, 33–34 °C)

| Tier, pixel ratio | Frame (mean) | Median | JavaScript |
|---|---|---|---|
| Medium, 0.75× | 18.5 ms (54 fps) | 22.3 ms | 16.9 ms |
| Medium, 1× | 22.5 ms (44 fps) | 22.3 ms | 18.2 ms |
| Medium, 1.5× | 33.7 ms (30 fps) | 33.4 ms | 18.7 ms |
| Medium, 2× | 49.8 ms (20 fps) | 33.8 ms | 21.9 ms |
| Low, 1× | 20.6 ms (49 fps) | 22.3 ms | 16.8 ms |
| Lowest, 1× | 17.7 ms (57 fps) | 22.2 ms | 16.0 ms |

The mean rises by about 9 ms for each 1× of pixels (2.5 million), so at 1.5× and above
the GPU sets the pace and main-thread savings don't show. At 1× and below the median sits
at two screen refreshes (22 ms at 90 Hz) because the JavaScript alone takes 16–18 ms, of
which `renderer.render` is 7 ms, the crowd 3 ms and the traffic 3 ms. In the Petřín woods
at Medium and 1.5× it draws 5.7 million triangles at about 9 fps with 22 ms of JavaScript.

A CPU profile of the drive on the phone (Auto, which went down to Lowest): three.js's
drawing of each object 31 % of the main thread's busy time (211 objects a frame on
Medium, counted on the M5, 17 of them instanced meshes with nothing in them), shader builds 9 % (Auto's
tier steps), `traffic.update` 8 %, sending uniform buffers 5 % (before this change), the
garbage collector 4 %, the crowd 3 %, `CarPool.render` 3 %.

The phone's Chrome had 217 tabs open from earlier test runs of several projects, and a
second scene in one run closed the page each time; one scene a run worked.

`bench.mjs --stalls` counted an attribute update as its whole array, so the lamps'
re-gathering read as 2.7 MB in a frame; it sends only the lamps in use (`send()` ranges).
The counter now adds up the ranges. The gathering itself takes 1.0–1.4 ms (5.5 ms at most)
with the CPU slowed 4×, 10–15 times in 30 s: not worth changing.

### Where the Pixel 5's GPU time goes (11 November, 2×, Medium, the Old Town Square)

At 2× the phone is limited by its GPU (49 ms a frame, 20 ms of it JavaScript). `--ab` in
one page, 40–60 s each, every window agreeing, 26–30 °C, no touches on the screen:

| Left out | Frame | Share of the frame |
|---|---|---|
| nothing | 49 ms | |
| the ground's patterns (`userData.flatten()`) | 45.0 ms | 8 % |
| the whole ground (its layers hidden) | 34.8 ms | 30 % |
| the buildings (hidden) | 42.3 ms | 14 % |
| the sun's shadow on the ground (`receiveShadow` off on its layers) | 45.2 ms | 8 % |

So the ground costs about 14.6 ms there: 3.9 ms the patterns, 3.9 ms reading the sun's
shadow (PCF on every tier), and some 7 ms the rest (lighting, the relief and sky
textures, layers over each other, the stencil). That is the lead for phones at 1.5× and
up. One more swap is unexplained: with only each tile's lowest ground layer left visible
the frame was 35.1 ms, the same as with no ground at all; which layer that was, and how
much of the tile it covers, wasn't checked.

Tried and dropped: the buildings' depth drawn before the ground (a depth-only copy of
each building mesh at render order −3002, cut away like the ground's depth), so that the
ground under roofs fails the depth test. 49.1 → 47.6 ms on the phone (3 %), nothing on
an M5, for one more draw of every building.

Also measured on the M5 with the CPU slowed 4×: not drawing the 128- and 256-tree pages
at all (29 of them in view on the drive, each a draw in the colour pass and the shadow
pass) saves 3–4 %, so packing them into fewer pages would save less. The shadow pass
draws about three times as many tree pages as the camera sees (26 against 9 a frame).

## 11 November 2026 — Traffic.update: standing cars ruled out before they are measured

For each of its ~40 cars, `Traffic.update` goes through every obstacle circle in a square
of reach + 8 m round it, most of them parked cars well off to the side, and measured each
standing one against every piece of the lane ahead (two divisions and a `Math.hypot` a
piece). Now, once the lane is built, a box round its pieces (`laneBox`, along and across
the lane where the car is, its ends taken on by the largest radius it rules out) rules
out every standing car further from it than such a car could matter: it can only be
passed or be in the way within W / 2 + r + max(PASS + SWERVE, TOUCH + |off|) of the lane.
The bound is exact. Also exact: no square root for a speed surely under 0.3 m/s,
`mergeDistance`, ahead and side only for moving obstacles, a lane piece no nearer than
the best so far skipped without `Math.hypot` (never less than the larger of its two
parts), the square test first, an indexed loop. Nothing a car does changes, and
obstacles are visited in the same order.

Checked: `node scripts/check-traffic-lanes.mjs --compare` against traces recorded from
`d2eeaad`, all 24 fixtures identical step by step (twelve of them new: cars standing
anywhere round bent streets). A copy that measured every ruled-out car against every
piece anyway found none of 3.8 million that would have mattered (the closest within
10 µm of the line), and 60 such streets matched the old code. `check-traffic-queues` and
`check-traffic-merges` print exactly what `d2eeaad` prints. `Math.hypot` calls in
`Traffic.update`: grid fixture 7.94 M → 0.85 M, parked bends 1.70 M → 0.26 M, parked
straight 113 k → 6 k; lane builds unchanged.

Timing: M5 MacBook Air, headless Chrome, WebGPU, 1×, High, 14:00, clear, 30 s a scene,
`--stalls --fresh-browser --loading-frames --require-webgpu`, 3 pairs with the candidate
as `--url` and 3 with it as `--vs`, against a server from a detached worktree of `d2eeaad`.
`Traffic.update` per call (`updates traffic` ms ÷ calls), mean of each order's three runs:

| Scene | Baseline | Candidate | Change (each order) |
|---|---|---|---|
| drive | 0.659, 0.694 ms | 0.468, 0.457 ms | −29 %, −34 % |
| stand | 0.347, 0.364 ms | 0.260, 0.252 ms | −25 %, −31 % |
| drive, CPU 4× | 1.169, 1.212 ms | 0.880, 0.872 ms | −25 %, −28 % |
| stand, CPU 4× | 1.111, 1.037 ms | 0.797, 0.789 ms | −28 %, −24 % |

Every candidate run was quicker than every baseline run in the same series. A CPU
profile of each on the drive: self time in `Traffic.update` 2.41 → 1.35 s over the run
(7.8 → 4.4 % of samples); the obstacle lookup it calls (`obstacles` in `main.ts`, the two
spatial hashes) stayed at 0.58–0.61 s and is now about a quarter of what is left. Whole
frames came out between 4 % quicker and 2 % slower in the series means, inside the noise,
so no frame-rate gain is claimed. A few seconds of Node checks ran during one 4×
series. Not measured: the Pixel 5 (the phones were shared with other sessions tonight);
on it `Traffic.update` was 3–4 ms a frame, so a similar share would be about 1 ms.

What's left, not done: the query is a square of reach + 8 m because a moving car that
this one follows into a shared lane counts wherever it is in that square; standing cars
only matter within a few metres of the lane, so asking the parked cars' hash
(`resting`) for a smaller area would cut the lookup and the loop, but that needs
`obstacles()` in `main.ts` to take the two hashes apart. Deciding about standing cars
less often than every step (they don't move) would save more but changes when a car
reacts, so it wasn't tried.

## 11 November 2026 — fewer objects made each simulation step

`simulate` (`src/main.ts`) made an obstacle object every step for each circle of each
moving car and for each person, officer, crew member and tram circle, and new arrays for
`Car.circles()`, `Trams.bodies()` and its own lists; `BusStops.sync` went through all
3102 stops each frame and tried `place()` every frame for a stop that couldn't be placed.
Now the obstacles in `hash`/`carHash` come from a pool filled in again each step (every
reader was followed first: none keeps one past its step), `pushCar` works out the circles
without the list, the step's lists and the tram bodies are reused, and `BusStops.sync`
looks only at the stops filed round the view and those shown, trying a failed `place()`
again after 250 ms. Not changed: one pass over `loose` for the movers and
`syncResting` (other code between them can move and add loose cars, so when
`restingWhole` is rebuilt could change), and `traffic.emergency`.

Counted in the page (headless Chrome on the M5, WebGPU, High, 1×, 10 s a scene, per
simulation step; adds to any `SpatialHash` of an object not seen before):

| | drive, `main` | drive, branch | Old Town Square, `main` | branch |
|---|---|---|---|---|
| obstacles made | 521 | 0.2 | 1240 | 0.4 |
| `Car.circles()` calls | 55 | 14 | 40 | 0 |
| hash adds (unchanged) | 650 | 647 | 1364 | 1362 |

Bus-stop signs (a scene eval going through seven places, ~1580 `sync` calls on each
server): a sign was shown exactly when it was in view and placed, and in the scene exactly
when shown, for every stop on both; the same signs showed; `place()` calls 234 → 17.

CPU profiles, `bench.mjs --profile`, 15 s, the two servers taking turns three times
(order swapped in the second round), shares of the busy main-thread time:

| | `main` | branch |
|---|---|---|
| garbage collector, drive 1× | 0.81–1.07 % | 0.70–0.76 % |
| garbage collector, standing 1× | 1.70–1.75 % | 1.26–1.32 % |
| garbage collector, drive 4× CPU | 0.77–0.78 % | 0.61–0.72 % |
| garbage collector, standing 4× CPU | 1.01–1.28 % | 0.93–1.15 % |
| `simulate` (with what it calls), drive 1× / 4× | 29.4–30.7 / 27.8–28.2 % | 30.0–30.2 / 27.2–27.9 % |
| `simulate`, standing 1× / 4× | 42.2–42.8 / 41.7–42.2 % | 41.5–42.2 / 41.1–42.8 % |
| `BusStops.sync` | 0.29–0.58 % | 0.11–0.21 % |
| `pushCar` | 0.61–0.84 % | 0.38–0.55 % |

Frame times and JavaScript per frame were within the noise in every pair (standing at
4×: JavaScript 9.9–10.0 against 9.6–10.0 ms; driving at 4×: 10.8–11.3 against
10.6–10.9 ms). What `simulate` spends filling in pooled obstacles is about what it spent
making them; what's saved is in the collector, outside `simulate`. Offline in Node, the
same fill (1360 obstacles a step, read back) took 15.0 µs a step pooled against 17.7 µs
with new objects, the collector included.

Tried and reverted: keeping the hash's bucket arrays from step to step (emptied, and
dropped when a fill left them empty). It took the new buckets from 341 / 689 a step to
under 1, and the collector's share at 1× standing to 0.8 %, but `clear()` going through
the map cost 0.22 profile samples a frame (0.38 at 4×) against 0.09–0.26 saved in
`add()`. In Node, `Map.clear()` with new arrays took 31 µs a step, walking the map 41 µs,
lists of the buckets used 49 µs: V8 makes and drops short-lived arrays more cheaply than
it keeps them.

Not measured: the phone (the Pixel 5 was shared with other sessions tonight), and a
same-build noise control. Checks: `check-traffic-lanes --compare` identical, the parked
cars' hash from `time-parking.mjs` unchanged (-1273522741, 4129 cars),
`check-parking-overlap` 0 pairs, typecheck; scenarios `police-chase`, `bike-hit`,
`pedestrians-escape`, `bus-ride` and `bus-displays` pass on both. Two fail now and then on
both: `job-tram` two runs in three (the tram stops 30 m short of Na Knížecí) and
`dustcart` half the runs (2 of 4 on `main`, 2 of 5 on the branch: the cart leaves the
traffic and its crew walk off). `check-bus-lines` (two breaks over 30 m) and
`check-resting-cars`'s simulation case (`d.resting.sync`) fail on `main` already.

## 11 November 2026 — the two merges together

`main` with the `Traffic.update` and simulation-garbage merges (`01ff310`) against the
commit before both (`568d910`), headless Chrome on the M5, WebGPU, High, 1×, CPU slowed
4×, 20 s a scene, three pairs with each as `--url` (load average about 5):

| Scene | Before | After | `Traffic.update` a call |
|---|---|---|---|
| drive | 11.9, 11.9 ms | 11.0, 11.1 ms | 1.25 → 0.80 ms |
| stand | 11.2, 10.9 ms | 10.1, 10.2 ms | 1.05 → 0.72 ms |

Seven to ten per cent a frame, the same way in all twelve pairs, nearly all of it the
traffic. Not measured on the phone.

`bus-ride` (the scenario) fails about one run in five with or without the merges: the
bus is still short of the next stop after three minutes (2 of 11 runs before, 3 of 16
after), so no inspection starts and nobody is let off.

## 12–13 November 2026 — the look on Ultra, and first person (branch `beautify`)

A new tone curve, roof edges, a post-processing pass on Ultra, and for first person a sky,
street-level trees and window reflections. Headless Chrome on the M5, WebGPU, 2×
(2880×1800), 14:00 clear unless said; the machine had other apps on the GPU through the
night (6–82 % busy between runs), so read the pairs, not the absolute numbers.

**The whole branch against `main`** (`--vs`, 20 s a scene):

| Tier | Scene | `main` | Branch |
|---|---|---|---|
| High | stand | 6.3, 7.2 ms; reversed 6.5, 7.0, 6.4, 6.2 | 6.9, 7.9 ms; reversed 6.3, 6.9, 7.1, 6.2 |
| High | drive | 10.0, 10.5 ms | 10.5, 10.4 ms |
| Ultra | stand | 6.8, 7.6 ms | 7.4, 7.8 ms |
| Ultra | drive | 9.4, 10.4 ms | 11.0, 11.7 ms |
| Ultra, 22:00 rain | stand | 16.3 ms | 15.3 ms |
| Ultra, 22:00 rain | drive | 16.0 ms | 16.2 ms |

Below Ultra nothing measurable changed (the curve is no dearer than the one before it; the
roof lines and the glass are a few operations on roof and wall pixels). On Ultra the pass
costs about half a millisecond standing and up to 1.5 ms driving, most of it main-thread
time for its dozen small draws.

**The pass by itself** (`--ab` toggling `POST.value` in one page): with the bloom's first
copy at half the picture's width (three.js's own) 10.8 → 12.8 ms standing and 13.9 → 15.8
driving; at a quarter 8.7 → 9.9 and 13.1 → 13.3. A quarter is what is in.

**The water's waves** (`--ab` toggling the setting at the river): 8.6 ms without, 8.5 with.
Ultra now has them until the player chooses.

**First person** (`--eval` setting `__test.eyes`, Ultra, 2×; `--ab` in one page):

| Piece | Old Town Square, facing its trees | Petřín woods |
|---|---|---|
| Street trees (four and five sprays a branch end, two texture reads) | 10.2 → 13.4 ms | 31.9 → 25.4 ms |
| Street trees (three sprays, one read: what is in) | 7.9 → 10.2 ms | 33.6 → 29.0 ms |
| The sky | 11.3 → 12.0 ms | |
| The pass | 11.0 → 11.2 ms | |

In a wood the street trees are quicker than the top-down crowns they replace; a wood in
first person is slow either way (about 30 frames a second at 2× on Ultra, on `main` too).
A pixel of a leaf card pays for its lighting and shadow filter even where the picture is
transparent (WGSL's `discard` goes on running the shader), so the cost follows the cards'
area on screen: the lead for making them cheaper is cards cut closer to the spray, or
shading the sprays per corner.

**Ambient shading from depth, tried and left off** (`?ao`: three.js's GTAO at half
resolution in the Ultra pass, 12 samples, radius 4 m, the depth-only ground drawn for it):
two runs each way, standing 7.6, 7.6 → 11.1, 10.7 ms and driving 10.8, 12.0 → 13.8, 14.5 ms.
About 3 ms a frame for a darkening round cars, along walls and in roof valleys that is hard
to find in the picture from above, where the shadows and the ground's soft shading already
do that work. It stays behind `?ao`.

Checks: `check-graphics` (WebGPU and WebGL), `check-material-sharing --case all`,
`check-tree-pool --case all`, `check-tree-shadows` and `check-renderer` pass (run
`check-graphics` against a freshly started dev server: on one that has served edited modules
its `import('/src/shading.ts')` gets a second copy and fails at "lowest: detail").
Scenarios `seasonal-ground`, `tunnel-layers`, `lamp-knock`, `wall-crash` and `police-chase`
pass; `tunnel-mouth` fails the same way on `main` ("in the mouth, not underground", Divadelní).
Not measured: the phone, Medium and below, and Windows.

## 13 November 2026 — the second round of the look, and what the phone showed (branch `beautify`)

Added that day: leaf sprays over the crowns from above (Ultra), kerbs and gutters, street
wear, mosaic patterns, grass detail, roof relief and glints, a shade under cars, rooms behind
lit windows, floodlit landmarks, wakes, photo mode, and on Ultra shadows that soften with
distance. Headless Chrome on the M5, WebGPU, 2× unless said; the GPU was shared with other
apps all day (2–92 % busy between runs).

**The branch against `main` at the end** (`--vs`, three pairs, 16 s a scene, 14:00 clear, 13
November so the trees are mostly bare):

| Tier | Scene | `main` | Branch |
|---|---|---|---|
| High | stand | 6.2, 6.5 ms (and one 3.8) | 7.0, 7.0 ms (and one 5.7) |
| High | drive | 6.7, 8.5, 9.5 ms | 8.0, 8.8, 9.2 ms |
| Ultra | stand | 7.5, 7.4, 6.7 ms | 9.3, 8.6, 8.4 ms |
| Ultra | drive | 9.9, 10.1, 8.8 ms | 13.2, 11.7, 11.2 ms |

High at 1× (where the main thread is the limit): standing 4.4 → 4.5 ms. So below Ultra the
branch costs the main thread next to nothing standing (a CPU profile of both: 4.91 → 5.03 ms a
frame) and its shading 0.5–0.8 ms a frame at 2× on the Old Town Square. Main against main,
as a control: within 0.5 ms either way, and the order of a pair made no difference.

**Ultra's pieces** (`--ab` in one page): the pass with its bloom 0.5 ms standing and 1.0
driving; the soft shadows 1.3 ms standing as first written, 0.5 once most pixels stop after
six reads; the leaf sprays about 0.5 driving past Petřín (in November: 3.3 ms in a wood
before the bare ones were folded away in the vertex shader, not timed again in summer); the
water's waves nothing. Street wear and kerbs (two more draws a tile): 0.3 ms standing on High.
The shade under cars: 0.1 ms.

**Two mistakes found by measuring, both in the shadow filter:**

- It made its uniforms inside the function that runs for every material, so the renderer had
  hundreds more to update a frame (`updateByType` 2.7 % of a profile's samples, `writeBuffer`
  up from 2.1 to 3.2 %). They are kept per shadow now.
- It was on the sun's shadow at every tier, with a switch in the shader. **On the Pixel 5 that
  halved the frame rate at Medium**: standing on the Old Town Square, `main` 28 frames a
  second, the branch 15, the branch without the filter 32 (20 s each, tier's own pixel ratio,
  30–35 °C). Found by measuring the branch's history there: 27 and 26 frames a second at the
  ends of the first two days, 11 after the commit that added the filter. It is now put on the
  shadow only while Ultra is chosen (`Graphics.apply`; the lit shaders are rebuilt when it
  changes, half a second). After that, on the phone: 25 and 32 frames a second standing
  against 28, and on the drive 18 and 18 against 17 and 24 (30 s each, 35–36 °C; the
  slowest 1 % of the branch's frames were longer, 480 against 190–300 ms, on two runs each:
  not settled).

The drive scene varied between page loads by more than anything here costs (the same build:
4.3, 5.6 and 9.1 ms a frame at 1× on High), which is why single runs of it prove nothing.

Checks: `check-graphics` (WebGPU and WebGL, on a freshly started server),
`check-material-sharing`, `check-tree-pool`, `check-tree-shadows`, `check-renderer`,
`check-ground-areas`, `check-ground-season`, `check-roof-clutter`; scenarios `photo-mode`
(new), `lamp-knock`, `wall-crash`, `police-chase`, `seasonal-ground`, `tunnel-layers`,
`boat-boarding`, `ferry-ride`, `cruise-lock`, `car-doors`, `lamp-break`,
`pedestrians-escape`, `bike-hit` and `job-taxi` pass. `check-lamp-forget` and
`check-display-text` fail on `main` too (Node 26 and a JSON import). Not measured: Windows,
Low and Lowest, Ultra on the phone, the leaf sprays in summer.

## Bloom on High, 16 November 2026

Pixel 5 over ADB, Chrome WebGPU, High at its default 2× pixel ratio, driving from
Újezd. Bloom and the darker corners switched together in alternating four-second
windows after warming both states. In clear daylight, bloom off → on averaged
112.4 → 112.3 ms/frame. In rain at 22:00, it averaged 273.3 → 260.9 ms/frame.
Both states were under 4 FPS in the rain, which makes that run a poor measure of
small costs. An earlier rainy run was discarded because the driver never got into
the car. High now enables the pass by default.

## Canopy sprays on High, 16 November 2026

Pixel 5 over ADB, Chrome WebGPU, High at its default 2× pixel ratio. In Divoká
Šárka on July 15 at 14:00 in clear weather, 34 visible canopy mesh pages held
8,542 instances. Alternating four-second windows after warm-up, sprays off → on
averaged 98.6 → 97.6 ms/frame. With the order reversed, the comparison was
96.0 → 98.0 ms/frame. The difference changed direction across runs. High now
enables the sprays by default. This measures steady rendering after warm-up.

## Headlight beams and wet glints on High, 16 November 2026

Pixel 5 over ADB, Chrome WebGPU, High at its default 2× pixel ratio, driving from
Újezd in rain at 22:00. The setup verified a moving car, four beam instances,
27 glints and fully wet ground. Alternating four-second windows after warm-up,
effects off → on averaged 261.0 → 264.5 ms/frame. With the order reversed the
comparison was 259.4 → 264.0 ms/frame. The 1–2% cost was small compared with the
roughly four FPS baseline. High now enables the beams and glints by default.

## Small pond ripples, 17 November 2026

Desktop Chrome WebGPU, Ultra, clear at 13:00. At the same street-height view
in Park Přátelství, three five-second samples each way gave 20.5 → 21.3 ms
with the original water first, and 20.6 → 21.0 ms with the quieter water first.
The second run was slower in either order. Across both orders, the original
averaged 20.7 ms and the quieter water 21.0 ms. Draw counts ranged from 56 to
58. There was no GPU timing, so this comparison does not isolate shader cost.

## Transmission towers, 17 November 2026

On desktop Chrome WebGPU at Ultra, the Přemyšlenská view had three loaded
transmission meshes and about 2,600 vertices. Alternating visibility in the
same view for six four-second windows gave 28.3 ms/frame off and 28.7 ms/frame
on, with an offline map build running. There was no GPU timing, so this is a
check against a large added cost and does not isolate the cost of the meshes.

## People's shadows on a phone, 19 November 2026 (branch `crowd-shadows`)

Following the kept-shadow-map trial (branch `shadow-cache`), which found that on the Pixel 5
the moving casters are the larger part of what drawing the sun's shadow map costs. A person
is 506 vertices and 588 triangles, each vertex reading the animation textures four times,
and the Old Town Square holds 225–340 of them.

`?peopleshadows=full|simple|none` (`PEOPLE_SHADOWS` in `src/figures.ts`): `simple` puts a
six-vertex shape as big as a standing person in the shadow map in each person's place, on a
layer only the sun's shadow camera sees; `none` gives people no shadow. Low and Lowest
use `simple` (chosen by the user from the pictures, 19 November); the other tiers cast as before.

Pixel 5, Chrome WebGPU over adb, Medium, 1×, standing on the Old Town Square, clear,
`--ab` against `full` in one page, 48 s in four-second windows, no touches:

| Instead of each person's own shape | `full` | Changed | Battery |
|---|---|---|---|
| The same mesh in one frame of its clip (one read a vertex, not four) | 30.1 ms | 31.0 ms | 30 °C |
| The plain shape | 24.6 ms | 23.8 ms (3.0 %) | 34 °C |
| The plain shape, again | 25.8 ms | 24.8 ms (3.9 %) | 34 °C |
| No shadow | 25.1 ms | 23.6 ms (5.9 %) | 32 °C |
| No shadow, again | 25.3 ms | 24.4 ms (3.8 %) | 34 °C |

So about 1 ms of 25 on the busiest square, the plain shape saving about what no shadow
does: the cost is the vertices, not the texture reads (the one-frame version looked the same
as today's and was dropped). The first window of each run was `full`'s and its slowest, which
flatters the changed side a little. One more run of the plain shape sat at a steady 30
frames a second in both states (33.3 against 33.8 ms, with `&dev`), and two others broke
off: the page closed in one, and in the other the frame rate fell to nothing in both
states. The plain shape alone ran 30 s with no errors in the console; what broke those runs
wasn't found.

With Low and Lowest set to the plain shape, again on the phone at Low (its own pixel
ratio, the same switch in one page, 32–34 °C, no touches): standing 27.6 → 26.1 ms (5.2 %)
and 22.2 → 21.7 ms (2.2 %), the drive from Újezd 38.4 → 37.9 ms (1.3 %, within its noise).
All three ran through.

The look: the plain shape's shadow is a thin spike whatever the person does, so someone
lying down or on a bike casts a standing one. `check-graphics` covers the tiers' choice;
it stops at "high: actual MSAA depth texture", as it does without this change. Not
measured: Medium and up (unchanged), the M5.

## 22 November 2026 — street views and VR quality

Medium's new street budgets reduced Pixel 5 mono FPV frame time in both test
orders, by 5.3–20.9%. M5 driving results remain inconclusive against the measured
background variation, and actual Daydream stereo performance was not tested.

The realistic tyre/suspension model took 8.6 ms across 384 updates in an M5 Ultra
driving profile, about 0.022 ms per update. It was not the main cost in that run.
Rendering, uploads and repeated ground-polygon checks cost much more. This is a
measurement of the handling model itself, not every consequence of driving it.

Changes:

- Grass placement yields every 32 candidates and resumes within a 1 ms frame
  budget. Buffer assembly still finishes in one task. A regression check compares
  every generated buffer against a hash from the original builder: the settled
  geometry is identical. New patches can take more frames to appear.
- Street facade indexes and ironwork matrices use explicit dirty ranges without
  `DynamicDrawUsage`, which forced uploads even while stationary. In three paired
  drives, non-long-task attribute uploads went from 0.20–0.21 to 0.07 MB/frame;
  total buffer writes went from 0.42 to 0.28–0.31 MB/frame. The driven routes and
  streamed contents differ slightly, so these are work counts for those runs.
- Motion blur keeps the original sample when the projected smear is below 0.35
  pixels, including the protected player car and most sky pixels, instead of
  taking eight redundant samples. Its independent frame-time benefit is unmeasured.
- Street budgets now scale at fixed resolution: detailed avatars go from 24 on
  High/Ultra to 12/6/2 on Medium/Low/Lowest, with shorter ranges for them and close
  car bodies. Lower tiers simplify branch tubes while retaining every leaf card.
  The player's avatar and driven car keep their close models.
- VR entry allocates 45/55/65% resolution on Lowest/Low/Medium and keeps the previous
  75% on High/Ultra; `vrscale`
  still overrides it. Auto targets the reported headset refresh rate, falling back
  to 60 FPS, rather than desktop's 40. Active XR sessions scale street detail;
  resolution changes at re-entry. Canvas DPR is restored when leaving XR.

### Pixel 5

Chrome WebGPU, Old Town Square, first person, Medium shading/shadows at 1×,
clear at 14:00. The new Medium street budgets and the previous full budgets
alternated in one page, four-second windows after warming both states. These
compare a deliberate detail tradeoff at the same resolution, not identical looks.

| Order | Full budgets | Medium budgets | Reduction in frame time |
|---|---:|---:|---:|
| Full first | 42.4 ms | 33.5 ms | 20.9% |
| Medium first | 37.6 ms | 35.6 ms | 5.3% |

Starts were at 25.0 and 25.5 °C. The first Medium window of the second run was
slower than its later windows. Both runs completed without console errors. These
are mono FPV results; they do not establish Daydream stereo performance.

The same phone's WebGL path (used by VR), one 24-second mono FPV A/B at 27.2 °C,
gave 36.1 → 34.5 ms (4.6%) with full → Medium street budgets and no console
errors. That single run was not repeated in reverse order.

### M5 Ultra driving

Chrome WebGPU, third person, realistic sedan, lane assist, 2×, clear 14:00;
16-second samples after five seconds of driving. Detached source snapshots
included the pre-existing avatar edits in the baseline. Three alternating pairs,
then two pairs with the starting order reversed:

| Pair | Baseline mean/p95/p99, ms | Changed mean/p95/p99, ms | Baseline/changed frames over 100 ms |
|---|---|---|---|
| 1 | 42.7 / 71.8 / 95.4 | 32.9 / 62.0 / 142.4 | 3 / 12 |
| 2 | 43.2 / 71.9 / 97.2 | 35.3 / 66.0 / 150.1 | 3 / 10 |
| 3 | 30.7 / 53.2 / 75.2 | 27.1 / 48.7 / 64.5 | 2 / 1 |
| Reversed 1 | 27.9 / 51.1 / 69.9 | 24.6 / 42.5 / 65.2 | 0 / 2 |
| Reversed 2 | 32.4 / 52.2 / 79.8 | 26.1 / 46.1 / 71.9 | 2 / 3 |

Mean intervals improved, but an unchanged-build control moved from 26.3 to 32.2
ms (22%). Tails worsened in the first two pairs, and the changed build also had
more frames over 100 ms in both reversed pairs. Desktop smoothness and the
size of any gain remain inconclusive. Loads ranged from 10.7 to 58.5 seconds.
The GPU was already 72% busy before testing. Later per-client GPU-time samples
identified Codex and WindowServer as active consumers; briefly pausing Spotify's
renderer reduced only part of the load, and it was resumed.

The benchmark now counts draws/stalls after all post-processing passes, refuses
failed car entry and zero-frame runs, and offers view, handling, deterministic
vehicle, fixed settling and normal pacing options. An early failed car-entry run,
a suspended phone run and a profile whose per-draw material-key tracing added
substantial overhead were excluded. Local JSON/log evidence is under
`docs/evidence/performance-2026-11-22/` (ignored by git).

Validation: typecheck, production bundle build without copying map assets,
`check-street-quality`, `check-player-avatar`, `check-street-handling`, offline
`check-tree-shadows` and `check-street-facades`; FPV/TPV visual tier switching in
the in-app browser. Full gameplay/pipeline suites and actual Daydream stereo
testing were not run. The in-app browser tool stalled during the final overhead
screenshot, so that screenshot was not verified.
The full-strength motion-blur path was also checked in normally paced Chrome:
an 80 km/h vehicle velocity with simulation paused rendered at 59.9 FPS over two
seconds (p99 16.8 ms), with the player car sharp and the surrounding street blurred.
That checks the shader and picture, not smoothness on a moving driving route.

## 22 November 2026 — real Cardboard stereo check

Pixel 5, Chrome WebGL, actual `immersive-vr` sessions over USB/localhost, without
a viewer. Both XR eye cameras rendered, 6 cm apart, with separate viewports and
Cardboard lens correction. The phone lay flat; an offset reference space
recentered its physical pose toward the street. The saved screenshot shows both
eye views of the Old Town Square.

Each tier ran for 30 seconds, in Medium → Low → Lowest order, leaving and
re-entering VR for each resolution. These are single stationary samples of a
living city, not a controlled before/after comparison. Battery temperature rose
from 27.2 to 31.0 °C across the series.

| Tier | FPS | Mean / p95 / p99 frame interval, ms | XR framebuffer, both eyes | CPU through stereo draw, ms/frame | Draw calls/frame |
|---|---:|---|---|---:|---:|
| Medium | 12.4 | 80.8 / 81.4 / 88.7 | 1064 × 491 | 42.4 | 631 |
| Low | 13.4 | 74.8 / 103.9 / 165.5 | 848 × 415 | 43.0 | 569 |
| Lowest | 15.5 | 64.3 / 71.9 / 132.8 | 694 × 340 | 39.1 | 497 |

Fixed order, scene changes and warming confound tier differences; Low's worse
p95/p99 also show why higher average FPS does not establish smoother play.
The recorder sampled the real XR animation callback, through the end of stereo
drawing; `renderer.info` was reset once per callback, so counts include the
shadow and other render passes. Lowest averaged 12.01 million triangles per
frame. Both eye views rendered with no console errors; even the best sample,
15.5 FPS, remained far below the 60 FPS target. CPU timing does not isolate GPU cost.

In a further 30-second active session starting with Lowest's framebuffer, Auto
used the fallback 16.67 ms target and stepped
High → Medium → Low → Lowest at about 0 / 7.8 / 15.5 / 22.5 seconds. The active
694 × 340 framebuffer stayed unchanged as designed; the final reported rate was
16 FPS. Re-entry applied the fixed-tier framebuffer sizes shown in the table.
No application code changes were needed for this check.

Raw frames, Auto transitions and the stereo screenshot are saved locally under
`docs/evidence/performance-2026-11-22/stereo/` (ignored by git). The owned test tab
was closed, temporary port mappings removed and the phone's sleep setting restored.
Pixel 11 Pro stereo and moving driving routes were not measured here.

## 22 November 2026 — stereo VR optimisation and optional shorter view

Follow-up measurements used real Cardboard-mode WebGL stereo on the Pixel 5 at
the Old Town Square, with two eyes, 600 people, Lowest graphics and the same
694 × 340 XR framebuffer. No viewer was fitted; the phone was recentered while
lying flat. Profiles include both eyes and the shadow/depth passes; CPU
times do not isolate GPU cost, and this phone has no usable GPU timer extension.
The clean starting revision was `84059da7`.

A fresh baseline averaged 15.2 FPS (65.7 ms mean, 91.6 ms p95, 186.8 ms p99),
with 11.27 million triangles per frame. The stereo CPU profile put about 33% of
sampled wall time inside rendering and 18% in simulation. Ground layers were
large and repeated for both eyes and the depth pass; cars and people also cost
substantial geometry. A moving profile later put about 10% in `Crowd.update` and
18% in WebGL program selection. Those are inclusive sampled shares, not separate
costs to add together.

Changes now implemented:

- Low and Lowest build ordinary surveyed ground at 4 m spacing instead of 2 m.
  Tile seams, step walls and road refinement retain their finer geometry, as do
  bridge decks and tunnel floors. Physics still samples the original terrain.
  Existing tiles are not rebuilt just because the graphics tier changes.
- VR skips distant ordinary cars and people outside a head-facing cone expanded
  by at least 45 m. The current eye pose and XR projection set the direction and
  width; nearby shadows/headlights, elevated actors, bridges, tunnels, unknown
  heights and steep head tilts keep conservative treatment. Populations and
  simulation continue. The invisible minimap stops drawing in an XR session.
- A saved **Shorter view in VR** setting offers a 120 m view with haze. It is
  **off by default**: every graphics tier keeps the previous 400 m horizon unless
  the player chooses it. Tile loading still covers 400 m, and the camera's far
  clipping plane stays unchanged so distant markers are not clipped away.
- Crowd escape checks prepare each threat's speed/direction once per simulation
  step, then use squared distances for each walker. This removes repeated square
  roots without changing escape/jump thresholds or random-number order.
- VR retains a material owner for each encountered static-tile WebGL program,
  up to 128 owners, so retiring a tile does not discard the last reference to its
  compiled shader. Duplicate programs do not retain another owner. Geometry and
  tile textures still dispose normally; retained materials release with the renderer.

The controlled comparisons switched geometry and drawing in one warmed stereo
session. Six-second windows alternated between the two configurations, three
times each, at 400 m. Full 2 m
ground with the old minimap work took 72.1 / 70.5 / 69.5 ms per frame; 4 m ground
with hidden minimap drawing disabled took 63.7 / 64.3 / 68.1 ms. Geometry fell from
about 11.7 to 7.1 million triangles per frame, with about the same 516 draw calls.
CPU time did not clearly improve. A series starting with the candidate and
including conservative car visibility took 77.9 / 74.9 / 77.5 ms before and
71.3 / 70.1 / 71.4 ms after, with about 5.6 million triangles. These were separate
runs, so the gains must not be added. Separate fresh candidate loads were slower
than the fresh baseline (93.0 and 80.1 ms). They are retained and not attributed
to heat. Battery temperature reached about 36.5–36.7 °C during the work; this does
not show whether GPU throttling occurred.

The 120 m samples showed lower geometry and draw-call counts than the 400 m runs
above. An application snapshot with the short view was checked: both eyes and
nearby scenery rendered without console errors.

| Lowest, 120 m | FPS | Mean / p95 / p99 frame interval, ms | Frames over 100 ms | CPU through stereo draw, ms/frame | Draw calls/frame | Triangles/frame |
|---|---:|---|---:|---:|---:|---:|
| Standing, 20 s | 22.3 | 44.9 / 66.7 / 73.8 | 0 | 36.1 | 233 | 2.10 million |
| Driving at 50 km/h, 12 s | 14.0 | 71.6 / 138.9 / 216.1 | 24 | 52.6 | 280 | 3.65 million |

These are single samples, **not a controlled final-code speed-up**. They preceded
the saved setting, final crowd threat preparation and shader retention. The
shorter view hides distant buildings behind haze; the game owner chose to keep 400 m
as the default and make the shorter view optional. A hard 120 m camera far plane
and frozen shadows were diagnostic trials only and were not kept. Neither these
numbers nor reduced geometry demonstrate smooth VR, especially while driving.

Final-code verification on the Mac: typecheck, production bundle build without
copying map assets, street-quality/VR pose and cache-lifecycle checks, the crowd
escape regression, ground area/bridge/tunnel checks, and 25 terrain seam/cut tests
passed. A real Chrome WebGL check retired/recreated three ground surfaces and
verified reuse of the same program with only one retained material owner.
Street-handling, tunnel-layers, pedestrians-escape and bike-hit scenes passed;
the Lowest overhead screenshot was inspected. The in-app browser confirmed the
new setting defaults off, persists when enabled across reload, and returns to off.
Full pipeline suites were not run.

The Pixel 5 became active in another app before the final-code timing run, so it
was left alone. Latest-code phone FPS at either distance, moving-route/head-turn
checks after the final changes, night/bad-weather coverage and long-session cache
memory remain open, as does Pixel 11 Pro testing. Raw frame arrays, CPU profiles,
prototype helpers, screenshots and logs are retained locally under
`docs/evidence/performance-2026-11-22/optimisation/` (ignored by git).

## 22 November 2026 — what the buildings hide at street level

Asked: how much of what the game draws at street level can't be seen, as a measure of
what occlusion culling could save (the idea behind GPU-driven renderers such as GTA VI's;
`docs/webgpu-vr.md` has the VR side). Nothing in the game culls by occlusion today: every
draw in front of the camera within the view distance is drawn.

Measured with `scripts/hidden-draws.js` through the scene runner, on the M5 in headless
Chrome, WebGPU, High, 1440 × 900, 14:00, clear. With the live game held still (no frames
drawn, shadow maps and shader time frozen, so two pictures of a view are identical), the
main pass's draws are taken away one at a time, biggest first, and each stays away if no
pixel changes. The set left out at the end changes no pixel as a whole (checked every
time: 0 pixels). Occlusion queries were tried first and dropped: three.js reads a
render's results at the next render with queries, and the answers mixed runs.

Views: six places (Karlova, the Old Town Square, Malostranské náměstí, Vodičkova, by
Charles Bridge, Můstek), each from eye height facing north, east, south and west; four
places from a car's driving seat at the same four headings; four places from the
ordinary overhead camera.

| Camera | Views | Draws hidden (median, range) | Triangles hidden (median, range) | Drawn per view |
|---|---:|---|---|---|
| Eye height, on foot | 24 | 87 % (74–98 %) | 76 % (44–99 %) | 300–490 draws, 4.9–15.3 M triangles |
| Driving seat | 15 | 84 % (76–95 %) | 70 % (52–82 %) | 330–500 draws, 5.8–11.0 M triangles |
| Overhead | 4 | 73 % (67–74 %) | 52 % (40–73 %) | 90–140 draws, 1.3–2.3 M triangles |

- **The ground is most of it.** At eye height the ground's layers are about three
  quarters of the triangles drawn (4.4 of 5.7 M on the Old Town Square facing north), and
  65–91 % of them are hidden. Draws more than 250 m away were 78–100 % hidden in every
  view broken down by distance.
- **Open places hide least:** the Old Town Square facing its open side 44 %, Malostranské
  náměstí facing east 49 %. Lanes and courtyards hide 85–99 %.
- **Overhead isn't free of it either,** but there it's mostly lower ground layers covered
  by the layers above them and lamps under the trees, not the buildings.
- The numbers are of one moment's streaming state: the same view measured twice drew
  5.7 and 6.5 M triangles (more tree pages loaded the second time), and the share hidden
  moved by up to 20 points between such runs.

Not covered: the sun's shadow pass (a caster hidden from the camera can still cast into
view), single instances of an instanced mesh (counted hidden only when all of them are),
the WebGL renderer used for VR (same scene, so similar shares expected), the phone, and
any timing: this counts work that could be skipped, not frame time.

What it suggests: occlusion culling at street level could skip roughly four draws in five
and most of the triangles, the distant ground above all. The game's draws are coarse (a
tile's ground layers, a tile's buildings), so a per-tile answer captures most of it. A
visibility table baked by the pipeline (which tiles can be seen from each patch of street)
would work in both renderers, VR included; hardware occlusion queries would be WebGPU only
and arrive a frame or two late. Before building either, a cheaper check: leave out ground
tiles beyond 250 m at eye height and see what the Pixel 5 gains, and how often a missing
tile shows.

### Leaving out distant ground at street level (`?farground`), same day

The first thing the measurement above suggested: in the street views, leave out the
ground of tiles more than 250 m from the camera (tiles are 250 m squares; the distance is
to the nearest edge). `FAR_GROUND` in `src/tiles.ts`, off by default, `?farground=250`.

**What it changes on screen** (the 24 eye-height views above, the game held still,
pictures with and without compared pixel by pixel): no pixel at all in 22 views. By
Charles Bridge facing south, 0.8 % of the picture: the far bank across the Vltava, a strip
at the horizon; facing west there, 277 pixels. Left out per view: 4–11 tiles' ground,
0–145 draws of 260–490 and 0–3.0 of 3.6–9.6 M triangles (median about 1.9 M).

**What it gains on the Pixel 5** (Chrome, WebGPU, Medium, first person, standing on the
Old Town Square, `--ab` in one page, 4 s windows, no screen touches): nothing measurable.
At the tier's own pixel ratio 21.0 fps off against 20.4 on (−3 %, within the windows'
spread, 26 °C); at 2× 14.4 against 14.6 (+2 %, 32 °C). In the bench's view it leaves out
4 of 12 tiles' ground: 366 → 335 draws and 5.57 → 4.66 M triangles (checked in the page on
the M5). The phone's frame there is held by its JavaScript (32–46 ms of 48–70 ms), which 31
fewer draws barely touch. The driving scene in first or third person couldn't be measured
on the phone: the bench couldn't get into the car there (it can on the M5), and the failed
runs left game tabs open that then stalled the next connection (closed).

So distant ground alone isn't worth turning on for phones at Medium. It removes
triangles, not much CPU, and the phone is CPU-bound in first person. Where triangles do
matter is VR: going from 2 m to 4 m ground (11.7 → 7.1 M triangles) took the stereo frame
from about 72 to 65 ms (above). `?farground=250` works in VR too (the switch is in the
tiles, not the renderer) and is worth a try in the headset. For the phone's main thread,
the larger share is the other hidden draws (buildings, trees, lamps, instanced meshes:
most of the 87 %), which needs real occlusion culling rather than a distance rule.

### The best occlusion culling could do on the Pixel 5, same day

Before building any culling: what does the phone gain if the draws the buildings hide
aren't drawn at all? `scripts/cull-ab.js` builds the hidden set with
`scripts/hidden-draws.js` in the page itself, once the bench has loaded (in the bench's
view, at half the picture's size), and `--ab` then moves those objects to the layer only
the sun's shadow camera sees. They leave the main pass but still cast, as with real
culling. The set is the one hidden at the start; nothing follows what comes into view
later.

Pixel 5, Chrome WebGPU, Medium at the tier's pixel ratio, first person standing on the
Old Town Square, 60 s in four-second windows, no screen touches, 29–30 °C:

| | Main pass draws | fps | Frame | JavaScript |
|---|---|---|---|---|
| Everything drawn | 188 | 15.9 (15–16 a window) | 63.0 ms | 44.4 ms |
| Hidden ones left out | 18 | 21.2 (21–22 a window) | 47.1 ms | 36.3 ms |

**25 % quicker a frame**; the windows don't overlap. 170 of 188 draws and 2.6 of 3.0 M
triangles were hidden there (all beyond 100 m, and 49 of 63 nearer). A control in the same
setup with a switch that does nothing measured 15.6 against 15.8 fps (1.5 %), so the
building of the set doesn't slow the page down. The baseline is lower than the 21 fps of
the morning's distant-ground test in the same scene (26 °C then); the gain is measured
within one page, so that doesn't change it. On the M5 the same switch in another view
halved the drawing calls of a whole frame (shadow passes included) with no visible change.

So culling is worth building: about 8 ms of JavaScript and 16 ms of frame on the phone in
one ordinary view, against nothing measurable for the distant ground alone. This is a
ceiling: a real culler costs something itself, keeps a margin round what it can't be sure
of, and has to follow the camera as it moves.

### The same with only the tiles' own meshes, same day

Both reviews of the culling plan (`docs/occlusion-culling.md`) pointed out that the 25 %
above could leave out anything that changed no pixel, including the shared instanced
pages (trees, lamps, cars, people) and ground layers covered only by other ground
layers, which a culler working with tiles can't. `hidden-draws.js` with `tiles: true`
lets only the tiles' own meshes go, each tile's ground layers as one.

In one view on the M5 (Old Town Square, first person, Medium) that is 89 of 272 draws
instead of 207 of 262. On the Pixel 5, same setup as above but the phone warmer (34.5 °C
at the start, JavaScript 60–67 ms a frame against 36–44 before):

| | Main pass draws left out | fps | Frame | JavaScript |
|---|---|---|---|---|
| Everything drawn | 0 of 188 | 14.3 (13–16 a window) | 70.3 ms | 66.7 ms |
| Hidden tile meshes left out | 70 of 188 | 15.9 (15–18 a window) | 63.0 ms | 60.2 ms |

**10 % quicker a frame**, the windows overlapping a little. Per draw left out it is the
same as the full set: about 0.1 ms of frame each (7.3 ms for 70, 16 ms for 170). So the
gain follows the number of draws, and a culler of tile meshes alone would get about 40 %
of the ceiling. The other 60 % is in the shared pages and the many small instanced
meshes: cull those as whole pages only if a page is all hidden, or give them pages per
area so they can go with the tiles.

### The culler prototype (`?cull`), same day

The sweep from the camera that both reviewers suggested, in `src/occlusion.ts` (details
in `docs/occlusion-culling.md`). In the 24 views it left out nothing visible (no changed
pixel) and caught 70 % of the truly hidden tile draws, plus 15–69 batches and other
meshes a view.

On the Pixel 5 (Medium, first person standing on the Old Town Square, `--ab` on
`culler.enabled`, 60 s, no touches):

| | fps | Frame | JavaScript |
|---|---|---|---|
| Off | 20.4 (20–22 a window) | 49.1 ms | 34.6 ms |
| On | 22.1 (21–24 a window) | 45.3 ms | 31.5 ms |

**7.7 % quicker a frame** (30.5 °C). A first run with every verdict tested every frame
gained 4.5 % (29.2 °C, 62.5 → 59.7 ms): the tests cost 1.5 ms a frame there, 0.6 ms once
verdicts were kept until the next sweep. The sweep costs about 15 ms on the phone each
time the eye has moved a metre; standing, that's rare.

### The culler's sweep in a worker, driving (22 November, evening)

The sweep moved into a worker (`src/occlusionSweep.ts`, `src/occlusionWorker.ts`), asked
for from where the eye will be in the frame that uses it and safe for an eye within
0.5 m of that (details in `docs/occlusion-culling.md`). Pixel 5, Medium, first person,
the drive scene in a sedan with lane assist, `--ab` on `culler.enabled`, 60 s:

| | Run 1 (27.1 °C) | Run 2 (27.7 °C) |
|---|---|---|
| Off | 9.0 fps, 116.1 ms, JS 54.1 ms | 8.8 fps, 115.9 ms, JS 47.6 ms |
| On | 10.0 fps, 101.6 ms, JS 47.1 ms | 9.9 fps, 103.4 ms, JS 48.2 ms |
| | **12.6 % quicker** | **10.7 % quicker** |

In 31 % of the frames there was no usable sweep (nothing culled), and with a new sweep
each frame the tests are all done again (19 ms in the last frame measured). Both leave
room. `bench.mjs` now runs `--eval-after` with `--ab` too.

Later that evening (details in `docs/occlusion-culling.md`): the guess of where the eye
will be now uses the measured lag (frames without culling 31 % → 20–23 %), and the tests
cost less at their worst (560 → 43–69 ms) but not on average (about 8.5 ms a frame on
the phone). Four more driving A/Bs: 12.7 %, 8.9 %, 8.3 % and 15.4 % quicker (28–33 °C).


### The drive that stood still with `&dev` (23 November)

The drive scene with `--extra "&dev"` stood at 0 km/h, on the Pixel 5 and on the M5
alike: `?dev` opens the developer panel and focuses its place search, which stops the
keys there (so typing a place doesn't drive the car), and the bench's Shift and W never
reached the game. Stepping the simulation by hand drove the car, so the start place,
getting in and lane assist were fine. `bench.mjs` now takes the focus off a text field
before pressing keys, and warns when a drive's car stands still after settling (naming
what has the keys).

Pixel 5, Medium, tier pixel ratio (1.5×), first person, sedan, `&dev`, 45 s, no touches:
6.9 fps both runs (29.4 °C and 30.1 → 31.2 °C), 30 km/h by lane assist from about 12 s
to the end of timing. At 7 fps the game's step limit (0.05 s) runs the world at about a
third of real time, so 30 km/h on the speedometer covered about 3 m a second.

## 23 November 2026 — the buildings drawn from a pool by the GPU (`?gpudraw`)

Stage 1 of `docs/gpu-driven-drawing-plan.md` (branch `gpu-driven-drawing`, details and
the picture checks there). Pixel 5, Medium at the tier's pixel ratio, first person
standing on the Old Town Square, `--ab` on `gpuDraw.enabled`, 60 s, no touches:

| | Off | On | |
|---|---|---|---|
| culler on in both, 25.4 °C | 73.6 ms, JS 38.1 ms | 97.7 ms, JS 40.8 ms | 33 % slower |
| culler off in both, 27.8 °C | 92.1 ms, JS 43.1 ms | 104.4 ms, JS 42.2 ms | 13 % slower |

No JavaScript is saved (it replaces only 12–16 draws a frame), and GPU time goes up even
with the culler off. Drawing the pieces nearest first didn't remove that. With the culler
on, the pool also loses the culler's occlusion. M5: 4.6 % quicker, within the noise. The
stage's stop rule is met. Later, with the culler off: skipping the compute pass changed nothing (128.4 → 133.2 ms),
and a pool with one piece per tile mesh (about 14 indirect calls) drew as fast as the old
meshes (113.9 → 111.3 ms). So the loss is the ~1,100 indirect calls a frame at 8 × 8
pieces, most of them drawing nothing, on a GPU-limited phone. With the pieces sorted
nearest first the Adreno hung and Chrome's GPU process crashed in every run (3 of 3,
none of 4 without).

Later still (`gpuDraw.visibleOnly`: the CPU writes the visible pieces' arguments packed and
calls them in a row, details in the plan doc). Pixel 5, charging, same scene: calling only
the visible pieces against every slot with the culler off, 105.0 → 94.2 ms (10.3 %
quicker). The pool against the culler alone: 76.4 → 78.5 ms, the same within the windows,
against 33 % slower in the first run. No GPU crash in either. Calls at offsets with gaps or
out of order had hung the Adreno every time. Note for indirect draws in three.js r187: a
CPU change to `geometry.indirect` isn't uploaded unless the mesh gets a full refresh, so
write it through `renderer.backend.updateAttribute`.

Last (`gpuDraw.occlusion`: the culler's sweep verdicts applied to the pool's pieces): the pool
against the culler alone, standing on the Old Town Square, 77.8 → 79.7 ms, the same. Stage 1's
stop rule holds. Driving, once the bench's keys reached the game again (the `&dev` fix
above): culler alone 158.2 ms, pool 164.4 ms, the same within the windows (4–10 against 5–8
fps).

A Pixel 11 Pro (23 November, evening) is limited by its GPU too, JavaScript about half the
frame: the pool against the culler alone was about 5 % quicker standing (High: 35.9 →
34.2 ms) and the same driving (47.5 → 47.3 ms).

### The nearby people's ceiling on the Pixel 5 (23 November, afternoon)

`--ab` on `lifeSize.enabled` (Rocketbox avatars against the instanced figures they replace),
Medium at the tier's pixel ratio, standing on the Old Town Square, 60 s, no touches, 29.7 °C,
no `&dev`: 54.0 ms against 53.8 ms a frame (JavaScript 25.5 and 24.2 ms). There's no gain to
be had from instancing the avatars at Medium. The same scene with `&dev` took about 75 ms
with 36 ms of JavaScript that day: **leave `&dev` out of phone timings.**

## 23 November 2026 — where the Pixel 5's GPU time goes on the ground

`scripts/ground-ab.js` through `--ab`: every drawn tile's ground layers get a cheaper
material (the depth-only meshes and the soft shading stay). Medium at the tier's pixel ratio
(1.5×), standing on the Old Town Square, 60 s each, no `&dev`, no touches, 28–34 °C. Without
the ground's cost the phone would no longer be limited by its GPU (JavaScript about 25 ms).

| Left out | Frame | Saved |
|---|---|---|
| nothing (the run's own off windows) | 52–54 ms | |
| the whole ground (its layers hidden) | 52.3 → 26.5 ms | 25.8 ms, half the frame |
| all shading (an unlit flat colour, same draws and stencil) | 54.5 → 35.2 ms | 19.3 ms |
| all but the sun's light and shadow (no pattern, mirror, normals or sky darkening) | 52.9 → 40.7 ms | 12.2 ms |
| the pattern (`userData.flatten()`) | 53.4 → 46.8 ms | 6.6 ms |
| the sun's shadow (`receiveShadow` off) | 51.8 → 46.7 ms | 5.1 ms |
| the sky darkening (`aoNode`: one read of the tile's sky texture) | 54.1 → 49.9 ms | 4.2 ms |
| lamp light, the wet mirror and the sheen (`emissiveNode`) | 53.7 → 49.7 ms | 4.0 ms |
| the paving's and setts' normals | 64.6 → 62.6 ms | 2.0 ms (a slow run, 33 ms of JavaScript) |

So the ground costs the phone about 26 ms a frame now, against 14.6 ms at 2× on 11 November
(since then: the street look, raised kerbs, the wet mirror and sheen). About 9 ms of it is
drawing the layers at all, even unlit; 52 of the frame's 169 draws are ground layers. The
shading's 19 ms splits roughly into the parts above, which add up to a little more than the
whole. The plain-colour swap (`colorNode` only) saved nothing: the emissive part reads the
same colour, so the pattern and weathering run anyway.

Leads, unmeasured: the 9 ms of drawing (number of draws or layers over each other, on a
tiled GPU); one read for the sky and relief textures together; a cheaper shadow lookup on
the ground at Medium; the pattern's cost on phones.

Two variants first failed to compile on the phone and looked like large savings:
`Material.clone()` leaves out the tile textures the ground's graph reads from the material
(`reliefMap`, `skyMap` and so on). Check the bench's console lines before trusting an A/B.

Then the 9 ms of drawing the layers unlit, split (`collapse`: the same draws and vertices,
every vertex moved to one point so no pixel is drawn; `merged`: every tile's layers as one
unlit mesh, the same pixels in one draw, no stencil). Same scene and settings, 25–30 °C:

| Pair (off → on) | Frame | |
|---|---|---|
| unlit layers → the same draws drawing no pixels | 36.4 → 32.2 ms | the pixels: 4.2 ms |
| no layers → the draws drawing no pixels | 38.1 → 43.1 ms | the draws and their vertices: 5.0 ms |
| unlit layers → one merged draw | 35.1 → 37.1 ms | 2 ms slower, windows overlapping |

So the cost of the layers' draws is their vertices, not the number of draws: one draw with
the same triangles was no quicker. Counted in the page (first person, Medium, the same
place): 13 tiles drawn, 344 ground layers, 6.1 M triangles and 3.4 M vertices in them,
311–621 thousand triangles a tile. A coarser ground for the farther tiles is the lead for
that part, not fewer draws. (The run with no layers took 38.1 ms, against 26.5 ms in the
first run: compare within a run, not across runs.)

### The ground draped by error (23 November, late afternoon)

Most of the ground's GPU time on the phone is its triangles, so the next step was fewer of
them. `scripts/ground-lod-ab.js` has the tile workers build every drawn tile's ground again
and swaps it in (`--warmup 40`), standing, Medium, 60 s, no `&dev`, no touches:

| Ground | Old Town Square, 8 tiles | |
|---|---|---|
| triangles up to 8 m everywhere (4.46 M → 0.47 M triangles) | 52.4 → 37.2 ms | 29 % quicker |
| up to 4 m everywhere, as on Low (→ 1.32 M) | 52.1 → 40.7 ms | 22 % quicker |
| 8 m only for tiles over 100 m away | 49.6 → 46.6 ms | 6 %: the triangles that cost are near you |

A uniform 8 m ground loses the shape of slopes and kerbs, so instead the ground is draped
by error (the TIN plan's idea): triangles up to 8 m, an edge split down to the tier's 2 m
only where the terrain or the kerbs' depth is more than 3 cm off the straight line at a
quarter, half or three quarters along it. The test reads positions only, so layers sharing
a border split it alike.

| Draped by error | Triangles in the tiles' ground | Pixel 5 |
|---|---|---|
| Old Town Square (`stand`) | 4.46 M → 0.89 M | 55.1 → 40.2 ms, 27 % quicker |
| Petřín (`woods`, the trees hold it at 5 fps) | 8.42 M → 3.24 M | 209.5 → 194.6 ms, 7 % |
| Malá Strana (`strana`) | 3.37 M → 1.10 M | 71.7 → 66.3 ms, 7.6 % |

The same frame held and drawn with both grounds (M5, Medium): 18 to 1,035 pixels of a
million differ at Petřín and Malostranské náměstí, at eye height and from above, all of
them one-pixel lines where the ground meets a wall or a step. Building a tile's ground in
the worker: median 133 → 171 ms on the M5 (the first version took 7 times as long; the
test now answers each edge once). On by default on every tier (`groundFlat: 8`).

### The sun's shadow read once (23 November, evening)

Turning the ground's sun shadow off saved 5.1 ms above, so the next try was a cheaper
lookup: three.js's `BasicShadowFilter` (one hardware-compared read) instead of the PCF
filter every tier below Ultra uses (five reads in a rotated disc). `scripts/shadow-ab.js`
swaps the filter on the sun's shadow for every lit material, not only the ground, and
builds the materials again each switch (`--window 5 --warmup 10`). Pixel 5, Medium, 60 s,
no `&dev`, no touches, 25–28 °C:

| Place | PCF → one read |
|---|---|
| Old Town Square (`stand`, held at 30 fps) | 33.2 → 32.9 ms |
| Malá Strana (`strana`) | 42.3 → 42.4 ms |

No saving: the four extra reads cost the phone nothing measurable, so the shadow's cost on
the ground is the lookup itself (the shadow coordinates and the map read), not the filter.
The single read also gives the large shadows across the square a slightly harder edge.
PCF stays.

### The lamp and mirror code by day (23 November, evening)

By day the lamps' light and the puddle mirror are switched off by uniforms, but their code
is still in the ground's shader, and on phone GPUs code that never runs can still cost
(registers). `userData.day()` builds each ground material without it (the sheen and the
water stay; by day the picture is the same, `LAMP_ON` and `MIRROR` both 0), and
`scripts/ground-ab.js` 'day' swaps it in. Pixel 5, Medium, 60 s, no `&dev`, no touches,
28–31 °C:

| Place | Game's ground → without the lamp and mirror code |
|---|---|
| Old Town Square (`stand`) | 41.4 → 40.9 ms, 1.3 % |
| Malá Strana (`strana`) | 43.7 → 42.0 ms, 3.9 % (windows overlapping) |

So of the 4.0 ms the whole emissive part cost, the code that is off by day is at most
about 1.5 ms. Not enough to swap the ground's shaders at dusk and dawn (each graph compiles
on the main thread, 7–60 ms), so the game keeps one shader; the variant stays for tests.

### Mipmaps on the ground's tile textures (23 November, evening)

One read of the sky-view texture cost the phone 4.2 ms above. It is one texel a metre
(250 × 250 a tile) without mipmaps, as are the relief, road-coverage and deck-mask textures,
so the far ground reads them scattered. `scripts/mip-ab.js` gives all four mipmaps and
trilinear filtering. Pixel 5, Medium, 60 s, no `&dev`, no touches, 31–32 °C:

| Place | Game's textures → with mipmaps |
|---|---|
| Old Town Square (`stand`, held near 30 fps) | 33.7 → 33.3 ms, 1.1 % |
| Malá Strana (`strana`) | 44.3 → 43.6 ms, 1.5 % |

Within the noise, and the picture is the same, so the textures stay as they are. With the
shadow filter and the lamp and mirror code, three of the four shading leads above came to
little; what is left is the pattern (6.6 ms), which is the look itself.

### Street-level façades on Vodičkova (23 November)

From 50.0804883, 14.4239302, facing 247.6° on foot, desktop Chrome ran the original
façades (`21da2fbe`) and the revised façades in three alternating pairs. WebGPU, High,
1×, clear summer afternoon, eight seconds per run. Mean frame times were 7.33, 7.39
and 7.76 ms before, and 7.50, 7.33 and 7.98 ms after. The average difference of
0.11 ms was smaller than the variation between runs. Mobile performance is unmeasured.

### Panel-house loggias on Poznaňská (23 November)

At 50.1301764, 14.4199635, looking 35° along a Bohnice block with the camera tilted
18° up, three alternating desktop WebGPU runs averaged 6.5 ms per frame at `72fde5f8`
and 6.8 ms with the larger windows and modelled loggias. High, 1×, clear summer
afternoon, eight seconds per run. The 95th percentiles were 7.2, 7.3 and 9.0 ms
before, and 7.1, 8.9 and 9.4 ms after. Both versions slowed during the test.
These measurements cover a standing desktop view. Mobile frame time is unmeasured.

### Walking through the trees at Petřín (24 November)

At 50.083, 14.3965, facing 140°, the original tile-wide distance check drew the
detailed trunk, boughs and leaf sprays on 11,483 trees. Selecting by each tree's
position drew them on 1,764. Both versions accounted for all 12,939 trees in the
same loaded pages. The detailed meshes contained 16.25 and 2.60 million triangles
respectively before camera culling.

On a Pixel 5, WebGPU Medium at 392 × 745 and 1× resolution, the page and individual
selections averaged 139.1 and 109.5 ms per frame in eight alternating six-second
windows. A second run kept individual selection on and changed only the distant
crowns' tuft rims. Full and eight-point rims averaged 100.0 and 84.3 ms, with
four windows per setting. These are separate within-run comparisons. Even the
lighter forest averaged only 11.9 fps in that second run.
