---
read_when: Investigating long bridge height association, Net.spread interpolation, IPR face windows, or the Radotín motorway profile.
---

# Radotín bridge height diagnosis

The approximately 1.14 m rise over two metres on motorway way **172187367**
begins in graph-height propagation, before IPR matching or smoothing.
`Net.spread` uses the two nearest fixed anchors by graph distance, which can both
lie on the same side of a span. Changing that nearest pair creates a discontinuity.
Deck-window rejection and a second propagation pass then amplify the wrong
profile; smoothing spreads it out rather than restoring the source deck.

This is a read-only diagnosis of accepted bridge-contact commit `f0bb722`, pinned
as a private module. Neither contact semantics nor height rules were changed.
The clean pre-bridge ground and IPR cache are the same frozen inputs used by
the accepted contact checkpoint; that report belongs to the
surface worker's accepted commit and may be read with `git show
f0bb722:docs/bridge-contact-results.md`. No final terrain, nearest-runtime-deck
selection, location exception, source download or citywide rebuild was used.

## Ground anchors and propagation

At the start of 172187367, the two nearest fixed ground contacts are:

| Node | Owning way | Graph distance from span start | Ground height |
| --- | --- | ---: | ---: |
| 1820688669 | motorway link 925846267 | 305.9 m | 197.088 m |
| 5868412460 | motorway link 925846268 | 306.7 m | 198.638 m |

Both are observed ground contacts under the accepted merge logic. The target's
far endpoint, node 478231564, is at 242.912 m and about 1,305 m along its way.
The first pair keeps the estimate near 197.862 m as distance increases because
both low anchors remain the closest pair. Between s = 497.971 and 502.714 m,
the high far endpoint replaces one low anchor. The estimate jumps from 197.863
to 220.084 m over 4.743 m, even though the available IPR surface is continuous.

After deck matching, the same mechanism selects two nearby samples from the low
cluster around s = 89–99 m until another cluster becomes nearer around s = 517 m.
It does not interpolate between samples bracketing the missing-data interval.
The profile changes from a low plateau near 203.795 m to a high plateau near
228.444 m. [Exact anchor identities and distances](evidence/radotin-height-diagnosis/anchors.json).

A minimal three-branch graph with two low contacts at 197.088/198.638 m and
one far high contact at 242.912 m reproduces a **22.152 m jump over 5 m**.
It contains no IPR faces, survey, rasterisation, or bridge pieces.
[Synthetic reproduction](evidence/radotin-height-diagnosis/synthetic.json).

## Face association and smoothing

All 271 non-fixed target samples have IPR candidates. The height window accepts
84, rejects every candidate at 187, and chooses a lower face at three samples.
For example, at s = 98.890 m the initial estimate is 197.862 m. `solve` queries
`deck_at` with guess 199.862 m and a strict window of approximately
193.862–203.862 m. The candidates are 203.850 and 206.500 m: the lower one fits
and the higher one is rejected. Around s = 498–522 m, the higher face rises
smoothly from 214.32 to 214.80 m, but both candidates are rejected.

The matched source faces belong to bridge object **ID_BUD 1000061**, sheet
**Prah86**, with source update value **200908**. Global shapefile faces 655 and
693 provide the higher/lower pair over the first section; faces 654/694 provide
the later pair. Both higher and lower faces have negative Newell normal Z ratios
near −1, so a signed-normal filter cannot distinguish them here. Object identity
alone cannot separate upper and lower surfaces of the same bridge either.
Face matching uses the pipeline's exact `krovak_to_local` transform, rather than
a separately selected CRS operation. [Faces and geometry hashes](evidence/radotin-height-diagnosis/faces.json).

| Target profile stage | Largest adjacent height change | Spacing | Equivalent change per 2 m |
| --- | ---: | ---: | ---: |
| Initial ground-anchor spread | 22.221 m | 4.743 m | 9.370 m |
| Spread after IPR snapping | 12.342 m | 4.743 m | 5.204 m |
| After crossing constraints | 12.342 m | 4.743 m | 5.204 m |
| After 25 smoothing passes | 2.714 m | 4.743 m | **1.14454 m** |

The last value agrees with the contact report's 1.14450 m/2 m raster profile.
This is a profile of the pinned way itself, with no runtime-level switching.
Crossing constraints do not alter this target; the discontinuity already exists
before them. Smoothing reduces its peak but does not correct the association.
[Stage summary](evidence/radotin-height-diagnosis/summary.json),
[trace log](evidence/radotin-height-diagnosis/trace.log),
[input provenance](evidence/radotin-height-diagnosis/provenance.json).

## Proposed next scoped step

First add a propagation-continuity regression using the three-branch graph and
two clusters of fixed samples separated by a gap. Preserve every fixed ground,
measured-deck and crossing constraint exactly, while requiring a continuous
profile through the unmeasured interval. A continuous graph interpolation with
Dirichlet anchors is a candidate; its treatment of branch grades must be reviewed
before choosing an implementation. Simply widening the deck window or increasing
smoothing would mask the source of the jump and risk borrowing another deck.

Then rerun source association with the existing windows. Continuous propagation
may leave some height-window rejects on a genuinely curved bridge; those should
be measured separately before proposing any additional matching rule. No source
association or propagation repair is implemented in this checkpoint.

Negative controls should include the accepted full/chunk/reverse-order contact
fixtures and motorway **906486675** (the contact fix already reduced its rise to
about 0.10 m/2 m); simple two-ended bridges with sparse IPR coverage; true loose
ends; and close/crossing decks with distinct mapped layers. Cycleway **495700335**
is explicitly layer 1, metal, and suspended between the motorway bridges: its
actual centre-line samples have no IPR face, so it must not acquire a neighbouring
motorway surface. The nearly level Libeň south way **376889215** and the footway
**32955360** provide additional unchanged-profile checks. Profiles should remain
tied to way/member identity, not a reused runtime level number.

The detailed immutable trace and private diagnostic scripts remain under
`/tmp/radotin-height-diagnosis/`. Compact evidence is committed above; no raw
ground or deck cache is committed. Parent approval of the next scoped step
precedes a new bridge-height rule.
