---
name: smooth-road-profile
description: Diagnose and smooth dips, crests and abrupt changes of grade along a drivable route in Streets of Prague while preserving hills, crossfall and separate bridge or tunnel levels.
---

# Smooth a road profile

## Trace the defect

Replay the reported location and heading. Check whether the car follows the dip and whether the asphalt itself changes height. A kerb drawn across an otherwise smooth lane points to a surface polygon or a misplaced level. Fix that geometry before fitting heights.

Trace each carriageway through the directed driving graph between the requested endpoints. Keep the actual turns, widths and changes of level. At each metre, sample the centre and four parallel lines at ±40% and ±80% of the local half-width. Use the surface the vehicle rides there, including its bridge deck or tunnel floor. Record any fallback to ground height and inspect it at crossings. Save these baseline samples before applying corrections.

## Fit and apply the grade

For the magistrála from Wilsonova to V Holešovičkách, the median of the three inner samples gave a centre height resistant to a bad lane sample. An 11-sample moving median followed by Gaussian smoothing with a 12 m standard deviation removed short dips while retaining the long climb. The difference between the inner side samples supplied the crossfall (the slope towards the kerb). We limited it to ±3.5% and smoothed it over distance. Choose the distances and crossfall for the road being repaired, especially on banked bends.

Keep control points at junctions, bends and level changes. Apply the fitted height only to the matching level and blend back into the surrounding terrain beyond the kerb. The magistrála uses a 3 m shoulder. Where a wide road joins a narrow ramp, prefer the segment that spans the sample point. Otherwise the end of the wide segment can pull the ramp to the wrong height.

The reference implementation stores controls in `pipeline/magistrala_profiles.json` and assigns them to both Prague map grids in `pipeline/magistrala.py`. Follow the shared sampler in `src/magistrala.ts` through `src/tiles.ts` and `src/tileWorker.ts` so the vehicle and the rendered road agree.

## Verify the ride

Repeat the same samples in both directions. For each line, compare the height at each metre with the average of its heights 5 m before and after. The absolute difference measures a local dip or crest over a 10 m span, even on a hill. Report the worst value and its location. Include junctions, tile seams, deck ends and transitions back to the original road. The per-street check in `scripts/check-road-flatness.mjs` skips street ends, so also sample continuously across those joins.

Drive the worst stretches with `t.follow(line, kmh)` in the scene runner and inspect the road at pedestrian height and normal overhead zoom. On bridges, `kink` measures the change in grade the car rode, while `jump` samples the underlying ground. The magistrála check found a maximum deviation of about 14 cm across five lines sampled over 11.5 km of combined travel. This is an example result. Establishing absolute elevation accuracy requires independent survey heights.
