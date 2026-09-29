# Plan 002: Money, spent on taxis, public transport and shared bikes

> An implementation plan for another agent. Planned at `f603c97` on `main`, 2026-09-29.
> The working tree then had someone else's uncommitted work (the WebGPU trial, and a
> beacon over your taxi in `src/taxi.ts`, `src/main.ts`, `src/cs.ts`, `src/police.ts`).
> Check `git status` and `git diff` before you start. Don't revert or overwrite changes
> you didn't make. If `src/taxi.ts` or `src/main.ts` still has uncommitted changes,
> work around them and commit only your own hunks (`git add -p`), or stop and ask.

## Status

- Priority: P1
- Effort: M–L (about 1.5 days, with the inspector)
- Risk: low to medium. Most of the work is small hooks in `src/main.ts` (about 1,400
  lines, shared with parallel work) and the GBFS price calculation for bikes.
- Depends on: none
- Category: gameplay feature

## Goal and scope

The player has money: **10,000 Kč at the start of every game**. For now it's only
spent, on three things:

1. **Taxis**: the fare the meter already works out is taken from the balance.
2. **Public transport (PID)**: trams, the metro and the Petřín funicular. You buy a
   90-minute ticket yourself. On a tram or the funicular you have 10 seconds after
   getting on; at the metro you choose on the way in. Ride without one and a ticket
   inspector may check you. You either pay the fine or run. The inspector, in plain
   clothes, runs after you, and if you aren't caught quickly they call the police.
3. **Shared bikes (nextbike)**: the rental is paid as it goes, by the operator's real
   pricing plan (GBFS, already in `bikes.json`). A bike left outside a station and
   abandoned costs a fee, as with nextbike.

The balance is always shown in the HUD. If you can't afford something, you can't
start it, and a short message says why.

Out of scope: earning money, saving the balance between games, police fines, parking,
pedal boats, choosing between ticket types, buses (you can't ride them yet), and
police fines for anything other than fare dodging.

## Decisions made (don't change them without asking)

- **Start balance**: 10,000 Kč. The balance is **not saved** (no `localStorage`).
  Every page load starts from 10,000 again, since there's no way to earn more yet.
- **Test override**: `?money=N` sets the start balance (whole Kč, ≥ 0), so you can
  test what happens when money runs short. Document it in the README's list of URL
  parameters.
- **No debt**: the balance never goes below 0.
- **PID ticket**: one kind, the 90-minute transfer ticket at the PID Lítačka app
  price, **46 Kč** (fares from 1 January 2026; 30 minutes cost 36 Kč). It's valid for
  90 minutes of **game** time from purchase, on trams, the metro and the Petřín
  funicular. The NH hotel's funicular on Mrázovka stays free. Nothing is bought
  automatically:
  - **Tram and Petřín funicular**: getting on is always allowed. Without a valid
    ticket you have **10 seconds** (real time, not sped up) to buy one: key **B**,
    or a touch button. After that the chance is gone for this ride and you're riding
    without a ticket.
  - **Metro**: the choice comes **on the way in**, before the station list. Buy a
    ticket (46 Kč), or go in without one. If you hold a valid ticket, the question
    is skipped. If you can't afford one, only "without a ticket" is offered, with
    the reason.
  - **Inspection**: riding without a ticket, at each tram or funicular stop the
    vehicle arrives at there's a **5%** chance of a check. On the metro the chance is
    **15%** a ride, checked at the way out. Keep these as named constants so they can
    be tuned. At most one check a ride.
  - **Fine**: **1,200 Kč**, PID's fine paid on the spot (2026). You pay what you
    have, never going below 0.
  - **The choice at a check**: *"Ticket inspection!"* in the hint and a banner, with
    **B** to pay the fine and **E** to get off and run. There are **5 seconds** to
    decide.
    - Tram or funicular: the vehicle waits at the stop while you decide. If you don't
      decide, you pay.
    - Metro: the check is at the way out, on the street. Running there just means
      walking or running away (more than 3 m from the inspector); pressing nothing
      for 5 s means paying.
  - **The inspector**: when you run, a figure appears beside you:
    - in plain clothes: any look from the crowd (`randomLook`), not a uniform;
    - on a tram, beside the door you got off by, after about 0.5 s;
    - they run after you on foot like a police officer on foot (the same way round
      cars and trams), at about **6 m/s**, a little slower than the police (6.4). They
      never shoot and never drive.
  - **Caught**: when they reach you on foot, you pay the fine (or what you have
    left), with a red banner, like "Busted" (`showBanner(…, true)`), and the chase is
    over. If they haven't called the police yet, they don't.
  - **The police**: if they haven't caught you **10 seconds** after you ran, they
    call the police. That's a new crime, `fareDodge`, reported by phone at the
    inspector's position: **one star**. The same happens at
    once if you get into a vehicle (car, bike, tram, taxi) while they're chasing you.
    After the call they go on chasing you, up to 30 s from the start.
  - **Caught by the police afterwards**: once the inspector has called the police,
    you owe the fine at the higher rate, **1,500 Kč** (PID's fine paid within 15
    days). If the police catch you ("Busted") while you still owe it, it's taken
    (or what you have left), and the banner says so. You no longer owe it once
    you lose the police (the stars go to 0), or when you're "Wasted".
  - **Giving up**: after 30 s, or when you're more than 60 m ahead, they give up,
    walk off and disappear once out of sight (as officers do, `offscreen`). If
    you've got into a vehicle, they give up at once after the call.
  - **Knocking them over**: you can knock them down like a person or an officer
    (a car, an explosion, a tram): they lie down for a while and it counts as the
    crime `knock`.

- **Taxi**:
  - You can't call one unless you can afford its starting fare (`firm.start`).
  - During the ride the hint shows the meter.
  - When the meter reaches your balance, the driver pulls over and lets you out:
    *"Your money ran out, so the driver let you out"*.
  - If the taxi **crashes**, the ride is free.
- **Bikes**:
  - Renting from a station needs at least the price of the first charge (39 Kč with
    nextbike's standard plan).
  - **Paid as it goes**: each begun interval is paid when it begins. That means
    39 Kč when you take the bike, another 39 Kč when the 31st minute begins, and so
    on, up to the plan's daily cap. So nothing goes unpaid when you don't return the
    bike. When the money runs out, whatever is left is taken and the rental goes on
    (no debt).
  - The time is counted on the game clock, and a parked bike's rental keeps running,
    as it does now.
  - **Returning** to a station of its system ends the rental. It costs nothing more,
    since the time has already been paid.
  - **Abandoning**: a rented bike parked outside a station is abandoned when you're
    more than **300 m** from it, or when it's gone (burnt out, or dropped with its
    tile). The rental ends, and nextbike's fee for a bike not returned to a station
    is taken: **500 Kč**, or **1,000 Kč** if it's more than 3 km from the nearest
    station of its system (nextbike's price list, 2026). A banner says so. The bike
    stays where it is as an ordinary shared bike, not yours any more.
  - A teleport (developer panel), a metro ride or a taxi ride can take you more than
    300 m away. That counts as abandoning too, which is fair: you left it there.

## Current state (what the plan relies on)

- **Taxi**: `src/taxi.ts`.
  - `FIRMS` (line ~33) has `start` and `perKm` per firm.
  - `leave()` (~line 260) works out `fare` (rounded to 5 Kč) from `this.metres` and
    only shows it in a banner via `this.o.banner`.
  - `call(firm)` sends a taxi.
  - `update()` counts `metres` while riding. When the taxi's agent drops out of the
    traffic (a crash), it calls `leave()` and says *"The taxi crashed. You got out"*.
  - `hint()` builds the HUD line while riding.
  - Messages go through `this.say(text)` (the hint line, 5 s).
  - Constructed in `src/main.ts` (~line 613) with an options object (`banner`, `toLocal`…).
- **Tram**: `src/ride.ts`, `TramRide.board(v)`. It's called from `enterOrExit()` in
  `src/main.ts` (~line 509: `const tram = ride.boardable(...)`, then `ride.board(tram)`).
- **Metro**: `src/metro.ts`.
  - `open(station)` shows the choice of stations.
  - `go(to)` (~line 267) starts the ride after the "shut" check. It shows refusals in
    `this.note` and then calls `this.render()`.
  - Constructor options are destructured at ~line 121 (`clock, inMap, ready, terrain,
    standAt, onArrive, onStation`) and passed from `src/main.ts` ~line 204.
  - The game clock moves on by the ride's timetable time. Buy the ticket at `go()`,
    before that happens.
- **Funicular**: `src/funicular.ts`.
  - `SPECS` (~line 36) holds the Petřín and NH lines.
  - `board(c)` is called from `enterOrExit()` in main (~line 503: `funicular.near`,
    then `funicular.board(cabin)`).
  - `c.line.spec` is the car's line spec.
- **Bikes**: `src/bikeshare.ts`.
  - `rent(c, now)` returns `true` today. Its comment already expects "false when
    you can't pay".
  - `leave(c, now)` returns the finished `Rental` (`system`, `seconds` of game time,
    modulo a week) only when the bike went back to a station, otherwise `null`.
  - `BikeSystem.plans` holds GBFS `system_pricing_plans`. `praha_now/bikes.json` has
    one system (`nextbike_tg`) with two plans. The first, `Rate0752`, is the standard
    one ("CZK 39.00/30min, max. 500.00/24h"). Its `per_min_pricing` is:
    `{start 0, interval 30, rate 39, end 360}`, `{start 360, interval 0, rate 32,
    end 1440}`, then the same pattern repeating each day.
  - Main calls `rent` at ~line 530 (`if (best.share && !bikeShare.rent(best,
    clock.t)) return;`) and `leave` at ~line 494 (in `enterOrExit`, getting off).
- **Game clock**: `clock.t` is in seconds, `day * 86400 + seconds since midnight`, and
  runs faster while fast-forwarding. Differences wrap at a week (see `WEEK` in
  `bikeshare.ts`). Use the same modulo when checking whether a ticket is still valid.
- **HUD**: `index.html` ~line 332 (`#street`, `#clock`, `#wanted`, `#health`,
  `#hint`); CSS for `#wanted`/`#health` at ~line 81. The frame loop in `src/main.ts`
  (~lines 1296–1316) updates them with `show(id, value, 'html' | 'opacity')` and
  caches the rendered state (see `wanted.dataset.face`).
- **Messages**: `showBanner(text, alert?)` in main (~line 757). Use it without
  `alert`; alert is for Busted and Wasted.
- **Translations**: every UI string is written in English and wrapped in `t()` from
  `src/i18n.ts`. Its Czech goes in `src/cs.ts` (`CS` map). A missing entry shows in
  English. Counts use `tn()`.
- **No test runner.** The gate is `npm run typecheck` and `npm run build`, plus a
  check in the browser.

## Implementation

### 1. `src/money.ts`: the wallet and prices

This is a new module, so `main.ts` stays thin. Match the codebase's style: a short
header comment in plain English, small functions, and comments that explain why.

```ts
export const START_MONEY = 10_000; // Kč
// PID's 90-minute transfer ticket in the PID Lítačka app (fares from 1 January 2026).
export const TICKET = { price: 46, minutes: 90 };

export class Wallet {
  balance: number;
  paid = 0; // the last amount taken, shown beside the balance for a moment
  paidT = 0;
  private ticketFrom = NaN; // game time the current PID ticket was bought
  constructor(params: URLSearchParams) { /* START_MONEY, or ?money=N when it's a whole number ≥ 0 */ }
  has(kc: number): boolean
  // Take up to `kc` (never below 0); returns what was taken.
  take(kc: number): number
  hasTicket(now: number): boolean // a PID ticket still valid at `now`
  buyTicket(now: number): boolean // false when you can't afford it
  update(dt: number): void // counts down paidT
}

export const GRACE = 10; // s (real) after getting on a tram or funicular to buy a ticket
export const FINE = 1200; // Kč, PID's fine paid on the spot (2026)
export const FINE_LATE = 1500; // Kč, and paid later (within 15 days): when the police catch you
export const CHECK_STOP = 0.05; // chance of inspectors at each stop, riding without a ticket
export const CHECK_METRO = 0.15; // and on a metro ride
export const DECIDE = 5; // s to pay or run at an inspection

// One ride on a tram or the Petřín funicular: with a ticket, still time to buy one,
// or riding without (and caught at most once).
export class PidRide {
  state: 'ticket' | 'grace' | 'dodging' | 'checked' | null = null;
  left = 0; // seconds left to buy
  constructor(private wallet: Wallet) {}
  board(now: number): void // 'ticket' if one is valid, else 'grace' with left = GRACE
  buy(now: number): boolean // only during 'grace'; then 'ticket'
  update(realDt: number): void // 'grace' runs out into 'dodging'
  // At a stop: an inspection, maybe (only while 'dodging', at most once a ride;
  // after that, state becomes 'checked').
  check(chance: number, roll = Math.random()): boolean
  leave(): void // state = null
}

// "10 000 Kč" / "10,000 Kč", by the game's language.
export function kc(n: number): string
```

Requirements:

- `hasTicket()` checks the age as `((now - ticketFrom) % WEEK + WEEK) % WEEK < TICKET.minutes * 60`.
  Export `WEEK` from one place or copy the constant with a comment.
- `kc()` uses `Intl.NumberFormat` with `cs-CZ` or `en-GB` depending on `getLang()`.
  The Czech locale puts a non-breaking space between thousands.

Add a **pure function for the bike rental price** by the GBFS v2.3 rules, in
`money.ts` or `bikeshare.ts`:

```ts
// What a rental of `minutes` costs under a GBFS pricing plan: the plan's price plus,
// for each per-minute segment that has started, its rate once per begun interval
// (up to the segment's end), or just once where the interval is 0.
export function rentalCost(plan: PricingPlan | undefined, minutes: number): number
```

How it works:

- `cost = plan.price`.
- For each segment, the first one (`start === 0`) always applies. A later one
  applies only if `minutes > start`.
  - `interval > 0`: add `rate * Math.max(1, Math.ceil((Math.min(minutes, end ?? Infinity) - start) / interval))`.
  - `interval === 0`: add `rate` once.
- No plan means 0 (free).
- Round the result to whole Kč.

Expected values for `Rate0752`: 0 min → 39, 29.9 → 39, 30 → 39, 30.5 → 78,
360 → 468, 361 → 500, 1440 → 500, 1441 → 539.

The first charge (the minimum needed to rent) is `rentalCost(plan, 0)`.

### 2. HUD: the balance

- In `index.html` add `<div id="money"></div>` to the HUD, next to `#wanted` and
  `#health`. Style it like those, using the existing CSS variables. It's always
  visible. For a moment after a payment it also shows `−46 Kč` (a class that fades
  out, or opacity driven by `wallet.paidT`).
- Render it in main's frame loop. Only rewrite the DOM when the text changes; use a
  cached `dataset.face` as `#wanted` does.
- Give it an `aria-label` such as `t('Money: {money}')`.
- Create the wallet early in main: `const wallet = new Wallet(params);`.
- Call `wallet.update(dt)` in the frame.

### 3. Taxi (`src/taxi.ts`)

- Add a `wallet: Wallet` to the constructor options.
- Pull the fare out into `private fare()`: the same formula, rounded to 5 Kč.
- `call(firm)`: if `!wallet.has(firm.start)`, set `this.state = 'off'` and say
  `t('Not enough money for a taxi (from {fare})', { fare: kc(firm.start) })`.
- `update()`, while riding: if `this.fare() >= wallet.balance`, the driver pulls over
  and lets you out. Call `leave()` and then
  `this.say(t('Your money ran out, so the driver let you out'))`.
- `leave(pay = true)`: take `fare()` from the wallet (`take`, since it may be a little
  more than the balance). Keep the banner (`'{firm} fare: {fare} Kč'`). On a crash,
  call `leave(false)`; the message becomes
  `'The taxi crashed. You got out. The ride was free'`.
- `hint()` while riding: add `t('Meter: {fare}', { fare: kc(this.fare()) })` to the
  parts.
- The firm choice (`render`) may stay as it is.

### 4. Public transport: tickets and inspectors

Create one `PidRide` in main (`const pid = new PidRide(wallet)`). The inspection
itself (the choice and the chase) lives in the new module `src/inspector.ts`
(section 4a).

**Tram** (`enterOrExit` and the frame loop in `src/main.ts`):

- After `ride.board(tram)`, call `pid.board(clock.t)`. In `getOff()`, call
  `pid.leave()`.
- In the frame, call `pid.update(dt)` with the **real** frame time, not the sped-up
  one.
- Key **B**, while `pid.state === 'grace'`: `pid.buy(clock.t)`. Then show a banner:
  - bought: `t('Ticket for {minutes} minutes: {price}')`;
  - not enough money: `t('Not enough money for a ticket ({price})')`.

  Check that no other key handler already uses `KeyB`.
- Touch: add a `#t-ticket` button, shown only during `grace`. Follow the example of
  `#t-taxi` in `index.html` and `src/touch.ts`, and of its click listener in
  `taxi.ts`.
- Hint while riding, during `grace`: put first
  `t('<b>B</b> buy a ticket ({price}) · {secs} s left')` (without `<b>B</b>` on
  touch). While `dodging`, show a short `t('No ticket')` among the parts.
- Inspection: when the tram **arrives** at a stop with you on it and
  `pid.check(CHECK_STOP)` returns true, start the inspection (`inspector.start('tram')`,
  section 4a). Arriving means `ride.atStop()` turned from false to true; keep the
  previous value in main. Check only while riding, not at the stop where you got on.
  While you decide, the tram must not leave: add a way to hold its dwell to `ride.ts`
  (`hold(seconds)`, or a `held` flag that `trams.ts` respects) and check it doesn't
  hold up the other trams behind it for longer than necessary.

**Petřín funicular**:

- Add `ticket: boolean` to the line spec in `SPECS`: `true` for Petřín, `false` for
  NH.
- After `funicular.board(cabin)`, if `cabin.line.spec.ticket`, call
  `pid.board(clock.t)`. In the funicular's branch of `enterOrExit`, call
  `pid.leave()`.
- Buying (B or touch) and the hint work the same as on a tram. Add the grace part
  to `funicular.hint()`, or put it in front of it in main.
- Inspection: when `funicular.me.stop` turns from `null` to a station and
  `pid.check(CHECK_STOP)` is true, start `inspector.start('funicular')`. The
  funicular runs by the clock, so it can't wait. If it leaves before you decide,
  treat that as paying.

**Metro** (`src/metro.ts`):

- Add an option `fares?: { valid(): boolean; buy(): boolean; price: number }` to the
  constructor. Main wires it to `wallet.hasTicket(clock.t)`,
  `wallet.buyTicket(clock.t)` and `TICKET.price`.
- `open(station)`: if `fares` exists and `!fares.valid()`, the first phase is a new
  one, `'ticket'`; otherwise go straight to `'pick'`, as now. Add `'ticket'` to the
  type of `phase`.
- The `'ticket'` screen, in `render()` in the same style as `'pick'`:
  - the question `t('Going in without a ticket?')`;
  - two buttons:
    - `data-act="buy"`: `t('Buy a ticket for {minutes} minutes ({price})')`. When
      you can't afford it, it's disabled, with `t('Not enough money for a ticket
      ({price})')`.
    - `data-act="nobuy"`: `t('Go in without a ticket')`.
  - keys: **1**/**2** (or W/S and E) choose, **Esc** goes back to the street.
  - Both choices lead to `'pick'`. `nobuy` sets `this.dodging = true`, and `open()`
    resets it to `false`.
- Inspection happens at the way out. In main's `onArrive`, after the teleport, if
  `metro.dodging && Math.random() < CHECK_METRO`, call `inspector.start('street')`.
  Then set `metro.dodging = false`.
- A ticket bought on a tram also covers the metro, and the other way round, within
  its 90 minutes.

The police's rules (no arrest on a tram) don't change.

### 4a. The inspector (`src/inspector.ts`)

This is a new module, in the style of `police.ts`. Start with a header comment
explaining the rules from "Decisions made". Its outline:

```ts
export class Inspector {
  phase: 'off' | 'decide' | 'chase' | 'leaving' = 'off';
  where: 'tram' | 'funicular' | 'street' = 'street';
  left = 0; // s to decide
  called = false; // the police have been called
  owed = 0; // Kč owed for running off, collected if the police catch you
  private t = 0; // s since you ran
  person: Chaser | null = null; // the figure on foot
  constructor(o: {
    scene; kit: FigureKit; grid; rng; wallet: Wallet;
    bodyAt: (x, y, r, skip) => boolean; offscreen: (x, y) => boolean;
    crime: (x: number, y: number) => void; // police.crime('fareDodge', x, y)
    fined: (paid: number) => void; // the red banner
  })
  start(where): void // phase 'decide', left = DECIDE
  pay(): void // B: wallet.take(FINE), fined(paid), phase 'off'
  run(x, y, h): void // you've left: the figure beside (x, y), phase 'chase'
  update(dt, me: { x, y, onFoot: boolean, inVehicle: boolean }): void
  render(height): void
  reset(): void // teleport, being wasted or busted: the figure goes
}
```

- **Chasing on foot**: police officers already do it in `Police.walk()` in
  `src/police.ts`: they head for you, go round cars and trams with `bodyAt` and the
  `detour` side, move by the grid (`blocked`), and animate with `locomote`/`knocked`.
  Don't copy that code. Pull the steering (the part from `let ang = Math.atan2(dy,
  dx)` to setting `vx/vy/h`) out into an exported function, for example
  `steer(o, tx, ty, speed, bodyAt, skip, rng)` in `police.ts`, and use it in both
  places. Officers must behave exactly as before. Check a chase on foot with the
  police after the refactor.
- **The figure**: `new Figures(kit, 1)` with `fig.look(0, randomLook(rng))`, and an
  `Anim(kit, 'idle')`. Render it as `Police.render` renders officers (`fig.set` with
  a matrix and `SCALE`, then `commit`). There's never more than one inspector, and
  the figure can be kept and reused.
- **Catching**: on foot and within 1.1 m (the same `reach` as officers), call
  `pay()`. You can't be caught in a vehicle.
- **Timing**:
  - 10 s after `run()` with no catch: `crime(x, y)` once (`called = true`,
    `owed = FINE_LATE`), and `showBanner(t('The inspector called the police'))`.
  - At once, if `me.inVehicle`.
  - 30 s, or more than 60 m, or `called && me.inVehicle`: phase `'leaving'`; they
    walk off (1.4 m/s away from you, as officers without a car do) and go once
    `offscreen`.
- **In main**:
  - Collisions: add the inspector to what cars, trams and explosions knock over, in
    the same places as `police.officers` (main ~lines 727, 854, 1007). Hitting them
    with your car counts as `police.crime('knock', …)`.
  - Add a way to knock them down (`knock(vx, vy)`, with `down` as officers have).
  - On a teleport, being wasted or busted, call `inspector.reset()`. `reset()`
    doesn't clear `owed`, so that `busted()` can still collect it.
  - In `busted()` (main ~line 344), before `police.forgive()`: if `inspector.owed`,
    `const paid = wallet.take(inspector.owed)` and `inspector.owed = 0`. Then show
    `t('Busted · fine for riding without a ticket: {fine}')` instead of plain
    "Busted", with `paid` in place of `fine` when it was less. It stays an alert
    banner.
  - In `wasted()`, set `inspector.owed = 0`. In the frame, if
    `police.stars === 0 && inspector.owed`, also set it to 0: you got away.
- **The choice, in main**:
  - While `inspector.phase === 'decide'`, the hint shows
    `t('Ticket inspection! <b>B</b> pay the fine ({fine}) · <b>E</b> get off and run · {secs} s')`.
    On touch, the `#t-ticket` button becomes "Pay the fine", and running is the
    usual get-off button.
  - B calls `inspector.pay()`.
  - On a tram, E (`getOff`) during `decide` calls `inspector.run(...)` at the
    place where you got off. On the funicular, the same in its branch of
    `enterOrExit`.
  - On the street (metro), moving more than 3 m from where the check began counts
    as `run`.
  - If `left` runs out, call `pay()`.
- **Police**: in `src/police.ts`, add `fareDodge: 2` to `POINTS`. `crime()` adds
  `POINTS × 0.5` when phoned in and `× 1.5` when an officer sees it. With 2, a phoned-in
  call gives heat 1, which is one star (`STARS = [1, 4, …]`). If a patrol sees it
  (heat 3), it's still one star.
- **The banner at a fine**, in main, passed as `fined`:

  ```ts
  const fined = (paid: number) => showBanner(paid < FINE
    ? t('Ticket inspection! You had no ticket, so they took all your money ({paid})', { paid: kc(paid) })
    : t('Ticket inspection! Fine for riding without a ticket: {fine}', { fine: kc(FINE) }), true);
  ```

### 5. Shared bikes (`src/bikeshare.ts` and main)

- `Rental` gets `paid: number` (Kč paid so far).
- `plan` means `system.plans[0]`; write a small `planOf(system)` helper for it.
- `rent(c, now, afford: (kc: number) => boolean)`:
  - For a new rental (a bike taken from a station), if
    `!afford(rentalCost(plan, 0))`, return `false`.
  - A bike you parked yourself (with its rental still running) is let go as it is now.
- In main: `if (best.share && !bikeShare.rent(best, clock.t, (n) => wallet.has(n))) { showBanner(t('Not enough money for a bike ({price})', …)); return; }`.
  Show the price of the first charge.
- **Paying as it goes**: add `charge(now, take: (kc: number) => number)` to
  `BikeShare` and call it from main every frame (or once a second), next to
  `bikeShare.update`. For each running rental, compute
  `due = rentalCost(plan, minutes so far) - rental.paid`. If it's above 0, call
  `take(due)` and add **`due`** to `paid`, not what was actually taken, so that
  the balance running out doesn't make it charge again and again. Measure the
  minutes as in `leave` (modulo a week). The first charge is taken right at
  `rent`, through the same path.
- **Returning** (main ~line 494): `bikeShare.leave(c, clock.t)` doesn't take any
  more. If it returns a rental, show
  `showBanner(t('{name}: returned after {minutes} min, {price} in all', …))`.
- **Abandoning**: add `abandon(px, py, now): { rental: Rental; fee: number }[]` to
  `BikeShare`, called from main next to `charge`.
  - It ends every running rental whose bike, parked (not `c.mode === 'player'`), is
    more than `ABANDON = 300` m from the player.
  - It also ends rentals whose bike has left `loose` or is `burnt`. Check what
    happens to such a car when its tile is unloaded: after a pick-up, main takes it
    out of `tileCars` (it "stays when its tile unloads"), so it may never go.
    Measure the distance by the position either way.
  - `fee` is `FEE_OFF_STATION = 500`, or `FEE_FAR = 1000` when the nearest station
    of its system is more than 3 km away (`near()` or a scan over `stations`).
  - After abandoning, `c.share.station` stays `null` (a bike outside a station) and
    the rental is put in `done`.
  - Main takes the fee with `wallet.take(fee)` and shows
    `t('You left the {name} bike outside a station: fee {price}')`.
- While riding a shared bike, add the running price to the hint in the `inCar`
  branch: `t('{name} bike: {minutes} min, {price} so far')`. For that, add
  `rental(c)` to `BikeShare`, returning the running rental (or `null`).
- While walking away from a parked rented bike, add
  `t('Your {name} bike is still rented: {minutes} min, {price} so far')` to the hint
  on foot, when nothing more important is showing. Players should know the meter
  is running.
- Update the file's header comment: remove "Until then every ride is free" and
  describe the paying.

### 6. Translations (`src/cs.ts`)

Add a Czech entry for every new English text, and keep the formatting of the existing
entries. Suggested translations:

| English | Czech |
| --- | --- |
| `Money: {money}` | `Peníze: {money}` |
| `Not enough money for a taxi (from {fare})` | `Na taxi nemáš dost peněz (od {fare})` |
| `Your money ran out, so the driver let you out` | `Došly ti peníze, řidič tě vysadil` |
| `The taxi crashed. You got out. The ride was free` | `Taxi bouralo, jízda je zadarmo` |
| `Meter: {fare}` | `Taxametr: {fare}` |
| `Ticket for {minutes} minutes: {price}` | `Jízdenka na {minutes} minut: {price}` |
| `Not enough money for a ticket ({price})` | `Na jízdenku nemáš dost peněz ({price})` |
| `<b>B</b> buy a ticket ({price}) · {secs} s left` | `<b>B</b> koupit jízdenku ({price}) · zbývá {secs} s` |
| `No ticket` | `Bez jízdenky` |
| `Ticket inspection! Fine for riding without a ticket: {fine}` | `Revize! Pokuta za jízdu bez jízdenky: {fine}` |
| `Ticket inspection! <b>B</b> pay the fine ({fine}) · <b>E</b> get off and run · {secs} s` | `Revize! <b>B</b> zaplatit pokutu ({fine}) · <b>E</b> vystoupit a utéct · {secs} s` |
| `The inspector called the police` | `Revizor zavolal policii` |
| `Busted · fine for riding without a ticket: {fine}` | `Chycen · pokuta za jízdu bez jízdenky: {fine}` |
| `Pay the fine` | `Zaplatit pokutu` |
| `Ticket inspection! You had no ticket, so they took all your money ({paid})` | `Revize bez jízdenky: revizor si vzal všechno, co ti zbylo ({paid})` |
| `Going in without a ticket?` | `Jdeš dovnitř bez jízdenky?` |
| `Buy a ticket for {minutes} minutes ({price})` | `Koupit jízdenku na {minutes} minut ({price})` |
| `Go in without a ticket` | `Jít bez jízdenky` |
| `Not enough money for a bike ({price})` | `Na kolo nemáš dost peněz ({price})` |
| `{name}: returned after {minutes} min, {price} in all` | `{name}: vráceno po {minutes} min, celkem {price}` |
| `You left the {name} bike outside a station: fee {price}` | `Kolo {name} zůstalo mimo stanici: poplatek {price}` |
| `Your {name} bike is still rented: {minutes} min, {price} so far` | `Kolo {name} máš pořád půjčené: {minutes} min, zatím {price}` |
| `{name} bike: {minutes} min, {price} so far` | `Kolo {name}: {minutes} min, zatím {price}` |

Check how the existing Czech lines address the player (the "ty" form, as in
`počkáš`) and keep to it. Avoid Czech wording that assumes the player's gender (such as
"vystoupil jsi").

### 7. Documentation

- `README.md`, the "Playing" section:
  - Add a new bullet, **Money**: you start with 10,000 Kč; taxis, PID tickets and
    shared bikes cost money; the balance isn't saved; you can't earn money yet.
  - Taxis: the fare is taken from your money; the ride stops when you run out; a
    crash means a free ride.
  - Trams, metro and funicular: the 90-minute ticket, 10 seconds to buy it after
    getting on (B), the choice on the way into the metro, the check, the 1,200 Kč
    fine, and running from the inspector (who calls the police after 10 s; if the
    police then catch you, they take 1,500 Kč). The NH funicular is free.
  - Shared bikes: paid as you go by nextbike's plan. A bike left outside a station
    and abandoned (more than 300 m away) costs a fee of 500 or 1,000 Kč.
- The README's URL parameters paragraph: add `?money=N`.
- "Not yet in the game": earning money.

## Verification

1. `npm run typecheck` and `npm run build` pass.
2. Check `rentalCost` against the expected values above. There's no test runner, so
   use a quick script in a temporary directory, not in the repo. For example, with
   Node ≥ 22.6: `node --experimental-strip-types` on a small file that imports
   the function. If `money.ts` imports modules that can't run in Node, put
   `rentalCost` in a file with no imports.
3. In the browser: `npm run dev` (port 5191, bound to 0.0.0.0). Open
   `http://localhost:5191/?go&start=14.4052,50.0808` and then the same URL with
   `&money=60`:
   - The HUD shows 10,000 Kč (or 60 Kč), in both English and Czech (`?lang=cs`).
   - Get on a tram at Újezd: the hint counts down 10 s with "B buy a ticket". B takes
     46 Kč and the banner says so. Get off and on again: no countdown, since the
     ticket is still valid.
   - Without buying, after 10 s the hint shows "No ticket". For a quick check,
     temporarily raise `CHECK_STOP` to 1 (don't commit that). At the next stop comes
     the inspection with its 5 s:
     - B takes 1,200 Kč (everything with `money=60`), and the tram goes on.
     - E gets you off. A person in ordinary clothes gets off after you and runs
       after you. If they catch you, you pay. If you get away for 10 s, one star
       lights up and the police come. Once you're far enough away, the inspector
       gives up and disappears.
     - Getting into a car during the chase calls the police at once.
     - If the police then catch you, "Busted" also takes 1,500 Kč. If you shake them
       off (no stars) and they catch you later for something else, nothing is taken
       for the ticket.
     - A car knocks the inspector over, and that's the crime `knock`.
     - A chase with the police on foot still works as before (the `steer`
       refactor).
   - With `money=60`, after one ticket, buying another (after 90 minutes of game
     time) is refused with a message.
   - Taxi (T): with 60 Kč the street taxi (60) can be called and the app ones too. The
     ride ends when the meter reaches the balance. With 30 Kč, no taxi can be called.
   - Metro without a valid ticket: the question comes first. "Buy" takes 46 Kč and
     "without" doesn't. With a valid ticket, the station list comes straight away.
     With too little money, "Buy" is disabled with the reason. Check the inspection
     at the way out with `CHECK_METRO` temporarily at 1: B pays, and walking away
     means running.
   - Petřín funicular: the 10-second countdown as on a tram; the NH funicular has none.
   - Shared bike (nextbike station near Újezd, or anywhere in `praha`):
     - Taking it needs 39 Kč, and 39 Kč is taken right away.
     - Once 30 game minutes have gone by (the developer panel can shift the time),
       another 39 is taken.
     - Returning it takes nothing more, and the banner shows the total.
     - Park it away from a station and walk off 300 m: the fee of 500 Kč, and the
       rental ends.
     - With `money=60`, the money runs out and the rental goes on without the
       balance going below 0.
4. Look at the console: no errors.

Leave out a full performance benchmark. The change adds no per-pixel work, only one
HUD element (and it's rewritten only when its text changes).

## Commits

Small logical commits, each with a body saying what changed and why, in the
repository's style (`git log` subjects such as "Taxis: …", "Shared bikes: …"):

1. `Money: a wallet with 10 000 Kč, shown in the HUD`
2. `Taxis: the fare taken from your money, out when it runs out`
3. `PID tickets: 90 minutes for trams, the metro and the Petřín funicular`
4. `Police: officers' steering round cars pulled out for others to use` (the refactor
   on its own, with no change in behaviour)
5. `Ticket inspectors: pay the fine or run, and they call the police`
6. `Shared bikes: rentals paid as they go by nextbike's plan, a fee for abandoned ones`
7. README (can be part of the commits above).

Don't push unless the user asks.
