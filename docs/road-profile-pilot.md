---
read_when:
  - Trying the experimental Italská road profile or comparing its road and vehicle heights
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
grade of 4.7–6.8%. The largest sampled
mesh-to-vehicle height difference in the end and shoulder transitions was 0.030 m.
The withheld stations use the same survey lines as nearby fitting stations, so
their residuals measure interpolation within the source.

Only the pilot edge's results changed among 396 nearby streets. The adjacent
Vozová junction kept the same sampled height. Two independently meshed synthetic
tiles agree along a shared edge within 0.01 mm. The real Italská strip is inside
one tile. A sedan completed one test drive in each variant without damage, and the
fixed top-down views showed continuous paving and lane markings.

The affected tile's road and sett layers increased from 11,050 to 15,603
triangles. This pilot did not measure frame times.
