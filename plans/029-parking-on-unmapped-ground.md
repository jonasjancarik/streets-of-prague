---
read_when: Changing where parked cars can stand (src/parking.ts, src/parkingClearance.ts), what counts as a car park in the pipeline (`lots` in pipeline/osm_area.py, the technical map's parking surfaces in pipeline/dtm.py), or the plots of plan 025.
---

# Plan 029: Parking where the map has no car park

Cars can only be parked where the map has a parking lane, an OSM car park or a kerb.
The photos show many more places: the asphalt round shops and halls, estate car
parks nobody mapped, and a car on the drive of nearly every family house.

## Status and starting point

- Status: PARTLY BUILT (branch `plan-029-parking`, merged into main on 5 October 2026, not deployed): A and C
  built; B checked on fourteen estates on 5 October 2026 and not built (no reliable signal); see "What was built" at the end.
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

## What was built (5 October 2026)

Branch `plan-029-parking`, three commits on `af66875`; not merged, not pushed.

- **A, inferred car parks** (`_inferred_lots` in `pipeline/osm_area.py`, `parking()` in
  `pipeline/dtm.py`). Ground the technical map calls parking, plus work yards, that
  OSM maps no car park on, less mapped lots, buildings (1 m round), car ways and
  natural cover; kept where an opening by 4.4 m leaves at least 60 m² within 3 m of a
  car way; a yard that buildings close in on (over 65 % of its edge) is dropped
  unless the survey says parking. They are tile `lots` with `"i": 1`, so they can be
  drawn without a car park's paint. `slots()` in `src/parking.ts` lays out an inferred
  lot wide enough as rows of bays with a 6 m aisle between every two rows (edge row,
  then back-to-back pairs); mapped lots are unchanged. Unit tests:
  `pipeline/test_inferred_lots.py`, `test_dtm_land.py`.
- **C, cars on drives** (`_drive_spots` in `pipeline/osm_area.py`). One spot a plot of
  a family-house block: 3.3 m inside the gate (where the fences put it), nose to the
  house, kept where the gate is at least 6.2 m from the house and nothing stands on
  it. The tile field is `drives` (`{b, x, y, h}`), not `plots` as the plan said, since
  only the drive is needed at run time; older tiles without it are fine, so the data
  format stays 2. `parkCars` fills a drive with a chance of 0.3 by day and 0.55 at
  night; the cars stay out of the street graph and never drive off. Unit test:
  `pipeline/test_drive_spots.py`.

### Measured

- Řepy halls (50.09156, 14.35117): one inferred lot of 1,221 m² beside 299 m² mapped;
  before, no car stood on the yard, after it has rows of cars (pictures in the report,
  `repy-before.png` and `repy-after.png`).
- Ořechovka (50.09383, 14.38260), chunk 5,8: 34 drive spots in the 250 m square, 902
  in the 2 km chunk; 36 of 47 chosen spots got a car on the tiles loaded.
- Hostivař halls (50.00167, 14.56409): nothing inferred; the game draws that ground as
  grass or park, so no paved ground is there to park on. A ground-cover problem, not
  one of parking.
- The estate (50.13206, 14.42100) is a case for B: it has trees between service roads,
  and nothing was inferred there.

### B was not built

First attempt (plan-029-parking): two parallel service roads 10–20 m apart with blocks
of flats on the far sides were searched for in the OSM ways (`service` including
`parking_aisle` and `driveway`, which the drive graph leaves out). They are rare: a
handful of hits in the first chunks searched, one of them a depot (50.1376, 14.44586).
That scan never finished, and the plan's check was not done.

Second attempt (5 October 2026, branch `plan-029-estate-strips`, no code kept): the
check was done on fourteen estates, each a 500 m square, against the 2024 aerial photo
(IPR ImageServer, resampled to the game's frame at 0.25 m per pixel). Estates: Lužiny,
Opatov, Petřiny, Kobylisy, Černý Most, Prosek, Řepy, Modřany, Libuš, Barrandov, Chodov,
Hloubětín, Hostivař, Invalidovna. The game's real `parkCars` and `slots()` were run
headlessly on the shipped tiles and the cars drawn over the photo.

- The estate this plan was written from (50.13206, 14.42100) is already a mapped lot
  (x −3110..−3095, y 7950..8150 in the game's frame), with dense cars. The premise was
  stale before this plan began.
- On all fourteen, the large estate car parks are mapped lots, parking lanes or kerb
  slots, and the game puts cars on them. `slots()` already lays parallel bays along every
  drive edge of 30 m or more, service roads included, unless `park` says no. About
  7,000 cars stand in the fourteen windows.
- A simple car detector on the photo (bright or coloured blobs of 3.5–12 m², elongated,
  off buildings) was run to list 25 m cells with at least five blobs and fewer than
  two thirds as many game cars. It flagged 49 cells. Seen against the photo, about 35 of
  them were trees, shadows, sand, playgrounds or a bridge, so the detector is not a
  signal, and the remaining 14 hold a few cars each (3 to 10): a perpendicular row on an
  estate service road (Petřiny), a yard between blocks (Modřany, Řepy), the end of a
  mapped lot that the game fills thinly (Lužiny, Chodov), and unpaved building ground
  with cars (Hostivař). That is on the order of 100 cars against 7,000, around 1 %.
- The one pattern B proposed, a service road with blocks beside it, does not tell car
  and no-car apart. Service roads through the green of Lužiny, Opatov and Libuš carry
  no cars in the photo at all; at Petřiny and Chodov they carry perpendicular rows that
  parallel bays would not match anyway. The gaps B would fill are too few and a rule
  based on the service road would put cars on ground that has none, so nothing was built.
- Pictures: `/tmp/p029b/<estate>-before.png` (photo, then game cars) and
  `unmatched-cars-sheet*-before.png` (the 49 cells), kept out of the repository.

Found on the way and not part of B: at Lužiny a hall's white roof gets cars drawn over
it in the game, though the photo shows none. Probably a lot that overlaps a building.
Worth its own look.

What would change this: a source that says "bays", such as the technical map's parking
surfaces inside the estate (part A already uses those), or a per-estate hand list.
Perpendicular rows along service roads would need `slots()` to lay bays at an angle to
the kerb, which is its own task.

### Left open

- The paved strip across the plot (plan 025) does not exist, so drive cars stand on
  grass. A second car in front of a garage needs garages marked on plots.
- Not measured: collision bodies on an estate drive, a `scripts/bench.mjs` run, a
  village and an estate sample (the extracts take 10 to 15 minutes each at that load).
- `scripts/check-parking-clearance.mjs` passes. `scripts/check-car-pool.mjs` fails with
  "active paint upload range" in the same way on main's dev server, so not from this
  work. `scripts/check-data-format.mjs public/data` passes (format 2).
- The map was not rebuilt: the pictures were made by patching the tiles of my own copy
  of the data with the output of `extract`. The shared local `praha` map was rebuilt on
  5 October 2026 and has `lots` and `drives` in its tiles; it is not deployed.
