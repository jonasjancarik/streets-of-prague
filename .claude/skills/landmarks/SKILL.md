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
| white | nothing: filled in from around it, often a flat, darker colour |

White on a wall you can see is the thing to look into. White on faces inside other
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
- **A tree baked into a roof or wall.** The mesh has trees; one that reaches over the
  building is baked in (Mánes's north-east corner, see `todo.md`). Nothing handles it
  yet.
- **No clean model: a jagged dark shard.** Where IPR's city model has no building (the
  Powder Tower on its own: its OSM footprint has none, `no IPR buildings there`), the
  landmark is the mesh's raw triangles, with spikes of ground round its foot; in the game
  it is a torn black shape. Don't ship that. IPR may carry the building as part of a
  neighbour (Obecní dům's model includes the Powder Tower): make the neighbour the
  landmark, and the widened footprint hides the OSM building too.
- **White or blocky ground floor.** Where houses, arcades or crowds hide the lowest
  metres of a wall from every photograph (the Týn Church's west and south fronts), the
  rays find nothing and the texels are filled in from around them. Not fixed; see
  `todo.md`, "Landmarks".
- **Landmark roofs look like another material.** The photographs' roofs are paler and
  yellower than the city's tiled roofs. Two things in the game handle it, both after
  the bake, so a landmark's GLB never needs remaking for colour: `warmUp` in
  `src/tiles.ts` shifts warm colours of the texture redder when it loads (gently: too
  much and the plaster goes orange too), and `shadeLandmark` (`src/shading.ts`, and its
  TSL port in `src/webgpu/buildings.ts`, key `landmark-roof`) draws the city's tile
  pattern wherever a texel is a red roof on an up-facing face, at the photograph's
  brightness. The face's normal comes from derivatives, because the model's normals are
  all "up" for the light. Mask by hue and saturation, and let dark texels through too
  (roofs in shadow are low in saturation); a strict mask leaves speckles on shaded
  slopes. Change both shader versions together, and check with `?renderer=webgl`.
- **Roof colours to match.** The palette for the other roofs is in `src/map/buildings.ts`
  and, separately, `pipeline/ipr_buildings.py` (IPR's buildings, baked into their tile data).
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

## Files

- `pipeline/landmarks.py` — `LANDMARKS`, the mesh download (nodes cached in
  `pipeline/.cache/mesh/`), picking IPR's buildings, the footprint, running Blender.
- `pipeline/landmark_bake.py` — the clean-up and the bakes (runs inside Blender).
- `pipeline/.cache/landmarks/<area>/<name>.{mesh.glb,lod3.obj,sources.glb}` — what the
  sheet reads; the bake's inputs, so `landmark_bake.py` can be run on them directly
  while trying things.
- `.claude/skills/landmarks/find.py`, `views.py` — the helpers above.
