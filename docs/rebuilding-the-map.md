# Rebuilding the map

<!-- read_when: rebuilding praha, centrum or ujezd after pipeline changes; swapping a new map in; going back to the previous map -->

Written in the night of 5–6 October 2026, short of time: the order and the inputs
below were read from the code; the swap and the timings are marked where they were
not tried. The README's "Building the map" has the background.

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
    uv run build_tiles.py praha --resume --no-assemble
    uv run ipr_buildings.py praha --no-assemble
    uv run ipr_terrain.py praha --no-assemble
    uv run --group cover ground_cover.py build praha --no-assemble   # praha and ujezd have this layer
    uv run --group cover young_woods.py build praha --no-assemble    # praha only
    uv run layers.py praha --strict
    uv run --group cover tree_sizes.py build praha                   # praha only; assembles again
    uv run build_signals.py praha

Then `centrum` and `ujezd` the same way (without the cover, young woods and tree size
steps they don't have). `tree_sizes.py` measures the trees of the tiles as assembled, so
it runs after `layers.py`; a later assemble keeps its layer (by each tree's place).

| Step | Reads | Writes |
|---|---|---|
| `build_tiles.py` | `.cache/osm/` (country extract, the area's and chunks' cuts and `.parsed.pkl`), `.cache/dtm/`, `.cache/trees/`, `public/data/<area>_parking.json` | `.cache/layers/<area>/{buildings,ground,streets,parking}/`, `completed/`, `meta.json`, and the OSM cuts |
| `ipr_buildings.py` | buildings and ground layers, `.cache/ipr/` (sheets, `parsed/`, `source/`), `.cache/mesh_colours/<area>*` | `tiles/*.ipr.bin.gz` in `public/data/<area>_now`, `.cache/layers/<area>/ipr.json` |
| `ipr_terrain.py` | ground and streets layers, `.cache/ipr/` (terrain sheets, bridges), `.cache/dtm/` (survey heights), `terrain_keep.json` | `tiles/*.height.bin.gz`, `*.levels.bin.gz`, `.cache/layers/<area>/terrain.json` |
| `ground_cover.py build` | the layers, the terrain layer, `.cache/cover/` (photos, surface model, model, results); asks IPR's server for photos of tiles it has none of | `.cache/layers/<area>/cover.json` |
| `young_woods.py build` | ground layer, terrain layer, `.cache/cover/dsm_ipr` | `.cache/layers/<area>/young.json` |
| `tree_sizes.py build` | the assembled `tiles/*.json`, the terrain layer, `.cache/cover/` (IPR's surface model, ČÚZK's DMP 1G, the summer photo at 1 m and 0.25 m and the colour-infrared one at 1 m: fetched for tiles that have none) | `.cache/layers/<area>/treesize.json` (each tree's height, crown, outline and colour; what grows where, on a 2 m grid), then the tiles |
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

## How long

Quiet machine, from the README and the terrain skill (not measured again tonight):
`praha` with buildings and terrain about 11 minutes with warm caches before the
survey heights came, `ipr_terrain.py praha` alone about 16 minutes now; `centrum`
under half a minute, `ujezd` seconds. After tonight's merges every chunk is worked
out again (the cache key covers all pipeline code), so expect the long end.

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
