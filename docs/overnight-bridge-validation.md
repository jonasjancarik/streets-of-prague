---
read_when: Reviewing the accepted bridge-contact integration or extending the strict centrum generation with the TS terrain cutter.
---

# Integrated bridge checks

The accepted bridge-contact/layer fix was checked with the survey-source filter,
surface and furniture changes in integration commit `5182c47` on 3 October 2026.
Only this report, evidence and validation fixtures were added. No implementation,
main, push or deployment change was made. The TS terrain cutter remains outside
this checkpoint and can use the same generated map in the next check.

## Current records and strict map

The existing private raw sources and offline fixture from the prior combined pass
were retained. Streets now contain **498 current-format structure records for
418 unique ways**, all with observed `on_ground` and explicit/unknown `mapped_layer`
fields. No legacy records were relied on for the new terrain generation.

The strict gate's whole-pipeline processing key changed, so all six centrum chunk
layers and the IPR stage were refreshed before terrain and strict assembly. OSM
cuts/parsing and raw IPR sources reused their validated caches; no source download
or citywide map build ran. The contact/survey suite passed **22 tests**.

The current strict map has 234 tiles, format 2, built
`2026-10-03T00:26:37Z`, pipeline `5182c47670`, index SHA-256
`c2ec699a13d019ae552860f53a467ad50863843a751bd8557f55e1407f01f0a3`.
The private baseline is `centrum_before_bridge_now`, built
`2026-10-02T22:45:45Z`, pipeline `7ad54d61ab`; its saved streets records preserve
the original legacy hints for diagnostic comparison.

Across every tile, drive/walk routes, paid-parking sections, lots, passages,
crossings, surfaces, buildings, trees, walls and fences are unchanged. Every IPR
binary is unchanged. [Data comparison](evidence/overnight-bridges/data-comparison.json).
Bridge-related terrain adjustments change **357 height samples in six tiles**,
with a maximum absolute change of **1.8 m** in tile `13_9`; labels are unchanged.
Twenty-eight level payload/outline files change. The union of finite padded bridge
height grids loses no coverage. That grid check is not a full geometry/height audit.

The survey stage is identical to the prior generation, including 1,069 rejected
raw vertices. On the same clean surveyed ground before bridge pads/pulls, contact
anchors change from 552 to 548 and accepted IPR points from 2,225 to 2,284. Ground
samples pulled toward bridge ends change from 3,835 to 3,482. The before/current
capture emitted existing all-NaN/empty-mean warnings; the selected profiles are
finite and the stored bridge coverage comparison found no new loss.

## Source identity and profile method

The [capture fixture](evidence/overnight-bridges/offline-profile-build.py) wraps the
real terrain build after survey filtering and before bridge pads/pulls. It also runs
the pinned `187f410` structures implementation against the saved legacy records on
the same clean ground, solely for diagnostic output. It does not use already-pulled
final terrain as solver input or alter the production result.

Source ways were selected by catalogue location/corridor and recorded by OSM way,
nodes, kind, mapped layer, geometry and actual piece/group membership. The emitted
member-level mapping is then used in the game; no nearest-height level guessing is
used. [Source profiles and groups](evidence/overnight-bridges/source-profiles.json).
The pinned baseline helper can be restored with
`git show 187f410:pipeline/structures.py > /tmp/bridge-before-structures.py` before
replaying the offline capture fixture.

| Bridge corridor | Source way | Length | Runtime level, before → current | Runtime samples | Largest change per 2 m |
|---|---:|---:|---|---:|---:|
| most Legií | 106518154 | 344.65 m | 1 → 1 | 172 | 0.244 m |
| Karlův most | 4053134 | 316.55 m | 2 → 3 | 158 | 0.370 m |
| Čechův most | 127867974 | 175.48 m | 2 → 2 | 88 | 0.089 m |

All **418 runtime samples** are finite in both generations and have zero observed
before/current height delta. The selected source-solver profiles also retain their
heights. Charles Bridge's changed level number is not a height jump; member identity
keeps the sampler on the intended way. These are three selected ways, not full
catalogue spans or proof that every connected bridge part is repaired.

The join check samples 0.5 m inside the identified deck and 0.5 m beyond its endpoint
on final ground, only at genuinely observed ground contacts. Neither a loose end
nor an internal continuation is presented as a ground join.

| Source way / ground node | Before step | Current step |
|---|---:|---:|
| 106518154 / 1225419809 | 0.020 m | 0.020 m |
| 106518154 / 299059749 | 0.212 m | 0.212 m |
| 4053134 / 1083674658 | 0.090 m | 0.090 m |
| 127867974 / 4692949902 | 0.046 m | 0.046 m |

All four sampled joins remain below 0.5 m. This precise source-identified join/profile
check was used instead of a vehicle traversal, avoiding traffic as a confounder.
[Complete runtime samples](evidence/overnight-bridges/runtime-profiles.json).

## Scene evidence

The short exclusive Chrome batch used the existing 5204 server and scene port 5304.
It verified the current map marker and WebGPU backend, with High graphics, DPR 1,
1280×800, clear Wednesday 14:00, fixed summer date 15 July, paused simulation and
hidden HUD. Cameras were loaded before teleporting and loaded again afterwards.
The deck targets are source-line midpoints (height 125, tilt 35, heading 0); head
targets are source endpoints (height 70, tilt 45, heading toward the deck). Exact
coordinates and heading construction are retained in the source data and
[scene fixture](evidence/overnight-bridges/scene-profile.txt).

- Most Legií: [deck](evidence/overnight-bridges/most-Legi--deck.png),
  [first head](evidence/overnight-bridges/most-Legi--head-0.png),
  [last head](evidence/overnight-bridges/most-Legi--head--1.png).
- Karlův most: [deck](evidence/overnight-bridges/Karl-v-most-deck.png),
  [ground-contact head](evidence/overnight-bridges/Karl-v-most-head--1.png).
- Čechův most: [deck](evidence/overnight-bridges/-ech-v-most-deck.png),
  [ground-contact head](evidence/overnight-bridges/-ech-v-most-head-0.png).

These inspected images show populated decks/heads and loaded adjacent ground.
They retain existing wall/slab shapes and other model limitations; this checkpoint
does not claim visual recovery of every bridge or natural slope. The first CLI
response was truncated at 64 KiB; numeric capture was recovered through the
existing scene file callback without adding cases or recapturing images.
The fixture defaults to numeric capture; set `window.__bridgeCaptureImages=true`
for an intentional future screenshot replay.

Twenty-seven previously sampled furniture positions encountered in these loaded
tiles remain present with identical sampled support heights. The broad furniture
clearance/physics suite was not repeated. This is a local data-change check, not
an invariance claim for every possible scatter point or unsampled region.

## Limits and handoff

No new implementation defect was identified by this scoped pass. The sampled
centrum joins/profiles are stable, while other bridge-related cells and level
assignments change as recorded above. Radotín is outside centrum and its unresolved
height-association issue is not claimed fixed. No full-city rebuild, clean GPU/frame
benchmark, phone/WebGL bridge pass or full traversal suite was attempted.

The scene browser is closed and its shared lock released. The useful integration
server remains running on 5204; the parent can resume writing after this docs/evidence
handoff and add the accepted TS cutter without another Python map rebuild. The same
[localhost](http://localhost:5204/?area=centrum),
[LAN](http://MacBook-Air-2.local:5204/?area=centrum), and configured
[Tailscale](http://macbook-air-2.adal-macaroni.ts.net:5204/?area=centrum) URLs apply;
Tailscale was stopped during setup.
