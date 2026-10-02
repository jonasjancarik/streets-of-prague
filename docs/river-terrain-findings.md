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

Every capture uses WebGPU, 1280 × 800, DPR 1, High graphics, 14:00, clear weather,
2 October, and `t.wait(0.5)` with the same camera. Height is in game metres above
the 180 m reference. The camera is centred on the listed latitude and longitude.

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
