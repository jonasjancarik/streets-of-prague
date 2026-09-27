# Praha 1945 · Újezd

An experiment: a stylised, strictly top-down 3D view of Prague in May 1945, built
in three.js from OpenStreetMap and checked against the 1945 Allied aerial survey.
It has two modes on the same map:

- **Courier** (`/`): walk a message across Most Legií on the first day of the uprising.
- **Barricades** (`/?mode=barricades`): German columns try to get through to
  Smíchov; you barricade streets and they re-route around what they can see.

```bash
npm install
npm run dev          # http://localhost:5190
```

Courier controls: WASD/arrows walk, Shift runs, scroll zooms, R restarts.
Barricade controls: click a street to build (15 s), right-click to take it down,
drag or WASD to pan, scroll to zoom, Space pauses, G hides the drivable streets.
In both: keys 1–4 swap the ground between the painted map and the 1945, 1938 and
2012 aerial photos, 5 shows the AI-painted test tile, B hides buildings, F gives
an old-film look, O switches to a flat (orthographic) map view.

## Driving prototype (`drive.html`)

A separate, present-day experiment: a GTA 2-style top-down sandbox covering
Prague's historic centre (Hradčany and Malá Strana to Vinohrady, about 4.3 × 3 km).
Open `http://localhost:5190/drive.html` (`?area=<name>` for another tiled area,
`?night` for night-time parking).

- Tank controls on foot and in the car: W/S forwards and back, A/D turn, Shift
  runs, Space is the handbrake. E gets into the nearest car, including one driving
  past (its driver runs off). R puts the car back on the road.
- **Everything is procedural, no textures or AI imagery.** The ground is real
  geometry, one mesh per surface kind triangulated from OSM, coloured by world-space
  GLSL patterns (`shading.js`, `surface.js`): asphalt, granite setts, Prague mosaic
  pavement, slabs, grass, water. Rails, zebras, centre lines and bay outlines are
  thin strips on top. Buildings get roof tiles laid down each face's slope, slate,
  gravel on flat roofs and windows by storey. All of it stays sharp at any zoom.
- **The map streams in 250 m tiles** (`tiles.js`), loaded around the camera and
  dropped behind it. Each tile has its own ground, buildings, trees, collision grid
  and parked cars; straight-skeleton roofs are built in web workers
  (`roofWorker.js`). Traffic and pedestrians live within about 330 m of the player.
- Data, per area (`centrum` and `ujezd` are defined in `build_area.py`):

  ```bash
  cd pipeline
  uv run build_parking.py centrum    # TSK paid-parking sections (read by build_tiles)
  uv run build_tiles.py centrum      # today's map + street graphs in tiles → centrum_now/
  uv run ipr_buildings.py centrum    # IPR's real 3D buildings into the tiles
  uv run ipr_terrain.py centrum      # IPR's terrain → hill shading per tile
  ```

  `build_tiles.py` works in 2 km chunks (with a 150 m overlap so buildings and
  streets on a chunk border come out whole), using `build_area.py`'s present-day
  mode (no 1945 filter, car parks kept, asphalt vs setts from OSM `surface`, zebra
  crossings). Each tile also carries its car and pedestrian network edges, keyed by
  OSM node ids, and its paid-parking sections, so the game only ever loads what is
  around the player; nothing about the area is loaded up front apart from the
  tram rails. With a local OSM extract (`pipeline/.cache/osm/czech-republic-latest.osm.pbf`
  from [Geofabrik](https://download.geofabrik.de/europe/czech-republic.html), about
  950 MB, plus `brew install osmium-tool`) the chunks are cut locally and the centre
  builds in under a minute; without it the pipeline asks Overpass (set
  `OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api` if overpass-api.de
  refuses).
- **The whole city** is the area `praha` (its bounding box, 34 × 26 km). Its data is
  too big for git and is ignored; build it with the same four commands and open
  `drive.html?area=praha`. The IPR step downloads every sheet it needs (about 150 MB
  each) on the first run.
- **Buildings come from IPR Praha's open 3D model** (CityGML LOD3, real roofs,
  towers and domes) where the area has it (`ipr_buildings.py`; `?osm` in the URL
  shows the OSM footprints extruded instead). Sheets are downloaded once into
  `pipeline/.cache/ipr/` (about 150 MB each). Coordinates go S-JTSK → WGS84 with the
  Czech datum shift → local metres; IPR wall bases then sit a median 0.55 m from OSM
  building edges.
- **Terrain** (`ipr_terrain.py`, IPR's bare-earth model on a 4 m grid per tile): the
  ground, buildings, walls, trees, cars, people, trams and the camera all sit at
  their real height, cars pitch and roll with the slope and roll downhill, and the
  ground is hill-shaded. The terrain model has no bridges, so each deck is raised to
  run between the heights of its two ends.
- `src/drive/`: arcade car physics against the 0.5 m collision grid, tree trunks
  included (`car.js`); AI traffic that keeps to the right lane, brakes for anything
  ahead and gives way to the right (`traffic.js`); pedestrians on the footpath
  network who dodge fast cars and get knocked over (`people.js`); three-section
  modern trams (`trams.js`). Roads are sized and marked from OSM `lanes`: lane
  dividers, double centre lines on four lanes or more, edge lines on the main roads.
- Parked cars follow TSK Praha's paid-parking data (`build_parking.py` reads the
  monthly occupancy GeoJSON from `~/projects/parkovani-praha`, or `PARKING_DATA`).
  Each street section gets spaces × measured occupancy cars, by day or with `?night`,
  placed in OSM's mapped parking lanes and lots first and then along the kerb
  (`parking.js`); bay lines are painted in the zone colour (blue resident, violet
  mixed, orange visitor). Cars are drawn as instances.
- The camera pulls up with speed.
- **Developer panel**: press <kbd>`</kbd> (or add `?dev`). Type a street for instant
  matches from the area's `names.json`, press Enter to look up a full address on
  OpenStreetMap's Nominatim, or pick a spot on an OpenStreetMap map; the game loads
  the tiles there and drops you on the pavement. "Copy link" gives a `?start=lon,lat`
  link to the spot.

## How it is built

The full step-by-step record of how the Újezd level was made, and how to build
another area, is in [docs/level-creation.md](docs/level-creation.md).

`pipeline/build_area.py` (uv) does the data work for one bbox:

1. **OSM via osmnx** → buildings, land use, water, roads (buffered to real widths),
   tram and funicular rails, walls, trees and weirs, projected to local metres.
2. **1945 filter.** Buildings are dropped if they are on a verified post-1945 list
   or carry a year-only `start_date` after 1945.
3. **Historical orthophotos** from IPR Praha's archive WMS
   (`gs-pub.praha.eu/.../ortofotomapa_archiv`: layer 205 = 1945, 209 = 1938,
   117 = 2012 TrueOrto), saved at ~0.3 m/px for the same bbox.

`pipeline/review_1945.py` makes a contact sheet of flagged buildings on the 1945
and 2012 photos, for deciding what goes on the post-1945 list.
`pipeline/ai_tile.py` prepares the inputs for an AI-painted tile, checks the
result against the OSM footprints, and installs it as layer 5.

`pipeline/build_streets.py` exports the drivable street graph for the same bbox
(`public/data/<area>_streets.json`): junctions as nodes, streets as edges with their
polylines, cut at the bbox edge into `border` nodes where columns enter and leave.
Footways, paths, steps and service alleys are left out; pedestrian zones and living
streets stay in, since they were ordinary streets in 1945.

In the browser (`src/`), `world.js` builds the shared city and `courier.js` and
`barricades/` are the two modes:

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
building walls lean outwards at the screen edges (GTA 2 style). O swaps in an
orthographic camera with the same framing.

### Barricade mode (`src/barricades/`)

- `graph.js`: the street graph, Dijkstra towards a set of exit nodes, and snapping
  a click to the nearest street. Most Legií is the only bridge inside the map, so
  Jiráskův and Mánesův most are added as **off-map links** between border nodes.
  Without them a single barricade on the bridge would decide the game.
- `column.js`: a German column is a lead vehicle plus followers that drive along the
  leader's trail, keeping to the right. The leader plans on **what the column knows**:
  it learns about a finished barricade when it has line of sight to it (110 m,
  raycast against building footprints) or runs into it. It then re-plans. That can
  mean a U-turn, a different street, or forcing its way through: a Hetzer clears a
  barricade in 40 s, infantry from trucks in 110 s, and a tipped-over tram takes 1.6×
  as long. Half-built barricades are scattered by passing columns.
- `mode.js`: three reported columns (from Národní, Myslíkova and Anenská), 8
  barricades, the side panel, the report log and the score. The score is each
  column's delay compared with its route through an empty city. On a street drawn as
  two parallel carriageways in OSM, one barricade cuts both.
- `models.js`: Hetzer (built in Prague by ČKD/BMM), Sd.Kfz. 251, Opel Blitz, a
  paving-stone barricade and a tram on its side.

`window.__game.advance(seconds)` fast-forwards the simulation, which is handy for
checking a barricade layout without waiting.

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

**Barricades as edges in the street graph work as a mechanic.** Columns visibly
change their plans ("spotted the barricade on Janáčkovo nábřeží and is going
another way, via Vítězná"). The city grid has so much redundancy, though, that a
single barricade in the middle of a block costs a column only 20–40 s. What
matters are the chokepoints (the bridge, the embankments) and barricades placed
round a corner, where a column only sees them once it has committed to the street.
Because a broken barricade stays open for everyone behind, the interesting decision
is when and where to rebuild while the columns are on the move. Simulated layouts:
no barricades 0 s, one on the bridge 1 min, bridge + embankment about 5 min, all
eight about 6.5 min.

## Possible next steps

- Petřín terrain from a DEM (it's a ~130 m hill; currently flat, with no hillshade).
- Trace demolished 1945 buildings from the photo into a small GeoJSON overlay.
- Barricade mode: defenders and anti-tank weapons at barricades (so holding one
  costs the Germans more than time), limited builders instead of a global build
  timer, telephone reports that arrive late or are wrong, and columns sharing
  what they have seen over the radio.
- Split the ground into tiles for larger areas and sharper close-ups.
- Driving: about 550 of the cars TSK's data puts on Újezd by day have nowhere to
  go, mostly in narrow two-way Malá Strana streets with no mapped parking lane.
  Try tighter kerb spacing, half-on-the-pavement parking where the street is too
  narrow, and parking on one side of two-way streets.

## Credits

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- Aerial photos 1938, 1945 and 2012: datový podklad ©
  [IPR Praha](https://geoportalpraha.cz/en/data-and-services/open-data), CC BY.
- Paid-parking sections and occupancy: [TSK Praha](https://zps.tsk-praha.cz/).
- 3D buildings and terrain (driving game): datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model), CC BY.
- Roofs: [straight-skeleton](https://github.com/StrandedKitty/straight-skeleton) (MIT, wraps CGAL).
- The layer 5 tile was painted with AI image generation (Codex).
