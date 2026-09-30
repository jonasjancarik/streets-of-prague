---
read_when: Implementing step 1 of the driving-stutter work, or changing WebGPU building and lamp-light graphs.
---

# Plan 007: Share building and lighting shader graphs

This is step 1 of six plans to reduce driving stutter without reducing the game's visual detail. Follow the steps in order and record the result in `plans/README.md`. This file contains the context needed to work on this step without the original discussion.

## Status and starting point

- Status: PLANNED; source inspection only. No implementation or new measurements were performed to write this plan.
- Priority: P1. Estimated effort: about a day. Change risk: medium.
- Category: performance. Dependencies: none.
- Planned at: `5162c1fcf11e51df8ceda46049cac217fc7a12cd`, 2026-09-30.
- Confidence: high that graphs are recreated; the remaining frame-time cost needs a controlled comparison.

Before editing, run `git status --short` and:

```sh
git diff --stat 5162c1fcf11e51df8ceda46049cac217fc7a12cd..HEAD -- src/webgpu/buildings.ts src/webgpu/lamps.ts src/webgpu/common.ts src/main.ts scripts/check-material-sharing.mjs scripts/bench-stalls.js
```

Read any intervening changes and compare the excerpts below with the live symbols. Preserve unrelated work. If the shader-conversion or texture-binding design has changed, stop and revise the plan rather than applying it mechanically. Do not create a branch, commit, push, or deploy without separate authorization.

## Why this matters

Driving brings previously unseen tile meshes into view. WebGPU's material setup translates three.js node graphs into shader code on the main thread. Equivalent-looking graphs are not necessarily cache-equivalent: the default node key includes node identity. The ground already reuses its graphs, but buildings and lamp-light wrappers still create new ones. This plan removes that duplication; it does not promise that GPU pipeline compilation, instanced meshes, or other hitches disappear.

The repository uses npm, Vite, strict TypeScript, and three.js r186. WebGPU is the default; `?renderer=webgl` selects the legacy renderer. Read `.agents/skills/performance/SKILL.md` and `.agents/skills/webgpu-port/SKILL.md` before implementation. Some historical introductory text in the latter is outdated; the live renderer and the section saying WebGPU is the default take precedence.

## Current state

- `src/tiles.ts:160,238–249`: `buildingMaterial()` returns a new shaded Lambert material for each building mesh.
- `src/webgpu.ts:275–285`: `configureRenderer()` decorates three.js's legacy-material conversion using the port registry in `src/webgpu/common.ts`.
- `src/webgpu/buildings.ts:176–182` currently creates nodes inside that conversion:

  ```ts
  node.vertexColors = false;
  node.colorNode = buildingColor();
  node.emissiveNode = windowGlow();
  node.aoNode = skyAmbient(attribute('sky', 'float'));
  lampLit(node);
  ```

- `src/webgpu/lamps.ts:107–113` makes a new wrapper each time:

  ```ts
  const emissive = node.emissiveNode;
  node.emissiveNode = Fn(() => {
    const e = vec3(emissive ?? 0).toVar();
    e.addAssign(diffuseColor.rgb.mul(lampLight(world, normalView)));
    return e;
  })();
  ```

- The `cut-*` and `landmark-roof` ports in `src/webgpu/buildings.ts` also construct masks and colour graphs per conversion.
- `src/webgpu.ts:198–244` is the exemplar: `groundGraphs` caches node objects by structural variant while `materialReference()` reads each material's own inputs. Match that distinction between shared calculations and material-owned values.
- `node_modules/three/src/nodes/core/Node.js:470` returns `this.id` from `customCacheKey()`. `TSLCore.js:837–839` constructs a fresh call node on each function call. Inspect these sources, but do not patch three.js.

## Scope

Modify only `src/webgpu/buildings.ts`, `src/webgpu/lamps.ts`, and, if needed for a small shared helper, `src/webgpu/common.ts`; create `scripts/check-material-sharing.mjs`. `scripts/bench-stalls.js` may receive narrowly scoped build-attribution improvements. `src/main.ts` may expose a read-only test handle through the existing `window.__drive` object only if the test cannot use the port registry or scene directly. Update `todo.md`, the relevant rendering paragraph in `README.md`, this plan's result section, and its index row.

Do not change ground patterns, colour formulas, facade imagery, shadow resolution, renderer fallback, Auto-tier disposal, instanced-mesh cache keys, or dependencies. Tree batching and car preparation are later steps. Keep per-mesh material ownership: sharing a material object and disposing it when a tile leaves is not the proposed solution.

## Implementation steps

### 1. Capture the baseline and add a focused regression check

Create `scripts/check-material-sharing.mjs` using `scripts/check-graphics.mjs` as the runner pattern: invoke the existing benchmark with a browser `--eval` assertion program, propagate nonzero exits, and treat console/page errors as failures. Support `--url` and `--case graphs|bindings|all`; default to `all`. New commands in this plan are specifications for this script, not existing commands.

The graph case should construct two separate legacy materials per target port, convert them with the live renderer library, and inspect the resulting node identities and material cache keys. Equivalent building materials must share colour, ambient and final emissive nodes. Equivalent landmarks/cutaway materials must share their corresponding graph nodes. Different emissive inputs or world-position nodes passed to `lampLit` must not accidentally receive the same wrapper. Use actual rendered meshes for the binding case rather than treating equal IDs as sufficient proof.

**Verify:** `node --check scripts/check-material-sharing.mjs` exits 0. `node scripts/check-material-sharing.mjs --url http://localhost:5191/ --case graphs` should initially fail specifically on duplicated target graph identities; save that failure. Run the comparison command below against the unmodified baseline when execution is authorized.

### 2. Share complete graphs, including the lighting wrapper

Instantiate the building colour, window glow, sky ambient and cutaway-mask nodes once per structural variant, outside port callbacks or in a lazy cache. Assign those same node objects to each converted material. Apply the same treatment to the landmark colour and mask nodes. Do not merely hoist the `Fn` definition while continuing to call it for each material.

Make `lampLit()` reuse its final emissive graph for the same pair of original emissive node and world-position node. Treat absent emissive as an explicit cache case. A small identity-based cache is enough; do not merge unrelated vehicle/figure emissions. Preserve lazy construction of the lamp texture node until the light map exists. Repeated application to one converted material must not add the light twice.

Keep `materialColor`, built-in material map references, geometry attributes and render-group uniforms dynamic. A graph must not close over the first landmark's texture or a tile's sky values. Reuse the existing `follow()` helpers for mutable globals, and preserve derivatives outside conditional branches.

**Verify:** `npm run typecheck` exits 0; the new `--case graphs` command passes, including distinct-input and repeated-application cases.

### 3. Check actual bindings, disposal and changing conditions

In the regression runner, render two landmark-style meshes with deliberately different textures and two building meshes with different `sky` attributes. Assert that their bindings remain distinct and that rendering one has not replaced the other's input. Remove and dispose one material, render the survivor again, and check for errors. Exercise daytime/nighttime uniforms, rain/snow, and a changing cutaway; values must update on static meshes too.

Preserve `await loadFacadeAtlas()` before startup compilation in `src/main.ts:1336–1338`. The black stand-in texture must not become permanently bound to static buildings. Check ordinary IPR and extruded OSM geometry layouts separately; sharing is required within equivalent layouts, not across incompatible attributes or material settings.

**Verify:** `node scripts/check-material-sharing.mjs --url http://localhost:5191/ --case all` and `node scripts/check-graphics.mjs --url http://localhost:5191/` exit 0 with no console/page errors. Inspect matched baseline/candidate screenshots at `stand` and `strana`, at 14:00 clear and 22:00 rain. Check a landmark and tunnel cutaway in the browser as well. Legacy WebGL should retain its baseline appearance.

### 4. Compare driving stalls and document the result

Use an unchanged baseline server and a candidate server with the same map data. For later steps, baseline means the result immediately before that step, not necessarily the original planning commit. Serve stable snapshots; do not edit while a benchmark is running.

```sh
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu
```

The candidate is `--url`, baseline is `--vs`. Inspect build counts by object kind, build milliseconds, long-task duration/count, frame p95/p99, and ordinary-frame render time. Equivalent new building meshes should reuse an existing live builder state after their variant has warmed. Zero total builds is not required: trees, cars, new variants, and eviction of the last user remain possible.

**Verify:** `npm run build` exits 0; the comparison completes on WebGPU without errors or missing geometry. Record actual results and screenshots in this plan and summarize them in `todo.md`. If timing is inconclusive, say so; a lower graph count alone is not a proven frame-time improvement.

## Execution environment and checks

Use `npm run dev` for the candidate and `PORT=5192 npm run dev` in a separate baseline checkout after verifying those ports and directories. Follow the user's server/PortPilot rules and provide the required access URLs if starting persistent servers. Do not alter an existing server you do not own. `public/data` is generated, untracked, and may be shared; this step only reads it. `bench.mjs` needs Google Chrome and Playwright available via its existing lookup or `PLAYWRIGHT_PATH`; do not add a dependency just for this check. There is no npm test, lint, or docs-list script in the inspected package; use the focused runner, typecheck and build above.

For screenshots, an existing command is `node scripts/bench.mjs --url http://localhost:5191/ --scenes stand,strana --seconds 2 --time 22:00 --weather rain --shot /tmp/material-sharing-%s.png --fresh-browser --loading-frames --require-webgpu`. Use distinct baseline/candidate output names. Frame time comparisons must use alternating runs; GPU timer readings on Metal are not reliable. Runtime measurements in this file are future verification, not work authorized by the original read-only review.

## Done criteria and stop conditions

- [ ] Typecheck, focused graph/binding checks, graphics-switch regression, and build pass.
- [ ] Equivalent converted materials share complete graph nodes; distinct textures, sky attributes and emissive variants still render correctly.
- [ ] Disposal of one tile does not invalidate a surviving tile's material inputs.
- [ ] Controlled drive comparison and matched visual checks are recorded, with no unsupported speedup claim.
- [ ] `git diff --check` passes; changed files are within scope; this plan and the index state the outcome.

Stop if sharing requires a three.js cache-key patch, captures object-specific instance buffers, produces stale textures, or requires changing Auto shadow disposal. Those are separate problems. If focused checks fail after two reasonable attempts, preserve the evidence and report the blocker rather than hiding a material or disabling its lighting.

Future ports must share the final node objects, not just their constructor functions. Review additions to `lampLit` for inputs missing from the cache key. Recheck cache assumptions after a three.js upgrade.

## Result

Not started. Record implementation revision, verification commands/results, comparison environment, measured results, visual checks, and any remaining limitations here.
