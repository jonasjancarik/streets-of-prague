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
`?countryside`), `night-greenery`, `night-bridges`, `night-gardens`, `night-boats`, `night-roofs`, `night-maplook`, `night-beige`, `night-pavements`,
`night-walls`, and single commits of
`night-renderer` (windows on ground floors, the fog, the start-up report) and `night-maplook`
(sports lines). Not merged, each with its state written in the plan or doc it names:

- **`night-missions` (plans 004 and 006 phase 4):** the job engine, five odd jobs
  (courier, taxi fare, patient run, tram shift, fire call), the factions' books; save
  format 2. Nine assumed answers to confirm. `job-tram` passes now. Left:
  `scene.mjs run all` and `npm run build`, read the Czech texts in the game, a touch
  and gamepad button for asking for work.
- **`night-audio`:** tyre recordings are back, engines are made of their firings
  (about 5 dB louder), a heavy diesel for fire engines, lorries and buses, a water-jet
  sound, louder sirens. Levels are measured; nobody has heard any of it. Listen on
  `sound-test.html` (old voices kept there), then merge.
- **`worktree-rust-wgpu`** (never to be merged): the static daylight scene of `ujezd`
  and `centrum` matches the game to about 5–8 levels of mean difference, with tile
  streaming and the sedan's handling; `rust/PARITY.md` on the branch has the status
  table and the order to go on in. A sky-view module is uncommitted in its worktree.
- Uncommitted work was left by the limit in the worktrees of `night-renderer`
  (`src/sky.ts`, the night fog) and `night-walls` (`scenarios/step-edges.ts`,
  `src/testkit.ts`).

The shared maps (`ujezd`, `centrum`, `praha`) were rebuilt from main on 7 October with
everything merged up to then, strict assembly included (`67dafe5`; the map before is
in `pipeline/.cache/previous-map-2026-10-07`). On it: 10 steps in the water along the
fairway (376 before), no deck too low for boats, 231 lone ground points over 2 m
(1,124), and `check-map-rebuild.mjs` passes. Two faults only the full praha build
showed were fixed on the way (a crash in the surveyed pavements, an invalid shape in
the verges), and one the comparison with the kept map showed: verges past the survey
had taken the unmapped land away from the photo classification, woods and single
trees with it. Not rebuilt: the lamp files (`build_lamps.py ujezd centrum praha`),
waiting for a look at dark suburbs. Four full scenario runs on the new map: two clean,
`wall-crash` once, `fire-brigade` once (old behaviour of the engines, see "Gameplay").

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

## Decided on 7 October

- **Touch devices keep starting at Medium** (the Pixel 5 steps down by itself).
- **The WebGL renderer stays** as what the game falls back to when WebGPU doesn't
  start; it only has to work, not to match the look.
- **`straight-skeleton` was replaced** the same day: roofs are built on the game's own
  skeleton (`src/map/skeleton.ts`, tested by `scripts/check-skeleton.mjs`); the build
  holds no CGAL or WebAssembly and is 2 MB smaller; the roofs match the old ones
  within 2 cm on all 10,275 of a sample (`scripts/roof-compare.mjs`,
  `docs/licences-review.md`). `npm prune` is owed, once no older branch is served from
  the shared `node_modules` (the `night-audio` worktree still imports the package).
- **The cruise boat stays lower.**
- **Missions are not being launched for now** (8 October). Branch `night-missions` stays
  as it is; the taxi job is only for someone in a taxi, the other answers (tone, which
  three factions) are open until it is taken up again.
- **`play.streetsofprague.com`:** live since 8 October (v0.5.5); the root redirects to it,
  the homepage stays offline, saved games are not carried over, `streets-cf` is gone.
  `streets.jonasjancarik.cz` still redirects to the root (so two hops to the game); left
  as it is on purpose until the root gets content of its own.

## Decisions needed

- **Missions and factions (plan 004):** nine answers were assumed on branch
  `night-missions`; confirm or change them (top of the plan's Result on the branch).

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
- Plan 017: shadow-only eight-point rims are implemented behind `?treeShadows=simple`.
  Pixel 5 woods/suburb gains repeat in both orders; see the plan for exact results
  and adoption limits. The visible-crown and smaller-page options remain untried.

## Performance

- **Plans 032–036** are done; each removed its repeated work, and together they looked
  quicker standing (6 of 6 pairs) but not clearly on the drive. Left: a same-build
  noise control on a quiet machine to confirm the standing gain; persistent car slots
  and dirty matrix/paint uploads for parked cars (deferred by plan 032); the feedback
  and newsletter modals in `check-paused-physics.mjs --url`, which skips them on a dev
  server without the form URLs.
- **Plan 012 Part B** (incremental resting-car index) is on main behind
  `?resting=incremental`, off. One retest on a busy machine was inconclusive (control
  7.9 %, comparison 9.5 %); a quiet-machine retest and `check-resting-cars.mjs` are owed.
- **Plan 010:** the warmed landmarks are switched on in `night-landmarks`'s cloned data
  and matched the old look; replace the shared landmark files (copy them from that
  worktree or `landmarks.py <area> --rebake`) and upload them with the map.
- **Street graphs** now forget tiles far behind the player (checked offline over 8 km
  and with one pursuit in the game). Left: a scenario with a taxi ride across forgotten
  streets. Lamp indexes now retire with their graph tiles; the lifecycle checks are
  in `scripts/check-lamp-forget.mjs`.
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

- A ground rebuild is almost all `osm_area.extract`: about 50 s for the dense suburban
  chunk 5,8, of which the gardens are 26–32 s (119 s before 6 October). The gardens
  could be a layer of their own (how is noted in plan 025).
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
- **Bridges still off:** joins of 3.7–5.3 m at stairs and short footways down to the
  quays (most Závodu míru, Mánesův, Čechův, Štefánikův, Hlávkův most sever); Libeňský
  most (jih) sits on the bank's slope at its ends, 3.5 m under the streets; Branický
  most's footway, Dvorecký most and the cycleway under Barrandovský most are at boat
  clearance (5.5 m over the water), not their real heights; Nuselský most's corners at
  Pankrác were not looked at. `check-bridge-decks.mjs praha` lists them
  (`docs/bridge-deck-check.md`). A game older than 7 October draws bridge stairs at
  ground height on the new tiles: release the game with or before the map.
- **Car streets crossing drops of 7–10 m on the ground** (`node
  scripts/check-step-edges.mjs praha`): terrain or map faults to look at.
- **Spikes in the ground:** 233 lone points more than 2 m off their neighbours remain
  (24 over 5 m), see `check-terrain-spikes.mjs`; ragged cuts are not scanned.
- **River:** the water lies level between weirs now. Beyond IPR's terrain model (north
  of Sedlec) the river's level and valley are guessed (it rises 1 m per km; really it
  is level to the Klecany weir and then drops about 3 m); real terrain there would
  need ČÚZK's DMR 5G (`pipeline/dmr5g.py` is a prototype). A piece of water still sits
  high on the slope beside the river north of Sedlec. Of 57 tiles where water fell by
  more than 10 m, the 14 largest were looked at (all the Vltava beyond the model).

## Map look

- **Gardens (plan 025):** paved strips, sheds, beds, pools, the `plots` field, fences
  lit from both sides and hedges on their own ground are in main and show after the
  ground rebuild (seen on one rebuilt chunk, Ořechovka). Left: corner gaps in the
  data; the `plots` tile field is unread and adds about 12 % to a dense suburban
  tile's JSON, so trim it or use it; 25 drive places in that chunk still touch a road
  or path; fences read quite white from above; crown positions from the photographs.
- **Woods (plan 026):** the young-wood rule errs towards leaving a wood alone (praha:
  298 ha young, 254 ha clearings); a 0.25 m photo could tell pole-stage stands. A tile
  can't see a wood lying wholly in the next tile, so its shrub fringe is missing along
  such a border.
- **Grass and worn paths (plan 027):** verges are a kind of their own and worn paths
  start at OSM entrances and follow the footfall map; seen on five trial chunks only.
  People don't walk the worn paths yet; no dry-season picture of the verge strips.
- **Roofs (plan 028):** look at the school atria after the rebuild (roof class now goes
  by street; countryside tiles and streets without a name still go by 90 m cell).
- **Parking (plan 029):** collision bodies on an estate drive unmeasured (the second
  car in front of a garage is in).
- **Sports grounds and road paint (plan 030):** lane, edge, parking and crossing
  lines now share sports lines' minimum pixel width on both renderers. Close,
  normal and high top-down views and one sloped street were checked on 17 October;
  `docs/performance-log.md` records added attributes, tile-build cost and inconclusive
  frame timing.
- **Lanes (plan 031):** past the city limits unmapped land is grass, not paving;
  unmapped village squares turn to grass with the rest: look for bad cases.
- **Paths and pavements (plan 018):** surveyed pavements, islands, medians, platforms
  and tram beds are in. To look at: far fewer driveway cars where a pavement is
  surveyed (`DRIVE_ROOM` would bring some back), mosaic instead of setts on cobbled
  pavements, wider grey park paths; medians and tram beds were hardly seen. Frame time
  of up to three more ground layers a tile unmeasured.
- **The plain beige ground:** courtyards are classified with it and seams between tiles
  are gone (plan 014); most courtyard ground in the centre is in shadow in the
  photographs and stays neutral. Asphalt, gravel and dirt are still told apart only
  38–40 % of the time on the Smíchov labels (a model from OSM surface tags did worse):
  hand labels from other districts are what is missing. Tiles outside IPR's
  photographs: ČÚZK's colour orthophoto is CC BY 4.0, its infrared unclear, there is
  no surface model out there, and no downloader is written. See
  `docs/beige-cover-city.md`.
- **Painted photo** (`?ortho`): nine variants are in `docs/evidence/painted-photo/` to
  judge; the photograph's shadows are what keeps it reading as a photograph. To try:
  shadows cast from the surface model and the sun, then relit.
- **Roof and wall colours (plan 005):** about a third of the detected roof windows are
  still false finds, mostly chimney tops (57 % before; judged on 29 roofs the
  thresholds were also picked on, so re-measure on a fresh sample); buildings with no
  measured wall and no measured neighbour (28 % in centrum) still take the palette
  (correcting shaded walls by the ground's light was measured and is worse than
  borrowing); building age for OSM-only buildings. Roof clutter costs about 1 % of a
  frame at High; chimneys and roof windows show nothing above noise. Facade window
  pictures tear where a wall is in two pieces out of plane (Italská, 50.07621,
  14.43758). A game older than 6 October reading the new map repaints measured walls
  from the palette: release the game with or before the map.
- **Countryside (plan 021):** steps 1–4 are in main behind `?countryside` (the join,
  behaviour past the edge, hills). Left: step 5, bridges and tunnels (two built
  streets leave the map on one and step at the edge; water tilts with the hills);
  credits for Protomaps and the elevation data in the game; whether to host a copy of
  the elevation tiles (the game fetches them from AWS at run time now); a save made
  past the map resumed in a real browser; a phone measurement (worker time for a
  tile and its heights, bytes on a drive out).

## Gameplay

- **`scene.mjs run all` mostly passes.** It was unstable before the night of 5–6
  October (two of twenty failing in every run on `27bc5ef`); what was wrong is in the
  commits of 6–7 October (arrests and trips to the hospital reaching into the next
  scenario, cars left behind, E meaning something nearer than the test wanted, checks
  timed too tightly, a boat taken off the water 700 m away, a drive aimed past the
  bridge). Five of the last six full runs were clean. Left:
  - `wall-crash` was corrected on 17 October: the old setup could hit other cars
    first and accelerate past 100 km/h. It now checks a clear approach, coasts from
    60 km/h and records the actual wall impact. Ten repeats and the full-run case
    passed with the original final speed limit below 15 km/h.
  - `bike-hit` once: the car put 10 m behind the courier hit something else first
    (34 m from the bike at 14 km/h); the check now says the car's damage and place.
  - `courier-bag` once: E took the player into a taxi standing nearer than the bag.
  - Run the full set a few times on the map rebuilt on 7 October.
  - A car put down by `t.car` can still land inside another car or a tram.
  - A tied-up pedal boat between 600 and 700 m from the player is live on water that
    isn't loaded (harmless as far as seen).
  - Changed in the game along the way, worth a look: at 60 km/h a wall met nose first
    breaks both headlamps (the blow reaches 1.7 m, not 1.3); a bag lying beside a bike
    or moped can be picked up (E used to get you on the bike); a paramedic who can't
    get nearer for 12 s sees to the patient from up to 30 m away.
- **Tyre sounds are off on main** (`TYRE` in `src/audio.ts`); recordings, new engine
  voices, the heavy diesel and measured jet and siren levels wait on `night-audio`.
- **Fire engines don't always get there, and that is accepted** (decided 8 October).
  They don't slow for a tram, bus or car in their way, and a crew held up within 70 m
  gets out beyond the cannon's 16 m. From a fresh game they arrived in time in all of
  60 calls on the map of 8 October; in a long session things pile up and more go
  wrong. Two days of work on branch `night-scenarios` (a route along lanes, traffic
  making room, trams moving on, a driver that goes round things; each behind a switch
  in `src/emergency.ts`) gave fewer rammings at equal arrival times and no fewer bad
  arrivals, so it is not merged; `docs/emergency-driving-handover.md` and plan 006 on
  that branch hold the figures and how to measure. Also: about 40 s to clear a narrow
  street after a fire; cars give little room in the Old Town.
- **Buses** now find a way round where a line has no street (centrum: 40 breaks to 3).
  Left: an AE bus still stalls near Na Poříčí; 581 line breaks over 30 m citywide not
  gone through (`check-bus-lines.mjs praha`); buses cut across sharp bends in a street.
- **Traffic by time of day** is one city-wide figure; queues on real routes, the
  direction of the peak and the car mix are next (`docs/traffic.md`).
- **Parked cars:** the 18 October centre-map sweep found 222 cars in a bus's way,
  with no pickup or emergency-centreline findings after those clearances were added.
  The reproduced pickup collision at the Pobřežní bend is covered by an actual-body
  regression. Bus clearance remains open in `docs/traffic.md`; the sweep is approximate
  and has not yet run on `praha`.
- **Boats:** cruise boats follow the fairway through the locks (`river.json`); they
  still turn at Modřany and Klecany (no usable lock in the map's water). One boat at
  a time goes through a lock cut. One opposing pair passed a live lock check on
  18 October; broader natural queues and other locks remain unchecked (`docs/boats.md`).
  The offline checks now cover hull overlap, opposing queues and release after a
  boat disappears, unloads or turns away (`scripts/check-river-boats.mjs`).
- **Ferries:** P1, P2, P4, P5 and P6 run with tickets; an inspector may check you as the ferry comes in (running
  off from a ferry was not played); P3 and P7 when PID's feed has them; not tried on touch or WebGL.
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
- **Lamps:** an untagged street or footpath is lit where a lamp stands within 45 m or
  buildings stand along it, and the lights carry on to the next lit street up to
  300 m (the owner's middle way, 7 October); 32,267 lamps from IPR's operator-record
  layer were added to the survey's. Its licence and attribution
  (`DTMP_CUR_TMISZNAK_ADS_B`) were checked on 17 October and added to the credits
  (see `docs/licences-review.md`). Left: path lamps on estates may be
  too dense (71 in a 250 m circle at Jižní Město; 30 m spacing is the knob); lamps
  doubled where the two layers disagree by more than 12 m; no picture shows the
  connection rule; no benchmark; a hung lamp with no wall within 18 m on both sides is
  drawn without cables; posts in cobbled squares and on bridge decks are not checked
  for standing in the way. Rebuild the lamp files after any rebuild of the tiles (the
  roadways come from them): `build_lamps.py`, then `test_lamps_off_the_road.py --built`. The lighting cables (`DTMP_CUR_TMISPRUBEH_L`, code
  616602) could say which streets are lit instead of inferring it. The numbers on the
  lamps' plates are in none of IPR's open layers. Roofs no longer take lamplight; a
  `bench.mjs --ab` is owed.
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
- Walls, fences and railings from set 3 of the technical map are in
  (`pipeline/dtm_walls.py`). Left: railings are drawn as picket fences; surveyed steps
  and terrain edges (Terénní hrana) unused; a few railings across footways and kept
  OSM walls across paths (`dtm_walls.py <area> --crossings`).
- Noise maps for how loud a street's background is.
- Smaller things: avenues, memorial trees, noise barriers, fountains, public toilets,
  recycling bins, parking meters, playgrounds (<https://opendata.geoportalpraha.cz/>).

## Housekeeping

- **Licences:** `docs/licences-review.md`. TSK Praha's terms could not be read (someone
  has to look at the dataset entries or ask);   The repository has no LICENSE file.
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
- **Worktrees share `node_modules/.vite`** (the symlinked `node_modules`): one session's
  `vite --force` can break another's dev server until it is restarted.
- **Night worktrees** (`.claude/worktrees/night-*`, plus `night-renderer-snap`): keep
  those whose branch is unmerged; the merged ones can go (move their `node_modules`
  and `public/data` symlinks to the Trash first).
