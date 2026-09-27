# Streets of Prague

A GTA 2-style top-down sandbox on the real, present-day Prague: every street,
building, tram line, parked car and hill comes from open data and is drawn
procedurally in three.js. No hand modelling; the only images are one small set of
facade parts (windows, doors, shopfronts) that every wall in the city is put together
from.

It started as the driving prototype inside `prague-game` (a Prague 1945 experiment)
and was split out with its history at `prague-game@c271397`.

```bash
npm install
npm run dev          # http://localhost:5191
```

The map data is built locally (see [Building the map](#building-the-map)); nothing
generated is committed. The whole city (`?area=praha`) is the default, `?area=centrum`
the historic centre and `?area=ujezd` a small test area. The game's clock starts at the time in Prague
now; `?time=HH:MM` and `?day=mon…sun` start it elsewhere, and `?night` at half past one
(with night-time parking). `?osm` shows OSM footprints instead of IPR's 3D buildings, `?dev` opens the
developer panel, `?touch` shows the touch controls on a desktop, `?start=lon,lat` starts somewhere else.

## Playing

- Tank controls on foot and in the car: W/S forwards and back, A/D turn, Shift
  runs, Space is the handbrake. E gets into the nearest car, including one driving
  past (its driver runs off). R puts the car back on the road. Scroll zooms; the
  camera also pulls up with speed.
- In the car, holding Shift is lane assist (`src/assist.js`): it steers along your
  lane, and A/D then pick the turn at the next junction instead of steering. It only
  works within the street's speed limit (OSM `maxspeed`, else 50 km/h in town, 70 on
  trunk roads, 80 on motorways): speed and it lets go; 5 km/h under the limit it's back.
- **Metro**: the M signs are the real entrances. Press E at one to go down, pick a
  station on any line (W/S, A/D for the line, E to go, or tap), and the ride plays out
  on the line's map: the wait for a train, the stations going by, a change of line
  where you need one, with the clock moving on by the real times (`src/metro.js`).
  You come up at an entrance of that station, and the police have lost you. After
  midnight the metro is shut until about five.
- **Tram stops**: stand at one and the HUD lists the next trams due, counting down
  (`src/board.js`). Hold Space (on touch, "Hold to wait") to fast-forward until one is
  about to arrive.
- **Trams**: press E next to a tram waiting at a stop to get on (`src/ride.js`). The
  panel lists the stops ahead. Pick one with W/S (or tap it) and the ride runs at 6×,
  stops on the way included, until about 250 m before your stop; then you watch the
  tram pull in and you get off. Hold Shift (on touch, "Hold to speed up") to speed up
  at any time. E while it's moving gets you off at the next stop. Sped up, the whole
  world runs faster, in short steps so the physics holds; it slows down again while
  the streets ahead are still loading. The police can't arrest you on a tram, and
  your stars fade twice as fast.
- **On a phone or tablet** on-screen controls appear (add `?touch` to get them on a
  desktop). The left thumb has a round stick: on foot, push it the way you want to go
  and you walk there (a full push runs); in the car, push it sideways to steer. Put
  your thumb down away from the stick and the stick moves under it. In the car the
  right thumb has the gas and brake (roll from one to the other without lifting), the
  handbrake, lane assist (a toggle here) and "Get out"; "Back on road" is top right.
  Pinch the map to zoom (`src/touch.js`).
- **Police.** Knocking people over, pulling drivers out of their cars, wrecking
  traffic, ramming or stealing a police car and speeding past the police (20 km/h over
  the limit) earn stars, up to five; crimes the police see count three times as much.
  Police cars chase you along the streets and ram you; when you're on foot or stopped,
  an officer gets out and runs after you, and if they reach you, you're busted (the
  police keep the car). You can outrun them on foot. From three stars a helicopter
  joins in and sees you over the rooftops. Stay out of sight and the stars go one at a
  time; they blink while nobody can see you (`src/police.js`, `src/helicopter.js`).
- **Developer panel**: press <kbd>`</kbd> (or add `?dev`). Type a street for instant
  matches from the area's `names.json`, press Enter to look up a full address on
  OpenStreetMap's Nominatim, or pick a spot on an OpenStreetMap map; the game loads
  the tiles there and drops you on the pavement. "Copy link" gives a `?start=` link.
  "Helicopter next to me" parks one on the nearest open ground: E gets in, W/S fly,
  A/D turn, Space climbs, Shift comes down. Below 30 m the buildings are in the way;
  land on open ground to get out.

## How it works

- **Procedural look.** The ground is real geometry, one mesh per surface kind
  triangulated from OSM and coloured by world-space GLSL patterns (`src/shading.js`,
  `src/surface.js`): asphalt, granite setts, Prague mosaic pavement, slabs, grass,
  water. Rails, zebras, lane markings and parking-bay outlines are thin strips on top.
  OSM rarely maps the gardens and lawns in a suburb or a housing estate, so a street
  block of family houses, or of flats with plenty of room round them, gets grass
  between the buildings (`_gardens` in `pipeline/osm_area.py`); denser inner-city
  blocks, shops, offices and schools stay paved. Buildings get roof tiles laid down
  each face's slope, slate and gravel on flat roofs. It all stays sharp at any zoom.
- **Facades** are put together bay by bay and storey by storey from 48 parts: windows,
  doors, gateways and shopfronts of tenements, baroque houses, functionalist blocks,
  panel housing and family houses (`src/facades.js`). A wall's style comes from where
  it stands and how tall it is: baroque in Old Town, Malá Strana and Hradčany, panel
  housing for tall blocks far out, family houses under about 8 m, tenements with some
  functionalism elsewhere. The plaster takes the building's own colour. The parts were
  drawn by an image model as four sheets, each asked for with the first sheet as a
  style reference, and are cut and packed by `assets/facades/build_atlas.py`.
- **Tiles.** The map streams in 250 m tiles (`src/tiles.js`) around the camera. Each
  tile has its own ground, buildings, trees, collision grid, parked cars and piece of
  the street graphs (joined across tiles by OSM node ids), so start-up doesn't depend
  on the area's size. Straight-skeleton roofs for OSM buildings are built in web
  workers (`src/roofWorker.js`).
- **Buildings** come from IPR Praha's open 3D model (CityGML LOD3: real roofs, towers
  and domes), which covers the whole city. OSM buildings that the model doesn't have
  (newer ones, sheds, anything past the city limits) are extruded from their footprints.
- **Terrain.** IPR's bare-earth model on a 4 m grid per tile: the ground, buildings,
  walls, trees, cars, people, trams and the camera sit at their real height, cars
  pitch, roll and roll downhill, and the ground is hill-shaded. The terrain model has
  no bridges, so each deck is raised to run between the heights of its two ends.
- **Life.** Arcade car physics against the 0.5 m collision grid (`src/car.js`); AI
  traffic that keeps to its lane, brakes for anything ahead and gives way to the right
  (`src/traffic.js`); pedestrians on the footpath network who leap out of the way of
  fast cars and get knocked over, then get up again (`src/people.js`). Traffic and
  people live within about 330 m of the player.
- **Crowds.** The busier the streets around you, the more people: 500 to 600 round the
  Old Town Square and on Charles Bridge, a couple of hundred in Vinohrady or on a
  housing estate, a few dozen on the edge of town. They come and go out of sight as
  you move, turn up more often on the busier streets and, at a junction, lean towards
  the busier way. How busy a street is comes from a footfall map
  (`pipeline/build_footfall.py`, `src/footfall.js`). There's no open data on where
  people walk, so it's pieced together from what draws them: OSM's shops, cafés,
  sights, schools and pedestrian streets, how many buses, trams, trains and metro
  trains leave each stop on a weekday, and a short hand-made list of the places
  tourists crowd.
- **Bikes and motorbikes.** Cyclists and motorcyclists ride with the traffic, and bikes
  and motorbikes stand on the pavements around you: E gets you on one, and it leans
  into the turns. Hit something hard and you're thrown off. On foot, Space jumps (not
  at a tram stop, where it waits for a tram); in the air, a car can't knock you over.
- **People and two-wheelers** are a small kit built in Blender from code
  (`assets/figures/build.py` → `public/figures.glb`): a low-poly person with a skeleton
  and clips for standing, walking, running, jumping, falling, getting up and riding,
  plus a bike and a motorbike. At load, `src/figures.js` plays every clip through and
  bakes the posed vertices into textures, so the whole crowd is one instanced draw
  call. Rebuild with `blender -b --factory-startup -P assets/figures/build.py`; add
  `-- --preview DIR` to render a few frames of every clip.
- **Trams** run Prague's real lines (`src/trams.js`), taken from OSM's route
  relations: each line goes round its whole route there and back. How many trams a line
  has out follows PID's timetable for the game clock's day and hour (`src/clock.js`):
  a tram every few minutes on a weekday afternoon, fewer at weekends and in the
  evening, and only the night lines 91–99 after midnight. Trams join a line where the
  gap is widest and leave service out of sight; the dev panel moves the clock an hour
  either way. The departure boards count down from where the trams really are, so a
  tram held up in traffic shows up late there too. They stop at
  every stop, keep to the track's speed limit, slow down for curves and brake for the
  tram in front and for anything on the track. Three-section 15T-like cars with the
  line number on the roof in the line's colour. They run all over the city at once, so
  they come into view on their own timetable; only the ones near the camera are drawn.
- **Police** patrol with the traffic. Chasing cars find their way with an A* search over
  the street graph (both ways along every street) and drive it with the same physics as
  your car; within 40 m and in sight they head straight for you. What the police see
  is checked with rays over the collision grid; the helicopter needs no line of sight.
- **Parking** follows TSK Praha's paid-parking data: each street section gets spaces ×
  measured occupancy cars (day or night), placed in OSM's parking lanes and lots and
  then along the kerb (`src/parking.js`); bay lines are painted in the zone colour
  (blue resident, violet mixed, orange visitor). Cars stand parallel, angled or
  perpendicular as OSM tags each parking area (`orientation`) and each side of the
  street (`parking:<side>:orientation`, or the older `parking:lane:<side>`); where it
  doesn't say, an area under 4.5 m wide is parallel, up to 5.6 m angled and wider
  perpendicular. Angled bays slant forwards along the lane beside them, so cars nose
  in. Sides tagged as having no parking (or parking mapped separately) get
  no kerbside cars. Underground, multi-storey and rooftop car parks stay empty.
- **Roads** are sized and marked from OSM `lanes`: dashed dividers, double centre
  lines on four lanes or more, edge lines on the main roads. The asphalt reaches out
  to each kerb on its own (`pipeline/kerbs.py`): past the lanes to take in a tram
  track running in the street and a tagged parking lane, and where the pavement is
  mapped as its own way beside the street, up to that pavement's inner edge. Parked
  cars stand along that kerb.
- **Passages through buildings** (OSM `tunnel=building_passage`: gateways, arcades,
  Prague's pasáže) are cut out of the buildings' collision footprint and stay in the
  street graphs, so cars, traffic and people go through. While you're in one, a round
  hole opens in the floors above you so you can still see yourself (`CUTAWAY` in
  `src/shading.js`).

`src/map/` holds the map-building modules shared with the 1945 project it came
from (geometry helpers, straight-skeleton buildings, trees, the Petřín funicular).

## Known issues

- **Bridges and tunnels.** The height map holds one height per point, so a car driving
  under a flyover jumps up onto it. There are no tunnels at all (Blanka, Strahov); only
  passages through buildings at street level can be driven and walked through.
- **Past the city limits** the buildings come from OSM, and where OSM gives neither a
  height nor a number of storeys, the height is a guess from the kind of building and
  the size of its footprint (sheds, cottages, one- or two-storey houses, halls). The
  terrain there carries on flat at the height of the nearest ground IPR has.
- **Parking doesn't fit.** About 30 % of the cars TSK counts don't fit into the
  narrow streets and are left out.
- **Angled and perpendicular parking along the kerb** stands just outside the
  carriageway, since OSM street widths usually leave it out. Where the pavement there
  is narrow, the cars end up on it; where a building is in the way, they're left out.
  Inside car parks, away from any street, angled bays slant an arbitrary way.
- **Tram termini without a loop.** Where the map has no way to turn round at the
  end of a line (5 and 6 at Nádraží Holešovice, 13 at Zvonařka, 17 at Libuš, 19 at
  Pankrác), the tram reverses where the track allows it, or waits until it's off
  screen and reappears on the other track. The timetables set how often each line runs,
  not the departures themselves, and they come from one typical weekday, Saturday and
  Sunday (public holidays run as normal days). Lines 32 and 40 have no track on the
  map, and the historic lines 41 and 42 are left out. In the smaller areas
  (`centrum`, `ujezd`) the lines carry on past the edge of the map, and so does a tram
  you're riding.
- **Traffic** has no traffic lights; at junctions it only gives way to the right and
  steers around others. The lane assist sometimes clips a corner.

## Not yet in the game

- Something to do: missions (deliveries, taxi, courier).
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
uv run build_lines.py centrum      # tram lines from OSM's route relations → lines.json
uv run build_metro.py centrum      # the metro from PID's timetables → metro.json
uv run build_footfall.py centrum   # how busy the streets are → footfall.png
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
  ArcGIS Online catalogue. Sheets come in blocks of 10 × 10 named after a town, and the
  city spills over from Praha (`Prah`) into Beroun (`Bero`), Kladno (`Klad`), Kralupy
  (`Krav`) and Český Brod (`Cbro`); the pipeline reads all five. Coordinates go S-JTSK → WGS84 with the Czech datum shift →
  local metres (going straight to the datum-less local projection puts everything
  ~25 m off); IPR wall bases then sit a median 0.55 m from OSM building edges.
- **Tram lines.** `build_lines.py` takes every tram line's two route relations (one
  per direction) and joins them into a loop along the track network, stops and speed
  limits included; it prints any line or direction it can't follow. Lines stay whole
  where they leave the area. With the local extract it takes about 10 seconds. It also
  adds how often each line runs, hour by hour, from PID's timetables:
  `pid_timetable.py` downloads the GTFS feed (about 50 MB, again when it's a week old)
  into `pipeline/.cache/pid/` and reduces it to a summary of every tram and metro trip.
  Without it, every line runs every 8 minutes.
- **Metro.** `build_metro.py` takes the metro from the same timetables: each line's
  stations in order with the typical minutes between them, how often it runs, and
  every station's entrances (PID's feed has them all, 331). It follows the current
  timetable, so a station closed for works (Flora, as of autumn 2026) isn't there.
- **Footfall.** `build_footfall.py` needs the local OSM extract and uses PID's
  timetables when it can get them (see Tram lines); it counts the departures at every
  stop once and keeps them in `pipeline/.cache/pid/departures.json`. The whole city
  takes about 15 seconds. 1 on the map is as busy as the Old Town Square, so `ujezd`,
  which doesn't reach it, measures against the last `centrum` or `praha` built.
  Without the map, every street counts as equally busy and about 240 people are about
  everywhere.
- **Parking.** `build_parking.py` reads the monthly TSK occupancy GeoJSON collected by
  `~/projects/parkovani-praha` (set `PARKING_DATA` to point elsewhere).

Sizes: centrum is 234 tiles and about 36 MB; the whole city 13,609 tiles, 247k OSM
buildings and IPR buildings in 4,326 tiles, about 580 MB. The caches (OSM extract and
IPR sheets) are about 7.5 GB.

## Deploying

It runs at <https://streets.jonasjancarik.cz> from mbxp. `scripts/deploy-mbxp.sh`
builds the committed code, uploads it as a new release and syncs your local
`public/data/` to the server (only changed files go over), then restarts the
`streets-of-prague` container (busybox httpd) on `127.0.0.1:3017`. `scripts/httpd.conf`
gives JSON a Content-Type, which Cloudflare needs before it compresses a response. The Cloudflare tunnel
`urad-ai-poc` routes the hostname there.

## Credits

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- Tram and metro timetables: [PID / ROPID](https://pid.cz/o-systemu/opendata/), CC BY 4.0, reduced to trips per hour.
- 3D buildings and terrain: datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model), CC BY.
- Paid-parking sections and occupancy: [TSK Praha](https://zps.tsk-praha.cz/).
- Roofs: [straight-skeleton](https://github.com/StrandedKitty/straight-skeleton) (MIT, wraps CGAL).
- Maps in the developer panel: [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles; address search by [Nominatim](https://nominatim.org/).
