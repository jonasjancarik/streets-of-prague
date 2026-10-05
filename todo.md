# To do

What is still open, checked against `main`, the branches and the local map on
5 October 2026. Plans and their status are in [`plans/README.md`](plans/README.md);
measurements are in [`docs/performance-log.md`](docs/performance-log.md).

## Release

Main is 94 commits past v0.5.2 and the live map is still 2026-10-03. Waiting to go
out: plans 025–031, the photo-classified ground, the game controller, car doors, the
arrest, crash barriers, parking outside the paid zones. The local `praha` map was
rebuilt on 5 October with all of it; `centrum` and `ujezd` are from 3 October.

Before deploying:

- `layers.py praha --strict` on the rebuilt layers.
- A frame-time run of plan 028's flat-roof details on a quiet machine (the first
  attempt timed out while loading). If it shows, limit the skylights or keep the
  details to the High tier.
- A look on a phone (see "Phone checks").
- `scripts/check-car-pool.mjs` was reported failing on main's dev server with
  "active paint upload range" (plan 029); find out whether it is the check or the pool.

## Decisions needed

- **Missions and factions (plan 004):** nine open questions (tone, saving, factions,
  how missions are handed out…). The firefighter job (plan 006 phase 4) waits for it.
- **The game on play.streetsofprague.com (plan 024):** five decisions. The homepage in
  `site/` can't go online before it.
- **Branch `nearby-tiles` (plan 016):** merge or shelve. Steady-state gain 1–3 %; the
  gain is in how fast a far tile arrives. 299 commits behind main.
- **Branch `ios-app` (plan 020):** real-device checks (whether the app gets WebGPU on
  iOS 26 among them), then phases 4, 5, 7 and 8.
- **Roof clutter** (aerials, more chimneys and dormers) and stronger moss on red clay.
- **Garden trees:** thin the scatter with distance, or one cheap crown for the suburbs.
  The cost is per tree and per mesh, not per triangle.

## Phone checks

Nearly everything since 1 October was measured on the M5 only.

- Whether Auto on touch devices holds 40 fps at Medium (1.5×) now that the wall
  shader is fixed, or still steps down to 1×.
- Sun shadows are the largest single piece of shading on the Pixel 5 (about 11 ms at 1×).
- The same wall-shader check on another phone GPU (Mali, Apple).
- Not yet seen on a phone: seasons (plan 023), garden hedges and bigger crowns (025),
  woods (026), flat-roof details (028), the photo-classified ground, the mist volumes
  and river mist, the fire engine's water cannon, the taxi buttons.
- 20–24 ms spikes in `crowd.update` and 12 ms in `trams.update` on a warm Pixel 5.
- If phones struggle in bad weather, mist and ripples could go on the Lowest tier.
- Plan 017 (cheaper trees on phones) starts with a measurement that hasn't been made.

## Performance

- **Plan 012 Part B** (incremental resting-car index): the retest in isolation was
  never run. It stays off main until then.
- **Plan 010:** the `.warm-v1.glb` landmarks are staged, not active; the client that
  understands them is live since v0.5.2, so they can be switched on.
- **The street graphs only grow.** Drive and walk graphs, street names and the crowd's
  index keep every tile ever loaded. The police's route search runs over dropped tiles
  too, so shrinking needs care.
- **`requestDevice()` sometimes never returns** at "Preparing graphics…". The game falls
  back to WebGL after 5 s; the browser or driver reason is unknown.
- **WebGPU against the old look:** some low buildings show no windows by day (the tile
  north-east of the woods start); fog looks stronger in rain and snow (probably mixed in
  before the tone curve); the mosaic texture's cost isn't measured.
- **The WebGL renderer and the GLSL** are unmaintained at `?renderer=webgl`; delete them
  or say they stay.
- **Sky view:** a wall at a tile's edge doesn't learn about a neighbour that arrives
  later; landmarks have none; `fill()` tests every building.
- **Cloud shadows:** at gameplay zoom a patch reads as a slow brightness drift; trees
  have none on the GLSL path; the wet ground's mirror ignores them.
- **Tree meshes:** check with `--stalls` whether the third (shrub) mesh adds shader
  builds as tiles arrive; a quiet-desktop and phone comparison of plan 009's pool.
- **Main thread:** what's left is the crowd's `spot` / `follow` / `avoid`, `simulate`,
  `traffic.update`, `trams.clearAhead` and uniform uploads.
- **Ground under buildings** is still shaded on GPUs that don't skip covered pixels.

## Pipeline

- A ground rebuild is almost all `osm_area.extract` (about 5 s for a dense suburban
  chunk). The gardens could be a layer of their own.
- Assembly for the whole city takes about 16 s; it could put together only the chunks
  whose layers changed.
- `pipeline/.cache` takes about 2.5 GB and stale entries are never removed.

## Terrain

- **Steps in the ground: what's left.** Steep slopes with no surveyed wall (streets in
  cuttings, the hillside under Letná), where the 4 m lattice still shows; railway
  cuttings; walls that stop cars and people (they can still go over an edge, and drop);
  frame times and the WebGL renderer; a full-city check of the ground cutting. How to
  work on it: `.agents/skills/terrain-steps/SKILL.md`.
- **Bridges still off:** Železniční most ends 1.8 m above the street at Výtoň;
  Libeňský most's south part has steps of 1.3 m at both ends; Nuselský most's Pankrác
  end has ragged corners by the abutment; the long bridges at Lahovice and Radotín
  have breaks in their decks.
- **Paint and tram tracks where two bridges cross** can land on the wrong level. The
  pipeline knows each way's level and could hand it to the game with the street edges.
- **Hill shading for a moving sun** (it is baked to the north-west sun) and **hills
  casting shadows**: only worth it with a low evening sun.

## Map look

- **Gardens (plan 025):** paved strips from the gate (drive cars from plan 029 stand on
  grass without them), sheds, beds and pools, the `plots` tile field; fences lit from
  both sides, corner gaps closed, hedge heights against the terrain; crown positions
  from the photographs.
- **Woods (plan 026):** clearings inside a mapped wood are planted as full-grown wood;
  a few extra small trees along tile borders.
- **Grass and worn paths (plan 027):** verges aren't a kind of their own; worn paths
  use door proxies, not OSM entrances or the footfall map.
- **Roofs (plan 028):** re-run `ipr_buildings.py` for the city and look at the school
  atria; roof class can change where a street crosses a 90 m cell.
- **Parking (plan 029):** a second car in front of a garage; collision bodies on an
  estate drive unmeasured.
- **Sports grounds (plan 030):** painted lines are thin and fade from higher up.
- **Lanes (plan 031):** the pavement-or-verge pass; the gravel shoulder hasn't been
  looked at in the game.
- **Paths and pavements (plan 018):** phases 3–4 (shape tidying, surveyed pavement
  polygons) are deferred.
- **The plain beige ground:** 1,527 ha in tiles outside IPR's photographs (ČÚZK's
  orthophoto?); courtyards keep a neutral paved look (plan 014: run the classifier on
  `dtm_yard`); asphalt, gravel and dirt are confused (40 % right on the Smíchov labels),
  so more labels from other districts; seams where a patch changes class at a tile
  edge. See `docs/beige-cover-city.md`.
- **Painted photo** (`?ortho`): still a blurry photograph at 0.5 m/px. To try: a
  bigger, more stretched brush, the game's own palette, 1–2 m/px, evening out the
  photo's shadows, a margin from neighbouring tiles.
- **Roof and wall colours (plan 005):** walls measured for about 42 % of buildings
  (the rest are in shade in the photographs); mansard windows and chimneys lined up
  with the facade's bays; false finds among the detected roof windows; what the
  chimneys and windows cost.
- **Countryside (plan 021):** step 2, joining generated streets to the built map's at
  junctions; a phone measurement.

## Gameplay

- **Tyre sounds are off** (`TYRE` in `src/audio.ts`). Bring them back as recordings.
  Found on Freesound, not downloaded: asphalt 477825 (klankbeeld, CC BY 4.0) and
  425398 (Soundholder, CC BY 3.0); setts 591078 (orlandorizo, CC0) and 528562
  (Garuda1982, CC0). The engine voices aren't liked yet either (`sound-test.html`).
- **Fire engines:** a heavy diesel voice when driven; about 40 s to clear a narrow
  street after a fire; cars give little room in the Old Town; jets and siren levels
  unmeasured.
- **Buses:** a line is lost where the map has no street for it (148 at U Nemocnice);
  they crawl in the Old Town.
- **Traffic by time of day** is one city-wide figure; queues on real routes, the
  direction of the peak and the car mix are next (`docs/traffic.md`).
- **Parked cars:** the turning-curve clearance is unchecked citywide and on emergency
  routes.
- **Boats:** other bridges than Legion Bridge and water-height seams unchecked; no PID
  ferries (`docs/boats.md`).
- **Taxis** creep or stall behind parked cars in narrow streets, routes are sometimes
  long, and the apps have no phone screen.
- **Raised buildings** only in IPR's data (passages over a street) still block.
- **A tile-load error at start**, seen twice under heavy load: the game retries and
  carries on; the cause wasn't found.
- **Radio stations by vehicle type** (optional).

## Weather, night and seasons

- **Seasons (plan 023):** `scripts/check-tree-pool.mjs` is still owed from step 2; the
  ground's cost is unresolved. Later, if wanted: fallen leaves, hoarfrost, the city's
  calendar, seasons for baked landmarks.
- **Hung lamps where there are none:** could use OSM's `highway=street_lamp` and
  `lit=yes` for streets that should be dark.
- **Lamps light the roofs of low sheds** next to them.
- **Live weather** only at the start; Open-Meteo is free for non-commercial use only
  (ČHMÚ's open data would need a small proxy).
- **Puddles** are placed by noise; the terrain's low points and the kerbs would be
  better.

## Landmarks

- **A tree baked into Mánes's roof** at the north-east corner. Paint the roof's colour
  over green texels near the roof's edges when baking, or see whether a game tree
  there hides it.
- **Týn Church: bare and blocky walls at street level** on the west and south. Fill
  from the nearest sharp wall texture, or leave the ground floor to the game's facade.

## More map data

All IPR Praha, CC BY, at
`https://mp.iprpraha.cz/arcgis/rest/services/Hosted/<name>/FeatureServer/0`. Not used yet:

- Lawns, shrubs, hedges and flower beds: `OPK_CUR_OPK_SMZ_VP_P`, 127,000 polygons.
- Street furniture: `DTMP_CUR_TMISZNAK_B` (manhole covers, storm drains, traffic
  lights, hydrants, phone boxes); only the lamps are used.
- Walls, fences, railings and steps: set 3 of the DTM, already in
  `pipeline/.cache/dtm/ZPS_KR/`. Could replace OSM's walls and block the player.
- The rest of set 2's surfaces: pavements, traffic islands, separate tram tracks.
- Building age ("Stáří zástavby") to pick facade styles.
- Noise maps for how loud a street's background is.
- Smaller things: avenues, memorial trees, noise barriers, fountains, public toilets,
  recycling bins, parking meters, playgrounds (<https://opendata.geoportalpraha.cz/>).

## Housekeeping

- **Licences to check:** the credits state no licence for TSK Praha's data;
  `straight-skeleton` is MIT but wraps CGAL, whose straight-skeleton code may be GPL.
- **mbxp:** one old uncompressed tile is left (`praha_now/tiles/84_68.bare.bin`, no
  `.gz` beside it, so probably still in use).
- **Merged branches and their worktrees** can go: `plan-026-*` to `plan-031-*`,
  `beige-ground`, `roof-colours`, `worktree-telemetry`, `worktree-quay-heights`,
  `worktree-typescript-migration`, `codex/typescript-*`, `worktree-drive`,
  `mosaic-scatter`, `newsletter-cloudflare-confirm`. `beige-ground` and `quay-heights`
  hold untracked pictures and labels. Kept unmerged on purpose: `worktree-crowd-worker`
  (plan 019), `mosaic-ornaments`, `worktree-rust-wgpu`, `ipad-audio`.
- **Codex worktrees:** nine of fifteen hold commits that aren't in main in the same
  form (most in `811c`, plan 012 Part B, and `2bc4`); not gone through.
