# Vehicle display checks and scene failure triage

read_when: reviewing the bus-display and stolen-police-light fixes, or investigating
the five failures from their combined scene run.

## Scope and setup

The candidate is `00222e63c712d6f2dafa50a7702caf3cfc4296d2`, including bus commit
`9a3b20e` and police-light commit `00222e6`. The baseline is an unchanged Git archive
of `b3c22d5adf40f16b689fabdb9ecb45bb3c87b168`. Its production sources and native scene
files were checked against that commit's Git blobs. Each checkout has its own APFS
copies of dependencies and map files; no writable shared symlinks or city rebuilds
were used.

Both use the centrum map built `2026-10-02T20:16:12Z` (pipeline `934283de3e`). All
804 files match byte for byte; [the manifest](evidence/vehicle-displays-2026-10-03/map-manifest.json)
records their SHA-256 hashes and the relevant source blobs. The comparison uses
Chrome, WebGPU, 1280×800, DPR 1, High graphics, initial Wednesday 14:00 and clear
weather, with the date fixed to 10-03. Only one owned game browser runs at a time.

## Original combined run

The candidate's full scene set passed 7 of 12 cases. These five failed:

| Case | Exact failure observed |
| --- | --- |
| `ambulance` | The first patient remained hurt after 150 simulated seconds; phase `work`, treated `0`, two medics, car 11 m away, path 5 m, stuck 134.6 s. Both departure checks also failed. The severely hurt patient was carried after 94 s, with treated `9`, but the rig did not depart. |
| `lamp-knock` | `Could not get into the car` before the impact checks. |
| `police-stolen-lights` | A police car arrived, then `Could not get into the car` before the light checks. |
| `wall-crash` | `Could not get into the car` before the wall checks. |
| `wreck-tow` | The far wreck was still standing after 90 simulated seconds; the nearby wreck correctly remained. |

The preceding `heli-bridge` case finishes in a helicopter. `teleportTo` preserves
that mode and raises its altitude on the next teleport. Normal entry refuses to
leave an airborne helicopter. This is a source-derived explanation to verify on
both revisions, not a baseline result by itself.

## Focused renderer checks

The new bus and police-light scenarios passed independently on WebGPU and WebGL.
The bus resource check repeated 200 renders per backend without generating another
canvas or replacing a board/texture, and checked empty/missing identifiers, burnt
wrecks, despawn and return. The police beacon check measured actual instance colors
changing while stopped, two lamps after re-entry, and zero stale instances after
exit or burnout on both backends. Typechecking passed. No frame-rate benefit is
claimed, and no production build or timing benchmark was run for these fixes.

Durable screenshots from those focused checks:

- [WebGPU front board](evidence/vehicle-displays-2026-10-03/bus-route-front.png) and
  [minibus roof](evidence/vehicle-displays-2026-10-03/minibus-route-overhead.png).
- [WebGPU stopped stolen police car](evidence/vehicle-displays-2026-10-03/police-stolen-stopped.png).
- [WebGL front board](evidence/vehicle-displays-2026-10-03/webgl/bus-route-front.png),
  [minibus roof](evidence/vehicle-displays-2026-10-03/webgl/minibus-route-overhead.png),
  and [stopped stolen police car](evidence/vehicle-displays-2026-10-03/webgl/police-stolen-stopped.png).

The bus views use height 22 m / tilt 40° / heading 270° overhead and height 7 m /
tilt 60° / heading 270° from the front. The police view uses height 18 m / tilt 20° /
heading 0° at 22:00. The repeat comparison records exact positions and camera
snapshots in its JSON results.

## Baseline comparison

The comparison ran between 04:01 and 04:07 Prague time on 3 October 2026. The replay
harness, `scripts/triage-vehicle-scenes.mjs`, reloads before each selected case and
pauses the live simulation before running it. For the new police case, baseline-only
browser instrumentation supplies the new test helper methods without editing any
baseline source. Native `t.drive` remains the original baseline implementation.

| Case / fixture | Pinned `b3c22d5` | Candidate `00222e6` | Classification |
| --- | --- | --- | --- |
| `ambulance`, fresh | All checks pass. | First rig fails to depart; the other checks pass. | Session-dependent ambulance behavior; see warmed fixture below. |
| `lamp-knock`, fresh | Pass | Pass | No introduced failure in normal entry/impact. |
| `police-stolen-lights`, fresh | Entry succeeds; stopped, re-entry and stand-down light assertions fail. | All checks pass. | Intended repair of the baseline speed-gated lights. |
| `wall-crash`, fresh | Pass | Pass | No introduced failure in normal entry/collision. |
| `wreck-tow`, fresh | Pass | Pass | The basic cleanup behavior is unchanged. |
| Each of `lamp-knock`, `police-stolen-lights`, `wall-crash`, airborne helicopter | `Could not get into the car` | `Could not get into the car` | Existing fixture/mode leak, reproduced on both revisions. |
| `wreck-tow`, airborne helicopter | Far wreck remains; near wreck remains. | Same result. | Existing camera-dependent fixture assumption. |
| `ambulance`, warmed session | Original treatment stall reproduced: hurt after 150 s, treated `0`, two medics, car 11 m away, path 5 m; departure checks fail. The severely hurt patient also remains untreated. | First departure and final theft/crew assertion fail; treatment succeeds. | Existing ambulance navigation/session variability, not an introduced bus/police failure. |

The warmed fixture creates and immediately removes 20 test hatchbacks while paused.
It advances the existing game's seeded RNG through the normal car factory without
leaving those cars as obstacles. Both revisions receive exactly that fixture. The
different ambulance subchecks across runs are recorded rather than treated as
deterministic timing or identical actor-state evidence. Crucially, the unchanged
baseline reproduces the original treatment-stall signature and failed departures.

The helicopter fixture enters a real helicopter and sets it 10 m above its floor.
The scenarios' own `t.go()` subsequently preserve that mode and raise its altitude;
normal exit remains unavailable. This explains the three identical entry errors.
In the tow replay, the candidate's far wreck is 90 m away but its derived cleanup
view radius is approximately 132.3 m. It is therefore ineligible for offscreen
towing. [The measured camera and wreck positions](evidence/vehicle-displays-2026-10-03/tow-camera.json)
record this without changing the cleanup rule.

No introduced regression was identified. The original combined suite is still
7/12; this triage does not make it green or fix ambulance AI, helicopter fixture
cleanup, or the tow test's camera assumptions. No further gameplay changes were made.

## Raw evidence and replay

- [Baseline selected cases](evidence/vehicle-displays-2026-10-03/baseline-results.json)
  and [candidate selected cases](evidence/vehicle-displays-2026-10-03/candidate-results.json).
- [Baseline warmed ambulance](evidence/vehicle-displays-2026-10-03/baseline-ambulance-warm.json)
  and [candidate warmed ambulance](evidence/vehicle-displays-2026-10-03/candidate-ambulance-warm.json).
- [Baseline airborne tow](evidence/vehicle-displays-2026-10-03/baseline-tow-airborne.json)
  and [candidate airborne tow](evidence/vehicle-displays-2026-10-03/candidate-tow-airborne.json).
- [Baseline stopped police car](evidence/vehicle-displays-2026-10-03/baseline/police-stolen-stopped.png)
  and [candidate stopped police car](evidence/vehicle-displays-2026-10-03/candidate/police-stolen-stopped.png).
  Their exact positions, camera parameters and executable situation snapshots
  are recorded in the corresponding selected-case JSON entries. Native ambulance
  scenarios reuse screenshot names; those PNGs retain the last capture at that name,
  while the JSON retains each capture's snapshot.

After acquiring the exclusive game slot, start a scene server against the desired
checkout with `--date 10-03 --extra '&area=centrum' --port 5305`. The unchanged
baseline archive was served on 5208; the candidate was served on 5205. Run:

```sh
node scripts/triage-vehicle-scenes.mjs --port 5305 --revision <revision> --out <selected-results.json>
node scripts/triage-vehicle-scenes.mjs --port 5305 --revision <revision> --cases ambulance --fixture warm-session-20 --out <ambulance-results.json>
node scripts/triage-vehicle-scenes.mjs --port 5305 --revision <revision> --cases wreck-tow --fixture airborne-helicopter --out <tow-results.json>
```

The harness does not launch a browser and rejects a different map build or renderer.
The comparison browser and temporary baseline server are stopped; the owned GPU
lock is released. The candidate dev server remains on 5205 for review.
