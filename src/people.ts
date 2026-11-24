import * as THREE from 'three';
import { clamp, segDist } from './network.ts';
import { Figures, Anim, FIGURE_SIZE, SCALE, randomLook, jumpHeight } from './figures.ts';
import type { FigureKit, Look } from './figures.ts';
import type { WalkEdge, WalkGraph } from './network.ts';
import type { Footfall } from './footfall.ts';
import type { Point2 } from './map/geo.ts';
import { fences } from './fences.ts';
import type { TileWorld } from './tiles.ts';
import { ROOFTOP } from './roofSurface.ts';
import { parachute } from './parachute.ts';
import { Umbrellas } from './umbrellas.ts';

interface WalkGrid {
  at(x: number, y: number): number;
  height?: (x: number, y: number) => number;
  view?: (who: Walker) => WalkGrid;
}
type PersonOnFoot = Pick<Walker, 'x' | 'y' | 'vx' | 'vy' | 'gz'>;
interface WalkSpot { e: WalkEdge; s: number }
export interface Pedestrian extends WalkSpot {
  i: number; fwd: boolean; side: number; speed: number; x: number; y: number; h: number;
  // How far across their half of the path they keep, 0 (the middle) to 1 (the edge).
  lane: number;
  // 'hold': off the paths, making for `hold` and standing there (waiting at a bus stop,
  // following a guide).
  vx: number; vy: number; state: 'walk' | 'flee' | 'down' | 'rejoin' | 'hold';
  t: number; pause: number; z: number; anim: Anim; look: Look;
  // Stepping aside round something in the way: metres across the path now, and wanted.
  dodge: number; dodgeTo: number;
  // How fast they're actually going (for the legs), m/s.
  pace: number;
  // The fastest they may go for now (someone slower in front of them, with no way past), m/s.
  cap: number;
  // Seconds they've been trying to walk on with a wall or a fence in the way.
  stuck: number;
  // Theirs for good, whichever slot they're drawn in (which umbrella they carry).
  serial: number;
  target?: WalkSpot & { x: number; y: number };
  gz?: number;
  // Knocked down by someone taking their bike: which way to run once they're up.
  then?: Point2;
  // Hurt badly and lying there until an ambulance crew has seen to them (or it's been so long nobody's coming): seconds so far.
  hurt?: number;
  // So badly hurt that the ambulance takes them away rather than getting them up again.
  grave?: boolean;
  // Where someone in the 'hold' state makes for, and the way they face once there.
  hold?: { x: number; y: number; h: number };
  // The way they mean to walk, junction by junction (a guide's to the next sight); at a
  // junction the way doesn't go on from, it's dropped.
  route?: { e: WalkEdge; fwd: boolean }[];
  // The umbrella they hold up whatever the weather (a guide's, for the group to follow).
  brolly?: number;
  // Busy with something of their own (leading a tour): not sent home with the crowd,
  // nor taken onto a tram.
  kept?: boolean;
  // A tour group they're in: a guide doesn't step round its own group, which follows it.
  group?: object;
}
interface WalkSegment extends WalkSpot { a: Point2; b: Point2; s0: number; len: number }
// Something standing in the way: a circle of a parked car or bike (see pushCar in main.ts).
interface Obstruction { x: number; y: number; z?: number; r: number; kind: string; car?: { vx: number; vy: number } }
type Obstructions = (x: number, y: number, r: number) => Iterable<Obstruction>;

// Pedestrians wander the footpath network, jump out of the way of fast cars,
// and get knocked over (then get up again) when they don't make it.

const HURT_FOR = 240; // seconds a hurt person lies there if no ambulance comes
const GETUP = 1.25; // seconds of getting up at the end of lying on the ground
// Walking, people head for a point this far along their path, so they round corners
// and turn gradually rather than all at once.
const LOOK = 1.2;
// Turns to try, nearest the way first, for a step round a corner (toHold).
const ROUND = [0.7, -0.7, 1.4, -1.4];
const CLEAR = 0.6; // m kept between a walker's middle and the side of whatever they pass
const TURN = 5; // rad/s, the fastest a walker turns
const PASS = 0.62; // m kept between two walkers' middles as they pass each other
const MEET = 0.8; // the same for two coming towards each other
const SHOULDERS = 0.55; // m: two walkers' middles closer than this are moved apart
// What lies beside a footpath is looked at every STATION metres along it (see sides()),
// out to at most FAR metres, and looked at again after STALE seconds.
const STATION = 3, FAR = 14, STALE = 60;
// A path that runs inside buildings for more than this share of its length (an indoor
// corridor, a way through a block with no passage open in it) isn't walked.
const INDOOR = 0.3;
const PAVEMENT = 1.1; // m: the narrowest strip beside a carriageway people walk along as a pavement
// People are bucketed in squares this many metres across to find who's near whom.
const BUCKET = 3;
const bucket = (i: number, j: number) => ((i * 73856093) ^ (j * 19349663)) & 4095;

// What lies to either side of a footpath, at each station along it (right then left of
// its direction): how far out the first wall, building or fence stands (`wall`), and on a
// street walked without a pavement mapped of its own, how far out the carriageway ends
// (`kerb`: -1 where a wall comes first, so there's no pavement), and where a path runs
// along a hedge or a fence, how far out its side is (`from`). `inside`: the share of
// the path itself that runs through buildings.
interface Sides { at: number; wall: Float32Array; kerb: Float32Array; from: Float32Array; inside: number }

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(SCALE, SCALE, SCALE);
const UP = new THREE.Vector3(0, 1, 0);
const _doorRoot = new THREE.Object3D(), IDENTITY = new THREE.Quaternion();
// Hip height .96 m plus the authored last frame of getin, in figure axes.
const SEATED_FIGURE_HIPS = new THREE.Vector3(-.06,.46,0);
const _m = new THREE.Matrix4();

// Standing, or walking to running, for someone on their feet going at `speed`
// (negative: backwards).
export function locomote(a: Anim, dt: number, speed: number) {
  if (Math.abs(speed) < 0.2) { a.play('idle', false, 0.3); a.step(dt); }
  else a.move(dt, speed);
}

// Lying down after being knocked over, getting up for the last GETUP seconds.
export function knocked(a: Anim, dt: number, left: number) {
  if (left < GETUP) a.play('getup', false, 0.1);
  a.step(dt);
}

export class Crowd {
  private threatScan: { x: number; y: number; ux: number; uy: number; reach2: number; jump2: number }[] = [];
  walk: WalkGraph;
  grid: WalkGrid;
  r: () => number;
  kit: FigureKit;
  people: Pedestrian[];
  fig: Figures;
  umbrellas: Umbrellas;
  private serial = 0;
  private exitPose?: Anim;
  totalLen: number;
  cell: number;
  segs: Map<string, WalkSegment[]>;
  footfall: Footfall | null = null;
  tick = 0;
  // Whether a point is on a carriageway (see main.ts); without it, streets are walked
  // along their edges as if they had no pavement.
  road: ((x: number, y: number) => boolean) | null = null;
  private sideCache = new Map<WalkEdge, Sides>();
  private clock = 0;
  private budget = 0; // how many more paths' sides may be looked at this step
  // The lane's room across the path from the last lane() (metres out on their side),
  // whether it's a pavement beside a carriageway and which side it's on (+1 right).
  private lo = 0;
  private hi = 0;
  private pave = false;
  private sign = 1;
  // Everyone bucketed by where they stand, made again each step: heads[bucket] is the
  // first person's number, links[n] the next one's (-1 at the end). Buckets are
  // BUCKET metres square, hashed into 4096 (people far apart may share one).
  private heads = new Int32Array(4096).fill(-1);
  private links = new Int32Array(0);
  // What's in the way, for avoid(): per span, its two sides across the path, whether
  // it's already alongside and whether it's someone coming the other way.
  private spans = new Float64Array(4 * 48);
  private spanN = 0;
  // Where avoid() looks from: across the path from where they walk now, how far ahead
  // the nearest person is, the lane's room, and the path's point and directions there.
  private way = { now: 0, ahead: Infinity, lo: 0, hi: 0, pave: false, sign: 1, bx: 0, by: 0, ux: 0, uy: 0, nx: 0, ny: 0 };

  constructor(walk: WalkGraph, grid: WalkGrid, scene: THREE.Scene, rng: () => number, count: number, kit: FigureKit) {
    this.walk = walk;
    this.grid = grid;
    this.r = rng;
    this.kit = kit;
    this.people = [];
    this.fig = new Figures(kit, count + 16);
    this.fig.lifeSize = true;
    scene.add(this.fig.mesh);
    this.umbrellas = new Umbrellas(scene, count + 16);
    this.totalLen = walk.edges.reduce((a, e) => a + e.path.length, 0);
    this.cell = 16;
    this.segs = new Map();
    this.index(walk.edges);
    for (let i = 0; i < count; i++) this.add();
  }

  // Footpath segments bucketed for nearest(); called again as more of the map loads.
  index(edges: WalkEdge[]) {
    for (const e of edges) {
      // More of the map round it has loaded: look at what's beside it again when there's time.
      const known = this.sideCache.get(e);
      if (known) known.at = -Infinity;
      let acc = 0;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const k = `${Math.floor((a[0] + b[0]) / 2 / this.cell)},${Math.floor((a[1] + b[1]) / 2 / this.cell)}`;
        if (!this.segs.has(k)) this.segs.set(k, []);
        this.segs.get(k)!.push({ e, a, b, s0: acc, len, s: acc });
        acc += len;
      }
    }
  }

  // Footpaths that have left the network (their tiles are far behind). Anyone still on
  // one walks it up and down until they're moved nearer you, as on a path that ends
  // where the map hasn't loaded.
  forget(edges: WalkEdge[]) {
    for (const e of edges) {
      this.sideCache.delete(e);
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const k = `${Math.floor((a[0] + b[0]) / 2 / this.cell)},${Math.floor((a[1] + b[1]) / 2 / this.cell)}`;
        const list = this.segs.get(k);
        if (!list) continue;
        const left = list.filter((s) => s.e !== e);
        if (left.length) this.segs.set(k, left);
        else this.segs.delete(k);
      }
    }
  }

  // Closest point on the footpath network (used to rejoin after running away).
  nearest(x: number, y: number): WalkSpot | null {
    let best: WalkSpot | null = null, bestD = Infinity;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let R = 1; R <= 4 && !best; R++) {
      for (let i = -R; i <= R; i++) {
        for (let j = -R; j <= R; j++) {
          for (const s of this.segs.get(`${cx + i},${cy + j}`) || []) {
            const d = segDist(x, y, s.a, s.b);
            if (d < bestD && !this.indoor(s.e, false)) {
              const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
              const t = clamp(((x - s.a[0]) * dx + (y - s.a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
              bestD = d;
              best = { e: s.e, s: s.s0 + t * s.len };
            }
          }
        }
      }
    }
    return best;
  }

  add(at?: WalkSpot): Pedestrian {
    const r = this.r;
    if (this.people.length >= this.fig.capacity) {
      // Full: move someone who is out of the way instead (not, if it can be helped, anyone
      // waiting at a stop or with a tour group).
      let p = this.people[Math.floor(r() * this.people.length)];
      for (let k = 0; k < 8 && (p.kept || p.state === 'hold'); k++) p = this.people[Math.floor(r() * this.people.length)];
      Object.assign(p, { e: at?.e || p.e, s: at?.s ?? p.s, state: 'walk', vx: 0, vy: 0, cap: Infinity, stuck: 0, hurt: undefined, grave: undefined,
        hold: undefined, route: undefined, brolly: undefined, kept: undefined, group: undefined });
      this.place(p);
      return p;
    }
    let e = at?.e, s = at?.s;
    // (Not inside a building, if a few tries find somewhere else.)
    for (let tries = 0; !at?.e && tries < 4 && (!e || this.indoor(e, true)); tries++) {
      e = this.anywhere();
      s = r() * e.path.length;
    }
    if (!e) throw new Error('No walkable edges are loaded');
    const i = this.people.length;
    const p: Pedestrian = {
      i, e, s: s ?? 0, fwd: r() > 0.5, side: r() > 0.5 ? 1 : -1, lane: r(),
      speed: 1.1 + r() * 0.6, x: 0, y: 0, h: 0, vx: 0, vy: 0,
      state: 'walk', t: 0, pause: 0, z: 0, anim: new Anim(this.kit, 'walk', r() * 2), look: randomLook(r),
      dodge: 0, dodgeTo: 0, pace: 0, cap: Infinity, stuck: 0, serial: this.serial++,
    };
    this.fig.look(i, p.look);
    this.fig.mesh.count = this.people.length + 1;
    this.people.push(p);
    this.place(p);
    return p;
  }

  // Someone goes home: the last in the list takes their slot.
  retire(p: Pedestrian) {
    const last = this.people.pop();
    if (!last) return;
    if (last !== p) {
      last.i = p.i;
      this.people[p.i] = last;
      this.fig.look(last.i, last.look);
    }
    this.fig.mesh.count = this.people.length;
  }

  // What lies beside a path (see Sides), looked at once a minute at most, and only a few
  // paths a step unless `now`; null if it hasn't been looked at yet.
  sides(e: WalkEdge, now = false): Sides | null {
    const known = this.sideCache.get(e);
    if (known && (this.clock - known.at < STALE || (!now && this.budget <= 0))) return known;
    if (!now && this.budget <= 0) return null;
    this.budget--;
    const len = e.path.length, n = Math.max(2, Math.round(len / STATION) + 1);
    const m: Sides = known && known.wall.length === 2 * n ? known : { at: 0, wall: new Float32Array(2 * n), kerb: new Float32Array(2 * n), from: new Float32Array(2 * n), inside: 0 };
    m.at = this.clock;
    // A street walked without a pavement of its own: where its carriageway ends.
    const street = e.side > 0 && !!this.road, far = Math.min(FAR, e.width / 2 + 6);
    let solid = 0;
    for (let i = 0; i < n; i++) {
      const q = e.path.at((len * i) / (n - 1)), nx = Math.sin(q.ang), ny = -Math.cos(q.ang);
      if (this.grid.at(q.x, q.y)) solid++;
      const onRoad = street && this.road!(q.x, q.y), fenced = fences.blocks(q.x, q.y, 0.1, 0);
      for (let k = 0; k < 2; k++) {
        const sx = k ? -nx : nx, sy = k ? -ny : ny;
        let wall = far, kerb = NaN, from = 0, out = !fenced;
        for (let d = 0.25; d <= far; d += 0.25) {
          const x = q.x + sx * d, y = q.y + sy * d, solid = this.grid.at(x, y) !== 0, fence = fences.blocks(x, y, 0.1, 0);
          // (A path mapped along a hedge: out of it first, then on.)
          if (!out && fence && !solid) { from = d; continue; }
          out = true;
          // (Past a tree or a post, not a fence: something under a metre across.)
          if (solid && !fence && d + 1 <= far && this.thin(x, y, sx, sy)) continue;
          if (solid || fence) { wall = d; break; }
          if (onRoad && kerb !== kerb && !this.road!(x, y)) kerb = d;
          if (kerb === kerb && d - kerb > 3.5) break; // pavement enough
        }
        // A wall before the kerb: no pavement. Neither within reach (the mouth of a
        // side street, a car park): unknown, so as on either side of it along the street.
        m.wall[2 * i + k] = wall;
        m.from[2 * i + k] = from;
        m.kerb[2 * i + k] = !onRoad ? NaN : kerb === kerb ? kerb : wall < far ? -1 : NaN;
      }
    }
    // The unknown stations take the nearest known one's kerb (none: no pavement).
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < n; i++) {
        if (m.kerb[2 * i + k] === m.kerb[2 * i + k]) continue;
        let v = -1;
        for (let j = 1; j < n; j++) {
          const a = i - j >= 0 ? m.kerb[2 * (i - j) + k] : NaN, b = i + j < n ? m.kerb[2 * (i + j) + k] : NaN;
          if (a === a && a >= 0) { v = a; break; }
          if (b === b && b >= 0) { v = b; break; }
          if (i - j < 0 && i + j >= n) break;
        }
        m.kerb[2 * i + k] = v;
      }
    }
    m.inside = solid / n;
    // A path in a wall, or one whose tile's walls haven't come yet (where nothing is
    // loaded is solid too): looked at again in a few seconds.
    if (solid) m.at = this.clock - STALE + 3;
    this.sideCache.set(e, m);
    return m;
  }

  // Whether what's solid at (x, y) is small, a tree or a post: open ground within a metre
  // further out along (sx, sy), and three quarters of a metre to either side of it.
  private thin(x: number, y: number, sx: number, sy: number) {
    if (this.grid.at(x - sy * 0.75, y + sx * 0.75) || this.grid.at(x + sy * 0.75, y - sx * 0.75)) return false;
    for (let d = 0.25; d <= 1; d += 0.25) if (!this.grid.at(x + sx * d, y + sy * d)) return true;
    return false;
  }

  // A path mostly inside buildings, where nobody could see them or follow them.
  indoor(e: WalkEdge, now: boolean) {
    if (e.path.length < 2) return false;
    const m = now ? this.sides(e, true) : this.sideCache.get(e);
    return !!m && m.inside > INDOOR;
  }

  // How far across the path someone keeps (to the right of its direction, in metres) at
  // `s` along it: on the pavement beside a street (crossing to the other one where theirs
  // has none),
  // near the edge of one without a pavement, anywhere across a footpath, a pedestrian
  // street or a bridge; never into a wall or a fence. It leaves the room they have
  // across their side in lo, hi and which side that is in `sign`.
  lane(p: Pedestrian, s = p.s) {
    const e = p.e, m = this.sides(e);
    this.sign = p.side;
    // (A street in walls all along: its tile's walls not come yet, as good as unknown.)
    if (!m || (e.side && m.inside >= 1)) {
      this.pave = false;
      this.hi = e.side ? e.side : Math.max(0, e.width / 2 - 0.4);
      this.lo = e.side ? Math.max(0, this.hi - 0.6) : 0;
    } else {
      const n = m.wall.length / 2, u = clamp(s / (e.path.length || 1), 0, 1) * (n - 1);
      const i = Math.min(n - 2, Math.floor(u)), f = u - i, k = p.side > 0 ? 0 : 1;
      this.room(e, m, i, f, k);
      if (e.side && !this.pave) {
        const { lo, hi } = this;
        this.room(e, m, i, f, 1 - k);
        // (Crossed over, they stay on that side until its pavement ends too, rather than
        // back across wherever their own side has a stretch of pavement again.)
        if (this.pave) this.sign = p.side = -p.side;
        else { this.lo = lo; this.hi = hi; }
      }
    }
    return this.sign * (this.lo + p.lane * (this.hi - this.lo));
  }

  // The room across one side (k: 0 right, 1 left) of a path between two stations (i and
  // the next, f of the way), into lo, hi and pave.
  private room(e: WalkEdge, m: Sides, i: number, f: number, k: number) {
    let lo: number, hi: number;
    const wall = m.wall[2 * i + k] * (1 - f) + m.wall[2 * i + 2 + k] * f;
    const from = Math.max(m.from[2 * i + k], m.from[2 * i + 2 + k]);
    // (A pavement at either station: one without, a kiosk in the way, say, isn't the end of it.)
    const k0 = m.kerb[2 * i + k], k1 = m.kerb[2 * i + 2 + k];
    const kerb = k0 >= 0 && k1 >= 0 ? k0 * (1 - f) + k1 * f : Math.max(k0, k1);
    this.pave = false;
    if (e.side && kerb >= 0 && wall - kerb >= PAVEMENT) {
      // On the pavement, a little in from the kerb.
      this.pave = true;
      lo = kerb + 0.4;
      hi = Math.max(lo, Math.min(wall - 0.35, kerb + 3.4));
    } else if (e.side) {
      hi = Math.max(0, Math.min(e.side, wall - 0.45));
      lo = Math.max(0, hi - 0.6);
    } else {
      lo = 0;
      hi = Math.max(0, Math.min(e.width / 2 - 0.4, wall - 0.35));
    }
    // Beside the hedge or fence the path runs along, not in it.
    if (from) { lo = Math.max(lo, from + 0.35); hi = Math.max(hi, lo); }
    this.lo = lo;
    this.hi = hi;
  }

  // Where on their path someone is, `ahead` metres on, over in their lane (and round
  // whatever they're stepping past), clear of buildings and fences: a step aside that
  // would end in one is made smaller, then the lane is.
  spot(p: Pedestrian, ahead = 0) {
    const s = p.s + (p.fwd ? ahead : -ahead), q = p.e.path.at(s);
    let lane = this.lane(p, s), dodge = p.dodge;
    const nx = Math.sin(q.ang), ny = -Math.cos(q.ang);
    let x = q.x + nx * (lane + dodge), y = q.y + ny * (lane + dodge);
    // (Walls only: the room in the lane already keeps clear of fences, and follow() checks
    // them on every step.)
    for (let k = 0; k < 6 && this.grid.at(x, y) !== 0; k++) {
      if (Math.abs(dodge) > 0.05) dodge *= 0.5;
      else lane *= 0.6;
      x = q.x + nx * (lane + dodge);
      y = q.y + ny * (lane + dodge);
    }
    return { x, y, ang: p.fwd ? q.ang : q.ang + Math.PI };
  }

  // A path picked at random, by length.
  private anywhere() {
    let x = this.r() * this.totalLen, e: WalkEdge | undefined;
    for (const f of this.walk.edges) if ((x -= f.path.length) < 0) { e = f; break; }
    e = e || this.walk.edges[0];
    if (!e) throw new Error('No walkable edges are loaded');
    return e;
  }

  // Put a person straight onto their edge (new, or moved). On a path inside a building,
  // onto the next one out of it, or failing that (a dead end in there), somewhere else.
  place(p: Pedestrian) {
    if (this.indoor(p.e, true)) {
      for (const o of this.walk.adj.get(p.s > p.e.path.length / 2 ? p.e.v : p.e.u) || []) {
        if (o.e === p.e || this.indoor(o.e, true)) continue;
        p.e = o.e;
        p.fwd = o.fwd;
        p.s = o.fwd ? 0 : o.e.path.length;
        break;
      }
      for (let tries = 0; tries < 4 && this.indoor(p.e, true); tries++) {
        p.e = this.anywhere();
        p.s = this.r() * p.e.path.length;
      }
    }
    p.stuck = 0;
    p.cap = Infinity;
    p.dodge = p.dodgeTo = 0;
    let q = this.spot(p);
    // (Where the path runs through a wall, a passage through a building, say: a little
    // further along it or back, out of the wall.)
    for (let k = 1, s = p.s; k <= 20 && this.blocked(q.x, q.y); k++) {
      p.s = clamp(s + (k % 2 ? 1 : -1) * Math.ceil(k / 2), 0, p.e.path.length);
      q = this.spot(p);
    }
    p.x = q.x;
    p.y = q.y;
    p.h = q.ang;
  }

  // Stuck on the corner of a wall where their path runs close by it: put a step or two
  // further along it, if that's clear, or a moment's wait.
  private pastCorner(p: Pedestrian) {
    p.stuck = 0;
    p.dodge = p.dodgeTo = 0;
    const s = p.s;
    for (const ahead of [1, 1.6, 2.2]) {
      p.s = clamp(s + (p.fwd ? ahead : -ahead), 0, p.e.path.length);
      const q = this.spot(p);
      if (!this.blocked(q.x, q.y)) { p.x = q.x; p.y = q.y; return; }
    }
    p.s = s;
    p.pause = 1 + this.r() * 1.5;
  }

  // Walking on: after the point ahead on their path, at their own pace (a little
  // quicker to catch up after a detour).
  follow(p: Pedestrian, dt: number) {
    p.dodge += clamp(p.dodgeTo - p.dodge, -1.5 * dt, 1.5 * dt);
    const q = this.spot(p, LOOK), dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    const step = p.pause > 0 ? 0 : Math.min(d, Math.min(p.speed, p.cap) * dt * clamp(d / LOOK, 0.7, 1.5));
    let moved = step;
    if (d > 0.01 && step > 0) {
      let nx = p.x + (dx / d) * step, ny = p.y + (dy / d) * step;
      // Never from open ground into a wall, a building or a fence (from inside one, out
      // of it). Cutting a corner: back onto the path where they'd be without the
      // shortcut, briskly; failing that, along the wall, or they stand.
      if (this.blocked(nx, ny) && !this.blocked(p.x, p.y)) {
        const on = this.spot(p), bx = on.x - p.x, by = on.y - p.y, bd = Math.hypot(bx, by) || 1;
        const k = Math.min(1, Math.max(step, p.speed * dt * 2) / bd);
        nx = p.x + bx * k;
        ny = p.y + by * k;
        if (this.blocked(nx, ny)) {
          nx = p.x + (dx / d) * step;
          ny = p.y + (dy / d) * step;
          if (!this.blocked(nx, p.y)) ny = p.y;
          else if (!this.blocked(p.x, ny)) nx = p.x;
          else { nx = p.x; ny = p.y; }
        }
        moved = Math.hypot(nx - p.x, ny - p.y);
      }
      p.stuck = moved < step * 0.3 ? p.stuck + dt : 0;
      p.x = nx;
      p.y = ny;
    }
    p.pace = dt > 0 ? moved / dt : 0;
    // Face where they're going, turning at most TURN a second.
    const want = d > 0.05 ? Math.atan2(dy, dx) : q.ang;
    const off = Math.atan2(Math.sin(want - p.h), Math.cos(want - p.h));
    p.h += clamp(off * Math.min(1, dt * 8), -TURN * dt, TURN * dt);
  }

  // Off the paths: over to their spot (at a bus stop, behind a guide) and standing there,
  // turned the way they want to face. They set off once the spot is a few steps off and
  // keep walking until they're on it, so a spot that moves a little at a time (a guide
  // walking ahead) is followed at a walk rather than in fits and starts.
  toHold(p: Pedestrian, w: { x: number; y: number; h: number }, dt: number) {
    const dx = w.x - p.x, dy = w.y - p.y, d = Math.hypot(dx, dy);
    let moved = 0;
    if (d > (p.pace > 0.05 ? 0.08 : 0.35)) {
      const step = Math.min(d, Math.min(p.speed * 1.4, 0.45 + d * 1.3) * dt);
      let nx = p.x + (dx / d) * step, ny = p.y + (dy / d) * step;
      // (Along a wall or a fence rather than into it, or round its corner.)
      if (this.blocked(nx, ny) && !this.blocked(p.x, p.y)) {
        if (!this.blocked(nx, p.y)) ny = p.y;
        else if (!this.blocked(p.x, ny)) nx = p.x;
        else {
          const a = Math.atan2(dy, dx);
          nx = p.x; ny = p.y;
          for (const turn of ROUND) {
            const x = p.x + Math.cos(a + turn) * step, y = p.y + Math.sin(a + turn) * step;
            if (!this.blocked(x, y)) { nx = x; ny = y; break; }
          }
        }
      }
      moved = Math.hypot(nx - p.x, ny - p.y);
      p.stuck = moved < step * 0.3 ? p.stuck + dt : 0;
      p.vx = dt > 0 ? (nx - p.x) / dt : 0;
      p.vy = dt > 0 ? (ny - p.y) / dt : 0;
      p.x = nx;
      p.y = ny;
    } else { p.vx = p.vy = 0; p.stuck = 0; }
    p.pace = dt > 0 ? moved / dt : 0;
    const want = moved > 0.002 ? Math.atan2(p.vy, p.vx) : w.h;
    const off = Math.atan2(Math.sin(want - p.h), Math.cos(want - p.h));
    const turn = moved > 0.002 ? TURN : 2.5;
    p.h += clamp(off * Math.min(1, dt * 6), -turn * dt, turn * dt);
  }

  // Something in the way, across the path from a to b (see spans).
  private span(a: number, b: number, beside: boolean, oncoming: boolean) {
    if (this.spanN * 4 >= this.spans.length) return;
    const s = this.spans, k = this.spanN++ * 4;
    s[k] = a; s[k + 1] = b; s[k + 2] = beside ? 1 : 0; s[k + 3] = oncoming ? 1 : 0;
  }

  // Whether `v` across the path is clear of everything in the way, and reached from
  // `now` without stepping sideways through something they're passing.
  private clear(v: number, now: number) {
    const s = this.spans, lo = Math.min(v, now), hi = Math.max(v, now);
    for (let k = 0; k < this.spanN * 4; k += 4) {
      if (v > s[k] && v < s[k + 1]) return false;
      if (s[k + 2] && s[k + 1] > lo && s[k] < hi) return false;
    }
    return true;
  }

  // Look a few metres ahead for what's in the way, parked cars and bikes, other people
  // and the player, and pick the nearest way past (or back into their lane once past).
  // Meeting someone, they keep right; with no way past, they fall in behind someone
  // going their way or stop for a moment.
  avoid(p: Pedestrian, near?: Obstructions, player?: PersonOnFoot) {
    const dir = p.fwd ? 1 : -1, q = p.e.path.at(p.s + dir * 1.5), base = p.e.path.at(p.s);
    const ux = Math.cos(q.ang) * dir, uy = Math.sin(q.ang) * dir, nx = Math.sin(q.ang), ny = -Math.cos(q.ang);
    const lane = this.lane(p), now = lane + p.dodge, lo = this.lo, hi = this.hi, pave = this.pave, sign = this.sign;
    this.spanN = 0;
    p.cap = Infinity;
    if (near) for (const o of near(p.x, p.y, 5)) {
      if (o.kind !== 'car' || !o.car || Math.abs(o.car.vx) + Math.abs(o.car.vy) > 0.5) continue;
      if (o.z !== undefined && p.gz !== undefined && Math.abs(o.z - p.gz) > 3) continue;
      const ax = o.x - base.x, ay = o.y - base.y, along = ax * ux + ay * uy;
      if (along < -o.r - 0.5 || along > 4.5) continue;
      const lat = ax * nx + ay * ny, w = o.r + CLEAR;
      this.span(lat - w, lat + w, along < o.r + 1, false);
    }
    // Leave shoulder room for someone walking towards us or crossing our path.
    // Predict briefly so a passer-by turns before reaching the first-person camera.
    let personAhead = Infinity, blockAt = Infinity, blockPace = 0, blocker: Pedestrian | null = null;
    if (player && Math.abs(player.x - p.x) < 6 && Math.abs(player.y - p.y) < 6 &&
        Math.abs((player.gz ?? 0) - (p.gz ?? 0)) < 1.5) {
      const dx = player.x - base.x, dy = player.y - base.y;
      const along = dx * ux + dy * uy, closing = p.speed - player.vx * ux - player.vy * uy;
      if (closing > .1 && along > -.45 && along < Math.min(5.5, 1.4 + closing * 1.65)) {
        const time = clamp(along / closing, 0, .65);
        const side = dx * nx + dy * ny + time * (player.vx * nx + player.vy * ny);
        if (Math.min(Math.abs(side - lane), Math.abs(side - now)) < 1.05) {
          this.span(side - .98, side + .98, false, false);
          personAhead = along;
        }
      }
    }
    // The other walkers near them: where each will be across the path by the time
    // they meet (someone standing, or going their way more slowly, or coming the other
    // way), and anyone already alongside.
    const people = this.people, links = this.links, gz = p.gz ?? 0;
    let pushX = 0, pushY = 0, held = false;
    const i0 = Math.floor((p.x - 5) / BUCKET), i1 = Math.floor((p.x + 5) / BUCKET);
    const j0 = Math.floor((p.y - 5) / BUCKET), j1 = Math.floor((p.y + 5) / BUCKET);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (let n = this.heads[bucket(i, j)]; n >= 0; n = links[n]) {
        const o = people[n];
        if (!o || o === p || Math.abs((o.gz ?? 0) - gz) > 1.5 || (o.group && o.group === p.group)) continue;
        // (How far ahead from where they are, so that of two going the same way only
        // the one behind has the other ahead; across from the path.)
        const dx = o.x - base.x, dy = o.y - base.y, along = (o.x - p.x) * ux + (o.y - p.y) * uy;
        // Closer than shoulders allow (a crowd at a dead end, people put down on the same
        // spot): a little apart, each their own way.
        const ox = p.x - o.x, oy = p.y - o.y, od = Math.hypot(ox, oy);
        if (od < SHOULDERS) {
          const k = (SHOULDERS - od) * 0.5, a = od > 0.01 ? 0 : p.serial * 2.4;
          pushX += od > 0.01 ? (ox / od) * k : Math.cos(a) * k;
          pushY += od > 0.01 ? (oy / od) * k : Math.sin(a) * k;
          // (Of two walking on as one, side by side in a passage, the later lets the other
          // get ahead.)
          if (p.serial > o.serial && along > -.1 && o.state === 'walk' && o.pace > .2) held = true;
        }
        if (along < -.3 || along > 5.5) continue;
        const walking = o.state === 'walk', down = o.state === 'down';
        const ovx = walking ? Math.cos(o.h) * o.pace : down ? 0 : o.vx, ovy = walking ? Math.sin(o.h) * o.pace : down ? 0 : o.vy;
        const toward = ovx * ux + ovy * uy, closing = p.speed - toward, beside = along < .6;
        if (!beside && (closing < .1 || along > Math.min(5.5, 1.2 + closing * 1.4))) continue;
        const time = beside ? 0 : Math.min(1.2, along / closing);
        // (Not for someone coming towards them: what they're doing across the path is
        // stepping aside for us, and counting on it, each would step aside only half enough.)
        const side = dx * nx + dy * ny + (toward < -.3 ? 0 : time * (ovx * nx + ovy * ny));
        if (Math.abs(side - lane) > 1.4 && Math.abs(side - now) > 1.4) continue;
        // (A little more room for someone coming the other way.)
        const pass = toward < -.3 ? MEET : PASS;
        this.span(side - pass, side + pass, beside, toward < -.3);
        // (Someone alongside, or as good as on the same spot, is stepped away from, not
        // waited for: two waiting for each other would wait for good.)
        if (along < .3) continue;
        if (along < personAhead) personAhead = along;
        // In their way right now: how far ahead, and how fast it goes their way.
        if (Math.abs(side - now) < PASS && along < blockAt) { blockAt = along; blockPace = toward; blocker = o; }
      }
    }
    if (pushX || pushY) {
      const x = p.x + pushX, y = p.y + pushY;
      if (!this.blocked(x, y)) { p.x = x; p.y = y; }
    }
    if (held) p.pause = Math.max(p.pause, .3);
    const w = this.way;
    w.now = now; w.ahead = personAhead; w.lo = lo; w.hi = hi; w.pave = pave; w.sign = sign;
    w.bx = base.x; w.by = base.y; w.ux = ux; w.uy = uy; w.nx = nx; w.ny = ny;
    if (this.fits(p, lane)) { p.dodgeTo = 0; return; }
    // The way round nearest to where they're walking now, so they don't dither; past
    // someone coming the other way, on their own right (+ across the path, going forward).
    // Off the pavement into the road only to get round a parked car, not round people.
    const road = this.road, kerbside = !!road && !road(base.x + ux + nx * lane, base.y + uy + ny * lane);
    let best = NaN, cost = Infinity, inRoad = false;
    const s = this.spans;
    for (let k = 0; k < this.spanN * 4; k += 4) {
      for (let e = 0; e < 2; e++) {
        const v = e ? s[k + 1] + 0.01 : s[k] - 0.01;
        let c = Math.abs(v - now);
        if (s[k + 3] && (e ? dir : -dir) < 0) c += 0.8;
        const off = kerbside && road!(base.x + ux + nx * v, base.y + uy + ny * v);
        if (off) c += 2;
        if (c < cost && this.fits(p, v)) { cost = c; best = v; inRoad = off; }
      }
    }
    // A tree, a post or a wall corner in their lane, nothing else: a step or two aside,
    // to their right if they can.
    for (let d = 0.5; best !== best && d <= 2; d += 0.5) {
      if (this.fits(p, now + dir * d)) best = now + dir * d;
      else if (this.fits(p, now - dir * d)) best = now - dir * d;
    }
    if (inRoad && blocker && blockAt < 1.6) best = NaN;
    if (best === best) {
      p.dodgeTo = best - lane;
      // Still right behind someone while stepping round them: no faster than they go.
      if (blockAt < 1) p.cap = Math.max(0, blockPace);
    } else if (blocker && blockAt < 1.6) {
      // No way past. Someone going their way: they fall in behind. Someone coming
      // towards them or standing there: one of the two (the one who came out later)
      // waits, and after a while turns back; the other stops short of them.
      // (Someone standing there, at a bus stop or in a tour group, doesn't make way, nor
      // does a guide with a group behind, but for another guide.)
      const mine = p.group ? 1 : 0, theirs = blocker.group || blocker.state === 'hold' ? 1 : 0;
      if (blockPace > .2) p.cap = blockPace * 0.95;
      else if (mine === theirs ? p.serial > blocker.serial : mine < theirs) { p.pause = Math.max(p.pause, .25); p.stuck += .1; }
      else if (blockAt < .8) p.cap = 0;
    } else if (personAhead < 1.8 && !blocker) p.pause = Math.max(p.pause, .25);
  }

  // Whether `v` across the path is somewhere to step to (for avoid(), with `way` set):
  // clear of what's in the way, no wall or fence a little way on, and with someone
  // ahead, on this side of the kerb (on a path, within its width; a narrow doorway may
  // only fit one person at a time).
  private fits(p: Pedestrian, v: number) {
    const w = this.way;
    if (!this.clear(v, w.now)) return false;
    if (w.ahead < Infinity) {
      if (p.e.side ? w.sign * v < w.lo - .25 || w.sign * v > w.hi + (w.pave ? .3 : 1.3)
        : Math.abs(v) > Math.max(.4, w.hi + .18)) return false;
    }
    return !this.blocked(w.bx + w.ux + w.nx * v, w.by + w.uy + w.ny * v) && !this.blocked(w.bx + w.ux * 2.5 + w.nx * v, w.by + w.uy * 2.5 + w.ny * v);
  }

  // A wall, a building or a fence (one they can't jump, `up` m off the ground).
  blocked(x: number, y: number, up = 0) { return this.grid.at(x, y) !== 0 || fences.blocks(x, y, 0.15, up); }

  // Someone steps out of a car (a driver who's just been pulled out, say), looking
  // like `look` if given (the rider of a bike you've taken).
  spawnAt(x: number, y: number, look?: Look) {
    const p = this.add(this.nearest(x, y) || undefined);
    p.x = x;
    p.y = y;
    p.then = undefined;
    if (look) {
      p.look = look;
      p.anim.riderSeed = look.riderSeed;
      this.fig.look(p.i, look);
    }
    return p;
  }

  // `seen`: whether a spot is in view; out of it, nobody's walk or fall is animated.
  update(dt: number, threats: Iterable<{ x: number; y: number; vx: number; vy: number }>, near?: Obstructions, seen: (x: number, y: number) => boolean = () => true, player?: PersonOnFoot) {
    const r = this.r;
    // All walkers see the same car positions during this step. Prepare speed,
    // direction and reach once per car rather than once per walker and car.
    let threatN = 0;
    for (const car of threats) {
      const speed = Math.hypot(car.vx, car.vy);
      if (speed < 1.5) continue;
      const item = this.threatScan[threatN] ??= { x: 0, y: 0, ux: 0, uy: 0, reach2: 0, jump2: 0 };
      item.x = car.x; item.y = car.y; item.ux = car.vx / speed; item.uy = car.vy / speed;
      item.reach2 = (9 + speed * 1.1) ** 2; item.jump2 = (3 + speed * .35) ** 2;
      threatN++;
    }
    // Each walker looks ahead for things in the way a few times a second, not all at once.
    this.tick = (this.tick + 1) % 4;
    this.clock += dt;
    this.budget = 6;
    // Who stands where, for avoid() to find the people near someone.
    const people = this.people;
    if (this.links.length < people.length) this.links = new Int32Array(Math.max(people.length, this.fig.capacity));
    this.heads.fill(-1);
    for (let n = 0; n < people.length; n++) {
      const b = bucket(Math.floor(people[n].x / BUCKET), Math.floor(people[n].y / BUCKET));
      this.links[n] = this.heads[b];
      this.heads[b] = n;
    }
    for (const p of this.people) {
      p.t -= dt;
      const exit=p.anim.driverExit;
      if (exit) {
        exit.elapsed+=dt;
        if (exit.elapsed>=exit.duration) p.anim.driverExit=undefined;
      }
      if (p.hurt !== undefined) {
        // Lying there until seen to, or until it's been too long to wait for anyone.
        if (p.state !== 'down' || (p.hurt += dt) > HURT_FOR) this.revive(p);
        else p.t = 5;
      }
      if (p.state === 'walk' || p.state === 'hold') {
        // Look out for fast cars heading this way.
        for (let i = 0; i < threatN; i++) {
          const c = this.threatScan[i];
          const dx = p.x - c.x, dy = p.y - c.y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 > c.reach2) continue;
          const ux = c.ux, uy = c.uy;
          const ahead = dx * ux + dy * uy, side = dx * uy - dy * ux;
          if (ahead > -1 && Math.abs(side) < 4) {
            const s = side >= 0 ? 1 : -1;
            p.state = 'flee';
            p.t = 1 + r() * 0.8;
            p.vx = uy * s * 5.5;
            p.vy = -ux * s * 5.5;
            // Too close to just run: they leap out of the way.
            if (dist2 < c.jump2) p.anim.play('jump', true, 0.08);
            break;
          }
        }
      }
      if (p.state === 'walk') {
        if (p.pause > 0) { p.pause -= dt; }
        else {
          // (Held up by a wall: their place on the path waits for them.)
          if (p.stuck < 0.3) p.s += (p.fwd ? 1 : -1) * Math.min(p.speed, p.cap) * dt;
          if (p.s < 0 || p.s > p.e.path.length) this.turn(p);
          if (r() < dt * 0.02) p.pause = 1 + r() * 4;
        }
        if (p.i % 4 === this.tick) {
          // (On a path found to be inside a building once its walls came: out onto the
          // next one, unseen in there.)
          if (this.indoor(p.e, false)) this.place(p);
          this.avoid(p, near, player);
        }
        this.follow(p, dt);
        if (p.stuck > 1.5) {
          // No way on past a wall or a fence: out of sight, back onto the path (unless the
          // path itself runs through the wall, a passage through a building, say, or
          // they're on it already, held up by someone); in sight, or then, they turn round.
          const q = seen(p.x, p.y) || p.route ? null : this.spot(p);
          if (q && !this.blocked(q.x, q.y) && Math.hypot(q.x - p.x, q.y - p.y) > 0.3) this.place(p);
          // (Someone on a way of their own, a guide with a group behind, doesn't turn back:
          // caught on a corner, a step on past it; failing that, they wait.)
          else if (p.route) this.pastCorner(p);
          else { p.fwd = !p.fwd; p.stuck = 0; p.dodge = p.dodgeTo = 0; }
        }
      } else if (p.state === 'hold') {
        if (p.hold) this.toHold(p, p.hold, dt);
        else p.state = 'walk';
      } else if (p.state === 'flee' || p.state === 'down' || p.state === 'rejoin') {
        if (p.state === 'down') {
          const k = Math.exp(-4 * dt);
          p.vx *= k;
          p.vy *= k;
        }
        if (p.state === 'rejoin') {
          if (!p.target) continue;
          const dx = p.target.x - p.x, dy = p.target.y - p.y, d = Math.hypot(dx, dy);
          if (d < 0.4 || p.t < -8) {
            p.state = 'walk';
            p.e = p.target.e;
            p.s = p.target.s;
            p.stuck = 0;
            p.cap = Infinity;
          } else {
            p.vx = (dx / d) * 1.8;
            p.vy = (dy / d) * 1.8;
          }
        }
        // Off the path, walls and fences stop them too (unless they're already in one,
        // or jump it).
        const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, inWall = this.blocked(p.x, p.y, p.z);
        if (inWall || !this.blocked(nx, p.y, p.z)) p.x = nx; else p.vx *= -0.3;
        if (inWall || !this.blocked(p.x, ny, p.z)) p.y = ny; else p.vy *= -0.3;
        if (p.state !== 'down' && Math.hypot(p.vx, p.vy) > 0.3) p.h = Math.atan2(p.vy, p.vx);
        if (p.t < 0 && p.state === 'down' && p.then) {
          // Up again, and off at a run.
          Object.assign(p, { state: 'flee', t: 2.5, vx: p.then[0], vy: p.then[1], then: undefined });
        } else if (p.t < 0 && (p.state === 'flee' || p.state === 'down')) {
          const n = this.nearest(p.x, p.y);
          if (n) {
            const q = n.e.path.at(n.s);
            p.target = { e: n.e, s: n.s, x: q.x, y: q.y };
            p.state = 'rejoin';
            p.t = 0;
          } else p.state = 'walk';
        }
      }
      if (seen(p.x, p.y)) this.animate(p, dt);
    }
  }

  // A car about to touch them: they leap clear, away from it (nx, ny: out of the car,
  // towards them). Nobody is ever run over.
  leap(p: Pedestrian, nx: number, ny: number) {
    p.state = 'flee';
    p.t = 1 + this.r() * 0.8;
    p.vx = nx * 6;
    p.vy = ny * 6;
    p.then = undefined;
    if (p.anim.name !== 'jump' || p.anim.done) p.anim.play('jump', true, 0.08);
  }

  animate(p: Pedestrian, dt: number) {
    const a = p.anim;
    if (p.state === 'down') knocked(a, dt, p.t);
    else if (a.name === 'jump' && !a.done) a.step(dt);
    else locomote(a, dt, p.state === 'walk' || p.state === 'hold' ? p.pace : Math.hypot(p.vx, p.vy));
    p.z = a.name === 'jump' ? jumpHeight(a.t, 0.7) : 0;
  }

  turn(p: Pedestrian) {
    const node = p.s > p.e.path.length / 2 ? p.e.v : p.e.u;
    // On their way somewhere: the next street of it, if it goes on from here.
    if (p.route) {
      const next = p.route[0];
      if (next && (next.fwd ? next.e.u : next.e.v) === node) {
        p.route.shift();
        p.e = next.e;
        p.fwd = next.fwd;
        p.s = p.fwd ? 0 : p.e.path.length;
        p.dodge = p.dodgeTo = 0;
        p.stuck = 0;
        return;
      }
      p.route = undefined;
    }
    // Not into a building, where the path runs on inside it: that's a dead end.
    const opts = (this.walk.adj.get(node) || []).filter((o) => o.e !== p.e && !this.indoor(o.e, true));
    // Busier streets are likelier. A walk spreads people out more evenly than its
    // turns lean (it has to pass the quiet streets round a busy one), so the turns lean
    // harder, by pull^1.75: in a simulation that kept as many people a metre on each
    // street, in the long run, as the crowd is first put out with (by pull).
    const w = opts.map((o) => (this.footfall ? this.footfall.pull(o.e) ** 1.75 : 1));
    let x = this.r() * w.reduce((a, b) => a + b, 0), k = 0;
    while (k < opts.length - 1 && (x -= w[k]) > 0) k++;
    const pick = opts.length ? opts[k] : { e: p.e, fwd: !p.fwd };
    // A dead end: stop and turn round before walking back.
    if (!opts.length) p.pause = 0.6;
    p.e = pick.e;
    p.fwd = pick.fwd;
    p.s = p.fwd ? 0 : p.e.path.length;
    p.dodge = p.dodgeTo = 0;
    p.stuck = 0;
  }

  // A gunshot at (x, y): everyone walking within r runs from it.
  scare(x: number, y: number, r: number) {
    for (const p of this.people) {
      if (p.state !== 'walk' && p.state !== 'rejoin' && p.state !== 'hold') continue;
      const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy);
      if (d > r) continue;
      const a = Math.atan2(dy, dx) + (this.r() - 0.5) * 0.8, sp = 5 + this.r();
      Object.assign(p, { state: 'flee', t: 2.5 + this.r() * 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp });
    }
  }

  // `hurt`: 1 for a blow hard enough that they stay down until an ambulance crew gets to
  // them, 2 for one that has them taken away.
  knock(p: Pedestrian, vx: number, vy: number, hurt = 0) {
    p.state = 'down';
    p.t = 3 + this.r() * 2;
    if (hurt && p.hurt === undefined) p.hurt = 0;
    if (hurt > 1) p.grave = true;
    p.vx = vx;
    p.vy = vy;
    p.h = Math.atan2(vy, vx) + Math.PI;
    p.anim.play('fall', true, 0.08);
  }

  // Seen to: they get up (a little slowly) and walk on.
  revive(p: Pedestrian) {
    p.hurt = undefined;
    p.grave = undefined;
    if (p.state === 'down') p.t = GETUP;
  }

  // Only those `seen` (in view, with room for their shadows) are drawn, packed into the
  // first slots: most of the crowd round you is out of sight.
  // The predicate receives the person too, so stereo can retain elevated casters.
  render(height: (x: number, y: number, p: Pedestrian) => number = () => 0, seen: (x: number, y: number, p: Pedestrian) => boolean = () => true, sheltered?: (x: number, y: number, head: number) => boolean) {
    const m = _m, rain = this.umbrellas.wet > 0;
    let n = 0;
    this.umbrellas.begin();
    for (const p of this.people) {
      if (!seen(p.x, p.y, p)) continue;
      m.compose(_p.set(p.x, height(p.x, p.y, p) + p.z, -p.y), _q.setFromAxisAngle(UP, p.h), _s);
      // (Dropped by anyone running from a car or knocked over.)
      const upright = p.state === 'walk' || p.state === 'rejoin' || p.state === 'hold';
      const brolly = upright && p.brolly !== undefined ? p.brolly : p.serial;
      const up = upright && (brolly !== p.serial || (rain && this.umbrellas.up(p.serial))) && !sheltered?.(p.x, p.y, _p.y + 1.8);
      // A street avatar has its own draw and holds its own umbrella. Pack only
      // the remaining walkers into this batch, including in the shadow pass.
      if (this.fig.streetModel(p.i, m, p.anim, up ? brolly : -1)) continue;
      this.fig.wear(n, p.i);
      let pose=p.anim;
      const exit=pose.driverExit;
      if (exit && FIGURE_SIZE.value<SCALE) {
        // A full avatar pool can need a frame to release a slot. The small
        // figure follows the same door path until the matching rig takes it.
        _doorRoot.position.copy(_p); _doorRoot.quaternion.copy(_q); _doorRoot.scale.setScalar(1);
        exit.place(_doorRoot,SEATED_FIGURE_HIPS,IDENTITY);
        m.compose(_doorRoot.position,_doorRoot.quaternion,_doorRoot.scale);
        const small=this.exitPose ??= new Anim(this.kit,'getin');
        small.t=small.duration*exit.seatedPhase;
        small.from=pose.name; small.ft=pose.t; small.w=exit.standingWeight;
        pose=small;
      }
      this.fig.place(n,m,pose);
      if (up) this.umbrellas.put(brolly, _p, p.h, p.anim.phase, Math.min(1, p.pace / 1.2));
      n++;
    }
    this.fig.commit(n);
    this.umbrellas.commit();
  }
}

// Nearest spot where a person fits (a free cell with free cells on all four sides),
// searching outward in rings up to maxR metres.
export function nearestWalkable(grid: WalkGrid, x: number, y: number, maxR = 60): Point2 {
  for (let r = 0; r <= maxR; r += 1) {
    const n = Math.max(8, Math.round(r * 6));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (grid.at(px, py) === 0 && grid.at(px + 1, py) === 0 && grid.at(px - 1, py) === 0 && grid.at(px, py + 1) === 0 && grid.at(px, py - 1) === 0) return [px, py];
    }
  }
  return [x, y];
}

// The player on foot: tank controls relative to where they face, Shift to run, Space
// to jump. `ctl` = { move -1..1, turn -1..1 (left +), run, jump, aim }. With `aim` =
// { h, mag } (the touch stick) you turn to face h and walk that way instead; a full
// push runs.
export class Walker {
  grid: WalkGrid;
  x: number; y: number; h: number; z: number; speed: number; down: number;
  vx: number; vy: number;
  // Stepping sideways (first person's A/D), m/s to the left.
  side = 0;
  // Standing on a car: how high its bonnet, roof or boot is under your feet.
  perch: number;
  anim: Anim;
  look: Look;
  fig: Figures;
  base: THREE.Matrix4;
  mesh: THREE.Group;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  gz?: number;
  level?: number;
  _tx?: number;
  _ty?: number;

  flight: { height: number; peak: number; vz: number; inflation: number; open: boolean; fromX: number; fromY: number; deck: number; helicopter?: boolean } | null = null;
  readonly body = new THREE.Group();
  private canopy?: THREE.Group;

  constructor(grid: WalkGrid, kit: FigureKit, private world: TileWorld, private splash: (helicopter: boolean) => void, private hurt: (points: number) => void) {
    this.grid = grid;
    this.x = this.y = 0;
    this.h = 0;
    this.z = 0;
    this.speed = 0;
    this.down = 0;
    this.vx = this.vy = 0;
    this.perch = 0;
    this.anim = new Anim(kit, 'idle');
    this.look = { shirt: '#d9612c', trousers: '#2f3a4f', skin: '#e3b99a', hair: '#3a2618', sleeves: false };
    this.fig = new Figures(kit, 1);
    this.fig.avatarSeed = Math.floor(Math.random() * 0x100000000);
    this.fig.look(0, this.look);
    this.fig.mesh.count = 1;
    this.base = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
    this.mesh = new THREE.Group();
    this.mesh.add(this.body);
    this.body.add(this.fig.mesh);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.95, 32),
      new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.mesh.add(this.ring);
  }

  get onRoof() { return this.level === ROOFTOP; }
  // In the air, high enough for a car to pass under your feet.
  get airborne() { return this.z + this.perch > 0.5; }
  get jumping() { return this.anim.name === 'jump' && !this.anim.done; }

  // The ground and walls as you meet them: on a bridge deck or under it.
  get ground() { return this.grid.view ? this.grid.view(this) : this.grid; }

  blocked(x: number, y: number) {
    const g = this.ground, r = 0.3;
    if (g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r)) return true;
    // A fence or a hedge stops you coming up to it, unless you're jumping (or already in it).
    return !this.onRoof && this.perch < 0.3 && fences.blocks(x, y, 0.15, this.z) && !fences.blocks(this.x, this.y, 0.15, this.z);
  }

  private leaveLedge(dt: number) {
    const speed = Math.hypot(this.vx, this.vy);
    if (speed < 1) return false;
    const deck = this.level ?? 0, height = this.gz ?? 0;
    // The walker's collision radius meets an oblique lip before its centre does.
    // A short vault also clears the thickness of a quay wall or bridge parapet.
    for (const distance of [0.38, 0.85, 1.45, 2.2]) {
      const reach = dt + distance / speed;
      const x = this.x + this.vx * reach, y = this.y + this.vy * reach;
      const water = this.world.waterAt(x, y);
      const ahead = !deck && water ? this.world.terrainAt(x, y, true) : this.world.levelAt(x, y, deck);
      if (ahead >= height - 1.5) continue;
      const below = this.world.landingAt(x, y, height);
      const surface = !below.level && water ? this.world.terrainAt(x, y, true) : below.h;
      if (height - surface <= 1.5 || this.world.rooftopAt(x, y) > height + this.z) continue;
      if (!water && this.world.cellAt(x, y, below.level, below.h) !== 0) continue;
      this.flight = { height: height + this.z, peak: height + this.z, vz: 1, inflation: 0, open: false, fromX: this.x, fromY: this.y, deck };
      this.x = x; this.y = y;
      this.h = Math.atan2(this.vy, this.vx);
      this.sync();
      return true;
    }
    return false;
  }

  jumpFromHelicopter(c: { x: number; y: number; h: number; z: number; vx: number; vy: number; vz: number }) {
    // While aboard, the hidden walker stays at the boarding spot. Keep it as
    // a fallback if the splashdown has no reachable bank among the loaded tiles.
    this.flight = { height: c.z + 0.8, peak: c.z + 0.8, vz: c.vz, inflation: 0, open: false,
      fromX: this.x, fromY: this.y, deck: this.level ?? 0, helicopter: true };
    this.x = c.x; this.y = c.y;
    const lx = -Math.sin(c.h), ly = Math.cos(c.h);
    let side = 0;
    for (const k of [1, -1]) {
      const x = c.x + k * lx * 2, y = c.y + k * ly * 2;
      if (this.world.rooftopAt(x, y) >= c.z || this.world.landingAt(x, y, c.z).h >= c.z) continue;
      this.x = x; this.y = y; side = k; break;
    }
    this.h = c.h;
    this.vx = c.vx + lx * side * 2; this.vy = c.vy + ly * side * 2;
    this.perch = this.side = this.speed = this.down = 0;
    this.level = undefined;
    this._tx = undefined;
    this.mesh.visible = true;
    this.anim.play('jump', true);
    this.sync();
  }

  endFlight() {
    this.flight = null;
    this.z = 0;
    if (this.canopy) this.canopy.visible = false;
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
  }

  private fly(dt: number, deploy: boolean, move: number, turn: number, aim?: { h: number; mag: number } | null) {
    const f = this.flight!;
    if (deploy && !f.open) {
      f.open = true;
      if (!this.canopy) { this.canopy = parachute(); this.body.add(this.canopy); }
      this.canopy.visible = true;
    }
    if (aim) {
      turn = clamp(Math.atan2(Math.sin(aim.h - this.h), Math.cos(aim.h - this.h)) * 2, -1, 1);
      if (!move) move = aim.mag;
    }
    this.h += turn * (f.open ? 1.25 : 2) * dt;
    const dive = Math.max(0, move), flare = Math.max(0, -move);
    // Track forward through freefall, then trade height for speed under the wing.
    // Pulling back flares the canopy for a shorter, slower landing.
    const speed = f.open ? 7 + 6 * dive - 4.5 * flare : 4 + 10 * dive - 3 * flare;
    const grip = 1 - Math.exp(-dt * (f.open ? 2.6 : 1.4));
    this.vx += (speed * Math.cos(this.h) - this.vx) * grip;
    this.vy += (speed * Math.sin(this.h) - this.vy) * grip;
    if (f.open && this.canopy) {
      f.inflation = Math.min(1, f.inflation + dt / 0.35);
      this.canopy.scale.set(0.55 + 0.45 * f.inflation, 0.8 + 0.2 * f.inflation, 0.2 + 0.8 * f.inflation);
      // Rotate the pilot, lines and wing around the harness, so the feet
      // swing below it and the attachment points stay together in a turn.
      this.body.rotation.x += (-turn * 0.35 - this.body.rotation.x) * grip;
      this.body.rotation.z += ((0.1 + 0.18 * flare - 0.3 * dive) * f.inflation - this.body.rotation.z) * grip;
      this.body.position.set(0, -1.2, 0).applyQuaternion(this.body.quaternion);
      this.body.position.y += 1.2;
      const sink = 2.8 + 3.8 * dive - flare + Math.abs(turn) * 0.6;
      f.vz += (-sink - f.vz) * (1 - Math.exp(-4 * f.inflation * dt));
    } else {
      f.vz = Math.max(-48, f.vz - (9.81 + 6 * dive) * dt);
    }
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
    let under = this.world.landingAt(nx, ny, f.height);
    let wet = !under.level && this.world.waterAt(nx, ny);
    // Keep the landing clear, even when the player turns towards a wall.
    const clear = wet || (under.h <= f.height + 0.6 && this.world.cellAt(nx, ny, under.level, under.h) === 0);
    if (clear && this.world.rooftopAt(nx, ny) <= f.height + 0.6) {
      this.x = nx; this.y = ny;
    } else {
      under = this.world.landingAt(this.x, this.y, f.height);
      wet = !under.level && this.world.waterAt(this.x, this.y);
    }
    const surface = wet ? this.world.terrainAt(this.x, this.y, true) : under.h;
    f.height += f.vz * dt;
    f.peak = Math.max(f.peak, f.height);
    if (f.height <= surface) {
      this.endFlight();
      if (wet) {
        this.x = f.fromX; this.y = f.fromY;
        this.level = f.deck;
        if (f.helicopter) {
          const dry = { at: (x: number, y: number) => this.world.waterAt(x, y) === false
            ? this.world.cellAt(x, y, 0, this.world.terrainAt(x, y)) : 255 };
          const [x, y] = nearestWalkable(dry, nx, ny, 200);
          if (dry.at(x, y) === 0) { this.x = x; this.y = y; this.level = 0; }
        }
        this.splash(!!f.helicopter);
      } else this.level = under.level;
      this.gz = this.world.levelAt(this.x, this.y, this.level);
      this._tx = this.x; this._ty = this.y;
      this.speed = this.side = this.vx = this.vy = 0;
      this.anim.play('idle', true, 0.1);
      if (!wet && !f.open) {
        const drop = f.peak - surface;
        // A fast dive or a moving aircraft alone shouldn't make a short drop fatal.
        // Use impact energy for intermediate falls, capped by the actual drop.
        const speedHeight = Math.max(0, -f.vz) ** 2 / (2 * 9.81);
        const severity = clamp(Math.min(speedHeight - 6, (drop - 6) * 1.5) / (25 - 6), 0, 0.95);
        if (drop >= 25) this.hurt(100);
        else if (severity > 0) this.hurt(100 * severity);
      }
    }
    this.sync();
  }

  // `strafe` (first person): left/right step sideways instead of turning.
  update(dt: number, ctl: { turn: number; move: number; run: boolean; jump: boolean; brake?: boolean; aim?: { h: number; mag: number } | null; strafe?: boolean }) {
    if (this.flight) { this.fly(dt, ctl.jump, ctl.move, ctl.turn, ctl.aim); return; }
    const a = this.anim;
    if (this.down > 0) {
      this.down -= dt;
      const k = Math.exp(-4 * dt);
      this.vx *= k;
      this.vy *= k;
      if (!this.blocked(this.x + this.vx * dt, this.y)) this.x += this.vx * dt;
      if (!this.blocked(this.x, this.y + this.vy * dt)) this.y += this.vy * dt;
      // A quicker get-up than the crowd's: you want to get going again.
      if (this.down < GETUP / 1.5) a.play('getup', false, 0.1);
      a.step(dt, a.name === 'getup' ? 1.5 : 1);
      this.z = 0;
      this.side = 0;
      this.sync();
      return;
    }
    // Tank controls, like GTA 2: up/down move along the way you face, left/right turn.
    let { turn, move } = ctl, target;
    if (ctl.aim) {
      const off = Math.atan2(Math.sin(ctl.aim.h - this.h), Math.cos(ctl.aim.h - this.h));
      turn = Math.sign(off) * Math.min(1, Math.abs(off) * 3);
      this.h += Math.sign(off) * Math.min(Math.abs(off), 12 * dt);
      // Hardly move until you've turned round, so a sharp change doesn't drift sideways.
      const facing = Math.max(0, Math.cos(off));
      target = (ctl.aim.mag > 0.9 || ctl.run ? 7.5 : 3.6 * Math.min(1, ctl.aim.mag / 0.8)) * facing;
    } else {
      if (!ctl.strafe) this.h += turn * (ctl.run ? 3.6 : 4.2) * dt;
      target = move > 0 ? move * (ctl.run ? 7.5 : 3.6) : move * 2;
    }
    // Like a first-person game: forward and sideways together no faster than either alone.
    let across = ctl.strafe && !ctl.aim ? turn * (ctl.run ? 5 : 3) : 0;
    if (across && target) {
      const length = Math.hypot(move, turn);
      if (length > 1) { target /= length; across /= length; }
    }
    this.side += (across - this.side) * Math.min(1, dt * 10);
    if (Math.abs(this.side) < 0.01) this.side = 0;
    const jumping = a.name === 'jump' && !a.done;
    if (ctl.jump && !jumping) a.play('jump', true, 0.06);
    this.speed += (target - this.speed) * Math.min(1, dt * 10);
    const c = Math.cos(this.h), sn = Math.sin(this.h);
    this.vx = c * this.speed - sn * this.side;
    this.vy = sn * this.speed + c * this.side;
    if (this.jumping && this.z > 0.45 && (this.level ?? 0) >= 0 && this.leaveLedge(dt)) return;
    if (!this.blocked(this.x + this.vx * dt, this.y)) this.x += this.vx * dt;
    if (!this.blocked(this.x, this.y + this.vy * dt)) this.y += this.vy * dt;
    // (Sideways, the legs walk at the pace you go.)
    const pace = Math.abs(this.side) > Math.abs(this.speed) ? Math.abs(this.side) : this.speed;
    if (a.name === 'jump' && !a.done) a.step(dt);
    // Turning on the spot shuffles the feet.
    else locomote(a, dt, Math.abs(pace) > 0.2 ? pace : ctl.strafe ? 0 : Math.abs(turn) * 0.9);
    this.z = a.name === 'jump' ? jumpHeight(a.t, 1.1) : 0;
    this.sync();
  }

  knock(vx: number, vy: number) {
    this.endFlight();
    this.down = 2.2;
    this.vx = vx;
    this.vy = vy;
    this.h = Math.atan2(vy, vx) + Math.PI;
    this.anim.play('fall', true, 0.08);
  }

  sync() {
    const g = this.ground, ground = g.height ? g.height(this.x, this.y) : 0;
    if (this.flight) this.z = this.flight.height - ground;
    this.mesh.position.set(this.x, ground + this.perch + this.z, -this.y);
    this.mesh.rotation.set(0, this.h, 0);
    this.ring.position.y = 0.05 - this.z;
  }

  // The avatar pool releases anyone missing from a rendered frame, even between simulation steps.
  drawFigure() {
    if (this.fig.lifeSize) {
      this.mesh.updateMatrixWorld();
      this.fig.set(0, _m.multiplyMatrices(this.body.matrixWorld, this.base), this.anim, -1, this.base);
    } else this.fig.set(0, this.base, this.anim);
    this.fig.commit(1);
  }
}
