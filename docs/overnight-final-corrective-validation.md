---
read_when: Reviewing final corrective integration ae86cf4, repeating the scoped centrum validation, or checking remaining tunnel/seam limits before deployment.
---

# Final corrective city validation

The accepted tunnel-domain correction and source-pull change passed a final scoped
validation at source `ae86cf4823f8f94899150d27eaa81a03ed8d8be6`. The regenerated
centrum map restores the previously lost Mrázovka tunnel and adjoining bridge
samples. Its supported 80% tunnel point is again 27.47 m below ground. **The unknown
60% baseline region remains unknown, and the separate Kampa dry-sampler discrepancy
remains.** This is not a full-city or entire-tunnel traversal claim.

This checkpoint changes only reports, evidence and replay fixtures. No production
source, main, remote or deployment change was made.

## Final code, private inputs and strict generation

The tested source includes the accepted source filter/pull, surfaces/cutter,
furniture, parking/graph/fetch guards, vehicles/boats, birds, season picker, taxi,
ambulance, scenario preparation and corrected component-selection policy. The
unaccepted plain-support payload was not used.

[Before provenance](evidence/overnight-final-correction/provenance-before.json) records
source and input hashes. The clean before map remains at
`public/data/centrum_before_harmonic_now` (built `2026-10-03T00:26:37Z`, pipeline
`5182c47670`). The blocked intermediate generation is independently preserved at
`public/data/centrum_blocked_harmonic_now` (built `2026-10-03T03:46:50Z`, pipeline
`76118bc126`). Cached clean street records remain in
`pipeline/.cache/harmonic-before/layers`. All are private copies inside integration.

The [offline wrapper](evidence/overnight-final-correction/offline-build.py) reuses the
recorded OSM/parking/tree/colour inputs, 57 DTM surface and 57 line packages, nine
IPR building/terrain sheets and bridge sources. Network acquisition is blocked.
All six centrum chunks, IPR and terrain were refreshed for final processing keys,
then strict assembly passed. No new source download or citywide regeneration ran.

[Final map provenance](evidence/overnight-final-correction/provenance-current.json):
234 tiles, format 2, built `2026-10-03T05:44:19Z`, pipeline `ae86cf4823`, index SHA-256
`c1dd723ed3e7d9d370532bf461c6b9531c49c8ed95fe0204c46430476525472c`.
All 234 tile JSON/height, 89 levels and 228 IPR payloads passed integrated validation.
The survey still rejects 1,069 raw vertices.

Against the clean before map, all protected drive/walk, parking sections/lots,
passages, crossings, area/road, building/tree/wall/fence fields match; labels and
IPR binaries are unchanged. Heights change at 114 samples in ten tiles, and 15
level payload/outline tiles change. Finite padded bridge coverage loses no samples.
[Data comparison](evidence/overnight-final-correction/data-comparison.json).

## Policy and CPU verification

- One final app build passed, including TypeScript; the existing bundle-size warning remains.
- All relevant focused JS checks passed: parking/fetch, 12 cutter and 11 complete-ground
  checks, ground/furniture/survey, boat access, ground seasons/birds, season picker,
  taxi, ambulance crew and scenario preparation. Bus/police/testkit resource checks
  also passed in their CPU fixture, including 400 retained bus renders.
- Full Python discovery ran once: **107 tests, zero failures**. The frozen clean
  mixed-component export also passed the actual TypeScript decoder/sampler gates.
- The shallow threshold is still **2.5 m**, and `drop_shallow`'s function AST matches
  the earlier accepted `76118bc` implementation exactly. The correction changes
  propagation domain selection, not this policy. [Policy proof](evidence/overnight-final-correction/shallow-policy.json).
- The recorded bridge-only Radotín fixture contains 26 ways and 1,016 nodes. Both
  its 18-pin and 692-pin propagation passes retain bit-identical heights and nearest
  distances versus the accepted harmonic trace. This preserves the control's prior
  result; it is not a new Radotín map/source-height recovery claim.
  [Control](evidence/overnight-final-correction/radotin-control.json).

[Logs and hashed evidence](evidence/overnight-final-correction/) preserve the exact
commands/results. Build timings are completion records, not performance comparisons.
No implementation or test initialization repair was needed in this validation pass.

## Mrázovka native gates

The native probe selects actual source members/groups and mapped layer identities,
then samples the loaded level lattice. It does not choose a level by nearest height
or manually assign a car's level/height. A real loaded `Car` receives the appropriate
source-kind hint, and the native tracker/collision view supplies the result.

| Point | Source identity | Raw loaded sample | Native tracking | Result |
| --- | --- | ---: | --- | --- |
| 60% | Tunnel way `362654528`, mapped layer -2 | Unknown (NaN) | Existing level/API ground fallback at 228.105 m | Baseline limitation retained; not repaired or called a tunnel pass |
| 80% | Tunnel way `362654528`, mapped layer -2 | 199.3999996 m | Level -1 at the same height, free collision cell | Ground 226.8744337 m; genuine depth **27.4744340 m** |
| 95% | Bridge way `4700780`, mapped layer 1 | 204.0605848 m | Level 1 at the same height, free collision cell | Finite adjoining bridge restored |

The simplified drive edge `3669205756>493880663>0` again has both original
`bridge:true` and `tunnel:true` flags. The tunnel source node list includes
`3669205756` through `10565295183`; the adjoining bridge is nodes `29900759`,
`29901177`, `493880663`. Raw source records and the earlier blocker retain full
identities. [Exact final targets](evidence/overnight-final-correction/target-points.json),
[native result](evidence/overnight-final-correction/native-tunnel.json),
[fixture](evidence/overnight-final-correction/native-tunnel.txt).

An initial diagnostic incorrectly asserted that `levelAt` must expose NaN at 60%.
The existing API deliberately falls back to ground. That failed assumption log is
retained; the corrected gate checks the raw loaded sampler and reports the fallback
separately. No missing height was fabricated and no production API was changed.
The view is above the park, so the image alone does not prove the underground depth;
the source/lattice/native-tracker numbers are the depth evidence.

## Fresh focused smoke

Google Chrome used one exclusive game at a time through the scene runner, integration
Vite 5204 and one-off scene commands on 5304. Each selected scenario starts from a
fresh page with the accepted normal-action on-foot preparation: WebGPU, High,
DPR 1, 1280×800, Wednesday 14:00, clear weather, fixed date 15 July. Both map build
and pipeline markers were asserted by the native fixtures.

- Bus displays passed five checks; police stolen lights passed nine; boat boarding
  passed ten. Each scenario ran once; the broad flaky vehicle suite was not repeated.
- Tiles `8_5` and `7_5` contain 103 and 78 sampled parked cars. All **181** pass swept
  lane/turn clearance with zero duplicate centres; two furniture instances coexist.
  Eviction was paused only during numeric inspection. [Parking view](evidence/overnight-final-correction/shots/final-parking-corner.png).
- A naturally placed sedan over water on Legií remained on expected level 1 and moved
  **10.91 m in 1.5 simulation seconds**, with finite height and no new damage. No level
  override was used. The initial midpoint attempt placed the car on public ground
  under the bridge; it is preserved as an ambiguous fixture placement, not a passing
  deck drive. Only that targeted placement was corrected.
  [Result](evidence/overnight-final-correction/native-smoke.json),
  [deck drive](evidence/overnight-final-correction/shots/final-legii-drive.png).
- Required streaming jobs finish with zero failures. One optional sky refresh is
  separately recorded; it is not a failed required tile.

All selected captures were inspected. Native depth evidence is runtime sampling and
tracking, not GPU buffer readback. No full tunnel/bridge traversal, phone, clean timing
comparison or new ambulance-arrival matrix was run. Ambulance CPU crew checks and its
separate prior native replay remain qualified by their own arrival variability.

## Remaining limits and handoff

The direct final sampler comparison at tile `5_6`/`5_7`, x -784..-778, y 248.82,
side 0 still differs by **0.7999997 m**. The source-pull fix is included and rebuilt,
but this remaining dry-side fallback discrepancy is not claimed resolved. No pilot
plain-support file was introduced. The 60% Mrázovka unknown and broad source-height
limitations likewise remain explicit; restoring the supported 80%/95% regression
points does not invent complete regional support.

All one-off browsers have exited; GPU/heavy locks are released. The useful existing
5204 server is preserved. Final integration source ownership returns to the parent
after this report/evidence commit. No map data was pushed, published or deployed.
The preserved before/blocked snapshots remain available for comparison and recovery.
