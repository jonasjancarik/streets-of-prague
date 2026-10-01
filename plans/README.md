# Implementation plans

| Plan | Scope | Status |
| --- | --- | --- |
| [001: Transition to TypeScript](001-transition-to-typescript.md) | Browser `src/`, entry page, compiler gate, documentation | DONE (local) |
| [002: Money](002-money.md) | 10 000 Kč wallet, paid taxis, PID tickets, an inspector who chases you, shared bikes, HUD | PLANNED |
| [003: Cloudflare deploy](003-cloudflare-deploy.md) | App as a Worker with static assets, map data in R2, mbxp kept alongside | PLANNED |
| [004: Missions and factions](004-missions-and-factions.md) | Mission engine and odd jobs, factions with reputation and turf, story missions; several questions still open | PLANNED (open questions) |
| [005: Roofs and colours from the photo mesh](005-roofs-and-colours-from-the-photo-mesh.md) | Real wall and roof colours and roof materials measured from IPR's photo mesh, mansards with windows, detected roof windows, dormers and chimneys | PLANNED |
| [006: Firefighters](006-firefighters.md) | Fire engines called to burning cars, crews putting out wrecks, blue lights and sirens, traffic giving way, the player's water cannon, a firefighter job | PHASES 1–3 DONE (the job waits for plan 004) |
| [013: Fill the beige ground](013-fill-the-beige-ground.md) | Squares' surfaces from OSM, an asphalt-grey pavement palette, and DTM courtyards and green | PHASES 0–3 DONE (main and shared local tiles; photo classification is plan 014) |
| [014: Identify courtyard surfaces](014-classify-courtyard-surfaces.md) | Deferred photo classification within DTM courtyard outlines | PLANNED |

Plans 001–006 were indexed from `c6b5350`. Check the working tree and each plan's
starting revision before implementation; preserve unrelated changes.

## Driving stutter

These six steps were planned through source inspection at
`5162c1fcf11e51df8ceda46049cac217fc7a12cd` on 30 September 2026. No implementation,
asset conversion, runtime check or new measurement was performed while writing them.
Each file is a self-contained handoff with current-code excerpts, scope, ordered
implementation steps, regression cases, future verification commands and stop conditions.

| Step | Plan | Priority | Estimated effort | Status |
| --- | --- | --- | --- | --- |
| 1 | [007: Share building and lighting shader graphs](007-share-building-shader-graphs.md) | P1 | About a day | DONE (main; timing benefit inconclusive) |
| 2 | [008: Prepare and retain car meshes](008-prepare-car-meshes.md) | P1 | One to two days | DONE (main; timing benefit inconclusive) |
| 3 | [009: Reuse spatial tree batches](009-reuse-tree-batches.md) | P1 | Several days | DONE (main; timing inconclusive) |
| 4 | [010: Bake landmark colour adjustments into assets](010-prebake-landmark-colours.md) | P2 | One to two days plus asset checks | DONE (main code and isolated assets; shared data/deployment pending, timing inconclusive) |
| 5 | [011: Reuse spawn weights and pavement-traffic lookups](011-reuse-spawn-sampling.md) | P2 | About a day | DONE (main; timing benefit inconclusive) |
| 6 | [012: Schedule streaming and update parked-car collisions](012-schedule-streaming-and-update-collisions.md) | P2 | Several days | VERIFIED locally; Part A accepted for main, Part B held (desktop regression) |

### Order and dependencies

Execute in the order shown. These are not strict functional dependencies: each
optimization can be understood and implemented independently. The order puts
smaller shader-related changes before tree ownership changes, then addresses
location-specific loads and remaining simulation/streaming work. Compare each step
with the state immediately before it, so improvements from earlier steps do not
hide a later regression.

Several plans edit `src/main.ts` or `src/tiles.ts`; do not apply their excerpts as
whole-file replacements. In particular, retain the current tram-driving and fare
work. Plan 007's shared lamp-light wrapper affects later rendering checks. Plan 010
must reconcile any implementation of plan 005's colour work, and it has a separate
asset-migration outcome: code completion does not mean shared or deployed map data
has been converted. Plan 012 has two separately verified parts, streaming then the
resting-car index.

The plans do not authorize delegation. If work is explicitly assigned to separate
people or agents, give each the corresponding plan and coordinate shared-file edits.
No new dependencies, renderer downgrade, visual-quality reduction or deployment is
part of this sequence.

### Verification and status

Runtime commands in the plans are for later authorized implementation. They were
checked against the repository's scripts by reading them, not executed. Commands
for new regression scripts are explicitly labelled as proposed implementation
work. The package currently has `typecheck` and `build`, but no general npm test,
lint or docs-list script.

Use the existing performance skill for stable snapshots, alternating comparisons,
Chrome/WebGPU checks and generated-data handling. Inspect images and console errors
before trusting a faster frame: a missing object is not an optimization. Report
shader-build/operation counts separately from observed timing changes, and do not
claim a timing benefit when the comparison is inconclusive.

Executors should update their row to IN PROGRESS, DONE, or BLOCKED with a short
reason. Record the implementation revision, exact verification commands, relevant
device/settings, results, visual checks and residual limitations in the plan's
Result section. For plan 010 also state whether assets are only staged, active in
shared local data, or deployed. Commit/branch/push/deploy actions still require the
operator's separate authorization.

### Considered and deferred

- **Auto graphics material disposal:** it refreshes stale shadow-texture bindings.
  Removing it is not a safe optimization without a verified replacement; these
  plans retain it and use fixed graphics tiers for comparisons.
- **Police route searches:** conditional on pursuits, with existing retry limits;
  investigate if residual pauses correlate with chases rather than general driving.
- **Street graph pruning:** relevant to long sessions, but must preserve active
  routes and is outside this six-step effort.
- **Moving parking into workers:** previous repository results found relatively
  little main-thread cost; it is not a leading target for these hitches.
- **Lower tree density or simpler surface/roof shaders:** changes the look and is
  not required to remove repeated setup work.
- **Per-instance car paint, parked-car render-transform caching, broad object
  pooling and offline sky baking:** possible follow-ups, not part of this scope.
- **Staggering the life tick:** reconsider only if the narrower step-5 changes leave
  a measured burst; scheduling changes must not alter population or accounting.

Merge findings for plans 007–012 are recorded in
[the summary](../docs/optimisation-findings-007-012.md). Implementation completion
does not imply that every experiment is recommended for main.
