# Where the pictures and models come from

Sounds have their own list in [`public/audio/SOURCES.md`](../public/audio/SOURCES.md),
and the map data its credits in the README.

## Made from code

- `cars/build.py`, `trams/build.py`, `figures/build.py` build the cars, trams, people
  and bikes (`public/cars.glb`, `public/trams.glb`, `public/figures.glb`) in Blender
  from code. No outside models are used.
- `pipeline/skyline.py` draws the skylines on the loading screen
  (`public/skylines/`) from IPR Praha's 3D buildings and terrain (CC BY).
- The pictures and videos on the homepage (`site/media/`) are filmed in the game
  (`trailer/`, `site/media.sh`).

## From outside

- **People close up in first person** (`public/rocketbox/`): 14 avatars from the
  [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) library (MIT,
  © 2020 Microsoft) in CodePawl's [GLB repack](https://huggingface.co/datasets/codepawl/rocketbox-avatars-glb)
  (half the triangles, KTX2 textures), and the library's own walk, slow run and run clips,
  and a few of its standing ones (waiting, looking round, on the phone, under an umbrella). `rocketbox/build.sh` downloads them and converts the clips with `rocketbox/clips.mjs`
  onto the avatars' bone axes (a straight Blender conversion bent the knees backwards); the
  licence goes with them (`rocketbox/LICENSE.md`). The seated occupants in
  `public/car-drivers.glb` are the male-adult-13, female-adult-05 and uniformed
  male-adult-10 avatars baked in the game’s seated entry pose. Their vertex colours
  sample the corresponding diffuse textures (`cars/pose_driver.mjs`, `cars/driver_mesh.py`).

## Made with image generation

These were generated with OpenAI's image models (through ChatGPT and Codex), then cut
up and packed by the scripts beside them. The prompts are kept with the sources.

- **Facade parts** (`facades/sheetN.webp` → `public/facades.webp` and
  `public/facades-mask.webp`): windows, doors and shopfronts that every wall in the
  city is put together from. The brief for each sheet is in `facades/sheetN.txt`;
  `facades/build_atlas.py` cuts and packs them.
- **Character portraits** (`portraits/sheetN.webp` → `public/portraits/`): generated
  with ChatGPT; faces that came out too alike were redone one by one with Codex
  (`portraits/faces/`). `portraits/cut.py` cuts them out.
- **Street furniture surfaces** (`furniture/build.py` → `public/furniture-surfaces.webp`):
  authored timber grain, cast aggregate and public telephone lettering, with the leaf
  spray from `trees/leaf.webp` reused on small courtyard shrubs.
- **Leaves, twigs, needles and bark** (`trees/leaf.webp`, `trees/twig.webp`,
  `trees/needle.webp`, `trees/bark.webp` → `public/street-trees.webp` and
  `public/bark.webp`): a spray of a broadleaf branch in leaf, the same bare in winter, a
  spruce bough, and a trunk's bark, generated with Codex from the briefs in `trees/*.txt`;
  `trees/build.py` packs them. Every tree and shrub seen in first person is put together
  from these, and on Ultra the crowns seen from above carry the sprays too.
- **Street reflections on cars** (`reflections/src/<kind>.webp` →
  `public/reflections.webp`): one eye-level street per kind of area, from the prompt
  in `reflections/src/<kind>.prompt.txt`; `reflections/pack.sh` packs them.
