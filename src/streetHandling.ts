// A single-track model for the player's car. X is forward, lateral force is
// positive to the left and positive yaw turns left. Forces below are per kg.
import type { Car, CarControl, CarSpec } from './car.ts';

const G = 9.81;
export const ROLL_CENTRE = .44; // metres above the local road plane
const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

type Vehicle = Pick<Car, 'h' | 'w' | 'vx' | 'vy' | 'braking' | 'skidFront' | 'skidBack'>;

export class StreetHandling {
  steer = 0; // front wheel angle, radians
  roll = 0;
  pitch = 0;
  private rollRate = 0;
  private pitchRate = 0;
  private longitudinal = 0;
  private pedal = 0;
  private rearLock = 0;
  private gearDirection: number;
  private reverseWait = 0;

  constructor(forward: number, readonly wheelbase: number) {
    this.gearDirection = forward < -.25 ? -1 : 1;
  }

  advance(car: Vehicle, spec: CarSpec, ctl: CarControl, road: number, slope: number, dt: number) {
    // Only the driven car pays for these small steps. Stable tyres and springs
    // at parking speed, even when the game is drawing at 20 or 30 fps.
    const steps = Math.ceil(dt * 120 - 1e-9);
    for (let i = 0; i < steps; i++) this.step(car, spec, ctl, road, slope, dt / steps);
  }

  private steeringRange(speed: number, radius: number) {
    return Math.min(Math.atan(this.wheelbase / radius), .072 + Math.atan(this.wheelbase * 13 / (speed * speed + 1)));
  }

  // Lane assist asks for curvature. Express it in the same rack travel as the
  // driver's input, including the small front/rear difference in cornering slip.
  steerForCurvature(curvature: number, speed: number, radius: number) {
    const angle = Math.atan(this.wheelbase * curvature) + .0027 * speed * speed * curvature;
    return clamp(angle / this.steeringRange(speed, radius), -1, 1);
  }

  private step(c: Vehicle, s: CarSpec, ctl: CarControl, road: number, slope: number, dt: number) {
    const fx = Math.cos(c.h), fy = Math.sin(c.h);
    const forward = c.vx * fx + c.vy * fy, left = -c.vx * fy + c.vy * fx;
    const speed = Math.abs(forward), wb = this.wheelbase;
    const frontStatic = s.drive === 'rwd' ? .51 : s.drive === 'awd' ? .55 : .60;
    const frontArm = wb * (1 - frontStatic), rearArm = wb * frontStatic;
    const height = s.H * .36;
    const frontLoad = clamp(frontStatic - this.longitudinal * height / (G * wb), .27, .79);
    const grip = G * road * clamp(.96 * s.grip / 8.5, .79, 1.05);

    // Full lock is useful in a courtyard; at road speed the first few degrees
    // should let you place the car in a lane. Unwind faster than winding on.
    const available = this.steeringRange(speed, s.radius ?? 3.8);
    const wanted = clamp(ctl.steer, -1, 1) * available;
    const unwinding = this.steer * wanted <= 0 || Math.abs(wanted) < Math.abs(this.steer);
    this.steer += (wanted - this.steer) * (1 - Math.exp(-(unwinding ? 9 : (s.response ?? 9) * .76) * dt));
    const cs = Math.cos(this.steer), sn = Math.sin(this.steer);

    const input = clamp(ctl.throttle, -1, 1), direction = Math.sign(input);
    if (direction && direction !== this.gearDirection && speed < .25 && !ctl.handbrake) {
      this.reverseWait += dt;
      if (this.reverseWait >= .20) { this.gearDirection = direction; this.pedal = 0; }
    } else this.reverseWait = 0;
    const footBrake = direction && (direction !== this.gearDirection || input * forward < -.25) ? Math.abs(input) : 0;
    const overLimit = ctl.cap == null ? 0 : Math.max(0, forward - ctl.cap);
    const gas = footBrake ? 0 : input * (input > 0 && ctl.cap != null ? clamp((ctl.cap - forward) / 2, 0, 1) : 1);
    this.pedal += (gas - this.pedal) * (1 - Math.exp(-(gas ? 9 : 22) * dt));
    const reverse = this.gearDirection < 0;
    const vmax = reverse ? Math.min(10, s.vmax * (s.reverse ?? .3)) : s.vmax;
    // Torque-limited launch, then a power-limited pull as speed builds.
    const pull = (footBrake ? 0 : this.pedal) * s.accel * (reverse ? .31 : .63)
      / (1 + speed / (reverse ? 7 : 19)) * Math.max(0, 1 - (speed / vmax) ** 4);
    const brake = Math.min(speed / dt, Math.max(footBrake * (s.brake ?? 16) * .62, Math.min(3, overLimit * 2)));
    const driveFront = s.drive === 'rwd' ? 0 : s.drive === 'awd' ? .48 : 1;
    const sign = Math.sign(forward), frontLimit = grip * frontLoad, rearLimit = grip * (1 - frontLoad);
    const frontX = clamp(pull * driveFront - sign * brake * .67, -frontLimit, frontLimit);
    const rearDrive = clamp(pull * (1 - driveFront) - sign * brake * .33, -rearLimit, rearLimit);

    // The steered front contact patch sees a different velocity from the rear.
    // Braking and propulsion spend some of the same grip needed for cornering.
    const frontLeft = left + frontArm * c.w, rearLeft = left - rearArm * c.w;
    const frontSlip = (frontLeft * cs - forward * sn) / Math.max(2.5, Math.abs(forward * cs + frontLeft * sn));
    const rearSlip = rearLeft / Math.max(2.5, speed);
    const frontBudget = Math.sqrt(Math.max(0, frontLimit ** 2 - frontX ** 2));
    const rearBudget = Math.sqrt(Math.max(0, rearLimit ** 2 - rearDrive ** 2));
    const frontY = -frontBudget * Math.tanh(8.0 * frontSlip);
    // A locked rear tyre still drags against its direction of travel. As the
    // tail steps out more of that drag acts sideways, arresting the spin.
    this.rearLock += (Number(ctl.handbrake) - this.rearLock) * (1 - Math.exp(-12 * dt));
    const lockedDrag = rearLimit * .78 / Math.max(.65, Math.hypot(forward, rearLeft));
    const rearX = (1 - this.rearLock) * rearDrive - this.rearLock * lockedDrag * forward;
    const rearY = -(1 - this.rearLock) * rearBudget * Math.tanh(10.2 * rearSlip) - this.rearLock * lockedDrag * rearLeft;
    const frontSide = frontY * cs + frontX * sn;
    const lateral = frontSide + rearY;
    const resistance = Math.min(speed / dt, .16 + .00032 * speed ** 2 + (1 - Math.abs(this.pedal)) * (s.drag ?? .6) * .65);
    this.longitudinal = frontX * cs - frontY * sn + rearX - sign * resistance;
    const along = this.longitudinal - G * slope / Math.sqrt(1 + slope * slope);

    c.vx += (fx * along - fy * lateral) * dt;
    c.vy += (fy * along + fx * lateral) * dt;
    const yawInertia = (.29 * s.L) ** 2 + (.25 * s.W) ** 2;
    c.w += ((frontArm * frontSide - rearArm * rearY) / yawInertia - .22 * c.w) * dt;
    c.h += c.w * dt;
    if (speed < .25 && Math.abs(left) < .12 && (footBrake || ctl.handbrake || (!input && Math.abs(slope) < .015))) {
      c.vx = c.vy = c.w = 0;
    }

    c.braking = !!footBrake || overLimit > .5 || (ctl.handbrake && speed > .3);
    c.skidFront = clamp((Math.abs(frontSlip) - .12) * 2.6 + footBrake * Math.min(1, speed / 8) * .30, 0, 1);
    c.skidBack = Math.max(clamp((Math.abs(rearSlip) - .105) * 2.8, 0, 1), ctl.handbrake ? clamp(speed / 4, 0, .92) : 0);

    // Sprung body: rearward load transfer lifts the nose; leftward force
    // compresses the right springs. Tall bodies take a slower, larger set.
    const tall = clamp((s.H - 1.43) / .7, 0, 1);
    const rollTarget = clamp(lateral / G * (.096 + tall * .058), -.14, .14);
    const pitchTarget = clamp(this.longitudinal / G * (.072 + tall * .031), -.093, .065);
    const frequency = 10.4 - 2.6 * tall;
    this.rollRate += (frequency ** 2 * (rollTarget - this.roll) - 1.48 * frequency * this.rollRate) * dt;
    this.pitchRate += (frequency ** 2 * (pitchTarget - this.pitch) - 1.60 * frequency * this.pitchRate) * dt;
    this.roll += this.rollRate * dt;
    this.pitch += this.pitchRate * dt;
  }
}
