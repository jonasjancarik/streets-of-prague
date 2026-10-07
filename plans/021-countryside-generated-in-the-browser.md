---
read_when: Changing what happens at the edge of the map, how tiles are found and loaded (src/tiles.ts, src/tileWorker.ts), the OSM-only path of the map pipeline (pipeline/osm_area.py, pipeline/build_tiles.py), or adding another source of map data to the browser.
---

# Plan 021: Countryside generated in the browser

The map ends at the edge of a 34 × 26 km rectangle around Prague. Carry on past it
with tiles the browser makes itself from OpenStreetMap as the player drives out:
plainer than the city, not hosted by us, and joined to the built map without a step
in the road.

## Status and starting point

- Status: IN PROGRESS (steps 1 to 3 are done apart from what the Result lists as owed;
  hills, bridges and tunnels are not started).
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

**Step 1, the prototype, 4 October 2026** (`?countryside`; `src/countryside.ts`,
`src/countrysideWorker.ts`, `src/countrysideTiles.ts`, `scripts/check-countryside.mjs`).

- Source: a Protomaps extract of central Bohemia at zoom 15, 297 MB, at
  `public/data/countryside/central-bohemia.pmtiles` (local only; `VITE_COUNTRYSIDE_URL`
  points elsewhere). All of Czechia is 1.7 GB. Made with
  `pmtiles extract https://build.protomaps.com/<date>.pmtiles <out> --bbox=13.40,49.50,15.60,50.65 --maxzoom=15`.
- Protomaps' layers differ from the OpenMapTiles ones this plan lists: roads carry the
  OSM highway value, one-way, bridge and tunnel flags and names, but no surface;
  buildings a height but not their kind; single trees come as points of interest.
- Making a tile takes the worker under 1 ms once its vector tiles are read and 15–45 ms
  when it reads new ones (headless Chrome on the M5; Node gives the same). Building the
  tile afterwards took 170–360 ms against 140–220 ms for the built map's outer ring, so
  the generator is not what limits streaming. Not measured on a phone, and not by
  driving out at speed in real time.
- The ground has no step at the edge (0 m over 200 points), and a car drives out of the
  built map without noticing.
- **The built map's streets do not stop at the rectangle**, as this plan assumed: each
  runs on to its next junction, up to 250 m outside. Generated streets are cut at the
  rectangle, so for that stretch both exist and the two graphs are not connected.
  Step 2 should match junctions by position (a built street's outer end against the
  generated junction there) and drop the generated streets a built one already covers,
  rather than snap road ends on the rectangle's edge.
- Left out, as planned: hills, bridges and tunnels as levels, lamps, traffic and people
  densities of their own, place names, the map view, saves outside the rectangle.
  Also: streets are overlapping rectangles and octagons rather than one outline, so
  nothing may draw a kerb along them; building parts are skipped; a building wider
  than 12 m past a vector tile's edge may come out twice or not at all.

**Step 2, the join for roads, 6 October 2026** (`src/countrysideJoin.ts`, and changes in
`src/countryside.ts`, the worker and `scripts/check-countryside.mjs`; still behind
`?countryside`).

- The built map's streets run on past the edge to their next junction: 267 drive edges
  and 344 walking edges in `praha`, half of them under 110 m, the longest 5.2 km (a
  motorway). Out there the built street stands alone. A generated street lying on one
  (every 3 m of it within 3 m) leaves that graph, and is dropped when it is in neither;
  the generated junction within 10 m of the built street's outer end takes the built
  junction's id and place, its streets bending to it over 30 m and starting as wide as
  the built street of the same class. Where the vector tiles have no junction there,
  the generated street passing within 4 m is split. The countryside tile lists the
  built edge itself (same id, so the graphs take it once, through the same
  `drive.add` and `walk.add` as any tile) and lays its surface from the edge on, kerb
  to kerb as inside.
- Which streets leave comes from the built map's rim tiles, read by the worker when a
  vector tile within 6 km of the edge is first made (about fifty small JSON files for
  the first, a few for each one after). No new map file and no rebuild. Before this
  leaves the flag the pipeline should write that list into one file.
- Two faults of step 1 found on the way: a road's point lying on another road that has
  no point there made no junction (now it does), and generated edge ids could equal a
  built edge's between the same two junctions (they now start with `c`).
- `node scripts/check-countryside.mjs` (about two minutes; `--places` lists where main
  roads leave) makes the 1,290 countryside tiles those streets pass through and asserts:
  118 of 123 outer ends of built streets lead on into generated streets, and 263 of 286
  on foot (the rest are dead ends, or streets OpenStreetMap has changed since); no
  generated street doubles a built one for cars, three paths do on foot; no junction
  stands twice; routes cross the edge both ways at 16 main roads, four on each side,
  and on foot; the ground's step at the edge is 0 m over 30,748 shared grid points.
  242 generated drive edges and 171 walking ones start at the edge with no built street
  to carry on from: mostly streets the built map cuts off there itself.
- Heights: the countryside is still flat outwards from the built map's edge, so the
  seam has no step. One built street leaves the map on a bridge or in a tunnel
  (a level of its own); the countryside has no levels, so that one will step.
- Pictures from above at K Nádraží (west), Pražská (east), Zdibsko (north) and Slepá
  (south) show the roads carrying on. A first set of three came out as cars on bare
  ground: they were taken a second and a half of game time after a far jump, before
  the tiles had been drawn; waiting for the tile and a few real seconds gives the
  ground (`World.loaded` has the tile, its JSON has roads).
- Owed: a scenario that drives out and back on an arterial road (the test API has no
  way to follow a road yet, and a scenario run without `?countryside` has nothing to
  check); the phone. On the Pixel 5 measure the time the
  worker takes for the first tile near the edge (it reads the rim tiles), for a tile
  whose vector tiles are new and for one whose are known, the requests and bytes for a
  ten-minute drive out, and whether the road ahead is there at 130 km/h.
- Steps 3 to 6 are not started.

**After step 2, 7 October 2026: what it had left, and a fault the scenario found.**

- **The map does not fill its tile grid.** `praha` is 34,543 × 26,195 m, and its last
  column and row of tiles are built only that far: 207 m short of the grid's edge to
  the east, 55 m to the north. Steps 1 and 2 took the grid's edge for the map's, so
  those strips were nothing (no ground; a car driving out north or east stopped
  there), and the check, which used the same wrong edge, passed. Now the generator
  takes `index.size`, makes the rest of each of those last tiles, and the game puts
  the built part and the countryside part together as one tile
  (`CountrysideTiles.whole`). With the right edge 949 edges leave the map (406 drive,
  543 walk); 173 of 181 outer ends lead on by car and 402 of 438 on foot; streets
  starting at the edge with nothing to carry on from fell from 242 to 141 (drive)
  and 171 to 28 (walk).
- **`leaving.json`**: `pipeline/layers.py` writes the streets that run on past the
  map's edge into one file (praha: 385 kB before compression) and sets `leaving` in
  `index.json`; the worker reads that once. A map without it keeps reading its rim
  tiles (up to 7 km along the rim from a vector tile). The check makes 262 tiles both
  ways and they are the same tiles. **The shared map has no `leaving.json` yet**: run
  `pipeline/.venv/bin/python pipeline/layers.py praha` (assembly only) to write it;
  until then the fallback is used.
- **Scenario `countryside-edge`** (`node scripts/scene.mjs run countryside-edge --extra
  "&countryside"`): finds a route out along Zdibsko and one back (781 m and 784 m),
  drives a car out and back in along them; the ground under it never changes by more
  than 0.1 m in a sixth of a second and it strays 0.3 m (out) and 3.4 m (back) from
  the line. The test kit got `t.route`, `t.follow` and `t.countryside`. Scenarios that
  need the countryside skip themselves when the game was opened without it.
- A second generated junction within 1.5 m of a built street's end (a road cut at a
  vector tile's edge a pace from its junction) is now the same junction.
- The street graphs take and forget countryside tiles through the same calls as built
  ones (checked: a built street carried by both stays while either is loaded).

**Step 3, behaviour outside, 7 October 2026.**

- **Traffic**: past the map the hour's count of cars is multiplied by how much street
  there is within 330 m against a city district's (`streetShare`, `src/network.ts`;
  10 km of lanes, main roads counting more: Beroun's centre 1.0, a village 0.10, a
  lane between fields 0.02). Scenario `countryside-traffic`: 45 cars at Karlovo
  náměstí at 16:00, 4 in a village, 3 among fields.
- **People**: busyness past the footfall map's edge goes by the share of the tile's
  ground that is built on (0.01 at full: the map's own outer ring averages 0.0016
  where a tenth to a fifth is built on), instead of the map's outermost cell carried
  on outwards; and the 40 people who are about anywhere fall to a tenth among fields
  and woods. 19 people in the village, 11 among fields.
- **Taxis and police** work on the generated roads (`countryside-taxi`: an app taxi
  ordered 600 m past the edge comes, and drives you back into the map on the way to
  Letná; `countryside-police`: two stars bring two police cars). The taxi told
  "streets still loading" from "the map ends" by the built map's list of tiles; it now
  asks whether a tile is there at all. Fares' destinations are the fixed list of
  places inside the map. The game has no missions and no map view to adapt.
- **The title**: outside the city's parts, the town or village you come into, from the
  vector tiles three zooms out (a village's name within 900 m of its middle, a town's
  within 2.2 km). It names the villages of the built map's outer ring too.
- **Starts and saves**: the first load waits for the countryside's file, so `?start=`
  or a save past the map finds its tiles (checked with `?start`). A save from out
  there opened without the countryside goes back to the nearest edge of the map (not
  run in a browser: the scene runner never resumes a save).
- **No connection**: with the file missing the game loads and the map ends where it
  always did (checked with a wrong `VITE_COUNTRYSIDE_URL`). If the connection goes
  mid-game, a countryside tile is tried again every two seconds and the road ahead
  stays unloaded, as at the edge of what has loaded. One of the map's partly built
  last tiles read at that moment keeps only its built part until it is read again.
- **The limit**: no tiles further than 150 km from the middle of the map (the file of
  central Bohemia ends well inside that).
- Not done from step 3: credits in the game for Protomaps (wanted once this leaves the
  flag; the README names it), and the phone measurement (the list under step 2).
