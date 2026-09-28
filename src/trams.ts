import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './map/geo.ts';
import type { Car } from './car.ts';
import type { Clock } from './clock.ts';

export interface RawTramLine {
  ref: string; colour: string | null; night: boolean; from: string; to: string;
  pts: Point2[]; stops: [number, string][]; ends: [number, number];
  turns: { at: number; to: number; where: string }[]; speed: [number, number][];
  perHour?: Record<'weekday' | 'saturday' | 'sunday', number[]>;
}
export interface TramHalt { s: number; dwell: number; name: string; to?: number }
export interface TramPoint { x: number; y: number; ang: number }
export interface TramLine extends RawTramLine {
  path: Loop; halts: TramHalt[]; haltS: number[]; limitS: number[]; limitV: number[];
  trams: TramVehicle[];
}
interface TramLook {
  sections: THREE.Mesh[];
  sign: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}
interface TramCell { v: TramVehicle; x: number; y: number; c: number; s: number }
export interface TramVehicle {
  id: number; line: TramLine; s: number; speed: number; dwell: number; halt: number;
  stuck: number; ghost: number; waitFor: TramVehicle | null; blocker: Car | null;
  spotted: number; forPlayer: boolean;
  held: number; shove: Car | null; look: TramLook | null; pending: number;
  parts: TramPoint[]; cells?: TramCell[]; levels?: { x: number; y: number; gz?: number }[];
  rider?: boolean;
}
interface TrackObstacle { kind: string; x: number; y: number; r: number; car?: Car }
export interface TramBody { v: TramVehicle; x: number; y: number; vx: number; vy: number; circles: Point2[] }
type Nearby = (x: number, y: number, radius: number) => Iterable<TrackObstacle>;

// Prague's trams on their real lines (data/<area>_now/lines.json, from
// pipeline/build_lines.py). Each line is one closed loop, there and back, and its
// trams run round it: they stop at every stop, keep to the track's speed limit, slow
// for curves, and brake for the tram in front and for anything on the track.
// How many trams a line has out follows its timetable for the game clock's day and
// hour (`perHour` in lines.json): trams join where the gaps are widest and leave
// service out of sight. They're three-section articulated cars in red and white
// (15T-like), with the line number on the roof; every section follows the track on its
// own, so a tram bends round corners.

const SECTION = 10.2, GAP = 0.25, W = 2.5, H = 3.4;
const STEP = SECTION + GAP;
const HALF = STEP + SECTION / 2; // from the middle of a tram to its front
const BOGIE = SECTION / 2 - 1.6; // from the middle of a section to each of its bogies
// How far behind a tram's front each of its bogies runs (they click over the rail joints).
export const BOGIES = [STEP, 0, -STEP].flatMap((o) => [HALF - o - BOGIE, HALF - o + BOGIE]);
const ACCEL = 1.1, BRAKE = 1.2, HARD = 4.5; // m/s²: pulling away, braking, stopping short
// For the player the driver needs a moment to react, then brakes as hard as a real
// tram can: 14 m/s (50 km/h) takes some 45 m to stop, so step out in front of one too
// late and it hits you. Everyone else it sees coming, and stops for in time.
const REACT = 0.8, EMERGENCY = 2.8; // s, m/s²
const DWELL = 18, TURN = 40; // seconds at a stop, and at a terminus where the tram reverses
const PUSH = 60, CREEP = 1.5; // s a car can hold a tram up before the tram pushes it off the track, at this many m/s
// Without timetables: trips per hour, day lines from 5 in the morning to midnight,
// night lines (91-99) through the night.
const FALLBACK = { day: 7.5, night: 3 };
export const MEAN_SPEED = 5.5; // m/s along a line, stops included: spaces the trams out
const MANAGE = 2; // seconds between checks of how many trams each line should have out
const CELL = 20;
const NONE: TramCell[] = [];
const FAR = 800, FAR_STEP = 0.25; // trams further than this from the player move in steps of this many seconds

function sectionGeometry(kind: string) {
  const parts: THREE.BufferGeometry[] = [];
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  box(SECTION, 1.0, W, 0, 0.85, 0, '#c4161c');
  box(SECTION, 1.2, W * 0.99, 0, 1.95, 0, '#262b30');
  box(SECTION, 0.55, W, 0, 2.82, 0, '#ecebe6');
  box(SECTION - 0.4, 0.16, W * 0.9, 0, 3.17, 0, '#d4d4cf');
  box(SECTION * 0.45, 0.35, W * 0.55, 0, 3.4, 0, '#9fa2a3');
  // Cab ends: red nose with a dark windscreen, at the outer end of the first and last section.
  if (kind !== 'mid') {
    const x = (SECTION / 2) * (kind === 'front' ? 1 : -1);
    box(0.5, 1.6, W * 0.96, x * 0.96, 2.1, 0, '#1b1f23');
    box(0.7, 0.5, W, x * 0.96, 2.95, 0, '#c4161c');
  } else {
    box(1.4, 0.9, 0.08, -1, 3.6, 0, '#2d2f31'); // pantograph
    box(0.1, 0.1, 1.6, -1, 4.05, 0, '#2d2f31');
  }
  return mergeGeometries(parts);
}

const material = new THREE.MeshLambertMaterial({ vertexColors: true });
const geoms: Record<string, THREE.BufferGeometry> = {};
const sectionMesh = (kind: string) => {
  geoms[kind] ||= sectionGeometry(kind);
  const m = new THREE.Mesh(geoms[kind], material);
  m.castShadow = true;
  return m;
};

// The line number on the roof, white on the line's colour.
const signGeometry = new THREE.PlaneGeometry(3.2, 1.6).rotateX(-Math.PI / 2);
const signs = new Map<string, THREE.MeshBasicMaterial>();
function signMaterial(ref: string, colour: string | null) {
  if (!signs.has(ref)) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const g = c.getContext('2d');
    if (!g) throw new Error('Cannot create tram sign canvas');
    g.fillStyle = colour || '#c4161c';
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#fff';
    g.font = 'bold 50px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ref, 64, 35);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    signs.set(ref, new THREE.MeshBasicMaterial({ map: tex }));
  }
  return signs.get(ref)!;
}

// A line's closed loop: position and heading at any distance along it.
class Loop {
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
  wrap(s: number) { return ((s % this.length) + this.length) % this.length; }
  ahead(from: number, to: number) { return this.wrap(to - from); } // how far `to` is ahead of `from`
  at(s: number): TramPoint {
    s = this.wrap(s);
    let lo = 1, hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    const a = this.pts[lo - 1], b = this.pts[lo];
    const t = (s - this.cum[lo - 1]) / (this.cum[lo] - this.cum[lo - 1] || 1);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
}

// The last index in a sorted array at or before s (or the last one, round the loop).
function before(arr: number[], s: number) {
  let lo = 0, hi = arr.length - 1;
  if (s < arr[0]) return arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Where a line's trams are heading at a point along its loop: its far terminus on the
// way there, its first one on the way back.
export const headsignAt = (line: TramLine, s: number) => (s < line.ends[0] || s >= line.ends[1] ? line.to : line.from);
export const frontOf = (v: TramVehicle) => v.line.path.wrap(v.s + HALF);

function prepare(line: RawTramLine): TramLine {
  const path = new Loop(line.pts);
  // Where a tram halts: the stops, and termini with no loop on the map, where it
  // reverses or moves across to the other track (`to`). A stop just before such a
  // terminus is the terminus itself.
  const turns = line.turns.map((t) => ({ s: t.at, dwell: TURN, to: t.to, name: t.where }));
  const halts: TramHalt[] = [];
  for (const [s, name] of line.stops) {
    if (turns.some((t) => path.ahead(s, t.s) < 40)) continue;
    if (halts.length && s - halts[halts.length - 1].s < 20) continue;
    halts.push({ s, dwell: DWELL, name });
  }
  halts.push(...turns);
  halts.sort((a, b) => a.s - b.s);
  return {
    ...line, path, halts, haltS: halts.map((h) => h.s), trams: [],
    limitS: line.speed.map((x) => x[0]), limitV: line.speed.map((x) => x[1] / 3.6),
  };
}

export class Trams {
  scene: THREE.Scene;
  rng: () => number;
  clock: Clock;
  pool: TramLook[];
  grid: Map<number, TramCell[]>;
  gridSweep: number;
  list: TramVehicle[];
  id: number;
  manageT: number;
  lines: TramLine[];

  constructor(lines: RawTramLine[], scene: THREE.Scene, { clock, rng = Math.random }: { clock: Clock; rng?: () => number }) {
    this.scene = scene;
    this.rng = rng;
    this.clock = clock;
    this.pool = [];
    this.grid = new Map();
    this.gridSweep = 0;
    this.list = [];
    this.id = 0;
    this.manageT = 0;
    this.lines = lines.map(prepare);
    for (const line of this.lines) {
      line.trams = [];
      const L = line.path.length, n = this.target(line), offset = rng() * (L / Math.max(1, n));
      for (let k = 0; k < n; k++) this.add(line, offset + (k * L) / n);
    }
  }

  // Trips per hour in each direction for a line now, and so how many trams it needs out.
  perHour(line: TramLine) {
    const { clock } = this;
    if (line.perHour) return line.perHour[clock.kind][clock.hour];
    const h = clock.hour, night = h < 5;
    return line.night === night ? FALLBACK[night ? 'night' : 'day'] : 0;
  }
  target(line: TramLine) {
    const n = this.perHour(line);
    return n > 0 ? Math.max(1, Math.round((line.path.length * n) / (MEAN_SPEED * 3600))) : 0;
  }

  add(line: TramLine, s: number) {
    const v: TramVehicle = { id: this.id++, line, s, speed: 0, dwell: 0, halt: 0, stuck: 0, ghost: 0, waitFor: null, blocker: null, spotted: 0, forPlayer: false, held: 0, shove: null, look: null, pending: this.rng() * FAR_STEP, parts: [] };
    // Not on the short cut across a terminus with no loop.
    for (const h of line.halts) {
      if (h.to !== undefined && h.to !== h.s && line.path.ahead(h.s - HALF, v.s) < line.path.ahead(h.s, h.to) + 2 * HALF) v.s = h.to + HALF;
    }
    v.s = line.path.wrap(v.s);
    this.nextHalt(v);
    this.place(v);
    this.list.push(v);
    line.trams.push(v);
    return v;
  }

  remove(v: TramVehicle) {
    if (v.look) { this.give(v.look); v.look = null; }
    this.list.splice(this.list.indexOf(v), 1);
    v.line.trams.splice(v.line.trams.indexOf(v), 1);
  }

  // Bring each line's number of trams towards its timetable, one tram per line at a
  // time: a new one in the middle of the widest gap, and the one whose leaving opens
  // the smallest gap taken out, both only where nobody's looking.
  manage(seen: (x: number, y: number) => boolean) {
    for (const line of this.lines) {
      const want = this.target(line), have = line.trams.length, L = line.path.length;
      if (want === have) continue;
      const order = [...line.trams].sort((a, b) => a.s - b.s);
      const gaps = order.map((v, i) => line.path.ahead(v.s, order[(i + 1) % order.length].s) || L);
      if (want > have) {
        let s = this.rng() * L;
        if (order.length) {
          const i = gaps.indexOf(Math.max(...gaps));
          s = order[i].s + gaps[i] / 2;
        }
        const p = line.path.at(s);
        if (!seen(p.x, p.y)) this.add(line, s);
      } else {
        let best: TramVehicle | null = null, bestGap = Infinity;
        order.forEach((v, i) => {
          const p = v.parts[1], g = gaps[i] + gaps[(i - 1 + order.length) % order.length];
          if (!v.rider && !v.look && !seen(p.x, p.y) && g < bestGap) { best = v; bestGap = g; }
        });
        if (best) this.remove(best);
      }
    }
  }

  nextHalt(v: TramVehicle) {
    const { line } = v;
    v.halt = (before(line.haltS, line.path.wrap(v.s + HALF)) + 1) % line.halts.length;
  }

  // The three sections' centres and headings along the track. Each section rides on two
  // bogies and lies along the line between them, so it swings round a curve smoothly
  // instead of snapping from one piece of the track to the next.
  place(v: TramVehicle) {
    const path = v.line.path;
    v.parts = [-STEP, 0, STEP].map((o) => {
      const a = path.at(v.s + o - BOGIE), b = path.at(v.s + o + BOGIE);
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ang: Math.atan2(b.y - a.y, b.x - a.x) };
    });
  }

  // Move every tram on. `near(x, y, r)` finds what else is about (cars, people, the
  // player) within `r` of (x, y) of the player, and `seen(x, y)` whether a spot is
  // on screen.
  update(dt: number, { near = null, x = 0, y = 0, r = 0, seen = () => false }: {
    near?: Nearby | null; x?: number; y?: number; r?: number; seen?: (x: number, y: number) => boolean;
  } = {}) {
    this.manageT -= dt;
    if (this.manageT < 0) {
      this.manageT = MANAGE;
      this.manage(seen);
    }
    // Where every tram's sections are, so the trams behind can see them (the buckets
    // and entries are kept from step to step, keyed by number as in SpatialHash).
    for (const b of this.grid.values()) b.length = 0;
    for (const v of this.list) {
      v.cells ||= [{ v, x: 0, y: 0, c: 0, s: 0 }, { v, x: 0, y: 0, c: 0, s: 0 }, { v, x: 0, y: 0, c: 0, s: 0 }];
      const cells = v.cells;
      v.parts.forEach((p, n) => {
        const k = Math.floor(p.x / CELL) * 131072 + Math.floor(p.y / CELL);
        let b = this.grid.get(k);
        if (!b) this.grid.set(k, (b = []));
        const o = cells[n];
        o.x = p.x; o.y = p.y; o.c = Math.cos(p.ang); o.s = Math.sin(p.ang);
        b.push(o);
      });
    }
    // Buckets left empty for a while go, so the map doesn't grow with the city.
    if (++this.gridSweep > 600) {
      this.gridSweep = 0;
      for (const [k, b] of this.grid) if (!b.length) this.grid.delete(k);
    }
    for (const v of this.list) {
      const mid = v.parts[1], d = Math.hypot(mid.x - x, mid.y - y);
      // Far from the player a tram moves in bigger steps: nobody sees it, and it keeps
      // fast-forwarding cheap.
      let step = dt;
      if (d > FAR) {
        v.pending += dt;
        if (v.pending < FAR_STEP) continue;
        step = v.pending;
      }
      v.pending = 0;
      this.step(v, step, near && d < r ? near : null, seen);
      this.place(v);
    }
  }

  step(v: TramVehicle, dt: number, near: Nearby | null, seen: (x: number, y: number) => boolean) {
    const { line } = v, path = line.path;
    const h = line.halts[v.halt];
    if (v.dwell > 0) {
      v.speed = 0;
      v.dwell -= dt;
      // Moving across to the other track: only where nobody's looking, or after a
      // while (or at once with the player on board: you don't see it from inside).
      if (v.dwell <= 0 && h.to !== undefined && h.to !== h.s && v.dwell > -60 && !v.rider) {
        const a = v.parts[1], b = path.at(h.to);
        if (seen(a.x, a.y) || seen(b.x, b.y)) return;
      }
      if (v.dwell <= 0) {
        v.dwell = 0;
        if (h.to !== undefined) {
          v.s = path.wrap(h.to + HALF); // off again from the other end
          this.nextHalt(v);
        } else v.halt = (v.halt + 1) % line.halts.length;
      }
      return;
    }

    const front = path.wrap(v.s + HALF);
    let toHalt = path.ahead(front, h.s);
    if (toHalt > path.length - 30) { // just passed it (spawned there): on to the next
      this.nextHalt(v);
      return;
    }
    if (toHalt < 0.6 && v.speed < 0.5) {
      v.dwell = h.dwell * (0.7 + 0.6 * this.rng());
      v.speed = 0;
      return;
    }

    // Keep to the limit here, slow in time for lower limits and the next stop.
    const look = (v.speed * v.speed) / (2 * BRAKE) + 12;
    let i = before(line.limitS, front);
    let target = line.limitV[i];
    for (let k = 1; k < line.limitS.length; k++) {
      const j = (i + k) % line.limitS.length, d = path.ahead(front, line.limitS[j]);
      if (d > look) break;
      target = Math.min(target, Math.sqrt(line.limitV[j] ** 2 + 2 * BRAKE * d));
    }
    target = Math.min(target, toHalt < 0.6 ? 0 : Math.max(0.8, Math.sqrt(2 * BRAKE * (toHalt - 0.5))));

    // Anything on the track ahead: another tram, a car, a person. A car left on the
    // track that has held the tram up for a minute gets slowly pushed off it (not one
    // waiting in traffic).
    const was = v.blocker;
    const gap = this.clearAhead(v, dt, front, look, near, seen);
    if (gap < Infinity) target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, gap - 4)));
    v.held = v.blocker && v.blocker === was && v.speed < 0.1 ? v.held + dt : 0;
    if (v.held > PUSH && v.blocker && v.blocker.mode !== 'traffic') { v.shove = v.blocker; v.held = 0; }
    if (v.shove) target = Math.min(target, CREEP);

    v.speed = v.speed < target ? Math.min(target, v.speed + ACCEL * dt) : Math.max(target, v.speed - (v.forPlayer ? EMERGENCY : HARD) * dt);
    v.s = path.wrap(v.s + Math.min(v.speed * dt, toHalt)); // never past the stop
  }

  // How far along the track ahead the way is clear (Infinity if it is, as far as `look`).
  clearAhead(v: TramVehicle, dt: number, front: number, look: number, near: Nearby | null, seen: (x: number, y: number) => boolean) {
    const path = v.line.path;
    v.waitFor = null;
    v.blocker = null;
    v.forPlayer = false;
    let sawPlayer = false;
    const shove = v.shove;
    v.shove = null; // until it's on the track ahead again
    if (v.ghost > 0) v.ghost -= dt;
    for (let d = 1; d <= look; d += 3.5) {
      const p = path.at(front + d);
      if (v.ghost <= 0) {
        for (let i = Math.floor((p.x - 8) / CELL); i <= Math.floor((p.x + 8) / CELL); i++) {
          for (let j = Math.floor((p.y - 8) / CELL); j <= Math.floor((p.y + 8) / CELL); j++) {
            for (const o of this.grid.get(i * 131072 + j) || NONE) {
              if (o.v === v) continue;
              const dx = p.x - o.x, dy = p.y - o.y;
              const along = dx * o.c + dy * o.s, clamped = Math.max(-SECTION / 2, Math.min(SECTION / 2, along));
              if (Math.hypot(along - clamped, dx * o.s - dy * o.c) > 1.5) continue;
              // Two trams waiting for each other (at a junction): the older one goes.
              if (o.v.waitFor === v && v.id > o.v.id) continue;
              v.waitFor = o.v;
              // Stuck behind a tram for long: drive through it only when the two meet
              // head-on (on a stub with one track), or when nobody can see it happen.
              // A tram queueing behind another waits its turn.
              v.stuck = v.speed < 0.1 ? v.stuck + dt : 0;
              const headOn = o.c * Math.cos(p.ang) + o.s * Math.sin(p.ang) < -0.5;
              if ((headOn && v.stuck > 25) || (v.stuck > 90 && !seen(p.x, p.y) && !seen(v.parts[1].x, v.parts[1].y))) { v.ghost = 6; v.stuck = 0; }
              return d;
            }
          }
        }
      }
      if (near) {
        for (const o of near(p.x, p.y, 3)) {
          if (o.kind === 'tram') continue;
          if (Math.hypot(o.x - p.x, o.y - p.y) >= 1.3 + o.r) continue;
          if (o.car && o.car === shove) { v.shove = shove; continue; } // being pushed aside
          // The player: only once the driver has had a moment to react.
          if (o.kind === 'player') {
            sawPlayer = true;
            if (v.spotted < REACT) continue;
            v.forPlayer = true;
          }
          v.blocker = o.car || null;
          v.spotted = sawPlayer ? v.spotted + dt : 0;
          return d;
        }
      }
    }
    v.spotted = sawPlayer ? v.spotted + dt : 0;
    v.stuck = 0;
    return Infinity;
  }

  // The cars trams are pushing off the track.
  *shoved(): Generator<Car> {
    for (const v of this.list) if (v.shove) yield v.shove;
  }

  // Draw the trams within r of (x, y); the others keep running undrawn.
  sync(x = 0, y = 0, r = Infinity, height: (x: number, y: number, point: { x: number; y: number }) => number = () => 0) {
    for (const v of this.list) {
      const mid = v.parts[1];
      const show = Math.hypot(mid.x - x, mid.y - y) < r;
      if (show && !v.look) v.look = this.take(v.line);
      if (!show && v.look) { this.give(v.look); v.look = null; }
      if (!show) continue;
      const look = v.look;
      if (!look) continue;
      // Each section keeps track of whether it's on a bridge deck or under one.
      v.levels ||= v.parts.map(() => ({ x: 0, y: 0 }));
      const levels = v.levels;
      v.parts.forEach((p, i) => {
        const m = look.sections[i], at = Object.assign(levels[i], { x: p.x, y: p.y });
        const fx = Math.cos(p.ang) * SECTION / 2, fy = Math.sin(p.ang) * SECTION / 2;
        const hf = height(p.x + fx, p.y + fy, at), hb = height(p.x - fx, p.y - fy, at);
        m.position.set(p.x, (hf + hb) / 2, -p.y);
        m.rotation.set(0, p.ang, Math.atan2(hf - hb, SECTION), 'YZX');
      });
      // The number reads the right way up whichever way the tram is going.
      look.sign.rotation.y = Math.cos(v.parts[2].ang) < 0 ? Math.PI : 0;
    }
  }

  take(line: TramLine): TramLook {
    let look = this.pool.pop();
    if (!look) {
      look = { sections: [sectionMesh('back'), sectionMesh('mid'), sectionMesh('front')], sign: new THREE.Mesh(signGeometry) };
      look.sign.position.y = 3.75; // well clear of the roof box (top at 3.58), or the two flicker from high up
      look.sections[2].add(look.sign);
      for (const m of look.sections) this.scene.add(m);
    }
    look.sign.material = signMaterial(line.ref, line.colour);
    for (const m of look.sections) m.visible = true;
    return look;
  }

  give(look: TramLook) {
    for (const m of look.sections) m.visible = false;
    this.pool.push(look);
  }

  // Collision and look-ahead data for the trams within r of (x, y): for traffic, and
  // for crashes.
  bodies(x = 0, y = 0, r = Infinity) {
    const out: TramBody[] = [];
    for (const v of this.list) {
      const mid = v.parts[1];
      if (Math.hypot(mid.x - x, mid.y - y) > r) continue;
      const circles: Point2[] = [];
      for (const p of v.parts) {
        const c = Math.cos(p.ang), s = Math.sin(p.ang);
        for (const k of [-3.85, -2.57, -1.28, 0, 1.28, 2.57, 3.85]) circles.push([p.x + c * k, p.y + s * k]);
      }
      const c = Math.cos(mid.ang), s = Math.sin(mid.ang);
      out.push({ v, x: mid.x, y: mid.y, vx: c * v.speed, vy: s * v.speed, circles });
    }
    return out;
  }
}

// Someone on foot (radius `rad`) out of a tram's sections, to the nearest side as long
// as `free` there; not a section on a bridge deck above them or below. Returns the way
// they were pushed (away from the tram), or null if they weren't touching it.
export function pushOutOfTram(t: TramBody, who: { x: number; y: number; gz?: number }, rad: number, free: (x: number, y: number) => boolean): Point2 | null {
  const A = SECTION / 2 - W / 2, min = W / 2 + rad;
  for (let i = 0; i < t.v.parts.length; i++) {
    const p = t.v.parts[i], gz = t.v.levels?.[i]?.gz;
    if (gz !== undefined && who.gz !== undefined && Math.abs(gz - who.gz) > 3) continue;
    const c = Math.cos(p.ang), s = Math.sin(p.ang), dx = who.x - p.x, dy = who.y - p.y;
    const along = Math.max(-A, Math.min(A, dx * c + dy * s));
    const qx = p.x + c * along, qy = p.y + s * along;
    let nx = who.x - qx, ny = who.y - qy;
    const d = Math.hypot(nx, ny);
    if (d >= min) continue;
    if (d < 1e-6) { const side = -dx * s + dy * c < 0 ? -1 : 1; nx = -s * side; ny = c * side; }
    else { nx /= d; ny /= d; }
    const x = qx + nx * min, y = qy + ny * min;
    if (free(x, y)) { who.x = x; who.y = y; }
    return [nx, ny];
  }
  return null;
}
