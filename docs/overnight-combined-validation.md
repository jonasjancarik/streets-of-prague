---
read_when: Reviewing the accepted overnight surface, survey-source and furniture integration, or repeating its private-map validation.
---

# Combined city validation

The accepted source-filter, surface and furniture changes passed one combined
validation on a privately rebuilt centrum map on 3 October 2026, Prague time.
The tested implementation is integration commit `7ad54d6`; this report/evidence
commit changes no implementation. No push, main merge or deployment was performed.

Included commits are `ea4bb4a` (source filter, upstream `3358b32`), `84c3344` and
`3ff21cb` (furniture, upstream `6bfee3e` and `fdaba9c`), and `2885a75` plus `7ad54d6`
(surfaces, upstream `5efe19e` and `6711199`). The exact terrain cutter and later
bridge-contact work are excluded. The separate worker-cost runner was not integrated.

## Private inputs and strict generation

Data, raw sources, Python environment and node_modules were APFS-cloned into
`/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague`.
The writable data/cache directories resolve inside that checkout, with no shared
writable symlinks. The source worker's ground/IPR/terrain manifests had a different
processing key, so none were reused as a verified generation. No code or active
bridge cache was copied from the surface/bridge worker.

The replay used the existing centrum OSM cut, 57 supplied DTM surface packages and
57 line packages, the existing tree records, nine local IPR building sheets, nine
terrain sheets and raw bridge shapefile inputs. All geometry ran under integration
code. Source acquisition was frozen by the [offline fixture](evidence/overnight-combined/offline-build.py),
which blocks HTTP rather than refreshing/downloading datasets. No praha/citywide
map build ran. Parsing the supplied DTM source index still reads its district packages.

The original centrum colour table referenced by old metadata was unavailable.
The existing primary-checkout Prague per-building colour table was cloned privately
as the centrum lookup. This is a recorded ancillary input choice, so the captures
are not a pixel comparison against the old facade colouring. The OSM source hash is
`fe5343f02c5005f5b717bca9e8e26de9e74263a32430d16f23e13e31860d4f37`;
parking/colour hashes and private paths are in [provenance.json](evidence/overnight-combined/provenance.json).

All six centrum chunks were rebuilt with buildings, ground, streets and parking;
IPR buildings and terrain were regenerated, then `layers.assemble('centrum', strict=True)`
passed. A missing separate parking-input file was caught by the field comparison
before captures, corrected from the cached source, and only parking was rebuilt.
The evidence fixture now requires that input before any replay.

The final strict map contains 234 tiles, format 2, `built=2026-10-02T22:45:45Z`,
`pipeline=7ad54d61ab`, index SHA-256
`53ced0a71ad5349358bef26fd7e2f7dcf4886891b0e4bf9df6efdb90975b29d1`.
The Python processing key is
`18ec609b167bc66671e8df0ef4dc6121bbb9a92e72a4c274cf819c3098dcc961`.
The strict gate validated current chunk completion, dependencies, source identities
and binary hashes; no stale surface-only preview was used for the final captures.
The terrain stage reported 1,069 rejected raw survey vertices. That count is recorded
without claiming that every rejected/retained source record was independently audited.

## Verification

- `npm run build` passed, including typecheck; the existing bundle-size warning remains.
- Thirty-four focused Python surface/survey tests passed: square materials, walking
  surfaces, DTM land and survey-source filtering.
- Pure furniture/survey tests, ground-layer order/palette checks and the real
  canvas/land-worker furniture check passed.
- Across all 234 tiles, drive edges, walk edges, paid-parking sections, parking lots,
  passages and crossings match the cloned baseline byte-for-byte after canonical
  object-key serialization. [Field comparison](evidence/overnight-combined/route-parking-comparison.json).
- The loaded player moved **6.9 m** in two simulated seconds on public ground in
  Old Town Square. [Movement](evidence/overnight-combined/player-movement.json).
- Forty furniture placements across 37 loaded tiles had zero sampled overlaps with
  explicit paving, road polygons, real walking-route widths, buildings, water,
  parking or structures. Each centre had a solid collision cell. The independent
  checks cover the physical footprint's centre, corners and edge midpoints, not
  merely the placement function's own acceptance predicate.
- A real Kampa bench approach moved the player 1.95 m, from 3.00 m to 1.08 m in
  front of the bench, without crossing it; the centre was blocked. This is a simple
  collision check, not a full physics suite. [Combined scene result](evidence/overnight-combined/combined-scene.json).

The final world had no failed, queued or running worker jobs, 735 drive edges,
3,076 walk edges, 1,072 parked cars and 242 pedestrians. Optional refresh
cancellations were recorded separately from failures. These counts describe that
loaded world, not the whole map or a performance comparison.

## Combined views

The scene browser used this checkout on Vite 5204 and scene port 5304. The map marker
and target-tile terrain were verified before captures. The default backend was
WebGPU, High graphics, DPR 1, 1280×800, clear Wednesday 14:00, fixed summer date
15 July. Simulation was paused and the HUD hidden. The free camera was loaded before
teleporting and loaded again afterwards to avoid capturing a retired target tile.

| View | Latitude, longitude | Height / tilt / heading | Picture |
|---|---|---|---|
| Karlovo park | 50.075, 14.4195 | 145 / 25 / 0 | [View](evidence/overnight-combined/karlovo-combined.png) |
| Old Town Square | 50.0873, 14.4208 | 135 / 25 / 0 | [View](evidence/overnight-combined/old-town-combined.png) |
| Open courtyard | 50.0838504, 14.4083889 | 35 / 0 / 0 | [View](evidence/overnight-combined/courtyard-combined.png) |
| Kampa bank/path | 50.081814815, 14.4103086003 | 55 / 25 / 0 | [View](evidence/overnight-combined/kampa-combined.png) |

The images show Karlovo's lawns and paths retained, clear Old Town paving with input
greenery preserved, a planter away from the courtyard route and walls, and benches
beside Kampa's paths. Counts in the scene result cover every loaded tile, including
objects outside each camera view. The pictures support the sampled combined result;
they do not prove historical furniture locations or correctness of every source polygon.

## Scope and handoff

No implementation defect was found by this combined pass. The initial missing
parking input was a setup issue corrected before the authoritative pass. Existing
terrain/cutter seam concerns and the bridge-contact changes remain separate work.
No phone, WebGL, clean frame-time benchmark, full gameplay suite or full-city map
validation was attempted. Build logs are evidence of completion, not speedup claims.

All logs, hashes, camera fixture and screenshots are committed under
`docs/evidence/overnight-combined/`. The owned scene browser is closed and its GPU
lock released; unrelated processes were preserved. The useful integration server
remains running at [localhost:5204](http://localhost:5204/?area=centrum),
[MacBook-Air-2.local:5204](http://MacBook-Air-2.local:5204/?area=centrum), and the configured
[Tailscale URL](http://macbook-air-2.adal-macaroni.ts.net:5204/?area=centrum).
Tailscale was stopped at verification, so that last route was unavailable.

The parent can resume writing in this integration checkout after this documentation
handoff. Extend validation only around subsequently accepted cutter/bridge changes;
the accepted source/surface/furniture snapshot already has this authoritative pass.
