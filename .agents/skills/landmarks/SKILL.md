---
name: landmarks
description: How to add a landmark to Streets of Prague from IPR's photorealistic 3D mesh (Mánes, a church, a tower…), baked in Blender onto IPR's clean city model, and how to check and fix one. Use when adding or improving a landmark, when a landmark looks wrong in the game (dark patches, holes, see-through walls, trees baked in), or when working on pipeline/landmarks.py or pipeline/landmark_bake.py.
---

# Landmarks from IPR's photorealistic mesh

A landmark is a building the game draws from photographs instead of its procedural
look. `pipeline/landmarks.py` cuts IPR's photorealistic mesh (aerial photographs,
summer 2023, ~5 cm/px, CC BY, a public I3S layer) around the building's OSM footprint,
and Blender (`pipeline/landmark_bake.py`, run in the background) bakes those colours
onto the building's clean model from IPR's city model (LOD3). The game hides IPR's and
OSM's buildings in the landmark's footprint and draws the model instead
(`landmarkModel` in `src/tiles.ts`). The README ("Landmarks") says how it works; this
is how to do it and what goes wrong.

Mánes with Šítkovská vodárenská věž was the first (29 September 2026). Everything
below was learned on it and on the Týn Church (one OSM way, `way/379512802`, and one
IPR building, towers included; 334 faces, 1.2 MB).

## Adding one

1. **Find its OSM buildings.** From `pipeline/`:

   ```
   uv run ../.claude/skills/landmarks/find.py praha Týn
   uv run ../.claude/skills/landmarks/find.py praha --near 14.4225,50.0876 --radius 50
   ```

   It lists each building's id (`way/…`), name, height, its game position (x, y for
   `window.__drive.teleport`) and `start=lon,lat`. Take every building that belongs
   to the landmark: a church and its tower are often separate ways. Building parts
   (`part True`) don't count; the building they belong to does.

2. **Add it to `LANDMARKS`** in `pipeline/landmarks.py`: a short name, the OSM ids,
   and a comment with the real names.

3. **Make it for each area the game uses** (the whole city is the default, the
   centre is `?area=centrum`):

   ```
   uv run landmarks.py praha týn
   uv run landmarks.py centrum týn
   ```

   It needs the area's tiles (`build_tiles.py`) and IPR's parsed sheets
   (`ipr_buildings.py`), and Blender (`/Applications/Blender.app` or `$BLENDER`).
   About 15 s a landmark on a quiet machine. It prints how many of IPR's buildings
   it took; 0 means it falls back to the mesh's own triangles (see below).
   `public/data` is shared with other sessions (see the memory on shared map data):
   this only writes `landmarks/` and `landmarks.json` there.

4. **Check it** (next section), fix what's wrong, commit `LANDMARKS`. The GLBs are
   generated data and stay out of git.

**After a change to the bake** (`landmark_bake.py`, `landmark_fill.py`, `PAINT_OVER`),
`uv run landmarks.py <area> [name…] --rebake` bakes again from the inputs kept in
`pipeline/.cache/landmarks/<area>/`: no mesh nodes, no IPR sheets, and the footprints in
`landmarks.json` stay as they are. It needs only `pipeline/.cache/layers/<area>/meta.json`
besides. In a worktree, clone `public/data/<area>_now` and `pipeline/.cache/landmarks`
(`cp -cpR`) and copy that `meta.json`; never bake into the shared data.

**Time.** A bake is single-threaded and takes 1–3 minutes on a quiet machine with a
4096² texture (five Cycles bakes and the fills); with many sessions at work it took 15
minutes and more. Run it in the background with a long limit. Keep NumPy work on the
4096² images lean: a saved set of them is ~800 MB.

## Showing a change

For anything visual, show before and after from the same camera, side by side, day
(and night where it matters): teleport to the landmark with `window.__drive.teleport`,
`window.__drive.view(1.4)`, press `H`, wait about 12 s for the tiles, then screenshot.
Playwright with real Chrome (`channel: 'chrome'`, args `--use-angle=metal
--enable-gpu --ignore-gpu-blocklist --enable-unsafe-webgpu`) is what works; see the
memory on the headless bench. Other sessions load the machine, so a bench number taken
while it is busy says little; check `uptime` before trusting one.

## Checking one

**The sheet first.** One Blender command renders a 3 × 4 sheet: the mesh as cut, the
baked model and the model coloured by where each texel came from (columns), from
above, north-east, south-west and the side (rows):

```
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
    -P .claude/skills/landmarks/views.py -- praha týn "$SCRATCH/týn.png"
```

Read it with the Read tool. The baked columns are drawn one-sided, as the game draws
them, so a missing or inward-facing face shows as a hole. The colours of the third
column:

| colour | where the texel's colour came from |
|---|---|
| red | a roof, from straight above (what the camera sees) |
| green | a wall, straight in from 1.5 m in front of it |
| blue | a wall, straight in from 3 m out, further (the models are further apart there) |
| orange | a wall whose ray met the underside of something, so from above |
| yellow | elsewhere on the same face: a wall's gap repeating the wall above it, a roof spot painted over |
| white | nothing: filled in from around it, often a flat, darker colour |

Yellow on a wall is made up: look at what it repeats. White on a wall you can see is
the thing to look into. White on faces inside other
faces (two of IPR's buildings touching) doesn't matter.

**Then the game.** The dev server is usually already running on 5191 (check with
`lsof -nP -iTCP:5191 -sTCP:LISTEN` before starting one). `?go` skips the start screen:

```
http://localhost:5191/?go&start=<lon,lat from find.py>&time=14:00&weather=clear
```

The camera starts where `start` snaps to the nearest street, which may be 50–100 m
off. `window.__drive.teleport(x, y)` with find.py's x, y puts you next to it, and
`H` hides the controls panel. Check `&time=23:00` too: the model has the photographs'
daylight in it and must still darken at night. The Browser pane has to be shown for
the game to render (see the memory on benchmarking).

## What goes wrong, and why

- **Dark patches on walls: rays starting behind the mesh.** IPR's mesh sits up to
  ~1 m in front of the LOD3 walls. A ray starting closer than that begins behind the
  photographed surface and meets something inside. That's why the first ray starts
  1.5 m out, not less.
- **Dark wedge under a dome or spire.** LOD3 simplifies domes (an octagonal pyramid
  on a straight drum), while the mesh bulges out over the drum; a ray straight in from
  the drum meets the dome's shaded underside. The bake catches rays that meet a
  surface facing down (the mesh's normal is baked alongside) and takes those texels
  from above instead.
- **Half a wall missing, or a see-through triangle.** Picking LOD3 triangles by
  OSM's outline loses some: IPR's walls can be 1–2 m off OSM's, and a wall triangle's
  middle is right on the outline. `lod3()` takes whole IPR buildings instead (those at
  least half inside the OSM footprint) and widens the landmark's footprint to cover
  them, so the game hides all of their triangles too.
- **Faces pointing inwards.** Don't let Blender recalculate normals on LOD3: a set of
  touching solids fools it and it flips walls. CityGML's own orientation is right;
  only faces the bake adds (small holes it fills) get recalculated.
- **Axes.** Blender's importers turn y-up into z-up with an object rotation; the bake
  applies it before looking at normals. A GLB with a node rotation still works in the
  game (`landmarkModel` works out "up" in each mesh's axes), but anything that tests
  normals in Blender must do so after `transform_apply`.
- **A tree baked into a roof.** The mesh has trees; one that reaches over the
  building is baked in (Mánes's north-east corner). Nothing in the bake's data tells it
  from the roof: seen from above, the mesh there is the roof's height (the crown is
  flattened onto it, within 0.1 m), and the colour is the roof's, only much darker, not
  green. So a general rule by colour or height does not exist, and green copper roofs
  are not at risk from one. Instead, mark the place: `PAINT_OVER` in `landmarks.py`
  takes `(lon, lat, radius)`; within it, roof texels darker than 0.6 of their face's
  usual brightness are given the colour of their own face round them (`dark_spots` in
  `landmark_fill.py`, then a push-pull over that face only). Smooth on purpose: copying
  the roof along its slope made stripes of the seams. Keep the radius tight, a real
  shadow inside it goes too. The tree is still baked into the *walls* next to it
  (Mánes's east wall, north end); see the memory on the facade experiment for that.
- **No clean model: a jagged dark shard.** Where IPR's city model has no building (the
  Powder Tower on its own: its OSM footprint has none, `no IPR buildings there`), the
  landmark is the mesh's raw triangles, with spikes of ground round its foot; in the game
  it is a torn black shape. Don't ship that. IPR may carry the building as part of a
  neighbour (Obecní dům's model includes the Powder Tower): make the neighbour the
  landmark, and the widened footprint hides the OSM building too.
  A raw mesh can still be good, though: House Okamura (Nad Tejnkou 9a, newer than IPR's
  city model) has clean concrete cylinders in the mesh, so it ships as raw triangles.
  `ground_off` in `landmarks.py` drops the flat triangles within 1 m of the lowest point,
  which removes the ground spikes. Look at the sheet before deciding; don't assume.
- **Blocky, wrongly coloured ground floor.** Where houses, arcades or crowds hide the
  lowest metres of a wall from every photograph (the Týn Church's west and south
  fronts), the rays find nothing. The old fill took colours from whatever was near in
  the texture, other islands included: orange roof and white plaster in blocks on a
  dark stone wall. Now a wall's gaps repeat the same wall from above them
  (`copy_along` in `landmark_fill.py`): the 3 m above the gap, there and back so it joins
  up, with the gap's edge evened out over 1 m so columns stay in step. It is as good as
  the wall just above the gap: where that band has a neighbour's roof or a dark hollow
  in it (the Týn Church's south side, one bay), those repeat too. In the game the Týn
  Church's foot is behind its neighbours' houses from every side, so the game's own
  facade was not needed there.
- **"Black roof parts" on Mánes** (a note from 29 September) were the shader's flat
  roofs, next item; the baked texture has no black or unlit texels on the roofs. Checked
  from above on 6 October: nothing black.
- **Landmark roofs look like another material.** The photographs' roofs are paler and
  yellower than the city's tiled roofs. `pipeline/landmark_colours.py` shifts warm
  colours in each final `.warm-v1.glb` (JPEG quality 88), retaining the unconverted
  file and leaving Blender's source and diagnostic models alone. Its active scene
  carries `landmarkColourVersion: 1`. Older unmarked GLBs still get the same `warmUp`
  pass in `src/tiles.ts`. Which one the game loads is the `file` of each entry in
  `public/data/<area>_now/landmarks.json`: `landmarks.py` (with or without `--rebake`)
  writes the warmed name there, so a run switches them on. The client that reads the
  marker is live since v0.5.2; an older one would adjust a warmed file twice.
  `scripts/check-landmark-colours.mjs --fixtures public/data/<area>_now --area <area>
  --name <landmark>` checks an area whose manifest is switched on. `shadeLandmark` (`src/shading.ts`, and its
  TSL port in `src/webgpu/buildings.ts`, key `landmark-roof`) draws the city's tile
  pattern wherever a texel is a red roof on an up-facing face, at the photograph's
  brightness. The face's normal comes from derivatives, because the model's normals are
  all "up" for the light. Mask by hue and saturation, and let dark texels through too
  (roofs in shadow are low in saturation); a strict mask leaves speckles on shaded
  slopes. Change both shader versions together, and check with `?renderer=webgl`.
- **Black flat roofs.** `roofTiles` turns the face's downhill direction into a
  `normalize`; on a perfectly flat face that is 0/0, NaN, and the roof draws black
  (the National Theatre's rear block and courtyard, 30 September 2026). The direction
  is nudged so it is always defined, and near-flat faces (`LANDMARK_ROOF.flat`) are left
  out of the red-roof mask, so grey gravel and dark flat roofs keep the photograph's
  colour instead of turning into clay tiles. Both shader versions. If a landmark shows
  black in the game but not on the sheet, look at the shader before re-baking: the
  sheet reads the GLB's texture, which is fine.
- **Roof colours to match.** The palette for the other roofs is `ROOF_TILES` in
  `src/map/roofPalette.ts` (landmark roofs use its mean, and the mask and brightness
  limits are `LANDMARK_ROOF` in `src/shading.ts`, used by both shaders) and, separately,
  `pipeline/ipr_buildings.py` (IPR's buildings, baked into their tile data).
  Only a change to the palette itself needs `ipr_buildings.py` run again for `praha` and
  `centrum`; adding or editing a landmark never touches the city's roofs. Judge colour against photographs of real roofs, as
  measured pixels of the rendered result, not the palette's hex values: the render
  shifts hue and brightness.
- **Baked light.** Walls facing away from the sun at the time of the flight are
  darker, and stay so. It's the photograph; leave it.

## When there's no clean model

If IPR has no building there (newer ones), or with `--raw`, the landmark is the mesh's
own triangles: ~20,000 triangles and 2 MB for Mánes, ragged edges, trees included,
drawn two-sided. Fine as a stopgap, not as a result.

Unless the clean model is the worse of the two. IPR's Dancing House is a prism standing
on the ground: no waist or legs on the glass tower, no column and open ground floor
under the corner tower, all of which the mesh has. Compare them in plan before choosing
(cut both at a few heights and draw the outlines over OSM's and the tile's `passages`).
Three sets in `landmarks.py` cover such a landmark (8 October 2026):

- `RAW`: always the mesh's triangles. IPR's buildings there still widen the footprint,
  or their walls stay standing in front of the landmark (a beige curved wall before the
  corner tower).
- `SHADED`: street fronts photographed in shade come out blue, white plaster most of
  all. `unshaded` takes the cast out of what is bluer than red and lightens it; the
  dark part (glass, windows) keeps most of its blue.
- `PLAIN` (`plain` in `landmarks.json`): no tiled roofs, so the game draws it with the
  cutaway only. Otherwise near-black texels on a sloping face count as a roof in shadow
  and are drawn as clay tiles: red-brown patches on the glass tower's skirt.
  Slate and copper church roofs need it too (St Vitus, St Ludmila, Vyšehrad): their
  shaded slopes otherwise come out as red-brown tile patches. Check every new church.

Walking under it needs nothing from the landmark: OSM's `passages` open the collision
grid, and the cutaway opens the model above the player.

## Files

- `pipeline/landmarks.py` — `LANDMARKS`, the mesh download (nodes cached in
  `pipeline/.cache/mesh/`), picking IPR's buildings, the footprint, running Blender.
- `pipeline/landmark_bake.py` — the clean-up and the bakes (runs inside Blender).
- `pipeline/landmark_fill.py` — the fills (NumPy only), tested without Blender:
  `uv run --project pipeline python -m unittest discover -s pipeline -p test_landmark_fill.py`.
  `LANDMARK_DEBUG=<file.npz>` on a bake keeps the images they work on.
- `pipeline/.cache/landmarks/<area>/<name>.{mesh.glb,lod3.obj,sources.glb}` — what the
  sheet reads; the bake's inputs, so `landmark_bake.py` can be run on them directly
  while trying things.
- `.agents/skills/landmarks/find.py`, `views.py` — the helpers above. For one large view
  instead of the sheet (an elevation, a corner from above), copy `views.py`'s `render`
  with an orthographic camera; the sheet's 480 px cells hide a tree on a roof.
