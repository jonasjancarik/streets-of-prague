# Where the pictures and models come from

Sounds have their own list in [`public/audio/SOURCES.md`](../public/audio/SOURCES.md),
and the map data its credits in the README.

## Old Town Square

The Old Town Hall and Orloj, Týn Church, St Nicholas and the Marian Column are
modelled in `old-town-square/`. The three buildings retain parts of their
surveyed envelopes and textures. Their principal elevations, roof details and
the freestanding Marian Column are reconstructed. Each game model and its
texture atlas are licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Building geometry and aerial surfaces are adapted from [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh), CC BY 4.0.

The following Wikimedia Commons photographs were cropped, perspective-corrected
and mapped onto the models. In the town hall textures, the photographed lamp
and parts of the clock housing were removed where they overlapped modelled details.

| Model | Photographic sources |
| --- | --- |
| Old Town Hall | Dietmar Rabich / Wikimedia Commons, [Prag, Altstädter Rathaus, Astronomische Uhr — 2019 — 6590](https://commons.wikimedia.org/wiki/File:Prag,_Altst%C3%A4dter_Rathaus,_Astronomische_Uhr_--_2019_--_6590.jpg), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Yair Haklai, [Old Town Hall Tower (Prague)](https://commons.wikimedia.org/wiki/File:Old_Town_Hall_Tower_(Prague).jpg), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Sajjadmrt, [Prague astronomical clock in 2026](https://commons.wikimedia.org/wiki/File:Prague_astronomical_clock_in_2026.jpg), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). |
| Tower and council houses | Jorge Láscar, [Old Town Hall and Astronomical Clock](https://commons.wikimedia.org/wiki/File:Lascar_Old_Town_Hall_(Staromestsk%C3%A1_radnice)_and_Astronomical_Clock_(Orloj)_(4501597341).jpg), [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/). PatrikPaprika, [Praha, Staroměstské náměstí, Staroměstská radnice (01)](https://commons.wikimedia.org/wiki/File:Praha,_Starom%C4%9Bstsk%C3%A9_n%C3%A1m%C4%9Bst%C3%AD,_Starom%C4%9Bstsk%C3%A1_radnice_(01).jpg), [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). |
| Týn Church | Dennis Jarvis, [Czech-03862 — Church of Our Lady before Týn](https://commons.wikimedia.org/wiki/File:Czech-03862_-_Church_of_Our_Lady_before_T%C3%BDn_(33020809055).jpg), [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/). |
| St Nicholas | Petr Šmerkl, Wikipedia, [Church of St Nicholas of Old Town in Prague 2010](https://commons.wikimedia.org/wiki/File:Church_of_St_Nicholas_of_Old_Town_in_Prague_2010.jpg), [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). |
| Marian Column | Gampe, [statue and capital](https://commons.wikimedia.org/wiki/File:Marian_column_Prague_(4825).jpg) and [pedestal inscription](https://commons.wikimedia.org/wiki/File:Marian_column_Prague_(4827).jpg), [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Xyzabec, [front right angel](https://commons.wikimedia.org/wiki/File:Praha_Mari%C3%A1nsk%C3%BD_sloup_And%C4%9Bl_vpravo_vp%C5%99edu.jpg) and [rear left angel](https://commons.wikimedia.org/wiki/File:Praha_Mari%C3%A1nsk%C3%BD_sloup_And%C4%9Bl_vlevo_vzadu.jpg), [CC0](https://creativecommons.org/publicdomain/zero/1.0/). The wings follow the [completed restoration](https://www.marianskysloup.cz/clanky/aktuality/socharska-vyzdoba-sloupu-dokoncena.html). |

## Jan Hus Memorial

The model reconstructs Ladislav Šaloun’s memorial on Old Town Square. Its height
and placement follow the IPR Praha survey and its steps follow the OpenStreetMap
footprint. The figures and pedestal are modelled in `jan-hus/build.py`. The
photographs below were cropped, recoloured and wrapped onto the sculpture.
The resulting model and atlas are licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

| Atlas input for `--photos` | Photograph |
| --- | --- |
| `plate.jpg` | Anonymous plate in Matějček and Wirth, *Modern and Contemporary Czech Art* (1924), public domain. [Standing figure and granite relief](https://commons.wikimedia.org/wiki/File:The_Jan_Hus_Monument_at_Prague.jpg) |
| `exiles.jpg` | Wisniowy, public domain. [Western group](https://commons.wikimedia.org/wiki/File:Pomnik_jana_husa_wisnia6522.JPG) |
| `chalice.jpg` | Enfo, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). [Eastern group](https://commons.wikimedia.org/wiki/File:046_Starom%C4%9Bstsk%C3%A9_N%C3%A1m%C4%9Bst%C3%AD,_monument_a_Jan_Hus.jpg) |
| `reverse.jpg` | VasuVR, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). [Rear figures and dedication, left stereograph](https://commons.wikimedia.org/wiki/File:PCZ828_18_Praha_D_Old_Town_hall_square_Jan_Hus_monument_2_back_3D.jpg) |
| `face.jpg` | Kawon Kez Sel, [CC0](https://creativecommons.org/publicdomain/zero/1.0/). [Hus’s face](https://commons.wikimedia.org/wiki/File:Jan_Hus_Monument_(zoomed_detail),_Prague,_August_2025.jpg) |

## Fantova budova

The historic main station uses IPR Praha’s survey for the building plan, heights,
central roof and platform elevation. The entrance, galleries and both end pavilions
are modelled. The gable,
clock surrounds and window bays adapt Lynx1211’s 2017 photograph. The façade
details were cropped, resized and fitted to the geometry. The glass lanterns,
frames, ribs and canopy brackets are modelled. The combined GLB and derived
photographic panels are licensed under CC BY-SA 4.0.
[IPR Praha 3D survey (CC BY)](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh),
[Lynx1211’s front elevation](https://commons.wikimedia.org/wiki/File:Secesn%C3%AD_budova_Hlavn%C3%ADho_n%C3%A1dra%C5%BE%C3%AD.jpg),
[south tower reference by ŠJů](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_ji%C5%BEn%C3%AD_v%C4%9B%C5%BE_hlavn%C3%ADho_pr%C5%AF%C4%8Del%C3%AD.jpg),
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

The end pavilions use rectified, colour-adjusted details from photographs by ŠJů,
Wikimedia Commons. The tile courses, ridge lanterns, ironwork and stone birds are
original reconstructions. All parts share the station’s texture atlas.

| Pavilion detail | Source photograph by ŠJů | Source licence |
| --- | --- | --- |
| South pavilion window bays, projecting end window and rusticated lower storey | [street elevation](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_ji%C5%BEn%C3%AD_k%C5%99%C3%ADdlo,_od_Vrchlick%C3%A9ho_sad%C5%AF.jpg), [end elevation](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_od_jihu.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Carved arches and doors | [west arch](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_z%C3%A1padn%C3%AD_vchod_do_ji%C5%BEn%C3%ADho_k%C5%99%C3%ADdla,_port%C3%A1l.jpg), [south entrance](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_ji%C5%BEn%C3%AD_vchod.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Clock face, banded tower masonry, crown reliefs and gilded wings | [south clock](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_ji%C5%BEn%C3%AD_v%C4%9B%C5%BE,_ji%C5%BEn%C3%AD_cifern%C3%ADk.jpg), [clock tower](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_ji%C5%BEn%C3%AD_v%C4%9B%C5%BE.jpg), [winged wheel](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_ji%C5%BEn%C3%AD_v%C4%9B%C5%BE,_ok%C5%99%C3%ADdlen%C3%A9_kolo.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| North pavilion stained-glass bay | [north windows](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_vitr%C3%A1%C5%BEe_na_severn%C3%AD_stran%C4%9B.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| North pavilion oval windows and balconies | [Wilsonova balconies](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_z_Wilsonovy_ulice,_balk%C3%B3ny_severn%C3%ADho_k%C5%99%C3%ADdla.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| North pavilion double-height portal | [north portal](https://commons.wikimedia.org/wiki/File:Praha_hlavn%C3%AD_n%C3%A1dra%C5%BE%C3%AD,_Fantova_budova,_port%C3%A1l_severn%C3%ADho_k%C5%99%C3%ADdla.jpg) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |

## National Theatre

The building plan and roof heights follow IPR Praha’s city model. The texture of the
two copper roofs at the rear comes from its 2023 aerial survey. The open porches,
auditorium roof, gilded ironwork, chariots and stone figures are modelled in
`national-theatre/`. [IPR Praha, 3D mesh, CC BY](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh).

The stonework sheet contains rectified, tinted details from public-domain
photographs. The capitals, fluting, carved panels, niches and window bays come
from plates in Matějček and Wirth’s *Modern and Contemporary Czech Art* (1924).
The attic windows come from Karelj’s photograph of the theatre from the bridge.
[West façade](https://commons.wikimedia.org/wiki/File:Part_of_the_west_facade_of_the_National_Theatre_in_Prague.jpg),
[entrance balcony](https://commons.wikimedia.org/wiki/File:Part_of_the_Balcony_of_the_National_Theatre_in_Prague.jpg),
[riverside elevation](https://commons.wikimedia.org/wiki/File:National_Theatre,_Prague.jpg) and
[Karelj’s 2008 photograph](https://commons.wikimedia.org/wiki/File:N%C3%A1rodn%C3%AD_divadlo_prg.jpg).

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

The street-level gas lanterns are original models of the cast frame, glazing and
burner assembly. The lighting contractor's Prague installation was a visual
reference. [BRAUN Lighting Solutions, Charles Bridge and Prague Old Town](https://braun.lighting/wp-content/themes/braun/pdf.php?id=3229).

## Vltava reflections

The bank panoramas use IPR Praha's summer 2023 photorealistic mesh, cropped to
the stationary waterfront. Blender renders the colour and distance to each
surface from the river. The map supplies the water surface and shore distances.
`pipeline/river_reflections.py` builds `public/vltava-banks.webp` and its
geographic station list. [IPR Praha, 3D mesh, CC BY](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh).

## Hradčany skyline

`pipeline/castle_horizon.py` cuts the hill and palace from IPR Praha's 2023 survey.
Blender renders eight colour and depth views, including the bearing from the middle
of Charles Bridge. The visible surfaces become the small meshes and shared
photographic atlas in `public/hradcany-horizon.glb`. The evening atlas uses
OpenStreetMap building footprints and the photographed surface directions to
pick out the southern palace front, St Vitus and the towers of St George.
The lighting pattern follows the castle's architectural lighting brief.
[IPR Praha, 3D mesh, CC BY](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh),
[OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright)
and [Prague Castle lighting brief](https://cceamoba.cz/media/pages/souteze/sph/76ac71dda2-1767975363/sph-p.01-outline-brief.pdf).

## Mostecká shopfronts

`pipeline/mostecka_frontages.py` derives the positions and shop categories from
the local Prague OpenStreetMap extract. The display contents reuse the street
window atlas. [OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright).

## Made from code

- The street pigeon is an original Blender mesh with vertex-coloured plumage.
  Rebuild it with `blender -b --factory-startup -P assets/birds/pigeon.py`.
  Its proportions and markings follow the [Cornell Lab’s rock pigeon identification photographs](https://www.allaboutbirds.org/guide/Rock_Pigeon/id).
- The café folding chairs, slatted tables and square parasols are modelled in
  `src/terraceFurniture.ts`. The furniture shares the park benches’ timber texture.
  The visual reference is [Prague’s outdoor dining guide](https://kultivovana.praha.eu/files/manual_predzahradky_MHMP_digi.pdf).
- The sightseeing cruiser is an original model of a low-deck Vltava passenger boat.
  The fleet photographs were used as visual reference. Its seated skipper and passengers
  are simplified from the credited Rocketbox driver poses with `assets/boats/crew.py`.
  [Prague Boats, Lužnice](https://www.prague-boats.cz/luznice-boat/).

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
  licence goes with them (`rocketbox/LICENSE.md`). For male-adult-07, the navy overshirt,
  charcoal trousers, trainers and short-haired face use two ImageGen edits of the
  original UV atlases. The editable images are in `rocketbox/overshirt/`. Its
  `build.mjs` takes the original LOD1 GLB and an output path. It runs Blender to fit
  the clothing and shoe soles to the existing rig, then uses Pillow, NumPy, SciPy and
  Basis Universal to align the face and pack the mipmapped textures. The middle-distance crowd uses
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
