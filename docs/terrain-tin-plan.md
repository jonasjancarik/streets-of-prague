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
