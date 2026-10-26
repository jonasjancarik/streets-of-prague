---
read_when: Looking at tree rendering cost on phones, the tree shadow pass, or the size of tree pages in src/trees.ts and src/map/vegetation.ts.
---

# Plan 017: Cheaper trees on phones

Trees are probably the largest share of the triangles in a frame, and a tile's trees
are drawn all together, on screen or not, once for the picture and once for the
shadow map. This plan first finds out whether that matters on a Pixel 5, and only
then makes the trees cheaper there.

## Status and starting point

- Status: shadow-only implementation adopted as the default at every graphics
  tier, including Ultra, on 26 October 2026 after the user approved the comparison
  images. `?treeShadows=full` opts into the original detailed shadows. Performance
  measurement limitations below remain unchanged.
- Priority: P3. Effort: half a day to measure; two to three days if it goes ahead.
  Risk: low for the measurement; medium for the changes (the trees' look and their
  shadows are easy to spoil).
- Category: performance (vertex work on weaker GPUs). Dependencies: plan 009's tree
  pool, which is in main. If plan 016 goes ahead first, repeat step 1 after it, since
  it changes which pages exist.
- Planned at: `1b5756cdf775c7fbde3e5522fb57de5658664bcf`, 1 October 2026, from reading
  the code only. Nothing was run or measured while planning.
- Confidence: low. On the M5 the main thread is the limit and vertex count is not.
  Whether the Pixel 5's GPU is limited by vertices has never been measured.

Before editing run `git status --short` and:

```sh
git diff --stat 1b5756cdf775c7fbde3e5522fb57de5658664bcf..HEAD -- src/trees.ts src/map/vegetation.ts src/webgpu/trees.ts src/graphics.ts scripts/check-tree-pool.mjs
```

Branch changes, commits, pushes and deployment need separate authorization.

## Current state

- `src/map/vegetation.ts`: a broadleaf crown is 16 tufts with a 20-point outline each
  plus a core, about 340 triangles (`CROWN_TIERS`, `crownShape(7, 20, …)`); a shrub
  about 90; a conifer six tiers of 14 sides plus a trunk, about 180. The tufts are
  real geometry so that nothing needs alpha testing.
- `src/trees.ts`: `TreePool` leases pages to tiles, 1,200 broadleaf or 128 shrubs or
  conifers a page (`TREE_PAGE_CAPACITY`). A page's bounds cover all its trees, so a
  page is culled only when its whole tile's trees are off screen. The screen shows
  roughly an eighth of a tile's area at walking height.
- Every page casts and receives shadows (`treePageFactory`). The shadow pass draws
  the same crown; in winter its fragment mask cuts the twigs out
  (`maskShadowNode` in `src/webgpu/trees.ts`, `treeDepth` on WebGL).
- Plan 009's drives drew about 1.2 million triangles a frame in 190–245 draw calls.
  How much of that is trees was not broken down. A tile with a wood can hold several
  thousand trees.
- `src/graphics.ts` has the tiers (High to Lowest) and Auto, which starts at Medium
  on touch devices.

## Options, cheapest first

**A. A simpler crown in the shadow pass.** A shadow doesn't show a tuft's lobes at
the shadow map's resolution. Draw the shadow from a low-detail crown (the same tufts
with a 6–8 point outline, or one rounded blob per tree) while the picture keeps the
full crown. In three.js a mesh has one geometry for both passes, so this needs either
a second set of instanced pages that only cast (`colorWrite` off isn't enough: they
must be skipped in the main pass and the full pages must stop casting), sharing the
same instance buffers, or a vertex-stage collapse of the outline in the shadow pass
only. The second set doubles the tree draw calls unless the full pages stop casting,
which they would. Winter twig shadows need the tuft coordinates: keep them on the
simple crown or accept blob shadows from bare trees (a decision on the look).

**B. A simpler crown on low tiers.** Give Lowest (and perhaps Low) a crown with fewer
tufts and outline points for both passes. Simple to do, since the factory already
makes the geometry once; the look changes on those tiers only.

**C. Smaller pages.** Split a tile's trees into a grid of cells (for example 4 × 4,
about 62 m each) and lease a page per cell, so culling drops the cells off screen.
Fewer vertices, but more draw calls and more pages in the pool (plan 009's reserve
and its uniform-buffer uploads grow), which costs the main thread. Only worth it
where the GPU is clearly the limit and woods are in view.

## Scope

In scope: `src/trees.ts`, `src/map/vegetation.ts`, `src/webgpu/trees.ts`,
`src/graphics.ts` for a tier switch, `scripts/check-tree-pool.mjs`, `README.md`,
`todo.md`, the performance skill's phone notes, this plan and its row.

Out of scope: tree density and placement, the collision trunks, the leaf shading, and
impostor or billboard trees.

## Implementation steps

### 1. Find out whether the phone is limited by tree vertices

With measurement authorized and the Pixel 5 attached (`--android`, see the
performance skill), on `woods`, `suburb` and `drive`:

- Count triangles and draw calls per frame by kind (trees, people, cars, buildings,
  ground), main and shadow passes separately.
- Toggle with `--ab`, alternating and warmed: trees not casting shadows; tree pages
  hidden; the crown swapped for a low-detail one (a throwaway geometry made in the
  `--ab` code). Each toggle changes vertex work with little else.
- Record battery temperature and alternate the order, as the skill describes.

**Stop here** unless hiding tree shadows or the low-detail crown improves the phone's
frame time clearly beyond an unchanged-build control. Record the numbers and close
the plan. If only the woods scene benefits, say so: that argues for option B or C on
low tiers rather than A everywhere.

### 2. Do the option the numbers favour

One option at a time, each compared with the state before it:

- A if the shadow toggle carried most of the gain.
- B if the low-detail crown helped in both passes and the tier's look is acceptable
  (show the user before and after screenshots at walking height and zoomed in).
- C only if culling by cell would remove most of the drawn trees in the scenes that
  were slow, and the added draws don't cost more on the main thread than they save.

**Verify:** `npm run typecheck`; `check-tree-pool.mjs` passes (zero growth and zero
tree shader builds after start-up still hold); screenshots in summer, winter (bare
twigs and their shadows) and snow on both renderers; the tunnel cutaway under a park
still opens.

### 3. Compare on the phone and the Mac

Alternating drives on the phone for frame time and its tail, and a check on the M5
that nothing got slower (more pages or draws can cost the main thread there).

## Done criteria and stop conditions

Done when the chosen option shows a repeatable frame-time gain on the Pixel 5, no
regression on the M5, the trees and their shadows look right in every season, and
the pool's reuse guarantees still hold.

Stop and report if step 1 shows no vertex limit, if the simpler shadow is visibly
wrong at High, or if option C's extra pages bring back first-use shader builds while
driving.

## Historical result, 6 October 2026

Step 1, 6 October 2026, Pixel 5 (Android 14, WebGPU), main at `27bc5ef`, High at 1×,
`bench.mjs --android --ab`, 4-second windows alternating, one run of 32 s per toggle,
battery 30.0–31.9 °C:

| Scene | Toggle | Off | On | JavaScript off / on |
| --- | --- | ---: | ---: | ---: |
| woods | tree pages drawn | 12.6 ms | 28.9 ms | 10.8 / 14.3 ms |
| woods | trees cast shadows | 20.8 ms | 28.6 ms | 13.1 / 14.2 ms |
| woods | nothing (control) | 28.6 ms | 28.9 ms | 15.3 / 15.0 ms |
| suburb | tree pages drawn | 13.8 ms | 17.6 ms | 11.9 / 13.7 ms |
| suburb | trees cast shadows | 16.2 ms | 17.8 ms | 13.6 / 14.2 ms |

Every window agreed with its neighbours to within 2 fps. In a wood the trees are over
half the frame and their shadow pass over a quarter (7.8 ms); in the garden suburb
3.8 ms and 1.6 ms. The JavaScript hardly moves, so this is GPU work. The stop
condition isn't met: the plan goes ahead, and the shadow toggle carrying half of the
trees' cost in the woods points at option A (a simpler crown in the shadow pass).

Not done: the per-kind triangle and draw-call counts, the `drive` scene, the
low-detail crown toggle (which would say whether the main pass is limited by vertices
or by the pixels the crowns cover), reversed order and a second run. Hiding the pages
also removes the pixels they shade, so "trees drawn" is not a vertex figure by itself.

## Shadow-only prototype, 26 October 2026

Option A was initially implemented as opt-in `?treeShadows=simple`. Rather than
additional proxy meshes, each broadleaf shape's existing index buffer holds a second,
eight-point-rim triangle list. `onBeforeShadow` selects its draw range and
`onAfterShadow` restores the full range. The main-render hook also restores it after
an interrupted shadow render. Main geometry, instance buffers, materials, seasonal
twig masks, tree outlines and draw counts are retained. The actual renderer checks
confirm that both WebGPU and WebGL use the selected range.

Normal broadleaf shadows use 148 instead of 340 triangles, big crowns 292 instead
of 564; shrubs/conifers are unchanged. The extra shared indices total 2,640 bytes.
This is a subset of the original vertices, so no new silhouette shader or per-frame
buffer update is needed. A shadow's outer edge can be coarser/smaller; matched
summer/winter top-down views remain close.

Pixel 5 summer woods/suburb frame-time savings of approximately 9–12% repeat in
both run orders, versus a 2.2% unchanged-build control. Winter woods improved 14.3%
in one alternating run. Verified drive comparisons disagree, and desktop results
are provisional under background GPU load. Full details and raw windows are in
[the evidence record](../docs/evidence/tree-shadows-2026-10-26/README.md).

Passed: `npm run build`, `node scripts/check-tree-shadows.mjs`, the latter with
`--url http://localhost:5191/` on WebGPU and WebGL in four seasons plus snow,
`node scripts/check-tree-pool.mjs --url http://localhost:5191/ --case all` both with
and without `--simple-shadows`, and `node scripts/scene.mjs run tunnel-layers` with
the mode enabled. The full unrelated scenario suite was intentionally skipped.

The prototype is complete, but this plan's broad adoption criteria are not all met:
a matched-route phone comparison, a quiet reversed desktop comparison, and a
reversed winter run remain open. Preserve both valid but conflicting drive results.
These measurements do not establish a city-wide FPS gain. Options B/C and
shader-compilation investigation remain separate work.

The user subsequently approved the simpler shadows visually and requested them
as the default even on Ultra. That adoption is now implemented independently of
graphics tier, with `?treeShadows=full` as the explicit override. It is a quality
choice based on the accepted appearance, not a claim that the unresolved timing
checks passed.
