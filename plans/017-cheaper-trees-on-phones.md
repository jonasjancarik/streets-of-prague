---
read_when: Looking at tree rendering cost on phones, the tree shadow pass, or the size of tree pages in src/trees.ts and src/map/vegetation.ts.
---

# Plan 017: Cheaper trees on phones

Trees are probably the largest share of the triangles in a frame, and a tile's trees
are drawn all together, on screen or not, once for the picture and once for the
shadow map. This plan first finds out whether that matters on a Pixel 5, and only
then makes the trees cheaper there.

## Status and starting point

- Status: PLANNED. Step 1 decides whether the rest goes ahead.
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

## Result

Not started.
