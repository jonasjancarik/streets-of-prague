---
read_when: Changing how pedestrians are simulated or drawn (src/people.ts, src/figures.ts), adding code that reads or changes crowd.people, adding another worker, or moving other simulation off the main thread.
---

# Plan 019: Move the crowd into a worker

The main thread, not the GPU, limits the frame on WebGPU (`todo.md`, 30 September
2026), and the crowd's `spot` / `follow` / `avoid` lead what is left of its profile.
Walk the pedestrians in a worker of their own, and leave on the main thread only
what has to meet the rest of the game: who exists, what hits them, and drawing them.

## Status and starting point

- Status: PLANNED.
- Priority: P1. Effort: five to eight days. Risk: medium to high (the crowd is read
  and changed from many places in `main.ts`, and results arrive a frame late).
- Category: performance (main-thread time per simulation step).
  Dependencies: none. Touches `src/main.ts`, as plans 016 and 018 do.
- Planned at: `1e1119a13d09179f2d0f035059c39678c2ed783a`, 1 October 2026, from reading
  the code only. Nothing was run or measured while planning.
- Confidence: high that the walking itself leaves the main thread; unknown how much
  of the frame that is on a phone, and how much the work that stays (hash, collisions,
  matrices) costs. Step 1 measures both.

Before editing run `git status --short` and:

```sh
git diff --stat 1e1119a13d09179f2d0f035059c39678c2ed783a..HEAD -- src/people.ts src/figures.ts src/passengers.ts src/main.ts src/network.ts src/contracts.ts src/testkit.ts
```

Branch changes, commits, pushes and deployment need separate authorization.

## Current state

- `Crowd` in `src/people.ts` holds up to `PEOPLE = 1200` `Pedestrian` objects and does
  everything: the roster (`add`, `retire`, `spawnAt`, `place`), the walking
  (`update` → `follow`, `spot`, `avoid`, `turn`, `nearest`), the animation (`Anim` from
  `src/figures.ts`) and the drawing (`render` → `Figures`).
- `simulate()` in `src/main.ts` runs one or more steps a frame (line 1607) and calls
  `crowd.update(dt, threats, carsOnly, seen)` synchronously in each.
- What the walking reads:
  - the footpath graph (`WalkGraph`: edges with a `Polyline`, `side`, `width`, `busy`;
    `adj`), which only grows, through `world.onEdges` → `crowd.index(w)`;
  - the collision grid, `world.grid.at(x, y)`: each tile's `Grid.cells` (2 cells a
    metre, 250 m tiles, so 250 KB a tile), with a bridge level above turning a blocked
    cell free. The cells are written only in `src/tileWorker.ts`, never on the main
    thread after a tile arrives;
  - `footfall.pull(e)` in `turn()`, a fixed number for each edge;
  - `threats`: the player's car and other cars faster than 5 m/s;
  - `carsOnly(x, y, 5)`: the circles of cars near a walker, of which `avoid()` uses
    only those standing still (`|vx| + |vy| ≤ 0.5`), and their height `z` against the
    walker's `gz`;
  - the shared seeded random stream `this.r`.
- What the rest of the game does with people, all on `crowd.people` directly:
  - `main.ts` 1229: adds some to the obstacle `hash` (position, velocity, `gz`, and
    `p.e.side === 0`);
  - `main.ts` 1380–1394: `offTrams(p, …)` and `bump(p, …)` push people out of trams
    and cars (changing `p.x`, `p.y`) and knock them over;
  - `main.ts` 538, 613, 1031–1032, 1203–1205: `scare` and `knock` from guns, the
    explosion and the water cannon;
  - `main.ts` 396–421 (`scatterPeople`): retires, re-places and adds people, picking
    spots with `pickPerson` on the main thread;
  - `main.ts` 756 and `src/passengers.ts`: `spawnAt()` returns a person who is changed
    in the same breath (`knock`, or `Object.assign(p, { state: 'flee', … })`);
    passengers also read `p.state`, `p.x`, set `p.t`, test `people.includes(p)` and
    `retire`;
  - `main.ts` 1635: `crowd.render(ground, seen)`, where `ground(x, y, p)` is
    `world.groundFor(p, …)` and keeps the bridge level and `gz` on `p`;
  - `scripts/bench.mjs` and `src/testkit.ts` read `crowd.people.length`.
- Scenarios (`scenarios/*.ts`, `scripts/scene.mjs`) step the game with
  `t.simulate(dt)` and expect the world to have moved when it returns.
- Tile workers (`src/tileWorkers.ts`) already take up to three threads, fewer on
  machines with few cores.

## Design

### Three parts

1. **`CrowdSim`** (new `src/crowdSim.ts`): the walking and the animation clock, with
   no three.js and no DOM. State in typed arrays indexed by slot. It imports only
   `Polyline`, `clamp`, `segDist` from `src/network.ts` and the animation logic.
2. **`Crowd`** (stays in `src/people.ts`): the main thread's side. It owns the roster
   (which slots are alive, each one's look), a mirror of every person as the last
   result described them, the queue of commands, and the drawing.
3. **A transport**, chosen at start-up:
   - *worker*: `src/crowdWorker.ts` runs a `CrowdSim`; messages go by `postMessage`
     with transferred buffers;
   - *inline*: the same `CrowdSim` called directly, in the same step. Scenarios,
     `t.simulate()`, `?crowd=inline` and any browser where the worker fails to start
     use this. Both transports take the same commands and give the same result
     layout, so everything above them is written once.

### Who owns what

The main thread owns existence, the worker owns movement.

- Slots are stable: a retired slot goes on a free list and is reused, in place of
  today's swap with the last person. `Figures`' wardrobe is already kept by person,
  so looks need no change. The mirror is an array by slot with an `alive` flag;
  `crowd.people` becomes a getter over the live ones for existing loops.
- `add`, `spawnAt`, `place`, `retire`, `knock`, `scare`, a push from `bump` or
  `offTrams`, and the two places that set fields directly (`passengers.ts`) become
  **commands**. Each is applied to the mirror at once, so the caller sees its effect
  in the same step, and is queued for the simulation, which applies the queue in
  order before its next step.
- Every command gets a sequence number. A result carries the number of the last
  command it included; for a slot changed by a later command the main thread keeps
  its own mirror values and ignores that row. This is what stops a person who was
  just knocked over from standing up again for one frame.
- `spawnAt` needs `nearest()`; the main thread keeps its own copy of the segment
  index for that (it has the graph anyway), or the command carries only `x, y` and
  the simulation finds the edge. Prefer the second, and drop `index`/`nearest` from
  the main side if nothing else calls them.

### What goes to the simulation

Once, at start: the clip table (`kit.clips`, plain numbers), the seed for its own
random stream, the constants.

As tiles come and go:
- new walk edges: `id`, `u`, `v`, `pts`, `width`, `side`, and `pull` already worked
  out by `footfall.pull(e)`; the simulation builds its own `Polyline`s and adjacency;
- a tile's walk cells: a copy of `grid.cells` with the bridge rule of `world.grid.at`
  already applied (a blocked cell under a level above 0 becomes free), transferred;
  and a note when the tile is unloaded. A missing tile reads as 255, as now.

Every frame, in one message: the total `dt` and the number of steps, the commands,
the threats (`x, y, vx, vy`), the view (centre and radius, for `seen`), the circles
of standing cars within reach of the view (`x, y, z, r`; from `resting` and the
standing ones in `carHash`), and `gz` for the people drawn last frame.

### What comes back

One buffer, reused back and forth by transfer:
- for every live slot: `x, y, h, vx, vy, t`, `state`, and whether its edge has
  `side === 0` (the `hash` test);
- for those in view: `z` (the jump) and the two animation rows that `Anim.write`
  produces today (the sleeves flag stays on the main side).

`Crowd.render` then composes matrices from the mirror and the ground height, as now,
and copies the animation rows into the instance attributes.

### Timing

- One message is in flight at a time. If the answer to the last one hasn't arrived
  when a frame begins, the main thread adds this frame's `dt` and commands to what it
  will send next (capped at a tenth of a second), and draws from the mirror.
- People are therefore drawn, hashed and hit where they were up to one frame ago.
  The mirror moves each walking person on by `v × dt` between results so the drawing
  stays smooth and traffic's view of them doesn't jump.
- A paused world or a clock held by the bench sends nothing.
- The inline transport has no delay: `t.simulate()` and scenario results stay exact.

### Random numbers

The simulation gets a stream of its own, seeded from `seeded` at start. The main
thread keeps using `seeded` for spawning. The order of numbers drawn elsewhere in the
game changes once, so scenario baselines that depend on it need re-recording; with
the inline transport they are repeatable afterwards.

## Scope

In scope: `src/people.ts`, new `src/crowdSim.ts` and `src/crowdWorker.ts`,
`src/figures.ts` (animation rows written to a plain array), `src/contracts.ts`
(message types), `src/passengers.ts`, the crowd's call sites in `src/main.ts`,
`src/tiles.ts` only to hand out a tile's walk cells and its unloading,
`src/testkit.ts`, `scripts/bench.mjs` (the people count), a new
`scripts/check-crowd-worker.mjs`, one new scenario, `README.md`, `todo.md`, the
performance and scene-testing skills where they describe the crowd, this plan and
its row.

Out of scope: the player's `Walker`, police officers, the fire brigade's crew, the
inspector, traffic and trams; `SharedArrayBuffer` (it needs cross-origin isolation,
which the Turnstile widget on the forms may not survive); how the crowd looks or
behaves; the number of people.

## Implementation steps

### 1. Measure what there is to gain

With measurement authorized, on `stand` and `drive` at a busy place (Old Town
Square) and a quiet one, at 1× and with `--cpu 4`, and on the Pixel 5:

```sh
node scripts/bench.mjs --profile --cpu 4
```

Record the self time of `Crowd.update` and what it calls, against the whole
main-thread time of a frame. Then bound the gain with `--ab`, switching the call to
`crowd.update` off (people freeze; hash, collisions and drawing still run): that
frame time is the best this plan can reach.

Record separately what stays behind: the `hash` loop over people, the collision loop
at 1380, and `crowd.render`.

**Stop here** if freezing the crowd changes the median frame by less than about 5%
at the busy place on both machines. Record the numbers and close the plan.

### 2. Split the walking from the roster and the drawing, on the main thread

Make `CrowdSim`, the command queue, the stable slots and the mirror, with only the
inline transport. `Anim` gains a way to write its rows into a `Float32Array`; the
crowd's `Anim`s live in the simulation. Convert every call site listed under
"Current state" to commands or mirror reads. `crowd.update(...)` becomes "send this
step", `crowd.render(...)` reads the mirror.

Behaviour must match today's apart from the random stream.

**Verify:** `npm run typecheck`; `node scripts/scene.mjs run all`; by eye at Old Town
Square: walking, stepping round parked cars, fleeing a fast car, being knocked over
and getting up, a gunshot scattering people, passengers boarding and leaving a tram,
the rider thrown off a stolen bike. Compare frame time with step 1's baseline: the
typed arrays must not be slower.

### 3. Feed the simulation its world by messages

Still inline, but through the same messages the worker will get: edges as they load
(with `pull`), walk cells per tile and their unloading, standing-car circles, threats,
the view, `gz`. Remove `CrowdSim`'s direct references to `world`, `footfall`,
`carsOnly` and `offscreen`.

**Verify:** as step 2. Add `scripts/check-crowd-worker.mjs`: build a small graph and
grid, run the same commands through the old lookups and the message-fed ones, and
compare positions after a few hundred steps.

### 4. Run it in a worker

Add `src/crowdWorker.ts` and the worker transport: one message in flight, the reused
buffers, the sequence numbers, the mirror's carry-forward between results, the cap
on saved-up time. Fall back to inline if the worker can't be made or reports an
error, and with `?crowd=inline`. The test kit and `scripts/scene.mjs` use inline
unless asked otherwise.

**Verify:** the checks of step 2 in a normal browser session (worker transport); one
new scenario that runs on the worker transport and waits for results: a person
knocked over stays down, a retired person doesn't reappear, a person spawned and
knocked in the same step is lying down in the next result. No console errors over a
ten-minute drive across tile loads and unloads.

### 5. Measure and decide

Repeat step 1's runs against the build before step 2, alternating (`--vs`, see the
performance skill), on the M5 at 1× and `--cpu 4` and on the Pixel 5. Report the
main-thread time removed, the time the message handling adds, the worker's own step
time, and how often a frame began with no answer yet.

Keep the worker as the default only if the median frame improves beyond the noise on
at least one of the machines and regresses on neither. Otherwise leave inline as the
default, keep the split (it is what any later move needs), and say so in the Result.

## Regression cases

- A person knocked, scared, pushed or retired never shows their earlier state again.
- A slot reused within a frame of being retired takes the new person's look and place.
- Passengers still board at the nearest door and vanish; those getting off appear at
  the doors and walk away.
- People don't walk through buildings after a tile loads, and stop being simulated
  into a tile that has unloaded.
- On a bridge and under it: walkers ignore cars on the other level.
- Pausing in the developer panel, the fast-forward while waiting for a tram, and the
  metro (when the street waits) leave people where they were.
- A background tab that returns after a minute doesn't fling people forward.
- Saving and loading a game, and a teleport from the test kit, give a sensible crowd
  at once (`scatterPeople(false)`).

## Risks and open questions

- **What stays may be much of the cost.** The hash, the collisions and the matrices
  for people still run on the main thread. Step 1 says how much.
- **One frame late.** A car can overlap a person for a frame before the push shows.
  If it reads badly, apply pushes to the mirror at once (already planned) and check
  whether threats need the car's position carried forward by a frame.
- **Standing cars each frame.** Sending every resting car near the view each frame
  may cost more than it saves. Send the resting set only when `syncResting` reports
  a change, and the few standing movers each frame.
- **One more thread** on phones with four cores, beside the tile workers. Check
  tile arrival times on the Pixel 5 before and after.
- **Other code that reaches into people.** Search again for `crowd.` and
  `Pedestrian` before step 2; anything added since this plan was written needs the
  same treatment.

## Result

Not started.
