# To do

Possible next steps after the performance work of 27–29 September 2026 (the layered
pipeline, tiles built in workers, parked cars kept out of the per-frame work, gzipped
tile files, cheaper ground shading). Rough order: quick wins first.

## Serving

- **Delete the old uncompressed tile files on mbxp.** The game now fetches
  `<tile>.<kind>.bin.gz`. The deploy never deletes anything, so the old `.ipr.bin`,
  `.height.bin` and `.bare.bin` files from before are still in
  `/home/jonas/deployments/streets-of-prague/shared/data/*/tiles/`. Nothing asks for
  them (a few hundred MB). Only delete `*.bin` files that have a `*.bin.gz` beside
  them, and check the site afterwards.
- **Cache the map data at Cloudflare's edge.** Cloudflare doesn't cache `.json` by
  default, so every tile JSON goes through the tunnel to mbxp; `.gz` files are
  cached. Plan 003 (`plans/003-cloudflare-deploy.md`) covers this: the data moves to
  R2 under hashed, immutable names with a Cache Rule, so no purge is needed. The
  mbxp data stays uncached at the edge until that plan's hostname swap.

## Game performance

`scripts/bench.mjs` measures frame times in Google Chrome (headless, on the GPU) at
fixed places; `--vs` compares with another server taking turns, `--ab` switches a
change on and off within one page (both hold up when the machine is busy), `--cpu 4`
stands in for a phone's CPU. After the work of 29 September 2026 (noise from a
texture, the ground's broad variation baked per tile, cheaper stones, the ground
shaded once a pixel, less per-frame bookkeeping), at 2× on an M5 in Chrome: 32–41%
less time a frame than before it, and 32–42% less with the CPU slowed 4× at 1×.
Still worth checking on a real phone.

On 30 September 2026 (WebGPU, the default now) the main thread, not the GPU, was
the limit on an M5 at 2×. Fixed then: the lamps re-gathered every frame (their cache
check never held), instance buffers went up whole, and DynamicDrawUsage makes
three.js's WebGPU renderer upload a buffer every frame: 3.0–3.5 MB a frame of
uploads down to ~0.2 MB. The crowd is drawn and animated only in view. Open:

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
- **The mosaic's stones at the usual height on foot** are drawn at about a tenth of
  their contrast (they fade out as they get smaller than a pixel) yet cost 14% of the
  frame. A tighter fade would save most of that, but it's a change to the look.
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
  High at ~23 fps (median frame ~33 ms). Open, biggest first:
  - **Tree meshes:** every tile makes three new instanced tree meshes, and three.js
    builds every instanced mesh on its own (its key has the mesh's `uuid`): ~60 ms each
    on a Pixel 5 for the tuft shader. One set of tree meshes shared by all tiles
    (refilled when tiles come and go) would build once.
  - **Car models:** ~25 builds a drive (~13 ms each on the Pixel 5), one per model as it
    first appears and again when a model's mesh grows past its capacity
    (`CarDrawer.render`, `max(8, 1.5 × n)`). Making every model's mesh during loading
    with room to spare would move them behind the loading screen.
  - **Tile workers crowd a phone's main thread:** on a Pixel 5, frames swell (render ~17 →
    ~30 ms) while tiles load, with no build involved; 1 worker instead of 3 halved those
    long tasks, but tiles took 2–3× longer to arrive. A decision: fewer workers on
    phones, or leave it.
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
  and `ujezd` tiles on disk were rebuilt after the fix (a few hundred `praha` height
  tiles are older, probably unchanged). Still to confirm: that this data has been
  deployed to mbxp. See "Terrain grid" in the README.
- **Finer terrain.** IPR's terrain model has points about 10 m apart, so
  embankments, retaining walls, cuttings and steps are smoothed away (most visible
  along the river and railways). A finer bare-earth model would fix it; ČÚZK's
  DMR 5G (2 m grid) may be open (unchecked). IPR's 1 m surface model won't do: it
  includes buildings and trees.
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

- **Taxis.** Let the player hail a taxi in the street or order one through a
  ride-hailing app. The apps stand in for Uber and Bolt under made-up names, and
  their drivers are more reckless than regular street taxis.
- **Fill the plain beige areas.** Fields, work yards, railway land and building sites
  now have surfaces of their own (from OSM land use). What's left is unmapped ground
  in town: yards, verges, car parks on bare earth. The prototype
  (`pipeline/ground_cover.py`, `?cover=rules` in the game) classifies IPR's 2024
  orthophoto and 2025 surface model into grass, trees, dirt, gravel, asphalt and "not
  ground"; tried on 49 tiles round Smíchov. Still to do: run it for the whole city (a
  16–65 GB photo download), and fold it into the build.
  About a third of the beige pieces in town are roofs or site clutter and some are
  roadway the streets don't reach: gaps in the map data rather than missing ground.
- **Painted photo, with stronger filters.** `ground_cover.py ortho` (`?ortho` in the
  game) paints the orthophoto through an anisotropic Kuwahara filter; at 0.5 m/px it
  still looked like a blurry photograph. To try: a bigger, more stretched brush;
  fewer colours (the game's own ground palette); 1–2 m/px; evening out the photo's
  own shadows; darker edges; and painting each tile with a margin from its
  neighbours so the tiles don't show seams.
- **Firefighter job.** Phase 4 of `plans/006-firefighters.md`: firefighting as a job,
  once the mission engine from plan 004 exists. The rest of the fire brigade (engines,
  crews, lights, sirens, giving way, stealing an engine, the water cannon) is in.
- **Fire engine polish.**
  - A driven engine uses the petrol-car engine sound; give it a heavy diesel voice.
  - After a fire is out, an engine can take about 40 s to clear a narrow street.
  - Cars give little room on narrow Old Town streets (no space on the right).
  - Not measured yet: `scripts/bench.mjs --vs` with the jets, the water cannon on a
    phone, and the siren levels in a real browser.

## Weather and night

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

Open data found on 28 September 2026 and not used yet. All IPR Praha, CC BY; the
feature services are at `https://mp.iprpraha.cz/arcgis/rest/services/Hosted/<name>/FeatureServer/0`
(paged queries, 2,000 features at a time).

- **Trees from the city's greenery records.** `OPK_CUR_OPK_SMZ_VP_B` has 171,000
  trees (`kod_vp` 71) and 30,000 shrubs (51), each marked conifer, broadleaf or
  fruit tree (`kod_drevin`); OSM has about 20,000 trees in Prague. Only greenery the
  city and its districts look after, so no private gardens: for those, IPR's 1 m
  surface model minus the terrain gives the tree crowns' heights.
- **Lawns, shrubs, hedges and flower beds.** `OPK_CUR_OPK_SMZ_VP_P`, 127,000
  polygons, for the plain beige ground in parks, housing estates and along streets.
- **Street furniture from the archived utility map.** `DTMP_CUR_TMISZNAK_B`, 1.39
  million points by `ctmtp_popis`: manhole covers (174,000), storm drains (71,000),
  traffic lights (5,700), hydrants, phone boxes, substations. The street lamps from it
  are in the game (`pipeline/build_lamps.py`).
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
- **A stolen police car has no flashing lights.**
- **Buses.** They follow PID's real lines (`pipeline/build_buses.py`) and stop at the
  stops, but a line is lost where the map has no street for it (148 at U Nemocnice),
  buses often crawl in the Old Town's traffic, and they show no line number.
- **Traffic by time of day.** The number of cars follows a TSK travel-time profile
  and favours main roads, but it is one city-wide figure; queues on the real routes,
  direction of the peak and car mix are next. See `docs/traffic.md`.
- **Boats.** Cruise boats and pedal boats are on the river (`src/boats.ts`), but not
  PID's ferries, no lights at night, and they've only been looked at from above
  (passing under a bridge is unchecked). One of the tied-up pedal boats can't be
  reached from the bank.
- **Parked cars at tile edges and corners.** Parking now keeps clear of the traffic
  lanes, but a couple of cars at tile edges still overlap a lane of the neighbouring
  tile, and at junctions a car standing on the corner is still driven through after a
  few seconds (parking isn't checked against the turning paths).
- **Rebuild the streets layer for the metro fix.** Metro station corridors and stairs
  are no longer tunnels (`station_ways` in `pipeline/structures.py`); rebuilt for
  `centrum`, not yet for `praha` and `ujezd` (the command is under Terrain).
- **Taxis.** Hail one with T or order one from the two made-up apps (`src/taxi.ts`).
  They can creep or stall behind parked cars in narrow Old Town streets, their routes
  are sometimes long, the apps have no phone screen of their own, and the touch
  button hasn't been looked at on a phone.
- **A tile-load error at start, seen twice** (`TileWorld.loadNow` → `fetchTile`, under
  heavy load, not reproduced). Startup now retries a failing tile and carries on
  without it; the cause of the failed download itself wasn't found.
- **Raised buildings from IPR.** Passages and walkways over a street are left out of
  the collision only when OSM has `min_height` (3 m or more); raised parts only in
  IPR's 3D buildings still block.
- **Licences to check.** The credits give IPR as CC BY 4.0 and state no licence for
  TSK Praha's data; `straight-skeleton` is MIT but wraps CGAL, whose straight-skeleton
  code may be GPL.
