---
read_when: Changing inferred benches, bins or courtyard planters, their tile-worker placement, collision or rendering.
---

# Park and courtyard furniture

The game adds sparse wooden benches and green bins beside mapped paths in parks
and gardens, and small stone planters in mapped courtyards. These are plausible
scenery inferred from land use, not a survey of actual furniture. Unmapped gaps,
forests, sports areas, parking and paved squares remain empty of these objects.

`src/map/furniture.ts` generates them once in the land tile worker, after trees.
Every candidate comes from a 14 m map-fixed lattice with its own seeded jitter.
Park/garden candidates have a 45% acceptance chance and need a nearby real
ground-level footway, path or pedestrian route; 22% are bins. Benches are moved to
1.9–2.2 m beyond the mapped path edge, facing the path; bins use a 1.7–2 m setback.
Projected points must stay in the middle 64% of their original lattice cell to
preserve spacing. Half-metre raster cells check the resulting footprint. Courtyards have
a 25% chance and receive only planters, including closed courtyards. All these
chances precede clearance rejection, so actual density is substantially lower.

The padded footprint must remain entirely on its supported surface. Road polygons
and mapped walk lines, all building footprints and landmarks, water, bridge/tunnel
structure outlines, fences, walls, passages, tree crowns and surveyed lamps exclude
placement. Building margins also keep scenery away from unrecorded doors. No point
sampled under the footprint may differ from its centre height by more than 16 cm.
Missing terrain or an unavailable lamp survey disables furniture. The survey fetch
has a three-second deadline and an abort signal; its cached outcome stays unchanged
for every tile in the world, even if a response arrives late. It cannot hold up map
loading indefinitely. Older maps without courtyard/park/path evidence receive no
invented substitutes.

Every square surface, including `square` for paving slabs, excludes furniture even
when it overlaps a park. Grass inside a named square depends on corrected surface
data: the pipeline must trim the general place outline around explicit green and
water, as in surface commit `5efe19e`. The furniture reader cannot distinguish those
outlines from explicit slab paving in the shared `square` field.

Candidates stay 12 m inside their tile, avoiding duplicate placements and overlaps
with tree crowns across seams without consulting neighbouring tiles. This leaves a
visible strip without inferred furniture at tile edges; it is a conservative tradeoff
until the pipeline supplies a stable halo of blockers. Placement is deterministic for
the same tile geometry, tree instances and map projection, regardless of load order.
It is not expected to stay identical across map rebuilds or a different area's origin.

`src/furniture.ts` shares three low-poly models and one vertex-colour material. Each
populated kind uses one instanced mesh per tile with static matrices, active upload
ranges, bounds and sun shadows. Models use 108/36/84 triangles for benches/bins/planters;
each object's matrix adds 64 bytes. Tile removal disposes its instance bindings while
preserving shared geometry and materials. First-use shader builds still occur for new
instanced meshes; no frame-time improvement or negligible GPU cost is claimed.

The worker stamps the solid footprints into the existing collision grid before
parking. There is no new per-frame placement, physics pass or post-index scan.
Furniture is static and cannot be knocked over. `&nofurniture` disables generation
and collision for baseline comparisons; hiding meshes only measures rendering cost.

Run `node scripts/check-furniture.mjs` for deterministic placement, seams, clearance,
slopes and density. With Vite running, `node scripts/check-furniture-browser.mjs
http://localhost:5203/` exercises real raster exclusions, land-worker transfer,
collision, shared models and instance disposal in Chrome. The usual typecheck/build
remain applicable. See `docs/overnight-furniture-results.md` for the camera and map
provenance of the initial visual check.
