# 041: Knockable street furniture with Rapier (option B)

Status: PROPOSED (28 November 2026). The alternative to [040](040-knockable-furniture-own-physics.md),
which is being tried first. Pick this up if 040's own simulation turns out too limited:
pieces that should stack, pieces hitting pieces, or ragdolls.

## What changes for the player

The same as 040. On top of that, pieces knock into each other and pile up, a
container can trap a bin against a wall, and pieces hit by a car can hit parked cars.
Most of the difference shows in third person and at eye level. From above the two
options look nearly the same.

## Cost

[Rapier](https://rapier.rs) 0.21 (`@dimforge/rapier3d`, measured 28 November 2026):

| | Raw | Gzip |
|---|---|---|
| `rapier_wasm3d_bg.wasm` | 3.1 MB | 1.17 MB |
| `@dimforge/rapier3d-compat` (the wasm inlined in JS) | 4.3 MB | 1.65 MB |

Use the non-compat package with Vite's wasm support (or `vite-plugin-wasm`), so the
wasm arrives as its own cacheable file. It's loaded the first time a piece comes loose,
not at start: the first knock plays its sound and debris at once, and the body starts
moving once the module is ready (a few hundred milliseconds on a phone the first time).
The Cloudflare Worker serves `.wasm` as static assets. Check its MIME type.

## Design

**What stays as it is.** The collision grid, posts and fences stay the authority for
cars. Cars are not Rapier bodies: the physical handling and the arcade cars stay ours.
Rapier simulates only the loose pieces and a static world built around them.

**Static world, only where needed.** Rapier must know the ground, kerbs and walls
round any piece that is moving. Rather than mirroring whole tiles, build colliders on
demand in a 24 m patch round each awake body:
- the ground as a `heightfield` collider sampled from `world.surfaceAt` at 0.5 m (bridge
  decks: a second heightfield on the body's level),
- walls as `cuboid` colliders from the grid's solid cells, merged into runs of cells
  row by row (a few dozen boxes for a street corner),
- other standing furniture and parked cars as kinematic cuboids, moved each frame
  from their own positions.
A patch is built when a body wakes inside an area that has none, kept while any
body is awake there, and freed 10 s after the last one sleeps. The patch must be rebuilt
when its tile unloads or when a standing piece in it comes loose.

**The car in Rapier.** Each car near an awake body gets a kinematic cuboid, moved to
the car's pose before each Rapier step. Rapier's contact events give the impulse on
the body. The car gets its share back by momentum (`j/M`, as in 040), applied in
`Car.move` from the contacts of the previous step. Kinematic bodies never feel a
force, so this exchange is ours to write in both options.

**Coming loose.** As in 040: `looseCells` from the worker, a standing piece's box
tested in `Car.move`, cells cleared when it comes loose, `tough`/`give`/mass per kind.
The body is created in Rapier with the car's velocity transfer as its start velocity.

**Stepping.** `world.step()` at a fixed 60 Hz with the default 4 solver iterations,
run from the main loop only while a body is awake. Rapier's own sleeping does the rest.
Measure the cost on the Pixel 5 profile with 40 awake bodies. Budget: under 1 ms.

**Drawing.** As in 040: the tile's instance matrix is written from the Rapier body's
translation and rotation, converted from Rapier's Y-up frame, which is the same as
three.js's.

## Extra work compared with 040

- The dependency, the async loader and its failure path (no wasm: pieces stay walls).
- Building patch colliders from the grid and the heights, and keeping them right as tiles stream
  in and out (the hardest part, and where most of the bugs would be).
- Kinematic proxies for cars and standing furniture, kept in step with the game.
- Two simulations next to each other for the player's car with physical handling: ours
  for the car, Rapier for the pieces, joined only by our momentum exchange.
- Tests: a scene that knocks pieces into a wall corner and into each other.

## What it gains

- Pieces hitting pieces and stacking, which 040 doesn't attempt.
- Proper box contact (edges and faces, not eight corners), so a bench rests flat on
  its slats and doesn't tilt on a corner.
- A base for ragdolls of people hit by cars, and for loose loads falling off vans.

## Phases

1. The loader, the patch world, and a bin and a bench knocked by the player's car.
2. All of 040's phase 1 kinds, cars and parked cars as proxies, crash events.
3. 040's phases 2 and 3.
