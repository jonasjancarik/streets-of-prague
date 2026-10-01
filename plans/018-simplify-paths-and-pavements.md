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

- Status: PLANNED.
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

Not started.
