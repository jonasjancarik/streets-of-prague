---
read_when: Working on the ground's surfaces (squares, courtyards, green, the plain beige base), pipeline/osm_area.py's areas, pipeline/dtm.py's kinds, or the ground palette in src/ground.ts.
---

# Plan 013: Fill the beige ground

Much of the town is still one flat beige: the base under everything unmapped, and
squares that are drawn the same as the pavement. From above (the camera over Old
Town Square, 30 September 2026) the square, its pavements and the courtyards behind
it read as one colour, though the real square is grey-brown granite setts.

This plan gives that ground what the data already knows about it, in four phases,
cheapest first: squares get their surface from OSM, the palette tells the paved
kinds apart, the technical map (DTM) adds courtyards and green, and the aerial photo
classifier decides what the courtyards are made of.

## Status and starting point

- Status: PHASES 0–3 DONE in main and rebuilt into shared local map data.
  Phase 4 is deferred to [plan 014](014-classify-courtyard-surfaces.md).
  The server deployment was not changed.
- Planned at `8f35d7a`, 30 September 2026, from reading the code and measuring the
  data (below). Nothing in the game was changed or rebuilt while planning.
- Effort: phases 1–2 about a day; phase 3 one to two days; phase 4 open-ended.
- Risk: low for the look (every phase is checked on screenshots); medium for the
  tile rebuilds, which touch shared map data (see "Rebuilding tiles").

## What the data says

Measured on 30 September 2026 against the `centrum` area's cached layers
(`pipeline/.cache/layers/centrum/`). "Plain beige" below means the base only: not
covered by any area, road surface or building. The `centrum` area has **183 ha of
plain beige out of 1 290 ha**. Squares and paths are beige too, but mapped.

### Squares in OSM

Of the 388 squares and pedestrian areas in the `centrum` OSM extracts (areas with
`highway=pedestrian`, `area:highway` or `place=square`):

| `surface` | count |
| --- | --- |
| none | 156 (40 %) |
| `sett` | 128 |
| `paving_stones` | 65 |
| `asphalt` | 18 |
| other (`compacted`, `paved`, `concrete`, `unhewn_cobblestone`, `concrete:plates`, `cobblestone`, `unpaved`, `sand`) | 21 |

The ones with no surface include most of the big named squares: Staroměstské,
Václavské, Karlovo, Malostranské, Míru, Republiky, Jiřího z Poděbrad, Palackého.

Old Town Square is the relation `place=square` 2362716 with no `surface`, and no
pedestrian area covers it. But all nine `highway=pedestrian` lines named
"Staroměstské náměstí" across it are `surface=sett`, and so are the streets that
lead into it and nearly all the footways round it. **The square's surface has to
be taken from the ways on it**, not from its own tags.

### Technical map (DTM ZPS, set 2)

The packages are already downloaded (`pipeline/.cache/dtm/ZPS_OPL/`), but
`dtm.py` keeps only three kinds (carriageway, lay-bys, parking). Measured on Praha 1
only (`VS_CZ010_MOMC_500054`), transformed the way `dtm.surfaces()` does it (S-JTSK
to WGS84 with the Prague area of interest; without it the result is metres off):

| DTM class (code) | Area | Already OSM green | Plain beige now |
| --- | --- | --- | --- |
| Dvůr, nádvoří (`010000018903`) | 36.6 ha | 2.0 ha | **26.9 ha** |
| Chodník (`010000000703`) | 68.7 ha | 17.3 ha | 13.6 ha (correctly paved) |
| Udržovaná plocha zeleně (`010000021503`) | 81.8 ha | 71.9 ha | **8.0 ha** |
| Zahrada (`010000020903`) | 22.0 ha | 19.3 ha | 2.3 ha |
| Hřiště (`010000015203`) | 2.7 ha | 2.2 ha | 0.5 ha |
| Les (`010000021103`) | 15.0 ha | 14.9 ha | 0.1 ha |

Courtyards are the biggest piece of beige. The DTM's material field
(`PrevazujiciPovrch`) is 99 (unknown) almost everywhere, so it says *what* a surface
is, not what it's made of. Under Old Town Square the DTM has only "Chodník".

Not yet measured: the rest of the `centrum` area (parts of Praha 2, 3, 5, 7, 8), and
how much of Praha 1's beige none of these classes cover.

### IPR greenery (`Hosted/OPK_CUR_OPK_SMZ_VP_P`)

4 445 polygons (103 ha) in the `centrum` box, but only **4.2 ha** of them fall on
plain beige: OSM already maps nearly all of it. Not worth it for the beige; see
"Considered and deferred".

## Phase 0: a before picture and a beige count

1. Take the before screenshots with `scripts/scene.mjs` (scene-testing skill), each
   from above and at a low angle, midday, clear weather:
   - Old Town Square, the camera as in the user's screenshot (roughly
     `t.camera({ at: [50.0873, 14.4208], height: 180, tilt: 25 })`);
   - Václavské náměstí; Karlovo náměstí; Malostranské náměstí;
   - a Malá Strana block with courtyards (behind Nerudova) and a Nové Město block
     (round Vodičkova).
   Keep the exact `t.camera` calls in this plan's Result so the after shots match.
2. Add `pipeline/beige_report.py`: for an area's cached layers, the plain beige in
   hectares, and, given a DTM package, how the DTM classes above split between
   OSM green, other mapped ground and plain beige. It's the measurement above made
   repeatable, so each phase can report what it changed. Transform with the same
   `AreaOfInterest` as `dtm.surfaces()`.

## Phase 1: squares get their surface

In `pipeline/osm_area.py`:

1. Decide a square's surface from its own `surface` tag, grouped:
   - setts: `sett`, `cobblestone`, `unhewn_cobblestone` (the existing `COBBLES`
     minus `paving_stones`);
   - slabs: `paving_stones`, `concrete:plates`, `paved`, `concrete`;
   - asphalt: `asphalt`;
   - loose: `compacted`, `unpaved`, `sand`, `gravel`, `fine_gravel` (drawn as dirt or
     gravel).
2. A square with no tag inherits one from the ways on it: the length of
   `highway=pedestrian`, `footway`, `living_street` and `service` lines inside the
   polygon, grouped as above and not counting `footway=crossing`, tunnels or other
   layers. The biggest group wins if it has at least 60 % of the length and there's
   at least 30 m of it. Otherwise the square stays as it is (slabs). Squares are
   decided after the loop over all features, like the `maybe` passages, since the
   lines can come after the polygon.
3. Emit them as separate area keys, `square_setts`, `square_asphalt`,
   `square_loose`, and keep `square` for slabs and the undecided ones, so tiles that
   haven't been rebuilt still draw.
4. Update the other readers of `areas.square` to take all four:
   `src/map/vegetation.ts:51` (no trees on squares) and `pipeline/ground_cover.py:441`
   (squares count as paving).

In `src/ground.ts`, draw the new keys where `square` is drawn now, in a fixed order
(each layer has a slot whether a tile has it or not):

- `square_setts`: a pedestrian sett colour, greyer and a little lighter than the
  roads' `sett` (`#8a847a`); start near `#9c958a`, pattern `setts`;
- `square_asphalt`: `COLORS.asphalt`, pattern `asphalt`;
- `square_loose`: `COLORS.dirt` or gravel.

Check the `setts` pattern's stone size on a big square from above and at street
level. If it reads as road cobbles rather than a square, stop and show the user
before tuning the pattern. A new shader pattern costs frame time (performance skill).

Report: how many squares each rule decided, in `centrum` and in `praha`, and the
named squares that are still undecided.

## Phase 2: palette

Today the base (`#cdbfa8`), squares (`#d0c3ab`) and paths (`#d4c8b2`) are nearly the
same colour. Move them apart so the kinds read apart from above:

- the base (pavements and everything unmapped): cooler and a little greyer;
- slab squares: lighter than the base;
- paths through parks (`path`): keep them warm.

It's only colours in `COLORS`, but it changes the look of the whole city: show the
user before/after screenshots from phase 0's views and let them choose between two
or three variants. Keep the sunny, weathered look (the visual direction in memory).

## Phase 3: courtyards and green from the DTM

In `pipeline/dtm.py`:

1. Read more kinds: `yard` (`010000018903` Dvůr, nádvoří), `green` (`010000021503`
   Udržovaná plocha zeleně), `garden` (`010000020903` Zahrada), `pitch`
   (`010000015203` Hřiště), `wood` (`010000021103` Les). Bump `VERSION`.
2. `streets()` now joins every kind in `surfaces()`. Restrict it to the three street
   kinds, or the new kinds would become road surface.
3. Add `land(bbox, transform)`: `{kind: geometry}` on the ground (level 0) in local
   metres, with the same index-once approach as `streets()`. Leave out
   `_smooth()`'s corner rounding, which is meant for kerbs.

In `pipeline/osm_area.py`, add them as areas `dtm_yard`, `dtm_green`, `dtm_garden`,
`dtm_pitch`, `dtm_wood`, clipped to the tile.

In `src/ground.ts`, draw them just above the base and `LAND_USE`, below `COVER` and
everything from OSM, so OSM wins wherever both have something (OSM's parks carry
paths, pitches and ponds the DTM lumps together):

- `dtm_green`, `dtm_garden`: the park and garden colours, pattern `grass`;
- `dtm_wood`: wood; `dtm_pitch`: pitch, without the painted outline;
- `dtm_yard`: its own neutral paved look, darker and greyer than the pavements (a
  start: `COLORS.yard`, pattern `concrete`). This is a stand-in until phase 4 says
  what each courtyard is made of. Show the user before settling it.

In `src/map/vegetation.ts`, fill `dtm_green` and `dtm_garden` like `park` and
`garden`, so they get shrubs, and keep trees off `dtm_yard` and `dtm_pitch`.

Watch for: courtyards the DTM draws under glass roofs or passages (check a few
arcades in the centre); DTM green on roofs or decks (use level 0 only); and tile
size (run `beige_report.py` and compare the tiles' gzip size before and after).

## Phase 4: what the courtyards are made of

(Status, 4 October 2026: the photo classifier now runs for the whole city on the
unmapped ground, see [docs/beige-cover-city.md](../docs/beige-cover-city.md). The
courtyards themselves, `dtm_yard`, are still the neutral fallback: plan 014.)

The orthophoto classifier (`pipeline/ground_cover.py`, `?cover=rules`, see `todo.md`
"Fill the plain beige areas") was built for all the unmapped ground and needs the
whole city's photos (a 16–65 GB download). With phase 3 the target shrinks: classify
inside each DTM courtyard (grass, trees, paving, asphalt, gravel) and give the
courtyard polygon, or its parts, the result. The courtyard's exact outline removes the
guesswork about where the ground ends.

This phase gets its own plan once phases 1–3 are in and `beige_report.py` shows what
is left.

## Rebuilding tiles

Phases 1 and 3 change the pipeline's output, so the tiles need a rebuild
(`pipeline/build_tiles.py`). `public/data` and the caches are shared between parallel
sessions: in a worktree, clone them before rebuilding (memory: shared map data), and
say in the Result whether the rebuilt tiles are only local or shared.

## Verification

For each phase:

- `npm run typecheck`; for pipeline changes, a rebuild of `centrum` without errors.
- The after screenshots from phase 0's views, shown to the user next to the before
  ones.
- `beige_report.py`'s numbers before and after (plain beige in hectares).
- Phase 1: Old Town Square is setts; Malé náměstí (`sett`) and náměstí Václava Havla
  (`paving_stones`) are unchanged in kind; a square without ways on it stays slabs.
- Phase 3: no courtyard or lawn drawn over a street or a building, spot-checked in
  Malá Strana and Nové Město.
- Only phase 1's new sett pattern tuning (if any) and phase 3's extra layers could
  cost frame time: if either adds a shader pattern or many draw calls, compare with
  `scripts/bench.mjs --ab` (performance skill).

## Considered and deferred

- **IPR greenery polygons**: only 4.2 ha of plain beige in the centre. Useful later
  for detail inside parks (1 219 shrub groups, 268 hedges, some 400 flowerbeds),
  which is a separate look improvement.
- **DTM materials**: `PrevazujiciPovrch` is unknown almost everywhere; revisit if IPR
  fills it in.
- **Broad variation from above** (worn walking lines, stains, darker edges by the
  houses at tens of metres): would help large squares after phases 1–2; it's drawn on
  every pixel, so measure it (performance skill).
- **Other DTM classes**: steps (`Schodiště`, 1.6 ha in Praha 1), planters, and
  "Stavba pro zpevnění povrchu" (8.8 ha, unclear what it is on the ground). Look at
  them once phase 3 is in.

## Result

Phases 0–3 are in commit `a1f11e4` in the plan-013 worktree at
`/Users/janca/.codex/worktrees/2bc4/streets-of-prague`; the result and deferred
plan are committed separately. The initial worktree's `public/data` and relevant
`pipeline/.cache` directories were independent copy-on-write copies of the original
data. Converted plan-010 landmarks remain only
in `/tmp/sop-landmark-colours-010/{centrum,praha}_now` and are not activated.

### Phase 0: baseline

All camera captures use `t.time("14:00")`, `t.weather("clear")`, High graphics,
`?area=centrum`, and `heading: 0`. Each named view was captured from above with
`tilt: 25`, then low with `tilt: 65`:

| View | Exact `t.camera` calls (`at`, heights) |
| --- | --- |
| Old Town Square | `{ at: [50.0873, 14.4208], height: 180, tilt: 25, heading: 0 }`; `{ at: [50.0873, 14.4208], height: 55, tilt: 65, heading: 0 }` |
| Václavské náměstí | `{ at: [50.08195, 14.4282], height: 180, tilt: 25, heading: 0 }`; `{ at: [50.08195, 14.4282], height: 55, tilt: 65, heading: 0 }` |
| Karlovo náměstí | `{ at: [50.0753, 14.4195], height: 240, tilt: 25, heading: 0 }`; `{ at: [50.0753, 14.4195], height: 55, tilt: 65, heading: 0 }` |
| Malostranské náměstí | `{ at: [50.0883, 14.4030], height: 180, tilt: 25, heading: 0 }`; `{ at: [50.0883, 14.4030], height: 55, tilt: 65, heading: 0 }` |
| Nerudova block | `{ at: [50.08865, 14.3995], height: 180, tilt: 25, heading: 0 }`; `{ at: [50.08865, 14.3995], height: 55, tilt: 65, heading: 0 }` |
| Vodičkova block | `{ at: [50.0808, 14.4245], height: 180, tilt: 25, heading: 0 }`; `{ at: [50.0808, 14.4245], height: 55, tilt: 65, heading: 0 }` |

The original centre tile copy is served as `centrum_before` to keep the renderer,
weather and camera identical. Matched baseline and phase-1 images are in
`/private/tmp/sop-013-images/{before,phase1}/`; phase-3 and palette captures are
in sibling folders. The first phase-1 screenshots mistakenly used the game's
default `praha` area and were replaced with `centrum` captures. Initial palette
captures contained a fading start overlay and were likewise replaced after a
2.5-second wait; those discarded attempts are not evidence.

`pipeline/beige_report.py` reads assembled tiles and optionally one DTM package.
It uses the same EPSG:5514 → WGS84 area-of-interest transform as `dtm.surfaces()`.
The baseline centre count is 182.64 ha plain ground out of 1,289.73 ha in 234 tiles;
the JSON is `/private/tmp/sop-013-baseline-beige.json`. The Praha 1 DTM package
split includes 26.89 ha of courtyard and 8.03 ha of maintained green on formerly
plain ground. A separate report can read copied historical tiles with `--tiles-root`.

### Phase 1: square surfaces

Own tags group setts, slabs, asphalt and loose ground. With no own tag, the chosen
group must cover at least 60% and 30 m of eligible pedestrian, footway, living-
street or service lines within the polygon. Crossings, tunnels and nonzero layers
are excluded. `place=square` is now requested from OSM; it was absent from the old
feature filter. `square`, `square_setts`, `square_asphalt` and `square_loose` have
fixed rendering slots, and older tiles still use `square`.

`pipeline/square_report.py` counted 366 centre polygons: 227 explicitly tagged,
42 inherited, 97 undecided. Of those inherited, 29 became setts, 7 slabs, 5
asphalt and 1 loose. Its centre report is
`/private/tmp/sop-013-centrum-squares.json`. The full-city extract yielded 2,721
polygons: 1,441 explicitly tagged, 154 inherited and 1,126 undecided; the report
is `/private/tmp/sop-013-praha-squares.json`. The report clips exported OSM areas
to each area box; its polygon totals therefore differ from the earlier plan's
raw-extract inventory. Old Town Square and Malostranské náměstí inherit setts;
Malé náměstí retains its explicit setts, and náměstí Václava Havla retains its
explicit slabs. Karlovo and Václavské náměstí remain undecided slabs. A square
without qualifying ways stays slabs.

The isolated `centrum` ground rebuild passed six chunks and changed 211 of 234
assembled tiles. The plain-ground count fell to 179.75 ha because newly requested
`place=square` areas are mapped rather than plain. The JSON is
`/private/tmp/sop-013-phase1-beige.json`. At Old Town Square the new sett surface
reads as a continuous pedestrian square at 180 m and 55 m; its stone pattern does
not look like an oversized road-cobble grid in those captures.

### Phase 2: palette

Three lighter pavement variants were captured at all six matched views in
`/private/tmp/sop-013-images/palette-{a,b,c}/`. The user chose asphalt grey for
the general pavement instead: `#92908c` with the existing asphalt pattern, near
the darker road hue. Slab squares remain light (`#d7d3cb`), park paths warm
(`#d8cbb6`), and pedestrian setts `#9c958a`. The accepted direction is captured
at `/private/tmp/sop-013-images/asphalt-provisional/`. Colours do not change the
phase-1 plain-ground area.

### Phase 3: surveyed courtyards and green

`dtm.py` now reads ground-level yards, maintained green, gardens, pitches and
woods; street surfaces still index only road, roadside and parking kinds. Land
polygons retain surveyed corners without the kerb smoothing. The layers draw
between land use and OSM/photo cover, and the vegetation raster follows the same
precedence. DTM green, garden and wood can grow appropriate vegetation; yards and
pitches suppress generated trees. The user chose the lighter neutral courtyard
shade (`#85837e`) after viewing matched Nové Město alternatives; the material
remains a fallback until plan 014 classifies actual courtyard surfaces.

The isolated `centrum` ground rebuild passed all six chunks and changed 230 of
234 tiles. Plain ground fell from 179.75 to 72.20 ha; the JSON is
`/private/tmp/sop-013-phase3-beige.json`. The 234 assembled tile JSON files grew
from 16,403,145 to 19,213,498 raw bytes, and from 4,038,613 to 4,975,149
bytes compressed individually with gzip level 9 (+23.2%). Matched phase-3 images
are in `/private/tmp/sop-013-images/phase3-provisional/`. Additional DTM yard
close-ups are in `yard-provisional/` and `yard-lighter/`.

The isolated default `praha` rebuild also passed: 252 chunks in 677 seconds,
14,595 assembled tiles, 7,858 changed. Its data directory grew from 601,828 to
670,372 KiB (+11.4%). Its Old Town Square tile has `square_setts`, DTM yard and
DTM green polygons; a final default-area screenshot is
`/private/tmp/sop-013-images/final-city/old-town-city-above.png`. The final
12 matched centre images with the chosen asphalt pavement and lighter yard are
in `/private/tmp/sop-013-images/final-centre/`, paired by filename with `before/`.

Two DTM-yard overlaps with mapped central passages were inspected from above,
and a cutaway view in pasáž Koruna was compared with the original centre tiles.
The roofs and visible floor remain in place. Low-angle free-camera views into
the other arcades were occluded by building facades, so they do not verify every
covered courtyard. In Malá Strana and Nové Město, the sampled streets and roofs
remain visible above the DTM courtyard and green layers. `check-ground-areas.mjs`
also verifies the fixed DTM-before-OSM ground order and no outline on DTM pitches.

### Final checks and limits

`npm run build` (including typecheck), the four `test_square_surfaces.py` cases,
the `test_dtm_land.py` ground-level/street separation case, the eight existing
`test_landmark_colours.py` cases, `node scripts/check-ground-areas.mjs`, and
`git diff --check` passed. The integrated client also passed the material-sharing,
car-pool, tree-pool, spawn-work, streaming, resting-car, staged-landmark-marker,
and WebGPU/WebGL graphics checks before plan-013 edits. Final WebGPU and WebGL
scene captures after the ground edits reported no page errors. The first final
`scene.mjs run all` attempt had transient police-spawn and clear-ground failures;
the affected scenarios passed individually, and the next full run passed all three.

No new procedural pattern was added: the new areas reuse the existing asphalt,
setts, gravel, concrete, grass, wood and pitch patterns. In one completed
alternating WebGPU observation at 2×, Old Town Square used 123 draw calls on
the integrated baseline and 129 with the new ground; Malá Strana used 176 and
187. The user stopped frame-time measurement because it was unreliable, so the
comparison was interrupted and no timing conclusion is made. The benchmark's
temporary servers and browser processes were stopped. The plan-012 Part B
desktop frame-time regression recorded in its own Result remains a separate,
unresolved tradeoff; this plan makes no claim that it improved.

`build_tiles.py` advises rerunning `ipr_terrain.py` whenever ground is rebuilt.
This change does not alter its bridge or tunnel inputs, so the isolated ground
tiles were assembled with the existing terrain and structure layers. The new
courtyard surface remains a provisional material because the DTM does not say
what most yards are made of. The plan-010 staged landmarks and server deployment
remain unchanged.

Phase 4 remains a separate future plan, [014](014-classify-courtyard-surfaces.md).

### Full local rebuild and activation, 1 October 2026

After the plan-013 code reached main at `2e5bd64`, all four tile layers were
rebuilt for `praha`, `centrum` and `ujezd` from copied cached OSM, DTM, parking
and IPR inputs. Each area then ran `ipr_buildings.py` and `ipr_terrain.py` to
regenerate its building and height/structure binaries. This was done in an
isolated copy at `/private/tmp/sop-map-rebuild-20261001-2e5bd64`; it did not
rebuild the separate transit feeds, landmarks or optional photo classifier.
`praha` took 885 seconds for the tile-layer step, with 7,896 changed tile JSON
files. The dependent city building and terrain passes completed, as did all
three steps for `centrum` and `ujezd`.

The stage validator found every indexed tile JSON and required height, IPR and
level binary: 14,595 city tiles (5,703 with IPR buildings, 2,087 with levels),
234 centre tiles (228 with IPR, 89 with levels), and 25 Újezd tiles (23 with IPR,
13 with levels). The centre's plain-ground count remained 72.20 ha out of
1,289.73 ha. All three gameplay scenarios passed against the staged city map;
matched screenshots at Old Town Square, Charles Bridge, Malá Strana and Újezd
were inspected. Terrain structure sampling emitted `All-NaN slice`/`Mean of
empty slice` warnings in all three areas; each terrain step completed and the
assembled files passed the integrity check. These warnings were not investigated
as part of the surface rebuild.

Before activation, a SHA-256 inventory of all 37,934 shared data files showed no
concurrent changes. The stage differed in exactly 8,550 map-data files and had
32 obsolete `.levels.bin.gz` files. A copy-on-write rollback snapshot of shared
`public/data`, the layer cache and DTM parsed cache was retained in
`/private/tmp/sop-map-rebuild-20261001-2e5bd64/shared-before`. After a dry run,
the changed tile outputs and matching layer/DTM caches were synced to shared
local data without a blanket delete. The 32 binaries were confirmed absent from
the new structure indexes and moved to Trash individually. The shared-area
integrity check then passed, followed by all three gameplay scenarios and a
rendered Old Town Square check from the primary checkout. Build and validation
logs, screenshots, and the source/stage manifest comparison are in the staging
directory. The validated local release was later deployed to mbxp at `428ae64`;
there is no Git remote to push.

The separate efficiency review later committed `8265c15`, changing pipeline
cache and resume handling. The release data was built with the preceding pipeline
at `2e5bd64` and remains valid for the client. The new cache validation records
were established after deployment as described below.

### New pipeline cache readiness, 1 October 2026

After the mbxp release, the new pipeline at `8265c15` was run once in the primary
checkout with `build_tiles.py --resume --no-assemble`, followed by the IPR building
and terrain steps and `layers.py --strict` for all three areas. A copy-on-write
rollback snapshot of the active local `public/data` and pipeline cache is at
`/private/tmp/sop-next-build-ready-20261001`. Strict assembly passed for `ujezd`,
`centrum` and `praha`, establishing 259 chunk completion records and six IPR/terrain
completion records.

The repeat `--resume --no-assemble` runs built **zero** chunks and reused all four
Újezd layer outputs, all 24 centre outputs and all 1,008 city outputs (the tile
steps took 0.46, 0.43 and 0.98 seconds respectively). The second city IPR building
pass hit all 128 parsed-sheet caches; the terrain pass hit all 132. A second strict
city assembly changed zero tile JSON files. The local centre and Újezd data stayed
byte-for-byte equal to the deployed copy. Two city tile JSON files changed only in
drive-edge list order: their order-independent edge contents are equal. No frame-time
measurement was made, and this cache preparation was not redeployed to mbxp.

The validation records use source path, size, mtime and ctime, plus processing code
and library versions. They are ready in this primary checkout; copying these caches
to another path does not preserve their validity. A future source or pipeline-code
change will correctly invalidate affected work. The first-pass and repeat logs are
in the rollback snapshot directory.

### Photo classification of the unmapped ground, 3–4 October 2026

The live city map already held phases 0–3 (plain ground in `praha`: 4,329.6 ha). The
prototype's `rules` method (62 % exact on the hand labels, against 27 % for the model)
was run for the city as the `cover` layer, folded into the build and into the tiles
without a flag or a map format change: plain ground in `praha` fell to 2,459.9 ha, tile
JSONs grew 12.0 % gzipped, and the frame time could not be told from noise. Numbers,
before and after pictures and what is left are in
[docs/beige-cover-city.md](../docs/beige-cover-city.md). Not deployed.
