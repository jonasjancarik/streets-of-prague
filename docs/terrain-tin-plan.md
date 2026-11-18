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
  isn't raised. The survey has the kerb lines (DTM ZPS, set 3), but not how high they
  are (see stage 2).
- **Walls between lattice points.** A quay or retaining wall is an outline between
  lattice points of two labels. The step lines trial (`--step-lines`) gives each side a
  smooth height along it, but the ground next to the wall is still the lattice's.
- **Places the lattice can't hold.** An underpass ramp narrower than a cell (Dobříšská
  in the LiDAR trial) needs an edge where the ground breaks, not finer heights.

Stage 0 checked this list with first-person shots at 13 spots (14 November 2026). The
walls are worse than the list said, and the kerbs are as it says:

- At a retaining wall on a slope (Chotkova, Thunovská) there is no wall to see. The
  ground climbs it as a crumpled sheet, torn into slabs with dark gaps between them,
  and in Thunovská the slabs hang over the street. This is the worst of first person.
  From above, the same places look fine.
- Kerbs are flat granite strips everywhere (Platnéřská, Újezd, Smetanovo nábřeží,
  Nerudova).
- On the streets, the creases are mild. In `ujezd`, 0.3 % of the metres along the
  streets have a 2 m wave over 10 cm. Nerudova reads smooth at eye height, and the
  cobbles of steep Thunovská show the creases.
- Underpasses: at Dobříšská, the ramp's walls stand clean and upright, but a patch of
  the road beside them has a ragged edge. At Na Veselí a low wall runs across the
  carriageway, with road markings on both sides of it.

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
pavements. Walls take each side's height from today's ground, as the step lines do.
Cars and walkers feel the kerbs (decided 14 November).

The survey says where a kerb is, not how high: each kerb line has one height per
vertex, mostly the road's. In Praha 1 it lies a median 1 cm above the road as the LiDAR
has it, and it hardly ever comes paired with a second line for the kerb's top. The
LiDAR does show the step. Across 5,471 runs of 10 m in Praha 1 with a clean cross
section (`docs/evidence/kerbs/`, local), half the kerbs are 9 cm or more, and about one
in six reads as flush (under 3 cm), most of them in pedestrian streets (Železná, Ovocný
trh). The scan can't be trusted when it says a kerb is flush, though. In Platnéřská and
Betlémská it reads 0 cm, with the pavement rising a few per cent towards the houses,
but on Street View both kerbs are raised by about 10 cm (the user's look, 14 November).
Why the scan loses them isn't known: parked cars filled in, narrow pavements, or the
scan's own smoothing.

The rule, then (proposed):

- A kerb between a carriageway and a pavement is raised. It takes the scan's step where
  the scan shows a clean one of 10 cm or more, and otherwise 10 cm, marked as guessed.
- It's lowered (2 cm) or flush only where the data says so: OSM's kerb tags at crossings
  (in Prague 5,662 lowered, 1,432 flush, 1,443 raised), the survey's driveway ramps
  (Nájezd, though only 10 in Praha 1), and pedestrian streets with no carriageway.
- Without the LiDAR, every kerb gets the guessed height except at those places. The
  scan makes kerbs more exact, but the stage doesn't need it.

Done when the first-person pairs show raised pavements and clean walls, lowered kerbs at
crossings stay lowered, the road checks are no worse, and the size is still within the
limit. Spot checks on Street View at a few kerbs of each kind come with it.

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
The candidates are the road overlays (`?roadfit`, `?roadsurfaces`, the corridors) and
the step lines. The lattice leaves the map (decided 14 November): the boats, lamps and
everything else that goes through `terrainAt` follow the switch, and the sky view and
the hill shade are moved to the TIN. It stays inside the build for as long as the rules
in `dtm_heights.py` work on a grid, and for one release both ship, so the map can go
back. The handbook, `rebuilding-the-map.md` and the terrain-steps skill change with it.

## The move off the lattice (17 November 2026)

What replaces stages 2–4 after the decision to go straight to the end. The survey's rules
(`dtm_heights.apply`) work on one array over the whole area: at 0.5 m that would be
about 3 billion points for `praha`, so they can't simply run finer. The build becomes
two passes in `ipr_terrain.py`:

1. **The city pass** (as now, on the 4 m lattice): what is city-wide by nature. IPR's
   model with its gaps filled, the water's pools and their levels, the walls' strips as
   polygons and which side is up, bridges and tunnels and their levels, the pads at
   bridge ends, the made-up land past IPR's model. Its lattice stays inside the build.
2. **The tile pass** (new, each tile with a margin, every 0.5 m): the surface the mesh
   is fitted to.
   - Water: flat at its pool's level.
   - Paved ground: the LiDAR as it is, and smoothed over 1.5 m on unpaved ground within
     2 m of it. Without the LiDAR: the city pass's streets.
   - Open ground: IPR's dense model.
   - Where the LiDAR is more than 0.5 m off the city pass: the city pass, if IPR's dense
     model doesn't bear the LiDAR out (a hole in the scan), and on any such patch that
     reaches a face in the LiDAR across a car street's middle or a way near a bridge
     (bridge ends, which OSM draws short of their abutments, and walls a street is drawn
     across). The ten trial places, below, say why.
   - Within 2 m of a wall: the city pass's heights. This is where the lattice still
     reaches the map, until the wall rules move to points (step 4).
   - Pads: flat at their height.
   - Breaklines: the walls' outlines with each side's height read from this surface a
     little way out (the LiDAR's crown where it has one, the straight tops), the
     survey's kerb lines with the same height on both sides, the water's edges.

   Then `pipeline/tin.py` fits the mesh (10 cm on paved ground, 25 cm elsewhere) and
   writes `<tile>.tin.bin.gz`: the points, each point's heights by side, the
   breaklines. The game builds the triangles itself (Delaunator and Constrainautor).
3. **The game** reads the mesh wherever a tile has one (`src/tin.ts`, as on the trial),
   the hill shade comes from it, and the checks read it too. For one release the map
   carries both, so it can go back; then `height.bin` goes.
4. **The walls move to points**: their foot and top from the survey's lines and the
   LiDAR, not from the lattice. After that the city pass only decides water levels,
   structures and which side of each outline is which.

Order: ujezd built both ways (with and without the LiDAR), then the ten trial places,
then the size in the binary format on ujezd and the 40 random tiles, and the Pixel 5's
time to triangulate a tile, before `praha`.

## How to work

- Small areas first; never build `praha` before the area's numbers are in.
- A/B pairs from the same commit, `?tin` against today, in first person and from above.
- No pipeline edits in a worktree while a build of it runs.
- Ask first, as the road plan says, before deploying, changing the shared map's
  defaults, letting the map grow by more than about a fifth, accepting a frame-time
  cost, or removing an overlay, a flag or a rule.

## Room to decide

- **Cars at kerbs.** Decided 14 November: cars and walkers ride the TIN as drawn, so a
  car mounting a pavement gets a jolt of about 12 cm.
- **The lattice afterwards.** Decided 14 November: it leaves the map at stage 4 (see
  there).
- **Kerbs the scan can't read.** It read two raised kerbs as flush, so flush comes only
  from the data (OSM's kerb tags, driveway ramps, pedestrian streets). Other kerbs get
  10 cm, marked as guessed (proposed in stage 2).
- **Without the LiDAR.** Stages 1 and 2 don't need it; the scan makes the kerbs more
  exact.
- **Straight to the end.** Decided 17 November: no more trial stages on top of the
  lattice. The build and the game move off the 4 m lattice in one go, ujezd first,
  then the trial places, then `praha`.
- **The LiDAR in the map.** Decided 17 November: streets take the 2023 LiDAR, walls
  come from the survey. The build must still run without it, and ujezd is built both
  ways first to show what it changes. (Nothing on record said why the public map was
  built without it: it had only been used in experiments.)
- **Size.** Decided 17 November: up to the fifth above (about 200 MB), aiming at 10 cm
  on paved ground and 25 cm elsewhere. The real binary format is measured on ujezd and
  on the 40 random tiles before `praha` is built, and the time to triangulate a tile
  on the Pixel 5 with it.
- **Kerbs, for now.** Decided 17 November: the survey's kerb lines go into the mesh as
  edges with the same height on both sides, so the road's edge follows the kerb.
  Raising them (the 10 cm rule above) is a later rule and a pass over the gameplay it
  touches: cars, traffic, chases, bikes, cars parked half on the pavement.

## Progress

- 14 November 2026: plan written. Not started. Decided the same day: kerbs in physics,
  the lattice out of the map at stage 4. Measured: the survey has kerbs' positions, and
  the LiDAR shows most of their heights but loses some low ones (two "flush" kerbs are
  about 10 cm on Street View).
- 14 November 2026: stage 0 done except the Pixel 5 frame time (the phone wasn't
  connected). The shots, the checks and the numbers are in `docs/evidence/tin/stage0`
  (local); "Why" above has what they showed. The scripts that took them are
  `docs/evidence/tin/baseline.js` and `tiles.js`. The tiles report the ground's build
  time (`drawMs.ground`) and triangles (`groundTriangles`) since this stage. Round the
  13 spots (104 tiles), a tile's ground has 71,000 triangles (median; at most 135,000)
  and 500 in the walls at its steps (at most 2,800). Its worker takes 95 ms (median;
  at most 522 ms), measured in headless Chrome on the M5 while the machine was busy, so
  compare only with runs made the same way. `ujezd`'s road check: 2 streets over the
  hard limits for bumps, 4 for leaning, 2 for twisting, none for steps. Its step check:
  8.1 km of edge, 287 teeth (35 per km), and 761 m of parapet whose top jumps by over
  5 cm.
- 14 November 2026: stage 1 stopped at its first measurement, the size. The prototype
  is `scripts/tin-target.mjs` (today's heights through the game's sampler, every 0.5 m,
  and the steps' outlines with each side's height) and `pipeline/tin.py` (breaklines,
  tile edges, greedy insertion on a conforming Delaunay). For `ujezd`'s 25 tiles, which
  are the dense middle of the city:

  | Tolerance | Vertices a tile | Triangles a tile | gzip a tile | `praha` by tile count |
  |---|---|---|---|---|
  | 2 cm everywhere | 14,800 | 28,200 | 194 KB | 2.8 GB |
  | 2 cm paved, 25 cm elsewhere | 6,200 | 10,900 | 77 KB | 1.1 GB |
  | 10 cm paved, 25 cm elsewhere | 3,200 | 5,300 | 38 KB | 560 MB |
  | the steps alone, 2 cm | 300 | – | 1.5 KB | 22 MB |

  Today's height file is 2.5 KB a tile (median). The limit was a fifth more map, about
  200 MB. Even if the outer tiles cost a third of these, a TIN within 2 cm of the paved
  ground is over it. The reason is the lattice's own shape: 45 % of its cells (all that
  aren't flat) are bilinear patches that bend by over 2 cm, so copying them takes
  several vertices a cell, each costing about 12 bytes against the lattice's one. A
  TIN is cheaper than a grid only where the ground is flat for long stretches.
  Building takes about 0.9 s a tile (2 cm paved, 25 cm elsewhere). The prototype still
  puts some samples in triangles of the wrong side (about 5,000 in `2_2`). That's to
  fix if this goes on.

  Proposed instead (not decided): keep the lattice for the smooth ground and add the
  steps, and in stage 2 the kerbs, as breaklines with each side's height. That's about
  1.5 KB a tile. The worker cuts the layers along them and takes heights near them from
  them. Stage 0 found the walls and kerbs the trouble in first person, not the creases.
- 14–15 November 2026: the lattice plus wall lines (option 1), built for the whole
  city with the LiDAR streets (`--survey-scan --step-lines`), against today's map:

  | | Today | Lines + LiDAR |
  |---|---|---|
  | Car-street steps over 1 m | 34 | 7 |
  | Bumps over 0.5 m | 537 | 259 |
  | Leaning over 15 % | 2,932 | 941 |
  | Twisting over 12 % | 2,361 | 712 |
  | Waves over 0.6 m (5 m either side) | 2,227 | 840 |
  | Carriageway within 0.3 m of the LiDAR | 86.4 % | 99.0 % |
  | Wall top jumping over 15 cm | 17.2 km | 6.6 km |
  | Wall top jumping over 5 cm | 38.1 km | 21.7 km |
  | Sharp turns along a wall, per km | 39.9 | 39.5 |

  Most of the road gain is the LiDAR streets; the wall-top gain is the lines. The
  sharp turns are the square ends of the survey's wall strips, not the lattice, and
  stay. In the pictures (`docs/evidence/tin/walls`, local) Thunovská's overhanging
  slabs, Chotkova's toothed ramp, Michle and most of Beneše's sawtooth are gone, and
  the first-person fix (walls hide what's behind them) stops the city showing through
  walls.

  What's left on the walls: of 274 km of wall line, the top sags more than 1 m below
  a straight line through the metres either side along 8.9 km, and more than 2 m
  along 2.1 km. At Československého exilu and Linhartova the cause is the LiDAR
  streets' shoulder: past the kerb, a lattice point takes the street's height when the
  scan within a metre of it reaches the street's height, and beside a retaining wall
  that scan runs down the wall's face. So the first row of points on the top comes
  down to the street, and the line reads the top's height from them. (The survey's
  retaining-wall lines, "Hranice zdi", are surveyed at the wall's foot, not its crown,
  so they can't give the top either.) Three fixes tried, all left off:

  - Lattice corners within 1–2 m of the line count for neither side (`MARGIN` in
    `step_lines.py`): fixes those two, worse at Vyšehrad and Malá Strana.
  - The lines read each side's height from the LiDAR instead of the lattice
    (`--step-lines-scan`): fewer sags, but noisier tops everywhere, and beside a
    narrow terrace the foot climbs the wall.
  - The shoulder only where all of the scan near a point is at the street's height
    (`SCAN_SHOULDER_WHOLE` in `dtm_heights.py`): walls better, streets worse. On nine
    windows (below) steps over 1 m 6 → 9, leaning over 15 % 38 → 51. On a 4 m lattice
    the street's edge and the wall's top share cells, and only one of them can be
    right.

  Still broken, each its own case: a car park full of wall slivers (50.10355,
  14.45724), Dobříšská's cutting, and torn walls in the ground under several road
  bridges (Na Botiči under Jižní spojka, the trunk road at 49.94233, 14.36734), which
  today's map has too. What looked like a crater at nábřeží Kapitána Jaroše
  (50.09785, 14.43698) is the game's hole round a player under a deck: the street
  under Hlávkův most's approach is 7 m below it in today's map as well.

  The 2 m lattice (option 3), on nine windows of 5 × 5 tiles round the places above
  (Československého exilu, Kapitána Jaroše, Linhartova, the car park, Beneše,
  Vyšehrad, Malá Strana, Na Veselí, Italská), summed:

  | Build | Steps over 1 m | Bumps over 0.5 m | Leaning over 15 % | Twisting over 12 % | Waves over 0.6 m | Wall top jumping over 15 cm (points) | Top sagging over 2 m (points) |
  |---|---|---|---|---|---|---|---|
  | 4 m | 6 | 15 | 38 | 46 | 48 | 639 | 204 |
  | 4 m, strict shoulder | 9 | 16 | 51 | 58 | 57 | 628 | 178 |
  | 2 m | 2 | 10 | 17 | 17 | 23 | 653 | 195 |
  | 2 m, strict shoulder | 5 | 10 | 23 | 23 | 30 | 607 | 175 |

  On 2 m the streets lose half to two thirds of what's left; the walls hardly change
  (Vyšehrad's sags and the car park are worse). For `ujezd`, already clean, 2 m
  and 4 m come out nearly the same, and the ground has the same number of triangles
  (68,900 against 68,300 a tile, median): the game's mesh doesn't follow the lattice.
  The worker takes longer, 165 against 123 ms a tile (median; at most 1,031 against
  787 ms, headless). The height file is 7.6 against 2.9 KB a tile in the dense
  windows.

  The whole city on 2 m (`ipr_terrain.py praha --survey-scan --step-lines --step 2`,
  then `layers.py`): 31 minutes for the terrain at 13.3 GB peak, 8 for the layers.
  The height files are 67 MB against 27 MB on 4 m (the map grows by 4 %). Against
  the 4 m lines build:

  | | 4 m | 2 m |
  |---|---|---|
  | Car-street steps over 1 m | 7 | 45 |
  | Bumps over 0.5 m | 259 | 346 |
  | Leaning over 15 % | 941 | 929 |
  | Twisting over 12 % | 712 | 666 |
  | Waves over 0.6 m (5 m either side) | 840 | 840 |
  | Waves over 1.5 m (12 m either side) | 428 | 521 |
  | Carriageway within 0.3 m of the LiDAR | 99.0 % | 99.1 % |
  | Wall top jumping over 15 cm | 6.6 km | 7.7 km |
  | Wall top sagging over 2 m | 2.1 km | 2.0 km |

  The windows didn't predict this. Of the 42 streets that get a step over 1 m on
  2 m (4 lose one), 23 are within 30 m of a bridge or tunnel, and most are trunk
  roads and motorway links at interchanges: under the decks the ground on 2 m is
  torn into more pieces, with lone spikes (Na Botiči: one point 17 m over its
  neighbours). The rules were tuned on 4 m; which of them go wrong on 2 m isn't
  known yet. Pictures:
  `docs/evidence/tin/grid/cmp-city-*.jpg` (local).

  Decided overnight (to review): no TIN, for its size, and because the walls aren't a
  storage problem: the lines already carry them. The 4 m lattice stays, with the
  lines and the LiDAR streets (`--survey-scan --step-lines`) proposed for the next
  map. The 2 m lattice gains a little on leaning and twisting and nothing on the
  walls, and its rules would need going through near bridges first: not worth it for
  now. The wall tops need their own work on any lattice: the heights beside a
  street's shoulder, and the survey's foot lines.
- 15 November 2026: walls from the LiDAR directly, first trials (both off).
  IPR's bare-earth scan leaves the walls out and bridges each one with a slope 3–6 m
  wide (Československého exilu: 254 to 262 m over 6 m, the survey's line at the foot),
  so a side read at a fixed 1.5–4 m lands on that slope. Two changes, on the nine
  windows (sums against the 4 m lines build):

  | Build | Steps over 1 m | Leaning over 15 % | Top sagging over 2 m (points) | Top jumping over 15 cm (points) |
  |---|---|---|---|---|
  | 4 m lines | 6 | 38 | 204 | 639 |
  | Walk | 6 | 39 | 132 | 960 |
  | Shoulder stops at walls | 9 | 48 | 163 | 586 |
  | Both | 9 | 50 | 130 | 941 |

  - The walk (`step_lines.walk_reader`, `window.py --wall-walk`): out from the line
    on each side until the scan flattens (under 0.5 m a metre), all or nothing per
    side, gaps filled along the line. Československého exilu, Linhartova, Italská and
    the car park lose their sags (the exil wall's top now runs level, with one notch
    left). Vyšehrad gets rougher: on a sloping bank the walk makes a wall 8 m tall
    where the scan has 4, and where the line ends the top drops to the lattice.
  - The street's shoulder stops at the survey's wall lines (`SCAN_SHOULDER_WALLS` in
    `dtm_heights.py`): the walls a little better, the streets a little worse, as with
    `SCAN_SHOULDER_WHOLE`: on 4 m the street's edge and the wall's top share lattice
    points.

  Next: a wall's ends (the walked top brought down to the lattice over the last
  metres, not at the end), and a limit on how far the walk may take a top above what
  the lattice has. The sawtooth along nábřeží Edvarda Beneše isn't heights: it's the
  survey's wall pieces, each rising and falling to nothing. Pictures:
  `docs/evidence/tin/walk/cmp-walk-*.jpg` (local).
- 15 November 2026: the walk's ends. Brought back to the lattice's reading over the
  last 6 m before a line ends or the other side loses its height (`TAPER`), and a
  half-walked step capped at the scan's own rise across the line plus 0.5 m (`SPAN`,
  `STEP_SLACK`). Also fixed: the walk's first reading is on the line itself, on
  neither side's outline, and the walk stopped there half the time. On the nine
  windows the sags over 2 m come to 158 points (204 on the lines build) and the tops
  jumping over 15 cm to 1,029 (639). Letting the walk cross other terraces' outlines
  (`WALK_ACROSS`) made it worse: 1,114, and in the pictures Vyšehrad's bastion broke
  open at its foot. Left off.

  Most of the jumps that count are where walls of very different heights meet
  (Vyšehrad: a 17 m rampart and a 3 m wall at one corner), on the old build too; the
  walk makes the tall walls their real height, so the jumps there grow. The measure
  doesn't tell a real corner from a broken one, and the pictures show little change
  at Vyšehrad either way. What the pictures do show: Československého exilu's top
  runs level, but has a notch down to the street where two of the survey's wall
  pieces end with a gap between them. That, and Beneše's sawtooth, is the walls'
  outlines, not their heights: joining a wall's pieces across short gaps, and
  letting a wall come down to nothing over its last metres instead of ending square,
  is the next thing to try (`strips` in `dtm_heights.apply`). Pictures:
  `docs/evidence/tin/walk/cmp-walk4.jpg`, `cmp-walk5.jpg` (local).
- 15 November 2026: the walls' outlines. The notch at Československého exilu wasn't a
  gap between the survey's pieces (they are one line there) and the step line there was
  level: the game's sampler gave way to the lattice. The wall's foot strip stops at the
  car street's kerbs, a footway's width, and the street past it and the wall's top were
  both plain ground; where the wall runs across the lattice at an angle a cell had
  corners of both, and the top sagged to the street. Beneše's sawtooth is the same.
  Now each retaining wall gets a strip on its top too (`TOP_STRIP`, 8 m, on by
  default); lattice points on the top's side that kept a footway's height go with the
  foot; pieces under 32 m² that a street on the top leaves are dropped (`TOP_LEAST`).
  Two bugs this showed: the game drew an edge two terraces share twice, wall and
  parapet one over the other, flickering (`shared` in `src/stepEdges.ts`); and the
  step lines read the next tile's terraces by the tile's own label numbers, so near a
  tile's edge they read another terrace (a 7 m hole at the corner of Československého
  exilu; `terrace_ids`, `lattice_reader`).

  A new measure reads the game's sampler a metre either side of every surveyed wall
  (the old ones read the step lines, which were fine where the game wasn't). Nine
  windows, 9,600 m of wall:

  | | top sags over 1 m | over 2 m | step under half | rough parapet (m) |
  |---|---|---|---|---|
  | lines build | 623 m | 359 m | 418 m | 510 |
  | with top strips | 481 m | 302 m | 359 m | 416 |

  Street checks unchanged or better (leaning over 15 %: Jaroše 8 → 6); tiles 4.5 %
  larger gzipped. Pictures: `docs/evidence/tin/top/cmp-*.jpg` (local). Left: the
  corner of Československého exilu where the survey's line turns back on itself (a
  flat shaded band on the wall, a hole before), and Vyšehrad's corners where walls of
  very different heights meet.

  The city build (`ipr_terrain.py praha --survey-scan --step-lines`, then `layers.py`,
  22 minutes) against the lines build: parapet tops jumping over 15 cm 6.6 → 4.1 km,
  over 5 cm 21.7 → 13.3 km; car-street steps over 1 m 7 → 4, bumps over 0.5 m 259 →
  256, leaning over 15 % 941 → 923, twisting over 12 % 712 → 692, waves over 0.6 m
  840 → 823, 99 % of carriageway within 0.3 m of the LiDAR as before. On the nine
  places (5 × 5 tiles each, 18,400 m of wall) the top sags over 1 m along 1,101 →
  850 m, over 2 m 563 → 478 m. 298 km of edge (267), sharp turns 39.5 → 40.5 per km.

  It gave K Celinám (50.00447, 14.35263) a step of 4.4 m: a living street at a wall's
  foot with the next wall's top a metre past its kerb, narrower than a cell, and the
  top strip took the cell's last plain corner. Where a car street crosses a cell
  whose plain corners a top strip took, those corners go back to plain ground (39
  cells in the city); the step is 1.3 m now and nothing else measured moved.

  By a path in Podolí (50.04845, 14.40551) a wall's top strip ended square across the
  path: a wall 5 m high across it where the lines build had a ramp. A top strip's
  ends are where it was cut, not a wall, and the step lines there now run level
  (`soft_edges`, `SOFT_END`): the path climbs past the wall's end. Levelling the
  strip's far side too fixed it as well but roughened the walls' tops more (in the
  test windows round Vyšehrad, parapet jumps over 15 cm 166 → 229 m; ends only 214 m).
  City build against the one before: 17 km less edge (298 → 281 km), sharp turns 40.5
  → 39.0 per km, the streets' checks and the wall tops' sags on the nine places as
  before (sags over 1 m 850 → 846 m). Parapet jumps over 15 cm went 4.1 → 6.3 km:
  2,400 new spots with a median of 0.24 m, the last metres where a wall now ends
  instead of turning the corner along its strip's end (the worst, at Chotkova,
  50.09348, 14.40885, is a wall ending beside a path up the bank). The roughest
  parapet in the city is still the 13 m at Podolí's wall end, where the 14 m wall
  stops. Pictures: `docs/evidence/tin/top/city/cmp-*.jpg` (local; left the lines
  build, right with top strips) and `cmp-ends-city-*.jpg` (left with top strips,
  right with level ends).

- **The dense terrain model (16 November 2026).** IPR serves each TER sheet twice: the
  CityGML the pipeline read, which is thinned, and a Shapefile with every point of it
  and five times more (on TER_Krav_6-9 152,000 points against 26,000, triangles of
  about 2 m² against 74 m²; the extra points sit 18 cm off the thinned surface in the
  median, 16 % of them over 0.5 m). Both are public ArcGIS Online items of IPR's
  (`TER_<sheet>_gml`, `_shp`). `ipr_terrain.py --dense` (`DENSE_TIN`, `--set
  DENSE_TIN=1` in `window.py`) read the Shapefile ones, kept zipped in
  `pipeline/.cache/ipr/`; the triangles go onto the lattice vectorised now (same
  heights, ten times faster).

  Eleven test windows (the ten places and Podolí), coarse against dense, with
  `--survey-scan`. Plain ground within 0.3 m of the 2023 LiDAR, the terrain model
  alone: 65.5 → 79.4 % on average (every place better, Vyšehrad 56 → 74 %, K Celinám
  78 → 91 %); after the survey's rules, as the map has it: 68.2 → 76.3 %. With the
  dense model the rules take the ground further from the LiDAR, not nearer (79.4 →
  76.3 %): worth finding which (feathering, banks, the made-up land) and tuning them
  to the dense ground. Wall tops sagging over 1 m 578 → 461 m (Vyšehrad 162 → 112,
  Podolí 101 → 77, Malá Strana 51 → 32), parapet jumps over 15 cm 622 → 584 m. The
  streets about the same (they take the LiDAR's road): waves over 0.6 m 56 → 61,
  leaning over 15 % 44 → 46, steps over 1 m 7 → 7. From above the pictures hardly
  differ (`docs/evidence/tin/dense/cmp-*.jpg`, local). Built for the city below.

  Tuning the rules for the dense model (same eleven windows, averages). The rules took
  the ground further from the LiDAR because two of them were made for the coarse one:
  - **Handling areas** (yards, depots, loading areas) took the average of their rims,
    surveyed only there; the biggest patches the rules made worse were all of them (a
    yard in Modřany 1.5 m under the ground). Left to the terrain model now, with either
    model: plain ground within 0.3 m 68.2 → 68.8 % coarse, 76.3 → 77.2 % dense, walls
    and streets as before.
  - **The walls' reach** (`REACH`, 10 m): the dense model's ramps at walls are narrow,
    and 4 m or 2 m took the terraces within 0.3 m of the LiDAR 47 → 53–55 % (over 1 m
    off 29 → 16–18 %). But the walls' tops sag more against the survey (over 1 m 410 →
    580 m at 4 m, 895 m at 2 m): next to a wall the LiDAR is a ramp too, and the
    survey's top should win. Left at 10 m.
  - **Feathering** beside surveyed streets costs 1.4 points of plain ground, but
    without it the streets wave more (over 0.6 m 61 → 66). Kept. `FEATHER` 6 m and
    `FEATHER_BLUR` 2 m: no better.
  - Keeping the terrain model's shape across a surface, moved by how far the survey's
    points round it are off it, instead of averaging them: plain ground +0.2, terraces
    −2 points. Dropped. Banks (`BANK` 4 m), `INLAND` 8 m, `--no-level`,
    `--no-scan-streets`: no difference.

  With the dense model the walls' step comes out under half its usual height along 398
  m of the measured walls (358 coarse): worse round Vyšehrad (+24), Holešovice (+17)
  and Beneše (+9), better at Na Veselí, Modřany and Linhartova. The dense model finds
  more retaining walls (round Vyšehrad 7.9 → 9.0 km).

  **The city with the dense model** (16 November 2026, `ipr_terrain.py praha --dense
  --survey-scan`, without handling areas), against the coarse city build with the same
  rules but the handling areas still in (`docs/evidence/tin/dense/`, local). The
  whole ground against the 2023 LiDAR: plain ground within 0.3 m 75.2 → 86.7 %, over
  1 m off 3.4 → 1.7 %, mean 0.30 → 0.17 m; terraces within 0.3 m 43.7 → 47.5 %.
  Streets (`check-road-flatness`): steps over 1 m 4 → 5, bumps over 0.5 m 256 → 216,
  leaning over 15 % 923 → 890, twisting over 12 % 692 → 665, waves (5 m) over 0.6 m
  823 → 773, stretches over 2 m off the LiDAR 391 → 355, carriageway within 0.3 m of
  the LiDAR 99.0 → 99.1 %. Steps in the ground (`check-step-edges`): 281 → 308 km of
  edges, parapet jumps over 15 cm 6.3 → 6.8 km, sharp turns 39.0 → 37.8 a km. Wall
  tops on the nine places: sagging over 1 m 846 → 798 m, over 2 m 477 → 396 m, the
  step under half its height 834 → 866 m. From above, the walls' tops are straighter
  (Československého exilu, Bašta sv. Ludmily) and nothing new is broken in the
  pictures.

  The one new step over 1 m is K Přehradám (49.95625, 14.39252). A service way (113651153)
  passes under it at a slant in a cutting 5 m deep, and `structures.cuttings` makes the
  street a short bridge over it, 19 m long, judged along the street's middle. The dense
  model has the cutting reach further under the street's east edge and then run on
  right beside it, 1.6 m past the kerb; the coarse model had neither. Where the deck
  ends, the edge reads the cutting's side: a step of 1.2 m.

  Tried on a window and taken back out: lengthening the bridge, judged under the
  street's edges too or ended 4–6 m past the cutting instead of 2 m, with its ends at
  the street's height either side (the abutment rule put the end on the cutting's far
  bank, 1 m over the street). The best brought the step to 0.77 m, but a 1 m wave
  stays wherever the deck ends, because the cutting runs on beside the street, and near
  a deck the street doesn't take the LiDAR's road. What it needs is the cutting's
  wall along the street's edge, as a step in the ground; the survey has none there.

  **The default since 16 November 2026**, with the city map above on the beta.
  `ipr_terrain.py --coarse` (`--set DENSE_TIN=0` in `window.py`) reads the CityGML
  sheets as before.

  **IPR's dense TIN cut at the walls, tried as the ground itself (16 November 2026).**
  Not the stage 1 TIN above (today's heights triangulated): IPR's own dense points,
  without the points within 0.3 m of a step line (the wall's face), and the game's step
  lines doubled 3 cm either side, each copy at that side's height. On the nine places
  (5 × 5 tiles each), against today's ground as the game samples it
  (`scripts/tin-target.mjs`):

  | | today | dense TIN | with steps, sides from IPR's points | with steps, sides from the step lines |
  |---|---|---|---|---|
  | streets within 0.3 m of the LiDAR | 88.1 % | 84.4 % | 84.9 % | 84.9 % |
  | other ground within 0.3 m | 74.1 % | 73.9 % | 75.1 % | 75.1 % |
  | wall tops sagging over 1 m (18.4 km of wall) | 955 m | 2,436 m | 2,260 m | 1,817 m |
  | over 2 m | 527 m | 876 m | 1,389 m | 1,013 m |
  | step under half its height | 971 m | 932 m | 1,440 m | 1,188 m |

  Not taken. The dense model has few points at the walls the game knows: within a metre
  of the step lines, an IPR point at 6–23 % of the line's points, and within 4 m about
  one, so a side's height rarely comes from IPR (1–23 % of the line) and the ground
  between the line and the next points is a long ramp of a triangle. The streets lose
  the LiDAR's road (`_scan_streets`) and come out faceted. Other ground gains a point.
  From above (pictures in `docs/evidence/steptin`, local) the walls are clean but the
  ground beside them is toothed and the streets crumpled; today's ground is smoother,
  with 4 m blocks on slopes. Over the middle tile the TIN with its lines takes 20–230 KB
  gzipped against 2–5 KB of heights (a plain encoding; the lines are doubled every
  0.5 m). The measures for walls were made for, and the rules tuned on, these nine places,
  which favours today's ground. A TIN still looks like the way to get the shape between
  points right, but with today's heights on the streets and at walls, as stage 1 plans.

  **Road samples and terrain window trials (17 November 2026).** The current
  57,188-street check found six steps over 1 m. Of the 9.9 million bare-earth
  LiDAR comparisons on ground roads, 99.1% were within 0.3 m. The flagged spots
  still matter: street panoramas show continuous roads at K Celinám,
  K Přehradám and Kbelská, while the game shows a high wall, an uneven deck
  approach and a distorted cutting respectively.

  | Worst step within the trial window | 4 m grid | 2 m grid |
  |---|---:|---:|
  | K Celinám | 1.32 m | 3.01 m |
  | K Přehradám | 1.15 m | 1.64 m |
  | Kbelská | 0.35 m | 1.02 m |

  Seven windows with top strips 4, 6 and 8 m wide did not find a better default.
  Keeping two plain grid corners around a road cut K Celinám's worst step to
  0.74 m but left a 2.9 m wave. Cutting the strips back from the lane was worse:
  the map made a 1.64 m wall step across K Celinám. The ground on either side of
  the wall needs separate support, especially where the road is narrower than a
  grid cell. These trials did not improve both the road and the adjacent wall.
  Add `--lane-steps` to `scripts/check-road-flatness.mjs` to rank sudden steps
  on the traffic graph's path in each direction as well as the full carriageway.
  On Patočkova the lane test confirmed a 1.21 m step. The flagged K Přehradám
  deck edge, by contrast, was much smoother at the middle of the sampled lane.

  **Straight wall tops, with the ground filled up to them (17 November 2026).** A
  retaining wall's top runs straight between its corners, while the top the game reads
  beside it sags wherever the scan or the 4 m lattice blurs it. So each wall gets an
  even grade per stretch, and the ground behind it is raised to that top.
  `step_lines.straight_tops` (on branch `tin`, off by default: `window.py --set
  STRAIGHT_TOPS=1 --set STRAIGHT_FILL=1`) joins each step line across the tiles'
  edges and splits it at corners, where its high side changes and where a street
  crosses it. Through the upper envelope of each stretch's top it fits straight pieces
  of 8 m or more (within 0.3 m), and it moves a top up by 3 m at most and down by
  0.5 m. A piece steeper than 20 % is a bank's slope, not a wall's top, and stays as it
  was. The fill raises the lattice points of the top's terrace within 4 m behind the
  wall to the new top, but none within a cell of a car street's carriageway.

  On the nine places (3 × 3 tiles each), the game's ground 1 m behind the top of every
  step 1 m or higher (13.0 km, corners left out), against the straight line 6 m either
  way:

  | | today | straight tops | straight tops, ground filled |
  |---|---:|---:|---:|
  | dips behind the top over 0.3 m | 506 m | 443 m | 250 m |
  | over 0.5 m | 292 m | 267 m | 169 m |
  | over 1 m | 145 m | 130 m | 96 m |
  | parapet jags over 15 cm | 486 m | 478 m | 469 m |

  Straight tops alone do little. The game gives a step line no say where it is far off
  the lattice and the lattice has no step there (`AGREE` in `src/terrain.ts`), so a
  raised top falls back to the lattice. Where the line does hold, it leaves a rim: at
  Malá Strana the ground 1 m behind was more than 0.3 m under the top at 7 % of the
  places, against 3 % today. With the fill the rim is gone (2 %), and the dips halve,
  most of all on the quay of nábřeží Kapitána Jaroše (from above, the wall's shadow on
  the river is straight where it was notched every 4 m), at M7, Vyšehrad and Malá
  Strana. The streets within 300 m measure as before except one 10 m slip road at
  nábřeží Kapitána Jaroše, now leaning 8.7 % (the flag is 8 %). The streets' fit to the
  LiDAR is unchanged, and so is the ground 4–6 m behind the walls (51, 58 and 64 %
  within 0.3 m of the LiDAR). The first version also filled under streets, which put
  four more leaning streets at nábřeží Kapitána Jaroše. It also lifted the land side of
  the water's outline where that outline climbs a bank (by 3 m). The street and slope
  rules above come from those two.

  What it leaves: along the survey's own retaining walls (8.5 km), the dips over 1 m
  stay at about 320 m. They are where several small terraces meet, at walls' ends, and
  where a terrace's outline runs a metre or more off the surveyed wall. The sawtooth
  on the grass slope behind the quays is the 4 m lattice on a diagonal bank, not the
  wall. Both need the walls' outlines taken from the survey's lines themselves, or a
  finer ground (stage 1). Not the default yet: it hasn't been tried on the whole city,
  and the measures were tuned on these nine places. Pictures and scripts are in
  `docs/evidence/straight-tops` (local).

  **The wall's top where its face ends (17 November 2026).** At nábřeží Kapitána Jaroše
  the game still drew one wall 8 m high, where there is a stone wall to about 185.5 m
  and a grass bank behind it rising to 189 m over 6 m (the LiDAR, and the user's
  picture from Google Earth). The top was read 1.5–4 m back, on the bank; straight
  tops then levelled it at the bank's height. `STRAIGHT_CROWN` (tin branch, 5631f7d2;
  needs the scan) reads a LiDAR profile across each stretch of wall: the steepest rise
  starting within 5 m of the line, followed while it is steeper than 1 m per metre and
  at least 1 m high. Where it ends is the crown. Where most of a stretch has one, the
  top goes no higher than the crown (filled in between), and then the straight pieces
  are fitted. The fill behind such a wall also lowers the lattice within 4 m to the
  scan's height, never under the top: without that the lowered top was a ledge a
  metre wide with the old ground jumping back up behind it.

  The ground 1 m and 3 m behind the walls, share within 0.3 m of the LiDAR:

  | | straight tops, ground filled | with the crown |
  |---|---:|---:|
  | Československého exilu | 18 / 46 % | 25 / 55 % |
  | nábřeží Kapitána Jaroše | 22 / 40 % | 28 / 44 % |
  | Linhartova | 21 / 37 % | 30 / 56 % |
  | M7 | 33 / 58 % | 40 / 64 % |
  | Benešovská | 65 / 89 % | 65 / 90 % |
  | Vyšehrad | 12 / 26 % | 18 / 41 % |
  | Malá Strana | 18 / 50 % | 27 / 62 % |
  | Na Veselí | 43 / 45 % | 42 / 46 % |
  | Italská | 18 / 37 % | 44 / 61 % |

  The streets measure exactly as before. At Jaroše the top is now 185.3–186.3 m
  (LiDAR crown 185.2–185.6, straight tops 188.4), and the places that changed most are
  walls of the same kind: a low wall with a terrace or a bank behind and a second rise
  further back (Československého exilu: a wall to 259 m, a terrace 6 m wide, then
  263 m; straight tops had put the top at 262.4). The "dips behind the top" measure
  goes up (Jaroše 70 → 87 m over 0.3 m), because 1 m behind a low wall is now the
  bank's real slope, which it counts as a dip; it fits walls with a flat top only.
  Parapet jags over 15 cm grow at Vyšehrad (206 → 281 m) and a little at Malá Strana
  and Linhartova, the worst of them the same as before: Vyšehrad's ramparts, battered
  walls where the crown may stop part way up, are left to look at. Screenshots
  `crown-jaros.jpg` and `crown-m7.jpg` in `docs/evidence/straight-tops` (local); in the
  tin worktree's game the three maps are `?area=walls-today`, `walls-straight` and
  `walls-crown`.

  **The notches every 15 m (17 November 2026).** Even with the crown, the Jaroše quay
  still had a notch down to the water every 15 to 17 m, in all three versions; the real
  wall is straight. The LiDAR is the same at a notch as between them. The step line runs
  a little askew to the lattice and crosses a row of it every 15 m, and there the top's
  side was read on the wall's foot, half a metre over the water: no step, so the point
  ended a straight piece. With the crown, a gap of up to 16 m between two stretches of
  one wall is wall where the scan has a crown at every point of it, and a stretch with a
  crown takes it both ways (a top read lower was read on the face). The quay's top now
  runs evenly from 186 to 184 m (tin branch, fb1c39b1). Within 0.3 m of the LiDAR 3 m
  behind the walls: Jaroše 44 → 48 %, M7 64 → 70 %, Československého exilu 55 → 61 %,
  Na Veselí 46 → 49 %, the rest within 2 points. Streets as before. Parapet jags over
  15 cm went up at Vyšehrad (281 → 321 m) and Malá Strana (47 → 59 m), not yet looked
  at. Pictures `crown2-jaros.jpg` and `crown2-jaros-east.jpg`.

  **Vyšehrad's parapets (17 November 2026).** Most of the new jags were on the
  ramparts, whose top falls 5 m in 20 m along the wall: too steep to straighten, so it
  keeps its heights point by point, and with the crown those came from one LiDAR
  profile each, scattering by 0.2–0.7 m. Such stretches now keep the step line's own
  reading, and the crown only sets the height where the top is straightened (tin
  branch). Parapet jags over 15 cm: Vyšehrad 321 → 258 m (straight tops alone: 206),
  Malá Strana 59 → 44 m, Jaroše 136 → 119 m; Benešovská 27 → 34 m and Linhartova
  38 → 41 m. Streets as before; the LiDAR fit behind the walls about the same, except
  Malá Strana 3 m back (63 → 57 %). Of what is left above straight tops at Vyšehrad,
  the largest piece is a lane in a cutting where the crown brings the ground down
  from 215.4 to 211.8 m and the LiDAR has 209–213 m: closer to the real ground, but it
  counts as a jag. Picture `crown3-vysehrad.jpg`.
- 17 November 2026: the TIN tried again, on the new ground. The user hadn't agreed to
  the 15 November "no TIN": the TIN is wanted, with the straight tops and the ground
  filled up to the walls. Stage 1's builder (`pipeline/tin.py`, tin branch 2d2d57d8)
  on the nine places' middle 3 × 3 tiles, with the crown version of the ground as the
  target. Two fixes first: a triangle not touching a step takes the side at its middle
  (the flood leaked through gaps in the outlines and put water on the land's side,
  5,415 samples a tile → 224, all within 7 cm of a step), and a step segment the
  triangulation misses is split at its midpoint even with no sample between its ends
  (missing wall segments 626 of 2,246 → 6 of 4,779).

  Size: the file can hold the points alone, a height per side at a step's points, and
  the steps as runs of point numbers; the game triangulates them. Stored with their
  triangles they are 3.5 times bigger.

  | Target, paved / elsewhere | nine dense places, a tile | 40 random tiles, a tile | `praha` from the random tiles |
  |---|---:|---:|---:|
  | today's ground, 10 / 25 cm | 14.8 KB | 4.5 KB | 65 MB |
  | today's ground, 20 / 50 cm | 10.1 KB | 2.7 KB | 39 MB |
  | LiDAR off the streets, 10 / 25 cm | 18.2 KB | 5.7 KB | 83 MB |
  | LiDAR off the streets, 20 / 50 cm | 11.7 KB | 3.2 KB | 46 MB |

  Today's height file is 61 MB for `praha` (the nine places: grid 3.2 KB, step lines
  2–4 KB and terraces 0.5–1.3 KB a tile). So points-only passes the size gate, which
  the 14 November encoding (2.8 GB at 2 cm) didn't.

  Shape: a TIN of today's ground copies it (median 2 cm off, 95 % within 10 cm), the
  4 m lattice's stair-steps on diagonal banks included (the grass behind the Jaroše
  quay). It's a better container, not better ground. "LiDAR off the streets" takes
  IPR's bare earth (smoothed over a metre) wherever it is 4 m or more from a step line
  and from paved ground, blended over 2–4 m, and today's ground elsewhere (streets,
  walls, water): the Jaroše bank becomes one even slope, and Linhartova's hillside
  shows its paths, ridges and terraces instead of 4 m blocks
  (`docs/evidence/tin/walls-tin/relief-*.jpg`, local). Left to fix: beside some walls
  a second ridge runs parallel to the wall, the LiDAR's own slope across the wall
  taken up just past the 2 m; near the slip roads at Jaroše the LiDAR's slopes and
  the game's terraces don't line up.

  For the game: a triangulation with the steps as constraints, so that no triangle
  crosses a wall whatever the ties. With another tie-break (Qhull's `QJ`) 224 of
  4,779 wall segments went missing, so plain Delaunay of the points isn't enough. The
  game has no such library yet (a new dependency, or our own). Nothing in the game reads
  the TIN yet.

  **IPR's dense model instead of the grid (17 November 2026).** The ground above went
  TIN → grid → TIN: the pipeline samples IPR's dense terrain sheets (`TER_*_shp`, a
  TIN with triangles of about 2 m²) onto the 4 m grid, and the builder triangulated the
  grid again. So the target now takes IPR's dense triangles themselves wherever the
  ground is 4 m or more from a step line and from paved ground (blended over 2–4 m),
  and today's new ground elsewhere: the streets (the LiDAR's road), the walls with
  their straight tops and filled ground, and the water.
  (`docs/evidence/tin/walls-tin/dense_target.py`, local; it reads the sheets with the
  16 November trial's `dense_points`.)

  | Paved / elsewhere | nine dense places, a tile | 40 random tiles, a tile | `praha` from the random tiles |
  |---|---:|---:|---:|
  | 10 / 25 cm | 18.5 KB | 6.1 KB | 89 MB |
  | 20 / 50 cm | 12.4 KB | 3.5 KB | 50 MB |

  (Ten random tiles' sheets aren't in the cache, on the city's edge; those kept
  today's ground.) Open ground, 4 m or more from steps and paved ground, within 0.3 m
  of the 2023 LiDAR:

  | | today's grid | TIN of today's | TIN from IPR's dense model |
  |---|---:|---:|---:|
  | Československého exilu | 70.1 % | 69.5 % | 73.0 % |
  | nábřeží Kapitána Jaroše | 77.1 % | 76.7 % | 74.6 % |
  | Linhartova | 73.7 % | 72.8 % | 74.2 % |
  | M7 | 81.9 % | 81.2 % | 80.4 % |
  | Benešovská | 84.8 % | 84.4 % | 86.9 % |
  | Vyšehrad | 62.7 % | 61.9 % | 62.4 % |
  | Malá Strana | 70.5 % | 70.1 % | 71.9 % |
  | Na Veselí | 67.7 % | 67.2 % | 69.0 % |
  | Italská | 62.6 % | 62.1 % | 62.5 % |

  About even in height: today's grid has the survey's rules on top of the same model.
  The gain is the shape between the points: the 4 m blocks on hillsides and the
  stair-steps on diagonal banks go, as with the LiDAR stand-in, and the picture is
  much the same (`drelief-*.jpg`). The second ridge beside some walls shows here too,
  so it comes from the blend near walls, not from the LiDAR.

  **The game's triangles (17 November 2026).** The game would get the points and the
  wall lines, and build the triangles itself with the wall lines kept as edges:
  Delaunator with Constrainautor on top (both ISC; added on the `tin` branch, nothing
  imports them yet). Tried in Node on the nine places' 81 tiles at 10 / 25 cm
  (`docs/evidence/tin/walls-tin/cdt_check.mjs`, local):

  - Wall pieces not kept as edges: 53 of 108,772. First 6,752: the same wall came
    twice, once from each side's outline with the labels swapped and its own samples,
    and the copies cross in a zigzag. `tin.py` now keeps one copy (`DUP`, 10 cm). A wall
    along the tile's edge passes through the edge's points; it is cut at them.
  - Time: 3–30 ms a tile on the M5 (Vyšehrad 11, Benešovská 21–30), 7 ms on average,
    half of it Delaunator. Fine in a worker as a tile loads.
  - Sides: a triangle on a wall line takes that side (Delaunator's triangles run
    clockwise, so the right of the line); any other its middle's side from the tile's
    water and terrace outlines, as the pipeline does. From the points alone, the river
    between banks without a wall came out as land.
  - Heights: 99.8 % of the check samples (every 2 m) within 1 cm of the pipeline's
    TIN, and 270 of 1.29 million over the tolerance, against the pipeline's 132.
    Wrong-side samples 1,928 against the pipeline's 590, mostly at Benešovská, Malá
    Strana and M7: not looked into yet.

  **In the game (17 November 2026).** On the `tin` branch, `?area=walls-tin` loads a
  map copy (`public/data/walls-tin_now` there: `praha_now` with the trial places' tiles
  from window builds with straight tops, crowns and fill) whose tiles also have the
  TIN's points and wall lines under `tin/`. The game triangulates them in
  `src/tin.ts`, reads the ground's heights from the triangles (walls and ground meshes
  alike), cuts the ground into 2 m pieces instead of 8 m on those tiles, and shades it
  from a 1 m relief of the TIN. Wall tops followed the wall lines badly at first
  (kinks where a line was cut, and where a point's other side was dropped): with each
  point's every side kept and the wall's own height read on the line, samples more than
  10 cm off the line went from 7.85 % to 0.09 %. 83 are still over 2 m, at tiny pieces
  where three walls meet.

  Two places the user found:

  - **The quay wall dipped 4 m at nábřeží Kapitána Jaroše** (a V seen from above),
    going down from the bridge head to the quay. A piece of a top steeper than
    `TOP_GRADE` keeps its heights as read, and there the reading had slipped to the
    wall's foot. Such a piece is now held at its lower end, less 0.3 m, where an end's
    height is the straight top it joins (`straight_tops`, `tin` branch). Taking the
    ends from the envelope instead flattened the last metres of a wall at Malá Strana
    over a 6 m cliff and lifted a quay wall under Vyšehrad by 5.5 m. Against the
    earlier build, on the ten places, it moves the dip and 9 heights at Libeňský most
    and under Vyšehrad (small dips filled to the top beside them, at most 0.75 m),
    nothing else.
  - **The road edge on Edvarda Beneše was torn** (the lattice's teeth where the road is
    cut into Letná's slope). The target had today's ground on the streets. It now has
    the 2023 LiDAR on paved ground and within 2 m of it, smoothed over 1.5 m off the
    paved ground (raw, the strips of grass and hedge beside a street came out in dark
    scribbles), and keeps today's ground only within 2 m of walls of 0.3 m or more. A
    terrace's outline with the same height on both sides is no wall: it kept a 2 m band
    of teeth along the kerb, and now takes the new ground's height
    (`docs/evidence/tin/walls-tin/dense_target3.py`, local). The tiles round the second
    view are in the trial now (the place `jarosw`, 58_68).

  Points a tile, the nine places: 4,700 → 6,300; gzip with the 0.5 m side grid
  38.7 → 50.2 KB. Before and after: `game-jaros-dip-fixed.jpg`,
  `game-jarosw-road-edge.jpg`. Left on that road: a short zigzag where the road's
  edge is a real low wall (0.7 m median) drawn on the lattice's outline, which the TIN
  can't straighten (the outline would have to follow the kerb), and scribbles on the
  tram median that the mesh didn't change. Also left: the bridge head at Hlávkův most,
  as broken on today's map, and a crack along the promenade above Jaroše's quay.
- 17 November 2026: the move off the lattice, first round (branch `tin`). The city pass
  is `ipr_terrain.py --tin`. The tile pass is `pipeline/tin_tiles.py`: the surface every
  0.5 m as listed under "The move off the lattice", then the fit, written as
  `tiles/<k>.tin.bin.gz` beside the lattice and listed under `tin` in `index.json`. The
  file (`tin.FORMAT` 1, read by `decodeTin` in `src/tin.ts`) has the points sorted by
  row, two bytes for each coordinate and height, the extra heights of points on a wall,
  and the breaklines as runs of point numbers with the side on their left and right. The
  game draws the ground from the mesh wherever a tile has one (`?tin=off` for the
  lattice), and `check-road-flatness.mjs` and `check-bridge-decks.mjs` read it too
  (`--tin off` for the lattice). `check-tin.mjs` compares each mesh, as the game builds
  it, with the surface it was fitted to.

  `ujezd` built both ways, against the city pass's lattice built the same way:

  | | Lattice, LiDAR | Mesh, LiDAR | Lattice, no LiDAR | Mesh, no LiDAR |
  |---|---|---|---|---|
  | Carriageway within 0.3 m of the LiDAR | 99.7 % | 99.9 % | 94.7 % | 94.8 % |
  | Streets leaning over 8 % / 15 % | 3 / 2 | 2 / 0 | 10 / 4 | 10 / 4 |
  | Bumps over 0.15 / 0.5 m | 4 / 1 | 2 / 1 | 7 / 2 | 7 / 2 |
  | Line metres with a wave over 0.2 m (5 m either side) | 0.17 % | 0.12 % | 0.65 % | 0.62 % |
  | Points a tile | | 4,900 | | 3,800 |
  | Mesh file a tile (gzip) | | 23.9 KB | | 19.5 KB |

  The bridges' decks and joins come out the same in all of them. Without the LiDAR the
  streets are the city pass's, so the mesh changes little on them: what it changes is
  the open ground (IPR's dense model in place of the lattice) and the edges, which
  follow the outlines instead of the lattice's cells. The streets' gain is the LiDAR's,
  as on the lattice in November.

  At Smetanovo nábřeží the quay wall has no outline in the city pass (the lattice draws
  it as a ramp), and the mesh followed the LiDAR's 1 m cells down it in a sawtooth. On
  the ground within 1.5 m of a LiDAR face rising more than 1 m within a metre, the
  surface now takes IPR's dense model (`STEEP`, `STEEP_NEAR` in `tin_tiles.py`). The
  pictures, lattice against both meshes, are in `docs/evidence/tin/move` (local).

  Left: 104 breakline pieces on `ujezd` that the game's triangulation can't keep
  (clusters of points a few centimetres apart where two outlines nearly cross, which
  want their crossings put in and close points merged), white specks along some wall
  lines, and a wavy wall foot on Petřín with the LiDAR.

  The size, before the ten trial places so as to know early whether the format holds:
  40 random tiles of `praha`, each a window build with the city pass as `--tin
  --survey-scan`. The mesh file is 8.5 KB a tile on average (median 3.4 KB, at most
  38.7 KB), about 124 MB for the city's 14,595 tiles, inside the 200 MB. Everywhere
  within 10 cm on paved ground and 25 cm elsewhere; 39 triangles in all (1.5 m²) on the
  wrong side of a step.

  The time to make a tile's ground from its file (`scripts/tin-bench.mjs`, `ujezd`'s 25
  tiles, each tile's median of three to five runs, then the median and the worst tile):

  | | Mac (M5, headless Chrome) | Pixel 5 |
  |---|---|---|
  | Unpacking and decoding | 0.5 ms | 4 ms |
  | Triangulating with the breaklines | 2.4 ms (at most 10) | 10 ms (at most 64) |
  | The sampler's index | 0.5 ms (at most 1) | 2 ms (at most 4) |
  | The shading texture | 35 ms (at most 72) | 178 ms (at most 334) |

  All of it runs on the main thread while a tile loads (`src/tiles.ts`). The shading is
  the cost: it reads the mesh five times for every square metre of the tile, where the
  lattice's read one height per lattice point. Proposed before `praha` (not decided):
  draw the shading triangle by triangle, one slope each (inside a triangle it already
  reads a single slope, so it should look the same), and perhaps move the triangulation
  into the tile worker for the worst tiles. The phone's first runs came out four times
  slower: its screen had gone off or the lock screen was over Chrome, which then slows
  the page. Kept awake (a wake every 10 s, the lock screen lifted) it gives the numbers
  above, with no touches on the screen during the run.

  The shading fixed the same day (`tin` d6d6e4c9): its heights come from three grids
  filled triangle by triangle (`tinGrid`), and only texels near walls and the water's
  edge read through the sampler. The texture is the same to 0.01; on the Pixel 5 it takes
  28 ms a tile (at most 83) instead of 174, and a tile's ground from its file 48 ms in
  all (at most 145). The sampler no longer reads kerbs as steps (it had laid a band
  0.6 m wide along every kerb at the kerb line's height); the road check didn't change.
  In the game, before and after from above and at street level (Vítězná, the head of
  Most Legií, Kampa; `docs/evidence/tin/shading`, local), nothing on the ground
  changes: the pixels that differ are the moving traffic, people and water.
- 17 November 2026: the ten trial places on the mesh (`tin` 654b8b34). Each place is a
  window build of `praha` (the city pass on 5 × 5 tiles, the tile pass on the middle
  3 × 3), with and without the LiDAR, checked against the lattice of the same build.

  Without the LiDAR the mesh is the lattice again on the streets, at all ten: within
  0.3 m of the LiDAR 92.1 → 92.2 %, steps over 0.25 m 41 → 38, twisting over 12 %
  87 → 83, bridge joins over 1 m 18 → 18, everything else within a street or two.

  With it, the first mesh broke the bridges' ends: joins over 0.5 m / 1 m went from
  24 / 13 to 41 / 27. The LiDAR and IPR's dense model are both bare earth, OSM ends
  bridges a few metres short of their abutments, and the city pass keeps a street's last
  metres at the deck's height there (`END_CLEAR`); the mesh took them down to the
  ground under the deck, 3–4.5 m at the ends of Hlávkův most, Čechův most and 5. května
  over Hvězdova. Elsewhere the LiDAR had a hole 4 m deep in Československého exilu, and
  Sekaninova is drawn across a wall that both the LiDAR and the dense model have.

  Where the LiDAR is more than 0.5 m off the city pass, the surface now takes the city
  pass in two cases (`AGREE`, `held_ground` in `tin_tiles.py`):
  - where IPR's dense model doesn't bear the LiDAR out either (the hole);
  - on each such patch that reaches a face in the LiDAR (a rise of 1 m within a metre)
    across the middle of a car street, or of any street or path within 8 m of a bridge's
    outline, out to 15 m from the face (the bridge ends, Sekaninova).
  A patch with no such face keeps the LiDAR: those are the city pass's own mistakes, like
  a pit 2 m deep in Národní inside Most Legií's outline. Taking the city pass wherever
  the two disagreed, tried first, lost most of the LiDAR's gain and kept that pit. The
  tile is worked out with a 20 m margin, so neighbouring tiles decide alike.

  | The ten places, with the LiDAR | Lattice | First mesh | Mesh |
  |---|---|---|---|
  | Carriageway within 0.3 m of the LiDAR | 99.35 % | 99.51 % | 99.49 % |
  | Bridge joins over 0.5 / 1 m | 24 / 13 | 41 / 27 | 24 / 13 |
  | Bridge breaks over 1 m | 6 | 6 | 6 |
  | Steps over 0.25 / 1 m | 27 / 7 | 33 / 11 | 29 / 7 |
  | Bumps over 0.15 / 0.5 m | 51 / 18 | 46 / 14 | 49 / 14 |
  | Streets leaning over 8 / 15 % | 83 / 48 | 87 / 41 | 90 / 41 |
  | Twisting over 5 / 12 % | 106 / 53 | 102 / 44 | 104 / 44 |
  | Line metres with a wave over 0.2 m (5 m either side) | 0.84 % | 0.71 % | 0.73 % |
  | Points a tile / mesh file a tile (gzip) | | 6,100 / 28.6 KB | 5,800 / 27.8 KB |

  2,330 car streets. The last column has three more mesh tiles at Vyšehrad. Its first
  build had a step of 1.29 m on Na Výtoni, which was the edge of the built area: the
  tile north of it had no mesh. Built too, nothing there steps over 0.25 m. The tiles
  are dense town, so they come out larger than the 40 random tiles' 8.5 KB.

  More streets lean over 8 % because the city pass levels car streets kerb to kerb and
  the mesh takes the LiDAR's own cross-fall: on the new ones (hillside streets at
  Vyšehrad, Malá Strana and round Československého exilu) the mesh is nowhere more than
  about half a metre off the LiDAR, on most within 0.2 m. Na Výtoni's right edge as drawn
  lies on a strip 1.5 m above the carriageway, which the lattice had levelled away. Two
  streets lean more where the rule holds the city pass only partly: U tržnice in the
  Italská place (11 %, the lattice 7.5 %, up to 2.8 m off the LiDAR) and Plachého in the
  Linhartova place (23 % against 1 %, beside a 5 m wall).

  `ujezd` again with the rule: within 0.3 m of the LiDAR 99.9 → 99.7 %, the lattice's
  figure (the bridge ends held at the deck, where the LiDAR has the ground under it),
  no step over 0.25 m (was 1), and Divadelní back to the lattice's 30 % lean across. Its
  cutting down to the car park under the theatre has its walls beside the street, not
  across it, but the dense model lacks the cutting too, so the first case takes the
  city pass there.

  In the game, lattice against mesh at the ten places, the hole at Československého
  exilu and Sekaninova, slanted and from above (`docs/evidence/tin/trial10`, local). From
  above the two are nearly the same, bridge ends and the hole included. The hill shade
  on the mesh shows small dips in the LiDAR's pavements as faint dark smudges
  (Československého exilu's east pavement). The first mesh shots at Vyšehrad had no
  ground and no buildings: its tiles, the heaviest of the ten (9,700 points a tile),
  weren't built yet when the picture was taken, with two game pages loading at once.
  They were there a few seconds later. Worth timing on the Pixel 5 before `praha`.

  Left: Divadelní, U tržnice and Plachého; 934 breakline pieces the game's triangulation
  can't keep and 677 samples over the tolerance over the 93 tiles, as on `ujezd`; the
  smudges; and from before, the white specks, Petřín's wall foot and the triangulation
  on the main thread. For `praha`, the tile pass takes 1–2 s a tile on one core, some
  4–8 hours for the city's 14,595 tiles, so it should run tiles in parallel first.

- 18 November 2026: `praha` on the mesh (`tin` 85e462ac, then 08bd746b, 6e0ebe29 and
  8ad13a20). The city pass (`ipr_terrain.py praha --tin --survey-scan`) took 36 minutes
  at 8.4 GB. The tile pass ran in nine processes: 1 h 45 min for the target, where the
  four slices with the dense centre ran 40 minutes past the other five (the target is
  now dealt out in runs of 32 tiles, 8ad13a20), and 46 minutes for the 14,595 tiles,
  6.7 hours of work in all. With `--keep-target` the tiles alone take 44 minutes.

  The meshes come to 132.5 MB, inside the 200 MB (the estimate was 124 MB): 29 million
  points, the median tile 1,200 points and 5 KB, the heaviest 25,000 points and 108 KB.
  The work folder holds 41 GB (the target 20 GB, the surface 21 GB). In the game's
  triangulation (`check-tin.mjs`) 12,859 breakline pieces are lost and 10,064 samples
  are over the tolerance, and a tile takes 1 ms at the median and 52 ms at most, in
  Node on the Mac.

  | `praha`, 57,188 car streets | Lattice | First mesh | Mesh |
  |---|---|---|---|
  | Carriageway within 0.3 m of the LiDAR | 99.1 % | 99.8 % | 99.6 % |
  | Off it by more than 1 m | 0.48 % | 0.09 % | 0.22 % |
  | Streets more than 2 m off it somewhere | 355 | 255 | 301 |
  | Bridge joins over 0.5 / 1 m | 243 / 120 | 455 / 150 | 291 / 121 |
  | Steps over 0.25 / 1 m | 185 / 5 | 597 / 35 | 432 / 21 |
  | Bumps over 0.15 / 0.5 m | 1,246 / 216 | 1,419 / 201 | 1,441 / 213 |
  | Streets leaning over 8 / 15 % | 1,956 / 891 | 3,398 / 1,282 | 3,134 / 1,004 |
  | Twisting over 5 / 12 % | 1,951 / 664 | 3,407 / 919 | 3,238 / 755 |
  | Ridge or trough over 0.3 / 1 m | 490 / 79 | 946 / 78 | 645 / 73 |
  | Streets with a wave over 0.3 m (2 m either side) | 681 | 1,200 | 975 |
  | Line metres with a wave over 0.2 m (5 m either side) | 0.53 % | 0.52 % | 0.53 % |

  The first mesh, with the rule from the ten places, fitted the LiDAR better than the
  lattice, but across the city it made more streets step, lean and twist, and missed
  nearly twice as many bridge ends. The ten places, all in the centre, hadn't shown it.
  Three causes, each now a rule in `tin_tiles.py`:
  - Roads on something neither model has. The map calls the road ground, and the
    survey has it 5–8 m over the bare earth that the LiDAR and IPR's dense model share:
    a motorway at the city's north-east edge (50.1336, 14.6361), Pražský okruh at
    50.0476, 14.2727. The mesh took them down to the ground. Where a car street's middle
    has the city pass more than 3 m over the LiDAR, its patch keeps the city pass out to
    60 m, off paved ground too (the motorway's verges had fallen 8 m beside its held
    carriageways). Not near tunnels: the ramp down to Bubenečský tunel at 50.1136,
    14.4327 is in a cutting 6 m deep that both models have, and there the city pass,
    level at the top, is the one that's wrong.
  - Bridge ends with no wall. Most of the new bad joins were small bridges over streams
    and paths, with no face in the LiDAR to hold the city pass. Within 6 m of where a
    bridge's way comes down onto a way on the ground the city pass now holds, since the
    decks are the city pass's. At one of Jižní spojka's decks (50.0614, 14.4948) the
    lattice brings the street down a metre to the deck while the LiDAR has the road a
    metre higher: the deck may be low, which is for the city pass to fix.
  - Banks inside OSM's width. On narrow lanes the LiDAR has the bank or garden wall
    beside the lane inside the street as drawn, and lanes leaned 50–70 % (Na dražkách,
    K Housličkám, Na Kavčích horách); beside Revoluční by Kotva a ramp goes down under
    the street's edge. On a car street's carriageway the city pass now holds wherever
    the LiDAR parts from it by more than 0.5 m but the street's middle agrees: the city
    pass's streets are the LiDAR's own, level kerb to kerb.

  In the game, lattice against mesh at eight of these places, slanted and from above
  (`docs/evidence/tin/praha`, local). From above Na dražkách, Na Kavčích horách,
  K Housličkám, Revoluční and Jižní spojka look the same on both. Pražský okruh's slip
  road still sags and cracks beside the median on the mesh (the lattice cracks there
  too, less), and at the north-east motorway, where the LiDAR ends, the guardrails wave
  more.

  Left: steps over 0.25 m on 432 streets against the lattice's 185, most of them
  0.3–0.5 m on residential streets, where a bank reaches the lane's middle (Na dražkách
  still has 0.76 m) or a held patch meets the LiDAR; more streets leaning, twisting and
  with short waves than on the lattice, although the share of line metres with a wave
  is the same; Pražský okruh's slip road and the north-east motorway; the ramp to
  Bubenečský tunel (a 3 m step at the top of the cutting, where the lattice has the
  road level over it); and from before, the smudges, the white specks, Petřín's wall
  foot, the triangulation on the main thread and the heavy tiles on the Pixel 5. The
  bridges and tunnels branch (`claude/elated-noyce-c84e2c`, 18 November) changes what
  the city pass writes for tunnels and bridge outlines, so `praha`'s city pass and tile
  pass would be built again after it is merged.

- 18 November 2026, later: the bridges and tunnels work merged into `tin` (e6f2d4fc, from
  `claude/elated-noyce-c84e2c`, with main up to 6886d48d) and `praha` built again: the
  station hall's chunk, IPR's buildings, the city pass (18 minutes) and the tile pass (the
  target 61 minutes now that it is dealt out in runs, the tiles 61), 132.5 MB as before.
  The drive-through scenario passes on the mesh: the Strahov tunnel both ways, Wilsonova
  past the station both ways, and at Bulhar no slab over the carriageways (decks within
  0.6 m). From above, the slab at Bulhar and the hall over Wilsonova are gone.

  | `praha` | Lattice before | Lattice after | Mesh before | Mesh after |
  |---|---|---|---|---|
  | Bridge joins over 0.5 / 1 m | 243 / 120 | 238 / 113 | 291 / 121 | 285 / 113 |
  | Steps over 0.25 / 1 m | 185 / 5 | 178 / 6 | 432 / 21 | 437 / 27 |
  | Ridge or trough over 1 m | 79 | 77 | 73 | 66 |
  | Leaning over 15 % | 891 | 886 | 1,004 | 996 |
  | Off the LiDAR by more than 1 m | 0.48 % | 0.48 % | 0.22 % | 0.19 % |

  The six new steps over 1 m on the mesh are at the Řepy D0 interchange (50.0753,
  14.2895), where the ground beside the bridge lies flat at 331.2 m, 6 m under the bank
  the LiDAR and IPR's model have, with bridge-end terraces at 338 m in it. It isn't the
  merge: main's map of 16 November and the bridges worktree's have the same pit and
  terraces, and the pre-merge code builds them from today's inputs too. The `tin` build
  of 17 November didn't have it, for a reason in its inputs not yet found. On the
  lattice the streets there ride on the terraces; the mesh takes the LiDAR on them and
  meets the pit. The four river bridges over the join limit (Palackého, Mánesův, Čechův,
  Štefánikův) are as before. Pictures in `docs/evidence/tin/praha-merged` (local).

- 18 November 2026, evening: the steps the mesh had and the lattice hadn't (`tin`
  a54d602d and the commit after it). Most came from a carriageway taking each sample's
  height from whichever source won there: the LiDAR, the city pass, or IPR's dense model
  near any face in the LiDAR (a kerb's or a parked car's edge too; on Nad Lávkou the dense
  model lies 1.4 m over the road the other two agree on), with short blends between
  sources 0.5–1 m apart. A car street's carriageway on the ground is now the city pass
  (the LiDAR's own street, level kerb to kerb) plus the LiDAR's offsets from it where they
  are small, smoothed along the road over 2 m. Where the LiDAR is further off and the
  dense model bears it out, the city pass is wrong (Pod Stárkou) and the road takes the
  LiDAR; where it doesn't, it's a bank or a ramp inside OSM's width and the road round it
  says. Stretches more than 2.5 m off along the road (decks, cuttings) keep the old rules,
  and the offset fades out over 12 m before a bridge's landing: the decks are the city
  pass's, and the first city-wide run left 21 more joins over 0.5 m (Jižní spojka,
  5. května, 0.2 → 0.6 m). Only the tile pass changed (47 minutes with `--keep-target`).

  | `praha` | Lattice | Mesh before | Mesh after |
  |---|---|---|---|
  | Steps over 0.25 / 1 m | 178 / 6 | 437 / 27 | 202 / 20 |
  | Bumps over 0.5 m | 214 | 210 | 164 |
  | Leaning over 15 % | 886 | 996 | 840 |
  | Twisting over 12 % | 662 | 744 | 575 |
  | Waves over 0.3 m (2 m) | 675 | 971 | 575 |
  | Bridge joins over 0.5 / 1 m | 238 / 113 | 285 / 113 | 269 / 113 |
  | Carriageway within 0.3 m of the LiDAR | 99.1 % | 99.6 % | 99.6 % |

  The drive-through scenario passes. Streets more than 0.3 m off the LiDAR somewhere rose
  (1,859 → 2,342; over 2 m fell, 294 → 267): the road now keeps the city pass where the
  LiDAR has a small bank inside OSM's width. Of the 20 steps over 1 m left, seven are at
  the Řepy interchange (the pit), and most of the rest are motorways the map calls ground
  and tunnel ramps: Bubenečský tunel's (3.1 m), the north-east motorway, D8 at
  50.1724, 14.4571. Also V Lázních, Ostřicová and K Celinám (a wall's terrace), K Přehradám
  by its bridge and Patočkova by the Strahov tunnel. Most of the 0.25–1 m ones are short
  steps of 0.3–0.5 m on residential streets (Nad Kovárnou, Schwankova, Na Vidouli). From above: the 2.35 m pit across the trunk road by Zbraslav (49.9423,
  14.3674) is gone, and so are the folds in 5. května's median. Pictures in
  `docs/evidence/tin/steps` (local).
