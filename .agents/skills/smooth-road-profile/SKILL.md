---
name: smooth-road-profile
description: Diagnose and repair dips, bumps and sudden pitch changes on drivable roads in Streets of Prague. Use for a reported jolt, a rough bridge approach or a request to smooth a route and verify it with a virtual drive.
---

# Smooth a road profile

## Reproduce the ride

Replay the reported location, direction and camera. Check whether the wheels follow the defect. If a kerb appears across a lane while the car rides smoothly, inspect the surface polygons and their levels first.

Trace each requested direction on the driving graph, keeping turns, widths and changes of level. Save a baseline before changing the map. Sample every metre along the centre and at ±40% and ±80% of the local half-width, using the deck or tunnel floor where applicable. Record where a missing level sample falls back to ground. Continue across junctions and tile seams. The per-street scan in `scripts/check-road-flatness.mjs` skips street ends.

## Choose the repair from the evidence

- **At a bridge end**, compare the graph’s level transition, the rendered deck outline, the ground below it and the road height across every lane. At náměstí Hrdinů the upper road and deck agreed, but a gap exposed the lower street. `pipeline/bridge_joins.py` extends the deck and its graph span to the first supported landing across the carriageway. Recheck the road underneath and a healthy join. The [terrain-steps skill](../terrain-steps/SKILL.md) covers abutments and retaining walls.
- **On ordinary asphalt**, compare the rendered terrain mesh, its underlying height grid and the LiDAR across the dip and on both approaches. At Wilsonova and Politických vězňů the mesh and grid both dipped while the scan followed a gentle grade. `scanned_road_dips` in `pipeline/tin_tiles.py` uses that scan where it meets the road on both sides. Preserve dips confirmed by the scan. Check the fix in the map build the player uses and compare heights along the rebuilt tile’s edges.
- **For repeated roughness along a carriageway**, fit its longitudinal grade and crossfall (the slope towards the kerb) separately for each direction. The magistrála fit used the median of the three inner samples, followed by an 11-sample moving median and Gaussian smoothing with a 12 m standard deviation. That fit limited crossfall to ±3.5% and blended it into a 3 m shoulder. Tune those distances to the road. Keep controls at bends, junctions and changes of level. `pipeline/magistrala.py` tiles the controls in `pipeline/magistrala_profiles.json`. The renderer and vehicle share the sampler in `src/magistrala.ts`.

Prefer correcting a rule shared by roads with the same defect. Rebuild the affected tiles first. Keep the original map available for comparison.

## Verify the result

Use the [scene-testing skill](../scene-testing/SKILL.md) to drive a sedan with `t.follow(line, kmh)`. Repeat with the same car, line and target speed. For a route-wide request, drive the full route and replay the worst stretch on its own. Check arrival and deviation from the line so a car that missed the defect cannot count as a pass. Inspect the road at pedestrian height and normal overhead zoom.

Choose the measurement that answers the report and give the before and after values, units and location.

- **Dip or crest in metres.** Compare the height at each sample with the average 5 m ahead and behind. A steady climb gives zero deviation.
- **Jolt felt in the virtual drive.** `t.follow` reports `kink`, the change between successive vertical rises, in metres, sampled a sixth of a second apart on the surface the car rode. Its `jump` field samples ground height and can include the drop below a bridge.
- **Pitch in degrees.** At the moving car’s position and heading, sample the front and rear on its current level. Compute `atan2(frontHeight - rearHeight, sampleSpacing) * 180 / Math.PI`. Record the spacing and any ground fallback. This measures pitch imposed by the road. Measuring suspension motion requires the rendered chassis orientation.

For a general bridge change, run `node scripts/check-bridge-decks.mjs praha --ride-joins --save before.json` on the baseline, then repeat on the candidate with `--save after.json --against before.json --strict-regressions`. Compare the saved `rides` by road, bridge and node. They rank the change in pitch over 2 m of travel using a 4 m front-to-rear span. The strict regression check covers deck breaks and end heights, so inspect the pitch results separately.
