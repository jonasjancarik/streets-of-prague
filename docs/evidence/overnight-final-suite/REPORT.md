# Final overnight scene suite

read_when: reviewing the final integrated Streets of Prague checkpoint or its remaining scene-suite failures.

**13 of 15 top-level scenarios passed. The suite is not all green.** This was one
finite, normal-order pass, with no top-level reruns, source edits or data edits.
The existing `vehicle-entry-order` case internally runs helicopter and lamp scenes;
those nested runs are part of that scenario, not an additional broad rerun.

## Provenance

- Integration HEAD: `a141097c719f32797e2455d698c1106c6bbc28ae`; application source `ae86cf4`.
  The commits differ only in evidence/documentation.
- Served centrum map: format 2, built `2026-10-03T05:44:19Z`, pipeline `ae86cf4823`.
- Chrome, actual WebGPU backend, 1280×800, DPR 1, High graphics. Initial URL uses
  `place=staromak&go&day=wed&time=14:00&weather=clear&date=10-03&area=centrum`.
- Run: 3 October 2026, 08:26:38–08:27:15 Prague time (06:26:38–06:27:15 UTC).
- 136 source files and all 804 map files were fingerprinted before/after. HEAD,
  source hash and map hash stayed unchanged. The complete hashes are in [results.json](results.json).
- Cases share the live world and the existing normal-action `onFoot` preparation.
  This is not a fresh-page-per-case run or a fresh-world reset.

[Raw results and observation snapshots](results.json), [console summary](run.log),
and [finite collector](run-suite.mjs) are preserved here. The collector delegates
car creation and screenshots to the original test API, adding observation records
without changing assertions or controls. It records final spawned-car positions;
it does not record their initial positions.

## Results

| Scenario | Result |
| --- | --- |
| ambulance | Pass |
| boat-boarding | Pass |
| bridge-exit | Pass |
| bus-displays | Pass |
| fire-brigade | Pass |
| fire-driver | Pass |
| heli-bridge | Pass |
| lamp-knock | **Fail** |
| police-chase | Pass |
| police-stand-down | Pass |
| police-stolen-lights | Pass |
| seasonal-ground | Pass |
| vehicle-entry-order | Pass, including both complete nested assertion sets |
| wall-crash | Pass |
| wreck-tow | **Fail** |

No scenario or observation reported a page/console error.

## Failure classification

### Lamp impact: unresolved order or fixture sensitivity

The first lamp case successfully entered a hatchback and found a post. Its selected
post was not down after the run, and the car finished at 0.2 km/h rather than the
asserted 10–45 km/h range. The observed car had damage 7.712 and was at
`50.08047, 14.42376`, heading 89°, Vodičkova. Its final raw velocity magnitude was
approximately zero.

Later, the existing `vehicle-entry-order` case ran `heli-bridge` then `lamp-knock`
on the same source/map. All helicopter assertions passed; the nested lamp was down
and the car retained 23 km/h, so all original lamp assertions passed there too.
This indicates state/order/fixture sensitivity, not a universal failure to knock
posts down. The single run did not record which obstacle halted the first car.

This is **not** the previously reproduced airborne vehicle-entry error: entry now
succeeds. No matching physical-impact baseline was run in this final task, so a
pre-existing-versus-introduced regression classification remains unconfirmed.
No source fix or diagnostic rerun was performed.

Native scenarios reuse screenshot names. `lamp-knock.png` is the last, passing
nested capture; it must not be presented as an image of the earlier failed impact.
The failed case's exact recorded position and executable snapshot remain in JSON.

### Tow: the out-of-sight premise is not met

The near wreck remained, as expected. The nominal far wreck also remained. At the
end of the case it was stationary, damaged 50, and only 73.5425 m from the on-foot
player. The normal foot view uses zoom 1, FOV 38° and aspect 1.6; its cleanup radius
is approximately `100*tan(19°)*hypot(1,1.6)+15 = 79.9676 m`. Thus that car was
inside the retained view radius and was not eligible for offscreen towing.

The near-labelled car was 57.717 m away despite an `ahead:8` request, and the
far-labelled car had an `ahead:-90` request. The car factory searches for clear
positions rather than guaranteeing the requested distance; later motion is also
possible. Initial positions were not recorded, so the report does not claim which
caused these final distances.

This matches the earlier pinned-baseline camera/placement-dependent tow fixture
limitation. It does not demonstrate an introduced towing-behavior regression.
The scenario's out-of-sight assumption requires a future targeted fixture check;
its assertions were not weakened here.

## Cleanup and limits

The owned scene/browser PID 30584 is stopped, port 5305 is closed, and the owned
GPU lock is released. Integration Vite PID 9723 on port 5204 remains running.
Registrations, source, map data, other processes and the parent's separate handoff
document were left intact. Only this evidence directory was written.

No additional broad run, alternate-renderer run, build or timing benchmark was
performed. These are behavior/assertion results on the final centrum snapshot,
not citywide or phone-performance evidence. Evidence collection was left uncommitted for parent handling.
