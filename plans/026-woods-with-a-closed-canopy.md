---
read_when: Changing how woods are filled with trees (src/map/vegetation.ts), the woodland floor's colour (src/ground.ts, src/groundSeason.ts), the tree meshes or their batching (plans 009 and 017), or what a wood looks like from the helicopter.
---

# Plan 026: Woods with a closed canopy

From above, a wood in the game is separate round crowns with lit green ground
between them and a ruler-straight edge. A real one is a closed, dark, uneven roof of
leaves with conifers mixed in and a ragged edge of shrubs and young trees.

## Status and starting point

- Status: STEPS 0–4 AND THE EDGE BLEND DONE (steps 0–3 merged into main on 5 October 2026; step 4 and the
  edge blend from branch `plan-026-young-woods` merged the same day; not deployed; the local `praha` map was rebuilt with the
  young layer on 5 October 2026). A phone check is still open (see "Left open").
- Priority: P2. Effort: three to five days. Risk: medium (woods already hold most of
  the trees in view on the city's edge).
- Category: feature (map look). Dependencies: none. Overlaps plan 017 (cheaper trees
  on phones) and plan 009 (tree batches): re-read both before changing meshes.
- Planned at: `364e7f3cac31a9aedb4a64f8c0b1ac9563258990`, 4 October 2026, from the
  aerial comparison (places 50.12522, 14.30214; 50.15677, 14.38949; 50.09156,
  14.35117; 49.95898, 14.54310) and from reading the code. Nothing was measured.
- Confidence: high that a darker floor and a soft edge help at no cost; unknown
  whether more or bigger crowns are affordable.

Before editing run `git status --short` and:

```sh
git diff --stat 364e7f3cac31a9aedb4a64f8c0b1ac9563258990..HEAD -- src/map/vegetation.ts src/ground.ts src/groundSeason.ts
```

## Current state

- **The scatter** (`src/map/vegetation.ts`, about line 101): a spot every 4.5 m,
  62 % kept, crown radius 3–6.2 m, 30 % conifers (`CONIFERS[0]`). That is about one
  tree per 33 m² with a mean crown of about 66 m², so crowns should overlap; the gaps
  seen from above come from the jitter leaving holes and from small crowns landing
  next to each other.
- **The floor** is `COLORS.wood` `#52703c` (`src/ground.ts`), a mid green that reads
  as sunlit grass through every gap. `WOOD_SEASON` tints it toward leaf litter from
  November to March only.
- **The edge** is the wood polygon's outline: trees stop on a line, and the ground
  changes colour on the same line.
- **Height** is one tree shape scaled by radius; a photo shows a rough surface with
  taller trees standing out.
- **What is a wood** comes from OSM and the technical map (`wood`, `dtm_wood`). At
  49.95898, 14.54310 a young plantation is drawn as full-grown wood; at 50.09156,
  14.35117 the real wood is larger than the mapped one. This plan does not fix the
  outlines.

## Design

1. **A dark floor.** Under a wood the ground is in shade all summer: a darker, browner
   floor colour in leaf, with the existing litter tint in winter. No geometry, one
   colour in `groundSeason.ts`. This alone closes most gaps to the eye.
2. **Fill the holes rather than add trees everywhere.** Place trees on a jittered
   grid as now, then a second pass that adds a tree only where no crown covers the
   spot (the scatter already has a `crowded` test for gardens). Aim: no more than
   10–15 % more trees.
3. **Uneven heights.** Scale height separately from radius, with a slow noise over
   the wood so that stands of taller trees form, and the odd emergent.
4. **Conifers in stands.** Choose conifer or broadleaf from low-frequency noise, not
   per tree, so a wood has dark conifer patches as in the photos. Keep the overall
   share.
5. **A ragged edge.** Within 8 m inside the outline, thin the trees with noise and
   make them smaller; within 6 m outside it (where the neighbour is grass, a field or
   a garden, never paving or a road), add shrubs and a few small trees. Blend the
   floor colour over the same band.
6. **Young woods.** Where the surface model shows a canopy under 6 m over a mapped
   wood (inside the city only), use small trees. Optional; leave it if step 0 shows
   few such places.

## Steps

0. **Count**: trees, triangles and draw calls in view over three woods (Divoká
   Šárka's edge, Kunratický les, the wood at 50.12522, 14.30214), from the ground and
   from the helicopter, with `scripts/bench.mjs`. Record the share of ground pixels
   visible through the canopy in a top-down picture (threshold on the floor colour).
1. Floor colour (item 1). Pictures before and after, summer and winter.
2. Hole filling and uneven heights (2, 3). Repeat the count; stop if frame time on
   the phone tier worsens by more than a few per cent and report.
3. Stands and edge (4, 5).
4. Young woods (6), if worth it.

## Out of scope

Correcting wood outlines against the photos, undergrowth you can walk through, new
tree meshes.

## What was built (4 October 2026, branch `plan-026-woods` from `af66875`)

- **Step 0, counts** (desktop, summer, 13:00, clear; trees within 100 m of the view
  centre, broadleaf + conifer): Šárka (50.1047, 14.3157) 596 + 270; Kunratický les
  (50.0187, 14.4770) 633 + 271; wood at 50.12522, 14.3037 640 + 267. Triangles in
  the top-down view: 4.1 M, 4.6 M, 3.3 M, of which 0.1–0.2 M are not trees. Lit
  floor visible through the canopy (pixels that do not change when the trees are
  hidden, so lit ground only): 14 %, 12 %, 16 %. The woods are already dense; the
  gaps are mostly a floor problem. Winter is not comparable with this method.
- **Step 1, floor** (`2c72c0f`): `COLORS.wood` and `woodBase` are `#394a2b` (were
  `#52703c`). The winter litter colour is unchanged. `scripts/check-ground-season.mjs`
  passes. Top-down summer pictures show the gaps as shade instead of lit grass.
- **Steps 2 and 3** (`1d8c7a5`, `src/map/vegetation.ts`): conifer stands from noise
  with a share near 30 %; height scaled apart from radius by noise plus 4 % emergents;
  a thinner, smaller and lower band 8 m inside the outline; a gap pass on a 3.4 m
  lattice that adds a small tree where no crown covers a spot (about 10 % more
  trees in the wood, as counted per tile); shrubs and a few young trees within 6 m
  outside the outline over grass, garden, park or field (fields are now painted
  into the tree raster, value 40). Counts after: 534 + 368, 647 + 204, 508 + 393 near
  the same centres (total within +5 % to −6 %); top-down triangles 4.4 M, 4.1 M,
  3.3 M.
- **Frame time**: `scripts/bench.mjs --scenes woods --vs` (baseline `af66875`, M5
  desktop, Chrome/WebGPU): median 5.5 ms before, 5.6 ms after over three alternating
  pairs. Two earlier series were swamped by other sessions' load (one pair read
  32 fps against 176) and prove nothing. The phone tier was not measured; the tree
  count and triangles are within a few per cent of before, so no change is expected.

## What was built (5 October 2026, branch `plan-026-young-woods` from `12c65c5`)

- **Step 4, young woods.** `pipeline/young_woods.py` (new layer `young`, polygons per tile,
  put into the tile as `areas.young_wood` by `layers.assemble`): inside a mapped wood, where
  IPR's 1 m surface model minus the terrain gives a canopy top (80th percentile over 9 m)
  between 1.5 and 7 m, in patches of at least 250 m2. `survey` over the city: 986 ha of
  12,831 ha of wood (7.7 %), in 3,103 tiles of 14,595. A trial block (tiles 30–42 × 60–72
  around Divoká Šárka) was built into this worktree's own data: 86 tiles with a wood, 65
  with a young one. In the game, `treeInstances` leaves such an area out of the usual wood
  scatter and gap pass and plants a thicket instead (3.4 m lattice, crown radius 1.3–2.6 m,
  height 0.55–0.8 of the usual, thinner towards the outline). Seven unit tests
  (`pipeline/test_young_woods.py`); the full pipeline suite (153 tests) and `npm run typecheck`
  pass. `code_key()` leaves `young_woods.py` out, like `ground_cover.py`, so changing it does
  not invalidate the other layers. Triangles in a top-down view over a young wood
  (50.0988, 14.3296, 120 m high): 3.29 M with the change, 3.23 M before.
- **Edge blend** (`woodEdges` in `src/ground.ts`): two soft shade bands (the existing
  `shade()` skirts, 6 m wide, at most 0.5 dark; no new shader code, so WebGL and WebGPU
  both get it). One runs along wood outlines where the floor shows and the neighbour is not
  wood; the other along the outlines of park, meadow, lawn and garden where wood floor
  shows on the other side (a park is often drawn over a wood's floor, so its outline is the
  visible edge; the first version, drawn only at the wood outline, was hidden under the park
  at Šárka). Woods under 1,500 m2 and the tile border are left out; the two bands do not
  stack on one edge. Pictures: `/tmp/p026b/woods-edge-sarka-*` (not in git).
- **Frame time** (`scripts/bench.mjs --vs`, M5, Chrome/WebGPU, 10 s a scene, alternating,
  three or four pairs, baseline `12c65c5`): Petřín woods 4.5 ms baseline, 4.8 ms with the change
  (one pair read 207 against 233 fps, and the spread between runs is as large); Old Town
  Square 3.8 against 3.5 ms; Šárka at 160 m high, order reversed, four pairs: 4.2 against 4.2 ms.
  The scenes are CPU-bound at about 4 ms and the GPU time is not reported, so a software
  rendering run (`--angle swiftshader --dpr 1`, Šárka, two pairs) was added to see the
  cost of covered pixels: 525 ms baseline, 493 ms with the change. No measurable cost, so the
  blend stays. The phone tier was not measured.

## What was built (6 October 2026, branch `night-maplook`)

- **Clearings.** `pipeline/young_woods.py` also writes clearings: patches of 400 m2 or more
  inside a mapped wood where the surface model has nothing above 1.5 m **and** IPR's summer
  photo shows open ground (brightness over 0.42 averaged over 9 m, saturation over 0.11, so
  not a canopy with its shadows and not grey rock, asphalt or gravel), on ground under
  35 degrees steep. They are the young layer's `clear` tiles; `layers.assemble` puts them
  into the tile as `areas.wood_clearing`. The game draws unmown grass there over the wood
  floor (`src/ground.ts`) and leaves it out of the wood scatter; only the shrubs and odd
  young trees of a wood's edge stand round its rim (`src/map/vegetation.ts`).
- **Why the photo.** The first rule used the surface model alone and was wrong for most of
  what it found: over many closed stands (Divoká Šárka above all) IPR's surface model lies
  at ground level, so whole tiles of tall forest read as bare (55 of 72 tiles had a
  "clearing", 5 ha in one tile). The same fault must make some of the *young* woods false
  (tall forest read as 1.5 to 7 m); that rule was not changed here, see "Left open".
- **Checked against the photo** on three blocks in the worktree's own data (Šárka, tiles
  28–36 × 66–73; Kunratický les, 68–75 × 31–37; the wood at 50.125, 14.304, 19–26 × 78–84):
  134 tiles with a wood, 43 with a clearing, 14 ha of 528 ha of wood. The 22 clearings
  looked at over the photo are all open ground: fields and meadows that lie inside a wood's
  outline (the largest, 3.9 ha at 50.0983, 14.3267, is a mown field), an orchard, real
  clearings in Kunratický les, a strip between a wood and a field, one patch of bare earth
  by a building site (drawn as grass). No closed forest, rock face, road or pond.
- **Tile borders of the patches.** A young wood or clearing that goes on in the next tile
  now reaches the border (it stopped a metre short: a dark line across a clearing).
  The two tiles still work their patches out separately, so an outline can jog by a few
  metres at a border.
- **The extra small trees along tile borders are gone** (`src/map/woodScatter.ts`): the
  wood, young-wood and gap passes run on a lattice fixed to the map with a seed per cell,
  and each tile also works out the crowns 8 m past its edge (the wood taken to go on there),
  uses them when it fills the gaps and drops them before drawing. Every wood's trees moved;
  the density is unchanged (1,985 trees in a 250 m tile of wood). `scripts/check-wood-seams.mjs`
  checks that a tile expects exactly the trees its neighbour plants beside the border, that
  none is planted twice and that a strip along the border is as dense as the wood elsewhere.
- **To show in the shared map:** `uv run --group cover young_woods.py build praha` (it
  assembles at the end). 5,287 tiles have a wood; the trial ran at 0.4 to 0.8 s a tile with
  six jobs including fetching the photos, so allow about an hour, plus three to four minutes
  for the assemble. Until it is run, assemble ignores the layer made by the old code, and
  the young woods are missing too.

### Left open

- Check on a phone (Pixel 5), and whether more or bigger crowns are affordable.
- The young layer was built for the whole city in the local `praha` map on 5 October 2026
  (`uv run --group cover young_woods.py build praha`, then assemble); it is not deployed.
- Young woods still rest on the surface model alone, which reads some tall closed forest as
  low (see above): compare a sample with the photo as was done for the clearings, and
  require a photo signal there too. Many "woods" are drawn under park or meadow, so there the young planting shows as
  small, dense trees on a meadow, not as a thicket on a wood floor.
- The shrubs of the ragged edge are still placed per tile (fewer of them right at a tile
  border, where the tile cannot see the neighbour's wood).
