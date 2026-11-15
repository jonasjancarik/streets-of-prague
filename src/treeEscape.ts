import type { Car } from './car.ts';
import type { TreeTrunk } from './contracts.ts';

const HOLD = 1; // s of throttle while barely moving at the same tree
const CONTACT_GAP = 0.45; // s between contacts while the car bounces off the trunk
const STUCK_DISTANCE = 0.45; // m from the start of the attempt
const CLEARANCE = 0.15; // m beyond the trunk's cells, including the small collision pushback

export class TreeEscape {
  ignored?: TreeTrunk;
  private direction = 0;
  private tree?: TreeTrunk;
  private touched?: TreeTrunk;
  private time = 0;
  private gap = 0;
  private x = 0;
  private y = 0;

  get seeking() { return this.direction !== 0 && !this.ignored; }

  begin(car: Car, direction: number) {
    if (this.ignored && (car.level || this.clearOf(car, this.ignored))) this.ignored = undefined;
    if (!direction || direction !== this.direction) this.tree = undefined;
    this.direction = direction;
    this.touched = undefined;
  }

  hit(trunk: TreeTrunk | undefined) {
    if (trunk && (!this.touched || trunk === this.tree)) this.touched = trunk;
  }

  end(car: Car, dt: number) {
    if (!this.seeking) return;
    const moved = Math.hypot(car.x - this.x, car.y - this.y) > STUCK_DISTANCE;
    if (this.touched && (this.tree !== this.touched || moved)) {
      this.tree = this.touched;
      this.x = car.x;
      this.y = car.y;
      this.time = this.gap = 0;
      return;
    }
    if (!this.tree) return;
    this.gap = this.touched ? 0 : this.gap + dt;
    if (moved || this.gap > CONTACT_GAP) {
      this.tree = undefined;
      return;
    }
    this.time += dt;
    if (this.touched && this.time >= HOLD) {
      this.ignored = this.touched;
      this.tree = undefined;
    }
  }

  private clearOf(car: Car, trunk: TreeTrunk) {
    const dx = trunk.x - car.x, dy = trunk.y - car.y;
    const c = Math.cos(car.h), s = Math.sin(car.h);
    const [halfLength, halfWidth] = car.samples[0];
    const along = Math.max(0, Math.abs(dx * c + dy * s) - halfLength);
    const across = Math.max(0, Math.abs(dy * c - dx * s) - halfWidth);
    return Math.hypot(along, across) > trunk.radius + CLEARANCE;
  }
}
