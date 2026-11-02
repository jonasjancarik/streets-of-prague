---
name: scene-testing
description: How to check what happens in Streets of Prague (driving, crashes, police, fares, trams, weather, camera views) by scripting the real game in headless Chrome with scripts/scene.mjs, the test API in src/testkit.ts (window.__test) and the scenarios in scenarios/. Use when verifying a gameplay change, reproducing a bug the user describes, replaying coordinates or a "Copy this situation" snippet the user pasted, taking a screenshot of a place or from a camera angle, or adding a regression scenario. Not for frame times (use scripts/bench.mjs and the performance skill).
---

# Testing in the game

Don't write throwaway Playwright scripts. The game has a test API and a runner that
keeps it loaded, so a check takes seconds, not a minute of loading per attempt.

## The loop

1. The dev server must be up (`npm run dev`, port 5191; check with
   `lsof -nP -iTCP:5191 -sTCP:LISTEN`).
2. Start the scene server in the background: `node scripts/scene.mjs serve`
   (loads the game once in headless Chrome, listens on 5199). It follows the dev
   server's reloads: after you edit source, the next command waits for the page to
   load again.
3. Explore with `eval`, one shot of JS with `t` = `window.__test` (and `__drive`,
   the game's raw objects):
   `node scripts/scene.mjs eval "await t.go('karlova'); await t.drive('sedan'); return t.probe()"`
   A bare expression is returned as it is; with `;` or `return`, it's a function body.
4. If the check is worth repeating, make it a scenario (below) and run it:
   `node scripts/scene.mjs run <name>`; `run all` before committing gameplay changes.
5. Look at screenshots with Read (they go to `$TMPDIR/scene/<name>.png`), and show
   the user the ones that matter.
6. `node scripts/scene.mjs stop` when done (it holds a Chrome with a GPU context).

Without `serve`, each command loads the game itself (fine for a one-off).
A command waits while another session runs a benchmark ("Waiting for the benchmark
from …" on stderr), and at most three sessions run scenes at once; the rest queue
(`scripts/game-lock.mjs`). Leave it waiting. Between commands a scene server's page
stands still under a benchmark.
Options: `--place`, `--time`, `--weather`, `--date` (`10-20` or a season's name; today otherwise), `--graphics`, `--show` (a visible window),
`--out`.

## The API (`src/testkit.ts`)

Units are the everyday ones: places as `[lat, lon]` or a name from `PLACES`, headings
in compass degrees (0 north, 90 east), speeds in km/h.

- `t.go(where, { heading })`: loads the tiles and puts you there on foot (or in your
  vehicle). `t.where()`: lat/lon, heading, street, mode.
- `t.onFoot()` prepares a scenario on foot through normal landing/exit actions and
  resets the camera to follow at its normal zoom. `t.run()` does this before every
  scenario. An airborne helicopter is staged on nearby clear ground and descends
  through `t.wait` controls; failure to land or disembark fails preparation.
- `t.time('21:30')`, `t.weather('rain' | … | 'auto')`, `t.season('autumn' | '10-20')` (the game's date), `t.set({ money, stars, health })`.
- `t.drive(type)`: gets out of whatever you're in and into a new car on clear ground
  ahead (`hatch`, `sedan`, `suv`, `van`, `taxi`, `police`, `pickup`, `truck`, `bus`,
  `moto`, `bike`…, the keys of `SPECS` in `src/car.ts`). `t.car(type, opt)`: just
  parks one. `t.exit()` gets you out.
  `t.carView(car)` reports actual player/camera distances, the production cleanup
  view radius and whether the car is out of sight. Use it to assert a placement
  premise: `t.car` can find a different clear spot than the requested `ahead` distance.
- `t.boats()`: loaded boats with kind, location, mooring status, safe bank coordinates
  and water/bank heights. `t.boardBoat()`: ordinary interaction from the current bank
  position, returning whether you boarded. `t.exit()` uses the same safe bank rule.
  `boat-boarding` checks all three waiting boats; `scripts/check-boat-access.mjs`
  checks rejected quays, walls and railings without a browser.
- `t.ferries()`: PID's ferries (line, sailing or not, the landing each lies at, the next
  one, each landing's spot on the bank). `t.boardFerry()` is E at a landing; `t.ticket()`
  says how the fare stands, `t.ticket(true)` buys one first. `t.roll = 0` makes the inspector sure to check
  you at the next ferry landing (1: never; null again afterwards), `t.inspection()` says how
  that stands, `t.payFine()` pays, and `t.frames()` lets the live game look once between
  waits (inspections and the HUD are looked at once a frame, not in `t.wait`). `t.cruiseToEnd(back)` puts a
  cruise boat on the fairway before the end of the stretch nearest you, `t.cruiseAt(where, dir)`
  at the point of the fairway nearest a place, `t.cruise()` says
  where it is, which way it goes and whether it's turning. Scenarios `ferry-ride`,
  `cruise-lock` and `cruise-weir`; offline, `scripts/check-river.mjs` and `scripts/check-river-boats.mjs`.
  With a dev server on another port pass `--url http://localhost:<port>/` to every
  command, `run` included: without it the command loads the game from port 5191.
- `t.dent(car, along, left, levels)` crumples a car as a blow that far along and to the left of
  its middle would (metres; `DENT` in `src/car.ts`) and returns `car.crush`.
- `t.ignite(car)` sets a car on fire; `t.fire(car)`: whether it burns, is a wreck, still
  has flames, what the fire engine sent to it is doing (`go`, `work`, `leave`) and how
  many hoses are on it, whether its roof cannon sprays and how far away it is.
- `t.enter(car)` takes an existing car through the normal entry path, including theft.
  It, `t.drive` and `t.exit` are instant. `t.press()` is E as the player presses it:
  to the door, in (or out) through it, which takes a second or so of `t.wait`; with a
  driver at the wheel it plays the theft. `t.toDoor(car, n)` stands you by door n (1 the
  driver's, 2 the other front one), `t.wallBeside(car, n)` turns the ground beside door n into a
  wall (it returns the function that removes it), `t.fromDoor(car, n)` is how far you are from where you'd
  stand to use it. `t.arrested()` is how far an arrest has got
  (`door`, `out`, `hands`, `cuff`, `lead`, `seat`, `back`) or null. `t.bust()` arrests you
  on the spot (by the nearest officer on foot, if any), even inside a scenario;
  `await t.settled()` waits for the move to the cell to load. Scenario `arrest-car`.
  `t.busLines()` lists loaded PID identifiers/destinations; `t.busLine(car, ref)` assigns
  one of those lines to a test bus. `t.policeCar()` finds the nearest police vehicle;
  `t.policeLights(car)` reports whether its flashing lamps are active.
- `t.courier()`: the nearest delivery courier in traffic. `t.bags()`: the bag you carry and those
  lying about; `t.toBag()` stands you by one, `t.interact()` presses E on foot, `t.clearBags()`
  starts clean, `t.peopleNear(x, y, r)` lists the people round a spot.
- Jobs (`src/missions.ts`): `t.job()` says what is on (`idle`, `offer`, `on`), the job, its
  step and objective, seconds left, pay, where it wants you, seconds out of the vehicle
  (`out`), the last outcome and the books (`done`, `failed`, `earned`, `rep`).
  `t.startJob(id)` starts one at once, `t.pressJ()` is the phone key, `t.offerJob(id)`
  puts an offer up, `t.autoJobs(on)` turns on the offers nobody asked for (off in test
  runs), `t.jobTime(s)` sets the seconds left, `t.toJob(back)` puts you and your vehicle
  at the job's place, `t.clearJobs()` starts the books again. `t.jobCar()` is the car a
  fire call set burning, `t.aimAtCar(car, back)` points your engine at it, `t.cannon(on)`
  holds the water cannon. `t.takeTram()` puts you in the cab of the nearest tram,
  `t.tram()` reports it, `t.tramDoors()` is X. `t.upgradeSave(old)` runs a saved game
  through the format's version steps.
- `t.push(kmh, heading?)`: sets your car going. `t.post(r)`: the nearest standing
  lamp or pole; `t.post(r, 18)`: the nearest your car has a clear 18 m run up to, with the car put there. `t.aimAt(post, back)`: puts your car `back` m before it, facing it,
  on a run clear of walls and other cars. `t.runway(heading)`: metres to the first wall.
- `t.wallRun(back = 12)`: puts your car on a clear approach to a broad wall and returns
  its heading and wall plane, or null. It checks the full car, nearby vehicles, tram
  circles, posts and fences. `wall-crash` coasts from 60 km/h, records actual wall
  impacts and keeps the final speed check below 15 km/h.
- `t.route(from, to)`: the shortest way by car through the streets loaded now (those
  within some 700 m of you): `{ length, line }`, the line as `[lat, lon]` points, or null
  where the streets don't join up. `t.follow(line, kmh)` drives your car along such a
  line and reports `{ arrived, seconds, jump, strayed }` (`jump`: the biggest change in
  the ground's height from one sixth of a second to the next). `t.countryside()`:
  whether the game was opened with `?countryside` (`--extra "&countryside"`); the
  scenarios `countryside-edge`, `-traffic`, `-taxi` and `-police` need it and skip
  themselves without.
- `t.builtMap()`: whether your current position is inside an available prebuilt tile
  and the exact map extent from `index.json`. Unlike `t.countryside()`, this checks
  your location and excludes generated countryside, including the outer part of a
  partial edge tile.
- `t.orderTaxi()` orders an app taxi on foot, `t.taxi()` says how it stands (`state`,
  `near`, `to`), `t.boardTaxi()` gets in, `t.taxiTo(n)` picks the n-th place of its list.
  `t.boardTram(seconds)` waits for a tram to stop near you and gets on it (scenario `takeover-button`).
  `t.probe()` also gives `traffic` and `people` (how many are about) and `place` (the
  last title shown for the part of town or the village).
- `t.wait(seconds, controls)`: runs the world in 1/60 s steps with
  `{ move, turn, run, brake, jump, aim }` held (the live loop pauses meanwhile). `aim`
  is the touch stick: `{ h, mag }`, a heading in the game's radians (0 east, anticlockwise).
- `t.thumb(seconds, heading, mag = 1)`: drives your car with the stick alone (the
  one-handed "Stick only" setting, `stickOnly` in `src/touch.ts`), the thumb held toward a
  compass heading. Scenario `stick-only`.
- `t.probe()`: position, speed, car type/damage/burning/broken lamps/braking/ram, money, stars, police cars,
  health, ticket, time, weather, date.
- `t.camera({ at, height, tilt, heading, level })` looks from anywhere without moving you
  (tilt 0 = straight down, up to 75); `height` is metres above the terrain at the
  target. Both the eye and the look-at point follow that terrain. When comparing
  terrain changes, use an unaffected target and record the actual eye position and
  orientation: identical camera options alone do not establish an identical pose.
  The picture's top is north whatever the heading, so a tilted view facing east or west
  comes out on its side: pass `level: true` to keep the horizon level.
  `t.camera(null)` follows you again.
  `t.view(zoom)` zooms the ordinary camera.
- `t.aimAt(post, back)` checks walls, cars and the current tram collision circles
  for the whole car along its approach. A blocked approach is rejected instead of
  placing the car inside a tram. Moving traffic can still change after setup; this
  is fixture clearance, not a paused or disabled-traffic test.
- `t.shot(name)`: a screenshot (the car-name and district captions hidden).
- `t.film(name, seconds, controls, { fps, hud })`: footage as numbered screenshots
  (`name-0001.png` …), the world stepped evenly between them, the HUD hidden unless
  asked for. Start the server with `--size 1920x1080` for full-HD frames; ffmpeg or the
  trailer project (`trailer/`) turns them into video.
- `t.check(name, pass, detail)` records a result in a scenario.
- `t.paused`, `t.speed`, `t.unhurt`, `t.snapshot()`, `t.run(name)` are what the
  developer panel uses.

Missing something? Add it to `src/testkit.ts` (and the `Game` interface, wired in at
the end of `main()` in `src/main.ts`) rather than reaching into `__drive` from a
scenario, and mention it in this file.

## Scenarios

`scenarios/<name>.ts`, typechecked with the rest:

```ts
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A car at 50 km/h knocks a lamp post over',
  async run(t) {
    await t.go('vodickova');
    t.time('14:00');
    t.weather('clear');
    await t.drive('hatch');
    const post = t.post(80);
    if (!t.check('a post nearby', !!post)) return;
    t.aimAt(post!, 18);
    t.push(50);
    await t.wait(2);
    t.check('the post is down', !!post!.down);
    await t.shot('lamp-knock');
  },
} satisfies Scenario;
```

Set the time and weather yourself: the server's page keeps whatever the last command
left. Check numbers with ranges and put the measured value in `detail`, so a failure
says how far off it was. A scenario with no checks counts as failed.

Each run begins on foot with the ordinary camera; each scenario must create or enter
the vehicle it needs. Helicopter preparation can advance the clock by up to 45
simulated seconds. Its staging teleport resets traffic, police actors, fires,
brigade and ambulance state. `police.reset()` retains wanted heat, but the normal
descent simulation can change it and other world state. Set all required time,
date, weather, wallet, health, wanted and actor state after preparation, inside the
scenario. Manual `t.go`,
`t.drive` and `t.exit` keep their existing gameplay constraints. This does not reset
the whole world or resolve ambulance/tow behavior. `vehicle-entry-order` runs
`heli-bridge` followed by `lamp-knock` and retains both complete assertion results.
Set an explicit heading in `t.go` when car placement depends on it: the car factory
searches ahead of the player. `wall-crash` starts from its original northwest heading, then `wallRun` finds a
clear approach instead of inheriting traffic or obstacles from earlier scenarios.

The same scenarios run in the developer panel (`` ` ``, Testing): "Run and watch" plays
one in real time, "Run all" lists which pass.

## What the user sends

- **Coordinates** like `50.08730, 14.42060` (latitude first, copied from the panel or
  its map): `t.go([50.0873, 14.4206])`, or `t.camera({ at: [...] })` to look without
  going.
- **"Copy this situation"**: a few lines starting with `await t.go(...)` (place,
  heading, time, weather, money, stars, car, camera). Paste it into `eval` as it is to
  get to the same state, then investigate or turn it into a scenario.
- Google Maps / Mapy.cz links work in the panel's search; to use one here, take the
  numbers out (`parseSpot` in `src/dev.ts` shows the formats).

## Pitfalls met so far

- A car put down touching another stops dead in its first step (it's pushed apart).
  `t.aimAt` and `t.car` check for that; do the same if you place cars by hand.
- Crashing a car doesn't hurt the driver. Only shots, explosions and being thrown off a
  bike or motorbike do (`hurt` in `src/main.ts`), so don't test for health after a crash.
- Tiles near where you go are loaded by `t.go` / `t.camera({ at })`; far from you,
  traffic and people aren't spawned, so the free camera shows empty streets away from
  the player.
- Parked cars are drawn only within the normal camera's view radius of the free camera's
  target. A top-down `t.camera({ height: 363 })` of a street shows no cars until you
  `t.view(4)` first (`t.view(1)` afterwards); counting `tile.cars` doesn't need it.
- Where a bridge crosses a quay or a street, a spot is both on the deck and under it. `t.go` to
  walkable ground puts you on the ground; to water or anything else not walkable, on the deck
  (`boat-boarding` goes to a boat's place on the water first, then to its bank below).
- Import game modules through `t`, not by URL: after an edit Vite serves a file under a
  versioned URL, and importing it again gives a second, empty copy (that's how
  `posts` once looked empty).
- Headless Chrome here is fine for behaviour and screenshots, not for timing (see the
  performance skill and `scripts/bench.mjs`).
