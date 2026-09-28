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
  `src/main.ts`), placing people (`Crowd.place` allocates a point per person per
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

## Terrain

- **Straight elevation break at tile edges (likely cause found).** A dead-straight
  north–south line near Jeremenkova cuts across roads, pavement and grass, with the
  ground slightly lighter and offset on one side; a similar faint east–west line
  shows up elsewhere. Probable cause, from the code (untested): a tile is 250 m but
  its height grid covers only 248 m (62 steps of 4 m, `N = int(T // STEP)` in
  `ipr_terrain.py`), and the game holds the last height for the final 2 m. On top of
  that, a tile's first grid row is found with `round(i * 62.5)`, so every other tile's
  heights sit up to 2 m off its real edge. On a 10 % slope that's a 20 cm step at the
  seam. The hill shading (`relief()` in `src/tiles.ts`) also works out the slope at
  the tile's edge from the tile's own clamped values, not the neighbour's, so it
  flattens there. Fix in the pipeline: a height grid that lines up with the tile
  edges (e.g. a step that divides 250 m, or one shared row between neighbours), and
  shading that takes the edge slope from the neighbouring tile.
- **Finer terrain.** IPR's terrain model has points about 10 m apart, so
  embankments, retaining walls, cuttings and steps are smoothed away (most visible
  along the river and railways). A finer bare-earth model would fix it; ČÚZK's
  DMR 5G (2 m grid) may be open (unchecked). IPR's 1 m surface model won't do: it
  includes buildings and trees.
- **Hill shading for a moving sun.** The shading is baked per tile to the fixed
  north-west sun (`relief()` in `src/tiles.ts`, `SUN_OFFSET` in `src/main.ts`). If
  the sun ever moves with the clock, store the slope per tile instead and light it in
  the ground shader.
- **Hills casting shadows.** The terrain doesn't throw shadows, so a hill never
  puts a valley in shade. Hardly noticeable with the current midday sun; worth doing
  with a low evening sun.

## Gameplay and look

Noted on 28 September 2026 while playing, during the TypeScript refactor.

- **Traffic squeezes through parked cars.** In narrow streets some parked cars stick
  a metre or so into the traffic lane. A car stuck behind one for a few seconds
  drives on through it (it no longer does that to the car ahead in its lane or to a
  tram). It could steer round it instead, or parking could keep clear of the lanes.
- **Police cars drive over the parking lane.** Chasing you on foot, a police car
  heads straight for you, across parked cars. It could stop on the road and let
  the officer run the rest of the way.
- **Bike theft leaves no rider behind.** When you take a bike from someone riding
  it, the original rider doesn't appear running away (or at least isn't visible).
  They should be knocked off or step off and run away.
- **Climb over cars by jumping.** Jumping into a car should let the player scramble
  over it (bonnet or roof) to the other side instead of being blocked.
- **Steal an empty police car.** When the officers have left a police car, the
  player should be able to get in and drive it away.
- **Skid marks.** Hard braking and sliding turns could leave tyre marks on the road
  that fade out over time.
- **Trees in residential areas.** The grass between houses has almost no trees,
  which looks bare. Gardens and courtyards could get some scattered trees and
  shrubs.
- **Taxis.** Let the player hail a taxi in the street or order one through a
  ride-hailing app. The apps stand in for Uber and Bolt under made-up names, and
  their drivers are more reckless than regular street taxis.
- **Buses.** Add city buses running their routes, painted in the new PID livery.
- **Boats on the Vltava.** The river is empty. It could have pedal boats (rented at
  Slovanský ostrov and round the islands, some shaped like swans or old cars),
  tourist cruise boats moored along Náplavka and sailing up and down, and the PID
  ferries crossing at their fixed points. The player could rent a pedal boat, or
  jump onto a moored boat. The water is only a ground layer for now (`areas.water`
  in the tiles), so the boats would need it as the area they can move in, and
  bridges and weirs as things to stop at or pass under.
- **Motorbike rider sunk into the ground.** Came across a motorbike with its rider
  stuck partly in the road surface, not moving. Probably a height that isn't
  following the terrain (unchecked); could be related to the terrain elevation issues.
- **Building bridge over Svornosti blocks the player.** A covered walkway joins
  two buildings above the street. NPC cars drive under it, but the player can't:
  the walkway seems to block the player as if it were a building on the ground.
  Probably needs a targeted fix for this spot.
- **Fill the plain beige areas.** Fields, work yards, railway land and building sites
  now have surfaces of their own (from OSM land use). What's left is unmapped ground
  in town: yards, verges, car parks on bare earth. The prototype
  (`pipeline/ground_cover.py`, `?cover=rules` in the game) classifies IPR's 2024
  orthophoto and 2025 surface model into grass, trees, dirt, gravel, asphalt and "not
  ground"; tried on 49 tiles round Smíchov. Still to do: run it for the whole city (a
  16–65 GB photo download), and fold it into the build.
  About a third of the beige pieces in town are roofs or site clutter and some are
  roadway the streets don't reach: gaps in the map data rather than missing ground.
- **Painted photo, with stronger filters.** `ground_cover.py ortho` (`?ortho` in the
  game) paints the orthophoto through an anisotropic Kuwahara filter; at 0.5 m/px it
  still looked like a blurry photograph. To try: a bigger, more stretched brush;
  fewer colours (the game's own ground palette); 1–2 m/px; evening out the photo's
  own shadows; darker edges; and painting each tile with a margin from its
  neighbours so the tiles don't show seams.
- **Parking zone markings.** The blue line should run only along the street side of
  a bay, plus short lines perpendicular to the pavement where the zone starts and
  ends; there's no line along the pavement. Purple and orange zones are marked with
  white dashed lines instead of blue (confusing, but that's how Prague does it).
- **Place names on screen.** Drop the large pop-up for street names; the street is
  already shown top left next to the speed, and that's enough. Keep the big title
  for entering a new neighbourhood or district.
