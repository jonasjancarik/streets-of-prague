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
  cached (`cf-cache-status` shows MISS, then HIT). A Cache Rule for `/data/*` would
  cover the JSON too. The catch is that tiles change on every deploy under the same
  names, so either purge the cache from `scripts/deploy-mbxp.sh` after the sync, or
  keep the edge TTL short.
## Game performance

`scripts/bench.mjs` measures frame times in Google Chrome (headless, on the GPU) at
fixed places; `--vs` compares with another server taking turns, `--ab` switches a
change on and off within one page (both hold up when the machine is busy), `--cpu 4`
stands in for a phone's CPU. After the work of 29 September 2026 (noise from a
texture, the ground's broad variation baked per tile, cheaper stones, the ground
shaded once a pixel, less per-frame bookkeeping), at 2× on an M5 in Chrome: 32–41%
less time a frame than before it, and 32–42% less with the CPU slowed 4× at 1×.
Still worth checking on a real phone.

What a frame costs now, at 2× standing by the Old Town Square (switched off one at a
time with `--ab`): the ground's patterns about 29% (the mosaic's stones 14%, dirt on
the paving 12%), shadows on the ground 11%, roof tiles 12%, the facade pictures 7%,
grime on the walls 6%, the shadow map's own pass 7%.

- **MSAA costs about a fifth of a frame at 2×** (57 → 71 fps without it, Chrome on
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
- **Parking a tile's cars runs on the main thread**: 0–4 ms a tile once warmed up,
  but up to 30 ms for the first tiles on an M5, several times that on a phone. The
  spots could be worked out in the tile worker, with only the cars made here.
- **The street graphs only grow.** The drive and walk graphs, street names and the
  crowd's index keep the edges of every tile ever loaded, so memory grows over a
  long session across the city. The police's route search runs over the graph,
  including tiles that have been dropped, so shrinking it needs care.
- **three.js's WebGPU renderer** (trial: `?renderer=webgpu`, `src/webgpu.ts`, 29
  September 2026). The ground, the tone curve, the buildings
  and the lamps' light (on the ground with the wet ground's mirror, the buildings,
  landmarks and poles) are ported (to TSL); rain, snow, lamp glows, skid marks and the
  ground's soft shading aren't drawn, and trees, cars, people and trams are drawn plain; not
  playable. Buildings cost 0.6–1.4 ms a frame on WebGPU against 0.7–1.3 ms on WebGL
  (`--ab`, 2×, Old Town Square, the drive from Újezd, Karlovo náměstí; the GPU was
  17–20% busy before each run). The lamps at night cost +0.7–0.8 ms a frame on WebGPU
  against +0.2–0.5 ms on WebGL (Old Town Square, Karlovo náměstí, glows not included).
  Open: fog looks stronger on WebGPU in rain and snow
  (it is probably mixed in before the tone curve, where the game means it after). The same ground patterns cost about half
  as much there: switched on and off with `--ab` at 2× on an M5, +1.2 ms a frame
  on WebGPU against +2.4–3.1 ms on WebGL (Old Town Square, Karlovo náměstí,
  Petřín), with another app keeping the GPU 70–80% busy. The whole frame can't be
  compared until the rest is ported: every `onBeforeCompile` (about 20, the
  buildings' and lamps' light among them) and every `ShaderMaterial` (about 10)
  would have to become TSL. Headless Chrome with `--disable-frame-rate-limit` never
  finishes `compileAsync` on WebGPU (webgpu.ts gives up after 10 s).
- **What's left on the main thread** (in order, with the CPU slowed 4×): the trams'
  steps and look-ahead, traffic, placing people (`Crowd.place`) and following
  everyone's height (`TileWorld.track`, `surfaceAt`), then three.js's own work.

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

- **Rebuild the terrain for the city.** The seams at tile edges are fixed in the
  pipeline and the game (29 September 2026: the height grid now has rows on both tile
  edges, and the hill shading takes the edge slope from the neighbouring tile), but
  the data has to be rebuilt to show it. `centrum` was rebuilt on the night of 29
  September; `praha` and `ujezd` still need it, together with the metro fix below:
  `cd pipeline && uv run build_tiles.py praha --layers streets && uv run ipr_terrain.py praha`
  (the same for `ujezd`; centrum took 43 s with warm caches). See "Terrain grid" in the README.
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
  Slatinách). Measure in Chrome with `--vs`, and thin them or give far crowns fewer
  triangles if it shows.
- **Standing on a car that drives off.** You can climb onto a standing car, but if
  it drives away it slides out from under you rather than carrying you.
- **A stolen police car has no flashing lights.**
- **Buses.** They follow PID's real lines (`pipeline/build_buses.py`) and stop at the
  stops, but a line is lost where the map has no street for it (148 at U Nemocnice),
  buses often crawl in the Old Town's traffic, and they show no line number.
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
