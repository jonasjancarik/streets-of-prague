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
2. **Then `praha`**: about 16 minutes. Don't edit anything in `pipeline/` while it
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
over the carriageway), with a place to paste into the game. Two minutes for praha,
seconds with `--near`. `--strict` fails on anything over the hard limits.

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
chasing the total. Of the 15 worst steps, 9 were retaining walls' terraces running along
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
- Under a bridge the survey may hold two surfaces over each other (the junction on
  Palackého most's east end, and the quay path passing under it). Their average was a
  pit 3 m deep. Within 6 m of a bridge, where a lattice point's nearest surveyed points
  are more than 3 m apart in height, the upper ones count (`LEVELS`, `UNDER_BRIDGE`).
  Everywhere, it moved 78,000 points and added 20 steps.
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
  The same mixing upwards (kerbs on an elevated road surveyed as ground, Vysočany) is
  still let through.
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
  Palackého most (8.9 m) and Lahovický most: not done. Rašínovo nábřeží by Palackého
  most and Komořanská by most Závodu míru were the two-level survey under a bridge (see
  above): fixed since, most Závodu míru's join down from 3.7 m to 0.9 m.

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
- `scripts/check-bridge-decks.mjs` (in the repo's scripts): the decks checked offline.
- `pairs.py`: two runs' screenshots side by side.
