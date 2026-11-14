---
read_when:
  - Planning work on the terrain's shape (the 4 m height lattice, a triangulated ground)
  - Working on the first-person view's ground, kerbs, or the ground at walls and building bases
  - Changing heightSampler in src/terrain.ts, the draping in src/ground.ts, or the terrain files the pipeline writes
---

# A triangulated ground: plan

Written 14 November 2026, before any prototype. The terrain's shape is a 4 m height
lattice today. This plan sets out how to replace it with a triangulated ground (a TIN:
triangles of any size, with edges laid along kerbs, walls, banks and bridge ends), in
stages that can each stop without harm to the map, and what to measure at each.

It sits next to [road-plan.md](road-plan.md): the road plan and the LiDAR trial decide
where the heights come from, and this plan decides the shape that carries them. Its
step 6 (roads as their own triangulated surface) becomes stage 4 here.

## Why

From above, the lattice is mostly good enough: height only comes through in the hill
shading and the length of shadows. First person (`?fps`, the panel's First person box)
is still an experiment, mostly because of the ground at eye height:

- **Creases and waves.** Each layer is draped in triangles of up to 8 m over heights
  that are bilinear in each 4 m cell, so slopes show creases and flat streets roll
  gently. Detail finer than 4 m isn't in the map at all.
- **No kerbs.** A kerb is a granite strip painted on ground of one height: the pavement
  isn't raised. The survey has the kerb lines (DTM ZPS, set 3).
- **Walls between lattice points.** A quay or retaining wall is an outline between
  lattice points of two labels. The step lines trial (`--step-lines`) gives each side a
  smooth height along it, but the ground next to the wall is still the lattice's.
- **Places the lattice can't hold.** An underpass ramp narrower than a cell (Dobříšská
  in the LiDAR trial) needs an edge where the ground breaks, not finer heights.

Stage 0 checks this list with first-person screenshots before any code changes.

## What a TIN changes and what it doesn't

A TIN puts points where the ground needs them: dense along a kerb or a sloping street,
sparse in a flat field. Its edges can follow a breakline exactly, with a different
height on each side, so a kerb or a wall is a real step in the surface. Everything that
reads heights through `heightSampler` can read it instead.

It doesn't decide heights. Wrong heights stay wrong in any shape: the rules in
`pipeline/dtm_heights.py`, the survey and (when asked for) the LiDAR still supply them.
It doesn't handle two levels in one place either. A TIN is one surface; bridges and
tunnels stay structures with their own levels (`pipeline/structures.py`). The trial's
failures under bridges were about which surface is the ground, not its shape.

## Where things stand

- **The lattice.** 63×63 points per 250 m tile (uint16 decimetres above 100 m and a label
  byte: 0 plain, 1 water, 2 and up terraces, flat terraces with a height for bridge-end
  pads), `<tile>.height.bin.gz`, 61 MB for `praha`'s 14,595 tiles. The whole map is
  980 MB.
- **One way in.** The game reads heights through `heightSampler` (`src/terrain.ts`):
  bilinear per cell, with labels, terraces, step lines and the side of a step. The worker
  drapes the ground with it (`groundAt` in `src/tileWorker.ts`, through `withRamps`,
  `withRoadProfile` and `withRoadSurfaces`). The main thread uses it through
  `terrainAt`, `heightAt` and `surfaceAt` in `src/tiles.ts` for cars, walkers, boats,
  lamps, signals and the mist. The sky view and the node checks
  (`check-road-flatness.mjs` among them) call it directly.
- **The ground mesh is already triangles.** Each layer (grass, carriageway, pavement…)
  is OSM polygons triangulated, subdivided to edges of at most 8 m (2 m in the road
  corridors), cut along the steps (`cutAtSteps`, with walls from `stepWalls`) and
  draped (`finish` in `src/ground.ts`). Layers overlap and write no depth; in first
  person the plain ground goes into the depth first, 0.3 m low (`GROUND_DEPTH`).
- **Shading.** Each tile's hill-shade texture comes from the lattice's slopes
  (`src/tiles.ts`).
- **Bridges and tunnels.** Separate lattices per level (`.levels.bin.gz`, 8.2 MB),
  masks, and the ramps.

## What to aim for

- In first person, kerbs, walls, banks and slopes look like the real street, and the
  ground meets walls and bridge ends without gaps or stairs.
- Cars, walkers and the checks ride the surface that's drawn, within a few centimetres.
- From above, nothing gets worse.
- Tile seams match exactly.
- The map grows by less than a fifth, with no frame-time cost worth noting on the
  Pixel 5 and no new stutter when tiles load.
- Off by default until the user says otherwise. The public map keeps the lattice until
  then.

## The format

One file per tile, `<tile>.tin.bin.gz`, next to the height file while both exist.

- **Vertices:** x and y as uint16 across the tile (4 mm), heights as uint16 centimetres
  above the tile's lowest point.
- **Triangles:** vertex indices (uint16 while a tile has fewer than 65,536 vertices),
  stored as differences so gzip packs them.
- **Sides:** a label per triangle, the same labels as today's. At a step (a wall, a
  kerb, a quay) the vertices along it are doubled, one copy for each side's height,
  and the triangles on each side use their own copy.
- **Breaklines:** each step as a list of vertex pairs with its kind (wall, kerb, bank,
  bridge end, found in the scan), so the game knows what to draw along it.
- **Seams:** the vertices on each tile edge are chosen once per edge (at a fixed
  spacing, plus where a breakline crosses), so both neighbours have the same ones.
  The pipeline checks this.

The size isn't known. A rough guess: 100–200 MB for `praha` at a few centimetres'
tolerance in the streets, which is why the tolerance depends on the place (tighter on
carriageways and pavements, looser in woods and fields) and why size is the first
thing stage 1 measures. If it's too large, meshoptimizer's codecs (MIT; three.js ships
a decoder for them) are the next thing to try.

## In the pipeline

A new module, `pipeline/tin.py`, runs after the lattice and the step lines in
`ipr_terrain.py`, behind a `--tin` switch (off unless asked), and writes the tile files.

- **Triangulation.** shapely 2.1 (installed) has a constrained Delaunay, but only for
  polygons: it can't add points inside them. Start with a conforming Delaunay on
  `scipy.spatial.Delaunay` (installed): breaklines sampled densely, everything
  triangulated, and any breakline segment that's missing split and triangulated again
  until all are edges. No new dependency. Triangle (Shewchuk), the usual tool, forbids
  commercial use without a licence, so it's out. If this is too slow or fragile, look
  for a constrained Delaunay library and give it the dependency health check.
- **Points.** Greedy insertion against a target surface: the point that's furthest off
  goes in first, until the whole tile is within its tolerance.
- **The target surface.** Stages 1 and 2: today's heights (the lattice with its rules
  and step lines). Stage 3: the LiDAR where the trial shows it's right.
- **Rules stay.** `dtm_heights.py` keeps deciding heights on the lattice in stages 1–3.
  No rule is rewritten for the TIN until it's the default.

## In the game

- **A sampler with the same signature.** `tinSampler` answers `(x, y, side)` from the
  triangle the point lies in, using a bucket grid per tile (a few metres a bucket)
  built in the worker and sent with the tile. Everything behind `heightSampler`
  switches with one URL option, `?tin`, like the other trials.
- **Draping by error.** The layers keep their polygons. `subdivide` already takes a test
  for which edges to split (`refineRoad` uses it). A new test splits an edge where the
  TIN's height at its middle is more than a few centimetres off the straight line, down
  to about a metre. Breaklines cut the layers the way `cutTerrainSteps` cuts them at
  terraces today, and their walls come from the breaklines. Kerbs get a face of their
  own, so the pavement stands up.
- **Depth in first person.** The plain ground's depth pass can draw the TIN itself, so
  what hides things behind a crest is the ground that's drawn.
- **Shading** from the TIN's normals, or from the lattice during the trial.
- **Levels unchanged.** Bridge-end pads become fixed-height areas in the TIN, and decks
  and tunnels keep their own lattices.

If draping by error leaves visible gaps, stage 1 tries the fallback: inserting the
TIN's vertices into each layer.

## The stages

Each stage is built in a worktree with cloned data. Each starts with one area,
`ujezd` (a slope, retaining walls, the quay, a bridge end, kerbed streets), then the
15 places of the LiDAR trial. Only then is it built for `praha`.

### 0. A first-person baseline

No code. Scripted shots (`scripts/scene.mjs` with `t.eyes`) at a dozen fixed spots: a
sloping street, a retaining wall on a slope, the quay, a kerbed main street, a park
path, a bridge end, building bases on a slope, Dobříšská's underpass. Each spot gets a
top-down shot too. Also kept: `check-road-flatness.mjs` and `check-step-edges.mjs` on
the area, ground triangle counts and the worker's build time per tile, and a
first-person frame time on the Pixel 5.

Done when the "Why" list above is confirmed or corrected with pictures.

### 1. Today's ground as a TIN

No new data: the TIN is built to stay within 2 cm of today's `heightSampler`
everywhere, steps included. This proves the format, the seams, the sampler's speed and
the draping without any argument about heights.

Measure the file size per kind of tile, extrapolated to `praha`, and the worker's build
time and triangle counts. Measure the main thread's height lookups too (cars, walkers)
and the frame time. A check compares the TIN with the lattice at random points and
along every street.

Done when `?tin` looks the same as today from above and in first person, the checks
match, and the numbers are in. Stop if the size or the cost is already over the limits.

### 2. Kerbs and walls from the survey

Breaklines from the DTM ZPS: kerb lines, walls, steps, the edges of carriageways and
pavements. Each side's height comes from the survey's heights where it has them. Where
it doesn't, the kerb is left out rather than given a made-up height (or, if the user
prefers, a standard height marked as guessed). Physics reads the kerbs too; see
"Room to decide".

Done when the first-person pairs show raised pavements and clean walls, the road checks
are no worse, and the size is still within the limit.

### 3. Detail from the LiDAR

Only with the LiDAR switched on (`--ipr-lidar`, `--survey-scan`), and only where the
trial shows the scan is right (car streets yes; under and beside decks no). The scan's
noise is filtered first. Points go in where the scan differs from the target by more
than the place's tolerance. Edges the scan shows and the survey lacks (a ramp's wall at
Dobříšská) are written to a list for review, not trusted on their own.

Done when the 15 places and `praha` compare favourably with stage 2 on the checks and in
first person.

### 4. The default, and what it replaces

Making the TIN the map's default, and retiring what it replaces, are the user's calls.
The candidates: the road overlays (`?roadfit`, `?roadsurfaces`, the corridors), the
step lines, and possibly the lattice itself (kept as a coarse derived file if the sky
view or the boats still want it). The handbook, `rebuilding-the-map.md` and the
terrain-steps skill change with it.

## How to work

- Small areas first; never build `praha` before the area's numbers are in.
- A/B pairs from the same commit, `?tin` against today, in first person and from above.
- No pipeline edits in a worktree while a build of it runs.
- Ask first, as the road plan says, before deploying, changing the shared map's
  defaults, letting the map grow by more than about a fifth, accepting a frame-time
  cost, or removing an overlay, a flag or a rule.

## Room to decide

- **Cars at kerbs.** With kerbs in physics, a car mounting a pavement gets a jolt of
  about 12 cm.
  That's realistic and tells the player they've left the road. The other choice is cars
  reading a surface with the kerbs smoothed out. Recommended: both cars and walkers ride
  the TIN as drawn.
- **Without the LiDAR.** Stages 1 and 2 don't need it. If the trial doesn't adopt the
  scan, they still bring the kerbs and walls.
- **The lattice afterwards.** Keep it as a small derived file, or drop it once nothing
  reads it.
- **Missing kerb heights.** Leave such kerbs out, or give them a standard height marked
  as guessed.

## Progress

- 14 November 2026: plan written. Not started.
