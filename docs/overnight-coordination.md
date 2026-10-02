---
read_when: Continuing or reviewing the overnight city geometry and detail work started 2 October 2026.
---

# Overnight city improvements

Session deadline: 3 October 2026, 04:56 UTC / 06:56 Prague.
All implementation starts at `b3c22d5`. Main, shared map data and unrelated worktrees remain untouched. No push or deployment is authorized.

## Stop condition

Before substantial work and at least every five minutes of active work, read live Codex usage. Stop this effort if the 10080-minute weekly window has more than 90% used. An unreadable quota pauses new work. `/tmp/streets-overnight-quota-stop` also stops work. Preserve files; only minimal shutdown is allowed after the threshold. Never consume reset credits to continue.

## Workers

- Terrain: `01a0fe68-b4ff-7e33-85b9-5c210adcc469`, worktree `/Users/janca/.codex/worktrees/ae03/streets-of-prague`, dev port 5201.
- Surfaces: `01a0fe68-bc98-72d3-ad72-b6b3c72a5c01`, worktree `/Users/janca/.codex/worktrees/f776/streets-of-prague`, dev port 5202.
- Furniture: `01a0fe68-c8d9-7221-b7f2-92732e44794d`, worktree `/Users/janca/.codex/worktrees/fd60/streets-of-prague`, dev port 5203.

Read these IDs directly: list_threads omitted them during launch. Only one active scene/benchmark browser at a time; workers use `/tmp/streets-overnight-gpu-lock` with an owner file. Verify ownership before recovering a stale lock.

## Status at 21:28 UTC

Terrain candidate `3358b324a84d475ac5665b96bbb6aa2ca43c3822` rejects gross original survey vertex errors before interpolation and preserves separate line components. Worker reports Nosticova peak 293.66 to 195.79 m, two changed height tiles, identical labels and bridge levels, ten focused regressions passing. Parent inspected diff; surfaces worker is assigned independent review after its own checkpoint. Not integrated yet.

Exact terrain cutting remains uncommitted and under investigation. Parent specifically requested independent tile-seam tests and representative complexity measurements; do not enable it merely because within-mesh tests pass.

Surface worker implements plan 018 and corrects named square outlines painting over explicitly mapped green. Parent inspected matched Old Town and Karlovo images. Review identified clipping into narrow green holes; worker added a preservation rule and test. Sett conversion accounts for Wenceslas path-class area reduction. Petřiny estate comparison and final documentation pending.

Furniture worker implements deterministic benches/bins beside park paths and courtyard planters, with worker placement, shared meshes and collision integration. Parent requested closer path-edge placement and timeout of optional survey fetch; worker reports both corrected and tests passing. Revised low-angle visual evidence pending. Combined Karlovo validation must use corrected surface data.

Both terrain and surface workers report two pre-existing pipeline assembly-test mock failures involving subprocess.run(cwd=...). Require baseline reproduction before treating them as unrelated; do not expand scope into broad cache refactoring.

## Next coordination steps

Collect committed surface/furniture changes and independent source-filter review. Integrate accepted commits here only, resolving documentation overlap without losing evidence. Run relevant combined checks and isolated map/scene comparisons, particularly furniture on corrected green surfaces. Reuse workers for independent reviews and scoped fixes. Record exact final source and map provenance. No speedup claim without uncontended measurements.

## Checkpoint at 21:38 UTC

Furniture candidate `6bfee3ea3fb746a9d3162a03e75649b7aa0af808` is committed in its worker checkout. Parent inspected the final low-angle Kampa view and path-edge placement code: the seat faces the path with a clear approach. Revised tests cover the optional survey deadline.

Review assignments changed: furniture worker reviews terrain source commit `3358b32`; surfaces worker reviews furniture `6bfee3e` after completing its own implementation. Both candidates await independent review.

Automatic approval review rejected the proposed cherry-pick because acceptance is still pending. No integration or checkpoint commit ran. Wait for independent reviews, resolve findings and explicitly accept before retrying; do not bypass the rejection. This integration worktree remains at b3c22d5 with only this untracked coordination note.

Quota check: 1% used in the weekly window; stop signal absent. No reset credits consumed.

## Acceptance at 21:47 UTC

The independent furniture worker review of pinned terrain commit `3358b324a84d475ac5665b96bbb6aa2ca43c3822` found no substantive issues. It passed the ten committed tests and additional probes for empty/all-invalid input with water, nonfinite coordinates, excluded grade levels, v3 cache invalidation/v4 reuse, and both 30 m thresholds. Parent accepts this commit for isolated integration, retaining its documented heuristic and small-area validation limits. This new completed review resolves the earlier integration approval concern for this terrain commit only.

Surface commit `5efe19e9c5880a106646333d9fb6649fe03b9a40` is complete with six view pairs, 29 focused tests and baseline reproduction of unrelated mock failures. Furniture review found a real P2: generic square includes explicit slab paving; furniture must exclude it after green. Props worker is assigned that follow-up fix, then independent review of the pinned surface commit. Neither furniture nor surfaces is accepted yet.

## Acceptance at 22:08 UTC

Surfaces reviewer confirmed furniture follow-up `fdaba9ccbfe17c66343319413fa713d16124b0b7` resolves the explicit slab-paving overlap, including its regression. Parent inspected the same small diff and final feature views. Furniture sequence `6bfee3ea3fb746a9d3162a03e75649b7aa0af808` then `fdaba9ccbfe17c66343319413fa713d16124b0b7` is accepted for isolated integration. Combined validation on corrected surface data remains required. This completed independent review resolves the earlier integration approval concern for furniture.

Surface fixes for surveyed/inferred green and differently surfaced links pass new regressions; awaiting committed checkpoint and independent recheck. Terrain cutter is being committed after fixed-pose WebGPU/WebGL captures and CPU/geometry measurements. Bridge diagnosis found inconsistent on-ground endpoint flags across chunks; surfaces worker is authorized a separate narrow root-cause fix with chunk-order/full-area regressions if confirmed.

## Acceptance at 22:28 UTC

Independent terrain-worker review of pinned surface follow-up `67111992849623c5a11fdee59b4639eb6e8184cb` passed 19 surface tests and extra probes: no named-square overlap with surveyed lawns, retained park paths, contrasting links preserved, explicit paving precedence unchanged, and four independent chunk extractions agreeing on shared cores. Parent accepts surface sequence `5efe19e9c5880a106646333d9fb6649fe03b9a40` then `67111992849623c5a11fdee59b4639eb6e8184cb` for isolated integration.

Cutter `8e9e105` is NOT accepted yet. Independent review passed 400 additional geometry cases but found groundLayers pre-cut refinement leaves a 0.27 m curved-height tile-edge gap (baseline 1.2 m). Author is assigned integrated seam regression and correction. Synthetic dense segment arrangements also show steep scaling; actual-map density evidence is needed to contextualize it.
