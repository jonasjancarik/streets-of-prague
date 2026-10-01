---
read_when: Implementing step 5 of the driving-stutter work, or changing pedestrian and traffic replenishment.
---

# Plan 011: Reuse spawn weights and pavement-traffic lookups

This is step 5 of the driving-stutter work. Remove repeated calculations within one spawn pass and repeated scans of ordinary traffic for each pedestrian. Keep the city's population, distributions, reactions and simulation timing unchanged in the first implementation.

## Status and starting point

- Status: DONE locally; operation reduction verified, frame-time benefit inconclusive.
- Priority: P2. Effort: about a day. Risk: low–medium.
- Category: performance. Dependencies: none technically; run after the rendering steps so residual simulation work is easier to attribute.
- Planned at: `5162c1fcf11e51df8ceda46049cac217fc7a12cd`, 2026-09-30.
- Confidence: high in redundant work; medium that these paths explain visible hitches on the user's device.

Before editing run `git status --short` and:

```sh
git diff --stat 5162c1fcf11e51df8ceda46049cac217fc7a12cd..HEAD -- src/main.ts src/traffic.ts src/spawn.ts scripts/check-spawn-work.mjs scripts/bench-stalls.js
```

Reconcile preceding-plan changes, preserve current tram-driving/fare behaviour, and stop if population or RNG semantics have changed in ways not covered below. Branch changes, commits, pushes and deployment need separate authorization.

## Current state and conventions

This is an npm/Vite/strict-TypeScript game with three.js rendering. Read `.agents/skills/performance/SKILL.md`, particularly the warning that reducing the crowd simulation radius previously reduced the number of visible people. This plan does not reduce that radius or the population.

`src/main.ts:339–349` constructs pedestrian spawn weights for every pick:

```ts
let total = 0;
const upTo = edges.map((e) => (total += e.path.length * footfall.pull(e)));
for (let t = 0; t < 8; t++) {
  const x = seeded() * total;
  let lo = 0, hi = upTo.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (upTo[mid] < x) lo = mid + 1; else hi = mid; }
  const e = edges[lo], s = seeded() * e.path.length, at = e.path.at(s);
  if (!ok || ok(at.x, at.y)) return { e, s };
}
```

`scatterPeople()` at 354–374 repeatedly calls it over the same `edges` array. It caps additions/retirements at 20 during play, but not relocation of existing distant people. It runs on the half-second life tick at 1288–1316 together with parked bikes and shared-bike accounting. Startup and teleports also call `scatterPeople(false)` and need immediate full placement.

`Footfall.edge()` caches a street's busyness (`src/footfall.ts:88–102`), but `pull()` still computes its exponent and `pickSpot()` repeatedly reconstructs the cumulative sum. Reusing the table within a pass avoids both repeated work and cross-pass invalidation complexity.

`Traffic.spawn()` in `src/traffic.ts:108–140` sums every candidate edge on each call, then linearly selects an edge on up to 40 attempts. Main's quarter-second traffic tick calls it up to ten times over the same list (`src/main.ts:1319–1325`). Ordinary traffic weights roads differently from explicitly requested buses/taxis/police; preserve that distinction.

`Traffic.pavementNear()` at 181–184 scans all agents:

```ts
return this.agents.some((a) => a.kerb && Math.abs(a.car.x - x) < d && Math.abs(a.car.y - y) < d);
```

`src/main.ts:1059` calls it for qualifying pedestrians before `traffic.update()`. That ordering matters: the optimization must use the same pre-update positions and membership.

## Scope

In scope: `src/main.ts`, `src/traffic.ts`, optional small typed helpers in new `src/spawn.ts`, new `scripts/check-spawn-work.mjs`, narrow `traffic.spawn`/spawn-pass counters in `scripts/bench-stalls.js` and existing `window.__drive` test handles if needed; `README.md`, `todo.md`, this plan and its index row.

Do not change crowd radius/caps, footfall data or weights, traffic counts, lorry road eligibility, collision distances, route selection, live RNG order, public gameplay copy, or money/rental accounting. Do not add a general job scheduler or per-agent framework. Broad allocation pooling and collision-index changes belong elsewhere. Do not promise to make traffic spawning free: geometry, overlap checks and routes still cost work.

## Implementation steps

### 1. Characterize the existing selections before replacing them

Create `scripts/check-spawn-work.mjs` following `scripts/check-graphics.mjs`'s browser-eval runner and failure handling. Support `--url` and `--case people|traffic|pavement|all`. Import helpers through Vite instead of installing a TypeScript test runner. For selection tests, keep a small reference implementation of the old selection loops inside the test and feed both implementations identical deterministic random values and rejection results.

Test empty candidates, one edge, unequal weights, rejected positions, exact cumulative boundaries, and exhaustion of eight/forty attempts. The two existing selectors have different equality rules: people use the first cumulative value >= the target, while traffic's subtract-and-`< 0` loop uses the first strictly greater cumulative value. Preserve these rules and the number/order of RNG calls. Do not fix an unrelated distribution edge case as part of an optimization.

**Verify:** `node --check scripts/check-spawn-work.mjs` passes. As helpers are added, each named case must prove identical selected edge IDs/positions and random-call counts against the reference. No assumed speedup is needed to establish correctness.

### 2. Prepare the pedestrian distribution once per pass

Move cumulative-weight construction out of `pickSpot()` into `scatterPeople()` immediately after the candidate list is chosen. Pass an immutable-per-pass sampler to every relocation/addition pick. Do not retain the table across half-second passes yet: the player, view radius and available streets can change, and a pass-local cache has no stale-data problem.

Keep the rejection callback live for each trial and keep the existing eight-attempt limit. Preserve retirement/relocation/addition ordering, initial population and `scatterPeople(false)` behaviour. The helper may live in `src/spawn.ts` if that makes it directly testable; avoid importing all of `main.ts` from tests.

**Verify:** `npm run typecheck` and `node scripts/check-spawn-work.mjs --url http://localhost:5191/ --case people` pass. Count weight-function calls: for E candidate edges and any number of picks within that pass, table construction calls it E times, not E times per pick. The reference/new selected positions and final RNG state match.

### 3. Reuse traffic distributions within a replenishment pass

Prepare a weighted traffic sampler once for the candidate edge list and explicit selection mode. Extend `Traffic.spawn()` with an optional prepared sampler, retaining a correct fallback for callers that spawn a single car. Main's up-to-ten-car loop should pass one ordinary-traffic sampler. If bus spawning uses a different candidate list or weight rule, it must use its own sampler or the existing fallback.

Preserve the exact total accumulation order, 40 attempts, vehicle-type/random draws, occupancy checks and eligibility rules. A cached sampler must not capture the agent list: each successful spawn immediately participates in the overlap check for subsequent spawns. Leave `agents.some()` in place initially; replacing it with a second spatial index is not necessary to remove repeated edge scans.

A prefix-sum search can differ from repeated subtraction by floating-point rounding near a cumulative threshold, even with the right equality operator. Include such fixtures in the reference tests. If needed, retain a rare old-order subtraction fallback using cached weights for numerically ambiguous targets; do not accept a seeded-selection difference merely because the distributions look similar.

**Verify:** `npm run typecheck` and the `--case traffic` test pass for ordinary and explicit-type weights, multiple successive spawns, failed attempts and a candidate-list change. Compare full outcomes/RNG state with the old reference, including newly spawned cars blocking later attempts. The edge-weight computation count is once per prepared list/mode.

### 4. Gather pavement-driving agents once per simulation step

Add a reusable list in `Traffic`, filled once just before main iterates pedestrians to build obstacles. Scan `agents` for those with `kerb`, and have `pavementNear()` examine only that subset while retaining the original square-distance test and live car coordinates. Do not gather after `traffic.update()`: that would change the snapshot used by the existing code.

Rebuild the subset each simulation substep, including fast-forwarded tram/taxi rides. A persistent subset maintained only by `adopt()`/`release()` is more fragile because kerb completion, gone-agent filtering and other transitions also remove eligibility. The one-scan-per-step design is sufficient here.

**Verify:** `npm run typecheck` and the `--case pavement` test pass. For scripted adopt, release, kerb completion and successive-substep cases, compare every query with the original `agents.some()` result. With A agents and P queries, gathering visits A once; queries inspect only the K kerb agents, including the K=0 case.

### 5. Compare periodic work without changing its timing

Extend stall attribution only enough to count/time `Traffic.spawn()` and the pedestrian preparation pass. Main's spawn helpers are closures, so a read-only development hook or a small typed helper is needed to inspect them; do not turn the whole main loop into a framework. Report simulation cost and operation counts as well as long tasks.

```sh
node scripts/check-spawn-work.mjs --url http://localhost:5191/ --case all
node scripts/bench.mjs --url http://localhost:5191/ --vs http://localhost:5192/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu
```

Expected: checks pass with equivalent behaviour and fewer repeated weight/agent visits. Record the controlled comparison's spawn/update times, long tasks, and p95/p99. Confirm population counts and ordinary traffic continue replenishing while driving; check off-screen relocations, pedestrians reacting to pavement cars, and fast-forwarded rides. No visible density reduction may be counted as a performance gain.

Spreading the half-second jobs across frames is a possible follow-up, not an automatic addition to this step. It changes event/RNG ordering and can delay replenishment. Only propose it if these narrower changes leave a measured burst; keep rental fees, ticket/accounting work and startup/teleport placement out of that proposal.

**Verify:** `npm run build` and `git diff --check` pass. Document the reductions in repeated operations and any measured timing effect separately. Update the plan/index and the relevant performance note.

## Execution environment

Existing gates are `npm run typecheck` and `npm run build`; no npm test/lint/docs-list script exists. The new focused browser runner uses the existing Chrome/Playwright setup from `scripts/bench.mjs` and `scripts/check-graphics.mjs`, through `PLAYWRIGHT_PATH` if necessary, without new dependencies.

Use candidate/baseline URLs on ports 5191/5192 only after checking ownership. Start `npm run dev` or `PORT=5192 npm run dev` in the respective stable checkouts during authorized execution, following the user's PortPilot and access-URL requirements. Read generated `public/data` without changing it. Keep each timed snapshot unchanged and alternate runs; CPU throttling affects the main thread, not workers. A single faster drive is not proof.

## Done criteria and stop conditions

- [ ] Deterministic reference comparisons preserve selections, rejection limits and RNG consumption.
- [ ] People/traffic distributions are prepared once per candidate list and mode within each pass.
- [ ] Pavement queries agree with the pre-update reference at every tested simulation substep.
- [ ] No crowd/traffic reduction or new on-screen popping; rendering and game rules are unchanged.
- [ ] Focused checks, typecheck/build, scope review and documentation pass; timing uncertainty is reported.

Stop if an optimization changes the seeded results, requires indexing all dynamic agents in another system, or depends on changing the life-tick cadence. An apparent speedup accompanied by fewer visible people or fewer successful traffic spawns is a failed result.

Maintain pass-local sampler ownership. If future work caches across passes, its key must include candidate membership and weight mode, not just the player's tile. Any movement of the pavement-subset refresh must preserve its position before pedestrian obstacle collection.

## Result

Implemented from `a3032fbf44451e97a9e13248af6c5cb4a17844f7` in local commits
`a348b3d` and `51710bc`.
`src/spawn.ts` keeps the old pedestrian cumulative comparison and traffic's
subtraction loop, with weights prepared once per pass/list. Main refreshes the
kerb-agent subset before each pedestrian-obstacle collection. The initial traffic
placement also reuses one prepared list. No radius, cap, count, route, or clock rule
was changed.

Checks: `node --check scripts/check-spawn-work.mjs`,
`node scripts/check-spawn-work.mjs --url http://localhost:5241/ --case all`,
`npm run typecheck`, `npm run build`, and `git diff --check` pass. The browser
fixtures compare 54 pedestrian selections and 56 traffic selections, plus
successive spawns, 8/40 rejection exhaustion, exact cumulative boundaries and
RNG counts. The actual `Traffic.spawn()` bus rejection case uses 80 draws for
40 attempts in both versions. Six pedestrian picks use one three-edge weight
build instead of six. During a 40-second drive, 78–80 people passes prepared
40,530–41,579 edge weights for 460–479 picks; the old loop rebuilt the weights
for every pick. Traffic weights are computed once per prepared list/mode and
cached through its 40 attempts. Its cached subtraction order matches the old
loop, including floating-point boundary fixtures.
The pavement fixtures cover empty lists, adopt, release, kerb completion and
successive substeps. In the real game, six manual simulation substeps rebuilt
the subset six times; 173 qualifying pedestrian queries included one positive
kerb-car hit and had zero mismatches against the original all-agent scan.

The candidate and baseline both loaded at Old Town Square with 1,200 people
and 41 traffic agents, and both had 1,200/40 after the same short drive. A
teleport to Petřín immediately placed 223 people on both versions; traffic
replenished afterward. Overlay-free screenshots at both sites showed comparable
visible density, with no new popping observed. Captures are under
`/tmp/streets-011-scenes/plan011-{candidate,baseline}-{clear,petrin}.png`.
Map data was copied to this worktree for serving; the shared source and its
manifests were not modified. There is no asset migration in this plan.

Two alternating comparisons used an Apple M5 MacBook Air (32 GB), Chrome
WebGPU, High, 14:00 clear, DPR 1, CPU throttle 4, 40-second drives, three
baseline/candidate pairs each, fresh browser, loading frames and stall counters.
The exact command was:

```sh
node scripts/bench.mjs --url http://localhost:5241/ --vs http://localhost:5246/ --scenes drive --seconds 40 --dpr 1 --cpu 4 --graphics high --time 14:00 --weather clear --stalls --runs 3 --fresh-browser --loading-frames --require-webgpu
```

The first series averaged 11.9 → 12.9 ms/frame (baseline → candidate);
long-task counts were 5/10/7 → 34/6/5 and p99 frames were
30.9/34.4/32.3 → 61.1/32.1/29.6 ms. The second averaged 13.0 → 11.5
ms/frame; long tasks were 13/13/4 → 5/6/8, p95 frames
30.8/28.1/21.0 → 13.6/15.7/23.2 ms, and p99 frames
40.0/43.5/32.4 → 27.9/31.1/33.1 ms. There were no page errors or renderer
fallbacks, and both versions kept about 347–351 visible people and 40–41
traffic agents during the drives. The opposing series and variable shader-build
stalls make the overall frame-time benefit inconclusive.

In the second series, traffic spawning took 5.5–7.5 ms over 22–26 baseline
calls and 4.0–8.9 ms over 22–26 candidate calls, plus 1.1–1.9 ms to prepare
21–23 candidate lists. Traffic update totaled 2.09–2.17 seconds and crowd
update 2.18–2.22 seconds per baseline drive; candidate totals were
2.12–2.16 and 2.15–2.26 seconds, respectively. Calls per drive differed with
frame rate, so these totals do not isolate this optimization's effect. Detailed
logs and JSON are `/tmp/streets-011-compare{,-update}.{log,json}`.
Staggering remains deferred because it would change timing and RNG order.
