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
  `scripts/road-places.json`. Stretches on a deck in IPR's bridge model that OSM doesn't
  call a bridge are left out of the LiDAR comparison (the bare-earth scan is the ground
  under them). The index records the terrain's options. `praha` takes
  1.5–2 minutes: the road outlines are tested as half-metre masks now (`--exact` for
  the polygons), nine times faster, within a quarter of a metre of an outline.
  - **Thresholds** from the real roads: along the middle lines of 4,345 km of streets
    on the ground, the LiDAR's waves are under 4, 9 and 24 cm (2, 5, 12 m either side)
    at 99 % of points, and over the flags (0.1, 0.2, 0.5 m) at 0.2 %. The map is over
    them at 1.0, 2.1 and 1.8 % of line metres: six to ten times the real road.
  - **Baseline**, the beta's map before the fix (built 7 Nov) → today's map:
    86.7 → 86.7 % of carriageway within 0.3 m of the LiDAR (target 95 %), 1.30 →
    1.29 % more than 1 m off; middle offset +0.02 m (the conversion is right).
    Streets whose worst is more than 1 m off: 2,220 with nothing beside them, 379 →
    367 by a bridge or tunnel (257 over 2 m, 111 over 5 m: most of the big ones), 82
    by a wall's terrace. Reports: `docs/evidence/road-plan/report-{beta,now}.{txt,json}`.
  - **The dips** on the old map: Na Veselí −6.05 m off the LiDAR and 2.85 m waves (its
    worst step was 0.36 m, which is why the old check missed it), náměstí Hrdinů
    −2.11 m. On today's map 1.27 and 0.35 m.
  - Worst left (step 2 and 3): Čuprova and Sokolovská in Vysočany 14–18 m over the
    LiDAR (the elevated road's kerbs surveyed as ground), Na Botiči 15 m, a trunk at
    49.9426, 14.3677 15 m under it for 1–2 km, Dobříšská's north end 7 m over,
    Kongresová 6 m under, náměstí Míru 4 m over, the side street at náměstí Hrdinů
    4 m over (a wall's terrace reaching onto it).
- 8 November 2026, step 2 started: the LiDAR decides where the survey has two levels,
  as rules in `dtm_heights.py` rather than a file of decisions (the evidence agreed at
  every place looked at, so the script decides; a file is still the way for places it
  can't). All on `praha` with `--step-lines`, against today's map.
  - **A bridge's deck kerbs out of the ground** (4238a983): a surveyed point more than
    3 m over the highest the LiDAR has within 2 m is up on something; inside one of the
    map's bridges it's the deck's, and no lattice point takes it. And where a lattice
    point's nearest kerbs are on two levels, the LiDAR picks the one it agrees with. The
    D0 under Na Radosti lost its 8 m hump (its slip road's bump 3.64 → 0.23 m); bumps
    over 0.5 m 510 → 482, waves over 0.3 m within 2 m 1,739 → 1,703, streets more than
    1 m off the LiDAR beside a structure 367 → 331. But 8 bridge joins got worse by more
    than half a metre, two of them 7 m.
  - **A bridge's last metres** (57b7f2ef): OSM ends bridges a few metres short of their
    abutments, and the bridge's end takes the ground's height there. Kerbs within 6 m
    of where a bridge comes down to the ground stay the street's. Joins worse by more
    than half a metre: 8 → 2; Malovanka's slip road 7.08 → 0.22 m, Hlávkův most's north
    footway 6.03 → 0.03 m. (Keeping the LiDAR from picking the lower level within 25 m
    of a bridge, tried first, changed none of the joins.)
  - **Decks the map doesn't draw** (5dae8174): outside the map's bridges a kerb up on
    something is the street's own where it carries on from the street's other kerbs at
    a street's grade (a viaduct the map calls ground), and a deck's over the street where
    it doesn't. Čuprova under the railway: bump 2.1 → 0.28 m; Na Žertvách 5.27 →
    0.32 m; Na Botiči's step 1.84 → 0.18 m. Steps over 1 m 14 → 12, bumps 471, ridges
    over 1 m 139 → 103, waves over 0.3 m within 2 m 1,686, streets more than 1 m off
    the LiDAR beside a structure 321; no bridge join changed.
  - **Čuprova under the railway** (9 November): in a tunnel's strip a kerb more than 3 m
    under the highest kerb round it counts as the underpass's, and the highest was the
    railway's deck, so a cycle path's tunnel beside Čuprova took the street's own kerbs
    for its own and the deck filled the street, a ridge 18 m high. The highest is now
    one that isn't up on something: Čuprova's waves within 12 m 5.40 → 0.29 m and 3.56 →
    0.57 m, its bump 0.75 → 0.13 m; 535 fewer kerbs taken for an underpass's in the
    city, no bridge join changed, and one street worse: Wilsonova by Těšnovský tunel,
    already leaning 48 % across, bump 1.25 → 1.81 m (its crown 1.53 → 1.08 m). Judging
    the kerbs of surveyed pieces too small to hold a lattice point, the first guess,
    moved no street in the city.
  - **A footway's tunnel under Modřanská, a pad across Ohrobecké údolí** (9 November,
    bc877eb0, 7feb7740): Modřanská's lattice points at Zlíchov lay in the strip of a
    footway's tunnel crossing under it and took its floor, pits 2–3 m deep; a car street
    crossing a tunnel is no longer in it. A bridge's end lifted over a car street that
    crosses its pad stays on the ground: Ohrobecké údolí 6.66 → 0.21 m. Together: steps
    over 1 m 12 → 11, bumps over 0.5 m 469 → 468, ridges over 1 m 103 → 102; Čechův
    most's join 0.12 → 0.72 m, Oistrachova's bump 0.75 → 1.49 m and Povltavská's waves
    0.29 → 1.37 m worse.
  - **Tried and dropped: a wall at every bridge end over a lower street** (9 November,
    for 5. května over Hvězdova and its slip roads, a torn slope and a guardrail in
    zigzags). A wall across a bridge's end, a terrace on top, wherever a car street in
    its last 30 m is 3 m or more below the end: 750 walls in the city. It fixed
    Železničářů (3.79 → 0.02 m) and Spojovací (1.63 → 0.06 m), but made 24 bridge joins
    worse by over half a metre (a motorway's 0.12 → 6.81 m at 50.12468, 14.26942) and
    left 5. května looking the same, with slabs standing beside the slope. The slope
    there runs along the lower street, beside the deck, not across its end. The code is
    in `docs/evidence/road-plan/abutment-walls.patch` (local).
  - **Walls along a street in a cutting under a bridge** (9 November): along each side
    of a car street passing under one of the map's bridges, where the terrain model 7 m
    out is 2.5 m or more above the street, a wall from under the deck out to 40 m past
    it, the terrace on top; it stops where another street's middle crosses it or it runs
    into the lane of a street that doesn't meet this one (`_cuttings`, `--no-cuttings`).
    209 walls. Against the two fixes above: bumps over 0.5 m 468 → 462, ridges over 1 m
    102 → 98, waves over 1.5 m within 12 m 633 → 623; 14 streets' bumps better and none
    worse, crowns 14 better and 1 worse (Chlumecká 0.64 → 1.66 m); the trunk link at
    50.08752, 14.38088 7.60 → 1.37 m; joins 6 worse (the footway at náměstí Hrdinů 3.43
    → 6.66 m, by the eye cleaner than before) and 5 better. 5. května's slip road over
    Hvězdova (50.05162, 14.44466) got its wall. Stopping where any other lane touched the
    wall, the first version, put none at 50.05296, 14.44106: the street's own next piece
    of way touched it.
  - **5. května over Hvězdova by hand** (9 November): two walls in `terrain_walls.json`
    along the survey's top edges of the embankment (264–265 m) either side of the low
    ground under the bridges, the west one 31 m, the east one 32 m (carried on north-east
    past the surveyed edge along the lattice's step). The east side is a clean wall now
    and the torn slope under the bridges smaller (`kvetna-hand-walls-above.jpg` in the
    evidence); no street or join elsewhere moved. Still torn: north-west of the west wall,
    between it and 5. května's own south kerb (264 m), the terrain model has a pocket at
    259–260 m, 9–15 m from the wall (past its terrace strip), and the guardrail along the
    kerb still zigzags there. Next to try: a third wall along that kerb (the survey's
    line from 14.440701, 50.053046 to 14.441017, 50.05292), after checking the pocket
    isn't a real slope down to the underpass.
  - Left for step 2: the pocket at 5. května above; Železničářů (3.8 m), a bridge's
    pad across a street; nábřeží Edvarda Beneše (5.4 m) and Kapitána Jaroše (3.2 m); the
    footway at 50.1024, 14.5723 (0.05 → 2.87 m since 4238a983); V Kuťatech, a 7 m bridge
    whose deck kerbs all lie within 6 m of its ends (6.22 m, as today); Wilsonova at
    50.0923, 14.4374 (leaning 48 % across, as today); Kosmická at 50.0319, 14.5323, a
    crown of 3.15 m that keeping out every kerb up on something that no surface carries
    took to 0.04 m (but that also broke the viaducts of Brněnská, Strakonická and
    Pražský okruh, whose own kerbs lie just off their surfaces' outlines).
- 9 November 2026, step 3 measured, not finished. `praha` with the LiDAR as the ground
  (`--ipr-lidar .cache/ipr_lidar/2023 --lidar-ground --lidar-window 4 --step-lines`, on
  today's 4 m lattice, each point the median of the scan's 4 × 4 metres), against
  today's map:
  - **Streets:** bumps over 0.5 m 510 → 295, waves over 0.3 m within 2 m 1,739 → 994,
    over 1.5 m within 12 m 684 → 467, leaning over 15 % 2,883 → 1,999, twisting over 12 %
    2,322 → 1,289; steps over 1 m 14 → 17 (Chotkova 4.4 m, nábřeží Edvarda Beneše 3.9 m,
    Ryšavého's walls).
  - **Bridges and the river are worse:** 112 joins worse by more than half a metre, 92
    better (Jižní spojka 0.18 → 5.01 m; Mánesův most 1.35 → 0.24 m, Palackého most 2.02
    → 1.84 m); the D0's slip road under Na Radosti has a bump of 1.8 m again; a deck
    1.57 m into the river (today 0.59 m) and a new step in the water at tile 60_67. The
    bridges take their ends' heights from the ground (`structures.py`), and with the
    LiDAR that's the bare earth under a deck's last metres.
  - **Cost:** the heights 29.6 MB against 27.0 MB (decimetres: centimetres added
    nothing on a 4 m lattice and doubled them). The lattice, the meshes and the tiles
    are the same size, so the frame time shouldn't move; not benchmarked yet. A 2 m
    lattice would be about as smooth as the scan itself (0.17 % of line metres over
    the 2 m wave flag, against 0.29 % on 4 m), but its heights were 205 MB.
  - **Recommendation:** the LiDAR on today's 4 m lattice, once the bridges read the
    street's height at their ends instead of the bare earth, and the river's decks
    and steps are as good as today's. Not before: today's survey map with step 2's
    rules has the bridges right.
