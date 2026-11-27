---
read_when: Changing inferred benches, bins or courtyard planters, OSM's mapped street furniture, their tile-worker placement, collision or rendering.
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

The overhead benches, bins and planters use 108, 36 and 84 triangles. At pedestrian
height the bench has chamfered timber slats on cast supports, the litter basket has a
recessed liner, and individual sprays of leaves rise from the planter. Each kind uses one
draw per populated tile. The survey's standing hydrants and phone boxes are left out: the
standing model looked American, and Prague's hydrants are mostly underground (their
covers are drawn with the street's ironwork); nearly all its phone boxes were removed in
the early 2020s. The kinds have names (`KIND` in `src/map/furniture.ts`). Switching cameras reuses the instance placements. The street models share a
single surface atlas, loaded on first use in the street view.

The worker stamps the solid footprints into the existing collision grid before
parking. There is no new per-frame placement, physics pass or post-index scan.
Furniture is static and cannot be knocked over. `&nofurniture` disables generation
and collision for baseline comparisons; hiding meshes only measures rendering cost.

## Mapped street furniture

Along the streets the furniture is OpenStreetMap's, where it stands on the map:
litter bins, benches, bike stands, pay-and-display machines, bollards, post boxes,
recycling containers, street cabinets, advertising columns, poster cases, drinking
fountains and Stolpersteine (`pipeline/build_street_furniture.py` → `street-furniture.json`,
about 64,000 items in `praha`; `src/mappedFurniture.ts`). Inferred park benches and bins
within 12 m of a mapped one of the same kind are left out. Stolpersteine lie flat and
stop nobody (`FLAT_FURNITURE`). A bike stand of `capacity` n becomes a row of
n/2 inverted Us; a collection point one container per kind it takes, in Prague's
colours (green and white glass bells, blue paper, yellow plastic, orange cartons, grey
metal); a mapped row of bollards one every 1.6 m. The pipeline turns each item square to
the nearest mapped way, its local +z towards it. The main thread loads the file with the
lamp survey's three-second deadline and hands each tile the items whose points are in
it; the land worker leaves out those inside a building or on the game's carriageway
(`mappedSpots`, `src/map/furniture.ts`). A post box mapped within 1.2 m of a building
hangs on its wall instead of standing on a post. They share the furniture kinds'
instancing, collision and overhead blocks; the models are in `src/furnitureModels.ts`.
Without the file a map has only the inferred furniture.

A surveyed tree standing in paving (no mapped green under it, and a road within 7 m or a
paved square round it) gets a flat cast-iron grate round its foot (`treeGrates`).

The one-way streets have their signs, inferred from the streets traffic drives (OSM has
almost no `traffic_sign` points): where one ends at a junction, a no-entry sign on the
right of whoever would turn in against it, facing them; where it starts, a one-way sign
facing the traffic turning in (`oneWaySigns`). Only ordinary town streets (secondary
down to living streets, at least 15 m long, between junctions of three or more ways);
a sign that lands on the game's carriageway moves out to the kerb.

Run `node scripts/check-furniture.mjs` for deterministic placement, seams, clearance,
slopes and density. With Vite running, `node scripts/check-furniture-browser.mjs
http://localhost:5203/` exercises real raster exclusions, land-worker transfer,
collision, shared models and instance disposal in Chrome. The usual typecheck/build
remain applicable. The camera and map
provenance of the initial visual check are in the local working records (`docs/evidence/`).
