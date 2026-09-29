import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './map/geo.ts';
import type { Clock } from './clock.ts';
import { lampLit } from './lamps.ts';

// The Petřín funicular: two cars on one cable, one going up while the other comes
// down, passing each other on the loop halfway, where both stop at Nebozízek. Where
// they are follows from the game's clock (trips every few minutes from 9:00 to 23:30),
// so they keep their places while the world runs faster. Press E beside a car waiting
// at a station to ride it; E again at a station to get off.
//
// Any other funicular OSM has in the area (a short private one) runs the same way,
// with one car and nobody riding it.

interface Rail { kind: string; pts: Point2[] }
interface Options {
  clock: Clock;
  // Ground height at a point, null where the map isn't loaded.
  terrain: (x: number, y: number) => number | null;
  // Local metres for a longitude and latitude, null outside the area.
  toLocal: (lon: number, lat: number) => Point2 | null;
}
interface RiderPosition { x: number; y: number; h: number; vx: number; vy: number }

const V = 4, ACC = 0.5; // m/s at full speed, and m/s² starting and stopping
const END_WAIT = 75, MID_WAIT = 20; // seconds at the ends, and at the halfway stop
const OPEN = 9 * 3600, CLOSE = 23.5 * 3600;
const LEN = 14, W = 2.5, BAYS = 4; // a car, in stepped compartments
const FAST = 6;

// The Petřín line's stations: the ends by where they are (the lower one first),
// Nebozízek by where the cars pass each other.
const PETRIN = { bottom: { name: 'Újezd', lon: 14.40354, lat: 50.08265 }, mid: 'Nebozízek', top: 'Petřín' };

class Path {
  pts: Point2[];
  cum: number[];
  length: number;

  constructor(pts: Point2[]) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    this.length = this.cum[this.cum.length - 1];
  }
  at(s: number) {
    s = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < s) i++;
    const a = this.pts[i - 1], b = this.pts[i];
    const t = (s - this.cum[i - 1]) / (this.cum[i] - this.cum[i - 1] || 1);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
}

// OSM splits the track into short ways, with the passing loop as two ways side by
// side. Join them into every route from one end of the track to the other: one for a
// plain track, two (one per car) with a loop.
function routes(lines: Point2[][]): Point2[][][] {
  const key = ([x, y]: Point2) => `${Math.round(x)},${Math.round(y)}`;
  const at = new Map<string, { i: number; pts: Point2[]; to: string }[]>();
  lines.forEach((pts, i) => {
    if (pts.length < 2) return;
    const a = key(pts[0]), b = key(pts[pts.length - 1]);
    if (a === b) return;
    if (!at.has(a)) at.set(a, []);
    if (!at.has(b)) at.set(b, []);
    at.get(a)!.push({ i, pts, to: b });
    at.get(b)!.push({ i, pts: pts.slice().reverse(), to: a });
  });
  const seen = new Set<string>(), out: Point2[][][] = [];
  for (const start of at.keys()) {
    if (seen.has(start)) continue;
    const part: string[] = [start];
    seen.add(start);
    for (let k = 0; k < part.length; k++) {
      for (const e of at.get(part[k])!) if (!seen.has(e.to)) { seen.add(e.to); part.push(e.to); }
    }
    const ends = part.filter((n) => at.get(n)!.length === 1);
    if (ends.length !== 2) continue;
    const found: Point2[][] = [];
    const walk = (n: string, used: Set<number>, pts: Point2[]) => {
      if (found.length === 2) return;
      if (n === ends[1]) { found.push(pts); return; }
      for (const e of at.get(n)!) {
        if (used.has(e.i)) continue;
        walk(e.to, new Set(used).add(e.i), pts.concat(e.pts.slice(1)));
      }
    };
    walk(ends[0], new Set(), [at.get(ends[0])![0].pts[0]]);
    if (found.length) out.push(found);
  }
  return out;
}

// Seconds to cover d metres from a standstill to a standstill, and how far along and
// how fast at τ seconds in.
function runTime(d: number) { return d > (V * V) / ACC ? d / V + V / ACC : 2 * Math.sqrt(d / ACC); }
function runAt(tau: number, d: number): [number, number] {
  const T = runTime(d), top = Math.min(V, (ACC * T) / 2), ta = top / ACC;
  if (tau <= 0) return [0, 0];
  if (tau >= T) return [d, 0];
  if (tau < ta) return [0.5 * ACC * tau * tau, ACC * tau];
  if (tau > T - ta) { const r = T - tau; return [d - 0.5 * ACC * r * r, ACC * r]; }
  return [0.5 * ACC * ta * ta + top * (tau - ta), top];
}

function carGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  // One compartment: red below, a band of windows, a cream roof.
  const bay = LEN / BAYS;
  box(bay, 0.9, W, 0, 0.75, 0, '#9b2a22');
  box(bay - 0.06, 1.1, W * 0.99, 0, 1.75, 0, '#23282c');
  box(bay, 0.35, W, 0, 2.47, 0, '#9b2a22');
  box(bay - 0.5, 0.14, W * 0.8, 0, 2.7, 0, '#d8d2c2');
  return mergeGeometries(parts);
}
const bayGeometry = carGeometry();
const material = new THREE.MeshLambertMaterial({ vertexColors: true });
// At night the windows (the dark band) are lit from inside.
material.onBeforeCompile = (sh) => {
  lampLit(sh);
  sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (uLampOn > .005 && dot(vColor.rgb, vec3(.3, .59, .11)) < .03 && vColor.b > vColor.r) totalEmissiveRadiance += vec3(1., .88, .7) * .5 * uLampOn;`);
};
material.customProgramCacheKey = () => 'funicular';
const frameMaterial = new THREE.MeshLambertMaterial({ color: '#34373a' });

export interface FunicularCar {
  line: Line;
  path: Path;
  flip: boolean; // runs the cable the other way: at the top while the first car is at the bottom
  mesh: THREE.Group;
  bays: THREE.Mesh[];
  frame: THREE.Mesh;
  x: number; y: number; h: number; vx: number; vy: number;
  s: number; // along its own path, from the bottom
  up: boolean;
  stop: number | null; // the station it stands at (index into line.stops)
}
interface Line { length: number; mid: number | null; stops: { at: number; name: string }[]; cars: FunicularCar[] }

export class Funicular {
  o: Options;
  lines: Line[] = [];
  cars: FunicularCar[] = [];
  me: FunicularCar | null = null;
  scale = 1;
  open = false;

  constructor(rails: Rail[], scene: THREE.Scene, o: Options) {
    this.o = o;
    const bottom = o.toLocal(PETRIN.bottom.lon, PETRIN.bottom.lat);
    for (let found of routes(rails.filter((r) => r.kind === 'funicular').map((r) => r.pts))) {
      // Every route starts at the bottom end.
      const [a, b] = [found[0][0], found[0][found[0].length - 1]];
      const named = !!bottom && Math.min(Math.hypot(a[0] - bottom[0], a[1] - bottom[1]), Math.hypot(b[0] - bottom[0], b[1] - bottom[1])) < 60;
      if (named && Math.hypot(b[0] - bottom![0], b[1] - bottom![1]) < Math.hypot(a[0] - bottom![0], a[1] - bottom![1])) {
        found = found.map((p) => p.slice().reverse());
      }
      const paths = found.map((p) => new Path(p));
      const length = paths.reduce((s, p) => s + p.length, 0) / paths.length;
      if (length < 40) continue;
      // Halfway stop: the middle of the loop, where the two routes part and meet again.
      let mid: number | null = null;
      if (paths.length === 2) {
        const [p, q] = found, same = (u: Point2, v: Point2) => Math.hypot(u[0] - v[0], u[1] - v[1]) < 0.5;
        let i = 0;
        while (i + 1 < p.length && i + 1 < q.length && same(p[i + 1], q[i + 1])) i++;
        let j = 0;
        while (j + 1 < p.length && j + 1 < q.length && same(p[p.length - 2 - j], q[q.length - 2 - j])) j++;
        const s0 = paths[0].cum[i], s1 = paths[0].cum[p.length - 1 - j];
        mid = ((s0 + s1) / 2 / paths[0].length) * length;
      }
      const line: Line = { length, mid, stops: [], cars: [] };
      if (named) {
        line.stops.push({ at: 0, name: PETRIN.bottom.name });
        if (mid !== null) line.stops.push({ at: mid, name: PETRIN.mid });
        line.stops.push({ at: length, name: PETRIN.top });
      }
      paths.forEach((path, k) => {
        const mesh = new THREE.Group(), bays: THREE.Mesh[] = [];
        for (let i = 0; i < BAYS; i++) {
          const m = new THREE.Mesh(bayGeometry, material);
          m.castShadow = true;
          m.position.x = (i + 0.5) * (LEN / BAYS) - LEN / 2;
          bays.push(m);
          mesh.add(m);
        }
        // The running gear under the steps, along the slope.
        const frame = new THREE.Mesh(new THREE.BoxGeometry(LEN - 0.4, 0.5, W * 0.7), frameMaterial);
        frame.castShadow = true;
        mesh.add(frame);
        mesh.visible = false;
        scene.add(mesh);
        const car: FunicularCar = { line, path, flip: k === 1, mesh, bays, frame, x: 0, y: 0, h: 0, vx: 0, vy: 0, s: 0, up: true, stop: null };
        line.cars.push(car);
        this.cars.push(car);
      });
      this.lines.push(line);
    }
  }

  // Where the cable is: how far the first car is from the bottom, how fast it's going
  // (up is positive), and whether the line is running.
  private cable(line: Line, sec: number) {
    const L = line.length, m = line.mid;
    const trip = m === null ? runTime(L) : runTime(m) + MID_WAIT + runTime(L - m);
    const half = END_WAIT + trip, cycles = Math.floor((CLOSE - OPEN) / (2 * half));
    if (sec < OPEN || sec >= OPEN + cycles * 2 * half) return { d: 0, v: 0, open: false };
    const p = (sec - OPEN) % (2 * half), up = p < half, tau = (p % half) - END_WAIT;
    let d: number, v: number;
    if (m === null) [d, v] = runAt(tau, L);
    else if (tau < runTime(m)) [d, v] = runAt(tau, m);
    else if (tau < runTime(m) + MID_WAIT) [d, v] = [m, 0];
    else { const [e, w] = runAt(tau - runTime(m) - MID_WAIT, L - m); [d, v] = [m + e, w]; }
    return up ? { d, v, open: true } : { d: L - d, v: -v, open: true };
  }

  update() {
    const sec = this.o.clock.t % 86400;
    this.open = false;
    for (const line of this.lines) {
      const { d, v, open } = this.cable(line, sec);
      if (line.stops.length) this.open ||= open;
      for (const car of line.cars) {
        const along = car.flip ? line.length - d : d, speed = car.flip ? -v : v;
        car.s = (along / line.length) * car.path.length;
        // Standing at an end, it goes the other way next.
        if (v !== 0) car.up = speed > 0;
        else if (along < 0.5) car.up = true;
        else if (along > line.length - 0.5) car.up = false;
        const stop = line.stops.findIndex((st) => Math.abs(st.at - along) < 0.5);
        car.stop = v === 0 && stop >= 0 ? stop : null;
        const p = car.path.at(car.s);
        car.x = p.x; car.y = p.y; car.h = p.ang;
        car.vx = Math.cos(p.ang) * speed; car.vy = Math.sin(p.ang) * speed;
        // Level compartments stepped up the slope, the ends' heights from the ground.
        const back = car.path.at(car.s - LEN / 2), front = car.path.at(car.s + LEN / 2);
        const hb = this.o.terrain(back.x, back.y), hf = this.o.terrain(front.x, front.y);
        car.mesh.visible = hb !== null && hf !== null;
        if (hb === null || hf === null) continue;
        const run = Math.hypot(front.x - back.x, front.y - back.y) || LEN, slope = (hf - hb) / run;
        car.mesh.position.set(p.x, (hb + hf) / 2, -p.y);
        car.mesh.rotation.y = p.ang;
        for (const b of car.bays) b.position.y = slope * b.position.x;
        car.frame.position.y = 0.25;
        car.frame.rotation.z = Math.atan(slope);
      }
    }
  }

  // A car waiting at a station right next to (x, y), if there is one to ride.
  // (With any, also one standing there for the night.)
  near(x: number, y: number, any = false) {
    if (this.me || (!this.open && !any)) return null;
    for (const c of this.cars) {
      if (c.stop === null || !c.mesh.visible) continue;
      const dx = x - c.x, dy = y - c.y, cs = Math.cos(c.h), sn = Math.sin(c.h);
      if (Math.abs(dx * cs + dy * sn) < LEN / 2 + 1 && Math.abs(dx * sn - dy * cs) < W / 2 + 2.5) return c;
    }
    return null;
  }

  // Where a car is heading: the next station, and the end it's going to.
  heading(c: FunicularCar) {
    const stops = c.line.stops, along = (c.s / c.path.length) * c.line.length;
    const ahead = stops.filter((st) => (c.up ? st.at > along + 0.5 : st.at < along - 0.5));
    return { next: (c.up ? ahead[0] : ahead[ahead.length - 1])?.name ?? null, end: (c.up ? stops[stops.length - 1] : stops[0]).name, up: c.up };
  }

  board(c: FunicularCar) {
    this.me = c;
    this.scale = 1;
  }

  leave() {
    this.me = null;
    this.scale = 1;
  }

  seat(walker: RiderPosition) {
    const c = this.me!;
    Object.assign(walker, { x: c.x, y: c.y, h: c.h, vx: c.vx * this.scale, vy: c.vy * this.scale });
  }

  // Hold Shift to speed the ride up.
  speedUp(dt: number, hold: boolean) {
    const target = hold ? FAST : 1;
    this.scale += (target - this.scale) * Math.min(1, dt * (target > this.scale ? 1.5 : 4));
    if (Math.abs(this.scale - target) < 0.02) this.scale = target;
    return this.scale;
  }
}
