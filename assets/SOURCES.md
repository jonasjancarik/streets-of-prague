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
- **Street reflections on cars** (`reflections/src/<kind>.webp` →
  `public/reflections.webp`): one eye-level street per kind of area, from the prompt
  in `reflections/src/<kind>.prompt.txt`; `reflections/pack.sh` packs them.
