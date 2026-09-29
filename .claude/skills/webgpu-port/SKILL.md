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

Ported (in `src/webgpu.ts`): the ground's patterns, noise, dirt and weather colour
(`patterned()` in `src/shading.ts`, through `setPatterned`), and the tone curve
(`sky.ts`, registered with `renderer.library.addToneMapping`).

Not ported, drawn with the plain material (their `onBeforeCompile` is ignored):

| Where | What | Notes |
|---|---|---|
| `shading.ts` `shadeBuildings` | roofs (tiles, slate, flat), windows, facade pictures (`FACADE_GLSL` in `facades.ts`, a `sampler2DArray` and a const int array), grime, lit windows, rain and snow on buildings, the cutaway hole | the biggest cost left: roof tiles ~12%, facades ~7%, grime ~6% of a frame |
| `shading.ts` `cutAway` | the round hole over the player in a passage | used by trees and the depth-only ground |
| `lamps.ts` `lampLit` | lamp light added to Lambert materials at `lights_fragment_end`, read from a light map render target | shared by the ground, buildings, cars, figures, trams, boats, signals; needed for night |
| `map/vegetation.ts` `leafy`, `treeDepth` | leaves in tufts (vertex and fragment), bare twigs, their shadows | `treeDepth` is a `customDepthMaterial`, see below |
| `figures.ts` `vatMaterial` | people animated from textures (`gl_VertexID`, `texelFetch`) | colour and depth versions |
| `car.ts`, `trams.ts`, `boats.ts`, `funicular.ts` | snow on top, lamp light | module-level materials, see "Load order" |
| `underground.ts` | metro hole and earth | |
| `map/buildings.ts` `drapeRoofs` | an experiment's roof texture | low priority |

Not drawn at all (every `ShaderMaterial` is hidden by a `visible` accessor on
`THREE.ShaderMaterial.prototype` in `createRenderer`): the ground's soft shading
(`surface.ts`), rain, snow and mist (`weather.ts`), lamp light pools and glows
(`lamps.ts`), signal glows (`signals.ts`), spray, fire, skid marks. A ported one has
to be built as a node material (not a `ShaderMaterial`) or it stays hidden.

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
- `WebGLRenderTarget` works as a render target; sampling a render target's
  texture in TSL flips it for you. Check the lamps' light map lands where it should.

## Gotchas found so far

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
- **Shadows use the object's own material.** WebGPU ignores `customDepthMaterial`
  (`treeDepth`, the cars' and figures' depth materials): the shadow pass takes the
  material's `positionNode` (or `castShadowPositionNode`) and `maskShadowNode`. It
  also multiplies in `colorNode.a`, so a shadow caster with an expensive
  `colorNode` may run it in the shadow pass: check the shadow shader.
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
