---
name: webgpu-port
description: How to port and optimize Streets of Prague's shaders with three.js TSL for the default WebGPU renderer (src/webgpu.ts), and how to check and measure each change. Use when working on src/webgpu.ts, porting a material from GLSL to TSL or node materials, sharing shader graphs, or comparing WebGL and WebGPU.
---

# Porting the game to three.js's WebGPU renderer

WebGPU is the default renderer (three r187, `src/webgpu.ts`); `?renderer=webgl`
selects the legacy `THREE.WebGLRenderer`. The default path uses TSL, three's node
language, which compiles to WGSL and can also target three's WebGL 2 backend.
Legacy GLSL customizations need explicit TSL ports. Read `docs/performance-log.md`
and `docs/optimisation-findings-007-012.md` for current results, and
the `performance` skill before measuring. The global `threejs-webgpu-performance` skill covers
three's build caching, instancing limits, warm-up and TSL rules for any project. The older per-port timings below are
historical observations, not claims about the current combined renderer.

## Where things stand

WebGPU is the default renderer now (`main.ts`). The old `WebGLRenderer` and the GLSL are no longer kept up
to date: they run with `?renderer=webgl`, and for a browser with no WebGPU adapter. A change to the look
is made in TSL only. Delete the GLSL, its setter hooks and `?renderer=webgl` when nobody needs them. (three's own
WebGL 2 backend under `WebGPURenderer` was tried on 29 September 2026: it drew the square correctly but at 21 fps with
hitches of a second and a half, and the page then reset; it wasn't looked into.)

Ported: the ground's patterns, noise, dirt and weather colour (`patterned()` in
`src/shading.ts`, through `setPatterned`; `src/webgpu.ts`), the tone curve (`sky.ts`,
registered with `renderer.library.addToneMapping`), and the buildings
(`src/webgpu/buildings.ts`: roofs, windows, facade pictures, grime, lit windows, rain
and snow, and the cutaway hole, also used by every `cutAway` material: landmarks, the
depth-only ground), and the trees (`src/webgpu/trees.ts`: facets, creases, small leaves,
bare twigs in winter, bark, snow on the crowns, the tint of light through leaves, and the
twigs' shadows). Shared helpers and uniforms are in
`src/webgpu/common.ts`. The lamps' light is ported too (`src/webgpu/lamps.ts`): the pools
drawn into the light map (`setPools`, a node material with the same custom blending),
`lampLight(world, normal)`, and `lampLit(node)`, which adds the light to a port's
`emissiveNode`. Since 1 October 2026 there are two light maps (the ground's, and the
bridges' for lights well over the ground under them, drawn and read only while one is
in view), each adding up light and brightness-weighted height (`a / luma(rgb)` is the
height the light falls at, relative to `LAMP_REF.x`); a material that reads the lamps
binds both textures. Each map has its own pools material: a uniform set between the two
renders of one frame did not reach the second. Ultra adds the cones and glints of
`src/lightfx.ts` (their materials are in `webgpu/glows.ts`); with them and people, trams
and posts as shadow casters, `--ab` at night in the rain showed no measurable cost on an
M5 (stand 9.9 against 10.3 ms, drive 8.6 against 8.9 ms, GPU 65% busy with other apps). It is on the ground (with the wet ground's mirror, `shine`), the
buildings, the landmarks, the trees and the poles. At night (22:00, 2×)
the whole lamp system costs +0.7 and +0.8 ms a frame on WebGPU against +0.2 and +0.5 ms
on WebGL (Old Town Square, Karlovo náměstí; `--ab` swapping `lamps.update`'s `on` for
0; the glows aren't drawn on WebGPU yet, so its number is a little low). Buildings cost 0.6–1.4 ms a frame at 2× on WebGPU against
0.7–1.3 ms on WebGL (`--ab`, three scenes). Trees cost +0.5 ms a frame on WebGPU against
+0.6 ms on WebGL (Petřín woods, 2×, clear noon, hiding every tree mesh; the GPU was 52% busy
before the run and 80% after, another app's). The ground's soft shading (`src/webgpu/soft.ts`,
a node material with the same custom blending, dig discard and stencil settings, made through
`setSoftShade` in `surface.ts`) costs +0.2 ms on WebGL and +0.7 ms on WebGPU (Old Town Square, 2×,
clear noon, hiding the meshes with an `alpha` attribute; GPU 41% busy before, 75% after). WebGPU
blends before the tone curve, so the colour is converted to linear and divided by the exposure:
the shading comes out about 10% stronger than in WebGL (mean change of −11.9 against −10.8 in
brightness); by night it looks the same. The cars, trams, funicular and boats
(`src/webgpu/vehicles.ts`: snow on the cars' tops, the tram, funicular and boat windows
lit at night through `emissiveNode`, and `lampLit`) cost +0.0 and +0.4 ms a frame on WebGL
against +0.8 and +1.0 ms on WebGPU (Old Town Square, the drive from Újezd; 2×, clear noon,
`--ab` hiding those meshes; another app kept the GPU about 80% busy). The people
(`src/webgpu/figures.ts`: the animation textures read with `vertexIndex`, the colour per part, `lampLit`;
their four colours share one interleaved buffer in `figures.ts` to stay within WebGPU's 8 vertex
buffers) cost +0.3 and +0.1 ms on WebGL against −0.1 and +0.3 ms on WebGPU (Old Town Square, the drive;
2×, clear noon; GPU 20% busy before and 76% after). The metro's tunnels and train (`src/webgpu/underground.ts`:
the hole's discard as a `maskNode`, the earth disc's position and mottling, and its depth written as 1 with
`depthNode`) cost +0.1 ms on WebGL and +0.1 ms on WebGPU during a ride (Old Town Square, 2×, clear 14:00, GPU 60%
busy; within the noise). The lamp glows, signal glows, spray, fire and skid marks
(`src/webgpu/glows.ts`; each legacy file takes a setter in the style of `setSoftShade`; the spray is drawn as
small quads for each drop because WebGPU points are one pixel wide) are NodeMaterials that blend before
the tone curve, so the glows' and flames' strength is scaled by eye (`GG` in `glows.ts`) and the smoke,
spray and skid alpha is approximate. The lamp glows cost +0.2 ms on WebGL against +0.7 ms on WebGPU (Old Town Square,
22:00, 2×; GPU about 80% busy). The others only show while they are used, and were not timed. Rain, snow and mist
(`src/webgpu/weather.ts`; `setFx` in `weather.ts`; the snow is an instanced quad for each flake) cost +0.0 ms on
WebGL and +0.4 ms on WebGPU for rain and its mist, +0.0 and +0.1 ms for snow (Old Town Square, 2×, 14:00, hidden with
`layers.mask`). At night they are much fainter on WebGPU than on WebGL, because the whole night frame is lighter there
(fog before the tone curve).

Legacy hooks and port status:

| Where | What | Notes |
|---|---|---|
| `shading.ts` `cutAway` | the hole over the player | ported for the landmarks, the depth ground and the trees (a `maskNode`) |
| `lamps.ts` `lampLit` | lamp light added to Lambert materials at `lights_fragment_end`, read from a light map render target | ported for the ground, buildings, `cut-*` and poles (`lampLit(node)` in a port); cars, trams, boats, funicular, figures and the signals' poles and heads have it too |
| `map/buildings.ts` `drapeRoofs` | an experiment's roof texture | low priority |

Every `ShaderMaterial` is hidden by a `visible` accessor on `THREE.ShaderMaterial.prototype` in
`configureRenderer`, so a ported one has to be built as a node material (not a `ShaderMaterial`) or it stays hidden.
All the effects are ported now; what's left of the plain-material list above is the roofs experiment.

Whole frame, 2×, high, 12 s each, `bench.mjs --extra "&renderer=webgpu"` (run each scene in its own process: a second
scene in one WebGPU run never finishes loading). Frames per second, WebGL then WebGPU; WebGPU ran with other apps
keeping the GPU 78–91% busy, WebGL at 21% (clear) and 80% (rain), so the pairs are not fair:

| Scene | Clear noon | Rain, 22:00 |
|---|---|---|
| Old Town Square, standing | 154 / 144 | 119 / 123 |
| Old Town Square, walking | 145 / 137 | 129 / 139 |
| Petřín woods | 160 / 167 | 154 / 153 |
| Drive from Újezd | 115 / 131 | 120 / 136 |

Since 13 November 2026 the tone curve is in `src/grade.ts` (the numbers, and the curve on the
CPU) and `src/webgpu/grade.ts` (the node, and `ungrade()` for colours meant for the screen:
use it, don't undo the curve by hand); `?grade=old` keeps the one before. On Ultra the frame
is drawn through `src/webgpu/post.ts` (a `RenderPipeline`: scene pass, bloom, the curve, a
vignette), so the scene's target there is the pass's, not the canvas's. From the street the
scene's `backgroundNode` is the sky of `src/webgpu/dome.ts`, and near trees are a second
instanced mesh over each page's instances (`src/webgpu/streetTrees.ts`, a node material of
its own, not a port).

## How a port is wired

- Keep the GLSL path exactly as it is. The TSL version lives in `src/webgpu.ts`
  (split into `src/webgpu/*.ts` once it grows past a few hundred more lines) and is
  switched in by a hook the WebGPU module sets, as `setPatterned` does for the
  ground. The module is loaded for the default WebGPU path after renderer
  initialization, not for the legacy `?renderer=webgl` path.
- **Load order: settled with `addPort`, neither lazy materials nor a boot module.**
  The game's module-level materials (`car.ts`, `trams.ts`, `funicular.ts`,
  `vegetation.ts`'s `treeDepth`) and the per-tile ones stay as they are, legacy
  materials with `onBeforeCompile`, so the game's code needs no change. When
  `WebGPURenderer` builds a shader for a legacy material it converts it in
  `library.fromMaterial` (one place, called by the node builder, once per distinct
  render-object cache key); `configureRenderer` wraps that, and `addPort(/^cars$/, (node,
  legacy) => { node.colorNode = …; })` decorates the converted node material. Ports are
  chosen by the legacy material's `customProgramCacheKey()`, which every one of these
  materials sets already. Build each port's node graph once at module level and share it,
  or every render object compiles its own shader (7 ms on an M5, up to ~90 ms on a
  phone, on the main thread: the stalls while driving). three.js keys a build by its
  nodes' ids, so a `uniform()` or `texture()` made per tile makes a new shader per tile:
  have one shared graph read per-material values with `materialReference(name, type)`
  (a texture at your coordinates: `.context({ getUV: () => uv })`), as `groundGraph` in
  `webgpu.ts` does. Nodes made inside an `addPort` callback are new for every converted
  material (the trees' port still does this). Every `InstancedMesh` gets a build of its
  own anyway (three.js keys it by `uuid`), so reuse instanced meshes rather than making
  new ones. `--stalls` in the bench lists the builds by kind (see the performance skill).
  **Shadows:** the shadow pass reads `colorNode`/`positionNode`/`maskShadowNode` from the
  *mesh's own* material (`Renderer._getShadowNodes`), not from the converted one, so a
  ported building's facade shader never runs in the shadow pass, and the cutaway doesn't
  cut shadows, as in the GLSL. A port that needs a vertex change or a mask in the
  shadow pass (trees' twigs, figures' animation) sets it on the legacy material too.
  A material with no port is drawn plain, as before. `setPatterned` (the ground) still
  hands over a node material at creation, which is fine because tiles are made after the
  renderer.
- A converted legacy material: `WebGPURenderer` turns a `MeshLambertMaterial` into
  a `MeshLambertNodeMaterial` by copying its properties (`NodeLibrary.fromMaterial`).
  Build the node material yourself instead, copying what the callers set (colour,
  side, depth, blending, stencil, polygon offset), as `groundMaterial` does.
- Give each ported material `userData.flatten()` in both paths if there's a useful
  "without it" to measure against (see Measuring).

### Graph sharing and retained meshes

- **Share the final graph, including wrappers.** Hoisting a `Fn` definition while
  calling it for every converted material still creates fresh call nodes. Reuse
  colour, ambient, mask and final emissive nodes per compatible variant. A light
  wrapper such as `lampLit()` must distinguish the original emissive and position
  inputs; sharing the building colour alone is not enough. Keep texture-node
  initialization late enough that required maps exist.
- **Equal graph identities are only the first check.** Render two materials with
  different textures/attributes, change shared uniforms, then dispose one and
  render the other again. A graph must read the current material's inputs rather
  than retaining the first material's texture. `check-material-sharing.mjs` covers
  this alongside the graphics-switch checks; recheck disposal and shadow bindings
  after changes to caching.
- **Warm the objects that will actually draw.** Instance builds depend on retained
  mesh/buffer identity, including shadow-pass variants. Verify first visible use
  after preparation, not just that `compileAsync` resolved or timed out. Reserve
  capacity explicitly and exercise overflow/reuse without hiding instances. Pooling
  trades startup and memory for less first-use work; a smaller builder count is
  not by itself a faster-frame result.
- **Distinguish graph builds from GPU pipeline compilation.** Different objects
  can require separate JavaScript node builds yet produce identical shader text
  that shares a GPU pipeline. Track builder events, generated shader variants and
  pipeline events separately rather than calling all three "compiles". Instance
  capacity can appear in shader array lengths, so exact-size allocations can add
  variants even when the material looks unchanged.
- **Treat per-instance appearance as a separate experiment.** Quiet Blocks reduced
  body batches by moving colour and material variation into instance attributes.
  This is a useful precedent for the deferred car-paint idea, not proof of a gain
  here. Preserve material differences that require separate groups, measure extra
  attribute/upload costs, and inspect the current Three version before borrowing
  its shader-name/cache patches. Never remove object identity from cache keys that
  bind object-specific buffers. Sources are in the performance skill's cross-project
  references.

## GLSL → TSL here

Check the API in `node_modules/three/build/three.webgpu.js` / `src/nodes` rather
than from memory; TSL changes between releases. Imports: node classes from
`three/webgpu`, functions from `three/tsl`. The TSL typings don't follow chained
arithmetic well: `webgpu.ts` uses `type N = any` for nodes.

- `diffuseColor.rgb = …` at `color_fragment` → `material.colorNode` (a `vec4`; it
  replaces the material colour, so multiply `materialColor` in yourself). Vertex
  colours: `vertexColor()`.
- World position varying → `positionWorld`. View-space `normal` → `normalView`;
  `dot(normal, viewMatrix[1].xyz)` is `normalWorld.y`.
- Custom attributes → `attribute('facade', 'vec4')`. Varyings → `varying(node)` or
  `vertexStage(node)`. `gl_VertexID` → `vertexIndex`; `texelFetch` →
  `textureLoad(tex, ivec2(…))`. Vertex changes → `positionNode` (and `normalNode`).
- `sampler2DArray` → `texture(arrayTexture, uv).depth(layer)`. Const arrays →
  `array([...])` or `uniformArray`.
- `discard` → `If(cond, () => { Discard(); })`. For shadows, `maskShadowNode`.
- Added light at `lights_fragment_end` (`lampLit`: `directDiffuse += diffuseColor *
  light`) → with a Lambert material this is the same as `emissiveNode =
  diffuseColor.rgb * light` (emissive is added to the lit colour before tone
  mapping). Check the result against WebGL at night.
- `ShaderMaterial` → `MeshBasicNodeMaterial` (or `SpriteNodeMaterial`,
  `LineBasicNodeMaterial`) with `colorNode`/`opacityNode`/`positionNode`, or
  `vertexNode`/`fragmentNode` for full control. `gl_PointSize` doesn't exist on
  WebGPU (points are 1 px): snow needs `PointsNodeMaterial` with `sizeNode`, or
  sprites. Custom blending carries over as material properties.
- Uniforms that follow the game's shared `{ value }` objects (`DIRT`, `WET`,
  `SNOW`, the ground's `time`): `uniform(u.value).onRenderUpdate(() => u.value)`. A
  `Vector4` changed in place (`CUTAWAY`, `DIG`) can be passed by reference:
  `uniform(CUTAWAY.value)`.
- Per-tile numbers (a texture's box) must be uniforms, not constants in the graph,
  or every tile compiles its own shader.
- `WebGLRenderTarget` works as a render target, but its texture is upside down when
  sampled in TSL (the lamps' light map needs `1 - v`, see `lampLight`). `attribute()`
  reads an `InstancedBufferGeometry`'s instanced attributes (the pools' quads).
  `NodeMaterial` with `vertexNode` (clip space) and `fragmentNode` takes custom
  blending as on `ShaderMaterial`, max equation for alpha included. WGSL's
  `smoothstep` wants edge0 < edge1: write `1 - smoothstep(lo, hi, x)`.

## Gotchas found so far

- **Uniforms that follow the game's values go in `renderGroup`.** A `uniform()` in the
  default (per-object) group kept the value it had when first uploaded: the cutaway hole
  stayed at the radius it had in its first frames. `follow()` and `uCut`/`uDig` in
  `webgpu/common.ts` set `.setGroup(renderGroup)`; use them, and check that a value
  that changes during play really reaches the shader (e.g. swap it for a constant and
  compare screenshots).
- **Night on WebGPU crashed** with `camera.updateProjectionMatrix is not a function`: the
  lamps' light map is drawn with a bare `THREE.Camera`. `configureRenderer` gives the base
  class a no-op.
- **A texture a port swaps later never reaches objects that don't move.** three.js checks
  the *legacy* material for nodes, finds none, and gives an unchanged object only the shared
  (render-group) refresh, so its texture bindings stay as they were at the first draw. The
  facade atlas's stand-in (`atlas` in `webgpu/buildings.ts`) stayed black on every tile compiled
  before `facades.webp` loaded (black walls with whole window cells lit at night, in the build
  only, where loading is faster). `main.ts` awaits `loadFacadeAtlas()` before the first
  `compileAsync`; load any such texture before the first draw, or don't swap it.
- **Derivatives only outside branches.** WGSL rejects `fwidth`/`dFdx` (and
  `textureSample` without a level) in non-uniform control flow. Anything computed
  with them must be declared before an `If`: `.toVar()` puts it on the stack where
  it's called (see `detail()` in `webgpu.ts`). Inside branches use
  `.level(float(0))` for texture reads.
- **A node first used inside an `If` is emitted inside it.** `.toVar()` the values
  a branch changes (and anything used again after it) before the `If`. This holds for
  values two branches share as well: `facadeModules` in `webgpu/buildings.ts` worked out
  a wall pixel's bay and storey in the upper floors' branch only, the ground floor read
  them unset, and ground floors and low buildings had no doors or windows (found
  6 October 2026 by reading the WGSL from `getShaderAsync`: a variable assigned in an
  `else` and read after it).
- **The scene's fog is mixed in before the tone curve.** Its colour is meant for the
  screen, so `Sky` hands WebGPU the colour the curve turns into it (`beforeCurve` in
  `sky.ts`, on the CPU) and a smaller share (`FOG_SHARE`). Compare fog between the
  renderers only on fresh loads at the same time and weather, with and without the fog
  (`fog.near = fog.far = 1e5`): the night frame is lighter on WebGPU without any fog
  (lamp-lit paving 0.29 against 0.20), and WebGL's fog also lightens what lies under the
  lamps' additive glows, so the fogged pictures differ less than the bases do.
- **One texture node per texture.** Make it once (`const noise =
  texture(NOISE.value)`) and read with `noise.sample(uv)`; a fresh `texture()` per
  call can run into WebGPU's limit of 16 textures per shader.
- **Hiding by material fails with shared shaders.** Hiding `ShaderMaterial`s when
  they were first compiled missed every later material with the same program (three
  caches the build): hide or replace at creation, not at compile.
- **Geometries that share a buffer need it marked `shared`.** Disposing one geometry makes
  three.js destroy the buffer for all, and an object that hasn't changed is never checked
  again, so it draws without it (validation errors after 20–30 s of driving). Set
  `attribute.shared = true` (the tree crown's do); `configureRenderer` skips deleting those.
- **Shadows use the object's own material.** WebGPU ignores `customDepthMaterial`
  (`treeDepth`, the cars' and figures' depth materials): the shadow pass takes the
  material's `positionNode` (or `castShadowPositionNode`) and `maskShadowNode`. It
  also multiplies in `colorNode.a`, so a shadow caster with an expensive
  `colorNode` may run it in the shadow pass: check the shadow shader.
- **A pipeline may have 16 vertex inputs** (a `vec4` each; a matrix is four). Past a
  uniform buffer's size (~1000 instances) three.js reads the instance matrix as four
  vertex inputs, so don't add a second copy of it: `instanceMatrix()` in
  `webgpu/trees.ts` reads it the way three.js does, and `shareInstances` (called in
  `setupPosition`, before three.js's instancing) puts big ones in a storage buffer both
  share. A pipeline over the limit fails and its objects silently aren't drawn: look
  for `exceeds the maximum (16)` in the bench's console lines.
- **`DynamicDrawUsage` means "upload every frame"** in the WebGPU renderer, changed or
  not. Leave it off and set `needsUpdate` (with an update range, `src/gpu.ts`).
- **Runtime MSAA needs the canvas target too:** `_samples` alone leaves the picture
  byte-for-byte unchanged: the tone-mapping framebuffer retains its startup samples.
  Set `_samples` and the samples of `_frameBufferTargets.get(_canvasTarget)`, as
  `Graphics` does. Do not dispose it: three rebuilds its attachments on the next
  render, and disposal can invalidate textures used by background compilation.
  Checked with matched zoomed screenshots at 1× and 2× and actual GPU sample counts.
- **Runtime shadow resizing needs fresh bindings:** `sun.shadow.mapSize` resizes the
  target, but converted legacy materials can retain the destroyed texture. `Graphics`
  releases their render caches once on a resize, including stationary meshes. WebGL
  needs `shadow.map` disposed and set to null. Test repeated low/high switches and
  read the console; matching dimensions alone is not proof of a valid render.
- **A startup stall can precede all shaders:** the 120 s stall was reproduced inside
  `GPUAdapter.requestDevice`, with no network requests outstanding. `renderer.ts`
  bounds initialization and falls back to legacy WebGL before loading GPU factories;
  `bench.mjs --require-webgpu` rejects that fallback for measurements.
- **Inspect the generated shader** with `await
  renderer.debug.getShaderAsync(scene, camera, mesh)`.
- **`compileAsync` never finishes** in headless Chrome with
  `--disable-frame-rate-limit` (which `scripts/bench.mjs` uses); `configureRenderer`
  gives up after 10 s and the rest compiles when first drawn. Without that flag,
  frames are capped at 60 fps and differences hide.
- Look at `console.info` in the page: `configureRenderer` says whether it got WebGPU
  or fell back to WebGL 2. A benchmark on the fallback measures nothing useful.

## Checking a port

1. `npm run typecheck`.
2. Screenshots of the same place in both renderers, and the port's condition
   (`--time 22:00` for lamps, `--weather rain`/`snow` for weather): `node
   scripts/bench.mjs --scenes stand --seconds 2 --extra "&renderer=webgl&dev" --shot /tmp/gl-%s.png`
   and the same without `--extra`, with `--require-webgpu --shot /tmp/gpu-%s.png`. Look at them. Compare
   the ported surfaces, not the pixels: tone mapping and filtering differ slightly.
3. No new errors in the console. Page errors and console errors are printed by
   `bench.mjs`; add `&dev` to `--extra` for shader errors on WebGL.
4. The WebGL game must look and run as before (a WebGL screenshot against one from
   before the change).

## Measuring

Use `--ab` with a toggle that swaps each material for its `userData.flatten()` to
compare steady-state feature cost, with both states warmed. The ground's toggle
is in the `performance` skill. To compare first-use builds, install attribution
before the cold transition instead; a warmed material toggle cannot measure that
hitch. Whole-frame comparisons require equivalent visible work: missing/unported
objects make a renderer look faster for the wrong reason.

Follow the performance skill's one-active-game rule, unchanged-build noise control,
reversed run order and device/temperature checks. Record builder and upload counts
separately from frame timings. Compare code changes on the same backend first;
switching backend at the same time confounds the result. Independent port results
do not add up to a combined speedup: test the selected integrated revision after
concurrent work has settled. Noisy or contradictory timings remain inconclusive.

## Committing

- Another session often works in the same checkout: check `git status` first and
  commit only your own changes (stage a single hunk of a shared file with `git diff
  -U0 file` → keep your hunk → `git apply --cached --unidiff-zero`).
- One commit per ported piece, with the before/after screenshots checked and the
  `--ab` numbers for both renderers in the body.
- Update the table above and `docs/performance-log.md` as pieces are ported.
