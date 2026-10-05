---
read_when: Working on ground_cover.py's build step or the cover layer, judging what the photo-classified ground got right or wrong, or deciding on the next beige-ground step (courtyards, ground outside IPR's photographs, seams).
---

# The unmapped ground, classified for the whole city (3–4 October 2026)

`pipeline/ground_cover.py build praha` now classifies the plain ground of the city from
IPR's aerial photographs and surface model and puts the result into the tiles. This
note records what was measured. The map data was built locally and **not deployed or
uploaded**; the shared `public/data/praha_now` was changed (see "What changed on disk").

## Where things stood

The live map (built 3 October 2026 14:17 from `3fe4b61c3d-dirty`) already had plan 013's
squares, grey pavement and surveyed courtyards and green. Measured with
`pipeline/beige_report.py` and a per-tile version of it:

| | tiles | plain ground |
| --- | --- | --- |
| `centrum` (as built) | 234 | 72.47 ha of 1,289.73 ha (72.20 ha when plan 013 recorded it) |
| `praha` before the cover | 14,595 | **4,329.6 ha** of 90,484.6 ha |

## Method: rules

`ground_cover.py score` on the 108 hand-labelled pieces round Smíchov, 9 tiles:

| method | exact | green or not | material on hard ground | roofs and clutter caught |
| --- | --- | --- | --- | --- |
| `rules` | 62 % | 93 % | 40 % | 92 % |
| `model` (gradient boosting) | 27 % | 88 % | 23 % | 32 % |
| `model` without the land-use class | 21 % | 95 % | 11 % | 32 % |

Chosen: **`rules`**. The model learns from OSM's parks and roads, whose surfaces look
nothing like unmapped ground, so it calls clutter paving and misses roofs. The rules were
tuned by eye on these same pieces, so 62 % is optimistic. Only the Smíchov labels exist;
other districts were judged by eye (below). Asphalt, gravel and dirt are the weak part
(40 % on hard ground); grass against trees is reliable and so are roofs and sheds.

## The download

IPR's colour and infrared orthophotos cover the city only: tiles outside it come back
black (2,377 of the 8,149 tiles looked at). Surface model: already local for the whole city
(`DSM_1m.tif`, 3.7 GB), nothing to download.

| | per tile | whole city (5,772 tiles with a photo; 8,149 asked) |
| --- | --- | --- |
| PNG, 0.25 m (the prototype's way) | 2.35 MB × 2 | about 27 GB |
| JPEG, 0.25 m (used) | 0.26 MB × 2 | **2.6 GB** on disk |
| JPEG, 0.5 m | 0.08 MB × 2 | about 0.9 GB, but loses 5 points on the hand labels (57 % against 62 %) |

Lossy JPEG at 0.25 m scored the same as the PNG on the labels (64 against 63 pieces right
of 108). Infrared is needed (greenness decides grass and trees) and costs about as much as
the colour image. The prototype also kept every photo as float arrays, 32 MB a tile, which
would have been about 180 GB for the city; the build keeps the JPEG and decodes it. Tiles
under 0.1 ha of plain ground (6,446 tiles, 192 ha, 4.4 %) are not looked at.
Disk before: 184 GB free.

## Result

Build: 73 minutes for the city on six processes (8,149 tiles looked at, 5,738 with cover),
including the photo downloads. A second run redoes nothing (keys of the tile's ground,
heights, photographs, surface model and code).

Little of that was the download: with the photographs on disk, working every tile out
again still took 55 minutes on six processes (5 October 2026), the first 8 of them one
process deciding which tiles have enough plain ground. Working a tile out took 0.9 s, most of
it projecting its million pixels into S-JTSK three times over (for the colour photograph,
the infrared one and the surface model). `sjtsk()` now projects a 33 × 33 lattice once per
tile and places the pixels between its points (within 0.00002 mm of projecting each one):
0.34 s a tile on 40 tiles spread over the city, with the same cover out.

Two more steps brought that to 0.18 s a tile, again with the same cover on those tiles.
`burn()` fills polygons row by row instead of testing every pixel of a polygon's box
against every edge (20 times faster over 1,217 tiles; 75 pixels of 1.3 thousand million
came out differently, where a pixel's centre lies exactly on an edge), and `summarise()`
measures only the pixels that belong to a piece.

The cover's code key (`layers.cover_processing`, `build_cache.reach_key`) now covers only
`tile_cover` and what it leads to in `ground_cover.py`, so a change to the prototype's other
commands (`ortho`, `train`, `sheet`, `score`...) no longer redoes every tile. A change to
the classifier does, from the photographs already on disk.

Measured after these changes: every tile of the city worked out again in 7 min 51 s on ten
processes (`--jobs 10`, photographs on disk), and a run with nothing to redo takes 70 s,
25 s of it putting the tiles together.

| | plain ground |
| --- | --- |
| `praha` before | 4,329.6 ha |
| `praha` after | **2,459.9 ha** (−43 %) |
| in tiles with a photograph: before → after | 2,610.9 → 741.3 ha (−72 %) |
| left: tiles outside IPR's photographs | 1,526.6 ha |
| left: tiles under 0.1 ha of it | 192.0 ha |

What was filled: 538 ha dirt, 512 ha gravel, 473 ha trees (as wood), 227 ha asphalt,
128 ha grass, plus 82,394 single trees from the canopy tops. About 740 ha in photographed
tiles stays plain on purpose or by limit: roofs and sheds missing from OSM, site clutter,
shadows, and ground the rules call "not ground".

Every one of the 5,738 changed tile files differs from the old one only in `cover_*`
areas, additions to `wood` and additions to `trees` (checked by comparing each tile with
its snapshot).

## Tile size

14,595 tile JSONs, as in plan 013 (raw, and each file gzip level 9):

| | before | after | |
| --- | --- | --- | --- |
| raw | 469.0 MB | 522.2 MB | +11.3 % |
| gzip | 120.3 MB | 134.7 MB | **+14.4 MB, +12.0 %** |

Per changed tile (5,738): median +2.0 KB gzip (+22 %), mean +2.5 KB, 95th percentile
+6.3 KB, largest +17.9 KB. `public/data/praha_now` went from 661 to 712 MB. The cover
layer file is 54 MB in the cache; the results cache 75 MB.

## Cost in the game

`scripts/bench.mjs` in real Chrome on WebGPU, 2×, High, clear 14:00, 10 s a scene, the
two maps taken turns (`?area=praha_beforecover`, a copy of the old map, against
`praha`), three rounds with the order reversed. The machine was not clean: the desktop
and the Claude app used about 18 % of the GPU before and 83 % after (the last reading
came after the runs), and one run aborted on a WebGL fallback and is left out.

- **Work counted** (the same every run): draw calls +4 to +13 (Old Town Square 88 → 96,
  Letná 143 → 147, Florenc 119 → 132, Bubeneč 167 → 177, Barrandov 106 → 112);
  triangles +0 to +18 % (Barrandov, with its added woods and trees, 1.31 M → 1.55 M).
- **Frame time:** the medians sit between 3.5 and 8.5 ms in both maps, with run to run
  differences of up to 4 ms for an unchanged map (Old Town Square before: 3.5, 7.5, 7.2 ms;
  the first run came before something else started using the GPU). Florenc
  6.8/6.8/7.0 before and 6.9/7.0/7.0 after; Barrandov 6.1/5.9/6.0 and 6.7/6.1;
  Bubeneč 8.0/7.6/8.5 and 8.0/6.9. **No frame-time change can be told from the noise.**
  All scenes run far above 60 frames a second at 2×. The GPU timer does not work on Metal
  and nothing was measured on a phone or a Windows GPU.
- No new shader pattern: the layers reuse grass, dirt, gravel, asphalt and wood.

## What to look at

Matched views (same camera, 14:00, clear) in `docs/evidence/beige-cover/`, before on the
left: `oldtown-florenc.jpg` (Florenc bus station, 50.08937 N 14.442 E),
`estate.jpg` (Jižní Město, 50.02418 N 14.51878 E), `villas.jpg` (Liboc villas,
50.10054 N 14.34416 E), `barrandov.jpg` (50.0309 N 14.3862 E), `park-edge.jpg`
(Bubeneč railway and park, 50.1051 N 14.43151 E), `rail-zizkov.jpg` (a park by
Žižkov: the camera was meant for the freight yard and missed it; the railway yard
is shown better at Bubeneč). Each is `t.camera({ at, height: 230, tilt: 12, heading: 0 })`.
Earlier Smíchov, Žižkov freight yard and Vršovice pairs were checked the same way but
not kept.

## Wrong calls and limits seen

- **Gravel against dirt against asphalt** is the weak call (40 % on the hand labels): the
  2024 photo is bright and hazy, so asphalt is often grey, not dark. Florenc's bus
  station shows blotches of dirt and gravel on what is asphalt.
- **No seams handling:** tiles are classified one at a time, so a patch can change class
  across a tile edge. Not measured; none stood out in these views.
- **Only the beige is classified:** DTM courtyards (`dtm_yard`) keep their neutral
  paved look. That is plan 014's step and the rules are untested on yards.
- **Outside the photographs:** 1,526.6 ha of plain ground in 2,377 tiles beyond IPR's
  pictures have no cover. ČÚZK's orthophoto could cover them.
- **82,394 single trees** come from canopy tops, and the woods are filled with the game's
  own trees, so trees now follow the photo rather than OSM; check performance on a phone.
- Tiles whose ground or heights are rebuilt later lose their cover until
  `ground_cover.py build` is run again (an error under `layers.py --strict`).
- Fully empty tiles are never listed, so they could not get cover (none in `praha`).

## What changed on disk

- Code: `pipeline/ground_cover.py` (`build`), `pipeline/layers.py` (`merge_cover`,
  `cover_key`, assembly), `pipeline/build_cache.py` (`code_key()` leaves
  `ground_cover.py` out), the `?cover` flag removed from `src/tiles.ts`, `src/main.ts`.
  The tile format and map format (2) did not change; `deploy/data-oldest` is untouched.
- Data: `public/data/praha_now` now has the cover (5,738 tiles rewritten, `index.json`
  stamped by the dirty pipeline). A copy of the old city map is in
  `public/data/praha_beforecover_now` (the before in the screenshots; **delete it before
  any deploy, which syncs the whole folder**) and `/private/tmp/sop-ujezd-before-cover`.
  `ujezd_now` was rebuilt through every step, strict assembly included, as a check of the
  whole chain; `centrum_now` has no cover.
- Caches: `pipeline/.cache/cover/` (photos 2.6 GB, results, and the copied Smíchov data).
  `strict` assembly of `praha` itself was not run: the code key changed with the edits
  above, so it asks for a rebuild of every layer first. The city assembled without
  `--strict`, with the layers as they were.
