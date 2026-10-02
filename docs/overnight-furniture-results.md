---
read_when: Reviewing or integrating the overnight park and courtyard furniture feature, or repeating its visual checks.
---

# Furniture implementation results

Implemented locally on 2 October 2026 from `b3c22d5`, in the isolated `fd60` worktree.
The feature adds inferred benches, bins and courtyard planters using existing land-use,
path, tree, terrain and collision data. No map rebuild, download, push or deployment
was performed. Behaviour and tradeoffs are documented in `docs/furniture.md`.

## Map and scene provenance

The private APFS clone resolves to
`/Users/janca/.codex/worktrees/fd60/streets-of-prague/public/data/centrum_now`.
No shared writable data/cache symlink was used. The map's index reports format 2,
`built: 2026-10-02T20:16:12Z`, pipeline `934283de3e`; its SHA-256 is
`539b8a35bca422314595812f7f1feaabe695f7e8eb703230d3577fc12afd80ee`.
The loaded game's area and built marker were verified before captures.

Vite uses port 5203. The final Chrome scene command was `node scripts/scene.mjs serve
--url http://localhost:5203/ --port 5303 --extra '&area=centrum' --date summer
--time 14:00 --weather clear --out /tmp/furniture-final`.
The renderer was verified as WebGPU. Screenshots are 1280×800 at DPR 1, High graphics,
Wednesday 14:00, 15 July, clear weather. Simulation was paused and the HUD hidden.
The player stayed at 50.08365, 14.40835 while the camera moved, keeping the models
unobstructed. This thread exclusively owned the shared GPU lock for the final batch;
Chrome closed before the lock was released.

Final screenshots, raw render counters, object coordinates, reload results and camera
logs have a durable copy at
`/Users/janca/.codex/visualizations/2026/10/02/01a0fe68-c8d9-7221-b7f2-92732e44794d/furniture-evidence/final/`.
The original temporary capture folder is `/tmp/furniture-final`. Initial exploratory
captures remain in the durable parent folder, but precede the path-edge correction;
use the `final` folder for review.

## Matched cameras and costs

Before/after images toggle only furniture mesh visibility in the same loaded scene.
This isolates the visual addition; the hidden state still has furniture collision.
It is not a separate baseline revision or a physics comparison. For complete baseline
generation and collision use `&nofurniture`.

Coordinates are latitude, longitude; height is metres and tilt/heading are degrees.
Each named prefix has `-before.png` and `-after.png`. Counts cover all loaded tiles,
including objects outside the camera view. They describe geometry/memory budgets,
not visible-object counts or frame-time results.

| Prefix | Camera at | Height / tilt / heading | Benches / bins / planters | Meshes | Loaded triangles | Matrix bytes |
|---|---|---|---|---|---|---|
| park | 50.0820578557, 14.4095256671 | 32 / 15 / 0 | 12 / 5 / 4 | 12 | 1,812 | 1,344 |
| courtyard | 50.0838504, 14.4083889 | 30 / 0 / 0 | 12 / 5 / 4 | 12 | 1,812 | 1,344 |
| residential | 50.079773, 14.40593 | 38 / 0 / 0 | 13 / 2 / 3 | 10 | 1,728 | 1,152 |
| riverfront | 50.081814815, 14.4103086003 | 32 / 15 / 0 | 12 / 5 / 4 | 12 | 1,812 | 1,344 |
| bench-low | 50.081814815, 14.4103086003 | 12 / 55 / 270 | 12 / 5 / 4 | 12 | 1,812 | 1,344 |
| bin | 50.082454981, 14.4097226406 | 22 / 25 / 0 | 12 / 5 / 4 | 12 | 1,812 | 1,344 |

`bench-front-*` uses the riverfront location, height 8, tilt 70, heading 270, with
camera up explicitly set to `[0,1,0]` during the capture, then restored. The game's
normal north-oriented camera up rolls its horizon when used at this angle; the test
change makes the bench front, backrest, feet and approach from the path readable.
`bench-side-after.png` is an additional inspection with normal camera up, height 8,
tilt 70, heading 90. These camera adjustments exist only in the test session.

The Kampa park/riverfront views show benches on grass a short distance from mapped
paths, clear of nearby lamps and tree crowns. The front view shows the seat facing
the path, grounded feet and a clear approach. The open courtyard shows one planter
clear of its walk route and walls; the residential view shows two planters in an
enclosed yard. The bin view shows a bin beside the river path. The images support
these sampled placements and appearances, not citywide correctness or actual
historical furniture locations.

At the final park camera, the outermost main scene render was wrapped to read
`renderer.info.render.drawCalls` and `triangles`. Four visibility windows
(off/on/off/on), each 20 animation callbacks, discarded the first three rendered
samples and retained 17 samples each. Every off sample was 51 calls and 249,136
triangles; every on sample was 54 calls and 250,684 triangles: **+3 calls, +1,548
renderer-reported triangles**. Raw samples are in `final/render-counts.json`.
These counters use the renderer's own pass accounting. No GPU milliseconds, FPS or
smoother-play claim is inferred. Matrix uniforms can still upload on drawn WebGPU
frames even when application matrices are unchanged.

Shared bench/bin/planter model buffers occupy 11,664 / 3,888 / 9,072 bytes,
respectively (positions, normals and vertex colours), and use 108 / 36 / 84 triangles.
Each populated kind/tile owns an instanced mesh and 64 matrix bytes per object.
Shared material/model buffers survive tile removal. New instance meshes can still
incur first-use shader preparation; no timing improvement is claimed.

## Verification and integration

`node scripts/check-furniture.mjs` passed deterministic repetition, shifted seams,
spacing, supported/unsupported surfaces, footprint interiors, path-edge setback and
orientation, missing/steep terrain, and courtyard density. Its fixture produced 61
park/garden objects and 31 courtyard planters before varying exclusions. The survey
checks passed parsing, malformed evidence rejection, deadline, fetch abort and an
immutable unavailable outcome despite a late response. The survey has one cached
three-second acquisition per world; all tiles receive the same outcome.

`node scripts/check-furniture-browser.mjs http://localhost:5203/` passed actual
canvas exclusions for roads, water, bridges, structures, buildings, parking, sport,
woods, squares, railway land, lamps, passages, fences and tree crowns. Explicit green
wins over a general named-square outline; explicit paved-square polygons still win
over green. Real land workers transferred matrices and stamped solid collision cells;
missing terrain or disabled furniture returned no objects. Model budgets, shared
resources, bounds, active upload ranges and instance-only disposal passed. Check
outputs are saved in the durable evidence folder.

A final real game tile (`5_5`) was dropped and rebuilt with `world.loadNow`; an ordered
JSON comparison of all furniture kinds/matrices matched exactly. No console or page
errors were returned by completed final scene commands. `npm run build` passed,
including typechecking, with the existing large-bundle warning. Final placement,
survey and worker/model checks passed after the review corrections.

The earlier Karlovo camera had no park furniture because its general named-square
outline overrode green in placement. This is no longer a final exclusion: explicit
green now wins, aligning with the surface thread's correction. This checkout retains
the original ground renderer/data, so Karlovo's final appearance needs the parent’s
integrated validation with that surface fix. No ground polygon or terrain geometry
code was changed here.

Broad driving scenarios, WebGL visual parity, phone checks and frame-time benchmarks
were intentionally skipped for this static scenery feature. No long-route memory or
first-use shader timing claim is made. The 12 m seam inset and conservative crown
clearance can leave sizeable spaces unfilled. The next practical step is human review
of the final views, then integrated real-data validation with the adjacent surface and
terrain changes. A stable, isolated phone/desktop comparison can follow if the density
and placement are accepted.

The dev server remains available at `http://localhost:5203/?area=centrum`,
`http://MacBook-Air-2.local:5203/?area=centrum`, and the configured Tailscale URL
`http://macbook-air-2.adal-macaroni.ts.net:5203/?area=centrum`. Tailscale was stopped
at verification, so the last URL is currently unavailable. The owned scene browser
was stopped; pre-existing processes were preserved.
