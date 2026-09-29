---
name: performance
description: How to measure and speed up Streets of Prague (frame rate, GPU shading, main-thread CPU, tile loading) without fooling yourself. Use when working on performance, frame rate, shader cost, stutter or hitches, when adding anything drawn on every pixel (ground patterns, weather, lighting), or when adding per-frame or per-step work in the simulation.
---

# Performance in Streets of Prague

What was learned measuring and optimising the game (29 September 2026, M5
MacBook Air). The state of play and the open items are in `todo.md` under
"Game performance"; read that too.

## Measuring

Use `scripts/bench.mjs` (it documents its options at the top). It loads the game in
headless **Google Chrome** on the GPU at fixed places (`stand`, `drive`, `woods`,
`suburb`, `river`, `tunnel`), a fixed time (`--time`) and weather (`--weather`).

- **Compare, don't read absolute numbers.** Run-to-run drift is large (seen: 28 →
  14 fps with no code change), so a single before/after pair proves nothing.
  - Code changes: run a second dev server from a detached worktree of the baseline
    commit, then `--vs http://127.0.0.1:5192/ --runs 3`, which takes turns between
    the two. In the worktree, symlink `node_modules` and `public/data` from the main
    checkout (the map data is not in git). When cleaning up, move the symlinks to
    the Trash before `git worktree remove`, so the removal can't touch the targets.
  - A change you can switch in the page: `--ab "window.__ab = (on) => { … }"`
    toggles it every 2 s in one page. It's the most reliable way to find what a
    piece costs. To patch a shader piece out: clone the material, wrap its
    `onBeforeCompile`, string-replace the GLSL, give it a new
    `customProgramCacheKey`, and swap materials in `__ab`.
- **Use Chrome, not Playwright's bundled Chromium.** The bundled build's MSAA costs
  about 4.5× per fragment on a Mac, against 1.5× in Chrome, which inflates every
  per-pixel cost. The bench uses `channel: 'chrome'` by default.
- **Check what else is using the GPU first**: `ioreg -r -d 1 -c IOAccelerator |
  grep "Device Utilization"`. The Claude app's browser pane keeps rendering the
  game if it's open on the dev server, and takes most of the GPU. It's the user's,
  so don't kill it: ask them to close it, or rely on `--vs`/`--ab`.
- A hidden browser pane doesn't run `requestAnimationFrame` at all, so the game
  never gets past loading there.
- `--dpr 2` means GPU-bound (fragment cost). `--dpr 1 --cpu 4` stands in for a
  phone's CPU. `--profile` prints the hottest functions, and `--profile-load`
  profiles start-up; the `.cpuprofile` files are written to `/tmp`.
- The GPU timer query's numbers aren't reliable on Metal. Trust frame times.
  Headless Chrome still lines frames up to 16.7 ms slots, so a GPU-bound frame
  shows as 16 or 33 ms. Use the average.
- Before trusting a big speed-up, take a `--shot` (and run with `--extra "&dev"`,
  which prints shader compile errors). A shader that fails to compile draws
  nothing, and nothing is fast: a "3.8× faster" ground was really no ground.
- Anything that should look the same: compare screenshots (`--shot`, `--zoom 0.3`
  for close-ups) and check that the stats match (e.g. the share of dark pixels),
  not that the pixels match. For simulation changes, compare an order-independent
  hash of results (parked car positions) between the servers.

## Where the time goes (2× on an M5, Chrome, by the Old Town Square)

The GPU is the limit at 2×. Per frame, roughly:
- **Ground patterns: ~29%.** The mosaic's stones 14%, dirt on the paving 12%.
- **Shadows on the ground: 11%.**
- **Roof tiles: 12%.**
- **Facade pictures: 7%.**
- **Wall grime: 6%.**
- **The shadow map pass: 7%.**
- **MSAA: ~20% at 2×.**

The ground is shaded on every pixel. Measure anything you add to `PATTERNS_GLSL`,
`WEATHER_GLSL` or `patterned()` with `--ab`.

## GPU gotchas

- **Value noise reads its lattice from a texture** (`NOISE` in `src/shading.ts`,
  one filtered `textureLod` a call). Don't go back to hashing four corners per
  call. Each `vnoise` is still a texture read, and a 4-octave `fbm` is 4 reads,
  which added up to ~10% of a frame for one `fbm` on the ground. Count the reads.
- **Anything that changes over tens of metres or more goes in a per-tile
  texture**, not the shader. That's how `broad()` is baked into the hill-shading
  texture (`relief()` in `src/tiles.ts`). The JS noise in `shading.ts` matches the
  GLSL.
- **Gate sub-pixel detail with a branch.** Compute `detail()` (which uses `fwidth`)
  outside the `if`, then `if (d > 0.) { … }`. Derivatives inside non-uniform
  branches are undefined. `textureLod` is safe inside them.
- **A random number per cell: use `hash32`** (three numbers for one hash), not
  several `hash12` calls. Compare squared distances; take `sqrt` once at the end.
- **GLSL name clashes** (e.g. a second `float d` in one function) fail the whole
  ground program silently unless the page runs with `?dev`.
- **Apple GPUs skip covered opaque pixels on their own** (hidden surface removal),
  so reordering or stencilling layers measures ~0% on a Mac. On Apple, the
  **stencil test is not early; the depth test is.** The ground's layers are drawn
  top-down with a stencil (`onceAPixel` in `src/surface.ts`, needs `stencil: true`
  in `main.ts`) for GPUs without that, which is most Windows PCs and many phones;
  it can't be measured here. Overdraw can be counted by rendering with an additive
  material and reading pixels back: it was 1.4–2.1 solid ground layers per pixel.
- **Don't order the ground layers by a fake depth** (`gl_Position.z` by rank). It
  works at 24 bits but breaks on 16-bit depth buffers. And drawing the ground
  after the buildings breaks the view down into tunnels (the cars inside would be
  painted over).
- **Changing the random lattice changes where patches fall** (asphalt cracks
  appear on other streets, stones change). That's acceptable if the character
  holds, but say so in the commit.
- **Measured and not worth it:** folding the shadow filter's trigonometry together
  (Metal copes already), and 4× instead of 8× anisotropy on the facade pictures.
- Changes that would help but alter the look are decisions for the user: MSAA off
  at 2× (antialiasing can only be chosen when the renderer is created), a tighter
  fade for the stones, a cheaper shadow filter.

## CPU gotchas

- **Don't use generators or per-call allocations in per-step code.**
  `SpatialHash.near` fills an array. `obstacles()` in `main.ts` reuses one list,
  which holds until the next call, so never look up obstacles while going through
  a list. `Polyline`/`Loop` keep each segment's heading, so there's no `atan2` per
  `at()`.
- **Update only what changed.** The tram grid re-files only trams that moved
  (`file`/`unfile` in `src/trams.ts`); when a tram leaves service it's taken out in
  `remove`. Most of the ~300 trams are far away and step four times a second.
- **Instanced meshes that cast shadows need their own `customDepthMaterial`**,
  one per kind (trees have `instanceColor`, cars don't). With three.js's single
  shared depth material, every switch between instanced and plain meshes rebuilds
  shader parameters (`getParameters` shows in the profile).
- **Static groups skip the per-frame matrix walk:** tile groups set
  `updateMatrixWorld = () => {}` once their matrices are made.
- **Skip work nobody sees:** by day the lamps return right after gathering the
  poles.
- **Tile loading happens on the main thread** after the workers finish: meshes,
  street graphs, and parking (`parkCars`, 0–4 ms a tile when warm, up to ~30 ms
  cold on an M5). Numeric map keys, not template strings; share per-type data;
  compute outlines once.
- Check behaviour after simulation changes: trams, traffic and people still move,
  some stop for obstacles, and the grids hold no stale entries.

## WebGPU trial

`?renderer=webgpu` (with `--extra "&renderer=webgpu"`) draws with three.js's
WebGPU renderer, where only the ground is ported (see `src/webgpu.ts` and `todo.md`).
Measure the ground's patterns in either renderer by swapping each ground material
for its `userData.flatten()` (the same ground without the pattern):

```
--ab 'window.__ab = (on) => { window.__drive.scene.traverse((o) => { const m = o.material; if (!m || Array.isArray(m)) return; const u = o.userData; if (!u.patterned && m.userData && m.userData.flatten) { u.patterned = m; u.flat = m.userData.flatten(); } if (u.patterned) o.material = on ? u.patterned : u.flat; }); }; window.__ab(false); window.__ab(true);'
```

Only compare such differences between the renderers, not whole frames: on WebGPU
everything written in GLSL is drawn plain or not at all. There's no GPU timer there.

## Before you commit

Type check (`npm run typecheck`), check screenshots against the baseline, and put
the `--vs`/`--ab` numbers and what was checked in the commit body. Update `todo.md`
"Game performance" when the picture changes.
