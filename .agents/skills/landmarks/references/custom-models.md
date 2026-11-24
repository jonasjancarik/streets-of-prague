# Custom landmark models

The National Theatre (`divadlo`) uses the same model in top-down, first-person
and third-person views.
Its existing landmark entry still determines which tile loads it. The survey
bake remains available as a fallback and for comparisons.

## Shape and surface detail

Before replacing the model, capture its silhouette at normal top-down driving
zoom. Use first person to inspect openings at eye height and third person to
see their scale beside the player. Pick a street angle that shows what needs
to change, such as daylight through a carriage porch. Record the camera position, heading, zoom
or pitch, time and weather so you can repeat each shot.

Take the plan and roof heights from IPR's city model. Horizontal sections at the
eaves and ridge reveal tapered wings and changes of roof pitch. Check entrances,
porches and towers against their OSM outlines and passages. Use photographs from
several sides to resolve openings and count the bays on each elevation.

Model features that change the skyline, cast a distinct shadow or let the player
see through the building. The theatre's chariots and open arches need depth.
Carved panels and column fluting read well from a shared texture atlas. Rectify
photographs of unobstructed bays, match their stone tones and pad the atlas
regions so neighbouring colours stay apart in mipmaps. Record each source, its
licence and how it was adapted in [the asset credits](../../../../assets/SOURCES.md).

## Build and placement

The theatre's [editable sources](../../../../assets/national-theatre/) include
the geometry, statuary and atlas builder. From the repository root, rebuild the
tracked `public/national-theatre.glb` with

```sh
uv run --project pipeline python assets/national-theatre/build.py
```

The builder samples the rear copper roofs from
`pipeline/.cache/landmarks/praha/divadlo.mesh.glb`. If that input is missing,
the survey bake's `uv run landmarks.py praha divadlo` command in `pipeline/`
produces it. This also writes the area's survey GLB and manifest, so follow the
[worktree instructions](../SKILL.md#adding-a-survey-landmark) when the map data is shared.
Commit the editable sources and exported app asset together. Area-specific
survey GLBs under `public/data/` are generated map data.

For placement, choose a geographic origin, a second point along the model's
positive X axis and a surveyed base elevation. The [custom landmark loader](../../../../src/customLandmark.ts)
projects both points into the active map's grid, uses their direction for
rotation, maps north to negative world Z, and subtracts the area's `iprRef`
from the base elevation. The default full-city dataset (`praha`) and the optional
historic-centre dataset (`centrum`) have different grid origins. Projecting the
anchors keeps the model beside the same pavement in either dataset.

Keep the authored normals when applying the game's cutaway material and shadows.
The ordinary photo loader points every normal upward because its textures already
contain sunlight. In [the tile loader](../../../../src/tiles.ts), use the
landmark name to select the model and keep the positioned mesh in the rooftop
lookup. When replacing a survey bake, keep its load fallback. Include subsidiary
OSM buildings in `LANDMARKS` in `pipeline/landmarks.py`. Check existing maps as
well as new builds. The theatre's carriage porch had a separate OSM way outside
the old landmark footprint, so a second building filled the new arches. The
loader includes that way's rings in the footprint used to hide overlapping buildings.

## In-game checks

Repeat the baseline shots and compare them side by side. Inspect the silhouette
from a distance, the entrance at eye height and the materials after dark. A
successful fallback can hide an asset-loading error. For example, this
[scene runner](../../scene-testing/SKILL.md) check visits the theatre in the
default full-city game and confirms that the authored mesh loaded.

```sh
node scripts/scene.mjs eval --fresh \
  "await t.go([50.08148,14.41290]); const m = await window.__drive.world.landmarkModels.get('divadlo'); return !!m?.getObjectByName('Národní_divadlo')"
```

Expect `true`. When changing placement, also run the check with
`--extra '&area=centrum'` to exercise the historic-centre grid. For material
changes, compare the default WebGPU renderer with `?renderer=webgl`. Look
through each open porch for leftover walls and check `world.rooftopAt(x, y)`
at a surveyed roof point. A visual opening also
needs a mapped passage for the player to walk through it.

Compare triangles, draw calls per pass, GLB bytes and atlas dimensions. The
theatre went from 452 to 26,182 triangles while keeping one draw call per pass
and shrinking the atlas from 4096² to 1024². To measure frame cost, use
`scripts/bench.mjs --ab` with a switch that alternates the old and new models
at the same camera after both have warmed up. Report the renderer, device and
variation across runs. See the [performance skill](../../performance/SKILL.md).
