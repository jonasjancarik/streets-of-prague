# To do

Possible next steps after the performance work of 27–29 September 2026 (the layered
pipeline, tiles built in workers, parked cars kept out of the per-frame work, gzipped
tile files, cheaper ground shading). Rough order: quick wins first.

## Serving

- **The old uncompressed tile files on mbxp are gone**, except one
  (`praha_now/tiles/84_68.bare.bin`, no `.gz` beside it, so probably still in use;
  checked 3 October 2026).
- **Map data is cached at Cloudflare's edge.** Plan 003 is done: the map is served from
  `data.streetsofprague.com` (R2, hashed names) and the beta reads it from there too.

## Game performance

Plans 007–011 and plan 012 Part A are selected for main; see
[the findings and merge summary](docs/optimisation-findings-007-012.md). Part B
(the incremental resting-car index) stays experimental: it was consistently 3.5%
slower per frame on desktop despite fewer index updates. Main retains the original
collision index. An isolated retest is pending (see plan 012's follow-up); competing
game instances have not been established as the cause of that result. No general
FPS improvement is established for this set.

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
- **The street graphs only grow.** The drive and walk graphs, street names and the
  crowd's index keep the edges of every tile ever loaded, so memory grows over a
  long session across the city. The police's route search runs over the graph,
  including tiles that have been dropped, so shrinking it needs care.
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
    [plan 008](plans/008-prepare-car-meshes.md) for tests and trade-offs.
    Plan 015 now separates paint from body geometry on both renderers, retaining
    128-car pages per type and courier-box variant. Car-body draws fell about 84%
    on the counting drive (72 → 12 per pass) and 81% standing (36 → 7), with no
    overflow or late pages. Pool checks, palette/wreck equivalence, seeded and
    parked-car hashes, WebGPU day/night/snow screenshots and the build passed.
    Both renderers passed day/night/snow screenshot comparisons. Three alternating
    drive pairs favoured the change (12.7 → 9.6 ms/frame), but loading-time drift
    and the lack of an unchanged-build control leave the timing benefit provisional. See
    [plan 015](plans/015-paint-cars-per-instance.md) for evidence and limits.
  - **Worker scheduling:** plan 012 Part A prioritizes required jobs, allows one
    job per worker and coalesces optional sky refreshes. Desktop and Pixel 5
    comparisons had no missing player/ahead-tile frames. Frame-time differences
    were inconclusive; keep the existing worker count.
  - On a warm Pixel 5 there are also 20–24 ms spikes in `crowd.update` and 12 ms in
    `trams.update`.

## Pipeline

- **The ground layer's own cost.** With the OSM parsed and cached, a ground rebuild
  is almost all `osm_area.extract`: merging the street surfaces, the kerbs and the
  gardens (about 5 s for a dense suburban chunk). The gardens could become a layer
  of their own, rebuilt only when the buildings or the gardens rule change.
- **Assembly for the whole city takes about 16 s**, reading all four chunked layers
  and comparing every tile. It could put together only the chunks whose layers
  changed.
- **The caches take about 2.5 GB** in `pipeline/.cache` (parsed OSM chunks, parsed
  IPR sheets, layers), on top of the OSM extract and the IPR sheets. Stale ones
  (after a new OSM extract, say) are replaced as they're rebuilt but never removed.

## Terrain

- **Rebuild the terrain for the city.** Done locally: the seams at tile edges are
  fixed in the pipeline and the game (29 September 2026), and the `centrum`, `praha`
  and `ujezd` tiles on disk were rebuilt after the fix. The map rebuilt with the new
  terrain was uploaded as 2026-10-02 and 2026-10-03 and is live (v0.5.2). See "Terrain
  grid" in the README.
- **Steps in the ground: what's left.** Quay walls, retaining walls and bridge heads
  are steps (merged into main; "Steps in the ground" in the
  README; how to work on it: `.agents/skills/terrain-steps/SKILL.md`), built for
  `praha` and looked over at every bridge over the Vltava and Nuselský most. Still to
  do: steep slopes with no surveyed wall (streets in cuttings, the hillside under
  Letná), where the 4 m lattice still shows (the ground beside surveyed streets follows
  them since `FEATHER`, which took the teeth off paths; two places are in
  `pipeline/terrain_keep.json`); railway cuttings; walls that stop cars and people
  (they can still go over an edge, and drop); frame times and the WebGL renderer.
  Bridges still off: Železniční most ends 1.8 m above the street at Výtoň (the
  embankment isn't in the terrain), Libeňský most's south part has steps of 1.3 m at
  both ends (as on main), Nuselský most's Pankrác end has small ragged corners by the
  abutment, and the long bridges at Lahovice and Radotín have breaks in their decks.
  Source spikes near Nosticova and the south-east edge of `ujezd` are fixed by rejecting
  grossly inconsistent survey vertices before interpolation (2 October 2026,
  `docs/river-terrain-findings.md`); verified on private `ujezd` data only.
  Ground cutting now follows the actual outlines, including narrow enclosed terraces
  and three levels meeting, with independent tile-edge regressions. Six `ujezd` tiles
  had 1,516 sampled step-crossing triangles before and zero after; total geometry grew
  by 0.082% in bytes, with a measured CPU loading cost. Full-city and frame-time checks
  remain open; see the same findings document.
  Independent review then found a pre-cut refinement seam on curved terrain.
  A shared 2 m perimeter/profile contract fixes it, with nine complete-path checks;
  geometry is now 4.12% larger than the first cutter checkpoint. Stored-height
  disagreements remain separate. The findings retain both checkpoints' evidence.
- **Hill shading for a moving sun.** The shading is baked per tile to the fixed
  north-west sun (`relief()` in `src/tiles.ts`, `SUN_OFFSET` in `src/main.ts`). If
  the sun ever moves with the clock, store the slope per tile instead and light it in
  the ground shader.
- **Hills casting shadows.** The terrain doesn't throw shadows, so a hill never
  puts a valley in shade. Hardly noticeable with the current midday sun; worth doing
  with a low evening sun.

## Bridges and tunnels

Left over from putting bridges and tunnels on levels of their own (28 September
2026, `pipeline/structures.py`).

- **Paint and tram tracks where two bridges cross.** A street's road paint and each
  stretch of tram track are drawn on the one level they mostly lie on
  (`mostlyOn` and `splitByLevel` in `src/ground.ts`). Where a flyover crosses
  another bridge they can end up on the wrong one, painted over the upper deck or
  hidden under it. The pipeline knows which level each way is on and could hand that
  to the game with the street edges, instead of the game guessing from the masks.

## Gameplay and look

Noted on 28 September 2026 while playing, during the TypeScript refactor.

- **Paths and pavements.** Plan 018 phases 0–2 are in main and live in v0.5.2. Matching route ribbons over squares and island/link ribbons
  are removed; cobbled walking streets use setts. Named square outlines keep their
  mapped green and water, so Karlovo náměstí is a park with paths again. The local
  `centrum` test has 88.3% less mosaic overlap with squares and 28.7% fewer path
  points. Whether the 2026-10-03 map includes these surfaces is unconfirmed. See
  `plans/018-simplify-paths-and-pavements.md` for the matched pictures; gap-closing and surveyed pavement polygons remain deferred.

- **Fill the plain beige areas.** Plan 013 phases 0–3 now give squares their OSM
  surface, make the general pavement asphalt grey, and add surveyed courtyards and
  green from the DTM in the shared local tiles. The centre's plain ground fell from
  182.64 to 72.20 ha. Whether the uploaded 2026-10-03 map includes this is unconfirmed. What's left includes
  unmapped ground, verges and car parks on bare earth. The prototype
  (`pipeline/ground_cover.py`, `?cover=rules` in the game) classifies IPR's 2024
  orthophoto and 2025 surface model into grass, trees, dirt, gravel, asphalt and "not
  ground"; tried on 49 tiles round Smíchov. Still to do: run it for the whole city (a
  16–65 GB photo download), and fold it into the build.
  About a third of the beige pieces in town are roofs or site clutter and some are
  roadway the streets don't reach: gaps in the map data rather than missing ground.
  Next step for courtyard materials: `plans/014-classify-courtyard-surfaces.md`.
- **Painted photo, with stronger filters.** `ground_cover.py ortho` (`?ortho` in the
  game) paints the orthophoto through an anisotropic Kuwahara filter; at 0.5 m/px it
  still looked like a blurry photograph. To try: a bigger, more stretched brush;
  fewer colours (the game's own ground palette); 1–2 m/px; evening out the photo's
  own shadows; darker edges; and painting each tile with a margin from its
  neighbours so the tiles don't show seams.
- **Roof and wall colours from the photo mesh** (plan 005, in main; since 30 September 2026:
  `pipeline/mesh_colours.py`, roof materials in the shader, flat roof materials,
  mansard windows, roof windows found on the mesh, chimneys by rule). Measured for
  the whole city on 1 October 2026 (`praha`: 5,703 tiles, 230,056 buildings) and built
  into the local `praha_now`. Left: walls measured only for about 42 %
  of buildings, since the photographs are a morning's and walls facing west or north
  are in shade (their colour can't be recovered; the rest keep the palette); mansard
  windows and chimneys lined up with the facade's bays; checking the roof-window
  detection for false finds (ujezd has 3,851 on 710 of 938 buildings); how much the
  chimneys and windows cost (ujezd's buildings grew from 1.9 to 3.0 MB).
- **Firefighter job.** Phase 4 of `plans/006-firefighters.md`: firefighting as a job,
  once the mission engine from plan 004 exists. The rest of the fire brigade (engines,
  crews, lights, sirens, giving way, stealing an engine, the water cannon) is in.
- **Tyre sounds, switched off.** The road noise and the rumble on stones were filtered
  noise and sounded like it, so both are at 0 (`TYRE` in `src/audio.ts`; the squeal in
  a slide is still on). Bring them back as recordings, played louder and higher with
  speed. Found on Freesound, not downloaded: asphalt 477825 (klankbeeld, CC BY 4.0,
  a hybrid at 50 km/h) and 425398 (Soundholder, CC BY 3.0); setts 591078 (orlandorizo,
  CC0, from inside) and 528562 (Garuda1982, CC0, from outside). The engine voices
  aren't liked yet either: tune them on `sound-test.html` (dev server only), which has
  sliders for every number of the engine and the tyres.
- **Fire engine polish.**
  - A driven engine uses the petrol-car engine sound; give it a heavy diesel voice.
  - After a fire is out, an engine can take about 40 s to clear a narrow street.
  - Cars give little room on narrow Old Town streets (no space on the right).
  - Not measured yet: `scripts/bench.mjs --vs` with the jets, the water cannon on a
    phone, and the siren levels in a real browser.

## Radio

- **Radio stations by vehicle type (optional).** Station blocking, equal random
  selection and selection weighted by published listener numbers are implemented
  in the expandable Radio settings. Zero radio volume stops all radio downloads.
  Extra to consider: vary station selection by the type of vehicle the player enters.

## Weather and night

Seasonal ground (plan 023 step 3) is implemented in an isolated checkout: fresh
spring grass, late-summer dry patches, winter olive grass, November–March woodland
litter, spring crops and harvested earth. Evergreen hedges keep their foliage.
The 15 July surface palette stays unchanged. Date regressions, typecheck and 30
scene checks per renderer pass, with 48 matched seasonal images and real field
and hedge views. Warmed 2× A/B comparisons in both renderers preserve draw counts;
their small or contradictory frame-time differences leave the ground cost
unresolved. See [the evidence](docs/evidence/seasons-step3/README.md). The source is
merged into main; deployment remains separate.

Bird ambience now follows the fixed date too: strongest on spring mornings, reduced
in late summer and nearly silent in winter, while July's familiar mix and the
weather/place suppression remain. Only the existing loops' gains change, through
their two-second fades. Deterministic date/time/weather checks, offline recording
levels and a muted runtime smoke pass: date propagation, expected real targets,
retained gain/filter nodes and weather suppression. See
[the evidence](docs/evidence/seasonal-birds.md).

Plan 023's start-screen step is complete: four seasons, a poster that follows the
chosen or saved season, and English/Czech labels. The current season starts on
today's Prague date; other buttons use representative dates, while date links and
saved games keep their dates. Live Prague weather is available only for today's
game date. CPU state/URL/Czech checks and desktop/touch-width menu interactions
passed (`scripts/check-start-seasons.mjs`). The seasonal ground and hedge work is integrated locally alongside these controls.

What's in since 29 September 2026: clear, cloudy, rain, mist and snow
(`src/weather.ts`), IPR's street lamps with a light map over the view
(`src/lamps.ts`), headlights, lit windows and trams, rain and wind sounds.

- **What it costs** (measured on 29 September 2026, 2× on an M5 in Chrome, standing
  by the Old Town Square, rather noisy): rain, a storm and mist about 10–15% more a
  frame than a clear day, snow about 20%; night about the same as day. If phones
  struggle, the mist and the ripples could go in the Lowest graphics tier.
- **Hung lamps where there are none.** Streets with no IPR lamp within 20 m get one
  over their middle every 30 m (their real lamps hang on cables or walls, which the
  utility map mostly lacks). Motorways, service roads and tracks get none; footpaths
  in parks are left dark unless IPR has lamps there. Could also look at OSM's
  `highway=street_lamp` and `lit=yes` for streets that should be dark.
- **Lamps light the roofs of low sheds.** The light map keeps the height of the ground
  under the brightest lamp and fades the light 3–11 m above it, so a low roof next to a
  lamp still gets some; walls next to floodlit monuments get light up to about 25 m.
- **Live weather beyond the start.** The start screen takes the real weather in
  Prague from Open-Meteo (free only for non-commercial use; if the game takes more than
  donations, switch to ČHMÚ's open data, CC BY, which needs a small proxy). It could
  also follow the real weather as the game runs, not only at the start.
- **Puddles where the water gathers.** They're placed by noise; the terrain's low
  points and the kerbs would be better.

## Landmarks

- **A tree baked into Mánes's roof.** The tree at the building's north-east corner,
  on the embankment, reaches over the roof in IPR's photorealistic mesh, so a dark
  smudge of it is baked into the roof's texture (`pipeline/landmarks.py`). A tree of
  the game's own there may hide it once trees come from the city's greenery records
  (see "Trees from the city's greenery records" below); otherwise, paint the roof's
  colour over green texels near the roof's edges when baking.

- **Týn Church: bare and blocky walls at street level.** The lowest 3–4 m of the
  west and south walls have white patches and a few coarse blocks in the baked texture:
  the photographs never see the ground floor there, because of the houses, the arcade in
  front of the west front and the crowds on the square, so the bake fills the gaps from
  around them. Only a player next to the wall sees it. Filling those texels from the
  nearest sharp wall texture, or leaving the ground floor to the game's own facade
  texture, would hide it.

## More map data

Open data found on 28 September 2026. Trees are used now (below); the rest is not used yet, except where noted. All IPR Praha, CC BY; the
feature services are at `https://mp.iprpraha.cz/arcgis/rest/services/Hosted/<name>/FeatureServer/0`
(paged queries, 2,000 features at a time).

- **Trees from the city's greenery records (done: `pipeline/ipr_trees.py`, in the game).** `OPK_CUR_OPK_SMZ_VP_B` has 171,000
  trees (`kod_vp` 71) and 30,000 shrubs (51), each marked conifer, broadleaf or
  fruit tree (`kod_drevin`); OSM has about 20,000 trees in Prague. Only greenery the
  city and its districts look after, so no private gardens: for those, IPR's 1 m
  surface model minus the terrain gives the tree crowns' heights.
- **Lawns, shrubs, hedges and flower beds.** `OPK_CUR_OPK_SMZ_VP_P`, 127,000
  polygons, for the plain beige ground in parks, housing estates and along streets.
- **Street furniture from the archived utility map.** `DTMP_CUR_TMISZNAK_B`, 1.39
  million points by `ctmtp_popis`: manhole covers (174,000), storm drains (71,000),
  traffic lights (5,700), hydrants, phone boxes, substations. Only the street lamps from it
  are in the game; the rest is unused (`pipeline/build_lamps.py`).
- **Walls, fences, railings and steps from the technical map.** Set 3 of the DTM
  (lines and points), already downloaded to `pipeline/.cache/dtm/ZPS_KR/` (same
  download list as `dtm.py`, `code=03`). Could add to or replace OSM's walls, and
  block the player.
- **The rest of the technical map's surfaces.** Set 2 (what `dtm.py` reads) also
  has pavements, traffic islands, separate tram tracks, yards and kept greenery;
  its levels tell bridges and the metro apart.
- **Building age** (catalogue: "Stáří zástavby") to pick facade styles, instead of
  guessing from where a building stands and how tall it is.
- **Noise maps** (day and night, road traffic on its own) for how loud the
  background sound is in a street.
- **Smaller things:** tree-lined avenues, memorial trees, retaining walls, noise
  barriers, fountains, drinking fountains, public toilets, recycling bins, parking
  meters, playgrounds. All in the catalogue at <https://opendata.geoportalpraha.cz/>.

## Left over from the night of 29 September 2026

- **Garden trees cost triangles.** The scattered garden trees and shrubs roughly
  doubled the triangles in view in a garden suburb (0.57 M → 1.19 M near Na
  Slatinách). Shrubs now have a mesh of their own, 92 triangles instead of the
  crown's 340 (30 September 2026): 1.22 M → 1.06 M at a fixed spot there, on both
  renderers. A park spot with no shrubs didn't change (0.38 M). It didn't show in
  frame time: on a Pixel 5 (WebGPU, 1×, `--android --vs`, three pairs) 24.7 → 25.0 ms
  a frame with 15 ms of JavaScript, so that phone is CPU-limited; on the M5 the pairs
  were too noisy to read (the machine was busy). What's left is the number of
  trees, not their triangles: thinning the garden scatter or giving far crowns fewer
  triangles is a separate decision.
- **Garden trees: cut the number of meshes and trees, not triangles.** The shrub mesh
  above saved triangles but no frame time, so the cost is per tree and per mesh. Options
  to try, separately from the scatter density and the tree crowns:
  - Thin the garden scatter with distance, or give far trees a cheaper shape.
  - Use simpler trees throughout the suburbs: one low-triangle crown for every garden
    tree (broadleaf as well as shrubs), or a plain blob beyond a few tens of metres.
    Judge it by frame time on a phone first (`--android --vs`), then by how the
    suburb looks from the street.
- **Third tree mesh: check its shader-build cost.** Each tile now makes three instanced
  tree meshes, and every `InstancedMesh` pays its own shader build (~14 ms at 1× on an
  M5, ~60 ms on a Pixel 5). Run `--stalls` on the drive scene, old against new, and
  look for extra builds or hitches as tiles arrive. If there are any, merge shrubs and
  broadleaf trees into one mesh, or don't make the shrub mesh for a tile with no shrubs.
- **Shrub mesh: measure again on an idle M5.** The M5 pairs were too noisy to read (the
  GPU was busy with other apps, the new build always ran second, and one run fell to
  37 fps). Redo `--vs` with alternating and swapped order, three or more pairs, after
  checking CPU and GPU load. The phone already showed no change in frame time.
- **Stolen police-car lights (done, `b075b47`).** Flash while the player drives, including
  when stopped or reversing; switch off on exit and return on re-entry. Siren policy is
  unchanged.
- **Buses.** They follow PID's real lines (`pipeline/build_buses.py`) and stop at the
  stops, but a line is lost where the map has no street for it (148 at U Nemocnice),
  buses often crawl in the Old Town's traffic. Line numbers are on the front, side
  and roof; the front number is enlarged and the side board keeps the destination.
- **Traffic by time of day.** The number of cars follows a TSK travel-time profile
  and favours main roads, but it is one city-wide figure; queues on the real routes,
  direction of the peak and car mix are next. See `docs/traffic.md`.
- **Boats.** Cruise cabins and navigation lights are visible at night; pedal and
  swan boats now carry a white lamp, using the shared night switch without extra
  light objects. Moored boats require a short, clear route to low walkable ground;
  boarding and exiting use the same rule and reject high quays, walls and railings.
  The three moored boats passed boarding/exiting on the private centrum snapshot
  built 2 October at 20:16 UTC, and a pedal boat travelled below Legion Bridge's
  deck at water height. Other bridges, phones and water-height seams remain
  unchecked; PID's ferries are still absent. See [boat access](docs/boats.md).
- **Parked cars at tile edges and corners (fixed).** Parking now waits for the
  neighbouring street JSON and reserves the route's turning curves, including
  vehicle overhang and a bus's axle/heading sweep. Paid-section targets are unchanged;
  bays that obstruct those paths stay empty. CPU checks cover neighbouring lane
  offsets, both tile orders, narrow streets and ordinary/bus turns. A real WebGPU
  replay at Ostrovní–Opatovická reproduced a 0.38 m bus/parked-hatch overlap in the
  old placement, then passed with the candidate parking. Tiles `8_5`/`7_5` reloaded
  in either order with identical parked-car layouts and no duplicate centres.
  Citywide driving and emergency routes remain unchecked; see `docs/traffic.md`.
- **Rebuild the streets layer for the metro fix.** Metro station corridors and stairs
  are no longer tunnels (`station_ways` in `pipeline/structures.py`, 29 September 2026).
  The whole map was rebuilt after that (uploaded as 2026-10-02 and 2026-10-03), so this is
  done in the live map; local `praha` and `ujezd` data was not checked.
- **Taxis.** Hail one with T or order one from the two made-up apps (`src/taxi.ts`).
  They can creep or stall behind parked cars in narrow Old Town streets, their routes
  are sometimes long, and the apps have no phone screen of their own. The touch
  button now names its action (close menu/cancel request), and cancellation clears
  request state before rebooking. A touch-sized browser check is recorded in
  `docs/taxi-controls.md`; a physical-phone check remains open.
- **A tile-load error at start, seen twice** (`TileWorld.loadNow` → `fetchTile`, under
  heavy load, not reproduced). Startup now retries a failing tile and carries on
  without it; the cause of the failed download itself wasn't found. A separate
  deterministic defect is fixed: HTTP failures for required terrain, bridge or IPR
  binaries, and successful downloads with invalid decoded lengths or IPR counts,
  now fail the tile fetch instead of caching absent geometry. HTTP 204 levels no
  longer become cached all-NaN grids. CPU checks cover legacy optional layouts,
  recovery, abort, gzip and obsolete requests
  (`scripts/check-tile-fetch.mjs`); this does not establish the original heavy-load cause.
- **Raised buildings from IPR.** Passages and walkways over a street are left out of
  the collision only when OSM has `min_height` (3 m or more); raised parts only in
  IPR's 3D buildings still block.
- **Licences to check.** The credits give IPR as CC BY 4.0 and state no licence for
  TSK Praha's data; `straight-skeleton` is MIT but wraps CGAL, whose straight-skeleton
  code may be GPL.
