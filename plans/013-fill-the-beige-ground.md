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

- Status: PLANNED. No implementation yet.
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

(Fill in per phase: revision, commands, screenshots, `beige_report.py` numbers,
residual issues.)
