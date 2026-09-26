# Praha 1945 · Újezd

An experiment: a stylised, strictly top-down 3D view of Prague in May 1945, built
in three.js from OpenStreetMap and checked against the 1945 Allied aerial survey.
You play a courier crossing Most Legií during the first day of the uprising.

```bash
npm install
npm run dev          # http://localhost:5190
```

Controls: WASD/arrows walk, Shift runs, scroll zooms. Keys 1–4 swap the ground
between the painted map and the 1945, 1938 and 2012 aerial photos; 5 shows the
AI-painted test tile. B hides
buildings, F gives an old-film look, R restarts.

## How it is built

`pipeline/build_area.py` (uv) does the data work for one bbox:

1. **OSM via osmnx** → buildings, land use, water, roads (buffered to real widths),
   tram and funicular rails, walls, trees and weirs, projected to local metres.
2. **1945 filter.** Buildings are dropped if they are on a verified post-1945 list
   or carry a year-only `start_date` after 1945.
3. **Historical orthophotos** from IPR Praha's archive WMS
   (`gs-pub.praha.eu/.../ortofotomapa_archiv`: layer 205 = 1945, 209 = 1938,
   117 = 2012 TrueOrto), saved at ~0.3 m/px for the same bbox.

In the browser (`src/`):

- `ground.js` paints the whole area onto one 4096 px canvas: speckled grass,
  cobbles, water with current bands, weir foam, tram rails and blurred contact
  shadows under buildings. A world-scale detail texture adds grain at close zoom.
- `buildings.js` extrudes walls, darkened towards the ground, and builds roofs from
  a **straight skeleton** (`straight-skeleton`, CGAL compiled to WASM). That gives
  proper hipped roofs on any footprint, courtyards included. Four-corner houses
  get gable ends. Terracotta, slate and copper colours are picked per building.
- `vegetation.js` scatters instanced trees from a 1 m land-use raster
  (woodland, parks, orchard rows).
- `transit.js` stitches OSM's fragmented tram ways into long chains and runs
  trams and the Petřín funicular along them.
- `player.js` handles movement against a 0.5 m walkability grid. Only the largest
  connected region counts as walkable, so closed courtyards never trap a spawn point.

The camera is a perspective camera pointing straight down with north up, so
building walls lean outwards at the screen edges (GTA 2 style).

## Findings

**The 1945 orthophoto is the key resource.** IPR's 1945 layer is sharp and lines
up with OSM to within a few metres. It works as a reference layer in the game
(key 2) and is how the 1945 filter was checked.

**OSM `start_date` is unreliable for Prague.** Buildings imported from RÚIAN carry
full dates such as `1975-10-08`, which are cadastre record dates. Of 14 flagged
buildings, 7 existed in 1945 (Klementinum is tagged `1995`). The pipeline now only
trusts year-only dates, plus a hand-verified list. Buildings that stood in 1945 but
were demolished later (e.g. the houses where Nová scéna now stands) are not in OSM
at all; they would have to be traced from the 1945 photo.

**AI restyling** (Codex image generation, one 300 m tile around the Újezd junction;
inputs, briefs and results are in `docs/ai-restyle/`):

- *Photo only:* a beautiful painted tile, and block layout and framing survive. The
  model misreads the scene, though: shadowed park became a canal and a pond,
  and trams became boats.
- *OSM layout map + photo:* passing a flat colour-coded OSM render as "layout
  ground truth" and the 1945 photo as "detail reference" fixes the semantics.
  Painted roofs then register to within about 1–2 m of the OSM footprints
  (`overlay-osm-guided.jpg`).
- In the game (key **5**) that tile is feathered into the painted ground and
  draped top-down over the 3D roofs. At gameplay zoom it looks much richer than the
  procedural paint. Remaining issues: visible seams at the tile edge, painted ridges
  that don't always match the geometric ones, and doubled trees (painted plus 3D).

Scaling that up is feasible. Render the OSM layout map for overlapping tiles,
generate each one with the same brief, then blend the overlaps. Style drift
between tiles and the per-tile generation time are the costs to watch.
Geometry, collision and semantics should stay procedural from OSM either way.

## Possible next steps

- Petřín terrain from a DEM (it's a ~130 m hill; currently flat, with no hillshade).
- Trace demolished 1945 buildings from the photo into a small GeoJSON overlay.
- Barricades, period vehicles and NPCs from the Prague uprising.
- Split the ground into tiles for larger areas and sharper close-ups.
