---
read_when: Reviewing the optimisation work from plans 007–012, deciding which experiments to integrate, or checking claims about driving stutter and frame speed.
---

# Findings from optimisation plans 007–012

Reviewed on 1 October 2026. All six plans completed their local implementation and
required verification. The recommendation is to merge plans 007–011 and plan 012
Part A, while keeping plan 012 Part B experimental. Completion of an experiment
and recommendation to ship it are separate decisions.

The strongest findings are reductions in repeated work and first-use shader
builds. None of these plans establishes a general FPS gain. The individual timing
comparisons cannot be added together: they used separate candidates against the
same starting revision, and several changed direction under machine load.

## Findings and decisions

| Plan | Verified finding | Cost or limitation | Decision |
| --- | --- | --- | --- |
| [007: Building shader graphs](../plans/007-share-building-shader-graphs.md) | Equivalent buildings, landmarks and cutaway materials share node graphs and live builder state while keeping distinct textures and sky bindings. | Drive mean 15.3 → 13.0 ms, but pairs disagreed and total material builds were 339 → 344. No proven whole-frame gain. | Merge: removes duplicate graph construction with matching visuals and no demonstrated consistent regression. |
| [008: Car meshes](../plans/008-prepare-car-meshes.md) | Car-body builder events fell from 74–76 to 13–15 per drive. Retained pages did not overflow in the measured drives. | About 0.8 s more benchmark loading; 167,936 bytes of reserved matrices versus 38,336 baseline after settling. Mean 13.8 → 13.5 ms and tail latency are inconclusive. Late/custom colours and burnt models can still build on first use; phone startup was not measured. | Merge with the documented startup/memory tradeoff: a substantial reduction in first-use builders without clipping cars. |
| [009: Tree batches](../plans/009-reuse-tree-batches.md) | All three final candidate drives had zero tree builder events and zero pool growth. Ordinary-frame uploads were about 0.33–0.34 MB versus 0.36–0.44 MB baseline. | About 3.33 MB of reserved matrix/colour/evergreen arrays. Full-drive mean was worse, 12.6 → 14.7 ms, with candidate second and heavy system load; dense suburb was 9.0 → 8.9 ms. Reversed startup runs did not confirm the earlier large penalty. Phone performance is unverified. | Merge for retained mesh reuse and eliminated measured first-use builds. Do not claim faster driving; repeat timing on a quieter machine/phone before doing so. |
| [010: Landmark colours](../plans/010-prebake-landmark-colours.md) | Versioned GLBs perform zero runtime colour pixel passes; legacy assets retain their old path. All 15 staged models preserve geometry and non-image buffers, with matching checked appearances. | Staged centre/city files are 33.4%/32.9% larger. Cold-transition timing is inconclusive. Original shared manifests and GLBs remain active. | Merge converter and compatible reader. Keep asset activation separate until a marker-aware client is live; consider download-size cost before rollout. |
| [011: Spawn sampling](../plans/011-reuse-spawn-sampling.md) | Weights are prepared once per replenishment pass and pavement queries scan only the relevant traffic subset. Selector boundaries, RNG consumption, populations and 173 live queries matched the reference. | Two three-pair timing series changed direction: 11.9 → 12.9 ms and 13.0 → 11.5 ms. Preparation itself has a cost. | Merge as a behavior-preserving reduction in repeated calculations; no confirmed FPS gain. |
| [012 A: Streaming scheduling](../plans/012-schedule-streaming-and-update-collisions.md) | One job per worker, required jobs first, revision-safe coalesced sky refreshes. Desktop/phone queues drained and every comparison had zero player/ahead-tile gaps. | Mean frame-time changes were small and inconclusive. Required-tile build p95 remained 1.25–1.30 s desktop and 5.28–5.99 s phone. | Merge scheduling and diagnostics. Keep the existing worker-count default. |
| [012 B: Resting-car index](../plans/012-schedule-streaming-and-update-collisions.md) | Ordered collision queries match the full-rebuild oracle; only changed entries are refiled. | Desktop mean consistently worsened 10.10 → 10.46 ms (+3.5%). Phone 56.46 → 56.79 ms is inconclusive; one baseline outlier dominates the apparent long-task reduction. Adds an offset-array immutability assumption. | Hold off main. Keep the existing full-rebuild-on-change collision implementation until a revision demonstrates a net benefit. |

## Separate plan 012 comparisons

Each comparison used three alternating 40-second WebGPU drives at High graphics,
14:00 and clear weather. Desktop was an M5 MacBook Air, DPR 1 with the main thread
throttled 4×. The Pixel 5 used Android 14, Chrome 154.0.8037.57, its own display and
no CPU throttle. Phone battery temperature rose from 27.4 to 31.5 °C during Part A
and 31.8 to 33.6 °C during Part B; later candidate runs were warmer.

| Comparison | Mean frame time, before → after | Mean p95 / p99, before → after | Long tasks, total | Loading, mean |
| --- | --- | --- | --- | --- |
| A desktop: original → scheduler | 10.18 → 10.04 ms | 12.60 / 27.40 → 12.37 / 27.03 ms | 6 → 6 | 13.44 → 13.40 s |
| A Pixel 5 | 55.83 → 56.29 ms | 137.17 / 196.60 → 133.77 / 189.67 ms | 207 → 208 | 25.43 → 24.19 s |
| B desktop: scheduler → index | 10.10 → 10.46 ms | 12.57 / 27.47 → 13.00 / 27.93 ms | 5 → 8 | 14.43 → 13.76 s |
| B Pixel 5 | 56.46 → 56.79 ms | 126.47 / 190.00 → 130.13 / 189.10 ms | 283 → 233 | 25.46 → 24.97 s |

Both phone comparisons built three tiles per drive and had no road gaps. Part A
coalesced 41 refreshes per desktop drive and 36–37 per phone drive. Part B changed
roughly 1,500 cars across 5.2 million desktop scans, or 756–765 across 0.84–0.85
million phone scans; fewer mutations did not translate to faster desktop frames.

## Verification and scope of integration

The individual plans record their commands, committed revisions and image/log
paths. Checks covered material sharing and per-material bindings, both graphics
backends, car/tree page reuse and overflow, weather/shadows/cutaways, landmark
markers and legacy compatibility, deterministic spawn selection, worker failures
and stale refreshes, and collision order. The final plan-012 gameplay suite passed
after a transient wall-crash assertion was rerun successfully.

The selected integration starts at `a3032fbf44451e97a9e13248af6c5cb4a17844f7`.
It reuses the already committed numerical integration through plan 012 Part A
(`826f95836febcf32fa5fdb040dd3a77884b0140e`), then includes the final streaming
regression additions and baseline-compatible road-gap reporting. It excludes all
incremental collision-index implementation commits. The existing `syncResting()`
remains in place. This also excludes plan 013's ground changes.

The selected integration passed `npm run build` (including typecheck),
`check-streaming`, `check-material-sharing`, `check-car-pool`, `check-tree-pool`
and `check-spawn-work` with `--case all`, graphics switching on WebGPU and WebGL,
eight `test_landmark_colours.py` tests, the staged landmark browser check on both
renderers, all three `scene.mjs run all` scenarios, and `git diff --check`.
The combined gameplay screenshot retains the buildings, parked vehicles and tree
canopy. Logs and scenario images are in `/tmp/streets-optimisation-merge-checks/`.
The final merge revision is recorded at handoff. A new
combined timing comparison is intentionally deferred: concurrent plan-013 graphics
work could invalidate it, and the existing results do not justify a combined FPS
claim. No generated map data is rebuilt or replaced by this merge; no push or
deployment is part of it.

## Retained experiments and asset staging

| Plan | Original completed worktree | Final original commit |
| --- | --- | --- |
| 007 | `/Users/janca/.codex/worktrees/60f1/streets-of-prague` | `50c92d6e48a0a9ce1465ef6b9e6d19a7e1312e5e` |
| 008 | `/Users/janca/.codex/worktrees/8d89/streets-of-prague` | `408aae2ebafd83d7ae0a6172a10a42f272cf01ab` |
| 009 | `/Users/janca/.codex/worktrees/2632/streets-of-prague` | `be7c6e0de3e88c85af6de8869c204713c1194370` |
| 010 | `/Users/janca/.codex/worktrees/2438/streets-of-prague` | `afdf836b77124d4aba261aa0fafc6fc5063bd330` |
| 011 | `/Users/janca/.codex/worktrees/208b/streets-of-prague` | `c2e2e7093c2ccafa2925786a44813d8f49a04376` |
| 012 | `/Users/janca/.codex/worktrees/811c/streets-of-prague` | `dc84b12ae6fc8720c3beeb70a7519e0734e3e539` |

Plan 010's converted assets remain at
`/tmp/sop-landmark-colours-010/centrum_now` and
`/tmp/sop-landmark-colours-010/praha_now`. Their earlier checks used copied/staged
assets; shipping the code alone does not activate them. The already launched
plan-013 worktree integrates the full experiments, including 012 B; any later
merge of that work needs to preserve this decision rather than reintroducing the
rejected index inadvertently.
