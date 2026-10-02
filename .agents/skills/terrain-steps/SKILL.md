---
name: terrain-steps
description: How Streets of Prague's terrain gets its quay walls, retaining walls and bridge heads (the steps in the ground, from the technical map's survey), and how to find and fix a place where the ground looks broken. Use when the ground is ragged, pitted or spiked somewhere, when a bridge dips, kinks or doesn't meet its street, when water climbs a bank or a wall has a hole in it, when working on pipeline/dtm_heights.py, pipeline/structures.py, pipeline/ipr_terrain.py, pipeline/terrain_keep.json, the labels in src/terrain.ts or the cutting and walls in src/ground.ts, or when rebuilding the terrain.
---

# Steps in the ground

IPR's terrain model has a point about every 10 m, and the game reads it on a 4 m
lattice, bilinearly: on its own a quay wall is a ramp, and where the wall runs across
the lattice at an angle the ramp has teeth. Since October 2026 the walls are steps.
The README's "Steps in the ground" has the outline; the top of
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
4. **Look.** `bridges.mjs shots after`, then `pairs.py before after out/` and read the
   pictures. Numbers miss what's beside the bridge.
5. **Compare like with like.** "Before" is the same code with the terrain model alone:

       uv run ipr_terrain.py praha --no-survey     # then shots before, measure --save before.json

   Not another branch's dev server: its lighting and its bridge code differ, and half
   of what looked like new damage in October 2026 was shadows.

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
- A bank lower than the water must get no wall: the wall faces the land and shows
  from the river as a black hole (the walls' backs are in the depth buffer).
- A tunnel's portal takes the lowest ground round it, which mustn't be the water.
- The map cuts a bridge's ways into scraps a few metres long at its ends, and where a
  scrap meets the long way a path down to the quay often joins: that node counts as on
  the ground, 8 m down (Palackého most, Čechův most). A scrap running on from a much
  longer bridge way is level at the higher of its ends, has that way's height and
  level, and asks for no flat terrace of its own (`SCRAP` in `structures.py`).
- Where pieces of one level lie over each other, the higher one counts (`rasterise`).
- Where a bridge crosses a tunnel too close, the tunnel goes down. Lifting the bridge
  put a hump in the junction over the underpass at Hlávkův most.
- "Raise a mapped street to the surveyed one next to it" only over the map's water:
  on land the next street may be another street, a level up.
- Low, short retaining walls (under 1.5 m, under 12 m) make more ragged ends than
  steps.

Tried and dropped: a terrace for every surveyed street well above or below the ground
beside it (cliffs 12 m high under Letná); leaving the terrain model wherever the
survey is far off it with no step near (breaks in the street where the two meet).

## When a rule can't get a place right

`pipeline/terrain_keep.json`: a box in degrees (west, south, east, north) and why. The
place stays as the terrain model has it. Use it for a place that's worse with the
survey than without, after looking at both; don't bend a rule for one place. A box
that takes in a bridge's end changes where that bridge lands: measure it again.

## What's still wrong

`todo.md`, "Steps in the ground: what's left". The lattice is 4 m: a slope with no
surveyed wall (a path down a bank, the hillside under Letná) keeps its teeth, and no
rule here will fix that.

## The files here

- `bridges.json`: the bridges over the Vltava and the Berounka and Nuselský most, with
  their ends. `list_bridges.py` writes it from praha's layers.
- `bridges.mjs`: `measure` and `shots`, through the scene server.
- `terrain_at.py`: the lattice round a place.
- `pairs.py`: two runs' screenshots side by side.
