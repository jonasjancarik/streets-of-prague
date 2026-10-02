---
read_when:
  - Changing surveyed terrain heights, river banks, retaining walls, or ground cutting
  - Rebuilding terrain after a survey-source update
---

# River terrain checks

The overnight terrain work started from `b3c22d5adf` on 2 October 2026. All builds
and captures used the isolated `ae03` worktree. Source packages, layer caches,
Újezd map and Python environment were APFS clones; the main checkout was read-only.
The server ran on port 5201 and the scene runner on 5291. No citywide build,
download, push or deployment was performed.

## Survey source errors

The source has kerb vertices at 294.22–294.47 m near Nosticova, connected to
vertices around 194 m. Another group near the south-east edge of Újezd is
270–273 m against terrain around 194–197 m. These are source errors before the
4 m lattice: densifying the segments first makes intermediate heights that then
spread through inverse-distance interpolation and the feather beside streets.

`dtm_heights.py` now keeps original 3D line components in survey cache version 4.
It checks each finite vertex against the bare terrain before densification,
rejecting an absolute difference over 30 m. It samples only consecutive valid
runs, retains isolated valid anchors, and never connects over a rejected vertex
or between separate components of a MultiLineString. A missing terrain sample
provides no evidence to reject a finite survey vertex. Water and retaining-wall
processing still run even if every street vertex is rejected.

The 30 m threshold deliberately leaves corrections of the size of quay ramps,
retaining walls and underpasses intact. In Újezd, 31,506 of 44,443 original vertex
records had a terrain sample. The rule rejected 24 records at 15 distinct XYZ
positions; the largest retained difference was 10.85 m. Synthetic checks also
retain a coherent 300% hillside and a 26 m terrain correction. The rule does not
validate moderate errors or finite vertices outside the built terrain grid.

The source-filter rebuild kept 392 surfaces, 21,377 street points, 19,904 water
points, 1,341 bank points, and 3,088 m of retaining walls. It changed 214 encoded
height samples in two tiles (`1_2` and `4_0`). Every label and bridge-level payload
was byte-identical. All shared tile edges matched their baseline values; the
baseline's existing 0.3 m discrepancy at tile `2_0`'s east edge remained unchanged.
It belongs to the later bridge/ground adjustment, not this source filtering.

At Nosticova's camera centre the ground changed from 286.07 to 194.24 m a.s.l.;
within its 40 m square the maximum changed from 293.66 to 195.79 m. The other seven
camera profiles below were unchanged. This is a correction of a measured source
spike, not evidence that the lattice's steep-slope aliasing is solved.

## Matched cameras and map provenance

The baseline is the normal surveyed build of this exact checkout, not a different
branch's terrain-only build. Its marker is `2026-10-02T21:01:17Z`, pipeline
`b3c22d5adf`. The source-filter map marker is `2026-10-02T21:10:50Z`, pipeline
`b3c22d5adf-dirty`. Both are Újezd, map format 2, with 25 tiles and a
63 × 63 lattice at 4.032258 m. Both use the same inherited IPR building payloads;
the build reports their provenance as older, so strict whole-generation assembly
was not claimed. The terrain step completed normally.

The original capture series uses WebGPU, 1280 × 800, DPR 1, High graphics, 14:00,
clear weather, 2 October, and `t.wait(0.5)` with the same camera parameters.
`main.ts` places the free camera's eye the requested height above the terrain at
the target. The older skill note saying height is above the game's zero is
incorrect. Thus a source correction under the target also moves the eye; the
Nosticova spike view establishes a height profile but is not a fixed-pose visual
comparison. Other targets' heights stayed unchanged.

| Camera | Latitude | Longitude | Height | Tilt | Heading |
| --- | ---: | ---: | ---: | ---: | ---: |
| Legií west | 50.08127 | 14.40807 | 75 | 55 | 0 |
| Legií east | 50.08139 | 14.41288 | 75 | 55 | 0 |
| Čertovka south bridge | 50.08262 | 14.40697 | 45 | 55 | 80 |
| Čertovka north bridge | 50.08520 | 14.40762 | 45 | 55 | 0 |
| Charles Bridge east | 50.08619 | 14.41353 | 75 | 55 | 0 |
| Kampa quay | 50.08451 | 14.40856 | 60 | 55 | 110 |
| Nosticova spike | 50.08275 | 14.40453 | 70 | 50 | 70 |
| Petřín slope | 50.08390 | 14.40061 | 100 | 60 | 270 |

Charles Bridge's west end lies beyond this area's ground coverage. Its initial
capture showed missing ground and was excluded, then replaced by two Čertovka
bridges. This dataset cannot verify the whole of Charles Bridge, Jiráskův most,
Letná, or the long southern bridges.

Evidence is in `/tmp/sop-river-terrain/`: `before-build.log`,
`after-source-build.log`, `rejected-survey.json`, `source-map-comparison.json`,
`before-valid-cameras.json`, `after-source-cameras.json`, and
`shots/before-valid-*.png` / `shots/after-source-*.png`. The preserved baseline
map is `before-map/`, also privately served as `ujezd_before_now` for matched
checks; its index still identifies the original Újezd map.

Additional source comparisons use unaffected nearby targets, with the same final
cutter reading the two maps. Their actual target, eye and quaternion match
exactly before and after; these poses are recorded in
`before-fixed-fixed-cameras.json` and `after-fixed-fixed-cameras.json`.

| Fixed target | Latitude | Longitude | Height above target | Tilt | Heading |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nosticova nearby | 50.08240 | 14.40455 | 150 | 25 | 0 |
| South-east nearby | 50.07680 | 14.41450 | 160 | 25 | 90 |
| Čertovka south, overhead | 50.08262 | 14.40697 | 90 | 10 | 0 |
| Čertovka north, overhead | 50.08520 | 14.40762 | 90 | 10 | 0 |

For example, Nosticova's local target is
`[-175.354190886, 13.899999619, -100.110454212]`, eye
`[-175.354190886, 163.899999619, -30.164305489]`, quaternion
`[-0.537299608, 0, 0, 0.843391446]` in both maps. The source comparison sheets are
`pairs/nosticova-fixed.jpg` and `pairs/south-east-fixed.jpg`.

## Exact cuts at terrain steps

The former `cutAtSteps` inspected triangle-corner labels and bisected edges with
different labels. It missed a terrace wholly inside a triangle, narrow strips
between corners, and three levels meeting in one triangle. Its approximate cuts
also followed bends differently from the separate wall outlines.

`src/terrain-cut.ts` now indexes the existing outlines in 16 m cells. Within each
ground triangle it finds the actual finite segments that enter it, cuts an
arrangement along them, classifies its cells using the existing terrace/water
priority, then merges cells of the same level before triangulation. Holes remain
holes; each level has its own vertices at a step. Alpha values are interpolated
from the original triangle. The ordinary 8 m mesh and existing 2 m refinement
near steps are retained. No height grid or surface-material choice changes.

Merging is necessary: simply extending each segment's supporting line creates
extra vertices on an unrelated mesh or tile edge. One neighbouring tile can then
sample a nonlinear height at that extra vertex while the other uses a straight
edge, opening a crack. The final cutter removes those extensions and their
collinear edge vertices. Independent tiles keep the original edge tessellation
plus actual step intersections. Area signs are calculated relative to a local
origin so tiny pieces at large map coordinates cannot become spurious holes.

The `ground.ts` changes are confined to importing the helper, `cutAtSteps`,
accepting its replacement position/alpha arrays in `finish`, and creating and
clearing the outline index in the existing `stepped` wrapper. Wall construction,
height sampling, bridge levels, and ground materials are unchanged.

### Real geometry checks

The CPU geometry harness compares `3358b32`'s ground cutter with the candidate,
using the identical source-filtered Újezd map. It builds the lower ground of
each tile directly from its ground/road/rail/building inputs (`levels: []`);
bridge and tunnel decks and the browser's canvas masks are outside this cost
measurement. It alternates candidate/baseline order over three runs per tile.

Across 25 tiles, output triangles changed from 1,200,327 to 1,200,712 (+0.032%),
vertices from 770,623 to 771,541 (+0.119%), and geometry buffers from 33,158,612
to 33,185,684 bytes (+0.082%). Neither produced non-finite positions. The densest
survey tile, `0_1`, has 475 terrace-outline vertices: its triangles increased
from 84,851 to 90,402 (+6.54%) and geometry bytes from 2,369,332 to 2,567,744
(+8.37%). Aggregate counts should not hide this local increase.

The sum of per-tile three-run median CPU times was 534.91 ms for the baseline and
646.39 ms for the candidate: about 111 ms extra work across this area. This is a
Node measurement during concurrent overnight work, not a clean GPU, frame-rate,
or streaming-latency benchmark. It establishes a loading-cost tradeoff, not a
performance gain. Counts and correctness are the stronger evidence.

The crossing check samples triangle interiors in non-water ground/road meshes,
excluding shades, walls and level geometry. It ignores points within 1 mm of an
outline to allow for Float32 geometry precision. The number of triangles with
samples on more than one terrain level changed as follows:

| Tile | Step crossings, before → after | Including water, before → after |
| --- | ---: | ---: |
| `0_1` | 531 → 0 | 74 → 0 |
| `1_2` | 131 → 0 | 10 → 0 |
| `2_2` | 535 → 0 | 345 → 0 |
| `2_3` | 232 → 0 | 183 → 0 |
| `2_4` | 56 → 0 | 56 → 0 |
| `3_2` | 31 → 0 | 31 → 0 |

These are sampled crossings, not proof that every source surface or height is
correct. Smooth terrain still uses the 4 m height lattice and 8 m ground mesh;
steep slopes and height interpolation within one level can remain inaccurate.
The cutter improves how existing levels meet, without inventing breaklines for
natural slopes or growing location exception boxes.

The evidence includes `geometry-cost.json`, `geometry-cost-final.log`,
`geometry-cost.mjs`, `crossing-meshes.json`, and `crossing-meshes.mjs`. Both
harnesses and the baseline source copy are in `/tmp/sop-river-terrain/`.
`after-cut-final-cameras.json` records unchanged underfoot profiles for all eight
original valid cameras, with screenshots in `shots/after-cut-final-*.png` and
comparisons against the source-filter-only reader in `cut-pairs/`.

The final reader also passed four WebGL captures (`?renderer=webgl&dev`) at the
fixed targets above. `webgl-stable-fixed-cameras.json` identifies WebGL explicitly
and records the same targets, eye positions and quaternions as WebGPU; screenshots
are `shots/webgl-stable-*.png`. No page or shader errors were returned. An earlier
sequential WebGL capture had an unloaded south-east target and was excluded. The
final harness sets the free camera before teleporting, loads it again afterwards,
and requires the target tile's terrain sampler before taking a screenshot.

### Regression coverage

```sh
node --test scripts/test-terrain-cut.mjs
npm run typecheck
```

The twelve geometry regressions cover narrow enclosed terraces, islands and
holes, three levels, overlapping-outline priority, internal mesh edges,
independently cut tile meshes with nonlinear edge heights, separately clipped
shorelines, winding, degenerate input, interpolated alpha, unchanged density,
dense curved outlines, tiny pieces at large coordinates, and pieces touching
at a point. Coincident cut vertices from overlapping triangles retain distinct
alpha values instead of sharing one triangle's shading with another. The dense
synthetic case puts 99 outline vertices into an 8 m square
and produces 204 triangles without leaking the supporting-line arrangement into
the output. Its runtime is printed for observation, not used as a flaky test gate.

## Remaining checks

The source and cutter changes are separate local commits, with the source filter
as the first checkpoint. Neither is pushed, deployed, or merged into main. The
review server stays available at port 5201 with the private source-filtered map;
the owned scene browsers are stopped and the GPU lock released. The Tailscale
route was unavailable during setup; localhost and the LAN server are available.

Next, inspect the terrain in `centrum` around Letná and more bridge heads using
the same isolated-data procedure, then compare required-tile arrival latency and
frame-time tails in an exclusive GPU window before expanding validation to the
whole city. The 4 m height interpolation, natural slopes, the existing 0.3 m
bridge/ground seam, and bridge collision walls remain separate work. A full app
build, full-city rebuild, and clean frame-rate benchmark were intentionally
skipped; the source regression tests, geometry regressions, typecheck, local
terrain build, geometry harnesses, and both renderer checks are the scoped gates.

## Verification

Run the focused source regressions with:

```sh
cd pipeline
uv run python -m unittest test_dtm_heights -v
uv run ipr_terrain.py ujezd --jobs 2
```

The ten regressions cover rejection before interpolation, gaps, missing values,
separate line components and cache reuse, valid steep surfaces, retained quay and
underpass corrections, water levels, finite heights, and tile seams. Browser
captures were serialized with the overnight GPU lock. No GPU timing claim is
made, and no full-city rebuild was attempted.

`npm run typecheck` passed. The broader Python discovery run passed 43 of 45
tests; two existing `test_build_cache.ChunkBuildTests` assembly tests fail because
their shared `subprocess.run` mock does not accept the `cwd` argument passed by
`layers.pipeline_commit` (`unexpected keyword argument 'cwd'`). Neither file was
changed by this work. The ten source regressions pass independently.
