import type { Car } from './car.ts';
import { onPavement } from './parking.ts';
import { MERGE } from './traffic.ts';
import type { Traffic } from './traffic.ts';

// Now and then, somewhere in view, one of the cars parked up on the pavement (see
// parkCars) sets off along it at walking pace, and only after a while bumps down
// over the kerb into the street.

const EVERY = [25, 60]; // seconds between two of them, at random in this range
const RUN = [10, 30]; // metres along the pavement

export class PavementDrivers {
  traffic: Traffic;
  r: () => number;
  wait: number;

  constructor(traffic: Traffic, r: () => number) {
    this.traffic = traffic;
    this.r = r;
    this.wait = 10 + r() * 15;
  }

  // Every `dt` seconds or so: when it's time, picks a car from `loose` that stands on
  // the pavement 15–80 m from (x, y), where `seen` says it's in view, with nothing
  // in the way along the pavement ahead (`solid` or another car). Hands it to the
  // traffic and takes it out of `loose`; returns it.
  update(dt: number, loose: Car[], x: number, y: number, seen: (x: number, y: number) => boolean, solid: (x: number, y: number) => boolean) {
    if ((this.wait -= dt) > 0) return null;
    this.wait = 3; // nothing suitable now: look again in a few seconds
    const near = loose.filter((c) => {
      const d = Math.hypot(c.x - x, c.y - y);
      return d > 15 && d < 80 && onPavement.has(c) && !c.two && c.speed < 0.1 && c.damage === 0 && seen(c.x, c.y);
    });
    for (const c of near.sort(() => this.r() - 0.5)) {
      const { edge, s } = onPavement.get(c)!;
      // Back in the lane before the end of the street, where the lane swings into the next one.
      const run = Math.min(RUN[0] + this.r() * (RUN[1] - RUN[0]), edge.path.length - s - MERGE - 8);
      if (run < 6 || Math.cos(c.h - edge.path.at(s).ang) < 0.9) continue;
      const fx = Math.cos(c.h), fy = Math.sin(c.h), half = c.spec.W / 2;
      const others = loose.filter((o) => o !== c && Math.abs(o.x - c.x) < run + 10 && Math.abs(o.y - c.y) < run + 10);
      let clear = true;
      for (let d = c.spec.L / 2 + 0.5; clear && d < c.spec.L / 2 + run; d += 1) {
        const px = c.x + fx * d, py = c.y + fy * d;
        clear = !solid(px + fy * half, py - fx * half) && !solid(px - fy * half, py + fx * half);
        for (const o of others) {
          if (clear && Math.abs(o.x - px) < 4 && Math.abs(o.y - py) < 4) clear = Math.hypot(o.x - px, o.y - py) > half + o.spec.W / 2 + 0.3;
        }
      }
      if (!clear) continue;
      onPavement.delete(c);
      loose.splice(loose.indexOf(c), 1);
      this.traffic.adopt(c, edge, s, run);
      this.wait = EVERY[0] + this.r() * (EVERY[1] - EVERY[0]);
      return c;
    }
    return null;
  }
}
