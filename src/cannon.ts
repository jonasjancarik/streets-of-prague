import type { Car } from './car.ts';
import type { Point3 } from './guns.ts';

// The water cannon on the roof of a fire engine you're driving. Hold the button to spray
// straight ahead; the tank runs dry after about 30 s of it and fills back up slowly.

export const TANK = 30; // seconds of spraying
const REFILL = 0.2; // seconds of water back per second
const RESTART = 2; // an empty tank must have this much before it sprays again
export const REACH = 17; // m
export const HOSE = 1.6; // seconds of water (for `douse`) per second of spraying

export class Cannon {
  tank = TANK;
  jet: { from: Point3; to: Point3 } | null = null;
  // Where the water comes from and goes, along the car's heading (map x, y).
  dir = { x: 1, y: 0 };
  private dry = false;

  get spraying() { return !!this.jet; }

  update(dt: number, car: Car | null, held: boolean, height: (x: number, y: number) => number) {
    this.jet = null;
    if (!car || car.type !== 'fire') {
      this.tank = Math.min(TANK, this.tank + REFILL * dt);
      return;
    }
    if (this.dry && this.tank > RESTART) this.dry = false;
    if (held && !this.dry && this.tank > 0) {
      this.tank = Math.max(0, this.tank - dt);
      if (this.tank <= 0) this.dry = true;
      const c = Math.cos(car.h), s = Math.sin(car.h), ahead = car.spec.L * 0.2;
      const fx = car.x + c * ahead, fy = car.y + s * ahead;
      const tx = car.x + c * REACH, ty = car.y + s * REACH;
      this.dir = { x: c, y: s };
      this.jet = { from: [fx, fy, height(fx, fy) + car.spec.H], to: [tx, ty, height(tx, ty) + 0.3] };
    } else this.tank = Math.min(TANK, this.tank + REFILL * dt);
  }

  // How far along the jet (0 at the nozzle) the point is, or -1 when it's more than
  // `radius` from the water's path.
  hit(car: Car, x: number, y: number, radius: number) {
    const dx = x - car.x, dy = y - car.y, along = dx * this.dir.x + dy * this.dir.y;
    if (along < 0 || along > REACH + radius) return -1;
    return Math.abs(-dx * this.dir.y + dy * this.dir.x) <= radius ? along : -1;
  }
}
