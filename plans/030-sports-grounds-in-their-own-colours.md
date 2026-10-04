---
read_when: Changing how pitches, playgrounds and running tracks are classified (pipeline/osm_area.py, pipeline/dtm.py) or drawn (the `pitch` layer in src/ground.ts).
---

# Plan 030: Sports grounds in their own colours

Every pitch, court, playground and running track is the same green rectangle with a
white outline. In the photos they are the brightest things in a suburb: red running
tracks, orange clay courts, blue or green hard courts, striped football grass.

## Status and starting point

- Status: PLANNED.
- Priority: P3 (small, cheap, visible from above and at schools). Effort: one to two
  days. Risk: low.
- Category: feature (map look). Dependencies: none.
- Planned at: `364e7f3cac31a9aedb4a64f8c0b1ac9563258990`, 4 October 2026, from the
  aerial comparison (50.13206, 14.42100: a red track and courts beside a school;
  50.09383, 14.38260: clay tennis courts; 50.00167, 14.56409: tennis courts drawn as
  a brown patch) and from reading the code. Nothing was measured.

Before editing run `git status --short` and:

```sh
git diff --stat 364e7f3cac31a9aedb4a64f8c0b1ac9563258990..HEAD -- pipeline/osm_area.py pipeline/dtm.py src/ground.ts
```

## Current state

- **One kind.** `osm_area.py` (about line 564) turns `leisure=pitch|playground|
  sports_centre|track` into `pitch`; the tags `sport` and `surface` are dropped. The
  technical map's sports surfaces become `dtm_pitch`.
- **One colour.** `src/ground.ts` draws `pitch` in `#6c9c55` with the `pitch`
  pattern and a 12 cm painted outline round the outer ring (about line 599).
- A running track (`leisure=track`) is filled as an area even where it is a ring.

## Design

Carry `sport` and `surface` through to the tile and choose a look from them:

| Look | When | Colour and marks |
| --- | --- | --- |
| grass pitch | `sport=soccer` etc., `surface=grass` or none on a large pitch | mown stripes, white lines |
| artificial grass | `surface=artificial_turf` | even saturated green, white lines |
| clay | `sport=tennis` with `surface=clay` or none | orange-red, white lines |
| tartan | `leisure=track`, `surface=tartan`, athletics | brick red, lane lines |
| hard court | `surface=asphalt|acrylic|concrete`, basketball, multi | blue, green or red by hash; lines |
| sand | `sport=beachvolleyball`, `surface=sand` | sand |
| playground | `leisure=playground` | rubber or sand patch, no lines |

Lines: for a rectangle within tolerance of a standard size (tennis 11 × 24 m,
basketball 15 × 28, football by its proportions), draw that sport's lines from a
small table, fitted to the rectangle's own axes; otherwise only the outline, as now.
Lines are thin strips like the existing outline and the zebras, no textures.

Where neither tag is present, guess from the size and the neighbours (a 600 m²
rectangle beside a school is a hard court; a 36 × 18 m pair is tennis). Inside the
city the photo's colour could decide, but the tags and sizes will cover most cases;
measure that in step 0 before reaching for the photo.

## Steps

0. **Count** over the city: pitches by `sport` and `surface`, how many have neither,
   how many are rectangles of a standard size.
1. Tags through the pipeline; colours by look. Pictures of the three places.
2. Sport lines for the standard rectangles.
3. Guesses for the untagged, if step 0 shows they are many.

## Out of scope

Goals, nets, hoops and fences round courts (furniture, see `docs/furniture.md`),
stadium stands, people playing.
