---
read_when: Reviewing the 2–3 October overnight changes, choosing what to merge, or opening their local preview and verification evidence.
---

# Overnight work, 3 October 2026

The accepted changes were merged into main on 3 October 2026, preserving main's
newer map-release, beta-deployment and radio-TODO commits. This merge did not push,
deploy, rebuild map data or copy the private preview map into main. The isolated
integration worktree remains available at
`/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague`.
The merged tree passed the app build, all 107 Python tests, 23 geometry tests and
focused parking, download, fixture, seasons, taxi, boat and ambulance checks.
The prior 15/15 scene confirmation was not repeated for this source merge. The overnight
application source is `ae86cf4`, validated in `a141097`. Reviewed lamp/tow test-fixture
corrections are integrated through `edbf011`; the unchanged map then passed a
[15/15 scene confirmation](evidence/wrapup-final-confirmation/REPORT.md).

The preview uses a private, strictly assembled 234-tile centrum map built at
`2026-10-03T05:44:19Z`. It is not a full-city rebuild. Source caches and map data
used for experiments were private copies; the main checkout's data was not replaced.
All seven implementation threads worked in separate worktrees, with independent
reviews and one game browser at a time.

## What changed

| Area | Result | Evidence |
| --- | --- | --- |
| River banks and terrain | Ground triangles follow surveyed step outlines, including holes and narrow terraces. Shared mesh edges use a consistent height profile, with Float32 edge handling. Gross original survey-height errors are rejected before interpolation. | [Terrain findings](river-terrain-findings.md) |
| Bridges | Chunk-local loose ends no longer become false ground anchors; explicitly separate decks stay separate. Bridge-only height propagation is continuous across branches. Shared bridge-to-ground pulls agree at tile edges. | [Contacts](bridge-contact-results.md), [continuity](bridge-height-continuity.md), [source seam](bridge-ground-edge-diagnosis.md) |
| Tunnels | A regression found during integration was corrected: tunnel-containing or partially known components retain their previous propagation. Intentional shallow-tunnel removal remains unchanged at 2.5 m. | [Correction](tunnel-propagation-compatibility.md), [final validation](overnight-final-corrective-validation.md) |
| Roads and pavements | Duplicate mapped walking ribbons are removed where the ground already has that material. Real park paths and contrasting surfaces remain; named squares no longer paint over known lawns. | [Plan 018 results](../plans/018-simplify-paths-and-pavements.md) |
| City objects | Deterministic benches, bins and courtyard planters use conservative land-use and clearance checks, shared models and tile-worker placement. | [Furniture](furniture.md), [combined validation](overnight-combined-validation.md) |
| Parking | Neighboring lanes and vehicle sweeps through junctions are reserved before parking is generated. Tile reload order and paid-parking targets are preserved. | [Traffic](traffic.md), [real corner comparison](evidence/parking-clearance-2026-10-03/README.md) |
| Vehicles and boats | Bus route boards are more readable; a driven police car's lights work while stopped or reversing. Pedal boats have night lamps, and moorings/boarding require reachable low banks with player-footprint clearance. | [Vehicle evidence](vehicle-scene-triage-2026-10-03.md), [boats](boats.md), [combined smoke](vehicle-boat-smoke-2026-10-03.md) |
| Seasons | Grass, woodland floors, fields and hedges follow the date in both renderers. Birds vary by season. The start screen offers four seasons, date-correct live weather and bilingual, keyboard-accessible controls. | [Ground comparisons](evidence/seasons-step3/README.md), [birds](evidence/seasonal-birds.md), [season plan](../plans/023-seasons.md) |
| Taxi and ambulance | Taxi touch controls say when they close the menu or cancel a booking; cancellation clears stale state. Stalled ambulance crews can take a local detour around parked cars, without extending treatment range. | [Taxi](taxi-controls.md), [ambulance](ambulance.md) |
| Reliability and tests | Required downloads and binary layouts are validated, failed neighbor graph data cannot masquerade as an empty road graph, cache mocks verify their real subprocess contract, and scenarios prepare their vehicle state through normal actions. | [Binary formats](binary-download-validation-design.md), [scenario contract](vehicle-scene-triage-2026-10-03.md) |

## Verification

The final corrective pass passed the app build, all 107 Python tests and the relevant
focused JavaScript checks. Strict assembly and runtime payload validation passed
for all 234 centrum height/JSON files, 89 level files and 228 IPR files. The map
index hash is `c1dd723ed3e7d9d370532bf461c6b9531c49c8ed95fe0204c46430476525472c`.

Native source-identified checks restored Mrázovka's supported tunnel point to
199.4 m, 27.47 m below ground, and its adjoining bridge point to 204.060585 m.
The separate bridge-only Radotín control stayed bit-identical after the tunnel
correction. A Legií sedan drive stayed on the correct deck and moved 10.91 m
without new damage. All 181 sampled parked cars passed clearance checks with no
duplicate centres. Fresh boat, bus and police-light scenarios passed.

Independent wider terrain sampling covered 48 stored Prague tiles beyond Újezd
without non-finite geometry or sampled step crossings. Seasonal visual evidence
includes 48 matched images and both renderer paths. Individual reports distinguish
CPU probes, native checks, screenshots, and measured limits. No frame-rate gain is
claimed: the added geometry has a cost, and several timing comparisons were
inconclusive on a shared host.

The first final broad scene suite passed 13/15. Targeted wrap-up reproduced a
tram-body interception omitted by the lamp fixture's clearance check and confirmed
that the tow fixture had placed its supposedly distant wreck inside the cleanup
view. Independently reviewed fixture corrections preserve production collision and
towing rules and the original assertions. The exact tram/post identity from the
first immutable run was not recorded; that historical limitation remains in its report.

After integrating both corrections, typecheck and the lamp/tow/scenario-start CPU
checks passed. One normal-order combined confirmation then passed **15 of 15
scenarios**, with no reported page/console errors and unchanged hashes for all 136
source and 804 map files. This is a successful run on the frozen snapshot, not a
claim about every possible ordering or device. The map was not rebuilt during wrap-up.
[Historical 13/15 report](evidence/overnight-final-suite/REPORT.md),
[tow correction](tow-fixture-wrapup-2026-10-03.md),
[lamp diagnosis and correction](evidence/lamp-wrap/REPORT.md), and
[final 15/15 confirmation](evidence/wrapup-final-confirmation/REPORT.md) retain the
complete evidence without overwriting earlier failures.

## What remains unresolved

- A roughly 0.8 m Kampa dry-side sampler disagreement remains between two tiles.
  The mesh tessellation discrepancy is fixed; the remaining problem is which dry
  support samples each tile chooses when its lattice corners are water-labelled.
- The plain-ground support experiment `fcf611d` remains separate and unadvertised.
  It demonstrated consistent sampling but exposed source conflicts and candidate
  height changes up to 8.15 m. It is not included in the preview's loader or map.
- The recorded Mrázovka 60% point still has unknown raw tunnel support; existing
  APIs fall back to ground there. Restoring the 80% and 95% regression points is
  not a claim that the entire tunnel is correct.
- Radotín's abrupt height jump is reduced in the regional fixture, but source-face
  rejection and a middle-span height offset remain. Other bridge approaches and
  full-city traversal are not established by the centrum validation.
- Full-city regeneration, physical-phone testing and deployment were not performed.
  Taxi Czech browser visibility remains unverified despite passing CPU translation
  checks. Existing ambulance arrival variability and stretcher collision limitations
  are separate from the repaired crew stall.

## Review and next steps

Open the running integration preview:

- [This machine](http://localhost:5204/?area=centrum)
- [Local network](http://MacBook-Air-2.local:5204/?area=centrum)
- [Configured Tailscale address](http://macbook-air-2.adal-macaroni.ts.net:5204/?area=centrum)

The Tailscale service was stopped during validation, so that route is unavailable
until it reconnects. The integration server is deliberately retained; temporary
scene browsers and unused worker servers were closed. Worktrees and evidence remain
available for inspection. Main's unrelated edits were preserved.

The source merge is complete. A full map rebuild, shared-data activation and
deployment remain separate actions. The chronological
[coordination log](overnight-coordination.md) records accepted source commits,
review corrections and the withheld experiment. The
[final corrective report](overnight-final-corrective-validation.md) is authoritative
for the final map generation and tunnel regression gates.
