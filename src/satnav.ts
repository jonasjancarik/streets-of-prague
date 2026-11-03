import * as THREE from 'three';
import { Heap } from './police.ts';
import { Polyline, junctionCurve, junctionTrim } from './network.ts';
import { project, turnOf } from './assist.ts';
import { t } from './i18n.ts';
import type { DriveEdge, DriveGraph } from './network.ts';
import type { Marker } from './marker.ts';
import type { Point2 } from './map/geo.ts';

// Driving directions: to a spot picked on the map (N, or the map button in the corner;
// startmap.ts), or else to where the job wants you. The quickest way by car, along
// one-way streets, as far as the streets have loaded (worked out again as more of them
// arrive and whenever you leave it), painted on the road ahead, with the next turn in
// the HUD. Holding Shift, the lane assist takes its turns (`next`).

const CRUISE = 4.5; // m/s as the crow flies across town (the streets wind, and stop at junctions): a guess for the part of the way that hasn't loaded yet
const QUICK = 17; // m/s, for how near the search looks to be (a fast town street: a motorway is faster, but the search gets slow if it allows for one everywhere)
const U_TURN = 30, TURN = 3; // s added for turning back, and for a turn (fewer turns)
const OFF = 14; // m off the line before the way is worked out again
const ARRIVE = 25; // m from a picked spot that counts as there
const WIDTH = 2, STEP = 2.5, CHEVRON = 3; // the line on the road: m wide, sampled every m, one arrow per m
const PICKED = '#6cc4ff', JOB = '#5ee6a8'; // the line's colour to a spot you picked (the pin's too), and to the job's (its marker's)

export type TurnKind = 'left' | 'right' | 'keep-left' | 'keep-right' | 'back';
export interface Turn { at: number; kind: TurnKind; onto: string | null }
export interface Way {
  edges: DriveEdge[];
  // Along the lanes from where the car is; `lv`: the level (ground, bridge, tunnel) of each point.
  line: Polyline;
  lv: number[];
  turns: Turn[];
  // It ends at the goal, not merely as near to it as the loaded streets go.
  reached: boolean;
}
export interface Goal { x: number; y: number; name: string }
interface Driver { x: number; y: number; h: number }

const levelOf = (e: DriveEdge, s: number) => {
  let l = e.level ?? 0;
  for (const [m, v] of e.levels ?? []) if (m <= s) l = v;
  return l;
};

// The lane a car at (x, y) heading `h` is driving in: near it and running its way.
export function startOn(near: DriveEdge[], x: number, y: number, h: number) {
  let best: { e: DriveEdge; s: number } | null = null, score = Infinity;
  for (const e of near) {
    const p = project(e.path, x, y);
    if (p.d > 25) continue;
    const sc = p.d + Math.abs(turnOf(h, p.ang)) * 6; // facing the wrong way is as bad as 19 m off
    if (sc < score) { score = sc; best = { e, s: p.s }; }
  }
  return best;
}

// The turn from `e` into `f` worth telling: null where the way simply goes on.
export function turnAt(g: DriveGraph, e: DriveEdge, f: DriveEdge): TurnKind | null {
  if (f === e.twin) return 'back';
  const opts = (g.out.get(e.v) || []).filter((o) => o !== e.twin);
  if (opts.length <= 1) return null;
  const end = e.path.at(e.path.length).ang, ang = (o: DriveEdge) => turnOf(end, o.path.at(Math.min(8, o.path.length)).ang);
  const tf = ang(f);
  if (Math.abs(tf) >= 0.6) return tf > 0 ? 'left' : 'right';
  const straight = opts.reduce((a, b) => (Math.abs(ang(b)) < Math.abs(ang(a)) ? b : a));
  if (straight === f) return null;
  return tf > ang(straight) ? 'keep-left' : 'keep-right';
}

// (By the headings of the lanes' last and first pieces: this runs for every street the search looks at.)
const endAng = (e: DriveEdge) => e.path.angs[e.path.angs.length - 1], startAng = (e: DriveEdge) => e.path.angs[Math.min(1, e.path.angs.length - 1)];
const turnCost = (from: DriveEdge, end: number, to: DriveEdge) => (to === from.twin ? U_TURN : Math.abs(turnOf(end, startAng(to))) > 0.6 ? TURN : 0);

// The quickest way by car from `from` to `goal` (A* by time on the directed street graph),
// or, where the goal's streets haven't loaded or can't be reached, the way to the loaded
// street end that looks quickest from there on. Null where there's no street to start on.
export function findWay(g: DriveGraph, near: (x: number, y: number, r: number) => DriveEdge[], from: Driver, goal: { x: number; y: number }): Way | null {
  const start = startOn(near(from.x, from.y, 30), from.x, from.y, from.h);
  if (!start) return null;
  const ends = near(goal.x, goal.y, 200).map((e) => ({ e, ...project(e.path, goal.x, goal.y) }));
  const d0 = Math.min(...ends.map((f) => f.d));
  const byNode = new Map<string, { e: DriveEdge; s: number }[]>();
  let best: { cost: number; node: string | null; e: DriveEdge; s: number } | null = null;
  for (const f of d0 < 200 ? ends.filter((f) => f.d <= d0 + 12) : []) {
    if (f.e === start.e && f.s >= start.s) {
      const cost = (f.s - start.s) / f.e.speed;
      if (!best || cost < best.cost) best = { cost, node: null, e: f.e, s: f.s };
    }
    if (!byNode.has(f.e.u)) byNode.set(f.e.u, []);
    byNode.get(f.e.u)!.push(f);
  }
  const [gx, gy] = [goal.x, goal.y];
  const cost = new Map<string, number>(), guess = new Map<string, number>(), prev = new Map<string, DriveEdge>(), open = new Heap();
  const reach = (e: DriveEdge, c: number) => {
    const [x, y] = e.pts[e.pts.length - 1], h = Math.hypot(gx - x, gy - y);
    cost.set(e.v, c); guess.set(e.v, h / QUICK);
    open.push([c + h / QUICK, e.v]);
    return c + h / CRUISE;
  };
  let edge = { node: start.e.v, score: reach(start.e, (start.e.path.length - start.s) / start.e.speed) };
  for (let pops = 0; open.size && pops < 40000; pops++) {
    const [f, n] = open.pop();
    const c = cost.get(n)!;
    if (f > c + guess.get(n)! + 1e-6) continue; // stale
    if (best && f >= best.cost) break;
    // With the goal's streets not loaded: nothing further out can look quicker.
    if (!byNode.size && f >= edge.score) break;
    const last = prev.get(n) ?? start.e, end = endAng(last);
    for (const to of byNode.get(n) ?? []) {
      const tc = c + to.s / to.e.speed + turnCost(last, end, to.e);
      if (!best || tc < best.cost) best = { cost: tc, node: n, e: to.e, s: to.s };
    }
    for (const e of g.out.get(n) || []) {
      const nc = c + e.path.length / e.speed + turnCost(last, end, e);
      if (nc >= (cost.get(e.v) ?? Infinity)) continue;
      prev.set(e.v, e);
      const score = reach(e, nc);
      if (score < edge.score) edge = { node: e.v, score };
    }
  }
  const chain = (n: string) => {
    const out: DriveEdge[] = [];
    for (let k = n; k !== start.e.v;) {
      const e = prev.get(k);
      if (!e || out.length > 5000) break;
      out.unshift(e);
      k = e.u;
    }
    return [start.e, ...out];
  };
  if (best) {
    const edges = best.node === null ? [start.e] : [...chain(best.node), best.e];
    return lay(g, edges, start.s, best.s, true);
  }
  const edges = chain(edge.node);
  return lay(g, edges, start.s, edges[edges.length - 1].path.length, false);
}

// The way along the lanes of `edges`, from `s0` on the first to `s1` on the last, with a
// curve through each junction as the traffic takes it (network.ts, Route).
function lay(g: DriveGraph, edges: DriveEdge[], s0: number, s1: number, reached: boolean): Way {
  const pts: Point2[] = [], lv: number[] = [], joins: number[] = [];
  const put = (x: number, y: number, level: number) => {
    const q = pts[pts.length - 1];
    if (q && Math.abs(q[0] - x) < 1e-3 && Math.abs(q[1] - y) < 1e-3) return;
    pts.push([x, y]);
    lv.push(level);
  };
  let from = s0;
  edges.forEach((e, i) => {
    const f = edges[i + 1], p = e.path;
    const trim = f ? junctionTrim(e, f) : 0, to = Math.max(from, f ? p.length - trim : s1);
    const a = p.at(from);
    put(a.x, a.y, levelOf(e, from));
    for (let k = 0; k < p.pts.length; k++) if (p.cum[k] > from && p.cum[k] < to) put(p.pts[k][0], p.pts[k][1], levelOf(e, p.cum[k]));
    const b = p.at(to);
    put(b.x, b.y, levelOf(e, to));
    if (!f) return;
    joins.push(pts.length - 1);
    for (const [x, y] of junctionCurve(b, f.path.at(trim)).pts) put(x, y, levelOf(e, to));
    from = trim;
  });
  if (pts.length < 2) { const q = pts[0] ?? [0, 0]; put(q[0] + 0.01, q[1], lv[0] ?? 0); }
  const line = new Polyline(pts), turns: Turn[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const kind = turnAt(g, edges[i], edges[i + 1]);
    if (!kind) continue;
    const at = line.cum[Math.min(joins[i], line.cum.length - 1)], last = turns[turns.length - 1];
    if (last && last.kind === kind && at - last.at < 25) continue; // across a divided road: one turn
    const onto = edges[i + 1].name ?? null;
    turns.push({ at, kind, onto: onto && onto !== edges[i].name ? onto : null });
  }
  return { edges, line, lv, turns, reached };
}

// A strip of arrows, for the line on the road.
function chevrons() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 32;
  const x = c.getContext('2d')!;
  x.fillStyle = 'rgba(255,255,255,0.45)';
  x.fillRect(0, 4, 64, 24);
  x.fillStyle = '#fff';
  x.beginPath();
  x.moveTo(18, 4); x.lineTo(34, 4); x.lineTo(50, 16); x.lineTo(34, 28); x.lineTo(18, 28); x.lineTo(34, 16);
  x.closePath();
  x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const far = (d: number) => (d < 1000 ? `${Math.max(10, Math.round(d / 10) * 10)} m` : `${(d / 1000).toFixed(1)} km`);
const ARROWS: Record<TurnKind | 'on' | 'end', string> = { left: '↰', right: '↱', 'keep-left': '↖', 'keep-right': '↗', back: '↶', on: '↑', end: '◎' };
const SAY: Record<TurnKind, string> = { left: 'Turn left', right: 'Turn right', 'keep-left': 'Keep left', 'keep-right': 'Keep right', back: 'Turn round' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' } as Record<string, string>)[c]};`);

export class Satnav {
  // The spot picked on the map; while there's none, the job's.
  goal: Goal | null = null;
  way: Way | null = null;
  s = 0; // metres along the way's line to where the car is
  private job: { x: number; y: number } | null = null;
  private quiet = false; // told to stop showing the way to the job's spot (until the job moves on)
  private planned: { x: number; y: number } | null = null;
  private off = 0;
  private wait = 0;
  private age = 0; // s since the way was worked out
  private learnt = 0;
  private mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private at = -1;
  private driving = false;
  private here = false; // at the job's spot: the job takes over

  constructor(scene: THREE.Scene, private g: DriveGraph, private near: (x: number, y: number, r: number) => DriveEdge[],
    private height: (x: number, y: number, level: number) => number, private pin: Marker, private say: (text: string) => void) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
      map: chevrons(), color: PICKED, transparent: true, opacity: 0.85, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  // What the way leads to now.
  get target(): (Goal & { job: boolean }) | null {
    if (this.goal) return { ...this.goal, job: false };
    return this.job && !this.quiet ? { ...this.job, name: '', job: true } : null;
  }

  pick(goal: Goal | null) {
    this.goal = goal;
    if (!goal && this.job) this.quiet = true; // "stop navigating" stops the job's directions too
    this.drop();
  }

  // The street after `e` on the way, for the lane assist.
  next(e: DriveEdge) {
    const w = this.way;
    if (!w || !this.mesh.visible) return null;
    const i = w.edges.indexOf(e);
    return i >= 0 ? w.edges[i + 1] ?? null : null;
  }

  private drop() {
    this.way = this.planned = null;
    this.s = this.off = this.wait = 0;
    this.mesh.visible = false;
  }

  // Once a frame: `car`, what you're driving (null on foot); `job`, where the job wants you.
  update(dt: number, car: Driver | null, me: { x: number; y: number }, job: { x: number; y: number } | null) {
    const moved = job && this.job ? Math.hypot(job.x - this.job.x, job.y - this.job.y) > 5 : job !== this.job;
    if (moved) { this.job = job; this.quiet = false; this.here = false; }
    if (this.goal) this.pin.show(this.goal.x, this.goal.y); else this.pin.hide();
    this.pin.update(dt, me);
    const arrows = this.mesh.material.map!;
    arrows.offset.x = (arrows.offset.x - dt * 0.9) % 1; // the arrows creep along the way
    const to = this.target;
    this.driving = !!car;
    if (to && Math.hypot(to.x - me.x, to.y - me.y) < ARRIVE) {
      if (!to.job) { this.say(t('You have arrived')); this.goal = null; }
      else this.here = true;
      this.drop();
      return;
    }
    if (to?.job && this.here && Math.hypot(to.x - me.x, to.y - me.y) > ARRIVE * 2.5) this.here = false; // drove off again
    if (!to || !car || (to.job && this.here)) { this.drop(); return; }
    this.mesh.material.color.set(to.job ? JOB : PICKED);
    const w = this.way;
    if (w) {
      const p = project(w.line, car.x, car.y, this.s - 20, this.s + 60);
      if (p.d < OFF) { this.s = p.s; this.off = 0; } else this.off += dt;
    }
    this.wait -= dt;
    this.age += dt;
    const left = w ? w.line.length - this.s : 0;
    // A way that ends where the loaded streets do: worked out again as more come in, soon
    // once its end is near, and every few seconds before that.
    const stale = !w || this.off > 1.2 || !this.planned || Math.hypot(to.x - this.planned.x, to.y - this.planned.y) > 5
      || (!w.reached && (left < 40 || (this.g.count !== this.learnt && (left < 300 || this.age > 3))));
    if (stale && this.wait <= 0) this.plan(car, to);
    this.place();
  }

  private plan(car: Driver, to: { x: number; y: number }) {
    this.way = findWay(this.g, this.near, car, to);
    this.planned = { x: to.x, y: to.y };
    this.learnt = this.g.count;
    this.s = this.off = this.age = 0;
    this.wait = this.way ? 1 : 2;
    this.at = -1;
    if (this.way) this.build(this.way);
  }

  // The line on the road, sampled along the way, a little above whatever it runs on.
  private build(w: Way) {
    const { line, lv } = w, n = Math.max(2, Math.ceil(line.length / STEP) + 1);
    const pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), index: number[] = [];
    let seg = 1;
    for (let i = 0; i < n; i++) {
      const d = Math.min(line.length, i * STEP), p = line.at(d);
      while (seg < line.cum.length - 1 && line.cum[seg] < d) seg++;
      const h = this.height(p.x, p.y, lv[seg - 1]) + 0.25;
      const nx = -Math.sin(p.ang) * WIDTH / 2, ny = Math.cos(p.ang) * WIDTH / 2;
      pos.set([p.x + nx, h, -(p.y + ny), p.x - nx, h, -(p.y - ny)], i * 6);
      uv.set([d / CHEVRON, 1, d / CHEVRON, 0], i * 4);
      if (i) index.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(index);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  // From a few metres ahead of the car to the end.
  private place() {
    const w = this.way;
    this.mesh.visible = !!w;
    if (!w) return;
    const from = Math.floor((this.s + 3) / STEP);
    if (from === this.at) return;
    this.at = from;
    const total = this.mesh.geometry.index?.count ?? 0;
    this.mesh.geometry.setDrawRange(Math.min(total, from * 6), Math.max(0, total - from * 6));
  }

  // The card in the HUD, as HTML ('' when there's nothing to say).
  card() {
    const to = this.target;
    if (!to || (to.job && (this.here || !this.driving))) return '';
    const name = to.name ? `<div class="nav-to">${esc(to.name)}</div>` : '';
    const head = (arrow: string, text: string, d = '') => `<div class="nav-turn"><i>${arrow}</i><span>${text}</span>${d ? `<b>${d}</b>` : ''}</div>`;
    if (!this.driving) return head(ARROWS.end, t('Get in a car to see the way')) + name;
    const w = this.way;
    if (!w) return head(ARROWS.end, t('Drive onto a street to see the way')) + name;
    const next = w.turns.find((turn) => turn.at > this.s - 2);
    const rest = w.reached ? w.line.length - this.s : null;
    const total = rest !== null ? `<div class="nav-left">${t('{distance} to go', { distance: far(rest) })}</div>` : '';
    if (next) return head(ARROWS[next.kind], t(SAY[next.kind]), far(next.at - this.s)) + (next.onto ? `<div class="nav-onto">${esc(next.onto)}</div>` : '') + name + total;
    if (rest !== null) return head(ARROWS.end, t('Destination ahead'), far(rest)) + name;
    return head(ARROWS.on, t('Keep going')) + name;
  }

  // For the test API.
  probe() {
    const w = this.way, to = this.target;
    return {
      to: to ? { x: Math.round(to.x), y: Math.round(to.y), name: to.name, job: to.job } : null,
      shown: this.mesh.visible, reached: w?.reached ?? false, length: w ? Math.round(w.line.length) : 0, along: Math.round(this.s),
      streets: w ? w.edges.length : 0, turns: w ? w.turns.map((x) => ({ at: Math.round(x.at), kind: x.kind, onto: x.onto })) : [],
    };
  }
}
