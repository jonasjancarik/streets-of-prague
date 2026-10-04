---
read_when: Changing street widths where OSM gives none (`road_width` and `ROAD_WIDTH` in pipeline/osm_area.py), pavements and verges outside the technical map's area, or the roads of plan 021's countryside tiles.
---

# Plan 031: Narrower lanes outside the city

Where the technical map stops, a street's width is guessed from its class. A village
lane tagged `residential` comes out 8 m wide with no verge, twice what the photo
shows, and blocks of garden turn into slabs of asphalt where several meet.

## Status and starting point

- Status: PLANNED.
- Priority: P2 (it affects the whole outer ring and plan 021). Effort: two to four
  days. Risk: medium: street widths feed the street graph, traffic lanes, parking
  and kerbs, so a change here moves a lot.
- Category: fix (map look and driving). Dependencies: none. Plan 021 guesses widths
  the same way in the browser; keep the two rules the same.
- Planned at: `364e7f3cac31a9aedb4a64f8c0b1ac9563258990`, 4 October 2026, from the
  aerial comparison (50.15677, 14.38949; 50.00167, 14.56409; 50.11385, 14.70064) and
  from reading the code and tile `47_95`. Nothing was measured.

Before editing run `git status --short` and:

```sh
git diff --stat 364e7f3cac31a9aedb4a64f8c0b1ac9563258990..HEAD -- pipeline/osm_area.py pipeline/kerbs.py pipeline/build_tiles.py src/countryside.ts
```

## Current state

- **`road_width`** (`pipeline/osm_area.py`, about line 69): the `width` tag, else
  lanes × 3.25 m plus a margin, else `ROAD_WIDTH` by class: `residential` 8 m,
  `unclassified` 7, `living_street` 6, `service` 5, `tertiary` 10.
- **In tile `47_95`** (Nad Vinicemi, north of the city limits) 13 of 14 drive edges
  are `residential` at the default 8 m; the one with a `width` tag is 4.0 m. The
  photo shows single-lane streets of 4–5 m with grass to the fences.
- **A fault to check first.** The same tile draws a grey area of roughly a hectare
  south of Nad Vinicemi where the photo has gardens and an orchard. The tile's
  `roads.road` holds 4,424 m² in one polygon, which is about what 14 edges at 8 m add
  up to, so the patch may lie in a neighbouring tile or come from another layer. Not
  investigated.
- **Inside the city** widths come from the technical map's surveyed kerbs
  (`kerbs.py`); this plan does not touch them.
- **No pavement or verge is made** outside the city unless OSM maps one; the README
  notes that angled parking there stands just outside the carriageway.

## Design

1. **Width from the room there is.** For an edge with no `width` and no `lanes`,
   measure the gap between the buildings, fences and garden plots either side at
   points along it; the carriageway is at most that gap less a verge each side.
2. **Defaults by setting, not class alone.** Without room to measure: `residential`
   among family houses or in a village 5 m; among blocks of flats 6.5 m; a dead end
   or a street under 150 m long 4 m; `unclassified` between villages 5.5 m; `service`
   3.5 m. Calibrate these numbers on the outer districts inside the city, where the
   same OSM classes have surveyed widths.
3. **One lane where it is one lane.** Under about 4.6 m the street graph should carry
   a single lane both ways, with traffic giving way, or be treated as one-way for
   traffic purposes. Find out what the traffic code does with such a street today
   before choosing (`docs/traffic.md`).
4. **A verge, not a pavement.** Between the narrowed carriageway and the plots:
   grass, with a gravel shoulder on through roads. Pavements only where OSM maps
   them (`sidewalk=*` or a separate footway).

## Steps

0. **Find the grey area fault** and fix it or write down where it is. Measure: for
   each class, the surveyed width inside the city's outer districts against today's
   default (a table with medians and spread), and the share of outer-ring edges with
   neither `width` nor `lanes`.
1. New defaults (item 2), calibrated. Rebuild three outer tiles; pictures against
   the photos; check that parking and traffic still work there
   (`scripts/check-parking-clearance.mjs`, a scenario driving the street).
2. Width from the room (item 1).
3. Single-lane behaviour (item 3) and verges (item 4).
4. The same rule in `src/countryside.ts` for plan 021.

## Out of scope

Widths inside the technical map's area, lane markings, speed limits.
