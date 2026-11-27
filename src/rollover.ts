// A car or van rolling over (car.ts): what's left of the driving physics while it rolls.
//
// The classic and realistic driving models are flat (the physical one, physicalHandling.ts,
// tips cars over itself): a car has a place, a heading and a speed on the map, and
// nothing ever tips it. A rollover starts from a trip: the wheels stopped dead while the
// car slides sideways (into a raised kerb, a post or a wall), or a hard enough blow in the
// side from another vehicle. Then the car's cross-section (a box with the glasshouse
// narrower than the body, for cars) turns about whichever of its corners is on the road.
// Gravity pulls its centre of mass down around that corner, each corner that lands takes
// some of the spin away, and it comes to rest on its wheels again, on its side or on its
// roof. Rolling about its corners moves it sideways as it would on the road.
//
// The speed a trip needs: the spin it gives is the slide's momentum about the corner,
// v·h / (k² + r²), and that must lift the centre of mass over the corner, g·(r − h), so
// v = √(2g(r − h)(k² + r²)) / h (h: height of the centre of mass, r: its distance from
// the corner, k: the box's radius of gyration). About 21 km/h sideways for a saloon,
// 17 km/h for a van.
import type { CarSpec } from './car.ts';

const G = 9.81;
// Of the spin, what's left after each landing on a new corner.
const LANDING = 0.42;
// Below this (rad/s), a landing ends the roll.
const REST = 0.3;
// Sliding on the body (m/s²) while it rolls and once it lies on its side or roof.
export const SCRAPE = 6;

type Shape = { pts: [number, number][]; h: number; k2: number };
const shapes = new WeakMap<CarSpec, Shape>();
// The cross-section, x across the car (+ to its left), y up from the road.
function shape(s: CarSpec): Shape {
  let sh = shapes.get(s);
  if (!sh) {
    const w = s.W / 2, H = s.H, boxy = s.heavy || H > 1.9;
    const top = boxy ? w * 0.96 : w * 0.86, shoulder = boxy ? H * 0.85 : H * 0.6;
    const pts: [number, number][] = [[w, 0], [w, shoulder], [top, H], [-top, H], [-w, shoulder], [-w, 0]];
    sh = { pts, h: H * (boxy ? 0.42 : 0.38), k2: (s.W * s.W + H * H) / 12 };
    shapes.set(s, sh);
  }
  return sh;
}

// The sideways speed (m/s) that tips this vehicle over when its wheels are stopped.
export function tripSpeed(s: CarSpec) {
  const { h, k2 } = shape(s), w = s.W * 0.43, r = Math.hypot(w, h);
  return Math.sqrt(2 * G * (r - h) * (k2 + r * r)) / h;
}

export class Rollover {
  // Turned about its long axis (rad): + the left side up (the roof goes right).
  angle = 0;
  rate = 0;
  // How high its middle has to be raised for its lowest corner to touch the road (m).
  lift = 0;
  // Still turning; else lying still on the side `face` says.
  moving = true;
  private pivot = -1;
  private pivotX = 0; // where the corner it turns on touches the road, across from the car's middle (m)
  private sh: Shape;

  // `side`: +1 to throw the roof to the car's left, −1 to its right; `speed`: the
  // sideways speed (m/s) the trip stopped.
  constructor(spec: CarSpec, side: number, speed: number) {
    this.sh = shape(spec);
    const { h, k2 } = this.sh, w = spec.W / 2;
    this.rate = -side * speed * h / (k2 + w * w + h * h);
  }

  // Lying still, turned by `angle` (as `angle` below): where the physical handling
  // (physicalHandling.ts) left a car on its side or roof.
  static lying(spec: CarSpec, angle: number) {
    const r = new Rollover(spec, 1, 0), c = Math.cos(angle), s = Math.sin(angle);
    r.angle = angle;
    r.rate = 0;
    r.moving = false;
    r.lift = -Math.min(...r.sh.pts.map(([x, y]) => x * s + y * c));
    return r;
  }

  // A further blow while it rolls or lies there.
  push(spec: CarSpec, side: number, speed: number) {
    const { h, k2 } = this.sh, w = spec.W / 2;
    this.rate += -side * speed * h / (k2 + w * w + h * h);
    this.moving = true;
  }

  // 'wheels', 'side' or 'roof', by which way up it is.
  get face(): 'wheels' | 'side' | 'roof' {
    const a = Math.abs(Math.atan2(Math.sin(this.angle), Math.cos(this.angle)));
    return a < 0.6 ? 'wheels' : a > 2.4 ? 'roof' : 'side';
  }

  // Moves it on by dt. Returns how far it moved sideways (m, + to the car's left), the
  // speed of the hardest landing (m/s), for the sound and the shake, and the corner it
  // landed on then: across and up from the car's middle and the ground, and how far the
  // car was turned (for the dents, Car.landed).
  step(dt: number): { across: number; landing: number; corner?: [number, number, number] } {
    let across = 0, landing = 0, corner: [number, number, number] | undefined;
    if (!this.moving) return { across, landing };
    const { pts, h, k2 } = this.sh;
    const n = Math.max(1, Math.ceil(dt / 0.004));
    for (let i = 0; i < n; i++) {
      const c = Math.cos(this.angle), s = Math.sin(this.angle);
      // The lowest corner, and of two level ones the one it's turning towards.
      let q = 0, low = Infinity, qx = 0;
      for (let j = 0; j < pts.length; j++) {
        const [x, y] = pts[j], rx = x * c - y * s, ry = x * s + y * c;
        const lower = ry < low - 1e-4 || (ry < low + 1e-4 && (this.rate > 0 ? rx < qx : rx > qx));
        if (lower) { q = j; low = ry; qx = rx; }
      }
      const originX = this.pivot < 0 ? 0 : this.pivotX - this.rotX(this.pivot, c, s);
      if (q !== this.pivot) {
        if (this.pivot >= 0) {
          const [x, y] = pts[q], hit = Math.abs(this.rate) * Math.hypot(x, y - h);
          if (hit > landing) { landing = hit; corner = [x, y, this.angle]; }
          this.rate *= LANDING;
          if (Math.abs(this.rate) < REST) { this.rate = 0; this.moving = false; }
        }
        this.pivot = q;
        this.pivotX = originX + qx;
        if (!this.moving) break;
      }
      // Gravity about the corner, the box's turning inertia about that corner.
      const [px, py] = pts[q], cgx = -h * s, cgy = h * c;
      const dx = cgx - (px * c - py * s), dy = cgy - (px * s + py * c);
      this.rate += (-G * dx / (k2 + dx * dx + dy * dy)) * (dt / n);
      this.angle += this.rate * (dt / n);
      const c2 = Math.cos(this.angle), s2 = Math.sin(this.angle);
      const newX = this.pivotX - this.rotX(q, c2, s2);
      across += newX - originX;
      this.lift = -(px * s2 + py * c2);
    }
    return { across, landing, corner };
  }

  private rotX(j: number, c: number, s: number) {
    const [x, y] = this.sh.pts[j];
    return x * c - y * s;
  }
}
