---
name: webgpu-port
description: How to port Streets of Prague's shaders from GLSL (onBeforeCompile, ShaderMaterial) to three.js TSL for the WebGPU renderer trial (?renderer=webgpu, src/webgpu.ts), and how to check and measure each port. Use when working on src/webgpu.ts, porting a material to TSL or node materials, or comparing WebGL and WebGPU.
---

# Porting the game to three.js's WebGPU renderer

The game draws with `THREE.WebGLRenderer` and changes three.js's shaders in GLSL.
`?renderer=webgpu` swaps in `WebGPURenderer` (three r186, `src/webgpu.ts`), where
GLSL can't run: every shader has to be written in TSL (three's node language, which
compiles to WGSL, and to GLSL on the WebGL 2 fallback backend). The port happens
piece by piece next to the GLSL, so the default game never changes. Read `todo.md`
"Game performance" for the state and the numbers so far, and the `performance`
skill for measuring.

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
`emissiveNode`. It is on the ground (with the wet ground's mirror, `shine`), the
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

Not ported, drawn with the plain material (their `onBeforeCompile` is ignored):

| Where | What | Notes |
|---|---|---|
| `shading.ts` `cutAway` | the hole over the player | ported for the landmarks, the depth ground and the trees (a `maskNode`) |
| `lamps.ts` `lampLit` | lamp light added to Lambert materials at `lights_fragment_end`, read from a light map render target | ported for the ground, buildings, `cut-*` and poles (`lampLit(node)` in a port); cars, trams, boats, funicular, figures and the signals' poles and heads have it too |
| `map/buildings.ts` `drapeRoofs` | an experiment's roof texture | low priority |

Every `ShaderMaterial` is hidden by a `visible` accessor on `THREE.ShaderMaterial.prototype` in
`createRenderer`, so a ported one has to be built as a node material (not a `ShaderMaterial`) or it stays hidden.
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

## How a port is wired

- Keep the GLSL path exactly as it is. The TSL version lives in `src/webgpu.ts`
  (split into `src/webgpu/*.ts` once it grows past a few hundred more lines) and is
  switched in by a hook the WebGPU module sets, as `setPatterned` does for the
  ground. The module is only loaded with `?renderer=webgpu`, so it adds nothing to
  the normal game.
- **Load order: settled with `addPort`, neither lazy materials nor a boot module.**
  The game's module-level materials (`car.ts`, `trams.ts`, `funicular.ts`,
  `vegetation.ts`'s `treeDepth`) and the per-tile ones stay as they are, legacy
  materials with `onBeforeCompile`, so the game's code needs no change. When
  `WebGPURenderer` builds a shader for a legacy material it converts it in
  `library.fromMaterial` (one place, called by the node builder, once per distinct
  render-object cache key); `createRenderer` wraps that, and `addPort(/^cars$/, (node,
  legacy) => { node.colorNode = …; })` decorates the converted node material. Ports are
  chosen by the legacy material's `customProgramCacheKey()`, which every one of these
  materials sets already. Build each port's node graph once at module level and share it
  (per-tile numbers as uniforms), or every render object compiles its own shader.
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
  lamps' light map is drawn with a bare `THREE.Camera`. `createRenderer` gives the base
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
  a branch changes (and anything used again after it) before the `If`.
- **One texture node per texture.** Make it once (`const noise =
  texture(NOISE.value)`) and read with `noise.sample(uv)`; a fresh `texture()` per
  call can run into WebGPU's limit of 16 textures per shader.
- **Hiding by material fails with shared shaders.** Hiding `ShaderMaterial`s when
  they were first compiled missed every later material with the same program (three
  caches the build): hide or replace at creation, not at compile.
- **Geometries that share a buffer need it marked `shared`.** Disposing one geometry makes
  three.js destroy the buffer for all, and an object that hasn't changed is never checked
  again, so it draws without it (validation errors after 20–30 s of driving). Set
  `attribute.shared = true` (the tree crown's do); `createRenderer` skips deleting those.
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
- **Runtime switches that work:** `renderer._samples` (MSAA 4 or 0: ran without errors in an
  `--ab`, not yet checked on screen) and `sun.shadow.mapSize` (the shadow map is resized each update).
  The WebGL renderer can do neither without being made again.
- **Inspect the generated shader** with `await
  renderer.debug.getShaderAsync(scene, camera, mesh)`.
- **`compileAsync` never finishes** in headless Chrome with
  `--disable-frame-rate-limit` (which `scripts/bench.mjs` uses); `createRenderer`
  gives up after 10 s and the rest compiles when first drawn. Without that flag,
  frames are capped at 60 fps and differences hide.
- Look at `console.info` in the page: `createRenderer` says whether it got WebGPU
  or fell back to WebGL 2. A benchmark on the fallback measures nothing useful.

## Checking a port

1. `npm run typecheck`.
2. Screenshots of the same place in both renderers, and the port's condition
   (`&time=22:00` for lamps, `&weather=rain`/`snow` for weather): `node
   scripts/bench.mjs --scenes stand --seconds 2 --shot /tmp/gl-%s.png` and the same
   with `--extra "&renderer=webgpu" --shot /tmp/gpu-%s.png`. Look at them. Compare
   the ported surfaces, not the pixels: tone mapping and filtering differ slightly.
3. No new errors in the console. Page errors and console errors are printed by
   `bench.mjs`; add `&dev` to `--extra` for shader errors on WebGL.
4. The WebGL game must look and run as before (a WebGL screenshot against one from
   before the change).

## Measuring

Only compare **what a piece costs** in each renderer, never whole frames, until
everything is ported (on WebGPU the unported parts are cheaper because they're
plain or missing). Use `--ab` with a toggle that swaps each material for its
`userData.flatten()`, in both renderers, at `--dpr 2`, a few scenes, `--seconds 32
--window 2`. The ground's toggle is in the `performance` skill ("WebGPU trial");
write the same for other pieces. Check first what else is using the GPU (`ioreg -r
-d 1 -c IOAccelerator | grep "Device Utilization"`) and report it with the numbers.

Once buildings, lamp light and trees are ported, compare whole frames with `--vs`
between WebGL and WebGPU on the same server: that's the number that decides
whether to switch.

## Committing

- Another session often works in the same checkout: check `git status` first and
  commit only your own changes (stage a single hunk of a shared file with `git diff
  -U0 file` → keep your hunk → `git apply --cached --unidiff-zero`).
- One commit per ported piece, with the before/after screenshots checked and the
  `--ab` numbers for both renderers in the body.
- Update the table above and `todo.md` "Game performance" as pieces are ported.
