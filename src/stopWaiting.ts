import type { Crowd, Pedestrian } from './people.ts';
import type { TramVehicle } from './trams.ts';
import { HALF, headsignAt } from './trams.ts';
import type { Funicular, FunicularCar } from './funicular.ts';
import { busDoors, type Car } from './car.ts';
import { clamp } from './network.ts';

// People waiting at the stops near you: bus stops, tram stops and the funicular's
// stations. A few stand round each stop's sign, facing the track or the street: more
// where more lines stop, on busier streets and at the busy hours of the day (how full the
// roads are then, TSK's travel times in src/traffic.ts, stands in for how many people are
// travelling: nobody publishes how many wait at a stop). Each waits for one of the stop's
// lines. When that line's bus, tram or funicular car stands at the stop with its doors
// open, they walk to its nearest door and get on, and it waits for anyone still on their
// way; a few people get off it, more at the end of the line. Then the stop fills again,
// one at a time.
//
// They're people of the crowd (src/people.ts) in its 'hold' state, taken from the
// passers-by: one walks over from nearby, or, where nobody would see it, someone from
// out of sight is put there. Frightened off, knocked over or needed by something else,
// they drop out of the queue.
//
// A bus you drive works the same way once you stop by a sign and open its doors (X): people
// waiting for its line get on, a few get off, and the doors shut by themselves when nobody
// is left to get on or off. It can't move off while they're open. On a tram you drive,
// src/passengers.ts lets people off; those waiting for its line get on here.

export const WAITING = {
  first: 1.5, // people at a stop with one line, on an ordinary street at the busiest hour
  perLine: 0.9, // and for each line after the first
  most: 10, // at one stop
  hold: 25, // s: the longest a vehicle waits for someone walking to its doors
  reach: 30, // m: how far off someone walks over from to wait, in view
};

export type StopKind = 'bus' | 'tram' | 'funicular';

// A stop people wait at: where its sign is and which way its vehicles go (`ang`), the lines
// that stop there and where round the sign people stand: `along` (m ahead of the sign,
// from and to) and `out` (m out from it, on the right of the way the vehicles go, or on
// both sides of the track with `both`). `open`: false while nothing runs; `many`: how many
// more wait there than the street's busy hours would say (1).
export interface WaitStop {
  kind: StopKind; x: number; y: number; ang: number; name: string; refs: readonly string[];
  along: [number, number]; out: [number, number]; both?: boolean; many?: number;
  open?: () => boolean;
}

// A vehicle standing at a stop with its doors open: the line it's on, whether the stop is
// the end of it, where its doors are (on the ground just outside each, and the way out),
// which stop it stands at, how to keep it there a little longer, and whether people get
// off it here (false: something else sees to that).
export interface Door { x: number; y: number; nx: number; ny: number }
export interface Standing {
  key: object; kind: StopKind; ref: string; end: boolean; doors: Door[];
  by: (s: WaitStop) => boolean;
  hold: (() => void) | null;
  off: boolean;
}

// A bus: the doors along its right side (busDoors), at its front's stop by the sign
// (the kerb can be a parking lane away).
export function busStanding(c: Car, ref: string, end: boolean, hold: (() => void) | null): Standing {
  const cs = Math.cos(c.h), sn = Math.sin(c.h), out = c.spec.W / 2 + 0.35;
  return {
    key: c, kind: 'bus', ref, end, hold, off: true,
    doors: busDoors(c.spec.L).map((d) => ({ x: c.x + cs * d + sn * out, y: c.y + sn * d - cs * out, nx: sn, ny: -cs })),
    by: (s) => s.kind === 'bus' && byBus(s, c),
  };
}
function byBus(s: WaitStop, c: Car) {
  const dx = s.x - c.x, dy = s.y - c.y, cs = Math.cos(c.h), sn = Math.sin(c.h);
  return Math.cos(c.h - s.ang) > 0.7 && Math.abs(dx * cs + dy * sn) < c.spec.L / 2 + 8 && Math.abs(dx * sn - dy * cs) < 8;
}

// A tram: a door on the right of each of its sections (as in src/passengers.ts), at the
// stop whose sign its front stands by.
const TRAM_OUT = 1.6; // m from a section's middle to just outside its door
export function tramStanding(v: TramVehicle, off: boolean, hold: (() => void) | null): Standing {
  const h = v.line.halts[v.halt];
  return {
    key: v, kind: 'tram', ref: v.line.ref, off, hold,
    end: !!h && (h.to !== undefined || h.name === headsignAt(v.line, v.s)),
    doors: v.parts.map((p) => ({ x: p.x + Math.sin(p.ang) * TRAM_OUT, y: p.y - Math.cos(p.ang) * TRAM_OUT, nx: Math.sin(p.ang), ny: -Math.cos(p.ang) })),
    by: (s) => {
      if (s.kind !== 'tram') return false;
      const f = v.line.path.at(v.s + HALF), dx = s.x - f.x, dy = s.y - f.y, cs = Math.cos(f.ang), sn = Math.sin(f.ang);
      return Math.cos(f.ang - s.ang) > 0.7 && Math.abs(dx * cs + dy * sn) < 12 && Math.abs(dx * sn - dy * cs) < 6;
    },
  };
}

// The funicular's stations, one for each stop of each line: people stand along the
// platform on either side of the track (OSM doesn't say which side it is on, so wherever
// there's ground to stand on).
export function funicularStops(f: Funicular): WaitStop[] {
  const out: WaitStop[] = [];
  for (const line of f.lines) {
    // (Petřín's is a sight in itself, with queues at its stations most of the day; the
    // hotel's is mostly empty. A guess: nobody counts them.)
    const path = line.cars[0].path, { len, w, name, ticket } = line.spec, many = ticket ? 3 : 0.5;
    for (const st of line.stops) {
      const p = path.at((st.at / line.length) * path.length);
      out.push({ kind: 'funicular', x: p.x, y: p.y, ang: p.ang, name: st.name || name, refs: [name],
        along: [-len / 2 + 0.5, len / 2 - 0.5], out: [w / 2 + 0.6, w / 2 + 2.6], both: true, many, open: () => line.open });
    }
  }
  return out;
}
// A funicular car standing at one (`stops`: funicularStops' list): doors along both sides.
export function funicularStanding(c: FunicularCar, stops: readonly WaitStop[]): Standing | null {
  const line = c.line, i = c.stop;
  if (i === null) return null;
  const station = stops.find((s) => s.kind === 'funicular' && s.refs[0] === line.spec.name && s.name === (line.stops[i].name || line.spec.name) && Math.hypot(s.x - c.x, s.y - c.y) < 12);
  if (!station) return null;
  const { len, w } = line.spec, cs = Math.cos(c.h), sn = Math.sin(c.h), doors: Door[] = [];
  const n = Math.max(1, Math.round(len / 3.5));
  for (let k = 0; k < n; k++) {
    const a = -len / 2 + (len * (k + 0.5)) / n;
    for (const side of [1, -1]) doors.push({ x: c.x + cs * a + side * sn * (w / 2 + 0.4), y: c.y + sn * a - side * cs * (w / 2 + 0.4), nx: side * sn, ny: -side * cs });
  }
  return { key: c, kind: 'funicular', ref: line.spec.name, end: i === 0 || i === line.stops.length - 1, doors, by: (s) => s === station, hold: null, off: true };
}

// Keeps the items of `list` that pass, in place.
function keep<T>(list: T[], pass: (item: T) => boolean) {
  let n = 0;
  for (let i = 0; i < list.length; i++) if (pass(list[i])) list[n++] = list[i];
  list.length = n;
}

interface Spot { x: number; y: number; h: number; taken: boolean }
interface Waiter { p: Pedestrian; hold: { x: number; y: number; h: number }; spot: Spot; ref: string; since: number; patience: number; on: object | null }
interface Queue {
  stop: WaitStop; spots: Spot[]; waiters: Waiter[];
  want: number; wantAt: number; next: number; seen: number;
  // The vehicle standing at the stop now, since when, and how many are still to get off it.
  at: Standing | null; arrived: number; leaving: number; leaveAt: number;
}

export interface WaitingWorld {
  crowd: () => Crowd;
  stops: () => readonly WaitStop[]; // the stops whose signs stand near the view (the same objects each time)
  standing: (out: Standing[]) => void; // adds the vehicles standing at a stop with their doors open
  driving: () => Car | null; // the car you drive, if any
  busy: (x: number, y: number) => number; // the footfall map, 1 on the Old Town Square
  demand: () => number; // 0 to 1: how busy this hour is for travelling
  offscreen: (x: number, y: number) => boolean;
  road: (x: number, y: number) => boolean; // on a carriageway or a parking bay
  rng: () => number;
  boarded?: (key: object) => void; // someone got on this vehicle
}

const KINDS: StopKind[] = ['bus', 'tram', 'funicular'];
const tally = () => Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<StopKind, number>;

export class StopWaiting {
  queues = new Map<WaitStop, Queue>();
  boarded = tally(); // got on (since the game started), by kind of stop
  alighted = tally(); // got off
  private clock = 0;
  private frame = 0;
  private standing: Standing[] = [];
  // The bus you drive while its doors are open, and since when.
  mine: { car: Car; since: number; done: boolean } | null = null;

  constructor(private w: WaitingWorld) {}

  update(dt: number) {
    this.clock += dt;
    this.frame++;
    const crowd = this.w.crowd();
    // (While the map is still loading there are no paths yet to put anyone on.)
    if (!crowd.walk.edges.length) return;
    for (const s of this.w.stops()) {
      let q = this.queues.get(s);
      if (!q) {
        q = this.open(s);
        this.queues.set(s, q);
        // (Just come into the scene, like its sign: filled at once.)
        while (q.waiters.length < q.want && this.bring(q, true)) { /* filled */ }
      }
      q.seen = this.frame;
    }
    // Vehicles standing at a stop now.
    const standing = this.standing;
    standing.length = 0;
    this.w.standing(standing);
    const mine = this.mine;
    if (mine) {
      // (Doors shut by themselves once nobody is left to get on or off, or when you get out.)
      if (mine.done || this.w.driving() !== mine.car || mine.car.speed > 1) this.closeDoors();
      else {
        const s = this.stopBy(mine.car), line = mine.car.line;
        standing.push(busStanding(mine.car, line?.ref.trim() ?? '', !!line && !!s && s.name === line.to, null));
      }
    }
    for (const q of this.queues.values()) {
      if (q.seen !== this.frame) { this.close(q); continue; }
      // Those who've gone: run off, knocked over, taken onto a tram, moved away.
      keep(q.waiters, (x) => {
        const here = crowd.people[x.p.i] === x.p && x.p.state === 'hold' && x.p.hold === x.hold;
        if (!here) x.spot.taken = false;
        return here;
      });
      this.vehicle(q, crowd);
      if (this.clock > q.wantAt) {
        // (A stop that came into the scene before the ground round it had loaded found
        // nowhere to stand: look again.)
        if (!q.spots.length) q.spots = this.spots(q.stop);
        q.want = this.wanted(q);
        q.wantAt = this.clock + (q.spots.length ? 20 + this.w.rng() * 20 : 2);
      }
      if (q.waiters.length < q.want && this.clock > q.next) {
        const hidden = this.w.offscreen(q.stop.x, q.stop.y);
        this.bring(q, hidden);
        q.next = this.clock + (hidden ? 0.5 : 6 + this.w.rng() * 14);
      }
      // Fed up with waiting (or the line has shut for the day), now and then someone walks off.
      const shut = q.stop.open && !q.stop.open();
      for (const x of q.waiters) if (!x.on && (shut || this.clock - x.since > x.patience)) { this.release(q, x); break; }
    }
  }

  // The vehicle at the stop: its passengers get on and off.
  private vehicle(q: Queue, crowd: Crowd) {
    const s = q.stop, r = this.w.rng;
    let at: Standing | null = null;
    for (const a of this.standing) if (a.by(s)) { at = a; break; }
    if (at?.key !== q.at?.key) {
      // Gone (or another come): whoever didn't make it waits for the next.
      for (const x of q.waiters) if (x.on) { x.on = null; Object.assign(x.hold, { x: x.spot.x, y: x.spot.y, h: x.spot.h }); }
      q.arrived = this.clock;
      q.leaving = 0;
      if (at) {
        if (at.off && !this.w.offscreen(s.x, s.y)) {
          const n = at.end ? 3 + r() * 6 : (0.4 + r() * 1.8) * (1 + 8 * this.w.busy(s.x, s.y)) * (0.4 + this.w.demand());
          q.leaving = Math.min(at.end ? 9 : 6, Math.floor(n));
        }
        q.leaveAt = this.clock + 0.6;
        for (const x of q.waiters) if (at.ref && x.ref === at.ref) x.on = at.key;
      }
    }
    q.at = at;
    if (!at) return;
    const doors = at.doors;
    // Getting off, one after another, out onto the pavement (by a door with ground outside it).
    if (q.leaving > 0 && this.clock > q.leaveAt && crowd.people.length < crowd.fig.capacity) {
      let d = doors[Math.floor(r() * doors.length)];
      for (let k = 0; k < 6 && crowd.blocked(d.x + d.nx * 0.8, d.y + d.ny * 0.8); k++) d = doors[Math.floor(r() * doors.length)];
      if (!crowd.blocked(d.x + d.nx * 0.8, d.y + d.ny * 0.8)) {
        const p = crowd.spawnAt(d.x, d.y);
        const along = (r() - 0.5) * 0.8;
        Object.assign(p, { state: 'flee', t: 1.4 + r() * 0.8, vx: d.nx * 1.2 - d.ny * along, vy: d.ny * 1.2 + d.nx * along });
        this.alighted[at.kind]++;
      }
      q.leaving--;
      q.leaveAt = this.clock + 0.5 + r() * 0.7;
    }
    // Getting on at the nearest door.
    let boarding = false;
    keep(q.waiters, (x) => {
      if (x.on !== at.key) return true;
      let best = doors[0], bd = Infinity;
      for (const d of doors) {
        const e = Math.hypot(d.x - x.p.x, d.y - x.p.y);
        if (e < bd) { bd = e; best = d; }
      }
      if (bd < 0.6) {
        x.spot.taken = false;
        crowd.retire(x.p);
        this.boarded[at.kind]++;
        this.w.boarded?.(at.key);
        return false;
      }
      Object.assign(x.hold, { x: best.x, y: best.y, h: Math.atan2(-best.ny, -best.nx) });
      boarding = true;
      return true;
    });
    // (The driver waits for them, for a while.)
    const busy = (boarding || q.leaving > 0) && this.clock - q.arrived < WAITING.hold;
    if (busy) at.hold?.();
    // (Yours: the doors shut once all are on and off, after a few seconds at least.)
    if (this.mine?.car === at.key && !busy && this.clock - q.arrived > 3) this.mine.done = true;
  }

  // Whether anyone waiting is still on the way to this vehicle's doors.
  boarding(key: object) {
    for (const q of this.queues.values()) if (q.at?.key === key && q.waiters.some((x) => x.on === key)) return true;
    return false;
  }

  // The bus stop near the view a bus stands by, if any.
  stopBy(c: Car) {
    for (const q of this.queues.values()) if (q.stop.kind === 'bus' && byBus(q.stop, c)) return q.stop;
    return null;
  }

  // The doors of the bus you drive: open them if it stands still by a stop's sign (false
  // if not), or shut them again.
  openDoors(c: Car) {
    if (this.mine || c.speed > 0.3 || !this.stopBy(c)) return false;
    this.mine = { car: c, since: this.clock, done: false };
    c.passengerDoors(true);
    return true;
  }
  closeDoors() {
    this.mine?.car.passengerDoors(false);
    this.mine = null;
  }
  doorsOpen(c: Car | null) { return !!c && this.mine?.car === c && !this.mine.done; }

  // How many wait at the stop: more lines, a busier street and a busier hour, more people.
  private wanted(q: Queue) {
    const s = q.stop, busy = this.w.busy(s.x, s.y);
    if (s.open && !s.open()) return 0;
    const n = (WAITING.first + WAITING.perLine * (s.refs.length - 1)) * clamp(0.6 + 6 * busy, 0.6, 2.2) * this.w.demand() * (s.many ?? 1) * (0.6 + 0.8 * this.w.rng());
    return clamp(Math.round(n), 0, Math.min(WAITING.most, q.spots.length));
  }

  private open(s: WaitStop): Queue {
    const q: Queue = { stop: s, spots: this.spots(s), waiters: [], want: 0, wantAt: 0, next: 0, seen: 0, at: null, arrived: 0, leaving: 0, leaveAt: 0 };
    q.want = this.wanted(q);
    q.wantAt = this.clock + (q.spots.length ? 20 + this.w.rng() * 20 : 2);
    return q;
  }

  // Somewhere to stand round the sign, nearest it first: on the pavement or platform
  // behind it (where the doors will be), a step or two in from the edge and clear of the
  // walls, each turned to the street or the track and partly towards where the vehicles
  // come from.
  private spots(s: WaitStop): Spot[] {
    const r = this.w.rng, crowd = this.w.crowd();
    const ux = Math.cos(s.ang), uy = Math.sin(s.ang), nx = Math.sin(s.ang), ny = -Math.cos(s.ang);
    const best = s.along[1] - 4.5, all: (Spot & { score: number })[] = [];
    for (const side of s.both ? [1, -1] : [1]) {
      for (let a = s.along[0]; a <= s.along[1]; a += 1.05) {
        for (let o = s.out[0]; o <= s.out[1]; o += 0.9) {
          const ja = a + (r() - 0.5) * 0.45, jo = (o + (r() - 0.5) * 0.3) * side;
          if (Math.hypot(ja, jo) < 0.6) continue; // (the sign's pole)
          const x = s.x + ux * ja + nx * jo, y = s.y + uy * ja + ny * jo, ox = nx * side, oy = ny * side;
          if (crowd.blocked(x, y) || this.w.road(x, y)) continue;
          if (crowd.blocked(x + ox * 0.4, y + oy * 0.4) || crowd.blocked(x + ux * 0.35, y + uy * 0.35) || crowd.blocked(x - ux * 0.35, y - uy * 0.35)) continue;
          all.push({ x, y, h: s.ang + side * (Math.PI / 2 + r() * 1.1 - 0.25), taken: false, score: Math.abs(ja - best) * 0.35 + Math.abs(jo) * 0.5 + r() * 1.6 });
        }
      }
    }
    all.sort((p, q) => p.score - q.score);
    return all.slice(0, 24).map(({ x, y, h, taken }) => ({ x, y, h, taken }));
  }

  // One more to wait at the stop: put there where nobody sees it (`hidden`), otherwise a
  // passer-by from nearby who walks over. False if there's nobody to come.
  private bring(q: Queue, hidden: boolean) {
    const spot = q.spots.find((p) => !p.taken);
    if (!spot) return false;
    const crowd = this.w.crowd(), people = crowd.people, r = this.w.rng;
    let p: Pedestrian | null = null;
    if (hidden) {
      for (let k = 0; k < 40 && !p; k++) {
        const o = people[Math.floor(r() * people.length)];
        if (o && this.free(o) && this.w.offscreen(o.x, o.y)) p = o;
      }
    } else {
      let best = WAITING.reach;
      for (const o of people) {
        const d = Math.hypot(o.x - spot.x, o.y - spot.y);
        if (d < best && this.free(o) && this.clear(o.x, o.y, spot.x, spot.y)) { best = d; p = o; }
      }
    }
    if (!p) return false;
    const hold = { x: spot.x, y: spot.y, h: spot.h };
    Object.assign(p, { state: 'hold', hold, pause: 0, stuck: 0, vx: 0, vy: 0 });
    if (hidden) Object.assign(p, { x: spot.x, y: spot.y, h: spot.h, pace: 0 });
    spot.taken = true;
    const refs = q.stop.refs;
    q.waiters.push({ p, hold, spot, ref: refs[Math.floor(r() * refs.length)] ?? '', since: this.clock, patience: 180 + r() * 420, on: null });
    return true;
  }

  // Someone just walking about, free to go and wait.
  private free(p: Pedestrian) { return p.state === 'walk' && !p.kept && p.hurt === undefined && p.route === undefined; }

  // Whether the way from (x0, y0) to (x1, y1) keeps off the street.
  private clear(x0: number, y0: number, x1: number, y1: number) {
    for (let k = 1; k <= 4; k++) {
      const f = k / 5;
      if (this.w.road(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)) return false;
    }
    return true;
  }

  // Back to walking about: out of sight straight onto a path, in sight walking to one.
  private release(q: Queue, x: Waiter) {
    const crowd = this.w.crowd(), p = x.p;
    x.spot.taken = false;
    keep(q.waiters, (o) => o !== x);
    if (crowd.people[p.i] !== p || p.state !== 'hold' || p.hold !== x.hold) return;
    p.hold = undefined;
    const n = crowd.nearest(p.x, p.y);
    if (!n) { p.state = 'walk'; return; }
    if (this.w.offscreen(p.x, p.y)) {
      Object.assign(p, { state: 'walk', e: n.e, s: n.s });
      crowd.place(p);
    } else {
      const at = n.e.path.at(n.s);
      Object.assign(p, { state: 'rejoin', target: { e: n.e, s: n.s, x: at.x, y: at.y }, t: 0 });
    }
  }

  // The stop has gone from the scene: everyone waiting there goes back to walking about.
  private close(q: Queue) {
    for (const x of [...q.waiters]) this.release(q, x);
    this.queues.delete(q.stop);
  }

  // For the tests: each stop near the view, its waiters and the vehicle standing there.
  report() {
    return [...this.queues.values()].map((q) => ({
      stop: q.stop, kind: q.stop.kind, name: q.stop.name, lines: q.stop.refs, want: q.want, waiting: q.waiters.length,
      boarding: q.waiters.filter((x) => x.on).length, vehicle: q.at ? q.at.ref || '?' : null,
      people: q.waiters.map((x) => ({ x: x.p.x, y: x.p.y, ref: x.ref, pace: x.p.pace })),
    }));
  }
}
