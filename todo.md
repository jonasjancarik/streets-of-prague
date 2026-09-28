# To do

Possible next steps after the performance work of 27–28 September 2026 (the layered
pipeline, tiles built in workers, parked cars kept out of the per-frame work, gzipped
tile files). Rough order: quick wins first.

## Serving

- **Delete the old uncompressed tile files on mbxp.** The game now fetches
  `<tile>.<kind>.bin.gz`. The deploy never deletes anything, so the old `.ipr.bin`,
  `.height.bin` and `.bare.bin` files from before are still in
  `/home/jonas/deployments/streets-of-prague/shared/data/*/tiles/`. Nothing asks for
  them (a few hundred MB). Only delete `*.bin` files that have a `*.bin.gz` beside
  them, and check the site afterwards.
- **Cache the map data at Cloudflare's edge.** Cloudflare doesn't cache `.json` by
  default, so every tile JSON goes through the tunnel to mbxp; `.gz` files are
  cached (`cf-cache-status` shows MISS, then HIT). A Cache Rule for `/data/*` would
  cover the JSON too. The catch is that tiles change on every deploy under the same
  names, so either purge the cache from `scripts/deploy-mbxp.sh` after the sync, or
  keep the edge TTL short.
- **Favicon.** There is none, so every visit logs a 404 for `/favicon.ico`.
- **Clean up stale tiles locally too.** Tiles that drop out of an area (none in the
  index any more) keep their old files in `public/data/<area>_now/tiles/`, and the
  deploy copies them over. `layers.assemble` could remove tile files that aren't
  listed; it doesn't, to stay on the safe side.

## Game performance

Measured on an M5 MacBook Air in Chromium, plus Chrome's 4× CPU throttling to stand
in for a phone (60 fps standing, 57 driving, where it was 48 and 46). Worth
checking on a real phone before going further.

- **Ground overdraw.** Every ground layer is drawn without a depth test, over a
  full-tile mosaic base, so each pixel is shaded two or three times with the most
  expensive patterns. Drawing the opaque layers top-down with a stencil would shade
  each pixel once, but the see-through layers (soft shading at shores and round
  buildings, bridge shadows) have to stay in order on top, which makes it fiddly.
  Only worth it if a phone turns out to be held back by the GPU; the pixel ratio
  already steps down when frames are slow (`?dpr=1` to compare).
- **The street graphs only grow.** The drive and walk graphs, street names and the
  crowd's index keep the edges of every tile ever loaded, so memory grows over a
  long session across the city. The police's route search runs over the graph,
  including tiles that have been dropped, so shrinking it needs care.
- **What's left on the main thread** (in order, standing on the Old Town Square):
  the collision hash's generators (`SpatialHash.near` and `obstacles` in
  `src/main.js`), placing people (`Crowd.place` allocates a point per person per
  step), and the trams, all ~300 of them updated every step even far away (they
  already move in bigger steps when far).
- **A benchmark in the repo.** The measurements were made with a throwaway
  Playwright script (load at the Old Town Square, stand, drive east; frame times,
  long tasks, CPU profile, draw calls). Worth keeping as `scripts/bench.mjs` to
  compare changes against.

## Pipeline

- **The ground layer's own cost.** With the OSM parsed and cached, a ground rebuild
  is almost all `osm_area.extract`: merging the street surfaces, the kerbs and the
  gardens (about 5 s for a dense suburban chunk). The gardens could become a layer
  of their own, rebuilt only when the buildings or the gardens rule change.
- **Assembly for the whole city takes about 16 s**, reading all four chunked layers
  and comparing every tile. It could put together only the chunks whose layers
  changed.
- **The caches take about 2.5 GB** in `pipeline/.cache` (parsed OSM chunks, parsed
  IPR sheets, layers), on top of the OSM extract and the IPR sheets. Stale ones
  (after a new OSM extract, say) are replaced as they're rebuilt but never removed.

## Gameplay and look

Noted on 28 September 2026 while playing, during the TypeScript refactor.

- **Vehicle collisions.** You can walk under a tram, trams drive over cars, and at
  one point the player walked straight through the middle of a parked car. Trams,
  moving cars and parked cars should all block the player and each other.
- **Trams turn in sharp steps.** On curves they snap from one heading to the next
  in visible increments instead of turning smoothly along the track.
- **Parking zone markings.** The blue line should run only along the street side of
  a bay, plus short lines perpendicular to the pavement where the zone starts and
  ends; there's no line along the pavement. Purple and orange zones are marked with
  white dashed lines instead of blue (confusing, but that's how Prague does it).
- **Zebra crossings.** They should start and end where they meet the pavement, and
  run mostly perpendicular to it where the geometry allows, instead of stopping
  short or overshooting. The stripes also have uneven gaps now (one gap noticeably
  wider than the rest).
- **Place names on screen.** Drop the large pop-up for street names; the street is
  already shown top left next to the speed, and that's enough. Keep the big title
  for entering a new neighbourhood or district.
