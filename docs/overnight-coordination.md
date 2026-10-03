---
read_when: Continuing or reviewing the overnight city geometry and detail work started 2 October 2026.
---

# Overnight city improvements

Session deadline: 3 October 2026, 07:00 UTC / 09:00 Prague.
All implementation starts at `b3c22d5`. Main, shared map data and unrelated worktrees remain untouched. No push or deployment is authorized.

## Stop condition

Before substantial work and at least every five minutes of active work, read live Codex usage. Stop this effort if the 10080-minute weekly window has more than 50% used. An unreadable quota pauses new work. `/tmp/streets-overnight-quota-stop` also stops work. Preserve files; only minimal shutdown is allowed after the threshold. Never consume reset credits to continue.

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

## Acceptance at 23:59 UTC

Combined source/surface/furniture validation is committed as `187f410`, with strict 234-tile centrum generation, unchanged movement/parking fields, collision checks and four inspected views. Integration implementation through `7ad54d6` is verified to that documented extent.

Independent review of bridge contact commit `f0bb72213ea5918b65afebe580cf5e4be83f47c1` found no substantive issues: 44 focused tests and probes for 22 chunk orders, shared contacts, loose ends, legacy/mixed caches and nested mapped layers passed. Parent inspected the change and accepts it for isolated integration. Legacy components retain old anchors until their streets are rebuilt; Radotín height association remains unresolved. Follow-up validation must rebuild current structure records and terrain, not reuse legacy anchors.

The canonical tile-edge correction is still awaiting its committed checkpoint and independent review; do not integrate the cutter yet.

## Acceptance at 01:09 UTC

Bridge validation handoff `c7f2efc` is clean. Strict assembly, 22 integrated tests, unchanged protected map fields, 418 finite source-identified runtime deck samples and four 0.02–0.21 m genuine joins passed. The seven views and caveats are documented in docs/overnight-bridge-validation.md.

Parent accepts cutter sequence `8e9e1057a42bcf0803ee221bc6f29b9d3cb478d8`, evidence `bcf7c6e`, canonical-edge fix `c752c41c227ee36f2d7982c403111d9d9d60a673`, precision follow-up `64a454ba0190e4520cdec0763b99f548d3769565`. Independent review passed 23 committed tests and eight additional precision variants after both P2 seam findings were corrected. A wider 48-tile private stored-data pass found no invalid geometry or sampled crossings; size increases and contended CPU costs are explicitly documented. This is acceptance for isolated integration, with a final combined runtime check still required.

Radotín Net.spread continuity repair remains separate and unaccepted. The author is comparing the sparse graph interpolation against clean-ground source profiles and negative controls.


## User extension at 02:09 UTC

The user extended work until 3 October 2026 09:00 Prague / 07:00 UTC and raised the stop threshold to below 50% weekly quota remaining (weekly usedPercent >50). This supersedes every earlier 10% or 04:56 UTC note. All seven workers and the coordinator were updated. Current remaining weekly quota is 92%. Rolling task selection remains authorized, with single-browser/load limits and no main/shared-data/push/deploy changes.

## Acceptance at 02:20 UTC

Boat sequence `e88f704` + `cf1e1a8` is accepted after independent review and correction of intermediate walker-footprint clearance. Reviewer reproduced the narrow corridor rejection and open-bank/height/determinism controls; author verified three real moorings and under-bridge travel, with final guard CPU coverage. Parent inspected night-light evidence.

Vehicle sequence `9a3b20e` + `00222e6`, evidence `5c72c3d`, is accepted after independent retained-resource/lifecycle review and baseline triage of all five original scene-suite failures. No introduced regression was identified; the full suite remains 7/12 and must not be reported green. Parent inspected bus display and production diffs. Combined smoke remains needed for these additions.

Tile-fetch reliability `ae1a49f` is pending independent review. Parking and seasonal work remain unaccepted. The rolling queue has seven workers, all updated to 09:00 Prague and below-50% quota stop. Kampa source-sampler mismatch and Net.spread review remain open.

## Acceptance at 03:00 UTC

Seasonal ground/hedges sequence `0a6525c`, `37fedb0`, evidence `243aa86` is accepted. Independent source/year/paused-date checks found no issues; author completed 30 checks per renderer, 48 matched captures and the required A/B/reverse/control measurements. Timing remains inconclusive and no performance benefit is claimed. July identity and evergreen hedge behavior are verified. Step4 start-screen work is separate in c01c; seasonal bird activity is the next small task in 8ccf.

Vehicle/boat combined smoke is committed as `d08a53a` and passed24 focused checks. Parking graph omission is corrected in `7de0db8` and independently rechecked; complete parking/fetch sequence awaits final binary validation. Integration remains local only.

## Acceptance at 03:30 UTC

Parent accepts bridge continuity `d7dde1b` plus result guard `57475d7` after independent focused review, including rejection of the reviewer's numerical failure case. Diagnostic evidence `cc69274` accompanies the sequence. Remaining Radotín source offset and fallback profile shifts are limitations requiring integrated validation, not full-recovery claims.

Parent accepts parking/fetch sequence `376a71d`, evidence `fac44d3`, design `28cf9bb`, graph guard `7de0db8`, HTTP guard merge `c020b48`, binary validation `6959e41`. Independent rechecks found no remaining issues after graph omission correction;21 layout probes and real binary samples passed. Parent accepts tests-only `cc908cb` after inspecting its strict subprocess assertions; two baseline mock failures are corrected without production changes.

Do not integrate plain-support pilot `fcf611d`: rollout withheld due source conflicts and up to8.15m candidate changes. It is an inspectable experiment with game loading unchanged. All live work retains09:00/<50% limits.

## Acceptance and blocker at 04:40 UTC

Combined checkpoint `c42b93e` found a blocking Mrázovka regression in harmonic propagation: a mixed bridge/tunnel component includes a non-finite out-of-region anchor and loses tunnel depth. The author is correcting domain selection; integration map is NOT approved overall until regenerated and checked. Old map/source snapshots are preserved.

Accept `35f3f4` seam-only source fix after independent pre-pilot application,11 new tests,46 focused tests,25-tile replay and20 order permutations. It requires no plain-support pilot. Accept seasonal birds `2ac779d`, picker `6d05bc0`, taxi controls `af8aa0f`, and docs index `d9e9ea1` after independent reviews and recorded UI/CPU evidence. Taxi Czech runtime remains unverified, though CPU language handling passes.

Accept ambulance fix `9b56630` with native replay evidence `048f942`: independent CPU review found no introduced blocker and verified no timeout/distant-treatment shortcut; native warmed scene treated and returned crew. Pre-existing stretcher collision/arrival variability remains. Scenario-isolation implementation `7488703` is awaiting a small documentation correction before integration.

## CPU checkpoint at 04:50 UTC

Combined checkpoint `74a9c9e` passes build, relevant JavaScript checks and100 Python tests. No map rebuild was performed; the current map remains blocked by Mrázovka until tunnel-domain correction.

Accept scenario isolation `7488703` with docs correction `7a4397f`: independent CPU review found no implementation blocker, and documentation now correctly states preparation's clock/actor side effects. Author's ordered/standalone runtime checks pass without weakened assertions. Whole-suite results must be rerun before any all-green claim.

## Tunnel correction accepted at 05:30 UTC

Accept `9d84cbdd16f751de8aa142b78695d95ae64fcd5a` after independent source/export review:32 tests and runtime decoder fixture pass on integration dependencies without the withheld pilot. Mixed/tunnel/nonfinite-anchor components preserve legacy propagation; complete finite bridge components retain harmonic gains. Radotín controls remain bit-identical.

User explicitly reaffirmed intentional near-surface tunnel removal. `drop_shallow` and cover policy are unchanged; independent shallow fixture remains dropped below the existing2.5m threshold. Deep Mrázovka fixture restores199.4m at80% and adjoining bridge204.060585m at95%; old60% unknown remains. Map blocker is not closed until strict regeneration and native replay confirm this on final integration.


## Final handoff at 06:50 UTC

Final corrective validation is recorded in a141097. The independently reviewed tunnel correction passed strict 234-tile generation and native source-identified gates; shallow removal remains 2.5 m. Build, 107 Python tests and focused checks pass. One final broad scene run on unchanged source/map passed 13/15; lamp-impact uncertainty and the tow fixture distance premise are documented without suppressing failures. Consolidated results are in docs/overnight-results-2026-10-03.md.

All seven worker threads are idle with completed turns. No GPU/heavy lock remains; only integration 5204 remains listening among the overnight dev/scene ports. Main remains at b3c22d5; unrelated 10-line todo.md changes in main were observed and left untouched. No push, merge to main or deployment occurred. The optional plain-support pilot remains unintegrated. Latest weekly quota: 82% remaining. No new implementation work will start before the scheduled cutoff; final scheduled closeout will pause this heartbeat.

## Resumed wrap-up: tow fixture accepted

The user authorized targeted wrap-up after the original cutoff. The50% weekly-quota stop remains active; no new features are in scope. Fresh lamp-final-wrap and tow-fixture-wrapup worktrees preserve the completed overnight baseline46b1f3e.

Accept tow fixture5c47580 after independent review and parent diff inspection: production cleanup is unchanged, actual near/far eligibility is asserted, unrelated600m culling is excluded, original90-second removal/retention assertions remain, and three immutable focused replays pass. Historical13/15 evidence remains intact. Lamp failure is now traced to a tram collision omitted by test setup clearance; its correction is pending.

## Resumed wrap-up: lamp fixture accepted

Accept lamp fixture 2cc627f after independent review and parent diff inspection. A predecessor replay identifies immediate tram-body collision omitted by setup clearance; the helper now checks native car/tram circles without changing gameplay collision code or the original post-down/10–45 km/h assertions. CPU negative controls and standalone/ordered scene checks pass. Exact original full-suite tram/post identity remains unrecorded; this is not an identical-world replay claim. Tow fixture is already accepted and integrated. One combined confirmation remains before closeout.


## Wrap-up completion

Both independently reviewed fixture corrections are integrated through edbf011.
The single final normal-order confirmation passes 15/15 scenarios with unchanged
source/map fingerprints, no reported page/console errors, and passing typecheck
plus lamp/tow/scenario-start CPU checks. Historical 13/15 evidence is preserved;
production collision/towing rules and original assertions were not weakened.

All wrap-up workers are idle with completed turns, owned scene browsers/locks are
closed, and only integration 5204 remains running among the wrap-up ports. The
handoff is updated; no new features or map rebuild occurred during this closeout.
Main, deployment and shared data remain untouched by this effort. Known Kampa
sampler and withheld pilot limits remain separate. Latest weekly quota: 79%
remaining. The coordinator is paused after this completed wrap-up.
