# Plan 004: Missions and factions

> An implementation plan for another agent. Planned at `e5a0187` on `main`, 2026-09-29.
> The working tree then had someone else's uncommitted work (fences, tiles, signals,
> tram stops, `src/main.ts`, `README.md` and others). Check `git status` and
> `git diff` before you start, don't revert changes you didn't make, and commit only
> your own hunks.
>
> **Several design questions are still open** (see [Open questions](#open-questions)).
> Each phase below says which questions it needs answered first. Don't settle them
> yourself: where a phase is blocked, stop and ask. Where this plan names a default,
> it's a suggestion for the user, not a decision.

## Status

- Priority: P1 (the README's "Not yet in the game" lists "something to do" first)
- Effort: L–XL overall; phase 1 alone is M (about 2 days)
- Risk: medium. The mission engine is new code with a narrow interface, but missions
  touch most systems (cars, people, police, money, tiles), and `src/main.ts` is
  shared with parallel work.
- Depends on: money (`src/money.ts`), which is in the game
- Category: gameplay feature

## Goal and scope

Give the player something to do: missions that pay, and factions that give them out,
remember what you did for them and hold parts of the city.

In four phases, each playable on its own:

1. **Mission engine and odd jobs**: a small engine for missions made of steps, a
   marker and an objective line, and two or three kinds of repeatable jobs made up
   from the map (courier, taxi driver, bring a car). The player starts earning money.
2. **Factions as data**: reputation with each faction, their parts of town, their
   people and cars in the streets, jobs offered by phone depending on reputation.
3. **Story missions and hostile factions**: written missions with conversations, and
   faction members who come after you when they don't like you.
4. **Later, only if wanted**: weapons for the player, taking over territory.

Out of scope for now: voice acting, cutscenes beyond the existing `Dialog`, new
portraits (use the 30 in `public/portraits/cast.json`), multiplayer, and anything
that needs per-place imagery (see the procedural rule in the project notes).

## Current state (what the plan relies on)

- **Conversations**: `Dialog` in `src/portraits.ts` (~line 107). `play(lines)`
  returns a promise; a `Line` has `who` (portrait id), `name`, `text` and an optional
  `objective`, shown as "New objective". It takes the keys while it's up
  (`src/main.ts` ~line 712). `?dialog` plays a sample (~line 1202).
- **Cast**: 30 portraits in `public/portraits/cast.json`: marek, clerk, driver,
  student, butcher, courier, veteran, tattooed, neighbour, drifter, rocker, conductor,
  foreman, bouncer, mechanic, barmaid, grandma, punk, inspector, hacker, boss, lawyer,
  journalist, policeman, policewoman, detective, paramedic-f, paramedic, guard,
  official.
- **A marker in the world**: the taxi's beacon (`src/taxi.ts` ~line 65: a yellow
  see-through pillar and an arrow over the taxi). It's private to `Taxi` today.
- **Named places**: `PLACES` in `src/taxi.ts` (~line 22), `[name, lon, lat]`,
  turned into local coordinates with `toLocal`. Street names for the whole area are
  in `data/<area>_now/names.json` (read by `src/dev.ts`).
- **Money**: `Wallet` in `src/money.ts`: `has(n)`, `take(n)`, `balance`, the "paid"
  flash in the HUD. Nothing adds money yet, and nothing is saved.
- **Police**: `Police.crime(kind, x, y, car?)` adds heat (`POINTS`, ~line 49);
  `stars`, `sees(x, y)`, `onBusted`. Wasted is handled in `src/main.ts` (~line 414).
- **A chaser on foot**: `Inspector` in `src/inspector.ts` appears, runs after you
  with `steer()` from `src/police.ts`, gives up, walks off and vanishes off-screen,
  and can be knocked over. Police cars chase along the street graph (`ChaseCar`,
  paths both ways along every street).
- **Parts of town**: `Districts` in `src/districts.ts` reads `districts.json`
  (cadastral areas, which cover the city without gaps) and has `inside()`.
- **People and traffic**: `Crowd` (`src/people.ts`) and `Traffic.spawn(avoid, edges,
  type)` (`src/traffic.ts` ~line 108). Looks come from `randomLook` in
  `src/figures.ts`; car kinds from `randomType`.
- **Tiles stream in and out** round the player (`src/tiles.ts`). The crowd, parked
  cars and much of the traffic belong to the tiles near you. The taxi keeps its own
  agent alive while you wait for it and ride in it.
- **Time**: the game clock, weather, tram timetables (`src/board.ts`), the metro's
  real ride times.
- **Saved in the browser today**: only settings (`sound`, `graphics`, `lang`, radio,
  help folded), each in its own `localStorage` key with `try`/`catch`.

## Design

### Mission engine (`src/missions.ts`)

A mission is data: an id, who gives it, a reward, and a list of **steps**. The engine
runs one mission at a time as a state machine over the steps, shows the current
objective in the HUD and the marker, and checks the fail conditions every frame.

Steps are small, typed primitives, for example:

| Step | Done when |
| --- | --- |
| `talk(lines)` | the conversation is over (`Dialog.play`) |
| `goTo(place, r, how?)` | you're within `r` m, on foot, in a car or either |
| `getCar(match)` | you're in a car that matches (kind, colour, a specific parked car) |
| `bring(place, r, limit?)` | you and the car or the load reach the place, in time |
| `follow(agent, far)` | the agent arrives without losing you (farther than `far` fails) |
| `lose()` | no stars, or at most `n` |
| `waitUntil(time)` | the game clock reaches it (Space fast-forwards, as at a tram stop) |
| `ride(line, stop)` | you get off the line at the stop (`src/ride.ts`, `src/metro.ts`) |

Fail conditions per mission or step: wasted, busted, time's up, the car wrecked or
burnt out, the load or the person lost, too far from the target. A failed mission
shows a red banner (`showBanner(…, true)`) and can be taken again.

Missions are TypeScript data, not JSON, so they're checked by `tsc` and their text
goes through `t()` and `src/cs.ts` like everything else. A step may be a function
of the mission's state, for places or cars picked when it starts.

**Interface with `src/main.ts`**: the engine gets a small options object (the scene,
the player's position and vehicle, `wallet`, `police`, `dialog`, `showBanner`, the
HUD line, helpers to spawn a car or a person), and main calls a few hooks:
`onEnterCar`, `onLeaveCar`, `onCrime`, `onWasted`, `onBusted`, `update(dt)`. The
mission logic stays out of `src/main.ts`.

### Marker (`src/marker.ts`)

Move the taxi's beacon into its own small class (a pillar, an arrow, `show(x, y)`,
`hide()`) and use it for both. When the target is off-screen, an arrow at the edge of
the screen points at it, with the distance. The minimap route or GPS line is not part
of this plan.

### Places and the streaming tiles

A target may be in tiles that aren't loaded. So:

- Places are **coordinates known up front**: hand-picked points (the developer
  panel's "Copy link" gives `?start=lon,lat`), or points picked from data loaded for
  the whole area (`names.json`, tram stops, parking zones, bike stations).
- Anything a mission puts into the world (a car to steal, a person to follow, a load)
  **belongs to the mission**, not to a tile or the crowd, and is spawned only when its
  tile is loaded and it's out of sight, as police and taxis are. It's removed when the
  mission ends.
- A place needs a spot on the pavement or in a lane: use `standAt` and `edgesNear`,
  as the taxi does.

### Odd jobs (phase 1)

Repeatable jobs made up from the map, each a template that picks its places when it
starts. Candidates (pick two or three for phase 1):

- **Courier**: pick up a parcel and bring it across town in a time limit, on foot, on
  a shared bike or in a car. Pay grows with distance, a bonus for being early.
- **Taxi driver**: in a car (any, or a taxi only, see open questions), pick up a
  passenger waving at the kerb and drive them to a named place. The existing taxi
  code already has the fare formula (`FIRMS`).
- **Bring a car**: a specific kind and colour, parked or in traffic, to a garage.
  Stealing is a crime as it is today; damage lowers the pay.
- **Catch a tram** (Prague-only): be at a stop before a real departure and ride it to
  a stop, using the real timetables.

Jobs are offered at a job point (a courier depot, a taxi rank) or by phone (see open
questions).

### Factions (phase 2)

A faction is data (`src/factions.ts`):

- id, name, colour, a boss and contacts (portrait ids),
- home parts of town (names from `districts.json`),
- how its people look (a few `Look` colour sets) and which cars they drive
  (kinds and colours),
- its rivals.

**Reputation**: a number per faction, −100 to 100. Missions change it; working for a
faction lowers it with that faction's rivals (as respect in GTA2). It decides:

- which missions and jobs the faction offers,
- how its people treat you on its turf (greet, ignore, run off, come after you),
- perhaps prices (a garage, a taxi firm).

**Territory**: a part of town belongs to at most one faction. The district title can
say whose it is. On a faction's turf, a share of the crowd and traffic takes its looks
and cars: when `Crowd` and `Traffic` spawn someone inside the turf, they ask the
factions module for a look or a car.

### Story missions and hostile members (phase 3)

- Written missions per faction, a short chain each, with conversations (`Dialog`)
  and portraits from the cast.
- Hostile members come after you on foot like the inspector (appear, run, give up,
  walk off, can be knocked over) and in cars like police cars (`ChaseCar`). Take the
  shared parts of `src/police.ts` and `src/inspector.ts` out into a small module first
  rather than copying them.
- Without weapons for the player (see open questions) the missions are about
  driving, chasing, escaping, ramming, stealing and delivering.

### Saving

Earning money needs the balance kept between visits, and factions need reputation and
progress kept. The suggested shape: one `localStorage` key, `save`, with a version
number, `{ v, money, rep: {…}, done: [...], active? }`, read at start and written
when something changes, with `try`/`catch` like the other settings. `?money=N` still
overrides the balance for a visit. `?fresh` starts without the save. Whether to save
at all is an open question, and plan 002's decision ("not saved") has to be changed
explicitly with the user.

## Open questions

These are the user's to decide. Each has a suggested default; don't treat it as
decided.

1. **Tone.** Satire of Prague life (taxi rip-offs, developers, short-term lets,
   pubs, the town hall), or a more serious crime story? Suggested: satire, with
   made-up names, as Zipp and Hopla for the taxi apps. *Needed for phases 2 and 3.*
2. **Saving.** Keep money, reputation and progress between visits (`localStorage`)?
   This reverses plan 002's "not saved". Suggested: yes, from phase 1, since jobs pay.
   *Needed for phase 1.*
3. **Weapons for the player.** None for now (driving, chasing, stealing), or from the
   start? Suggested: none until phase 4. *Needed for phase 3.*
4. **Which factions, and how many.** Suggested: three to start. Candidates that fit
   the cast:
   - the taxi mafia (driver, boss),
   - couriers and the gig economy (courier, hacker, student),
   - the Žižkov pub and punk scene (punk, rocker, barmaid, bouncer, tattooed),
   - developers and the town hall (boss, lawyer, official, foreman, clerk),
   - the neighbours' association (grandma, neighbour, veteran).

   The police, the journalist and the detective stay outside the factions.
   *Needed for phase 2.*
5. **How missions are handed out.** A phone (a call or a message from a contact with
   their portrait), fixed meeting places (a pub, a garage), or both? Suggested: the
   phone for jobs and story calls, a few fixed places for the start of story chains.
   *Needed for phase 1 (jobs) and phase 3.*
6. **Taxi driver job.** Any car, or only a taxi you get from a rank? *Needed for that
   job only.*
7. **Territory for every part of town, or only some?** Covering all ~100 cadastral
   areas makes the whole city feel owned; a few home turfs keep the rest neutral.
   Suggested: a few home turfs, the rest neutral. *Needed for phase 2.*
8. **Turf changes.** Can territory change hands through missions, or is it fixed?
   Suggested: fixed until phase 4. *Needed for phase 4.*
9. **Failure costs.** Does failing cost anything (money, reputation), or can you
   simply try again? Suggested: reputation for story missions, nothing for jobs.
   *Needed for phase 1 (jobs) and phase 3.*

## Steps

### Phase 1: engine and odd jobs (needs questions 2, 5, 9)

1. `src/marker.ts`: the beacon from `src/taxi.ts`, plus the edge-of-screen arrow;
   the taxi uses it. Check the taxi still shows its beacon.
2. `src/missions.ts`: the engine, the step types above, fail conditions, the HUD
   objective line, the hooks from `src/main.ts`.
3. `Wallet.give(n)` in `src/money.ts`, with a green "+N Kč" flash next to the balance.
4. Saving (if question 2 says yes): `src/save.ts`, versioned, `?fresh`.
5. Two or three job templates, and a way to take them (question 5).
6. Czech text in `src/cs.ts`; README: a **Missions** section under Playing, and the
   item in "Not yet in the game" updated; `?mission=<id>` to start one for testing.

### Phase 2: factions (needs questions 1, 4, 7)

1. `src/factions.ts`: the faction data, reputation, rivals, `ownerAt(x, y)` through
   `Districts`.
2. The district title and the HUD say whose turf you're in.
3. Faction looks and cars in `Crowd` and `Traffic` on their turf.
4. Jobs offered by factions, depending on reputation; reputation saved.
5. README and `src/cs.ts`.

### Phase 3: story missions and hostile members (needs questions 1, 3, 5, 9)

1. Take the shared chase code out of `src/inspector.ts` and `src/police.ts`.
2. Hostile members on foot and in cars, driven by reputation.
3. A short chain of story missions for each faction, with conversations.
4. README and `src/cs.ts`.

### Phase 4: later (needs questions 3, 8)

Weapons for the player and turf changes, planned separately if wanted.

## Verification

- `npm run typecheck` and `npm run build` after each phase.
- In the game (`?area=centrum&go`), for each job: take it, finish it, check the pay
  and the save; fail it in each way (wasted, busted, time's up, car wrecked) and check
  the banner and that everything the mission spawned is gone.
- A target in tiles that aren't loaded: the marker and the edge arrow point at it;
  the mission's car or person appears only once you're near, out of sight.
- A metro ride, a taxi ride and a teleport from the developer panel during a mission
  don't break it.
- Frame times at the bench places (`node scripts/bench.mjs --vs`) don't get worse
  with a mission running.

## Commits

One commit per step within a phase: the marker, the engine, `Wallet.give`, saving,
each job, then docs and translations.
