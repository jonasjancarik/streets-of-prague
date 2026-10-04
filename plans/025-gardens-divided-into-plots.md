---
read_when: Changing how gardens round family houses are made (`_gardens` in pipeline/osm_area.py), the garden tree and shrub scatter (src/map/vegetation.ts), hedges and fences (src/fences.ts), or adding anything that needs to know which house a piece of garden belongs to.
---

# Plan 025: Gardens divided into plots

A suburb's gardens are one lawn per block with small trees dotted over it. From the
air a real one is a patchwork: each house on its own plot, a hedge or fence round it,
a few big crowns covering half the ground, a paved strip to the street, a shed, now
and then a pool. Divide the garden blocks into plots and furnish each one.

## Status and starting point

- Status: IN PROGRESS (4 October 2026): step 0 done; hedges and fences along plot
  edges, and bigger garden crowns, built; paved strips, small things and plot records
  not done (see "What was done").
- Priority: P1 among the plans from the aerial comparison (it was the biggest
  difference at seven of the ten places). Effort: one to two weeks. Risk: medium
  (more trees and hedges in the suburbs, where triangles already doubled once).
- Category: feature (map look). Dependencies: none. Plan 029 (cars on driveways)
  builds on the plots made here.
- Planned at: `364e7f3cac31a9aedb4a64f8c0b1ac9563258990`, 4 October 2026, from ten
  random 250 m squares of the local `praha` map set against IPR's 2024 aerial photos
  and from reading the code. Nothing was built or measured.
- Confidence: high that Voronoi cells round the houses give believable plots; unknown
  how the hedges and bigger crowns cost on a phone, and how good the surface model is
  at telling a garden tree from a shed.

Before editing run `git status --short` and:

```sh
git diff --stat 364e7f3cac31a9aedb4a64f8c0b1ac9563258990..HEAD -- pipeline/osm_area.py pipeline/build_tiles.py src/map/vegetation.ts src/fences.ts src/ground.ts
```

Branch changes, commits, pushes and deployment need separate authorization.

## Current state

- **One lawn per block.** `_gardens` (`pipeline/osm_area.py`, about line 592) cuts
  `landuse=residential` along the streets into blocks and makes a block green where
  it is mostly homes (family houses covering under 45 % of it, or flats under 30 %),
  less a strip of 0.8 m round a house and 2 m round anything bigger. The result is one
  `garden` polygon; nothing records which house a piece belongs to.
- **Trees are scattered evenly.** `gardenTrees` (`src/map/vegetation.ts`, about line
  177) tries a spot every 8 m and keeps 30 % of them; 88 % of those are small (radius
  1.8–3.6 m) and 12 % big (3.4–5 m). Shrubs: every 5.5 m, 10 % kept. In the photos
  crowns cover roughly half of a villa garden; in the game well under a tenth.
- **Hedges and fences come only from OSM** (`barrier=fence|hedge`, drawn by
  `src/fences.ts`, knocked down by cars, with seasonal tints). At the ten places
  almost none were mapped: tile `47_95` has 54 buildings and no fence.
- **Voronoi is already in the pipeline**: `osm_area.py` (about line 627) splits
  street surfaces with `shapely.voronoi_polygons` round points along lines.
- **Garden trees cost.** `todo.md` records that the garden scatter roughly doubled
  the triangles in view in a garden suburb (0.57 M to 1.19 M).
- **A search of every branch, worktree and stash found no earlier plot work.**

## Design

### Plots

In the pipeline, for each garden block: Voronoi cells round the main buildings
(not the outbuildings; `OUTBUILDINGS` already lists them), sampled along each
footprint's outline so that a long house gets a long plot, clipped to the block.
Terraced houses sharing a wall get cells that run from the street to the back of the
block, which is what their gardens do. Cells under about 60 m² merge into a
neighbour. Each plot records its building and the side that faces the nearest street.

The cadastre's real parcels (ČÚZK's INSPIRE cadastral parcels, free) would be more
faithful but mean another source to download, cache and keep in step. Step 0 looks at
one suburb both ways before deciding; start with Voronoi.

### What goes on a plot

All chosen from a hash of the building's id, so a plot is the same in every build.

- **Its edge.** Along shared edges a hedge (most), a fence, or nothing; along the
  street a fence or low wall with a gap for the gate. Written as `fences` features so
  `src/fences.ts` draws them and cars knock them down as they do OSM's. Where OSM
  already has a barrier within a metre, keep OSM's.
- **A paved strip** from the gate to the house, wider where the plot has a garage.
- **Trees where the trees are.** Inside the city, take crown positions from IPR's
  surface model minus the terrain (already local for the whole city, see
  `docs/beige-cover-city.md`) and the infrared photo's greenness, as `todo.md`
  suggests for private gardens: a local maximum over 4 m high and green is a tree,
  with the crown's radius from the height field. Outside the photographs, raise the
  scatter instead: fewer trees but most of them big, placed toward the plot's back
  and edges.
- **Small things, rarely.** A shed in a back corner where OSM maps none, a vegetable
  bed, a pool (one plot in ten at most). These are ground patches, not meshes.

### Cost

Hedges are the risk: a suburb gains kilometres of them. Count first (step 0). If
they cost too much, hedges on the street side only, or hedges as a ground stripe
past 150 m.

## Steps

0. **Count and look.** For three suburb tiles (Ořechovka 50.09383, 14.38260; Braník
   50.03767, 14.43505; a village at the east edge 50.11385, 14.70064): plots a block,
   metres of plot edge, trees the surface model finds against trees the scatter
   makes. Draw the Voronoi plots and the cadastre's parcels over the photo for one
   tile. Stop and report if the surface model cannot separate crowns from roofs.
1. **Plots in the pipeline**, as a tile field (`plots`: ring, building id, street
   side). No change to what is drawn. Check with `scripts/check-data-format.mjs`.
2. **Edges**: hedges, fences and gates as `fences` features.
3. **Trees** from the surface model inside the city, the denser scatter outside.
4. **Paved strips and small things.**
5. **Measure** a suburb drive before and after with `scripts/bench.mjs` (performance
   skill) on the laptop and a phone; take the same top-down pictures as step 0 and
   set them beside the photos.

## What was done (4 October 2026)

Step 0, counted on the three suburb tiles (Ořechovka `45_67`, Braník `60_42`, the
east-edge village `136_76`; garden m², Voronoi plots a tile, main buildings):

| | Ořechovka | Braník | Village |
|---|---|---|---|
| garden area | 29,000 m² | 35,000 m² | 42,000 m² |
| plots / main buildings | 38 / 42 | 74 / 64 | 73 / 88 |
| crowns over 3 m in the surface model, share of garden | 21 % | 10 % | 6 % |
| the game's scatter before (replica) | 28 trees/ha, 7 % | 23/ha, 6 % | 33/ha, 8 % |

- **Voronoi plots are believable** drawn over the photo (Ořechovka), in rows and in
  loose villas. Their edges are curved where two houses face each other at an angle,
  so the generated edges are straightened by 1 m.
- **The surface model cannot be used for garden crowns.** It separates crowns from
  roofs (green and off the footprints), but in private gardens it holds most crowns
  as faint bumps or not at all, while street trees show up fine. The photo shows
  about half of Ořechovka's garden under crowns; the model finds a fifth. A colour rule
  on the photograph (dark and infrared-green) finds a third and mistakes shaded lawn
  for crowns. So trees are not placed from it. Crown positions from the photographs
  would need the classifier in `ground_cover.py` run over the suburbs; left as a
  follow-up.
- The cadastre was not compared; Voronoi plots were enough to go on.

Built:

- `_plots` and `_plot_fences` in `pipeline/osm_area.py`: plots in blocks of family
  houses, and between them a hedge (half), a fence (a third) or nothing, chosen from
  the two buildings' ids; along the street a fence, a hedge or nothing, with a 3 m gap
  for the gate. Only on grass, and not within a metre of a mapped fence, hedge or wall.
  They go in as ordinary `fences`, so the format is unchanged.
- `gardenTrees` in `src/map/vegetation.ts`: four in ten trees are big (radius 3.8–6 m,
  before 12 % at 3.4–5 m); a crown may lean over a path or a fence, so only the inner
  60 % of it has to be clear. The replica gives 11–14 % crown cover and 32–36 trees a
  hectare (before 6–8 % and 23–33), about a sixth more trees. The photos show far more
  than that in the villa suburbs; the rest needs real crown positions.

Seen on a phone, looking down: fences show as dark thin strips (a single upright
plane, dark on its shaded side), pieces stop short at plot corners, and a hedge can end
with nothing joining it. To do: light fences from both sides, close the corner gaps,
check hedge heights against the terrain.

Not done: the `plots` tile field (nothing reads it yet; plan 029 should add it from
`_plots`), paved strips from the gate, sheds, vegetable beds and pools, and the
measurement on a phone (step 5).

## Out of scope

Housing-estate lawns (they have no plots), allotment colonies' own layout, cars on
driveways (plan 029), anything hand-authored for one place.
