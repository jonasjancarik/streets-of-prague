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
node scripts/scene.mjs run all   # test scenarios in headless Chrome (see Testing below)
```

### Testing

`scenarios/*.ts` are scripted situations with checks, e.g. "a car at 50 km/h knocks a
lamp post over". They drive the real game through the test API in `src/testkit.ts`
(`window.__test`, `t` in a scenario): go to a place (named test places, or
latitude/longitude), set the time, weather, money, stars and health, get into a new
car, aim it at the nearest post, push it to a speed, run the world for a few seconds
with given controls, read back the numbers (`t.probe()`), look from anywhere with
`t.camera()`, and take screenshots.

`node scripts/scene.mjs serve` keeps headless Chrome open with the game loaded; then
`run <name…|all>`, `eval "<js with t>"` and `shot` take a second or two each, and follow
the dev server's reloads. Without a server each command loads the game itself.
Screenshots go to `$TMPDIR/scene`. The same scenarios run in the developer panel
("Run and watch" plays one in real time), and "Copy this situation" there copies where
you are, the time, weather, money, stars, car and camera as the start of a new scenario.

WebGPU is the default renderer; `?renderer=webgl` selects the legacy renderer.
WebGPU reuses the same building, landmark, cutaway and lamp-light shader graphs
across equivalent meshes. Each mesh keeps its own material, textures and sky-view
attribute, so unloading one tile does not change another tile's appearance.
If the browser's GPU adapter request takes more than 5 seconds, or device
initialization more than 15 seconds, startup continues with WebGL. A GPU device
that arrives after that timeout is released. Benchmark runs can require WebGPU
with `--require-webgpu`, and `--load-progress` reports the loading stage every 5 seconds.
For Chrome/Metal loading hangs, `--fresh-browser --loading-frames` keeps runs separate
and the frame scheduler active during loading; the heartbeat stops before timing.

The map data is built locally (see [Building the map](#building-the-map)); nothing
generated is committed. The whole city (`?area=praha`) is the default, `?area=centrum`
the historic centre and `?area=ujezd` a small test area. The game's clock starts at the time in Prague
now, and the sun and the light follow it; `?time=HH:MM` and `?day=mon…sun` start it elsewhere, and `?night` at half past one
(with night-time parking). The weather changes by itself every half hour or so of the game's clock;
`?weather=clear|cloudy|rain|storm|mist|snow` fixes it, and `?go` skips the start screen (the loading screen's language, time, weather and sound choices and its Start button; the weather is the real weather in Prague now, from Open-Meteo (`src/liveweather.ts`), or else rolled anew on each visit), and <kbd>P</kbd> steps through them. `?osm` shows OSM footprints instead of IPR's 3D buildings, `?dev` opens the
developer panel, `?dialog` plays a sample conversation, `?touch` shows the touch controls on a desktop, `?start=lon,lat` starts somewhere else, and `?money=N` sets how much money you start with (10,000 Kč otherwise). The game is in English and Czech: the start screen has the choice (remembered for next time; the browser's language decides the first time), and `?lang=cs|en` sets it. All text is written in English in the code and looked up by that text in `src/cs.ts`, through `t()` in `src/i18n.ts`; a line with no Czech entry shows in English. The Czech is kept gender-neutral towards the player for now (see the note at the top of `src/cs.ts`). Elements in `index.html` marked `data-t` work the same way.
Graphics (<kbd>G</kbd> cycles it, remembered in the browser):

| Setting | Ultra | High | Medium | Low | Lowest |
|---|---|---|---|---|---|
| Pixel ratio, up to the screen's own | 2 | 2 | 1.5 | 1 | 1 |
| MSAA on WebGPU | 4 samples | 4 samples | 4 samples | 4 samples | Off |
| Sun shadow map | 4096², softer edges | 2048² | 2048² | 1024² | 1024² |
| Dirt, grime, small leaves and tone curve | On | On | On | On | Off |
| Roof tiles and weathering | On | On | On | On | Off |
| Car shadows in lamplight | Full | Full | Soft | Soft | Off |
| Maximum crowd | 1200 | 1200 | 1200 | 1200 | 600 |

The sun shadow map covers just what is on screen, as the sun sees it, so shadows stay
sharp when you drive and when the sun is low. Street patterns and facade pictures
stay on at every tier. Quieter streets have
fewer people; changing tiers lets surplus people leave out of sight.
Auto, the default, starts High (Medium on touch devices) and moves between tiers
by how steady the frames are (`src/graphics.ts`), ignoring loading and tile builds;
it never picks Ultra, which only choosing it turns on.
`?graphics=auto|ultra|high|medium|low|lowest` overrides it for one visit; `?dpr=1` fixes
only the pixel ratio. WebGL keeps MSAA on at every tier because it cannot change
that without a new renderer.

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
  Meanwhile the view follows your train along the real track, deep under the streets
  and seen through a hole in the ground as in a road tunnel (`src/underground.ts`):
  the line's two tunnels, a platform at each station with the line's colour on its
  walls, the train pulling in and stopping, the station's name as it stands there.
  It slows down while the map ahead loads; E skips to the end. You come up at an entrance of that station, and the police have
  lost you. After midnight the metro is shut until about five.
- **Funiculars**: the Petřín funicular's two cars run on one cable from Újezd up to
  Petřín, one going up as the other comes down, and pass each other at Nebozízek,
  where both stop; from 7:00 to 22:00 a car leaves each end every four minutes or so.
  The NH hotel's little one on Mrázovka has a single cabin, free to ride in its opening
  hours (10:30–11:30, 15:00–18:00, 22:00–24:00). Where the cars are follows from the
  game's clock (`src/funicular.ts`). Press E beside a car standing at a station to get
  in; hold Shift to speed the ride up, and E gets you out at any station. Nobody walks
  or drives through a car: people are pushed aside (knocked over by one coming at
  them), and cars bounce off.
- **Parts of town**: the street you're in shows top left; come into another part of
  town (Smíchov, Malá Strana, Vinohrady…) and its name comes up as a large title for a
  few seconds, as does the one you start in (`src/districts.ts`). You have to be 30 m
  into it, and a name doesn't come up again within a minute and a half, so a street
  along the boundary doesn't keep showing titles.
- **Tram stops**: stand at one and the HUD lists the next trams due, counting down
  (`src/board.ts`). Hold Space (on touch, "Hold to wait") to fast-forward until one is
  about to arrive. Stops have blue-and-white plates with a black tram in side view
  and the stop name on the pole.
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
- **Pedal boats**: a few wait tied up at the bank round Slovanský ostrov and the islands;
  stand next to one (or any passing pedal boat or swan) and press E to get in
  (`src/boats.ts`). W/S pedal, A/D turn;
  E gets you out again where the bank is close.
- **Money** (`src/money.ts`): you start with 10,000 Kč, shown top right, and can only spend
  it (not saved between visits, never below 0). **PID ticket**: 46 Kč for 90 game minutes on
  trams, the metro and the Petřín funicular (the NH hotel's funicular is free). Nothing is
  bought for you: on a tram or the funicular you have 10 seconds to buy one (B, or "Buy a
  ticket" on touch) and then ride without; the metro asks "Going in without a ticket?" at the
  entrance. Riding without one risks an inspection (5% at each tram or funicular stop, 15% per
  metro ride): pay the 1,200 Kč fine (B) within 5 seconds or get off and run, and the inspector
  chases you on foot (`src/inspector.ts`). After 10 seconds, or at once if you get into a
  vehicle, they phone the police: one star, and if you're then arrested the fine is 1,500 Kč.
  Taxis need money for the fare, and let you out when it reaches your balance. Shared bikes are
  paid as you ride (below).
- **Taxis**: on foot near a street, press T (on touch, "Taxi") and pick how to get one
  (`src/taxi.ts`): wave down a street taxi, or order one through Zipp or Hopla, two
  made-up ride-hailing apps that cost less and whose drivers speed, tailgate and push
  through gaps. The nearest free taxi in the traffic (or a new one out of sight) drives
  to the lane next to you and waits 90 seconds; the hint says roughly how long it will
  be, and holding Space fast-forwards the wait. Press E beside it to get in, then a
  number (or tap) to pick one of ten well-known places (Old Town Square, Wenceslas
  Square, Main Station, Anděl, Prague Castle, Vyšehrad…). It finds its own way there
  along the one-way streets, sped up like a tram ride until the last 200 m, and you
  pay at the end from your money (a street taxi 60 Kč plus 36 Kč a km, the apps less; the meter shows in the hint, and a crash means a free ride). E gets you out
  early, and T cancels a taxi on its way. As on a tram, the police can't arrest you
  in a taxi, and your stars fade twice as fast.
- **On a phone or tablet** on-screen controls appear (add `?touch` to get them on a
  desktop). The left thumb has a round stick: on foot, push it the way you want to go
  and you walk there (a full push runs); in the car, point it the way you want to
  drive on screen and the car steers round to it (reversing, the back follows it). Put
  your thumb down away from the stick and the stick moves under it. In the car, lane
  assist is a toggle above the stick, showing the speed limit it keeps to while it's
  on; the right thumb has the gas and brake (roll from one to the other without
  lifting), the handbrake and "Get out"; "Back on road" is top right, under the
  sound and settings buttons. Pinch the map to zoom (`src/touch.ts`).
- **Sound and settings.** Two buttons in the top right corner: sound on or off (also
  M), and the settings, with the start screen's choices during play: language, sound,
  graphics (also G) and weather (also P). On a phone the credits are in there too
  (`src/settings.ts`).
- **Police.** Knocking people over, pulling drivers out of their cars, wrecking
  traffic, ramming or stealing a police car and speeding past the police (20 km/h over
  the limit) earn stars, up to five; crimes the police see count three times as much.
  Police cars chase you along the streets and ram you. When you're on foot they stay
  on the road and stop at the kerb nearest you; then (or when you stop the car) an
  officer gets out and runs after you, and if they reach you, you're busted (the
  police keep the car). The arrest banner appears before the screen fades to black;
  you are then taken to the station and the picture fades back in. You can outrun them on foot, or take the police car they've
  left behind (E) and drive off in it, its blue lights flashing as you go. From three stars a helicopter
  joins in and sees you over the rooftops, and the officers carry pistols: once they can
  see you from close enough they stop and shoot instead of running you down, and from
  four stars they shoot out of the cars too. Gunshots send people running. Stay out of
  sight and the stars go one at a time; they blink while nobody can see you
  (`src/police.ts`, `src/helicopter.ts`).
- **Health.** Shots hurt you, far less in a car (the car takes most of it), and so
  does being run down, knocked over by a tram or thrown off a bike. A bar under the
  stars shows how much you have left once you're hurt, and it comes back by itself
  after a few quiet seconds. When it runs out you're wasted: you fall where you are
  and come round outside the nearest hospital, no longer wanted (`src/guns.ts`).
- **Burning cars.** A car that's taken enough knocks (crashes, police bullets, a blast
  nearby) starts to smoke, then catches fire and a few seconds later blows up, leaving
  a charred wreck that smoulders for a while and can't be driven. If your own car
  catches fire, get out: still inside when it goes, you're wasted. The blast knocks
  people over, hurts you if you're near, shoves the cars around and can set them going
  too; blowing up a car you've crashed into is a crime, a police car more so
  (`src/fire.ts`).
- **Fire brigade.** When a car catches fire, a fire engine is called from a few hundred
  metres away, drives to it by the streets, and its crew of three gets out and sprays
  the car with hoses. A car nobody is driving burns 45–75 seconds before it blows up,
  which gives the engine time to arrive; your own car and cars chased by the police
  still go in 4–6 seconds. Once the fire is out, the crew climbs back aboard and the
  engine drives away. Crew and engines can be run over. Engines flash blue lights
  (police cars chasing you use the same code) and sound a siren: a slow two-tone for the
  engine, a faster rising and falling wail for the police, both gone by about 450 m. Cars
  ahead of one slow down and keep right as far as the street allows, and the police and
  engines take red lights at no more than 5 m/s (`src/brigade.ts`, `src/water.ts`,
  `src/beacons.ts`). The developer panel's "Set the nearest car on fire" button is the
  quickest way to see it.
  You can take an engine like any car (it counts as a carjack, and the crew who are out
  run after you for a while). Hold <kbd>F</kbd> in it (a button on phones) to spray the
  water cannon 17 m ahead: it puts out burning cars and knocks people and officers over
  gently, which counts as a crime. The tank lasts about 30 seconds and refills slowly;
  a blue bar under the health bar shows it (`src/cannon.ts`).
- **Developer panel**: press <kbd>`</kbd> (or add `?dev`). Type a street for instant
  matches from the area's `names.json`, press Enter to look up a full address on
  OpenStreetMap's Nominatim, paste coordinates or a Google Maps / Mapy.cz link, or pick
  a spot on an OpenStreetMap map (right-click there copies its coordinates); the game
  loads the tiles there and drops you on the pavement. "Copy link" gives a `?start=`
  link; `?place=` takes one of the test places in `src/testkit.ts`. The panel shows your
  coordinates (with a copy button) and links to the spot on Google Maps, Street View
  (facing your way) and Mapy.cz. The free camera stops following you: drag to move it,
  the wheel zooms, right-drag or Shift-drag turns and tilts it, and searching or the map
  then move the camera instead of you. Under Testing: pause, one frame at a time, slow
  motion or 2–4×, money, stars, full health, nothing hurts, into a new car of any type,
  the test places, and the scenarios (see Testing above).
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
  blocks, shops, offices and schools stay paved. Gardens get a few trees and shrubs,
  scattered by where they are so they're the same every visit, clear of the houses,
  paths and the trees already there (`gardenTrees` in `src/map/vegetation.ts`).
  Buildings get roof tiles laid down
  each face's slope, slate and gravel on flat roofs. It all stays sharp at any zoom.
- **Facades** are put together bay by bay and storey by storey from 60 parts: windows,
  doors, gateways and shopfronts of tenements, baroque houses, functionalist blocks,
  panel housing and family houses (`src/facades.ts`). A wall's style comes from where
  it stands and how tall it is: baroque in Old Town, Malá Strana and Hradčany, panel
  housing for tall blocks far out, family houses under about 8 m, tenements with some
  functionalism elsewhere. Window axes are about 3 m apart, as in a Prague tenement,
  with plain plaster between the windows. Party walls (a building's side wall standing
  back to back with its neighbour's, and showing where the neighbour is lower) are
  plastered without windows. Each building gets its own plaster colour: mostly ochres,
  yellows, creams and stone-like sands and greys, with a few pale greens, pinks and
  blues, mixed differently for each style. The parts were
  drawn by an image model as five sheets, each asked for with the first sheet as a
  style reference (the fifth, the tenements' windows and portals, after a
  neo-Renaissance house in Mělnická), and are cut and packed by `assets/facades/build_atlas.py`.
- **Portraits and the loading screen.** Characters are half-length portraits drawn by
  an image model, ten to a sheet, and cut apart by `assets/portraits/cut.py` into
  `public/portraits/` (the sheets never line up, so the seams are found per row); faces
  that came out too alike were regenerated one at a time (`assets/portraits/faces/`). The
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
  ground, the roofs, the cars and the tree tops, and melts slower still. Under snow,
  and from December to February, the broadleaf trees lose their leaves down to the
  branches; pines, spruces and some of the hedges stay green. On the roads
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
  tile has its own ground, buildings, tree-page leases, collision grid, parked cars and piece of
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
- **Trees** are IPR's surveyed ones (about 171,000 on city land, `pipeline/ipr_trees.py`)
  plus OSM's; where both have a tree within 2.5 m, IPR's stands. IPR says which are
  conifers and which fruit trees, and so does OSM sometimes (`leaf_type`, `genus`).
  Conifers are their own shape (`pineGeometry` in `src/map/vegetation.ts`, evergreen in
  winter), fruit trees are small. The woods, parks and gardens are filled up with made-up
  trees, 30% of them conifers in woods, but not next to a surveyed one. Rebuild them with
  `uv run build_tiles.py <area> --layers ground`, then `ipr_terrain.py <area>`.
  Rendering keeps fixed-capacity mesh pages per tree shape (`src/trees.ts`). A tile
  leases pages containing only its own trees; unloading the tile clears the pages
  for reuse without changing the surveyed or generated tree data. Pages hold 256
  broadleaf or 128 shrub/conifer instances. Startup prepares 64 broadleaf, 20 shrub
  and 24 conifer pages; a denser view can add pages without dropping trees.
- **Landmarks** (so far Mánes with Šítkovská vodárenská věž, the Týn Church, the Old Town Hall with its tower, St Nicholas at Old Town Square, the National Theatre, the Rudolfinum, the Municipal House with the Powder Tower, and House Okamura in Břevnov) are cut out of IPR's
  photorealistic 3D model instead: a textured mesh of the whole city from oblique aerial
  photographs (summer 2023, about 5 cm/px), published as an I3S scene layer.
  `pipeline/landmarks.py` takes the mesh's pieces over the landmark's OSM footprints
  (a little wider) and keeps the triangles inside. Blender (`pipeline/landmark_bake.py`)
  then bakes their colours onto the landmark's clean model from IPR's city model
  (LOD3): straight walls and roof edges, without the mesh's trees and lumps, about 100
  faces and one texture of about 5 cm per pixel (Mánes: 1.2 MB, against 2 MB and
  18,000 triangles for the mesh's own). Roofs take their colours from straight above,
  as the camera sees them; walls from straight in front, except where that meets the
  underside of something (an onion dome bulging over the simpler drum LOD3 has), which
  the camera never sees, so they take what's above instead. The game hides IPR's and OSM's buildings in that
  footprint and draws the model there (`landmarkModel` in `src/tiles.ts`). The photographs have the day's light
  in them, so the model is lit evenly, as if every face looked up, and still darkens at
  night. The collision footprint stays OSM's.
- **Roof colours.** Pitched roofs are terracotta tiles (a palette matched to reference photos of Prague's roofs, brick-red rather than orange, with each tile a little redder or duller than the next; the landmarks' photographs get the same warming when they load, in `warmUp` in `src/tiles.ts`, and where a landmark's photograph shows a red roof, the roof shader draws the same tiles at the photograph's brightness: `shadeLandmark` in `src/shading.ts` and its port in `src/webgpu/buildings.ts`), as nearly all of them are in Prague;
  flat ones are grey. OSM's `roof:material` and `roof:colour` can make a roof grey slate
  or green copper instead, down to single building parts (the cathedral's grey roofs
  and copper domes), and `pipeline/roofs.py` corrects landmarks OSM gets wrong or leaves
  out, including wings of the Castle that both OSM and IPR draw as one building.
  Churches OSM says nothing about get slate. IPR's roofs take their colour triangle by
  triangle, from the OSM building or part they lie in.
- **Colours from the photo mesh.** Where `pipeline/mesh_colours.py` has run, IPR's
  buildings take their real colours from IPR's photorealistic mesh instead of the
  palette: each roof face its colour and material (tiles, slate, sheet metal, copper;
  flat roofs bitumen, membrane, gravel, planted or paving), and each building its
  plaster. The photographs were taken on a summer
  morning, so the light is taken out first: the sun's direction and a light model are
  measured on the data itself (`--calibrate`), samples in the shade of other buildings
  are left out, and walls or roof faces seen only in shade count as unsure (their
  colour can't be recovered from the near-black shadows). Unsure roof faces take the
  colour of the rest of their roof, and a building's faces of one material that differ
  only a little are evened out; unsure walls keep the palette. A roof cover given in
  `roofs.py` or OSM still wins. Only colours and material classes leave the pipeline;
  the game draws its own tiles, slate, metal pans between standing seams (`sheetRoof`
  in `src/shading.ts` and `src/webgpu/buildings.ts`), sheets, planted roofs and paving
  on flat roofs, weathering and facades on top. Mansards (roof faces steeper than 60°)
  get a row of windows (`mansardCoords` in `src/facades.ts`). Roof windows are found in
  the mesh's colours (level 14, `detect_windows`); chimneys are placed by rule on the
  ridges (`pipeline/roof_details.py`), since the mesh is too coarse to show them; both
  go into the building's own triangles, so they cast shadows and take the weather.
  In `centrum`, walls are measured for 42 % of buildings and 93 % of roof faces get a
  colour.
- **Building import over water.** IPR footprints with at least 60% of their area
  over mapped water are omitted, keeping moored boats out of the building model.
- **Crossing widths.** At junctions where road surfaces merge, zebra bars are limited
  to the crossed street's width plus 2 m on each side, adjusted for the crossing angle.
- **Terrain.** IPR's bare-earth model on a 4 m grid per tile: the ground, buildings,
  walls, trees, cars, people, trams and the camera sit at their real height, cars
  pitch, roll and roll downhill, and the ground is hill-shaded.
- **Street placement.** Traffic-light poles and shared-bike rows move towards the
  pavement when their mapped positions fall on a carriageway. Tram-wire supports
  move out of the road too; a span is omitted when neither side can support it.
- **Bridges and tunnels** have heights of their own, above and below the bare ground
  (`pipeline/structures.py`). Where one meets a street on the ground it's at the
  ground's height, and in between its height runs evenly from end to end, along the
  ways and through junctions (Blanka's underground ramps). Bridges follow IPR's 3D
  model of Prague's bridges wherever it has them, so a deck rises and falls as the
  real one does. Tunnels keep a few metres of ground over them, more away from their
  portals, and wherever two cross on different OSM layers, the upper one clears the
  lower. They're put on levels (bridges 1, 2, …, tunnels -1, -2, …) so that ones
  crossing at different heights never share one. The metro stations' corridors and
  stairs (OSM tags them as tunnels too) are left out, both as tunnels and from the
  walking network: footways and stairs underground that are indoors, reach a metro
  entrance or come within 30 m of a station or platform. Underpasses away from the
  metro stay. A connected tunnel that never reaches 2.5 m below the ground is
  treated as a passage at street level; its streets lose their tunnel tag when no
  underground level covers them.
  Cars, trams and people drive or walk onto a bridge or into a tunnel where it meets
  the street and off it at the far end; parapets and tunnel walls keep them in, and
  whatever is on one level and another passes by. Under a bridge a round hole opens in
  it above you, as in a passage; in a tunnel a wider one opens down to it, the ground
  round you shown as bare earth. Everything else under the ground stays hidden
  (`track` and `view` in `src/tiles.ts`, the meshes in `src/ground.ts`). The car
  network keeps the tunnels and the magistrála, so traffic drives through them.
- **Life.** Arcade car physics against the 0.5 m collision grid (`src/car.ts`), in
  which buildings raised 3 m or more off the ground (OSM `min_height`, like a covered
  bridge between two houses) leave the way under them open; AI
  traffic that keeps to its lane, brakes for anything ahead, pulls out round a car
  standing in its way where the street has room (and waits behind it where it hasn't)
  and gives way to the right (`src/traffic.ts`), and stops at red lights; pedestrians on the footpath network who round its
  corners, step past parked cars and bikes in their way, leap out of the way of fast
  cars and get knocked over, then get up again (`src/people.ts`). Traffic and
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
  into the turns. Take one from someone riding it and they're pushed off (knocked
  down if it was going), then run. Hit something hard and you're thrown off. On foot,
  Space jumps (not at a tram stop, where it waits for a tram); in the air, a car can't
  knock you over. Jump at a car that's standing still and you climb onto it and can
  walk over its bonnet, roof or boot and drop off the other side. If it drives off with
  you on top, you ride along until it goes faster than about 30 km/h and throws you off.
- **Shared bikes.** Rows of bikes use real station locations, but fictional operator
  names: Pedálek for the blue nextbike bikes and Šlapeto for the pink Rekola bikes
  (`src/bikeshare.ts`, `build_bikes.py` below). Taking one starts a rental,
  and leaving it within 25 m of a station of the same system returns it and ends the
  rental; left anywhere else it's only parked and still yours. You pay as you go by the
  system's GBFS pricing plan where available (nextbike: 39 Kč per begun half hour,
  at most 500 Kč a day); Šlapeto uses a fictional game price of 1 Kč/minute. Each
  interval is charged when it begins, and the hint shows the price so far. A rented bike left
  more than 300 m from you, burnt out or gone costs a fee of 500 Kč (1,000 Kč when the nearest
  station of its system is over 3 km away).
- **Buses.** A few red and white city buses drive Prague's real bus lines around you
  (`src/buses.ts`, from PID's timetables): each follows its line from junction to
  junction, shows its number and where it's going on the boards at the front and by the
  front door, pulls up at its stops for 10 to 15 seconds and goes on, holding up the
  traffic behind it. Where a line leaves the streets on the map, the bus carries on along
  the main roads and is replaced once out of sight; without `buses.json` all buses just
  drive the main roads. You can take one like any car, but it's slow to pick up speed,
  wide in the turns and shoves smaller cars aside.
- **Lorries.** Box trucks and articulated lorries (built from boxes in `src/car.ts`, like the
  bus) use only the motorways and, further than 6.5 km from the Old Town Square, the trunk and
  primary roads (the suburbs with the depots and warehouses); they never appear in the
  centre or in parking spaces, and one that turns onto another kind of street is removed.
  They are slow to pick up speed and swing wide in the bends.
- **People and two-wheelers** are a small kit built in Blender from code
  (`assets/figures/build.py` → `public/figures.glb`): a low-poly person with a skeleton
  and clips for standing, walking, jogging, running, jumping, falling, getting up and
  riding, plus a bike and a motorbike. The walk, jog and run place the feet first (on
  the ground they stay put, rolling from heel to ball) and reach them with the legs;
  in the game the two gaits either side of someone's speed are blended, in step. At
  load, `src/figures.ts` plays every clip through and bakes the posed vertices into
  textures, so the whole crowd is one instanced draw call. Rebuild with `blender -b --factory-startup -P assets/figures/build.py`; add
  `-- --preview DIR` to render a few frames of every clip.
- **Cars** are built the same way (`assets/cars/build.py` → `public/cars.glb`): one
  low-poly body per type (hatchback, saloon, estate, SUV, van, pickup, taxi, police), shaped for
  the view from above, where the bonnet, cabin, windows and roof show, with a little
  of the sides, wheels and lights towards the edges of the screen. `src/car.ts` puts
  each car's colour on the paint. The bus is built from boxes in `src/car.ts`. Rebuild with
  `blender -b --factory-startup -P assets/cars/build.py`; `-- --preview DIR` renders
  them from above. During loading, `CarPool.prepare` creates the ordinary paint and
  courier-box bodies without consuming the game's random numbers. The already-started
  bike feed gets up to 250 ms to provide its operator colours. Each body keeps a
  16-car instance page; yellow taxis and silver hatchbacks reserve a second page
  because they exceeded 16 in the comparison drive. Empty pages stay hidden, and
  denser views get another retained page, so no visible car is dropped. A shared-bike
  colour that arrives after preparation, an unusual custom colour, or the first burnt
  body gets its page when first seen. Check preparation,
  page reuse and renderer behaviour with `node scripts/check-car-pool.mjs --url
  http://localhost:5191/ --case all` against a running dev server.
- **Trams** run Prague's real lines (`src/trams.ts`), taken from OSM's route
  relations: each line goes round its whole route there and back. How many trams a line
  has out follows PID's timetable for the game clock's day and hour (`src/clock.ts`):
  a tram every few minutes on a weekday afternoon, fewer at weekends and in the
  evening, and only the night lines 91–99 after midnight. Trams join a line where the
  gap is widest and leave service out of sight; the dev panel's time slider moves the
  clock. The departure boards count down from where the trams really are, so a
  tram held up in traffic shows up late there too. They stop at
  every stop, keep to the track's speed limit, slow down for curves and brake for the
  tram in front and for anything on the track. A car left on the track that holds a
  tram up for a minute gets pushed aside, slowly. They're the types Prague runs, about
  as often as in its fleet: the Škoda 15T, Tatra T3R.P in coupled pairs, the Škoda 14T,
  the Tatra KT8D5R.N2P and the new Škoda 52T, with the line number on the roof in the
  line's colour. Each section of a tram lies along the track on its own, so it bends
  round a corner as the real one does. The bodies are built like the cars
  (`assets/trams/build.py` → `public/trams.glb`, `-- --preview DIR` renders them), from
  the real lengths and liveries. They run all over the city at once, so they come into
  view on their own timetable; only the ones near the camera are drawn.
- **Overhead wires** (`src/wires.ts`) are built with each tile over its tram tracks: a
  contact wire 5.6 m above every track, where the pantographs reach, and every 30 m or so
  a span wire across the tracks, anchored to a building front when one is within 11 m
  (as in the old town's narrow streets) or else hung from a pole beside the track.
- **Posts** (`src/posts.ts`): the wires' poles and the lamp posts are solid, and nobody
  parks round one. Drive into one slowly and you bounce off; hit a lamp post at more
  than 18 km/h or a wire pole at more than 32 km/h and it goes over the way you were
  going, and you carry on slowed. A fallen lamp goes dark, and a fallen wire pole
  brings its span wire down with it.
- **Fences and hedges** (`src/fences.ts`, `src/map/fences.ts`): OSM's `barrier=fence` and
  `barrier=hedge` lines are cut into sections of up to 3 m, drawn as pickets between two
  rails and as a leafy box (a tagged `height` is used, else 1.2 m and 1.5 m). A car
  goes through a fence at more than about 5 km/h, and the section it hits lies down
  the way it was going (and stays down); a hedge takes 18 km/h, slower than that a car
  bounces off. On foot you can't walk through either, but you can jump a fence lower than
  about 1.6 m. Unlike the walls, they aren't in the tile's collision grid (the people
  and traffic of the city ignore them). Older tiles have none: rebuild the `ground`
  layer (`uv run build_tiles.py <area> --layers ground`).
- **Boats** on the Vltava (`src/boats.ts`): a few white cruise boats go slowly up and
  down the river, and pedal boats, every third a swan, paddle about round the islands.
  The river is only a ground layer, so the water of the loaded tiles is where they can
  go: each boat looks ahead and to both sides and turns towards the more open water,
  and turns back short of a weir. They're put on the water near you and taken away
  when they fall far behind; they keep to the water's height, so they pass under the
  bridges. Low-poly bodies built from boxes and extrusions, one mesh each. At night,
  when the street lamps come on, the cruise boats' cabin windows light up and they
  show their navigation lights (red to port, green to starboard, white on the mast
  and at the stern).
- **Sound** (`src/audio.ts`, Web Audio API). Your engine and tyres are made in code:
  the engine's note follows the revs up through the gears (lower for a van, higher for
  a motorbike, none on a bike), and the tyres hiss on asphalt, rumble over setts at the
  rate the wheels meet the stones (from the street's OSM `surface`), and squeal in a
  slide. The four nearest trams are recordings of Prague trams from Freesound, cut
  into clips by `pipeline/build_audio.py` (sources and licences in
  `public/audio/SOURCES.md`): the rumble and the motors' whine as loops that follow
  the tram's speed, the wheels' squeal in tight curves, pulling away from a stop and
  pulling in as it happens, and the bell at you or a car on the track ahead. The
  bogies' clicks over the rail joints are made in code. Under it all is the city's own
  sound, long stereo loops from the same script, each as loud as where you are and the
  time of day call for: two layered Old Town crowds (each six stretches of the
  recordings at once, a murmur with no words to make out), full on the busiest squares
  and well down and muffled in side streets, by how busy the streets within 150 m are
  (the footfall map, 1 at the Old Town Square), and quiet at night;
  distant traffic by day and a low hum by night; and birds where it's quiet (a
  blackbird at dawn and dusk, small garden birds by day, a morning chorus early on),
  none in rain or snow. It starts with the first key press or tap (the browser's rule);
  M turns it off and on, and it goes quiet in the metro.
- **Car radio.** While driving a car, use N to cycle stations or the controls under
  the speed display to pick one, step backwards/forwards or switch the radio off.
  Its on/off state is remembered; a station is selected randomly when it starts,
  and leaving a car prepares another station for the next car. Static ends when
  the stream plays or fails.
- **Police** patrol with the traffic. Chasing cars find their way with an A* search over
  the street graph (both ways along every street) and drive it with the same physics as
  your car; within 40 m and in sight of your car they head straight for it. After you
  on foot, the route ends in the traffic lane nearest you, clear of the parked cars,
  and a car that finds another police car already stopped just ahead waits behind
  it. What the police see
  is checked with rays over the collision grid; the helicopter needs no line of sight.
  Shots are decided when they're fired (likelier to hit close up, with more stars and
  against someone standing still) and drawn as a streak flying to where the bullet went.
- **Parking** follows TSK Praha's paid-parking data: each street section gets spaces ×
  measured occupancy cars (day or night), placed in OSM's parking lanes and lots and
  then along the kerb (`src/parking.ts`); bay lines are painted as Prague paints them,
  along the street side of the bays with short lines across at each end and none along
  the pavement: solid blue in residents' zones, white dashes in the mixed (violet) and
  visitors' (orange) ones. Cars stand parallel, angled or
  perpendicular as OSM tags each parking area (`orientation`) and each side of the
  street (`parking:<side>:orientation`, or the older `parking:lane:<side>`); where it
  doesn't say, an area under 4.5 m wide is parallel, up to 5.6 m angled and wider
  perpendicular. Angled bays slant forwards along the lane beside them, so cars nose
  in. Sides tagged as having no parking (or parking mapped separately) get
  no kerbside cars, and no car is left sticking out into a traffic lane. Underground, multi-storey and rooftop car parks stay empty.
  As in Prague, some cars stand half or fully on the pavement, often vans and often
  at corners or where the kerb is otherwise empty. Every half minute or so, one in
  view sets off along the pavement at walking pace before it bumps down into the
  street (`src/pavement.ts`).
- **Roads** are marked from OSM `lanes`: dashed dividers, double centre lines on four
  lanes or more, edge lines on the main roads. In Prague their shape comes from the
  city's digital technical map (`pipeline/dtm.py`), which has every carriageway,
  lay-by and parking bay as surveyed, so the asphalt ends where the real kerb does,
  rounded street corners and traffic islands included. The survey draws a corner's
  curve as a few straight pieces, so the corners are rounded off (up to 1.5 m along
  each side) and hairline gaps between neighbouring surfaces closed; a parking bay's
  short sides stay nearly square. OSM only says what a street is
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
  street graphs, so cars, traffic and people go through. Many pasáže are mapped as
  `tunnel=yes` or `covered=yes|arcade` instead; such a way at street level (no lower
  layer or level, bar an arcade one layer down) counts as a passage when at least
  half of it runs inside buildings, or an arcade 3 m of it (`passage_tags` in
  `pipeline/osm_area.py`), rather than as a tunnel under the ground or a metro
  station's corridor. While you're in one, a round
  hole opens in the floors above you so you can still see yourself (`CUTAWAY` in
  `src/shading.ts`).

`src/map/` holds the map-building modules shared with the 1945 project it came
from (geometry helpers, straight-skeleton buildings, trees).

## Known issues

- **Bridges and tunnels.** A bridge IPR's model doesn't have (a newer one) slopes
  evenly from one end to the other, and tunnels' depths are a guess (OSM has none).
- **Past the city limits** the buildings come from OSM, and where OSM gives neither a
  height nor a number of storeys, the height is a guess from the kind of building and
  the size of its footprint (sheds, cottages, one- or two-storey houses, halls). The
  terrain there carries on flat at the height of the nearest ground IPR has.
- **Parking doesn't fit.** About 30 % of the cars TSK counts don't fit into the
  narrow streets (without standing in the traffic lane) and are left out.
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
- **Traffic lights** come from OSM, which has about 2,200 in Prague at some 620
  junctions; junctions without them in OSM have none in the game. Each junction runs
  two phases (along its main street and across it), so turning traffic gets no arrow
  of its own, trams and pedestrians ignore the lights, and the lights never switch to
  flashing amber at night.
- **Traffic** without lights only gives way to the right and steers around others.
  The lane assist sometimes clips a corner.

## Not yet in the game

- Something to do: missions (deliveries, taxi, courier), and earning money.
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
uv run mesh_colours.py centrum     # real roof and wall colours from IPR's photo mesh (optional)
uv run ipr_buildings.py centrum    # IPR's 3D buildings into the tiles
uv run ipr_terrain.py centrum      # IPR's terrain, bridges and tunnels, hill shading
uv run build_lines.py centrum      # tram lines from OSM's route relations → lines.json
uv run build_metro.py centrum      # the metro from PID's timetables → metro.json
uv run build_buses.py centrum      # bus lines and stops from PID's timetables → buses.json
uv run build_footfall.py centrum   # how busy the streets are → footfall.png
uv run build_lamps.py centrum      # street lamps from IPR's utility map → lamps.bin.gz
uv run build_signals.py centrum    # traffic lights at junctions from OSM → signals.json
uv run build_bikes.py centrum      # shared bikes' stations from GBFS feeds → bikes.json
uv run build_districts.py centrum  # parts of town from OSM's cadastral areas → districts.json
uv run landmarks.py centrum        # landmarks from IPR's photorealistic mesh → landmarks/
```

Areas (`ujezd`, `centrum`, `praha`) are defined in `pipeline/osm_area.py`.

- **Shared bikes.** `build_bikes.py` reads nextbike Praha's public GBFS feed and
  Rekola's parking-map station feed directly. With `GOLEMIO_API_KEY` set (from
  [api.golemio.cz/api-keys](https://api.golemio.cz/api-keys)), it can add other systems
  from Golemio's `/v2/vehiclesharing/gbfs`. Feeds are cached in `.cache/bikes/` for a
  day. Operator names in the output are fictional, real operator/app links are
  omitted, and Rekola's data is paired with the fictional game price above.

- **Skylines.** `uv run skyline.py hradcany` (or `--all`) draws a real Prague view as a
  red screen-print silhouette into `public/skylines/`, for the loading screen and the
  backdrop behind character portraits. It reads the praha caches of `ipr_buildings.py`
  and `ipr_terrain.py`; the views (camera spot, direction, field of view, landmark) are
  listed in `VIEWS` at the top of `pipeline/skyline.py`. Each landmark is drawn black and
  its place in the picture goes to `skylines.json`, which the loading screen uses to
  stand it tall beside the menu.
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
- **Terrain grid.** A tile's heights are a 63 × 63 grid whose outer rows lie on the
  tile's edges (a step of 250 / 62 ≈ 4.03 m), so neighbouring tiles share them and
  the ground meets without a step. Data built before 29 September 2026 used a flat
  4 m step that stopped 2 m short of the edge, which shows as straight lines across
  roads and grass on slopes; the game still reads it. To rebuild the terrain for the
  whole city (from the main checkout, with no other pipeline job running):

  ```bash
  cd pipeline
  uv run ipr_terrain.py praha      # then centrum and ujezd, if you use them
  ```

  Nothing else needs rebuilding. The first run reads every terrain sheet again at the
  new step, so it takes a few minutes longer than usual.
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
- **Landmarks.** `LANDMARKS` in `pipeline/landmarks.py` names each landmark and the OSM
  buildings it replaces; `uv run landmarks.py <area> [name…] [--level N] [--raw]` makes
  them, after `build_tiles.py` and `ipr_buildings.py` (it takes the footprints and the
  clean models from the tiles). It needs Blender (on the PATH, in /Applications or
  `$BLENDER`); `--raw` keeps the mesh's own triangles instead. The mesh's pieces are
  kept in `pipeline/.cache/mesh/`; the finest level (16) is the default. How to add
  one, check it and fix what goes wrong: `.agents/skills/landmarks/SKILL.md`.
  Repository skills live in `.agents/skills`; `.claude/skills` is a compatibility symlink.
- **Mesh colours.** `mesh_colours.py <area>` needs the area's IPR sheets parsed
  (`ipr_buildings.py` once) and writes `pipeline/.cache/mesh_colours/<area>.json.gz`,
  which `ipr_buildings.py` reads (`--mesh-colours off` to leave it out). It downloads the
  mesh at level 13 (about 110 MB for `centrum`, into `pipeline/.cache/mesh/`, shared
  with the landmarks) and level 14 for the roof windows (about 2 GB for `centrum`;
  `--no-windows` skips it), and measures tiles side by side (`--jobs`); `centrum` takes
  about 15 minutes. It saves every 100 tiles, and `--resume` goes on after a stop (for
  the whole city, a night's run). `ipr_buildings.py --no-roof-details` leaves out the chimneys and
  roof windows. `--debug` writes, per tile, the mesh from above next to the measured
  colours and a table; `--calibrate [--every 6]` estimates the light and the white
  balance again and prints the constants to put in the script.
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
- **Traffic lights.** `build_signals.py` needs the streets layer and the local OSM
  extract. It puts each `highway=traffic_signals` node on the car network's streets that
  pass it and run the way it faces (`traffic_signals:direction`, else towards the nearer
  end), when that end is a junction within 60 m; a light mapped on the junction itself
  stops cars short of the streets crossing there. Junction nodes within 40 m of each
  other share one cycle (a crossing of two dual carriageways is four nodes); the main
  street gets the longer green. Lights for a pedestrian crossing alone are left out.
  It takes a few seconds, even for the whole city.
- **Metro.** `build_metro.py` takes the metro from the same timetables: each line's
  stations in order with the typical minutes between them, how often it runs,
  every station's entrances (PID's feed has them all, 331), and the track from the
  feed's shapes, with how far along it each station is. It follows the current
  timetable, so a station closed for works (Flora, as of autumn 2026) isn't there.
- **Parts of town.** `build_districts.py` needs the local OSM extract: it takes the
  cadastral areas (`boundary=cadastral`, the katastrální území, which is what people
  call the parts of town) once into `pipeline/.cache/osm/cadastral.osm.pbf` and keeps
  each one reaching into the area whole, simplified to 4 m. The whole city has 112 of
  them and the `praha` box reaches into the villages round it (255, about 540 kB).
  Without the file there are no titles.
- **Footfall.** `build_footfall.py` needs the local OSM extract and uses PID's
  timetables when it can get them (see Tram lines); it counts the departures at every
  stop once and keeps them in `pipeline/.cache/pid/departures.json`. The whole city
  takes about 15 seconds. 1 on the map is as busy as the Old Town Square, so `ujezd`,
  which doesn't reach it, measures against the last `centrum` or `praha` built.
  Without the map, every street counts as equally busy and about 240 people are about
  everywhere.
- **Sounds.** Unlike the map, the clips in `public/audio/` are committed; run
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

The game credits the map's sources in the corner of the screen (**Credits** opens the
list, with the licences), and the build writes the full licence texts of the bundled
libraries to `dist/licenses.txt` (a small plugin in `vite.config.js`).

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- Tram and metro timetables: [PID / ROPID](https://pid.cz/o-systemu/opendata/), CC BY 4.0, reduced to trips per hour.
- 3D buildings, bridges and terrain: datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model), CC BY.
- Landmarks, and the roof and wall colours: photorealistic 3D model of Prague, datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh), CC BY.
- Carriageways and parking bays: Digitální technická mapa kraje, datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/28A24EB4-5EE8-436E-B0BB-357025258211), CC BY.
- Paid-parking sections and occupancy: [TSK Praha](https://zps.tsk-praha.cz/).
- Street lamps: the surface marks of the archived utility map (DTMP_CUR_TMISZNAK_B), datový podklad © [IPR Praha](https://geoportalpraha.cz/), CC BY.
- Unmapped-ground prototype (`?cover`, `?ortho`): orthophotos and the digital surface model © [IPR Praha](https://geoportalpraha.cz/), CC BY 4.0; older surface model DMP 1G © [ČÚZK](https://geoportal.cuzk.cz/), CC BY 4.0.
- Tram sounds: [Freesound](https://freesound.org), nearly all CC0; the motor's whine is
  [tramvaj nova prujezd nabrezi MS](https://freesound.org/s/621068/) by ozvuk,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see `public/audio/SOURCES.md`).
- City sounds: [Freesound](https://freesound.org); the Old Town crowds are
  [Prague, Staro Mesto, City Center](https://freesound.org/s/212034/) (parts 1 and 2)
  by vonfleisch, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), the traffic
  [Prague Atmo Traffic from 5th floor](https://freesound.org/s/94309/) by aUREa,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), the rest CC0.
- Drawing: [three.js](https://threejs.org/) (MIT); map projections: [proj4js](https://proj4js.github.io/proj4js/) (MIT).
- Roofs: [straight-skeleton](https://github.com/StrandedKitty/straight-skeleton) (MIT, wraps CGAL).
- Maps in the developer panel: [Leaflet](https://leafletjs.com/) (BSD-2-Clause) with OpenStreetMap tiles; address search by [Nominatim](https://nominatim.org/).

### Licences for added assets

The game isn't commercial, but it may take donations (a "buy me a coffee" link), so
treat every asset as if it were for commercial use:

- Fine: CC0, CC BY (credit it here), our own recordings, and anything royalty-free
  that allows commercial use (e.g. Sonniss GDC bundles, Pixabay).
- Not fine: anything non-commercial (CC BY-NC, BBC Sound Effects, Meta AudioGen
  output), and AI tools whose free tier bars commercial use.
- Record each sound or texture that comes from outside, with where it came from, its
  licence and its author, next to the files (e.g. `assets/audio/SOURCES.md`).
