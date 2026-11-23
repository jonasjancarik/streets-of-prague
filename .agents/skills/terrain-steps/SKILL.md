---
name: terrain-steps
description: How Streets of Prague's terrain gets its quay walls, retaining walls and bridge heads (the steps in the ground, from the technical map's survey), and how to find and fix a place where the ground looks broken. Use when the ground is ragged, pitted or spiked somewhere, when a bridge dips, kinks or doesn't meet its street, when water climbs a bank or a wall has a hole in it, when working on pipeline/dtm_heights.py, pipeline/structures.py, pipeline/ipr_terrain.py, pipeline/terrain_keep.json, pipeline/terrain_walls.json, the labels in src/terrain.ts or the cutting and walls in src/ground.ts, or when rebuilding the terrain.
---

# Steps in the ground

IPR's terrain model has a point about every 10 m, and the game reads it on a 4 m
lattice, bilinearly: on its own a quay wall is a ramp, and where the wall runs across
the lattice at an angle the ramp has teeth. Since October 2026 the walls are steps.
The handbook's (`docs/handbook.md`) "Steps in the ground" has the outline; the top of
`pipeline/dtm_heights.py` has every rule and why. In short:

- **Heights** come from the technical map's surveyed lines (DTM ZPS, set 3) where a
  surveyed street surface is; water is flat at its level; the ground by a bank or a
  retaining wall is what the terrain model has clear of its ramp.
- **Labels**: each lattice point is plain ground (0), water (1) or a terrace of its
  tile (2 and up, the outline in the tile's `terraces`). Where the labels in a cell
  differ, the game reads a height from the corners with the point's own label
  (`heightSampler`), cuts every ground layer along the outlines (`cutAtSteps`) and puts
  a wall there (`stepWalls`). A terrace with `h` is flat at that height whatever the
  lattice says: the last metres of a street before its bridge (`structures.pads`).
- **Bridges** end on the street they come off (`abutment`), not on the quay below.

## The loop

A change to a rule shows only in the game, and only after a rebuild. Work in a
worktree with its own copies of the data (APFS clones: `public/data/praha_now`,
`ujezd_now`, `pipeline/.cache`), never on the main checkout's shared data.

1. **Try it on `ujezd`** (Malá Strana and both banks, Kampa, most Legií): 5 seconds.

       cd pipeline && uv run ipr_terrain.py ujezd

   The `survey:` line says how many points each rule touched; a count that jumps says
   more than the pictures will.
   **Or on a few tiles of `praha` anywhere** (`window.py`, 5–25 seconds): the build for
   5 × 5 tiles round a place, written as an `.npz` (`window_diff.py` tabulates it
   against the terrain model and the LiDAR, or diffs two) or as a map folder the offline
   checks read with `--data` and `--near <lat>,<lon>,120`. `--set NAME=value` changes a
   constant for one run, so a rule can be tuned over many places without a city build:

       uv run python ../.agents/skills/terrain-steps/window.py praha 50.05296 14.44106 --npz /tmp/a.npz
       uv run python ../.agents/skills/terrain-steps/window_diff.py table /tmp/a.npz <x> <y>

   To try a rule while a `praha` build runs, copy `pipeline/*.py` and its JSON files to a
   scratch folder with `.cache` and `.venv` linked in, and the two scripts beside it as
   `.agents/skills/terrain-steps/`: `window.py` finds the pipeline next to itself.

   **Drive it in the game** without a city build: the scene runner's `--map` takes the
   window's map folder, and its browser gets those files from there and the rest of the
   map from the dev server. A window and a scenario's drive take a couple of minutes:

       uv run python ../.agents/skills/terrain-steps/window.py praha 50.07395 14.28882 --survey-scan --data /tmp/w
       node scripts/scene.mjs run repy-bridge-ride --fresh --map /tmp/w

   (`--fresh`, or a `serve --map /tmp/w` of its own: a running server keeps the map it
   was started with.) Only the window's middle counts. The game draws the ground from
   the tiles' meshes (`*.tin.bin.gz`), and `window.py` doesn't make them: it keeps the
   city build's where the lattice is unchanged, so two windows can differ by the city
   builds they came after rather than by the rule (a "fix" for Řepy's south-west end in
   November 2026 was the mesh, and the rule made it worse). Build the middle tiles'
   meshes for each window, about 3 minutes:

       uv run tin_tiles.py praha --data /tmp/w --tiles 17_57,18_57,…,19_59 --work /tmp/w-tin

   or delete the window's `*.tin.bin.gz` to compare the lattices alone. `t.follow`'s `kink` is the
   drive's measure of a step or a dip. Don't put a copy of the map under `public/`:
   51,000 new files there stalled the shared dev server for many minutes.
2. **Then `praha`**: 17–35 minutes. Don't edit anything in `pipeline/` while it
   runs: the build checks its own code at the end and refuses its output if a file
   changed. Write the next change somewhere else meanwhile.
3. **Measure the bridges.** With the dev server and the scene server up (the
   scene-testing skill), after reloading the page:

       node .agents/skills/terrain-steps/bridges.mjs measure --save now.json --against before.json

   Per bridge: the worst kink, the steepest grade on the deck, and every join between
   deck and street with its step in metres. A join over 0.5 m is a step a car hits.
   A grade of 40 % and more on a deck means two pieces of one level lie over each
   other with different heights. `--full "most Legií"` prints the profile.
   Without the game (no browser, no waiting for the shared game lock), on the built
   tiles with the game's own samplers:

       node scripts/check-bridge-decks.mjs praha --save now.json --against before.json
       node scripts/check-bridge-decks.mjs praha --near 50.0672,14.4130,400 --profile 355002644

   It walks every street and path on a bridge a metre at a time on its own level (the
   map gives each edge its `level` since October 2026) and each named bridge's own way:
   the worst break along a deck, the worst join at an end, and a list of the worst
   places in the city. It fails when a named bridge is over `--max-break` or
   `--max-join` (1 m each): several still are, see `todo.md`.
4. **Look.** `bridges.mjs shots after`, then `pairs.py before after out/` and read the
   pictures. Numbers miss what's beside the bridge.
5. **Compare like with like.** "Before" is the same code with the terrain model alone:

       uv run ipr_terrain.py praha --no-survey     # then shots before, measure --save before.json

   Not another branch's dev server: its lighting and its bridge code differ, and half
   of what looked like new damage in October 2026 was shadows.

## Are the streets flat?

Without the game, on the built tiles with the game's own samplers:

    node scripts/check-road-flatness.mjs praha --save now.json --against before.json
    node scripts/check-road-flatness.mjs praha --near 50.0827,14.4342,300 --profile Wilsonova

It walks every car street a metre at a time, along its middle and both edges, on its
own level, and lists per street the worst step, bump (washboard), lean across, ridge or
trough, twist (the lean changing within 4 m) and stretch off the road (grass or a verge
over the carriageway), with a place to paste into the game. `--strict` fails on anything
over the hard limits.

Since November 2026 it also walks lines along each street a metre apart across it
(`--across 0` for the middle and edges only) and measures how wavy each line is: its
height against the straight line 2, 5 and 12 m either side. A street may climb and lean;
a line along it bends only gently. And it compares the map with IPR's 2023 LiDAR ground
on every line, every 2 m, for streets on the ground and not under a bridge
(`pipeline/scan_heights.py` looks the points up; `--scan <directory>` where the LiDAR
isn't in this checkout's `pipeline/.cache/ipr_lidar/2023`, `--scan off` to skip it). The
summary gives the share of line metres with a wave over the flag and the share of samples
within 0.3 m of the LiDAR, which don't depend on how streets are cut into edges.
`scripts/road-places.json` lists places players or checks found broken; the report always
gives the worst of each measure near each, against `--against`'s too. A few minutes for
praha, seconds with `--near`.

The two dips players found on 8 November (Na Veselí and náměstí Hrdinů, the survey's
kerbs of the underpass below pulling the street down) had steps of only 0.36 m: no single
metre jumps much. They are 2.9 m waves and 6 m off the LiDAR.

Steps, lean and crown count only where the samples lie on the carriageway as drawn: OSM's
width reaches past the kerb, onto the retaining wall beside the street (U Komína and
Ostřicová looked like walls across the road). Each street's worst step says what it is:
`wall` (between two terraces of the terrain: a retaining wall's strip or a bridge's
pad), `deck` (the edge of a bridge or tunnel level) or `ground` (the lattice itself), with
the two sample points and their labels in `--save`'s `stepPair`.

What it found first (27 October 2026, 57,188 streets): about 100 steps over 1 m, some 200
streets with 10 m or more off the road, and some 5,000 leaning over 15 %. The leaning is
real in the game, not the checker: the 4 m lattice tilts hillside streets (Italská's left
edge 0.5–1 m above its right). Compare runs before and after a rule change rather than
chasing the total. Levelling the car streets across (`_level_across` in
`dtm_heights.py`, 5 November 2026) took leaning over 15 % from 4,039 to 3,049 streets,
twisting over 12 % from 2,912 to 2,499, bumps over 0.5 m from 683 to 578 and ridges over
1 m from 216 to 167; the first version, without blending where streets meet and with the
kerbs of streets passing underneath, made 900 streets bumpier. Of the 15 worst steps, 9 were retaining walls' terraces running along
or across a street, 4 bridges' pads and 1 the made-up land beyond IPR's model; the
terrace now stops at a car street's kerbs (`dtm_heights.py`) and the made-up land is no
steeper than VALLEY anywhere, which took steps over 1 m from 71 to 38.

## Finding what's wrong at a place

- **What the lattice says**: `terrain_at.py praha <lat> <lon>` prints heights, labels
  and bridge levels round the place. A lone value metres off its neighbours with the
  same label is a spike; low points under a street are a street drawn past its wall.
- **Which layer it is**: hide them one at a time in the scene server and take the
  picture again. Walls are the ground meshes with `side === FrontSide`; their
  depth-only backs have `colorWrite === false` and `renderOrder === -3000`; bridge
  slabs cast shadows and have a render order between -700 and -500. In October 2026
  the mess at every bridge head was the ground itself, with walls and slabs off too.
- **Which rule did it**: the `survey:` counts, and `--no-survey`.

## What the places taught

- A bridge drawn from past its wall's edge: the street's last metres hang over the
  quay. Extending the deck back over them leaves a bare slab across the junction;
  lifting lattice points does nothing (the stretch is smaller than a cell). It's a
  flat terrace with its own outline.
- The map's water runs on under streets it doesn't call bridges (Štvanice). Streets
  on the ground are taken out of the water, and the tile lists its own water outline
  under label 1.
- A street surveyed in an underpass is under the ground (Hlávkův most on Štvanice).
  In a tunnel's strip a kerb more than 3 m under the highest kerb round it is the
  underpass's, the highest of those not up on something (`SUNK_ROUND`): beside a cycle
  path's tunnel under the railway, Čuprova's own kerbs were taken for the tunnel's, and
  the railway's deck filled the street, a ridge 18 m high.
- An embankment between two walls is narrower than the 10 m the rules look out to.
- Water lies level: a pool of wide water between weirs has one level (what all but its
  lowest tenth has; the lowest is the water running off at a weir's end or into a
  lock), narrow water comes down to the pool it runs into, and nothing passes a weir's
  line (`level_water`, `weir_points`). Letting any lower water pull a pool down drained
  every pool of the Vltava into the next. Past the edge of IPR's model the river has
  no terrain of its own: it carries on from the last known pool and the land rises from
  it as a valley's side. `node scripts/check-river.mjs praha --all` counts the steps in
  the water along the fairway (376 before, 10 at weirs after).
- A bank lower than the water must get no wall: the wall faces the land and shows
  from the river as a black hole (the walls' backs are in the depth buffer).
- A tunnel's portal takes the lowest ground round it, which mustn't be the water.
- The map cuts a bridge's ways into scraps a few metres long at its ends, and where a
  scrap meets the long way a path down to the quay often joins: that node counts as on
  the ground, 8 m down (Palackého most, Čechův most). A scrap running on from a much
  longer bridge way is level at the higher of its ends, has that way's height and
  level, and asks for no flat terrace of its own (`SCRAP` in `structures.py`).
- A man_made=bridge outline takes its height from the ways on it, those within 3 m of
  the one that covers most of it. Most by area (length × width), not length:
  Barrandovský most's outline (19,000 m²) took a cycleway that runs its whole length
  and down a ramp off it, and was drawn at the cycleway's height as a second slab 1–4 m
  under the main deck and wider than it (`pieces`, `test_bridge_outline.py`).
  "Within 3 m" is taken at the middle of each way's stretch on the outline, so on a
  long outline that climbs, the far end's carriageways were left out: Wilsonova's
  viaduct falls 10 m over its 710 m from Hlavní nádraží to Bulhar, its height came from
  the station end, both carriageways at Bulhar were 5–6 m off it and got their own
  level, and the outline became a slab 6 m over them with the trams laid on its top
  (players' reports, November 2026). A way off by more than 3 m now joins when every
  point of it within 15 m of a deck way already on the outline is within 3 m of that
  way's height there (`OUTLINE_ALONG`, `DECK_BESIDE`); the build prints each one as
  `outline along:`. A flyover crossing the outline is far off the deck where it passes
  over it and stays out.
- Where pieces of one level lie over each other, the higher one counts (`rasterise`).
- Two structures side by side, anywhere more than 3 m apart in height, can't share a
  level: a level's heights are on the lattice and reach 6 m past each piece, so the
  lower one pulls the deck's edge down (`BESIDE` in `assign_levels`).
- A short bridge way steeper than 15 % is a mistake in the map, not a ramp (a service
  way off Hlávkův most tied to the landing by the water): it's level (`STEEP`). Where
  IPR has a deck along most of it, IPR says which end is wrong instead (`ipr_ends`):
  each end on IPR's deck, and the street's last metres brought to it as a flat terrace,
  out to where the ground comes within 1 m of the deck. Barrandovský most's ramps: the
  slip road off Jižní spojka over Vrbova had its far end on the slope under the deck
  (−4.4 m join), and Strakonická's end sat on an abutment wall's top that the terrain
  model kept, 3 m over IPR's deck (a floating slab). The street has to reach IPR's
  height within 4 m of one end (a 4 m track bridge that IPR puts 1.5 m over both ends
  stays level), and no car street on the ground may cross the ground that comes up:
  Jižní spojka over Ryšavého is drawn too short, its ends on Ryšavého's carriageways
  under IPR's deck, and the terrace put 6 m walls across Ryšavého. Extending such a
  bridge out to IPR's deck's end would be the real fix there (not tried: the street
  running on would need to be on the bridge's level).
- A gentler short bridge can have an end on the wrong ground too. A trunk link at
  Zlíchov runs level on IPR's deck along the top of Dobříšská's cutting; the terrain
  model has no wall there, so both ends sat on the cutting's floor 6 m down. The
  abutment rule lifted the north end, and the deck ran down 14 % to the south one,
  under `STEEP`. Any short car-street bridge with an end `WRONG_GROUND` (2 m) or more
  off IPR's deck now goes onto it the same way, and an end already on the deck counts
  as the street reaching it. At 1 m it lifted one of Železničářů's twin carriageways
  away from the other (lean 30 → 59 %) and put a 3 m trough in the slip road under
  Jižní spojka's short bridges. At 2 m, city-wide against a build of the same code
  without it: 5 ways move, joins over 1 m 122 → 119, and the Pražský okruh slip road
  at 50.0948, 14.5943 loses a 1.9 m bump. The link's south terrace still ends 1 m
  above the map's slope on its east edge: the cutting needs its wall.
- Under a bridge the survey may hold two surfaces over each other (the junction on
  Palackého most's east end, and the quay path passing under it). Their average was a
  pit 3 m deep. Within 6 m of a bridge, where a lattice point's nearest surveyed points
  are more than 3 m apart in height, the upper ones count (`LEVELS`, `UNDER_BRIDGE`).
  Everywhere, it moved 78,000 points and added 20 steps.
- The rules below that use IPR's 2023 LiDAR run only with `ipr_terrain.py
  --survey-scan` (or `--ipr-lidar`; `window.py --survey-scan` the same). The public map
  is built without them (14 November 2026), and their figures come from builds with
  the scan. Copying the scan into `pipeline/.cache` changes no build by itself.
- Since November 2026 the LiDAR decides (`aloft`, `DECK_SIDE` in `dtm_heights.py`): a
  kerb more than 3 m over the highest the bare-earth scan has within 2 m is up on
  something. Inside one of the map's bridges it's the deck's and no lattice point takes
  it (the D0 under Na Radosti had a hump 8 m high); outside them it's the street's own
  where it carries on from the street's other kerbs at a street's grade (a viaduct the
  map calls ground) and a deck's where it doesn't (the railway over Čuprova, which the
  map doesn't draw). Within 6 m of where a bridge comes down to the ground it's the
  street's (`END_CLEAR`): OSM ends bridges a few metres short of their abutments, a
  bridge's end takes the ground's height at its last node, and without the deck's
  kerbs there Malovanka's slip road met its street 7 m up. Where a lattice point's
  nearest kerbs are on two levels, the scan picks the one it agrees with.
- Since 10 November 2026 a car street on the ground takes the LiDAR's road between its
  kerbs (`_scan_streets`, `--no-scan-streets` to compare): the scan's middle value
  across the carriageway every metre, smoothed along the street, level kerb to kerb,
  with a shoulder out to 4.5 m. The survey's kerbs alone made a street lean, twist and
  wave on the 4 m lattice, and at 5. května over Hvězdova the kerbs of the street in
  the cutting made a pit 4 m deep. Not under decks or in tunnels, and near them only on
  stretches that run on unbroken from clear ground, from one of the map's edges into
  the next where they meet end to end (judged an edge at a time, Divadelní's last 21 m
  before its underpass under Národní, an edge of its own within 6 m of the tunnel, kept
  the lattice's slope up to Národní, a wedge 3 m high across the road; scenario
  `divadelni-underpass-ride`). In the city: leaning over 15 %
  2,826 → 940 streets, bumps over 0.5 m 462 → 260, 99 % of carriageway within 0.3 m of
  the LiDAR (was 86.7 %).
- A path down a bank is narrower than the lattice, so only a point here and there took
  the survey's height and the slope came out in teeth. The ground within 14 m of a
  surveyed street now moves with it (`FEATHER`); `--no-feather` to compare.
- `bridges.mjs`'s first sample may be under a footbridge (Nuselský most at Pankrác: a
  "join" of 6 m, 44 m before the bridge, that isn't there). Look before believing.
- Where a bridge crosses a tunnel too close, the tunnel goes down. Lifting the bridge
  put a hump in the junction over the underpass at Hlávkův most.
- "Raise a mapped street to the surveyed one next to it" only over the map's water:
  on land the next street may be another street, a level up.
- Stairs on a bridge (Železniční most at Výtoň, folded back beside the deck they come
  down from) are steeper and narrower than the lattice can hold: in the deck's level
  they pulled its last points 1.8 m down, and on a level of their own (tried 6 October
  2026) two flights 4 m apart mixed with each other. Since 7 October they carry their
  own profile: `structures.stairs` picks them (tagged `steps`, as steep from end to end
  whatever the map calls them, and the landings between flights), `ramps` gives each a
  line with heights (`ramps` on the tile's level), and they stay out of the lattice. The
  game reads a level through `withRamps` (`src/terrain.ts`). They share a level only
  with what is within 1 m of their height (`STAIRS_SAME`).
- Between a deck and the ground it's the stairs that take up the height. The solve runs
  a second time with the stairs known: their links count for a twentieth (`SOFT`), in
  the harmonic solve and in the smoothing, which used to average a deck's last node
  with the flight below it. IPR's faces aren't looked up along stairs.
- A bridge over open water with no deck in IPR's model (Dvorecký most, the footway
  under Barrandovský most) ran evenly between two low banks, 3 m over the river. It now
  clears the water by `WATER_CLEAR` away from its ends (rising at 8 % along streets,
  50 % along stairs), an IPR face lower than that over open water is a pier and not a
  deck, and a way's end out on the water is not an end on the ground.
- A bridge outline with no street on it (a railway bridge) took its height from the
  streets near its ends, which pass under it. Where IPR has a face over most of the
  outline, it's IPR's top.
- A rampart has a wall on each face, and a battered wall is surveyed along its crown
  and along its foot: the ground at the foot of one line is on the high side of the
  other. What one wall has put at its foot no other wall lifts (`lowered` in
  `dtm_heights.apply`); before, 400 terrace points stood at the height of the wall's
  top, most of them round Vyšehrad.
- A level's lattice can't hold two things 4 m apart at different heights. When a deck
  sags or jumps near its end, compare the solved profile with the lattice before
  blaming the solver: at Výtoň the profile was right.
- The survey has kerbs whose vertices jump between two levels a metre apart (náměstí
  Míru: every few vertices 21 m under the square, maybe the metro's vestibule). That's
  inside `SURVEY_OFFSET`, and it sank the square into a pit players drove into. A vertex
  more than `SUNK` (15 m) below all the terrain within 16 m is now rejected too. At 8 m
  it also dropped real kerbs at the foot of Radotín's quarry and lifted the street.
  The stairs down to that floor got through (their vertices 7–17 m down) and sank the end
  of Ibsenova 12 m (November 2026): a vertex within 8 m of a sunk one and over 3 m under
  the ground goes too (`SUNK_STAIRS`).
- With `--survey-scan`, smaller sunk vertices are caught by IPR's 2023 LiDAR raster
  (`ipr_lidar.py` imports it), even when it isn't the ground: a vertex more than `OFF_SCAN` (1 m)
  below every height the scan has within 2 m of it is moved up to the lowest of them
  (`survey:` counts them as `off_scan`; leave `--survey-scan` out to compare). The range, not
  the scan's height at the vertex, so a kerb at a wall's foot stays. Found at Svornosti
  by Palackého most: a kerb drawn as one straight 89 m line with its corner 2.2 m under
  the junction sank the crossing into a pit 2 m deep. Dropping such vertices instead
  didn't help: a street surface takes its height from the points along its own edge,
  and without the corner it took the kerbs' low ends further along. The same mixing
  upwards (kerbs on an elevated road surveyed as ground, Vysočany, Jižní spojka) is
  still let through: brought down to the ground, the ramps up to Hlávkův most broke
  their join with it by 4 m and links got steps. Nor within 6 m of a mapped bridge or
  in a tunnel: the scan has a bridge's abutment over the quay road under it (Hořejší
  nábřeží under Palackého most, moved 3 m up and leaning 67 %).
- Low, short retaining walls (under 1.5 m, under 12 m) make more ragged ends than
  steps.
- A retaining wall's terrace is cut out of every car street it reaches: its far edge,
  8 m from the wall, used to lie along the middle of the street at the wall's foot (Pod
  Plynojemem, 12 m), and a wall line the map and the survey place a metre or two apart
  ran down the carriageway. Taking the street into the terrace instead put the terrace's
  end across it (Řevnická, U Trezorky: 5 m); dropping the wall's line where it lies on a
  street took its heights too (the embankments by the river came out stepped). It left
  Hořejší nábřeží, which runs along the foot of the wall down to the quay, leaning 46 %.
  Keeping the terrace for a street at the wall's foot fixed Hořejší but brought back Na
  Botiči (10.8 m) and Řevnická: dropped.
- Beyond IPR's model each point of the made-up land beside water rose from its nearest
  water, and where the nearest changed from the brook in the valley to a pond on the
  plateau the land jumped 56 m (V Údolí, Suchdol). It's now lowered to no steeper than
  VALLEY from any neighbour (`--valley-nearest` for the old way).
- A bridge's pad that doesn't meet the street past it is a wall across that street
  (Ohrobecké údolí, Železničářů: 4–7 m). Leaving such pads out broke the joins of
  Palackého most (8.9 m) and Lahovický most: not done. Leaving out only a pad that a
  car street crosses fixed Ohrobecké údolí (`solve`, 9 November 2026). A wall across
  every bridge's end over a lower street, tried the same day for 5. května over
  Hvězdova, broke 24 bridge joins and didn't help there: the slope runs beside the
  deck along the lower street, not across the bridge's end. A wall along each side of
  a car street in a cutting under a bridge (`_cuttings`, `CUT_RISE`) does it, where the
  terrain model's slope beside the street is steep enough; it stops where another
  street's middle crosses it, not where any lane touches it (a street's ways are cut at
  every junction, and its own next way touched every wall).
- The terrain model carries some overpasses as ground, and `pull_to_bridges` brings
  ground within 1.5 m of a deck onto it. Under the D0 over its slip road at Řepy the
  ground beside the slip road lay at the deck's height: the tops of the walls along the
  slip road showed through the deck in the slip road's curve. Where the LiDAR's bare
  ground under a bridge is more than `DECK_DEPTH` (1 m) below the deck, the ground now
  goes down to the LiDAR (`under_decks` in `ipr_terrain.py`, with `--survey-scan`
  only): plain ground and walls' tops, not pads. Not where a street on the ground comes
  onto the bridge over open space either (`deck_ends`): OSM ends bridges short of their
  abutments, the street runs on under the deck's outline at the deck's height, and the
  LiDAR has the space under the last span there. Without that, 98 bridge ends got joins
  1–7 m deep (Karlův most over Kampa, Hlávkův most on Štvanice). The kept strip runs
  3 m back over the bridge (the lattice point the street's height comes from may be
  under the deck), and only where the street's end is more than 1 m over the LiDAR.
  Every end, over open space or not, also keeps the lattice cell it lies in (17 ends on
  firm ground had joins 1–2 m deep without it, Barrandovský most's among them), except
  beside a wall. At Řepy, where OSM's motorway bridge is no longer than the slip road
  under it is wide, both a disc of 6 m round each end and the cell alone stood the slip
  road's walls up to the deck again, as half circles through it: a wall's top comes from
  the ground beside it. Measure the joins (`check-bridge-decks.mjs --against`) and look
  at Řepy (50.07395, 14.28882, from the west) after any change to it.
- A pad reaches out to where the ground comes within `STEP` (1 m) of the street, not
  only past the steepest rise (`abutment`). The D0's north-east end at Řepy comes off
  its bridge 6 m over a slope that reaches it 9 m on; the steepest 2 m were the first,
  the pad stopped there, and the carriageway dipped 3 m into the slope just past the
  deck. Screenshots hid it; driving over the bridge showed it at once: the scenario
  `repy-bridge-ride` follows each carriageway at 80 km/h and checks `kink`, the
  sharpest change of grade under the car.
- A dual carriageway's two bridges each get their own pad at an end, and the ground
  between the pads kept its own height: in front of the D0's twin decks at Řepy it lay
  4 m under them, a pit with the pads' walls round it. Pads within `TWIN_GAP` (8 m) of
  each other, within `TWIN_LEVEL` (0.25 m) in height and running alongside are now one
  terrace at their mean height over the convex hull of the pads (`twin_pads` in
  `structures.py`): under the decks no more than `TWIN_UNDER` (2 m) past the shortest
  lip, not on streets passing under nor on each pad's own carriageway beyond its outer
  end, and only where the ground between them lies `TWIN_PIT` (1 m) or more under them
  somewhere. `window.py --set TWIN_GAP=-1` builds without it. What the other versions
  did (Jižní spojka at 50.0377, 14.4581, Patočkova at 50.0876, 14.3806, Palackého most):
  - the hull reaching as far as the longest lip stood 5 m over the valley under Jižní
    spojka's decks, which begin along a skewed abutment; without the lips at all, a
    point under the deck's edge at Řepy stayed down and broke the wall round it into
    see-through shards;
  - past the shorter pad the join lay on that carriageway, a 0.35 m step across it;
    cutting every carriageway out of the join instead left slivers and holes in the
    terrace's outline (a 0.96 m bump);
  - at 0.5 m the mean took a slip road at Patočkova 0.24 m off its deck; each pad
    keeping its own height, with the half of the ground nearer to it, left a seam of low
    walls down the median at Řepy, see-through in places;
  - joining where there was no pit only moved small pads a few centimetres, and
    Hořejší nábřeží at Palackého most leant 12 → 15 %.
- A street crossing over a tunnel isn't in it: Modřanská's points over a footway's
  tunnel at Zlíchov took the footway's floor (`_crossing` in `dtm_heights.py`). Rašínovo nábřeží by Palackého
  most and Komořanská by most Závodu míru were the two-level survey under a bridge (see
  above): fixed since, most Závodu míru's join down from 3.7 m to 0.9 m.

- A tunnel runs from portal to portal: its heights come from the bridges' solve
  whenever every end is known (`TUNNELS_HARMONIC`). With the old spreading each point
  took its two nearest pins, which past the cover rule's pins lay by one portal, so
  each half of the Strahov tunnel ran level from its own portal and the halves met in
  a ramp of 103 % under Strahov; players got stuck there (November 2026). A portal
  outside the map still selects the old spreading (Mrázovka in centrum). The deck
  check lists every car tunnel's steepest climb over 10 m: more than a street's
  15 % is two rules meeting, not the tunnel. A window round one end of a long tunnel
  has the other portal outside it and so shows no change: build the window round the
  tunnel's middle, or check the city.
- What stops a car on a street needn't be a step: a building under a street mapped a
  layer up (not a bridge) was solid across the lanes, the main station's hall under
  Wilsonova (`on_roof` in `osm_area.py`). `cellAt` in the game shows it as 255 under
  the carriageway on level 0.

- An underpass in a cutting whose street on top is wider than its car lanes can't be
  turned round (`structures.cuttings`): only the lanes become bridges. Národní over
  Divadelní (the dense terrain model shows the cutting since 16 November 2026) got two
  decks 3 m wide, one for each lane and askew as OSM draws them, the ground under them
  dug down to the LiDAR in pits, and the tram tracks and pavements between them left on
  ground at the street's height. An underpass that tram tracks cross stays a tunnel
  (the build prints `under tram tracks:`); in November 2026 it was the only cutting in
  the city with tracks within 30 m. `window.py` leaves the streets' levels in the tiles
  as the city build wrote them, so after such a change the window's tiles still say
  "Národní on a bridge here" and paint the underpass's road on the ground: set `level`
  and `levels` by hand (as `layers.assemble` would) before believing the pictures.
  The survey has such an underpass's own floor as the ground (level 0) and the street
  over it on level 1, so the ground layer painted the underpass's carriageway and
  pavements on top of Národní. `pipeline/survey_skip.json` re-files those four polygons
  (`as`) as what the survey's level 1 has there. Not a rule: over an underpass turned
  into a cutting the level 1 surfaces belong on the bridges, not on the ground.

Tried and dropped: a terrace for every surveyed street well above or below the ground
beside it (cliffs 12 m high under Letná); leaving the terrain model wherever the
survey is far off it with no step near (breaks in the street where the two meet).

## Which deck a street or a tram is on

Where two bridges cross, the outlines alone don't say which deck a street's paint or a
tram's tracks belong to. `structures.build` hands each way's level to the terrain layer
(`ways`), and `layers.assemble` writes it out (`structures.OnLevels`): `level` on every
drive and walk edge on a bridge or in a tunnel, and `deckRails` in a tile with
structures, the stretches of tram track on a bridge with their level (over two decks at
once, the one whose way the track runs along). The game paints and lays tracks by them
(`groundLayers`), hangs the wires over the same deck and starts whatever is put on a
street on that street's level. A map without the fields gets the old guesses.

## Check which game you're photographing

`look.sh` and the scene server take the game from port 5191 unless `GAME_URL` says
otherwise. With several worktrees, 5191 may be another checkout's dev server with another
map: on 2 October 2026 a whole round of before/after pictures (DMR 5G, the shoulder, the
first street cut) came out identical to the pixel because they were all of main's map.
Start this checkout's server on its own port (`PORT=5192 npm run dev`), check that
`curl $GAME_URL/data/praha_now/index.json` shows this checkout's `built`, and distrust a
"before" and "after" that don't differ at all.

The free camera's `height` is above the terrain at its target (`main.ts`), so a
height correction there moves the eye and look-at point even with identical
options. Use an unaffected nearby target for a fixed-pose comparison, and save
the actual eye position and orientation alongside the map marker. The bridge
helper's `h + 55` is a relative camera setting, not an absolute eye elevation.
See `docs/river-terrain-findings.md` for a verified fixed-pose example.

## Trials, off by default

- `--cut-streets`: a wide surveyed street under or over a steep bank with no surveyed
  wall becomes a terrace, cut along its outline, the bank a wall on it. Clean edge under
  Letná, but walls appear at street ends and junctions and where the bank is really a
  slope. Not good enough to turn on.
- `--shoulder`: the ground within 5 m of a surveyed street level with it. Not looked at
  against the right game yet.
- `--dmr5g`: ČÚZK's DMR 5G on Letná instead of IPR's model. Agrees with IPR to 0.4 m on
  average; in the game the hillside looks the same and the street's edge by the tunnel
  about as ragged.

## When a rule can't get a place right

`pipeline/terrain_keep.json`: a box in degrees (west, south, east, north) and why. The
place stays as the terrain model has it. Use it for a place that's worse with the
survey than without, after looking at both; don't bend a rule for one place. A box
that takes in a bridge's end changes where that bridge lands: measure it again.

`pipeline/terrain_walls.json`: a wall the survey has no wall for (a line in degrees, lon
and lat, and why), where the ground beside it is a slope in the game instead of a step.
The terrace goes on its top, so it works over a street in a cutting (Divadelní by the
National Theatre, the plaza 3 m above). Draw the line along the surveyed edge at the
top's height: cross-sections through the survey's lines show where it is (the first
guess there, the plaza's paving 3 m further in, moved the slope instead of removing it).
Its foot takes the lowest ground within `REACH` (10 m), so don't run it up to a tunnel's
portal, where the floor dips (the portal's wall at Divadelní put a 1 m bump in the
street and was dropped).

## Edges that stop you

`src/stepEdges.ts` makes the tops of the steps solid (0.8 m and more) and puts a
parapet on them, from the same outlines, sides and heights as the drawn walls. It is
open where a way on the ground crosses. Without a browser:

    node scripts/check-step-edges.mjs praha

Its list of car streets over the highest drops is a list of places to look at: a street
doesn't cross a drop of 7 m on the ground. The scenario `step-edges` drives at a quay
wall, walks at a retaining wall, and uses stairs and a street across a step.

## What's still wrong

`todo.md`, "Steps in the ground: what's left". The lattice is 4 m: a slope with no
surveyed wall (a path down a bank, the hillside under Letná) keeps its teeth, and no
rule here will fix that.

## The files here

- `bridges.json`: the bridges over the Vltava and the Berounka and Nuselský most, with
  their ends. `list_bridges.py` writes it from praha's layers.
- `bridges.mjs`: `measure` and `shots`, through the scene server.
- `terrain_at.py`: the lattice round a place.
- `window.py`, `window_diff.py`: the terrain build for a few tiles, and its tables and
  diffs against the LiDAR (see "The loop").
- `scripts/check-bridge-decks.mjs` (in the repo's scripts): the decks checked offline.
- `pairs.py`: two runs' screenshots side by side.
