# Plan 001: Migrate the browser application to TypeScript

> This is an implementation plan, not a request to change the Python map pipeline.
> Read the current working tree before starting. At planning time, the checkout had
> uncommitted changes in `README.md`, several `src/*.js` files, and two pipeline
> files. Preserve them. Do not switch branches or overwrite tracked files. The
> plan was written against the *working tree* at commit `4658c59`; comparing only
> `4658c59..HEAD` is insufficient because the working tree was already dirty.

## Status

- Priority: P1
- Effort: L (roughly 3–6 focused workdays; measure again after the first strict conversion)
- Risk: medium, mainly module resolution, worker transfers, and data contracts
- Depends on: none
- Category: migration
- Planned at: `4658c59`, 2026-09-28

## Goal and scope

Convert the 29 browser modules under `src/` to `.ts`, with `strict` typechecking
passing and no observable gameplay or map-data format change. Keep the Python
pipeline, generated `public/data/`, and deployment topology as they are. The final
gate is typecheck plus a production Vite build and browser checks against existing
`ujezd` and `centrum` data. A deployment is outside this plan.

Expected changed files: `src/**/*.js` renamed to `.ts`, `index.html`, `package.json`,
`package-lock.json`, new `tsconfig.json` and small `src/**/*.ts` contract files,
and `README.md` for commands and renamed source references. Leave `vite.config.js`
as JavaScript unless the compiler configuration requires otherwise. Do not edit
`pipeline/**/*.py`, assets, `public/data/`, or `scripts/deploy-mbxp.sh` merely for
the language change. If a generated-data mismatch is discovered, report it before
changing either side of that contract.

## Current state and important contracts

- `package.json:5-18` has `dev`, `build`, and `preview` scripts, Vite 8.3.1, and no
  TypeScript or test script. npm is the package manager (`package-lock.json`).
- `index.html:213` loads `/src/main.js`. `src/tiles.js:30` constructs the module
  worker with `new Worker(new URL('./tileWorker.js', import.meta.url), { type:
  'module' })`. Both paths must refer to the final `.ts` sources before the
  corresponding rename is considered complete.
- `src/tiles.js:23-48` uses a worker pool with numeric job IDs, `type`, `data`,
  optional transfer lists, and `{ id, result }` or `{ id, error }` responses.
  `src/tileWorker.js:155-174` dispatches `roofs`, `ipr`, `ground`, and `land` jobs
  and transfers array buffers back. Preserve ownership and transfer behavior;
  typing must not introduce copying or change the message shape.
- `src/main.js:40-44` fetches `index.json`, `lines.json`, and `metro.json` and
  uses empty `lines` fallbacks for the latter two. `src/tiles.js:317-329` fetches
  per-tile JSON and binary terrain/IPR data. Model the wire shapes from
  `pipeline/layers.py:156-210`, `pipeline/build_lines.py:12-20,273-274`, and
  `pipeline/build_metro.py:1-12,43-54`; preserve optional fields such as
  `terrain`, `iprRef`, `decks`, and the 3- or 4-element tile index tuples.
- `src/map/geo.js` and `src/network.js` are useful early conversions: geometry,
  grids, points, graph edges, and paths are shared broadly. `src/terrain.js`
  handles `ArrayBuffer` and typed arrays on both main and worker threads.
- `src/map/buildings.js:1-15` uses `straight-skeleton` (which ships declarations)
  through a `SkeletonBuilder`/default fallback. `proj4` also ships declarations.
  Installed `three` and `leaflet` packages do not declare a `types` field, so
  check and add compatible `@types/three` and `@types/leaflet` packages.
- There are no automated browser tests or CI workflows in this checkout. The
  ignored local `public/data/ujezd_now` (2.3 MB) and `centrum_now` (22 MB) data
  are available for smoke checks; an executor on another machine may need to
  generate or obtain them first.

## Implementation sequence

### 1. Establish a baseline and compiler gate

Record `git status --short` and `git diff --stat` before editing; inspect any
changed files again immediately before converting them. Run the current
production build once on the executor's checkout and note its result. Do not use
a full-city data rebuild as a migration test.

Add `typescript` and compatible `@types/three`/`@types/leaflet` as npm dev
dependencies after checking their current release activity and the Three/Leaflet
version match. Add `tsconfig.json` with `noEmit`, `strict`, `isolatedModules`,
`moduleResolution: "Bundler"`, `module: "ESNext"`,
`allowImportingTsExtensions: true` (compatible with `noEmit`), a modern browser target,
`lib` covering ES and DOM APIs, and `types: ["vite/client"]`. Start with
`allowJs: true`, `checkJs: false`, and `include: ["src"]` so JS and TS can
coexist. Add `npm run typecheck` using `tsc --noEmit` and make `npm run build`
run typecheck before Vite; Vite transpiles TypeScript but does not check types.
Use `import type` for type-only imports. Do not add a blanket `any` declaration
for the whole application.

**Gate:** `npm run typecheck` exits 0; `npm run build` exits 0; `git diff --
package.json package-lock.json tsconfig.json` shows only the intended setup.
If a full build copies too much ignored map data, use the deploy script's
code-only Vite build invocation for intermediate gates, then run `npm run build`
once at the final gate.

### 2. Define the data and worker contracts

Add small source-level types for `Point2`, bounding boxes, map index/terrain
metadata, raw drive/walk edges, tile JSON, tram and metro lines, and worker job
request/response payloads. Keep types grounded in the Python writers and current
consumers; make optional data genuinely optional and preserve the tuple forms.
At fetch boundaries, treat `Response.json()` as untrusted input (`unknown`),
then use narrow checks for fields needed before construction rather than casting
an entire unknown object without validation. Avoid rewriting the Python writer
or broad validation of every nested OSM feature during this language migration.

**Gate:** `npm run typecheck` and the code-only Vite build exit 0. Compare the
types with at least one existing `ujezd_now/index.json`, tile JSON, `lines.json`,
and `metro.json` file when present; verify missing optional files still follow
the existing fallbacks.

### 3. Convert leaf modules and geometry first

Rename `src/clock.js`, `src/terrain.js`, `src/footfall.js`, `src/map/geo.js`,
`src/network.js`, and other low-coupling helpers to `.ts` in small groups.
Annotate public function parameters, return values, mutable class fields,
generic `Map`/`Set` collections, nullable lookups, and fixed-length coordinate
tuples. As each file moves, update every import specifier that points to it in
both remaining `.js` files and converted `.ts` files; explicit `.ts` specifiers
are safe for Vite during the mixed phase. Do not leave a `.js` import pointing
at a file that has been renamed.

**Gate after each group:** `npm run typecheck` and the code-only Vite build exit
0. For graph and terrain helpers, preserve numerical results and typed-array
buffer handling; do not combine migration with algorithm changes.

### 4. Convert rendering and simulation modules

Move `src/map/*`, `src/facades.js`, `src/shading.js`, `src/surface.js`,
`src/ground.js`, `src/figures.js`, `src/car.js`, `src/parking.js`, `src/traffic.js`,
`src/people.js`, `src/trams.js`, `src/metro.js`, `src/police.js`, and their
smaller peers in dependency order. Put shared entity interfaces near their
owners and import them as types elsewhere. Explicitly type classes whose
properties appear after construction, callback parameters, Three.js meshes
and materials, and nullable DOM/canvas contexts. When a dependency declaration
disagrees with runtime behavior (especially `straight-skeleton` exports), use
a narrow local adapter or declaration and retain the runtime fallback instead
of changing the runtime path to satisfy the compiler.

**Gate after each group:** `npm run typecheck` and code-only Vite build exit 0.
Review the JS emitted by Vite only where a TS syntax choice could affect
runtime behavior; compare relevant gameplay behavior in the browser.

### 5. Convert the worker pair together

Convert `src/tileWorker.js` and `src/tiles.js` after their dependencies. Give
the four job kinds a discriminated request/result type, and type each transfer
list as transferable buffers. Use the correct worker global type locally in
`tileWorker.ts`; avoid assuming the window's `self` type. Keep the direct
`new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' })`
form so Vite detects and bundles it. Handle missing/unknown job IDs and worker
errors without changing successful jobs' message payload or transfer order.

**Gate:** typecheck and production code-only build exit 0; the built output
contains a worker chunk. In a browser with `?area=ujezd`, tiles load and the
console has no worker resolution or message errors. Check a second tile load
after moving across the map, since the initial tile alone misses pool behavior.

### 6. Convert the entry point, browser controls, and final gate

Convert `src/main.js`, `src/dev.js`, and `src/touch.js` after their imports.
Change `index.html` to `/src/main.ts`. Type DOM queries with null checks or
small required-element helpers; do not use non-null assertions for all UI
elements. Preserve URL parameters, loading fallbacks, event behavior, and the
existing developer panel. Update README source links and add `npm run
typecheck` to development instructions. Set `allowJs: false` (or remove it),
ensure every application source is `.ts`, and keep `strict` enabled. JavaScript
configuration and Python/asset scripts remain outside the application check.

**Final gate:** `npm run typecheck` and `npm run build` exit 0. `rg --files src
| rg '\\.js$'` returns no files; `rg -n '/src/main\\.js|tileWorker\\.js' index.html
src` returns no active references. In the browser, verify `?area=ujezd`
startup, driving, pedestrian movement, tram/metro panels, a second tile load,
and `?dev`; use `?area=centrum` for a larger-data check. Check the browser
console and failed network requests. Review `git diff --stat` for file renames
and no Python/data/deploy changes.

## Stop conditions and review notes

- Stop if the executor cannot distinguish pre-existing working-tree edits from
  migration edits, or if a required in-scope file changes concurrently.
- Stop if a dependency's current declarations require a runtime API change;
  investigate that as a separate change, not as a type workaround.
- Stop if typing reveals a mismatch between generated data and consumer logic
  that needs a Python or wire-format change. Record a sample and propose a
  separate compatibility fix.
- Do not silence categories of errors with `// @ts-nocheck`, broad `any`, or
  by weakening `strict`. Small, documented `unknown` conversions at I/O
  boundaries are acceptable.
- Keep logical commits local; do not push, deploy, or switch branches without
  the operator's instruction. A reviewer should focus on accidental runtime
  changes, module URL changes, optional generated fields, and worker transfer
  ownership.

## Reference documentation

- [Vite TypeScript and web workers](https://vite.dev/guide/features): Vite
  transpiles without typechecking and documents the direct `new Worker(new
  URL(...))` form.
- [TypeScript migration from JavaScript](https://www.typescriptlang.org/docs/handbook/migrating-from-javascript.html)
  and [allowJs](https://www.typescriptlang.org/tsconfig/allowJs.html): mixed
  JavaScript/TypeScript source is a supported staged migration path.
