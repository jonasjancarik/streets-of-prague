# Plan 002: Money, spent on taxis, public transport and shared bikes

> An implementation plan for another agent. Planned at `f603c97` on `main`, 2026-09-29.
> The working tree then had someone else's uncommitted work (the WebGPU trial, and a
> beacon over your taxi in `src/taxi.ts`, `src/main.ts`, `src/cs.ts`, `src/police.ts`).
> Check `git status` and `git diff` before you start. Don't revert or overwrite changes
> you didn't make. If `src/taxi.ts` or `src/main.ts` still has uncommitted changes,
> work around them and commit only your own hunks (`git add -p`), or stop and ask.

## Status

- Priority: P1
- Effort: M (about a day)
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
   getting on; at the metro you choose on the way in. Ride without one and ticket
   inspectors may catch you and fine you.
3. **Shared bikes (nextbike)**: the rental is charged when you return the bike, by the
   operator's real pricing plan (GBFS, already in `bikes.json`).

The balance is always shown in the HUD. If you can't afford something, you can't
start it, and a short message says why.

Out of scope: earning money, saving the balance between games, police fines, parking,
pedal boats, inspectors you can see (they're only a message), choosing between
ticket types, and buses (you can't ride them yet).

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
  - **Inspectors**: riding without a ticket, at each tram or funicular stop the
    vehicle arrives at there's a **5%** chance of a check. On the metro the chance is
    **15%** a ride, checked on arrival. Keep these as named constants so they can be
    tuned.
  - **Fine**: **1,200 Kč**, PID's fine paid on the spot (2026). You pay what you
    have, never going below 0. The message is red, like "Busted"
    (`showBanner(…, true)`). Once fined, you aren't checked again on the same ride.
- **Taxi**:
  - You can't call one unless you can afford its starting fare (`firm.start`).
  - During the ride the hint shows the meter.
  - When the meter reaches your balance, the driver pulls over and lets you out:
    *"Your money ran out, so the driver let you out"*.
  - If the taxi **crashes**, the ride is free.
- **Bikes**:
  - Renting from a station needs at least the price of the first charge (39 Kč with
    nextbike's standard plan).
  - The whole rental is charged when the bike goes back to a station. If the cost is
    more than you have, all you have left is taken (no debt).
  - A bike parked away from a station keeps its rental running, as it does now.
  - A bike that's never returned is never charged. That's a known gap; add it to
    "Known issues" in the README.

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
export const CHECK_STOP = 0.05; // chance of inspectors at each stop, riding without a ticket
export const CHECK_METRO = 0.15; // and on a metro ride

// One ride on a tram or the Petřín funicular: with a ticket, still time to buy one,
// or riding without (and caught at most once).
export class PidRide {
  state: 'ticket' | 'grace' | 'dodging' | null = null;
  left = 0; // seconds left to buy
  constructor(private wallet: Wallet) {}
  board(now: number): void // 'ticket' if one is valid, else 'grace' with left = GRACE
  buy(now: number): boolean // only during 'grace'; then 'ticket'
  update(realDt: number): void // 'grace' runs out into 'dodging'
  // At a stop: inspectors, maybe. Returns the fine taken, or null.
  // After a fine, state becomes 'ticket'.
  check(chance: number, roll = Math.random()): number | null
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

Create one `PidRide` in main (`const pid = new PidRide(wallet)`) and one helper that
fines you, so the tram, funicular and metro all say the same thing:

```ts
// Caught without a ticket: the fine, or all you have left.
const fined = (paid: number) => showBanner(paid < FINE
  ? t('Ticket inspection! You had no ticket, so they took all your money ({paid})', { paid: kc(paid) })
  : t('Ticket inspection! Fine for riding without a ticket: {fine}', { fine: kc(FINE) }), true);
```

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
- Inspection: when the tram **arrives** at a stop with you on it, call
  `pid.check(CHECK_STOP)`; if it returns a number, call `fined(n)`. Arriving means
  `ride.atStop()` turned from false to true; keep the previous value in main.
  Check only while riding, not at the stop where you got on.

**Petřín funicular**:

- Add `ticket: boolean` to the line spec in `SPECS`: `true` for Petřín, `false` for
  NH.
- After `funicular.board(cabin)`, if `cabin.line.spec.ticket`, call
  `pid.board(clock.t)`. In the funicular's branch of `enterOrExit`, call
  `pid.leave()`.
- Buying (B or touch) and the hint work the same as on a tram. Add the grace part
  to `funicular.hint()`, or put it in front of it in main.
- Inspection: when `funicular.me.stop` turns from `null` to a station, call
  `pid.check(CHECK_STOP)`.

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
- Inspection is checked on arrival. In main's `onArrive`, if `metro.dodging`, roll
  `Math.random() < CHECK_METRO`; if it hits, take `wallet.take(FINE)` and call
  `fined(...)`. Then set `metro.dodging = false`.
- A ticket bought on a tram also covers the metro, and the other way round, within
  its 90 minutes.

The police's rules (no arrest on a tram) don't change.

### 5. Shared bikes (`src/bikeshare.ts` and main)

- `rent(c, now, afford: (kc: number) => boolean)`:
  - For a new rental (a bike taken from a station), if
    `!afford(rentalCost(plan, 0))`, return `false`.
  - A bike you parked yourself (with its rental still running) is let go as it is now.
  - `plan` means `system.plans[0]`. Write a small `planOf(system)` helper for it.
- In main: `if (best.share && !bikeShare.rent(best, clock.t, (n) => wallet.has(n))) { showBanner(t('Not enough money for a bike ({price})', …)); return; }`.
  Show the price of the first charge.
- Returning (main ~line 494): `const r = bikeShare.leave(c, clock.t);`. If `r` is set:
  - `const cost = rentalCost(planOf(r.system), r.seconds / 60)`.
  - `wallet.take(cost)`.
  - Show `showBanner(t('{name}: {minutes} min, {price}', …))` with the system's name.
- While riding a shared bike, add the running price to the hint in the `inCar`
  branch: `t('{name} bike: {minutes} min, {price} so far')`. For that, add
  `rental(c)` to `BikeShare`, returning the running rental (or `null`), with the time
  so far measured as in `leave`.
- Update the file's header comment: remove "Until then every ride is free".

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
| `Ticket inspection! You had no ticket, so they took all your money ({paid})` | `Revize bez jízdenky: revizor si vzal všechno, co ti zbylo ({paid})` |
| `Going in without a ticket?` | `Jdeš dovnitř bez jízdenky?` |
| `Buy a ticket for {minutes} minutes ({price})` | `Koupit jízdenku na {minutes} minut ({price})` |
| `Go in without a ticket` | `Jít bez jízdenky` |
| `Not enough money for a bike ({price})` | `Na kolo nemáš dost peněz ({price})` |
| `{name}: {minutes} min, {price}` | `{name}: {minutes} min, {price}` |
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
    getting on (B), the choice on the way into the metro, inspectors and the
    1,200 Kč fine. The NH funicular is free.
  - Shared bikes: the price follows nextbike's plan.
- The README's URL parameters paragraph: add `?money=N`.
- "Not yet in the game": earning money.
- "Known issues": a bike that's never returned is never charged.

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
   - Without buying, after 10 s the hint shows "No ticket". For a quick check of the
     fine, temporarily raise `CHECK_STOP` to 1 (don't commit that). At the next stop
     1,200 Kč is taken, or everything with `money=60`, and you aren't checked again
     on that ride.
   - With `money=60`, after one ticket, buying another (after 90 minutes of game
     time) is refused with a message.
   - Taxi (T): with 60 Kč the street taxi (60) can be called and the app ones too. The
     ride ends when the meter reaches the balance. With 30 Kč, no taxi can be called.
   - Metro without a valid ticket: the question comes first. "Buy" takes 46 Kč and
     "without" doesn't. With a valid ticket, the station list comes straight away.
     With too little money, "Buy" is disabled with the reason. Check the fine on
     arrival with `CHECK_METRO` temporarily at 1.
   - Petřín funicular: the 10-second countdown as on a tram; the NH funicular has none.
   - Shared bike (nextbike station near Újezd, or anywhere in `praha`): taking it
     needs 39 Kč. Returning it to a station takes the price. The hint shows the
     running price.
4. Look at the console: no errors.

Leave out a full performance benchmark. The change adds no per-pixel work, only one
HUD element (and it's rewritten only when its text changes).

## Commits

Small logical commits, each with a body saying what changed and why, in the
repository's style (`git log` subjects such as "Taxis: …", "Shared bikes: …"):

1. `Money: a wallet with 10 000 Kč, shown in the HUD`
2. `Taxis: the fare taken from your money, out when it runs out`
3. `PID tickets: 90 minutes for trams, the metro and the Petřín funicular, and inspectors`
4. `Shared bikes: rentals charged by nextbike's pricing plan`
5. README (can be part of the commits above).

Don't push unless the user asks.
