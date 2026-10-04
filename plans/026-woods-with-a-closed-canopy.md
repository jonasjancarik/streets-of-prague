---
read_when: Changing how woods are filled with trees (src/map/vegetation.ts), the woodland floor's colour (src/ground.ts, src/groundSeason.ts), the tree meshes or their batching (plans 009 and 017), or what a wood looks like from the helicopter.
---

# Plan 026: Woods with a closed canopy

From above, a wood in the game is separate round crowns with lit green ground
between them and a ruler-straight edge. A real one is a closed, dark, uneven roof of
leaves with conifers mixed in and a ragged edge of shrubs and young trees.

## Status and starting point

- Status: STEPS 0–3 DONE on branch `plan-026-woods` (not merged or deployed). Step 4
  (young woods) not done; the floor colour is not blended over the edge band (see
  "What was built").
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

### Left open

- Blending the floor colour over the edge band (design item 5, last sentence): the
  wood floor is a flat polygon colour with the pattern in the ground shader, so a
  soft edge needs a shader or a mesh change. From above the ruler-straight change
  from dark floor to grass remains; the new shrubs and small trees cover part of it.
- Step 4 (young woods from the surface model): not started.
- Trees stop at the tile edge for the gap and edge passes (each tile only sees its own
  trees), so there can be a few extra small trees along a tile border.
- Check on a phone (Pixel 5) and whether more or bigger crowns are affordable.
