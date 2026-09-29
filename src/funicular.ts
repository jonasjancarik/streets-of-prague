import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './map/geo.ts';
import type { Clock } from './clock.ts';
import { lampLit } from './lamps.ts';
import { t } from './i18n.ts';

// Prague's funiculars. On Petřín two cars share one cable, one going up while the
// other comes down; they pass each other on the loop halfway, where both stop at
// Nebozízek. The NH hotel's little one on Mrázovka has a single cabin, free for anyone
// to ride in its opening hours. Where the cars are follows from the game's clock, so
// they keep their places while the world runs faster. Press E beside a car waiting at
// a station to ride it; E again at a station to get off. Nobody walks or drives
// through one.

interface Rail { kind: string; pts: Point2[] }
interface Options {
  clock: Clock;
  // Ground height at a point, null where the map isn't loaded.
  terrain: (x: number, y: number) => number | null;
  // Local metres for a longitude and latitude, null outside the area.
  toLocal: (lon: number, lat: number) => Point2 | null;
}
interface RiderPosition { x: number; y: number; h: number; vx: number; vy: number }

// Each line (from OSM: its name, stations, opening hours, and which end is the lower
// one), with its cars and how they run.
interface Spec {
  name: string;
  bottom: [number, number]; // lon, lat of the lower end
  stops: string[]; // bottom to top ('' for stations without a name)
  hours: [number, number][];
  speed: number; acc: number; endWait: number; midWait: number;
  len: number; w: number; bays: number;
  ticket: boolean; // needs a PID ticket (the hotel's own funicular doesn't)
}
const SPECS: Spec[] = [
  { name: 'Lanová dráha na Petřín', bottom: [14.40354, 50.08265], stops: ['Újezd', 'Nebozízek', 'Petřín'], hours: [[7, 22]],
    speed: 4, acc: 0.5, endWait: 75, midWait: 20, len: 14, w: 2.5, bays: 4, ticket: true },
  { name: 'Lanová dráha hotelu NH', bottom: [14.39685, 50.07107], stops: ['', ''], hours: [[10.5, 11.5], [15, 18], [22, 24]],
    speed: 1.5, acc: 0.3, endWait: 30, midWait: 0, len: 3, w: 1.6, bays: 1, ticket: false },
];
const BAY = 3.5, BAY_W = 2.5; // the size the compartment's geometry is made at
const FAST = 6;

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
function runTime(d: number, v: number, a: number) { return d > (v * v) / a ? d / v + v / a : 2 * Math.sqrt(d / a); }
function runAt(tau: number, d: number, v: number, a: number): [number, number] {
  const T = runTime(d, v, a), top = Math.min(v, (a * T) / 2), ta = top / a;
  if (tau <= 0) return [0, 0];
  if (tau >= T) return [d, 0];
  if (tau < ta) return [0.5 * a * tau * tau, a * tau];
  if (tau > T - ta) { const r = T - tau; return [d - 0.5 * a * r * r, a * r]; }
  return [0.5 * a * ta * ta + top * (tau - ta), top];
}

const clockTime = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

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
  box(BAY, 0.9, BAY_W, 0, 0.75, 0, '#9b2a22');
  box(BAY - 0.06, 1.1, BAY_W * 0.99, 0, 1.75, 0, '#23282c');
  box(BAY, 0.35, BAY_W, 0, 2.47, 0, '#9b2a22');
  box(BAY - 0.5, 0.14, BAY_W * 0.8, 0, 2.7, 0, '#d8d2c2');
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
  gz: number; slope: number; // ground height under its middle, and the rise a metre along
  s: number; // along its own path, from the bottom
  up: boolean;
  stop: number | null; // the station it stands at (index into line.stops)
  circles: Point2[]; // for knocking into cars
}
interface Line { spec: Spec; length: number; mid: number | null; stops: { at: number; name: string }[]; cars: FunicularCar[]; open: boolean }

export class Funicular {
  o: Options;
  lines: Line[] = [];
  cars: FunicularCar[] = [];
  me: FunicularCar | null = null;
  scale = 1;

  constructor(rails: Rail[], scene: THREE.Scene, o: Options) {
    this.o = o;
    for (let found of routes(rails.filter((r) => r.kind === 'funicular').map((r) => r.pts))) {
      // Which line this is, by its lower end, and every route starting there.
      const [a, b] = [found[0][0], found[0][found[0].length - 1]];
      let spec: Spec | null = null, flip = false;
      for (const s of SPECS) {
        const p = o.toLocal(s.bottom[0], s.bottom[1]);
        if (!p) continue;
        const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
        if (Math.min(da, db) < 60) { spec = s; flip = db < da; break; }
      }
      if (!spec) continue;
      if (flip) found = found.map((p) => p.slice().reverse());
      const paths = found.map((p) => new Path(p));
      const length = paths.reduce((s, p) => s + p.length, 0) / paths.length;
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
      const names = spec.stops;
      const stops = [{ at: 0, name: names[0] }, ...(mid !== null && names.length > 2 ? [{ at: mid, name: names[1] }] : []), { at: length, name: names[names.length - 1] }];
      const line: Line = { spec, length, mid: stops.length > 2 ? mid : null, stops, cars: [], open: false };
      paths.forEach((path, k) => {
        const mesh = new THREE.Group(), bays: THREE.Mesh[] = [], bay = spec.len / spec.bays;
        for (let i = 0; i < spec.bays; i++) {
          const m = new THREE.Mesh(bayGeometry, material);
          m.castShadow = true;
          m.scale.set(bay / BAY, 1, spec.w / BAY_W);
          m.position.x = (i + 0.5) * bay - spec.len / 2;
          bays.push(m);
          mesh.add(m);
        }
        // The running gear under the steps, along the slope.
        const frame = new THREE.Mesh(new THREE.BoxGeometry(spec.len - 0.4, 0.5, spec.w * 0.7), frameMaterial);
        frame.castShadow = true;
        mesh.add(frame);
        mesh.visible = false;
        scene.add(mesh);
        const car: FunicularCar = {
          line, path, flip: k === 1, mesh, bays, frame, x: 0, y: 0, h: 0, vx: 0, vy: 0, gz: 0, slope: 0, s: 0, up: true, stop: null, circles: [],
        };
        line.cars.push(car);
        this.cars.push(car);
      });
      this.lines.push(line);
    }
  }

  // Where the cable is: how far the first car is from the bottom, how fast it's going
  // (up is positive), and whether the line is running. Trips go back and forth from
  // each opening time, and the last one is back at the bottom by closing time.
  private cable(line: Line, sec: number) {
    const { spec, length: L, mid: m } = line, v = spec.speed, a = spec.acc;
    const first = m === null ? 0 : runTime(m, v, a);
    const trip = m === null ? runTime(L, v, a) : first + spec.midWait + runTime(L - m, v, a);
    const half = spec.endWait + trip;
    for (const [from, to] of spec.hours) {
      const p = sec - from * 3600;
      if (p < 0 || p >= Math.floor(((to - from) * 3600) / (2 * half)) * 2 * half) continue;
      const up = p % (2 * half) < half, tau = (p % half) - spec.endWait;
      let d: number, s: number;
      if (m === null) [d, s] = runAt(tau, L, v, a);
      else if (tau < first) [d, s] = runAt(tau, m, v, a);
      else if (tau < first + spec.midWait) [d, s] = [m, 0];
      else { const [e, w] = runAt(tau - first - spec.midWait, L - m, v, a); [d, s] = [m + e, w]; }
      return up ? { d, v: s, open: true } : { d: L - d, v: -s, open: true };
    }
    return { d: 0, v: 0, open: false };
  }

  update() {
    const sec = this.o.clock.t % 86400;
    for (const line of this.lines) {
      const { d, v, open } = this.cable(line, sec), { len, w } = line.spec;
      line.open = open;
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
        const c = Math.cos(p.ang), sn = Math.sin(p.ang);
        car.vx = c * speed; car.vy = sn * speed;
        car.circles.length = 0;
        const end = len / 2 - w / 2, n = Math.max(1, Math.ceil((2 * end) / (w / 2)));
        for (let i = 0; i <= n; i++) { const k = -end + (2 * end * i) / n; car.circles.push([p.x + c * k, p.y + sn * k]); }
        // Level compartments stepped up the slope, the ends' heights from the ground.
        const back = car.path.at(car.s - len / 2), front = car.path.at(car.s + len / 2);
        const hb = this.o.terrain(back.x, back.y), hf = this.o.terrain(front.x, front.y);
        car.mesh.visible = hb !== null && hf !== null;
        if (hb === null || hf === null) continue;
        car.slope = (hf - hb) / (Math.hypot(front.x - back.x, front.y - back.y) || len);
        car.gz = (hb + hf) / 2;
        car.mesh.position.set(p.x, car.gz, -p.y);
        car.mesh.rotation.y = p.ang;
        for (const b of car.bays) b.position.y = car.slope * b.position.x;
        car.frame.position.y = 0.25;
        car.frame.rotation.z = Math.atan(car.slope);
      }
    }
  }

  // The cars within r of (x, y) that can be bumped into.
  bodies(x: number, y: number, r: number) {
    return this.cars.filter((c) => c.mesh.visible && c !== this.me && Math.hypot(c.x - x, c.y - y) < r);
  }

  // Someone on foot (radius rad) out of a car to its nearer side, where free there.
  // Returns the car they touched and the way they were pushed (away from it), else null.
  pushOut(who: { x: number; y: number; gz?: number }, rad: number, free: (x: number, y: number) => boolean) {
    for (const c of this.cars) {
      if (!c.mesh.visible || c === this.me) continue;
      const { len, w } = c.line.spec, dx = who.x - c.x, dy = who.y - c.y;
      if (Math.abs(dx) > len && Math.abs(dy) > len) continue;
      const cs = Math.cos(c.h), sn = Math.sin(c.h), along = Math.max(-len / 2 + w / 2, Math.min(len / 2 - w / 2, dx * cs + dy * sn));
      if (who.gz !== undefined && Math.abs(c.gz + c.slope * along - who.gz) > 3) continue;
      const qx = c.x + cs * along, qy = c.y + sn * along, min = w / 2 + rad;
      let nx = who.x - qx, ny = who.y - qy;
      const d = Math.hypot(nx, ny);
      if (d >= min) continue;
      if (d < 1e-6) { const side = -dx * sn + dy * cs < 0 ? -1 : 1; nx = -sn * side; ny = cs * side; } else { nx /= d; ny /= d; }
      const x = qx + nx * min, y = qy + ny * min;
      if (free(x, y)) { who.x = x; who.y = y; }
      return { c, nx, ny };
    }
    return null;
  }

  // A car waiting at a station right next to (x, y), if there is one to ride.
  // (With any, also one standing there while the line is shut.)
  near(x: number, y: number, any = false) {
    if (this.me) return null;
    for (const c of this.cars) {
      if (c.stop === null || !c.mesh.visible || (!c.line.open && !any)) continue;
      const { len, w } = c.line.spec, dx = x - c.x, dy = y - c.y, cs = Math.cos(c.h), sn = Math.sin(c.h);
      if (Math.abs(dx * cs + dy * sn) < len / 2 + 1 && Math.abs(dx * sn - dy * cs) < w / 2 + 2.5) return c;
    }
    return null;
  }

  // Where a car is heading: the next station, and the end it's going to.
  heading(c: FunicularCar) {
    const stops = c.line.stops, along = (c.s / c.path.length) * c.line.length;
    const ahead = stops.filter((st) => (c.up ? st.at > along + 0.5 : st.at < along - 0.5));
    return { next: (c.up ? ahead[0] : ahead[ahead.length - 1]) ?? null, end: c.up ? stops[stops.length - 1] : stops[0], up: c.up };
  }

  // What the hint says standing by a car at a station.
  offer(c: FunicularCar) {
    if (!c.line.open) return t('The funicular runs {hours}', { hours: c.line.spec.hours.map(([a, b]) => `${clockTime(a)}–${clockTime(b)}`).join(', ') });
    const { up, end } = this.heading(c);
    if (!end.name) return t(up ? '<b>E</b> ride the funicular up' : '<b>E</b> ride the funicular down');
    return t(up ? '<b>E</b> ride the funicular up to {name}' : '<b>E</b> ride the funicular down to {name}', { name: end.name });
  }

  // And riding one (without the keys on a touch screen).
  hint(touch: boolean, scale: number) {
    const c = this.me!, parts = [];
    if (scale > 1.5) parts.push(t('{n}× speed', { n: Math.round(scale) }));
    if (c.stop !== null) {
      const { name } = c.line.stops[c.stop];
      parts.push(name ? t('At {name}', { name }) : t(c.stop === 0 ? 'At the bottom' : 'At the top'));
    } else {
      const { next, up } = this.heading(c);
      parts.push(next?.name ? t('Funicular to {name}', { name: next.name }) : t(up ? 'Going up' : 'Going down'));
    }
    if (!touch) parts.push(t(c.stop !== null ? '<b>E</b> get off' : 'hold <b>Shift</b> to speed up'));
    return parts.join(' · ');
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
