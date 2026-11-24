// Riding a bicycle or a motorbike (car.ts): the model for the one you ride. The traffic's
// riders keep to their lanes as before (traffic.ts).
//
// A two-wheeler turns because it leans: in a steady turn the lean φ and the turn rate ω
// balance, g·tan φ = v·ω. Steering asks for a lean, and the rider takes a moment to
// get there (`rate`), so turning in, straightening up and swerving all lag a little. At
// walking pace the handlebars steer it directly, as on a bicycle you wheel round a corner.
//
// The tyres' grip is one budget for turning, braking and driving (the friction circle):
// the rider keeps inside it, leaning less while braking or on a wet road, and easing the
// throttle in a bend. But the lean can't change at once, so grabbing the brakes in a
// bend, or a shower starting mid-corner, takes more than the tyres have, and a moment
// later the bike slides out from under you (a low-side).
//
// Braking: the brakes stop it as hard as the tyres or the rider allow, but a bicycle's
// short wheelbase and high rider tip it over the front wheel at about 0.6 g; the rider
// keeps to 0.45 g, and downhill the margin goes, so braking hard down a street steeper
// than about 15 % sends you over the bars. The handbrake button is the back brake alone: it
// locks the back wheel and skids, stopping you gently.
//
// A bicycle is pedalled: about 250 W, so its speed comes from the road's gradient and the
// air (about 32 km/h on the level, 12 up an 8 % street, and over 50 coasting down one).
//
// Kerbs: met nearly head-on the wheel rides up them with a bump, unless you hit one fast
// (over about 22 km/h on a bicycle, 36 on a motorbike) or it's a much higher step, which
// throws you over the bars; met at a shallow angle the front wheel runs along the kerb's
// edge and washes out, and you fall.
import { DRIVE_TUNE } from './driveTune.ts';
import type { Car, CarControl, CarSpec } from './car.ts';

const G = 9.81;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

// lean: the most the frame leans (rad); rate: how fast the rider leans it over (rad/s);
// mu: the tyres' grip on a dry road; flip: the braking (in g) that tips it over the front
// wheel on the level; stop: the hardest the rider brakes (in g, on a dry road); hop: a step
// higher than this (m) throws you over the bars; hit: so does riding straight at a kerb
// faster than this (m/s; less for a higher step).
const RIDE = {
  bike: { lean: 0.7, rate: 2.6, mu: 0.85, flip: 0.6, stop: 0.45, hop: 0.2, hit: 6 },
  moto: { lean: 0.84, rate: 2, mu: 1.05, flip: 1.05, stop: 0.92, hop: 0.25, hit: 10 },
};
const KERB = 0.12; // m (kerbDrop.ts)
// Of the grip, what the rider is willing to use.
const CARE = 0.88;
// Seconds over the tyres' grip before they let go.
const SLIDE = 0.12;
// The bicycle: the rider's power (W), the air's drag area (m², with the rider) and the
// tyres' rolling resistance.
const PEDAL = 250, CDA = 0.45, ROLLING = 0.006;
// How long (s) squeezing the brake levers fully takes.
const SQUEEZE = 0.3;

type Rider = Pick<Car, 'x' | 'y' | 'h' | 'w' | 'vx' | 'vy' | 'braking' | 'skidFront' | 'skidBack' | 'lean' | 'pedaling'>;
export type Fall = 'slide' | 'over' | 'kerb';

export class TwoWheel {
  lean = 0;
  private slip = 0;
  private squeeze = 0;
  private bump = 0; // s until another kerb counts

  // One step: moves the bike's speed and heading on. Returns how the rider came off, if
  // they did. `height`: the ground's height, for the kerbs.
  step(car: Rider, spec: CarSpec, S: CarSpec, ctl: CarControl, throttle: number, road: number, slope: number, dt: number, height?: (x: number, y: number) => number): Fall | null {
    const R = RIDE[spec.two!], fx = Math.cos(car.h), fy = Math.sin(car.h);
    let vf = car.vx * fx + car.vy * fy, vl = car.vx * fy - car.vy * fx;
    const v = Math.abs(vf);
    const mu = R.mu * DRIVE_TUNE.grip * road, rate = R.rate * DRIVE_TUNE.response;
    // What the turn takes of the grip now (lateral acceleration in g).
    const lat = Math.abs(vf * car.w) / G;

    // Driving: a bicycle at the rider's power, a motorbike at its engine's; either kept
    // within the grip the turn leaves.
    const room = Math.sqrt(Math.max(0, (CARE * mu) ** 2 - lat * lat)) * G;
    let drive = 0;
    if (throttle > 0 && vf > -0.3) {
      drive = spec.two === 'bike'
        ? Math.min(S.accel, (PEDAL * (S.accel / spec.accel) * throttle) / (S.mass * Math.max(v, 1)))
        : S.accel * throttle * (1 - (v / S.vmax) ** 2);
      drive = Math.min(drive, room);
    }
    car.pedaling = spec.two === 'bike' && throttle > 0.02 && !ctl.handbrake;
    // Braking: both levers squeezed over SQUEEZE s, as hard as the grip left by the turn
    // allows and the rider dares (on a bicycle, short of going over the bars on the level).
    const braking = throttle < 0 && vf > 0.3;
    this.squeeze = clamp(this.squeeze + (braking ? dt : -2 * dt) / SQUEEZE, 0, 1);
    const flip = R.flip + slope; // (downhill, slope < 0, it tips over sooner)
    const dare = Math.min(R.stop * G * (S.brake ?? 16) / (spec.brake ?? 16), CARE * mu * G);
    const brake = this.squeeze * dare;
    const back = ctl.handbrake && v > 0.3 ? Math.min(0.35 * mu * G, room) : 0;
    car.braking = braking || back > 0;
    // Grip used along the road (g): the tyres' own forces, not gravity's pull on a slope.
    const lon = (drive + brake + back) / G;

    if (throttle < 0 && vf <= 0.3) vf = Math.max(-1.2, vf - 1.5 * dt); // walking it backwards
    else if (throttle > 0 && vf < -0.3) vf = Math.min(0, vf + (S.brake ?? 16) * 0.5 * dt); // rolling back: brakes on
    else {
      const resist = spec.two === 'bike' ? (0.6125 * CDA * v * v) / S.mass + ROLLING * G : throttle > 0 ? 0 : S.drag ?? 0.6;
      const slowing = (brake + back + resist) * dt;
      vf = vf >= 0 ? Math.max(0, vf - slowing) + drive * dt : Math.min(0, vf + slowing);
    }
    // (Stopped, the rider puts a foot down rather than roll back down the hill.)
    if (Math.abs(vf) > 0.5 || throttle !== 0) vf -= G * slope * dt;
    if (spec.two === 'bike') vf = Math.min(vf, S.vmax * 2.2); // (no faster than a fast descent)

    // Steering: the lean you ask for, as far as the grip allows on its own. Braking doesn't
    // stand the bike up for you: let go of the steering first (the throttle, though,
    // gives way to the lean, above).
    const most = Math.min(R.lean, Math.atan(CARE * mu));
    const radius = S.radius ?? 2.5;
    // At walking pace the handlebars turn it; at speed the lean does. In between, both.
    const by = clamp((v - 1.5) / 4, 0, 1);
    const direct = (ctl.steer * vf) / radius;
    const want = (1 - by) * Math.atan((vf * direct) / G) + by * ctl.steer * most;
    this.lean += clamp((want - this.lean) * Math.min(1, dt * 10), -rate * dt, rate * dt);
    const leaned = (G * Math.tan(this.lean)) / Math.max(v, 0.5) * Math.sign(vf || 1);
    car.w = (1 - by) * direct + by * leaned;
    car.h += car.w * dt;
    car.lean = this.lean;

    // Over the grip: a moment, then the tyres let go.
    const used = Math.hypot(Math.tan(Math.abs(this.lean)) * by + lat * (1 - by), lon);
    this.slip = used > mu && v > 2 ? this.slip + dt : Math.max(0, this.slip - 2 * dt);
    // Over the bars: braking harder than the front wheel can take before it tips.
    const over = spec.two === 'bike' && brake / G > flip && v > 2;

    // The tyres don't slide sideways while they grip.
    vl *= Math.exp(-25 * dt);
    car.skidBack = back > 0 && v > 1 ? 0.8 : 0;
    car.skidFront = this.squeeze > 0.8 && brake > 0.8 * mu * G ? 0.5 : 0;
    const nx = Math.cos(car.h), ny = Math.sin(car.h);
    car.vx = nx * vf + ny * vl;
    car.vy = ny * vf - nx * vl;

    if (over) return 'over';
    if (this.slip > SLIDE) return 'slide';
    this.bump -= dt;
    return height && v > 1 ? this.kerb(car, spec, height) : null;
  }

  // A step up just ahead of the front wheel (a kerb is 12 cm): met head-on the wheel rides
  // up it with a bump, or throws you over the bars if it's a good deal higher; met at a
  // shallow angle the wheel runs along its edge and washes out. Riding alongside one is
  // fine.
  private kerb(car: Rider, spec: CarSpec, height: (x: number, y: number) => number): Fall | null {
    if (this.bump > 0) return null;
    const v = Math.hypot(car.vx, car.vy), tx = car.vx / v, ty = car.vy / v, nose = spec.L / 2 - 0.3;
    const x = car.x + Math.cos(car.h) * nose, y = car.y + Math.sin(car.h) * nose;
    // Climbing, half a metre on, more than the street's own slope over the last two?
    const here = height(x, y), slope = (here - height(x - tx * 2, y - ty * 2)) / 2;
    const qx = x + tx * 0.5, qy = y + ty * 0.5;
    if (height(qx, qy) - here - slope * 0.5 < 0.015) return null;
    // Which way the step faces (the way the ground climbs there), and how high it is
    // across, less the ground's own slope that way. (The kerbs are a short ramp in the
    // ground's heights, kerbDrop.ts.)
    const d = 0.2, gx = height(qx + d, qy) - height(qx - d, qy), gy = height(qx, qy + d) - height(qx, qy - d), g = Math.hypot(gx, gy);
    if (!g) return null;
    const nx = gx / g, ny = gy / g, head = tx * nx + ty * ny; // 1: square on to it
    if (head < 0.1) return null;
    const at = (s: number) => height(qx + nx * s, qy + ny * s);
    const fall = (at(1.5) - at(0.6) + at(-0.6) - at(-1.5)) / 1.8; // (either side of it)
    const step = at(0.3) - at(-0.3) - fall * 0.6;
    if (step < 0.08 || step > 1) return null;
    if (head < 0.35) return v > 2 ? 'kerb' : null; // (closer than about 20° to its line)
    // Straight at it: too high, or too fast for its height, and you go over the bars.
    const R = RIDE[spec.two!], whole = at(0.6) - at(-0.6) - fall * 1.2;
    if (v > 2 && (whole > R.hop || v * head > R.hit * KERB / whole)) return 'over';
    this.bump = 1.5 / v; // (one bump for the step, over the next metre and a half)
    const keep = 1 - Math.min(0.4, step);
    car.vx *= keep;
    car.vy *= keep;
    return null;
  }
}
