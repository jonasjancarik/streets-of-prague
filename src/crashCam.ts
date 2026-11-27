import type * as THREE from 'three';
import type { Car } from './car.ts';

// The big moments of your driving in slow motion, with the camera off to one side, as in
// a film: a hard crash, a car thrown into the air, going over a bridge's parapet, a roll
// at speed. Only a big one: a hit counts by how much it changed the car's speed (so a
// brush with a police car in a chase doesn't), and after one there's a pause before the
// next. In the street views only, not in the headset, and not while the developer panel
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
const LONGEST = 3.5; // s (real): in the air or falling, at the most
const PAUSE = 10; // s (real) after one before the next

type Moment = keyof typeof HOLD;
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
  // The shot: where the camera stands relative to the car, and where it is.
  private shot: { ox: number; oy: number; x: number; y: number; z: number } | null = null;

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
      // In the air or falling, until it's down (within reason).
      const still = m === 'over' ? !!c?.overboard : m === 'air' ? this.air > 0 : false;
      if ((this.t >= HOLD[m] && !still) || this.t >= LONGEST) { this.phase = 'out'; this.t = 0; }
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

  // The camera off to the side of the car, if there's room for it (a wall between them
  // ends the shot): to one side of the way it was going and a little ahead, at about the
  // height of a person, looking at it and drifting along after it. Returns whether it
  // took the camera.
  frame(car: Car, camera: THREE.PerspectiveCamera, ground: (x: number, y: number) => number, blocked: ((x: number, y: number) => boolean) | undefined, dt: number) {
    if (!this.cut || car !== this.car) return false;
    const z = car.physics ? car.physics.origin[2] : ground(car.x, car.y);
    const clear = (x: number, y: number) => {
      if (!blocked) return true;
      const d = Math.hypot(x - car.x, y - car.y), n = Math.ceil(d / 0.5);
      for (let i = 1; i <= n; i++) if (blocked(car.x + (x - car.x) * i / n, car.y + (y - car.y) * i / n)) return false;
      return true;
    };
    if (!this.shot) {
      const moving = Math.hypot(this.was.vx, this.was.vy) > 2;
      const a = moving ? Math.atan2(this.was.vy, this.was.vx) : car.h, fx = Math.cos(a), fy = Math.sin(a);
      // (Either side, the one with room; the car's left first, the driver's side.)
      for (const side of [1, -1]) for (const d of [7, 5.5, 4]) {
        const ox = -fy * side * d + fx * 2.5, oy = fx * side * d + fy * 2.5;
        if (this.shot || !clear(car.x + ox, car.y + oy)) continue;
        this.shot = { ox, oy, x: car.x + ox, y: car.y + oy, z: Math.max(ground(car.x + ox, car.y + oy) + 1.2, z + 1.1) };
      }
      if (!this.shot) { this.cut = false; return false; }
    }
    const s = this.shot, k = 1 - Math.exp(-1.2 * dt);
    s.x += (car.x + s.ox - s.x) * k;
    s.y += (car.y + s.oy - s.y) * k;
    s.z += (Math.max(ground(s.x, s.y) + 1.2, z + 1.1) - s.z) * (1 - Math.exp(-2 * dt));
    if (!clear(s.x, s.y)) { this.cut = false; return false; }
    camera.position.set(s.x, s.z, -s.y);
    camera.up.set(0, 1, 0);
    camera.lookAt(car.x, z + 0.7, -car.y);
    return true;
  }
}

const smooth = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };
