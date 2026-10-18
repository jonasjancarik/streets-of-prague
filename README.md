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

Development pages pause while another session benchmarks. Status requests time out
after four seconds; older replies cannot restore a pause after a newer reply cleared
it. If the local status endpoint is unavailable, the page carries on.
`node scripts/check-bench-pause.mjs` checks polling and startup recovery offline.

WebGPU is the default renderer; `?renderer=webgl` selects the legacy renderer.
WebGPU reuses the same building, landmark, cutaway and lamp-light shader graphs
across equivalent meshes. Each mesh keeps its own material, textures and sky-view
attribute, so unloading one tile does not change another tile's appearance.
If the browser's GPU adapter request takes more than 5 seconds, or loading the
`three/webgpu` base library or device initialization takes more than 15 seconds each,
startup continues with WebGL. A GPU device that arrives after that timeout is released;
cleanup failures are reported without stopping the fallback renderer. The game's
material ports (`src/webgpu.ts`) load only after the device is ready. If that import
fails or takes more than 15 seconds, or configuration fails, startup stops with an
error and starts renderer cleanup; reload the page to try again. That later stage
cannot safely switch to WebGL because it installs shared material factories.
`node scripts/check-renderer.mjs --offline` checks startup and late cleanup without a GPU.
Benchmark runs can require WebGPU
with `--require-webgpu`, and `--load-progress` reports the loading stage every 5 seconds.
For Chrome/Metal loading hangs, `--fresh-browser --loading-frames` keeps runs separate
and the frame scheduler active during loading; the heartbeat stops before timing.

The map data is built locally (see [Building the map](#building-the-map)); nothing
generated is committed. The whole city (`?area=praha`) is the default, `?area=centrum`
the historic centre and `?area=ujezd` a small test area. The game's clock starts at the time in Prague
now, and the sun and the light follow it; `?time=HH:MM` and `?day=mon…sun` start it elsewhere, and `?night` at half past one
(with night-time parking). The start screen offers spring, summer, autumn and winter,
with Prague's current season selected. Its button uses today's Prague date; the other
seasons use 20 April, 15 July, 20 October and 15 January. The date stays fixed and is
kept in the save (`src/season.ts`): the sun, leaves, blossom and likely weather follow
it. `?date=MM-DD` keeps an exact date and `?season=spring|summer|autumn|winter` uses a
season's representative date. These links keep their date until a season button is picked.
The weather changes by itself every half hour or so of the game's clock;
`?weather=clear|cloudy|rain|storm|mist|snow` fixes it, and `?go` skips the start screen
(language, season, time, weather and sound). The real weather in Prague, from
Open-Meteo (`src/liveweather.ts`), is offered only for today's game date; other dates
start with weather chosen for that season. A game begun with it follows the real
weather as it changes, until you pick one yourself ([docs/live-weather.md](docs/live-weather.md),
which also covers ČHMÚ's open data as a source through the Worker). <kbd>P</kbd> steps through the weather.
`?osm` shows OSM footprints instead of IPR's 3D buildings, `?dev` opens the
developer panel, `?dialog` plays a sample conversation, `?menu` shows only the start screen without loading the map (quick to reload while working on the screen, the beta note or the signup form; the note then shows on every press of Start), `?touch` shows the touch controls on a desktop, a new game starts at one of ten places around the city picked at random (`STARTS` in `src/main.ts`) and `?start=lon,lat` starts somewhere else, and `?money=N` sets how much money you start with (10,000 Kč otherwise). The game is in English and Czech: the start screen has the choice (remembered for next time; the browser's language decides the first time), and `?lang=cs|en` sets it. All text is written in English in the code and looked up by that text in `src/cs.ts`, through `t()` in `src/i18n.ts`; a line with no Czech entry shows in English. The Czech is kept gender-neutral towards the player for now (see the note at the top of `src/cs.ts`). Elements in `index.html` marked `data-t` work the same way.
HTML hints use `tHtml()` to keep key formatting while escaping names inserted from
map and transit data; text content uses `t()`. `node scripts/check-display-text.mjs`
checks transit hints, developer search results and scenario reports in both languages.

Graphics (<kbd>G</kbd> cycles it, remembered in the browser):

| Setting | Ultra | High | Medium | Low | Lowest |
|---|---|---|---|---|---|
| Pixel ratio, up to the screen's own | 2 | 2 | 1.5 | 1 | 1 |
| MSAA on WebGPU | 4 samples | 4 samples | 4 samples | 4 samples | Off |
| Sun shadow map | 4096², softer edges | 2048² | 2048² | 1024² | 1024² |
| Dirt, grime, small leaves and tone curve | On | On | On | On | Off |
| Roof tiles and weathering | On | On | On | On | Off |
| Drifting mist, mist over the river, raindrops' rings in puddles | On | On | On | On | Off |
| Shadows in lamplight | Cars, people, trams, posts | Cars | Soft, cars | Soft, cars | Off |
| Lamps' light map | 2048² | 1024² | 1024² | 1024² | 1024² |
| Cones of light in the air, glints on cars and wet ground | On | Off | Off | Off | Off |
| Maximum crowd | 1200 | 1200 | 1200 | 1200 | 600 |

The sun shadow map covers just what is on screen, as the sun sees it, so shadows stay
sharp when you drive and when the sun is low. Street patterns and facade pictures
stay on at every tier. Quieter streets have
fewer people; changing tiers lets surplus people leave out of sight.
Auto, the default, starts High (Medium on touch devices) and moves between tiers
by how steady the frames are (`src/graphics.ts`), ignoring loading and tile builds;
it never picks Ultra, which only choosing it turns on.
`?graphics=auto|ultra|high|medium|low|lowest` overrides it for one visit; `?dpr=1` fixes
only the pixel ratio. The Water setting turns on waves, sun glitter and lamp reflections on
the river (`src/webgpu/water.ts`; WebGPU only, not on Lowest, off unless chosen;
`?water=on|off` for one visit). WebGL keeps MSAA on at every tier because it cannot change
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
  lost you: completing the ride clears all wanted stars, including when skipped. After midnight the metro is shut until about five.
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
  within about eight game seconds of arrival, at up to 12× speed. On touch screens
  the board shows the nearest departure; tap “Timetable” to expand the full list. Stops have blue-and-white plates with a black tram in side view
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
  it (kept in the saved game, never below 0). **PID ticket**: 46 Kč for 90 game minutes on
  trams, the metro and the Petřín funicular (the NH hotel's funicular is free). Nothing is
  bought for you: on a tram or the funicular you have 10 seconds to buy one (B, or "Buy a
  ticket" on touch) and then ride without; the metro asks "Going in without a ticket?" at the
  entrance. Riding without one risks an inspection (5% at each tram or funicular stop, 15% per
  metro ride): pay the 1,200 Kč fine (B) within 5 seconds or get off and run, and the inspector
  chases you on foot (`src/inspector.ts`). After 10 seconds, or at once if you get into a
  vehicle, they phone the police: one star, and if you're then arrested the fine is 1,500 Kč.
  Tickets stay valid across Sunday night; once expired, they cannot become valid
  again when the weekly clock repeats. At interchanges, the ticket choices remain
  available while any metro line is running.
  Taxis need money for the fare, and let you out when it reaches your balance. Shared bikes are
  paid as you ride (below).
- **Taxis**: on foot near a street, press T (on touch, "Taxi") and pick how to get one
  (`src/taxi.ts`): wave down a free taxi that is passing by, or order one through Zipp or Hopla, two
  made-up ride-hailing apps that cost less and whose drivers speed, tailgate and push
  through gaps. The nearest free taxi in the traffic (or a new one out of sight) drives
  to the lane next to you and waits 90 seconds; the hint says roughly how long it will
  be, and holding Space fast-forwards the wait. Press E beside it to get in, then a
  number (or tap) to pick one of ten well-known places (Old Town Square, Wenceslas
  Square, Main Station, Anděl, Prague Castle, Vyšehrad…). It finds its own way there
  along the one-way streets, sped up like a tram ride until the last 200 m, and you
  pay at the end from your money (a street taxi 60 Kč plus 36 Kč a km, the apps less; the meter shows in the hint, and a crash means a free ride). E gets you out
  early, and T cancels a taxi on its way. On touch, the same Taxi button changes to
  **Close taxi menu** while choosing and **Cancel taxi** while a driver is coming or
  waiting. Cancelling releases the driver without a charge; opening the menu again
  clears the old notice so you can book another taxi. As on a tram, the police can't arrest you
  in a taxi, and your stars fade twice as fast.
- **On a phone or tablet** on-screen controls appear (add `?touch` to get them on a
  desktop). The left thumb has a round stick: on foot, push it the way you want to go
  and you walk there (a full push runs); in the car, point it the way you want to
  drive on screen and the car steers round to it (reversing, the back follows it). Put
  your thumb down away from the stick and the stick moves under it. In the car, lane
  assist is a toggle above the stick, showing the speed limit it keeps to while it's
  on; the right thumb has the gas and brake (roll from one to the other without
  lifting), the handbrake and "Get out"; "Back on road" is top right, under the
  sound and settings buttons. On foot, “Jump” works even at a tram stop; waiting
  has its own button. Long HUD lists scroll within a compact panel. Pinch the map to zoom (`src/touch.ts`).
  Scroll over the map to zoom; scrolling a menu leaves the camera unchanged.
  Switching windows or apps releases held controls, including the horn and water
  cannon. Touch controls also release when the browser loses their pointer capture.
  Releasing a movement key in a developer field still stops movement; scenario
  `input-release` checks this and window focus in the running game.
- **Game controllers** (`src/gamepad.ts`): the left stick points where to go, the
  triggers are gas and brake, X gets in or out, A jumps or brakes, and Menu opens
  settings. In a panel, the stick or d-pad moves focus and A activates the selected
  control; left/right adjusts sliders and selection lists. Returning from another
  window requires releasing held buttons before pressing them again.
  When a dialog opens over another one, controls follow the front dialog.
  `node scripts/check-controls.mjs` checks focus, pointer and controller handling.
- **Sound and settings.** Two buttons in the top right corner: sound on or off (also
  M), and the settings, with the start screen's choices during play: language, sound,
  graphics (also G) and weather (also P). On a phone the credits are in there too
  (`src/settings.ts`).
  Settings, credits, privacy, newsletter signup and feedback pause the game while open.
- **Saved games** (`src/save.ts`): the browser keeps an automatic save and games
  saved by hand from the settings, including money and tickets. Saves are checked
  before continuing; damaged or unsupported saves stay listed so they can be
  deleted. Older saves without a date, radio station or broken-lamp state still
  open. A car type no longer available resumes on foot with the rest of the save
  intact. `node scripts/check-save.mjs` checks this without loading the map.
  Failed manual save changes show a message inside settings and keep the current
  game open. Loading, starting again or returning to the menu only restarts after
  the required storage change succeeds. Automatic saves stay quiet; failure and
  retry checks are in `scripts/check-save-failures.mjs`.
- **Getting in and out of cars** (`src/getin.ts`). Press E by a car and you go to the
  nearer front door, it opens, you duck in and it shuts behind you; E again and you
  get out the same way (on the other side if the driver's door is against a wall).
  Taking a car with someone at the wheel: from the driver's side you reach in and
  haul them out onto the road, from the other side they get out of their own door
  and run. Press E again on the way to the door to change your mind. A car that is
  still rolling faster than a walk is left at once, without the door, and vehicles
  built from boxes (buses, lorries, the fire engine, the ambulance) have no door to
  swing: you step up to the cab and in.
- **Lamps.** A hard knock (from about 16 km/h) smashes the headlamp or tail lamp it lands
  on, which then stays dark and lights nothing at night; the headlamps behind a police
  ram frame never break. The tail lamps light up when a car brakes, by day as well
  (`knock` in `src/car.ts`, the pools of light in `src/lamps.ts`).
- **Police.** Knocking people over, pulling drivers out of their cars, wrecking
  traffic, ramming or stealing a police car and speeding past the police (20 km/h over
  the limit) earn stars, up to five; crimes the police see count three times as much.
  Police cars chase you along the streets and ram you; some carry a ram frame on the
  nose, more of them the more stars you have. When you're on foot they stay
  on the road and stop at the kerb nearest you; then (or when you stop the car) an
  officer gets out (their door stays open till they're back) and runs after you, to
  your door if you're in a car, and if they reach you, you're busted (the
  police keep the car). The arrest is played out (`src/arrest.ts`): the officer opens
  your door and has you out of the car, your hands go up, they step behind you and
  put the handcuffs on, and you're walked to their car and put in the back, while the
  other officers stand round and nobody shoots. The screen fades to black on the way;
  you are then taken to the station and the picture fades back in. You can outrun them on foot, or take the police car they've
  left behind (E) and drive off in it. Its blue lights keep flashing while you're at
  the wheel, even when stopped, and switch off when you get out. From three stars a helicopter
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
- **Ambulances.** A person hit by a car going faster than about 30 km/h, by a tram you
  drive, or caught near a blast stays on the ground instead of getting up after a few
  seconds; so does anyone a stray police bullet hits on the pavement. An ambulance is
  called from a few hundred metres away, drives to them by the streets (and through
  pedestrian zones, as the fire engine does) with blue lights and a quick two-tone
  siren, and its two paramedics get out and see to the patient for about nine seconds.
  Someone only hurt gets up and walks on. Someone badly hurt (a car faster than about
  48 km/h, a tram, a close blast, a bullet) is carried to the back of the ambulance by
  the two paramedics and driven away. Someone nobody comes to gets up on their own
  after four minutes. You can take an ambulance like any car (a carjack; the paramedics
  who are out run after you for a while). The developer panel's "Leave the nearest
  person hurt" button is the quickest way to see it (`src/ambulance.ts`,
  `scenarios/ambulance.ts`).
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

The [findings for optimisation plans 007–012](docs/optimisation-findings-007-012.md)
record the measurements, merge decisions and pending landmark asset activation.

- **Procedural look.** The ground is real geometry, one mesh per surface kind
  triangulated from OSM and coloured by world-space GLSL patterns (`src/shading.ts`,
  `src/surface.ts`): asphalt, granite setts, slabs, grass,
  water. Rails, zebras, lane markings and parking-bay outlines are thin strips on top.
  The general pavement is asphalt grey; slab squares are lighter, and park paths stay
  warm. Squares use their own OSM `surface` tag where one exists. Otherwise, a clear
  majority of mapped pedestrian and service ways crossing the square can supply its
  surface; Old Town Square takes the setts mapped on the ways through it. Walking
  routes add no ribbon over a square of the same material; cobbled
  footways use setts, and island/link routes leave the pavement clear while keeping
  real path sections through lawns. A named
  square's outline keeps its mapped lawns and ponds, with real paths through them.
  Surveyed and inferred lawns receive the same treatment; a link paved differently
  from the square remains visible.
  These surface rules leave the walking network and street kerbs alone. The city's
  technical map supplies ground-level courtyards, maintained green, gardens, pitches
  and woods where OSM has no more specific surface. OSM ground and roads draw above
  those surveyed shapes. Inside Prague the pavements come from the same map
  (`pipeline/pavements.py`): each one from the kerb to the wall as surveyed, with the
  traffic islands, medians and tram-stop platforms, paved with what OSM's footways on
  it say (Prague's pale mosaic, asphalt, earth for a park's path, setts for a cobbled
  walking street; one that says nothing is paved like its nearest neighbour). The
  footways' own 3 m ribbons are left out where they run on a surveyed pavement, so
  only paths the survey doesn't have keep one, with square ends: through parks,
  across estates and past the city limits. Mapped squares and car parks keep their
  own paving, and a block's gardens start behind the pavement. Where the trams have a
  bed of their own beside the street it is ballast. `DERIVED_PAVEMENTS=1` builds the
  ground without any of this, to compare. Rebuild the `ground` layer for these changes; use
  `pipeline/beige_report.py` to measure the remaining unmapped ground in an area's tiles.
  Land that OSM gives a use but no surface still gets one: fields with crop rows
  (farmland, nurseries), concrete work yards (industrial land, garages, farmyards),
  gravel ballast on railway land, and bare earth on building sites, brownfields and
  quarries (`_area_kind` in `pipeline/osm_area.py`).
  Pitches, courts, playgrounds and running tracks take their colour from what OSM says
  they are made of (`leisure`, `sport`, `surface`): grass, artificial turf, clay, sand,
  a red running track, or a grey, blue, green or red hard court. Where no surface is
  tagged, size and sport decide, and the colour of a hard court is picked from the
  feature's id so it never changes. Courts of a standard size get their lines (tennis,
  basketball, volleyball, handball and futsal halls, football pitches), and a track
  mapped as a centre line becomes a band of lanes with grass inside (`pipeline/sports.py`;
  the lines are the tile's `marks`). The looks and colours are in `src/map/pitches.ts`.
  OSM rarely maps the gardens and lawns in a suburb or a housing estate, so a street
  block of family houses, or of flats with plenty of room round them, gets grass
  between the buildings (`_gardens` in `pipeline/osm_area.py`); denser inner-city
  blocks, shops, offices and schools stay paved. Gardens get a few trees and shrubs,
  scattered by where they are so they're the same every visit, clear of the houses,
  paths and the trees already there (`gardenTrees` in `src/map/vegetation.ts`).
  The mapped trees (IPR's survey and OSM's) are as tall and as wide as the surface
  models show them, with their crown's outline and its colour in IPR's summer photo
  (`pipeline/tree_sizes.py`). The trees made up in woods, parks and gardens stand only
  where the photo shows leaves, as high as the canopy there; where it shows a crown no
  mapped tree covers (a courtyard, a private garden) one is made up for it.
  Buildings get roof tiles laid down
  each face's slope, slate and gravel on flat roofs. It all stays sharp at any zoom.
- **Facades** are put together bay by bay and storey by storey from 144 parts: windows,
  doors, gateways and shopfronts in thirteen looks (`src/facades.ts`): three for
  19th-century tenements (neo-Renaissance, Art Nouveau and the plain houses of Žižkov
  and Karlín), houses of 1912-1925, baroque houses and plainer burgher houses, functionalist
  blocks, the plain post-war houses and Socialist Realism of 1939-1953, infill since the 1990s, panel housing as built and as insulated since, and
  family houses. A building's style and looks come from its age where IPR's data has it
  (`pipeline/building_age.py`: Art Nouveau mostly for tenements of 1890-1914, for
  instance), else from where it stands and how tall it is: baroque in Old Town, Malá
  Strana and Hradčany, panel housing for tall blocks far out, family houses under about
  8 m, tenements with some functionalism elsewhere. All walls of a building take the same
  look; on panel blocks the loggias and staircase windows run up in columns, and on
  nearly half the older houses the stucco round the windows is a paler shade than the
  wall (a mask of it, `public/facades-mask.webp`, is made with the atlas). Window axes are about 3 m apart, as in a Prague tenement, with plain plaster
  between the windows, and floors are as tall as the style's (a tenement's 3.7 m over a
  4.4 m ground floor, a panel block's 2.85 m), stretched a little so that whole floors
  fill each wall up to its cornice. Party walls (a building's side wall standing
  back to back with its neighbour's, and showing where the neighbour is lower) are
  plastered without windows. Each building gets its own plaster colour: mostly ochres,
  yellows, creams and stone-like sands and greys, with a few pale greens, pinks and
  blues, mixed differently for each style. The parts were
  drawn by an image model as twelve sheets, each asked for with an earlier sheet as a
  style reference (the briefs are next to them in `assets/facades/`; the fifth, the
  tenements' windows and portals, after a neo-Renaissance house in Mělnická), and are
  cut and packed by `assets/facades/build_atlas.py`. Phones and tablets load them at half size.
- **Portraits and the loading screen.** Characters are half-length portraits drawn by
  an image model, ten to a sheet, and cut apart by `assets/portraits/cut.py` into
  `public/portraits/` (the sheets never line up, so the seams are found per row); faces
  that came out too alike were regenerated one at a time (`assets/portraits/faces/`). The
  loading screen puts three of them in front of a skyline of a real view, drawn from
  the 3D city by `pipeline/skyline.py`, with poster shapes over the panels' cut edges;
  its skyline follows the selected season, time and weather, including a saved game's
  date when continuing it;
  a conversation shows the speaker rising out of a frame (`src/portraits.ts`).
- **Weather** (`src/weather.ts`): clear, cloudy, rain, a thunderstorm, mist or snow,
  each a mix of cloud, rain, storm, snow and mist that the weather moves between over
  half a minute. In a storm the rain drives in on the wind, and lightning flickers
  every few seconds and thunders a moment later. It
  picks the next one every 20 to 60 minutes of the game's clock, by the game's date (rain in
  summer, snow in winter); a picked weather stays.
  Mist is marked **beta** on the start screen and is available only through an
  explicit choice. Automatic seasonal picks, live weather and restored automatic
  weather substitute Cloudy for Mist while it is in beta.
  Picking weather in the developer panel applies it immediately, including rain,
  mist and the ground's wetness or snow cover, even while the simulation is paused.
  The P key and the ordinary settings retain the gradual transition.
  Clouds hide the sun and fade the shadows, and the sky's light turns grey by day and
  orange from the city at night (`src/sky.ts`). Rain falls as streaks and snow as
  flakes in a box round the view that stays put in the world, so you move through
  them; mist lies in drifting banks in the streets (a stack of sheets up to 7.5 m, so
  the roofs stand out of it) with clear air between them. The developer panel's
  **Mist → Mist shape** also offers **Local volumes** on WebGPU (`?mist=volume`,
  or `?mist=sheets` to force the original mode). These are separate terrain-following
  banks, about 40 × 28 m and 0.15–2.2 m above ground, with drifting 3D noise and soft
  edges (`src/localmist.ts`, `src/webgpu/localmist.ts`). Each ray uses 8–16 samples
  (12 by default) and stops at opaque scenery using the viewport depth. All banks
  share one draw and one depth copy; they render at the game's resolution. Banks
  over water are wider and three times denser, with a gentler increase along the
  banks. Their placement follows the loaded water polygons and the water surface,
  rather than bridge or quay height. **More mist over water** adjusts this effect;
  zero restores the same scattered banks as on dry streets.
  Width, spacing, height, density and sampling are adjustable and saved in this browser;
  Reset restores both modes' defaults. The legacy WebGL renderer retains the layered
  banks. Saved tuning values are limited to each control's range; invalid numbers
  keep the defaults (`node scripts/check-mist-settings.mjs`).
  `node scripts/check-local-mist.mjs` checks wall occlusion, viewing a bank
  from inside, MSAA changes, resizing, stable placement and denser river mist at
  water-surface height in the real WebGPU renderer.
  The fog of
  rain and snow is measured from the camera so the ground is hazier than the roofs. The
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
  underpasses (`pipeline/build_lamps.py`), with the lamps of IPR's second layer (the
  documentation of finished works, which fills whole neighbourhoods the survey misses)
  and those only OSM has. A lamp the layers put on a post in a roadway hangs over
  the street on cables instead, or stands on the kerb beside it. Where there are still none, the game adds its own on lit
  streets and paths: hung on cables between houses that stand close, on poles
  elsewhere, small globes along footpaths. Lit means tagged lit in OSM, or untagged
  with a lamp near, with buildings along it, or on the way (300 m at most) from such a
  stretch to the next lit street (`pipeline/street_lighting.py`, `lit.bin.gz`). Streets
  tagged dark and roads between fields stay dark. Round the view the lamps get a pole and a glowing head,
  and every lamp and every driving car's headlights and rear lights add a pool of
  light to a light map: a texture over the view, drawn from above each frame. The
  ground, walls, trees, cars and people read their light from it by position, so the
  light costs one texture read a pixel however many lamps there are; its alpha keeps
  the height of the ground under the lamps, so their light stays off the roofs. Cars
  cast shadows into that map, so it is drawn a second time at a quarter of the size
  with nothing in the way, and what stands more than about 3 m above the lit ground
  (a tree's crown over a parked car) takes its light from that copy instead. The
  lamps come on at dusk (earlier under heavy cloud), and a share of the windows is lit
  by the hour, most in the evening.
- **Tiles.** The map streams in 250 m tiles (`src/tiles.ts`) around the camera. Each
  tile has its own ground, buildings, tree-page leases, collision grid, parked cars and piece of
  the street graphs (joined across tiles by OSM node ids), so start-up doesn't depend
  on the area's size. A tile's files are fetched all at once, and the heavy part of
  building it runs in web workers (`src/tileWorker.ts`): the ground's geometry
  (`src/ground.ts`), IPR's buildings, the roofs of OSM buildings (on their straight
  skeletons, `src/map/skeleton.ts`), the
  windows' positions on every wall, trees, walls and the collision grid. The main
  thread joins up the street graphs, makes the meshes and parks the cars.
  A tile is loaded in two stages. The city's traffic and people live up to 300 m from
  you, so every tile within about that distance gets its collision grid, heights,
  bridges and tunnels, fences, poles, street graph and parked cars (`make`, one worker
  job, about 0.1 s). Its ground, buildings, trees and sky view are made only when the
  tile comes within 100 m of the edge of the view (`dress`, `drawBeyond` in
  `TileWorld`, about half a second of worker time) and taken away again 40 m further
  out (`undress`), while the tile itself stays loaded. On foot that is about 6 of the
  14 loaded tiles. Zooming out, the tiles are drawn for the height the camera is
  heading for; the developer panel's free camera draws everything loaded.
  `src/tileWorkers.ts` dispatches one job per worker and gives required tile jobs
  priority over optional neighbour lighting. `src/skyRefresh.ts` coalesces lighting
  refreshes and ignores stale results; the worker-count default is unchanged.
- **Buildings** come from IPR Praha's open 3D model (CityGML LOD3: real roofs, towers
  and domes), which covers the whole city. OSM buildings that the model doesn't have
  (newer ones, sheds, anything past the city limits) are extruded from their footprints.
- **Trees** are IPR's surveyed ones (about 171,000 on city land, `pipeline/ipr_trees.py`)
  plus OSM's; where both have a tree within 2.5 m, IPR's stands. IPR says which are
  conifers and which fruit trees, and so does OSM sometimes (`leaf_type`, `genus`).
  Conifers are their own shape (`pineGeometry` in `src/map/vegetation.ts`, evergreen in
  winter), fruit trees are small. The woods, parks and gardens are filled up with made-up
  trees, 30% of them conifers in woods, but not next to a surveyed one; young woods (see
  "Young woods" under Unmapped ground) get small, dense ones. The dark woodland floor fades out
  over the grass beside it (`woodEdges` in `src/ground.ts`). Rebuild them with
  `uv run build_tiles.py <area> --layers ground`, then `ipr_terrain.py <area>`.
  Rendering keeps fixed-capacity mesh pages per tree shape (`src/trees.ts`). A tile
  leases pages containing only its own trees; unloading the tile clears the pages
  for reuse without changing the surveyed or generated tree data. Pages hold 1,200
  broadleaf or 128 shrub/conifer instances. Startup prepares 30 broadleaf, 20 shrub
  and 24 conifer pages; a denser view can add pages without dropping trees.
- **Landmarks** (so far Mánes with Šítkovská vodárenská věž, the Týn Church, the Old Town Hall with its tower, St Nicholas at Old Town Square, the National Theatre, the Rudolfinum, the Municipal House with the Powder Tower, House Okamura in Břevnov, and the Dancing House, which is the mesh as it is, since the city model has it as a plain prism without the legs you walk between) are cut out of IPR's
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
  night. The collision footprint stays OSM's. `pipeline/landmark_colours.py` writes a
  separate `.warm-v1.glb` final model with the photograph's warm-colour adjustment
  baked in; the active GLB scene carries `landmarkColourVersion: 1`. The browser skips
  its pixel pass for that marker and still adjusts older unmarked GLBs. The output
  manifest references the versioned files. To convert existing assets without
  rebuilding geometry, run `uv run --project pipeline python pipeline/landmark_colours.py
  --area-root public/data/centrum_now --output-root /tmp/sop-landmark-colours/centrum_now`
  (add `--dry-run` to validate without writing). Keep the old GLBs and original
  manifest until the new app is live: an older client would adjust the warmed files
  again. Review the staged manifest and assets before activating them in shared data.
- **Roof colours.** Pitched roofs are terracotta tiles (a palette matched to reference photos of Prague's roofs, brick-red rather than orange, with each tile a little redder or duller than the next; the landmarks' photographs get the same warming in the final GLB, or on load for older models, and where a landmark's photograph shows a red roof, the roof shader draws the same tiles at the photograph's brightness: `shadeLandmark` in `src/shading.ts` and its port in `src/webgpu/buildings.ts`), as nearly all of them are in Prague;
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
  only a little are evened out; unsure walls take the colour of a measured neighbour they share a wall
  with (`borrow_walls`), else the palette. The facade's style comes from the building's
  age (IPR's Stáří zástavby, `pipeline/building_age.py`) where that is known. At the High
  graphics setting roofs also get aerials, chimney pots, small dormers and thicker moss
  (`src/map/roofClutter.ts`, `?clutter=on|off`). In the cold months and under snow one chimney
  in five lets out a wisp of smoke (`src/chimneySmoke.ts`). A roof cover given in
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
  ways and through junctions (Blanka's underground ramps).
  Components containing only bridges and finite anchors use a distance-weighted
  harmonic graph solve, linear on chains and continuous at junctions. Components
  containing a tunnel or an unknown anchor retain the previous two-nearest model,
  so an out-of-map portal cannot erase a supported tunnel interior. Selection uses
  every way in a component, preserving bridge/tunnel joins. See
  `docs/bridge-height-continuity.md` and `docs/tunnel-propagation-compatibility.md`.
  Bridge continuations are resolved across chunks before a loose end is tied to
  the ground. Explicitly mapped different decks remain separate even where their
  inferred heights are close, while a shared OSM node keeps a physical join.
  Rebuild affected `streets` chunks and then terrain for these rules; old street
  caches remain readable, and mixed old/new records in one connected bridge
  component require a streets refresh before terrain can be built. See
  `docs/bridge-contact-results.md` for evidence and remaining height limitations.
  Bridges follow IPR's 3D
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
  When the game replenishes people and ordinary traffic, it prepares each nearby
  street's spawn weight once for that pass (`src/spawn.ts`). Cars still check the
  current traffic before each placement, and pavement-driving cars are gathered
  before each pedestrian-obstacle step.
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
  Rental time and fares continue across the weekly clock rollover; a lost bike pays
  its final interval before cleanup ends the rental. Stations with unknown operators
  or invalid pricing plans do not offer bikes. `node scripts/check-bikeshare.mjs`
  checks rental accounting and cleanup offline.
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
  and clips for standing, walking, jogging, running, jumping, falling, getting up,
  riding, getting into a car, hauling someone out of one, and an arrest (hands up,
  handcuffed, led away, and the officer's side of it), plus a bike and a motorbike. The walk, jog and run place the feet first (on
  the ground they stay put, rolling from heel to ball) and reach them with the legs;
  in the game the two gaits either side of someone's speed are blended, in step. At
  load, `src/figures.ts` plays every clip through and bakes the posed vertices into
  textures, so the whole crowd is one instanced draw call. Rebuild with `blender -b --factory-startup -P assets/figures/build.py`; add
  `-- --preview DIR` to render a few frames of every clip.
- **Cars** are built the same way (`assets/cars/build.py` → `public/cars.glb`): one
  low-poly body per type (hatchback, saloon, estate, SUV, van, pickup, taxi, police), shaped for
  the view from above, where the bonnet, cabin, windows and roof show, with a little
  of the sides, wheels and lights towards the edges of the screen. `src/car.ts` puts
  each car's colour on the paint. The doors are objects of their own in the file
  (`<type>_door1` to `4`, each with its origin on its hinge), and inside there is a
  floor, walls and seats to see through an open one. In the game they are still part
  of the body's one geometry: each vertex carries its hinge and door number, each car
  how far its four doors are open, and the vertex shader turns the door (`Car.open`,
  `webgpu/vehicles.ts`). The bus is built from boxes in `src/car.ts`. Rebuild with
  `blender -b --factory-startup -P assets/cars/build.py`; `-- --preview DIR` renders
  them from above. During loading, `CarPool.prepare` creates one body per type
  and separate courier-box variants without consuming the game's random numbers.
  Each body keeps a 128-car instance page, covering the measured peak of 104
  hatchbacks. Paint is a linear per-instance colour applied only to vertices marked
  as painted; glass, tyres and courier boxes retain their fixed colours on both
  renderers. Empty pages stay hidden, and denser views get another retained page,
  so no visible car is dropped. New shared-bike or custom colours use the existing
  type page; the first burnt body of each type gets its own page when first seen.
  Check preparation, page reuse, paint uploads and renderer behaviour with
  `node scripts/check-car-pool.mjs --url http://localhost:5191/ --case all` against
  a running dev server. Add `--baseline http://localhost:5192/` with a pre-plan-015
  server to compare every palette/box combination vertex by vertex, burnt colours,
  and an order-independent hash of 1,000 seeded cars. See
  [plan 015](plans/015-paint-cars-per-instance.md) for measured draw counts.
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
  tram up for 15 seconds gets pushed aside, slowly. A blocked traffic car gets 30
  seconds to clear the track, or 12 seconds outside the view, before the same recovery.
  A player-controlled car is never selected for this recovery. They're the types Prague runs, about
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
- **Surveyed walls, fences and railings** (`pipeline/dtm_walls.py`): where the technical
  map's survey covers a tile (30 m of its lines or more), its walls ("Zeď"), fences
  ("Plot") and railings ("Zábradlí", set 3, in `pipeline/.cache/dtm/ZPS_KR/`) stand in
  place of OSM's fences, of the fences made up round family houses, and of OSM's walls
  where the survey has a wall within 2 m (a thick garden wall is two outlines in the
  survey, which aren't used, so OSM's stays). They carry `"s": 1` and a height in the
  tile: an enclosing wall is 2 m, another 1 m, a fence 1.5 m, a railing 1 m (the map has
  no heights for them). Every wall and fence in such a tile is cut where something goes
  through: on the streets' and paths' surfaces, across each mapped street and path, in
  passages through buildings, at the gates of family houses' plots and within 0.8 m of
  a building. OSM's town walls, the crash barriers and the hedges stay (a hedge along a
  surveyed line goes). Outside the survey everything is OSM's.
  `uv run dtm_walls.py <area> --tiles --before <old tiles folder>` counts the metres per
  tile, and with `--crossings` the graph's edges and the gates that a wall or a fence
  closes. Rebuild the `ground` layer to get them, then `ipr_buildings.py` and
  `ipr_terrain.py`, which depend on it.
- **Crash barriers** are a third kind of the same sections (`kind: "guard_rail"` in a
  tile's `fences`): a steel beam 0.75 m high on a post every 2 m. They come from OSM's
  `barrier=guard_rail` where it is mapped, and elsewhere `pipeline/barriers.py` puts them
  along both edges of every motorway and expressway carriageway on the ground (the outer
  edge and the central reservation), open where another road's surface meets it; slip
  roads, bridges and tunnels get none of their own. A car meets a barrier as a line, not
  as a row of posts: drifting into it, even at motorway speed, it scrapes along and is
  turned back, and it breaks through only when it comes at the barrier's face at more
  than 50 km/h, which costs half of that speed. On foot a barrier stops you unless you
  jump. `scripts/check-guard-rails.mjs` checks all of that. Needs the `ground` layer
  rebuilt, like the fences.
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
- **Car radio.** While driving a car, use R to cycle stations or the controls under
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
  then along the kerb (`src/parking.ts`). Outside the paid zones (most of the east and
  south of the city and everything past the city limits) each spot's chance of a car
  comes from the buildings within about 60 m (`src/parkingDemand.ts`): the floor area
  (footprint × storeys) of flats and tenements, terraced and mid-rise houses, family
  houses and places of work, taken from the tile and its eight neighbours. Flats fill
  the street (about 90 % day and night), family houses keep their cars on the plot
  (about 30 %, so 15–25 % on a sparse villa street), offices, shops, halls and
  factories fill by day and mostly empty at night (70 % and 30 %), and where little is
  built the share falls towards nothing; more building round a spot raises it (floor
  area to the power 0.3, capped at 115 % of the typical street). A mapped car park is
  a third fuller than the kerb beside it, and one with no building in reach keeps 8 %.
  Paved ground that OSM maps no car park on (yards round halls and shops, from the
  technical map) becomes an inferred lot, `lots` with `"i": 1`, laid out in rows with aisles.
  The rates are measured against TSK's own counts: `scripts/parking-demand-sample.py`
  and `scripts/check-parking-demand.mjs` set the rule against the 3,183 sections with
  both occupancies. TSK's medians run higher than the rule for family houses (about 50 %
  against 24 %), because paid zones exist where parking is scarce and the cars here
  would otherwise stand in driveways (family-house plots now get a car on the drive: 30 % by day, 55 % at night, `drives` in the tiles); for flats they run a little
  lower (77–80 % against 83–89 %). Nothing changes inside the paid zones; `?oldparking`
  brings back the old flat 20 % / 45 % for comparison. Bay lines are painted as Prague paints them,
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
from (geometry helpers, buildings with roofs on their straight skeletons, trees).
The skeleton is the game's own code (`src/map/skeleton.ts`); `scripts/check-skeleton.mjs`
tests it, and `scripts/roof-compare.mjs` measures every such roof in a sample of tiles so
that two versions of the roof builder can be compared.

## Known issues

- **Bridges and tunnels.** A bridge IPR's model doesn't have (a newer one) slopes
  evenly from one end to the other, and tunnels' depths are a guess (OSM has none).
- **Past the city limits** the buildings come from OSM, and where OSM gives neither a
  height nor a number of storeys, the height is a guess from the kind of building and
  the size of its footprint (sheds, cottages, one- or two-storey houses, halls). The
  terrain there carries on flat at the height of the nearest ground IPR has.
- **The countryside past the map's edge** (`?countryside`, a trial: plan 021) is made in
  the browser from OpenStreetMap vector tiles as you drive out: streets, land, water,
  woods and extruded buildings, plainer than the map. Its streets carry on from the
  map's own at the junction each of those ends at, its ground swings from the map's
  edge to real hills over 500 m and is level across roads, traffic and people are as
  thin as the place, and the title names the town or village. Bridges and tunnels
  follow the ground (a motorway bridge runs along the valley floor), water lies on
  whatever slope the elevation data has, there are no lamps, trams, buses or parking
  out there, and it needs a 300 MB file of central Bohemia beside the map
  (`VITE_COUNTRYSIDE_URL`) and Mapzen's elevation tiles at AWS. Not measured on a phone.
- **Parking doesn't fit.** About 30 % of the cars TSK counts don't fit into the
  narrow streets (without standing in the traffic lane) and are left out.
- **Angled and perpendicular parking along the kerb** past the city limits stands just
  outside the carriageway, since OSM street widths usually leave it out. Where the
  pavement there is narrow, the cars end up on it; where a building is in the way,
  they're left out. (In Prague the technical map's parking bays are part of the street.)
  Inside car parks, away from any street, angled bays slant an arbitrary way.
- **Street widths past the technical map** are guessed from the class and the setting
  (family houses, blocks of flats, open land), cut to the room between the buildings,
  and not from the class alone: a village street is about 5.5 m and under 4.6 m cars
  take turns slowly (`pipeline/lanes.py`, plan 031). Through roads there have a gravel
  shoulder, and the land nobody mapped beside them is rough grass, a verge
  (`pipeline/verges.py`), with a pavement only where OSM tags one (`sidewalk=*`).
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

## Building the map

<!-- read_when: rebuilding map layers, changing pipeline caches, or validating staged map generations -->

Requirements: [uv](https://docs.astral.sh/uv/), Node.js, and for a local OSM extract
`brew install osmium-tool`.

```bash
cd pipeline
uv run build_parking.py centrum    # TSK paid-parking sections (read by build_tiles)
uv run build_tiles.py centrum      # today's map + street graphs in tiles → public/data/centrum_now/
uv run mesh_colours.py centrum     # real roof and wall colours from IPR's photo mesh (optional)
uv run ipr_buildings.py centrum    # IPR's 3D buildings into the tiles
uv run ipr_terrain.py centrum      # IPR's terrain, bridges and tunnels, hill shading
uv run --group cover ground_cover.py build centrum   # what the unmapped ground is made of, from aerial photos (optional)
uv run build_lines.py centrum      # tram lines from OSM's route relations → lines.json
uv run build_metro.py centrum      # the metro from PID's timetables → metro.json
uv run build_buses.py centrum      # bus lines and stops from PID's timetables → buses.json
uv run build_footfall.py centrum   # how busy the streets are → footfall.png
uv run build_lamps.py centrum      # street lamps from IPR's utility map → lamps.bin.gz
uv run ipr_greenery.py build centrum  # IPR's surveyed lawns, shrubs, hedges and flower beds into the tiles (optional)
uv run ipr_utility.py build centrum   # manhole covers, storm drains, traffic-light poles into the tiles (optional; before build_signals.py)
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
- **Staged rebuilds and resume.** For a complete rebuild, work in an isolated copy
  with its own writable caches and output; keep the active map in place until the
  new generation has passed validation. No other pipeline job should write to that
  copy. From its `pipeline/` directory, run this sequence for each required area:

  ```bash
  uv run build_tiles.py praha --jobs 4 --resume --no-assemble
  uv run ipr_buildings.py praha --jobs 4 --no-assemble
  uv run ipr_terrain.py praha --jobs 4 --no-assemble
  uv run layers.py praha --strict
  ```

  Repeat for `centrum` and `ujezd` when needed. `--resume` is opt-in: it skips only
  chunk layers with matching grid, source identities, processing code, library
  versions and output hashes. Missing, damaged or interrupted outputs are rebuilt.
  Local OSM cuts also track their parent source and requested box; replacing the
  country extract invalidates its area and chunk cuts. Overpass builds cannot reuse
  completed OSM chunk layers through resume because they lack a local source identity.
  Ordinary commands still rebuild the requested layers and assemble immediately.

  `--no-assemble` defers tile JSON and index assembly; IPR binaries are still written
  inside the isolated output. `layers.py --strict` checks chunk completion, the full
  grid, current local dependencies, IPR/terrain completion and binary hashes before
  writing assembled tiles. It requires both IPR stages and the new completion
  records, so old caches must be rebuilt once. Validation does not activate or deploy
  the result; switch the complete validated generation separately.

  IPR buildings depend on OSM buildings **and ground-water polygons**; terrain
  depends on ground, streets and IPR bridge data. Rebuild the affected IPR stage
  after those inputs change. Copying sources to another location conservatively
  invalidates their caches: large sources use path, size, mtime and ctime rather
  than hashing the whole country extract on every invocation.
- **Build measurements.** Each builder reports preparation, processing, writing,
  assembly and complete command durations. OSM chunks also report extraction laps
  (DTM streets, kerbs, cobble assignment, land unions and gardens), feature counts,
  cache hits and worker peak memory. Chunk results print as they finish; IPR sheets
  retain deterministic processing order. Worker durations overlap and must not be
  added together as whole-build time. Peak memory is the process lifetime maximum.
  For throughput comparisons, keep source data and settings fixed, distinguish cold
  and warm caches, and compare complete command durations after other builds finish.
  The earlier timings below are historical, not a measurement of the current pipeline.
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
- **Steps in the ground.** IPR's terrain model has a point about every 10 m, so on its
  own a quay wall or a retaining wall is a broad ramp. `pipeline/dtm_heights.py` corrects
  the grid from the technical map's survey (DTM ZPS: its lines carry heights): streets
  take the heights of their own kerbs, water its level, and the ground beside a bank or
  a retaining wall the height it has clear of the ramp. Original street vertices more
  than 30 m from the bare terrain are rejected before interpolation; their attached
  segments are skipped, keeping gross source errors from spreading into the ground.
  Separate components of a survey line stay separate. The survey log reports rejected
  vertices. See `docs/river-terrain-findings.md` for the checks and remaining limits.
  Each grid point also has a label
  (plain ground, water, or a terrace at a retaining wall's foot, whose outline is in the
  tile's `terraces`), stored after the heights in `<tile>.height.bin`. Where the labels
  in a grid cell differ, the game reads the height at a point from the corners with that
  point's own label (`heightSampler` in `src/terrain.ts`), cuts the ground's layers
  along the actual outlines (`src/terrain-cut.ts`, including enclosed terraces and
  holes) and puts a wall there (`src/ground.ts`). Cuts on the same level are merged
  before triangulation so temporary line extensions cannot introduce tile-edge
  cracks. Map format 2. It works
  on arrays over the whole area (a few GB and about a quarter of an hour for `praha`).
  Bridges come off the street above a quay wall, not the quay below it
  (`abutment` in `pipeline/structures.py`). Ground pulled to a nearby bridge also
  shares the same bridge support at tile-edge lattice points, even when the drawable
  bridge polygon appears in only one tile. Separate deck levels keep their existing
  pull order; conflicting support is rejected before export. See
  `docs/bridge-ground-edge-diagnosis.md` for the source comparison.
  The top of a step that drops 0.8 m or more stops cars and people (`src/stepEdges.ts`:
  solid in the tile's collision grid, with a low parapet; a quay less than 2.5 m above
  the water has none, the water stops you there). The edge is open over the width of
  each street, path or stairs on the ground that crosses it. `node
  scripts/check-step-edges.mjs <area>` counts the edges and lists the car streets that
  cross the highest drops (places where the terrain or the map is wrong);
  `?nostepedges` turns the edges off.
  Where the rules make a place worse than the
  terrain model alone (seen in the game), list it in `pipeline/terrain_keep.json` (a box
  in degrees and why) and it stays as the terrain model has it.
  Rendered tile edges also share a world-aligned 2 m height profile and perimeter
  stations (`src/terrain-edges.ts`), including tiles without steps, so differing
  clipped-outline refinement cannot open a gap on a curved slope. This changes
  edge geometry, not the stored lattice or gameplay height sampler.
- **Caches.** Every OSM chunk and every IPR sheet is read only once. What comes out
  is kept (`pipeline/.cache/osm/*.parsed.pkl`, `pipeline/.cache/ipr/parsed/`) and read
  again only when the source changes. Chunks and sheets are worked on side by side
  (`--jobs`, by default two fewer than the machine has cores, capped at eight).
  IPR XML parsing in source coordinates is also kept in `.cache/ipr/source/`, shared
  between the three areas; building rings are streamed to keep peak memory down.
  Projection, triangulation, tile packing and terrain rasterization remain
  area-specific. This adds disk usage and a cache write on the first parse, while
  later areas reuse the parsed source. DTM streets and land share one load per
  worker, and kerb width and survey coverage share samples for the same road lines.
  Buildings-only extraction skips DTM and unrelated feature geometry.
  Run the synthetic pipeline regression tests without rebuilding map data:

  ```bash
  cd pipeline
  uv run python -B -m unittest discover -s . -p 'test_*.py'
  ```
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
  kept in `pipeline/.cache/mesh/`; compressed responses are checked before caching.
  A cached gzip that fails to decode is fetched again and replaced only after a decodable
  response; failed retries leave the previous file intact and stop the build.
  The finest level (16) is the default. How to add one, check it and fix what goes
  wrong: `.agents/skills/landmarks/SKILL.md`. The
  generated final manifest names `.warm-v1.glb` files; originals remain beside them.
  `--rebake` bakes again from the inputs kept in `pipeline/.cache/landmarks/` after a
  change to the bake. A wall's lowest metres that no photograph shows repeat the wall
  above them, and `PAINT_OVER` marks roof spots where a tree is painted over
  (`pipeline/landmark_fill.py`).
  Repository skills live in `.agents/skills`; `.claude/skills` is a compatibility symlink.
- **Mesh colours.** `mesh_colours.py <area>` needs the area's IPR sheets parsed
  (`ipr_buildings.py` once) and writes `pipeline/.cache/mesh_colours/<area>.json.gz`,
  which `ipr_buildings.py` reads (`--mesh-colours off` to leave it out). It downloads the
  mesh at level 13 (about 110 MB for `centrum`, into `pipeline/.cache/mesh/`, shared
  with the landmarks) and level 14 for the roof windows (about 2 GB for `centrum`;
  `--no-windows` skips it), and measures tiles side by side (`--jobs`); `centrum` takes
  about 15 minutes. It saves every 100 tiles, and `--resume` goes on after a stop (for
  the whole city, a night's run). `ipr_buildings.py --no-roof-details` leaves out the chimneys and
  roof windows. `--windows-only` keeps the table's colours and only finds the roof
  windows again (how many of them are false, and what the detector checks:
  `docs/evidence/roof-windows/`). `--debug` writes, per tile, the mesh from above next to the measured
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
  A refresh checks the ZIP for damage and the required CSV files before replacing the
  cached feed. Failed refreshes stop and keep the previous files; the feed and summary
  are each replaced only after a complete write.
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
- **Unmapped ground.** `ground_cover.py build <area>` (extra packages in their own
  group: `uv sync --group cover`) works out what the ground nothing maps is made of,
  from IPR's 2024 colour and infrared aerial photographs and IPR's 2025 1 m surface
  model, and writes the `cover` layer: grass, trees (as wood), dirt, gravel and asphalt,
  with roofs, sheds and site clutter left as they are. Run it after `ipr_terrain.py`
  (it needs the heights); `layers.py` then puts the result into the tiles as the
  `cover_*` areas the game draws, so there is no flag. Photographs are fetched once, as
  JPEG at 0.25 m, into `pipeline/.cache/cover/photos/` (about 0.5 MB a tile, 3 GB for
  the city); each tile's answer is kept under a key of its inputs, so a second run
  only redoes tiles whose ground, heights or photographs changed. The surface model
  (`DSM_1m.zip` from IPR's open data, 1.5 GB, unzipped to
  `pipeline/.cache/cover/dsm_ipr/`) must be there. The same file also has the
  prototype's other commands (`classify --method model|jev`, `train`, `sheet`, `score`
  against hand labels, and `ortho`, the painted photo shown with `?ortho`, not
  convincing yet).
- **Young woods.** `young_woods.py build <area>` (same `cover` group; it needs the ground
  and terrain layers and IPR's surface model, not the ground cover) finds where a mapped
  wood is still low: inside a wood, where the canopy top (80th percentile over 9 m, surface
  model minus terrain) is between 1.5 and 7 m, in patches of at least 250 m2. It writes the
  `young` layer, and `layers.py` puts the polygons into the tiles as `areas.young_wood`;
  the game plants small, close trees there instead of full-grown ones
  (`treeInstances` in `src/map/vegetation.ts`). `survey` only reports the share. The
  surface model only covers the city, so a wood outside it stays as it was. Results are
  kept per tile under a key of the wood outlines and heights, and changing
  `young_woods.py` does not invalidate the other layers.

Sizes after the 1 October 2026 local rebuild: centrum is 234 tiles and about 38 MB;
the whole city is 14,595 tiles, 247,013 OSM buildings and IPR buildings in 5,703
tiles, about 655 MB. IPR building and terrain binaries are gzipped (`.bin.gz`)
and unpacked by the game. The caches (OSM extract and IPR sheets) are about
7.5 GB, and what the pipeline keeps of them once read about 2 GB more.

## Deploying

The mbxp beta site at <https://beta.streetsofprague.com> runs from mbxp.
<https://streets-beta.jonasjancarik.cz> remains an alternate address.
`scripts/deploy-mbxp.sh` builds committed code, syncs `public/data/` from this
machine, and restarts the `streets-of-prague` container on `127.0.0.1:3017`.
Each map is kept on the server in its own folder, `data/<id>`, named after a
fingerprint of its files and served at `data/<id>/`, so a deploy never changes the
map under the running game and browsers never mix files of two maps. Unchanged
files are hard links to the previous map's, so only what differs is sent and
stored. `current` and `current-data` on the server name the live commit and map,
and `releases/<commit>/data-id` the map each release went out with. To put an
earlier map back, run `DATA_ID=<id> scripts/deploy-mbxp.sh`. Old folders in `data/`
are not removed automatically. `scripts/deploy-mbxp.sh --cloudflare-map` sends no map at
all: the beta then reads the one production serves (`deploy/data-version`, from
`data.streetsofprague.com`), which allows deploying it from anywhere once a map is uploaded.
The `urad-ai-poc` tunnel routes the hostname there. `scripts/httpd.conf` gives
JSON the content type Cloudflare needs for compression.

The main site serves the app as Worker static assets, with a small Worker for the
newsletter signup, the feedback form and the statistics (below). That Worker answers at
<https://play.streetsofprague.com> and at <https://streetsofprague.com>, and
`GAME_MOVED` in `deploy/address` says which of the two is the game. With `GAME_MOVED=yes`
it is `play.`: a page asked for at `streetsofprague.com` is then redirected (301) to the
same path and options there, while `/api` and the game's files keep answering at both,
so a game left open in a tab keeps working. Empty, the game is at `streetsofprague.com`
and `play.` is a second address for it. Only `/api/*` and the page itself (`/`) run the
Worker; everything else comes straight from the assets. `scripts/local-two-hosts.sh`
runs the Worker locally as both addresses and `node scripts/check-two-hosts.mjs` checks
what they answer.
<https://streets.jonasjancarik.cz> permanently redirects to the game through a
Cloudflare Redirect Rule on `jonasjancarik.cz`, preserving paths and query strings.
Its map data comes from the R2 bucket at
<https://data.streetsofprague.com>, under the immutable prefix named in
`deploy/data-version`. The bucket also answers at
<https://streets-data.jonasjancarik.cz>, which has to stay connected: releases up to
v0.1.0 have that address built in. Each of the two hostnames needs its own Cache Rule
in its zone (eligible for cache, edge TTL from the origin's `Cache-Control`), or
Cloudflare serves every file straight from R2 without caching it. Local development loads `data/` next to the app, and mbxp
its own copy (above); only `scripts/deploy-cloudflare.sh` sets the R2 URL at build
time.

The map's files have a format number: `FORMAT` in `pipeline/layers.py` writes it
into each `index.json`, with the time and commit the map was built from, and the
game refuses a map whose number isn't its own `DATA_FORMAT` (`src/data.ts`). Raise
both together whenever a change means older code couldn't read the new files.
`scripts/check-data-format.mjs <folder or URL>` compares a map with the committed
code; the upload, release and both deploy scripts run it first.

After rebuilding map data, configure a bucket-scoped R2 S3 remote named `streets:`
in rclone (or set `R2_REMOTE` to another remote and bucket path). Use a temporary
Object Read & Write key for the `streets-of-prague-data` bucket; keep its access
key and secret outside this repository. Run `scripts/upload-data.sh <new-version>`
to upload and checksum-check every file. It refuses a version name that is
already on R2; `--resume` finishes an interrupted upload of the same files, and
fails if an object in that version has changed. Commit the updated
`deploy/data-version` and app code, then release (below), which runs
`scripts/deploy-cloudflare.sh`. That script checks the R2 index and its format, typechecks, builds only the app assets, validates
Cloudflare Build Output with `cf deploy --prebuilt --dry-run`, and deploys it. With
`--dry-run` it stops before deploying.
The two targets can be updated independently.

### Anonymous statistics

The Cloudflare build reports how well the game runs, errors and what gets played,
without anything that identifies a player, to the Worker in `worker/index.js`;
players can switch it off in the settings. `node scripts/telemetry-dashboard.mjs`
builds a local dashboard from the reports. See [docs/telemetry.md](docs/telemetry.md).

### Newsletter and feedback

The game has two small forms, both answered by the Worker in `worker/index.js`, which
is the only thing they talk to, so either can move to another service without the game
changing. The beta has no Worker of its own and uses production's. One visitor address
can try five times a minute and only the game's own pages are let in, since every use
sends an email. Each form stays out of the game until it is set up.
The form endpoints accept `POST` and preflight `OPTIONS`; other methods return
`405` with `Allow: POST, OPTIONS` and do not contact the email services.
The forms wait at most 30 seconds for response headers or an error response's body.
Successful headers finish immediately. If no headers arrive, acceptance is unknown;
the form keeps the typed fields and enables a manual retry without sending again
automatically. A stalled error body shows the existing generic failure message.

**Newsletter.** The start screen and the settings have a link to sign up for news about
the game by email (`src/newsletter.ts`). `/api/subscribe` passes the address to
[Brevo](https://www.brevo.com), which sends an email with a link to confirm; only then
is the address on the list, and the link leads back to the game, which says so. Nothing
is stored outside Brevo. The form offers the emails in English or Czech, with the game's
language picked to begin with. Turnstile, Cloudflare's check that a real browser is
signing up, keeps scripts from having confirmation emails sent to strangers; most
players see nothing of it.

**Feedback.** The settings have a "Send feedback" link (`src/feedback.ts`).
`/api/feedback` emails the message to the address in `deploy/feedback` through
Cloudflare's email sending, with the player's address (if they gave one) as the one a
reply goes to. The game adds its version, the browser and graphics card, the graphics
level and renderer, the frame rate, how long the page has been open, the HUD's tally,
the last few errors the page saw, and where the player was, in the form the scenarios
use, so the spot can be replayed (the scene-testing skill).

Setting each part up (Brevo, the domain's mail records, Turnstile, email sending), the
settings in `deploy/newsletter` and `deploy/feedback`, checking a change without sending
real email, and what to look at when something doesn't arrive are all in
`.agents/skills/player-forms/SKILL.md`. `node scripts/check-worker.mjs` checks the
Worker with the services behind it replaced by stand-ins.
`node scripts/check-form-deadlines.mjs` checks the real submit handlers with mocked
requests and controlled time, without sending email or loading CAPTCHA.

Incoming mail to `news@streetsofprague.com` and `jonas@streetsofprague.com` is
archived privately in R2 and forwarded to Gmail by a separate mail Worker.
See [Email for Streets of Prague](docs/email.md) for configuration, deployment
and the distinction between receiving mail and sending replies.

### Releases

How the game's version, the map data version and the map format fit together, and how
to roll back, is in [docs/versioning.md](docs/versioning.md).

Versions are git tags on `main` (`v1.2.3`), published as GitHub releases at
<https://github.com/jonasjancarik/streets-of-prague/releases>. With main committed
and pushed, `scripts/release.sh patch` (or `minor`, `major`, or a number such as
`v1.2.3`) works out the next version from the latest one, typechecks, checks that the map named in
`deploy/data-version` is on R2 in the format the code reads, then tags the commit,
creates the release with notes generated from the commits since the previous one
(headed by the map data version), and runs
`scripts/deploy-cloudflare.sh` (`--no-deploy` skips that). Production only runs
released versions: the deploy script refuses a commit that isn't a release tag, so
new code reaches production through `release.sh` and a rollback by checking out an
earlier tag. `scripts/deploy-cloudflare.sh --untagged` is the way round it for an
emergency. Code that isn't ready for a version goes to the beta. The build reads
`git describe` (see `vite.config.js`), and the settings panel shows it with the
build date: `v1.2.3`, or `v1.2.3-5-gabc1234` for commits made after the tag, followed by the map data version
(`deploy/data-version` on Cloudflare; elsewhere the day the map was built).

## Credits

The game credits the map's sources in the corner of the screen (**Credits** opens the
list, with the licences), and the build writes the full licence texts of the bundled
libraries to `dist/licenses.txt` (a small plugin in `vite.config.js`).

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), ODbL.
- The countryside past the map's edge (`?countryside`, plan 021): OpenStreetMap data as vector tiles in [Protomaps](https://protomaps.com/)' basemap layout (one PMTiles file, ODbL), and ground heights from Mapzen's [terrain tiles](https://registry.opendata.aws/terrain-tiles/) kept as open data at AWS ([their sources](https://github.com/tilezen/joerd/blob/master/docs/attribution.md): SRTM, EU-DEM produced using Copernicus data and information funded by the European Union, and others).
- Tram and metro timetables: [PID / ROPID](https://pid.cz/o-systemu/opendata/), CC BY 4.0, reduced to trips per hour.
- 3D buildings, bridges and terrain: datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model), CC BY.
- Landmarks, and the roof and wall colours: photorealistic 3D model of Prague, datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh), CC BY.
- Carriageways and parking bays: Digitální technická mapa kraje, datový podklad © [IPR Praha](https://geoportalpraha.cz/data-a-sluzby/28A24EB4-5EE8-436E-B0BB-357025258211), CC BY.
- Paid-parking sections and occupancy: [TSK Praha](https://zps.tsk-praha.cz/).
- Street lamps, manhole covers, storm drains and traffic-light poles: the surface marks of the archived utility map (DTMP_CUR_TMISZNAK_B), datový podklad © [IPR Praha](https://geoportalpraha.cz/), CC BY.
- Lawns, meadows, flower beds, shrubs and hedges on city-managed land: vegetation elements (OPK_CUR_OPK_SMZ_VP_P and _B), datový podklad © [IPR Praha](https://geoportalpraha.cz/), CC BY.
- Unmapped ground (`ground_cover.py`, `?ortho`): orthophotos and the digital surface model © [IPR Praha](https://geoportalpraha.cz/), CC BY 4.0; older surface model DMP 1G © [ČÚZK](https://geoportal.cuzk.cz/), CC BY 4.0.
- Tram sounds: [Freesound](https://freesound.org), nearly all CC0; the motor's whine is
  [tramvaj nova prujezd nabrezi MS](https://freesound.org/s/621068/) by ozvuk,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see `public/audio/SOURCES.md`).
- City sounds: [Freesound](https://freesound.org); the Old Town crowds are
  [Prague, Staro Mesto, City Center](https://freesound.org/s/212034/) (parts 1 and 2)
  by vonfleisch, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), the traffic
  [Prague Atmo Traffic from 5th floor](https://freesound.org/s/94309/) by aUREa,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), the rest CC0.
- Recorded car engine (on the sound test page so far): three recordings of a
  [Hyundai Kona](https://freesound.org/s/845607/) by KVV_Audio,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see `public/audio/SOURCES.md`).
- Drawing: [three.js](https://threejs.org/) (MIT); map projections: [proj4js](https://proj4js.github.io/proj4js/) (MIT).
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
