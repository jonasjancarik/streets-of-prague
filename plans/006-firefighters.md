# Plan 006: Firefighters

> An implementation plan for another agent. Planned at `e73bd6d` on `main`, 2026-09-30.
> The working tree then had someone else's uncommitted work (`src/car.ts`, `src/cs.ts`,
> `src/graphics.ts`, `src/main.ts`, `src/parking.ts`, `src/radio.ts`,
> `src/settings.ts`). Check `git status` and `git diff` before you start, don't revert
> changes you didn't make, and commit only your own hunks (`git add -p`).
>
> **A few design questions are still open** (see [Open questions](#open-questions)).
> Each phase says which ones it needs. Where this plan names a default, it's a
> suggestion for the user, not a decision: where a phase is blocked, stop and ask.

## Status

- Priority: P2 (the city reacting to the chaos you cause; not a prerequisite for anything)
- Effort: phase 1 M (about 1.5 days), phase 2 S–M, phase 3 M, phase 4 depends on plan 004
- Risk: medium. New code mostly lives in its own module, but it touches `src/fire.ts`,
  the traffic's braking in `src/traffic.ts` and `src/main.ts`, which is shared with
  parallel work. The water jet is drawn over many pixels, so it has to be measured.
- Depends on: nothing for phases 1–3; phase 4 needs the mission engine from plan 004
- Category: gameplay feature

## Goal and scope

When a car catches fire, a fire engine comes with its blue lights flashing, the
traffic gets out of its way, the crew puts the fire out and drives off. Later the
player can steal the engine and use its water cannon, and firefighting can become a
job.

In four phases, each playable on its own:

1. **Call-out and putting out the fire**: an engine drives to a burning car, the crew
   gets out and puts it out, then everyone leaves.
2. **Lights, siren and traffic giving way**: blue lights shared with the police, a
   siren, cars pulling over, the engine going through red lights carefully.
3. **The player and the engine**: steal it, drive it, spray water at fires, people and
   police.
4. **Firefighter job**: odd jobs on plan 004's mission engine (drive to fires against
   the clock, get paid).

Out of scope: burning buildings (smoke and flames from windows over procedural facades
cost too much per pixel for now), ambulances and paramedics (the lights module in
phase 2 is made so they can use it later), fire hydrants, ladders that move, and the
Prague fire brigade's real livery or name on the vehicle beyond the generic word
HASIČI.

## Current state (what the plan relies on)

- **Burning cars**: `Fires` in `src/fire.ts`. A car smokes from `SMOKING` (50) damage,
  catches fire at `BURNING` (90), and explodes after `FUSE` (4–6 s). The wreck
  (`c.burnt`) smoulders for `SMOULDER` (25 s), with flames for the first half.
  `onIgnite(c)` and `onBlast(c, blamed)` are the hooks; `src/main.ts` creates
  `Fires` around line 825 and calls `fires.update(dt, active, view)` around line 1228.
  Smoke and flames are `Puffs` (instanced quads, 600 and 300 of them).
- **Emergency driving**: `Police` in `src/police.ts` already does most of what an
  engine needs:
  - `spawn(x, y)` (line ~342): a car on a street out of view, 90–250 m away;
  - `route(ax, ay, bx, by)` (line ~289) and `roadside(x, y)` (line ~276): a way through
    the street graph (both ways along every street) and the kerb nearest a point;
  - `chase()` (line ~352): following a `Polyline` with slowing for bends, getting
    unstuck by reversing, stopping behind another car;
  - officers who get out, run with `steer()` and `locomote()`, get knocked over
    (`knocked()` in `src/people.ts`) and get back in;
  - `render()` (line ~603): two flashing blue lamps on the roof and a blue glow on the
    ground, instanced, for every car chasing you and for a stolen police car.
- **Big vehicles**: the bus type in `src/car.ts` (`TYPES`, a box body built around
  line 155 and 262). An engine can be built the same way.
- **Water drops**: `Spray` in `src/spray.ts`, a ring of points in one draw call where
  each drop is written once and moved by the shader. Cheaper than `Puffs` for many
  small drops.
- **Traffic**: `Traffic` in `src/traffic.ts`. Agents brake for what's ahead (lines
  ~199–280), stop at red lights (`signals.ahead`, ~line 304) and can steer off their
  lane with `off`; `kerb` is used to pull back in from the pavement.
- **Sound**: `Sound` in `src/audio.ts`, with voices made from oscillators and noise
  (`Engine`, `Tyres`) and recordings (`TramVoice`, `Ambience`). Levels are in
  `src/soundmix.ts`; tune them with the repo's sound-levels skill, not by listening.
  The police have no siren yet.
- **Figures**: `Look` in `src/figures.ts` is only colours (`shirt`, `trousers`,
  `skin`, `hair`, `sleeves`). There's no helmet.
- **Crimes**: `police.crime(kind, …)` with `knock`, `hitCop`, `carjack`, `blowUp`,
  `blowUpCop` and others.

## Design

### The engine (`src/car.ts`)

A new type `fire` in `TYPES`: about 8.5 m × 2.5 m × 3.2 m, 14 t, slow to speed up,
`vmax` around 25 m/s, rear-wheel drive, `weight: 0` (never parked or in ordinary
traffic), tough. The body is boxes like the bus: a red cab and body, a white or
reflective yellow stripe along the side, grey roller shutters, a ladder on the roof,
and HASIČI on the front. It will get stuck in narrow Old Town streets, and that's fine.

### The brigade (`src/brigade.ts`)

A class like `Police`, owning its engines and crews (they belong to it, not to a tile):

- `call(c: Car)`: a car is burning. If no engine is already on its way to a fire
  within 60 m, spawn one out of view 150–300 m away (`police.spawn`'s approach) and
  give it a route to the roadside nearest the fire. Reuse `police.route()` and
  `police.roadside()` by passing the `Police` instance in; don't copy them. (Plan 004
  phase 3 may later move them into a shared module.) At most `ENGINES` (2) at a time.
- Driving: the same following logic as `chase()`, with a lower top speed and more
  braking for bends. Take the shared part out of `Police.chase` into a function both
  can call, rather than copying it.
- On arrival: stop, 2–3 firefighters get out, walk to 4–6 m from the fire and spray.
  Each puts `douse(c, dt)` into `Fires`. When the fire is out they walk back, get in,
  and the engine drives off and is removed once it's out of view and 250 m away.
- Knocked-over firefighters get up again like officers. Running one over is `knock`.
  Blowing up an engine is `blowUp`.
- A firefighter's look: a dark navy suit with the sleeves on, and reflective bands if
  the figure shader can draw them cheaply; otherwise just the colours. A helmet needs
  a new part in the figures kit and is left for later.

### Fires last long enough to be put out (`src/fire.ts`)

The fuse is 4–6 s, so no engine can get there before the explosion, and that GTA
moment should stay. Firefighters put out the **wreck** instead. Default (open
question 1): while an engine is on its way or at work, a burnt wreck keeps its flames
until it's put out, for at most 120 s. Without an engine it smoulders as today.

New in `Fires`:

- `douse(c, amount)`: water on a car. On a wreck it cuts the flames and turns the
  smoke white (steam) for a few seconds, then stops. On a car that's burning but hasn't
  blown up yet (the player with the water cannon in phase 3), enough water brings its
  damage back under `BURNING` and clears the fuse, so it only smokes.
- `burning()`: the fires the brigade should know about, or `onIgnite` and `onBlast`
  passing to `brigade.call` in `src/main.ts`.

### Water

A jet from the hose or the cannon: a stream of drops along a ballistic arc, drawn like
`Spray` (a ring of points, written once, moved in the shader), with a few white `Puffs`
of steam where it hits. Only drawn when in view. Measure it with the performance skill
(`node scripts/bench.mjs --vs` with a jet in the middle of the screen) before settling
the number and size of drops.

### Lights (`src/beacons.ts`)

Move the lamps and glow out of `Police.render` into a small module that draws flashing
blue lights on any car it's given, with its own light bar layout per type (two lamps
on a police car, a longer bar on the cab of an engine). Police and brigade both use
it; ambulances can later. At night the glow on the ground is what shows, so check it
with the night lighting on.

### Siren

A two-tone siren for the engine, and for police cars that are chasing you (open
question 3). Suggested: made from oscillators in `src/audio.ts` like the engine sound,
so there's nothing to download, with its level in `src/soundmix.ts`, fading with
distance and a slight Doppler shift. A recording from Freesound through
`pipeline/build_audio.py` is the alternative if the made-up one sounds cheap. Tune the
level offline with the sound-levels skill; it shouldn't drown out the radio.

### Traffic giving way (`src/traffic.ts`)

An agent with an emergency vehicle behind it (siren on, within about 40 m, on the same
street, going the same way) slows down and moves right with `off`, as far as the lane
and parked cars allow, and stays there until it has passed. At a red light it doesn't
move off. The engine and a police car with its siren on go through red lights at no
more than about 5 m/s. Keep this a small addition next to the existing braking; it
runs for every agent every step, so check it doesn't cost more than a lookup of the
few emergency vehicles.

### The player (phase 3)

- The engine can be stolen like any car; the crew get out and chase you on foot like
  officers do. It counts as `carjack`.
- A key (open question 4) fires the water cannon forward from the roof while you're
  in the engine. It puts out burning cars (`douse`), knocks people and officers over
  (as a car does, but gently), and is a crime when it hits people (`knock`) or police
  (`hitCop`).
- Water runs out after about 30 s of spraying and refills slowly; the HUD shows the
  tank.

### Firefighter job (phase 4, needs plan 004 phase 1)

An odd job on the mission engine: while you're in an engine, a fire starts somewhere
(an ordinary car set burning out of view, 300–800 m away), with a marker. Get there and
put it out before it spreads to the cars around it; pay grows with how quickly. Then
the next one, as in GTA's side missions.

## Open questions

1. **Can the fire be put out before the explosion?** Suggested: no, the fuse stays
   4–6 s; firefighters put out the wreck, which keeps burning until they do (at most
   120 s). The alternative is a longer fuse for cars nobody's driving. *Needed for
   phase 1.*
2. **Where engines come from.** Suggested: out of view, 150–300 m away, like police.
   Real stations from OSM (`amenity=fire_station`, which `pipeline/osm_area.py`
   already reads) would mean engines driving from them, sometimes for minutes.
   *Needed for phase 1.*
3. **A siren for the police too?** Suggested: yes, for cars chasing you, sharing the
   code. *Needed for phase 2.*
4. **The water cannon key.** Suggested: the one used for the horn or an action key,
   whichever is free; check `src/main.ts` and the touch controls. *Needed for phase 3.*

## Steps

### Phase 1: call-out and putting out (needs questions 1, 2)

1. The `fire` type and its body in `src/car.ts`.
2. `Fires.douse()` and the longer-burning wreck while a crew is coming, in
   `src/fire.ts`.
3. The shared route following taken out of `Police.chase`.
4. `src/brigade.ts`: calling, driving, the crew, the hose, leaving; wired into
   `src/main.ts` (`onIgnite`/`onBlast`, `allCars`, collisions, the spatial hash, render,
   `reset()` on teleport).
5. The water jet and steam.
6. A developer panel button (`src/dev.ts`) to set the nearest car on fire.

### Phase 2: lights, siren, giving way (needs question 3)

1. `src/beacons.ts`, used by police and brigade.
2. The siren in `src/audio.ts` and `src/soundmix.ts`, levels checked offline.
3. Giving way and careful red lights in `src/traffic.ts`.

### Phase 3: the player (needs question 4)

1. Stealing the engine, the crew coming after you.
2. The water cannon, its tank in the HUD, crimes, touch control.

### Phase 4: the job (needs plan 004 phase 1)

1. The firefighter job template and its pay.

After each phase: Czech text in `src/cs.ts` for anything shown, and the README
(what's in the game, controls, the developer button).

## Verification

- `npm run typecheck` and `npm run build` after each phase.
- In the game (`?area=centrum&go`), with the developer button: a car burns, explodes,
  an engine arrives out of view, the crew puts out the wreck and they leave. Twice at
  once; one on a narrow street; one next to a tram line; a teleport while the engine is
  on its way (nothing left behind).
- At night: the blue lights and their glow on the ground.
- Traffic moves over for the engine and doesn't run into it or the parked cars.
- Sound levels with the sound-levels skill; the siren fades with distance.
- Frame times at the bench places with an engine spraying in view
  (`node scripts/bench.mjs --vs`), on a quiet machine. Show screenshots of the engine,
  the crew at work and the lights at night.

## Commits

One commit per step, with the README and translations in the step they belong to.
