---
read_when: Working on how footways, pedestrian streets and pavements are drawn (pipeline/osm_area.py's road_lines and squares, the path layer in src/ground.ts), or when a square or junction shows pale ribbons that aren't there in reality.
---

# Plan 018: Simplify paths and pavements on the ground

The game draws every mapped footway and pedestrian street as a pale ribbon with
round ends. Across a square that is one surface in reality (Old Town Square), or over
a traffic island, the ribbons show the routes people walk, not anything on the
ground. Leave out the ribbons that only repeat the surface under them, and tidy the
shapes of the rest.

## Status and starting point

- Status: PHASES 0–2 MERGED AND LIVE (the 2026-10-03 map has them). Phases 3–4 with
  traffic islands and tram beds are done on the branch `night-pavements` and built
  for `ujezd`, `centrum` and one suburban chunk in its own clones; the shared map is
  not rebuilt. See "Phases 3–4, 6 October 2026" for what changes and what is owed.
- Priority: P2. Effort: phases 1–2 about a day; phase 3 a day; phase 4 open-ended.
  Risk: low for the look (checked on screenshots); medium for the tile rebuild, which
  touches shared map data (see "Rebuilding tiles").
- Category: appearance and map data. It is not a frame-rate change: a tile has one
  path layer however many ribbons it holds. Tiles get a little smaller.
- Dependencies: plan 013 (squares take their surface from the ways on them), in main.
- Planned at: `1b5756cdf775c7fbde3e5522fb57de5658664bcf`, 1 October 2026, from reading
  the code and two of the user's screenshots (Old Town Square from the helicopter
  next to the aerial photograph; a junction with a T-shaped strip across an island).
  Nothing was rebuilt or run while planning.

Before editing run `git status --short` and:

```sh
git diff --stat 1b5756cdf775c7fbde3e5522fb57de5658664bcf..HEAD -- pipeline/osm_area.py pipeline/kerbs.py pipeline/build_tiles.py pipeline/dtm.py src/ground.ts scripts/check-ground-areas.mjs
```

Branch changes, commits, pushes and deployment need separate authorization.

## Current state

`pipeline/osm_area.py`:

- `add_way()` classes each highway line as `road`, `path`, `dirt`, `sett` or `bridge`.
  Anything that isn't a car road and isn't a crossing is widened into a polygon:
  `g.buffer(width / 2, cap_style="round", join_style="round")`, with widths from the
  table near line 45 (pedestrian 6 m, footway 3 m, path 2 m, steps 3 m, cycleway
  2.5 m) unless OSM gives one. These go to `road_lines["path"]`.
- The widening happens whatever the way lies on, and whatever its `surface` tag says.
  A `footway=traffic_island` or `footway=link` is widened like any other; it is only
  kept out of the kerb search (`sidewalks`).
- Squares: polygons with `highway=pedestrian`, `area:highway` or `place=square` are
  collected in `squares` with their own surface, and `_square_from_ways()` gives a
  square with no surface the clear majority surface of the ways across it
  (`square_ways`). The result is one of `square`, `square_setts`, `square_asphalt`,
  `square_loose` in `areas`.
- At the end everything of a class is merged: `road_polys = {k: unary_union(v)…}`.
  No simplification follows.
- Car roads are sized kerb to kerb by `kerbs.py`, which already uses the footways
  tagged as a street's pavement to place the kerb.

`src/ground.ts`, `layers()`: the squares are drawn first (slabs, setts, asphalt,
gravel), then later `R.path` in `COLORS.path` with the `mosaic` pattern, then setts
and roads. So a path always shows over a square. Everything unmapped is the base
layer in `COLORS.pavement` (asphalt grey).

Old Town Square (see plan 013): the square is a `place=square` relation with no
surface; nine `highway=pedestrian` lines named after the square cross it, all
`surface=sett`, with footways round it. The square is drawn as setts, and the nine
lines as 6 m mosaic ribbons on top.

The technical map (DTM ZPS) is already downloaded and has the surveyed pavement
polygons (`pipeline/beige_report.py` lists the kind `010000000703` as `sidewalk`);
`dtm.py` reads streets, yards and green from it but not pavements.

## Phases

### Phase 0: Before pictures and numbers

Fix the views for the comparison with `scripts/scene.mjs` (record the exact
`t.camera` calls in the Result): Old Town Square from the helicopter as in the user's
screenshot, the junction with the island, Wenceslas Square, Karlovo náměstí (a park
with paths, which must keep them), a housing estate with footways across grass, and
a street with mapped pavements. From the cached `centrum` layers, record the path
polygons' total area, their number of points, and the area of path lying on squares.

### Phase 1: No ribbon where a path crosses a square

After the squares have their surfaces, remove from `road_lines["path"]` whatever lies
inside a square polygon: subtract the union of the squares, a little enlarged (about
half a metre) so no sliver is left along the edge. The lines stay in the walking
network, the kerb search and the passage logic; only the drawn surface goes.

Keep a ribbon whose own surface is clearly different from the square's (asphalt
across setts, for example): compare `_square_surface()` of the way with the square's
kind and subtract only where they match or the way has no surface.

**Check:** Old Town Square is one sett surface; a paved path across a square of
another surface still shows; path area on squares falls to near zero.

### Phase 2: No ribbon that repeats what's under it

Outside squares the same thing happens on pedestrian streets and living streets
whose surface is setts, next to a sett carriageway, and with footways that run on
asphalt-grey pavement.

- A `pedestrian` or `footway` line with `surface` in the cobble kinds goes to
  `road_lines["sett"]` instead of `path`, so a cobbled pedestrian street joins the
  cobbled streets round it rather than showing as mosaic.
- A `footway=traffic_island` or `footway=link` is not drawn at all: it is a route
  across an island or a kerb, and the island itself is the base pavement. (This is
  the T-shaped strip in the junction screenshot. Confirm on that tile's data that the
  strip is such a way before relying on this; if it's an ordinary footway, it falls
  to phase 3's tidying instead.)
- Leave footways across parks, grass and courtyards alone: there the path is real.

**Check:** the island is plain pavement; paths in Karlovo náměstí and the housing
estate are unchanged; a cobbled lane in the Old Town is setts from wall to wall.

### Phase 3: Tidy the shapes that remain

On the merged `path` polygons (and `dirt`), before clipping to the chunk:

- Flat ends and mitred corners for the widened lines, with the round join kept only
  where lines meet, so a path that ends doesn't end in a half disc.
- Close gaps and notches narrower than about a metre (`buffer(+d).buffer(-d)` with
  mitred joins), so parallel footways a step apart become one surface and slivers
  between a path and a road disappear.
- Drop pieces smaller than a few square metres.
- `simplify()` to about 0.2 m, keeping topology.

Do the tidying per class after `unary_union`, and take the roads out of the result
again afterwards so a closed gap never paints path over a carriageway.

**Check:** fewer points (record before and after), no path over a road, building or
water, no visible change to paths in parks beyond squarer ends.

### Phase 4 (later, separate decision): Pavements from the technical map

Where the survey has pavement polygons, draw those as the pavement surface and stop
drawing OSM's sidewalk ribbons along the same streets. This gives real kerb-to-wall
pavements instead of 3 m strips, and needs `dtm.py` to read the kind, a rule for
which OSM footways the survey replaces (those `kerbs.py` already matches to a
street), and a surface choice (mosaic in the centre, asphalt or slabs elsewhere).
Write this up as its own plan once phases 1–3 are in and the remaining ribbons can be
judged.

## Scope

In scope: `pipeline/osm_area.py`, a pipeline test beside the existing ones if there
is a fitting place, `scripts/check-ground-areas.mjs` only if the layer order
changes (it shouldn't), `README.md` where it describes the ground, `todo.md`, this
plan and its row. Rebuilt ground layers for `centrum` first, then the other areas
once the user has approved the look.

Out of scope: the walking and driving networks, kerb placement, the ground's shaders
and palette, the tile format (no format number change: the same keys with different
polygons), and deployment.

## Rebuilding tiles

Phases 1–3 change the pipeline's output, so the ground layer needs a rebuild
(`uv run build_tiles.py centrum --layers ground`). `public/data` and the pipeline
caches are shared between parallel sessions: work on a copy (clone the data and
caches into a worktree, as plan 013 did), show the screenshots, and replace the
shared tiles only with the user's go-ahead. Say in the Result whether the rebuilt
tiles are only local, shared, or deployed.

## Verification

- A `centrum` ground rebuild without errors; `npm run typecheck` if any TypeScript
  changed; `node scripts/check-ground-areas.mjs`.
- Before and after screenshots of phase 0's views, shown to the user side by side.
- Phase 0's numbers again: path area, path area on squares, points.
- People still walk across the squares and islands (the walking network is
  unchanged): one `scene.mjs` scenario on Old Town Square.
- Parked cars: the order-independent hash of their positions is unchanged (paths
  don't affect parking, so a change means something else moved).

## Done criteria and stop conditions

Done when the squares and islands in the test views show one surface, real paths in
parks and estates are intact, the point count has fallen, and the rebuilt `centrum`
tiles have been approved from the screenshots.

Stop and report if removing ribbons leaves a square reading as empty or hard to tell
from the streets round it (the fix may then be a paving pattern on the square, not
ribbons), if the gap-closing merges things that should stay apart (a path and a
neighbouring courtyard), or if any change reaches the networks or the collision grid.

## Result

Implemented on 2 October 2026 in the isolated `f776` worktree, starting at
`b3c22d5`. The scoped-file comparison against the planned revision showed only
`src/ground.ts` had changed; this implementation leaves its renderer, materials,
height sampling, cutting and walls untouched. `kerbs.py` and the networks are
also unchanged.

### Surface rules

Walking buffers retain their surface tag until the squares have been classified.
They lose only their overlap with squares of the same material, or any square
when the route is untagged. An unknown explicit material stays. The square mask
extends 0.5 m into surrounding paving to avoid edge remnants, while mapped green
holes remain clear; subtraction precedes chunk/tile clipping.
Cobbled pedestrian streets and footways use `sett`; paving-stone footways keep
`path`. Ground-level `footway=traffic_island` and `footway=link` lose their drawn
ribbon on pavement but keep sections through mapped or surveyed green and inferred
housing-estate lawns. Bridges and other layers/levels retain theirs, and elevated ways no longer
supply a square's inferred material. An unpaved footbridge also retains the bridge
class rather than falling through to `dirt`.
Both numeric zero and decimal zero strings (`0.0`, `"0.0"`) count as ground level;
ambiguous or multiple levels keep their surface.

The before view exposed a necessary exception to the original plan: a
`place=square` outline can include a park. Karlovo náměstí is named by relation
2052491 and contains the mapped park relation 3366627. Treating the whole named
outline as paving would erase real park paths. Named outlines now exclude mapped
park, garden, wood, orchard, pitch and water surfaces; explicit pedestrian and
`area:highway` surface polygons still keep their paving within green areas.
Karlovo's real paths remain, and its lawns and pond are visible.
The newly visible green ring near Jan Hus is the cached OSM `leisure=garden`
relation 6829643, already present below the named square. No new garden polygon
was invented.

Phase 3 is not implemented: no flat-cap switch, gap-closing, small-piece deletion
or additional simplification. The point count already falls substantially from
the semantic changes. Closing nearby surfaces needs another comparison of narrow
paths and courtyards; it is not required to remove the false square/island ribbons.
Phase 4's DTM pavement import and photo downloads are not needed for this result.

### Matched views

The same rendering code, noon clear weather (`14:00`), date `10-02`, High graphics,
WebGPU, DPR 1 and 1280×800 viewport were used for both sides. The dev server is
this checkout on 5202, with scene server 5292. Before every batch the served
`index.json` marker was checked. The browser was closed after each GPU batch;
the overnight GPU lock serialized the comparisons. No GPU timing is claimed.

Each call was `await t.camera({ at, height, tilt, heading: 0 })`:

| View | `at` (latitude, longitude) | `height` | `tilt` | Before / after |
| --- | --- | --- | --- | --- |
| Old Town Square | `[50.0873, 14.4208]` | 180 | 25 | [Picture](../docs/evidence/plan018/old-town-pair.jpg) |
| Karlovo náměstí park | `[50.075, 14.4195]` | 180 | 25 | [Picture](../docs/evidence/plan018/karlovo-pair.jpg) |
| Wenceslas Square | `[50.0815, 14.4263]` | 180 | 25 | [Picture](../docs/evidence/plan018/wenceslas-pair.jpg) |
| Vinohrady residential pavement | `[50.0755, 14.44]` | 100 | 25 | [Picture](../docs/evidence/plan018/residential-pair.jpg) |
| Karlovo traffic island | `[50.075799, 14.4195498]` | 65 | 0 | [Picture](../docs/evidence/plan018/island-pair.jpg) |
| Petřiny housing estate | `[50.091, 14.346]` | 180 | 25 | [Picture](../docs/evidence/plan018/estate-pair.jpg) |

The island route is OSM `way/1058329131`, `highway=footway`,
`footway=traffic_island`, `surface=paving_stones`, 9.65 m long. Within its 3 m
buffer, mosaic path coverage fell from **34.75 m² to zero**. Its crossing and
walking edges are retained. This confirms a tagged island route rather than
assuming the user screenshot's unknown junction had that tag.

### Numbers and checks

The [metrics](../docs/evidence/plan018/metrics.json) sum areas and ring vertices
from the six cached `centrum` ground chunks, after clipping to their tiles. The
place measurements are square windows with half-width equal to the camera height;
they are geometric measures, not image pixel counts.

| Mosaic path measure | Before | After | Change |
| --- | ---: | ---: | ---: |
| Total area | 1,261,115.91 m² | 699,479.56 m² | −44.5% |
| Area on square layers | 174,267.04 m² | 20,304.72 m² | −88.3% |
| Ring vertices | 112,487 | 80,242 | −28.7% |
| Polygon pieces | 2,060 | 2,354 | +14.3% |

The total area reduction includes reclassification to setts, so it is not all
deleted physical coverage. Polygon pieces rise because subtracting squares splits
some routes. Within the Old Town view, mosaic overlap with squares falls from
12,120.65 to 70.17 m²; different mapped materials remain.

The mosaic-only green measure falls from 293,139 to 221,164 m², including
Wenceslas 877.41 → 3.33 m². That is not physical path loss: the Wenceslas paths
become setts and their combined walking-material footprint is **877.41 →
877.68 m²**. Karlovo's walking-material footprint on green is **4,439.56 →
4,438.79 m²**. The narrow-hole regression prevents the square margin from eating
real paths in a green hole only 0.8 m wide.

Across all `centrum` green, the union of path, dirt, sett and bridge surfaces
loses 15,237.85 m² of old ribbon footprint; **15,101.10 m²** is still covered by
actual square paving, and 2.51 m² by other paving. The remaining 134.23 m² consists
of thin packing/union differences: their sampled vertices, 0.25 m-spaced edges
and interior points lie at most **0.115 m** from replacement paving. This is
within the existing 0.15 m area packing tolerance, not a missing path segment.
See [green preservation](../docs/evidence/plan018/green-preservation.json) and
[sliver measurement](../docs/evidence/plan018/green-slivers.json).

- 29 focused Python tests passed: `test_square_surfaces`, `test_walking_surfaces`,
  `test_dtm_land`, `test_pipeline_efficiency`. The sixteen new surface regressions
  cover material matching, unknown tags, square holes, clipping seams, kerb
  candidates, bridges, raised layers/levels, decimal zero, narrow green holes,
  named parks, explicit paved areas, and links across mapped, inferred and surveyed lawns.
- `node scripts/check-ground-areas.mjs` and `npm run typecheck` passed.
- The broader Python discovery ran 46 tests, with two pre-existing errors in
  `test_build_cache.ChunkBuildTests.test_complete_staged_sequence_matches_immediate_assembly`
  and `test_strict_assembly_preflight_keeps_index_when_dependencies_are_stale`:
  their `osmium(cmd, check)` mock replaces the
  shared `subprocess.run` and rejects `pipeline_commit()`'s `cwd` argument. The
  staged-sequence error was reproduced with the unmodified HEAD `osm_area.py`.
  This unrelated test fixture was left unchanged.
- All 234 tile JSONs retain identical buildings, drive and walk edges, parking
  sections/lots, trees, walls, fences, rails, passages, weirs and crossings.
  [Field comparison](../docs/evidence/plan018/tile-invariance.json).
- The scene retained 1,200 pedestrians at Old Town Square; 1,174 moved more than
  1 m over three simulated seconds, and both scene checks passed (pedestrian motion
  and walking edges present). [Scene result](../docs/evidence/plan018/behavior-final.json).
  The player movement probe was inconclusive
  (speed changed, position did not), so it is not evidence of player traversal.
- The nine loaded tiles have identical sorted parked-car positions and headings.
  Both hashes are `75b8d99849754f2b50e2b6518b7ac165df7d798b519f590f75f57265f9bbbebc`.
  [Parking comparison](../docs/evidence/plan018/parking-result.json).

### Map provenance and remaining work

`public/data/centrum_now`, the ground chunk layers, OSM cuts, DTM packages and tree
cache were APFS-cloned into this worktree; their real paths were verified within
it. Main and its caches were read only. No country/citywide build or download ran.
The source OSM `centrum.osm.pbf` SHA-256 is
`fe5343f02c5005f5b717bca9e8e26de9e74263a32430d16f23e13e31860d4f37`.

The baseline marker was `built=2026-10-02T20:16:12Z`,
`pipeline=934283de3e`; the local candidate was
`built=2026-10-02T21:29:51Z`, `pipeline=b3c22d5adf-dirty`.
Both batches served this checkout's saved copies, not port 5191. The ground-only
offline rebuild called the existing `build_chunk()` for each of the six chunks,
checked unchanged build-input keys at the end and assembled locally. Existing
terrain binaries were retained for the matched geometry comparison; assembly
correctly warns their dependency snapshot is stale. These tiles are for review,
not a verified strict production assembly.

Petřiny uses a separate 25-tile APFS snapshot in `public/data/estate_now`, with
only the needed `praha_4_8.parsed.pkl` OSM cache copied. Its baseline is the
`praha` snapshot built at `2026-10-02T20:51:35Z`, pipeline `5932924ecc-dirty`.
Only the displayed region's `areas` and `roads` were regenerated through
`extract()` and the normal `_rings` packing tolerances; buildings, networks,
trees and parking were retained. It is a small surface preview, not a complete
assembled city map. The matched picture confirms the diagonal paths across its
lawns remain. Parking and the remaining surface comparison are recorded in
[estate evidence](../docs/evidence/plan018/estate-result.json).
The view has 11,563.77 → 11,448.23 m² of walking ribbons on green, with only
**0.59 m²** of the original footprint left without replacement paved coverage;
the other removed ribbons lie on actual square/road paving. The 14 loaded tiles'
parking hashes match. [Physical coverage](../docs/evidence/plan018/estate-green.json).

Review the pictures, then rebuild approved shared ground and terrain layers from
the chosen commit, with the normal strict assembly checks. No push, merge or
deployment was performed.

### Independent review follow-up, 3 October 2026

The review of `5efe19e` found two cases its fixtures did not combine. A named
square was trimmed before DTM green and inferred apartment-block lawns were
available, so it could still pave those lawns and remove their paths. Also,
route-only link filtering ran before material matching and could erase an
explicit asphalt link across a sett square.

The follow-up moves named-outline trimming after all green sources are collected.
Route-only filtering retains green sections and explicitly different materials
inside mapped square paving, then removes only the matching-material overlap.
Explicit pedestrian/area-highway surface polygons keep their paving priority.
Three new extraction regressions cover surveyed green, inferred lawns and both
link/traffic-island tags with matching versus contrasting materials. All **32
focused Python tests pass**. The reviewer's independent overlapping-box probe
also passes; its surveyed-green/garden fixtures now have **zero square overlap
and 120 m² of retained path**, and asphalt/wood/gravel link probes retain 60 m²
inside the sett square.

Furniture follow-up `fdaba9c` is accepted by code and regression review: it treats
`square` as a final exclusion after green, with an explicit slab-over-park test
and a trimmed named-square test. No furniture source was changed in this worktree;
combined furniture/ground scene validation remains with integration.

An offline `centrum` ground rebuild for the follow-up succeeded. Against the
`5efe19e` preview it removes another **3,403.66 m²** of named-square paving over
known green, while all 234 tiles retain identical buildings, networks, parking
inputs, trees, passages, crossings, rails, walls, fences and weirs. Its marker is
`built=2026-10-02T22:02:01Z`, pipeline `5efe19e9c5-dirty` (the preserved index
records the actual marker). [Follow-up measurements](../docs/evidence/plan018/review-followup/review-metrics.json).
The existing six paired images and main metrics above remain evidence for the
first implementation; they are not labelled as captures of this follow-up.
Two follow-up pairs use the same renderer/time/date/viewport as the initial
comparison, with heading 0: [surveyed green](../docs/evidence/plan018/review-followup/surveyed-green-pair.jpg)
at `[50.0807855,14.4487146]`, height 100, tilt 25; and
[contrasting asphalt links](../docs/evidence/plan018/review-followup/distinct-link-pair.jpg)
at `[50.07585,14.41382]`, height 65, tilt 0. The baseline is the saved `5efe19e`
preview; the candidate is the reviewed rebuild. Both markers were checked and
the browser closed before releasing the GPU lock. These confirm restored lawn
patches and retained contrasting route surfaces; no timing or furniture claim
is inferred.

### Phases 3–4, 6 October 2026 (branch `night-pavements`)

**Is the 2026-10-03 map built with phases 0–2?** Yes. The live index
(`https://data.streetsofprague.com/2026-10-03/praha_now/index.json`) says
`built=2026-10-03T10:24:31Z`, `pipeline=f760251180`, and both phase commits (`2885a75`,
`7ad54d6`) are ancestors of it. In the live tile the mosaic ribbon over the Karlovo
náměstí island route is gone (0 m² within 3 m of `[50.075799, 14.4195498]`).

**What the branch does.**

- `pipeline/dtm.py` also reads the survey's pavements (Chodník), driveways across them
  (Nájezd), cycle paths, traffic islands (Dopravní ostrůvek), medians (Dělící pás),
  platforms (Nástupiště) and tram beds (Tramvajová dráha); `dtm.walks()` hands them
  over one by one. `VERSION` is 4, so `surfaces.pkl` is read again from the 57
  packages once (a few minutes).
- `pipeline/pavements.py` (new). `surveyed()` chooses each surveyed polygon's paving
  from the OSM ways for walking on it, because the survey's own "prevailing surface"
  is "not stated" for 96 % of the pavement area: mosaic (`roads.pavement`), asphalt
  (`roads.pavement_asphalt`), earth for an unpaved path (joined to `roads.dirt`), setts
  for a walking street (joined to `roads.sett`). One without a tagged way is paved
  like the nearest tagged one within 60 m, else mosaic. Islands, medians, platforms
  and driveways are paved like pavements, cycle paths are asphalt. Gaps under 0.6 m
  and holes under 25 m² between pavement and carriageway are filled, except surveyed
  greenery (tree pits). `outside()` takes mapped squares and car parks out.
  `without_survey()` takes the footways' ribbons off the surveyed shape; a
  `footway=sidewalk` line at least half on it loses its ribbon altogether. Outside
  the survey nothing changes, so the derived ribbons remain the fallback.
- Phase 3: `ribbon()` gives the widened lines flat ends and mitred corners (round only
  where ways meet), `tidy()` closes gaps under 1 m (never onto carriageways, buildings
  or water), drops pieces under 4 m² and simplifies to 0.15 m, for `path` and `dirt`.
- Gardens (`osm_area._gardens`): the surveyed pavements cut the residential blocks
  like the streets do, so plots, fences, hedges, gates and paved strips start at the
  pavement's back edge and not at the kerb.
- `src/ground.ts` draws `pavement_asphalt` and `pavement` over the ribbons and under
  the carriageways, and `trambed` (the ballast colour, gravel pattern) over the
  carriageway and under the rails' concrete strip. No new colour or pattern; up to
  three more ground layers per tile.
- `kerbs.py`, the walk and drive networks and the game's parking and furniture code
  are untouched. `DERIVED_PAVEMENTS=1` builds the ground the old way, for A/B.

**Numbers.** Before = the same code with `DERIVED_PAVEMENTS=1`; ground layer, m²
after clipping to tiles. Scripts and results are in
[`docs/evidence/plan018/phase3-4`](../docs/evidence/plan018/phase3-4) (`metrics.py`
for the ground chunks with a per-tile table, `tiles.py` for assembled maps).

| | `ujezd` (25 tiles) | `centrum` (234) | Petřiny, `praha` chunk 4,8 (64) |
| --- | ---: | ---: | ---: |
| Ribbons (`path`) before → after | 67,678 → 10,953 | 700,398 → 164,958 | 189,917 → 45,311 |
| Ribbon points | 7,772 → 1,877 | 80,975 → 19,075 | 17,507 → 6,035 |
| Surveyed pavement, mosaic | 87,891 | 846,092 | 103,274 |
| Surveyed pavement, asphalt | 31,686 | 388,266 | 145,298 |
| Earth paths (`dirt`) | 2,514 → 13,529 | 18,281 → 60,587 | 59,397 → 66,774 |
| `sett` | 94,874 → 53,541 | 929,097 → 546,212 | 21,438 → 19,620 |
| Tram bed | 0 | 11,380 | 28,092 |
| Tiles with surveyed pavement | 23 | 231 | 60 |
| Ribbon over carriageway | 5,151 → 1,595 | 86,510 → 39,749 | 22,128 → 13,112 |
| Ribbon over buildings | 2,776 → 1,244 | 56,897 → 41,527 | 2,340 → 1,347 |
| Walk network on surveyed pavement | 30,540 of 45,960 m | 284,475 of 502,587 m | 46,356 of 125,171 m |
| Kerb samples with surveyed pavement just outside | 1,804 of 2,648 | 22,230 of 35,658 | 4,897 of 11,432 |
| Kerb samples with carriageway just outside | 1,215 → 403 | 13,605 → 5,738 | 1,937 → 1,907 |
| Ground chunk size | 875 → 1,014 kB | 9.6 → 10.9 MB | 3.4 → 3.9 MB |

Surveyed by kind on Petřiny's chunk (m²): pavement 345,880, tram bed 31,104, platform
3,193, median 3,121, island 2,833, driveway 161.

The sett area falls because a cobbled footway on a surveyed pavement is now mosaic;
judged on the screenshots, that reads better (the pavement stands apart from the
cobbled carriageway). Earth grows because a park path the survey has is drawn in its
surveyed width.

**What else changes in the tiles** (`tiles-ujezd.json`, `tiles-centrum.json`): `walk`,
`drive` (with the kerbs), `sections`, `buildings`, `trees`, `utility`, `crossings`,
`rails` and `walls` are identical in every tile. `lots` differs in 22 of centrum's
234 tiles by a few square metres (1,823 → 1,824 lots, 349,258 → 349,345 m²), because
an inferred car park stops at a garden and the gardens moved. Gardens, lawns, named
squares, plots, fences, patches, sheds and drive spots differ where a block now
starts behind its pavement.

- **Drive spots fall a lot**: 57 → 17 in `centrum`, 328 → 86 on Petřiny's chunk. A
  car needs 6.2 m between gate and house, and the gate has moved from the kerb to the
  pavement's back edge; before, most of those cars stood across the pavement. This
  is the honest geometry but it thins plan 029's driveway cars: the owner may want
  `DRIVE_ROOM` lowered or cars parked beside the house instead.
- Fences well inside a pavement (more than 0.5 m from its edge) in `centrum`:
  2,032 → 1,647 m of 42,645 (mostly OSM's own); hedges 602 → 240 m of 11,243.
- Pavement drawn over IPR's surveyed greenery in `centrum`: 12,107 m² of lawn, 3,182
  shrubs, 2,076 groups of trees, 1,264 meadow, 796 beds, together 1.6 % of the
  pavement. The two surveys disagree there; the pavement is on top. Over inferred
  gardens 72 m², over mapped car parks 58 m², over garden strips 39 m².
- 4,517 of centrum's 25,738 trees stand on surveyed pavement (street trees), as they
  should; the game makes up no trees and puts no furniture on a pavement, since it
  keeps both off everything in `roads`.

**In the game** (matched runs, `ujezdb`/`centrumb` = before; counts over the tiles
round each view): parked cars are not in identical places, because the made-up trees
and furniture they keep clear of moved off the pavements, and the choice of spots
is one random sequence per tile. Totals: `ujezd` views 529 → 536, 394 → 391, 515 →
512, 491 → 487; `centrum` 746 → 745, 322 → 314, 1,163 → 1,160, 653 → 659, 517 →
502. Furniture per view: 11 → 11, 9 → 13, 1 → 1, 17 → 16; 7 → 7, 30 → 21, 19 →
20, 9 → 9, 4 → 12.

**Pictures** (before | after; 14:00, clear, date 10-02, 1280×800, heading 0;
`t.camera({ at, height, tilt })`):

| View | `at` | height, tilt | |
| --- | --- | --- | --- |
| Újezd junction | `[50.0812, 14.4047]` | 110, 0 | [pair](../docs/evidence/plan018/phase3-4/junction-pair.jpg) |
| The same, lower | `[50.0812, 14.4047]` | 28, 58 | [pair](../docs/evidence/plan018/phase3-4/street-pair.jpg) |
| Malá Strana lanes | `[50.0852, 14.4045]` | 70, 0 | [pair](../docs/evidence/plan018/phase3-4/lanes-pair.jpg) |
| Smíchov street | `[50.0775, 14.4060]` | 110, 0 | [pair](../docs/evidence/plan018/phase3-4/smichov-pair.jpg) |
| Kampa park | `[50.0840, 14.4075]` | 110, 0 | [pair](../docs/evidence/plan018/phase3-4/kampa-pair.jpg) |
| Karlovo náměstí | `[50.0755, 14.4195]` | 140, 20 | [pair](../docs/evidence/plan018/phase3-4/karlak-pair.jpg) |
| Tram bed, Letná | `[50.09385, 14.40221]` | 130, 0 | [pair](../docs/evidence/plan018/phase3-4/trambed-pair.jpg) |
| Tram bed, Vinohrady | `[50.07812, 14.43365]` | 130, 0 | [pair](../docs/evidence/plan018/phase3-4/trambed2-pair.jpg) |
| Korunní | `[50.0755, 14.44]` | 100, 25 | [pair](../docs/evidence/plan018/phase3-4/vinohrady-pair.jpg) |
| Korunní, street level | `[50.0755, 14.44]` | 25, 60 | [pair](../docs/evidence/plan018/phase3-4/vinohrady-street-pair.jpg) |
| Old Town Square | `[50.0873, 14.4208]` | 180, 25 | [pair](../docs/evidence/plan018/phase3-4/oldtown-pair.jpg) |

Pavements run from kerb to wall with rounded corners. In parks the surveyed paths
are wider than the ribbons and mostly asphalt grey where they were beige (Kampa,
Letná): right by the tags, but a visible change of mood there. The Kampa pair also
shows more trees after; they come with the ground-cover layer, which was rebuilt for
each side, and the difference was not traced.

**Speed.** The first version spent 123 s of a 173 s chunk in the pavement step. The
cause was growing shapes that carry the surveyed carriageway's rounded corners
(about 250,000 points a chunk). Simplified by 3 cm first, and with each garden block
laid against the streets near it only, a chunk on a fairly quiet machine: `ujezd`
20 s, Petřiny 65 s (pavement step 3 s, tidying inside the 9 s of joins, gardens 18 s),
`centrum`'s six chunks 8–85 s.

**Checked.** All 200 pipeline tests (`python -m unittest discover -p "test_*.py"`),
among them 11 in `test_pavements.py` and a new one in `test_walking_surfaces.py`
(gardens start behind a surveyed pavement). The four tests that failed overnight
were the fixture: it lays its ways in the middle of `ujezd` and did not patch
`dtm.walks`, so the real pavements took 23 m² off each ribbon. `npm run typecheck`,
`check-ground-areas.mjs` (extended with the new layers' order),
`test-ground-seams.mjs`, `check-parking-clearance.mjs`, `check-furniture.mjs`.

**Owed.**

1. The frame time of up to three more ground layers per tile (`bench.mjs --ab`
   against the before map) was not measured: the machine was rebuilding the city.
2. The shared map is not rebuilt. Ground first, then cover, IPR and terrain as
   usual (see "Rebuilding tiles"); nothing was assembled strictly here, since the
   worktree's IPR and terrain layers are main's.
3. The owner's eye on: mosaic instead of setts for cobbled pavements, grey park
   paths, far fewer driveway cars.
4. Medians are paved like pavements (grassed ones are probably surveyed as greenery
   already; not checked on a picture). The tram bed shows on Letná only under trees.
5. 39 % of centrum's walk network is off surveyed pavement (crossings, park paths,
   squares, lines mapped a little off) and 16 % of kerb samples have carriageway
   outside them; neither was looked at case by case.
