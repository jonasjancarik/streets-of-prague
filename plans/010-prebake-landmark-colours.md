---
read_when: Implementing step 4 of the driving-stutter work, or generating and loading landmark textures.
---

# Plan 010: Bake landmark colour adjustments into assets

This is step 4 of the driving-stutter work. Move the existing landmark texture colour adjustment from the browser's main thread into asset generation, preserving the current look and compatibility with unconverted map data.

## Status and starting point

- Status: DONE for local code and isolated asset staging; shared map data and deployment remain pending. Cold-load timing benefit is inconclusive.
- Priority: P2, or P1 if pauses are specifically associated with approaching landmarks.
- Effort: one to two days plus asset verification. Risk: medium.
- Category: performance. Dependencies: none technically; keep the graph-sharing work from 007 if present.
- Planned at: `5162c1fcf11e51df8ceda46049cac217fc7a12cd`, 2026-09-30.
- Confidence: high in the synchronous pixel processing; its elapsed time and current texture inventory are unmeasured here. Do not repeat the review's speculative millisecond estimates as results.

Start with `git status --short` and:

```sh
git diff --stat 5162c1fcf11e51df8ceda46049cac217fc7a12cd..HEAD -- src/tiles.ts pipeline/landmarks.py pipeline/landmark_bake.py pipeline/landmark_colours.py pipeline/test_landmark_colours.py scripts/check-landmark-colours.mjs
```

Reconcile changes with the named symbols below. Plan 005 also concerns roofs/photo colours; if it has been implemented, confirm the intended colour formula before doing this work. Do not revert newer colour decisions. No branch change, commit, push, shared-data replacement or deployment is authorized by this plan alone.

## Current state and conventions

Read `.agents/skills/landmarks/SKILL.md` and `.agents/skills/performance/SKILL.md`. The browser uses npm/Vite/TypeScript; the Python pipeline uses uv and Python >=3.12. NumPy and Pillow are already declared in `pipeline/pyproject.toml`; no new imaging dependency is needed. Blender is needed for a fresh geometric bake but not for converting an existing GLB's embedded textures.

`src/tiles.ts:169–203` adjusts the photograph after loading:

```ts
const canvas = document.createElement('canvas');
canvas.width = img.width; canvas.height = img.height;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
ctx.drawImage(img, 0, 0);
const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
// Iterate every RGBA pixel, shift warm hues, increase saturation.
ctx.putImageData(data, 0, 0);
map.image = canvas;
map.needsUpdate = true;
```

`landmarkModel()` calls `warmUp(map)` for each mapped mesh. The exact current formula normalizes sRGB byte channels, selects pixels with `d >= 0.04`, maximum channel red, `g >= b`, and hue <=0.17; it shifts hue by up to 0.018 and increases saturation by up to 8%. Read the whole function rather than substituting a generic hue filter. It operates on encoded colour bytes, not linear-light shader values. Canvas byte clamping/rounding is part of the reference.

`src/tiles.ts:807–815` caches loaded landmark model promises by name, so this is mainly a first-load cost per landmark. Moving the colour operation offline does not remove image decoding, texture upload, mipmaps or shader compilation.

`pipeline/landmarks.py:175–219` generates two kinds of final model: Blender-baked LOD3 models through `bake()`, and raw textured mesh models through `write_glb()`. Both return a manifest entry naming `landmarks/<name>.glb`. `write_glb()` also writes source/reference assets used by Blender: do not warm those inputs accidentally. `pipeline/landmark_bake.py` exports the baked final model and a source-classification diagnostic model; the diagnostic colours must remain untouched.

The raw GLB writer at `pipeline/landmarks.py:222–250` demonstrates the existing binary layout conventions: embedded images, buffer views, 4-byte alignment, JSON/BIN chunks, and attribution. Match those conventions when rewriting image payloads.

## Scope

In scope: new `pipeline/landmark_colours.py` and `pipeline/test_landmark_colours.py`; final-output integration in `pipeline/landmarks.py`; the skip/fallback in `src/tiles.ts`; new `scripts/check-landmark-colours.mjs`; `README.md`, `todo.md`, the colour-processing paragraph of `.agents/skills/landmarks/SKILL.md`, this plan and the index row. Only modify `pipeline/landmark_bake.py` if final-export integration cannot stay in the calling pipeline, and explain why first.

Generated outputs belong in an isolated directory until explicitly approved for use in shared `public/data`. Keep original files and manifests intact during verification. Out of scope: geometry, footprints, normals, roof palettes/masks, texture resolution changes, new landmarks, terrain rebuilds, Cloudflare/server deployment, and removing the old-asset fallback before data migration is complete.

## Implementation steps

### 1. Port the colour operation and test it independently

Implement the existing warm-colour formula as a vectorized NumPy operation over Pillow-decoded byte pixels. Preserve alpha, dimensions and orientation; do not apply EXIF rotation or a different gamma conversion silently. Process only images used as base-colour photographs, not normal, metallic/roughness, occlusion or diagnostic textures. If one image is used for both colour and non-colour purposes, stop rather than recolouring both uses.

Write standard-library `unittest` cases in `pipeline/test_landmark_colours.py`. Compare against a scalar reference transcribed from the current browser formula, including clamped-byte rounding, for fixed colour fixtures and a deterministic random sample. Cover black, grey, blue, red/brown/yellow, low saturation, selection thresholds, alpha, and a small multi-row image that exposes vertical flips. Establish byte-level agreement before lossy image encoding; rendered screenshots alone are insufficient for the formula.

**Verify:** from the repo root, `uv run --project pipeline python -m unittest discover -s pipeline -p test_landmark_colours.py` exits 0. This command and the named test/helper files are new work specified by the plan.

### 2. Convert final GLBs with a version marker and separate filenames

Add a post-export conversion function used after either final-output branch in `landmarks.cut()`. The function should write `<name>.warm-v1.glb`, retaining the original unconverted asset. Put `landmarkColourVersion: 1` in the active glTF scene's `extras`; three.js exposes scene extras through `gltf.scene.userData`. Verify that mapping in the browser instead of assuming it. A marker in the generated asset is preferable to a manifest-only claim about its contents.

Repack embedded image buffer views with correct 4-byte alignment and updated lengths/offsets. Preserve mesh/accessor payloads, indices, UVs, materials, scene transforms, samplers and attribution. Do not append entire old and new atlases indefinitely. Preserve non-image buffer-view bytes exactly. Reject unsupported external image/buffer references or chunk layouts with a clear error instead of emitting a partly converted file. Mark only successfully completed conversions; an already-marked v1 asset must not be warmed or recompressed again.

Keep JPEG for opaque JPEG photographs initially, using an explicit recorded quality consistent with the existing bake (88); preserve alpha with a format that supports it. The extra JPEG encode can alter pixels, so test the formula before encoding and assess rendered output/file size separately. If the colour loss is visible, report the quality/size trade-off rather than changing image format or resolution silently.

Provide a CLI in the helper with `--area-root`, `--output-root`, and `--dry-run`. It converts the assets named by an existing `landmarks.json` into a separate staged area directory and writes a staged manifest referencing versioned filenames. It must preserve all entry fields, leave unsupported/failed entries unmodified only with an explicit reported partial result, and exit nonzero on incomplete requested conversion. Reject identical source/output roots in migration mode. Dry-run validates source structure and lists intended outputs without writing them.

**Verify:** expand the unittest command above with multi-image GLB fixtures, preserved non-image bytes, valid offsets/lengths, untouched source files, version-marker round trip, second-run idempotence, alpha, and failed-output handling. Then run the proposed CLI with `--dry-run`; it lists outputs and creates none.

### 3. Skip runtime warming for converted models and preserve old data

In `landmarkModel()`, inspect the loaded scene marker before traversing its meshes. Skip `warmUp()` only for a supported baked-colour version. Unmarked assets retain the existing operation and appearance. Use a per-model texture set to avoid applying the legacy adjustment more than once to a texture shared by multiple meshes. A marker for an unknown future version should produce a clear unsupported-version error; do not guess whether to warm it again.

Keep anisotropy, colour space, side, landmark shading and normal construction unchanged. New versioned filenames avoid old cached GLBs being mistaken for converted files. The staged manifest must only be activated with a client that understands the marker: an older client still warms everything and would double-adjust new assets. Record that app-first/data-second rollout requirement in `README.md`; no deployment is part of this execution step.

Create `scripts/check-landmark-colours.mjs`, following the error handling in `scripts/check-graphics.mjs`, with `--url` and `--fixtures` pointing at staged outputs. Use browser request routing or an isolated candidate data root to test staged GLBs without overwriting shared data. Assert that converted maps remain decoded images rather than replacement canvases, old assets still follow the compatibility path, shared maps are not processed twice, and supported markers survive GLTF loading.

**Verify:** `npm run typecheck` and `node --check scripts/check-landmark-colours.mjs` exit 0. Run the browser assertions in step 4 after generating the staged fixtures. Unknown-version and legacy cases must be explicit test cases, not skipped.

### 4. Stage representative assets and compare their first load

After verifying the parent directory exists and that source/output paths are distinct, these are the proposed conversion commands, run from the repo root during authorized execution:

```sh
uv run --project pipeline python pipeline/landmark_colours.py --area-root public/data/centrum_now --output-root /tmp/sop-landmark-colours/centrum_now --dry-run
uv run --project pipeline python pipeline/landmark_colours.py --area-root public/data/centrum_now --output-root /tmp/sop-landmark-colours/centrum_now
node scripts/check-landmark-colours.mjs --url http://localhost:5191/ --fixtures /tmp/sop-landmark-colours/centrum_now
```

Repeat on an isolated `praha` fixture for a raw model such as Okamura if the centrum set has no raw model. Check the actual manifest before choosing; do not assume a landmark count or atlas size from the review.

Compare the old runtime-warmed texture with the newly baked texture, both drawn by the candidate renderer with identical scene settings. Check a terracotta roof, warm plaster, grey/blue areas, shadowed roof texels and one raw model. Use matched cameras at 14:00 clear and 22:00, plus a legacy WebGL smoke check. The original GLB before runtime warming is not the visual reference.

For first-load attribution, load a non-landmark location, install instrumentation, then use `window.__drive.teleportTo(x, y)` to load the chosen landmark from a fresh page. The ordinary `--stalls` hook is installed after startup/settling, so starting the benchmark on the landmark can miss the work entirely. Extend the focused runner to time this controlled cold transition and assert zero legacy pixel-pass calls for marked assets; pair/alternate original and staged data. Re-visiting an already-cached landmark is not a valid cold test.

**Verify:** the Python tests, browser runner, `npm run build`, and `git diff --check` pass. Record source/output image dimensions, total asset bytes, first-load results and image comparisons. Keep the original/staged manifests separate; report data migration as pending if shared assets have not been activated.

## Environment and completion

Browser checks use the existing Chrome/Playwright discovery in `scripts/bench.mjs`; no dependency installation is required by the plan. There is no generic npm test/lint script. Use `npm run dev` only during authorized execution, after checking port ownership, and follow the user's server/PortPilot and access-URL instructions. Do not edit a snapshot while timing it. Python tests use uv with the existing pipeline dependencies, not a replacement runtime. Assets in `public/data` can be shared by other sessions and are not tracked by git.

- [x] Formula tests agree with the scalar browser reference before image encoding.
- [x] GLB tests preserve non-image data and metadata, validate the marker and alignment, and prevent double adjustment.
- [x] Both baked and raw final-output paths support conversion; Blender source/debug assets remain untouched.
- [x] Marked assets incur no browser colour pixel pass; old assets keep the compatibility path.
- [x] Visual checks, asset-size accounting, corrected cold-load verification, typecheck/build and documentation are complete.
- [x] The index distinguishes code completion from staged/shared/deployed asset status.

Stop if unsupported GLB layouts appear, image colour-space handling cannot match the browser, shared sources would be overwritten, or a colour change from plan 005 makes the reference ambiguous. Do not hide an asset mismatch with a shader recolouring change. If the JPEG round trip changes the look materially, bring back the measured quality/size options.

Version the marker whenever the baked formula changes. Future clients must continue to distinguish transformed assets from legacy ones until migration is explicitly finished. Removing the fallback is a later decision, not a prerequisite for avoiding the pixel pass on converted landmarks.

## Result

Implementation began at `a3032fbf44451e97a9e13248af6c5cb4a17844f7`, with core code in `30d3ab0`. The Python converter preserves originals and other GLB buffer-view bytes, embeds `landmarkColourVersion: 1` in the active scene, and writes separate `.warm-v1.glb` files. `landmarks.cut()` calls it after either Blender-baked or raw final export; it does not touch Blender's source or source-classification files. The browser checks the loaded scene marker before traversal, warms shared legacy maps once, and rejects unknown versions.

Source data was read only from `/Users/janca/projects/streets-of-prague/public/data`. The isolated output roots are `/tmp/sop-landmark-colours-010/centrum_now` and `/tmp/sop-landmark-colours-010/praha_now`; neither source manifest nor source GLB changed. Dry-run validated all 7 centre and 8 city entries without writing. A separate parse compared every staged manifest field except the filename, plus geometry and non-image buffer-view bytes, across all 15 models; they matched the originals. The staged centre GLBs total 10,928,568 bytes versus 8,190,312 original (+33.4%); city GLBs total 11,528,728 versus 8,673,904 (+32.9%). Baked atlases retained their 4096² dimensions, except St Nicholas at 2048²; raw Okamura retained four 1024×512 atlases. Sample decoded JPEG error against the warmed source pixels was 0.226–0.562 mean absolute byte value per channel, with 95th percentile at most 2. The added JPEG encode at quality 88 caused no visible colour loss in the checked game views, though the file-size increase is real.

Verification passed: `uv run --no-sync --offline --project pipeline python -m unittest discover -s pipeline -p test_landmark_colours.py` (8 tests; using the existing pipeline venv and an isolated uv cache because the default cache was sandbox-blocked), `npm run typecheck`, `npm run build`, `node --check scripts/check-landmark-colours.mjs`, and `git diff --check`. The browser runner was called with `--url http://localhost:5240/ --fixtures /tmp/sop-landmark-colours-010/{centrum,praha}_now` for staged and `--legacy` data, on headless Chrome at 1280×800, DPR 1, High, clear 14:00 and fresh 22:00 scenes, in WebGPU and WebGL. It verified that three.js copies scene extras into `gltf.scene.userData`, that converted maps remain images and make zero `putImageData` calls, that legacy maps become canvases, that shared maps get one pass, and that version 999 is rejected. The final runner observed no page or console errors. First-load JSON and screenshot evidence is under `/tmp/sop010-*.json` and `/tmp/sop010-*.png`.

An earlier version of the runner switched from day to night within an already-loaded page. The buffered Vite log from those dev sessions contained repeated WebGPU `GPUValidationError: Destroyed texture [1024x1024 RGBA16Float] used in a submit`. That size and format match the lamp light-map target in `src/lamps.ts`, not a landmark atlas. The cause was not established. The final runner uses a fresh page for 22:00; a new staged Old Town Hall night run produced no page/console errors or Vite log warning. No renderer code was changed for this plan.

Matched screenshots of Old Town Hall's terracotta and shaded roofs, grey tower and walls, Mánes's grey/blue roof, and raw Okamura were inspected at day and night. Staged and legacy landmark surfaces looked consistent in both renderers; people and transient place labels differ between runs. In selected landmark image regions, the screenshot comparison had mean absolute RGB differences below one byte per channel. The first timing samples were taken after direct GLB assertions loaded the same photographs, so they were excluded from cold-load attribution. The corrected runner instruments `teleportTo` before any direct model assertion on each fresh page. In an alternating staged/legacy/legacy/staged Mánes sequence, WebGPU transitions were 427/488 ms staged against 623/651 ms legacy; WebGL was 577/429 ms staged against 565/443 ms legacy. A raw Okamura pair was 423/425 ms staged against 540/662 ms legacy (WebGPU/WebGL). The browser loaded nearby tiles and other landmarks during these transitions, and the WebGL Mánes pairs changed direction, so a general whole-transition timing benefit is not established. The verified reduction is zero colour pixel passes for marked assets, against two passes for the Mánes legacy transition (including a nearby landmark) and four for raw Okamura. Corrected JSON evidence is in `/tmp/sop010-cold-*.json`.

Shared `public/data` still points to the original manifests and GLBs. Activate the versioned assets only after a client containing the marker check is live; an older client would warm them a second time. No push, merge, shared-data replacement, or deployment was done.

### Switched on in a clone, 6 October 2026 (branch `night-landmarks`)

"Switching on" is the `file` of each entry in `public/data/<area>_now/landmarks.json`:
the client loads whatever it names. `landmarks.py` writes the `.warm-v1.glb` name there
(also with the new `--rebake`), so no separate step is needed. In clones of `praha_now`
and `centrum_now` all landmarks were baked again with `--rebake` (the bake's new wall
fill, and Mánes's roof spot) and their manifests name the warmed files.
`scripts/check-landmark-colours.mjs --fixtures public/data/praha_now --area praha --name
okamura` passed on that data in WebGPU and WebGL (no pixel pass for the marked file,
legacy and shared files still adjusted once, version 999 rejected). The same check for
`centrum` with `--name tyn` stopped at its own precondition (the Týn Church is already
loaded at the script's starting place; use the default, Mánes); it was not run again
that night. Screenshots of all eight landmarks, old files with the browser's pass
against the new warmed files, look alike in colour. The shared `public/data` is still
on the old files: replacing them and uploading is the coordinator's step.
