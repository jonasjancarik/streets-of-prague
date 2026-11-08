---
read_when:
  - Starting work on broken, bumpy, sunk or tilted roads
  - Deciding where the ground's and the roads' heights should come from
  - Adding a rule to pipeline/dtm_heights.py or a road overlay (?roadfit, ?roadsurfaces and the like)
  - Changing check-road-flatness.mjs or adding a road check
---

# Roads without breaks: plan

Written 8 November 2026, after two player reports of the same fault (a pit 6 m deep on
5. května at Na Veselí, a trench of 2 m at náměstí Hrdinů). It sets out how to get from
a map where roads break in places to one where a broken road is rare, found by a check
before a player finds it, and fixed at its cause.

The steps are in order of dependence, and each is judged by numbers before the next
starts. Within a step, how to do it is open: the descriptions say what to aim for and
what's known, not the only way to get there. See "Room to decide" at the end for what
can be changed on the way and what needs asking first.

## Where things stand

The ground, roads included, is one lattice of heights a point every 4.03 m (63 × 63 per
250 m tile). Its heights start from IPR's terrain model (a point every ~10 m), which
`pipeline/dtm_heights.py` corrects from the technical map's survey (DTM ZPS) with a
long series of rules, most written for one kind of problem place. Bridges and tunnels
have levels of their own (`structures.py`); walls and quays are cut as real steps, and
since November each wall carries its own height line (`--step-lines`).

What has been tried for roads, all in [the findings](road-surface-findings.md):

| Trial | What it is | What it did | Status |
|---|---|---|---|
| Road fit | A surface fitted to the 2023 LiDAR over the streets of five inner areas, loaded as patches over the map | Bumps, leaning and twisting about halved; trouble beside banks and under decks | `?roadfit`, off by default |
| One surface | The 2023 LiDAR as the ground itself, 2 m lattice; the survey only says where streets, walls and water are | On `centrum` about the same gain as the road fit, without patches; wall tops rougher; the LiDAR is the ground under some decks | Prototype (`--lidar-ground --step 2`), never built for `praha` |
| Walls as lines | Each wall's top and foot as a line with heights | Steps over 1 m on car streets 37 → 18 on `praha` | On the beta (`--step-lines`) |
| Road profiles, surfaces, junctions, corridors, shelves | Fitted overlays for single streets or screened sets | Local improvements | Each behind its own URL option, off by default |
| Underpass kerbs | Kerbs of a road in a mapped tunnel kept out of the street above | The two reported places fixed; 40 streets changed, all better on the counts | In `main` (48f7cc8f) |

The beta's map (built 7 November, with `--step-lines`), car streets over the limits of
`scripts/check-road-flatness.mjs`:

| | flag | hard limit |
|---|---|---|
| Steps along the street | 272 over 0.25 m | 17 over 1 m |
| Bumps (against the line 3 m either side) | 4,383 over 0.15 m | 535 over 0.5 m |
| Leaning across | 7,505 over 8 % | 2,961 over 15 % |
| Ridge or trough across | 1,367 over 0.3 m | 145 over 1 m |
| Twisting (lean's change over 4 m) | 8,640 over 5 % | 2,427 over 12 % |

## Why roads break

1. **The heights come from rules, not from the road.** IPR's model is too coarse for a
   street, and the survey gives kerbs, not the road between them. The rules that join
   the two each fix their case and interact with the others: both reported dips were
   two rules (a surface's heights from its nearest edge points, and levelling across)
   taking the kerbs of a road on another level.
2. **Two levels in one place.** Where a road passes over another (a short underpass, a
   station hall, a ramp beside a quay) the sources disagree about which surface is
   which. The survey draws both as one surface, OSM's bridge is often shorter than the
   real one, the airborne LiDAR sees only the top, and IPR's bridge model is coarse or
   missing. Most of the worst breaks are of this kind.
3. **The lattice is coarse for a road.** A 4 m lattice with bilinear heights can't keep
   a narrow street on a hillside level, or a diagonal street beside a bank from
   twisting. Much of the leaning and twisting is this.
4. **Several surfaces read different ways.** The overlays sit over the map as patches,
   and the ground, the walls, the parapets, the cars and the checks each combine the
   map and a patch their own way at a step.
5. **The checks measure smoothness, not truth.** A road can pass every check and still
   be metres off the real one, and a smoothing pass would turn a pit into a long sag
   that passes.

## What to aim for

- **The road is where the real road is.** The 2023 LiDAR (IPR's bare-earth raster, 1 m,
  in `pipeline/.cache/ipr_lidar/2023`) is the reference for the top surface of every
  road on the ground. Smoothness follows from that; it isn't a goal of its own.
- **Which level a road is on is decided, not guessed.** Where two levels meet, the
  decision is written down with its evidence, and the pipeline reads it.
- **One surface, read one way.** The ground, the roads, the walls, the cars and the
  checks all read the same heights in the same way.
- **A break is found by a check, not by a player.** Every build is measured, and a
  map that's worse than the one before doesn't get deployed without a reason.

Rough targets, to be adjusted as we learn: no car street on the ground with a step
over 1 m that isn't a reviewed exception (bridge joins are counted on their own); 95 % of
carriageway within 0.3 m of the LiDAR where the LiDAR sees it; leaning over 15 % and
twisting over 12 % each under a tenth of today's.

## The steps

### 1. Measure roads against the real road

The step everything else is judged by. About a day.

Extend `scripts/check-road-flatness.mjs` (or add a sibling it shares code with):

- **Lines along the road, a metre apart across it.** Today the check walks three lines:
  the middle and the two edges. Walk lines parallel to the street's middle, one every
  metre across the carriageway as drawn, so a 10 m street gets about ten. No pit can
  then lie between them.
- **Waviness at several lengths.** On each line, how far each point lies off the
  straight line through the points a few metres either side, for about 3 m (bumps,
  washboard, as now), 10 m (dips like Na Veselí's) and 25 m (long sags). Climbing and a
  steady lean cost nothing; only bending counts. Leaning and twisting come from
  comparing neighbouring lines at the same station, as now.
- **Distance from the LiDAR.** For each sample on the ground, the map's height minus
  the LiDAR's. Leave out samples on a bridge or in a tunnel, under a deck, and where the
  LiDAR has no value. Per street: metres of carriageway more than 0.3 m and more than
  1 m off, and the worst point. This is the check that would have found both reported
  dips on its own.
- **Places players reported.** A small file of places (lat, lon, radius, date, what was
  reported, the feedback's key) that the report always lists with their worst values.
  Start with Na Veselí (50.0546, 14.43879) and náměstí Hrdinů (50.05715, 14.43602), and
  add the places in the findings (náměstí Míru, Wilsonova, Legerova, Kongresová).
- **One report.** A summary like today's table with the new columns, `--against` a
  saved report, the worst places with a place to paste into the game, and the build's
  date, pipeline commit and build options in the saved file, so a comparison says
  whether it is like with like.

Known: the LiDAR raster is in S-JTSK. Converting from the game's local metres must go
through WGS84 with the Czech datum shift (`ipr_buildings.krovak_to_local`); a direct
pyproj transform skips the shift and lands about 115 m away. On 8 November a scratch
script did that and compared the map with the wrong patch of ground for a whole
diagnosis. Test the conversion on a place with a known height.

Done when one command reports `praha` in a few minutes, the beta's map has a saved
baseline, and both reported dips show at the top of the LiDAR column when the check is
run on the map built without the underpass fix (`--no-sunk-kerbs`).

### 2. Decide the levels where two meet

Find every place where two levels could be confused, and decide each one with its
evidence.

- **Find them.** Samples where a surveyed surface's nearby edge points span more than
  about 3 m; where the map's ground and the LiDAR differ by more than 2 m; where a car
  street on the ground runs within a few metres of a bridge's or tunnel's end; where
  IPR's bridge model has a deck the map lacks, or the other way round.
- **Gather the evidence for each.** OSM's ways and their bridge and tunnel tags and
  extents, IPR's bridge faces, the survey's placement levels, the LiDAR (top surface
  only), IPR's surface model, and the photo mesh when in doubt.
- **Record the decisions** in a file the pipeline reads, as relationships rather than
  boxes: "this carriageway runs onto this deck", "this bridge reaches to here",
  "these kerbs belong to the road below". Each with its source, date and reason,
  so a change in OSM or the survey can be checked against it. Where the evidence
  agrees, the decision can be made by the script and listed; where it doesn't, it's
  listed for review with a picture.
- **Use them in the build.** The rules for two levels (`LEVELS`, `UNDER_BRIDGE`, the
  cuttings, the new underpass kerbs) become the fallback where nothing is decided.

Done when the places step 1 lists as off the LiDAR by more than 1 m next to a structure
are all decided or knowingly left, and decided places stay right in the next build.

### 3. The LiDAR as the ground for the whole city

The prototype exists (`ipr_terrain.py --ipr-lidar .cache/ipr_lidar/2023 --lidar-ground
--step 2`, with `--step-lines`); it has never been built for `praha`.

- **Build `praha` with it** in a worktree with cloned data, next to a build of the same
  commit without it, and compare with step 1's report, `check-bridge-decks.mjs`,
  `check-step-edges.mjs` and `check-river.mjs`.
- **Keep the rules where the LiDAR can't speak:** under decks (the LiDAR sees the deck,
  or interpolates under a long one), where it has no value, on water. Step 2's
  decisions say which is which.
- **Known problems from `centrum`:** the LiDAR is the ground under some decks (Wilsonova
  over the main station's hall, by Nuselský most), wall tops are rougher than today's,
  and the wall rules assume 10 m ramps (with the LiDAR they're 3–4 m, `Reach(sharp)`).
- **Cost.** The trial put `praha`'s heights at 300–400 MB instead of 61 MB (the LiDAR's
  centimetres don't compress), fetched a tile at a time as the player moves. Measure
  the tiles' sizes and load times, the frame time with `scripts/bench.mjs` (see the
  performance skill), and a phone. If it's too much, try the LiDAR's heights on today's
  4 m lattice (same size as now), or 2 m only near streets.

Done when there's a measured comparison and a recommendation. Switching the map to it
is the user's decision (see below).

### 4. Smooth roads inside the build

Once the ground follows the LiDAR, a parked car, a hedge or noise in the scan still
shows on a road. The road fit already knows how to handle that: stiff along a street and
loose across it, waves under about 20 m smoothed away, a lopsided robust loss so cars
can't lift the road, a softer junction, cut at walls (`pipeline/road_fit.py`). Apply that
method to the lattice in the build, for all of Prague, instead of as patches.

Done when step 1's report improves over step 3's without more road off the LiDAR. Then
compare with each overlay (road fit, surfaces, corridors, junctions, profiles,
shelves); where the built-in surface is as good or better, propose removing the
overlay, with the numbers.

### 5. A gate before deploying

- The terrain build writes step 1's report next to the map.
- The deploy scripts (`deploy-cloudflare-beta.sh`, `upload-data.sh` for production)
  compare it with the report of the map that's live, and stop if a hard-limit count
  rises or a reported place gets worse, unless told to go ahead with a reason, which
  is recorded with the map.
- The limits start as "no worse than the live map" and tighten as the numbers fall.

Done when a deploy of a worse map stops and says why.

### 6. Roads as their own surface, only if needed

If narrow hillside streets still lean or twist after steps 3 and 4, give carriageways a
surface of their own, triangulated along their exact outline and fitted to the LiDAR,
with the ground joining it at explicit edges ("Proposed road model" in the findings).
The game, the cars and the checks must all read it. It's the biggest change in the
list; don't start it until the earlier steps show it's needed.

## How to work

- **Compare like with like.** A before and after are the same commit with the change
  switched off by a flag, built with the same options. On 8 November a comparison
  against the beta's map showed 35 steps over 1 m against 17, because the beta was
  built with `--step-lines` and the new build wasn't, and from older code. Record the
  build command with every saved report.
- **Work in a worktree with cloned data** (`public/data/<area>_now` and
  `pipeline/.cache` as APFS clones), never on the main checkout's shared map. Don't edit
  `pipeline/` while a `praha` build runs: the build checks its own code at the end and
  refuses its output if a file changed.
- **Try small first.** `ujezd` builds in seconds and `centrum` in under a minute;
  `praha` takes 16–18 minutes. A probe that prints the lattice at a few places after
  each stage of `dtm_heights.apply` found the cause of the reported dips in one build;
  keep such probes out of commits.
- **Look as well as count.** Before and after pictures from the game at the places
  that changed most (the scene-testing skill; `t.eyes = { yaw: 0, pitch: -8 }` gives a
  windscreen view). Numbers miss what's beside the road.
- **Keep the record.** Findings go into [road-surface-findings.md](road-surface-findings.md),
  this plan's "Progress" below gets a line per step, evidence goes into
  `docs/evidence/` (local), and each step is committed in small commits with a
  regression test where it fits.

## Room to decide

During implementation, decide freely and note what was decided and why:

- thresholds, window lengths, line spacing and the report's format;
- file names and where code lives, merging or splitting steps, the order of work
  inside a step;
- a better method than the one described, if it does the job better on the numbers
  and the pictures;
- dropping an approach after a fair trial, with the reason in the findings;
- small fixes to pipeline rules found on the way, each with its comparison and a test.

Ask first:

- deploying to the beta or production;
- changing the options or defaults that the shared map is built with;
- a map that grows by more than about a fifth, or a frame-time cost that shows on the
  benchmark;
- removing an overlay, a flag or a rule;
- a rule change that moves more than a few hundred streets without a clear gain.

## Progress

- 8 November 2026: underpass kerbs kept out of the street above (48f7cc8f); in `main`
  and pushed. The beta (Cloudflare) has it since the evening: game 903ea33c, map
  `beta-5b2e5ce38dd8` (built 19:45 with `--step-lines`).
- 8 November 2026, step 1 done. `check-road-flatness.mjs` walks lines 1 m apart, measures
  waves 2, 5 and 12 m either side (the plan's 3, 10 and 25 m windows, rounded to whole
  metres each way), compares every line every 2 m with the LiDAR
  (`pipeline/scan_heights.py`), sorts each street's worst LiDAR offset by what's beside
  it (a bridge or tunnel within 15 m, a wall's terrace, neither), and lists
  `scripts/road-places.json`. The index records the terrain's options. `praha` takes
  1.5–2 minutes: the road outlines are tested as half-metre masks now (`--exact` for
  the polygons), nine times faster, within a quarter of a metre of an outline.
  - **Thresholds** from the real roads: along the middle lines of 4,345 km of streets
    on the ground, the LiDAR's waves are under 4, 9 and 24 cm (2, 5, 12 m either side)
    at 99 % of points, and over the flags (0.1, 0.2, 0.5 m) at 0.2 %. The map is over
    them at 1.0, 2.1 and 1.8 % of line metres: six to ten times the real road.
  - **Baseline**, the beta's map before the fix (built 7 Nov) → today's map:
    86.6 → 86.7 % of carriageway within 0.3 m of the LiDAR (target 95 %), 1.33 →
    1.32 % more than 1 m off; middle offset +0.02 m (the conversion is right).
    Streets whose worst is more than 1 m off: 2,226 with nothing beside them, 385 by
    a bridge or tunnel (273 over 2 m, 115 over 5 m: most of the big ones), 82 by a
    wall's terrace. Reports: `docs/evidence/road-plan/report-{beta,now}.{txt,json}`.
  - **The dips** on the old map: Na Veselí −6.05 m off the LiDAR and 2.85 m waves (its
    worst step was 0.36 m, which is why the old check missed it), náměstí Hrdinů
    −2.11 m. On today's map 1.27 and 0.35 m.
  - Worst left (step 2 and 3): Čuprova and Sokolovská in Vysočany 14–18 m over the
    LiDAR (the elevated road's kerbs surveyed as ground), Na Botiči 15 m, a trunk at
    49.9426, 14.3677 15 m under it for 1–2 km, Dobříšská's north end 7 m over,
    Kongresová 6 m under, náměstí Míru 4 m over, the side street at náměstí Hrdinů
    4 m over (a wall's terrace reaching onto it).
