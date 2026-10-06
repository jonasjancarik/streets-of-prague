# To do

What is still open, checked against `main`, the branches and the local map on
6 October 2026. Plans and their status are in [`plans/README.md`](plans/README.md);
measurements are in [`docs/performance-log.md`](docs/performance-log.md).

## Branches from the night of 5–6 October, waiting for a look

Twenty sessions worked overnight, each on its own branch and worktree
(`.claude/worktrees/night-*`); the account's usage limit stopped all of them from
about 00:20 to 04:55, so most got two to three working hours on a heavily loaded
machine. Merged into main: `night-release-checks`, `night-traffic`, `night-landmarks`
(code only), `night-pipeline`, `night-weather`, `night-graphs`, `night-countryside` (behind
`?countryside`), `night-greenery`, `night-bridges`, and single commits of
`night-renderer` (windows on ground floors, the fog, the start-up report) and `night-maplook`
(sports lines). Not merged, each with its state written in the plan or doc it names:

- **`night-play-subdomain` (plan 024):** everything prepared, nothing deployed. Confirm
  the five assumed answers at the top of the plan's Result, then follow
  `docs/play-subdomain-go-live.md` (on the branch). Merging attaches `play.` at the
  next release and blocks beta deploys until then.
- **`night-missions` (plans 004 and 006 phase 4):** the job engine, five odd jobs
  (courier, taxi fare, patient run, tram shift, fire call), the factions' books; save
  format 2. Nine assumed answers to confirm. `job-tram` passes now. Left:
  `scene.mjs run all` and `npm run build`, read the Czech texts in the game, a touch
  and gamepad button for asking for work.
- **`night-audio`:** tyre recordings are back, engines are made of their firings
  (about 5 dB louder), a heavy diesel for fire engines, lorries and buses, a water-jet
  sound, louder sirens. Levels are measured; nobody has heard any of it. Listen on
  `sound-test.html` (old voices kept there), then merge.
- **`night-gardens` (plans 025, 029):** paved strips, sheds, beds, pools, the `plots`
  field, fences lit from both sides, hedges on their own ground, a second car by a
  garage. Counted offline on one chunk, never seen in the game. Then: plots cut back
  behind mapped pavements, corner gaps, the time of the garden step.
- **`night-pavements` (plan 018 phases 3–4):** surveyed pavements, islands and tram
  beds, built for `ujezd` only (its tests pass, screenshots judged in the plan's
  Result); `centrum` and a suburb not built, the pavement step is slow.
- **`night-walls`, rest:** surveyed walls, fences and railings from the technical map
  (`pipeline/dtm_walls.py`), built for `ujezd` only and not seen in the game; a
  surveyed wall may close a gateway or yard. The step edges themselves are in main.
- **`night-boats`:** cruise boats follow a fairway (`river.json`), PID ferries P1, P2,
  P4, P5, P6 run and take tickets; scenarios `ferry-ride` and `cruise-weir` pass.
  No played test.
- **`night-roofs` (plan 005):** neighbour-borrowed wall colours, bay-aligned mansards
  and chimneys, building age for facade styles, roof clutter behind `ROOF_CLUTTER`
  (High and Ultra only). `ipr_buildings.py ujezd` ran: wall colours for 80.7 % of
  buildings (51.6 % measured, the rest from a neighbour sharing a wall), style from
  the age for 812 of 933. Not looked at in the game.
- **`night-beige` (plan 014):** courtyards classified with the plain ground, seams
  between tiles fixed, nine painted-photo variants to judge
  (scratchpad `overnight/night-beige/painted/`). Tried on `ujezd` only.
- **`night-maplook`, rest:** clearings inside mapped woods (changes every wood; needs
  the young layer rebuilt and a comparison with the photos).
- **`worktree-rust-wgpu`** (never to be merged): the static daylight scene of `ujezd`
  and `centrum` matches the game to about 5–8 levels of mean difference, with tile
  streaming and the sedan's handling; `rust/PARITY.md` on the branch has the status
  table and the order to go on in. A sky-view module is uncommitted in its worktree.
- Uncommitted work was left by the limit in the worktrees of `night-renderer`
  (`src/sky.ts`, the night fog) and `night-walls` (`scenarios/step-edges.ts`,
  `src/testkit.ts`).

The shared map data was not rebuilt. Rebuilds the merged work is waiting for:
`build_lamps.py ujezd centrum praha` (the new lamp rule; look at suburbs at night
first), IPR's greenery and street marks (`ipr_greenery.py`, `ipr_utility.py`,
`build_signals.py`; the downloads are in `night-greenery`'s worktree cache), and
`ipr_terrain.py` for the bridge levels and the landmark files (`landmarks.py <area> --rebake`). How to rebuild and
check: `docs/rebuilding-the-map.md`, `scripts/check-map-rebuild.mjs`.

## Release

Main is about a hundred commits past v0.5.2 and the live map is still 2026-10-03. Waiting to go
out: plans 025–031, the photo-classified ground, the game controller, car doors, the
arrest, crash barriers, parking outside the paid zones, and tiles drawn only near the
view (plan 016, merged on 5 October without new measurements). The local `praha` map was
rebuilt on 5 October with all of it; `centrum` and `ujezd` are from 3 October.

Before deploying:

- `layers.py praha --strict` fails on the current cache, and only because of the cache:
  the layers were built in a worktree that is gone (recorded source paths), and
  `code_key` hashes every `pipeline/*.py`, assembly code included. With those relaxed
  all 1,008 chunk records match and the assembled map is byte-identical. Either
  rebuild the layers from main (hours), or decide that `code_key` leaves out
  `layers.py`, `build_cache.py` and `chunk_cache.py` and identities stop using
  absolute paths.
- The other checks for plans 016 and 025–031 passed on 6 October (streaming, guard
  rails, narrow lanes, ground areas, roof rules, countryside, parking clearance, car
  pool, tree pool).
- A frame-time run of plan 028's flat-roof details on a quiet machine (the first
  attempt timed out while loading). If it shows, limit the skylights or keep the
  details to the High tier.
- A look on a phone (see "Phone checks").
- **Licence of `straight-skeleton`:** MIT, but its bundle carries CGAL compiled to
  WebAssembly, and CGAL's straight-skeleton package is GPL; the game ships it to
  browsers. Options in `docs/licences-review.md`.

## Decisions needed

- **Missions and factions (plan 004):** nine answers were assumed on branch
  `night-missions`; confirm or change them (top of the plan's Result on the branch).
- **The game on play.streetsofprague.com (plan 024):** five answers were assumed on
  branch `night-play-subdomain`; confirm, then the go-live checklist.
- **Lamps on untagged streets:** with the new rule (merged, data not rebuilt) a suburb
  such as 50.05348, 14.36206 is nearly dark. Decide whether untagged streets near a
  surveyed lamp should get lamps.
- **Touch devices starting at Low:** on the Pixel 5 Auto steps from Medium to Low and
  Lowest on a drive (22.7 fps at Medium, 36.3 at Low).
- **Branch `ios-app` (plan 020):** real-device checks (whether the app gets WebGPU on
  iOS 26 among them), then phases 4, 5, 7 and 8.
- **Roof clutter** (aerials, more chimneys and dormers) and stronger moss on red clay.
- **Garden trees:** thin the scatter with distance, or one cheap crown for the suburbs.
  The cost is per tree and per mesh, not per triangle.

## Phone checks

Nearly everything since 1 October was measured on the M5 only.

Pixel 5 readings of 6 October are in `docs/performance-log.md`. Bench figures taken
before that day's frame-count fix may be doubled.

- Auto does not hold Medium on the Pixel 5 (see "Decisions needed").
- Sun shadows cost about 4 ms at 1× on the Pixel 5 (High, standing), not 11 ms.
- On a drive, `traffic.update` (up to 11.7 ms) was the largest simulation piece in long
  tasks, then `trams.update` (7.5 ms) and `crowd.update` (5 ms).
- The same wall-shader check on another phone GPU (Mali, Apple).
- Not yet seen on a phone: seasons (plan 023), garden hedges and bigger crowns (025),
  woods (026), flat-roof details (028), the photo-classified ground, the mist volumes
  and river mist, the fire engine's water cannon, the taxi buttons.
- 20–24 ms spikes in `crowd.update` on a warm Pixel 5 did not appear at 32 °C.
- The Lowest tier now skips mist banks, river mist and puddle rings; the phone check
  in bad weather is owed.
- Plan 017: step 1 says go ahead (tree shadows are 7.8 ms of 28.9 in the woods, hiding
  trees saves 16 ms); the low-detail crown toggle and option A are next.

## Performance

- **Plan 012 Part B** (incremental resting-car index) is on main behind
  `?resting=incremental`, off. One retest on a busy machine was inconclusive (control
  7.9 %, comparison 9.5 %); a quiet-machine retest and `check-resting-cars.mjs` are owed.
- **Plan 010:** the warmed landmarks are switched on in `night-landmarks`'s cloned data
  and matched the old look; replace the shared landmark files (copy them from that
  worktree or `landmarks.py <area> --rebake`) and upload them with the map.
- **Street graphs** now forget tiles far behind the player (checked offline over 8 km
  and with one pursuit in the game). Left: a scenario with a taxi ride across forgotten
  streets; the lamps' street and hung-lamp tables still keep every tile ever joined.
- **`requestDevice()` sometimes never returns** at "Preparing graphics…" (limits: 5 s
  for the adapter, 15 s for the device). The error report now carries the stage, the
  time, frames drawn and whether the tab was hidden. Next: start without our own
  adapter request and without `timestamp-query`, and with a frame loop running.
- **WebGPU against the old look:** the night frame is lighter on WebGPU than on WebGL
  even without fog (lamp-lit paving 0.29 against 0.20); the mosaic texture's cost
  isn't measured.
- **`Route.ahead` in `traffic.update`** (the fix for taxis stalling) adds a little work
  per car: a `bench.mjs --ab` is owed.
- **The WebGL renderer and the GLSL** are unmaintained at `?renderer=webgl`; delete them
  or say they stay.
- **Sky view:** a wall at a tile's edge doesn't learn about a neighbour that arrives
  later; landmarks have none; neighbours' buildings are now filtered by box before
  the job (saving unmeasured).
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
- `pipeline/.cache` is about 39 GB, nearly all of it read by current steps;
  `pipeline/cache_stale.py` lists the roughly 2 GB that isn't (dry run by default).
- An override for the pipeline's output folder (`OUT` in `pipeline/osm_area.py`), so a
  rebuild writes into a clone and is swapped in by rename; quiet-machine timings for
  `docs/rebuilding-the-map.md`.
- `meta.json`'s `build_source` for `praha` points at a removed worktree.
- A drive street stops at the chunk edge between `centrum` tiles 5_7 and 5_8.

## Terrain

- **Steps in the ground: what's left.** Steep slopes with no surveyed wall (streets in
  cuttings, the hillside under Letná), where the 4 m lattice still shows; railway
  cuttings (the tops of quay and retaining walls now stop cars and people, scenario
  `step-edges`; stairs across a step untried);
  frame times and the WebGL renderer; a full-city check of the ground cutting. How to
  work on it: `.agents/skills/terrain-steps/SKILL.md`.
- **Bridges still off:** at Železniční most (Výtoň) the deck's last points take the
  stairs' heights (1.6–2.5 m); stairs need their own profile in the tile, and giving
  them a separate level was tried and made it worse (`docs/bridge-deck-check.md`).
  Libeňský most's south part (path way 376889215) lies at the water's level, about
  3.5 m under its ends. Nuselský most's Pankrác end has ragged corners by the
  abutment. The Lahovice and Radotín decks are continuous, with a 9.6 m fault at
  49.98353, 14.40065. Four decks are too low for a cruise boat (tiles `49_37`,
  `52_43`, `54_48`, `64_76`). `check-bridge-decks.mjs praha` lists them all (nine
  named bridges over 1 m).
- **Car streets crossing drops of 7–10 m on the ground** (`node
  scripts/check-step-edges.mjs praha`): terrain or map faults to look at.
- **Spikes in the ground:** `check-terrain-spikes.mjs` finds 1,124 lone points more
  than 2 m off their neighbours; 402 are terrace strips carrying wall-top heights
  (Vyšehrad's bastions), cause not yet found in `dtm_heights.apply`. Ragged cuts are
  not scanned.
- **The river's height is wrong north of Troja** (tiles `49_81`, `50_94`, `50_95`).
- **Paint and tram tracks where two bridges cross:** the pipeline now hands each
  way's level to the game; it shows after `ipr_terrain.py` has rebuilt the shared
  maps (heights stay the same). Look at one crossing afterwards.
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
- **Sports grounds (plan 030):** lines now hold a width in pixels from high up; road
  paint is as thin and could use the same hold.
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
- **Countryside (plan 021):** step 2 (the join) is in main; a scenario that drives out
  and back on an arterial road, the pipeline writing the list of streets that leave
  the map (the worker reads about fifty rim tiles now), the one built street that
  leaves on a bridge or tunnel, steps 3–6, a phone measurement.

## Gameplay

- **Tyre sounds are off on main** (`TYRE` in `src/audio.ts`); recordings, new engine
  voices, the heavy diesel and measured jet and siren levels wait on `night-audio`.
- **Fire engines:** about 40 s to clear a narrow street after a fire; cars give little
  room in the Old Town.
- **Buses** now find a way round where a line has no street (centrum: 40 breaks to 3).
  Left: an AE bus still stalls near Na Poříčí; 581 line breaks over 30 m citywide not
  gone through (`check-bus-lines.mjs praha`); buses cut across sharp bends in a street.
- **Traffic by time of day** is one city-wide figure; queues on real routes, the
  direction of the peak and the car mix are next (`docs/traffic.md`).
- **Parked cars:** `check-parking-city.mjs` finds, in centrum, 288 cars in a bus's
  way, 6 in a pickup's and 21 on the centre line of wide one-way streets; three causes
  in `docs/traffic.md`; nothing fixed, not yet run on `praha`.
- **Boats:** other bridges than Legion Bridge and water-height seams unchecked; no PID
  ferries (`docs/boats.md`).
- **Taxis:** routes are sometimes long, and the apps have no phone screen (the stall
  behind cars parked on a bend is fixed).
- **Raised buildings** only in IPR's data (passages over a street) still block. Likely
  fix: the pipeline emits `passages` where a street crosses a footprint that IPR's
  mesh shows open underneath.
- **A tile-load error at start**, seen twice under heavy load: the game retries and
  carries on; the cause wasn't found.
- **Radio stations by vehicle type** (optional).

## Weather, night and seasons

- **Seasons (plan 023):** the ground's cost is unresolved (the `--ab` command is in the
  plan). Later, if wanted: fallen leaves, hoarfrost, the city's
  calendar, seasons for baked landmarks.
- **Lamps:** the game's own lamps now go only on streets OSM tags as lit, and OSM's
  street lamps join the surveyed ones; it shows once `build_lamps.py` has rebuilt the
  lamp files (see "Decisions needed"). Roofs no longer take lamplight; a
  `bench.mjs --ab` and a matched before/after pair are owed.
- **Live weather** follows the real weather during a game. A ČHMÚ route is written
  (`worker/weather.js`, `docs/live-weather.md`), not deployed: set `WEATHER_SOURCE=chmi`
  and `VITE_WEATHER_API`, try it in the Workers runtime, add ČHMÚ to the credits.
- **Puddles** are placed by noise; the terrain's low points and the kerbs would be
  better.

## Landmarks

The bake's new fills are in main; the shared landmark files are not re-baked yet.

- **Mánes:** the roof corner is painted over as a flat grey patch without its eave
  line; the tree is still baked into the east wall's north end.
- **Týn Church:** on the south side one bay of the filled ground floor repeats a
  neighbour's roof; hidden behind houses in the game.
- `check-landmark-colours.mjs` fails with `--name` of a landmark near its start place.

## More map data

All IPR Praha, CC BY, at
`https://mp.iprpraha.cz/arcgis/rest/services/Hosted/<name>/FeatureServer/0`. Not used yet:

- Lawns, shrubs, hedges and flower beds (`OPK_CUR_OPK_SMZ_VP_P`) are in the pipeline
  and drawn once the data is rebuilt. Left: a flower pattern for the beds (bare earth
  now), benches on surveyed lawns, a look at a panel housing estate.
- Street furniture (`DTMP_CUR_TMISZNAK_B`): manhole covers, storm drains, hydrants,
  phone boxes and signal poles are in. Left: check a few surveyed signal poles against
  reality (1,807 of 3,107 lights get one); frame times unmeasured.
- Walls, fences, railings and steps: set 3 of the DTM, already in
  `pipeline/.cache/dtm/ZPS_KR/`. Could replace OSM's walls and block the player.
- The rest of set 2's surfaces: pavements, traffic islands, separate tram tracks.
- Building age ("Stáří zástavby") to pick facade styles.
- Noise maps for how loud a street's background is.
- Smaller things: avenues, memorial trees, noise barriers, fountains, public toilets,
  recycling bins, parking meters, playgrounds (<https://opendata.geoportalpraha.cz/>).

## Housekeeping

- **Licences:** `docs/licences-review.md`. TSK Praha's terms could not be read (someone
  has to look at the dataset entries or ask); `straight-skeleton` is under "Release".
  The repository has no LICENSE file.
- **mbxp:** `shared/data/praha_now/tiles/84_68.bare.bin` and the 1,301 `.bare.bin.gz`
  beside it are in no manifest and can be deleted.
- **Worktree `beige-ground`** (merged, 18 GB) is kept for the painted-photo
  experiments: it holds the photos, the hand labels and the surface model. Remove it
  when those are done. Kept unmerged on purpose: `worktree-crowd-worker` (plan 019),
  `mosaic-ornaments`, `worktree-rust-wgpu`, `ipad-audio`.
- **Codex worktrees:** gone through in `docs/codex-worktrees-review.md`. Eleven of
  fifteen hold nothing unique and can be removed; keep `2bc4` (plan 012 Part B, same
  as `811c`), `ae03` (a dry-ground pilot) and `fd60` (a furniture timing script) until
  decided. All are detached: branch what is kept.
- **Night worktrees** (`.claude/worktrees/night-*`, plus `night-renderer-snap`): keep
  those whose branch is unmerged; the merged ones can go (move their `node_modules`
  and `public/data` symlinks to the Trash first).
