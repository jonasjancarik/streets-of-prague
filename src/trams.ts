import * as THREE from 'three';
import { mirrored } from './mirror.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './map/geo.ts';
import type { Car } from './car.ts';
import type { Clock } from './clock.ts';
import { lampLit } from './lamps.ts';

export interface RawTramLine {
  ref: string; colour: string | null; night: boolean; from: string; to: string;
  pts: Point2[]; stops: [number, string][]; ends: [number, number];
  turns: { at: number; to: number; where: string }[]; speed: [number, number][];
  perHour?: Record<'weekday' | 'saturday' | 'sunday', number[]>;
}
export interface TramHalt { s: number; dwell: number; name: string; to?: number }
export interface TramPoint { x: number; y: number; ang: number }
// A track a tram runs along: a line's closed loop, or the open route of a tram someone is driving.
export interface Path {
  length: number;
  wrap(s: number): number;
  ahead(from: number, to: number): number;
  at(s: number): TramPoint;
}
export interface TramLine extends RawTramLine {
  path: Path; halts: TramHalt[]; haltS: number[]; limitS: number[]; limitV: number[];
  trams: TramVehicle[];
}
interface TramLook {
  kind: string;
  sections: THREE.Mesh[];
  sign: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}
interface TramCell { v: TramVehicle; x: number; y: number; c: number; s: number }
export interface TramVehicle {
  id: number; kind: string; line: TramLine; s: number; speed: number; dwell: number; halt: number;
  stuck: number; ghost: number; waitFor: TramVehicle | null; blocker: Car | null;
  spotted: number; forPlayer: boolean;
  held: number; shove: Car | null; look: TramLook | null; pending: number;
  parts: TramPoint[]; cells?: TramCell[]; levels?: { x: number; y: number; gz?: number }[];
  rider?: boolean;
  driven?: boolean; // someone is driving it (src/tramdrive.ts): the timetable no longer moves it
  ring?: number; // how many times its driver has rung the bell
  hold?: boolean; // stays at its stop, whatever the timetable says (an inspection is under way)
  // The grid buckets its sections are in, and whether it has moved since (see update).
  keys?: number[]; moved?: boolean;
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
// service out of sight. Each is one of the types Prague runs (see KINDS), with the line
// number on the roof. The simulation treats them all alike, as three 10 m sections; how
// one looks is its own: every section of its body lies along the track between its own
// two points on it, so a tram bends round corners where the real one does.

const SECTION = 10.2, GAP = 0.25, W = 2.5;
const STEP = SECTION + GAP;
export const HALF = STEP + SECTION / 2; // from the middle of a tram to its front
const BOGIE = SECTION / 2 - 1.6; // from the middle of a section to each of its bogies
// How far behind a tram's front each of its bogies runs (they click over the rail joints).
export const BOGIES = [STEP, 0, -STEP].flatMap((o) => [HALF - o - BOGIE, HALF - o + BOGIE]);
const ACCEL = 1.1, BRAKE = 1.2, HARD = 4.5; // m/s²: pulling away, braking, stopping short
// For the player the driver needs a moment to react, then brakes as hard as a real
// tram can: 14 m/s (50 km/h) takes some 45 m to stop, so step out in front of one too
// late and it hits you. Everyone else it sees coming, and stops for in time.
const REACT = 0.8, EMERGENCY = 2.8; // s, m/s²
const DWELL = 18, TURN = 40; // seconds at a stop, and at a terminus where the tram reverses
const PUSH = 15, CREEP = 1.5; // s a parked car can hold a tram up before the tram pushes it off the track, at this many m/s
// Without timetables: trips per hour, day lines from 5 in the morning to midnight,
// night lines (91-99) through the night.
const FALLBACK = { day: 7.5, night: 3 };
export const MEAN_SPEED = 5.5; // m/s along a line, stops included: spaces the trams out
const MANAGE = 2; // seconds between checks of how many trams each line should have out
const CELL = 20;
const NONE: TramCell[] = [];
const FAR = 800, FAR_STEP = 0.25; // trams further than this from the player move in steps of this many seconds

// The types, by their share of Prague's fleet (2026): the Škoda 15T most of all, Tatra
// T3R.P in coupled pairs, the Škoda 14T, the Tatra KT8D5R.N2P and the new Škoda 52T.
// Their bodies come from public/trams.glb (built in Blender by assets/trams/build.py):
// sections <kind>_<n> from the front, each with where it goes in its userData.
const KINDS: Record<string, number> = { '15T': 45, T3: 25, '14T': 12, KT8: 10, '52T': 8 };
interface SectionSpec { geometry: THREE.BufferGeometry; front: number; length: number; pivot: number }
interface TramType { sections: SectionSpec[]; length: number; sign: [number, number] }
const types = new Map<string, TramType>();
// The colours the parts are named after (the same as HEX in the build script).
const PART: Record<string, string> = {
  Red: '#c8161d', Cream: '#efe5c8', White: '#eeefeb', Silver: '#b4b8bb', Light: '#dcdedc', Roof: '#8f9396',
  Black: '#1d1c1b', Dark: '#3a3d40', Glass: '#1e2830', Skirt: '#2b2a29', Bellows: '#252423', Lamp: '#fff6d8',
  Tail: '#b3161b', Metal: '#5d6064', Pan: '#d9a21b',
};

export async function loadTrams(url = 'trams.glb') {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const c = new THREE.Color(), inv = new THREE.Matrix4(), m = new THREE.Matrix4();
  for (const kind of Object.keys(KINDS)) {
    const sections: SectionSpec[] = [];
    let sign: [number, number] = [0, 4];
    for (let i = 0; ; i++) {
      const node = gltf.scene.getObjectByName(`${kind}_${i}`);
      if (!node) break;
      inv.copy(node.matrixWorld).invert();
      const parts: THREE.BufferGeometry[] = [];
      node.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const g = new THREE.BufferGeometry();
        g.setIndex(o.geometry.index);
        g.setAttribute('position', o.geometry.attributes.position.clone());
        g.setAttribute('normal', o.geometry.attributes.normal.clone());
        g.applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld));
        c.set(PART[(Array.isArray(o.material) ? o.material[0] : o.material).name] || '#777777');
        const col = new Float32Array(g.attributes.position.count * 3);
        for (let k = 0; k < col.length; k += 3) col.set([c.r, c.g, c.b], k);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        parts.push(g);
      });
      const u = node.userData as { front: number; length: number; pivot: number; sign?: [number, number] };
      if (u.sign) sign = u.sign;
      sections.push({ geometry: mergeGeometries(parts), front: u.front, length: u.length, pivot: u.pivot });
    }
    if (!sections.length) throw new Error(`Missing ${kind} in trams.glb`);
    const last = sections[sections.length - 1];
    types.set(kind, { sections, length: last.front + last.length, sign });
  }
}

function randomKind(r: () => number) {
  const total = Object.values(KINDS).reduce((a, w) => a + w, 0);
  let x = r() * total;
  for (const [k, w] of Object.entries(KINDS)) if ((x -= w) < 0) return k;
  return '15T';
}

const material = new THREE.MeshLambertMaterial({ vertexColors: true });
// At night the windows (the dark blue-ish glass) are lit from inside.
material.onBeforeCompile = (sh) => {
  lampLit(sh);
  sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (uLampOn > .005 && dot(vColor.rgb, vec3(.3, .59, .11)) < .03 && vColor.b > vColor.r) totalEmissiveRadiance += vec3(1., .88, .7) * .5 * uLampOn;`);
};
material.customProgramCacheKey = () => 'trams';

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
class Loop implements Path {
  pts: Point2[];
  cum: number[];
  angs: number[]; // each segment's heading
  length: number;

  constructor(pts: Point2[]) {
    this.pts = pts;
    this.cum = [0];
    this.angs = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      this.angs.push(Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]));
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
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, ang: this.angs[lo] };
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
  pool: Map<string, TramLook[]>;
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
    this.pool = new Map();
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
    const v: TramVehicle = { id: this.id++, kind: randomKind(this.rng), line, s, speed: 0, dwell: 0, halt: 0, stuck: 0, ghost: 0, waitFor: null, blocker: null, spotted: 0, forPlayer: false, held: 0, shove: null, look: null, pending: this.rng() * FAR_STEP, parts: [] };
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
    if (v.cells && v.keys) for (let n = 0; n < 3; n++) this.unfile(v.keys[n], v.cells[n]);
    this.list.splice(this.list.indexOf(v), 1);
    v.line.trams.splice(v.line.trams.indexOf(v), 1);
  }

  // Bring each line's number of trams towards its timetable, one tram per line at a
  // time: a new one in the middle of the widest gap, and the one whose leaving opens
  // the smallest gap taken out, both only where nobody's looking.
  manage(seen: (x: number, y: number) => boolean) {
    // A tram someone left standing goes once nobody's looking at it.
    for (const v of [...this.list]) {
      const p = v.parts[1];
      if (v.driven && !v.rider && !seen(p.x, p.y)) this.remove(v);
    }
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

  // Someone takes the tram over: it leaves its line for a track of its own (`line.path`
  // is the route `path` it will be driven along), and the line gets another tram in
  // its place, out of sight, when the timetable wants one.
  steal(v: TramVehicle, path: Path, s: number) {
    v.line.trams.splice(v.line.trams.indexOf(v), 1);
    const line: TramLine = { ...v.line, path, halts: [], haltS: [], limitS: [], limitV: [], trams: [v] };
    Object.assign(v, { line, s, driven: true, rider: true, dwell: 0, speed: Math.max(0, v.speed), hold: false, waitFor: null, blocker: null, shove: null, held: 0, stuck: 0, ghost: 0, ring: v.ring ?? 0 });
    this.place(v);
  }

  // How far ahead of `front` (up to `reach` m) another tram is in the way, or Infinity.
  gapToTram(v: TramVehicle, front: number, reach: number) {
    const path = v.line.path;
    for (let d = 1; d <= reach; d += 2.5) {
      const p = path.at(front + d);
      for (let i = Math.floor((p.x - 8) / CELL); i <= Math.floor((p.x + 8) / CELL); i++) {
        for (let j = Math.floor((p.y - 8) / CELL); j <= Math.floor((p.y + 8) / CELL); j++) {
          for (const o of this.grid.get(i * 131072 + j) || NONE) {
            if (o.v === v) continue;
            const dx = p.x - o.x, dy = p.y - o.y;
            const along = dx * o.c + dy * o.s, clamped = Math.max(-SECTION / 2, Math.min(SECTION / 2, along));
            if (Math.hypot(along - clamped, dx * o.s - dy * o.c) <= 1.5) return d;
          }
        }
      }
    }
    return Infinity;
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
    if (v.parts.length !== 3) v.parts = [{ x: 0, y: 0, ang: 0 }, { x: 0, y: 0, ang: 0 }, { x: 0, y: 0, ang: 0 }];
    for (let n = 0; n < 3; n++) {
      const o = (n - 1) * STEP, a = path.at(v.s + o - BOGIE), b = path.at(v.s + o + BOGIE), q = v.parts[n];
      q.x = (a.x + b.x) / 2;
      q.y = (a.y + b.y) / 2;
      q.ang = Math.atan2(b.y - a.y, b.x - a.x);
    }
    v.moved = true;
  }

  // Where a tram's sections are, for the trams behind (see update).
  file(v: TramVehicle) {
    const cells = (v.cells ||= [{ v, x: 0, y: 0, c: 0, s: 0 }, { v, x: 0, y: 0, c: 0, s: 0 }, { v, x: 0, y: 0, c: 0, s: 0 }]);
    const keys = (v.keys ||= [NaN, NaN, NaN]);
    for (let n = 0; n < 3; n++) {
      const p = v.parts[n], o = cells[n], k = Math.floor(p.x / CELL) * 131072 + Math.floor(p.y / CELL);
      o.x = p.x; o.y = p.y; o.c = Math.cos(p.ang); o.s = Math.sin(p.ang);
      if (k === keys[n]) continue;
      this.unfile(keys[n], o);
      let b = this.grid.get(k);
      if (!b) this.grid.set(k, (b = []));
      b.push(o);
      keys[n] = k;
    }
    v.moved = false;
  }

  unfile(k: number, o: TramCell) {
    const b = this.grid.get(k), i = b ? b.indexOf(o) : -1;
    if (!b || i < 0) return;
    b[i] = b[b.length - 1];
    b.pop();
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
    // Where every tram's sections are, so the trams behind can see them: where they
    // were at the start of this step (keyed by number as in SpatialHash). Only the ones
    // that moved are filed again: most trams are far off and move a few times a second.
    for (const v of this.list) if (v.moved || !v.keys) this.file(v);
    // Buckets left empty for a while go, so the map doesn't grow with the city.
    if (++this.gridSweep > 600) {
      this.gridSweep = 0;
      for (const [k, b] of this.grid) if (!b.length) this.grid.delete(k);
    }
    for (const v of this.list) {
      if (v.driven) { this.place(v); continue; }
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
      if (v.hold) return;
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
    // track gets slowly pushed off it. Traffic gets more time to clear a visible queue.
    const was = v.blocker;
    const gap = this.clearAhead(v, dt, front, look, near, seen);
    if (gap < Infinity) target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, gap - 4)));
    v.held = v.blocker && v.blocker === was && v.speed < 0.1 ? v.held + dt : 0;
    const patience = v.blocker?.mode === 'traffic' ? (seen(v.blocker.x, v.blocker.y) ? 30 : 12) : PUSH;
    if (v.held > patience && v.blocker && v.blocker.mode !== 'player') { v.shove = v.blocker; v.held = 0; }
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
      if (show && !v.look) v.look = this.take(v);
      if (!show && v.look) { this.give(v.look); v.look = null; }
      if (!show) continue;
      const look = v.look;
      if (!look) continue;
      // Each third of the tram keeps track of whether it's on a bridge deck or under one.
      v.levels ||= v.parts.map(() => ({ x: 0, y: 0 }));
      const levels = v.levels, type = types.get(v.kind)!, path = v.line.path, front = v.s + type.length / 2;
      type.sections.forEach((spec, i) => {
        const m = look.sections[i], c = front - spec.front - spec.length / 2;
        const a = path.at(c + spec.pivot), b = path.at(c - spec.pivot);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const k = Math.max(0, Math.min(2, Math.round((c - v.s) / STEP) + 1));
        const at = Object.assign(levels[k], { x: cx, y: cy });
        const hf = height(a.x, a.y, at), hb = height(b.x, b.y, at);
        m.position.set(cx, (hf + hb) / 2, -cy);
        m.rotation.set(0, Math.atan2(a.y - b.y, a.x - b.x), Math.atan2(hf - hb, 2 * spec.pivot), 'YZX');
      });
      // The number reads the right way up whichever way the tram is going.
      look.sign.rotation.y = Math.cos(look.sections[0].rotation.y) < 0 ? Math.PI : 0;
    }
  }

  take(v: TramVehicle): TramLook {
    let look = this.pool.get(v.kind)?.pop();
    if (!look) {
      const type = types.get(v.kind);
      if (!type) throw new Error('Trams are not loaded');
      const sections = type.sections.map((spec) => {
        const m = mirrored(new THREE.Mesh(spec.geometry, material));
        m.castShadow = true;
        return m;
      });
      look = { kind: v.kind, sections, sign: new THREE.Mesh(signGeometry) };
      look.sign.position.set(type.sign[0], type.sign[1], 0); // over the roof, clear of the pantograph
      look.sections[0].add(look.sign);
      for (const m of look.sections) this.scene.add(m);
    }
    look.sign.material = signMaterial(v.line.ref, v.line.colour);
    for (const m of look.sections) m.visible = true;
    return look;
  }

  give(look: TramLook) {
    for (const m of look.sections) m.visible = false;
    let pool = this.pool.get(look.kind);
    if (!pool) this.pool.set(look.kind, (pool = []));
    pool.push(look);
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
