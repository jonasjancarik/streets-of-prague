---
read_when: Changing how IPR's surveyed lawns, shrubs, hedges, flower beds, manhole covers, storm drains or traffic-light poles are downloaded, put into the tiles or drawn.
---

# Surveyed greenery and street marks

Two optional layers from IPR Praha's open data (CC BY), each made by its own step and
merged into the tiles by `layers.assemble()` when present, like the young woods. A map
without them looks as it did before.

## Greenery (`pipeline/ipr_greenery.py`)

`OPK_CUR_OPK_SMZ_VP_P` holds about 127,000 polygons of the greenery the city tends,
and `OPK_CUR_OPK_SMZ_VP_B` about 30,000 single shrubs. Private gardens and most
courtyards are not in it. A tile gets:

| In the tile | From (`kod_vp`) | Drawn as |
| --- | --- | --- |
| `areas.ipr_lawn` | lawns (121, 123–126) | grass, `lawn` pattern |
| `areas.ipr_meadow` | meadow lawns, wild growth (122, 31, 32) | grass, `meadow` pattern |
| `areas.ipr_bed` | flower beds (11–14) | bare earth (there is no flower pattern yet) |
| `areas.ipr_shrubs` | shrub groups (41, 51), wide or crooked hedges | dark green ground filled with shrubs |
| `areas.ipr_grove` | tree groups, woody stands (61, 111) | lawn, planted with trees more closely than a park |
| added to `fences` | hedges (131), as a row along the middle | the game's hedges; clipped ones 1.1 m, free-growing 1.7 m |
| `shrubs` | single shrubs | one shrub each |

These lie above the guessed greenery (block gardens and lawns, the technical map's
green, the photos' grass) and below worn paths, woods, pitches, squares and streets.
Inside them the photos' tree canopy and single trees are dropped in `merge_greenery`,
and `src/map/vegetation.ts` makes up no park or garden trees there: IPR's own surveyed
trees stand on the same land. An IPR hedge within 1.5 m of a hedge the map already has
is left out. Shrub groups are filled from a 2.2 m lattice fixed to the map, at most 500
shrubs a tile (beyond that fewer, larger ones).

## Street marks (`pipeline/ipr_utility.py`)

From `DTMP_CUR_TMISZNAK_B`, the layer the lamps come from. A tile's `utility` is
`[x, y, kind]`: 0 manhole cover, 1 storm drain, 2 hydrant, 3 phone box, 4 the small
cover of an underground hydrant. `src/ground.ts` draws kinds 0, 1 and 4 as one flat
mesh per tile (`src/map/utility.ts`, `coverGeometry`): one more ground layer in a tile
that has any, however many covers. Hydrants and phone boxes are two more kinds of
the instanced furniture (`src/furniture.ts`, placed by `standingMarks` in the land
worker): one instanced mesh per kind in a tile that has any, solid like the benches.
One the game's carriageway covers is left out (the game's streets are not always as
wide as the real ones), and so is a surveyed signal pole there.

The layer's `signals` are the traffic lights' poles. `build_signals.py`, run after
this step, gives each junction light the nearest pole within 9 m of where the game
would stand it by rule, on the right of the street; `src/signals.ts` uses it.

## Commands

```
uv run ipr_greenery.py download     # once, about 40 minutes (64 + 16 pages)
uv run ipr_utility.py download      # once, about 20 minutes (163 pages)
uv run ipr_greenery.py build praha --no-assemble   # about 10 minutes
uv run ipr_utility.py build praha                  # seconds, then the assemble
uv run build_signals.py praha
```

The downloads are kept in `.cache/greenery/` and `.cache/utility/`; delete a file to
fetch it again. Both steps keep their own code keys (`layers.greenery_processing`,
`utility_processing`) and are left out of `build_cache.code_key`, so editing them
does not make IPR's buildings or the terrain out of date.
