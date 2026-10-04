---
read_when: Changing grass colours or their seasonal tints (src/ground.ts, src/groundSeason.ts, plan 023), the ground shader's patterns (performance skill), or adding marks that depend on where people walk.
---

# Plan 027: Summer grass that differs by place, and worn paths

Every lawn in the game is the same fresh green. In the July photos an unmown meadow
and a housing estate's lawn are straw-coloured, a watered garden and a football pitch
are green, and the grass between an estate's doors, stops and shops is crossed by
bare trodden lines.

## Status and starting point

- Status: BUILT on branch `plan-027-summer-grass` (not merged), 5 October 2026. Done:
  area kinds `meadow` and `lawn` split from `park` in the pipeline (`osm_area.py`,
  estate lawns from `_gardens`); per-kind dryness weights (`GRASS_DRYNESS` in
  `src/groundSeason.ts`: meadow 1, lawn 0.8, park 0.5, garden 0.25, pitch 0) as one
  tint uniform per kind in both shader paths, so no per-pixel work was added and
  15 July is unchanged (`scripts/check-ground-season.mjs` passes); worn paths
  (`pipeline/worn_paths.py`, area kinds `worn` and `worn_edge`, drawn as two blended
  dirt layers in `src/ground.ts`, trees kept off them). `?straw=0..1` starts the
  drying earlier so the July baseline can be compared (default 0 = unchanged).
  Left open: the July baseline default (the user's call); the plan-023 ground cost
  comparison was not run (no per-pixel work was added; run it if the shader's
  per-id branches should be measured); roadside verges are not a kind of their own
  (the pipeline has no verge data, so they follow the lawn or park they are mapped
  as); worn paths use door proxies (OSM entrances are not extracted) and not the
  footfall map; only chunks (2,10), (7,10), (9,6) were rebuilt in the shared
  clone, then assembled for the whole city, not the full chunk build: 119 paths in
  the two estate chunks (71 at Kobylisy, 48 at Černý Most, none in the village of
  Nebušice), 79 merged ribbons in 44 tiles (at most 6 per tile, median 1). A full
  chunk build is still to do before release. Expect a merge conflict with plan 030
  in `osm_area.py`, `build_tiles.py` and `layers.py`.
- Status (was): PLANNED.
- Priority: P2. Effort: two to four days for the colours, about the same again for
  the paths. Risk: low for colours; medium for paths (they need a per-tile input).
- Category: feature (map look). Dependencies: plan 023 (seasons), whose ground cost
  comparison is still unresolved: do not add per-pixel work before reading its
  result.
- Planned at: `364e7f3cac31a9aedb4a64f8c0b1ac9563258990`, 4 October 2026, from the
  aerial comparison (50.13206, 14.42100; 50.06689, 14.50137; 50.12522, 14.30214) and
  from reading the code. Nothing was measured.
- Confidence: high for colours by kind; unknown whether worn paths can be placed
  believably without looking like noise.

Before editing run `git status --short` and:

```sh
git diff --stat 364e7f3cac31a9aedb4a64f8c0b1ac9563258990..HEAD -- src/ground.ts src/groundSeason.ts src/season.ts pipeline/osm_area.py
```

## Current state

- **Colours by kind** (`COLORS` in `src/ground.ts`): `park` `#79a24c`, `garden`
  `#80a552`, `orchard` `#89a858`, `pitch` `#6c9c55`, `field` `#b9b27a`. Meadows,
  roadside grass, estate lawns and private gardens all end up as `park` or `garden`.
- **One seasonal tint for all grass**: `GROUND_SEASON` in `src/groundSeason.ts` (a
  tint and the strength of the shader's existing dry patches), set once when the game
  date changes. 15 July keeps the original palette exactly; `season.dry` rises
  through late summer.
- **The pipeline already knows more than it passes on**: `osm_area.py` (about line
  562) folds `landuse=grass|meadow|village_green|recreation_ground` and
  `natural=scrub|grassland` into `park`, and the technical map's maintained green
  into `dtm_green`.
- **Paths** exist only where OSM maps them (`path`, `dirt`).

## Design

### How dry, by kind

Give each grass kind a dryness weight that multiplies the season's `dry`:

| Ground | Weight | Why |
| --- | --- | --- |
| meadow, grassland, scrub, roadside verge | 1.0 | never watered, rarely mown |
| estate lawn (`_gardens` blocks of flats), `dtm_green` | 0.8 | mown short, not watered |
| park | 0.5 | partly shaded, sometimes watered |
| private garden | 0.25 | watered |
| pitch | 0 | watered or artificial (plan 030) |

That needs meadow and estate lawn kept apart from `park` and `garden` in the tiles
(two new area kinds, or a flag), and the weight as a per-layer constant, not a
per-pixel lookup: the ground is drawn per kind already, so each kind's material gets
its own tint uniform. No new texture reads.

Also move the summer baseline: the photos were taken in a dry July and show far more
straw than the game does on 15 July. Whether to change the baseline or keep it and
let August do it is the user's call; show both.

### Worn paths

Where an estate lawn or a meadow lies between two things people walk between, draw a
narrow bare line. Inputs the tile already has: the walk graph's nodes, doors of
blocks of flats, public-transport stops, the footfall map (`footfall.json`). A line
is made where a straight walk across grass saves at least a third against the mapped
path and is under 80 m. Drawn as a `dirt` ribbon 0.6–1 m wide with a soft edge, made
in the pipeline so it is the same every load. People do not need to walk on them yet.

## Steps

0. **Look**: a sheet of the three places, game against photo, for 15 July and 20
   August as they are now.
1. Keep meadow and estate lawn apart in the pipeline; weights in the materials.
   Pictures; run `scripts/check-ground-season.mjs` and the ground cost check from
   plan 023.
2. Decide the July baseline with the user.
3. Worn paths for one housing estate; show it before doing the city.
4. City build, counts of paths per tile, pictures.

## Out of scope

Classifying grass dryness from the photo itself, snow tracks, mud after rain.
