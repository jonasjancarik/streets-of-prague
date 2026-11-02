import { Car } from './car.ts';
import { BURNING } from './fire.ts';
import { posts } from './posts.ts';
import { t } from './i18n.ts';
import { kc } from './money.ts';
import { padLabels } from './gamepad.ts';
import type { Fires } from './fire.ts';
import type { Crowd, Pedestrian } from './people.ts';
import type { Wallet } from './money.ts';
import type { Dialog, Line } from './portraits.ts';
import type { Point2 } from './map/geo.ts';
import type { StopAhead } from './passengers.ts';

// Missions: something to do that pays. A mission is data (jobs.ts): who gives it, what
// they say, and a plan made when it is offered, which is a list of steps and the pay.
// This file is the engine that runs one mission at a time: it offers it on your phone,
// walks through the steps, shows the objective, the time left and the marker, pays you
// through the wallet at the end, and calls it off when it can't be finished.
//
// Nothing here runs while no mission is offered or under way, apart from watching what
// you get into (a taxi, a fire engine…), so the game is as it was with missions idle.

// A line of English text and what fills its {gaps}; it is translated when it is shown,
// so a mission under way follows a change of language.
export type Text = [string, Record<string, string | number>?];
export const say = ([en, vars]: Text) => {
  if (!vars) return t(en);
  const filled: Record<string, string | number> = {};
  for (const k in vars) filled[k] = typeof vars[k] === 'string' ? t(vars[k]) : vars[k];
  return t(en, filled);
};

// A place known up front, wherever the loaded tiles are: a tram stop, a named place.
export interface Spot { name: string; x: number; y: number }

// What you have to be driving for a job ('tram': one you've taken over).
export type Vehicle = 'taxi' | 'fire' | 'ambulance' | 'tram';

// The game, as far as a mission needs it (main.ts hands this in).
export interface MissionWorld {
  me: () => { x: number; y: number; h: number };
  car: () => Car | null;
  // The tram you're driving: what its doors are doing and the stop ahead.
  tram: () => { doors: boolean; at: string | null; next: StopAhead | null; on: number; off: number } | null;
  // Something else has the screen or the player (a conversation, an arrest, the metro): no offers now.
  busy: () => boolean;
  loaded: (x: number, y: number) => boolean;
  free: (x: number, y: number) => boolean;
  standAt: (x: number, y: number) => Point2;
  crowd: () => Crowd;
  // Cars standing about within r of a spot (parked, left, wrecked).
  parked: (x: number, y: number, r: number) => Car[];
  addCar: (c: Car) => void;
  removeCar: (c: Car) => void;
  offscreen: (x: number, y: number) => boolean;
  // A parcel on your back (its colour), or none.
  carry: (colour: string | null) => void;
  stars: () => number;
  // The police come after you with at least this many stars.
  wanted: (stars: number) => void;
  places: () => Spot[];
  // Sights a tourist wants to see (jobs.ts SIGHTS, those on the map).
  sights: () => Spot[];
  hospitals: () => Spot[];
  fires: Fires;
  wallet: Wallet;
  dialog: Dialog;
  banner: (text: string, alert?: boolean) => void;
  rng: () => number;
}

// One mission under way.
export interface Run {
  def: MissionDef;
  steps: Step[];
  i: number;
  pay: number;
  bonus: number;
  left: number | null; // seconds left for this step, when it has a limit
  limit: number;
  spare: number[]; // for each timed step done: the share of its time that was left
  away: number; // seconds out of the vehicle the job needs
  cargo: Car | null; // the car your passenger sits in, or the car you are to bring
  owned: Set<Car>; // cars the mission put there or set burning
  mark: Car | null; // the car the job is about (to bring somewhere, or to wreck)
}

type Outcome = boolean | Text; // true: done; a text: failed, and why

export interface Step {
  goal: Text | ((w: MissionWorld, run: Run) => Text);
  at?: (w: MissionWorld, run: Run) => { x: number; y: number } | null;
  limit?: number;
  begin?: (run: Run, w: MissionWorld) => void;
  tick: (run: Run, w: MissionWorld, dt: number) => Outcome;
  // The mission is over, or has moved on: take away what this step put in the world.
  end?: (run: Run, w: MissionWorld) => void;
}

export interface Plan { steps: Step[]; pay: number; bonus?: number; vars?: Record<string, string | number> }

export interface Contact { who: string; name: string }

export interface MissionDef {
  id: string;
  title: string;
  from: Contact;
  offer: string; // what the phone says; {gaps} are filled from the plan's vars
  brief?: string[]; // said face to face the first time you take it
  needs?: Vehicle;
  faction?: string; // whose job it is, and what doing it is worth with them
  rep?: number;
  minRep?: number; // not offered below this standing with the faction
  again?: boolean; // the next one is offered as soon as this one is done
  unprompted?: number; // offered by itself about this often (seconds), when you're free
  plan: (w: MissionWorld, pick: Picker) => Plan | null;
}

export interface Progress { done: Record<string, number>; failed: number; earned: number }

const OFFER = 20; // s an offer stays on the phone
const GRACE = 20; // s you may be out of the vehicle a job needs
const NOTE = 6; // s the outcome stays in the card
const STILL = 1.2; // m/s: slower than this is stopped

const far = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
export const apart = far;
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

// Picks places for a plan.
export class Picker {
  constructor(private w: MissionWorld) {}

  // A known place between `min` and `max` m from `from` (the nearest to that ring if
  // none is in it, as long as it's at least 80 m off), not one of the names in `not`.
  spot(from: { x: number; y: number }, min: number, max: number, not: string[] = [], among = this.w.places()) {
    const list = among.filter((s) => !not.includes(s.name) && far(s, from) > 80);
    const ring = list.filter((s) => { const d = far(s, from); return d >= min && d <= max; });
    if (ring.length) return ring[Math.floor(this.w.rng() * ring.length)];
    const off = (s: Spot) => { const d = far(s, from); return d < min ? min - d : d - max; };
    return list.sort((a, b) => off(a) - off(b))[0] ?? null;
  }

  nearest(from: { x: number; y: number }, among: Spot[]) {
    return among.slice().sort((a, b) => far(a, from) - far(b, from))[0] ?? null;
  }
}

// ---- Steps ---------------------------------------------------------------

// A conversation; the clock waits.
export function talk(lines: Line[], goal: Text): Step {
  let over = false;
  return {
    goal,
    begin: (_run, w) => { void w.dialog.play(lines).then(() => { over = true; }); },
    tick: () => over,
    // Called off in the middle of it: the conversation goes too.
    end: (_run, w) => { if (!over && w.dialog.active) { w.dialog.lines = []; w.dialog.next(); } },
  };
}

// Get to a place: on foot, or stopped there in what you drive. `carry` puts a parcel
// on your back once you're there (a colour), or takes it off (null).
export function goTo(spot: Spot, o: { goal: Text; limit?: number; r?: number; carry?: string | null }): Step {
  return {
    goal: o.goal, limit: o.limit, at: () => spot,
    tick: (_run, w) => {
      const c = w.car();
      if (far(w.me(), spot) > (o.r ?? 12) || (c && c.speed > STILL)) return false;
      if (o.carry !== undefined) w.carry(o.carry);
      return true;
    },
    end: (_run, w) => { if (o.carry) w.carry(null); },
  };
}

// Somebody waits at a place for you to stop the car beside them, and gets in.
export function pickUp(spot: Spot, o: { goal: Text; limit?: number; r?: number }): Step {
  let p: Pedestrian | null = null, stand: Point2 | null = null, boarding = 0;
  return {
    goal: o.goal, limit: o.limit, at: () => p ?? spot,
    tick: (run, w, dt) => {
      const m = w.me(), crowd = w.crowd(), d0 = far(m, spot);
      if (p && !crowd.people.includes(p)) p = null;
      // They are only there while you're near enough to see them.
      if (d0 > 110 || !w.loaded(spot.x, spot.y)) {
        if (p && d0 > 140) { crowd.retire(p); p = null; }
        return false;
      }
      stand ??= w.standAt(spot.x, spot.y);
      p ??= crowd.spawnAt(stand[0], stand[1]);
      if (p.state === 'down') return boarding > 0 || far(m, p) < 8 ? ['Your passenger was knocked over'] : false;
      const c = w.car(), d = c ? far(c, p) : Infinity;
      if (!boarding) {
        if (far(p, { x: stand[0], y: stand[1] }) > 3) { p.x = stand[0]; p.y = stand[1]; }
        Object.assign(p, { state: 'flee', t: 1, vx: 0, vy: 0, h: Math.atan2(m.y - p.y, m.x - p.x) });
        if (c && c.speed < STILL && d < (o.r ?? 10)) boarding = dt;
        return false;
      }
      boarding += dt;
      if (!c || c.speed > 2.5 || d > 16) { boarding = 0; return false; } // you drove off again
      if (d < c.spec.W / 2 + 0.9 || boarding > 6) {
        crowd.retire(p);
        p = null;
        run.cargo = c;
        return true;
      }
      Object.assign(p, { state: 'flee', t: 1, vx: ((c.x - p.x) / d) * 1.9, vy: ((c.y - p.y) / d) * 1.9 });
      return false;
    },
    // Left standing there: they go back to their walk.
    end: (_run, w) => { if (p && w.crowd().people.includes(p) && p.state === 'flee') p.t = 0; p = null; },
  };
}

// Stop at a place with your passenger: they get out on the side where there's room.
export function dropOff(spot: Spot, o: { goal: Text; limit?: number; r?: number }): Step {
  return {
    goal: o.goal, limit: o.limit, at: () => spot,
    tick: (run, w) => {
      const c = w.car();
      if (!c || c !== run.cargo || c.speed > STILL || far(c, spot) > (o.r ?? 14)) return false;
      const lx = -Math.sin(c.h), ly = Math.cos(c.h), off = c.spec.W / 2 + 0.8;
      for (const s of [-1, 1]) {
        const x = c.x + lx * s * off, y = c.y + ly * s * off;
        if (!w.free(x, y)) continue;
        Object.assign(w.crowd().spawnAt(x, y), { state: 'flee', t: 2.5, vx: lx * s * 1.6, vy: ly * s * 1.6 });
        break;
      }
      run.cargo = null;
      return true;
    },
  };
}

// A car on clear ground near a spot, for a mission to use.
function placeCar(w: MissionWorld, type: string, x: number, y: number, paint?: string) {
  for (let r = 0, n = 0; r <= 36 && n < 60; r += 4) for (let a = 0; a < (r ? 8 : 1) && n < 60; a++, n++) {
    const cx = x + Math.cos((a * Math.PI) / 4) * r, cy = y + Math.sin((a * Math.PI) / 4) * r;
    if (!w.free(cx, cy) || w.parked(cx, cy, 5).length) continue;
    const c = new Car(type, w.rng, cx, cy, w.rng() * Math.PI * 2, paint);
    if (!c.worldSamples().every(([sx, sy]) => w.free(sx, sy)) || posts.touches(c)) continue;
    c.mode = 'loose';
    w.addCar(c);
    return c;
  }
  return null;
}

// A car burns near a place: get there with the fire engine and put it out before it
// blows up. The car is one parked there (or one put there), set alight as you come
// near; nobody else is sent to it while the job is yours.
export function putOut(spot: Spot, o: { goal: Text; near: Text; limit?: number }): Step {
  let car: Car | null = null, made = false;
  return {
    goal: () => (car ? o.near : o.goal), limit: o.limit, at: () => car ?? spot,
    tick: (run, w) => {
      const m = w.me(), mine = w.car();
      if (!car) {
        if (far(m, spot) > 170 || !w.loaded(spot.x, spot.y)) return false;
        car = w.parked(spot.x, spot.y, 60)
          .filter((c) => !c.two && !c.burnt && c !== mine && !['fire', 'ambulance', 'police'].includes(c.type) && far(c, m) > 35 && !w.fires.blazes.has(c))
          .sort((a, b) => far(a, spot) - far(b, spot))[0] ?? null;
        if (!car) { car = placeCar(w, 'hatch', spot.x, spot.y); made = !!car; }
        if (!car) return far(m, spot) < 25; // nowhere for a car to stand: a false alarm, once you're there
        run.owned.add(car);
        car.damage = Math.max(car.damage, 95);
        w.fires.check(car);
        // From here the fire sets the pace; getting there early is what the bonus is for.
        if (run.left !== null && run.limit > 0) run.spare.push(run.left / run.limit);
        run.left = null;
        return false;
      }
      if (car.burnt) return ['The car blew up before the fire was out'];
      if (car.damage < BURNING) return true;
      if (!w.fires.blazes.has(car)) w.fires.check(car); // (a teleport clears the fires)
      return false;
    },
    // A car put there for the job goes when the job ends out of sight of it; one that
    // was parked there stays, burnt or not, as any other would.
    end: (run, w) => {
      if (car && made && !car.burnt && w.offscreen(car.x, car.y)) w.removeCar(car);
      if (car) run.owned.delete(car);
      car = null;
    },
  };
}

// The car a job is about, near a spot: one parked there that isn't anybody's in
// particular (no taxi, police or rescue), or, with none, one of `type` put there. It is
// found only once you're near and its tiles are in.
function carNear(w: MissionWorld, spot: Spot, type: string, paint?: string) {
  if (far(w.me(), spot) > 170 || !w.loaded(spot.x, spot.y)) return null;
  const mine = w.car();
  const found = w.parked(spot.x, spot.y, 45)
    .filter((c) => !c.two && !c.burnt && c !== mine && c.damage < 30 && !['fire', 'ambulance', 'police', 'taxi', 'bus', 'truck'].includes(c.type) && far(c, w.me()) > 25)
    .sort((a, b) => far(a, spot) - far(b, spot))[0];
  return found ?? placeCar(w, type, spot.x, spot.y, paint);
}

// Find the car the job is about near a spot and get into it. From then on it is the
// car you have to stay in (as with a passenger, out of it too long and the job fails).
export function takeCar(spot: Spot, o: { goal: Text; near: Text; type: string; paint?: string; limit?: number }): Step {
  return {
    goal: (_w, run) => (run.mark ? o.near : o.goal), limit: o.limit, at: (_w, run) => run.mark ?? spot,
    tick: (run, w) => {
      if (!run.mark) {
        run.mark = carNear(w, spot, o.type, o.paint);
        if (run.mark) run.owned.add(run.mark);
        return false;
      }
      if (run.mark.burnt) return ['The car is a wreck'];
      if (w.car() !== run.mark) return false;
      run.cargo = run.mark;
      return true;
    },
  };
}

// Bring the car you took to a place and stop there. What it pays goes down with the
// damage the car took on the way.
export function bringCar(spot: Spot, o: { goal: Text; limit?: number; r?: number }): Step {
  return {
    goal: o.goal, limit: o.limit, at: () => spot,
    tick: (run, w) => {
      const c = run.mark;
      if (!c || c.burnt) return ['The car is a wreck'];
      if (w.car() !== c || c.speed > STILL || far(c, spot) > (o.r ?? 15)) return false;
      run.pay = Math.round(run.pay * Math.max(0.3, Math.min(1, 1 - c.damage / 120)) / 10) * 10;
      run.cargo = null;
      return true;
    },
  };
}

// The car the job is about, near a spot, has to go up in flames: shot at, rammed,
// whatever it takes. Nobody comes to put it out while the job is yours (and once it
// burns, nobody will in time).
export function wreck(spot: Spot, o: { goal: Text; near: Text; type: string; paint?: string; limit?: number }): Step {
  return {
    goal: (_w, run) => (run.mark ? o.near : o.goal), limit: o.limit,
    at: (_w, run) => run.mark ?? spot,
    tick: (run, w) => {
      if (!run.mark) {
        run.mark = carNear(w, spot, o.type, o.paint);
        if (run.mark) run.owned.add(run.mark);
        return false;
      }
      return !!run.mark.burnt || run.mark.damage >= BURNING;
    },
  };
}

// The police are after you (at least `stars`) with your passenger in the car: shake them
// off before you go where you're going.
export function lose(stars: number, o: { goal: Text }): Step {
  return {
    goal: o.goal,
    begin: (_run, w) => w.wanted(stars),
    tick: (_run, w) => w.stars() === 0,
  };
}

// Drive past a place with your passenger: close enough to see it, at any speed.
export function pass(spot: Spot, o: { goal: Text; r?: number }): Step {
  return {
    goal: o.goal, at: () => spot,
    tick: (run, w) => !!run.cargo && w.car() === run.cargo && far(run.cargo, spot) < (o.r ?? 90),
  };
}

// Driving a tram: stop at the next `n` stops and open the doors. Each stop pays, and
// so does everyone who gets on or off.
export function serve(n: number, o: { perStop: number; perHead: number; limit: number }): Step {
  let served = 0, open: string | null = null, last: string | null = null;
  return {
    limit: o.limit,
    goal: (w) => {
      const next = w.tram()?.next?.stop;
      const count = { done: served, n };
      return open ? ['Wait for everyone to get on and off ({done} of {n})', count]
        : next && next.name !== last ? ['Stop at {name} and open the doors ({done} of {n})', { name: next.name, ...count }]
        : ['Drive on to the next stop ({done} of {n})', count];
    },
    at: (w) => { const next = w.tram()?.next?.stop; return next && next.name !== last ? next : null; },
    tick: (run, w) => {
      const tram = w.tram();
      if (!tram) return false;
      if (tram.doors && !open && tram.at) open = tram.at;
      if (!tram.doors && open) {
        if (open !== last) {
          served++;
          last = open;
          run.pay += o.perStop + o.perHead * (tram.on + tram.off);
          run.left = run.limit = o.limit;
        }
        open = null;
      }
      return served >= n;
    },
  };
}

// ---- The engine ------------------------------------------------------------

export class Missions {
  state: 'idle' | 'offer' | 'on' = 'idle';
  run: Run | null = null;
  offered: { def: MissionDef; plan: Plan; left: number } | null = null;
  progress: Progress = { done: {}, failed: 0, earned: 0 };
  // Offers nobody asked for (when you get into a taxi, now and then on foot). Test runs turn them off.
  auto = true;
  note: { text: string; good: boolean; t: number } | null = null;
  // Told how a mission ended (main.ts keeps the factions' books with it).
  onDone: ((def: MissionDef, paid: number) => void) | null = null;
  onFail: ((def: MissionDef) => void) | null = null;
  // Whether a job may be offered (its faction's standing with you).
  allowed: (def: MissionDef) => boolean = () => true;
  private pick: Picker;
  private wasIn: Vehicle | null = null;
  private inFor = 0;
  private askedIn = false;
  private free = 0; // seconds with nothing to do, towards the next unprompted offer
  private next: { def: MissionDef; t: number } | null = null;
  private sure = 0; // seconds left to press J again to give up
  private turn = 0;

  constructor(private w: MissionWorld, public defs: MissionDef[]) {
    this.pick = new Picker(w);
  }

  // What you're driving, as far as jobs care.
  vehicle(): Vehicle | null {
    if (this.w.tram()) return 'tram';
    const type = this.w.car()?.type;
    return type === 'taxi' || type === 'fire' || type === 'ambulance' ? type : null;
  }

  owns(c: Car) { return !!this.run?.owned.has(c); }

  private say(text: Text, good = false) { this.note = { text: say(text), good, t: NOTE }; }

  // Puts a job on the phone. False when there's nowhere to do it from here.
  propose(def: MissionDef, quiet = false) {
    if (this.state === 'on') return false;
    const plan = this.allowed(def) ? def.plan(this.w, this.pick) : null;
    if (!plan) {
      if (!quiet) this.say(['No work around here right now']);
      return false;
    }
    this.offered = { def, plan, left: OFFER };
    this.state = 'offer';
    this.note = null;
    return true;
  }

  // J with nothing on: a job that fits what you're driving, or one that needs nothing.
  ask() {
    const veh = this.vehicle();
    const fits = this.defs.filter((d) => (veh ? d.needs === veh : !d.needs) && this.allowed(d));
    if (!fits.length) { this.say(['No work around here right now']); return false; }
    return this.propose(fits[this.turn++ % fits.length]);
  }

  accept() {
    const o = this.offered;
    if (!o) return false;
    this.start(o.def, o.plan);
    return true;
  }

  // Starts a mission (straight away, for ?mission= and tests; `brief` false skips the talk).
  start(def: MissionDef, plan = def.plan(this.w, this.pick), brief = true) {
    if (!plan) return false;
    this.stop();
    const steps = [...plan.steps];
    if (brief && def.brief && !this.progress.done[def.id]) {
      steps.unshift(talk(def.brief.map((text) => ({ who: def.from.who, name: t(def.from.name), text: t(text, plan.vars) })), [def.title]));
    }
    this.run = { def, steps, i: 0, pay: plan.pay, bonus: plan.bonus ?? 0, left: null, limit: 0, spare: [], away: 0, cargo: null, owned: new Set(), mark: null };
    this.state = 'on';
    this.offered = null;
    this.note = null;
    this.sure = 0;
    this.begin();
    return true;
  }

  private begin() {
    const run = this.run!, step = run.steps[run.i];
    run.left = step.limit ?? null;
    run.limit = step.limit ?? 0;
    step.begin?.(run, this.w);
  }

  // Ends whatever is on without a word (a teleport into a saved game, a restart).
  stop() {
    const run = this.run;
    if (run) for (const s of run.steps.slice(0, run.i + 1)) s.end?.(run, this.w);
    this.run = null;
    this.offered = null;
    this.state = 'idle';
    this.sure = 0;
  }

  fail(why: Text, banner = true) {
    const run = this.run;
    if (!run) return;
    this.stop();
    this.progress.failed++;
    this.note = { text: `${t('Job failed')}. ${say(why)}.`, good: false, t: NOTE };
    if (banner) this.w.banner(`${t('Job failed')} · ${say(why)}`, true);
    this.onFail?.(run.def);
  }

  giveUp() {
    if (!this.run) return;
    const def = this.run.def;
    this.stop();
    this.say(['You gave the job up']);
    this.onFail?.(def);
  }

  private finish() {
    const run = this.run!;
    const spare = run.spare.length ? run.spare.reduce((a, b) => a + b, 0) / run.spare.length : 0;
    const paid = Math.round(run.pay + run.bonus * spare);
    this.stop();
    this.w.wallet.give(paid, run.def.id);
    this.progress.done[run.def.id] = (this.progress.done[run.def.id] ?? 0) + 1;
    this.progress.earned += paid;
    this.say(['Job done: {pay}', { pay: kc(paid) }], true);
    this.w.banner(`${t('Job done')} · ${t(run.def.title)}: +${kc(paid)}`);
    this.onDone?.(run.def, paid);
    if (run.def.again) this.next = { def: run.def, t: 4 };
  }

  // Wasted or busted: the job is off (the game's own banner says why).
  onWasted() { if (this.run) this.fail(['You ended up in hospital'], false); else this.offered = null, this.state = 'idle'; }
  onBusted() { if (this.run) this.fail(['You were arrested'], false); else this.offered = null, this.state = 'idle'; }

  // J (or a tap on the card). Returns true when the key was taken.
  key(code: string) {
    if (code !== 'KeyJ') return false;
    if (this.state === 'offer') this.accept();
    else if (this.state === 'on') {
      if (this.sure > 0) this.giveUp(); else this.sure = 4;
    } else this.ask();
    return true;
  }

  // One step of the world.
  update(dt: number) {
    const w = this.w;
    if (this.note && (this.note.t -= dt) <= 0) this.note = null;
    if (this.sure > 0) this.sure -= dt;
    const veh = this.vehicle();
    if (veh !== this.wasIn) { this.wasIn = veh; this.inFor = 0; this.askedIn = false; }
    this.inFor += dt;

    if (this.state === 'offer') {
      const o = this.offered!;
      // An offer for a vehicle goes when you leave it.
      if ((o.left -= dt) <= 0 || (o.def.needs && o.def.needs !== veh)) { this.offered = null; this.state = 'idle'; }
      return;
    }
    if (this.state === 'idle') {
      if (!this.auto || w.busy()) return;
      if (this.next && (this.next.t -= dt) <= 0) {
        const { def } = this.next;
        this.next = null;
        if (def.needs === (veh ?? undefined)) this.propose(def, true);
        return;
      }
      // Into a taxi, an ambulance, a fire engine or a tram's cab: its job is offered once.
      if (veh && !this.askedIn && this.inFor > 2.5) {
        this.askedIn = true;
        const def = this.defs.find((d) => d.needs === veh);
        if (def) this.propose(def, true);
        return;
      }
      // Now and then, a job that needs nothing, while you're free and not wanted.
      if (!veh && w.stars() === 0) {
        this.free += dt;
        const open = this.defs.filter((d) => !d.needs && d.unprompted && this.allowed(d));
        const def = open.length ? open[this.turn % open.length] : null;
        // (The first one comes sooner, so a new player finds out there is work.)
        const first = !this.progress.failed && !Object.keys(this.progress.done).length;
        if (def && this.free > def.unprompted! * (first ? 0.25 : 1)) {
          this.free = 0;
          this.turn++;
          this.propose(def, true);
        }
      }
      return;
    }

    const run = this.run!, step = run.steps[run.i];
    // Out of the vehicle the job needs, or of the car your passenger sits in.
    const mine = w.car();
    if (run.cargo?.burnt) { this.fail(['The car is a wreck']); return; }
    const out = run.cargo ? mine !== run.cargo : !!run.def.needs && veh !== run.def.needs;
    run.away = out ? run.away + dt : 0;
    if (run.away > GRACE) { this.fail(['You were out of the vehicle too long']); return; }
    if (run.left !== null && (run.left -= dt) <= 0) { this.fail(['You ran out of time']); return; }
    const result = step.tick(run, w, dt);
    if (result === false) return;
    if (result !== true) { this.fail(result); return; }
    if (run.limit > 0 && run.left !== null) run.spare.push(Math.max(0, run.left) / run.limit);
    run.i++;
    if (run.i >= run.steps.length) { this.finish(); return; }
    this.begin();
  }

  // Where the marker goes.
  target() {
    const run = this.run;
    return run ? run.steps[run.i].at?.(this.w, run) ?? null : null;
  }

  objective() {
    const run = this.run;
    if (!run) return '';
    const goal = run.steps[run.i].goal;
    return say(typeof goal === 'function' ? goal(this.w, run) : goal);
  }

  // The card in the HUD, as HTML ('' when there's nothing to say).
  card(touch = false) {
    const key = (what: string) => (touch ? `<span class="job-key">${t('Tap here: {what}', { what })}</span>` : padLabels(`<b>J</b> ${what}`));
    const note = this.note ? `<div class="job-note${this.note.good ? ' good' : ''}">${esc(this.note.text)}</div>` : '';
    if (this.state === 'offer') {
      const { def, plan, left } = this.offered!;
      return `<div class="job-from">${esc(t(def.from.name))} · ${t('job offer')}</div>`
        + `<div class="job-text">${esc(t(def.offer, plan.vars))}</div>`
        + `<div class="job-meta">${t('Pay: about {pay}', { pay: kc(plan.pay + (plan.bonus ?? 0) / 2) })}</div>`
        + `<div class="job-keys">${key(t('take the job'))} · ${Math.ceil(left)} s</div>`;
    }
    const run = this.run;
    if (!run) return note;
    const at = this.target(), d = at ? far(at, this.w.me()) : 0;
    const meta = [
      run.left !== null ? `<span class="${run.left < 20 ? 'late' : ''}">${mmss(run.left)}</span>` : '',
      at ? (d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`) : '',
      kc(run.pay),
    ].filter(Boolean).join(' · ');
    const out = run.away > 1 ? `<div class="job-note">${esc(t(run.cargo ? 'Get back in the car: {secs} s' : 'Get back in: {secs} s', { secs: Math.ceil(GRACE - run.away) }))}</div>` : '';
    return `<div class="job-from">${esc(t(run.def.title))}</div>`
      + `<div class="job-text">${esc(this.objective())}</div>`
      + `<div class="job-meta">${meta}</div>${out}`
      + `<div class="job-keys">${this.sure > 0 ? key(t('again to give the job up')) : key(t('give up'))}</div>`;
  }

  // For the test API: what's going on, as data.
  probe() {
    const run = this.run, at = this.target();
    return {
      state: this.state, id: run?.def.id ?? this.offered?.def.id ?? null,
      step: run ? run.i : -1, steps: run ? run.steps.length : 0, objective: this.objective(),
      left: run?.left == null ? null : Math.round(run.left), pay: run ? Math.round(run.pay) : this.offered ? this.offered.plan.pay : 0,
      at: at ? { x: at.x, y: at.y } : null, away: run ? Math.round(run.away) : 0,
      note: this.note?.text ?? null, done: { ...this.progress.done }, failed: this.progress.failed, earned: this.progress.earned,
    };
  }
}
