# How Streets of Prague works

The developer's handbook: how to run and test the game, what each part of it does, how
the map is built from open data and how the game is deployed. For what the game is and
how to start, see the [README](../README.md); the credits and licences are there too.

The game started as the driving prototype inside `prague-game` (a Prague 1945
experiment) and was split out with its history at `prague-game@c271397`.

```bash
npm install
npm run dev          # http://localhost:5191
npm run typecheck    # check browser source with strict TypeScript
npm run build        # typecheck, then make a production build
node scripts/bench.mjs   # frame times in Chrome at a few places (options in the script)
node scripts/scene.mjs run all   # test scenarios in headless Chrome (see Testing below)
```

On Windows, the same development command works in Command Prompt or PowerShell.
Use `npm.cmd` if PowerShell blocks `npm.ps1`. The default port is 5191; set the
`PORT` environment variable or pass `npm run dev -- --port 5192` to change it.
Vite watches browser source, leaving `pipeline/`, `trailer/`, `public/data/` and
other checkouts under `.claude/worktrees/` unwatched. Rebuild map data as usual;
reload the page to see it. Dependency discovery starts from the game's `index.html`.

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
Scenario runs restore the previous player damage setting when they finish, including after a failed check.
Screenshots go to `$TMPDIR/scene`. The same scenarios run in the developer panel
("Run and watch" plays one in real time), and "Copy this situation" there copies where
you are, the time, weather, money, stars, car and camera as the start of a new scenario.

For a varied street survey, run `node scripts/sample-streets.mjs praha 17`.
It picks separated examples from six street types on the built map and returns
Street View links with coordinates and headings for `t.go`. Use the same seed
to repeat a survey on the same map, or change the seed for another set.

Development pages pause while another session benchmarks. Status requests time out
after four seconds; older replies cannot restore a pause after a newer reply cleared
it. If the local status endpoint is unavailable, the page carries on.
`node scripts/check-bench-pause.mjs` checks polling and startup recovery offline.

WebGPU is the default renderer; `?renderer=webgl` selects the legacy renderer, and so does
`?vr` or the VR camera view (three.js draws for a headset only through WebGL).
`?gl2` (a trial) runs the WebGPU renderer through WebGL 2 instead, with all its materials;
with `?vr` that gives the headset the street trees and life-size people, but on the
Pixel 5 at about two thirds of the legacy renderer's frame rate (6 against 9–11 fps in
Kampa).
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
(place, view, graphics, season, time and weather, a row each, with sound and the language as
quiet toggles in the line of links under the Start button). The map loads behind it: the
Start button fills up with how far loading has got, with the seconds left under it
(`src/loadProgress.ts`). The estimate uses typical times for each stage (the map's index,
starting the graphics, the models, the streets, setting up, preparing the view), replaced
by this device's own times from its last load (`loadTimes` in local storage), at the pace
of the stages so far; the start report sends the stages' times so the typical ones can be
set from what players see ([telemetry](telemetry.md)). Scripts read each moment's estimate
from `window.__loadLog`. The Graphics row is the same setting as in Settings and applies
at once, while the map loads; its Auto button says the level Auto starts at. With a saved
game, the map loads round where it was left, so Continue opens at once; a new game then
loads a random street after Start. The start screen picks Clear; the real
weather in Prague, from Open-Meteo (`src/liveweather.ts`), is offered right after it as
"Live: …", only for today's game date (another season goes back to Clear). The weather
only starts changing by itself once the game is under way. A game begun with it follows the real
weather as it changes, until you pick one yourself ([docs/live-weather.md](live-weather.md),
which also covers ČHMÚ's open data as a source through the Worker). <kbd>P</kbd> steps through the weather.
`?osm` shows OSM footprints instead of IPR's 3D buildings, `?dev` opens the
developer panel, `?fps` starts in first person (the panel's First person box), `?tps` in third person (the Third person box: on foot, from a few metres behind you; driving, the same chase camera as first person, a little higher behind buses and lorries; riding or driving a tram or bus, the same chase camera, over a tram's roof from high above its middle section, while first person stays in your seat, or in the driver's seat of the front cab when you drive a tram (`cabEye` in `src/trams.ts`), `src/followCamera.ts`), `?headingup` (or the panel's Heading-up camera box) is an experiment: a GPS-style camera that keeps your car in the middle with its nose to the top of the screen and turns the map under it (`src/headingup.ts`, the camera in `src/main.ts`; cars only, the minimap stays north-up), `?dialog` plays a sample conversation, `?menu` shows only the start screen without loading the map (quick to reload while working on the screen, the beta note or the signup form; the note then shows on every press of Start), `?touch` shows the touch controls on a desktop, a new game starts at one of ten places around the city picked at random (`STARTS` in `src/main.ts`), or at a spot picked on the start screen's map (Place → Pick on the map, `src/startmap.ts`: anywhere inside Prague's city limits, from `src/prague.json`, which `pipeline/build_prague_outline.py` writes; the map is OpenFreeMap's vector tiles drawn with MapLibre in the poster's colours, `src/postermap.ts`, the same as the developer panel's map, loaded only when it's opened), and `?start=lon,lat` preselects Place → Location from link on the start screen, and `?money=N` sets how much money you start with (10,000 Kč otherwise). The game is in English and Czech: the start screen has the choice (a button naming the other language, in the line of links under Start; remembered for next time; the browser's language decides the first time), and `?lang=cs|en` sets it. All text is written in English in the code and looked up by that text in `src/cs.ts`, through `t()` in `src/i18n.ts`; a line with no Czech entry shows in English. The Czech is kept gender-neutral towards the player for now (see the note at the top of `src/cs.ts`). Elements in `index.html` marked `data-t` work the same way.
HTML hints use `tHtml()` to keep key formatting while escaping names inserted from
map and transit data; text content uses `t()`. `node scripts/check-display-text.mjs`
checks transit hints, developer search results and scenario reports in both languages.

`?roadprofiles` enables the experimental, map-versioned road surface on a reviewed
50 m section of Italská when its generated `road-profile.json` is present. It is
off by default; see [the road profile pilot](road-profile-pilot.md) for generation,
measurements and limits.

`?roadsurfaces` loads the wider screened road surfaces when `road-surfaces.json`
matches the assembled map. The [generation and screening instructions](road-profile-pilot.md)
explain how to prepare the file for another build.

Add `&roadjunctions` to load the wider junction trial from the matching
`road-junctions.json`. [Junction trial results and generation](road-profile-pilot.md#extended-junction-trial).

The game leaves out what the buildings hide in the street views (first
person, third person and VR): from the camera (in VR, both eyes), a sweep over the drawn tiles'
buildings (in a worker, from where the eye will be) works out how high something must
stand to be seen, and tile meshes,
instanced batches and other meshes below that leave the main pass but keep casting
shadows (`src/occlusion.ts`, `docs/occlusion-culling.md`). On by default since 23 November 2026; `?cull=0` draws everything, for comparison.

`?farground=250` is an experiment for the street views (first person, third person and
VR): the ground of tiles more than that many metres from the camera is left out, as the
buildings hide it almost everywhere at street level (`FAR_GROUND` in `src/tiles.ts`). It
is off by default; across the river and other wide open views a strip of the far bank
goes missing (performance log, 22 November).

Add `&roadcorridor` to preview the fitted Dobrovolského corridor when the matching
`road-corridor.json` is present. [Corridor trial results](road-profile-pilot.md#dobrovolského-corridor-trial).

Add `&roadcorridors` to load the screened Prague batch from the matching
`road-corridors.json`. [Batch selection and checks](road-profile-pilot.md#automatic-prague-corridor-trial).

Add `&roadshelves` to load the screened LiDAR terrain corrections beside
lower roads from the matching `road-shelves.json`.
[Source comparison and screening](road-surface-findings.md#lower-ground-beside-elevated-roads).

Add `&roadfit` to load the road fit over the inner city (Vinohrady, Nusle, Zlíchov,
Smíchov, the centre and Žižkov) from
`road-fit.json`: one smooth surface over the streets, fitted to IPR's LiDAR. Every
step that puts the map together (`layers.assemble`) fits it again, so it always
matches the map. Only a map whose terrain was built with the LiDAR
(`ipr_terrain.py --survey-scan` or `--ipr-lidar`) has one, and then the build stops
if IPR's LiDAR or surface model is missing from `pipeline/.cache`.
[How it is made and what it changes](road-surface-findings.md#road-fit-pilot-vinohradynusle).

A prototype puts the LiDAR into the map itself instead: `uv run ipr_terrain.py <area>
--ipr-lidar .cache/ipr_lidar/2023 --lidar-ground --step 2` makes the ground a 2 m
lattice of the 2023 LiDAR's heights in centimetres (`unit` in index.json's
`terrain`), and the survey only says where the streets, walls and water are. Tried on
`centrum`, not on `praha`.
[What it changes](road-surface-findings.md#one-surface-a-trial-on-the-centre-map).
With either ground, `--step-lines` (`pipeline/step_lines.py`) also writes each step's
outline as a line with the ground's height on either side (`stepLines` in the tile),
and the game reads the ground near a step from it: smoother wall tops, walls closer to
the LiDAR's; on `praha` it takes two-thirds of the sawtooth off the wall tops. On today's
ground a line gives way where it's far from the lattice and has a step the lattice
doesn't: it's reading another place's ground. `?lines=off` leaves the lines out to compare, and so does `--lines off`
for `check-road-flatness.mjs`, `check-bridge-decks.mjs` and `check-step-edges.mjs`, so
one build gives both sides of the comparison.
[Walls as lines](road-surface-findings.md#walls-as-lines),
[on praha](road-surface-findings.md#walls-as-lines-on-praha).

Add `&bridgesurfaces` to preview the surveyed railway and ramp repairs from
the matching `bridge-surfaces.json`.
[Husitská and U Bulhara](road-surface-findings.md#the-railway-at-husitská-and-the-ramps-at-u-bulhara).

Add `&stationtracks` to preview the mapped rail lines, ballast, sleepers and
platforms at Praha hlavní nádraží and its approaches. This loads the bridge
preview to keep the tracks on the right level. After building
`bridge-surfaces.json` for the current map, generate the station file with
`python pipeline/station_tracks.py public/data/praha_now pipeline/.cache/osm/praha.osm.pbf`
in the pipeline environment. OpenStreetMap supplies the track and platform
outlines. Bridge-tagged rails fill gaps in the surveyed track coverage where
they intersect a single deck.

For matched terrain comparisons, `?camera=lat,lon,altitude,height,tilt,heading`
opens the free camera at a fixed pose. Altitude is the target elevation in metres
above sea level. Height is the camera's rise above that target, in metres.
Tilt and heading are in degrees.

On WebGPU, `?roadraster` previews rasterized asphalt on shared terrain triangles.
See [the shared asphalt trial](tiny-prague-road-rendering.md#shared-asphalt-trial-6-november-2026)
for the comparison and measurements.

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
| Cones of light in the air, glints on cars and wet ground (WebGPU) | On | On | Off | Off | Off |
| Bloom round lights and glints, darker corners (WebGPU) | On | On | Off | Off | Off |
| Motion blur when driving, from the street (WebGPU) | On | On | Off | Off | Off |
| Waves and glitter on the river, until you choose | On | On | On | On | Off |
| Sprays of leaves and needles on trees and shrubs seen from above | On | On | Off | Off | Off |
| Shadows that soften with distance from what casts them | On | Off | Off | Off | Off |
| A soft shade under every car | On | On | On | On | Off |
| A person's shadow from the sun | Their own shape | Their own shape | Their own shape | A plain shape | A plain shape |
| Maximum crowd | 1200 | 1200 | 1200 | 1200 | 600 |
| Close detailed people, up to | 32 | 24 | 12 | 6 | 2 |
| Detailed people within | 45 m | 36 m | 22 m | 14 m | 8 m |
| Close car bodies within | 40 m | 30 m | 20 m | 16 m | 12 m |
| Façade walls with window depth, nearest | 36 within 56 m | 24 within 42 m | 12 within 27 m | 8 within 20 m | None |
| Manhole lids and drain grates in relief within | 32 m | 24 m | 15 m | 9 m | None |
| Relief and sheen up close on kerbs, stone steps, tram rails and rendered walls | On | On | Off | Off | Off |
| Trams, boats, the funicular, helicopters and metro lanterns in detail | 1.6× as far | 1.25× as far | Base distance | Base distance | Base distance |
| Street-tree branches | Full | Full | Fewer sides | Fewer sides | Fewer sides |
| Ordinary terrain mesh spacing | 2 m | 2 m | 2 m | 4 m | 4 m |
| VR resolution at session entry | 75% | 75% | 65% | 55% | 45% |

The sun shadow map covers just what is on screen, as the sun sees it, so shadows stay
sharp when you drive and when the sun is low. Street patterns and facade pictures
stay on at every tier. Quieter streets have
fewer people; changing tiers lets surplus people leave out of sight.
At street level, people and cars beyond the close-detail ranges use their usual
instanced models. Your own avatar and the car you drive keep their close models
(the car within at least 24 m on every tier). The ranges are in `src/streetQuality.ts`.
Once something has switched to its close model, it keeps it until it is 15% further
away (`KEEP`), so something standing near the line doesn't flicker between the two.
The few large things switch at a base distance on Medium and below: trams at 57 m,
boats, ferries and funicular cars at 50 m, helicopters at 60 m and metro lanterns at 55 m.
On 23 November 2026 Ultra and High moved these further out, after players noticed the
detailed models appearing close to the camera.
Simpler tree branches keep the same leaf cards and crown outline. Grass placement
runs in short slices while you move, so checking the ground under a new patch does
not have to finish in one frame.
Low and Lowest use fewer triangles on ordinary surveyed terrain. On every tier the
ground's triangles are up to 8 m long where it is flat, and are split down to the
tier's spacing only where the terrain or the kerbs bend more than 3 cm off a straight
line (`groundFlat` in `src/streetQuality.ts`, `bender` in `src/ground.ts`). Tile edges,
steps, road edges, bridge decks and tunnel floors keep their finer spacing; collision
heights do not change. Terrain spacing applies to newly built tiles, so an already
loaded tile keeps its mesh until it is rebuilt or the page reloads.
Auto, the default, starts where telemetry says the graphics chip usually ends up
(`AUTO_START` in `src/graphics.ts`: Lowest on Intel gen-9 and gen-12 integrated graphics
and Adreno 6xx phones, Low on Mali and older Adrenos, High on iPhones, iPads and newer
Adrenos), or else High (Medium on touch devices), and moves between tiers by how steady
the frames are, ignoring loading and tile builds; under half the frame rate it aims for,
it drops two tiers at once. On a computer without a touch screen, using WebGPU, it goes on
from High to Ultra when High's frames are steady and their work (the main thread's or the
GPU's, whichever is longer) takes under 10 ms; it tries that once a visit, as the change
rebuilds every lit shader (a short freeze each way). Touch devices, WebGL and VR stop at
High, and choosing Ultra still turns it on anywhere. On WebGPU it doesn't step down
when frames are slow only because they wait: when the browser or the screen holds the
game at 30 frames a second (Chrome's Energy Saver does), a frame whose work fits in
half the time stays at its tier.
In VR, Auto aims for the headset's refresh rate (60 FPS when the browser does not
report one). It reduces street detail while you play. Headset resolution changes
on the next VR entry; changing the page's pixel ratio cannot resize an active XR
framebuffer.
`?graphics=auto|ultra|high|medium|low|lowest` overrides it for one visit; `?dpr=1` fixes
only the pixel ratio. The Water setting turns on waves, sun glitter and lamp reflections on
the river (`src/webgpu/water.ts`; WebGPU only, not on Lowest; on by default from Low
through Ultra; `?water=on|off` for one visit). Small ponds and park basins with a
complete outline inside a tile get gentler ripples and keep their rain rings.

From street level, the Vltava carries short wind ripples across a longer swell.
Along the central river, neighbouring water-level panoramas supply the actual
banks. Each photograph has a depth view so the reflection shifts with the
camera. Moving boats and bridge piers meet their reflections at the waterline
on Medium and above. Only these objects and the bridge slabs go into a small
cached reflection, refreshed while river water is on screen. The overhead view
and headset keep the original water. Rebuild the atlas and station positions
from the Prague map with `uv run river_reflections.py` in `pipeline/`.

Every pixel ends with the same tone curve at every tier but Lowest (`src/grade.ts`): a
filmic curve per channel (Krzysztof Narkowicz's fit to the ACES curve, with a softer toe)
and a little less saturation, more of it taken from bright colours. Sunlit stone sits on
the straight middle of the curve, so a roof's sunny and shaded slopes stay apart and shade
is properly dark. The numbers are in one place for the WebGPU tone-mapping node
(`src/webgpu/grade.ts`), the old renderer's GLSL and the curve undone for colours meant for
the screen (fog, rain, smoke). `?grade=old` brings back the curve before it (an extended
Reinhard, under which everything sunlit sat on the shoulder and read as flat).

Over the curve lies a look that changes with the hour and the weather (`lookAt` in
`src/grade.ts`; WebGPU only, at every tier with the curve): the dark end of the picture
is tinted one way and the light end another, colours are made a little stronger or weaker
and the middle steepened. Broad daylight is close to neutral; a low sun has warmer
lights over cooler shade; dusk and dawn are bluer; night is blue in the dark with warm
lamplight; under cloud, in rain, snow or mist the colours are weaker and flatter. All
within a few per cent. `?look=off` leaves it out. The developer panel's Picture tab has
sliders for trying other amounts (`GRADE_TUNE` in `src/grade.ts`): Brightness (the
exposure), Mood of the hour (how strongly the look is laid on), Colour and Contrast. All
but Brightness work through the look, so they need WebGPU.

On High and Ultra the frame goes through one more pass (`src/webgpu/post.ts`, three.js's
`RenderPipeline`): the scene is drawn to a target of its own, what is brighter than a
threshold spills light round itself (bloom: by day only glints and the brightest plaster,
at night the lamps' pools, lit windows and headlights), then the tone curve runs and the
corners are darkened a little (by up to 16%; the Picture tab's Dark corners slider,
`VIGNETTE_TUNE` in `src/post.ts`, scales that). The bloom's first copy is a quarter of the picture's width.
`?post=on|off` overrides the tier for one visit.

Driving faster than about 20 km/h in first or third person, that pass also blurs the picture
along the way the street moves across it (full strength from about 60 km/h, as if the
shutter were open for 16 ms; the longest smear is 4.5 % of the picture's height): from the
picture's depth and the vehicle's speed it works out where each point was a moment
before and reads the picture eight times along that line. Your own vehicle and the road
far ahead stay sharp, and turning the camera blurs nothing. Other traffic is smeared as
if it stood still, so a car keeping pace beside you is blurred too. It can be turned off
in Settings (Motion blur when driving); `?motionblur=off` does so for one visit and
`=full` gives its full strength at any speed. The developer panel's Picture tab has a
Motion blur slider (0× to 4×, `BLUR_TUNE` in `src/post.ts`) for trying other
amounts. Not on foot, from above, on Medium and
below, or with the WebGL renderer.

Photo mode (<kbd>C</kbd>, `src/photo.ts`) stops the game, clears the screen of everything
but the picture and frees the camera: drag to move, scroll to zoom, right-drag or the
sliders to tilt and turn, and a slider for the hour. "Save picture" downloads the canvas at
its full size as a PNG. The button waits for the phone to finish encoding the picture.
<kbd>H</kbd> hides the bar. <kbd>C</kbd> or <kbd>Esc</kbd> goes
back, and the clock returns to what it was. It is the developer panel's free camera
(`t.cam`) with the game paused. WebGL keeps MSAA on at every tier because it cannot change
that without a new renderer.

## Art direction

<!-- read_when: designing or reviewing vehicles, buildings, vegetation, street furniture or lighting for either camera -->

**Top-down.** Judge the street at normal driving zoom, in motion. Coming up to a junction,
you should be able to follow the kerb, spot a pedestrian and tell which way a van is facing.
Give each object a distinctive outline and a few broad areas of colour. On the dustcart,
the orange cab and the black hose curled over the pale steel cover identify it from above.
A roofline and its cast shadow can do much of the work of describing a building. Keep
paving distinct from asphalt, and soften fine patterns if they shimmer as the camera moves.

**First person.** Aim for a street that looks real from the pavement. Work from photographs
of the Prague place or vehicle, starting with proportions and how the parts fit together.
At a building entrance, model the depth of the doorway and the step where it meets the
pavement. On a vehicle, spend detail where the player can see through, around
or into something. The ambulance windscreen reveals the seats and steering wheel. Its
headlamps have reflectors behind clear covers, with the beam starting at the lamp. Rubber,
glass and painted metal should respond differently to the same light. Use local service
colours and markings for recognition. Leave manufacturer badges off or invent one.

Car body panels render from both sides, and a closed dark underside fills the floor
and engine bay in both close and distant models, so rolled cars do not reveal the street
through their bodywork. Windows retain their separate glass treatment.

**Choosing the model.** Use one model when it looks right in both views. If a close-up needs
a cab interior or recessed lights, put that geometry on a separate street model so the
overhead view stays light. Both versions of a vehicle should agree on its footprint,
livery, lamp positions and damage. Check the same subject from above and on foot in
`?fps`, walking around it to catch details that look convincing from only one angle.
Check emergency lights in full daylight as well as after dark. At the peak of a flash,
the LED face looks nearly white and the colour shows around its edges. On the
ambulance, the red and blue flashes are visible on both the roof and the grille.

Near a junction of named streets, look up for Prague’s red enamel street plates.
The name follows the street parallel to the wall. The smaller line gives the
cadastral area and the Prague 1–10 borough from RÚIAN. The game infers a mounting
point on clear plaster near the corner. When a wide opening fills the end of the
wall, the plate can sit on the plaster between the first two bays. The curved face, proportions and enamel
border follow the examples in [IPR’s Pražský uličník](https://prazskyulicnik.az.iprpraha.cz/clanky/vyvoj-oznaceni-ulic-v-terenu).
The map supplies the names, while individual sign positions are approximate.

Look up a house front to its roofline. Windows stop where a whole one no longer fits:
under a gable (a štít), a sloping parapet or a step in the roof the wall is bare plaster,
and nothing lights up there at night. The game measures the top of every wall bay by
bay; which bays have windows at all is still inferred, as before
(`windowRows` and `splitWindowRows` in `src/facades.ts`).

Stand under a street tree on a windy day. The boughs and sprays lean with the wind and
swing back, in gusts that pass from tree to tree, about three times as hard in a storm.
Towards sunset or dawn, look along the river at the sun: the horizon there is orange
and the clouds on that side are lit warm, with only a blush on the opposite side.

At street level on WebGPU and WebGL, a glazed shopfront can show bookshelves, a bakery,
flowers or ceramics. Look through the glass from the side to see the walls
and floor behind the window frame. Adjacent bays share a display and some
stay lit after dark. Along Mostecká, mapped shop and café positions guide which
street-facing bays get a display. The stock and joinery are imagined for the game.
Arched timber portals sit further back, with a meeting stile, a stone landing
and enough steps to reach the threshold from the pavement.

Mapped foot passages continue through the ground floors of buildings. At U Nováků
on Vodičkova you can walk off the pavement, past the display cases, and back
out again. The openings follow the same route and width as the walking grid.
Listen at the threshold. Rain on the pavement gets quieter inside, the city's
high frequencies soften and your footsteps pick up two short wall reflections.
Nearby walkers put away their umbrellas under cover. On foot in first person,
people step aside as you approach or wait in a narrow doorway until you clear it.
Where passages meet, the corridor walls stop at the junction. The ceiling and floor
follow the terrain and end at the building's wall. The fixtures, finishes and
display cases are inferred scenery. Nearby interiors are built by an optional
tile-worker job and released on returning overhead.

Streets mapped through a building (`tunnel=building_passage`, a průjezd) get an
arched opening and a vault over plastered walls on a stone plinth, with a stone
surround at each end and a lantern under the crown. Drive or walk under the two
arches at the end of Smetanovo nábřeží by Křižovnické náměstí, or through the
gateway from Letenská into Josefská. A pavement mapped beside the road under the
same arch widens that arch, but the vault stays inside the houses the road runs
through, so it doesn't spill onto a neighbour's pavement where OSM's outlines overlap
the street. Two roads either side of a pillar stay two arches.
Tram tracks alone don't open a building, because where they really pass through
one a road is mapped with them. The vault's shape and the finishes are inferred.

A mapped passage often stops short of the façade, and a tile's copy of it stops at
the tile's edge. Its loose ends are carried on until they leave the building (up to
8 m, or 25 m from a tile's edge), so both ends open. Cutting the opening also
records where IPR's walls cross the passage, and the lining ends there rather than
at OSM's outline, which can be metres out where upper floors overhang the street
(`src/map/passageOpenings.ts`, `src/map/passageLining.ts`). See
`scenarios/covered-passage.ts`, `scenarios/josefska-gateway.ts` and
`scripts/check-passage-openings.mjs`.

Look down on Seminářská to see the cast lids and storm drains at their survey
positions. Nearby manholes have worn raised patterns and lifting slots, drain
grates have a recessed bed between the bars, and small hydrant covers carry an
H. The casting design is inferred. The close models follow the slope and
reuse four instance batches. Overhead and on Lowest, the ground marks remain.

The fire engine shows its roof ladder and hose rack from above. Within the close-car range on foot (the graphics table),
you can see through the crew cab, read the rear pump gauges and follow a firefighter’s
hose to the coupling beside the lockers. Two marked police cars share patrol and pursuit
duties. The silver response estate has yellow wing markings and roof rails. The white
municipal saloon carries a navy stripe with “Městská policie” on the front doors.

A tram or bus stop keeps its blue pictogram visible from above. On foot the same spot
has an upright red frame. You can read the stop name, line numbers and printed route
diagrams from either approach along the pavement. At metro entrances a four-sided
lantern gives the line letters, with the station name and neighbouring stops below it.
At a pedestrian crossing, the red standing figure and the green walking figure share
the same signal phase as the overhead light.

### Vehicle models at street level

Within the close-car range of the camera (the graphics table), the bus and minibus have separate panes in their doors
and windows. You can see the aisle, red seats, yellow rails and driver's controls.
The box lorry, articulated lorry and dustcart keep their cargo bodies and have
glazed cabs with seats, instruments and mirrors. Bicycles and motorbikes gain rims,
spokes and chain drives. Shared bikes keep their operator's paint and couriers
keep their delivery boxes.

From the bank you can see into the cruise boat's saloon and the ferry's wheelhouse.
The sightseeing boats have flared bows, rounded sterns and a Czech ensign. Close to
the boat, the timber deck, mooring fittings and raked windscreen come into view.
The skipper and four seated passengers share one mesh inside the cabin. From the
far bank, the illuminated saloon windows remain separated by their sash posts.
The Žofín swan has a low-sided white hull, a black rubbing strip and a recurved
neck with a yellow-orange bill. At the bank you can see the moulded bench, pedals
and steering lever. [Slovanka rental photo](https://www.slovanka.net/images/foto/7.jpg)

Petřín's two numbered cars have a continuous white shell around panoramic side
windows and roof glass. Four stepped landings follow the hill inside. In street
view, within 50 m (further on High and Ultra), the glass reveals the handrails, timber perches and door sills.
The NH hotel line has its own small red cabin. [DPP photographs of the 2026 cars](https://www.dpp.cz/en/company/news/detail/342_3462-petrin-funicular-returns-prague-public-transit-company-launches-fourth-generation-cars)

Both helicopter liveries use the same four-seat cockpit, visible within 60 m (further on High and Ultra).
The metro ride uses its overhead cutaway camera.

## Playing

- On foot, the yellow ring stays visible from above when you walk under trees.
  When driving, a yellow outline shows where foliage covers your car.
- If you get stuck against a tree, hold the accelerator or reverse. After about a
  second of barely moving, your car can pass that trunk until it clears it.
- Tank controls on foot and in the car: W/S forwards and back, A/D turn, Shift
  runs, Space is the handbrake. E gets into the nearest car, including one driving
  past (its driver runs off). R puts the car back on the road. Scroll zooms; the
  camera also pulls up with speed. The handbrake in a turn locks the back wheels and
  swings the tail out: the nose comes round while the car slides on the way it was
  going, and the slide eases off a moment after you let go (longer with the gas held
  in a rear-wheel-drive car). On a wet road a brisk turn drifts a little wide, and on
  snow not yet cleared from the streets clearly more. Braking hard, the handbrake and sliding round a
  corner leave dark tyre marks that fade after a minute (`src/skids.ts`); so do the
  police and cars sent skidding by a crash.
- **Car handling.** In first and third person and in VR, cars drive with **Realistic** handling by
  default; Settings → Car handling switches to **Classic**. The choice is remembered
  between games (`carHandling` in the browser's storage) and takes effect on the next driving step. It applies to the car, van
  or pickup you drive, including taxis and patrol cars. Overhead driving, heavy vehicles
  and AI drivers use Classic; two-wheelers have their own handling (below).
  With Realistic selected, feed in the steering as you approach a bend. Braking or
  accelerating hard leaves the tyres less grip for turning. A short handbrake pull
  lets the tail step out. Release it and unwind the steering to catch the slide.
  Holding the opposite pedal brakes first, then selects the other direction after a
  brief stop. Under power the nose rises, under braking it dips, and the body
  leans outwards in a turn while the wheels follow the road. Vans and SUVs lean
  more than saloons. The chase camera follows some of the car's momentum in a slide.
  The two-axle model and damped springs are in `src/streetHandling.ts`.
  Run `node scripts/check-street-handling.mjs` to compare launches, stops and cornering
  on a flat test road. The `street-handling` scene checks the driving modes in-game.
- **Rollovers** (`src/rollover.ts`). A car, van, bus or lorry rolls over when its
  wheels are stopped while it slides sideways: up a kerb at about 32 km/h across (a van
  at about 25; in practice in a fast handbrake slide, since the tyres soon scrub off any
  other sideways slide), into a wall or post at about 55 km/h across, or hit hard in
  the side by something much heavier (a bus at 60 km/h tips a saloon; another saloon
  would need about 100). The thresholds are multiples of the bare trip speed
  (`tripSpeed`, about 21 km/h for a saloon) in `Car.update` and `Car.jolted`.
  The car's cross-section then turns about whichever corner is on the road, and it comes
  to rest on its wheels again, on its side or on its roof, a little further across.
  Each landing on a new corner is heard, shakes the view and hurts you a little.
  Nobody drives or gets into an overturned car; you climb out with E, without the door.
  Any car, van or bus can roll except one still in the traffic, which leaves the traffic
  when it's hit hard. A police car, fire engine or ambulance that rolls is out of action
  for good: it drops out of the chase or the call, its lights go out, and its crew stays
  belted in rather than climbing out (at street level the windows read as dark, so you
  can't see them). Two-wheelers fall over as before. The `rollover` and
  `police-rollover` scenes check it.
- In the car, holding Shift is lane assist (`src/assist.ts`): it steers along your
  lane, and A/D then pick the turn at the next junction instead of steering. It also
  keeps you to the street's speed limit (OSM `maxspeed`, else 50 km/h in town, 70 on
  trunk roads, 80 on motorways): the gas fades out at the limit, and faster than that
  the car eases down to it. To drive faster, let go of Shift. With directions on (below),
  it takes their turns at junctions unless you press A or D.
- **Directions** (`src/satnav.ts`): press N (or the map button in the top right corner,
  or tap the directions card) to open the map of Prague, tap a street and "Drive here".
  While you drive, the quickest way by car (by time, along one-way streets) is painted
  on the road ahead in blue, with moving arrows, and the HUD shows the next turn, the
  street it leads into and how far there is to go; a blue pillar marks the spot. With
  no spot picked, the way leads to where the job wants you, in the job's green. The
  game waits while the map is open. The streets are only known as far as they have
  loaded (a few hundred metres round a parked car, about a kilometre once you drive
  and the view widens), so the way to somewhere further off runs to
  the loaded street that looks quickest from there and is worked out again as more of
  the city arrives, and whenever you leave it for a second or so. Reaching the spot
  ("You have arrived") ends the directions; "Stop navigating" on the map ends them
  sooner, the job's too until its next stop. On foot the card only says where you're
  headed. `node scripts/check-satnav.mjs` checks the routing offline on the real map;
  in the test API, `t.nav()` reads the way shown and `t.navTo(lat, lon)` picks a spot.
- **Walking directions.** In first person, open the map with N, choose a spot and
  select **Walk here**. The minimap traces a route along the pedestrian network,
  including paths, passages and stairs. The directions card shows the next turn.
  A pin behind a wall leads to the nearest footpath. For a distant destination
  the route extends as the streets ahead load. Getting
  into a car switches the same pin to driving directions. Getting out resumes the walk.

- **Indicators** (`src/blinkers.ts`): with directions on, your car's indicators flash
  amber on their own from about 4 s (at least 35 m) before each turn until you're
  through it, to the left for turning round. Glows over the car's corners, as its own
  lamps are drawn in its shader.
- **Minimap** (`src/minimap.ts`): a round map under the corner buttons, north up, about
  560 m round you: the streets you can drive (as far as they've loaded), the way the
  directions give, where it leads, the job's spot and the police. A click opens the big
  map; Settings, Minimap, turns it off.
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
  (`src/board.ts`). The stop covers the whole platform, the 30 m a tram fills behind
  where its front stops. Hold Space (on touch, "Hold to wait") to fast-forward until one
  is within about eight game seconds of your platform, at up to 12× speed. Trams at
  the stop's other platforms (across the street, or a hundred metres on, as at Újezd)
  are on the board but don't call off the wait. Where the stop's platforms have letters
  (Anděl's A to D, from OSM's `local_ref`), the board's title names yours and every
  row the platform the tram leaves from; trams from the other platforms are greyed. A
  tram held up on its way for a minute or more shows how late it is. While you wait,
  a tram held up out of sight is freed within seconds: a car in its way is pushed off
  after 2 seconds, a tram ahead driven through after 30 rather than 90.
  Walking pauses it and standing still
  picks it up again. Bus stops work the same way, counting only the buses that stop at
  your sign. On touch screens
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
- **Jobs** (`src/missions.ts`, `src/jobs.ts`): work that pays. Press J to ask for a
  job (on touch, tap the job card), J again to take the one on offer, K to turn it down and get
  another straight away (on touch, tap "another one" on the card), and J twice to give one up. With no job on, the card under the speed says "J look for work" ("Tap
  here: look for work" on touch). On a gamepad, d-pad right is J. On foot, on a bike
  or in an ordinary car, J goes through what's on: a
  courier run (fetch a parcel and bring it across town in time), a sightseeing tour (a
  tourist driven past three sights and back). A tourist at a pedestrian square meets
  the car at a nearby pavement and returns to that same kerb. The Regulars offer work for Jarka's pub
  crowd: bring a parked car to a yard (dents come off the pay), and once they know you,
  set a debtor's car on fire (ram it till it burns; nobody gets hurt) and a getaway (pick
  Venca up with two stars on you, lose the police, then drop him off). Sit in a taxi and you get fares to pick up
  and drive; in an ambulance, patients to take to hospital; in the cab of a tram you
  took over, a shift of five stops; in a fire engine, burning cars to put out with the
  water cannon before they blow up. The HUD shows the objective, the time left, the
  distance and the pay, and a green pillar marks the place (an arrow at the edge of the
  screen points to it when it's out of view). Being quick pays more. Failing or giving
  up costs nothing. The jobs you've done are kept in the saved game, along with how
  three made-up factions think of you (`src/factions.ts`; the Regulars' later jobs wait
  for their good opinion). `?mission=courier` (or `taxi`, `ambulance`, `tram`, `fire`,
  `tour`, `fetch`, `wreck`, `getaway`) starts one at once.
  Ask Fofr for work on foot in first person for a neighbourhood delivery. Follow the
  walking directions right up to the marked sender. Face them and press E to take the parcel. Deliver
  it to the recipient under the arrow with E (on touch, use the parcel button). Where
  the local footpaths are too short for a delivery, Fofr offers its cross-town run.
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
  lifting), the handbrake and "Get out". To drive with one hand, choose "Stick only"
  under Driving in the settings: how far you push is the gas, pointing back brakes,
  then backs up turning round until the car can drive off the way you point, letting go coasts, and the pedals go away. "Back on road" is top right, under the
  sound and settings buttons. On foot, “Jump” works even at a tram stop; waiting
  has its own button. Long HUD lists scroll within a compact panel. Pinch the map to zoom (`src/touch.ts`).
  Scroll over the map to zoom; scrolling a menu leaves the camera unchanged.
  Switching windows or apps releases held controls, including the horn and water
  cannon. Touch controls also release when the browser loses their pointer capture.
  Releasing a movement key in a developer field still stops movement; scenario
  `input-release` checks this and window focus in the running game.
- **Full screen and installing** (`src/install.ts`, `public/manifest.webmanifest`): the
  corner's expand button goes full screen and asks for landscape where the browser has
  the Fullscreen API. Settings → "Play as an app" installs the game where the browser
  offers it (Chrome and Edge, through `beforeinstallprompt`; there is no service
  worker), and on iPhone and iPad explains Share → Add to Home Screen instead. An
  iPhone's browser can't go full screen, so there the corner button opens that
  explanation. The installed app opens full screen and hides the button. To test
  the button where the browser doesn't offer installation, dispatch a fake
  `beforeinstallprompt` event with `prompt` and `userChoice` on `window`.
- **Controls card** (bottom right, `src/keyhelp.ts`): a cut-out of the keyboard with the
  keys for what you're doing lit up and a word under each; hovering a lit key gives the
  full sentence. H or its "hide" button folds it to a small button, and the game
  remembers that. The developer panel's key isn't on it. With a game controller the
  card is a list of the pad's buttons instead (`#help-pad` in `index.html`).
- **Game controllers** (`src/gamepad.ts`): the left stick points where to go, the
  triggers are gas and brake, X gets in or out, A jumps or brakes, d-pad right is J
  (jobs) outside the metro, and Menu opens settings. In a panel, the stick or d-pad moves focus and A activates the selected
  control; left/right adjusts sliders and selection lists. Returning from another
  window requires releasing held buttons before pressing them again.
  When a dialog opens over another one, controls follow the front dialog.
  `node scripts/check-controls.mjs` checks focus, pointer and controller handling.
- **Sound and settings.** Two buttons in the top right corner: sound on or off (also
  M), and the settings, with the start screen's choices during play: language, sound,
  graphics (also G) and weather (also P). On a phone the credits are in there too
  (`src/settings.ts`).
  Settings, credits, privacy, newsletter signup and feedback pause the game while open:
  the city stops stepping (no traffic, people or trams are updated) while the picture
  keeps being drawn (`node scripts/check-paused-physics.mjs`, plan 036).
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
  The player reaches for the handle on the chosen side before the door swings.
  A departing driver keeps the clothes and seated pose seen through the glass and
  rises through the open door. If the driver’s side is blocked, the player waits
  for them to clear the passenger door before sitting down. On the way in, the player leads
  with one knee and ducks below the roof while the shoulder camera stays outside.
  Taking a car with someone at the wheel: from the driver's side you reach in and
  haul them out onto the road, from the other side they get out of their own door
  and run. Press E again on the way to the door to change your mind. A car that is
  still rolling faster than a walk is left at once, without the door, and vehicles
  built from boxes (buses, lorries, the fire engine, the ambulance, the dustcart) have no door to
  swing: you step up to the cab and in.
- **Lamps.** A hard knock (from about 16 km/h) smashes the headlamp or tail lamp it lands
  on, which then stays dark and lights nothing at night; the headlamps behind a police
  ram frame never break. The tail lamps light up when a car brakes, by day as well
  (`knock` in `src/car.ts`, the pools of light in `src/lamps.ts`).
- **Police.** Knocking people over, pulling drivers out of their cars, wrecking
  traffic, ramming or stealing a police car and speeding past the police (20 km/h over
  the limit) earn stars, up to five; crimes the police see count three times as much.
  A crime none of them saw is phoned in six to eleven seconds later, and they go to
  where it happened rather than to you: the police only know where you are while they
  can see you, and otherwise make for where they last saw you.
  Police cars chase you along the streets and ram you; one stuck behind another goes
  round it to come up alongside you rather than ramming it. Some carry a ram frame on the
  nose, more of them the more stars you have. From two stars, when you're doing more than
  about 30 km/h, a car behind you now and then tries a PIT manoeuvre (`pitting` in
  `src/police.ts`, more often with more stars, `PITS` and `PIT_REST`): it pulls up beside
  your back wheels, keeps pace, then steers into your rear quarter. A blow from the side
  behind a car's middle swings its tail out faster than the back tyres hold it, so you spin
  for a second or so with the steering barely answering (`Car.upset` and `SPIN` in
  `src/car.ts`; any driven car spins this way, a police car you clip at the back too, not
  bikes, buses or lorries). You can beat it: brake or swerve away as it comes alongside
  (it gives up when it can't keep its place), or steer against the spin, which gets you
  back three times as fast (scenario `police-pit`).
  From three stars they also set up roadblocks (`src/roadblock.ts`, scenario
  `police-roadblock`): out of your sight, 110–330 m ahead on the way you're likely to
  drive (straight on at each junction, along the street network), police cars park across
  the street nose to nose in a V pointing at you, with a gap between the noses of 3 m at
  three stars, 2.7 m at four and 2.4 m at five, which a careful driver can get through.
  Wider streets get up to four cars from four stars (none on tram tracks, bridges or in
  tunnels). An officer from each car stands behind it and, armed, shoots as you come; stop
  near them and they come to arrest you. Ramming through works, but the parked cars are
  harder to shift than moving ones and it costs you speed and damage. Once you're past
  (or 450 m off, or after a minute and a half, or the chase is over) the officers get back
  in and the cars drive off (while you're still wanted they join the chase, as any patrol
  nearby would); out of sight they simply go. When you're on foot they stay
  on the road and stop at the kerb nearest you; then (or when you stop the car) an
  officer gets out (their door stays open till they're back) and runs after you, to
  your door if you're in a car. They stop at arm's length, facing you, spread round you
  rather than piling into one spot (two don't make for the same door of your car). Once they have hold of you it takes them a moment
  (about a second and a half on foot, two and a half at the door of a car you've
  stopped in) and then you're busted (the police keep the car); run, not walk, and you
  get out of their hands, or drive off before they open the door. The arrest is played out (`src/arrest.ts`): the officer opens
  your door and has you out of the car, your hands go up, they step behind you and
  put the handcuffs on, and you're turned round and walked to their car and put in the
  back (the officer walks round you to your side, not through you), while the
  other officers stand round a few steps off and nobody shoots (scenario `arrest-foot`). The screen fades to black on the way;
  you are then taken to the station and the picture fades back in. You can outrun them on foot, or take the police car they've
  left behind (E) and drive off in it. Its blue lights keep flashing while you're at
  the wheel, even when stopped, and switch off when you get out. In a police car, fire
  engine or ambulance, <kbd>X</kbd> (R3 on a controller, a "Blue lights" button on
  phones) goes from the lights to the lights and siren, then off, then back.
  With the siren on, traffic gives way to you as it does to the game's own emergency
  vehicles (`src/traffic.ts`). Each driver takes a moment to notice it. A car in front
  moves over to the right, or to the left on a one-way street when you're coming up
  on its right, slows down and stops by the side once you're close. On a street too
  narrow to let you by, it drives on instead. Cars coming the other way keep right and
  slow down, and stop if you're in their lane. Cars about to cross your path at a
  junction wait. Nobody honks at you, and a siren car standing still is only driven
  round slowly (scenario `siren-yield`).
  The police go easier on you in a fire engine or an ambulance: taking one is still a
  carjack, but the stars go three times as fast out of sight, and while you're not
  wanted they let speeding go, a wreck or someone knocked over counts about a third as
  much, and that little heat drains away by itself (`ON_DUTY` in `src/police.ts`,
  `scenarios/emergency-duty.ts`). From three stars a helicopter
  joins in and sees you over the rooftops, and the officers carry pistols: once they can
  see you from close enough they stop and shoot instead of running you down, and from
  four stars they shoot out of the cars too. Gunshots send people running. Stay out of
  sight and the stars go one at a time; they blink while nobody can see you
  (`src/police.ts`, `src/helicopter.ts`).
- **Your own helicopter.** Look for one in Zítkovy sady by Palackého náměstí,
  on the school field at Na Vítězné pláni, and at hospitals and airfields across Prague.
  The full list of landing spots is in `src/helipads.ts`. Press E to get in.
  W/S fly, A/D turn, Space climbs and Shift comes down. Climb above a building’s roof to fly over it.
  Land on open ground, a bridge deck or a flat or gently sloping roof and press E to
  step out. Both skids need support. A pitched roof or an overhanging skid prevents
  landing. In flight, press E to jump out, then press Space to open your parachute
  and steer with A/D. On a controller, press X then A. On touch, tap Jump out
  then tap Jump. You can bail out after engine failure too. If you splash down,
  you return to dry land. Impacts, gunfire and nearby vehicle explosions damage the aircraft.
  At 100% damage the engine fails, and the helicopter explodes on impact. Once you
  fly away from a pad, another helicopter can appear there when the pad is out of
  sight. The game clears away older helicopters left elsewhere when they are out of view.
- **Health.** Shots hurt you, far less in a car (the car takes most of it), and so
  does being run down, knocked over by a tram or thrown off a bike. A bar under the
  stars shows how much you have left once you're hurt, and it comes back by itself
  after a few quiet seconds. When it runs out you're wasted: you fall where you are
  and come round outside the nearest hospital, no longer wanted (`src/guns.ts`).
- **Your pistol** (developers only). Players have none: the developer panel's Pistol
  box hands it out, and that browser keeps it (the controls card and the touch Shoot
  button show only then). Hold the mouse button over the map to shoot where it points, or F
  (RB on a pad, Shoot on a touch screen) to shoot ahead, at the nearest car roughly that
  way; from a car the mouse shoots out of the window. Bullets stop at walls, cars and
  trams and never hit anyone: people in the way are passed by and run. Each bullet
  damages the car it hits (enough of them set it burning) and smashes a lamp it lands
  on. Gunfire is a crime (a star when the police hear it close by), and shooting a
  police car brings its crew out after you (`src/pistol.ts`).
- **Burning cars.** A car that's taken enough knocks (crashes, police bullets, a blast
  nearby) starts to smoke, then catches fire and a few seconds later blows up.
  Cars take less damage from collisions, with extra protection for the car you drive
  when touch controls are active. An explosion leaves
  a charred wreck that smoulders for a while and can't be driven. If your own car
  catches fire, get out: still inside when it goes, you're wasted. Every two seconds,
  flames can set another vehicle within about 1.5 metres on fire. The blast knocks
  people over, hurts you if you're near and shoves cars around. Vehicles within about
  two metres of the exploding vehicle's body catch fire and can spread the fire further.
  Blowing up a car you've crashed into is a crime, a police car more so
  (`src/fire.ts`).
- **Crash debris.** A crash near the camera throws sparks off metal, crumbs of safety
  glass that mostly fall where the car broke, bits of paint and plastic that fly further,
  bounce and slide to a stop, and a puff of grit; a scrape along a wall keeps sparking.
  The pieces are real size (glass a centimetre or two), lit like the rest of the street,
  and lie flat where they land for 15–25 s; each glass crumb has four faces that catch
  the sun or mirror the sky, so a patch of it glints as you walk past. An explosion throws burning embers and
  charred pieces far around. Smoke and flames face the camera, so they read from the
  street as well as from above (`src/debris.ts`, `src/particles.ts`).
  A window at a corner or side crumpled hard (level 2 of 3) breaks the way car glass
  does. The windscreen is laminated and stays in, crazed in spider webs: a small crushed
  spot, cracks running out from it, broken rings round it, and a crack where two webs
  meet. The side and rear windows are toughened and craze all over into centimetre
  cubes, frosted pale, and at level 3 pieces of them are gone, so you see into the car.
  From further off the cracks fade into an even frost instead of glittering
  (`brokenGlass` in `src/webgpu/vehicles.ts`, `BROKEN_GLASS_GLSL` in `src/car.ts`).
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
  If the road ends just outside cannon range, the engine closes the last few metres
  along a clear approach. Its crew finishes a smouldering wreck before taking another fire.
- **Ambulances.** A person hit by a car going faster than about 30 km/h, by a tram you
  drive, or caught near a blast stays on the ground instead of getting up after a few
  seconds; so does anyone a stray police bullet hits on the pavement. An ambulance is
  called from a few hundred metres away, drives to them by the streets (and through
  pedestrian zones, as the fire engine does) with red and blue lights and a quick two-tone
  siren, and its two paramedics get out and see to the patient for about nine seconds.
  Someone only hurt gets up and walks on. Someone badly hurt (a car faster than about
  48 km/h, a tram, a close blast, a bullet) is carried to the back of the ambulance by
  the two paramedics and driven away. Someone nobody comes to gets up on their own
  after four minutes. You can take an ambulance like any car (a carjack; the paramedics
  who are out run after you for a while). The developer panel's "Leave the nearest
  person hurt" button is the quickest way to see it (`src/ambulance.ts`,
  `scenarios/ambulance.ts`).
  From the pavement you can see the seats and steering wheel through the ambulance windows.
  Its street model carries the Prague service lettering, ECG trace and reflective checks
  (artwork in `assets/cars/prague-ambulance.svg`). The overhead camera uses the simpler roof model.
- **Dustcarts.** Within about 6 km of the Old Town Square, from 5:00 to 23:00, two
  dustcarts are out on their rounds near you (three between 6:00 and 12:00). Each keeps
  to the side streets at about 20 km/h, with its amber lamps flashing and two dustmen riding on the
  steps at the back. Every 16–32 m it stops beside a house. The dustmen jump down, go in
  (old-town bins are kept in the passage or the courtyard) and wheel a bin out to the
  lift at the back, which tips it. They take the bin back in, sometimes come out with a
  second one, then climb back on. Cars behind wait, or get past where the street is
  wide enough. That wait also applies to traffic joining the cart's lane at a
  junction. If the cart is crashed into or set on fire, the crew walk off and
  leave any bin where it stands; so do the ones on foot when you take it. Take it while
  they ride on the steps and they stay on, holding tight, with the amber lamps still
  going. Past about 40 km/h, or with a hard stop, a sharp swerve or a crash, they fall
  off. A fallen dustman runs after the cart and climbs back on if you stop for him
  (stood still and empty for 6 seconds, it's given up on); 45 m behind, he gives up
  and walks off. Hitting a dustman with your car knocks him over, as it
  does anyone else (`src/refuse.ts`, `scenarios/dustcart.ts`).
- **Developer panel**: press <kbd>`</kbd> (or add `?dev`). The search sits on top; below
  it are five tabs (Place, World, Picture, Driving, Testing), and the browser remembers
  the last one opened. Type a street for instant
  matches from the area's `names.json`, press Enter to look up a full address on
  OpenStreetMap's Nominatim, paste coordinates or a Google Maps / Mapy.cz link, or pick
  a spot on an OpenStreetMap map (right-click there copies its coordinates); the game
  loads the tiles there and drops you on the pavement. "Copy link" gives a `?start=`
  link; `?place=` takes one of the test places in `src/testkit.ts`. The panel shows your
  coordinates (with a copy button) and links to the spot on Google Maps, Street View
  (facing your way) and Mapy.cz. In free camera mode, drag the map to pan and
  scroll to zoom. Right-drag or Shift-drag to orbit the centre of the view. Drag
  up for a more angled view and down to look straight down. The Rotation and Tilt
  sliders let you set either angle separately. Straight down resets both angles
  to a north-up view. Searching or picking a spot on the map moves the camera. First person looks out at eye height (1.75 m) the
  way you face, with a wider 55° view. Settings → Camera view offers From above, First person and Third person and remembers your choice; the start screen's View row is the same choice (`playerView` in local storage), so whatever is picked there is what the game begins in and what Settings shows. ?fps and ?tps preselect it on the start screen. V cycles through those views on foot. First-person controls in Settings let you adjust the field of view, look sensitivity and walking camera movement. You can look down to see your feet or up to see the roofline. The camera URL options take precedence for that visit. At street level, people and their bikes are
  drawn life size there rather than 1.35× (`FIGURE_SIZE`). In a car or the helicopter it
  follows from behind and above like a driving game's chase camera, the car in the lower
  third, swinging round after it as it turns. It looks a little into a bend, eases over
  kerbs and bumps instead of following each one, hangs back a little further and widens
  its view by up to 7° towards 100 km/h, and comes in at once when a wall is behind the
  car. A click takes the mouse to look round with
  (Esc lets go); right-drag or Shift-drag looks round too. Driving, the view swings
  back behind the car smoothly once you stop looking round and the car has moved a couple
  of metres; turned while standing, it stays where you left it. In third person on foot the
  camera hangs a few metres back, just right of your head; a wall behind you brings it in
  at once and it eases back out, it rises only partly with a jump, and stepping into or
  out of a car blends from one camera to the other. These cameras ease with critically
  damped springs, so they move the same at any frame rate (`src/followCamera.ts`). On foot it plays like a
  first-person game: the mouse turns you, W/S walk the way you look and A/D step sideways (`t.eyes = { yaw, pitch }` in
  scripts). The left stick walks forward, back or sideways relative to the view. On a
  controller the right stick looks around. On a touchscreen, drag the street with your
  free thumb. In open space the third-person camera shows your feet at its neutral
  pitch. Next to a wall, the lens lowers toward your shoulder as it moves in.
  In first person each footfall follows the distance you actually cover.
  Stone, grass, gravel and settled snow have different footfalls. A paved path across a
  lawn sounds like pavement, even while the grass on either side crunches under snow.
  The
  view rises slightly between steps and settles on landing. As you approach a wall,
  the camera draws closer to your body so you can look into a shop window at arm’s length. The walking camera follows the system’s reduced-motion
  setting unless you choose Gentle movement or Keep steady. Nearby traffic, bells and sirens move across the stereo
  field as you turn. It loads 400 m round
  you, where the haze closes in, and draws only the tiles you look towards (ones already
  drawn stay when you turn); a tile coming into view shows a few meshes a frame, and only
  one tile joins the scene a frame anywhere, so none stalls the game (`View` in
  `src/tiles.ts`). Shadows only reach as far as the view from above would
  show. The ground's layers write no depth (from above nothing is behind the ground), so
  in first person each tile's plain ground goes into the depth first, 0.3 m low, and hides
  what lies behind a crest or down a slope (`GROUND_DEPTH` in `src/surface.ts`).
  From the street there is a sky (`src/webgpu/dome.ts`, the scene's background while the
  horizon can be in view; the free camera gets it tilted past 25°): blue overhead paling to
  the horizon, the sun where it really stands or the moon, stars on a clear night, and
  clouds. The fair-weather banks form over the same moving pattern that shades the
  ground. Seen from a bridge they have broad bases and sunlit sides. The sky and its
  water reflection read four neighbouring views from `cloud-bank.webp`, loaded the
  first time the camera sees the sky. `assets/sky/clouds.py` bakes these views through
  a 230 m-deep volume. `Sky.update` works out the colours (`DOME` in `src/sky.ts`), and the
  haze takes the horizon's colour, so the far end of a street fades into the sky. The
  Hradčany ridge and St Vitus remain visible beyond the nearby tiles in clear air.
  Eight photographs from the 3D survey carry depth, so the cathedral, palace and
  lower roofs shift against each other as you cross the river. At most two views
  blend at once. In the evening the southern palace front, St Vitus and St George's
  towers share the city's monument lighting and fade out after midnight. A separate
  67 KiB atlas loads only when those lights come into view. The ridge fades in at
  a distance, out in thick mist, and yields to the ordinary city as you approach it.
  Rebuild it with `uv run castle_horizon.py`
  in `pipeline/`.
  Broadleaf trees within about 150 m are drawn as a second model made to be stood under
  (`src/map/streetTree.ts`, `src/webgpu/streetTrees.ts`): a trunk with bark, boughs that
  fork, and at every branch end flat sprays of leaves (`public/street-trees.webp`, from
  `assets/trees/`), in the tree's own colour, turning and falling through the year to
  leave bare twigs. Each spray attaches by the stem at the bottom of its atlas image,
  with its tips pointing away from the wood. The atlas centres each stem rather
  than the whole fan. Sprays fit the surveyed crown and sway around their wooden
  attachment; their free ends flutter independently. Bark grain follows each bough
  around its bends. Thick trunks broaden at the roots, and the younger branches taper into
  smoother twigs.
  The tree pool divides each page by distance to the camera and reuses both instance
  buffers as you walk. A tree keeps its model for another six metres at the changeover
  so standing near it does not make it switch back and forth (`TreePool.street`).
  Farther away, each broadleaf tuft uses eight points around its rim. From above
  it has its original outline again.
  With a level street camera, distant trees behind the player use those crowns
  too. Nearby trees stay detailed on every side for their shadows. Turning
  reveals the boughs ahead, and looking steeply into the canopy restores the
  full circle of street trees.
  Shrubs there are a body of the same sprays, and
  conifers get whorls of spruce boughs laid over their plain tiers (`canopyGeometry`,
  `coniferGeometry`; `TreePool.canopy`). On High and Ultra the view from above has them too: sprays
  laid like shingles over every broadleaf crown's tufts, which keep its shape, shade and
  shadow underneath, and over shrubs and conifers; a spray whose leaves have fallen is not
  drawn. The free camera uses the street models once tilted more than 35°. The hole that opens the floors above you in a
  passage is off, windows mirror the sky by how flat you look along the wall, and what
  stands beside a lamp takes no more than a ceiling of its light (`WALL_MOST`). Seen at a
  slant the river is a mirror of that sky (`skyAt`, with a darker band for the far bank),
  and wet ground mirrors the sky low over the far end of the street. Under Testing: pause, one frame at a time, slow
  motion or 2–4×, money, stars, full health, nothing hurts, into a new car of any type,
  the test places, and the scenarios (see Testing above).
  **Watch approaching buses and trams** follows the next vehicle to your platform
  while you hold Space. Release Space to return to the player.
  "Helicopter next to me" parks one on the nearest open ground (flown like the one on
  Palackého náměstí, see Playing).
- **Driving sliders** (developer panel → Driving, `src/driveTune.ts`): multipliers on the
  handling of whatever vehicle you drive: acceleration, top speed, brakes, grip, grip lost
  at speed, fastest turning, turning circle, steering response, slowing when coasting, and
  how much rain and snow matter. They work in both the top-down and the realistic
  handling; 1× is the game as it ships. Each slider runs from 0.1× to 10× on a log scale
  (rain and snow from 0× to 5×) and says in a line what it does. Your own car's steering
  answers fifteen times as fast as the specs in `car.ts` give, and its turning circle is
  1.65 times as wide (`BASE` in `driveTune.ts`); those are the sliders' 1×. The values stay in this browser until Reset;
  double-click a slider to put it back to 1×, and Copy values copies them all.
- **VR** (`src/vr.ts`, an early version): play in a phone headset such as the
  Daydream View or a Cardboard, in Chrome on Android. Where the phone can show VR, the
  start screen has **Play in VR** and the settings' **Camera view** has a **VR** choice
  beside From above, First person and Third person (none of these show where it can't). VR
  isn't in the start screen's View row, since picking it reloads the page; on a page opened
  for VR that row is hidden and **Play without VR** starts from above. VR
  is drawn with WebGL, which only a fresh start can switch to, so picking it reloads the
  page; the game is saved as the page goes, and the start screen then offers **Start in
  VR** or **Continue in VR**, with **Play without VR** beside it. The choice is remembered
  (`playerView` in local storage, as for the other views); `?vr` asks for it from the URL.
  Out of the headset (Chrome's back button) the game shows **Play in VR** and **Play
  without VR** over the street. Picking another view leaves VR without a reload; the page
  stays on WebGL until its next start. (Chrome has no way yet to draw a headset with
  WebGPU for players; `docs/webgpu-vr.md` has the options.) Put the phone in the headset once VR has started. Chrome draws the lens correction and follows your head with the
  phone's sensors. You see the street from your own eyes; in a car you sit in the driver's
  seat. You walk the way your head faces, by one of three means:
  - the Daydream controller, paired from **Connect Daydream controller** (shown only
    with `?daydream`) over Web Bluetooth (not the old Daydream app): the touchpad walks or drives (top forward,
    sides sideways or steering), clicking it is E (get in or out), the app button runs,
    and the volume buttons turn you 30° at a time (not working yet, see below);
  - a gamepad (an Xbox controller works): the left stick walks forward, back and
    sideways relative to where you look (or steers in a car), and the right stick turns
    you smoothly, up to 90° a second;
  - nothing in hand: look well down for a second to start walking, again to stop.

  Chrome needs a secure address for VR: the beta and production sites, or `localhost`
  (on a phone over USB, `adb reverse tcp:5191 tcp:5191`). The first time, Cardboard asks
  for the camera so it can scan a viewer's QR code. The Daydream View has no code, so
  decline the camera and skip the scan. If declining opens Chrome's app info instead,
  go back and VR starts with the standard Cardboard lens settings.
  The graphics tier sets headset resolution when entering VR, from 45% on Lowest
  to 75% on High and Ultra, which keep the previous resolution. `?vrscale=0.3…1` overrides it for
  the visit. Leave and re-enter VR to apply a new resolution.
  With **Camera view → VR** selected, **Shorter view in VR** appears in Settings.
  It is off by default, keeping the usual 400 m horizon. Turning it on limits the
  view to 120 m and adds haze to reduce drawing work. This choice is saved separately
  from the graphics tier and takes effect on entering VR, without another page reload.
  Distant buildings disappear into the haze sooner. The page buttons, minimap and
  HUD aren't shown in the headset; the hidden minimap also stops drawing.
  Real Cardboard stereo on a Pixel 5, checked without a viewer on 22 November,
  remained well below 60 FPS. A shorter-view sample reached 22.3 FPS standing at
  the Old Town Square, but a moving sample was about 14 FPS. These samples preceded
  the final crowd and shader-retention changes. See the [stereo optimisation notes](performance-log.md#22-november-2026--stereo-vr-optimisation-and-optional-shorter-view)
  for comparisons and limits.

  In a car you sit in the driver's seat; in a bus, lorry,
  dustcart, fire engine or ambulance, up in the cab on the left behind the windscreen
  (`VR_CAB` in `car.ts`). The windows of the vehicle you drive are left out, so their
  tint and reflections don't fog the view; other vehicles keep theirs. Parts of the
  street car are modelled only from outside, so you see out through them. Checks: `window.__vr` (`fps`, `headH`,
  `headPitch`).

  The Daydream controller hasn't worked yet (tried 20 Nov 2026 on a Pixel 11 Pro). Chrome
  pairs with it and finds its data characteristic (service `fe55`, characteristic `0001`,
  notify), and starting notifications succeeds, yet no report ever arrives, whatever you
  press. Its other characteristics are `0002` (write) and `0003` (read), and reading
  `0003` fails with "GATT operation failed for unknown reason". The likely cause: a
  controller once set up with the Daydream app wants an encrypted, bonded link, and keeps
  its data from anything else. Write-ups from 2016–2017 got data simply by turning on
  notifications for `0001`. Not tried yet: forgetting it in Android's Bluetooth settings,
  then Google's reset (on USB power, hold App and Home together for up to 3 s), then
  pairing again from the game.

  For a phone whose Chrome can't be inspected remotely (Chrome allows that only with USB
  debugging on, not over wireless debugging alone), `?vrlog=<port>` sends the controls'
  state twice a second to `http://localhost:<port>/`: VR on or off, frame rate, movement,
  the Daydream controller's report count, raw bytes and characteristics, and every
  gamepad's axes and pressed buttons. Run any small listener that prints POST bodies, and
  pass the port through with `adb reverse tcp:<port> tcp:<port>`.

## How it works

The [findings for optimisation plans 007–012](optimisation-findings-007-012.md)
record the measurements, merge decisions and pending landmark asset activation.

- **Procedural look.** The ground is real geometry, one mesh per surface kind
  triangulated from OSM and coloured by world-space GLSL patterns (`src/shading.ts`,
  `src/surface.ts`): asphalt, granite setts, slabs, grass,
  water. Rails, zebras, lane markings and parking-bay outlines are thin strips on top.
  The general pavement is asphalt grey; slab squares are lighter, and park paths stay
  warm. Squares use their own OSM `surface` tag where one exists. Otherwise, a clear
  majority of mapped pedestrian and service ways crossing the square can supply its
  surface; Old Town Square takes the setts mapped on the ways through it. At street level on WebGPU the setts use a 2.5 m scan, including the worn stone faces and recessed joints. Walking
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
  across estates and past the city limits. A named square's paving gives way to
  surveyed sidewalks that follow the kerb. The open plaza, mapped pedestrian areas
  and car parks keep their paving, and a block's gardens start behind the pavement.
  Where the trams have a bed of their own beside the street it is ballast. `DERIVED_PAVEMENTS=1` builds the
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
  Where a roof's faces meet and end is marked too: lighter ridge and hip tiles, valleys
  lined with metal and darker either side, a gutter along the eaves, verge trims, flashing
  under a wall, and a kerb with a coping round a flat roof. The edges are those of IPR's
  model: the tile worker finds, for every roof triangle, which of its edges lie on the
  outline of its face and what meets it there (`src/map/roofEdges.ts`; another roof face
  below is a ridge, above a valley, a wall rising above it flashing, nothing an eave or a
  verge) and passes a distance to each in the facade attribute's spare numbers; the shader
  draws the lines (`roofLines` in `src/webgpu/buildings.ts`).
  A lit window at night shows a room: the pixel's ray is followed from the glass into a box
  as wide as the bay, as high as the storey and 4.2 m deep, and what it meets first is
  drawn (`room` in the same file: ceiling with the lamp's glow, walls, a back wall with a
  dado and a door or picture, the floor; a quarter of the windows have a blind half down).
  Along the edge of every carriageway runs a kerb of grey granite with a darker gutter
  inside it (`kerbs` in `src/ground.ts`), wherever what lies beside it is not carriageway.
  The kerb is raised: the carriageway (asphalt, setts, parking bays and the trams' own bed)
  lies 12 cm below the pavement, with the granite's face between them, so a tree pit or a
  traffic island in the street stands up out of it too. The terrain has one height for a
  street and its pavements, so the step is made in the game (`src/kerbDrop.ts`): each tile
  gets a picture of its carriageway, the ground's height is the terrain's less the kerb
  there (with a ramp a quarter of a metre wide on the pavement's edge), and the ground's
  layers are built to match, so cars, trams and people stand on the lowered street. The
  12 cm is the same everywhere and is not surveyed; there are no dropped kerbs at
  crossings or driveways. Within 8 m of a bridge or a tunnel the street comes back up
  level with the pavement, as their decks and floors have no step. `?flatkerbs` shows the
  ground as it was, to compare.
  The carriageway itself is worn (`streetWear`, in the gutter's own mesh): a dark stripe of
  oil down each lane, heavier where cars wait before a junction, and now and then a patch of
  newer asphalt laid along the street. Lanes, widths and junctions are the map's; which spot
  has a patch is made up, the same each time. Surveyed pavements are Prague's mosaic in one of
  three layouts, by stretches of some 44 m (`pavementStones` in `src/webgpu/mosaic.ts`):
  scattered stones, a chessboard on the diagonal, or a diagonal lattice of dark lines; which
  stretch has which is not surveyed. At street level the WebGPU view uses six-centimetre
  cubes with chipped edges, mineral flecks and shallow joints, following the scale of
  the city's cut limestone mosaic. Cut granite blocks follow the bends of the kerb,
  with narrow joints across it. On High and Ultra, in first and third person, the kerbs, stone
  steps and tram rails are lit as though they had depth (`kerbHeight`, `stairHeight` and
  `railHeight` in `src/webgpu.ts`): sunken joints, kerb stones and step blocks that have
  settled a little each their own way, a dish worn into the middle of each tread, the
  rail's groove. Each is a height field turned into a normal per pixel, so nothing is added
  to the geometry; the joints fade before they are only a pixel or two wide, where they
  would glitter, and all of it fades with distance. The same pixels get a roughness: rail
  heads and the worn middle of the steps catch the sun, and all of them shine more when
  wet. Rendered walls get the plaster's own grain as relief. It shows in sunlight and rain
  more than in shade, which is lit evenly from the sky. `CLOSE_RELIEF` in
  `src/streetSurface.ts` switches it (set from the tier in `src/graphics.ts`). Grass has lusher and thinner clumps, blades close up,
  and daisies and dandelions while the trees are in blossom. Tile rows and metal seams are
  lit and shaded by where the sun stands (`rowRelief`), and roof windows and metal roofs
  flash the sun where they lean half-way between it and the camera. Every car has a soft
  shade under it (`CarPool.under`: one mesh for all of them), and cruise boats and ferries
  trail a wake (`src/webgpu/wake.ts`). On Ultra the sun's shadows go through a filter of our
  own (`src/webgpu/shadows.ts`): it reads how far above a pixel its caster stands and widens
  the edge by 3.6 cm a metre, so a shadow is sharp at the foot of a wall and soft across the
  street (`?softshadows=on|off`). On Low and Lowest a person's shadow is that of a plain
  six-cornered shape as tall as they are, whatever they are doing, because a person's 506
  vertices drawn again for the shadow map cost a phone about a millisecond a frame on a full
  square (`PEOPLE_SHADOWS` in `src/figures.ts`; from the street people always cast their own
  shape; `?peopleshadows=full|simple|none` chooses for one visit).
  At night a landmark is lit by the floodlights at its foot all the way up, fading towards
  its top, spires included (`TALL` in `src/webgpu/lamps.ts`; the floodlights themselves are
  the surveyed festive lighting). As in Prague, that lighting goes off at midnight and comes
  back with the street lamps the next evening (`floodlightsAt` in `src/lamps.ts`).
- **Facades** are put together bay by bay and storey by storey from 144 parts: windows,
  doors, gateways and shopfronts in fourteen looks (`src/facades.ts`): three for
  19th-century tenements (neo-Renaissance, Art Nouveau and the plain houses of Žižkov
  and Karlín), houses of 1912-1925, baroque houses and plainer burgher houses, functionalist
  blocks and interwar apartment houses, the plain post-war houses and Socialist Realism of 1939-1953, infill since the 1990s, panel housing as built and as insulated since, and
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
  plastered without windows. So is a wall with another building's OSM outline just
  outside it (a neighbour in the next tile, or one whose own wall IPR doesn't have),
  unless that building is lower than 4 m or than 40 % of the wall. Each building gets its own plaster colour: mostly ochres,
  yellows, creams and stone-like sands and greys, with a few pale greens, pinks and
  blues, mixed differently for each style. The parts were
  drawn by an image model as twelve sheets, each asked for with an earlier sheet as a
  style reference (the briefs are next to them in `assets/facades/`; the fifth, the
  tenements' windows and portals, after a neo-Renaissance house in Mělnická), and are
  cut and packed by `assets/facades/build_atlas.py`. Phones and tablets load them at half size.
  At street level the WebGPU renderer fits recessed doors and windows, sash bars,
  projecting sills and stone hoods to nearby ordinary buildings. Where a continuous
  strip of wall is clear, a zinc downpipe passes over the cornice and ends in a
  cast-iron shoe above the paving. Its collars and wall straps share the façade
  draw, and a street plate can use another patch of plaster beside it. The meshes follow
  the mapped walls, including their sloping feet and existing passages. Opening
  positions and ornament are inferred from the façade artwork. In first and third person,
  historical façades give the first floor a centrepiece, a pair of end bays or alternating
  window hoods, with simpler windows above. Some ground floors have a house entrance,
  barred windows and a stretch of plaster. Others have groups of wider display windows
  with painted frames, Czech shop signs and occasional folding awnings. Window jambs
  have a constant depth above a separate horizontal sill. Modern infill can have facing
  brick or stone cladding, with window bays aligned vertically. Some flats have partly
  drawn curtains or lowered blinds. The same opening sizes and spacing carry
  on along the street beyond the range of the detailed meshes. The plaster grain
  covers two metres per repeat. The atlas builder sizes the glazing within each
  storey before measuring the openings. This leaves room for tall tenement sashes,
  smaller Old Town casements and low cellar lights.

  Panel houses use a 3.6 m room bay. Long walls repeat entrance sections, with
  stairwell lights above the doors on the access side and pairs of loggias on the
  sunnier elevation. Exposed concrete shows its joints. On insulated blocks, painted
  window bays alternate with pale balconies and some households have enclosed their
  loggia with sliding glass. The panel layout is inferred from the wall geometry.
  On functionalist frontages, steel ribbon windows run nearly pier to pier. Where a long
  wall shares an eave with an inward-rising pitched roof, the generator uses a residential
  interwar façade with divided casements. Fronts of four or more bays have stacked
  balconies at the ends, with rounded rendered parapets.
  Ordinary windows get physical depth through the first three upper floors.
  Nearby loggias have a slab, a guard and a rear door 0.92 m back, up to twelve upper
  floors. On High, up to 24 nearby walls qualify within 42 m (Ultra: 36 within 56 m). Lowest
  and the overhead camera use the original flat geometry. Photo landmarks keep
  their authored models.
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
  explicit choice. While it is in beta the seasonal roll leaves it out, and live
  weather and restored automatic weather show Cloudy instead. Cloudy comes up about
  a quarter of the time in autumn, winter and spring and a fifth in summer.
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
  street-level camera sees shorter rain streaks and smaller flakes around eye height.
  The weather fades the far end of the street sooner in a storm or snowfall. A local
  height map stops precipitation under the ground, roofs and bridge decks. It samples
  a 72 m square in strips and follows the camera as you walk. The
  ground gets wet in the rain (darker paving, puddles mirroring the sky and the lamps,
  rings where the drops hit; up close, the setts' worn tops, the asphalt's stones, the
  middle of stone steps and the rail heads shine more than the rest) and dries over several minutes; snow settles on the
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
  the street on cables instead, over the middle between its kerbs (the post is often
  surveyed a little to one side), or stands on the kerb beside it. A tram track on the
  street's asphalt or setts counts as roadway 3.5 m wide, so the lamps over the tracks
  where only trams and buses run (Lidická by Anděl) hang too; the game strings their
  cables across the track to the first wall each way, as it does across a street.
  On narrow streets such as Plaská and Mělnická, a regularly spaced row of surveyed
  lamps near the centre can also hang from cables when façades face each other
  across the street. This check uses the full paved road surface and requires
  clearance from the kerb, including where the mapped driving lanes are narrower.
  On the Zborovská block by the police station, each cable carries two lamps across
  the width of the street.
  Where there are still none, the game adds its own on lit
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
  with only the shadows that climb (those of lights lower than the car's roof, the
  headlights), and what stands more than about 3 m above the lit ground (a tree's crown
  over a parked car, the wall behind a van in someone's headlights) takes its light
  from that copy instead. On High and Ultra the headlights' cones in the air stop at
  the first car in their way. Helicopter searchlights use a separate soft volume,
  sampled through the air so the beam remains visible from inside it in first and
  third person. Their daytime ground glow fades smoothly at the edges.
  Lamp glints drawn as separate quads are confined to car roofs. Ground reflections
  use the wet ground materials and the selected reflection mode; dry grass and
  paving receive diffuse lamplight without floating reflection streaks.
  The lamps come on at dusk (earlier under heavy cloud),
  and a share of the windows is lit by the hour, most in the evening.
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
  out (`undress`), while the tile itself stays loaded. When a mesh retires, both its
  render object and its geometry are disposed. WebGPU otherwise retains the mesh and
  vertex arrays in its render-object registry even after releasing the GPU buffers.
  Shared materials remain available to the next tile. On foot that is about 6 of the
  14 loaded tiles. Zooming out, the tiles are drawn for the height the camera is
  heading for; the developer panel's free camera draws everything loaded.
  `src/tileWorkers.ts` dispatches one job per worker and gives required tile jobs
  priority over optional neighbour lighting. `src/skyRefresh.ts` coalesces lighting
  refreshes and ignores stale results; the worker-count default is unchanged.
  Which tiles are round the camera is worked out again only when the view changes
  (`TileWorld.picks`, the exact same view as the frame before, as when standing still,
  reuses it), while retries, builds and retirement still run every frame;
  `node scripts/check-tile-selection.mjs` compares it with the original selection
  ([plan 035](../plans/035-reuse-tile-selection.md)).
- **Buildings** come from IPR Praha's open 3D model (CityGML LOD3: real roofs, towers
  and domes), which covers the whole city. OSM buildings that the model doesn't have
  (newer ones, sheds, anything past the city limits) are extruded from their footprints.
- **Trees** are IPR's surveyed ones (`pipeline/ipr_trees.py`)
  plus OSM's; where both have a tree within 2.5 m, IPR's stands. The build also drops
  rows of OSM points in a surveyed travel lane when at least three distinct IPR
  trunks beside it show the same sideways shift. On Národní it skips five known
  misplaced OSM nodes and uses IPR's surveyed trunks between the parking bays. IPR says which are
  conifers and which fruit trees, and so does OSM sometimes (`leaf_type`, `genus`).
  Conifers are their own shape (`pineGeometry` in `src/map/vegetation.ts`, evergreen in
  winter), fruit trees are small. The woods, parks and gardens are filled up with made-up
  trees, 30% of them conifers in woods, but not next to a surveyed one; young woods (see
  "Young woods" under Unmapped ground) get small, dense ones. The dark woodland floor fades out
  over the grass beside it (`woodEdges` in `src/ground.ts`). Rebuild them with
  `uv run build_tiles.py <area> --layers ground`, then `ipr_terrain.py <area>`.
  Run `uv run ipr_trees.py --refresh` first to fetch the latest IPR inventory.
  A crown's top is where the surface models have it; its lower part is drawn out downwards
  in the shaders to where a city tree's crown begins, a sixth of the tree's height above the
  ground and never under 2.2 m (`CROWN_BASE` in `src/map/vegetation.ts`). Left as made for
  the view from above, the crown filled only the top third of the tree, a ball of leaves on
  a long bare pole that read as a palm from the street or across the river. From above
  nothing moves sideways; the shadows are longer by the crown's new depth.
  A broadleaf tree is its crown of tufts on a trunk, with a few boughs up into the crown
  (`crownShape`): the trunk's foot is put on the ground in the vertex shader, from how
  far below the crown the ground is, which rides in each tree's `yearly` number (`STEM`).
  Bare in winter, a tree shows branches running out from the trunk across the whole
  crown, forking twice on the way (`bareTwig`), so from above it is spokes that divide;
  seen from the side (first person) the lines on the tufts down the crown's sides are
  left out, where they would hang like a willow's, and the boughs show instead. From
  early October to the end of the year fallen leaves lie under every broadleaf tree in
  its autumn colour: a sheet in the same mesh, laid on the ground and cut into clumps by
  the shader, folded away the rest of the year (no extra draw; on steep ground it is
  level, so it floats on one side and is buried on the other).
  On Medium and above, street views replace those clumps near the eye with individual
  fallen leaves (`src/streetLitter.ts`, `src/webgpu/streetLitter.ts`): curled maple
  and linden shapes with stems, veins and mottled ochre, rust and brown surfaces.
  Their edges follow the local ground, avoiding water, buildings and abrupt steps.
  One mesh holds up to 3,600 leaves within 22 m; placement runs in short slices
  when you move or tiles change. Summer and overhead views hide it, and snow covers
  it gradually. The overhead tree geometry and its existing litter stay unchanged.
  Rendering keeps fixed-capacity mesh pages per tree shape (`src/trees.ts`). A tile
  leases pages containing only its own trees; unloading the tile clears the pages
  for reuse without changing the surveyed or generated tree data. Pages hold 1,200
  broadleaf or 128 shrub/conifer instances. Startup prepares 30 broadleaf, 20 shrub
  and 24 conifer pages; a denser view can add pages without dropping trees.
  Broadleaf shadows use an eight-point rim at every graphics tier, including Ultra,
  while the visible crowns keep their full geometry. `?treeShadows=full` restores
  the original detailed shadows; `?treeShadows=simple` explicitly selects the default.
  The existing twig mask, tree outlines,
  instance buffers and draw count are retained; shrubs and conifers are unchanged.
  `node scripts/check-tree-shadows.mjs` checks
  topology and draw-range restoration; add `--url http://localhost:5191/` for real
  renderer checks and seasonal screenshots. Run `node scripts/check-tree-pool.mjs
  --url http://localhost:5191/` for the existing reuse and shader-preparation checks;
  add `--full-shadows` to check the original detailed mode.
- **Landmarks** (so far Mánes with Šítkovská vodárenská věž, the Týn Church, the Old Town Hall with its tower, St Nicholas at Old Town Square, the Jan Hus memorial and the Marian column on the square, the National Theatre, the Rudolfinum, the Municipal House with the Powder Tower, House Okamura in Břevnov, and the Dancing House, which is the mesh as it is, since the city model has it as a plain prism without the legs you walk between) are cut out of IPR's
  photorealistic 3D model instead: a textured mesh of the whole city from oblique aerial
  photographs (summer 2023, about 5 cm/px), published as an I3S scene layer.
  Fantova budova, the historic main station building facing Wilsonova, has a custom
  model of its entrance gable, twin clock towers, glazed canopy and gallery windows.
  Both galleries meet modelled end pavilions with recessed windows, tiled roofs and
  glazed ridge lanterns. Gilded winged wheels crown the two outer clocks. The south
  pavilion has red panels around its end windows, and the north pavilion has oval
  windows and curved iron balconies facing the street. The central roof and platform
  wall follow the IPR survey. To rebuild it, run
  `uv run landmarks.py praha fantova` in `pipeline/`, then
  `uv run --project pipeline python assets/fantova/build.py` at the repository root.
  Run the landmark command for `centrum` as well to register the historic-centre placement.
  Across Wilsonova, four glazed stairwells stand on the forecourt. The model uses their
  individual footprints and a surveyed crown elevation of 220.4 m, with transparent panes,
  arched steel frames and a stair landing visible inside (`src/map/stationStairwells.ts`).
  The National Theatre uses the same custom model in top-down, first-person and
  third-person views. Its curved slate roof,
  gilded crest and three-horse chariots rise above the open Národní loggia and the
  carriage porch facing the river. The main structure follows IPR's survey. The
  columns, carved bays and roof surfaces share one texture atlas. The game loads
  the model with the theatre's usual tile and uses its roofs for rooftop landings.
  To rebuild `public/national-theatre.glb`, run
  `uv run --project pipeline python assets/national-theatre/build.py` from the
  repository root. It reads the cached Prague theatre survey from
  `pipeline/.cache/landmarks/praha/divadlo.mesh.glb`, produced by
  `uv run landmarks.py praha divadlo` in `pipeline/`.
  The Jan Hus Memorial uses a custom model in all views. The bronze groups, stepped
  granite base and carved inscriptions share one texture atlas. The model follows
  the existing solid footprint in both Prague maps. The lawn between the steps and
  the fence follows the mapped park outline. If the custom file fails to
  load, the tile uses its original survey mesh. Rebuild the app asset from the
  checked-in atlas with `uv run --project pipeline python assets/jan-hus/build.py`.
  The other four Old Town Square landmarks also have custom models. The Old Town
  Hall has a projecting Orloj with static astronomical and calendar dials, a
  gallery above the tower clocks and an oriel chapel. Týn Church has two tiers of
  turrets on each spire. The Old Town church of St Nicholas has a copper dome,
  open bell lanterns and a modelled south front. The Marian Column includes the
  balustrade, shrine, corner angels and the Virgin’s star halo.
  Run `uv run --project pipeline python assets/old-town-square/build.py` to
  rebuild all four, or append `radnice`, `tyn`, `mikulas` or `sloup` to build
  individual models. The three buildings read their original survey GLBs from
  `public/data/praha_now/landmarks/`, generated by `uv run landmarks.py praha radnice tyn mikulas`
  in `pipeline/`. The column needs only its checked-in sources.
  At St Nicholas on Malostranské náměstí the copper dome, lantern and belfry follow
  horizontal sections of that survey. The fitted roofs join the original drums and
  share the church's baked texture. Rebuild either area's model with
  `uv run landmarks.py <area> mikulas-ms --rebake` from `pipeline/`.
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
  A monument OSM doesn't map as a building (the Jan Hus memorial) isn't in the tiles:
  its OSM outline is copied into `MONUMENTS` in `landmarks.py`. It is cut to that outline
  with hardly any margin, keeps its lowest metre (its steps), and is marked `solid` in
  `landmarks.json`, so the game stamps its footprint into the collision grid as it does
  a building's.
- **Roof colours.** Pitched roofs are terracotta tiles (a palette matched to reference photos of Prague's roofs, brick-red rather than orange, with each tile a little redder or duller than the next; the landmarks' photographs get the same warming in the final GLB, or on load for older models, and where a landmark's photograph shows a red roof, the roof shader draws the same tiles at the photograph's brightness: `shadeLandmark` in `src/shading.ts` and its port in `src/webgpu/buildings.ts`), as nearly all of them are in Prague;
  flat roofs generated from footprints use bitumen, gravel or membrane, with the sheet
  seams aligned to the building walls. OSM's `roof:material` and `roof:colour` can make
  a roof grey slate or green copper instead, down to single building parts (the cathedral's grey roofs
  and copper domes), and `pipeline/roofs.py` corrects landmarks OSM gets wrong or leaves
  out, including wings of the Castle that both OSM and IPR draw as one building.
  Churches OSM says nothing about get slate. IPR's roofs take their colour triangle by
  triangle, from the OSM building or part holding at least half of the triangle (seen
  from above): IPR's triangles can be much bigger than a small part, such as a bay's
  copper roof.
  A flat roof nobody measured gets its tile colour greyed (`flat_roof` in
  `pipeline/ipr_buildings.py`: 35 % of the terracotta in grey), which came out pink in
  big plain faces. The game draws those eight exact colours as a warm grey instead
  (`PINK_FLAT` in `src/tileWorker.ts`), so no rebuild is needed; at the next rebuild of
  the buildings, lower the share in `flat_roof` to 0.12 and the table matches nothing.
  The level top of a pitched roof (a tenement's or a mansard's crown, the slopes rising
  to it) is drawn as sheet metal whatever the photos called it (`src/map/crownRoofs.ts`).
- **Stop shelters.** OSM maps many tram and bus stop shelters as small buildings that IPR
  doesn't have; the game draws them as a glass-roofed shelter on posts with a bench and an
  advertising panel, not as a little house (`src/map/stopShelters.ts`). Maps built since
  the pipeline marks them (`shelter` on the building, from `amenity=shelter`) use the
  mark; older maps take small narrow buildings along a tram track for shelters, which
  leaves bus-stop shelters as houses until the next rebuild.
- **Colours from the photo mesh.** Where `pipeline/mesh_colours.py` has run, IPR's
  buildings take their real colours from IPR's photorealistic mesh instead of the
  palette: each roof face its colour and material (tiles, slate, sheet metal, copper;
  flat roofs bitumen, membrane, gravel, planted or paving), and each building its
  plaster. Only faces under 3° count as flat: the shallow back slopes of tenements,
  which IPR codes flat up to 14°, are sheet metal (`LEVEL` in `pipeline/ipr_buildings.py`). The photographs were taken on a summer
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
  in `src/shading.ts` and `src/webgpu/buildings.ts`), and on flat roofs bitumen in metre-wide
  rolls with their laps and patched repairs, membrane sheets with paler welds, gravel,
  sedum and paving, all with sun-bleached patches and grime round the drains. The rolls,
  patches and glazing bars run square to the roof's walls: `roofEdges.ts` works out each
  flat roof's direction from its outline and keeps it in the fraction of the material
  number. A dark roof the photos call bitumen but which is clearly coloured is drawn as
  what it more likely is: blue as a glass roof, olive or brown as a dried-out sedum roof
  (`darkRoofAs`). Weathering and facades go on top. Mansards (roof faces steeper than 60°)
  get a row of windows (`mansardCoords` in `src/facades.ts`). Roof windows are found in
  the mesh's colours (level 14, `detect_windows`); chimneys are placed by rule on the
  ridges (`pipeline/roof_details.py`), since the mesh is too coarse to show them; both
  go into the building's own triangles, so they cast shadows and take the weather.
  What stands on flat roofs is made up by rule too (`src/map/roofDetails.ts`, roofs from
  `src/map/iprRoofs.ts` or OSM footprints): lift houses on tall blocks or a hatch on lower
  ones, rows of air-conditioning units with fans on top and a duct from each row, vents,
  vent stubs, a walkway of slabs from the way up to the plant on bigger roofs, skylights on
  halls and solar panels. It's seeded by the roof, so a roof keeps the same things.
  In `centrum`, walls are measured for 42 % of buildings and 93 % of roof faces get a
  colour.
- **Building import over water.** IPR footprints with at least 60% of their area
  over mapped water are omitted, keeping moored boats out of the building model.
- **Underground buildings.** OSM buildings tagged `location=underground` (the passage
  under the main station's forecourt, civil-defence shelters, underground garages) are
  left out (`extract` in `pipeline/osm_area.py`). Where IPR had nothing over them, the
  game used to extrude them as boxes, and they were solid to cars.
- **Streets on a building's roof.** A street mapped a layer up but not as a bridge or
  a tunnel runs on the roof of what's under it: Wilsonova (layer 1) over the main
  station's hall, which stood solid across the six lanes. A building on the ground
  there loses what the street's carriageway covers (`on_roof` in
  `pipeline/osm_area.py`, by the tags' width), with the median between its
  carriageways (gaps under 8 m, `ROOF_GAP`) and without the scraps left over (under
  25 m², `ROOF_SCRAP`). Not service roads: those mapped a layer
  up are rooftop car parks, on the roof itself. In Prague the hall is the only
  building it cuts (November 2026).
  At the station itself, the upper kerbs continue across the entrances to the
  lower concourse. The map follows the upper carriageways and their central
  reservation between those entrances (`pipeline/wilsonova.py`). Indoor footways
  and stairs confined to basement floors stay out of the surface walking network.
  Farther south, the lower pick-up road passes under both carriageways. The upper
  deck follows the surveyed kerbs and preserves the lightwell in the median.
  Traffic uses the deck height on Wilsonova and the original ground down the ramps.
  The lining of the neighbouring tunnel ends where the ramp opens to the sky.
- **Magistrála.** From the main station to the Liberecká end of V Holešovičkách,
  each direction follows its own smoothed height profile through junctions and over
  bridges. The profiles preserve the climb and the slope towards the kerbs.
  Ground and bridge decks use separate profiles wherever the roads cross at different levels.
- **Roads joining bridges.** A short piece of the upper carriageway can disappear where
  the approach meets a bridge at an angle over another street. During assembly,
  `pipeline/bridge_joins.py` checks the approach across its width against the deck,
  the raised ground at its end and the road below. Where the upper road drops and
  recovers within 16 m, the deck and the driving graph can continue to that landing.
  The lower street keeps its terrain. To compare map builds, run
  `node scripts/check-bridge-decks.mjs praha --ride-joins --save joins.json`.
  Its ride check ranks joins by how much the pitch over a 4 m span changes in 2 m of travel.
- **Crossing widths.** At junctions where road surfaces merge, zebra bars are limited
  to the crossed street's width plus 2 m on each side, adjusted for the crossing angle.
- **Terrain.** IPR's bare-earth model on a 4 m grid per tile: the ground, buildings,
  walls, trees, cars, people, trams and the camera sit at their real height, cars
  pitch, roll and roll downhill, and the ground is hill-shaded.
  On exposed carriageways the terrain mesh also checks short dips against the 2023 LiDAR.
  Where the road on both sides meets the scan and the scan follows a smooth grade
  through the dip, the mesh uses the scanned surface across the affected lanes.
- **Street placement.** Traffic-light poles and shared-bike rows move towards the
  pavement when their mapped positions fall on a carriageway. Tram-wire supports
  move out of the road too; a span is omitted when neither side can support it.
- **Bridges and tunnels** have heights of their own, above and below the bare ground
  (`pipeline/structures.py`). Where one meets a street on the ground it's at the
  ground's height, and in between its height runs evenly from end to end, along the
  ways and through junctions (Blanka's underground ramps).
  Components whose anchors are all known, tunnels included, use a distance-weighted
  harmonic graph solve, linear on chains and continuous at junctions. Components
  with an unknown anchor retain the previous two-nearest model, so an out-of-map
  portal cannot erase a supported tunnel interior. (Tunnels kept the two-nearest
  model until 18 November 2026: past the cover rule's pins both nearest pins lay by
  one portal, so each half of the Strahov tunnel ran level from its own portal and
  the halves met under Strahov in a ramp of 103 %, where players got stuck;
  `TUNNELS_HARMONIC = 0` brings it back to compare.) Selection uses
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
  crossing at different heights never share one. A bridge's outline as OSM draws it
  (man_made=bridge) shares a level with the streets on it, all the way along a deck
  that climbs. (Until 18 November 2026 only the ones near the height of the street
  that covers most of it did: Wilsonova's viaduct falls 10 m to Bulhar, where its two
  carriageways got a level of their own and the outline stood as a slab 6 m over
  them, the trams laid on its top; `OUTLINE_ALONG = 0` brings it back to compare.)
  The metro stations' corridors and
  stairs (OSM tags them as tunnels too) are left out, both as tunnels and from the
  walking network: footways and stairs underground that are indoors, reach a metro
  entrance or come within 30 m of a station or platform. Underpasses away from the
  metro stay. A connected tunnel that never reaches 2.5 m below the ground is
  treated as a passage at street level; its streets lose their tunnel tag when no
  underground level covers them.
  A bridge with a street on it is paved as pavement from parapet to parapet, with the
  carriageway laid over it between granite kerbs. The carriageway is as wide as the
  street, or wide enough for its tram tracks with a lane either side (on most Legií
  OSM's 7 m leaves the tracks out). Where the survey has no deck for a bridge, each end
  is as wide as the street on the ground it carries on from, measured over that
  street's last 25 m, and the carriageway goes over from one end's width to the
  other's (`bridge_ends` in `pipeline/kerbs.py`, the edges' `deck`): on the D0 at Řepy
  the bridges were 10.75 m wide against 14 m on the ground, with the deck showing in
  wedges between. The lanes keep to the narrower end, and a kerb that would lie on
  another street's carriageway (a slip road drawn over the motorway it joins) is left
  out. Bridges in `BALUSTRADES` (`src/ground.ts`; most
  Legií so far) get a stone balustrade instead of the plain parapet: a rail on balusters
  between pillars, each with a stone ball on top.
  Charles Bridge's deck is a straight band. OSM's outline of it takes in the piers'
  cutwaters, the triangles sticking out on both sides, which would otherwise be raised
  to the deck with a parapet round them. `pipeline/charles_bridge.py` finds them in
  the outline (the corners well out from the walkway's centre line) and writes
  `src/charlesBridge.json`: each pier's outline, the parapet line across it and the
  statues on it. The game (`src/statues.ts`) cuts the cutwaters off the deck's level
  and draws them as stone piers about 4 m below it, with a body under the arches. On
  the parapet over each pier stand its statues and groups, thirty of them, and
  Bruncvík on his column beside the bridge. They're low-poly figures on pedestals,
  facing the walkway, listed by OSM's name with how many figures each has and the odd
  feature: Nepomuk's bronze and halo of stars, the Calvary's crucifix with Mary and
  John, the Pietà, the groups on rocks, mitres, croziers, books and the Christ child.
  Within 75 m in a street view, the John of Nepomuk monument uses its photographed bronze,
  gilded palm and stars, coat of arms and three cast plates. The entire monument
  shares one texture atlas and one draw. The lighter figure returns beyond 90 m
  or when you switch to the overhead view.
  Each tile builds its share into one mesh at the deck's height, and the pedestals are
  cut out of the deck's level, so you walk round them. The bridge's lamps are gas
  lanterns on slim posts standing on the parapets: the surveyed lamps within 2.5 m of a
  parapet's line are moved onto it and drawn so (`bridgeLamp`), and the floodlights in
  the river under the arches are left out. `?nostatues` leaves out the statues and
  piers, keeps the deck as OSM has it and the lamps as the survey has them.
  Once the tile is drawn, each gas lantern sits at the height and centre of the
  coping beneath it. On Medium and above, up to twenty nearby gas posts and wall
  brackets show their brass burners, clear glass and individual mantles. At dusk
  the mantles light up inside the iron frames. Beyond 40 m the lamps use their
  simpler heads. At street level the wall shows courses of sandstone and
  separate coping stones. The pedestrian deck is paved with granite setts.
  From the river and Kampa the sixteen vaults are open from one side to the other,
  with wedge-shaped arch stones, a coursed soffit and cutwaters reaching the water.
  Their four groups share one atlas and load within 400 m of the bridge in a street
  view. The original deck, piers and tile draw are used overhead.
  Cars, trams and people drive or walk onto a bridge or into a tunnel where it meets
  the street and off it at the far end; parapets and tunnel walls keep them in, and
  whatever is on one level and another passes by. Under a bridge a round hole opens in
  it above you, as in a passage; in a tunnel a wider one opens down to it, the ground
  round you shown as bare earth. Everything else under the ground stays hidden
  (`track` and `view` in `src/tiles.ts`, the meshes in `src/ground.ts`). The car
  network keeps the tunnels and the magistrála, so traffic drives through them.
  At street level, a road tunnel has a lit concrete ceiling and tiled walls. The
  mapped tunnel way sets the ends of the roof, leaving the approaches open to daylight.
  The floor follows the map. Its headroom and finishes are inferred. From inside,
  the renderer omits just the pieces of the terrain mesh that enter the lane
  (`src/map/tunnelInterior.ts`, `src/map/tunnelEarth.ts`). A tunnel's outer walls stop
  half a metre under the ground over them, so an underpass only 5 m under its street
  doesn't show their tops in it (`tunnelLayers` in `src/ground.ts`).
  Where a wall at a step in the ground stands across a tunnel's way with the tunnel's
  floor at its foot, it is the tunnel's portal: the wall is open to 4.4 m over the
  floor and only the lintel above is drawn (`tunnelDoors`, `DOOR_H`). Such a wall comes
  from a floor listed in `pipeline/terrain_floors.json` (Divadelní under Národní); a
  tunnel's mouth in a hillside has none, and the ground there still runs up over it.
  Seen from above, the tunnel isn't drawn behind the opening (the tiles' coarse depth
  hides it), so the opening is filled with the tunnel's dark there (`DOOR_DARK`, a
  layer with `aboveOnly`); from street level that coarse depth and the fill are hidden
  (`tunnelEarthView` in `src/surface.ts`), the ground's own depth does its work, and
  you see into the lined tunnel. A tunnel's level reaches 12 m out of each portal at
  the portal's height (`PORTAL` in `pipeline/structures.py`), but only 4 m out of an end
  on a listed floor (`FLOOR_PORTAL`): the floor has the street's own height up to the
  mouth, and the 12 m left a step of 0.26 m across the road where the level ended.
  A road can change levels partway along an edge. Traffic, buses and the developer
  tool that puts a car back on the road use the level at that point along the lane.
  A named deck or tunnel is used where the loaded tile has its surface and height.
  A ground-level crossing under the same bridge still follows the ground.
- **Life.** Arcade car physics against the 0.5 m collision grid (`src/car.ts`), in
  which buildings raised 3 m or more off the ground (OSM `min_height`, like a covered
  bridge between two houses) leave the way under them open; AI
  traffic that keeps to its lane, brakes for anything ahead, pulls out round a car
  standing in its way where the street has room (and waits behind it where it hasn't),
  honks at you standing in its lane (the whole queue behind you joins in, later and
  less often; a cyclist rings the bell), after 5–10 s goes round you too, on whichever
  side has room and on through a junction the street crosses straight, with the queue
  following. A car stopped close behind you backs up to make room to turn if the way
  behind it is clear. Traffic gives way to the right (`src/traffic.ts`) and stops at red
  lights; pedestrians on the footpath network who round its
  corners, step past parked cars and bikes in their way, leap out of the way of fast
  cars and get knocked over, then get up again (`src/people.ts`). Traffic and
  people live within about 330 m of the player.
  Pedestrians step round each other too, keeping right when they meet someone; on a
  path too narrow to pass they fall in behind someone slower, and when two meet in a
  doorway one waits and then turns back. They spread across footpaths, squares and
  pedestrian streets. A street the walking network follows down its middle (one without
  a pavement mapped as a path of its own) is walked on its pavement, a little in from
  the kerb, found from the map's carriageways (`src/carriageway.ts`) when people first
  walk it. Where only the far side has one, they cross to it and stay there until it
  ends. Without a pavement wide enough, they keep to the street's edge, as in an
  old-town lane or a living street. Walls, buildings, fences and hedges stop them
  however they move (a tree or a post in the way, they step round), and paths that
  run on inside a building (an indoor corridor, a way through a block with no passage
  open in the map) aren't walked. The `pedestrian-paths` scenario checks passing,
  walls and pavements.
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
- **People waiting at stops** (`src/stopWaiting.ts`; `scenarios/bus-stop-waiting.ts`,
  `tram-stop-waiting.ts`, `funicular-waiting.ts`). At the bus and tram stops and the
  funicular's stations near you a few people stand round the sign, facing the street, some on their
  phones: more where more lines stop, on busier streets and at the busy hours (nobody
  publishes how many wait at a stop, so the roads' hourly load from TSK's counts stands in
  for it). Passers-by stop to wait one at a time; a stop that comes into view already has
  its people. When a bus pulls up, a few get off at its doors (more at a busy stop, at the
  busy hours and at the end of the line) and those waiting for its line walk to the nearest
  door and get in; the bus waits until they have, up to 25 s. Some give up after a while
  and walk on. Trams work the same way: people stand along the platform behind the sign
  (a tram is some 30 m long), get off at a door of each section and get on at the nearest
  one, and the tram waits for them. On the Petřín funicular (and the NH hotel's) they stand
  on either side of the track at each station, wherever there's ground (OSM doesn't say
  which side the platform is on), and nobody waits out of hours. The cars keep to the
  clock, so they don't wait for anyone. Three times as many wait for Petřín's as the
  street's busy hours would say, and half as many for the hotel's: a guess, as nobody
  counts them. On a tram you drive, `src/passengers.ts` lets people off and brings
  passers-by over; the people waiting for its line get on too, and the doors stay open
  until they have.
  A bus you drive does the same: pull up with its front by a stop's sign, stand still and
  press **X** (the Doors button on a touch screen) to open the doors. A few passengers get
  off, more at the end of its line (when the stop's name is the one on its display), and
  the people waiting for its number get on; a bus without a line only lets people off. It
  can't move off with the doors open; they shut by themselves once nobody is left to get on
  or off, or press X again (`scenarios/bus-doors.ts`). Close up (first and third person) each
  door's two glazed leaves swing in about their outer edges, as on the Citaros in PID's
  fleet, over about a second (`Car.passengerDoors`, slots 3 and 4 of the car door swing,
  which a bus's cab doors don't use); traffic buses open them while they stand at a stop and
  shut them in their last second and a half there. From above the doors don't move.
- **Tour groups** (`src/tours.ts`, `scenarios/tour-group.ts`). By day (most from about
  10:00 to 18:30, fewer in heavy rain and on lower crowd settings) up to three guided groups
  go round the sights near you: the Orloj, the Týn church, Charles Bridge, the Lennon Wall,
  the Castle and others (`TOUR_STOPS`, placed in front of each sight by hand from OSM; which
  sights tours stop at isn't published anywhere). A group of 7–16 stands round its guide
  in a half circle, a few looking about, for a minute or two, then follows the guide, who
  holds up a bright umbrella rain or shine, slowly along the footpaths to the next sight a
  few hundred metres on, waiting for anyone who falls behind. After two to five sights the
  tour ends and everyone goes their own way. Groups start out of sight, as if they'd been
  there a while. Someone frightened off or knocked down leaves the group; without its
  guide, or held up for 45 s, the group breaks up. Passers-by give way to a guide and to
  anyone standing in a group or at a stop.
- **Bikes and motorbikes.** Cyclists and motorcyclists ride with the traffic, and bikes
  and motorbikes stand on the pavements around you: E gets you on one. A collision that
  knocks a rider off or hits an unattended bike
  leaves the bike lying on its side until someone gets on. Take one from someone
  riding it and they're pushed off (knocked down if it was going), then run. Hit
  something hard and you're thrown off (a motorbike takes a harder knock than a
  bicycle). Get out of anything doing more than about 15 km/h (car, bike or tram)
  and you fall and get hurt.
- **Riding a bike or motorbike** (`src/twoWheel.ts`, in every view, for the one you ride;
  riders in the traffic keep to their lanes as before). It turns by leaning: steering
  asks for a lean and the rider takes a moment to get there, so turning in and swerving
  lag a little, and at speed the turns are wide (a motorbike at 40 km/h, leaned 43°, goes
  about 16 m round). At walking pace the handlebars steer it directly. The tyres' grip is
  shared between leaning, braking and accelerating: the throttle eases off in a bend by
  itself, but the brakes don't stand the bike up for you, so braking hard while still
  steering into a bend slides it out from under you, and you slide along the road beside
  it. Rain and snow take grip away, so it leans less (30° on a wet road instead of 43°),
  and a shower starting mid-bend can slide it out. The brakes stop a motorbike from 50
  km/h in about 11 m and a bicycle from 25 in about 5.5 m; the handbrake button is the
  back brake alone, which skids. Braking hard down a street steeper than about 15 % sends
  you over a bicycle's handlebars. A bicycle is pedalled at about 250 W: about 32 km/h on
  the level, 19 up a 4 % street, 11 up 8 % and 8 up 12 %; downhill it coasts up to about
  50. Stopped on a hill, the rider puts a foot down. Kerbs: a bump head-on, but riding
  straight at one faster than about 22 km/h on a bicycle (36 on a motorbike), or at a
  step much higher than a kerb, throws you over the bars; crossing one at a shallow angle
  (under about 20° to its line) washes the front wheel out. The `bike-handling` scene
  checks it. The developer panel's Grip, Steering response and Acceleration sliders also
  set how far you can lean, how fast you lean, and how hard you pedal. On foot,
  Space jumps (not at a tram stop, where it waits for a tram); in the air, a car can't
  knock you over. Move towards a bridge parapet, roof edge or steep drop and jump. Press Space again
  (Jump on touch, A on a controller) during the fall to open a parachute. It stays
  open until you land. Steer through freefall with A/D or the stick. W dives for speed. Under the canopy,
  You lean with the wing as you turn. W pitches you forward for speed and S leans you back for a slower landing. With the chute
  packed, drops onto solid ground are harmless up to 6 m. Beyond that, impact speed
  determines the damage, and a fall of 25 m or more is fatal. If you land in the
  river you return to where you jumped. Jump at a car that's standing still and you climb onto it and can
  walk over its bonnet, roof or boot and drop off the other side. If it drives off with
  you on top, you ride along until it goes faster than about 30 km/h and throws you off.
  From street level, the player keeps their walking avatar on either vehicle. Nearby
  traffic riders use the same close-avatar pool. Cyclists turn the cranks while
  pedaling and hold their angle while coasting. A motorcyclist keeps both boots
  on the pegs through a turn. Both riders put the left foot down at a stop.
  The overhead camera uses the lightweight instanced figures. Rebuild the fitted
  hand and foot motion with `node assets/rocketbox/actions.mjs`; the contact
  check is `node scripts/check-riding-poses.mjs`.
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
- **Bus timetables.** The departure board at a bus stop shows the next scheduled boarding
  departure per line at that platform alongside countdowns for simulated buses approaching
  the stop. Schedules use representative weekday, Saturday and Sunday service in game time.
  The map loads the platform's timetable when you approach a stop. See [the bus timetable plan](../plans/038-bus-timetables.md).
  The Prague map also contains a pilot for line 227. Its buses join loaded roads out of sight
  and follow the published stop sequence for each trip. They wait at a stop if early, and
  actual road traffic can delay them. The board uses the live countdown when it can match
  the simulated bus to the scheduled trip at that platform.
- **Bus stops and riding a bus** (`src/busstops.ts`, `scenarios/bus-ride.ts`). Every stop of
  the bus lines has a sign on the pavement beside where the bus pulls up: a blue plate with
  a black bus, lying flat so it reads from above, and the stop's name on the pole. It goes
  past the surveyed kerb (a parking lane can lie between) and up only once the ground there
  has loaded. Standing at one, the board lists the buses coming to it and to the stop of the
  same name across the street, counted down from where they are. Few buses are about at a
  time, so when none of your side's lines has one on its way, one is sent: it joins the
  line 220–400 m back, out of sight, and comes along it. Hold Space to wait, as at a tram
  stop. When it stands at the stop, E gets you on (F takes it over, throwing the driver
  out, as a carjacking). The strip lists the stops ahead: W/S or a tap picks one and the
  ride runs at 6× until 200 m before it; Shift speeds up at any time; E gets you off at the
  next stop, or at once while it stands. Held up for 10 seconds between stops, E lets you
  off where it is, and held up within 40 m of your stop you get off by yourself. The PID
  ticket covers buses (10 seconds to buy one), and riding without one risks an inspection
  at each stop you ride to, as on a tram: the bus waits there for your answer. Nobody
  parks at a bus stop: parking keeps the kerb clear from a bus's length behind the stop to
  just past it (`busStopZones`, asked by the tiles' parking through `world.noParking`).
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
  People are dressed for the game's date when they're made (`WARDROBE` in
  `src/figures.ts`): coats in the cold months, bare arms mostly in summer. In rain (not in
  snow) three in five of the walkers put up an umbrella (`src/umbrellas.ts`): one
  more instanced mesh over the crowd, drawn only while it rains.
- **Life-size people in first person** (`src/rocketbox.ts`): from street level the 24
  passers-by nearest you on High (within 36 m, less in a crowd; 32 within 45 m on Ultra,
  fewer and nearer below High) are drawn as avatars from the
  Microsoft Rocketbox library instead, walking, jogging, running and standing with that
  library's motion-captured clips; their feet keep pace with how fast they actually move.
  Each person switches to their detailed model when it finishes loading. If one model
  is missing or slow, other people can still appear, including uniformed crews whose
  base model and outfit are ready.
  The civilian in the navy overshirt wears the same outfit on foot, on a bicycle and
  on a motorbike. Up close, the fabric weave and bevelled trainer soles are visible.
  The lighter street model carries the same face and outfit in the shared crowd atlas.
  In a crowd, a nearer walker can take a detailed model's place from a civilian farther
  away. Walkers at similar distances keep their models as they pass one another.
  On Medium and above, ordinary walkers farther down the street wear those same
  fourteen outfits on lighter models. Their idle, walk, jog and run poses are baked
  into a texture, so walkers in the same outfit can share a draw call. The limit
  is twice the tier's close-avatar allowance, up to 64. The overhead view keeps
  its original figures. Rebuild the models and clothing atlas with
  `node assets/rocketbox/crowd.mjs` after building the full avatars.
  The player's model starts loading alongside the animation clips. The player gets
  a random avatar each session and keeps it when switching between
  first and third person, including after the detailed models are freed and reloaded.
  In third person the player turns into a sideways step while the camera keeps looking
  ahead. Backing up runs the stride in reverse, at the speed the player actually travels.
  Faster movement lengthens the stride. The slow-run and sprint clips top out
  at about 190 and 227 footfalls per minute. The supporting shoe rolls about the
  ball of the foot while the hips travel past it. Starting from rest shifts weight
  from a supported pose; reversing follows the slowdown through zero. After a
  sidestep the feet keep their landing direction until the next movement.
  During a sidestep the chest, neck and head turn back toward the player's sightline
  while the feet keep the captured step. Looking behind the body releases that turn.
  Phone calls, falls and other actions keep their own head poses.
  On uneven ground the player's knees and ankles follow the floor under each shoe.
  The captured swing and toe-off still set the step. Crossing an open edge, standing
  on a car or leaving the ground releases the terrain adjustment.
  Standing, each takes turns with a few ways of waiting (`STANDING`: shifting their weight,
  looking round, texting or calling on a phone, with a phone in the hand). In the rain
  anyone with their umbrella up holds it in the left hand, with Rocketbox's umbrella clip
  standing and that clip's left arm over the walk when moving.
  The player and nearby pedestrians keep their avatar when they jump, fall, get up or
  interact with a car. These actions follow the figure animation's clock. Rebuild
  them from `public/figures.glb` with `node assets/rocketbox/actions.mjs` after editing
  the poses. The two dustmen use the male-adult-10 and male-adult-17 avatars with their
  own high-visibility jackets, reflective bands and work trousers. Their riding pose follows
  the truck's steps on slopes, and the bin handle stays within reach as the bin tilts. From above
  they use the simpler figures in crew colours. Rebuild their clothing textures with
  `python3 assets/rocketbox/workwear.py` (Pillow, NumPy and basisu).
  Nearby police, paramedics and firefighters also use uniformed avatars. Police wear navy
  jackets marked POLICIE. Medics kneel to treat a patient, and firefighters wear helmets
  and brace the nozzle as they spray. Service outfits load when the crew is close enough
  to see. A nearby responder can take the place of a more distant civilian in the same
  avatar budget. Separate courier and rider groups use their usual figures.
  The avatars' code (with the
  texture and mesh decoders only they use) and the files (about 18 MB, in `public/rocketbox/`)
  load the first time first person is on (`src/lifesize.ts` imports `src/rocketbox.ts`
  then). A game opening in first or third person starts on them while the map loads:
  your own avatar and the clips at once, the crowd's once the map is in (so they don't
  hold up its tiles), and after Start the loading screen waits, 15 seconds at most, for
  your avatar and its shaders (`preload` and `warm`), so the game doesn't open on your
  stand-in. Two minutes after leaving first person, paused or not, they're freed again
  (`freeAfter`); the next look from the street loads them from the browser's cache
  (`scenarios/life-size-lazy.ts`). `?rocketbox=0` keeps the
  usual figures, to compare (`window.__drive.lifeSize.enabled` from a script or `bench.mjs --ab`).
  Rebuild with `assets/rocketbox/build.sh`; the avatars' list is in both it and `AVATARS`.
  The clips are read from Rocketbox's original FBX files and moved onto the avatars' own
  bone axes (`assets/rocketbox/clips.mjs`): converting them in Blender gives each file
  different axes, and the knees bent backwards. They're stored as 16-bit numbers, the
  standing ones at 15 frames a second, and joints that hardly move (most fingers) as one pose.
- **Birds** (`src/birds.ts`): by day in dry weather, flocks of pigeons arrive from beyond
  the view, wheel round a spot above the roofs for a minute or so and leave; over the
  river they're a few gulls gliding. Overhead and at a distance, one instanced mesh draws
  their silhouettes and a wingbeat narrows the span. A flock comes down as the overhead
  camera zooms in and shrinks away among the roofs. From the street, nearby pigeons have
  folded, barred wings, a green and violet collar and pink feet. The head dips to peck, then
  bobs as the bird walks. On takeoff the flight feathers spread and beat at the shoulders.
  Up to 24 close pigeons share these model parts (`src/streetBirds.ts`).
  `t.flock('pigeon' | 'gull')` puts one over you.
  On the ground, small groups of pigeons peck about on open ground just past the edge
  of the view; they take off when you come within 3 m on foot or a moving car within
  7 m, climb into a flock, circle nearby and come down on open ground again or fly off.
  `t.pigeons(ahead)` puts a group in front of you.
- **Café terraces** (`src/terraces.ts`): from 10 April to 27 October the cafés,
  restaurants and pubs that OpenStreetMap tags with `outdoor_seating` (and its beer
  gardens) have tables under square parasols outside: 1,212 places in `praha`
  (`pipeline/build_terraces.py` → `terraces.json`; a map without the file has none). OSM
  doesn't say where the tables stand or how many, so each place gets a row of two to
  six on the open ground nearest its point on the map, along the house, wherever a
  table fits clear of walls, roads and water; on a narrow pavement that may be one, or
  none. In first and third person the nearest tables have folding chairs on crossed
  steel frames, wooden slats and supporting ribs under the parasol. Up to 24 settings
  share two batches, one for the furniture and one for the coloured canvas. The
  overhead view and distant tables share the original single mesh. Nothing collides
  with them yet.
- **Cars** are built the same way (`assets/cars/build.py` → `public/cars.glb`): one
  low-poly body per type (hatchback, saloon, estate, SUV, van, pickup, taxi, police), shaped for
  the view from above, where the bonnet, cabin, windows and roof show, with a little
  of the sides, wheels and lights towards the edges of the screen; on top, the black
  scuttle and the wipers under the windscreen, an aerial, a glass roof panel on the
  saloon and the SUV, and the ribs pressed into the van's roof. `src/car.ts` puts
  each car's colour on the paint. At street level the cars within the close-car range (graphics table) have rounded
  tyres, recessed rims and dark wheel wells. The wheels roll with distance travelled
  and the front pair turns into a bend. Distant cars and the overhead view use the
  simpler wheels. Up close, each body has light clusters fitted to its actual wings,
  brake and reversing lenses, unbadged grilles and matching fictional Czech plates at
  the front and rear. The same individual lamps go dark when broken. Tinted windows reveal
  the dashboard, steering wheel and upholstered seats. The mirrors, latches and inner
  armrests move with their doors (`<type>_door1` to `4`, each with its origin on the hinge).
  Each street body downloads separately when its type comes within 14 m of the close-car range of the street
  camera. Inside the close-car range the sculpted shell takes over when ready. Until then the car
  keeps its fitted wheels and original body. The new shells share those wheel mounts and
  door pivots. The hatchback has a short bonnet and a raked tailgate, the estate a longer
  roof, and the SUV flared wheel openings and a taller, blunter nose. The estate, the SUV
  and the state police car carry low roof rails that follow the roof on three feet. The
  van has a tall nose and a high waist under its cab windows. Each has an amber
  repeater on the front wings, red reflectors in the rear bumper and a tailpipe under
  it. The cars have a fuel flap on the right; those with a tailgate have a rear wiper and a
  high brake light, and the van a pair of back doors with hinges. The pickup is a
  full-size truck: a bonnet at chest height, a tall grille, a shallow band of glass and a
  recessed, ribbed load bed. At street level the paint and glass mirror the street more
  faintly and out of focus than from above (`CAR_REFLECT.street` in `src/car.ts`): a
  sharp, bright street on every panel made smooth bodies look crumpled. The bonnet's profile and the van's waist come from `build.py`, so a
  change there needs both files rebuilt.
  Both police liveries keep their markings and optional ram on the close body.
  The bodies' proportions follow measurements of a real liftback: sides flat from the sill to
  a crease under the glass, side glass leaning in some 25°, the windscreen's base well ahead
  of the front door, front wheels a fifth of the length back from the nose and the back
  door ending over the rear axle. The taxi and the municipal police car are liftbacks.
  Rebuild these bodies with `blender -b --factory-startup --python-exit-code 1 -P assets/cars/street_shapes.py`.
  The sedan uses its own generator (`assets/cars/sedan.py`). It has a recessed
  sunroof, clear-coated paint, dark rear glazing, and separate lamp bowls below clear
  covers. Each tyre sits on its own ground sample when the car straddles a kerb.
  The brake calipers steer with the front hubs while the discs and wheels rotate.
  The speedometer reads road speed and the centre display goes dark in a parked car.
  Occupied cars draw a seated driver. The three static poses in `car-drivers.glb` load
  on the first close view of an occupied car and share instance batches across models.
  The doors stay in the body's instanced mesh. Each door vertex carries its hinge and number, and
  each car supplies its four opening angles to the vertex shader (`Car.open`,
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
  [plan 015](../plans/015-paint-cars-per-instance.md) for measured draw counts.
  A parked four-wheeler keeps its matrix (sat on the ground, pitched and rolled to the
  slope) until it moves, turns, is tracked onto another level or a tile comes or goes
  (`TileWorld.terrainRevision`), instead of sampling the ground under its wheels every
  frame; `node scripts/check-car-transforms.mjs --url …` checks the kept matrices
  against the original calculation ([plan 032](../plans/032-cache-parked-car-transforms.md)).
- **Helicopters**, yours and the police's, are one model built the same way
  (`assets/helicopters/build.py` → `public/helicopters.glb`, `-- --preview DIR` renders
  it): a light twin-engined utility helicopter, the fuselage and cowling lofted through
  rounded sections, with the main and tail rotors as objects of their own on their hubs.
  `src/helicopter.ts` paints the livery onto the parts named Paint, Band and Stripe
  (red for yours, the police's white and blue). The rotors turn with the world's time,
  not the screen's, and turning blades leave two faint copies trailing behind them, so
  they read as spinning from above at any frame rate, footage included.
- **Trams** run Prague's real lines (`src/trams.ts`), taken from OSM's route
  relations: each line goes round its whole route there and back. How many trams a line
  has out follows PID's timetable for the game clock's day and hour (`src/clock.ts`):
  a tram every few minutes on a weekday afternoon, fewer at weekends and in the
  evening, and only the night lines 91–99 after midnight. Trams join a line where the
  gap is widest and leave service out of sight. When the clock jumps (the time picked
  on the start screen, a night in the cells or in hospital, the dev panel's time
  slider) every line is laid out afresh for the new hour, keeping only a tram you're on,
  driving or waiting for; the `tram-clock-jump` scenario checks it. When a driver jumps off, the tram keeps coasting alongside the player even while the camera catches up. The departure boards count down from where the trams really are, so a
  tram held up in traffic shows up late there too. Each tram counts the seconds it has
  stood for something in the way and makes them up by cutting its stops short (to 8
  seconds at the least). They stop at
  every stop, keep to the track's speed limit, slow down for curves and brake for the
  tram in front and for anything on the track. A car left on the track that holds a
  tram up for 15 seconds gets pushed aside, slowly. A blocked traffic car gets 30
  seconds to clear the track, or 12 seconds outside the view, before the same recovery.
  Once a tram is pushing one car, the next one standing in its way goes along with it
  after a second (pushing one at a time, two cars nose to tail held trams up for good).
  A player-controlled car is never selected for this recovery. They're the types Prague runs, about
  as often as in its fleet: the Škoda 15T, Tatra T3R.P in coupled pairs, the Škoda 14T,
  the Tatra KT8D5R.N2P and the new Škoda 52T, with the line number on the roof in the
  line's colour. Each section of a tram lies along the track on its own, so it bends
  round a corner as the real one does. The bodies are built like the cars
  (`assets/trams/build.py` → `public/trams.glb`, `-- --preview DIR` renders them), from
  the real lengths and liveries. They run all over the city at once, so they come into
  view on their own timetable; only the ones near the camera are drawn. On the pavement,
  the destination reads across the cab and beside the first entrance. The T3's folding
  doors and the modern sliding doors reveal the steps or level floor when boarding.
  After dark the saloon lights pick out the seats and handrails through the glazing.
  Both cars of a coupled T3 carry a platform-side destination display. The 14T
  has two wide entrances in each suspended section and a single-leaf rear door.
  The 52T has five double doors and four bogies, with the centre section suspended.
  The 15T and KT8 ride on bogies at the ends and under the two articulations.
  Close models are prepared one section at a time as a tram approaches.
- Embedded tram rails show a polished running head and a dark flange groove on the
  inside. Joints cross the concrete bed at right angles to the track, including on
  curves and bridges. At walking height the asphalt beside it picks up the aggregate
  and small surface normals of a four-metre road scan.
- **Tram tracks** are OSM's `railway=tram` ways, including those mapped on the same way
  as a street or a bus lane (`highway=busway` or `service` with `railway=tram`, as on
  Lidická and round Anděl: about 300 ways across Prague): `pipeline/osm_area.py` takes
  the track from a way before deciding what kind of street it is. Where they lie comes
  from the technical map: `pipeline/di_tracks.py` moves each OSM node on a tram track
  onto the nearest surveyed track axis that runs the same way and is nearer to that
  track than to its neighbour (at most 3.2 m). OSM traces the tracks from aerial
  photos: half its track nodes in Prague move by 0.1 m or less, one in ten by more
  than 0.4 m, and in Újezd one moved 2.7 m, off the kerb it ran into. The tiles' rails (`osm_area.py`) and the
  lines the trams run along (`build_lines.py`) move the same nodes the same way, so a
  tram stays on its drawn track and the lines still share their points at the switches.
  The network, switches, bridges and tunnels stay OSM's. Where the survey has no axis
  (about 2% of Prague's track nodes, mostly the newest lines), OSM's position is kept.
  The railways and Petřín's funicular move the same way onto their own surveyed axes
  (a node only ever goes to an axis of its own kind): about three in four railway nodes
  in Prague, median 0.12 m, with the rest in yards and depots the survey leaves out,
  and the funicular by up to 0.5 m. Hlavní nádraží's tracks (`station_tracks.py`) move
  with them. `uv run di_tracks.py` reports how far each kind moved.
- **Overhead wires** (`src/wires.ts`) are built with each tile over its tram tracks: a
  contact wire 5.6 m above every track, where the pantographs reach, and every 30 m or so
  a span wire across the tracks, anchored to a building front when one is within 11 m
  (as in the old town's narrow streets) or else hung from a pole beside the track.
- **Transmission lines** (`pipeline/build_power.py`, `src/map/powerGrid.ts`) use
  OSM's mapped towers and their connecting spans, with approximate lattice
  shapes and wire sag. Heights come from OSM where tagged, or from the line
  voltage otherwise. They are scenery. Older maps have no transmission layer;
  `?nopower` hides it on maps that do.
- **Posts** (`src/posts.ts`): the wires' poles and the lamp posts are solid, and nobody
  parks round one. Drive into one slowly and you bounce off; hit a lamp post at more
  than 18 km/h or a wire pole at more than 32 km/h and it goes over the way you were
  going, and you carry on slowed. A fallen lamp goes dark, and a fallen wire pole
  brings its span wire down with it.
- **Fences and hedges** (`src/fences.ts`, `src/map/fences.ts`): OSM's `barrier=fence` and
  `barrier=hedge` lines are cut into sections of up to 3 m, drawn as pickets between two
  rails and as a leafy box (a tagged `height` is used, else 1.2 m and 1.5 m). From
  the pavement, the garden fences show woven wire and tension strands, fasteners
  on weathered boards, or painted iron bars. The street camera loads these finishes
  into the existing fence panels. A car
  goes through a fence at more than about 5 km/h, and the section it hits lies down
  the way it was going (and stays down); a hedge takes 18 km/h, slower than that a car
  bounces off. On foot you can't walk through either, but you can jump a fence lower than
  about 1.6 m. Unlike the walls, they aren't in the tile's collision grid (the people
  and traffic of the city ignore them). Older tiles have none: rebuild the `ground`
  layer (`uv run build_tiles.py <area> --layers ground`).
  A hedge's shape is rounded and a little uneven: a narrower foot, bellied sides, round
  shoulders and a slightly crowned top, its height and width varying by a few
  centimetres along it. Where the hedges stand is mapped; that unevenness is made up.
  From the street (first or third person, WebGPU) a hedge within 60 m is a hornbeam
  hedge: its body wears the photographed face of a clipped one, and over it stand
  clusters of hornbeam leaves, some half sunk and dark, some standing proud, stirring in
  the wind (`src/streetHedges.ts`, `src/webgpu/streetHedges.ts`; the two pictures are
  generated, `assets/hedges/`). They are made a 20 m patch at a time as you come near
  and thinned with distance. A hedge a car has flattened loses them. The leaves are a
  hornbeam's whatever the hedge really is, and every cluster's place is made up.
- **Grass from the street** (`src/streetGrass.ts`, `src/webgpu/streetGrass.ts`): in first
  and third person on WebGPU (Medium and up, like the hedge leaves), blades stand on the
  lawns within 24 m of you, wherever your feet would sound grass: short leaning cards of
  photographed lawn grass (`assets/grass/`, generated), cut into single blades, in the
  lawn's colour and the season's, bending with the wind and gone under snow. They are
  made a 6 m cell at a time and thinned with distance. Where the grass is comes from
  the map; the blades' places and lengths are made up.

- **Walls from the street**: near walls get the shade and dirt that make a house stand on
  its pavement. Under every window sill and under the ground floor's cornice the plaster
  is darker, fading out downwards (`SILL_SHADE`, `CORNICE_SHADE` in
  `src/map/streetFacade.ts`: thin sheets just in front of the wall, part of the walls
  modelled near you). Along a modelled wall's foot a strip of shade lies on the pavement,
  darkest at the wall (`FOOT_SHADE`). Every wall, modelled or not, is darker where it
  meets the ground and carries splashed dirt to an uneven height of a few dozen
  centimetres, and from close by the plaster is mottled and grainy (`wallFoot` in
  `src/webgpu/buildings.ts`; the WebGL path has the foot only). All of it is made up from
  the wall's shape; none of it says how dirty a real house is.
  A raised doorway in a modelled wall has stone steps up from the pavement, and while
  the wall is modelled they are solid: a car stops against them as against the wall
  (`stepAt` in `src/streetFacades.ts`, asked by `World.cellAt`). A wall's height above
  the ground is measured in the tile worker on the ground of its building's tile, which
  stops at that tile's edge. Before a wall is modelled it is measured again on the ground
  of the loaded tiles round it, so a building across a tile edge still stands on its
  pavement (on Vinohradská the foot and the steps were up to 0.9 m above it, with the
  plain wall below the foot showing as a pale band).
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
  `barrier=guard_rail` where it is mapped (not those on a bridge or with a `layer` above
  the ground: a barrier stands on the ground, and the rails on Nuselský most's central
  reservation stood in the valley), and elsewhere `pipeline/barriers.py` puts them
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
  bridges. Each boat is drawn as a single mesh. At night,
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
  bogies' clicks over the rail joints are made in code. The four nearest cars, buses and
  lorries within 60 m (not bikes) have a softer engine of their own, its note rising
  through the gears with their speed, and the whoosh of their tyres, panned to their
  side and pitched up or down as they come or go (levels in `PASSING`,
  `src/soundmix.ts`; the mixer's "Traffic around you"). Helicopters thud with their
  blades, whine and rumble: the one you fly on the engine's slider, spinning up and
  winding down with its rotor, and the two nearest others (police helicopters, one
  you've just left) on the traffic's, heard from up to 450 m (`ROTORS`). Crashes are
  made in code too (`src/crashsound.ts`), yours and any car's within 150 m: a soft knock
  for a bump at walking pace, crumpling metal from about 10 km/h, breaking glass from
  about 30 km/h, and each thing hit sounds its own (a wall's thud, a lamp post's clang,
  a hedge's rustle, a tram's heavy blow, a dull thud for someone hit). Anything that
  notices a blow calls `crash` in `src/impacts.ts`; a car isn't heard again within
  0.3 s unless it hits harder, and a hard one turns the rest down for a moment
  (levels in `CRASH` and `crashMix`, `src/soundmix.ts`; the mixer's "Bangs").
  Under it all is the city's own
  sound, long stereo loops from the same script, each as loud as where you are and the
  time of day call for: two layered Old Town crowds (each six stretches of the
  recordings at once, a murmur with no words to make out), full on the busiest squares
  and well down and muffled in side streets, by how busy the streets within 150 m are
  (the footfall map, 1 at the Old Town Square), and quiet at night;
  distant traffic by day and a low hum by night; and birds where it's quiet (a
  blackbird at dawn and dusk, small garden birds by day, a morning chorus early on),
  none in rain or snow, and none within 40 m of a trunk or primary road, fading back
  in by 150 m. It starts with the first key press or tap (the browser's rule);
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
  then along the kerb (`src/parking.ts`). The game checks the terrain under each
  parked car and skips places steeper than 30% across or 40% along the car.
  Outside the paid zones (most of the east and
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
  A parked car's whole footprint must clear any tree trunks within its bay.
  Parking also stays clear of the approaches to mapped outdoor stairways.
  Mapped service aisles inside a lot stay clear even when the traffic graph
  does not route through the lot.
  The ground must also support the corners of the car. A normal kerb is fine,
  but a corner hanging over a retaining step rules out the spot.
  As in Prague, some cars stand half or fully on the pavement, often vans and often
  at corners or where the kerb is otherwise empty. Every half minute or so, one in
  view sets off along the pavement at walking pace before it bumps down into the
  street (`src/pavement.ts`).
- **Roads** are marked from OSM `lanes`: dashed dividers, double centre lines on four
  lanes or more, edge lines on the main roads. A one-way street's lanes are laid out
  from its surveyed right kerb (less any parking OSM tags there), so where OSM splits a
  street as it gains a turning lane the other lines run on and the new one starts on
  the left; without a kerb, or one more than 2.5 m from half OSM's width, they are
  centred on OSM's line (`roadPaint` in `src/ground.ts`). In Prague their shape comes from the
  city's digital technical map (`pipeline/dtm.py`), which has every carriageway,
  lay-by and parking bay as surveyed, so the asphalt ends where the real kerb does,
  rounded street corners and traffic islands included. The survey draws a corner's
  curve as a few straight pieces, so the corners are rounded off (up to 1.5 m along
  each side) and hairline gaps between neighbouring surfaces closed; a parking bay's
  short sides stay nearly square. The survey's carriageways are those on the ground,
  plus any it has on a deck where OSM has an ordinary street running along it for 8 m
  or more (5. května over the roof of Pražského povstání station); the survey's green
  under such a deck is left out. A street crossing under the deck doesn't count, and
  where OSM has the deck as a bridge only the metres the street on the ground runs along
  it are taken (the streets in the valley under Nuselský most had brought its whole deck
  down onto the ground). OSM only says what a street is
  paved with: each part of the surveyed surface takes the paving of the nearest street,
  and cobbles reach at most 4 m past a cobbled street's kerb (a car park beside it is
  asphalt). Where a cobbled street meets an asphalt one, the more important street
  (by OSM's class, asphalt between equals) keeps its paving across the junction, out
  to the surveyed surface's edge, so the other street's paving ends in a straight line
  along it instead of in wedges along the halfway lines (`_paving_owners` in
  `pipeline/osm_area.py`, within 20 m of where the two meet). Each side's kerb, for the parked cars, is measured straight across from
  the street's centre line to where the surveyed surface ends (`pipeline/kerbs.py`).
  Past the city limits, and on the few streets the map doesn't have (about 2 %, mostly
  new ones), the asphalt reaches out to each kerb as OSM suggests: past the lanes to
  take in a tram track running in the street and a tagged parking lane, and where the
  pavement is mapped as its own way beside the street, up to that pavement's inner edge.
- **Passages through buildings** (OSM `tunnel=building_passage`: gateways, arcades,
  Prague's pasáže) are cut out of the buildings' collision footprint and stay in the
  street graphs, so cars, traffic and people go through. The importer leaves out passages
  tagged underground and indoor passages whose floors are all below zero. At Hlavní
  nádraží this keeps the lower concourse and its shop windows off Wilsonova. Many pasáže are mapped as
  `tunnel=yes` or `covered=yes|arcade` instead; such a way at street level (no lower
  layer or level, bar an arcade one layer down) counts as a passage when at least
  half of it runs inside buildings, or an arcade 3 m of it (`passage_tags` in
  `pipeline/osm_area.py`), rather than as a tunnel under the ground or a metro
  station's corridor. A tram track at street level that runs through buildings (its
  own arch, as beside Letenská's street and footway passages, or outlines drawn over
  the street) is kept open too, 3.6 m wide, wherever it does (`TRAM_PASSAGE`), so
  you can drive and walk along it. While you're in one, a round
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
  For trying places further out, `?countryside=live` (or "Past the map's edge" in the
  developer tools) reads the whole planet from Protomaps' daily build instead, through
  the dev server only (their server lets few sites read it, and the builds aren't for
  players), as far as 150 km from the middle of the map. Further away (Brussels, say),
  the developer tools' address search and map open the game again centred on the place
  you picked (`?at=lat,lon`): all of it countryside read live, with no Prague map,
  trams, lamps or saved games.
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
- **Crowded narrow pavements jam.** Where many people come both ways along a pavement too
  narrow to pass (the south side of Karlova at midday), they can stand blocking each other
  for minutes instead of stepping into the empty street. A tour group caught in such a jam
  breaks up.

## Not yet in the game

- More to do: written missions, factions that hold parts of town and react to you
  (`plans/004-missions-and-factions.md`). The first odd jobs are in.
- Visible damage on cars.
- Sound for people (voices, shouts).

## Building the map

<!-- read_when: rebuilding map layers, changing pipeline caches, or validating staged map generations -->

There are three ways to get a map. The game can read the public one over the internet
(`VITE_DATA_URL`, as in the README). `node scripts/download-map.mjs <area>` copies an
area of it into `public/data` (centrum about 55 MB, ujezd 4 MB, praha 1 GB in 38,000
files; `--countryside` adds the 283 MB past the map's edge), which is enough for
everything except changing the map: the pipeline can't rebuild part of a downloaded
map, as it works from its own caches in `pipeline/.cache`. To change the map, build it:

### Your first build

You need [uv](https://docs.astral.sh/uv/) (it brings Python and the pipeline's packages),
Node.js, [osmium](https://osmcode.org/osmium-tool/) (`brew install osmium-tool` or
`apt install osmium-tool`) and, for the landmarks, [Blender](https://www.blender.org/)
on the PATH (or `$BLENDER`). Then, from the repository's root:

```bash
pipeline/build_map.sh ujezd      # a few streets under Petřín
npm run dev                      # then http://localhost:5191/?area=ujezd
```

`build_map.sh` runs every step below in order for one area (`ujezd`, `centrum` or
`praha`) and makes the same map as the public game, apart from the month of the data
it downloads. It starts with `pipeline/fetch_sources.py`, which fetches what the
steps don't download on their own:

- OpenStreetMap: Geofabrik's Czech Republic extract, about 950 MB, kept until you
  ask for a newer one with `--refresh-osm`;
- this month's digital technical map from IPR (sets 2 and 3: the surfaces, and the
  kerbs and walls with their surveyed heights; about 400 MB);
- IPR's 2025 surface model at 1 m, the heights of roofs and tree tops (1.5 GB to
  download, 3.7 GB unpacked), for the ground cover and the trees;
- TSK's paid-parking counts, from the copy kept in
  [parkovani-praha](https://github.com/jonasjancarik/parkovani-praha) (TSK's own
  server needs a login).

Each step downloads the rest itself: IPR's 3D buildings, terrain and bridges, its
aerial photos and photorealistic mesh, PID's timetables and the bike feeds. Running
the script again brings a built area up to date and skips what hasn't changed.

`--quick` leaves out the two steps that read IPR's photorealistic mesh, the roof and
wall colours (`mesh_colours.py`) and the landmarks (`landmarks.py`, which needs
Blender). For `praha` the colours are a night's run and many gigabytes; the landmarks
take minutes. Without them the roofs and walls get the colours guessed from OSM and
the landmarks are missing.

Start with `ujezd`. From a fresh clone on 12 November 2026 it took about 40 minutes,
half of it downloading, and left 5.6 GB in `pipeline/.cache` (3.4 GB of it the surface
model); running it again took 2 minutes. Then `centrum`. `praha` takes from about two
hours (with warm caches) to a night, and tens of gigabytes.
[Rebuilding the map](rebuilding-the-map.md) has measured times, how to keep the
previous map while rebuilding, and how to check the result against it.

The public map is built without IPR's LiDAR raster (`ipr_lidar.py`, below): it is
used only in experiments. A build uses it only when the command asks for it
(`ipr_terrain.py --survey-scan` or `--ipr-lidar`), so importing it into
`pipeline/.cache` doesn't change what the same commands build, and a build that asks
for it stops if it's missing. `terrainOptions` in the map's `index.json` says whether
it was used.

### The steps

What `build_map.sh` runs, for `centrum`:

```bash
cd pipeline
uv run fetch_sources.py            # the OSM extract, the technical map, the surface model, the parking counts
uv run build_parking.py centrum    # TSK paid-parking sections (read by build_tiles)
uv run build_tiles.py centrum --resume --no-assemble     # OSM's buildings, ground, streets → .cache/layers/
uv run ipr_buildings.py centrum --resume --no-assemble   # IPR's 3D buildings
uv run mesh_colours.py centrum --resume                  # real roof and wall colours from IPR's photo mesh
uv run ipr_buildings.py centrum --resume --no-assemble   # again, to put the colours in
uv run ipr_terrain.py centrum --resume --no-assemble     # IPR's terrain, bridges and tunnels, hill shading
uv run --group cover ground_cover.py build centrum --no-assemble   # what the unmapped ground is made of, from aerial photos
uv run ipr_greenery.py build centrum --no-assemble       # IPR's surveyed lawns, shrubs, hedges and flower beds
uv run ipr_utility.py build centrum --no-assemble        # manhole covers, storm drains, traffic-light poles
uv run layers.py centrum --strict  # puts the tiles together → public/data/centrum_now/
uv run build_signals.py centrum    # traffic lights at junctions from OSM → signals.json
uv run build_river.py centrum      # the river's fairway, weirs and ferries → river.json
uv run build_lines.py centrum      # tram lines from OSM's route relations → lines.json
uv run build_metro.py centrum      # the metro from PID's timetables → metro.json
uv run build_buses.py centrum      # PID routes and platform timetables → buses.json and bus-timetable-*.json
uv run build_footfall.py centrum   # how busy the streets are → footfall.png
uv run build_lamps.py centrum      # street lamps from IPR's utility map → lamps.bin.gz
uv run build_bikes.py centrum      # shared bikes' stations from GBFS feeds → bikes.json
uv run build_terraces.py centrum   # cafés, restaurants and pubs with tables outside (OSM) → terraces.json
uv run build_districts.py centrum  # parts of town from OSM's cadastral areas → districts.json
uv run landmarks.py centrum        # landmarks from IPR's photorealistic mesh → landmarks/
```

For `praha` two more layers come before the strict assembly: `young_woods.py build`,
then a plain `layers.py praha` and `tree_sizes.py build` (the tree sizes are measured
on assembled tiles). `--no-assemble` keeps the game's tiles as they were until
`layers.py --strict` checks every layer and writes them all at once.

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
  copy. Run these commands from its `pipeline/` directory to prepare the base
  layers. [Rebuilding the map](rebuilding-the-map.md) lists the full sequence.

  ```bash
  uv run build_tiles.py praha --jobs 4 --resume --no-assemble
  uv run ipr_buildings.py praha --jobs 4 --resume --no-assemble
  uv run ipr_terrain.py praha --jobs 4 --resume --no-assemble
  ```

  Follow with the cover and tree steps for the area and the final strict assembly.
  For `praha`, assemble once before measuring tree sizes, run
  `uv run --group cover tree_sizes.py build praha --no-assemble`, then run
  `uv run layers.py praha --strict`.

  Repeat for `centrum` and `ujezd` when needed. `--resume` is opt-in: it skips only
  OSM chunk layers and whole IPR stages with matching grid, local sources,
  processing code, library versions and output hashes. IPR stages also check
  output options such as `--no-roof-details` or `--no-survey`. Worker count and
  assembly timing can vary between runs. Missing, damaged or interrupted outputs
  are rebuilt. Code outside a layer's processing dependencies, such as the audio
  builder, leaves its cache valid.
  Local OSM cuts also track their parent source, requested box and osmium
  executable. Replacing the country extract invalidates its area and chunk cuts. Overpass builds cannot reuse
  completed OSM chunk layers through resume because they lack a local source identity.
  Ordinary commands still rebuild the requested layers and assemble immediately.

  `--no-assemble` defers tile JSON and index assembly; IPR binaries are still written
  inside the isolated output. `layers.py --strict` checks chunk completion, the full
  grid, current local dependencies, IPR/terrain completion and binary hashes before
  writing assembled tiles. It requires both IPR stages and the new completion
  records, so old caches must be rebuilt once. Validation does not activate or deploy
  the result; switch the complete validated generation separately.

  Both IPR stages depend on the buildings, ground and street chunks because those
  chunks determine which tiles exist. The building stage also uses ground-water
  polygons to identify boats. Terrain uses the survey packages, hand-drawn
  terrain corrections, IPR bridge files and DMR 5G rasters when enabled. Large
  sources use path, size, mtime and ctime for identification, so copying a source
  to another location invalidates its cache.
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
- **The dense terrain model.** `ipr_terrain.py` reads IPR's terrain sheets as
  Shapefiles (`TER_<sheet>_shp` on ArcGIS Online, kept zipped in `pipeline/.cache/ipr/`,
  downloaded when missing): the same model as the CityGML ones but unthinned, about six
  times the points. The default since 16 November 2026; `--coarse` reads the CityGML
  ones (`TER_<sheet>_gml`) as before, for comparing. `docs/terrain-tin-plan.md` has how
  they compare.
- **Steps in the ground.** IPR's terrain model has a point about every 10 m, so on its
  own a quay wall or a retaining wall is a broad ramp. `pipeline/dtm_heights.py` corrects
  the grid from the technical map's survey (DTM ZPS: its lines carry heights): streets
  take the heights of their own kerbs, water its level, and the ground beside a bank or
  a retaining wall the height it has clear of the ramp. Original street vertices more
  than 30 m from the bare terrain are rejected before interpolation; their attached
  segments are skipped, keeping gross source errors from spreading into the ground.
  With `--survey-scan` (IPR's 2023 LiDAR raster, imported by `pipeline/ipr_lidar.py`;
  not on the public map), a vertex
  more than a metre below every height the scan has within 2 m of it is moved up to the
  lowest of them (a kerb's corner 2 m under the junction of Svornosti and Lidická sank
  the crossing into a pit), except by the map's bridges and in its tunnels. `--ipr-lidar`
  does this too, unless `--no-survey-scan`.
  Separate components of a survey line stay separate. The survey log reports rejected
  vertices, and in `off_scan` those moved up to the scan. See `docs/river-terrain-findings.md` for the checks and remaining limits.
  A car street is then level from kerb to kerb, with the pavement a grid cell beyond:
  each grid point on it takes the mean of both kerbs' surveyed heights across from it
  (`_level_across`), not the heights of whichever kerb is nearest, so hillside streets
  don't lean and twist from cell to cell. Kerbs of a street passing under or over it
  don't count, and where streets meet their heights are blended over a cell.
  Points under a bridge are left as the ground below it, but the street is levelled right
  up to the bridge's outline (without that, its last metres before a bridge over a
  cutting kept the cutting's heights and sagged).
  `ipr_terrain.py --no-level` builds without it, to compare.
  The street's last metres before a bridge are flat at the bridge's height out to where
  the ground comes within a metre of it (`abutment` in `pipeline/structures.py`).
  Where a dual carriageway's two bridges end side by side, the flat ground before them
  (`pads` in `pipeline/structures.py`) also takes in the strip between the carriageways,
  at their mean height, where it lies a metre or more lower and not under the decks
  (`twin_pads`): in front of the D0's bridges at Řepy that strip had sunk into a pit
  with walls round it.
  The [Italská profile pilot](road-profile-pilot.md) tries a separate, survey-fitted
  road surface with `?roadprofiles` and a generated file for the current map build.
  A short underpass that IPR's terrain model shows as an open cutting (it leaves the
  deck over it out, as it does every bridge's) is turned round to match the model
  (`structures.cuttings`): a tunnel cars use, under 80 m, crossed by a car street whose
  terrain dips over 2 m under it while the street is about level from side to side. The
  underpass goes on the ground in its cutting, and the street over it onto a short
  bridge (a way marked `cut`, without the flat terraces of `pads`). The street keeps its
  edge on the ground, with the deck's stretch as a level (`OnLevels.over_cutting`), and
  the game paints that stretch on the deck (`onDeck` in `src/ground.ts`). Under such a
  bridge the ground is the terrain model's cutting. The build log lists each one
  (`cutting: …`). See `docs/road-surface-findings.md`.
  An underpass that tram tracks cross stays a tunnel: a street with trams is wider than
  its car lanes, and only the lanes are ways to put on bridges. Národní over Divadelní
  got two decks 3 m wide lying askew over a pit, the tracks and the pavements between
  and beside them left in the air. The log's `under tram tracks: …` names every short
  underpass with tracks over it (ten in praha), whether or not the terrain model has a
  cutting there; in November 2026 Divadelní was the only one it kept from being cut.
  The optional `ipr_terrain.py praha --survey-companion-decks` adds a missing
  carriageway to a cutting bridge the build already found. The DTM must place both
  carriageways on the same bridge footprint. Surveyed kerbs from the added road must
  agree with the terrain heights at its approaches. The deck joins those approaches
  and the street underneath stays on the ground. If the new deck would put nearby
  bridge levels out of height order, the trial build stops. `dtm_structures.py LAT LON --ground`
  lists nearby survey objects, their placement levels, measured height ranges and
  source quality. Both commands use the local DTM packages.
  Each grid point also has a label
  (plain ground, water, or a terrace at a retaining wall's foot or on its top, whose
  outline is in the tile's `terraces`), stored after the heights in `<tile>.height.bin`.
  A wall has a terrace on both sides (`STRIP`, `TOP_STRIP` in `pipeline/dtm_heights.py`),
  so the street past the foot's strip and the wall's top never share a label in a cell;
  an edge two terraces share is drawn once, from the higher label (`shared` in
  `src/stepEdges.ts`). The top's strip ends square where its wall ends; those ends
  aren't walls, and the step lines there run level (`soft_edges`), so no wall stands
  across a path past a wall's end. Labels are numbered per tile; the step lines read across a tile's
  edge by numbers that are the same in every tile (`terrace_ids`). Where the labels
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
  each street, path or stairs on the ground that crosses it, and at each end of a bridge
  (the flat terrace before it is a step over the ground under the deck). A street or path
  that runs on into a tunnel opens no gap for its last 4 m (`INTO_TUNNEL`): it passes
  under the step through the tunnel's mouth, so the parapet runs on over the mouth as a
  railing (Divadelní under Národní; the tunnel's level lets you through below). `node
  scripts/check-step-edges.mjs <area>` counts the edges and lists the car streets that
  cross the highest drops (places where the terrain or the map is wrong), how many
  metres of parapet have a top that jumps from the metres either side of it (a sawtooth
  from above) and the roughest places; `--data <folder>` reads a copy of a map, and
  `--sides plane` reads the ground by a step from its own side's slope (`sampling` in
  `src/terrain.ts`, a trial, off in the game), and `--lines off` leaves a map's step
  lines out. `?nostepedges` turns the edges off.
  Straight outdoor stairways with a usable ground profile get granite treads
  and visible nosings from their mapped walk edges (`src/map/stairs.ts`). The stone
  (`stairStone` in `src/webgpu.ts`) lays each step in two or three blocks with
  staggered joints, wears the middle of each tread paler and smoother, and darkens and
  streaks the risers; the geometry's `trackCoord` gives it the step and the metres
  across the flight.
  Where the technical map surveys a flight, it is drawn from the survey instead, and
  flights OpenStreetMap lacks are drawn too (`pipeline/dtm_stairs.py`): the stairway
  outline (ZPS polygons, Schodiště) gets heights from its surveyed edges (ZPS lines,
  Hranice schodiště), a plane fitted to them gives the way it climbs, and the outline is
  cut straight across into treads of about 16 cm risers, with the flat ends left as
  landings. Flights that bend, branch or don't fit one plane are left out, as are sills
  under 12 cm, and the mapped stairs stay where no surveyed flight covers them. The
  game's terrain is smoother than the survey, so each flight is shifted to follow the
  ground under it, averaged over a few treads so the risers stay even. The flights are
  only drawn: walking still follows the ground. Ground tiles carry them as `flights`
  (top height and outline of each tread, and the nosing lines).
  Walking follows the smooth profile beneath the treads. A flight drawn in the map over
  the top of a wall beside it keeps to its own side of the wall (narrower, `WALL`), and up
  to 3.5 m at each end, a third of a short flight, may be left to the landing where the
  ground leans across it (`LANDING`): the stairs beside Divadelní's ramp down under
  Národní. At the south end of
  Štefánikův most, the lower sidewalk joins two flights of stairs beneath the road.
  The DTM ZPS transport edges run from 187.0 to 186.7 m Bpv. The walker and the rendered
  terrain use those landings. The two mapped stairways have a handrail along the
  bridge side, and the carriageway keeps its own bridge level
  (`src/map/bridgeWalk.ts`).
  Where the rules make a place worse than the
  terrain model alone (seen in the game), list it in `pipeline/terrain_keep.json` (a box
  in degrees and why) and it stays as the terrain model has it. A wall the survey doesn't
  have as one (it came out as a slope) goes in `pipeline/terrain_walls.json` (a line in
  degrees and why): the plaza over Divadelní's cutting by the National Theatre.
  A street's last metres before an underpass that stays a tunnel, raised to the street
  above as if they were inside it, go in `pipeline/terrain_floors.json` (an outline in
  degrees and why): the LiDAR's street level inside, a terrace of its own with the
  carriageway in it, and the highest ground out from its edge for the lattice points on
  top beside it, except at its open end (`FLOOR_SCAN` and its neighbours in
  `pipeline/dtm_heights.py`). It needs the terrain built with `--survey-scan`; without
  the scan a floor takes the terrain model's height where that is lower.
  [Places fixed by hand](hand-fixes.md) lists every such place.
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
  uv run --group cover python -B -m unittest discover -s . -p 'test_*.py'   # or npm test from the root
  ```

  They run on Windows too (`npm test` in PowerShell or Command Prompt). Pipeline code
  reads and writes text with `encoding="utf-8"`; Windows would otherwise use the
  locale's code page. `npm test` and CI make a missing encoding an error.
  To save a pipeline script's output to a file on Windows, set
  `$env:PYTHONIOENCODING = "utf-8"` first, or its Czech names and arrows can't be printed.
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
  street is sized from OSM. Set 3, the lines and points (kerbs with their surveyed
  heights, walls, fences, railings; 57 packages, about 270 MB), is downloaded only by
  `fetch_sources.py`, into `pipeline/.cache/dtm/ZPS_KR/`. The terrain's survey heights
  (`dtm_heights.py`) and the walls (`dtm_walls.py`) read it; without it the terrain
  has no quay or retaining walls and the streets aren't levelled from their kerbs.
  The surveyed tram track axes are in another set, transport infrastructure (DI, JVF,
  57 districts, about 31 MB): `build_tiles.py` downloads what's new into
  `pipeline/.cache/dtm/DI/` alongside set 2, and `di_tracks.py` keeps the matched track
  moves in `moves.pkl` there until the OSM extract or the DI files change. A new DI
  file rebuilds the ground and the streets; rebuild the lines (`build_lines.py`) with
  them.
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
- **Missing footprints.** Morávkova 1685/8 and 1685/10 share one cadastral footprint.
  The map uses the ČÚZK outline for RÚIAN building 146965833 and models its two low,
  dark roof sections. The street façade uses the two paint colours, pale band, windows
  and doors from the reference photo, with dark slatted gates and low masonry along
  the street. The supplement yields to a matching footprint in OpenStreetMap.
  For a local preview, rebuild the Prague buildings layer for chunk `13,5`.
- **Roof corrections.** `pipeline/roofs.py` lists landmarks by OSM id, and outlines
  (in WGS84) for parts of buildings OSM draws as one. After changing it, run
  `build_tiles.py <area> --layers buildings` and then `ipr_buildings.py <area>`.
- **Tram lines.** `build_lines.py` takes every tram line's two route relations (one
  per direction) and joins them into a loop along the track network, stops (with their
  platform letters) and speed limits included; it prints any line or direction it can't follow. Lines stay whole
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

Since 8 November 2026 the beta can run on Cloudflare too, which is where
beta.streetsofprague.com points now: `scripts/deploy-cloudflare-beta.sh` deploys any
committed code (no release) as the assets-only Worker `streets-of-prague-beta`, and
uploads the local map to R2 as `beta-<id>`, with the same fingerprint as on mbxp, unless
it's the map production serves (`deploy/data-version`), which it then uses by name. An
unchanged map isn't sent again; a changed one is a new upload of the whole map (about
1.4 GB), and an interrupted one is finished by running the script again. Its forms and
statistics go to production's Worker, as mbxp's do. The hostname is a Worker custom
domain now; to send it back to mbxp, remove the custom domain and recreate the proxied
CNAME to the tunnel, `9e92b145-1491-421a-942e-b33e6cb89a09.cfargotunnel.com`.

Both beta scripts build with `VITE_CHANNEL=beta`, which makes the game the test version
(`src/testversion.ts`): its start screen says the regular game is at
play.streetsofprague.com and has a "What's new here" sheet, a "Test version" button in
the game's corner opens the same sheet, and feedback messages say they came from it.
The list in the sheet is `deploy/beta-notes.json` (English and Czech lines, and `after`,
the release they were written after), baked into the build by `vite.config.js` through
`scripts/beta-notes.mjs`. The list is left out when `after` isn't the latest release or
when the beta is that release itself; running the script prints the notes, the commits
since the release and a warning when the notes are missing or behind. A list the player
hasn't opened yet has a red dot. To see it locally, run the dev server with
`VITE_CHANNEL=beta`.

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
builds a local dashboard from the reports. See [docs/telemetry.md](telemetry.md).

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
See [Email for Streets of Prague](email.md) for configuration, deployment
and the distinction between receiving mail and sending replies.

### Releases

How the game's version, the map data version and the map format fit together, and how
to roll back, is in [docs/versioning.md](versioning.md).

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

The credits for the map data, sounds and libraries are in the
[README](../README.md#credits).

### Licences for added assets

The game isn't commercial, but it may take donations (a "buy me a coffee" link), so
treat every asset as if it were for commercial use:

- Fine: CC0, CC BY (credit it in the README's Credits), our own recordings, and anything royalty-free
  that allows commercial use (e.g. Sonniss GDC bundles, Pixabay).
- Not fine: anything non-commercial (CC BY-NC, BBC Sound Effects, Meta AudioGen
  output), and AI tools whose free tier bars commercial use.
- Record each sound or texture that comes from outside, with where it came from, its
  licence and its author, next to the files (`public/audio/SOURCES.md`, `assets/SOURCES.md`).
