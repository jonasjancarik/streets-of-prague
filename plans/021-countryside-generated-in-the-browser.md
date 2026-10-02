---
read_when: Changing what happens at the edge of the map, how tiles are found and loaded (src/tiles.ts, src/tileWorker.ts), the OSM-only path of the map pipeline (pipeline/osm_area.py, pipeline/build_tiles.py), or adding another source of map data to the browser.
---

# Plan 021: Countryside generated in the browser

The map ends at the edge of a 34 × 26 km rectangle around Prague. Carry on past it
with tiles the browser makes itself from OpenStreetMap as the player drives out:
plainer than the city, not hosted by us, and joined to the built map without a step
in the road.

## Status and starting point

- Status: PLANNED (step 1 is a prototype that decides whether the rest goes ahead).
- Priority: P3. Effort: about a week for the prototype, three to five weeks in all.
  Risk: medium to high (a second map builder to keep in step with the pipeline, and
  two outside services the game would lean on).
- Category: feature (map). Dependencies: none. Touches `src/tiles.ts`, as plan 016
  does; plan 020's offline map download would not cover the generated part.
- Planned at: `23947baee0a87ada2c4bebb011018d9f6de444cd`, 2 October 2026, from reading
  the code and one tile of the local `praha` map. Nothing was run or measured, and
  the outside services named below were not checked while planning.
- Confidence: high that roads, ground and buildings can be made in a worker from
  vector tiles; unknown how long a tile takes on a phone, how good the roads look
  with widths guessed from the road class, and how the join behaves where OSM has
  changed since the map was built.

Before editing run `git status --short` and:

```sh
git diff --stat 23947baee0a87ada2c4bebb011018d9f6de444cd..HEAD -- src/tiles.ts src/tileWorker.ts src/tileWorkers.ts src/contracts.ts src/terrain.ts pipeline/osm_area.py pipeline/build_tiles.py
```

Branch changes, commits, pushes and deployment need separate authorization.

## Current state

- **The map is a fixed grid.** `index.json` lists every tile (`praha`: 139 × 105
  tiles of 250 m, 14,595 in all, 655 MB on disk). `World` keeps them in `available`
  (`src/tiles.ts` 309), and `around()` (585–598) skips any key that isn't there, so
  nothing is ever requested past the rectangle. What the car, traffic, people and the
  camera do on reaching the edge was not checked; step 0 records it.
- **The outer part is already OSM only.** The rectangle is Prague's administrative
  bounding box, and the city's outline leaves wide strips inside it that IPR doesn't
  cover. There the buildings are extruded from OSM footprints with guessed heights
  (`_guess_height` in `pipeline/osm_area.py`), street surfaces reach out to the kerb
  "as OSM suggests" (`road_width`), and the terrain "carries on flat at the height of
  the nearest ground IPR has" (README, Known issues). Tile `0_0` is a field, one
  tertiary road and no height data to speak of (a 103-byte `height.bin.gz`). So the
  drop in quality happens inside today's map, and the generated tiles continue that
  outer ring.
- **A tile's JSON is finished geometry**, in metres: `areas` (polygons by kind:
  `field`, `water`…), `lots`, `roads` (polygons by surface), `buildings`, `walls`,
  `fences`, `rails`, `passages`, `weirs`, `crossings`, `trees`, the street graphs
  `drive` and `walk` (edges with `id`, `u`, `v`, `hw`, `name`, `oneway`, `lanes`,
  `maxspeed`, `width`, `bridge`, `surface`, `pts`) and `sections` (paid parking).
  Beside it: `height.bin.gz` (a 63 × 63 grid, 4.03 m apart, sharing its outer points
  with the neighbours since 2026-09-29), and where present `ipr.bin.gz` and
  `levels.bin.gz`.
- **The browser already does the meshing.** `src/tileWorker.ts` turns that JSON into
  buffers (`ground`, `land`, `roofs`, `ipr`, `sky` jobs; `src/map/buildings.ts`,
  `src/ground.ts`, `src/map/vegetation.ts`). What it doesn't do is the step before:
  widening centre lines into street polygons, cutting them out of the land use,
  clipping to the tile, building the graphs. That is Python with shapely and osmnx
  (`pipeline/osm_area.py`, 679 lines; `pipeline/build_tiles.py`, 529).
- **Coordinates** are a transverse Mercator projection centred on the area's box
  (`osm_area.py` 124–128), origin `[17313.84, 13069.33]` for `praha`. Its scale error
  is about 0.01 % at 100 km. `proj4` is already a dependency.
- **City-wide layers stop at the rectangle**: tram lines, metro, buses, lamps,
  signals, footfall, districts, parking, bikes, landmarks.
- **OSM data comes through Overpass** at build time (`osmnx`, with a mirror for when
  `overpass-api.de` refuses, `use_overpass_mirror`).

## Design

### Where the data comes from

Not Overpass from every player's browser: the public servers are slow, limit each
address, and their operators ask applications not to do this. Vector map tiles
instead, in the OpenMapTiles layout, which carry at zoom 14:

- `transportation`: class (motorway … track, path), `oneway`, `surface`
  (paved/unpaved), `brunnel` (bridge/tunnel), `layer`, `ramp`; `transportation_name`
  for street names;
- `building` with `render_height` where OSM has a height or storeys;
- `landuse`, `landcover` (wood, grass, farmland), `water`, `waterway`, `park`.

A zoom-14 tile at Prague's latitude is about 1.57 km across with 4,096 steps, so
points are 0.4 m apart: enough for this. One of them covers about forty of the
game's tiles, so it is fetched once and kept while the player is near.

What they lack compared with the pipeline's Overpass data: the number of lanes,
speed limits, exact surface (cobbles), parking lanes, traffic lights, crossings,
single trees, walls and fences, building passages. Widths and speeds come from the
road class; the rest is left out.

Two ways to get them, decided in step 0:

1. **A public service** (OpenFreeMap is the candidate): nothing to host, but the game
   depends on someone else's uptime and goodwill.
2. **One file of our own** in R2, read by range requests (a Protomaps extract of
   Czechia or of central Bohemia): about a gigabyte of static storage, no server, and
   it stays the same until we replace it. Its layers are named differently from
   OpenMapTiles, so choose before writing the reader.

Either way the map data stays out of the repository and the build, which is the aim.
Prefer the second unless the first's terms clearly welcome a game.

### A generator in the tile worker

New `src/countryside.ts` (no three.js, no DOM), run as one more job in
`src/tileWorker.ts`: given a tile's `i, j` and box, it returns the same `TileJSON`
the pipeline writes plus a height grid, and from there the existing jobs mesh it as
they do any tile. Everything downstream (collision grid, street graphs, traffic,
parked cars, people, names) then works without knowing where the tile came from.

Per tile:

1. Fetch and decode the vector tiles under the box plus a margin of one road width.
2. Project to the game's metres with the same transverse Mercator as the pipeline.
3. **Roads**: join the centre lines, give each a width from its class (the table in
   `road_width`), offset them into polygons, unite them, clip to the box → `roads`.
   Bridges and tunnels keep their flag; nothing is built for them yet (see Terrain).
4. **Graphs**: split the lines at shared points into edges → `drive` (and `walk` from
   paths, footways and the sides of minor roads), with ids made from the rounded
   coordinates of their ends so that the same edge gets the same id in both tiles it
   crosses.
5. **Land**: land use and cover minus the roads → `areas`; water and waterways.
6. **Buildings**: footprints with `render_height`, or `_guess_height`'s rule ported.
7. **Trees**: none in the data; scatter them in woods and along nothing else, from a
   seed made of the tile key, so a tile looks the same each time it is made.

Offsetting and uniting polygons needs a library (a Clipper port or
`polygon-clipping`), and decoding needs a vector-tile reader and, for our own file,
the PMTiles reader. Each new dependency gets the usual health check. Keep the
generator's tables (widths by class, guessed heights) in one file that names the
Python function each one mirrors, so a change to the pipeline's OSM-only look has an
obvious second place to go.

### Finding tiles past the rectangle

`World.around()` asks only for `available` keys. Add a second kind: any key outside
`0 ≤ i < cols, 0 ≤ j < rows` is a countryside tile, built by the generator instead of
fetched. Keys with negative `i` or `j` work as strings; `byIndex` uses
`i * 65536 + j`, which stays unique for |j| < 32,768 but should get an offset so that
negative numbers are plainly safe. Check every other user of `cols`, `rows`, the
index's `size` and `bbox_wgs84` (the map view, spawn points, `footfall.png` lookups,
districts, the hill shading's neighbours) for an assumption that the world ends.

A limit on how far out to go (say 150 km from the centre) keeps the 32-bit
coordinates the GPU works with accurate to a few centimetres; further needs the
world's origin to move with the player, which is out of scope.

### Terrain

OSM has no heights. In order of ambition:

1. **Flat**, at the height the built map has at the nearest point of its edge
   (what the outer ring does already). The prototype stops here.
2. **Real hills** from free elevation tiles (the Terrarium set in AWS's open data,
   about 30 m between points), sampled onto the 63 × 63 grid. Roads then need the
   ground levelled across their width, which the city gets from IPR's surveyed
   terrain and the countryside would have to do itself: smooth the height along each
   road's centre line and pull the grid towards it within the road's width.
3. **Bridges and tunnels** as `levels`, sloping evenly from end to end as the
   pipeline does for bridges IPR lacks. Until then a motorway bridge follows the
   valley floor, and tunnels are open cuttings.

### The join

Two things can put a step or a gap in the road at the rectangle's edge.

- **Height.** The built ring is flat at IPR's last height; real elevation outside
  will differ by tens of metres in places. Blend from the built map's edge height to
  the elevation data over the first 500 m outside, and make the first generated
  row's shared grid points copy the built tile's edge points exactly (the same rule
  the built tiles follow among themselves).
- **Roads.** The built map's edges were cut at the rectangle from an OSM snapshot of
  the day it was built; the vector tiles are from another day and have simplified
  shapes. For each built edge that ends on the rectangle's edge, find the generated
  road of a matching class within a few metres and move its first points onto the
  built end, tapering the width over 30 m. A built road with no partner ends in the
  field as it does today; a generated road with no partner starts at the edge.
  Record how many of each there are around the whole rectangle (step 2), since that
  number says whether this rule is enough.

Building the pipeline's outermost ring from the same vector tiles would remove the
mismatch, but changes the built map and is not part of this plan.

### What the countryside doesn't have

Trams, metro, buses, lamps (so nights are dark apart from headlights and windows),
traffic lights, paid parking, shared bikes, landmarks, districts, footfall counts.
Needed so the game still behaves:

- traffic and people get a density by road class and by how built-up the tile is
  (buildings' share of its area), in place of `footfall.png` and the traffic profile;
- taxi fares, missions and police keep working on generated roads, with pick-ups and
  destinations chosen only inside the built map to begin with;
- the HUD's district line shows the nearest town's name from the tiles' `place`
  layer, or nothing;
- saves store the position as now; loading one outside the rectangle has to wait for
  generated tiles in `World`'s first load;
- scenarios stay inside the built map, and `scripts/scene.mjs` gets no network
  dependence from this;
- with no connection (or the service down) the edge behaves as it does today.

Credits already name OpenStreetMap; add the tile service or Protomaps, and the
elevation data's sources if step 4 goes ahead.

## Steps

0. **Look before building** (half a day).
   - Drive to the edge in the current game and write down what happens to the car,
     the camera, traffic and people.
   - Read the terms and limits of the candidate tile service and of the elevation
     tiles, check both answer a browser on another origin, and size a Protomaps
     extract for Czechia. Choose the source.
   - Health-check the libraries (reader, polygon offsetting and union).
1. **Prototype** (about a week): the generator with roads, graphs, land, water and
   extruded buildings, flat terrain, for tiles outside the rectangle, behind
   `?countryside`. No join logic beyond what falls out. Measure the time to make a
   tile in the worker on the M5 and the Pixel 5, at town and open-country places, and
   drive out along a motorway at full speed to see whether tiles arrive in time (a
   new one every seven seconds at 130 km/h, plus those to either side).
   **Stop here** if a tile takes long enough that the road ahead is missing at
   speed and making tiles coarser doesn't fix it, or if the result looks too poor
   beside the built ring to be worth the join.
2. **The join for roads** (three to four days): matching and snapping at the edge,
   stable edge ids across tiles, the count of unmatched roads. A scenario that drives
   out and back in on one arterial road and checks the car's height never jumps and
   the route never breaks.
3. **Behaviour outside** (about a week): traffic and people densities, fares and
   police on generated roads, the map view, saves, the HUD's place name, the
   no-connection case, the distance limit.
4. **Hills** (about a week): elevation tiles, levelling under roads, the height
   blend at the edge, hill shading across the join.
5. **Bridges and tunnels** (three to five days), if step 4 shows they are missed.
6. Documentation: README (How it works, Known issues, Credits), `docs/versioning.md`
   if the generator gets a version of its own (a cached tile made by an older
   generator must not be mixed with a newer one's neighbours).

## Verification

- `npm run typecheck` and `npm run build`.
- `scripts/scene.mjs` scenarios for the drive out and back (step 2) and for a save
  loaded outside the rectangle (step 3); screenshots at the join by day and night,
  shown before and after.
- `scripts/bench.mjs` in real Chrome inside the city with and without the feature,
  to show the built map's frame times are unchanged, and at one town outside.
- The worker's time per generated tile, and the number of requests and bytes fetched
  for a ten-minute drive out, on desktop and on the Pixel 5.

## Alternatives considered

- **Run the existing pipeline on demand on a server** and cache its tiles: one code
  path and the full OSM tags, but it needs a server that is always up and Overpass
  behind it, which is what this idea set out to avoid.
- **Build a bigger rectangle** (all of central Bohemia): no new code, but several
  times today's 655 MB to host and to rebuild, and still an edge.
- **Soften the edge only** (fog, a turn-back, a toll gate): days, not weeks, and
  worth doing anyway if step 1 stops the plan.

## Result

Not started.
