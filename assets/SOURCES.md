# Where the pictures and models come from

Sounds have their own list in [`public/audio/SOURCES.md`](../public/audio/SOURCES.md),
and the map data its credits in the README.

## Charles Bridge

The street-level John of Nepomuk is an original reconstruction. Its bronze
figure, three-part pedestal, cast panels, palm and five stars are editable in
`charles-bridge/nepomuk.blend`, with the texture atlas packed into the file. Export
the single-mesh game asset with
`blender -b assets/charles-bridge/nepomuk.blend -P assets/charles-bridge/export.py`.

- The figure uses public-domain photographs by Ysangkok, Wisniowy and Nikkolo.
  [Front](https://commons.wikimedia.org/wiki/File:John_of_Nepomuk_front.jpg),
  [profile](https://commons.wikimedia.org/wiki/File:Jan_Nepomucen_praga_wisnia6522.jpg)
  and [three-quarter view](https://commons.wikimedia.org/wiki/File:Prague_Jan_Nepomuck%C3%BD_07.jpg).
- The coloured reliefs and inscription combine Nikkolo's public-domain photograph
  of the pedestal with the public-domain historical photograph held by the Library
  of Congress. [Pedestal](https://commons.wikimedia.org/wiki/File:Prague_Jan_Nepomuck%C3%BD_08.jpg)
  and [historical photograph](https://commons.wikimedia.org/wiki/File:Prague._Statue_of_St._John_Nepomue_LCCN94512601.tif).
- The pedestal grain comes from Rob Tuytel’s CC0 sandstone scans. The bridge wall and coping
  use the diffuse and ambient occlusion images from Large Sandstone Blocks, packed by `assets/ground/bridge.py`.
  [Large Sandstone Blocks](https://polyhaven.com/a/large_sandstone_blocks) and
  [Sandstone Blocks 04, Poly Haven](https://polyhaven.com/a/sandstone_blocks_04).

The sixteen open vaults and their cutwaters are original geometry built on the
OpenStreetMap pier positions. Their faces use both sides of IPR Praha's summer
2023 photorealistic mesh, projected in Blender and combined with the sandstone
scans above. The end openings use the published clear spans. The other openings
follow the distances between the mapped piers. The packed source is
`charles-bridge/arches.blend`. Use the same exporter with that file to rebuild
`public/charles-arches.glb`. [IPR Praha, 3D mesh, CC BY](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh),
[OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright)
and [Charles Bridge, Prague City Tourism](https://prague.eu/en/objevujte/charles-bridge-karluv-most/).

## Made from code

- The street pigeon is an original Blender mesh with vertex-coloured plumage.
  Rebuild it with `blender -b --factory-startup -P assets/birds/pigeon.py`.
  Its proportions and markings follow the [Cornell Lab’s rock pigeon identification photographs](https://www.allaboutbirds.org/guide/Rock_Pigeon/id).
- The café folding chairs, slatted tables and square parasols are modelled in
  `src/terraceFurniture.ts`. The furniture shares the park benches’ timber texture.
  The visual reference is [Prague’s outdoor dining guide](https://kultivovana.praha.eu/files/manual_predzahradky_MHMP_digi.pdf).

- `cars/build.py`, `trams/build.py`, `figures/build.py` build the cars, trams, people
  and bikes (`public/cars.glb`, `public/trams.glb`, `public/figures.glb`) in Blender
  from code. No outside models are used.
- The hatchback, estate, SUV, taxi, van, pickup and police shells (`cars/street_shapes.py`) are original Blender surfaces fitted to the game's wheel and door layouts. An ImageGen concept sheet informed the hatchback, estate, SUV and taxi proportions. The game uses the modelled geometry.
- The street sedan (`cars/sedan.py`, `sedan_surfaces.py`, `sedan_fascia.py`, `sedan_cabin.py`)
  is original unbadged coachwork. Rebuild with Blender 5.2 using
  `blender -b --factory-startup --python-exit-code 1 -P assets/cars/sedan.py`.
  Exterior proportion and lighting reference: [Škoda's Superb design study](https://www.skoda-storyboard.com/en/press-releases/skoda-auto-releases-exterior-sketches-of-the-fourth-generation-superb/).
- `pipeline/skyline.py` draws the skylines on the loading screen
  (`public/skylines/`) from IPR Praha's 3D buildings and terrain (CC BY).
- The pictures and videos on the homepage (`site/media/`) are filmed in the game
  (`trailer/`, `site/media.sh`).

## From outside

- **Passage finishes** (`public/passage-finishes.webp`): original plaster, vitrine surround, terrazzo and ceiling artwork generated with OpenAI ImageGen. The prompt is in `facades/passage-finishes.txt`.
- **Shop displays** (`public/shop-displays.webp`): generated for the game with OpenAI ImageGen. The four shop back walls share one texture. The generation prompt is in `facades/shop-displays.txt`.
- **Street façade plaster** (`public/street-plaster.webp`): [Plastered Wall, Amal Kumar / Poly Haven](https://polyhaven.com/a/plastered_wall), CC0.
  `facades/plaster.py` takes the 1K diffuse and OpenGL normal JPEGs. It preserves the
  fine grain while the building supplies the colour. The opening profiles and the
  local ornament masks come from the game's existing façade sheets (`facades/openings.py`).

- **People close up in first person** (`public/rocketbox/`): 14 avatars from the
  [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) library (MIT,
  © 2020 Microsoft) in CodePawl's [GLB repack](https://huggingface.co/datasets/codepawl/rocketbox-avatars-glb)
  (half the triangles, KTX2 textures), and the library's own walk, slow run and run clips,
  and a few of its standing ones (waiting, looking round, on the phone, under an umbrella). `rocketbox/build.sh` downloads them and converts the clips with `rocketbox/clips.mjs`
  onto the avatars' bone axes (a straight Blender conversion bent the knees backwards); the
  licence goes with them (`rocketbox/LICENSE.md`). The middle-distance crowd uses
  the same fourteen source meshes, diffuse maps and motions. `rocketbox/crowd.mjs`
  simplifies them and bakes their poses, and `rocketbox/crowd_atlas.py` packs the
  diffuse maps into one texture. The seated occupants in
  `public/car-drivers.glb` are the male-adult-13, female-adult-05 and uniformed
  male-adult-10 avatars baked in the game’s seated entry pose. Their vertex colours
  sample the corresponding diffuse textures (`cars/pose_driver.mjs`, `cars/driver_mesh.py`).

- **Seat weave** (`public/sedan-upholstery.webp`): [Fabric Pattern 05 by Rob Tuytel, Poly Haven](https://polyhaven.com/a/fabric_pattern_05), CC0.
  Run `assets/cars/seat_weave.py` on the colour-01 1K JPEG to produce the neutral fabric tile.

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
- **Street-level hedges and grass** (`hedges/cluster.webp`, `hedges/face.webp` → `public/hedge-leaves.webp`, `public/hedge-face.webp`; `grass/blades.webp` → `public/grass-blades.webp`): generated for the game with OpenAI's image models through Codex. The prompts are beside the pictures (`cluster.txt`, `face.txt`, `blades.txt`); `build.py` in each folder packs them.
- **Street-level setts** (`ground/setts.py` → `public/street-setts.webp`): [Cobblestone Pavement by Charlotte Baglioni, Poly Haven](https://polyhaven.com/a/cobblestone_pavement), CC0. The 2.5 m scan supplies stone reflectance, joint shading and normals.
- **Pavement mosaic** (`ground/pavement.py` → `public/street-mosaic.webp` and `public/street-mosaic-relief.webp`): original procedural limestone cubes at the six-centimetre size described in the city’s [public-space guide](https://praha.eu/documents/42395/71960/mhmp_verejne_prostranstvi_2022_08_19_web.pdf/4ead22ca-2a90-4314-0a5a-639093405d73). The layout on each stretch is inferred.
- **Street ironwork** (`ground/ironwork.py` → `public/ironwork.webp` and `public/ironwork-normal.webp`): original procedural cast-iron relief. The rings, lifting slots and gate motif take their cues from the [Prague water company’s manhole reference drawings](https://zakazky.pvs.cz/document_audit_8706/smlouva-o-dilo_p8b-mestske-standardy-kanal_cast_b_vykres-pdf).
- **Close asphalt** (`ground/asphalt.py` → `public/street-asphalt.webp`):
  [Asphalt 04, Poly Haven](https://polyhaven.com/a/asphalt_04), photographed by
  Sergej Majboroda and processed by Jenelle van Heerden, CC0. The script takes
  `asphalt_04_diff_1k.jpg` and `asphalt_04_nor_gl_1k.jpg` from the 1K JPEG set.
  The four-metre scan supplies relative grain and normals; the game colours each road.
- **Fair-weather clouds** (`sky/clouds.py` → `public/cloud-bank.webp`): an original
  procedural volume built from the game's cloud-shadow field. The atlas records the
  light passing through it at twelve compass headings and seven elevations.
- **Street furniture surfaces** (`furniture/build.py` → `public/furniture-surfaces.webp`):
  authored timber grain, cast aggregate and public telephone lettering, with the leaf
  spray from `trees/leaf.webp` reused on small courtyard shrubs.
- The close fence atlas (`furniture/fences.py` → `public/street-fences.webp`) uses the
  same timber grain. Its wire, ironwork, folded steel slats and fittings are drawn to scale.
- **Leaves, twigs, needles and bark** (`trees/leaf.webp`, `trees/twig.webp`,
  `trees/needle.webp`, `trees/bark.webp` → `public/street-trees.webp` and
  `public/bark.webp`): a spray of a broadleaf branch in leaf, the same bare in winter, a
  spruce bough, and a trunk's bark, generated with Codex from the briefs in `trees/*.txt`;
  `trees/build.py` packs them. Every tree and shrub seen in first person is put together
  from these, and on Ultra the crowns seen from above carry the sprays too.
- **Street reflections on cars** (`reflections/src/<kind>.webp` →
  `public/reflections.webp`): one eye-level street per kind of area, from the prompt
  in `reflections/src/<kind>.prompt.txt`; `reflections/pack.sh` packs them.
