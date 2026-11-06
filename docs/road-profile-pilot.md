---
read_when:
  - Trying the experimental Italská road profile or comparing its road and vehicle heights
  - Generating and screening road surface patches across Prague
  - Deciding whether to fit a road beside a retaining wall
---

# Italská road profile pilot

The pilot covers 50 m of Italská north of Vozová. Its longitudinal curve and
cross-slope come from cross-sections through both DTM ZPS kerbs. The fit gives the
two sides equal weight and limits the influence of outliers. The last 6 m at each
end and a 2 m strip outside the core blend into the existing terrain. The generator
rejects a strip that reaches another mapped street, building, wall, water, rail or
level. It also rejects strips in a tile with a tunnel.

The level-zero vehicle sampler and the worker that drapes the road, markings and
surrounding ground use the same profile. The worker subdivides the draped mesh
around the strip at 2 m. The rest of the map uses the existing terrain. Hill shading still comes
from the terrain lattice. The fit models a cross-slope and does not infer a crown or
reconstruct junctions.

## Try it locally

Run from the repository root with a built Prague map and its DTM survey cache.

```sh
uv run --project pipeline python pipeline/road_profile.py --write --report /tmp/italska-kerbs.json
node scripts/check-road-profile.mjs public/data/praha_now /tmp/italska-kerbs.json
node scripts/check-road-flatness.mjs praha --near 50.0798,14.4375,400 --roadprofiles
```

Open the game with `?roadprofiles` and go to 50.08243, 14.43964. The URL option
reads the generated `road-profile.json` only for its matching map build. The
generator can use `--survey-snapshot pipeline/.cache/dtm/heights/praha.pkl`
with a trusted local survey snapshot to avoid re-reading the source packages in a
cloned worktree.

## Comparison on the 5 November map

| Italská edge `1449046826>2245320227>0` | Existing terrain | Pilot |
|---|---:|---:|
| Largest change in cross-slope over 4 m | 11.1 percentage points | 1.8 percentage points |
| Largest absolute cross-slope | 6.7% | 2.8% |
| Largest absolute ridge or trough | 0.26 m | 0.08 m |
| Largest centreline bump | 0.11 m | 0.08 m |
| Mean absolute difference at 18 withheld kerb samples | 0.178 m | 0.018 m |
| Largest checked mesh-to-vehicle height difference in the core | 0.761 m | 0.008 m |

The fitted road descends 2.76 m with a 2.07% cross-slope and a longitudinal
grade of 4.7–6.8%. The largest sampled mesh-to-vehicle height difference in the
end and shoulder transitions was 0.030 m.
The withheld stations use the same survey lines as nearby fitting stations, so
their residuals measure interpolation within the source.

Only the pilot edge's results changed among 396 nearby streets. The adjacent
Vozová junction kept the same sampled height. Two independently meshed synthetic
tiles agree along a shared edge within 0.01 mm. The real Italská strip is inside
one tile. A sedan completed one test drive in each variant without damage, and the
fixed top-down views showed continuous paving and lane markings. At 30 sampled
marking overlaps, paint triangles ranged from 0.6 mm below the asphalt to
1.0 mm above it. The at-grade layers write no depth, and stencil rank places
the markings over the asphalt regardless of these height differences.

The affected tile's road and sett layers increased from 11,050 to 15,603
triangles. A later integration check used three alternating baseline/candidate
WebGPU runs with a fixed top-down camera, High graphics, DPR 1 and paused
simulation. Mean frame times were 4.2 → 4.3 ms; individual pairs changed in both
directions (3.9/4.2, 4.6/4.5 and 4.2/4.0 ms). The difference was smaller than the
run-to-run variation. Draw calls stayed at 140 and total rendered triangles rose
from 2,513,591 to 2,535,938. These static desktop measurements do not establish
driving or mobile performance. See [the performance log](performance-log.md).


## Hořejší nábřeží

The same profile cannot safely cover the riverward kerb of edge
`21896519>8571419383>0` in tile `53_58`. The existing flatness check finds 21%
lean at 50.07412, 14.40960. The edge is 27.6 m long and bends up to 1.18 m
away from the straight line between its ends.

At 8 m along that edge, the upper carriageway occupies offsets −3.57 to
+3.42 m. Negative offsets are toward the river. Terrace 5 starts at the
riverward kerb and extends from −3.57 to −3.83 m. The lower carriageway starts
at −4.66 m. Two DTM wall lines cross this section at −3.56 and −3.82 m. The
cache retains their position but drops their heights. The nearest road-edge
height observations in the DTM cache are on the inland side of the upper road
(+3.41 m, 193.74 m a.s.l.) and the far edge of the lower road
(−10.16 m, 190.27 m a.s.l.).

| Offset from the upper road centre | Surface | Game height a.s.l. |
|---:|---|---:|
| −3.60 m | Terrace 5 | 190.60 m |
| −3.50 m | Upper road at the riverward edge | 192.44 m |
| −2.73 m | Upper road, riverward sample | 192.78 m |
| 0.00 m | Upper road centre | 193.40 m |
| +2.88 m | Upper road, inland sample | 193.91 m |

The profile's 2 m shoulder would leave at most 1.57 m of core on either side
of the centreline before reaching the terrace. That misses both flatness
samples. Even a 10 m trial strip from stations 5 to 15 with a 3.5 m half-width
and 2 m shoulders intersects 15.82 m² of terrace 4 and 2.81 m² of terrace 5.
The generator rejected it.

A patch here needs to follow the curved road polygon and stop at the surveyed
wall line on the river side. Its riverward edge needs its own height constraint
to join the wall top while keeping the height of the terrace and lower road.
The road and terrace need separate edges at their shared plan position so the
mesh and the vehicle sampler preserve the step.

### Original wall heights and the trial fit

The original Prague 5 ZPS package, `VS_CZ010_MOMC_500143_20260831_ZPS_KR.gpkg.zip`,
supplies the missing height. At the 8 m section above, wall record
`100085041784` is 193.89 m a.s.l. and coincides with the upper asphalt edge.
The opposite kerb `100021615720` is 193.74 m, a cross-slope of about 2.2%.
Both have horizontal and vertical accuracy class 3 and acquisition code 1.
The foot of the wall, record `100085041782`, is 190.50 m and has vertical
class 5. [ČÚZK accuracy classes](https://dtmwiki.cuzk.gov.cz/01_pravidla/01_zaklad/02_presnost)

An offline trial followed the curved carriageway along the existing terrace
cut. Its core used the wall top and inland kerb. Cubic joins matched the
existing road heights and slopes at both ends, and a narrow blend inside the
inland kerb left the adjoining pavement alone. Stations here are measured along
the straight chord of the OSM edge. The patch ran from −10.5 to 27.25 m, with
the survey-constrained core from 2 to 9 m. The check sampled every 0.25 m from
−16 to 42 m, including the approaches beyond the fit.

The largest river-side wheel-path grade fell from 46.4% to 12.3% within the
patch. The largest remaining grade, 22.4%, was outside it. The centreline
bump measured against samples 3 m to either side fell from 0.160 m to 0.059 m. The inland kerb itself stayed at its existing height, with a mean absolute
difference of 0.310 m in the core. The joins put the upper edge below the survey.

| Survey comparison | Stations | Mean absolute difference | Largest difference |
|---|---:|---:|---:|
| Core wall top, used as a constraint | 29 | 0.000 m | 0.000 m |
| South join, wall top | 50 | 0.274 m | 0.499 m |
| North join, wall top | 73 | 0.653 m | 1.107 m |
| North join, separately surveyed river-side kerb | 24 | 0.908 m | 1.109 m |

At station 22 m the surveyed wall top is 194.17 m and the trial is 193.06 m.
The separate kerb is still 194.13–194.16 m farther north, as the distance
between it and the wall grows from 3 cm to over a metre. An approach fit there
needs to follow the road once it separates from the wall, while preserving the
wall as a separate feature. The trial stayed offline because its smoother
joins disagreed with both sources.

## Wider Prague trial, 6 November 2026

The wider trial fits small two-dimensional surfaces to surveyed road edges. A fit
can follow a curved carriageway or span a connected junction. It fades into the
existing terrain around the edge of the patch. The car sampler and ground mesh
read the same surface. Existing terrain labels keep retaining-wall faces and
water separate, and the terrain lattice still supplies hill shading.

The generator screened 1,000 locations on Prague map `2026-11-06T00:13:10Z`,
alternating between three roughness severity bands where available. It proposed
117 fits after excluding locations without enough consistent survey evidence,
mapped crossings, rail and tiles with tunnel depth masks. It used a 1 m blend
mask for each fitted plane or quadratic. The held-out stations come from the
same survey lines as nearby fitted stations.

A second screen uses the game's height sampler to compare the same road
segments before and after fitting. It includes the approaches that the usual
flatness report trims. A patch needs a measured improvement on a road it
changes. The screen rejects patches that introduce hard-threshold findings or
materially worsen existing metrics. It also rejects steepened approaches,
changed blocking edges and larger drops at open crossings. When two patches
affect the same road, both are excluded so a single street-wide improvement cannot earn credit twice.
The road and collision reports must match the exact patch file by SHA-256.

### Prague regression check

The screen retained 74 patches: 28 curves, four junctions, one street beside
a retaining wall and 41 other street sections. The final comparison checked
all 57,188 car-network segments. Measured geometry changed on 83 segments.
There were no new hard-threshold findings. Blocking-edge geometry matched,
and no reported open crossing drop increased by more than 5 cm.

| Segments over the hard limit | Baseline | Screened patches |
|---|---:|---:|
| Steps over 1 m | 36 | 36 |
| Bumps over 0.5 m | 561 | 560 |
| Cross-slope over 15% | 3,022 | 2,977 |
| Cross-slope change over 12 percentage points | 2,478 | 2,435 |
| Ridges or troughs over 1 m | 150 | 150 |
| Off-carriageway stretches over 10 m | 0 | 0 |

### Representative places

- Cidlinská's bend. Largest cross-slope 35.8% → 6.5%, with a completed
  drive in both variants and no damage. The largest height change over
  a sixth of a second fell from 0.22 m to 0.16 m.
- Šperlova and Dobrovolského. Largest bump 0.35 m → 0.14 m on the
  measured Šperlova arm. The sedan completed a turn in both variants.
  The largest sampled height change on the drive fell from 0.34 m to 0.20 m.
  Both runs recorded small amounts of damage.
- U Žlábku, beside a retaining wall. Largest change in cross-slope 60.5 → 56.0 percentage
  points. The existing 1.6 m step remains. The collision edges matched, but
  the player-drive attempts on both route lengths stalled in both variants.
  A reverse approach with an in-car road reset also stalled in both.
- Hořejší nábřeží. The initial fit reduced the tested cross-slope from 21%
  to 6%, but added blocking-edge pieces. A second fit faded away from
  the wall and preserved the original blocking edges. Its approach and cross-section checks
  still rejected it. Hořejší is excluded from the preview.

The fixed top-down screenshots use identical camera poses for both variants.
See `docs/evidence/wider-road-surfaces/` for the fits, rejection reasons,
checker logs, routes and screenshots.

### Generate and screen another Prague build

The generated sidecar belongs to one assembled map. The experimental
`?roadsurfaces` option loads it when its build stamp matches. Use
`?roadprofiles` to replay the original Italská pilot. The wider option
takes precedence when both are present.

Run from the root of a checkout with a privately copied assembled map and its
matching trusted DTM survey cache. The files under the evidence directory
are working records.

```sh
e=docs/evidence/wider-road-surfaces
mkdir -p "$e"
node scripts/check-road-flatness.mjs praha --save "$e/baseline.json"
uv run --project pipeline python pipeline/road_surfaces.py \
  --data public/data/praha_now \
  --survey-snapshot pipeline/.cache/dtm/heights/praha.pkl \
  --baseline "$e/baseline.json" --out "$e/trial.json" --report "$e/fits.json" \
  --seed horejsi,50.07412,14.40960,26 --seed italska,50.08243,14.43964,22 \
  --seed chotkova,50.09316,14.40628,22 --seed miru,50.07604,14.43656,24
node scripts/check-road-flatness.mjs praha --roadsurfaces "$e/trial.json" --save "$e/trial-roads.json"
node scripts/check-step-edges.mjs praha --roadsurfaces "$e/trial.json" --save "$e/trial-steps.json"
node scripts/screen-road-surfaces.mjs "$e/trial.json" "$e/baseline.json" \
  "$e/trial-roads.json" "$e/trial-steps.json" "$e/accepted.json" "$e/screen.json"
```

Run both checkers on `accepted.json`, then run the screener on those outputs. Check
that every accepted patch survives the repeat, then put the file at
`public/data/praha_now/road-surfaces.json`.
