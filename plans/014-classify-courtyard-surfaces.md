---
read_when: Planning a later orthophoto-based material pass for DTM courtyards, after plan 013 phases 1–3.
---

# Plan 014: Identify courtyard surfaces from aerial photos

## Status and starting point

IN PROGRESS (see "Result so far"). This is the deferred fourth phase of [plan 013](013-fill-the-beige-ground.md).
No photo download, classifier change, tile build or shared-data activation is part
of this plan's creation.

Update, 4 October 2026: the photo classifier now runs for the whole city on the
unmapped ground (`ground_cover.py build`, [docs/beige-cover-city.md](../docs/beige-cover-city.md)),
so the photos and the per-tile cache this plan wanted already exist for 5,772 tiles.
Courtyards are the remaining step: let the same rules also classify `dtm_yard` pixels
(the mask in `tile_cover` counts them as covered now) and test them on hand-checked yards.

After plan 013's isolated centre tile rebuild, `beige_report.py` measured 72.20 ha
of plain unmapped ground, down from 182.64 ha before the square and DTM changes.
The DTM now outlines yards (`dtm_yard`), but its `PrevazujiciPovrch` is usually
unknown. The game draws each yard with a neutral paved fallback until this plan
classifies its actual surface.

## Scope

Use the existing `pipeline/ground_cover.py` photo classifier as a starting point,
restricted to ground-level DTM courtyard polygons. Within each courtyard, identify
grass, trees, paving, asphalt, gravel and dirt where the evidence is convincing;
keep the neutral yard fallback for uncertain pieces. The DTM decides where the
yard is. OSM roads, buildings, squares, parks and paths keep precedence.

Start with a small set of exposed courtyards in Malá Strana and Nové Město, including
the matched plan-013 camera views. Measure class coverage and error cases before
deciding whether to fetch photos for all centre or city tiles. The old broad photo
prototype estimates a 16–65 GB full-city download; a citywide fetch is a separate
execution decision after the small-area result.

## Proposed steps

1. Extend `beige_report.py` or a focused companion report to measure DTM yard area
   remaining under the fallback, by area and district. Keep the pre-DTM plain-ground
   measurement comparable with plan 013.
2. Fetch colour and infrared photos only for a selected set of courtyard tiles into
   an isolated cache. Use the existing surface model and terrain to reject roofs,
   trees and other objects above the courtyard ground.
3. Clip the existing `rules` classifier's pieces to each `dtm_yard` footprint before
   assigning a material. Preserve the courtyard outline and retain the fallback
   where confidence is low or a source is unavailable. Do not turn an unavailable
   photo into an asphalt or grass decision.
4. Compare each class against hand-checked courtyard samples, then show matched
   above and low-angle images for the selected Malá Strana and Nové Město blocks.
   Record the accepted palette and any false roofs, glass covers or passage floors.
5. If the sample is sound, rebuild only isolated ground tiles in increasing area
   scope. Report bytes per tile, coverage, rendering calls and frame-time comparisons
   before considering shared asset activation.

## Verification and stop conditions

- Unchanged OSM geometry remains on top. A courtyard class cannot cross its DTM
  footprint, cover a building or street, or create a seam across adjacent tiles.
- Ground-level trees and shrubs follow classified green where supported; paved
  classes suppress procedural vegetation. Existing surveyed trees remain intact.
- Use matched cameras from plan 013, clear midday and a shadowed view, with the
  same WebGL and WebGPU checks and proportional performance comparison.
- Stop expansion if the sample confuses roofs with ground, the material is not
  visually credible, or the extra tile and draw costs exceed the benefit. Keep
  the neutral yard fallback in that case.

Shared `public/data` and downloaded photo caches must be copied or isolated before
any generation.

## Result so far (branch `night-beige`, 6 October 2026)

Status: IN PROGRESS. Code is in place, built for `ujezd`, `centrum` and (timed, on a
clone) the city, and looked at in the game on `centrum`. The shared map has not been
rebuilt with it.

- `ground_cover.py build` now classifies the surveyed courtyards with the plain
  ground (`bare_mask`: `dtm_yard` no longer counts as covered). The courtyard keeps its
  outline and its neutral paving wherever the classifier says "not ground" (shadow,
  roofs, clutter) or sees no photograph; cover polygons are drawn above it.
- The classifier works cell by cell with a 16 m margin from the neighbouring tiles
  (`pipeline/cover_cells.py`), so a patch keeps its class across a tile edge. On the
  kept Smíchov photographs three shared edges had 0 differing cells of 10,240;
  `test_cover_layer.py` holds the same check on a synthetic field.
- On the 108 hand labels the cells do about as well as the first version's pieces
  (exact 58 % against 62 %, green or not 92 % against 93 %, material on hard ground
  38 % against 40 %, not ground caught 88 % against 92 %; `cover_labels.py score`).
  The differences are within what 108 pieces can show. More dirt is now left
  plain as "not ground" (1,154 m2 against 684 m2 of the labelled dirt).
- `ujezd` (16 tiles): trees 0.30 → 1.52 ha (courtyard canopy), dirt 0.04 → 0.31 ha,
  asphalt 0.11 → 0.27 ha, gravel 0.98 → 1.04 ha; the cover layer grew from 96 to
  128 KB of JSON. One block was compared with the photograph by eye (rows of trees in
  two courtyards match); no courtyard was hand-labelled.

- Looked at in the game on `centrum` (200 tiles classified, 6 October): canopy by houses
  planted trees through roofs and into a street; fixed (canopy within 4 m of a
  building is garden, a single tree needs room). Pictures in
  `docs/evidence/beige-cover/courtyards-*.jpg`.
- The model for asphalt, gravel and dirt from OSM `surface=*` was written and
  trained, and did worse than the rules on the hand labels (19 % against 38 %): not
  kept. Numbers in `docs/beige-cover-city.md`.

## What is left

1. Rebuild the city's cover (command and duration in `docs/beige-cover-city.md`).
2. Hand-labelled courtyards and hand labels from other districts: there are none, so
   courtyard classes were only judged by eye in four blocks, and the material of hard
   ground stays the rules' weak call.
