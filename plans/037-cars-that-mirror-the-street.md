---
read_when: Changing how car paint and glass reflect (CAR_GLOSS, carCoat in car.ts and webgpu/vehicles.ts), adding environment maps or reflection probes, or generating texture kits with Codex.
---

# Plan 037: Cars that mirror the street

## Status and intent

- Status: DONE: PHASES 1–3 BUILT (27 October 2026: `00be853`, `d9f00b8` with its WebGL fix `5571c51`, `7133c1e`). The seven strip images were reviewed and committed on 27 October 2026 (`assets/reflections/src/*.webp` with their prompts, packed into `public/reflections.webp`). Category: looks. Priority: P2.
- Effort: phase 1 one to two days; phase 2 one day plus review of the images; phase 3 two to three days. Each phase is checked and measured before the next starts, and the work can stop after any of them.
- Depends on: the car bodies of 27 October 2026 (`3ebb74f`, `7d03b2e`, `dd783e5`) and the stronger glass (`a1c7384`).
- Planned at: `5b57c19d5e9f12d38350f552b29ac3de7e7dd640`, 27 October 2026.

Real cars are glossy: their paint and glass mirror what's around them, a dark band of
buildings and trees along the sides with bright sky above it, and the sky on the roof
and bonnet. From the game's camera that's what makes a car read as painted metal, most
of all on cars away from the middle of the screen, which are seen at up to about 30°
from straight down. Ours only take a flat tint of the sky. This plan makes them mirror
a scene, in three steps:

1. A reflection shader for every tier: sky above, a band of surroundings at the
   horizon, the street below, a sun glint, stronger at a slant and when wet.
2. The band from images: a 360° street panorama strip for each kind of area, made with
   Codex image generation, chosen by where the car is.
3. On Ultra, the real surroundings: a small cube map rendered at street level in the
   middle of the view, for the cars near it.

Before editing, run `git status --short` and
`git diff --stat 5b57c19d5e9f12d38350f552b29ac3de7e7dd640..HEAD -- src/car.ts src/webgpu/vehicles.ts src/shading.ts src/sky.ts src/graphics.ts src/districts.ts`,
and compare with the excerpts below.

## Current state

The gloss (`src/car.ts:640–657`) adds one colour, `SKY_REF`, to what faces up
(`carTop`) and more of it where the surface is seen at a slant (`rim`); glass gets
`CAR_GLOSS.glass` times as much:

```ts
export const CAR_GLOSS = { dry: 0.25, sky: 0.5, lamps: 0.12, rim: [0.5, 0.8], rimSky: 4, rimLamps: 0.3, darker: 0.85, glass: 3.5 };
…
vec3 carCoat(vec3 c, vec3 n, vec3 v, vec3 lamp) {
  float glass = dot(c, vec3(.3, .59, .11)) < .04 && c.b > c.r * 1.25 ? ${CAR_GLOSS.glass.toFixed(2)} : 1.;
  float coat = mix(${CAR_GLOSS.dry.toFixed(2)}, 1., uWet) * glass * carTop(n);
  float slant = 1. - max(dot(n, v), 0.), rim = slant * slant * slant * slant * mix(…, uWet) * glass;
  return (uSkyRef * … + lamp * …) * coat + (uSkyRef * … + lamp * …) * rim;
}
```

`src/webgpu/vehicles.ts:45–56` is the same in TSL, for the default WebGPU renderer;
the two must stay in step. `SKY_REF` is set each frame in `src/sky.ts:192` from the
hemisphere light, dimmed at night. The sun's own highlight comes from the Phong
specular (`CAR_PAINT`, shininess 45). Nothing reflects a direction: no environment
map, no probe. The parts of a car are told apart by colour (glass by its dark blue
vertex colour); paint takes `paint` per instance (`CarPool.page`).

Graphics tiers (`src/graphics.ts`, `TIERS`) are ultra, high, medium, low and lowest;
the separate `reflections` setting (none, lights, mirror) is about wet streets and
is left alone. The parts of town are cadastral areas (`src/districts.ts`, from
`data/<area>_now/districts.json`), named, without a kind of area.

## Phase 1: a reflection shader for every tier

Replace the flat tint with a reflection of a made-up surrounding, looked up by the
reflected direction (world space) of each pixel of paint and glass:

- Above about 20° elevation: the sky, from the horizon colour to a bluer zenith, from
  the sky's own colours (`sky.ts`), and a soft glint where the sun is, so glints move
  across bonnets as cars turn.
- Around the horizon, from a little below it to about 20° above: a band of
  surroundings. In this phase a made-up one: darker than the sky, a little uneven along
  the horizon (a noise in the azimuth, so the line isn't ruler-straight), tinted by the
  time of day.
- Below: the dark street.
- The strength follows the clear coat: Schlick's Fresnel from a low reflectance
  facing the camera to strong at a slant; more when wet (`uWet`); glass more than paint
  (keep `CAR_GLOSS.glass`); a little less on dark paint than light. At night the band
  and sky dim with `SKY_REF`, and the lamps' light (`lampLightOn`) stays as the gloss
  that matters.
- One uniform scales the whole reflection (0 = off), for checks and for `--ab`.

Steps:

1. Write the reflection as one function in GLSL (`COAT_GLSL`, car.ts) and in TSL
   (vehicles.ts), with the same constants in `CAR_GLOSS` (or a new `CAR_REFLECT`
   next to it).
2. Pass the sky's horizon and zenith colours and the sun's direction as uniforms
   (shading.ts, set in sky.ts next to `SKY_REF`). Check what the sky already exposes
   before adding any.
3. Check the varyings: the WebGPU car shader must stay under the 16-varying limit
   (see the look-testing notes); the reflected direction can be worked out in the
   fragment stage from what's there.

Checks:

- Screenshots with `scripts/scene.mjs` (run in a browser of its own: `--port` of an
  unused server, never another session's): six types parked on the Old Town Square,
  straight down from 18 m and 40 m, at the normal height (100 m) in the middle and at
  the top and side edges of the screen; at 10:00, 14:00, dusk and 22:00; clear, overcast
  and rain. Before and after side by side.
- Both renderers: the default WebGPU and `?renderer=webgl`, compared for the same view.
- `node scripts/bench.mjs --ab "window.__ab = (on) => { … uniform = on ? 1 : 0 }"` on
  the stand and drive scenes; record in `docs/performance-log.md`.

Done when: paint shows sky on its tops and a darker horizon band on its sides at the
screen edges, glints move with the sun, night and rain look right in both renderers,
and the `--ab` cost is within noise or recorded and accepted.

## Phase 2: the band from images, by kind of area

Generate a 360° street panorama strip for each kind of area with Codex image
generation (`codex-imagegen` skill), and use it as the band from phase 1.

Not full HDRIs: image generation gives 8-bit images, poor at full spherical
panoramas (a seam where they wrap, warping at the poles). Only the band near the
horizon needs an image; the sky above it, the sun glint and the street below stay
from phase 1, so brightness the 8-bit image lacks comes from the game.

Kinds of area (a first list, to settle with the user):

- baroque Old Town and Malá Strana lanes
- 19th-century tenement blocks (Vinohrady, Karlín, Holešovice, Smíchov)
- panel housing estates
- villa suburbs with gardens
- the riverbank, the castle across the water
- parks and woods
- the countryside (fields, a village edge)

Steps:

1. Prompt and generate a strip per kind, about 2048 × 256, horizon at a fixed row,
   no sky above the rooftops (or a sky that's cut off later), eye height about 1.5 m.
   Show them to the user before anything goes in.
2. Make each wrap without a seam (cross-fade the ends), grade them to a neutral midday,
   and pack them into one texture (a column of strips), WebP, about 2 MB in all.
   Keep the prompts and the packing script in `assets/` so they can be made again.
3. Tint at run time by the time of day and the weather (the same tint the sky uses),
   so one strip serves morning, evening and overcast; dim at night as in phase 1.
4. Choose the strip per car: a kind of area for each cadastral area (a table next to
   `districts.json`, or worked out in the pipeline from the buildings' looks and ages,
   to be decided); each car takes the kind under it, as an instance attribute (a strip
   index, changed only when a car moves into another area), and the strips blend over
   some 50 m at the edges. Parked cars take it once.
5. Load lazily and fall back to the made-up band of phase 1 until the texture is in,
   and on Lowest.

Checks: as phase 1, plus the same car in three kinds of area, a car driving across an
edge between two (no pop), and the download in the loading profile
(`--profile-load`).

Done when: the user has approved the strips, cars in each kind of area show a band
that matches it at the screen edges, and the extra download and frame cost are recorded.

Stop if: the strips can't be made seamless or come out with recognisable landmarks or
text in them that can't be avoided; fall back to the made-up band.

## Phase 3: the real street on Ultra

A reflection probe: a cube map rendered from about 2 m above the street at the middle
of the view, so the cars near the middle mirror the actual buildings, trees, lit
windows at night and the sky between the rooftops.

Steps:

1. A `CubeCamera` (WebGPU: its cube render target) at about 128 px a side, drawing only
   the large merged meshes (buildings, roofs, ground, trees, sky) through a layer;
   no people, cars, furniture or particles.
2. Refresh one face a frame (the whole cube about ten times a second), round robin;
   move the probe with the view target, and refresh fully after a teleport.
3. Box-projected lookup: treat the cube as a box the width of the street around the
   probe, so reflections of nearby walls don't slide with distance. Optional if plain
   looks good enough.
4. Cars within some 60 m of the probe use it, blending to the strips of phase 2
   further out. Ultra only (`TIERS.ultra`), behind one flag so it can be switched off.

Checks: as phase 1, on Ultra; main-thread and GPU cost with `bench.mjs` (`--ab`
toggling the probe), since the puddle mirror's lesson was that a second render costs
main-thread time (9–19 %, `docs/performance-log.md`); shader compile time
and hitches when it first switches on (`--stalls`).

Done when: near cars mirror the real street, the cost is recorded and the user accepts
it for Ultra.

Stop if: the probe costs more than about 1 ms of main-thread time a frame on this
machine, or makes compile hitches the player sees; keep phases 1–2.

## Not in this plan

- Screen-space reflections: from straight above almost every reflected ray leaves the
  screen, so they'd show nothing.
- A probe per car, or planar mirrors on cars.
- Changes to wet streets or the `reflections` setting.
- Bikes, motorbikes and trams (their own materials).

## Working notes

- Never run a second Vite dev server whose `node_modules` is symlinked to this
  checkout: it rewrites the shared prebundled three.js and the game goes dark (see
  the 27 October incident). To compare against old code, swap a file on one server or
  give the second its own cache.
- Ask before committing generated images; keep the source images out of `public/`
  until approved.

## Result

- Phase 1: the made-up street in both renderers (`CAR_REFLECT`, `CAR_MIRROR` in car.ts,
  `STREET_REF` from sky.ts). No measurable frame cost (`docs/performance-log.md`).
- Phase 2: seven kinds of area, the strips packed by `assets/reflections/pack.sh`, a
  car's kind from its cadastral area (a table in `src/reflections.ts`), by distance
  outside the table, the riverbank where there's water within 40 m. The kind rides in
  `paint.w` and on into `vLit`, so no new varying (WebGPU's limit) and no new vertex
  buffer (the car pages use all 8). Not blended at the edges between areas: a car
  switches kind when it's 25 m on, which hardly shows at 70 px. Lowest keeps the
  made-up street.
- Phase 3: a face every third frame, 150 m, 128 px; cars left out of the probe (they
  read the cube while it's drawn, which WebGPU refuses); the sun and sky lights on a
  layer of their own for the probe (WebGPU and WebGL light only what shares a layer
  with the camera, so the mirror's layer alone came out black). +0.5 / +0.9 ms a frame
  standing / driving on Ultra. No box projection: plain looked right.
- Checked with `scripts/scene.mjs` shots, close and at the normal height, by day,
  dusk, night and in rain, on WebGPU and `?renderer=webgl`, High and Ultra.
