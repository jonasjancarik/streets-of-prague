---
read_when: Changing how far tiles are loaded or drawn, splitting a tile's simulation data from its meshes in src/tiles.ts, or investigating pop-in when zooming out or flying.
---

# Plan 016: Draw only nearby tiles

A tile is loaded whole today: its collision grid, street graph and parked cars, and
also its ground, buildings, trees, walls and wires. The simulation needs the first
set out to about 300 m; the screen shows about 110 × 70 m. Keep the simulation's
radius and make a tile's meshes only when it comes near the view.

## Status and starting point

- Status: PLANNED.
- Priority: P1. Effort: three to five days. Risk: medium (tile lifetime, pop-in,
  and code that assumes a loaded tile has meshes).
- Category: performance (scene size, GPU memory, work on tile arrival).
  Dependencies: none; touches the same file as plans 009 and 012.
- Planned at: `1b5756cdf775c7fbde3e5522fb57de5658664bcf`, 1 October 2026, from reading
  the code only. Nothing was run or measured while planning.
- Confidence: high that the scene shrinks several-fold; unknown how much frame time
  that buys, since off-screen tiles are already frustum-culled. Step 1 measures it.

Before editing run `git status --short` and:

```sh
git diff --stat 1b5756cdf775c7fbde3e5522fb57de5658664bcf..HEAD -- src/tiles.ts src/tileWorker.ts src/tileWorkers.ts src/trees.ts src/main.ts scripts/check-streaming.mjs
```

Branch changes, commits, pushes and deployment need separate authorization.

## Current state

- `src/main.ts` (around line 1553): `world.update(camPos.x, -camPos.z, viewRadius() + 220)`.
  `viewRadius()` is about 80 m at the walking height of 100 m (field of view 38°), so
  tiles are loaded within about 300 m. Tiles are 250 m square, which makes roughly
  15–20 loaded tiles for a view that touches one to four.
- `LIFE_RADIUS = 330` in `main.ts` is how far traffic and people are kept. They need
  the collision grid, the levels (bridges and tunnels), the terrain heights, the
  street graphs, the posts and fences, and the parked cars of every tile in reach.
- `TileWorld.make()` in `src/tiles.ts` does everything in one go: four worker jobs
  (`ground`, `land`, `ipr`, `roofs`), then `sky`, then on the main thread the level
  masks, `Surfaces` (up to about 31 ground layers, each a mesh and a material),
  building meshes, walls, fences, wires, landmarks, the tree lease, and parking.
- Each of those meshes sits in the scene and is visited by the renderer's culling in
  the main pass, the shadow pass and the lamps' light-map render. Their geometry and
  textures are uploaded when first drawn, not when added.
- The sun's shadow camera is fitted to the view (`fitShadow` in `main.ts`), so it
  needs casters only a little beyond the screen (a low sun reaches further).
- Zooming changes `height` (`view: (z) => …` near line 1861; the test camera goes
  from 5 to 1,500 m), and the helicopter moves fast. Both widen or move the view
  quickly.

## Design

Two radii in `TileWorld.update()`:

- **Simulated** (as now, `viewRadius() + 220`): the tile's data. Terrain heights and
  hill-shading samples, collision grid and levels, street graph edges, posts, fence
  sections, parked cars, water and roads for lookups, and the sky view's building
  outlines (`shapes`), which neighbouring tiles' sky jobs need.
- **Drawn** (`viewRadius() + D`): the tile's meshes. Ground surfaces and their
  textures, buildings, walls, fence rows, wires, landmarks, the depth-only ground, the
  tree pages, and the sky-view texture.

Start with `D` large enough that a tile is drawn before it can reach the screen at
the fastest travel speed, given the measured time to dress a tile; step 1 supplies
both numbers. A small extra margin on the keep side (as `update()` already has for
dropping) stops a tile at the edge from being dressed and undressed repeatedly.

Split `make()` into two stages:

1. `make()` keeps the `land` job (cells, trees' positions for trunks) and whatever
   parking and collision need, and produces a tile with `group: null`.
2. `dress(tile)` runs the `ground`, `ipr`, `roofs` and `sky` jobs and the mesh
   assembly, then attaches the group and leases the tree pages. `undress(tile)`
   disposes them and returns the pages, leaving the simulation data.

Open questions to settle while implementing, in this order:

- **What the simulated stage really needs from the workers.** `land` returns the
  cells, trees, walls and fences together; the collision grid needs the trees
  (trunks are stamped into it) and fence sections. Either keep `land` whole and hold
  its arrays until dressing, or split it. Holding the arrays is simpler; check the
  memory it costs across 15–20 tiles.
- **Parked cars are drawn everywhere** (cars aren't culled, and parking runs in
  `make()`). They stay in the simulated stage. A car parked on a tile whose ground
  isn't drawn is off-screen by construction; confirm with the margin chosen.
- **The inputs for dressing** (the tile's JSON, the IPR buffer) must be kept or
  fetched again. The IPR buffer is transferred to a worker and can't be used twice:
  keep the fetched files until the tile is dressed, and refetch (from the HTTP cache)
  if a tile is dressed a second time.
- **Lamps, signals and tram stops** come from the street graph, not from the tile's
  group; they keep their own radii.

## Scope

In scope: `src/tiles.ts`, `src/tileWorker.ts` and `src/tileWorkers.ts` if `land` is
split, `src/trees.ts` only for leasing at dress time, the one `world.update` call and
start-up `loadNow` calls in `src/main.ts`, `scripts/check-streaming.mjs`,
`scripts/bench-stalls.js` counters, `README.md`, `todo.md`, this plan and its row.

Out of scope: tile size, the map data format, level-of-detail meshes for far tiles,
culling within a tile, and the simulation's radius.

## Implementation steps

### 1. Count what the far tiles cost

With measurement authorized, record on `stand` and `drive`: loaded tiles, scene
objects in tile groups, how many are on screen, GPU buffers and textures alive, the
time from a tile entering the load radius to being usable, and the main-thread laps
of `make()` (`tile.ms`). Then try the cheapest experiment: hide (`group.visible =
false`) every tile whose box is more than a margin outside the view, toggled with
`--ab`. That bounds the steady-state gain from a smaller scene without any
restructuring.

**Stop here** if hiding far tiles makes no measurable difference to frame time and
the memory and arrival-work numbers don't justify the change on their own. Record the
numbers and close the plan.

### 2. Split a tile into data and meshes

Introduce `dress`/`undress` as above with `D` set so that every loaded tile is still
dressed at once. Behaviour must be identical to today.

**Verify:** `npm run typecheck`; `check-streaming.mjs`, `check-tree-pool.mjs` and the
scene scenarios pass; screenshots match.

### 3. Dress by distance

Add the drawn radius to `update()`. Required dressing jobs (a tile entering the drawn
radius) go ahead of optional work in the worker queue, as plan 012 A's scheduler does
for required tiles. `loadNow()` at start-up and after a teleport dresses what the
view needs before it returns.

**Verify:** no undrawn ground on screen during the `drive` route, a helicopter flight
at top speed, and a zoom from the closest to the furthest view; count frames in which
a tile in view was undressed (must be zero in the first two; state the result for the
zoom). Shadows at a low sun (07:00 and 19:00) show no missing casters at the screen's
edge.

### 4. Check lifetime and memory

Drive out and back over the same blocks, and a long route through new districts.
Buffers, textures and tree pages must return to their starting counts after
undressing; nothing may be disposed twice. Compare frame time, tile arrival time and
hitches against the baseline with alternating runs.

## Done criteria and stop conditions

Done when the simulation behaves as before (same parked-car hash, traffic and people
counts), far tiles hold no meshes, no undrawn ground appears in the three movement
tests, and resource counts are stable over repeated trips.

Stop and report if dressing a tile takes so long that `D` has to approach the
simulated radius to avoid pop-in (then the split buys nothing), if splitting `land`
changes the collision grid, or if hitches get worse because dressing now happens
closer to the player. In that last case consider dressing ahead along the direction
of travel before giving up.

Report scene-size and memory changes separately from frame time.

## Result

Not started.
