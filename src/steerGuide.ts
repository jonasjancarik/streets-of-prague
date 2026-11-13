import * as THREE from 'three';
import type { Car } from './car.ts';
import { turnOf } from './assist.ts';
import { clamp } from './network.ts';
import { WET, SNOW, STREET_SNOW } from './shading.ts';

// Where the car will go with the stick held as it is: a row of dashes on the road
// ahead, ending in an arrowhead. The stick (touch, or a gamepad's) sets a heading and the car comes
// round to it over a second or two, in an arc that is wider the faster you go; this
// shows the arc before you've driven it.
//
// The path is the car's own physics run ahead (Car.update, without the hills, the walls
// and the other cars), from the speed, the slide and the turn it has now, steering
// towards the stick at every step. Sliding, the dashes fade: the car won't keep to them.

const AHEAD = 1.2;  // s of driving shown
const STEPS = 24;
const DASHES = 12;  // one every other step
const HALF = 0.4;   // half a dash's width, m, at the usual zoom
const LIFT = 0.08;  // m above the ground
const FROM = 8, FULL = 18; // degrees between the car and the stick: nothing shown below, all of it above

// The stick in a car points where you want to go on screen, as it does on foot: steer
// towards that heading, harder the further off it is. Reversing (or about to, with the
// brake held at a standstill), the back of the car is what follows the stick.
// `last` keeps which way round the car was turning, between calls.
export function aimSteer(h: number, v: number, aim: number, throttle: number, last: { off: number }) {
  const back = v < -0.3 || (throttle < 0 && v < 0.5);
  let off = turnOf(h + (back ? Math.PI : 0), aim);
  // Pointing straight behind: keep turning the way you started, not flip-flop.
  if (Math.abs(off) > 2.6 && last.off && Math.sign(off) !== Math.sign(last.off)) off = -off;
  last.off = off;
  return clamp(off * 1.6, -1, 1) * (back ? -1 : 1);
}

export interface Held { h: number; throttle: number; handbrake: boolean }

export class SteerGuide {
  private path: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private pathPos: THREE.BufferAttribute;
  private pts = new Float32Array((STEPS + 1) * 2);
  private drawn = 0; // 0..1, how clearly it shows
  private turning = { off: 0 };

  constructor(scene: THREE.Scene) {
    const g = new THREE.BufferGeometry();
    this.pathPos = new THREE.BufferAttribute(new Float32Array((DASHES * 4 + 3) * 3), 3);
    g.setAttribute('position', this.pathPos);
    const index: number[] = [];
    for (let i = 0; i < DASHES; i++) index.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3);
    index.push(DASHES * 4, DASHES * 4 + 1, DASHES * 4 + 2);
    g.setIndex(index);
    this.path = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: '#ffd84a', transparent: true, opacity: 0, depthWrite: false, fog: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -12,
    }));
    this.path.frustumCulled = false;
    this.path.visible = false;
    this.path.renderOrder = 2; // over the ground and the tyre marks
    scene.add(this.path);
  }

  // `held`: the heading the stick asks for and the pedals, or null when nothing is
  // steering by a heading; `size`: how much bigger to draw it, zoomed out.
  update(dt: number, car: Car | null, held: Held | null, height: (x: number, y: number) => number, size: number) {
    let want = 0;
    if (car && held) {
      const back = car.forwardSpeed < -0.3 || (held.throttle < 0 && car.forwardSpeed < 0.5);
      const off = Math.abs(turnOf(car.h + (back ? Math.PI : 0), held.h)) * 180 / Math.PI;
      const length = this.predict(car, held);
      const fx = Math.cos(car.h), fy = Math.sin(car.h);
      const slide = clamp((Math.abs(car.vx * fy - car.vy * fx) - 1.5) / 4, 0, 1);
      want = clamp((off - FROM) / (FULL - FROM), 0, 1) * clamp((length - car.spec.L) / 3, 0, 1) * (1 - 0.85 * slide) * (held.handbrake ? 0.4 : 1);
      this.lay(car, height, size);
    }
    this.drawn += (want - this.drawn) * Math.min(1, dt * 10);
    this.path.material.opacity = 0.85 * this.drawn;
    this.path.visible = this.drawn > 0.02;
  }

  // The car's centre over the next AHEAD seconds into `pts`; returns how far it goes.
  // (Keep in step with the physics in Car.update.)
  private predict(car: Car, held: Held) {
    const S = car.spec, dt = AHEAD / STEPS, p = this.pts;
    let x = car.x, y = car.y, h = car.h, w = car.w;
    let vf = car.vx * Math.cos(h) + car.vy * Math.sin(h);
    let vl = car.vx * Math.sin(h) - car.vy * Math.cos(h);
    const road = 1 - (S.weather ?? 1) * (S.drive === 'awd' ? 0.6 : 1) * Math.max(0.25 * WET.value, 0.45 * SNOW.value * STREET_SNOW.value, 0.25 * SNOW.value);
    const brake = S.brake ?? 16, throttle = held.throttle;
    const last = { off: this.turning.off };
    let length = 0;
    p[0] = x; p[1] = y;
    for (let i = 1; i <= STEPS; i++) {
      const fast = clamp(Math.abs(vf) / S.vmax, 0, 1);
      if (throttle > 0) {
        if (vf < -0.3) vf = Math.min(0, vf + brake * road * dt);
        else vf += S.accel * throttle * (1 - fast * fast) * (0.6 + 0.4 * road) * dt;
      } else if (throttle < 0) {
        if (vf > 0.3) vf = Math.max(0, vf - brake * road * dt);
        else vf = Math.max(-S.vmax * (S.reverse ?? 0.3), vf - S.accel * 0.6 * dt);
      } else vf -= Math.sign(vf) * Math.min(Math.abs(vf), (S.drag ?? 0.6) * dt);
      if (held.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);

      const steer = aimSteer(h, vf, held.h, throttle, last);
      if (i === 1) this.turning.off = last.off;
      const power = S.two ? 0 : clamp(throttle, 0, 1);
      const bend = power * Math.abs(steer) * clamp(Math.abs(vf) / 10, 0, 1);
      const sliding = clamp((Math.abs(vl) - 1) / 5, 0, 1);
      const grip = (held.handbrake ? 1.1 : S.grip * (1 - (S.fade ?? 0.45) * fast) * (S.drive === 'rwd' ? 1 - (0.3 + 0.5 * sliding) * bend : 1) * (1 - 0.6 * sliding)) * road;
      vl *= Math.exp(-grip * dt);
      const loose = 1.8 * (1 - road) * clamp((Math.abs(vf) - 4) / 10, 0, 1);
      const follow = held.handbrake ? 1 - 0.8 * clamp((Math.abs(vf) - 3) / 5, 0, 1) : (S.drive === 'rwd' ? 1 - 0.6 * bend * sliding : 1) * (1 - loose);
      const maxW = S.turn * (1 - 0.35 * fast) * (held.handbrake ? 1.35 : 1) * (!S.drive || S.drive === 'fwd' ? 1 - 0.12 * bend : 1);
      const swing = held.handbrake ? Math.hypot(vf, vl) : Math.abs(vf);
      const wantW = steer * Math.min(swing / (S.radius ?? 3.6), maxW) * (vf >= 0 ? 1 : -1);
      w += (wantW - w) * Math.min(1, dt * (S.response ?? 9));
      h += w * dt;
      const travel = h - w * dt * (1 - follow);
      const nx = Math.cos(travel), ny = Math.sin(travel);
      const dx = (nx * vf + ny * vl) * dt, dy = (ny * vf - nx * vl) * dt;
      x += dx; y += dy;
      length += Math.hypot(dx, dy);
      p[i * 2] = x; p[i * 2 + 1] = y;
    }
    return length;
  }

  private lay(car: Car, height: (x: number, y: number) => number, size: number) {
    const p = this.pts, a = this.pathPos.array as Float32Array, half = HALF * size;
    // (Three.js is y-up: the map's y is -z.)
    const put = (o: number, x: number, y: number, z: number) => { a[o] = x; a[o + 1] = z; a[o + 2] = -y; };
    const clear = car.spec.L / 2 + 0.6; // nothing under the car itself
    let ux = Math.cos(car.h), uy = Math.sin(car.h);
    for (let d = 0; d < DASHES; d++) {
      const i = (d + 1) * 2 - 1; // the dash runs from step i-1 to step i
      const x0 = p[i * 2 - 2], y0 = p[i * 2 - 1], x1 = p[i * 2], y1 = p[i * 2 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0), o = d * 12;
      // (The last dash's place is the arrowhead's.)
      if (len < 0.05 || d === DASHES - 1 || Math.hypot(x1 - car.x, y1 - car.y) < clear) {
        for (let k = 0; k < 12; k++) a[o + k] = 0;
        continue;
      }
      ux = (x1 - x0) / len; uy = (y1 - y0) / len;
      const z = height((x0 + x1) / 2, (y0 + y1) / 2) + LIFT;
      put(o, x0 - uy * half, y0 + ux * half, z);
      put(o + 3, x0 + uy * half, y0 - ux * half, z);
      put(o + 6, x1 - uy * half, y1 + ux * half, z);
      put(o + 9, x1 + uy * half, y1 - ux * half, z);
    }
    // The arrowhead, the way the car is moving when it gets there.
    {
      const x0 = p[STEPS * 2 - 4], y0 = p[STEPS * 2 - 3], x1 = p[STEPS * 2], y1 = p[STEPS * 2 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len > 0.05) { ux = (x1 - x0) / len; uy = (y1 - y0) / len; }
      const o = DASHES * 12, z = height(x1, y1) + LIFT, wide = half * 3, long = half * 4.5;
      const bx = x1 - ux * long, by = y1 - uy * long;
      put(o, bx - uy * wide, by + ux * wide, z);
      put(o + 3, bx + uy * wide, by - ux * wide, z);
      put(o + 6, x1, y1, z);
    }
    this.pathPos.needsUpdate = true;
  }
}
