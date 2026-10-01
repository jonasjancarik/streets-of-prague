---
read_when: Planning a later orthophoto-based material pass for DTM courtyards, after plan 013 phases 1–3.
---

# Plan 014: Identify courtyard surfaces from aerial photos

## Status and starting point

PLANNED. This is the deferred fourth phase of [plan 013](013-fill-the-beige-ground.md).
No photo download, classifier change, tile build or shared-data activation is part
of this plan's creation.

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

No implementation has begun. Shared `public/data` and downloaded photo caches
must be copied or isolated before any future generation.
