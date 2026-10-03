---
read_when: Reviewing integration 76118bc, the private harmonic centrum generation, or the remaining Mrázovka tunnel/level blocker.
---

# Combined harmonic city validation

Integration `76118bc1267bcf3cb80e854b7f3924b195f80214` passed the app build, focused
CPU checks and **89 Python tests**. A privately rebuilt centrum map passed strict
assembly and runtime JSON/binary validation. The selected bridge profiles/joins,
parking clearance audit and short Legií drive passed to the extent below.
**Mrázovka's 27.47 m tunnel displacement is a blocker. The new generation is not
accepted as safe overall; passing selected checks do not remove this blocker.** No production code was changed in this pass.

## Code and frozen private inputs

The tested checkout is `overnight-city-integration/streets-of-prague`. The accepted
source filter, surfaces/cutter, furniture, vehicles/boats, seasons, bridge contacts,
harmonic solver/guard and parking/fetch guards were already in the pinned HEAD.
Later birds, season-picker, index and source-seam commits are outside this result.
The unaccepted plain-support payload was not used.

[Before provenance](evidence/overnight-harmonic-combined/provenance-before.json) records
source and input hashes. Before mutation, the active 234-tile map was APFS-cloned to
`public/data/centrum_before_harmonic_now`, and its cached layer records to
`pipeline/.cache/harmonic-before/layers`. The old map is built
`2026-10-03T00:26:37Z`, pipeline `5182c47670`, index SHA-256
`c2ec699a13d019ae552860f53a467ad50863843a751bd8557f55e1407f01f0a3`.

The [offline wrapper](evidence/overnight-harmonic-combined/offline-build.py) reuses the
existing network-blocking fixture: 57 DTM surface and 57 line packages, existing OSM
cut/tree/parking inputs, nine cached IPR building/terrain sheets, colour table and
bridge sources. Acquisition is frozen; geometry executes under current code. All
six chunks, IPR and terrain were refreshed for the changed whole-pipeline processing
key, then `layers.assemble('centrum', strict=True)` passed. No citywide rebuild or
source download occurred. Logs are completion evidence, not timing comparisons.

The [new map](evidence/overnight-harmonic-combined/provenance-current.json) has 234
tiles, format 2, built `2026-10-03T03:46:50Z`, pipeline `76118bc126`, index SHA-256
`4c51359f27fc3b6892d7e73e955dc56022664df67c1a48ded7448347310357b9`.
All 234 JSON/height files, 89 levels files and 228 IPR files passed the integrated
runtime validators. The survey still reports 1,069 rejected raw vertices.

## Combined CPU checks

- One `npm run build`, including TypeScript, passed; the existing bundle-size warning remains.
- Parking/fetch suites passed, including required graph fields and 21 corrupt-success/recovery cases.
- Twelve terrain-cutter and eleven complete-ground/perimeter checks passed.
- Ground order/palette, furniture placement/survey, boat access and ground-season checks passed.
- The existing bus/police/testkit CPU fixture passed, including 400 stable bus renders,
  retained label resources, beacon lifecycle and ownership/chase separation.
- Full Python unittest discovery passed once: **89 tests, zero failures**. No fixture
  initialization correction was needed and no production/test source was changed.

[Build and test logs](evidence/overnight-harmonic-combined/) are retained. This is the
combined suite at this HEAD; it does not include later queued changes.

## Regenerated data and selected bridges

[Data comparison](evidence/overnight-harmonic-combined/data-comparison.json) shows
unchanged walking routes, paid sections/lots, passages, crossings, areas/roads,
buildings, trees, walls/fences, labels and IPR binaries. Height values change at 391
samples across ten tiles, by at most 1.0 m; 45 level payload/outline tiles change.
The union of finite padded bridge grid coverage loses no samples. These are data
checks, not full geometric or source-height recovery guarantees.

Two drive tiles change only the `tunnel` flag of the same Mrázovka edge; see below.
No route coordinates, widths or topology change.

The offline capture records current source identities/groups on clean surveyed
ground before bridge pads/pulls. Runtime sampling uses each identified way and its
assigned level, with no nearest-height level selection. All **418 before/current
runtime samples** on the three selected ways are finite. Four genuinely observed
endpoint-ground joins, sampled 0.5 m inside/outside, remain unchanged at
0.020, 0.212, 0.090 and 0.046 m.

| Source way | Runtime samples | Largest before/current height change | Largest change per 2 m |
| --- | ---: | ---: | ---: |
| most Legií `106518154` | 172 | 0 m | 0.244 m |
| Karlův most `4053134` | 158 | 0.249 m | 0.370 m |
| Čechův most `127867974` | 88 | 0.000285 m | 0.089 m |

The source-solver profiles change by 0, 0.261 and 0.0021 m respectively. Runtime
levels stay 1/3/2. [Source comparison](evidence/overnight-harmonic-combined/source-profile-comparison.json),
[runtime summary](evidence/overnight-harmonic-combined/runtime-summary.json) and
[complete samples](evidence/overnight-harmonic-combined/shots/harmonic-runtime-profiles.json)
retain the distinction between continuous source and encoded runtime measurements.

Twenty-seven previously sampled furniture positions remain present with zero
sampled height delta. The selected parking audit encountered 87 parked entries,
with zero swept-clearance intrusions or duplicate centres and one furniture
instance. This count is a limited loaded-scene sample, not an exhaustive corner,
tile-order or citywide census. The [corner view](evidence/overnight-harmonic-combined/shots/combined-parking-corner.png)
shows the rejected old corner position clear under integrated geometry/furniture.

The natural player-car check on Legií used no manual level override: a sedan moved
21.01 m in two simulation seconds on expected level 1, with finite height and no
new damage. Required streaming jobs finished with zero failures; an optional sky
refresh remained separately recorded. [Smoke result](evidence/overnight-harmonic-combined/scene-smoke.json).

## Mrázovka blocker: tunnel disappears below supported ground

The existing shallow-tunnel rule removes `tunnel:true` from edge
`3669205756>493880663>0` in tiles `2_0` and `2_1`; its pre-existing `bridge:true`
remains. The edge endpoints are nodes `3669205756` and `493880663`; matching raw
tunnel way IDs, full node lists and points are preserved in
[source records](evidence/overnight-harmonic-combined/mrazovka-source-records.json).
[Exact drive differences](evidence/overnight-harmonic-combined/drive-differences.json).
A single targeted three-point probe used stable loaded tiles, current level/collision
masks and actual stored surface triangles, plus the saved before-map samplers.

| Fraction along edge | Before declared level | Current bridge-hint tracking | Current collision | Closest stored surface height gap |
| --- | --- | --- | ---: | ---: |
| 60% | Tunnel -1, unknown sample | Ground 228.105 m | Free (0) | 0.026 m |
| 80% | Tunnel -1, 199.400 m | Ground 226.874 m | Free (0) | 0.236 m |
| 95% | Bridge levels 1/2, 204.061/205.760 m | Level 1 with NaN sample, ground fallback 197.769 m; level 2 is finite at 197.787 m | Free (0) | 0.005 m |

Thus these sampled positions have physical stored surface support; the probe did
not find a new air gap. It **does not validate the tunnel route**: a formerly finite
underground level disappears at 80%, while the tracked height rises 27.47 m to ground.
At 95%, selected level 1 lacks a finite sample and falls back despite another finite
level. None of the three points is inside the ordinary road polygon tested by the
fixture. The result blocks acceptance of this generation and needs a separately reviewed
harmonic/source fix. It is not a successful Mrázovka traversal or source-height repair.

[Authoritative corrected result](evidence/overnight-harmonic-combined/mrazovka-final.json),
[fixture](evidence/overnight-harmonic-combined/mrazovka-check.txt), and
[corrected view](evidence/overnight-harmonic-combined/shots/corrected/combined-mrazovka-support.png)
are retained. The initial probe is explicitly non-authoritative: streaming retired
tiles during old-map fetches. A wrapper syntax error also produced no capture; both
initial logs are preserved. The corrected wrapper was syntax-checked before its
one-off run, and temporarily suspended eviction only during numeric sampling.
This is CPU inspection of stored Float32 geometry, not GPU readback.

## Scene provenance and handoff

The first batch used the pre-existing integration Vite server on 5204 and an owned
scene controller on 5304: Chrome, verified WebGPU, High, DPR 1, 1280×800, Wednesday
14:00, clear weather, date 15 July. Exact cameras are in the
[bridge fixture](evidence/overnight-harmonic-combined/scene-profile.txt) and
[smoke fixture](evidence/overnight-harmonic-combined/scene-smoke.txt). Selected bridge
views use height 125/tilt 35/heading 0; heads use height 70/tilt 45/toward the deck;
parking uses height 48/tilt 0/heading 0. Images were inspected; loaded bridges,
ordinary geometry and the corner are drawn. No full bridge traversal was attempted.

The browser closed before its lock was released. The corrected Mrázovka probe used
an automatically closed one-off browser; its geometric sampling does not depend on
a separately asserted renderer backend. No GPU/heavy lock is retained. All subsequent
analysis and this report are CPU/file work. The known Kampa sampler discrepancy
remains reproduced from its prior minimal case; no plain-support or later accepted
source-seam fix is included here. No phone, full scenario suite, clean performance
comparison, main merge, push or deployment was performed.

The useful, pre-existing integration server remains on
[localhost:5204](http://localhost:5204/?area=centrum),
[MacBook-Air-2.local:5204](http://MacBook-Air-2.local:5204/?area=centrum), and the configured
[Tailscale URL](http://macbook-air-2.adal-macaroni.ts.net:5204/?area=centrum).
This handoff releases integration source ownership back to the parent. Later TS/UI
changes need no Python rebuild; the separately accepted source seam needs its own
scoped terrain refresh and validation. This report adds no implementation change.
