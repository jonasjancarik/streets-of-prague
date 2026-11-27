// Physical handling for the player's car (Settings → Car handling → Physical): a rigid
// body with all six degrees of freedom on four sprung wheels.
//
// Nothing here scripts a slide, a lean or a rollover. The body is pushed by gravity, by a
// spring and damper at each corner (with an anti-roll bar across each axle) and by each
// tyre's grip where it touches the road. Weight moves between the tyres because the
// forces act at the road while the mass sits higher up, so a hard turn loads the outside
// tyres, lifts the inside ones and, in a tall van, can lift them off the road. A tyre's
// grip rises with its slip, peaks and falls away once it slides, and braking or driving
// spends grip the tyre needs for turning (a friction circle), so the handbrake, a heavy
// right foot in a rear-wheel-drive car and lifting off mid-corner all do what they do on
// a real road. A tyre sliding sideways into a kerb is stopped by it at the kerb's height,
// below the centre of mass, which can trip the car over. Twenty points on the body (sills,
// shoulders, bumpers, roof) land on the road when the car tips or tumbles and scrape
// along it, so a car comes to rest on its wheels, its side or its roof as it happens to.
//
// Frames: the world is x east, y north, z up. The body is X forward, Y left, Z up, with
// its origin where the model's is: the middle of the footprint, on the road at static
// ride height. Forces are in newtons, the inertia in kg·m².
//
// The game itself stays flat: a car has a place, a heading and a speed on the map, and
// walls, posts and other cars push it there (Car.move, collideBodies). Each step this
// model writes the car's plan position, heading and speeds back, and reads what the flat
// game did to them since (a wall's bounce, a blow from another car) as an impulse.
import type { CarControl, CarSpec } from './car.ts';

// A wheel is bent by a crash's dents as a whole, by how far they push in its hub: the
// suspension takes the first `hold` metres, and the wheel goes `give` of the rest
// (wheelBend in car.ts, and its shaders). Bent, a wheel pushed back or forward is toed
// `toe` times the turn of its axle (`most` rad at most), and it loses `grip` of its grip
// and adds `scrub` of its load to its rolling drag for every metre it was bent (keeping
// `least` of its grip; `scrubMost` at most). (PhysicalHandling.bend)
export const WHEEL_BEND = { hold: 0.1, give: 0.6, toe: 1.5, most: 0.12, grip: 2.5, least: 0.5, scrub: 1.5, scrubMost: 0.35 };

const G = 9.81;
const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

// A tyre's grip against its slip, normalised: 1 at the peak (s = 1), falling away as it
// slides (a Pacejka-like sin(C·atan(B·s))). The fronts fall to 0.76 of their peak, the
// rears only to 0.89, so a car understeers at the limit and a slide at the back builds
// gradually and can be caught. `slip(u)` is the slip that gives a share u (0–1) of the peak.
function tyre(shape: number) {
  const stiff = Math.tan(Math.PI / (2 * shape));
  return {
    curve: (s: number) => Math.sin(shape * Math.atan(stiff * s)),
    slip: (u: number) => Math.tan(Math.asin(clamp(u, 0, 1)) / shape) / stiff,
  };
}
const TYRES = [tyre(1.45), tyre(1.3)];
// A tyre locked by the handbrake: its share of the peak.
const LOCKED = .8;

// Below this forward speed (m/s) the slip angle is measured against it instead, so a car
// standing still doesn't jitter on its tyres.
const SLOW = 2;
// Substeps a second: the springs and tyres are stiff.
const RATE = 240;

export interface Axles { front: number; rear: number; track: number; radius: number }
// The car as the flat game holds it.
export interface PlanBody {
  x: number; y: number; h: number; vx: number; vy: number; w: number;
  braking: boolean; skidFront: number; skidBack: number;
}
type Ground = (x: number, y: number) => number;

// What a step did: the hardest landing of the body on the road (m/s into it) and where.
export interface Landing { speed: number; x: number; y: number }

interface Wheel {
  ax: number; ay: number; front: boolean;
  // Compression from static ride (m, + up into the arch), and how fast it changes.
  x: number; rate: number;
  // On the road, and pressed onto it with `load` N.
  contact: boolean; load: number;
  // Where it touches (world) and the road height under it.
  cx: number; cy: number; cz: number; ground: number;
  // How much it slides (0–1), for tyre marks and squeal.
  slide: number;
  // Bent by a crash (bend): turned off straight (rad, + left), the share of its grip it
  // keeps and the share of its load it drags.
  toe: number; grip: number; scrub: number;
}

// Tall vehicles (vans, pickups, SUVs) sit higher and roll more.
const tallness = (s: CarSpec) => clamp((s.H - 1.45) / 0.85, 0, 1);

export class PhysicalHandling {
  // Front wheel angle (radians, + left), as the street model's wheels are drawn.
  steer = 0;
  // The body's pose after the last step: where its origin is and its axes (forward,
  // left, up), each a unit vector in the world.
  readonly origin = new Float64Array(3);
  readonly axes = new Float64Array(9);
  readonly wheels: Wheel[];
  // How long it has lain still off its wheels (s), for handing it to Rollover.
  still = 0;
  // The car's dents the wheels were last bent for (Car.dentVersion).
  bentBy = -1;
  // Brake lights.
  private lit = false;

  private m: number;
  private inertia: [number, number, number];
  private cg: [number, number, number];
  private p = new Float64Array(3);
  private v = new Float64Array(3);
  private q = new Float64Array([1, 0, 0, 0]); // w, x, y, z
  private omega = new Float64Array(3); // world frame
  private R = new Float64Array(9); // row-major, body → world
  private hull: [number, number, number][];
  private springs: { k: number; bump: number; rebound: number; arb: number; travel: number; droop: number }[];
  private statics: number[];
  private grip: number;
  private slipPeak: [number, number];
  private hcg: number;
  private pedal = 0;
  private rearLock = 0;
  private gearDirection: number;
  private reverseWait = 0;
  // What was written to the flat car, to tell what the flat game changed since.
  private wrote = { x: 0, y: 0, h: 0, vx: 0, vy: 0, w: 0 };

  constructor(car: PlanBody, s: CarSpec, readonly axles: Axles, ground: Ground) {
    const m = this.m = s.mass, tall = tallness(s), { front, rear, track } = axles, wb = front - rear;
    this.hcg = s.H * (0.36 + 0.06 * tall);
    const frontShare = s.drive === 'rwd' ? .51 : s.drive === 'awd' ? .55 : .6;
    this.cg = [rear + frontShare * wb, 0, this.hcg];
    this.inertia = [0.8 * m * (s.W ** 2 + s.H ** 2) / 12, 0.85 * m * (s.L ** 2 + s.H ** 2) / 12, 0.9 * m * (s.L ** 2 + s.W ** 2) / 12];
    this.grip = clamp(1.02 * s.grip / 8.5, .85, 1.1);
    // (The rears peak sooner: their toe-in and the axle's give make a car understeer.)
    this.slipPeak = [Math.tan((8.5 + 2 * tall) * Math.PI / 180), Math.tan((6 + 1.5 * tall) * Math.PI / 180)];
    this.statics = [frontShare, frontShare, 1 - frontShare, 1 - frontShare].map(share => m * G * share / 2);
    // Ride frequencies (Hz), the roll the springs and bars allow (rad per g of cornering)
    // and the share of the bars' stiffness at the front.
    const ride = [1.35 + .3 * tall, 1.5 + .35 * tall], rollPerG = .085 + .045 * tall;
    const rollStiffness = m * G * this.hcg * (1 + 1 / rollPerG);
    const k = ride.map((f, i) => this.statics[i * 2] / G * (2 * Math.PI * f) ** 2);
    const bars = Math.max(0, rollStiffness - (k[0] + k[1]) * track * track / 2);
    this.springs = [0, 1].map(i => {
      const mass = this.statics[i * 2] / G, critical = 2 * Math.sqrt(k[i] * mass);
      return {
        k: k[i], bump: .28 * critical, rebound: .5 * critical,
        arb: bars * (i ? .4 : .6) / (track * track),
        travel: .08 + .04 * tall, droop: .12 + .05 * tall,
      };
    });
    const half = track / 2;
    this.wheels = [[front, half], [front, -half], [rear, half], [rear, -half]].map(([ax, ay], i) => ({
      ax, ay, front: i < 2, x: 0, rate: 0, contact: true, load: this.statics[i], cx: 0, cy: 0, cz: 0, ground: 0, slide: 0, toe: 0, grip: 1, scrub: 0,
    }));
    this.hull = hullOf(s);
    this.gearDirection = car.vx * Math.cos(car.h) + car.vy * Math.sin(car.h) < -.25 ? -1 : 1;
    this.place(car, ground);
  }

  // Sets the body down on the road under the flat car, level with it and moving as it does.
  private place(car: PlanBody, ground: Ground) {
    const c = Math.cos(car.h), s = Math.sin(car.h), { front, rear, track } = this.axles;
    const at = (a: number, l: number) => ground(car.x + c * a - s * l, car.y + s * a + c * l);
    const fl = at(front, track / 2), fr = at(front, -track / 2), rl = at(rear, track / 2), rr = at(rear, -track / 2);
    const pitch = Math.atan2((fl + fr - rl - rr) / 2, front - rear), roll = Math.atan2((fl + rl - fr - rr) / 2, track);
    const zMid = (fl + fr + rl + rr) / 4 - (front + rear) / 2 * Math.tan(pitch);
    // Yaw, then pitch (nose up is a turn about −Y), then roll about X.
    const qa = quat(0, 0, 1, car.h), qb = quat(0, 1, 0, -pitch), qc = quat(1, 0, 0, roll);
    mul(qa, mul(qb, qc, this.q), this.q);
    this.matrix();
    // (The flat car's place is the middle of the body at the height of its centre of mass.)
    const R = this.R, gx = this.cg[0];
    this.p[0] = car.x + R[0] * gx;
    this.p[1] = car.y + R[3] * gx;
    this.p[2] = zMid + R[8] * this.hcg + R[6] * gx;
    this.v[0] = car.vx; this.v[1] = car.vy; this.v[2] = 0;
    this.omega[0] = this.omega[1] = 0; this.omega[2] = car.w;
    for (const w of this.wheels) { w.x = w.rate = 0; w.contact = true; }
    this.publish(car, 0);
  }

  // Bends the wheels by how far a crash moved each one (m: forward, left, up in the body;
  // WHEEL_BEND). One pushed back or forward turns its end of the axle, and the wheel with
  // it; any bend costs it grip and makes it drag.
  bend(shifts: readonly (readonly number[])[], version: number) {
    const B = WHEEL_BEND, track = this.axles.track;
    this.wheels.forEach((w, i) => {
      const [sx, sy, sz] = shifts[i], l = Math.hypot(sx, sy, sz);
      w.toe = clamp(B.toe * Math.atan2(-sx * Math.sign(w.ay), track), -B.most, B.most);
      w.grip = Math.max(B.least, 1 - B.grip * l);
      w.scrub = Math.min(B.scrubMost, B.scrub * l);
    });
    this.bentBy = version;
  }

  get up() { return this.axes[8]; }
  // Off its wheels: tipped past 60°.
  get tipped() { return this.axes[8] < .5; }
  get tumbling() { return this.tipped && this.still < .2; }
  // Upright with all four tyres on the road.
  get planted() { return this.axes[8] > .9 && this.wheels.every(w => w.contact); }
  // Turned about its long axis (rad, + the left side up), as Rollover measures it.
  get rollAngle() { return Math.atan2(this.axes[5], this.axes[8]); }
  get speed() { return Math.hypot(this.v[0], this.v[1], this.v[2]); }
  get spin() { return Math.hypot(this.omega[0], this.omega[1], this.omega[2]); }

  // Each wheel's travel in the body (m, + up), front left, front right, rear left, rear right.
  travel(i: number) { return clamp(this.wheels[i].x, -this.springs[i >> 1].droop, this.springs[i >> 1].travel); }

  steeringRange(speed: number, radius: number) {
    const wb = this.axles.front - this.axles.rear;
    return Math.min(Math.atan(wb / radius), .065 + Math.atan(wb * 12 / (speed * speed + 1)));
  }

  // Lane assist asks for curvature: in the same steering travel as the driver's input.
  steerForCurvature(curvature: number, speed: number, radius: number) {
    const wb = this.axles.front - this.axles.rear;
    const angle = Math.atan(wb * curvature) + .0027 * speed * speed * curvature;
    return clamp(angle / this.steeringRange(speed, radius), -1, 1);
  }

  // Moves it on by dt. Returns the hardest landing of the body on the road, if any.
  advance(car: PlanBody, s: CarSpec, ctl: CarControl, road: number, dt: number, ground: Ground): Landing | null {
    this.absorb(car, ground);
    const x0 = car.x, y0 = car.y;
    const steps = Math.max(1, Math.ceil(dt * RATE - 1e-9)), h = dt / steps;
    let landing: Landing | null = null;
    for (let i = 0; i < steps; i++) {
      const l = this.step(s, ctl, road, h, ground);
      if (l && (!landing || l.speed > landing.speed)) landing = l;
    }
    this.publish(car, dt, x0, y0);
    let front = 0, back = 0;
    for (const w of this.wheels) if (w.front) front = Math.max(front, w.slide); else back = Math.max(back, w.slide);
    car.skidFront = front; car.skidBack = back;
    car.braking = this.lit;
    const resting = this.speed < .35 && this.spin < .35;
    this.still = this.tipped && resting ? this.still + dt : 0;
    return landing;
  }

  // What the flat game did to the car since the last step: moved it out of a wall,
  // bounced it, turned it, or put it somewhere else altogether.
  private absorb(car: PlanBody, ground: Ground) {
    const o = this.wrote;
    const dx = car.x - o.x, dy = car.y - o.y;
    if (Math.hypot(dx, dy) > 4 || !Number.isFinite(this.p[0] + this.v[0] + this.q[0])) return this.place(car, ground);
    this.p[0] += dx; this.p[1] += dy;
    const dh = Math.atan2(Math.sin(car.h - o.h), Math.cos(car.h - o.h));
    if (Math.abs(dh) > 1e-7) {
      // About the world's up through the middle of the car.
      const q = quat(0, 0, 1, dh), qx = this.centreX(), qy = this.centreY();
      mul(q, this.q, this.q);
      normalise(this.q);
      const c = Math.cos(dh), sn = Math.sin(dh), rx = this.p[0] - qx, ry = this.p[1] - qy;
      this.p[0] = qx + c * rx - sn * ry; this.p[1] = qy + sn * rx + c * ry;
      // (As in the flat game, turning the car leaves the way it moves alone.)
      this.matrix();
    }
    const dvx = car.vx - o.vx, dvy = car.vy - o.vy;
    if (dvx * dvx + dvy * dvy > 1e-8) {
      // A blow lands at bumper height: a tall body goes on over it.
      const R = this.R, bz = Math.min(.5, this.hcg) - this.cg[2], bx = -this.cg[0];
      const rx = R[0] * bx + R[2] * bz, ry = R[3] * bx + R[5] * bz, rz = R[6] * bx + R[8] * bz;
      this.impulse(dvx * this.m, dvy * this.m, 0, rx, ry, rz);
    }
    this.omega[2] += car.w - o.w;
  }

  // The plan position of the middle of the car (its origin raised to the centre of mass).
  private centreX() { const R = this.R; return this.p[0] - R[0] * this.cg[0]; }
  private centreY() { const R = this.R; return this.p[1] - R[3] * this.cg[0]; }

  // Writes the pose to the flat car. Its place stays where the step began, with the
  // speed that gets it to where the body is now: Car.move then moves it there against
  // the walls.
  private publish(car: PlanBody, dt: number, x0 = car.x, y0 = car.y) {
    this.matrix();
    const R = this.R, cx = this.centreX(), cy = this.centreY();
    const fh = Math.hypot(R[0], R[3]);
    if (fh > .15) car.h = Math.atan2(R[3], R[0]);
    if (dt > 0) {
      car.x = x0; car.y = y0;
      car.vx = (cx - x0) / dt; car.vy = (cy - y0) / dt;
    } else {
      car.x = cx; car.y = cy;
      const rx = -R[0] * this.cg[0], ry = -R[3] * this.cg[0], rz = -R[6] * this.cg[0];
      car.vx = this.v[0] + this.omega[1] * rz - this.omega[2] * ry;
      car.vy = this.v[1] + this.omega[2] * rx - this.omega[0] * rz;
    }
    car.w = this.omega[2];
    Object.assign(this.wrote, { x: dt > 0 ? cx : car.x, y: dt > 0 ? cy : car.y, h: car.h, vx: car.vx, vy: car.vy, w: car.w });
    const [gx, gy, gz] = this.cg;
    this.origin[0] = this.p[0] - (R[0] * gx + R[1] * gy + R[2] * gz);
    this.origin[1] = this.p[1] - (R[3] * gx + R[4] * gy + R[5] * gz);
    this.origin[2] = this.p[2] - (R[6] * gx + R[7] * gy + R[8] * gz);
    // Axes as columns: forward, left, up.
    for (let a = 0; a < 3; a++) for (let r = 0; r < 3; r++) this.axes[a * 3 + r] = R[r * 3 + a];
  }

  private matrix() {
    const [w, x, y, z] = this.q, R = this.R;
    R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - w * z); R[2] = 2 * (x * z + w * y);
    R[3] = 2 * (x * y + w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - w * x);
    R[6] = 2 * (x * z - w * y); R[7] = 2 * (y * z + w * x); R[8] = 1 - 2 * (x * x + y * y);
  }

  // A world point of the body (body coordinates bx, by, bz) into out[0..2].
  private point(bx: number, by: number, bz: number, out: Float64Array, at = 0) {
    const R = this.R, [gx, gy, gz] = this.cg, x = bx - gx, y = by - gy, z = bz - gz;
    out[at] = this.p[0] + R[0] * x + R[1] * y + R[2] * z;
    out[at + 1] = this.p[1] + R[3] * x + R[4] * y + R[5] * z;
    out[at + 2] = this.p[2] + R[6] * x + R[7] * y + R[8] * z;
  }

  // An impulse (N·s, world) at r from the centre of mass.
  private impulse(jx: number, jy: number, jz: number, rx: number, ry: number, rz: number) {
    const v = this.v, m = this.m;
    v[0] += jx / m; v[1] += jy / m; v[2] += jz / m;
    this.turn(ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx, this.omega);
  }

  // Adds the change of spin an angular impulse (world) makes to out.
  private turn(tx: number, ty: number, tz: number, out: Float64Array) {
    const R = this.R, I = this.inertia;
    const bx = (R[0] * tx + R[3] * ty + R[6] * tz) / I[0];
    const by = (R[1] * tx + R[4] * ty + R[7] * tz) / I[1];
    const bz = (R[2] * tx + R[5] * ty + R[8] * tz) / I[2];
    out[0] += R[0] * bx + R[1] * by + R[2] * bz;
    out[1] += R[3] * bx + R[4] * by + R[5] * bz;
    out[2] += R[6] * bx + R[7] * by + R[8] * bz;
  }

  // How much an impulse along n at r changes the speed there along n (1/kg).
  private give(nx: number, ny: number, nz: number, rx: number, ry: number, rz: number) {
    const d = this.spare; d[0] = d[1] = d[2] = 0;
    this.turn(ry * nz - rz * ny, rz * nx - rx * nz, rx * ny - ry * nx, d);
    return 1 / this.m + nx * (d[1] * rz - d[2] * ry) + ny * (d[2] * rx - d[0] * rz) + nz * (d[0] * ry - d[1] * rx);
  }
  private spare = new Float64Array(3);
  private at = new Float64Array(3);

  // Stops the body at r moving into a surface with normal n (out of it), with friction mu.
  // Returns how fast it was moving in.
  private touch(rx: number, ry: number, rz: number, nx: number, ny: number, nz: number, bounce: number, mu: number) {
    const v = this.v, o = this.omega;
    const vx = v[0] + o[1] * rz - o[2] * ry, vy = v[1] + o[2] * rx - o[0] * rz, vz = v[2] + o[0] * ry - o[1] * rx;
    const vn = vx * nx + vy * ny + vz * nz;
    if (vn >= 0) return 0;
    const jn = -(1 + bounce) * vn / this.give(nx, ny, nz, rx, ry, rz);
    this.impulse(jn * nx, jn * ny, jn * nz, rx, ry, rz);
    if (mu > 0) {
      const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz, t = Math.hypot(tx, ty, tz);
      if (t > 1e-6) {
        const ux = tx / t, uy = ty / t, uz = tz / t;
        const jt = Math.min(t / this.give(ux, uy, uz, rx, ry, rz), mu * jn);
        this.impulse(-jt * ux, -jt * uy, -jt * uz, rx, ry, rz);
      }
    }
    return -vn;
  }

  private step(s: CarSpec, ctl: CarControl, road: number, dt: number, ground: Ground): Landing | null {
    this.matrix();
    const R = this.R, p = this.p, v = this.v, o = this.omega, m = this.m, at = this.at;
    const upZ = R[8];
    // Forward and left, flattened onto the map.
    let fx = R[0], fy = R[3];
    const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    const forward = v[0] * fx + v[1] * fy, speed = Math.abs(forward);

    // The driver: steering, pedals and the gear (as StreetHandling).
    const available = this.steeringRange(speed, s.radius ?? 3.8);
    const wanted = clamp(ctl.steer, -1, 1) * available;
    const unwinding = this.steer * wanted <= 0 || Math.abs(wanted) < Math.abs(this.steer);
    this.steer += (wanted - this.steer) * (1 - Math.exp(-(unwinding ? 11 : Math.min(9, (s.response ?? 9) * .76)) * dt));
    const input = clamp(ctl.throttle, -1, 1), direction = Math.sign(input);
    if (direction && direction !== this.gearDirection && speed < .25 && !ctl.handbrake) {
      this.reverseWait += dt;
      if (this.reverseWait >= .2) { this.gearDirection = direction; this.pedal = 0; }
    } else this.reverseWait = 0;
    const footBrake = direction && (direction !== this.gearDirection || input * forward < -.25) ? Math.abs(input) : 0;
    const overLimit = ctl.cap == null ? 0 : Math.max(0, forward - ctl.cap);
    const gas = footBrake ? 0 : input * (input > 0 && ctl.cap != null ? clamp((ctl.cap - forward) / 2, 0, 1) : 1);
    this.pedal += (gas - this.pedal) * (1 - Math.exp(-(gas ? 9 : 22) * dt));
    const reverse = this.gearDirection < 0;
    const vmax = reverse ? Math.min(10, s.vmax * (s.reverse ?? .3)) : s.vmax;
    const pull = (footBrake ? 0 : this.pedal) * s.accel * (reverse ? .31 : .7)
      / (1 + speed / (reverse ? 7 : 19)) * Math.max(0, 1 - (speed / vmax) ** 4) * m;
    const braking = m * Math.max(footBrake * (s.brake ?? 16) * .62, Math.min(3, overLimit * 2));
    const engine = (1 - Math.abs(this.pedal)) * (s.drag ?? .6) * .65 * m;
    const driveFront = s.drive === 'rwd' ? 0 : s.drive === 'awd' ? .48 : 1;
    this.rearLock += (Number(ctl.handbrake) - this.rearLock) * (1 - Math.exp(-14 * dt));
    this.lit = !!footBrake || overLimit > .5 || (ctl.handbrake && speed > .3);

    // Forces (world) and torques about the centre of mass.
    let Fx = 0, Fy = 0, Fz = -m * G, Tx = 0, Ty = 0, Tz = 0;
    const add = (x: number, y: number, z: number, rx: number, ry: number, rz: number) => {
      Fx += x; Fy += y; Fz += z;
      Tx += ry * z - rz * y; Ty += rz * x - rx * z; Tz += rx * y - ry * x;
    };

    // Suspension: where each wheel's contact would be along the body's up axis.
    const W = this.wheels;
    for (let i = 0; i < 4; i++) {
      const w = W[i], sp = this.springs[i >> 1];
      this.point(w.ax, w.ay, 0, at);
      w.ground = upZ > .3 ? ground(at[0], at[1]) : -Infinity;
      const x = upZ > .3 ? (w.ground - at[2]) / upZ : -Infinity;
      if (x < -sp.droop) {
        w.contact = false; w.x = -sp.droop; w.rate = 0; w.load = 0;
      } else {
        w.rate = w.contact ? clamp((x - w.x) / dt, -4, 4) : clamp((x + sp.droop) / dt, 0, 4);
        w.contact = true; w.x = x;
        let f = this.statics[i] + sp.k * x + (w.rate > 0 ? sp.bump : sp.rebound) * w.rate;
        if (x > sp.travel) f += 15 * sp.k * (x - sp.travel) + sp.bump * 2 * Math.max(0, w.rate);
        w.load = f;
      }
      w.cx = at[0] + R[2] * w.x; w.cy = at[1] + R[5] * w.x; w.cz = at[2] + R[8] * w.x;
    }
    // The anti-roll bars (also against a wheel hanging in the air), then no tyre pulls the
    // car down: one the body lifts off its spring unloads, and the car goes up on two wheels.
    for (let a = 0; a < 4; a += 2) {
      const l = W[a], r = W[a + 1];
      const f = this.springs[a >> 1].arb * (l.x - r.x);
      if (l.contact) l.load += f;
      if (r.contact) r.load -= f;
      l.load = Math.max(0, l.load); r.load = Math.max(0, r.load);
    }

    // The road's slope across the wheels that touch it.
    let nx = 0, ny = 0, nz = 1;
    if (W.every(w => w.contact)) {
      const wb = this.axles.front - this.axles.rear, tr = this.axles.track;
      const sF = (W[0].ground + W[1].ground - W[2].ground - W[3].ground) / 2 / wb;
      const sL = (W[0].ground + W[2].ground - W[1].ground - W[3].ground) / 2 / tr;
      nx = -sF * fx + sL * fy; ny = -sF * fy - sL * fx;
      const n = Math.hypot(nx, ny, 1); nx /= n; ny /= n; nz = 1 / n;
    }

    // Tyres. An axle's drive and brakes go half to each wheel (an open differential: a
    // wheel lifted off the road by a hard turn spins).
    const share = (i: number) => W[i].contact ? .5 : 0;
    const ca = Math.cos(this.steer), sa = Math.sin(this.steer), each = m / 4 / dt;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      w.slide = 0;
      if (!w.contact || w.load <= 0) continue;
      const rx = w.cx - p[0], ry = w.cy - p[1], rz = w.cz - p[2];
      // The wheel's heading, then flat on the road.
      let hx = R[0], hy = R[3], hz = R[6];
      if (w.front || w.toe) {
        const turn = (w.front ? this.steer : 0) + w.toe, c = w.toe ? Math.cos(turn) : ca, sn = w.toe ? Math.sin(turn) : sa;
        hx = R[0] * c + R[1] * sn; hy = R[3] * c + R[4] * sn; hz = R[6] * c + R[7] * sn;
      }
      const hn = hx * nx + hy * ny + hz * nz;
      hx -= hn * nx; hy -= hn * ny; hz -= hn * nz;
      const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
      const lx = ny * hz - nz * hy, ly = nz * hx - nx * hz, lz = nx * hy - ny * hx;
      const vx = v[0] + o[1] * rz - o[2] * ry, vy = v[1] + o[2] * rx - o[0] * rz, vz = v[2] + o[0] * ry - o[1] * rx;
      const along = vx * hx + vy * hy + vz * hz, across = vx * lx + vy * ly + vz * lz;
      const load = Math.min(w.load, this.statics[i] * 3.5);
      const mu = this.grip * w.grip * road * clamp(1 - .05 * (load / this.statics[i] - 1), .88, 1.04);
      const most = mu * load;
      // Pedals: drive, then the brakes and the drag of the engine and the tyres rolling,
      // which never do more than stop the wheel.
      const drive = pull * (w.front ? driveFront : 1 - driveFront) * share(i);
      const resist = braking * (w.front ? .67 : .33) * share(i) * (1 - (w.front ? 0 : this.rearLock))
        + (.016 + w.scrub) * load + engine * (w.front ? driveFront : 1 - driveFront) * share(i);
      // (ABS: the brakes alone never lock a wheel.)
      const stop = Math.min(resist, .97 * most, Math.abs(along) * each);
      const demand = drive - Math.sign(along) * stop;
      const u = demand / most, T = TYRES[w.front ? 0 : 1];
      // (Asked for more than it has, the tyre spins up: its slip grows quickly past the peak.)
      const sx = Math.abs(u) <= 1 ? Math.sign(u) * T.slip(Math.abs(u)) : Math.sign(u) * (1 + (Math.abs(u) - 1) * 3);
      // (A tyre's cornering stiffness grows more slowly than its load: loaded harder, it
      // needs more slip to reach its peak.)
      const peak = this.slipPeak[w.front ? 0 : 1] * Math.sqrt(clamp(load / this.statics[i], .3, 3));
      const sy = across / (Math.max(Math.abs(along), SLOW) * peak);
      const slip = Math.hypot(sx, sy);
      let fa = 0, fs = 0;
      if (slip > 1e-9) {
        const f = most * T.curve(slip);
        fa = f * sx / slip; fs = -f * sy / slip;
      }
      // Never more sideways than stops the tyre's slide this step.
      fs = clamp(fs, -Math.abs(across) * each, Math.abs(across) * each);
      if (!w.front && this.rearLock > .01) {
        // A wheel locked by the handbrake slides against the way it moves.
        const sliding = Math.hypot(along, across), f = Math.min(most * LOCKED, sliding * each) / Math.max(sliding, 1e-6);
        fa += (-along * f - fa) * this.rearLock; fs += (-across * f - fs) * this.rearLock;
      }
      w.slide = clamp((slip - 1.1) * 1.4, 0, 1) * clamp(Math.hypot(along, across) / 3, 0, 1);
      if (!w.front) w.slide = Math.max(w.slide, this.rearLock * clamp(speed / 4, 0, .92));
      if (footBrake && speed > 4) w.slide = Math.max(w.slide, .3 * footBrake);
      const up = w.load;
      add(R[2] * up + hx * fa + lx * fs, R[5] * up + hy * fa + ly * fs, R[8] * up + hz * fa + lz * fs, rx, ry, rz);
    }

    // Air.
    const drag = .00032 * m * Math.hypot(v[0], v[1], v[2]);
    Fx -= drag * v[0]; Fy -= drag * v[1]; Fz -= drag * v[2];

    // Integrate the speeds: spin in the body's frame, with its gyroscopic part.
    v[0] += Fx / m * dt; v[1] += Fy / m * dt; v[2] += Fz / m * dt;
    {
      const I = this.inertia;
      const bx = R[0] * o[0] + R[3] * o[1] + R[6] * o[2], by = R[1] * o[0] + R[4] * o[1] + R[7] * o[2], bz = R[2] * o[0] + R[5] * o[1] + R[8] * o[2];
      const tx = R[0] * Tx + R[3] * Ty + R[6] * Tz, ty = R[1] * Tx + R[4] * Ty + R[7] * Tz, tz = R[2] * Tx + R[5] * Ty + R[8] * Tz;
      const nbx = bx + (tx - (by * I[2] * bz - bz * I[1] * by)) / I[0] * dt;
      const nby = by + (ty - (bz * I[0] * bx - bx * I[2] * bz)) / I[1] * dt;
      const nbz = bz + (tz - (bx * I[1] * by - by * I[0] * bx)) / I[2] * dt;
      const k = Math.exp(-.05 * dt);
      o[0] = (R[0] * nbx + R[1] * nby + R[2] * nbz) * k;
      o[1] = (R[3] * nbx + R[4] * nby + R[5] * nbz) * k;
      o[2] = (R[6] * nbx + R[7] * nby + R[8] * nbz) * k;
    }

    // A tyre sliding sideways into a kerb is stopped by it at the kerb's height.
    for (const w of W) {
      if (!w.contact && upZ < .5) continue;
      const rx = w.cx - p[0], ry = w.cy - p[1], rz = w.cz - p[2];
      const vx = v[0] + o[1] * rz - o[2] * ry, vy = v[1] + o[2] * rx - o[0] * rz;
      const lx = -fy, ly = fx, across = vx * lx + vy * ly;
      if (Math.abs(across) < 1.2) continue;
      const side = Math.sign(across), kerb = ground(w.cx + lx * side * .28, w.cy + ly * side * .28);
      const base = Number.isFinite(w.ground) ? w.ground : ground(w.cx, w.cy);
      const rise = kerb - base;
      if (rise < .06 || rise > .8 || w.cz > kerb - .02) continue;
      const hit = Math.min(rise, this.axles.radius) * .7;
      this.touch(rx, ry, rz + hit, -lx * side, -ly * side, 0, .05, .3);
    }

    // The body on the road: the points of it that are below the ground.
    let landing: Landing | null = null;
    this.point(0, 0, this.hcg, at);
    const middle = ground(at[0], at[1]), pts = this.hull, deep = this.deep;
    let n = 0;
    for (let j = 0; j < pts.length; j++) {
      this.point(pts[j][0], pts[j][1], pts[j][2], at);
      if (at[2] > middle + .9) continue;
      const g = ground(at[0], at[1]), d = g - at[2];
      if (d <= 0) continue;
      deep[n * 4] = at[0] - p[0]; deep[n * 4 + 1] = at[1] - p[1]; deep[n * 4 + 2] = at[2] - p[2]; deep[n * 4 + 3] = d;
      n++;
    }
    let most = 0;
    for (let pass = 0; pass < 3; pass++) for (let j = 0; j < n; j++) {
      const rx = deep[j * 4], ry = deep[j * 4 + 1], rz = deep[j * 4 + 2];
      const into = this.touch(rx, ry, rz, 0, 0, 1, pass ? 0 : .15, .45);
      if (!pass && into > most) { most = into; landing = { speed: into, x: p[0] + rx, y: p[1] + ry }; }
    }
    let lift = 0;
    for (let j = 0; j < n; j++) lift = Math.max(lift, deep[j * 4 + 3]);
    if (lift > .01) p[2] += (lift - .01) * .4;

    // Standing still with the brakes on (or on the level, off the gas): stopped.
    if (this.planted && Math.hypot(v[0], v[1]) < .25 && Math.abs(o[2]) < .2) {
      const levelGround = Math.abs(nx) < .015 && Math.abs(ny) < .015;
      if (footBrake || ctl.handbrake || (!input && levelGround)) { v[0] = v[1] = 0; o[2] = 0; }
    }

    // Positions.
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
    const q = this.q, [qw, qx, qy, qz] = q, h = dt / 2;
    q[0] += (-o[0] * qx - o[1] * qy - o[2] * qz) * h;
    q[1] += (o[0] * qw + o[1] * qz - o[2] * qy) * h;
    q[2] += (o[1] * qw + o[2] * qx - o[0] * qz) * h;
    q[3] += (o[2] * qw + o[0] * qy - o[1] * qx) * h;
    normalise(q);
    return landing;
  }
  private deep = new Float64Array(4 * 24);
}

// The points of the body that meet the road when it tips: the sills, the bumpers' ends,
// the shoulders (the bonnet's and the boot's corners on a saloon) and the roof's corners,
// on the cross-section rollover.ts uses.
function hullOf(s: CarSpec): [number, number, number][] {
  const L = s.L / 2, W = s.W / 2, H = s.H, boxy = !!s.heavy || H > 1.9;
  const top = boxy ? W * .96 : W * .86, shoulder = boxy ? H * .85 : H * .6, floor = clamp(H * .12, .15, .26);
  const [a, b] = s.cabin ?? [-L * .6, L * .5];
  const roofBack = boxy ? -L + .15 : a + .2, roofFront = boxy ? Math.max(b - .2, L - 1.1) : b - .25;
  const pts: [number, number, number][] = [];
  for (const y of [W, -W]) for (const x of [L - .35, 0, .35 - L]) pts.push([x, y, floor]);
  for (const y of [W - .2, .2 - W]) for (const x of [L, -L]) pts.push([x * .99, y, floor + .2]);
  for (const y of [W, -W]) for (const x of [L - .2, 0, .2 - L]) pts.push([x, y, shoulder]);
  for (const y of [top, -top]) for (const x of [roofFront, roofBack]) pts.push([x, y, H]);
  return pts;
}

function quat(x: number, y: number, z: number, angle: number) {
  const s = Math.sin(angle / 2);
  return new Float64Array([Math.cos(angle / 2), x * s, y * s, z * s]);
}
function mul(a: Float64Array, b: Float64Array, out: Float64Array) {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  out[0] = aw * bw - ax * bx - ay * by - az * bz;
  out[1] = aw * bx + ax * bw + ay * bz - az * by;
  out[2] = aw * by - ax * bz + ay * bw + az * bx;
  out[3] = aw * bz + ax * by - ay * bx + az * bw;
  return out;
}
function normalise(q: Float64Array) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
}
