---
read_when: Changing how roofs are chosen or coloured for buildings that come from OSM alone (src/map/buildings.ts, src/map/roofPalette.ts, `_guess_height` in pipeline/osm_area.py), the countryside tiles of plan 021, or flat roofs' look anywhere.
---

# Plan 028: Roofs on buildings without IPR data, and what stands on flat roofs

Past the city limits every house has the same orange tiled roof, and large modern
buildings get tiled hips they don't have. Inside the city, flat roofs are a clean
beige slab where a real one has a parapet, a lift house, vents, skylights and often
solar panels.

## Status and starting point

- Status: PARTLY DONE (branch `plan-028-roofs`, merged into main on 5 October 2026, not deployed). Built: step 0 (the atria
  fault), steps 1 and 2 (Part A), step 3 (parapets and surface colours). Not built: step 4,
  and the city's IPR layer has not been re-run (see "What was built").
- Priority: P2 for part A (it changes every village in the outer ring and all of plan
  021's countryside), P3 for part B. Effort: A two to three days, B three to five.
  Risk: low for A; medium for B (more triangles on every estate).
- Category: feature (map look). Dependencies: none. Plan 005 measured real roof
  colours for IPR's buildings; this plan is for the rest and must not override it.
- Planned at: `364e7f3cac31a9aedb4a64f8c0b1ac9563258990`, 4 October 2026, from the
  aerial comparison (A: 50.00167, 14.56409; 50.15677, 14.38949; 50.11385, 14.70064;
  49.95898, 14.54310; 50.06689, 14.50137. B: 50.13206, 14.42100; 50.09156, 14.35117)
  and from reading the code. Nothing was measured.

Before editing run `git status --short` and:

```sh
git diff --stat 364e7f3cac31a9aedb4a64f8c0b1ac9563258990..HEAD -- src/map/buildings.ts src/map/roofPalette.ts pipeline/osm_area.py pipeline/roof_details.py pipeline/ipr_buildings.py
```

## Current state

- **Shape** (`src/map/buildings.ts`, about line 132): where OSM gives no `roof`, a
  kiosk, canopy and half the garages and sheds are flat; a four-cornered footprint is
  gabled; everything else is hipped over its straight skeleton, whatever its size or
  kind. So a school, a supermarket or a new block of flats outside IPR's model gets a
  tiled hip.
- **Colour** (about line 103): "Pitched roofs in Prague are nearly all red tiles":
  without a `cover`, `ROOF_TILES` picked by hash, lightness varied by ±3 %. True of
  the old town; in the photos of suburbs and villages a third to a half of the roofs
  are dark grey, brown or black, and new houses are often flat and white or grey.
- **Flat roofs** are one colour (the roof colour pulled 60 % toward `#8a8580`) and
  nothing else. `flatRoof` does cut holes for inner rings.
- **Inside the city** IPR's buildings carry measured colours and covers (plan 005)
  and get chimneys and roof windows by rule (`pipeline/roof_details.py`), on pitched
  roofs only.
- **A fault to check first.** At 50.13206, 14.42100 two schools with atria (OSM
  relations 406353 and 406354, each with an inner ring of about 1,040 m² in tile
  `56_84`) are drawn roofed over. The tile data has the hole and `flatRoof` honours
  holes, so the loss is elsewhere, probably where IPR's mesh for the building is
  used. Not investigated.

## Design

### A. Buildings from OSM alone

- **Flat or pitched by kind and size.** Flat for `HALLS` kinds, schools, hospitals,
  offices, retail, `apartments` over three storeys, and any footprint over about
  400 m² or with more than eight corners that isn't a church or a farm. Houses stay
  pitched, except a share (by hash, higher for footprints with exact right angles and
  no neighbours' roofs like it) that are flat, as new houses are.
- **A wider palette for pitched roofs**, chosen by hash but weighted by the
  neighbours, since streets were built together: burnt tile in several ages, brown
  concrete tile, anthracite, grey fibre cement, green or red sheet on sheds and
  cottages. Old village cores (buildings tagged `farm`, or near a church) keep mostly
  red.
- **Calibrate** the shares against plan 005's measurements: the outermost IPR
  districts (Kolovraty, Klánovice, Zbraslav) are the nearest thing to the villages
  beyond, and their roof covers and colours are already measured.
- The same rules serve plan 021's countryside tiles (`src/countryside.ts`), so put
  them where both can use them.

### B. What stands on a flat roof

Instanced or merged geometry made in the worker from the footprint, seeded by the
building's id:

- a parapet (a raised rim 0.3–1 m) on every flat roof over about 60 m²;
- gravel grey, bitumen dark or membrane white-grey as the surface, by hash;
- a lift or stair house on blocks over four storeys, one per entrance where known;
- a few vents and air-handling boxes on halls, shops and offices;
- skylight rows on halls;
- solar panels on a share (schools and new houses most), in rows facing south.

All small boxes; no textures. From the street only the parapet and the tallest boxes
show, so the gain is mostly for the helicopter and high camera: count before doing
it (step 0).

## Steps

0. **Find the atria fault** and fix it or write down where it is. Count: buildings
   from OSM alone by kind and footprint over the outer ring; flat roofs in view on an
   estate, and how often the camera sees roofs at all in a normal drive.
1. Part A shape rule. Pictures of the five places against the photos.
2. Part A palette, calibrated. Same pictures.
3. Part B parapets and surface colours (cheap, visible from the street).
4. Part B the rest, if step 0 says roofs are seen enough. Bench an estate before and
   after.

## Out of scope

Roof colours measured from photos outside IPR's area, green roofs, roof terraces
with furniture.

## What was built

- **Atria fault (step 0).** Not in the tile data or `flatRoof`: `pipeline/ipr_buildings.py`
  ignored the interior rings of CityGML roof and floor polygons, so a courtyard in IPR's
  mesh was covered. It now cuts holes of 25 m² or more out of roof and floor surfaces
  (smaller ones and all wall holes stay separate polygons, as before). Unit-tested in
  `pipeline/test_ipr_openings.py`. The shared city layer was not re-run (hours, and the
  data is shared between sessions), so the schools at 50.13206, 14.42100 still look roofed
  until `ipr_buildings.py` is run again.
- **Counts (step 0).** Roofs on OSM-only buildings matter mostly from the helicopter or a
  high camera; from the street only the eaves and the parapet show.
- **Part A, `src/map/roofRules.ts`**, used by `buildBuildings` and so by plan 021's
  countryside too. Shape by kind, size, corners and a per-cell share; palette of clay,
  brown tile, grey and anthracite with the cell's dominant class followed by most
  buildings; flat surfaces in gravel, bitumen or membrane. Calibrated on IPR's measured
  roofs in Kolovraty (9 % flat), Klánovice (15 %), Zbraslav (29 %), Satalice (28 %) and
  Čakovice (49 %); among their pitched roofs about 21 to 37 % red, 27 to 40 % brown or
  orange, 28 to 41 % grey, 5 to 9 % dark. `scripts/check-roof-rules.mjs` checks the rules.
- **Part B step 3.** Parapets on flat roofs over 60 m²: walls 0.35 to 0.85 m above the
  roof, a 0.3 m cap, and an inner face that leans back so `facadeCoords` counts it as a
  roof and puts no windows on it.
- Before and after pictures of the five places in the plan are in the session report;
  inner-city (IPR) roofs are unchanged.

## What is left

- Re-run `pipeline/ipr_buildings.py` for the city and look at the atria schools.
- Step 4 (lift houses, vents, skylights, solar panels): not started; the gain is for the
  high camera only, and it adds triangles to every estate, so bench an estate first.
- Neighbour coherence is by 90 m grid cell, so a street crossing a cell edge can change
  roof class. "Near a church keeps red" was not implemented (no neighbour access in the
  worker); farms do keep red.
- Triangle cost of the parapets (4 triangles per edge of every flat roof over 60 m²) was
  not benched.
