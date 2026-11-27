import type * as THREE from 'three';
import type { Car } from './car.ts';

// The big moments of your driving in slow motion, with the camera off to one side, as in
// a film: a hard crash, a car thrown into the air, going over a bridge's parapet, a roll
// at speed. Only a big one: a hit counts by how much it changed the car's speed (so a
// brush with a police car in a chase doesn't), and after one there's a pause before the
// next. It lasts while the car is in the air or tumbling (5 s at most), and the camera
// takes one of a few angles (SHOTS) with nothing between it and the car. In the street views only, not in the headset, and not while the developer panel
// runs the world itself. Off unless you turn it on (Settings → Crash slow motion).
//
// The world is watched as it steps (notice, in the game's time); the clock is slowed and
// the camera moved as the frames are drawn (step and frame, in real time).

export const SLOW = 0.3; // the game's clock at the slowest
const HIT = 11; // m/s: a change of speed in one step this big is a crash worth seeing
const ROLL = 14; // m/s: a car tipping over this fast
const AIR = 0.25, CLEAR = 0.6; // s with no wheel down and the body this far (m) off the ground
const EASE_IN = 0.12, EASE_OUT = 0.35; // s (real) into and out of the slow motion
const HOLD = { hit: 1.3, roll: 1.6, air: 1, over: 1 }; // s (real) at the slowest, at least
const LONGEST = 5; // s (real): in the air, falling or tumbling, at the most
const PAUSE = 10; // s (real) after one before the next

type Moment = keyof typeof HOLD;

// Where the camera stands, from the car and the way it was going (m): `ahead` along it
// (behind if less than 0), `across` to one side (either), `up` above the car.
interface Angle { ahead: number; across: number; up: number }
const SHOTS = {
  side: { ahead: 2.5, across: 7, up: 1.1 }, // beside it, as it goes past
  wide: { ahead: 5, across: 12, up: 2.6 }, // further off and higher, the whole flight in view
  front: { ahead: 10, across: 3.5, up: 0.9 }, // ahead and a little aside, it coming at you
  low: { ahead: 7, across: 2, up: 0.45 }, // ahead, low to the road
  rear: { ahead: -8, across: 4, up: 2.2 }, // behind and above, over its shoulder
} satisfies Record<string, Angle>;
type ShotName = keyof typeof SHOTS;
// Which suit each moment, best first (one of the first three is picked at random, not the last one used).
const SUITS: Record<Moment, ShotName[]> = {
  hit: ['side', 'front', 'low', 'wide', 'rear'],
  roll: ['side', 'wide', 'front', 'rear', 'low'],
  air: ['wide', 'side', 'front', 'rear', 'low'],
  over: ['wide', 'side', 'rear', 'front', 'low'],
};
// Sees whether anything stands between two points (TileWorld.sightBlocked).
export type Sight = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;
const KEY = 'crashSlowMo';
let on = false;
try { on = localStorage.getItem(KEY) === 'on'; } catch { /* the default */ }
export const crashSlowMoOn = () => on;
export function setCrashSlowMo(enabled: boolean) {
  on = enabled;
  try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* not saved */ }
}

export class CrashCam {
  // Whether a moment may start now (main.ts: the setting, the view, nothing scripted).
  live = false;
  // The game's clock while it lasts (1 otherwise), and what it was for.
  scale = 1;
  moment: Moment | null = null;
  // The camera off to the side (false: the usual one, slowed only).
  cut = false;
  readonly fov = 48;
  private phase: 'idle' | 'in' | 'hold' | 'out' = 'idle';
  private t = 0;
  private pause = 0;
  // The car being watched and what it was doing the step before.
  private car: Car | null = null;
  private was = { x: 0, y: 0, vx: 0, vy: 0, tipped: false, over: false };
  private air = 0;
  // The shot: which, where the camera stands relative to the car (and above it), and
  // where it is; the last one taken; when the view was last blocked and a new one tried.
  private shot: { name: ShotName; ox: number; oy: number; up: number; x: number; y: number; z: number } | null = null;
  private last: ShotName | null = null;
  private retry = 0;
  shotName(): ShotName | null { return this.cut ? this.shot?.name ?? null : null; }

  // After each step of the world, your car (or none): starts a moment when it's a big one.
  notice(car: Car | null, dt: number, ground: (x: number, y: number) => number) {
    if (!car || car !== this.car || Math.hypot(car.x - this.was.x, car.y - this.was.y) > 10) {
      this.car = car;
      this.air = 0;
      if (car) this.remember(car);
      return;
    }
    const ph = car.physics;
    const dv = Math.hypot(car.vx - this.was.vx, car.vy - this.was.vy);
    const tipped = !!car.roll || !!ph?.tipped, over = !!car.overboard;
    // In the air: no wheel down, and the body well off the ground (not just on its side).
    const flying = !!ph && !ph.wheels.some((w) => w.contact) && ph.clearance(ground) > CLEAR;
    this.air = flying ? this.air + dt : 0;
    const speed = Math.hypot(this.was.vx, this.was.vy);
    if (over && !this.was.over) this.start('over');
    else if (this.air > AIR) this.start('air');
    // (Not the splash that puts it back on the deck.)
    else if (dv > HIT && !this.was.over) this.start('hit');
    else if (tipped && !this.was.tipped && speed > ROLL) this.start('roll');
    this.remember(car);
  }

  private remember(car: Car) {
    Object.assign(this.was, { x: car.x, y: car.y, vx: car.vx, vy: car.vy, tipped: !!car.roll || !!car.physics?.tipped, over: !!car.overboard });
  }

  private start(moment: Moment) {
    if (!this.live || this.pause > 0) return;
    if (this.phase !== 'idle') {
      // Already slowed: a crash that follows the first keeps it going a little longer.
      if (this.phase === 'hold') this.t = Math.min(this.t, 0.4);
      return;
    }
    this.moment = moment;
    this.phase = 'in';
    this.t = 0;
    this.cut = true;
    this.shot = null;
    this.retry = 0;
  }

  // Each frame drawn (real seconds): the game's clock for it.
  step(dt: number) {
    if (this.phase === 'idle') {
      this.pause = Math.max(0, this.pause - dt);
      return (this.scale = 1);
    }
    if (!this.live) this.phase = 'out';
    this.t += dt;
    if (this.phase === 'in') {
      this.scale = 1 - (1 - SLOW) * smooth(this.t / EASE_IN);
      if (this.t >= EASE_IN) { this.phase = 'hold'; this.t = 0; }
    } else if (this.phase === 'hold') {
      this.scale = SLOW;
      const c = this.car, m = this.moment!;
      // In the air, falling or tumbling, until it's down and still (within reason).
      const busy = !!c && (!!c.overboard || this.air > 0 || !!c.physics?.tumbling || !!c.roll?.moving);
      if ((this.t >= HOLD[m] && !busy) || this.t >= LONGEST) { this.phase = 'out'; this.t = 0; }
    } else {
      this.scale = SLOW + (1 - SLOW) * smooth(this.t / EASE_OUT);
      if (this.t >= EASE_OUT) this.end();
    }
    return this.scale;
  }

  private end() {
    this.phase = 'idle';
    this.scale = 1;
    this.moment = null;
    this.cut = false;
    this.shot = null;
    this.pause = PAUSE;
  }

  get active() { return this.phase !== 'idle'; }

  // The camera off to the side of the car: one of SHOTS with nothing between it and the
  // car, looking at it and drifting along after it. When something comes between, another
  // angle; none clear, the usual camera (only slowed). Returns whether it took the camera.
  frame(car: Car, camera: THREE.PerspectiveCamera, ground: (x: number, y: number) => number, sight: Sight | undefined, dt: number) {
    if (!this.cut || car !== this.car || !sight) return (this.cut = false);
    const z = car.physics ? car.physics.origin[2] : ground(car.x, car.y);
    const height = (x: number, y: number, up: number) => Math.max(ground(x, y) + 0.4, z + up);
    this.retry = Math.max(0, this.retry - dt);
    if (this.shot) {
      const s = this.shot, k = 1 - Math.exp(-1.2 * dt);
      s.x += (car.x + s.ox - s.x) * k;
      s.y += (car.y + s.oy - s.y) * k;
      s.z += (height(s.x, s.y, s.up) - s.z) * (1 - Math.exp(-2 * dt));
      if (sight(car.x, car.y, z + 0.7, s.x, s.y, s.z)) {
        if (this.retry > 0) return (this.cut = false);
        this.shot = null;
        this.retry = 0.5;
      }
    }
    if (!this.shot && !(this.shot = this.choose(car, z, height, sight))) return (this.cut = false);
    const s = this.shot;
    camera.position.set(s.x, s.z, -s.y);
    camera.up.set(0, 1, 0);
    camera.lookAt(car.x, z + 0.7, -car.y);
    return true;
  }

  // An angle for this moment with a clear view of the car: of the ones that suit it best,
  // a different one from last time, on either side, a little nearer if need be.
  private choose(car: Car, z: number, height: (x: number, y: number, up: number) => number, sight: Sight) {
    const moving = Math.hypot(this.was.vx, this.was.vy) > 2;
    const a = moving ? Math.atan2(this.was.vy, this.was.vx) : car.h, fx = Math.cos(a), fy = Math.sin(a);
    const suits = SUITS[this.moment ?? 'hit'], first = suits.slice(0, 3).filter((n) => n !== this.last && n !== this.shot?.name);
    const pick = first[Math.floor(Math.random() * first.length)];
    const order = [pick, ...suits.filter((n) => n !== pick)].filter(Boolean) as ShotName[];
    const sides = Math.random() < 0.5 ? [1, -1] : [-1, 1];
    for (const near of [1, 0.7, 0.5]) for (const name of order) for (const side of sides) {
      const { ahead, across, up } = SHOTS[name];
      const ox = (fx * ahead - fy * side * across) * near, oy = (fy * ahead + fx * side * across) * near;
      const x = car.x + ox, y = car.y + oy, h = height(x, y, up);
      if (sight(car.x, car.y, z + 0.7, x, y, h)) continue;
      this.last = name;
      return { name, ox, oy, up, x, y, z: h };
    }
    return null;
  }
}

const smooth = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };
