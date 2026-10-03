import { SCALE } from './figures.ts';
import type { Car, Door } from './car.ts';
import { locomote, type Walker } from './people.ts';
import type { Point2 } from './map/geo.ts';

// Getting into and out of a car through its door, played out rather than done at once:
// you go to the nearer front door, it opens, whoever is at the wheel leaves (hauled out
// by you through the driver's door, or out of it by themselves when you come from the
// other side), you duck in and it shuts behind you. Getting out is the same backwards.
// The game (main.ts) decides which car and what taking it means; this moves the figure
// and the doors, and says when each thing happens.

const JOG = 4.2; // m/s to the door
const GIVE_UP = 4; // seconds to reach a door before letting it go
const OPEN = 0.2, PULL = 0.62, SIT = 0.5, OUT_OPEN = 0.16, RISE = 0.42; // seconds

interface Hooks {
  walker: Walker;
  // Whoever is at the wheel leaves, as the door opens on them: `pulled` out by you, or
  // by themselves.
  evict(car: Car, pulled: boolean): void;
  // You're in the seat: the car is yours.
  seated(car: Car): void;
  // Your door is open: you're on foot from here, the car left where it stands.
  left(car: Car, at: Point2): void;
}

type Play =
  | { kind: 'in'; car: Car; door: Door; phase: 'walk' | 'open' | 'pull' | 'sit'; t: number; driver: boolean; from: Point2; h0: number }
  | { kind: 'out'; car: Car; door: Door; phase: 'open' | 'rise'; t: number };

const ease = (u: number) => u * u * (3 - 2 * u);
const turn = (from: number, to: number, u: number) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from)) * u;

export class GetIn {
  o: Hooks;
  play: Play | null = null;

  constructor(o: Hooks) { this.o = o; }

  get active() { return !!this.play; }
  // Still on the way to the door: pressing the key again calls it off.
  get walking() { return this.play?.kind === 'in' && this.play.phase === 'walk'; }

  // The front door to use from where you stand: the nearer one you can get to.
  door(car: Car): Door | null {
    const w = this.o.walker;
    const reach = (d: Door) => { const [x, y] = car.beside(d); return Math.hypot(x - w.x, y - w.y); };
    const doors = car.doors.filter((d) => d.n <= 2 && !w.blocked(...car.beside(d))).sort((a, b) => reach(a) - reach(b));
    return doors[0] && reach(doors[0]) < 7 ? doors[0] : null;
  }

  // To the door and in. `driver`: someone is at the wheel.
  enter(car: Car, door: Door, driver: boolean) {
    const w = this.o.walker;
    this.play = { kind: 'in', car, door, phase: 'walk', t: 0, driver, from: [w.x, w.y], h0: w.h };
  }

  // Out through the driver's door, or the other one if something's in the way there.
  // False if neither will do (or the car is going too fast for doors).
  exit(car: Car) {
    const w = this.o.walker;
    if (car.two || car.speed > 2.5) return false;
    const door = car.doors.find((d) => d.n <= 2 && !w.blocked(...car.beside(d)));
    if (!door) return false;
    car.open(door.n);
    this.play = { kind: 'out', car, door, phase: 'open', t: 0 };
    return true;
  }

  // Called off (knocked over, arrested, taken somewhere else): the doors shut, you stand where you are.
  cancel() {
    const p = this.play, w = this.o.walker;
    if (!p) return;
    this.play = null;
    for (const d of p.car.doors) p.car.open(d.n, false);
    w.base.makeScale(SCALE, SCALE, SCALE);
    // (Whoever was at the wheel doesn't wait to see what you do next.)
    if (p.kind === 'in' && p.driver) this.o.evict(p.car, false);
    if ((p.kind === 'in' && p.phase === 'sit') || (p.kind === 'out' && p.phase === 'rise')) {
      [w.x, w.y] = p.car.beside(p.door);
      w.anim.play('idle', false, 0.15);
      w.sync();
    }
  }

  update(dt: number) {
    const p = this.play;
    if (!p) return;
    if (p.kind === 'in') this.getIn(p, dt);
    else this.getOut(p, dt);
  }

  // Where to head for: the door, by way of the car's side if you're at one of its ends.
  private goal(car: Car, door: Door): Point2 {
    const w = this.o.walker, lane = car.spec.W / 2 + 0.55;
    const dx = w.x - car.x, dy = w.y - car.y, c = Math.cos(car.h), s = Math.sin(car.h);
    const along = dx * c + dy * s, left = (dy * c - dx * s) * door.side;
    return left < lane - 0.25 ? car.local(along, door.side * lane) : car.beside(door);
  }

  private getIn(p: Extract<Play, { kind: 'in' }>, dt: number) {
    const w = this.o.walker, { car, door } = p, a = w.anim;
    p.t += dt;
    w.z = w.speed = w.vx = w.vy = 0;
    // The car stops for you (its driver has seen what's coming).
    if (p.phase !== 'sit') {
      const k = Math.exp(-5 * dt);
      car.vx *= k;
      car.vy *= k;
      car.w *= k;
    }
    const facing = car.h - door.side * Math.PI / 2;
    if (p.phase === 'walk') {
      const [tx, ty] = this.goal(car, door), dx = tx - w.x, dy = ty - w.y, d = Math.hypot(dx, dy);
      const [bx, by] = car.beside(door), left = Math.hypot(bx - w.x, by - w.y);
      if (left < 0.08 && car.speed < 0.8) {
        const pull = p.driver && door.n === 1;
        Object.assign(p, { phase: pull ? 'pull' : 'open', t: 0 });
        w.perch = 0;
        car.open(door.n);
        if (pull) a.play('pull', true, 0.1);
        else if (p.driver) {
          // From the passenger's side: the driver is out of their own door and away.
          p.driver = false;
          car.open(1);
          this.o.evict(car, false);
        }
      } else {
        const step = Math.min(d, JOG * dt);
        if (d > 1e-3) {
          w.x += (dx / d) * step;
          w.y += (dy / d) * step;
          w.h = turn(w.h, Math.atan2(dy, dx), Math.min(1, 14 * dt));
        }
        locomote(a, dt, step / dt);
        if (p.t > GIVE_UP) { this.cancel(); return; }
      }
    } else if (p.phase === 'open' || p.phase === 'pull') {
      w.h = turn(w.h, facing, Math.min(1, 12 * dt));
      if (p.phase === 'open') locomote(a, dt, 0);
      else {
        a.step(dt);
        // Out they come as the heave begins.
        if (p.driver && p.t > 0.3) { p.driver = false; this.o.evict(car, true); }
      }
      if (p.t > (p.phase === 'open' ? OPEN : PULL)) {
        Object.assign(p, { phase: 'sit', t: 0, from: [w.x, w.y], h0: w.h });
        a.play('getin', true, 0.1);
      }
    } else {
      const u = Math.min(1, p.t / SIT), e = ease(u), [sx, sy] = car.seat(door);
      w.x = p.from[0] + (sx - p.from[0]) * e;
      w.y = p.from[1] + (sy - p.from[1]) * e;
      w.h = turn(p.h0, car.h, e);
      // (People are drawn bigger than life; inside the car they wouldn't fit.)
      const size = SCALE + (1 - SCALE) * ease(Math.max(0, (u - 0.25) / 0.75));
      w.base.makeScale(size, size, size);
      a.step(dt, a.duration / SIT);
      if (u >= 1) {
        this.play = null;
        w.base.makeScale(SCALE, SCALE, SCALE);
        for (const d of car.doors) car.open(d.n, false);
        this.o.seated(car);
        return;
      }
    }
    w.sync();
  }

  private getOut(p: Extract<Play, { kind: 'out' }>, dt: number) {
    const w = this.o.walker, { car, door } = p, a = w.anim;
    p.t += dt;
    if (p.phase === 'open') {
      if (p.t < OUT_OPEN) return;
      Object.assign(p, { phase: 'rise', t: 0 });
      this.o.left(car, car.seat(door));
      a.play('getin', true, 0);
    }
    const u = Math.min(1, p.t / RISE), e = ease(u), [sx, sy] = car.seat(door), [bx, by] = car.beside(door);
    w.x = sx + (bx - sx) * e;
    w.y = sy + (by - sy) * e;
    w.h = car.h;
    w.z = w.speed = w.vx = w.vy = 0;
    const size = 1 + (SCALE - 1) * ease(Math.min(1, u / 0.75));
    w.base.makeScale(size, size, size);
    // The getting-in, backwards.
    a.t = a.duration * (1 - u);
    if (u >= 1) {
      this.play = null;
      w.base.makeScale(SCALE, SCALE, SCALE);
      a.play('idle', false, 0.2);
      car.open(door.n, false);
    }
    w.sync();
  }
}
