# Codex worktrees: what is in them that main lacks

Checked on 6 October 2026 against `main` at 27bc5ef. The fifteen worktrees under
`/Users/janca/.codex/worktrees/*/streets-of-prague` are all on a detached HEAD, none has
uncommitted files, and none was changed by this review. For each commit not reachable from main
I compared its patch-id with every non-merge commit of main, then its subject line. A subject match
without a patch-id match means the work went in rewritten (usually squashed or amended), which
is fine to drop.

## Hold something main does not have

| Worktree | Commits | What they contain | Advice |
| --- | --- | --- | --- |
| `2bc4` and `811c` | the same seven commits twice (`35b141a`..`dc84b12` in 811c, `6cff7bc`..`1fbf415` in 2bc4) | Plan 012 Part B: parked cars' collision entries updated incrementally, skipping bucket work on unchanged steps, cheap resting-car no-op scans, numeric pose snapshots, documentation and the separate desktop and phone results. Plans/README says Part B is held after a desktop regression. 811c also has `ac90ca1` (Part A, already in main in other form). | Keep one of them (2bc4 is the later copy, at `b61368b`) until Part B is decided; the other is a duplicate and safe to remove. |
| `ae03` | `fcf611d` Prototype shared dry-ground support without advertising map payloads (814 lines: `pipeline/plain_support.py`, `pipeline/pilot_plain_support.py`, tests, comparison scripts, `docs/plain-ground-support-pilot.md`, evidence JSON, a 20-line change in `src/terrain.ts`) | A pilot of dry-ground support for the terrain, never merged. It predates the photo-classified ground (plan 013) and plan 027, so it may be superseded. | Keep until the owner has read `docs/plain-ground-support-pilot.md` and decided; otherwise it is the only copy of the evidence. |
| `fd60` | `1755da5` Measure furniture land-worker generation cost on saved tiles (`scripts/measure-furniture-worker.mjs`, `docs/overnight-furniture-results.md`) | A measuring script and its results; main has `docs/overnight-furniture-results.md`'s sibling notes but not this commit. Small, harmless. | Cherry-pick if furniture timing matters again, then remove. |

## Nothing unique (safe to remove)

- `2632`: four tree-pool commits, all in main under the same subjects.
- `5cb2`: PID bus route boards, in main.
- `c01c`: seasonal start screen and failed tile download handling, in main.
- `d122`: parked cars clear of neighbouring lanes, in main.
- `lamp-final-wrap`: lamp impact fixtures, in main.
- `60f1`, `8ccf`, `f776`: every non-merge commit is in main by patch-id; they differ only in merge commits.
- `cloudflare-deployment` and `overnight-city-integration`: ancestors of main.
- `tow-fixture-wrapup`: no commits outside main.

Removal is the owner's call (the worktrees are Codex's); use `git worktree remove` from the main
checkout, one at a time. Before removing `2bc4`/`811c`/`ae03`/`fd60`, copy or branch the
commits listed above, because a detached HEAD is not kept by any branch and will be garbage
collected.
