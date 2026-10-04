---
read_when: Changing where parked cars can stand (src/parking.ts, src/parkingClearance.ts), what counts as a car park in the pipeline (`lots` in pipeline/osm_area.py, the technical map's parking surfaces in pipeline/dtm.py), or the plots of plan 025.
---

# Plan 029: Parking where the map has no car park

Cars can only be parked where the map has a parking lane, an OSM car park or a kerb.
The photos show many more places: the asphalt round shops and halls, estate car
parks nobody mapped, and a car on the drive of nearly every family house.

## Status and starting point

- Status: PLANNED.
- Priority: P2. Effort: about a week. Risk: medium (cars are collision bodies and
  meshes; plan 015 made the meshes cheap, the bodies are not).
- Category: feature (map look, traffic). Dependencies: the occupancy by building type
  outside the paid zones, being done separately on 4 October 2026 (the session
  "Fill parking outside paid zones by building type"); read its result first, since
  it decides how full a slot is. Driveway cars need plan 025's plots.
- Planned at: `364e7f3cac31a9aedb4a64f8c0b1ac9563258990`, 4 October 2026, from the
  aerial comparison (50.13206, 14.42100; 50.09156, 14.35117; 50.00167, 14.56409) and
  from reading the code. Nothing was measured.

Before editing run `git status --short` and:

```sh
git diff --stat 364e7f3cac31a9aedb4a64f8c0b1ac9563258990..HEAD -- src/parking.ts src/parkingClearance.ts pipeline/osm_area.py pipeline/dtm.py pipeline/build_tiles.py
```

## Current state

- **Slots** come from OSM parking lanes, OSM car parks (`lots` in the tile, from
  `amenity=parking` that isn't under cover) and the kerb (`src/parking.ts`). Bays in
  a car park are laid out by its `orientation` tag or its width.
- **The technical map** adds surveyed parking bays and car parks inside the city
  (`pipeline/dtm.py`, kind `parking`, treated as part of the street) and courtyards
  and yards as `dtm_yard`. Outside the city there is neither.
- **What is missing in the pictures**: at 50.13206, 14.42100 a car park under trees
  beside a housing block is a strip of wood between two service roads; at 50.09156,
  14.35117 and 50.00167, 14.56409 the yards of halls and shops are grass or bare
  paving with no cars.
- **Underground, multi-storey and rooftop car parks stay empty** on purpose.

## Design

### A. Bays on paved ground that isn't a car park

A paved area qualifies when it is open to the sky, at least 5 m wide and 60 m² large,
touches a road a car can use (service roads count), and is not a carriageway, a
square, a pitch, a playground or a courtyard reached only through a passage.
Candidates: `dtm_yard`, the `yard` and `parking`-coloured ground, and the paving left
between a hall or shop and its service road.

Lay bays along the area's long edges, perpendicular where it is over 16 m wide (two
rows and an aisle), angled or parallel where narrower, leaving the aisle and every
entrance clear; `parkingClearance.ts` already tests a car against lanes and
buildings. Paint lines only on asphalt, and not in farmyards or works yards, where
cars stand unmarked.

### B. Strips of service road with trees between

Where two parallel service roads 10–20 m apart enclose a strip of trees or grass and
blocks of flats stand alongside, treat the roads' outer sides as perpendicular
parking. This is the estate car park at 50.13206, 14.42100, and a common pattern.
Check that pattern against a dozen estates before trusting it.

### C. A car on the drive

Each plot of plan 025 with a paved strip gets a car on it with some probability
(higher at night and at weekends, when the game has them), and a second in front of a
garage. These never drive off and need no slot in the street graph.

### How full

From the building-type occupancy being done separately; this plan adds slots, not a
rule for filling them. Shop and office yards follow the day; estates the night.

## Steps

0. **Count**: slots and parked cars per tile now, at six places (the three above, an
   estate, a villa street, a village), and how many more A and B would add. Count
   collision bodies in view on an estate drive. Stop and report if B's pattern
   matches things that are not car parks in more than a few cases.
1. A, in the pipeline (areas become `lots` with a flag saying they were inferred, so
   they can be drawn without a car park's paint where wanted).
2. B.
3. C, once plan 025's plots exist.
4. Pictures against the photos; `scripts/check-parking-clearance.mjs`,
   `scripts/check-car-pool.mjs`; bench an estate drive.

## Out of scope

Filling underground and multi-storey car parks, parking on grass verges, lorries in
depots.
