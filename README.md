# Streets of Prague

A GTA 2-style top-down sandbox on the real, present-day Prague: every street,
building, tram line, parked car and hill comes from open data and is drawn
procedurally in three.js. No hand modelling, no textures, no AI imagery.

It started as the driving prototype inside `prague-game` (a Prague 1945 experiment)
and was split out with its history at `prague-game@c271397`.

```bash
npm install
npm run dev          # http://localhost:5191
```

The map data is built locally (see [Building the map](#building-the-map)); nothing
generated is committed. `?area=centrum` is the default, `?area=praha` the whole
city, `?area=ujezd` a small test area. `?night` fills the streets with night-time
parking, `?osm` shows OSM footprints instead of IPR's 3D buildings, `?dev` opens the
developer panel, `?start=lon,lat` starts somewhere else.

## Playing

- Tank controls on foot and in the car: W/S forwards and back, A/D turn, Shift
  runs, Space is the handbrake. E gets into the nearest car, including one driving
  past (its driver runs off). R puts the car back on the road. Scroll zooms; the
  camera also pulls up with speed.
- In the car, holding Shift is lane assist (`src/assist.js`): it steers along your
  lane, and A/D then pick the turn at the next junction instead of steering. It only
  works within the street's speed limit (OSM `maxspeed`, else 50 km/h in town, 70 on
  trunk roads, 80 on motorways): speed and it lets go; 5 km/h under the limit it's back.
- **Developer panel**: press <kbd>`</kbd> (or add `?dev`). Type a street for instant
  matches from the area's `names.json`, press Enter to look up a full address on
  OpenStreetMap's Nominatim, or pick a spot on an OpenStreetMap map; the game loads
  the tiles there and drops you on the pavement. "Copy link" gives a `?start=` link.

## How it works

- **Procedural look.** The ground is real geometry, one mesh per surface kind
  triangulated from OSM and coloured by world-space GLSL patterns (`src/shading.js`,
  `src/surface.js`): asphalt, granite setts, Prague mosaic pavement, slabs, grass,
  water. Rails, zebras, lane markings and parking-bay outlines are thin strips on top.
  Buildings get roof tiles laid down each face's slope, slate, gravel on flat roofs
  and windows by storey. It all stays sharp at any zoom.
- **Tiles.** The map streams in 250 m tiles (`src/tiles.js`) around the camera. Each
  tile has its own ground, buildings, trees, collision grid, parked cars and piece of
  the street graphs (joined across tiles by OSM node ids), so start-up doesn't depend
  on the area's size. Straight-skeleton roofs for OSM buildings are built in web
  workers (`src/roofWorker.js`).
- **Buildings** come from IPR Praha's open 3D model (CityGML LOD3: real roofs, towers
  and domes) wherever it covers the city, else from OSM footprints.
- **Terrain.** IPR's bare-earth model on a 4 m grid per tile: the ground, buildings,
  walls, trees, cars, people, trams and the camera sit at their real height, cars
  pitch, roll and roll downhill, and the ground is hill-shaded. The terrain model has
  no bridges, so each deck is raised to run between the heights of its two ends.
- **Life.** Arcade car physics against the 0.5 m collision grid (`src/car.js`); AI
  traffic that keeps to its lane, brakes for anything ahead and gives way to the right
  (`src/traffic.js`); pedestrians on the footpath network who dodge fast cars and get
  knocked over (`src/people.js`); three-section modern trams (`src/trams.js`). Traffic
  and people live within about 330 m of the player.
- **Parking** follows TSK Praha's paid-parking data: each street section gets spaces ×
  measured occupancy cars (day or night), placed in OSM's parking lanes and lots and
  then along the kerb (`src/parking.js`); bay lines are painted in the zone colour
  (blue resident, violet mixed, orange visitor).
- **Roads** are sized and marked from OSM `lanes`: dashed dividers, double centre
  lines on four lanes or more, edge lines on the main roads.

`src/map/` holds the map-building modules shared with the 1945 project it came
from (geometry helpers, straight-skeleton buildings, trees, tram routes).

## Known issues

- **Bridges and tunnels.** The height map holds one height per point, so a car driving
  under a flyover jumps up onto it. There are no tunnels at all (Blanka, Strahov).
- **Buildings at the edges.** IPR's 3D model covers only inner Prague; further out the
  buildings come from OSM, and where OSM has no height they are 13 m tall.
- **Parking doesn't fit.** About 30 % of the cars TSK counts don't fit into the
  narrow streets and are left out.
- **No angled parking.** A mapped parking area narrower than 4.5 m gets parallel
  parking and a wider one rows of perpendicular bays; nothing is parked at an angle,
  and OSM's `parking:*:orientation` tags aren't read. Areas 4.5–5.5 m wide, typical
  for angled parking, get no bays at all, so the kerbside fallback fills them with
  parallel cars. Streets without a mapped parking area are always parallel.
- **Trams** shuttle back and forth on stretches of track instead of running real
  lines, and at the end of a stretch their sections bunch up into each other.
- **Traffic** has no traffic lights; at junctions it only gives way to the right and
  steers around others. The lane assist sometimes clips a corner.

## Not yet in the game

- Something to do: missions (deliveries, taxi, courier), police and a wanted level.
- Visible damage on cars.
- Sound.
- Day and night (night-time parking data is already there, see `?night`).

## Building the map

Requirements: [uv](https://docs.astral.sh/uv/), Node.js, and for a local OSM extract
`brew install osmium-tool`.

```bash
cd pipeline
uv run build_parking.py centrum    # TSK paid-parking sections (read by build_tiles)
uv run build_tiles.py centrum      # today's map + street graphs in tiles → public/data/centrum_now/
uv run ipr_buildings.py centrum    # IPR's 3D buildings into the tiles
uv run ipr_terrain.py centrum      # IPR's terrain: heights, bridges, hill shading
```

Areas (`ujezd`, `centrum`, `praha`) are defined in `pipeline/osm_area.py`.

- **OSM.** With `pipeline/.cache/osm/czech-republic-latest.osm.pbf` from
  [Geofabrik](https://download.geofabrik.de/europe/czech-republic.html) (about 950 MB)
  the chunks are cut locally with osmium; the centre builds in under a minute, the
  whole city in about 20 minutes. Without it the pipeline asks Overpass (set
  `OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api` if overpass-api.de
  refuses). `build_tiles.py` works in 2 km chunks with a 150 m overlap, so buildings
  and streets on a chunk border come out whole.
- **IPR.** `ipr_buildings.py` and `ipr_terrain.py` download the SMO-5 sheets they need
  (2.5 × 2 km, about 150 MB each for buildings) into `pipeline/.cache/ipr/` from IPR's
  ArcGIS Online catalogue. Coordinates go S-JTSK → WGS84 with the Czech datum shift →
  local metres (going straight to the datum-less local projection puts everything
  ~25 m off); IPR wall bases then sit a median 0.55 m from OSM building edges.
- **Parking.** `build_parking.py` reads the monthly TSK occupancy GeoJSON collected by
  `~/projects/parkovani-praha` (set `PARKING_DATA` to point elsewhere).

Sizes: centrum is 234 tiles and about 36 MB; the whole city 13,609 tiles, 247k OSM
buildings and IPR buildings in 4,326 tiles, about 580 MB. The caches (OSM extract and
IPR sheets) are about 7.5 GB.

## Deploying

It runs at <https://streets.jonasjancarik.cz> from mbxp. `scripts/deploy-mbxp.sh`
builds the committed code, uploads it as a new release and syncs your local
`public/data/` to the server (only changed files go over), then restarts the
`streets-of-prague` container on `127.0.0.1:3017`. The Cloudflare tunnel
`urad-ai-poc` routes the hostname there.

## Credits

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- 3D buildings and terrain: datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model), CC BY.
- Paid-parking sections and occupancy: [TSK Praha](https://zps.tsk-praha.cz/).
- Roofs: [straight-skeleton](https://github.com/StrandedKitty/straight-skeleton) (MIT, wraps CGAL).
- Maps in the developer panel: [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles; address search by [Nominatim](https://nominatim.org/).
