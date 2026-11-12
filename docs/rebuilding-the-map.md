# Rebuilding the map

<!-- read_when: rebuilding praha, centrum or ujezd after pipeline changes; swapping a new map in; going back to the previous map -->

For rebuilding a map that is already in use: keeping the previous one, the order of
the layer steps, timings and checks. For a first build, `pipeline/build_map.sh <area>`
runs the same steps (and the area's other files) in one go; see "Your first build" in
the handbook (`docs/handbook.md`), which also has the background.

Written in the night of 5–6 October 2026 and kept up to date since; the timings are
dated where they were measured.

A `build_tiles.py --chunks "ci,cj ..."` trial keeps the chunks it does not name. It
requires an existing build with the same area, projection, tile size and chunk grid;
build every layer without `--chunks` first when changing that grid. Malformed or
out-of-grid chunk coordinates stop before downloads, cache writes or metadata changes.
The shared IPR building parser cache follows its parser helpers and constants too,
so changing how source rings are read reparses the sheets on the next build.
Downloaded terrain sheets become cached sources only after their full GML file has
been written; an interrupted write is downloaded again on the next run.
IPR feature downloads retry service errors, malformed responses and empty pages
that still promise more results. If retries fail, they stop without caching an empty
or partial layer. The tree and lamp caches are also published only after a full write.
Sampled image and surface-model arrays are kept per area and carry records of their
source, tile box, resolution and sampling code. Photographs keep their existing
filenames with checks for their source and request. Older entries without these
records are misses on their next use.
Young-wood and tree-size layers also track the shared image and sampling helpers they
use, so changing those helpers makes strict assembly ask for those layers again.
Street simplification keeps OSM way endpoints, so adjacent cuts that contain different
neighboring ways retain the same shared edge ids and each way's own lane count and
width. Intermediate nodes within one way still simplify. This fixes the reproduced
cross-way joining defect at Slatiny between Praha tiles `101_55` and `101_56`; the
current map, built on 15 October, retains that gap until regenerated. Other causes of
disconnected streets still need the checks below.
In the two cached cuts checked in memory, drive edges increased from 488 to 609 and
401 to 496; walk edges from 1,101 to 1,270 and 924 to 1,058. These are local graph
counts, not runtime measurements. A regenerated map still needs route, loading and
frame-time checks before release. Rebuild outputs keyed by street IDs, including
`signals.json`, with the new streets as part of the full sequence below.

## Before starting

- Run from the main checkout, after the branches are merged, with no other pipeline
  job running (`pgrep -fl "build_tiles|ipr_|layers.py|ground_cover|young_woods"`).
  The caches recognise their sources by path and file times, so a copy elsewhere
  (a worktree with APFS clones) finds none of them and works everything out again.
- Don't edit anything in `pipeline/` while a step runs: each step checks its own code
  at the end and refuses its output if a file changed.
- Keep the previous map first (APFS clones, instant, no disk used):

      P=pipeline/.cache/previous-map-$(date +%F); mkdir -p $P/layers
      for a in praha centrum ujezd; do
        cp -cpR public/data/${a}_now $P/; cp -cp public/data/${a}_parking.json $P/
        cp -cpR pipeline/.cache/layers/$a $P/layers/
      done

  `pipeline/.cache/previous-map-2026-10-05` is such a copy, of `praha` only: the map
  built on 4 October (`praha_now`, `praha_parking.json`) with its layers
  (`layers/praha`), taken before the rebuild of 5 October.
  Never keep copies inside `public/data`: `scripts/upload-data.sh` and the beta deploy
  send everything in that folder.

## The steps, in order, for one area

    cd pipeline
    uv run fetch_sources.py          # this month's technical map and parking counts
    uv run build_parking.py praha
    uv run build_tiles.py praha --resume --no-assemble
    uv run ipr_buildings.py praha --resume --no-assemble
    uv run ipr_terrain.py praha --resume --no-assemble
    uv run --group cover ground_cover.py build praha --no-assemble   # every area has this layer
    uv run --group cover young_woods.py build praha --no-assemble    # praha only
    uv run layers.py praha                                           # praha: not --strict yet (below)
    uv run --group cover tree_sizes.py build praha --no-assemble     # praha only
    uv run layers.py praha --strict
    uv run build_signals.py praha

`--resume` reuses completed OSM chunk layers and whole IPR stages when their
grid, inputs, processing code, runtime versions and output hashes match. The IPR
stages also check their build options, so a run with flags such as `--no-survey`
or `--mesh-colours off` can only be reused with the same settings. Missing,
damaged or interrupted output is rebuilt. The previous completion records miss
once after upgrading. Omit `--resume` to rebuild the requested layers.

Then `centrum` and `ujezd` the same way (without the young woods and tree size steps
they don't have, and with `layers.py --strict` straight away). `tree_sizes.py` measures
the trees of the tiles as assembled, so it runs after an assemble; a later assemble
keeps its layer (by each tree's place). That first assemble can't be `--strict` when
anything the tree sizes depend on has changed since they were made (`ground_cover.py`'s
sampling, say): the check refuses the old layer, and only a later step makes the new
one. Seen on 18 October; the strict assemble after the tree sizes is the check.

| Step | Reads | Writes |
|---|---|---|
| `build_tiles.py` | `.cache/osm/` (country extract, the area's and chunks' cuts and `.parsed.pkl`), `.cache/dtm/`, `.cache/trees/`, `public/data/<area>_parking.json` | `.cache/layers/<area>/{buildings,ground,streets,parking}/`, `completed/`, `meta.json`, and the OSM cuts |
| `ipr_buildings.py` | buildings, ground and streets layers, `.cache/ipr/` (sheets, `parsed/`, `source/`), building ages and optional mesh colours | `tiles/*.ipr.bin.gz` in `public/data/<area>_now`, `.cache/layers/<area>/ipr.json` |
| `ipr_terrain.py` | buildings, ground and streets layers, `.cache/ipr/` (terrain sheets, bridges), `.cache/dtm/` (survey heights), `terrain_keep.json`, `terrain_walls.json`, optional IPR LiDAR or DMR 5G raster | `tiles/*.height.bin.gz`, `*.levels.bin.gz`, `.cache/layers/<area>/terrain.json` |
| `ground_cover.py build` | the layers, the terrain layer, `.cache/cover/` (photos, surface model, model, results); asks IPR's server for photos of tiles it has none of | `.cache/layers/<area>/cover.json` |
| `young_woods.py build` | ground layer, terrain layer, `.cache/cover/dsm_ipr` | `.cache/layers/<area>/young.json` |
| `tree_sizes.py build` | the assembled `tiles/*.json`, the terrain layer, `.cache/cover/` (IPR's surface model, ČÚZK's DMP 1G, the summer photo at 1 m and 0.25 m and the colour-infrared one at 1 m: fetched for tiles that have none) | `.cache/layers/<area>/treesize.json` (each tree's height, crown, outline and colour; what grows where, on a 2 m grid); final assembly writes the tiles |
| `layers.py --strict` | every layer, and checks the binary files against the layers' records | `tiles/*.json`, `index.json`, `names.json`, `leaving.json` (the streets that run on past the map's edge, for the countryside made in the browser); removes files of tiles that are gone |
| `build_signals.py` | streets layer, `.cache/osm/` | `signals.json` |

`--strict` stops before writing anything if a chunk is incomplete, a layer was made
from other inputs, or the cover or young woods are out of date; it says which step to
run again. The other files of an area (`lines.json`, `metro.json`, `buses.json`,
`footfall.png`, `lamps.bin.gz`, `bikes.json`, `districts.json`, `landmarks/`) don't
depend on these steps: rebuild one only if its own script changed
(`git diff --stat <commit in index.json's "pipeline">..main -- pipeline/`).

**In parallel:** the three areas keep separate layers and outputs, but share
`.cache/osm`, `.cache/ipr/parsed` and `.cache/dtm`, and each step already uses the
cores (`--jobs`), so run the areas one after another. Within an area the order above
is required; only `build_signals.py` may run beside the steps after `build_tiles.py`.

OSM chunk builds and IPR sheet processing submit at most two futures per worker
(`2 * --jobs`), including completed results waiting for the caller. OSM chunks
are reported as they finish; IPR sheets retain input order. Both refill the queue
as results are consumed, cancel queued work on failure or early close, and wait
for running workers to finish before closing the pool. This limits retained
futures, not total memory: a single chunk or sheet can still be large.

## Trying IPR's LiDAR terrain

Use a worktree with its own map output and about 8 GB free for the download and
import. From `pipeline/`:

    temp=$(mktemp -d)
    curl --fail --location --output "$temp/DTM.zip.part" \
      https://www.arcgis.com/sharing/rest/content/items/97d2c9c11aa9478cb21b469b8a4f820e/data && \
      mv "$temp/DTM.zip.part" "$temp/DTM.zip"
    uv run --with 'tifffile==2026.10.15' --with 'imagecodecs==2026.10.10' ipr_lidar.py "$temp/DTM.zip"
    uv run ipr_terrain.py ujezd --ipr-lidar .cache/ipr_lidar/2023

The importer checks the archive's SHA-256 and its GeoTIFF against the supplied
world file before publishing a memory-mapped cache. Its two files and the build
option are tracked by `--resume` and strict assembly. The terrain build reads
the cache without the TIFF packages. Use `--output` on the importer to create
another cache directory.

This switch samples IPR's 1 m bare-earth elevations in Bpv onto the existing
terrain lattice before the street survey, water and bridges are applied. CityGML
supplies the samples where the raster has no coverage. Builds without the switch
use the existing CityGML terrain source, and `--dmr5g` is a separate experiment.
The map index records the raster's source and archive checksum when it is used.
Credit IPR Praha under CC BY for maps built with the raster.
[IPR catalogue and licence](https://www.arcgis.com/sharing/rest/content/items/97d2c9c11aa9478cb21b469b8a4f820e/info/metadata/metadata.xml?format=default&output=html).

## How long

Quiet machine, from the README and the terrain skill (not measured again tonight):
`praha` with buildings and terrain about 11 minutes with warm caches before the
survey heights came, `ipr_terrain.py praha` alone about 16 minutes now; `centrum`
under half a minute, `ujezd` seconds. These timings predate the per-layer
processing fingerprints and IPR stage resume.

Tonight, in a worktree on APFS clones (so every cache missed) with the machine at a
load of 150–200 from fifteen other sessions: `build_tiles.py ujezd --jobs 2
--no-assemble` took 1,632 s, 751 s of it cutting the area out of the country extract.
That says how badly a busy machine and cold caches hurt, not what the rebuild costs.
`scripts/check-map-rebuild.mjs` on `praha` took 1 min 50 s under the same load.

Measured on 15 October 2026 in the main checkout, machine at a load of about 8, warm
caches, every chunk worked out again after code changes: `build_tiles.py praha` 49 min
(2,930 s in the workers), then `ipr_buildings.py` 84 s, `ipr_terrain.py` 151 s,
`ground_cover.py build` 60 s (278 of 7,330 tiles worked out), `young_woods.py build`
93 s, `layers.py --strict` 52 s, `tree_sizes.py build` 471 s, `layers.py --strict` again
51 s, `build_signals.py` 7 s: about 1 h 10 min for `praha`. `centrum` took 2.5 min
(`build_tiles.py` 107 s of it), `ujezd` 35 s; `check-map-rebuild.mjs` 10 s for all three.

Measured on 18–19 October 2026, main checkout, the machine at a load of 10–50 from
other work, every chunk worked out again: `build_tiles.py praha` 60 min,
`ipr_buildings.py` 8 min, `ipr_terrain.py` 6 min, `ground_cover.py build` 62 min (the
sampling's cache keys had changed), `young_woods.py build` 8 min, `layers.py` 1 min,
`tree_sizes.py build` 41 min, `layers.py --strict` 1 min: about 3 h 10 min for `praha`.

Measured on 5 November 2026, main checkout, the machine at a load of about 3, every
chunk worked out again (a pipeline change and the survey reach recomputed):
`build_tiles.py praha` 64 min, `ipr_buildings.py` 4 min, `ipr_terrain.py` 4 min,
`ground_cover.py build` 17 min (5,234 of 7,323 tiles worked out), `young_woods.py build`
2 min, `layers.py` 1 min, `tree_sizes.py build` 9 min, `layers.py --strict` 1 min: about
1 h 45 min for `praha`; `centrum` 6 min, `ujezd` 2 min, the lamps 1.5 min, so 1 h 53 min
for everything.

The long steps (`build_tiles.py`, `ground_cover.py`, `young_woods.py`, `tree_sizes.py`)
end their progress lines with the time left and when they should be done. In
`build_tiles.py` it runs low for the first half: the chunks go column by column, from
the light edge to the dense middle. On 5 November it said 11:42 at the start and 12:42
halfway, and the step finished at 12:21; from chunk 200 of 252 on it was within a minute.

## Checking the result

    node scripts/check-data-format.mjs public/data
    node scripts/check-map-rebuild.mjs public/data pipeline/.cache/previous-map-<date>

The second compares each area with the copy kept above (format, grid, tile count,
sizes by kind of file, every tile readable, other files present, streets joined
across tile edges on a sample) and exits 1 with the list of what is wrong. Its
tolerances are options (`--size-tolerance`, `--count-tolerance`, `--shrunk`,
`--new-breaks`); a change that really makes tiles a third bigger needs the tolerance
raised on purpose.

## So a running game never sees a half-built map

The pipeline writes into `public/data` of its own checkout (`OUT` in
`pipeline/osm_area.py`); there is no option for another folder yet. With
`--no-assemble` the tile JSON and the index change only in the last step, but the
`.bin.gz` files change as the IPR steps run, so for a while new heights sit under old
tiles. Two ways round it:

1. Stop the dev servers (or don't play) from `ipr_buildings.py` to the check, and
   reload afterwards. Simple, and what tonight's rebuild should do.
2. Not built yet: an environment variable for `OUT`, so the steps write into a clone
   (`pipeline/.cache/next-map/`) while using the main caches, and two renames swap it
   in after the check. It is one line in `osm_area.py`; note that the parking layer's
   key includes the path of `<area>_parking.json`, so that layer is redone once.

## Going back

    for a in praha centrum ujezd; do
      mv public/data/${a}_now pipeline/.cache/broken-map-${a}
      cp -cpR pipeline/.cache/previous-map-<date>/${a}_now public/data/
      trash pipeline/.cache/layers/$a && cp -cpR pipeline/.cache/previous-map-<date>/layers/$a pipeline/.cache/layers/
    done
    node scripts/check-data-format.mjs public/data

Restore the layers together with the map: the layers' records name the binary files'
hashes, and a map with other layers fails `--strict` on the next build. The copied
layers count as made from other inputs where a record holds a file's times, so the
next rebuild works those out again. For `previous-map-2026-10-05` this brings back
`praha` only. Production is not touched by any of this (it reads the uploaded
version in `deploy/data-version`; see the deploy skill).
