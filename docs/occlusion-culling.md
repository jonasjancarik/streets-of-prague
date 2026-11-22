---
read_when:
  - Working on occlusion culling, the visibility table or leaving out draws the buildings hide
  - Adding a step to the map pipeline that the game reads per tile at runtime
---

# Occlusion culling: plan

Written 22 November 2026, before any code, and reviewed the same day by Fable 5.2 and
GPT Astra 6.2 (see "Reviews" at the end; the order of work was changed after them).

## Why

At street level most of what the game draws can't be seen (performance log,
22 November):

- 87 % of the main pass's draws and 76 % of its triangles are hidden at eye height
  (median of 24 views); 84 % and 70 % from the driving seat.
- On the Pixel 5 (Medium, first person, standing on the Old Town Square) leaving out
  every hidden draw in that view made a frame 25 % quicker: 63 → 47 ms, JavaScript
  44 → 36 ms. The draws stayed in the sun's shadow pass. The phone is held back by
  three.js's JavaScript for each draw, so fewer draws is what helps.
- Leaving out only the ground beyond 250 m (`?farground`) gained nothing measurable:
  it removes triangles, not many draws.

## What there is to cull

In the street views (first person, third person, VR) the game draws the tiles within
400 m (`EYES_REACH` in `src/main.ts`). Tiles are 250 m squares; the whole city is 14,595
of them. Each loaded tile has a dozen or so meshes of its own (`TileMeshes` in
`src/tiles.ts`): the ground's layers (`surfaces`), the buildings and what is made with them
(`own`), landmarks. Most of them spread over the whole tile.

Trees, people, parked and moving cars, lamps and birds are drawn in pages shared between
tiles (instanced). The table below doesn't cover them; they stay as they are (or get a
per-instance check later).

## The plan in short

1. **A visibility table baked by the Python pipeline**, for the map that is built
   (`praha_now`): for each patch of the map, how high something has to stand in each
   square around it to be seen from there.
2. **The game uses it in the street views**: when the camera enters another patch, each
   tile mesh whose box is below that height in every square it covers leaves the main
   pass (it keeps casting shadows: it goes to the layer only the sun's shadow camera sees,
   as in the measurement).
3. **Occlusion queries as the fallback** where there is no table: the generated OSM
   countryside beyond the built map. Only after measuring how much is hidden there.

## The table

### Why the pipeline and not the browser

A table of mesh numbers would need the pipeline to know exactly how the game splits a tile
into meshes, which changes whenever the JavaScript does. A table of heights over squares
doesn't: it describes space, and the game tests whatever meshes it has against it. The
pipeline has the occluders already (building outlines and heights from OSM and IPR, the
surveyed terrain), runs with the map build, and versions its output with the tiles. A
bake in the browser would be exact for the meshes but needs headless Chrome and a GPU for
hours per city build, and still only samples points.

### What it stores

- **Patches** (where the camera is): 25 m squares, 100 per tile.
- **Squares** (what is seen): 62.5 m, 16 per tile, for every square within 400 m of
  the patch (164–169 squares, counted by GPT Astra 6.2).
- **For each patch and square: the lowest height (in metres above the map's datum,
  quantised to 1 m, one byte above the square's lowest ground) at which anything in that
  square can be seen from somewhere in the patch**, at any of the camera heights the
  street views use. "Never visible" and "always visible" get their own values.
- One file per tile (`tiles/<i>_<j>.vis.bin.gz`) for its 100 patches, loaded with the
  tile. Raw that is about 17 kB a tile (100 patches × ~166 squares), about
  243 MB for the city, mostly runs of "never" and "always" that compress well; the prototype measures
  the real size. Ways to shrink it if needed: store only patches on
  streets, paths and squares (the walk and drive graphs); coarser squares far away;
  delta coding between neighbouring patches.
- `index.json` gets `vis: { version, patch, square, reach, heights }`. A tile whose table
  doesn't match its data's build isn't culled.

### How it is computed

- **Occluders**: buildings as solid prisms from the ground up to their eaves (not the
  roof), outlines shrunk by 0.5 m, from IPR where it has the building, OSM otherwise;
  building parts that float (`minh` > 0) only from `minh` up; nothing below a passage's
  height where a passage runs through (`passages`); the terrain from the survey
  (`ipr_terrain.py`'s heights). Walls, bridges, trees and landmarks hide nothing. They are
  rasterised into a 1 m height grid over the patch's 400 m surroundings.
- **Eyes**: in each patch, its centre and four corners, at 1.5, 4 and 8 m above the
  ground there (on foot 1.75 m; the chase camera behind a car about 5 m, behind a bus
  about 7 m).
- **Sweep**: from each eye, rays out to 400 m (some thousands of them, so neighbouring
  rays are closer than the narrowest street gap at that distance), keeping the steepest
  slope over the obstacles so far; at each step the height a thing must reach to be seen
  is the eye's height plus that slope times the distance. Each square keeps the lowest
  value over all its steps, rays and eyes. numba, one tile's patches per job, the
  pipeline's usual `--resume` and chunks.
- **Margin**: what's seen from the eight neighbouring patches counts too (the runtime
  takes the lowest of the nine), so walking across a patch or a fast car between
  updates can't reveal anything the table missed by a few metres.

### Where it doesn't apply

The game culls only when the camera is in a street view, within 8 m of the ground below
it, inside the built map and in a tile with a matching table. Not in the overhead view,
the free camera, a helicopter in the air, on a bridge deck or terrace higher than that,
or in tunnels and the metro (which have their own views).

## In the game

- When a tile is drawn, its meshes' world boxes are worked out once.
- Each frame in a street view: find the camera's patch. When it changes (or a tile is
  drawn or dropped), take the lowest height of the nine patches for each square and
  test every loaded tile mesh: it leaves the main pass if, in each square its box
  covers, its top is below that height. Expected a few hundred tests per change, not
  per frame.
- Leaving out is a layer change (main camera off, shadow camera on), not `visible`, so
  shadows don't change. In VR (the WebGL renderer) it works the same.
- `?cull=0` turns it off for comparison; `?cull=show` tints what would be left out
  instead, for checking.

## Fallback: occlusion queries

For the countryside (no table). three.js r187 has queries on WebGPU
(`object.occlusionTest`); the results come a frame late, so a mesh hidden last frame is
drawn again for a frame when it might show (or kept drawn and only culled after a frame
or two hidden). Each query costs on the phone too, and the countryside has fewer
buildings to hide behind, so first measure what is hidden there (`scripts/hidden-draws.js`
with `&countryside`). The legacy WebGL renderer has no queries, so VR in the countryside
would stay as it is.

## Checks

1. **Nothing visible is left out**: at a few hundred street points (random, plus the 24
   views of the measurement), compare a picture with culling and without (game held
   still, as `hidden-draws.js` does). Any changed pixel is a failure to look at.
2. **No popping**: film a walk and a drive through narrow streets opening onto squares
   (Karlova → the Old Town Square, Celetná, Malá Strana), look for things appearing.
3. **Speed**: the Pixel 5 standing and driving (`bench.mjs --android`, `--ab` with
   `?cull` switched in the page), and VR.
4. **Bake**: time per tile, the whole city's size on disk, the download per tile.

## Order (after the reviews)

1. **Measure the ceiling this design can reach.** The 25 % on the Pixel 5 left out
   anything that changed no pixel, including the shared instanced pages and ground
   layers covered by other layers. Report the hidden draws by kind (tile ground, tile
   buildings, fixtures and furniture, landmarks, shared pages), then repeat the phone
   A/B with only the tile meshes allowed to go.
2. **If that is still worth it: a sweep in the game from the real camera**, behind
   `?cull`. Both reviewers point to it as at least the first prototype: the client has
   the outlines, heights, passages and terrain already; a sweep from the final camera
   position (both eyes in VR) is tighter than a table for a 75 m region, needs no bake,
   download or versioning, and covers the countryside too, which would make the query
   fallback unnecessary. A height grid per tile from the tile worker, the sweep in a
   worker, redone when the camera has moved more than the occluders were shrunk by.
3. **Score it against `hidden-draws.js`** over the 24 views and hand-picked hard places
   (lane mouths, passage ends, courtyard gates, the quays, the Hradčany slopes, the
   chase camera at corners, across Charles Bridge): what share of the truly hidden draws
   it catches, and anything it leaves out that isn't truly hidden (a failure).
4. **The Pixel 5 standing and driving, and VR**: draws, median and 95th-percentile
   frame time, the sweep's own cost.
5. **A table baked by the pipeline only if the sweep costs too much on the phone**, then
   with one eye height per camera kind, eyes on every walkable 1–2 m cell of a patch and
   a margin of a few metres rather than nine patches.

## Open questions

- Is a 2.5D sweep over a height grid good enough, or does something need real 3D
  (arcades, passages, overhangs, bridges over streets)?
- Patch and square sizes against the table's size and how much it culls.
- Are 1.5 / 4 / 8 m enough camera heights, and is the 8 m limit right for the chase
  camera behind a bus or a tram?
- Can a thin gap between buildings be missed by the rays, and how to make that safe
  (wider rays, eroding the occluders, more eyes)?
- How much do the shared instanced pages (trees, people, cars) matter once the tile
  meshes are culled, and should they be culled per instance on the GPU later?

## Reviews (22 November)

Both reviewers agree the class of solution is right (a decision on the CPU that moves
meshes between layers, so it removes three.js's per-draw JavaScript and works in WebGL VR
too), that GPU Hi-Z with indirect draws and occlusion queries don't fit (they don't remove
the JavaScript per draw, and WebGL VR has neither), and that portals don't suit an open
city. Where they differ and what they found:

- **Fable 5.2: sweep at runtime, not a bake.** A table for a 25 m patch plus its
  neighbours is a 75 m region, which in the Old Town spans several lanes and often a
  square, so much of the 87 % wouldn't survive; five eyes a patch is sampling, not a
  guarantee. The same 2.5D sweep from the camera's own point, in a worker, would be
  tighter and needs no table. Measure the shared pages' share first.
- **GPT Astra 6.2: bake, but prove the hidden part.** Sampled eyes and rays give no
  guarantee (a doorway can line up with a distant street from a sliver nobody sampled).
  Start from verified solid, convex walls and cull only boxes wholly in the region they
  hide from every eye in the camera volume. Try two bits a tile (ground, everything)
  before a height field. A software depth buffer of the resident blockers is the
  strongest alternative if conservative patches save too few draws. The table as planned
  is about 243 MB raw (164–169 squares a patch, not 400).
- **Both: the measured 25 % is too high for this design.** The harness could leave out
  shared pages and covered ground layers that the table can't. Measure with only tile
  meshes eligible.
- **One eye height is enough** for solid columns standing on the ground: raising the eye
  only lowers what has to be overcome, so the highest eye covers the lower ones (but
  costs the walker culling; one height per camera kind).
- **Use the final camera position**, not the player's: the chase camera is half the car
  plus 5.5 m behind and 1.9 m above the roof, it can be over a pavement or in a building
  at a corner, and `TileWorld.update` gets the position before the camera is placed. An
  eye inside an occluder culls nothing. In VR, both eyes.
- **Occluders must be known solid:** passages have no height in the data (`TilePassage`
  is `{hw, pts, w}`), so cut them out whole; arcades aren't gaps in the outlines; IPR's
  footprints can fall back to a convex hull and OSM buildings are replaced at 40 %
  overlap, so neither proves a wall; landmark-replaced buildings, floating parts and
  bridges hide nothing. `h` is the total height; eaves need IPR, or the lowest height
  over a footprint. Terrain could hide nothing at first (the drawn terrain differs from
  the survey at roads, underpasses and kerbs).
- **One box per mesh wastes most of the gain**: a tile mesh covers all 16 squares, so
  each mesh needs its own top per square (worked out when the tile is drawn), and real
  world boxes (buildings reach past their tile).
- **Streaming and other passes**: a tile drawn after the last update has to be tested on
  arrival, a blocker tile may still lack its wall (six meshes revealed per update), and
  the change of layers must keep the mirror's and probe's layer bits.
