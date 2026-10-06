# Plan 005: Roofs and walls in their real colours, mansards and roof details, from IPR's photo mesh

> An implementation plan for another agent. Planned at `1e75ba0` on `main`, 2026-09-29.
> The working tree then had other sessions' uncommitted work across the pipeline and
> the game (`pipeline/build_tiles.py`, `layers.py`, `osm_area.py`, `structures.py`,
> `src/main.ts`, `src/contracts.ts`, …). Check `git status` and `git diff` before you
> start, don't revert or overwrite changes you didn't make, and commit only your own
> hunks (`git add -p`). `public/data/` and `pipeline/.cache/` are shared with other
> sessions (see the memory on shared map data): rebuild them only from the main
> checkout with nothing else rebuilding, or clone them first in a worktree.

## Status

- Priority: P1 (the biggest step towards Prague looking like Prague from above)
- Effort: phase 1 about 2 days, phase 2 about half a day, phase 3 about 3 days
- Risk: medium. Phase 1 is a new pipeline step and a colour table, no game changes;
  phases 2 and 3 change the building shaders (GLSL and the WebGPU/TSL port) and add
  instanced geometry.
- Depends on: none. Builds on the landmark work (`pipeline/landmarks.py`, the skill
  `.claude/skills/landmarks/`), which already downloads and reads the same mesh.
- Category: map data and look

## Goal and scope

From above, Prague's roofs aren't all red and its houses aren't one palette. In Plaská
(compare the game with the photo mesh there) one street has orange and brown-red
tiles, light grey and blue-grey sheet metal, white metal roofs, grey mansards with
rows of windows, and dozens of dormers, roof windows, chimneys and skylights. The game
has uniform red tiles on smooth roof planes and a wall colour picked at random from a
palette.

This plan takes what IPR's photorealistic 3D mesh (aerial photographs, summer 2023,
CC BY) shows and turns it into **data**, never into imagery in the game:

1. **Phase 1 — real colours.** Every IPR building gets its real wall (plaster) colour,
   and every roof face its real colour and material (tiles, slate, sheet metal,
   copper, flat), measured from the mesh with the light roughly taken out. They
   replace the random palette and the "pitched is red, flat is grey" rule. The game
   is unchanged: the colours go where the colours are now.
2. **Phase 2 — mansards.** Very steep roof faces (the lower slope of a mansard) are
   drawn as a roof-covered wall with a row of windows, not as tiles.
3. **Phase 3 — roof details.** Roof windows, small dormers and chimneys the city model
   doesn't have are found in the mesh and drawn procedurally: roof windows in the roof
   pattern, dormers and chimneys as small instanced models lined up with the facade's
   window bays.

Out of scope: using the mesh's geometry or textures for ordinary buildings (it's
lumpy and would need cleaning everywhere; landmarks are the exception and have their
own pipeline), OSM-only buildings (no IPR model to colour, keep today's rules), trees
(a separate item in `todo.md`), balconies, facades' window layouts.

## Decisions made (don't change them without asking)

- **Data, not pictures.** Only colours, material classes and detected positions leave
  the pipeline. The procedural look (tile rows, facade parts, grime, snow, rain, lit
  windows at night) keeps working on top. This keeps within the rule that there's no
  per-place imagery beyond hand-picked landmarks.
- **Mesh level 13** (~20–25 cm per pixel on facades) for phases 1 and 2. Phase 3 may
  use level 14 (~11 cm/px) where it's needed, only over roofs.
- **Start with one area and compare, then the city.** The Plaská block and
  Staroměstské náměstí first, before anything citywide.
- **Hand corrections win for roofs.** `pipeline/roofs.py` regions and OSM's
  `roof:material` / `roof:colour` where someone set them on purpose stay above the
  mesh. The mesh beats the random palette and the defaults.
- **The mesh wins over OSM's `building:colour`** (decided by the user, 2026-09-30):
  it's often guessed, and the photographs show the real plaster. OSM's wall colour is
  used only where the mesh measurement isn't confident.
- **When unsure, keep today's colour.** A building or face whose measurement isn't
  clear (see "Confidence") keeps what it has now. Fewer buildings right is better than
  all of them wrong.
- **Landmarks are untouched**: their footprints are hidden in the game anyway.

## Current state (what the plan relies on)

- **IPR's city model**, `pipeline/ipr_buildings.py`, CityGML sheets `BD3_*.gml`
  declared as LOD3: walls, roofs, ground, building parts and installations, no windows
  or doors. `read_sheet()` returns, per building, its gml id, the tile, the triangles
  (int16 cm from the tile corner, `(x, height, y)`), a code per triangle (0 wall,
  1 pitched roof, 2 flat roof) and its ground outlines; it's cached per area in
  `pipeline/.cache/ipr/parsed/`.
- **Colours today**, `colours()` in `ipr_buildings.py`: the wall from `WALLS` by a
  hash of the building id; roofs from `ROOF_TILES` / `ROOF_SLATE` / `COPPER` by cover
  (`COVERS = ("tiles", "slate", "copper")`), the cover from OSM, `roofs.py` regions,
  or "slate/copper for churches, tiles for the rest"; flat roofs greyed by
  `flat_roof()`. One RGB byte triple per triangle goes into `<tile>.ipr.bin(.gz)`
  (header: triangle count; int16 positions; padding; uint8 colours).
- **In the game**, `ipr()` in `src/tileWorker.ts` unpacks the bin; the building shader
  (`BUILDING_GLSL` and `shadeBuildings` in `src/shading.ts`; the TSL port in
  `src/webgpu/buildings.ts`, WebGPU is the default renderer) draws flat roofs where
  the normal is up (`bn.y > .97`), tiles on pitched faces (`bn.y > .15`), and the
  facade parts on walls. Grey roof colours get the smaller slate rows
  (`slate = step(saturation, .08)` in `roofTiles`). There's no material channel.
- **The mesh**: public I3S layer `praha2023_merged_WM` (see the memory on IPR's photo
  mesh for the URL and layout). Nodes have JPEG atlases (1024×512) and plain triangle
  lists (float32 positions relative to the node's centre, EPSG:3857 x/y, height a.s.l.
  Bpv; uv0). `pipeline/landmarks.py` already has `fetch()`, `nodes_over()` and
  `triangles()` for it, with the node cache in `pipeline/.cache/mesh/`.
- **What the mesh costs** (measured 2026-09-29 on 1 km² samples, centre and Chodov,
  both alike since the mesh covers the ground evenly):

  | level | node size | on facades | MB/km² | whole city (496 km²) | `centrum` (13 km²) |
  |---|---|---|---|---|---|
  | 12 | ~250 m | ~45 cm/px | 2–2.5 | ~1.1 GB | ~30 MB |
  | 13 | ~120 m | ~20–25 cm/px | 7.5–9 | ~4 GB (≈32,000 nodes) | ~110 MB |
  | 14 | ~60 m | ~11 cm/px | 28–38 | ~16 GB | ~450 MB |

  Fetching only nodes over IPR buildings leaves out woods, fields and water, so level
  13 for the city is likely 2.5–3 GB.
- **Roof installations in IPR**: `BuildingInstallation` elements are big dormers and
  roof superstructures (typically 4.4 × 2.9 m, 2.1 m tall) and are already in the game
  (`read_sheet` takes all nested surfaces). Around Plaská (120 m) there are 36 of them
  on 62 buildings; the photo shows many times more. Small dormers, roof windows and
  chimneys are missing.
- **Lessons from the landmarks** (see the skill): the mesh sits up to ~1 m in front of
  LOD3 walls, so wall samples must come from 1.5 m or more out; roofs are best seen
  straight from above; pick IPR buildings whole by id, not triangles by OSM's outline;
  CityGML's face orientation is right.

## Design

### Phase 1: colours and materials from the mesh

A new step, `pipeline/mesh_colours.py <area>`, run after `ipr_buildings.py` has parsed
the sheets. It writes a colour table, and `ipr_buildings.py` uses it when it writes the
tiles.

**1. Which mesh to fetch.** For each tile of the area with IPR buildings, the level-13
nodes whose bounding sphere reaches the tile's buildings (`nodes_over()` from
`landmarks.py`, moved into a small shared module, e.g. `pipeline/photomesh.py`, and
`landmarks.py` changed to import it). Fetch with a bounded pool (8–16 at a time), with
retries, and resumable (the cache is per file already). Print progress per tile.

**2. Two views of the mesh per tile**, built from its nodes' triangles and textures in
numpy, no Blender:

- **From above**: an orthographic colour and height raster of the tile at 20 cm
  (a small z-buffer rasteriser over the mesh triangles: highest z wins, colour
  sampled from the node's texture at the interpolated uv). This is what roofs are
  measured on, and phase 3's detection too.
- **Wall samples**: for each IPR wall face, points on a grid over it (every ~0.5 m),
  each moved 1.5 m out along the wall's normal; for each point, the mesh triangle hit
  by a ray back towards the wall within 3 m (build a coarse grid index of the mesh
  triangles by x/y to test only nearby ones; a KD-tree from scipy, already in the
  `cover` dependency group, is fine too). Keep the hit's colour and the mesh normal.

**3. Taking out the light.** The photographs were taken in summer 2023 with the sun
roughly in the south. Walls in sun and in shade differ mostly in brightness, much less
in hue.

- Estimate the sun's azimuth and elevation once for the whole city from the data:
  bucket all wall samples by wall orientation and find the direction that best splits
  bright from dark (or read it off the shadows in the top raster).
- A wall is "lit" if it faces the sun (dot of its normal with the sun's direction
  above a margin), "shaded" if it faces away. Classify by orientation, never by how
  dark it is, or dark buildings would be brightened as "shaded".
- One citywide brightness factor for shaded walls, from buildings whose lit and shaded
  walls are clearly the same plaster. Apply it to shaded samples.
- One citywide white balance and haze correction (the photographs are a little blue
  and washed out): fit a single gain and offset per channel so the median roof tile
  matches a reference clay colour and the median plaster is neutral-to-warm. Apply to
  every measurement. Differences between buildings stay; only the camera's cast goes.

**4. The colour of a surface: its dominant colour, not a filtered one.** No fixed
thresholds on darkness or blueness: that would ruin dark buildings (blackened
sandstone at Týn or Prašná brána, dark brick, anthracite cladding) and glass
facades.

- Per building's walls (all walls together, weighted by area, lit samples preferred):
  convert to CIELAB, cluster (a 3D histogram over L\*a\*b\* with 4–6 unit bins, or
  k-means with k≈4), take the biggest cluster's median. For a plastered house that's
  the plaster (windows are 20–40 % of a facade); for a dark building it's dark; for a
  glass building it's the glass.
- Leave out the ground floor (below 3 m: shop fronts, cars, people) and samples under
  tree crowns (IPR's greenery records, `OPK_CUR_OPK_SMZ_VP_B`, points with a crown
  radius; see the memory on IPR's extra data) rather than "green pixels", since some
  facades are painted green.
- Per roof face: the same, on the top raster within the face's outline shrunk by
  0.3 m. Chimneys, roof windows and antennae are small minorities and drop out.

**5. Material classes for roofs**, from the roof colour and the face:

| class | how it's recognised |
|---|---|
| `flat` | code 2 (as now) |
| `copper` | green-cyan hue (a\* negative, b\* near 0), medium lightness |
| `tiles` | warm hue (a\* and b\* positive), any lightness (orange to brown-red) |
| `slate` | low chroma, dark (L\* below ~45) |
| `metal` | low chroma, light (L\* above ~55), sheet metal and painted roofs |

Between the classes, keep the colour and let the class be the nearer one. Show the
thresholds in one place with names so they can be tuned.

**6. Confidence.** Keep today's colour for a building's walls or a roof face when:
fewer than ~40 samples; the biggest cluster holds less than ~40 % of the samples;
lit walls disagree strongly with each other (different buildings under one IPR id,
say); the face is mostly under trees. Log the share of buildings and faces that took
a mesh colour per tile.

**7. The table and how it's used.** `pipeline/.cache/mesh_colours/<area>.json.gz` (or
per sheet): per IPR building id, the wall colour and, per roof triangle index (in
`read_sheet`'s order), a colour and class, plus the confidence. `ipr_buildings.py`
then, in the loop that builds `palette` and `which`:

- wall colour: the mesh's if confident, else OSM's `building:colour` if set, else
  `WALLS` as now;
- roof triangles: a `roofs.py` region or OSM's roof cover if set, else the mesh's
  colour and class, else today's default;
- flat roofs: the mesh's colour as measured, no `flat_roof()` greying.

The bin format doesn't change in phase 1. The shader's slate test by saturation
already gives grey roofs slate rows; `metal` roofs will look like slate until phase
1b.

**1b. A material channel** (small, do it after phase 1 looks right): a fourth byte per
triangle in the bin (bump a format flag in the tile JSON or `index.json`, keep reading
the old format), passed to the shader as an attribute, so `roofTiles` picks tiles,
slate, standing-seam metal (long vertical seams down the slope, a light sheen) or
copper (with verdigris variation) by class instead of by saturation. Change both the
GLSL (`src/shading.ts`) and the TSL port (`src/webgpu/buildings.ts`), and
`contracts.ts` / `tileWorker.ts` for the attribute.

### Phase 2: mansards

- In the shader, a pitched roof face steeper than about 60° (normal's up component
  below ~0.5, and not a wall: above 0.15, as now) is the lower slope of a mansard:
  draw it in its roof colour (slate or metal from phase 1) with a row of windows, one
  per facade bay, using the same bay logic as `facadeModules` (`facade` attribute:
  along-the-wall position, height, length, style) and lit at night like the facades'
  windows. Check that `facadeCoords` in `src/facades.ts` gives steep roof faces useful
  coordinates; if not, compute them the same way for faces with `bn.y` up to ~0.5.
- Make sure short steep bits (gables of hip roofs, dormer cheeks) don't get windows:
  a minimum face length along the eave (~4 m) and height (~2 m).
- GLSL and TSL both; compare the two renderers.

### Phase 3: roof windows, small dormers and chimneys

Detection runs in `mesh_colours.py` on the same per-tile top raster (level 13, or 14
for tiles in the centre if 13 proves too coarse), per pitched roof face:

- **Height residual**: raster height minus the LOD3 roof plane. Blobs 1.5–4.5 m wide
  and 0.8–3 m high, touching the face and ending below the ridge, are **dormers**;
  small tall ones (0.4–1.2 m wide, 1–2.5 m high) are **chimneys**. Skip anything
  overlapping an IPR `BuildingInstallation` (those are drawn already).
- **Roof windows** lie in the roof plane, so they show only in colour: rectangles
  0.6–1.6 m, darker or bluer than the face's own dominant colour (relative, as in
  phase 1), with edges along and across the slope.
- Output per tile: `roofdetails` list in a new layer (see `pipeline/layers.py` for how
  layers are written and assembled), each `{kind, x, y, z, along, down, w, h}` in the
  area's coordinates (`along`/`down`: the face's eave direction and slope).
- Where detection is unsure but the face clearly has several (the residual shows
  bumps along it), place that many evenly along the eave, snapped to the facade's
  window bays below (real dormers usually sit over window axes).

In the game:

- **Roof windows** in the roof shader: from a per-tile texture or a small uniform
  array per building is awkward; simplest is thin quads a centimetre above the roof
  (instanced, one draw per tile), dark glass with a frame, lit at night like windows.
- **Dormers**: two or three procedural types (gabled, shed, and a baroque arched one
  for Malá Strana and Staré Město, chosen by the facade style of the building), built
  once as small meshes and instanced per tile, taking the roof's colour and class for
  their roofs and the wall colour for their cheeks, with a window lit at night.
- **Chimneys**: brick or plastered boxes with a cap, instanced.
- Keep the tile's matrices static like the rest (`tiles.ts` `make()`), and dispose them
  with the tile.

## Steps

1. **Share the mesh code**: `pipeline/photomesh.py` with `fetch`, `nodes_over`,
   `triangles`, the node cache; `landmarks.py` imports it (behaviour unchanged; rerun
   the landmark Mánes and compare the GLB size and the sheet from the landmarks skill).
2. **Top raster and wall sampler** for one tile, with a debug image: the top raster
   next to a game screenshot of the same tile.
3. **Colour measurement** for the Plaská block and Staroměstské náměstí: print a table
   (building id, OSM name if any, wall colour swatch as hex, roof faces' colours and
   classes, confidence) and render a debug image: the game's building outlines filled
   with the measured colours next to the top raster.
4. **Light and white balance**: estimate the sun, the shade factor and the colour
   correction on a larger area (the whole `centrum` area is enough), then fix them as
   constants in the script with the date and area they came from.
5. **Wire into `ipr_buildings.py`** for `ujezd` (the small test area) and then
   `centrum`; screenshots before/after.
6. **Phase 1b** (material byte), then **phase 2** (mansards), each with before/after.
7. **Phase 3** detection with debug overlays first (detected dormers, chimneys and
   roof windows drawn as coloured boxes on the top raster), only then the game side.
8. **Citywide**: run for `praha` (expect ~3 GB of mesh and tens of minutes of
   downloading the first time), check a few districts.
9. **Docs**: README (Roof colours, Buildings, pipeline steps, credits: the photo mesh
   is already credited for landmarks), a line in `todo.md` for what's left, and, if
   the recipe for checking colours is worth keeping, a short skill like the
   landmarks one.

## Verification

Always show screenshots and before/after comparisons (the user asked for this).

- **The Plaská block**: the same view as the user's comparison (game at
  `?go&start=14.4070,50.0782`, zoomed out, and the photo mesh at the same spot in
  IPR's viewer https://app.iprpraha.cz/apl/app/model3d/ with the "Fotorealistický
  model" basemap), before and after each phase.
- **Staroměstské náměstí and Malá Strana**: colourful facades, copper domes, slate
  church roofs.
- **Dark and glass buildings**: Prašná brána or Týn (outside their landmark footprints
  if they become landmarks), a dark modern building and a glass office building: the
  measured colour must match the photo, not be brightened.
- **Night** (`&time=23:00`) and **rain / snow** (`&weather=rain`, `snow`): the
  procedural effects still work on the new colours; lit windows in mansards (phase 2)
  and dormers (phase 3).
- **Both renderers**: default (WebGPU) and `&renderer=webgl`.
- **Performance**: phase 1 changes no shader. For 1b, 2 and 3 use the performance
  skill (`scripts/bench.mjs --vs` against the commit before) and report the cost.
- **Coverage log**: the share of buildings and roof faces that took mesh colours, per
  area, printed by the script and quoted in the commit message.

## Commits

One commit per step above that works on its own (shared mesh code; the measurement
with its debug output; wiring into `ipr_buildings.py`; the material byte; mansards;
detection; the game side of roof details; docs), each with a body saying what changed,
what was measured and any trade-off. Generated data stays out of git.

## Open questions for the user

- Mansard windows: every bay, or only where the mesh shows windows in the steep face
  (detected like roof windows)?
- How far phase 3 should go outside the centre: the detection works anywhere, but the
  baroque dormer type only makes sense in the historic districts.

## Leftovers, 5-6 October 2026 (branch `night-roofs`)

Run for `ujezd` and `centrum` (the citywide colour table reused by building id, its
roof windows moved into each area's coordinates) and looked at in the game at High
against main's code and map: Celetná, Pařížská, Mánesova and Újezd, from above, over
the roofs and from the street.

- **Wall colours.** A building whose walls weren't measured takes the colour of a
  measured neighbour it shares a wall with (`borrow_walls` in `ipr_buildings.py`,
  `--no-borrow` to leave it out). Coverage: `centrum` 42.4 % → 72.1 % of 10,867
  buildings, `ujezd` 51.6 % → 80.7 % of 933. Tried on measured buildings, such a
  neighbour's colour is off by ΔE 7.2 (centrum, 729 buildings) and 6.2 (ujezd), where
  any other building in the area is off by 11.0 and 9.0. A neighbour of the same kind
  within 30 m was no better than any other building (11.0 and 9.8), so it isn't used;
  the script still prints its error. In the game the borrowed walls are mostly pale
  cream where the palette had ochres: truer, and a little less varied along a terrace.
- **Shade factor: not done.** `mesh_colours.py` measures the ground in sun and in shade
  per tile and within 8 m of each building (`ground_light`) as a calibration, but
  nothing uses it and it isn't in the table; the fit against buildings seen both ways
  is still to do, and needs the citywide measurement run again (5.5 h last time).
  Walls seen only in shade still count as unsure.
- **Bays.** Mansard windows take the bay count and origin of the wall below
  (`mansardCoords`; checked in `scripts/check-roof-clutter.mjs`). Chimneys between a
  ridge's ends stand over the piers between the bays of the wall along the ridge
  (`roof_details.piers`); it ran, but few ridges are long enough to have one, and it
  wasn't told apart by eye.
- **False roof windows.** Only the doubles are dropped (`roof_details.keep_windows`).
  The false-find rate on a sample of roofs is still unmeasured and the detector's
  thresholds are as they were.
- **Cost.** Chimneys have a material of their own (11), and the tile worker keeps
  chimneys and roof windows, then the clutter, as runs of triangles at the end of the
  building mesh (`geometry.userData.parts`: `extras`, `clutter`, `end`, in vertices),
  so `bench.mjs --ab` can switch them with `setDrawRange`. None of it adds a draw call.
  Standing on Staroměstské náměstí (`centrum`, High, 6 building meshes in view, 67
  draw calls, 724,000 triangles in the frame): buildings 65,700 triangles, chimneys and
  roof windows 28,000, clutter 54,200. Frame time, alternating, 3 runs of 8 s each, on
  a machine with a load of 40-100 from a map rebuild: clutter on against off −3.1 %,
  −1.6 %, +12.9 %; chimneys and windows on against off +2.6 %, +3.5 %, −1.4 %. No
  cost shows above that noise (a few per cent); a quiet-machine run is owed.
- **Roof clutter** (`src/map/roofClutter.ts`, `ROOF_CLUTTER` in `src/shading.ts`): aerials
  and pots on chimneys, a chimney through the slope on some roofs, small dormers over
  the wall's bays, thicker moss on clay tiles (GLSL and TSL). **On at High and Ultra
  only, pending the owner's look**; `?clutter=on|off` overrides it for a visit. Tiles
  loaded before the setting changes keep what they had. It nearly doubles the building
  triangles in the old centre; aerials (56 triangles each) are the first thing to thin
  if that matters on some device.
- **Building age** (`pipeline/building_age.py`): IPR's "Stáří zástavby"
  (`Hosted/URK_CUR_URK_STARIZASTAVBY_P`, 136,675 outlines, 8 MB in
  `pipeline/.cache/age/`), joined to IPR's buildings by their middle: 8,700 of 10,867
  buildings in `centrum`, 812 of 933 in `ujezd`. The style comes from the era (before
  1842 baroque, to 1924 tenement, 1925-53 functionalist, 1954-89 panel, later
  functionalist; under 8.5 m a family house), else from the old rule, and goes into the
  upper half of each wall triangle's material byte. OSM-only buildings keep the game's
  rule.
- **Old and new together.** This game with older map data works as before (checked:
  last night's `praha` map loads with no tile failing). An older game with the new data
  doesn't break, but it repaints measured and borrowed walls from the random palette
  and chimneys in a wall colour (it compares the whole byte with 15). So deploy the
  game before, or together with, a map rebuilt by this pipeline.
