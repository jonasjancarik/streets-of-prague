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
npm run typecheck    # check browser source with strict TypeScript
npm run build        # typecheck, then make a production build
node scripts/bench.mjs   # frame times in Chrome at a few places (options in the script)
```

The map data is built locally (see [Building the map](#building-the-map)); nothing
generated is committed. The whole city (`?area=praha`) is the default, `?area=centrum`
the historic centre and `?area=ujezd` a small test area. The game's clock starts at the time in Prague
now, and the sun and the light follow it; `?time=HH:MM` and `?day=mon…sun` start it elsewhere, and `?night` at half past one
(with night-time parking). The weather changes by itself every half hour or so of the game's clock;
`?weather=clear|cloudy|rain|storm|mist|snow` fixes it, and <kbd>P</kbd> steps through them. `?osm` shows OSM footprints instead of IPR's 3D buildings, `?dev` opens the
developer panel, `?dialog` plays a sample conversation, `?touch` shows the touch controls on a desktop, `?start=lon,lat` starts somewhere else.
Graphics (<kbd>G</kbd> cycles it, remembered in the browser): High draws at the screen's
pixel ratio up to 2, Medium up to 1.5, Low at 1, all with the tone curve, dirt and grime
and the trees' small leaves; Lowest at 1 without them. Auto, the default, moves between
them by how steady the frames are (`src/graphics.ts`).
`?graphics=auto|high|medium|low|lowest` overrides it for one visit and `?dpr=1` fixes
the pixel ratio.

## Playing

- Tank controls on foot and in the car: W/S forwards and back, A/D turn, Shift
  runs, Space is the handbrake. E gets into the nearest car, including one driving
  past (its driver runs off). R puts the car back on the road. Scroll zooms; the
  camera also pulls up with speed. Braking hard, the handbrake and sliding round a
  corner leave dark tyre marks that fade after a minute (`src/skids.ts`); so do the
  police and cars sent skidding by a crash.
- In the car, holding Shift is lane assist (`src/assist.ts`): it steers along your
  lane, and A/D then pick the turn at the next junction instead of steering. It also
  keeps you to the street's speed limit (OSM `maxspeed`, else 50 km/h in town, 70 on
  trunk roads, 80 on motorways): the gas fades out at the limit, and faster than that
  the car eases down to it. To drive faster, let go of Shift.
- **Metro**: the M signs are the real entrances. Press E at one to go down, pick a
  station on any line (W/S, A/D for the line, E to go, or tap), and the ride plays out
  on the line's map: the wait for a train, the stations going by, a change of line
  where you need one, with the clock moving on by the real times (`src/metro.ts`).
  Meanwhile the view rises over the darkened city and follows your train along the
  real track, stopping at each station, and slows down while the map ahead loads;
  E skips to the end. You come up at an entrance of that station, and the police have
  lost you. After midnight the metro is shut until about five.
- **Tram stops**: stand at one and the HUD lists the next trams due, counting down
  (`src/board.ts`). Hold Space (on touch, "Hold to wait") to fast-forward until one is
  about to arrive.
- **Trams**: press E next to a tram waiting at a stop to get on (`src/ride.ts`). The
  panel lists the stops ahead. Pick one with W/S (or tap it) and the ride runs at 6×,
  stops on the way included, until about 250 m before your stop; then you watch the
  tram pull in and you get off. Hold Shift (on touch, "Hold to speed up") to speed up
  at any time. E while it's moving gets you off at the next stop; if something on the
  track holds the tram up between stops for 10 seconds, E gets you off where it
  stands (on touch, "Get off here"). Sped up, the whole
  world runs faster, in short steps so the physics holds; it slows down again while
  the streets ahead are still loading. The police can't arrest you on a tram, and
  your stars fade twice as fast.
- **On a phone or tablet** on-screen controls appear (add `?touch` to get them on a
  desktop). The left thumb has a round stick: on foot, push it the way you want to go
  and you walk there (a full push runs); in the car, point it the way you want to
  drive on screen and the car steers round to it (reversing, the back follows it). Put
  your thumb down away from the stick and the stick moves under it. In the car, lane
  assist is a toggle above the stick, showing the speed limit it keeps to while it's
  on; the right thumb has the gas and brake (roll from one to the other without
  lifting), the handbrake and "Get out"; "Back on road" is top right.
  Pinch the map to zoom (`src/touch.ts`).
- **Police.** Knocking people over, pulling drivers out of their cars, wrecking
  traffic, ramming or stealing a police car and speeding past the police (20 km/h over
  the limit) earn stars, up to five; crimes the police see count three times as much.
  Police cars chase you along the streets and ram you; when you're on foot or stopped,
  an officer gets out and runs after you, and if they reach you, you're busted (the
  police keep the car). You can outrun them on foot. From three stars a helicopter
  joins in and sees you over the rooftops. Stay out of sight and the stars go one at a
  time; they blink while nobody can see you (`src/police.ts`, `src/helicopter.ts`).
- **Developer panel**: press <kbd>`</kbd> (or add `?dev`). Type a street for instant
  matches from the area's `names.json`, press Enter to look up a full address on
  OpenStreetMap's Nominatim, or pick a spot on an OpenStreetMap map; the game loads
  the tiles there and drops you on the pavement. "Copy link" gives a `?start=` link.
  "Helicopter next to me" parks one on the nearest open ground: E gets in, W/S fly,
  A/D turn, Space climbs, Shift comes down. Below 30 m the buildings are in the way;
  land on open ground to get out.

## How it works

- **Procedural look.** The ground is real geometry, one mesh per surface kind
  triangulated from OSM and coloured by world-space GLSL patterns (`src/shading.ts`,
  `src/surface.ts`): asphalt, granite setts, Prague mosaic pavement, slabs, grass,
  water. Rails, zebras, lane markings and parking-bay outlines are thin strips on top.
  Land that OSM gives a use but no surface still gets one: fields with crop rows
  (farmland, nurseries), concrete work yards (industrial land, garages, farmyards),
  gravel ballast on railway land, and bare earth on building sites, brownfields and
  quarries (`_area_kind` in `pipeline/osm_area.py`).
  OSM rarely maps the gardens and lawns in a suburb or a housing estate, so a street
  block of family houses, or of flats with plenty of room round them, gets grass
  between the buildings (`_gardens` in `pipeline/osm_area.py`); denser inner-city
  blocks, shops, offices and schools stay paved. Buildings get roof tiles laid down
  each face's slope, slate and gravel on flat roofs. It all stays sharp at any zoom.
- **Facades** are put together bay by bay and storey by storey from 48 parts: windows,
  doors, gateways and shopfronts of tenements, baroque houses, functionalist blocks,
  panel housing and family houses (`src/facades.ts`). A wall's style comes from where
  it stands and how tall it is: baroque in Old Town, Malá Strana and Hradčany, panel
  housing for tall blocks far out, family houses under about 8 m, tenements with some
  functionalism elsewhere. The plaster takes the building's own colour. The parts were
  drawn by an image model as four sheets, each asked for with the first sheet as a
  style reference, and are cut and packed by `assets/facades/build_atlas.py`.
- **Portraits and the loading screen.** Characters are half-length portraits drawn by
  an image model, ten to a sheet, and cut apart by `assets/portraits/cut.py` into
  `public/portraits/` (the sheets never line up, so the seams are found per row). The
  loading screen puts three of them in front of a skyline of a real view, drawn from
  the 3D city by `pipeline/skyline.py`, with poster shapes over the panels' cut edges;
  a conversation shows the speaker rising out of a frame (`src/portraits.ts`).
- **Weather** (`src/weather.ts`): clear, cloudy, rain, a thunderstorm, mist or snow,
  each a mix of cloud, rain, storm, snow and mist that the weather moves between over
  half a minute. In a storm the rain drives in on the wind, and lightning flickers
  every few seconds and thunders a moment later. It
  picks the next one every 20 to 60 minutes of the game's clock, by season (rain in
  summer, snow and mist in winter, mist mostly in the morning); a picked weather stays.
  Clouds hide the sun and fade the shadows, and the sky's light turns grey by day and
  orange from the city at night (`src/sky.ts`). Rain falls as streaks and snow as
  flakes in a box round the view that stays put in the world, so you move through
  them; mist is a drifting sheet a few metres up that the taller buildings stand out
  of, with fog measured from the camera so the ground is hazier than the roofs. The
  ground gets wet in the rain (darker paving, puddles mirroring the sky and the lamps,
  rings where the drops hit) and dries over several minutes; snow settles on the
  ground, the roofs, the cars and the tree tops, and melts slower still. On the roads
  and pavements it lies whole through the night; from about six in the morning the
  traffic clears it, a little more with every busy hour (by the game's clock), to wet
  slush with patches of snow by the afternoon, the roads before the pavements, while
  snow still falling covers them again, fastest at night (`WEATHER_GLSL` in `src/shading.ts`). A wet road takes a quarter
  of the tyres' grip and snow nearly half, for the cars you and the police drive.
  Cars on a wet road throw up spray behind them (`src/spray.ts`), and in snow lying on
  the street they leave tracks.
  Rain hisses and patters, the tyres hiss louder in the wet, and a wind blows while it
  snows, all made in Web Audio (`src/audio.ts`).
- **Night** (`src/lamps.ts`): the street lamps are IPR's, about 130,000 of them: on
  poles, on walls, the Old Town's gas lamps, floodlit monuments, tunnels and
  underpasses (`pipeline/build_lamps.py`). Side streets whose lamps hang on cables
  between the houses aren't in that map, so a street with no lamp within 20 m gets
  one hung over it every 30 m. Round the view the lamps get a pole and a glowing head,
  and every lamp and every driving car's headlights and rear lights add a pool of
  light to a light map: a texture over the view, drawn from above each frame. The
  ground, walls, trees, cars and people read their light from it by position, so the
  light costs one texture read a pixel however many lamps there are; its alpha keeps
  the height of the ground under the lamps, so their light stays off the roofs. The
  lamps come on at dusk (earlier under heavy cloud), and a share of the windows is lit
  by the hour, most in the evening.
- **Tiles.** The map streams in 250 m tiles (`src/tiles.ts`) around the camera. Each
  tile has its own ground, buildings, trees, collision grid, parked cars and piece of
  the street graphs (joined across tiles by OSM node ids), so start-up doesn't depend
  on the area's size. A tile's files are fetched all at once, and the heavy part of
  building it runs in web workers (`src/tileWorker.ts`): the ground's geometry
  (`src/ground.ts`), IPR's buildings, straight-skeleton roofs for OSM buildings, the
  windows' positions on every wall, trees, walls and the collision grid. The main
  thread only joins up the street graphs, makes the meshes and parks the cars, so
  driving into new streets doesn't stutter.
- **Buildings** come from IPR Praha's open 3D model (CityGML LOD3: real roofs, towers
  and domes), which covers the whole city. OSM buildings that the model doesn't have
  (newer ones, sheds, anything past the city limits) are extruded from their footprints.
- **Roof colours.** Pitched roofs are red tiles, as nearly all of them are in Prague;
  flat ones are grey. OSM's `roof:material` and `roof:colour` can make a roof grey slate
  or green copper instead, down to single building parts (the cathedral's grey roofs
  and copper domes), and `pipeline/roofs.py` corrects landmarks OSM gets wrong or leaves
  out, including wings of the Castle that both OSM and IPR draw as one building.
  Churches OSM says nothing about get slate. IPR's roofs take their colour triangle by
  triangle, from the OSM building or part they lie in.
- **Terrain.** IPR's bare-earth model on a 4 m grid per tile: the ground, buildings,
  walls, trees, cars, people, trams and the camera sit at their real height, cars
  pitch, roll and roll downhill, and the ground is hill-shaded.
- **Bridges and tunnels** have heights of their own, above and below the bare ground
  (`pipeline/structures.py`). Where one meets a street on the ground it's at the
  ground's height, and in between its height runs evenly from end to end, along the
  ways and through junctions (Blanka's underground ramps). Bridges follow IPR's 3D
  model of Prague's bridges wherever it has them, so a deck rises and falls as the
  real one does. Tunnels keep a few metres of ground over them, more away from their
  portals, and wherever two cross on different OSM layers, the upper one clears the
  lower. They're put on levels (bridges 1, 2, …, tunnels -1, -2, …) so that ones
  crossing at different heights never share one.
  Cars, trams and people drive or walk onto a bridge or into a tunnel where it meets
  the street and off it at the far end; parapets and tunnel walls keep them in, and
  whatever is on one level and another passes by. Under a bridge a round hole opens in
  it above you, as in a passage; in a tunnel a wider one opens down to it, the ground
  round you shown as bare earth. Everything else under the ground stays hidden
  (`track` and `view` in `src/tiles.ts`, the meshes in `src/ground.ts`). The car
  network keeps the tunnels and the magistrála, so traffic drives through them.
- **Life.** Arcade car physics against the 0.5 m collision grid (`src/car.ts`); AI
  traffic that keeps to its lane, brakes for anything ahead and gives way to the right
  (`src/traffic.ts`); pedestrians on the footpath network who leap out of the way of
  fast cars and get knocked over, then get up again (`src/people.ts`). Traffic and
  people live within about 330 m of the player.
- **Crowds.** The busier the streets around you, the more people: 500 to 600 round the
  Old Town Square and on Charles Bridge, a couple of hundred in Vinohrady or on a
  housing estate, a few dozen on the edge of town. They come and go out of sight as
  you move, turn up more often on the busier streets and, at a junction, lean towards
  the busier way. How busy a street is comes from a footfall map
  (`pipeline/build_footfall.py`, `src/footfall.ts`). There's no open data on where
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
  plus a bike and a motorbike. At load, `src/figures.ts` plays every clip through and
  bakes the posed vertices into textures, so the whole crowd is one instanced draw
  call. Rebuild with `blender -b --factory-startup -P assets/figures/build.py`; add
  `-- --preview DIR` to render a few frames of every clip.
- **Cars** are built the same way (`assets/cars/build.py` → `public/cars.glb`): one
  low-poly body per type (hatchback, saloon, estate, van, taxi, police), shaped for
  the view from above, where the bonnet, cabin, windows and roof show, with a little
  of the sides, wheels and lights towards the edges of the screen. `src/car.ts` puts
  each car's colour on the paint. Rebuild with
  `blender -b --factory-startup -P assets/cars/build.py`; `-- --preview DIR` renders
  them from above.
- **Trams** run Prague's real lines (`src/trams.ts`), taken from OSM's route
  relations: each line goes round its whole route there and back. How many trams a line
  has out follows PID's timetable for the game clock's day and hour (`src/clock.ts`):
  a tram every few minutes on a weekday afternoon, fewer at weekends and in the
  evening, and only the night lines 91–99 after midnight. Trams join a line where the
  gap is widest and leave service out of sight; the dev panel moves the clock an hour
  either way. The departure boards count down from where the trams really are, so a
  tram held up in traffic shows up late there too. They stop at
  every stop, keep to the track's speed limit, slow down for curves and brake for the
  tram in front and for anything on the track. A car left on the track that holds a
  tram up for a minute gets pushed aside, slowly. Three-section 15T-like cars with the
  line number on the roof in the line's colour. They run all over the city at once, so
  they come into view on their own timetable; only the ones near the camera are drawn.
- **Sound** (`src/audio.ts`, Web Audio API). Your engine and tyres are made in code:
  the engine's note follows the revs up through the gears (lower for a van, higher for
  a motorbike, none on a bike), and the tyres hiss on asphalt, rumble over setts at the
  rate the wheels meet the stones (from the street's OSM `surface`), and squeal in a
  slide. The four nearest trams are recordings of Prague trams from Freesound, cut
  into clips by `pipeline/build_audio.py` (sources and licences in
  `public/audio/SOURCES.md`): the rumble and the motors' whine as loops that follow
  the tram's speed, the wheels' squeal in tight curves, pulling away from a stop and
  pulling in as it happens, and the bell at you or a car on the track ahead. The
  bogies' clicks over the rail joints are made in code. It starts with the first key
  press or tap (the browser's rule); M turns it off and on, and it goes quiet in the
  metro.
- **Police** patrol with the traffic. Chasing cars find their way with an A* search over
  the street graph (both ways along every street) and drive it with the same physics as
  your car; within 40 m and in sight they head straight for you. What the police see
  is checked with rays over the collision grid; the helicopter needs no line of sight.
- **Parking** follows TSK Praha's paid-parking data: each street section gets spaces ×
  measured occupancy cars (day or night), placed in OSM's parking lanes and lots and
  then along the kerb (`src/parking.ts`); bay lines are painted in the zone colour
  (blue resident, violet mixed, orange visitor). Cars stand parallel, angled or
  perpendicular as OSM tags each parking area (`orientation`) and each side of the
  street (`parking:<side>:orientation`, or the older `parking:lane:<side>`); where it
  doesn't say, an area under 4.5 m wide is parallel, up to 5.6 m angled and wider
  perpendicular. Angled bays slant forwards along the lane beside them, so cars nose
  in. Sides tagged as having no parking (or parking mapped separately) get
  no kerbside cars. Underground, multi-storey and rooftop car parks stay empty.
  As in Prague, some cars stand half or fully on the pavement, often vans and often
  at corners or where the kerb is otherwise empty. Every half minute or so, one in
  view sets off along the pavement at walking pace before it bumps down into the
  street (`src/pavement.ts`).
- **Roads** are marked from OSM `lanes`: dashed dividers, double centre lines on four
  lanes or more, edge lines on the main roads. In Prague their shape comes from the
  city's digital technical map (`pipeline/dtm.py`), which has every carriageway,
  lay-by and parking bay as surveyed, so the asphalt ends where the real kerb does,
  rounded street corners and traffic islands included. OSM only says what a street is
  paved with: each part of the surveyed surface takes the paving of the nearest street,
  and cobbles reach at most 4 m past a cobbled street's kerb (a car park beside it is
  asphalt). Each side's kerb, for the parked cars, is measured straight across from
  the street's centre line to where the surveyed surface ends (`pipeline/kerbs.py`).
  Past the city limits, and on the few streets the map doesn't have (about 2 %, mostly
  new ones), the asphalt reaches out to each kerb as OSM suggests: past the lanes to
  take in a tram track running in the street and a tagged parking lane, and where the
  pavement is mapped as its own way beside the street, up to that pavement's inner edge.
- **Passages through buildings** (OSM `tunnel=building_passage`: gateways, arcades,
  Prague's pasáže) are cut out of the buildings' collision footprint and stay in the
  street graphs, so cars, traffic and people go through. While you're in one, a round
  hole opens in the floors above you so you can still see yourself (`CUTAWAY` in
  `src/shading.ts`).

`src/map/` holds the map-building modules shared with the 1945 project it came
from (geometry helpers, straight-skeleton buildings, trees, the Petřín funicular).

## Known issues

- **Bridges and tunnels.** A bridge IPR's model doesn't have (a newer one) slopes
  evenly from one end to the other. Tunnels' depths are a guess (OSM has none), and
  the metro stations' corridors and stairs are tunnels like any other.
- **Past the city limits** the buildings come from OSM, and where OSM gives neither a
  height nor a number of storeys, the height is a guess from the kind of building and
  the size of its footprint (sheds, cottages, one- or two-storey houses, halls). The
  terrain there carries on flat at the height of the nearest ground IPR has.
- **Parking doesn't fit.** About 30 % of the cars TSK counts don't fit into the
  narrow streets and are left out.
- **Angled and perpendicular parking along the kerb** past the city limits stands just
  outside the carriageway, since OSM street widths usually leave it out. Where the
  pavement there is narrow, the cars end up on it; where a building is in the way,
  they're left out. (In Prague the technical map's parking bays are part of the street.)
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
- Sound for the traffic, crashes, people and the helicopter.
- Spray behind cars in the rain, and bare trees in winter.

## Building the map

Requirements: [uv](https://docs.astral.sh/uv/), Node.js, and for a local OSM extract
`brew install osmium-tool`.

```bash
cd pipeline
uv run build_parking.py centrum    # TSK paid-parking sections (read by build_tiles)
uv run build_tiles.py centrum      # today's map + street graphs in tiles → public/data/centrum_now/
uv run ipr_buildings.py centrum    # IPR's 3D buildings into the tiles
uv run ipr_terrain.py centrum      # IPR's terrain, bridges and tunnels, hill shading
uv run build_lines.py centrum      # tram lines from OSM's route relations → lines.json
uv run build_metro.py centrum      # the metro from PID's timetables → metro.json
uv run build_footfall.py centrum   # how busy the streets are → footfall.png
uv run build_lamps.py centrum      # street lamps from IPR's utility map → lamps.bin.gz
```

Areas (`ujezd`, `centrum`, `praha`) are defined in `pipeline/osm_area.py`.

- **Skylines.** `uv run skyline.py hradcany` (or `--all`) draws a real Prague view as a
  red screen-print silhouette into `public/skylines/`, for the loading screen and the
  backdrop behind character portraits. It reads the praha caches of `ipr_buildings.py`
  and `ipr_terrain.py`; the views (camera spot, direction, field of view) are listed
  in `VIEWS` at the top of `pipeline/skyline.py`.
- **Layers.** The map is built in layers, and each step rebuilds only its own
  (`pipeline/layers.py`): `build_tiles.py` makes the OSM buildings, the ground (land
  use, streets and pavements, parking areas, walls, rails, crossings, trees), the
  street networks and the paid parking; `ipr_buildings.py` and `ipr_terrain.py` add
  IPR's buildings and terrain. Every step ends by putting the tiles together from all
  the layers, rewriting only the files that changed. So after changing how pavements
  are drawn, `uv run build_tiles.py centrum --layers ground` rebuilds just the ground
  (it then says to run `ipr_terrain.py`, which works out the bridges and tunnels from it); after
  changing the street networks, `--layers streets`. The layers are kept in
  `pipeline/.cache/layers/`.
- **Caches.** Every OSM chunk and every IPR sheet is read only once. What comes out
  is kept (`pipeline/.cache/osm/*.parsed.pkl`, `pipeline/.cache/ipr/parsed/`) and read
  again only when the source changes. Chunks and sheets are worked on side by side
  (`--jobs`, by default two fewer than the machine has cores).
- **OSM.** With `pipeline/.cache/osm/czech-republic-latest.osm.pbf` from
  [Geofabrik](https://download.geofabrik.de/europe/czech-republic.html) (about 950 MB)
  the chunks are cut locally with osmium. The centre builds in under half a minute
  the first time and in about 15 seconds after that; the whole city, with IPR's
  buildings and terrain, in about 11 minutes the first time (it was 42 before the
  layers and caches), and its ground alone in about a minute and a half, plus 40
  seconds for the terrain. Without it the pipeline asks Overpass (set
  `OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api` if overpass-api.de
  refuses). `build_tiles.py` works in 2 km chunks with a 150 m overlap, so buildings
  and streets on a chunk border come out whole.
- **Technical map.** `build_tiles.py` checks IPR's open data for this month's
  digital technical map (DTM kraje, set 2: the surfaces as polygons) when it builds
  the ground or the streets, and downloads any district that's new (57 GeoPackages,
  about 130 MB) into `pipeline/.cache/dtm/ZPS_OPL/`. They're read once, in about 15
  seconds, into `pipeline/.cache/dtm/surfaces.pkl`; `uv run dtm.py` does the same on
  its own. Offline, it uses whatever it downloaded last; with nothing downloaded, every
  street is sized from OSM.
- **IPR.** `ipr_buildings.py` and `ipr_terrain.py` download the SMO-5 sheets they need
  (2.5 × 2 km, about 150 MB each for buildings) into `pipeline/.cache/ipr/` from IPR's
  ArcGIS Online catalogue. Sheets come in blocks of 10 × 10 named after a town, and the
  city spills over from Praha (`Prah`) into Beroun (`Bero`), Kladno (`Klad`), Kralupy
  (`Krav`) and Český Brod (`Cbro`); the pipeline reads all five. Coordinates go S-JTSK → WGS84 with the Czech datum shift →
  local metres (going straight to the datum-less local projection puts everything
  ~25 m off); IPR wall bases then sit a median 0.55 m from OSM building edges.
- **Roof corrections.** `pipeline/roofs.py` lists landmarks by OSM id, and outlines
  (in WGS84) for parts of buildings OSM draws as one. After changing it, run
  `build_tiles.py <area> --layers buildings` and then `ipr_buildings.py <area>`.
- **Tram lines.** `build_lines.py` takes every tram line's two route relations (one
  per direction) and joins them into a loop along the track network, stops and speed
  limits included; it prints any line or direction it can't follow. Lines stay whole
  where they leave the area. With the local extract it takes about 10 seconds. It also
  adds how often each line runs, hour by hour, from PID's timetables:
  `pid_timetable.py` downloads the GTFS feed (about 50 MB, again when it's a week old)
  into `pipeline/.cache/pid/` and reduces it to a summary of every tram and metro trip.
  Without it, every line runs every 8 minutes.
- **Metro.** `build_metro.py` takes the metro from the same timetables: each line's
  stations in order with the typical minutes between them, how often it runs,
  every station's entrances (PID's feed has them all, 331), and the track from the
  feed's shapes, with how far along it each station is. It follows the current
  timetable, so a station closed for works (Flora, as of autumn 2026) isn't there.
- **Footfall.** `build_footfall.py` needs the local OSM extract and uses PID's
  timetables when it can get them (see Tram lines); it counts the departures at every
  stop once and keeps them in `pipeline/.cache/pid/departures.json`. The whole city
  takes about 15 seconds. 1 on the map is as busy as the Old Town Square, so `ujezd`,
  which doesn't reach it, measures against the last `centrum` or `praha` built.
  Without the map, every street counts as equally busy and about 240 people are about
  everywhere.
- **Tram sounds.** Unlike the map, the clips in `public/audio/` are committed; run
  `uv run build_audio.py` (needs ffmpeg) only to change how they're cut. It downloads
  the Freesound previews it needs into `pipeline/.cache/audio/freesound/` (no login
  needed). Add a new recording's source and licence to `public/audio/SOURCES.md`.
- **Parking.** `build_parking.py` reads the monthly TSK occupancy GeoJSON collected by
  `~/projects/parkovani-praha` (set `PARKING_DATA` to point elsewhere).
- **Unmapped ground (prototype).** `ground_cover.py` tries two ways to fill the ground
  nothing is mapped on, from IPR's aerial photographs, on a few tiles at a time; it
  isn't part of the build, and its extra packages are in a group of their own
  (`uv run --group cover ground_cover.py …`). `fetch` downloads the photos (colour and
  infrared) for the tiles; `classify --method rules` sorts the unmapped ground into
  grass, trees, dirt, gravel, asphalt and what isn't ground, and the game draws it with
  `?cover=rules`; `ortho` paints the photo itself through a Kuwahara filter, shown with
  `?ortho` (not convincing yet; stronger filters are still to try). Heights come from
  IPR's 1 m surface model, unzipped into `pipeline/.cache/cover/dsm_ipr/` (1.5 GB to
  download). The script's docstring has the rest, including hand-labelling and
  scoring.

Sizes: centrum is 234 tiles and about 22 MB; the whole city 13,609 tiles, 247k OSM
buildings and IPR buildings in 4,326 tiles, about 580 MB. The tiles' binary files
(IPR's buildings, the terrain) are gzipped (`.bin.gz`) and unpacked by the game. The
caches (OSM extract and IPR sheets) are about 7.5 GB, and what the pipeline keeps of
them once read about 2 GB more.

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
- 3D buildings, bridges and terrain: datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model), CC BY.
- Carriageways and parking bays: Digitální technická mapa kraje, datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/28A24EB4-5EE8-436E-B0BB-357025258211), CC BY.
- Paid-parking sections and occupancy: [TSK Praha](https://zps.tsk-praha.cz/).
- Street lamps: the surface marks of the archived utility map (DTMP_CUR_TMISZNAK_B), datový podklad © [IPR Praha](https://geoportalpraha.cz/), CC BY.
- Unmapped-ground prototype (`?cover`, `?ortho`): orthophotos and the digital surface model © [IPR Praha](https://geoportalpraha.cz/), CC BY 4.0; older surface model DMP 1G © [ČÚZK](https://geoportal.cuzk.cz/), CC BY 4.0.
- Tram sounds: [Freesound](https://freesound.org), nearly all CC0; the motor's whine is
  [tramvaj nova prujezd nabrezi MS](https://freesound.org/s/621068/) by ozvuk,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see `public/audio/SOURCES.md`).
- Roofs: [straight-skeleton](https://github.com/StrandedKitty/straight-skeleton) (MIT, wraps CGAL).
- Maps in the developer panel: [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles; address search by [Nominatim](https://nominatim.org/).

### Licences for added assets

The game isn't commercial, but it may take donations (a "buy me a coffee" link), so
treat every asset as if it were for commercial use:

- Fine: CC0, CC BY (credit it here), our own recordings, and anything royalty-free
  that allows commercial use (e.g. Sonniss GDC bundles, Pixabay).
- Not fine: anything non-commercial (CC BY-NC, BBC Sound Effects, Meta AudioGen
  output), and AI tools whose free tier bars commercial use.
- Record each sound or texture that comes from outside, with where it came from, its
  licence and its author, next to the files (e.g. `assets/audio/SOURCES.md`).
