---
read_when: Reviewing the wreck-tow scenario's placement premise or repeating its focused final-map replay.
---

# Tow scenario fixture correction

The immutable final suite remains 13/15 as recorded. Its tow failure put the
nominally far wreck 73.5425 m from the player, inside the 79.9676 m cleanup view.
`t.car` searches for a clear spot and can move back toward the player; the requested
`ahead` distance does not establish an out-of-sight premise.

The fixture now uses a fixed north-facing heading, requests a farther initial
search spot, and checks both actual positions against the current production view
before waiting. The far car must also be beyond the 40 m retention distance,
below the separate 600 m immediate-cull distance, and stationary. The existing
far-removal and near-retention assertions remain in place. `t.carView` is a
read-only test query; production cleanup thresholds and logic are unchanged.

## Verification

CPU premise regressions and typecheck pass. One short Google Chrome WebGPU batch
passed two fresh-page standalone runs and a `wall-crash` → `wreck-tow` sequence:

| Measurement | All three tow runs |
| --- | --- |
| Near wreck distance | 57.71698 m; in view |
| Far wreck distance | 160 m; out of sight |
| Cleanup view radius | 79.96760 m |
| Result after 90 simulated seconds | Far removed, near retained |

Both initial placements and final positions agree across the three runs. The
preceding wall-crash case also passed. All six tow checks passed in each run.

The new managed worktree starts at `46b1f3e`, with private APFS dependency and
centrum copies. Data build `2026-10-03T05:44:19Z`, pipeline `ae86cf4823`; all 804
map files match the immutable suite's aggregate hash
`d57d814798fe4cd7c99a79d34c4cc6daac9b6c08f581b9780cf64ece53c4df52`.
The tested source hash is
`65d36f8ee7cc64393dff815aea0f01b4361f4231cfc23ac5fe964e2d71784ffc`.
Source and map hashes remained unchanged throughout the focused batch.

[Raw results, view/position evidence and checks](evidence/tow-fixture-wrapup-2026-10-03/)
preserve the exact URL, renderer, camera and requested/actual spawn data.
No broad suite, production behavior change, full-map rebuild, push or deployment
was performed. The earlier 13/15 evidence has not been rewritten.
