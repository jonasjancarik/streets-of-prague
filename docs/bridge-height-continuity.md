---
read_when: Changing Net.spread, checking bridge/tunnel graph heights, or reviewing Radotín source-face association.
---

# Continuous bridge graph heights

This checkpoint replaces `Net.spread`'s two-nearest-anchor interpolation with a
distance-weighted harmonic graph solve. It is based on accepted contact commit
`f0bb722`, cherry-picked locally as `6211278`. Contact/grade rules, IPR face
windows, crossing handling and the 25 smoothing passes are unchanged.

The [diagnosis](radotin-height-diagnosis.md) reproduced a 22 m switch between
same-side graph anchors before deck association. The new sparse Laplacian uses
conductance `1 / edge length`, giving a linear profile on a chain and a continuous
height at a junction. Fixed heights stay exact during propagation; subsequent
existing smoothing retains its prior semantics. The topology/Laplacian is reused
between passes. Shortest nearest-anchor distances are computed separately by
Dijkstra, preserving the distance input to tunnel cover.

An unanchored component remains NaN with infinite nearest distance; an empty graph
returns empty arrays. One finite anchor gives a constant profile. Multiple equal
anchors give that exact constant without factorisation. With a non-finite anchor,
free heights in that component remain unknown while known pins remain exact; this
conservative behavior does not invent missing ground data. Other disconnected
components solve independently. No steep-height cap or location rule was added.

The sparse result is validated before assigning free heights. Non-finite values
or an invalid result shape raise a precise error. A finite value outside its own
component's fixed-anchor range by more than `1e-6 + 1e-9 × max(abs(anchor limits))`
metres also raises, without clamping or fallback. This allows numerical roundoff
while rejecting gross maximum-principle violations under extreme conditioning.
Parallel/repeated graph links each contribute their distance-weighted conductance;
physical links are not deduplicated by this repair. The remaining fallback/source
offsets reported below are unchanged.
Four additional guard checks inject NaN and out-of-range results, distinguish
component-local bounds, and accept tiny roundoff and valid steep anchors. All
25 focused structure checks pass. [Guard log](evidence/bridge-height-continuity/solver-guard-tests.log).

## Focused validation

Nine new propagation checks and the twelve accepted contact/layer checks pass:
same-side switching, branch balance, unequal chain lengths, multiple fixed samples,
nearest distances, zero/one anchors, empty/disconnected components, unknown input,
path reversal/way order, long chains, genuine steep anchors, separate deck layers,
and 200 independent components. [Focused log](evidence/bridge-height-continuity/structure-tests-new.log).
Three propagation checks fail against the pinned old implementation.
[Baseline log](evidence/bridge-height-continuity/height-tests-baseline.log).
The broader 65-test run passed 63 and retained the two already reproduced
`test_build_cache` subprocess-mock errors. The additional independent-component
check was added afterwards and passes in the focused run.
[Broader log](evidence/bridge-height-continuity/full-tests-harmonic.log).

```sh
cd pipeline
uv run python -m unittest test_structure_heights test_structure_contacts -v
```

## Clean regional comparison

Both readers use the frozen surveyed ground before pads/bridge pulls and the same
IPR source cache. Profiles are sampled along named way identities every two metres;
there is no nearest-runtime-level selection or final-terrain feedback.
[Provenance](evidence/bridge-height-continuity/provenance.json).

| Way | Before maximum 2 m change | After | Maximum profile change |
| --- | ---: | ---: | ---: |
| Radotín motorway 172187367 | 1.14454 m | **0.08355 m** | 11.815 m |
| Motorway 906486675 | 0.09834 m | 0.09834 m | below 10⁻¹² m |
| Motorway 171993317 | 0.44471 m | 0.06917 m | 4.138 m |
| Libeň south 376889215 | 0.00441 m | 0.00441 m | below 10⁻¹¹ m |
| Footway 32955360 | 0.10954 m | 0.10954 m | below 10⁻¹² m |
| Suspended cycleway 495700335 | 0.16897 m | 0.17749 m | 4.077 m |

The last fallback is not unchanged: it has no IPR face on its actual centre line,
and its graph-based profile changes. It remains its own mapped layer and has not
borrowed a nearby motorway face. Cycleway 60857689 changes by at most 0.281 m,
and footway 31729915 by at most 0.192 m. These shifts remain review limits rather
than claims of source-height recovery. [Complete controls](evidence/bridge-height-continuity/comparison.json).

Radotín's deck lookups accept 129 instead of 84 samples; all accepted ones choose
the highest face in their existing window, eliminating the three lower-face
selections. At the beginning, the initial estimate is now 206.499 m and the
206.350 m top face is accepted. The middle still has 142 window rejects and the
final interpolated height can be **3.277 m above the available top** near s =
643.825 m. The rule fixes continuity, not complete deck association.
[Stage/residual summary](evidence/bridge-height-continuity/candidate-summary.json).

A scoped in-memory build compared 26 ways, 37 pieces and 21 selected height tiles.
Ground contacts remain 18; accepted IPR samples rise from 595 to 674. Assigned
runtime levels change from 32 to 31 across those tiles, as corrected heights can
share a level; the explicit mapped-layer separation rule and its regressions are
unchanged. This is not a strict assembled production map.
[Regional result](evidence/bridge-height-continuity/regional-result.json).

## Solver cost and limits

On the 1,016-vertex/1,010-edge regional graph, initial/repeated spread calls measured
about 1.35/0.76 ms using common anchor dictionaries, versus 1.14/1.57 ms for the
old routine. These are single local CPU observations, not a general speed claim.
[Regional cost](evidence/bridge-height-continuity/real-solver-cost.json).
Synthetic chains of 1,001/4,001/16,001/64,001 vertices measured roughly
1.2/3.6/13.8/52.8 ms initially and 0.4/1.5/6.0/23.1 ms on repetition.
The 64k chain's maximum linear-profile error was 1.23 × 10⁻⁶ m.
[Scaling rows](evidence/bridge-height-continuity/scaling.json).

SciPy is an existing dependency. There is no dense city matrix; only the free-node
sparse partition is solved, with per-component masks assembled from cached node
groups. More highly connected graphs can have greater factorisation cost than a
chain and still need measurement. No citywide rebuild, bridge scene, GPU timing,
strict assembly, deployment or main write was performed. Further height-association
rules require a separately reviewed scope, particularly for the suspended cycleway
and the remaining middle-span source offset.
