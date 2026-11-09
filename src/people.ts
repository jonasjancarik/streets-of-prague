import * as THREE from 'three';
import { clamp, segDist } from './network.ts';
import { Figures, Anim, SCALE, randomLook, jumpHeight } from './figures.ts';
import type { FigureKit, Look } from './figures.ts';
import type { WalkEdge, WalkGraph } from './network.ts';
import type { Footfall } from './footfall.ts';
import type { Point2 } from './map/geo.ts';
import { fences } from './fences.ts';
import { Umbrellas } from './umbrellas.ts';

interface WalkGrid {
  at(x: number, y: number): number;
  height?: (x: number, y: number) => number;
  view?: (who: Walker) => WalkGrid;
}
interface WalkSpot { e: WalkEdge; s: number }
export interface Pedestrian extends WalkSpot {
  i: number; fwd: boolean; side: number; speed: number; x: number; y: number; h: number;
  // How far across their half of the path they keep, 0 (the middle) to 1 (the edge).
  lane: number;
  vx: number; vy: number; state: 'walk' | 'flee' | 'down' | 'rejoin';
  t: number; pause: number; z: number; anim: Anim; look: Look;
  // Stepping aside round something in the way: metres across the path now, and wanted.
  dodge: number; dodgeTo: number;
  // How fast they're actually going (for the legs), m/s.
  pace: number;
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
const CLEAR = 0.6; // m kept between a walker's middle and the side of whatever they pass
const TURN = 5; // rad/s, the fastest a walker turns

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(SCALE, SCALE, SCALE);
const UP = new THREE.Vector3(0, 1, 0);
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
  walk: WalkGraph;
  grid: WalkGrid;
  r: () => number;
  kit: FigureKit;
  people: Pedestrian[];
  fig: Figures;
  umbrellas: Umbrellas;
  private serial = 0;
  totalLen: number;
  cell: number;
  segs: Map<string, WalkSegment[]>;
  footfall: Footfall | null = null;
  tick = 0;

  constructor(walk: WalkGraph, grid: WalkGrid, scene: THREE.Scene, rng: () => number, count: number, kit: FigureKit) {
    this.walk = walk;
    this.grid = grid;
    this.r = rng;
    this.kit = kit;
    this.people = [];
    this.fig = new Figures(kit, count + 16);
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
            if (d < bestD) {
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
      // Full: move someone who is out of the way instead.
      const p = this.people[Math.floor(r() * this.people.length)];
      Object.assign(p, { e: at?.e || p.e, s: at?.s ?? p.s, state: 'walk', vx: 0, vy: 0, hurt: undefined, grave: undefined });
      this.place(p);
      return p;
    }
    let e = at?.e, s = at?.s;
    if (!e) {
      let x = r() * this.totalLen;
      for (const f of this.walk.edges) if ((x -= f.path.length) < 0) { e = f; break; }
      e = e || this.walk.edges[0];
      if (!e) throw new Error('No walkable edges are loaded');
      s = r() * e.path.length;
    }
    const i = this.people.length;
    const p: Pedestrian = {
      i, e, s: s ?? 0, fwd: r() > 0.5, side: r() > 0.5 ? 1 : -1, lane: r(),
      speed: 1.1 + r() * 0.6, x: 0, y: 0, h: 0, vx: 0, vy: 0,
      state: 'walk', t: 0, pause: 0, z: 0, anim: new Anim(this.kit, 'walk', r() * 2), look: randomLook(r),
      dodge: 0, dodgeTo: 0, pace: 0, serial: this.serial++,
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

  // How far across the path someone keeps (to the right of its direction, in metres):
  // near the edge of a street without a pavement of its own, anywhere across a
  // footpath, a pedestrian street or a bridge.
  lane(p: Pedestrian) {
    return p.side * (p.e.side ? Math.max(0, p.e.side - p.lane * 0.6) : p.lane * Math.max(0, p.e.width / 2 - 0.4));
  }

  // Where on their path someone is, `ahead` metres on, over in their lane (and round
  // whatever they're stepping past), clear of buildings.
  spot(p: Pedestrian, ahead = 0) {
    const q = p.e.path.at(p.s + (p.fwd ? ahead : -ahead));
    let off = this.lane(p) + p.dodge;
    const nx = Math.sin(q.ang), ny = -Math.cos(q.ang);
    let x = q.x + nx * off, y = q.y + ny * off;
    for (let k = 0; k < 6 && this.grid.at(x, y); k++) {
      off *= 0.6;
      x = q.x + nx * off;
      y = q.y + ny * off;
    }
    return { x, y, ang: p.fwd ? q.ang : q.ang + Math.PI };
  }

  // Put a person straight onto their edge (new, or moved).
  place(p: Pedestrian) {
    p.dodge = p.dodgeTo = 0;
    const q = this.spot(p);
    p.x = q.x;
    p.y = q.y;
    p.h = q.ang;
  }

  // Walking on: after the point ahead on their path, at their own pace (a little
  // quicker to catch up after a detour).
  follow(p: Pedestrian, dt: number) {
    p.dodge += clamp(p.dodgeTo - p.dodge, -1.5 * dt, 1.5 * dt);
    const q = this.spot(p, LOOK), dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    const step = p.pause > 0 ? 0 : Math.min(d, p.speed * dt * clamp(d / LOOK, 0.7, 1.5));
    if (d > 0.01) {
      let nx = p.x + (dx / d) * step, ny = p.y + (dy / d) * step;
      // Cutting the corner of a building: back onto the path where they'd be without
      // the shortcut, briskly. (Where the path itself goes through a building, through
      // a passage, they go through with it.)
      if (this.blocked(nx, ny) && !this.blocked(q.x, q.y)) {
        const on = this.spot(p), bx = on.x - p.x, by = on.y - p.y, bd = Math.hypot(bx, by) || 1;
        const k = Math.min(1, Math.max(step, p.speed * dt * 2) / bd);
        nx = p.x + bx * k;
        ny = p.y + by * k;
      }
      p.x = nx;
      p.y = ny;
    }
    p.pace = dt > 0 ? step / dt : 0;
    // Face where they're going, turning at most TURN a second.
    const want = d > 0.05 ? Math.atan2(dy, dx) : q.ang;
    const off = Math.atan2(Math.sin(want - p.h), Math.cos(want - p.h));
    p.h += clamp(off * Math.min(1, dt * 8), -TURN * dt, TURN * dt);
  }

  // Look a few metres ahead for parked cars and bikes on the path, and pick the nearest
  // way past them (or back into their lane once past).
  avoid(p: Pedestrian, near: Obstructions) {
    const dir = p.fwd ? 1 : -1, q = p.e.path.at(p.s + dir * 1.5), base = p.e.path.at(p.s);
    const ux = Math.cos(q.ang) * dir, uy = Math.sin(q.ang) * dir, nx = Math.sin(q.ang), ny = -Math.cos(q.ang);
    const lane = this.lane(p), now = lane + p.dodge;
    // Across the path, what each thing blocks, and whether it's already alongside.
    const spans: [number, number, boolean][] = [];
    for (const o of near(p.x, p.y, 5)) {
      if (o.kind !== 'car' || !o.car || Math.abs(o.car.vx) + Math.abs(o.car.vy) > 0.5) continue;
      if (o.z !== undefined && p.gz !== undefined && Math.abs(o.z - p.gz) > 3) continue;
      const ax = o.x - base.x, ay = o.y - base.y, along = ax * ux + ay * uy;
      if (along < -o.r - 0.5 || along > 4.5) continue;
      const lat = ax * nx + ay * ny, w = o.r + CLEAR;
      spans.push([lat - w, lat + w, along < o.r + 1]);
    }
    const inside = (v: number) => spans.some(([a, b]) => v > a && v < b);
    const open = (v: number) => {
      for (const k of [1, 2.5]) if (this.blocked(base.x + ux * k + nx * v, base.y + uy * k + ny * v)) return false;
      return true;
    };
    // Not by stepping sideways through whatever they're passing.
    const reach = (v: number) => !spans.some(([a, b, beside]) => beside && b > Math.min(v, now) && a < Math.max(v, now));
    const ok = (v: number) => !inside(v) && open(v) && reach(v);
    if (ok(lane)) { p.dodgeTo = 0; return; }
    // The way round nearest to where they're walking now, so they don't dither.
    let best: number | null = null;
    for (const [a, b] of spans) {
      for (const v of [a - 0.01, b + 0.01]) if (ok(v) && (best === null || Math.abs(v - now) < Math.abs(best - now))) best = v;
    }
    p.dodgeTo = best === null ? p.dodgeTo : best - lane;
  }

  blocked(x: number, y: number) { return this.grid.at(x, y) !== 0; }

  // Someone steps out of a car (a driver who's just been pulled out, say), looking
  // like `look` if given (the rider of a bike you've taken).
  spawnAt(x: number, y: number, look?: Look) {
    const p = this.add(this.nearest(x, y) || undefined);
    p.x = x;
    p.y = y;
    p.then = undefined;
    if (look) {
      p.look = look;
      this.fig.look(p.i, look);
    }
    return p;
  }

  // `seen`: whether a spot is in view; out of it, nobody's walk or fall is animated.
  update(dt: number, threats: Iterable<{ x: number; y: number; vx: number; vy: number }>, near?: Obstructions, seen: (x: number, y: number) => boolean = () => true) {
    const r = this.r;
    // Each walker looks ahead for things in the way a few times a second, not all at once.
    this.tick = (this.tick + 1) % 4;
    for (const p of this.people) {
      p.t -= dt;
      if (p.hurt !== undefined) {
        // Lying there until seen to, or until it's been too long to wait for anyone.
        if (p.state !== 'down' || (p.hurt += dt) > HURT_FOR) this.revive(p);
        else p.t = 5;
      }
      if (p.state === 'walk') {
        // Look out for fast cars heading this way.
        for (const c of threats) {
          const sp = Math.hypot(c.vx, c.vy);
          if (sp < 1.5) continue;
          const dx = p.x - c.x, dy = p.y - c.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 9 + sp * 1.1) continue;
          const ux = c.vx / sp, uy = c.vy / sp;
          const ahead = dx * ux + dy * uy, side = dx * uy - dy * ux;
          if (ahead > -1 && Math.abs(side) < 4) {
            const s = side >= 0 ? 1 : -1;
            p.state = 'flee';
            p.t = 1 + r() * 0.8;
            p.vx = uy * s * 5.5;
            p.vy = -ux * s * 5.5;
            // Too close to just run: they leap out of the way.
            if (dist < 3 + sp * 0.35) p.anim.play('jump', true, 0.08);
            break;
          }
        }
      }
      if (p.state === 'walk') {
        if (p.pause > 0) { p.pause -= dt; }
        else {
          p.s += (p.fwd ? 1 : -1) * p.speed * dt;
          if (p.s < 0 || p.s > p.e.path.length) this.turn(p);
          if (r() < dt * 0.02) p.pause = 1 + r() * 4;
        }
        if (near && p.i % 4 === this.tick) this.avoid(p, near);
        this.follow(p, dt);
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
          } else {
            p.vx = (dx / d) * 1.8;
            p.vy = (dy / d) * 1.8;
          }
        }
        const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
        if (!this.blocked(nx, p.y)) p.x = nx; else p.vx *= -0.3;
        if (!this.blocked(p.x, ny)) p.y = ny; else p.vy *= -0.3;
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
    else locomote(a, dt, p.state === 'walk' ? p.pace : Math.hypot(p.vx, p.vy));
    p.z = a.name === 'jump' ? jumpHeight(a.t, 0.7) : 0;
  }

  turn(p: Pedestrian) {
    const node = p.s > p.e.path.length / 2 ? p.e.v : p.e.u;
    const opts = (this.walk.adj.get(node) || []).filter((o) => o.e !== p.e);
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
  }

  // A gunshot at (x, y): everyone walking within r runs from it.
  scare(x: number, y: number, r: number) {
    for (const p of this.people) {
      if (p.state !== 'walk' && p.state !== 'rejoin') continue;
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
  render(height: (x: number, y: number, p: Pedestrian) => number = () => 0, seen: (x: number, y: number) => boolean = () => true) {
    const m = _m, rain = this.umbrellas.wet > 0;
    let n = 0;
    this.umbrellas.begin();
    for (const p of this.people) {
      if (!seen(p.x, p.y)) continue;
      m.compose(_p.set(p.x, height(p.x, p.y, p) + p.z, -p.y), _q.setFromAxisAngle(UP, p.h), _s);
      this.fig.wear(n, p.i);
      this.fig.set(n, m, p.anim);
      n++;
      // (Dropped by anyone running from a car or knocked over.)
      if (rain && (p.state === 'walk' || p.state === 'rejoin') && this.umbrellas.up(p.serial)) this.umbrellas.put(p.serial, _p, p.h);
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

  constructor(grid: WalkGrid, kit: FigureKit) {
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
    this.fig.look(0, this.look);
    this.fig.mesh.count = 1;
    this.base = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
    this.mesh = new THREE.Group();
    this.mesh.add(this.fig.mesh);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.95, 32),
      new THREE.MeshBasicMaterial({ color: '#ffe08a', transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.mesh.add(this.ring);
  }

  // In the air, high enough for a car to pass under your feet.
  get airborne() { return this.z + this.perch > 0.5; }
  get jumping() { return this.anim.name === 'jump' && !this.anim.done; }

  // The ground and walls as you meet them: on a bridge deck or under it.
  get ground() { return this.grid.view ? this.grid.view(this) : this.grid; }

  blocked(x: number, y: number) {
    const g = this.ground, r = 0.3;
    if (g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r)) return true;
    // A fence or a hedge stops you coming up to it, unless you're jumping (or already in it).
    return this.perch < 0.3 && fences.blocks(x, y, 0.15, this.z) && !fences.blocks(this.x, this.y, 0.15, this.z);
  }

  // `strafe` (first person): left/right step sideways instead of turning.
  update(dt: number, ctl: { turn: number; move: number; run: boolean; jump: boolean; aim?: { h: number; mag: number } | null; strafe?: boolean }) {
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
    if (across && target) { const k = 1 / Math.SQRT2; target *= k; across *= k; }
    this.side += (across - this.side) * Math.min(1, dt * 10);
    if (Math.abs(this.side) < 0.01) this.side = 0;
    const jumping = a.name === 'jump' && !a.done;
    if (ctl.jump && !jumping) a.play('jump', true, 0.06);
    this.speed += (target - this.speed) * Math.min(1, dt * 10);
    const c = Math.cos(this.h), sn = Math.sin(this.h);
    this.vx = c * this.speed - sn * this.side;
    this.vy = sn * this.speed + c * this.side;
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
    this.down = 2.2;
    this.vx = vx;
    this.vy = vy;
    this.h = Math.atan2(vy, vx) + Math.PI;
    this.anim.play('fall', true, 0.08);
  }

  sync() {
    const g = this.ground, ground = g.height ? g.height(this.x, this.y) : 0;
    this.mesh.position.set(this.x, ground + this.perch + this.z, -this.y);
    this.mesh.rotation.set(0, this.h, 0);
    this.ring.position.y = 0.05 - this.z;
    this.fig.set(0, this.base, this.anim);
    this.fig.commit(1);
  }
}
