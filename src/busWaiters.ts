import type { Crowd, Pedestrian } from './people.ts';
import type { BusStop } from './busstops.ts';
import type { TrafficAgent } from './traffic.ts';
import { busDoors, type Car } from './car.ts';
import { clamp } from './network.ts';

// People waiting at the bus stops near you. A few stand on the pavement round each sign,
// facing the street: more at a busy stop served by several lines, and more at the busy
// hours of the day (how full the roads are then, TSK's travel times in src/traffic.ts,
// stands in for how many people are travelling: nobody publishes how many wait at a stop).
// Each waits for one of the stop's lines. When that line's bus pulls up they walk to its
// nearest door and get on, and the bus waits for anyone still on their way; a few people
// get off it, more at the end of the line. Then the stop fills again, one at a time.
//
// They're people of the crowd (src/people.ts) in its 'hold' state, taken from the
// passers-by: one walks over from nearby, or, where nobody would see it, someone from
// out of sight is put there. Frightened off, knocked over or needed by something else,
// they drop out of the queue.
//
// A bus you drive works the same way once you stop by a sign and open its doors (X): people
// waiting for its line get on, a few get off, and the doors shut by themselves when nobody
// is left to get on or off. It can't move off while they're open.

export const WAITING = {
  first: 1.5, // people at a stop with one line, on an ordinary street at the busiest hour
  perLine: 0.9, // and for each line after the first
  most: 10, // at one stop
  hold: 25, // s: the longest a bus waits for someone walking to its doors
  reach: 30, // m: how far off someone walks over from to wait, in view
};

// Keeps the items of `list` that pass, in place.
function keep<T>(list: T[], pass: (item: T) => boolean) {
  let n = 0;
  for (let i = 0; i < list.length; i++) if (pass(list[i])) list[n++] = list[i];
  list.length = n;
}

interface Spot { x: number; y: number; h: number; taken: boolean }
interface Waiter { p: Pedestrian; hold: { x: number; y: number; h: number }; spot: Spot; ref: string; since: number; patience: number; bus: Car | null }
// A bus standing at a stop with its doors open: a traffic bus (`agent`) or yours.
interface Standing { car: Car; ref: string; end: boolean; agent: TrafficAgent | null }
interface Queue {
  stop: BusStop; refs: string[]; spots: Spot[]; waiters: Waiter[];
  want: number; wantAt: number; next: number; seen: number;
  // The bus standing at the stop now, since when, and how many are still to get off it.
  bus: Standing | null; arrived: number; leaving: number; leaveAt: number;
}

export interface WaitingWorld {
  crowd: () => Crowd;
  stops: () => readonly BusStop[]; // the stops whose signs stand near the view
  buses: () => readonly TrafficAgent[];
  driving: () => Car | null; // the car you drive, if any
  busy: (x: number, y: number) => number; // the footfall map, 1 on the Old Town Square
  demand: () => number; // 0 to 1: how busy this hour is for travelling
  offscreen: (x: number, y: number) => boolean;
  road: (x: number, y: number) => boolean; // on a carriageway or a parking bay
  rng: () => number;
}

export class BusWaiting {
  queues = new Map<BusStop, Queue>();
  boarded = 0; // got on a bus (since the game started)
  alighted = 0; // got off one
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
    // Buses standing at a stop now.
    const standing = this.standing;
    standing.length = 0;
    for (const a of this.w.buses()) if (a.bus && !a.bus.lost && a.bus.dwell > 0) standing.push({ car: a.car, ref: a.bus.line.ref, end: a.bus.stop >= a.bus.line.stops.length - 1, agent: a });
    const mine = this.mine;
    if (mine) {
      // (Doors shut by themselves once nobody is left to get on or off, or when you get out.)
      if (mine.done || this.w.driving() !== mine.car || mine.car.speed > 1) this.closeDoors();
      else {
        const s = this.stopBy(mine.car);
        const line = mine.car.line;
        standing.push({ car: mine.car, ref: line?.ref.trim() ?? '', end: !!line && !!s && s.name === line.to, agent: null });
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
      this.buses(q, crowd);
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
      // Fed up with waiting, now and then someone walks off.
      for (const x of q.waiters) if (!x.bus && this.clock - x.since > x.patience) { this.release(q, x); break; }
    }
  }

  // The bus at the stop: its passengers get on and off.
  private buses(q: Queue, crowd: Crowd) {
    const s = q.stop, r = this.w.rng;
    let at: Standing | null = null;
    for (const a of this.standing) if (this.by(s, a.car)) { at = a; break; }
    if (at?.car !== q.bus?.car) {
      // Gone (or another come): whoever didn't make it waits for the next.
      for (const x of q.waiters) if (x.bus) { x.bus = null; Object.assign(x.hold, { x: x.spot.x, y: x.spot.y, h: x.spot.h }); }
      q.bus = at;
      q.arrived = this.clock;
      q.leaving = 0;
      if (at) {
        const end = at.end;
        if (!this.w.offscreen(s.x, s.y)) {
          const n = end ? 3 + r() * 6 : (0.4 + r() * 1.8) * (1 + 8 * this.w.busy(s.x, s.y)) * (0.4 + this.w.demand());
          q.leaving = Math.min(end ? 9 : 6, Math.floor(n));
        }
        q.leaveAt = this.clock + 0.6;
        for (const x of q.waiters) if (at.ref && x.ref === at.ref) x.bus = at.car;
      }
    }
    const a = q.bus;
    if (!a) return;
    const c = a.car, doors = busDoors(c.spec.L), cs = Math.cos(c.h), sn = Math.sin(c.h), out = c.spec.W / 2 + 0.35;
    // Getting off, one after another, out onto the pavement.
    if (q.leaving > 0 && this.clock > q.leaveAt && crowd.people.length < crowd.fig.capacity) {
      const d = doors[Math.floor(r() * doors.length)];
      const p = crowd.spawnAt(c.x + cs * d + sn * out, c.y + sn * d - cs * out);
      const along = (r() - 0.5) * 0.8;
      Object.assign(p, { state: 'flee', t: 1.4 + r() * 0.8, vx: sn * 1.2 + cs * along, vy: -cs * 1.2 + sn * along });
      q.leaving--;
      q.leaveAt = this.clock + 0.5 + r() * 0.7;
      this.alighted++;
    }
    // Getting on at the nearest door.
    let boarding = false;
    keep(q.waiters, (x) => {
      if (x.bus !== c) return true;
      let bx = 0, by = 0, bd = Infinity;
      for (const d of doors) {
        const dx = c.x + cs * d + sn * out, dy = c.y + sn * d - cs * out, e = Math.hypot(dx - x.p.x, dy - x.p.y);
        if (e < bd) { bd = e; bx = dx; by = dy; }
      }
      if (bd < 0.6) {
        x.spot.taken = false;
        crowd.retire(x.p);
        this.boarded++;
        return false;
      }
      Object.assign(x.hold, { x: bx, y: by, h: c.h + Math.PI / 2 });
      boarding = true;
      return true;
    });
    // (The driver waits for them, for a while.)
    const busy = (boarding || q.leaving > 0) && this.clock - q.arrived < WAITING.hold;
    // (Held above the second and a half in which its doors shut.)
    if (busy && a.agent) a.agent.bus!.dwell = Math.max(a.agent.bus!.dwell, 2);
    // (Yours: the doors shut once all are on and off, after a few seconds at least.)
    if (!a.agent && this.mine?.car === c && !busy && this.clock - q.arrived > 3) this.mine.done = true;
  }

  // Whether a bus stands by the stop's sign: its front pulls up by it, the kerb can be a
  // parking lane away.
  private by(s: BusStop, c: Car) {
    const dx = s.x - c.x, dy = s.y - c.y, cs = Math.cos(c.h), sn = Math.sin(c.h);
    return Math.cos(c.h - s.ang) > 0.7 && Math.abs(dx * cs + dy * sn) < c.spec.L / 2 + 8 && Math.abs(dx * sn - dy * cs) < 8;
  }

  // The stop near the view a bus stands by, if any.
  stopBy(c: Car) {
    for (const q of this.queues.values()) if (this.by(q.stop, c)) return q.stop;
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
    const n = (WAITING.first + WAITING.perLine * (q.refs.length - 1)) * clamp(0.6 + 6 * busy, 0.6, 2.2) * this.w.demand() * (0.6 + 0.8 * this.w.rng());
    return clamp(Math.round(n), 0, Math.min(WAITING.most, q.spots.length));
  }

  private open(s: BusStop): Queue {
    const q: Queue = { stop: s, refs: [...new Set(s.lines.map((l) => l.line.ref))], spots: this.spots(s), waiters: [], want: 0, wantAt: 0, next: 0, seen: 0, bus: null, arrived: 0, leaving: 0, leaveAt: 0 };
    q.want = this.wanted(q);
    q.wantAt = this.clock + (q.spots.length ? 20 + this.w.rng() * 20 : 2);
    return q;
  }

  // Somewhere to stand round the sign, nearest it first: on the pavement behind it (where
  // the bus's doors will be), a step or two in from the kerb and clear of the walls, each
  // turned to the street and partly towards where the bus comes from.
  private spots(s: BusStop): Spot[] {
    const r = this.w.rng, crowd = this.w.crowd();
    const ux = Math.cos(s.ang), uy = Math.sin(s.ang), nx = Math.sin(s.ang), ny = -Math.cos(s.ang);
    const all: (Spot & { score: number })[] = [];
    for (let a = -11; a <= 2.5; a += 1.05) {
      for (let o = 0.5; o <= 3.2; o += 0.9) {
        const ja = a + (r() - 0.5) * 0.45, jo = o + (r() - 0.5) * 0.3;
        if (Math.hypot(ja, jo) < 0.6) continue; // (the sign's pole)
        const x = s.x + ux * ja + nx * jo, y = s.y + uy * ja + ny * jo;
        if (crowd.blocked(x, y) || this.w.road(x, y)) continue;
        if (crowd.blocked(x + nx * 0.4, y + ny * 0.4) || crowd.blocked(x + ux * 0.35, y + uy * 0.35) || crowd.blocked(x - ux * 0.35, y - uy * 0.35)) continue;
        all.push({ x, y, h: s.ang + Math.PI / 2 + r() * 1.1 - 0.25, taken: false, score: Math.abs(ja + 2) * 0.35 + jo * 0.5 + r() * 1.6 });
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
    q.waiters.push({ p, hold, spot, ref: q.refs[Math.floor(r() * q.refs.length)] ?? '', since: this.clock, patience: 180 + r() * 420, bus: null });
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

  // For the tests: each stop near the view, its waiters and the bus standing there.
  report() {
    return [...this.queues.values()].map((q) => ({
      stop: q.stop, name: q.stop.name, lines: q.refs, want: q.want, waiting: q.waiters.length,
      boarding: q.waiters.filter((x) => x.bus).length, bus: q.bus ? q.bus.ref || '?' : null,
      people: q.waiters.map((x) => ({ x: x.p.x, y: x.p.y, ref: x.ref, pace: x.p.pace })),
    }));
  }
}
