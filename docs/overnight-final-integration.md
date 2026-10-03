---
read_when: Reviewing the final accepted terrain cutter on the integrated city map or reproducing the remaining Kampa sampler seam.
---

# Final cutter integration check

The accepted TS cutter and edge repairs were checked at integration commit
`c85e999` on 3 October 2026. The existing strictly generated centrum map was reused:
234 tiles, built `2026-10-03T00:26:37Z`, pipeline `5182c47670`, index hash
`c2ec699a13d019ae552860f53a467ad50863843a751bd8557f55e1407f01f0a3`.
No Python rebuild, new implementation edit, main merge, push or deployment occurred.

All 23 geometry regressions passed once: 12 cutter tests plus 11 complete-ground/
perimeter tests. One `npm run build` passed, including typecheck, with the existing
bundle-size warning. [Test/build evidence](evidence/overnight-final/).

## Runtime geometry

The selected checks inspect real scene meshes' Float32 position attributes and
indices, not newly reconstructed source geometry. WebGPU backend position buffers
were present for both base meshes on each adjacent-tile pair. This establishes
uploaded-precision attribute/buffer use; it is not GPU readback or a presentation trace.
The fixture uses the actual stencil draw order (base `-1001`) and filters out water,
shades, walls and upper/deck/tunnel geometry from the crossing check.

A seam check interpolates the actual Float32 edge segments over the union of their
breakpoints. An independent comparison computes the expected per-tile edge profile
from unmodified, side-aware terrain samples at world-aligned 2 m anchors. Literal
stored grid nodes, sampler-derived profiles and residual mesh differences are
recorded separately. Local terrace labels are matched by physical side category;
these selected seams had no opposite-side or missing-edge intervals.

| Tile pair | Edge | Compared intervals | Stored edge-node difference | Largest mesh gap | Expected sampler-profile gap | Largest residual |
|---|---|---:|---:|---:|---:|---:|
| Kampa `5_6` / `5_7` | y = 248.82 | 168 | 0 m | 0.800 m | 0.800 m | 0.000000202 m |
| Terrace/courtyard `4_8` / `5_8` | x = -897.84 | 157 | 0 m | 0.001200 m | 0.001200 m | 0.000000274 m |

No additional tessellation discrepancy above 0.3 micrometres was observed in these
base-edge comparisons. **This does not mean all seams are fixed.** The 0.8 m Kampa
offset remains a real unresolved sampler/label consistency issue even though the
stored edge nodes agree. It must not be described as a 0.8 m stored-height mismatch
or hidden behind the tiny tessellation residual.

At x = -784 / -782 / -780 / -778 and y = 248.82, requested plain side 0 returns
5.80000019 m from tile `5_6` and 6.59999990 m from `5_7`. Shared corner heights are
4.69999981 m and shared corner labels are water (1). The lower tile can use a
5.8 m plain corner; the upper tile has no plain corner in that cell and searches its
own clipped neighbourhood, finding different dry-side samples. The existing
`heightSampler` label-aware corner/fallback selection is therefore tile-local at
this thin dry-ground/water transition. The cutter reproduces those input profiles;
there is no additional measured tessellation error at the offending point.

A [minimal CPU case](evidence/overnight-final/sampler-case.json) preserves both encoded
height grids, labels, terrace outlines/flat heights, water outlines and coordinates.
Run `node docs/evidence/overnight-final/reproduce-sampler.mjs` from the integration
root. [Reproduction](evidence/overnight-final/sampler-reproduction.json) includes
corner labels, shared rows, fallback neighbourhoods and raw sampler values. This
identifies the immediate cause; how pipeline labels/geometry or shared sampling
should be reconciled remains separate work. No implementation was changed to mask it.

## Outline and support checks

Across tiles `5_5`, `5_6`, `5_7`, `4_8` and `5_8`, the fixture considered 219,592
projected ground/road triangles and checked 610,035 interior samples near relevant
water/terrace outlines. **Zero sampled triangles spanned multiple terrain labels.**
10,353 samples within 1 mm of an outline were excluded to allow Float32 placement
precision. Other triangles whose boxes cannot meet an outline need no crossing
samples. This is sampled coverage, not a mathematical proof for every triangle.

A small actual player movement smoke at the Legií west bridgehead moved 3.30 m in
one simulated second, with finite ground support at both ends (13.27 → 13.10 game
metres). No full bridge traversal or repeated furniture/parking suite was run.
Complete numbers are in [runtime-check.json](evidence/overnight-final/runtime-check.json).

## Cameras and views

The short exclusive WebGPU batch used existing Vite 5204 and scene port 5304, High,
DPR 1, 1280×800, clear Wednesday 14:00, fixed summer date 15 July, paused simulation
and hidden HUD. The map marker was checked. Cameras were loaded before teleporting
and loaded again afterwards. Exact eyes and quaternions are in the runtime result.

| View | Latitude, longitude | Height / tilt / heading | Evidence |
|---|---|---|---|
| Kampa bank | 50.081814815, 14.4103086003 | 55 / 25 / 0 | [Final](evidence/overnight-final/kampa-final.png), [saved before](evidence/overnight-combined/kampa-combined.png) |
| Legií west source head | 50.0812660881, 14.4080712252 | 70 / 45 / 87.679637 | [Final](evidence/overnight-final/legii-head-final.png), [saved before](evidence/overnight-bridges/most-Legi--head-0.png) |
| Kampa tile seam | 50.0837364711, 14.4092017942 | 110 / 20 / 0 | [View](evidence/overnight-final/seam-5_6-5_7.png) |
| Terrace tile seam | 50.0871076665, 14.4074544004 | 110 / 20 / 0 | [View](evidence/overnight-final/seam-4_8-5_8.png) |

The matched Kampa/Legií targets and camera settings preserve the saved comparison
views on the same data; people, boats and other actors need not match pixel-for-pixel.
The images were inspected for loaded ground/decks and the sampled appearance.
The new seam cameras support the actual attribute checks but are not paired baseline
captures. Existing source/model limitations remain visible and are not claimed repaired.

## Limits and handoff

The browser completed with no failed or pending required worker jobs. It was closed
and its lock released before CPU-side source diagnosis. The optional WebGL view was
deferred because three other workers were queued; no WebGL parity claim is made.
No clean FPS/frame-time, phone, GPU-readback or full-city claim follows from this pass.
Memory pressure was checked before the scene slot (`memory_pressure -Q` reported
53% system-wide free); no further heavy
job was started. No extra Python rebuild was needed for the TS sequence.

The accepted cutter passes the scoped geometry/build/runtime checks, with the
Kampa sampler offset explicitly still unresolved. The parent can resume integration
writing after this report/evidence handoff. The useful server remains on 5204 at
[localhost](http://localhost:5204/?area=centrum), [LAN](http://MacBook-Air-2.local:5204/?area=centrum),
and the configured [Tailscale hostname](http://macbook-air-2.adal-macaroni.ts.net:5204/?area=centrum),
which was stopped during setup.
