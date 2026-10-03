---
read_when:
  - Rebuilding terrain with bridges near tile edges
  - Investigating conflicting plain-ground anchors or the withheld support pilot
---

# Bridge support at shared ground points

Two Újezd plain-ground anchors disagree between tiles `2_0` and `3_0`. This is a
current terrain-generation defect, independent of the tile-local sampler fallback
investigated by the unaccepted support prototype at `fcf611d`. A fresh private terrain build reproduces
the discrepancy; both historical height files match their terrain digest manifest.

## Source trace

The points are at x=141.55 m, y=-527.8941935483871 and -523.861935483871 in Újezd's
local coordinates, shared global lattice nodes (186,7) and (186,8). Both tiles label
them plain ground (0).

| Stage | First point, both tiles (m ASL) | Second point, both tiles (m ASL) |
| --- | --- | --- |
| Bare raster | 192.2689208984375 | 192.10824584960938 |
| Survey correction | 192.40663146972656 | 191.99327087402344 |
| Structure solving and flat pads | Same surveyed heights | Same surveyed heights |

The final bridge-to-ground pull is tile-local. `structures.build` returns only levels
with drawable clipped polygons in that tile. `3_0` exports a bridge height of
192.05674743652344 m at both points, but `2_0` has no corresponding drawable bridge
payload. Only `3_0` gets pulled to the deck. The resulting decimetre encodings are
924/921 and 920/921, producing 0.3 m and 0.1 m discrepancies.

The historical map's processing hash was
`21b86b574b5fd24d94b54f2d4c31fc48857968be84db2f2527194517cf680236`.
A fresh build with the accepted survey/contact/guarded harmonic source reproduces
the same four records. The cached streets inputs are **79 legacy-grade records**;
the current contact code deliberately supports them. The isolated cache has no raw
OSM input for regenerating observed-contact records, so this is not validation of a
fresh observed-contact streets generation. Full source identities, file digests,
processing keys and runtime versions are in `evidence/bridge-ground-edge`.

## Narrow source repair

`ipr_terrain.pull_to_bridges` gathers bridge support for each global tile-edge node,
keyed by its existing global deck level, before changing ground heights. Every copy
of a shared ground node receives the same support set, including a tile without a
drawable bridge polygon. Interior support stays tile-local and unchanged.

Separate deck levels retain the existing ascending-level pull calculation and its
0.5–1.5 m vertical reach. Heights are not averaged or replaced by a maximum across
levels. Water points remain untouched; distinct terrace ground heights stay separate.
Conflicting same-level support or conflicting shared plain ground is rejected before
any tile is changed. Drawable bridge metadata and bridge-level height arrays are
never modified by the helper. No payload schema or game loader changes are needed.

## Controlled private comparison

The old and new pull calculations were replayed on identical fresh arrays captured
after flat pads. The old calculation reproduced all **25 preserved compressed
height-payload hashes exactly**. The new calculation reproduced all newly exported
height arrays. This isolates the source repair from earlier solver changes.

Only `2_0.height.bin.gz` changes, at two points:

| Tile grid point | Before | After | Labels |
| --- | --- | --- | --- |
| (62,7) | 192.4 m ASL | 192.1 m ASL | 0 → 0 |
| (62,8) | 192.0 m ASL | 192.1 m ASL | 0 → 0 |

Both now match `3_0`. There are zero shared plain-anchor conflicts across the full
25-tile area, zero label changes, and every bridge-level payload is byte-identical.
The reported pull count changes from 229 to 231. The bridge geometry and other
ground heights remain unchanged relative to this matched-input baseline.

Eleven focused regressions cover the actual records, one-sided payloads, reversed
tile order, duplicate support, horizontal and vertical neighbours, a four-tile
corner, water, tunnels, elevated levels, nearby separate levels, different terraces,
unchanged interior behaviour and both conflict guards. Together with the existing
structure-height, contact and survey tests, **46 source tests pass**.

The private Újezd map was assembled again and its dev server remains on port 5201.
Assembly reports stale IPR processing provenance: strict publication assembly was
not verified, because IPR buildings were not rebuilt in this source-only diagnosis.
No full-city build, browser scene or frame-rate measurement was run. Build timings
in the logs have different cache warmth and are not a performance comparison.

## The withheld pilot's large changes

The largest 8.15 m shift is at x=107.2758064516129, y=2.3477419354838744 in tile `2_2`
(50.0815210973 N, 14.4084988003 E). That point is outside the supplied water polygons
by about 0.588 m. No mapped road, terrace, bridge outline or surveyed street surface
covers it. However, all four grid corners are labelled water at 184.8 m ASL, and the
nearest label-0 anchors lie roughly 32–35 m away at about 193 m ASL. The closest
surveyed street surface is over 23 m away. The pilot extends that remote plain-ground
height into this narrow geometric gap; these data do not establish its true height.

This is different from the repaired 0.3 m source seam. The prototype remains
unadvertised and unaccepted. A safer future support contract needs explicit evidence
that a query belongs to a dry surface connected to its anchors, plus a way to mark
unsupported samples. A single nearest-plain field cannot establish that identity:
nearness alone can cross water or a terrace. Returning a remote finite height or
silently falling back to water would both conceal uncertainty. That design and the
Kampa runtime fallback remain separate work requiring review.

## Reproduction

In an isolated data/cache copy, under the overnight heavy-job lock:

```sh
UV_CACHE_DIR=/tmp/streets-terrain-uv uv run --project pipeline --offline --no-sync \
  python pipeline/ipr_terrain.py ujezd --jobs 1 --no-assemble
PYTHONPATH="$PWD/pipeline" UV_CACHE_DIR=/tmp/streets-terrain-uv \
  uv run --project pipeline --offline --no-sync python -m unittest \
  test_ground_pull test_structure_heights test_structure_contacts test_dtm_heights -v
```

The evidence's `rebuild-trace.py` records intermediate arrays and exact points when
run from this isolated checkout with `PYTHONPATH` set to its pipeline directory. It
writes its trace to `/tmp/plain-support-source-diagnosis`; the large arrays and source
caches are deliberately not committed. `fix-comparison.json` records the matched
replay and payload invariants; before/after traces and input provenance preserve the
conflicting records rather than overwriting their history.
