import type * as THREE from 'three';
import type { Car } from './car.ts';
import { Sprites } from './particles.ts';
import { Debris } from './debris.ts';

// Cars that catch fire and blow up, GTA 2 style. A car that's taken enough knocks
// (crashes, shots, a blast nearby) starts to smoke from under the bonnet; more and it
// catches fire, and a few seconds later it explodes. What's left is a burnt-out wreck
// that smoulders for a while and can't be driven. What the blast does to people, cars
// and you is up to the game (`onBlast`); this keeps track of the fires and draws them.

export const SMOKING = 50; // damage at which a car starts to smoke
export const BURNING = 90; // and catches fire (the police give up a car at the same point)
const FUSE = [4, 6]; // seconds from catching fire to the explosion
const SPREAD_INTERVAL = 2; // seconds between checks for cars beside the flames
// A car nobody is driving burns this long, enough for a fire engine to get there.
const LONG_FUSE = [45, 75];
const LONG_RATE = 0.55; // those fires smoke and flame less thickly, so a few in view stay within the puffs' caps
// Seconds of water it takes to put out a burning car (a crew of three sprays for about 3 s); a wreck needs the same to stop smouldering.
export const DOUSE = 10;
const SMOULDER = 25; // seconds a wreck gives off smoke, flames for the first half
// A fire with an engine on its way waits for it: this many seconds longer at most, before the car blows up or the wreck's flames die down.
const WAIT = 60;
const LAST = 8; // seconds of fuse that are kept back for the crew

interface Blaze { fuse: number; t: number; emit: number; flame: number; wet: number; steam: number; rate: number; held: number; spread: number }

export interface FiresOptions {
  scene: THREE.Scene;
  height: (x: number, y: number, c: Car) => number;
  rng: () => number;
  // A car has caught fire.
  onIgnite?: (c: Car) => void;
  onSpread: (c: Car, blamed: boolean) => void;
  // Whether a fire engine is on its way to this car, or its crew is at work on it.
  awaited?: (c: Car) => boolean;
  // A car has blown up; `blamed` if the player set it going.
  onBlast: (c: Car, blamed: boolean) => void;
}

export class Fires {
  blazes = new Map<Car, Blaze>();
  blamed = new WeakSet<Car>();
  smoke: Sprites; flames: Sprites; debris: Debris;
  height: FiresOptions['height']; r: () => number;
  onIgnite: NonNullable<FiresOptions['onIgnite']>; onBlast: FiresOptions['onBlast'];
  onSpread: FiresOptions['onSpread'];
  awaited: NonNullable<FiresOptions['awaited']>;

  constructor({ scene, height, rng, onIgnite = () => {}, awaited = () => false, onSpread, onBlast }: FiresOptions) {
    this.smoke = new Sprites(scene, 700, 'smoke');
    this.flames = new Sprites(scene, 400, 'glow');
    this.debris = new Debris(scene, this.smoke, this.flames, rng);
    this.height = height;
    this.r = rng;
    this.onIgnite = onIgnite;
    this.onSpread = onSpread;
    this.awaited = awaited;
    this.onBlast = onBlast;
  }

  // The player damaged this car: if it blows up, it's on you.
  blame(c: Car) { this.blamed.add(c); }

  // Start keeping an eye on a car once it's damaged enough to smoke. (Pedal bikes
  // don't burn.)
  check(c: Car) {
    if (c.burnt || c.two === 'bike' || c.damage < SMOKING || this.blazes.has(c)) return;
    this.blazes.set(c, { fuse: -1, t: 0, emit: 0, flame: 0, wet: 0, steam: 0, rate: 1, held: 0, spread: SPREAD_INTERVAL });
  }

  // `cars`: those that may have taken damage this step. `view`: where the camera looks,
  // so fires far out of sight aren't drawn (they still burn and blow up).
  update(dt: number, cars: Iterable<Car>, view: { x: number; y: number; r: number }) {
    for (const c of cars) this.check(c);
    for (const [c, b] of this.blazes) {
      const d = Math.hypot(c.x - view.x, c.y - view.y), seen = d < view.r;
      if (d > 700) { this.blazes.delete(c); continue; }
      b.t += dt;
      if (c.burnt) {
        // The wreck stays in flames while an engine is coming for it.
        const dying = b.t > SMOULDER / 2 - 2 && b.t < SMOULDER / 2 && b.wet < DOUSE / 2;
        if (dying && this.hold(c, b, dt)) b.t -= dt;
        if (b.t > SMOULDER) { this.blazes.delete(c); continue; }
        if (seen) this.emit(c, b, dt, b.t < SMOULDER / 2 ? 0.5 : 0, 1 - b.t / SMOULDER);
        if (seen && b.steam > 0) this.steam(c, b, dt);
        b.steam = Math.max(0, b.steam - dt);
        continue;
      }
      if (c.damage >= BURNING) {
        if (b.fuse < 0) {
          // Your own car (or a police car after you) is the quick one; any other has time.
          const [lo, hi] = c.driven ? FUSE : LONG_FUSE;
          b.fuse = lo + this.r() * (hi - lo);
          b.rate = c.driven ? 1 : LONG_RATE;
          b.spread = SPREAD_INTERVAL;
          this.onIgnite(c);
        }
        // (Not the quick fuse of your own car: that one goes off whoever is coming.)
        if (!(b.rate < 1 && b.fuse < LAST && this.hold(c, b, dt))) b.fuse -= dt;
        if (b.fuse <= 0) { this.explode(c, seen); b.t = 0; continue; }
        b.spread -= dt;
        if (b.spread <= 0) {
          b.spread += SPREAD_INTERVAL;
          this.onSpread(c, this.blamed.has(c));
        }
        if (seen) this.emit(c, b, dt, 1 - b.wet / DOUSE, 1);
      } else if (seen) this.emit(c, b, dt, 0, (c.damage - SMOKING) / (BURNING - SMOKING));
      if (seen && b.steam > 0 && !c.burnt) this.steam(c, b, dt);
      b.steam = Math.max(0, b.steam - dt);
    }
    this.smoke.update(dt);
    this.flames.update(dt);
    this.debris.update(dt);
  }

  // Whether this fire waits another step for the engine that's coming to it.
  hold(c: Car, b: Blaze, dt: number) {
    if (b.held >= WAIT || !this.awaited(c)) return false;
    b.held += dt;
    return true;
  }

  // Whether `c` is on fire right now: burning and waiting to explode, or a wreck still in flames.
  onFire(c: Car) {
    const b = this.blazes.get(c);
    if (!b) return false;
    return c.burnt ? b.t < SMOULDER / 2 && b.wet < DOUSE / 2 : b.fuse >= 0;
  }

  // A wreck whose flames are out but that still smoulders: what a crew with hoses finishes off.
  smouldering(c: Car) {
    return c.burnt && this.blazes.has(c) && !this.onFire(c);
  }

  // Water on a car, `amount` seconds' worth from one hose. Enough of it brings a burning
  // car back under the point where it catches fire: it only smokes, steaming for a few
  // seconds, and won't explode. A wreck in flames loses them, and stops smouldering.
  douse(c: Car, amount: number) {
    const b = this.blazes.get(c);
    if (!b) return;
    b.wet += amount;
    b.steam = Math.max(b.steam, 3);
    if (c.burnt) {
      if (b.wet >= DOUSE / 2) b.t = Math.max(b.t, SMOULDER / 2);
      if (b.wet >= DOUSE) b.t = SMOULDER;
    } else if (b.fuse >= 0 && b.wet >= DOUSE) {
      c.damage = Math.min(c.damage, BURNING - 1);
      b.fuse = -1;
      b.wet = 0;
      b.rate = 1;
      b.steam = 6;
    }
  }

  // White steam where the water hits.
  steam(c: Car, b: Blaze, dt: number) {
    const S = c.spec, r = this.r, fx = Math.cos(c.h), fy = Math.sin(c.h), z = this.height(c.x, c.y, c) + S.H * 0.8;
    b.emit += dt * 10;
    for (; b.emit >= 1; b.emit--) {
      this.smoke.add({ x: c.x + fx * S.L * 0.2 + (r() - 0.5) * S.W, y: c.y + fy * S.L * 0.2 + (r() - 0.5) * S.W, z, vx: (r() - 0.5) * 0.8 + 0.6, vy: (r() - 0.5) * 0.8 + 0.4, vz: 1.6 + r(),
        r0: 0.5, r1: 1.6 + r(), life: 1.4 + r(), rgb: [0.92, 0.94, 0.96], a: 0.45, spin: (r() - 0.5) * 0.8 });
    }
  }

  // Smoke (and flames, `fire` 0–1) from under the bonnet; `thick` 0–1.
  emit(c: Car, b: Blaze, dt: number, fire: number, thick: number) {
    const S = c.spec, fx = Math.cos(c.h), fy = Math.sin(c.h), r = this.r;
    const x = c.x + fx * S.L * 0.3, y = c.y + fy * S.L * 0.3, z = this.height(c.x, c.y, c) + S.H * 0.75;
    // (Smoke drifts off a little to the north-east, as if on a light breeze, and slows as it cools.)
    b.emit += dt * (2.5 + 3.5 * thick + 2.5 * fire) * b.rate;
    for (; b.emit >= 1; b.emit--) {
      const grey = fire > 0 ? 0.07 + r() * 0.07 : 0.6 - thick * 0.35 + r() * 0.1;
      this.smoke.add({ x: x + (r() - 0.5) * 0.6, y: y + (r() - 0.5) * 0.6, z: z + fire * 0.6, vx: (r() - 0.5) * 0.8 + 0.8, vy: (r() - 0.5) * 0.8 + 0.6, vz: 2.6 + r() + fire * 1.5,
        r0: 0.45 + fire * 0.3, r1: 1.8 + thick * 1.5 + fire * 2, life: 2.2 + r() * 1.4 + fire * 1.5, rgb: [grey * 1.04, grey, grey * 0.95], a: 0.55 + 0.45 * Math.max(thick, fire),
        spin: (r() - 0.5) * 1.2, drag: 0.25 });
    }
    // Tongues of flame licking up out of the engine and the cabin, and a glow over them.
    b.flame += dt * 34 * fire * b.rate;
    for (; b.flame >= 1; b.flame--) {
      const along = r() < 0.65 ? 0.3 : -0.05;
      this.flames.add({ x: c.x + fx * S.L * along + (r() - 0.5) * S.W * 0.7, y: c.y + fy * S.L * along + (r() - 0.5) * S.W * 0.7, z: z - 0.15 + r() * 0.2,
        vx: 0.3 + (r() - 0.5) * 0.4, vy: 0.2 + (r() - 0.5) * 0.4, vz: 1.6 + r() * 1.4,
        r0: 0.35 + r() * 0.35, r1: 0.7 + r() * 0.5, life: 0.35 + r() * 0.35, rgb: [1.3, 0.45 + r() * 0.3, 0.08], a: 0.8, spin: (r() - 0.5) * 3 });
    }
    if (fire > 0.3 && r() < dt * 6 * b.rate) {
      this.flames.add({ x, y, z: z + 0.4, r0: 1.4, r1: 1.8, life: 0.35, rgb: [1, 0.4, 0.08], a: 0.22 * fire });
      // Now and then an ember floats up out of it.
      this.debris.sparks.add({ x: x + (r() - 0.5) * S.W, y: y + (r() - 0.5) * S.W, z: z + 0.5, vx: (r() - 0.5) * 1.5 + 0.5, vy: (r() - 0.5) * 1.5 + 0.4, vz: 2 + r() * 3,
        r0: 0.015, life: 1 + r() * 1.2, rgb: [1.6, 1, 0.5], a: 1, fall: 1, drag: 0.8, heat: true });
    }
  }

  explode(c: Car, seen: boolean) {
    c.burn();
    c.rider = null;
    c.w += (this.r() - 0.5) * 3;
    const blamed = this.blamed.has(c);
    this.onBlast(c, blamed);
    if (!seen) return;
    this.fireball(c.x, c.y, this.height(c.x, c.y, c) + 0.6, (x, y) => this.height(x, y, c));
  }

  fireball(cx: number, cy: number, z: number, under?: (x: number, y: number) => number) {
    const r = this.r, ground = z - 0.6;
    const at = (spread: number) => [cx + (r() - 0.5) * spread, cy + (r() - 0.5) * spread] as const;
    // The flash, and its glow on the ground round about.
    this.flames.add({ x: cx, y: cy, z: z + 1, r0: 2.5, r1: 6, life: 0.2, rgb: [1.7, 1.5, 1.1], a: 0.9 });
    this.flames.add({ x: cx, y: cy, z: ground + 0.05, r0: 7, r1: 10, life: 0.8, rgb: [1, 0.45, 0.1], a: 0.3, flat: true });
    // A fireball boiling up and out: fast at first, held back by the air.
    for (let i = 0; i < 26; i++) {
      const [x, y] = at(3), a = r() * Math.PI * 2, v = 4 + r() * 7;
      this.flames.add({ x, y, z: z + r() * 1.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 3 + r() * 6,
        r0: 1 + r() * 0.8, r1: 2.6 + r() * 2.2, life: 0.55 + r() * 0.6, rgb: [1.4, 0.42 + r() * 0.3, 0.08], a: 0.7, spin: (r() - 0.5) * 2, drag: 3 });
    }
    // Its hot heart rising after it.
    for (let i = 0; i < 8; i++) {
      const [x, y] = at(1.5);
      this.flames.add({ x, y, z: z + 1 + r() * 1.5, vx: (r() - 0.5), vy: (r() - 0.5), vz: 4 + r() * 2,
        r0: 1.4, r1: 3 + r() * 1.5, life: 0.9 + r() * 0.5, rgb: [1.4, 0.55, 0.12], a: 0.6, spin: (r() - 0.5) * 1.5, drag: 1.2 });
    }
    // Then a cloud of black smoke rolling up, lit orange from below at first.
    // (Few and dense rather than many and thin: every puff is blended over all it covers, and a
    // close cloud filling the screen many times over cost a phone tens of milliseconds a frame.)
    for (let i = 0; i < 12; i++) {
      const [x, y] = at(4), a = r() * Math.PI * 2, v = 2 + r() * 4, warm = i < 5;
      this.smoke.add({ x, y, z: z + 0.5 + r() * 2.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 2.5 + r() * 3,
        r0: 1.3, r1: 3.2 + r() * 2.3, life: 5 + r() * 4, rgb: warm ? [0.2, 0.11, 0.06] : [0.075, 0.07, 0.065], a: 1,
        spin: (r() - 0.5) * 0.6, drag: 1.1 });
    }
    // Dust and grit blown out along the ground.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + r() * 0.5, v = 8 + r() * 5;
      this.smoke.add({ x: cx, y: cy, z: ground + 0.6, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 0.3,
        r0: 0.8, r1: 2.5 + r(), life: 1.6 + r(), rgb: [0.38, 0.35, 0.32], a: 0.35, spin: (r() - 0.5), drag: 2.2 });
    }
    this.debris.blast(cx, cy, ground, under);
    // And a scorch mark on the ground under the wreck.
    this.smoke.add({ x: cx, y: cy, z: ground + 0.05, r0: 3.4, r1: 3.6, life: 60, rgb: [0.03, 0.03, 0.03], a: 0.7, flat: true, rot: 0 });
  }

  // Dev teleport and the like: nothing burning is left behind.
  reset() {
    this.blazes.clear();
    this.debris.reset();
  }
}
