---
read_when: Reviewing bridge source contacts, combining streets chunks before terrain builds, or diagnosing the Lahovice/Radotín bridge profiles.
---

# Bridge contacts across map chunks

Implemented in the isolated `f776` worktree on 3 October 2026, after surface
commits `5efe19e` and `6711199`. Shared data, main, deployment and the terrain
worker's source were left unchanged. This checkpoint corrects source contacts
and preserves mapped deck identities; the remaining long-deck height problem
still needs investigation.

## Reproduced source error

OSM motorway way **171993317**, 844.5 m long, starts at node **248763242**.
The cached `praha` streets chunk **5_2** marks that endpoint on ground, while
chunk **6_2** marks it off ground. The complete 6_2 OSM input has three bridge
ways at the node—171993317, 40029823 and 906486675—all `bridge=yes`, layer 2,
and no ordinary ground road. A cut containing only the long way reports it as
a loose end because its local use count is one. OR-merging that hint makes a
false global ground anchor.

`structure_ways()` now records observed ordinary-way contact in `on_ground`
separately from its compatible local `grade` hint. `merge_ways()` combines
observations, deduplicates ways, and resolves loose ends from the combined
node graph. It retains chosen original dictionaries for `pads()` evidence.
Empty structure inputs also retain a correctly shaped coordinate array.

The independent end-to-end fixture has two connected 100 m bridge ways above a
190 m valley, with a real 220 m deck and ground contacts at the outer ends.
Before the change, duplicate isolated cuts add a false centre anchor and split
the bridge into two runtime levels. After it, full-area, overlapping-cut and
reverse-cut-order builds have bit-identical raster grids and one 220 m deck.
The test exercises parsing, solving, pieces, level assignment and rasterisation.

## Cache and layer handling

The internal streets structure records also retain an explicitly mapped layer
in `mapped_layer`; an absent/unparseable tag stays unknown. Different explicit
layers with disjoint OSM nodes remain distinct when nearby or nested, even if
inferred heights are close. A shared node preserves a physical join despite
different tags. Untagged and legacy pieces keep height-based inference.

Existing complete legacy components remain readable with their old flags.
Incomplete contact arrays, mixed record versions for one way, or mixed old/new
records in a connected component fail with an instruction to rebuild its
streets chunks. Disjoint old/new components can coexist during a selective
refresh. Normal processing-key invalidation includes `structures.py`; rebuild
every streets chunk supplying an affected component, then terrain. Tile format
2 and the walking/driving network format are unchanged.

## Regional evidence and limits

A private APFS snapshot contains 48 requested tile JSON/height/level files from
`praha`, built `2026-10-02T20:51:35Z`, pipeline `5932924ecc-dirty`. Its index
SHA-256 stayed `6deeac89ee7c8812a7ca4f5328f77c6df05defc767fed777bb245dab47382229`
before and after copying. Seven cached OSM/streets/ground chunks supply the
diagnosed bridges. No source download or citywide build ran.

Reusing final terrain as solver input was rejected as a repair comparison: it
already contains bridge pads and height pulls. Instead, eight privately copied
raw IPR sheet grids were checked against their source identity, projection,
origin and step. The existing survey algorithm was applied to four small
regions before any bridge pads/pulls, with 56 ground tiles. Cached survey
points were limited to each region with an 80 m margin. This is diagnostic
recomputation, not a strict production terrain assembly; the separate survey
filter and exact cutter are not part of this patch.

The same clean ground and IPR deck inputs were used for both contact modes.
Both applied the mapped-layer guard; only the interpretation of contacts varied.
For 26 connected structure ways (35 chunk records), fixed ground anchors fall
from **19 to 18**, while accepted IPR samples rise from **506 to 595**. The
regional raster produces levels for 21 selected tiles. On motorway way
906486675, the largest two-metre height change falls from about **0.87 to
0.10 m**; this supports the representative false-anchor correction.

These results do not establish full bridge recovery. Radotín motorway way
172187367 still has an approximately **1.14 m change over two metres**, and
its first section remains below the available IPR top face. Height-window
association and smoothing after deck snapping are promising next inspection
points; no height window, smoothing rule, survey rule or exception box was
changed here.

Source identities must guide profiling: cycleway **495700335** is explicitly
layer 1, `surface=metal`, with the OSM note that it is suspended between the
motorway bridges. Nearby motorway ways are layer 2. The first nearest-height
catalogue profile followed a motorway, then a low orphan/outline level and
reported a false 14 m drop; that lower level was not proof of the cycleway's
height. Runtime level numbers can be reused by distant groups, so comparing
only those numbers without location/member identity is insufficient.

The Výtoň catalogue extrapolates straight beyond footway 31729915 into folded
steps 31729916. Its apparent last 1.8 m drop needs a profile along the actual
stair geometry. Libeň south way 376889215 has a nearly level deck in the
snapshot; its steep ground approaches remain. Neither join problem is claimed
fixed by this contact change.

## Verification and next step

**44 focused Python tests pass**, including 12 contact/layer regressions:
full/chunk/reverse-order equivalence, true contacts, real loose ends, legacy
reading, mixed/incomplete records, empty input, different-height crossings,
close/nested explicit decks, and connected physical joins. The broader suite
ran 66 tests and retains the two previously reproduced `test_build_cache`
subprocess mock errors.

Committed evidence is in [the evidence folder](evidence/bridge-contacts/).
Detailed profiles, source records and raw-stage provenance remain under
`/tmp/bridge-diagnosis/`; private snapshot/cache paths resolve within this
worktree. No bridge scene, GPU timing, strict assembly or deployment was
verified. Independent review of this pinned checkpoint precedes further
height-association work and combined terrain/cutter validation.
