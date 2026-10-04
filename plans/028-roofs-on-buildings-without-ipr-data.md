---
read_when: Changing how roofs are chosen or coloured for buildings that come from OSM alone (src/map/buildings.ts, src/map/roofPalette.ts, `_guess_height` in pipeline/osm_area.py), the countryside tiles of plan 021, or flat roofs' look anywhere.
---

# Plan 028: Roofs on buildings without IPR data, and what stands on flat roofs

Past the city limits every house has the same orange tiled roof, and large modern
buildings get tiled hips they don't have. Inside the city, flat roofs are a clean
beige slab where a real one has a parapet, a lift house, vents, skylights and often
solar panels.

## Status and starting point

- Status: PLANNED.
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
