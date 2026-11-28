# 040: Knockable street furniture, our own physics (option A)

Status: PHASE 1 BUILT (28 November 2026) on branch `knockable-furniture`, unmerged.
Option B, the same thing with Rapier, is [041](041-knockable-furniture-rapier.md).
We're trying this one first because it's smaller and adds no dependency.

## What changes for the player

Bins, recycling containers, benches and poster cases stop behaving like house
walls. Drive into one slowly and you're stopped, as today. Hit one fast enough and it
comes loose: it flies, tumbles and skids along the road or the pavement, then comes to
rest on its side, upside down or upright, however it happens to land. The car loses
speed according to the piece's mass and how firmly it was fixed down. A light bin barely
slows you, a bench ripped out of its bolts does. A piece that is already lying loose
just gets shoved or knocked along again.

## How furniture works today

- The tile worker writes every piece of furniture that isn't flat into the tile's
  collision grid as solid cells (`src/tileWorker.ts`, the `solid` list before
  `stampTrunks`). To a car, a bench is a wall.
- Lamp posts and wire poles live in `src/posts.ts` as circles. Hit one harder than its
  `tough` and it falls (a scripted fall, `fall()`), while the car keeps `1 - give` of
  its speed.
- Each tile draws its furniture as one `InstancedMesh` per kind
  (`src/furniture.ts`). The instance order is the order of the tile's `spots` for that
  kind.
- The physical car handling (`src/physicalHandling.ts`) and the rollover code are a
  hand-written rigid body with points that touch the ground, the same kind of simulation
  a tumbling bin needs.

## Design

**Cells that can be freed.** The worker writes furniture into the grid as before, but
also records which cells only knockable pieces made solid: cell index → what the cell
was and which pieces cover it (`looseCells`, built like `trunkCells`). A cell is freed
once every piece covering it has come loose. A cell also made solid by a wall, a post
or a trunk isn't in the map. When a piece is
knocked loose, its cells are cleared on the main thread, so nothing changes in the
pipeline or the map data.

**Standing pieces** (`src/looseFurniture.ts`). On the main thread each tile registers
its knockable pieces in a spatial hash: a rotated box per piece, made 0.15 m larger
on each side to match the margin the grid was written with. In `Car.move`, before the
grid is checked, a car's box is tested against nearby standing pieces. If it closes on
one faster than the piece's `tough`, the piece comes loose: its cells are cleared and it
becomes a body. Otherwise nothing happens here and the grid stops the car as today.

**Bodies.** A body is a rigid box, sized from its street model's bounding box, with a
mass and an inertia tensor. It's simulated in three.js's frame (Y up), so the result
goes straight into the instance matrix.
- Each step applies gravity and then contacts at the box's eight corners against the
  ground under them (`world.surfaceAt` on the level of the car that hit it). The contacts
  are sequential impulses with restitution and Coulomb friction, plus a small position
  correction. Fixed substeps of 1/120 s.
- A body that moves into a solid grid cell (a wall, a tree, a post) bounces back off
  it horizontally. It passes through furniture that's still standing (knocking that on
  is phase 3).
- After half a second below about 0.15 m/s it goes to sleep and costs nothing until
  something hits it again.
- No more than 48 bodies are awake at once. When that's exceeded, the oldest goes to sleep
  where it is.

**The car and a body.** Each substep a car's box is tested against nearby bodies. The
contact normal runs from the car to the body. The impulse is
`j = (1 + e) · vn / (1/M + 1/m)`: the body takes `j/m` along the normal plus a little
lift and spin, and the car takes `j/M`. The first knock off its fixings also costs the
car `give` of its closing speed, as with the posts. The blow is reported as a crash (`crash()`:
kind `post` for a bin or a poster case, `rail` for a steel container, `fence` for a
bench), so sound and debris come from code we already have.

**Drawing.** A loose piece stays in its tile's instanced mesh: its instance matrix is
rewritten each frame while the piece moves, and the mesh's bounding sphere is enlarged
once so the piece isn't culled when it leaves its spot. The same matrix works for the
overhead and street models, so both cameras show it with no extra draw calls.

**Lifetime.** Where pieces end up is remembered while the tile is loaded. A tile that
unloads and loads again has its furniture back in place (the worker writes it again).

## Kinds

| Kind | Mass | Comes loose above | Speed lost to the fixings |
|---|---|---|---|
| Bin (`bin`) | 25 kg | 2.5 m/s | 0.05 |
| 1100 l container (`plastic`, `paper`, `cartons`, `metal`) | 70 kg | 2 m/s | 0 (on castors) |
| Bench (`bench`) | 90 kg | 5 m/s | 0.15 |
| Poster case (`posterCase`) | 45 kg | 4 m/s | 0.1 |

Later phases: bike stands, parking machines and cabinets (heavy, bolted down), glass
bells (about 150 kg, throwing broken glass). Bollards, planters, advertising columns,
fountains and wall post boxes stay fixed.

## Phases

1. **Car hits, bodies tumble.** DONE. The kinds above, hit by any car (traffic hits them
   rarely). Cells freed, bodies simulated and drawn in both views, crash events.
   `scenarios/furniture-knock.ts` (`t.piece()` in the test kit aims a car at one) hits a
   bin and a bench at 50 km/h and a container at 40, on Vodičkova and nearby. Results
   on 28 November: the car keeps about 50 km/h after a bin and 43 after a bench. The
   bin goes 11–17 m, the bench 9–14 m, the container about 13 m, and each comes to rest
   on its side, its back or upright, however it lands. Cost: about 0.02 ms a frame for
   each moving piece. No poster case was found with a clear run up in the scenario's
   places, so that kind is untested in a scene.
2. **Material and mess.** Sounds for each material (a plastic container, a timber
   bench), bins spilling litter (`streetLitter.ts`), glass bells shattering, lids
   swinging open, castors that roll. The heavier kinds.
3. **People and other cars.** Kicking things on foot, people walking round fallen
   pieces, bodies hitting parked cars and each other, police and traffic going round them.

## Risks

- **Cars sticking.** If a body is pushed into the car's box from the side the car may
  stick to it. Bodies are always pushed out of the car, never the car out of a body.
- **Ground under the box.** On a bridge the level comes from the car that hit the piece,
  and a body that falls off a bridge isn't followed down. That's rare, and accepted for
  phase 1.
- **Cost.** Sleeping bodies cost nothing. The car-vs-piece test is a hash lookup per
  substep, as the posts already do.
