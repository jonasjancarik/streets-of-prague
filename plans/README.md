# Implementation plans

| Plan | Scope | Status |
| --- | --- | --- |
| [001: Transition to TypeScript](001-transition-to-typescript.md) | Browser `src/`, entry page, compiler gate, documentation | DONE (local) |
| [002: Money](002-money.md) | 10 000 Kč wallet, paid taxis, PID tickets, an inspector who chases you, shared bikes, HUD | DONE |
| [003: Cloudflare deploy](003-cloudflare-deploy.md) | App as a Worker with static assets, map data in R2, mbxp kept alongside | DONE (streetsofprague.com main; beta on mbxp) |
| [004: Missions and factions](004-missions-and-factions.md) | Mission engine and odd jobs, factions with reputation and turf, story missions; several questions still open | PLANNED (open questions) |
| [005: Roofs and colours from the photo mesh](005-roofs-and-colours-from-the-photo-mesh.md) | Real wall and roof colours and roof materials measured from IPR's photo mesh, mansards with windows, detected roof windows, dormers and chimneys | MOSTLY DONE (in main: `mesh_colours.py`, `roof_details.py`; measured for the whole city on 1 October; wall coverage about 42 %, window and chimney checks open) |
| [006: Firefighters](006-firefighters.md) | Fire engines called to burning cars, crews putting out wrecks, blue lights and sirens, traffic giving way, the player's water cannon, a firefighter job | PHASES 1–3 DONE (the job waits for plan 004) |
| [013: Fill the beige ground](013-fill-the-beige-ground.md) | Squares' surfaces from OSM, an asphalt-grey pavement palette, and DTM courtyards and green | PHASES 0–3 DONE (main and shared local tiles; photo classification is plan 014) |
| [014: Identify courtyard surfaces](014-classify-courtyard-surfaces.md) | Deferred photo classification within DTM courtyard outlines | PLANNED |
| [018: Simplify paths and pavements](018-simplify-paths-and-pavements.md) | Remove duplicate walking ribbons while preserving real paths and contrasting surfaces; shape tidying and surveyed pavements later | PHASES 0–2 IN MAIN AND LIVE IN v0.5.2 (whether the 2026-10-03 map includes them is unconfirmed; phases 3–4 deferred) |
| [019: Move the crowd into a worker](019-move-the-crowd-into-a-worker.md) | Pedestrians walk in a worker of their own; the main thread keeps the roster, collisions and drawing, and scenarios run the same code inline | SHELVED (built on `worktree-crowd-worker`; no gain on the M5 or the Pixel 5) |
| [020: iOS and Android apps](020-ios-and-android-apps.md) | The website's build wrapped with Capacitor for iPhone, folding iPhone, iPad and Android: sound that survives the silent switch, the map streamed with an optional download for offline play, the game and map updating without a store release, frame rate above 60 where allowed | PHASES 1–3 AND ANDROID BUILT on branch `ios-app` (21 commits, unmerged); real-device checks, phases 4, 5, 7 and 8 open |
| [021: Countryside generated in the browser](021-countryside-generated-in-the-browser.md) | Past the edge of the built map, tiles the browser makes itself from OpenStreetMap vector tiles: roads, land, buildings, later hills; joined to the built map without a step in the road | PLANNED (prototype decides) |
| [024: The game on play.streetsofprague.com](024-game-on-play-subdomain.md) | The game and its `/api` move to `play.streetsofprague.com`, the homepage in `site/` takes the root as a second Worker, saved games and settings follow the player, old links to the game keep working | PLANNED (five decisions to confirm first) |
| [023: Seasons](023-seasons.md) | A fixed game date; seasonal trees, ground, fields, hedges, light, weather and birds; season choices on the start screen | STEPS 1–4 IN MAIN AND LIVE IN v0.5.2 (ground cost unresolved) |

### Overnight status, 3 October 2026

Plan 018's surface implementation and review fixes (`5efe19e`, `6711199`) passed
focused regressions and matched views. The combined private `centrum` validation
(`187f410`) passed strict assembly for 234 tiles, preserved route and parking inputs,
and checked player movement and furniture placement. This does not activate shared
tiles or complete the deferred shape tidying and DTM pavement phases.

Seasons step 3 (`243aa86`) has full-year CPU checks and 48 matched WebGL/WebGPU
images; its ground-cost comparison remains inconclusive. Step 4 (`6d05bc0`) passed
Prague-date, midnight, URL, save and English/Czech checks, plus desktop and 390 px
menu checks. Bird gains (`2ac779d`) passed full-year, offline and muted runtime
checks. The tree-pool check owed from step 2 and physical-phone validation remain
open; later seasonal features remain deferred in the plan.

These reports describe accepted local work, including the isolated integration
checkout. The accepted source is merged into main and released as v0.5.2 (3 October 2026). Source-map pilots held
for further review remain outside these completion claims. The seasons plan is 023;
the play. subdomain plan was renumbered 024 to avoid the clash.

Plans 001–006 were indexed from `c6b5350`. Check the working tree and each plan's
starting revision before implementation; preserve unrelated changes.

## Fewer objects and draw calls

Planned on 1 October 2026 at `1b5756cdf775c7fbde3e5522fb57de5658664bcf` from reading
the code, after plans 007–012 showed no general frame-rate gain. Buildings and ground
have few triangles; the aim here is fewer objects and draw calls, since the main
thread limits the frame on WebGPU. Each plan starts with a counting step and a stop
condition to establish how much of the frame the proposed change affects.

| Plan | Scope | Priority | Estimated effort | Status |
| --- | --- | --- | --- | --- |
| [015: Paint cars per instance](015-paint-cars-per-instance.md) | One retained mesh per car type, with the paint as a per-instance colour | P1 | One to two days | DONE (local; draw reduction verified, timing benefit provisional) |
| [016: Draw only nearby tiles](016-draw-only-nearby-tiles.md) | Keep collisions, graphs and parking out to 300 m; make a tile's meshes only near the view | P1 | Three to five days | DONE on branch `nearby-tiles` (not merged or deployed; steady-state gain 1–3 %, the gain is in tile arrival work) |
| [017: Cheaper trees on phones](017-cheaper-trees-on-phones.md) | Measure whether a Pixel 5 is limited by tree vertices; then a simpler shadow crown, a simpler crown on low tiers, or smaller pages | P3 | Half a day to measure, two to three days after | PLANNED (measurement decides) |

The three are independent. 015 is the smallest and most contained. If 016 goes
ahead, repeat 017's measurement after it.

## Driving stutter

These six steps were planned through source inspection at
`5162c1fcf11e51df8ceda46049cac217fc7a12cd` on 30 September 2026. No implementation,
asset conversion, runtime check or new measurement was performed while writing them.
Each file is a self-contained handoff with current-code excerpts, scope, ordered
implementation steps, regression cases, future verification commands and stop conditions.

| Step | Plan | Priority | Estimated effort | Status |
| --- | --- | --- | --- | --- |
| 1 | [007: Share building and lighting shader graphs](007-share-building-shader-graphs.md) | P1 | About a day | DONE (main; timing benefit inconclusive) |
| 2 | [008: Prepare and retain car meshes](008-prepare-car-meshes.md) | P1 | One to two days | DONE (main; timing benefit inconclusive) |
| 3 | [009: Reuse spatial tree batches](009-reuse-tree-batches.md) | P1 | Several days | DONE (main; timing inconclusive) |
| 4 | [010: Bake landmark colour adjustments into assets](010-prebake-landmark-colours.md) | P2 | One to two days plus asset checks | DONE (main code and isolated assets; shared data/deployment pending, timing inconclusive) |
| 5 | [011: Reuse spawn weights and pavement-traffic lookups](011-reuse-spawn-sampling.md) | P2 | About a day | DONE (main; timing benefit inconclusive) |
| 6 | [012: Schedule streaming and update parked-car collisions](012-schedule-streaming-and-update-collisions.md) | P2 | Several days | VERIFIED locally; Part A accepted for main, Part B held (desktop regression) |

### Order and dependencies

Execute in the order shown. These are not strict functional dependencies: each
optimization can be understood and implemented independently. The order puts
smaller shader-related changes before tree ownership changes, then addresses
location-specific loads and remaining simulation/streaming work. Compare each step
with the state immediately before it, so improvements from earlier steps do not
hide a later regression.

Several plans edit `src/main.ts` or `src/tiles.ts`; do not apply their excerpts as
whole-file replacements. In particular, retain the current tram-driving and fare
work. Plan 007's shared lamp-light wrapper affects later rendering checks. Plan 010
must reconcile any implementation of plan 005's colour work, and it has a separate
asset-migration outcome: code completion does not mean shared or deployed map data
has been converted. Plan 012 has two separately verified parts, streaming then the
resting-car index.

The plans do not authorize delegation. If work is explicitly assigned to separate
people or agents, give each the corresponding plan and coordinate shared-file edits.
No new dependencies, renderer downgrade, visual-quality reduction or deployment is
part of this sequence.

### Verification and status

Runtime commands in the plans are for later authorized implementation. They were
checked against the repository's scripts by reading them, not executed. Commands
for new regression scripts are explicitly labelled as proposed implementation
work. The package currently has `typecheck` and `build`, but no general npm test,
lint or docs-list script.

Use the existing performance skill for stable snapshots, alternating comparisons,
Chrome/WebGPU checks and generated-data handling. Inspect images and console errors
before trusting a faster frame: a missing object is not an optimization. Report
shader-build/operation counts separately from observed timing changes, and do not
claim a timing benefit when the comparison is inconclusive.

Executors should update their row to IN PROGRESS, DONE, or BLOCKED with a short
reason. Record the implementation revision, exact verification commands, relevant
device/settings, results, visual checks and residual limitations in the plan's
Result section. For plan 010 also state whether assets are only staged, active in
shared local data, or deployed. Commit/branch/push/deploy actions still require the
operator's separate authorization.

### Considered and deferred

- **Auto graphics material disposal:** it refreshes stale shadow-texture bindings.
  Removing it is not a safe optimization without a verified replacement; these
  plans retain it and use fixed graphics tiers for comparisons.
- **Police route searches:** conditional on pursuits, with existing retry limits;
  investigate if residual pauses correlate with chases rather than general driving.
- **Street graph pruning:** relevant to long sessions, but must preserve active
  routes and is outside this six-step effort.
- **Moving parking into workers:** previous repository results found relatively
  little main-thread cost; it is not a leading target for these hitches.
- **Lower tree density or simpler surface/roof shaders:** changes the look and is
  not required to remove repeated setup work.
- **Per-instance car paint, parked-car render-transform caching, broad object
  pooling and offline sky baking:** possible follow-ups, not part of this scope.
- **Staggering the life tick:** reconsider only if the narrower step-5 changes leave
  a measured burst; scheduling changes must not alter population or accounting.

Merge findings for plans 007–012 are recorded in
[the summary](../docs/optimisation-findings-007-012.md). Implementation completion
does not imply that every experiment is recommended for main.

## Closer to the aerial photos

Planned on 4 October 2026 at `364e7f3cac31a9aedb4a64f8c0b1ac9563258990` from ten random
250 m squares of the local `praha` map, each looked at from straight above and set
beside IPR's 2024 aerial photo of the same square (ČÚZK's for the two squares past the
city limits). Streets, footprints and roof shapes inside the city matched well; what
differed was what lies between the buildings, and everything past IPR's data. All
procedural, nothing authored per place. Each plan starts with a counting step;
nothing was built or measured while planning.

| Plan | Scope | Priority | Estimated effort | Status |
| --- | --- | --- | --- | --- |
| [025: Gardens divided into plots](025-gardens-divided-into-plots.md) | Garden blocks split into a plot per house; hedges, fences and gates; trees where the surface model has them; a paved strip, sheds, pools | P1 | One to two weeks | PLANNED |
| [026: Woods with a closed canopy](026-woods-with-a-closed-canopy.md) | A dark woodland floor, holes in the canopy filled, uneven heights, conifers in stands, a ragged edge | P2 | Three to five days | STEPS 0–3 MERGED (young woods and the floor blend at the edge left) |
| [027: Summer grass that differs by place, and worn paths](027-summer-dry-grass-and-worn-paths.md) | Meadows and estate lawns dry out in summer while gardens and pitches stay green; trodden lines across estate grass | P2 | Four to eight days | MERGED; July baseline open, full map rebuild to do |
| [028: Roofs on buildings without IPR data](028-roofs-on-buildings-without-ipr-data.md) | Flat or pitched by kind and size, a wider roof palette past the city limits; parapets, lift houses, vents and solar panels on flat roofs; the roofed-over school atria | P2 (flat-roof details P3) | About a week | PARTLY MERGED: atria, shape and colour rules, parapets; flat-roof details (step 4) and the IPR re-run left |
| [029: Parking where the map has no car park](029-parking-on-unmapped-ground.md) | Bays on paved yards and unmapped estate car parks, a car on the drive of family houses | P2 | About a week | PARTLY MERGED: inferred car parks and drive cars; estate strips (B) not built |
| [030: Sports grounds in their own colours](030-sports-grounds-in-their-own-colours.md) | Tartan, clay, artificial grass and hard courts from OSM's `sport` and `surface`, with each sport's lines | P3 | One to two days | MERGED |
| [031: Narrower lanes outside the city](031-narrower-lanes-outside-the-city.md) | Street widths past the technical map from the room between the plots and from the setting, verges; the grey hectare at Nad Vinicemi | P2 | Two to four days | MERGED: setting-based widths, single lane, gardens on unmapped land, gravel shoulder; the pavement-or-verge pass left |

025 comes first: it changes the most, and 029's driveway cars need its plots. 030 is
the smallest and stands alone. 028 and 031 share their rules with plan 021's
countryside tiles.
