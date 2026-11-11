// Street graphs from pipeline/build_tiles.py: a directed car network with lanes
// offset to the right, and an undirected pedestrian network.

import type { Point2 } from './map/geo.ts';
import { laneLevels } from './roadLevels.ts';

export interface RawStreetEdge {
  id: string;
  u: string;
  v: string;
  hw: string;
  name?: string | null;
  pts: Point2[];
  width: number;
  lanes?: number | null;
  oneway?: boolean;
  maxspeed?: number | null;
  bridge?: boolean;
  tunnel?: boolean;
  // On a bridge or in a tunnel: the level it's on (pipeline/structures.py, OnLevels; not in older maps).
  level?: number;
  // Where it changes level along itself (several ways joined into one edge): [metres
  // from its start, the level from there on], the first from 0. Mostly absent.
  levels?: [number, number][];
  surface?: string;
  park?: [ParkingOrientation | null, ParkingOrientation | null];
  kerb?: [number | null, number | null];
}

export type ParkingOrientation = 'parallel' | 'diagonal' | 'perpendicular' | 'no';

export interface DriveEdge extends RawStreetEdge {
  laneOffset: number;
  laneLevels?: [number, number][]; // map level changes expressed along the offset lane
  path: Polyline;
  speed: number;
  twin?: DriveEdge | null;
  busy?: number;
  mid?: Polyline;
  // How many loaded tiles carry the edge (see remove), and its number in the order
  // the graph learnt its edges.
  refs: number;
  n: number;
}

export interface WalkEdge extends RawStreetEdge {
  path: Polyline;
  side: number;
  busy?: number;
  refs: number;
  n: number;
}

export interface PathPoint { x: number; y: number; ang: number }
type Random = () => number;
interface RouteLeg { path: Polyline; s0: number; s1: number; edge: DriveEdge | null; turn?: number; speed?: number }

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Polyline {
  pts: Point2[];
  cum: number[];
  angs: number[]; // each segment's heading (made once: at() runs for every walker every step)
  length: number;
  // On a route worked out for a police car or a fire engine: the stretches (from, to, in
  // metres along it) that go where people walk, taken slowly.
  foot?: [number, number][];

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

  at(s: number): PathPoint {
    s = clamp(s, 0, this.length);
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

// Shift a polyline sideways; positive d = to the right of the direction of travel.
export function offsetLine(pts: Point2[], d: number): Point2[] {
  if (!d) return pts;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] + ((b[1] - a[1]) / len) * d, p[1] - ((b[0] - a[0]) / len) * d];
  });
}

function bezier(a: Point2, c: Point2, b: Point2, n = 8): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

const CLASS_SPEED: Record<string, number> = {
  motorway: 22, trunk: 17, primary: 14, secondary: 13, tertiary: 12,
  motorway_link: 12, trunk_link: 11, primary_link: 10, secondary_link: 9, tertiary_link: 9,
  residential: 9, unclassified: 9, living_street: 5, service: 5,
};

// How much traffic a street of each class gets, against a residential street (1):
// the main roads carry most of the cars in Prague, and living streets and service
// roads hardly any. (Only ever a lean: cars still reach the small streets.)
export const ROAD_WEIGHT: Record<string, number> = {
  motorway: 3, trunk: 3, primary: 3, secondary: 2.5, tertiary: 2,
  motorway_link: 2, trunk_link: 2, primary_link: 2, secondary_link: 2, tertiary_link: 1.5,
  residential: 1, unclassified: 1, living_street: 0.3, service: 0.3,
};
export const roadWeight = (hw: string) => ROAD_WEIGHT[hw] ?? 1;

// How much street for cars lies within r metres of a point, against what a district
// of the city has within 330 m (about 10 km of lanes, a main road counting for more:
// ROAD_WEIGHT): 1 in town, a third on a main road between fields, a tenth on a lane.
// Past the built map the traffic is thinned by this (main.ts), or a village lane would
// carry the cars of a city district.
const CITY_STREETS = 10000;
export function streetShare(edges: Iterable<{ hw: string; pts: Point2[] }>, x: number, y: number, r: number): number {
  let sum = 0;
  for (const e of edges) {
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1];
      if (Math.hypot((ax + bx) / 2 - x, (ay + by) / 2 - y) <= r) sum += Math.hypot(bx - ax, by - ay) * roadWeight(e.hw);
    }
  }
  return Math.min(1, sum / CITY_STREETS);
}

// Where traffic drives, right of the street's centre line: the outer lane on two-way
// streets, the middle (or right of middle) lane on one-way ones.
// Under this a two-way street is one lane wide: cars keep to their right as far as a
// car's width allows and pass each other slowly, instead of the lane offset pushing
// them out over the verge.
export const SINGLE_LANE = 4.6;
const SINGLE_LANE_SPEED = 5;
// The driving width: OSM's, or less where the surveyed kerbs (kerbs.py) stand closer
// together than that (Pod křížkem is mapped 8 m wide between kerbs 5 m apart).
// Kerbs further apart than OSM's width take in a parking lane or a bay, so they don't widen it.
const carriageway = (e: RawStreetEdge) =>
  e.kerb?.[0] != null && e.kerb[1] != null ? Math.min(e.width, e.kerb[0] + e.kerb[1]) : e.width;
const narrow = (e: RawStreetEdge) => !e.oneway && carriageway(e) < SINGLE_LANE;

function laneOffset(e: RawStreetEdge) {
  const n = e.lanes || 0, W = carriageway(e);
  let off;
  if (narrow(e)) off = Math.max(0.5, W / 2 - 0.95);
  else if (e.oneway) {
    const lanes = Math.max(1, n || 1), lw = W / lanes;
    off = W / 2 - lw * (Math.floor((lanes - 1) / 2) + 0.5);
  } else {
    const per = Math.max(1, Math.floor(Math.max(2, n || 2) / 2)), lw = W / (2 * per);
    off = clamp(lw * (per - 0.5), 1.6, W / 2 - 1);
  }
  // A car's side stays off the kerb on the right, wherever OSM puts the street's middle.
  return e.kerb?.[0] != null ? Math.min(off, Math.max(0.5, e.kerb[0] - 1)) : off;
}

// Takes the edges in `gone` out of `edges` where it stands (others hold the array), in order.
function without<T>(edges: T[], gone: T[]) {
  if (!gone.length) return;
  const dead = new Set(gone);
  let n = 0;
  for (const e of edges) if (!dead.has(e)) edges[n++] = e;
  edges.length = n;
}

// The car network, filled in as tiles arrive and thinned again as they fall far behind.
// Edges are keyed by id and joined at shared (OSM) node ids; `out` lists the edges
// leaving each node. `edges` stays in the order they were learnt (rising `n`).
export class DriveGraph {
  byId: Map<string, DriveEdge>;
  out: Map<string, DriveEdge[]>;
  edges: DriveEdge[];
  count = 0; // edges learnt so far: the `n` of the newest

  constructor() {
    this.byId = new Map();
    this.out = new Map();
    this.edges = [];
  }

  // Adds raw edges; returns the graph's own edge objects (new or already known).
  add(list: RawStreetEdge[]): DriveEdge[] {
    return list.map((raw) => {
      const known = this.byId.get(raw.id);
      if (known) { known.refs++; return known; }
      const e = { ...raw, refs: 1, n: ++this.count } as DriveEdge;
      e.laneOffset = laneOffset(e);
      e.path = new Polyline(offsetLine(e.pts, e.laneOffset));
      if (e.levels?.length) e.laneLevels = laneLevels(e, e.path);
      e.speed = e.maxspeed ? Math.min(e.maxspeed / 3.6, CLASS_SPEED[e.hw] || 9) : CLASS_SPEED[e.hw] || 9;
      if (narrow(e)) e.speed = Math.min(e.speed, SINGLE_LANE_SPEED);
      this.byId.set(e.id, e);
      this.edges.push(e);
      if (!this.out.has(e.u)) this.out.set(e.u, []);
      this.out.get(e.u)!.push(e);
      e.twin = (this.out.get(e.v) || []).find((f) => f.v === e.u) || null;
      if (e.twin && !e.twin.twin) e.twin.twin = e;
      return e;
    });
  }

  // A tile's edges (as add() returned them) when the tile is far behind: those no
  // other tile carries leave the graph. Returns the ones that left. They keep their
  // own fields, so a car still on one drives to its end, where the street stops as it
  // does at the edge of what has loaded.
  remove(list: DriveEdge[]): DriveEdge[] {
    const gone: DriveEdge[] = [];
    for (const e of list) {
      if (this.byId.get(e.id) !== e || --e.refs > 0) continue;
      this.byId.delete(e.id);
      const out = this.out.get(e.u);
      if (out) {
        const i = out.indexOf(e);
        if (i >= 0) out.splice(i, 1);
        if (!out.length) this.out.delete(e.u);
      }
      const t = e.twin;
      if (t && t.twin === e) t.twin = (this.out.get(t.v) || []).find((f) => f.v === t.u) || null;
      gone.push(e);
    }
    without(this.edges, gone);
    return gone;
  }
}

// Next edge after `e`: anything but a U-turn, unless the street is a dead end.
// Null where the network isn't loaded (the far side of the map).
// With `main`, it keeps to the main roads where it can (a bus).
// With `lean`, it merely favours the bigger road (an ordinary car): the square root
// of the road's weight, so a main road wins more often but every turn stays possible.
export function nextEdge(g: DriveGraph, e: DriveEdge, r: Random, main = false, lean = false): DriveEdge | null {
  const all = g.out.get(e.v) || [];
  let opts = all.filter((f) => f !== e.twin);
  if (main && opts.some((f) => MAIN_ROADS.has(f.hw))) opts = opts.filter((f) => MAIN_ROADS.has(f.hw));
  const list = opts.length ? opts : all;
  if (!list.length) return null;
  if (!lean) return list[Math.floor(r() * list.length)];
  const w = list.map((f) => Math.sqrt(roadWeight(f.hw)));
  let x = r() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < list.length; i++) if ((x -= w[i]) < 0) return list[i];
  return list[list.length - 1];
}

// The streets buses keep to.
export const MAIN_ROADS = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'busway']);

// A route is a chain of legs: the lane of each edge, trimmed at both ends, and a
// short curve through each junction so turns are smooth.
export class Route {
  g: DriveGraph;
  r: Random;
  legs: RouteLeg[];
  s: number;
  dead = false;
  ended = false;
  main: boolean;
  // Leans towards the bigger road at junctions (see nextEdge).
  lean: boolean;
  // Which street to take after `e` (a bus on its line, see buses.ts); null: any.
  pick?: (e: DriveEdge, opts: DriveEdge[]) => DriveEdge | null;
  // The edges to take next, in order, instead of random turns (a taxi on a job). The
  // route simply stops growing when they run out.
  plan: DriveEdge[] | null = null;

  constructor(g: DriveGraph, edge: DriveEdge, s: number, r: Random, main = false, pick?: (e: DriveEdge, opts: DriveEdge[]) => DriveEdge | null, lean = false) {
    this.g = g;
    this.r = r;
    this.main = main;
    this.lean = lean;
    this.pick = pick;
    this.legs = [{ path: edge.path, s0: 0, s1: edge.path.length, edge }];
    this.s = s;
    this.extend();
  }

  get leg() { return this.legs[0]; }

  extend() {
    while (!this.dead && this.legs.filter((l) => l.edge).length < 4) {
      const last = this.legs[this.legs.length - 1];
      const e = last.edge;
      if (!e) return;
      const f = this.plan ? this.plan.shift() ?? null : this.pick?.(e, (this.g.out.get(e.v) || []).filter((o) => o !== e.twin)) || nextEdge(this.g, e, this.r, this.main, this.lean);
      if (!f) { if (!this.plan) this.dead = true; return; }
      // (A bus starts its turns further back, so they're wider and its back doesn't
      // swing over the kerb.)
      const trim = junctionTrim(e, f, this.main);
      last.s1 = Math.max(last.s0, e.path.length - trim);
      const a = e.path.at(last.s1), b = f.path.at(trim);
      const turn = Math.abs(Math.atan2(Math.sin(b.ang - a.ang), Math.cos(b.ang - a.ang)));
      const conn = junctionCurve(a, b);
      this.legs.push({ path: conn, s0: 0, s1: conn.length, edge: null, turn, speed: Math.min(e.speed, f.speed) });
      this.legs.push({ path: f.path, s0: trim, s1: f.path.length, edge: f });
    }
  }

  // The edge being driven along, or the next one while crossing a junction.
  get head(): DriveEdge {
    const leg = this.legs.find((l) => l.edge);
    if (!leg?.edge) throw new Error('A route always has an edge ahead');
    return leg.edge;
  }

  // Follow `plan` (edges leading on from `head`) from the end of the head edge, or
  // random turns again with null.
  follow(plan: DriveEdge[] | null) {
    const i = this.legs.findIndex((l) => l.edge);
    this.legs.length = i + 1;
    this.legs[i].s1 = this.head.path.length;
    this.plan = plan;
    this.dead = false;
    this.extend();
  }

  // Metres along the route to `s` on `edge`; Infinity if it isn't on the route yet.
  to(edge: DriveEdge, s: number) {
    let d = 0, from = this.s;
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      if (leg.edge === edge && s >= from - 0.5) return d + s - from;
      d += leg.s1 - from;
      from = this.legs[i + 1]?.s0 ?? 0;
    }
    return Infinity;
  }

  // Advance by ds metres; returns the current point.
  advance(ds: number) {
    this.s += ds;
    while (this.s > this.leg.s1) {
      if (this.legs.length === 1) { this.s = this.leg.s1; this.ended = true; break; }
      const over = this.s - this.leg.s1;
      this.legs.shift();
      this.s = this.leg.s0 + over;
      this.extend();
    }
    return this.leg.path.at(this.s);
  }

  // The lane from `back` metres behind to `fwd` metres ahead as straight pieces, five
  // numbers each in `out`: both ends (x, y) and how far ahead the first one is. Returns
  // how many pieces. (For telling what stands in the lane round a bend from what stands
  // beside it.)
  ahead(back: number, fwd: number, out: number[]): number {
    let n = 0, d = -Math.min(back, this.s);
    for (let li = 0; li < this.legs.length && d < fwd; li++) {
      const leg = this.legs[li], { pts, cum } = leg.path;
      const from = li === 0 ? this.s + d : leg.s0, to = Math.min(leg.s1, from + fwd - d);
      let lo = 1, hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < cum.length && cum[i - 1] < to; i++) {
        const a = pts[i - 1], b = pts[i], len = cum[i] - cum[i - 1];
        if (len < 1e-6) continue;
        const t0 = Math.max(0, (from - cum[i - 1]) / len), t1 = Math.min(1, (to - cum[i - 1]) / len);
        if (t1 <= t0) continue;
        const k = n++ * 5;
        out[k] = a[0] + (b[0] - a[0]) * t0;
        out[k + 1] = a[1] + (b[1] - a[1]) * t0;
        out[k + 2] = a[0] + (b[0] - a[0]) * t1;
        out[k + 3] = a[1] + (b[1] - a[1]) * t1;
        out[k + 4] = d + cum[i - 1] + t0 * len - from;
      }
      d += Math.max(0, to - from);
    }
    return n;
  }

  // Point `d` metres ahead along the route, and the lowest speed limit on the way there.
  lookahead(d: number) {
    let s = this.s, limit = Infinity;
    for (const leg of this.legs) {
      limit = Math.min(limit, leg.edge ? leg.edge.speed : leg.speed ?? Infinity, !leg.edge && (leg.turn ?? 0) > 1.1 ? 4.5 : !leg.edge && (leg.turn ?? 0) > 0.5 ? 7 : Infinity);
      if (s + d <= leg.s1) return { p: leg.path.at(s + d), limit };
      d -= leg.s1 - s;
      s = leg === this.legs[this.legs.length - 1] ? leg.s1 : this.legs[this.legs.indexOf(leg) + 1].s0;
    }
    const last = this.legs[this.legs.length - 1];
    return { p: last.path.at(last.s1), limit };
  }
}

// Shared by routes and parking clearance: reserve the curve traffic actually takes.
export const junctionTrim = (e: DriveEdge, f: DriveEdge, main = false) => Math.min(main ? 11 : 7, e.path.length / 3, f.path.length / 3);
export const junctionCurve = (a: PathPoint, b: PathPoint) => new Polyline(bezier([a.x, a.y], corner(a, b), [b.x, b.y]));

// Where the incoming and outgoing lanes would cross; the midpoint when they're parallel.
function corner(a: PathPoint, b: PathPoint): Point2 {
  const dax = Math.cos(a.ang), day = Math.sin(a.ang), dbx = Math.cos(b.ang), dby = Math.sin(b.ang);
  const den = dax * dby - day * dbx;
  const mid: Point2 = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  if (Math.abs(den) < 0.2) return mid;
  const t = ((b.x - a.x) * dby - (b.y - a.y) * dbx) / den;
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  if (t < 0 || t > gap * 1.5) return mid;
  return [a.x + dax * t, a.y + day * t];
}

// The footpath network, filled in as tiles arrive (edges are undirected).
const ROADLIKE = new Set(['residential', 'tertiary', 'secondary', 'primary', 'service', 'unclassified', 'living_street', 'busway']);
// Main roads nobody strolls along (the Magistrála is only a `primary` road in the map,
// with no ban on foot): people use the pavements and crossings mapped beside them.
const NO_STROLLING = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'motorway', 'motorway_link']);
export class WalkGraph {
  byId: Map<string, WalkEdge>;
  adj: Map<string, { e: WalkEdge; fwd: boolean }[]>;
  edges: WalkEdge[];
  fresh: WalkEdge[] = [];
  count = 0;

  constructor() {
    this.byId = new Map();
    this.adj = new Map();
    this.edges = [];
  }

  add(list: RawStreetEdge[]): WalkEdge[] {
    const fresh: WalkEdge[] = [];
    const res = list.filter((raw) => !NO_STROLLING.has(raw.hw)).map((raw) => {
      const known = this.byId.get(raw.id);
      if (known) { known.refs++; return known; }
      const e: WalkEdge = { ...raw, path: new Polyline(raw.pts), side: 0, refs: 1, n: ++this.count };
      // Streets without a separately mapped pavement: people keep to the edge.
      e.side = ROADLIKE.has(e.hw) ? Math.max(0, e.width / 2 - 0.9) : 0;
      this.byId.set(e.id, e);
      this.edges.push(e);
      for (const [n, fwd] of [[e.u, true], [e.v, false]] as [string, boolean][]) {
        if (!this.adj.has(n)) this.adj.set(n, []);
        this.adj.get(n)!.push({ e, fwd });
      }
      fresh.push(e);
      return e;
    });
    this.fresh = fresh;
    return res;
  }

  // As DriveGraph.remove.
  remove(list: WalkEdge[]): WalkEdge[] {
    const gone: WalkEdge[] = [];
    for (const e of list) {
      if (this.byId.get(e.id) !== e || --e.refs > 0) continue;
      this.byId.delete(e.id);
      for (const n of e.u === e.v ? [e.u] : [e.u, e.v]) {
        const left = (this.adj.get(n) || []).filter((o) => o.e !== e);
        if (left.length) this.adj.set(n, left);
        else this.adj.delete(n);
      }
      gone.push(e);
    }
    without(this.edges, gone);
    return gone;
  }
}

// Spatial hash of named street segments, for the "you are on …" label.
export class StreetNames {
  cell: number;
  map: Map<string, { a: Point2; b: Point2; name: string; rank: number; e: RawStreetEdge }[]>;
  seen: Set<RawStreetEdge>;

  constructor(...edgeLists: RawStreetEdge[][]) {
    this.cell = 20;
    this.map = new Map();
    this.seen = new Set();
    for (const list of edgeLists) this.add(list);
  }

  add(list: RawStreetEdge[]) {
    for (const e of list) {
      if (this.seen.has(e)) continue;
      this.seen.add(e);
      if (!e.name) continue;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const seg = { a, b, name: e.name, rank: e.hw === 'footway' || e.hw === 'steps' ? 1 : 0, e };
        for (const key of this.cells(a, b)) {
          if (!this.map.has(key)) this.map.set(key, []);
          this.map.get(key)!.push(seg);
        }
      }
    }
  }

  // Edges that have left the graphs (their tiles are far behind).
  remove(list: RawStreetEdge[]) {
    for (const e of list) {
      if (!this.seen.delete(e) || !e.name) continue;
      const keys = new Set<string>();
      for (let i = 0; i < e.pts.length - 1; i++) for (const key of this.cells(e.pts[i], e.pts[i + 1])) keys.add(key);
      for (const key of keys) {
        const left = (this.map.get(key) || []).filter((s) => s.e !== e);
        if (left.length) this.map.set(key, left);
        else this.map.delete(key);
      }
    }
  }

  // The cells a segment passes through.
  private cells(a: Point2, b: Point2) {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / this.cell) + 1;
    const keys = new Set<string>();
    for (let k = 0; k <= n; k++) keys.add(this.key(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
    return keys;
  }

  key(x: number, y: number) { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }

  at(x: number, y: number, maxD = 14) {
    let best: string | null = null, bestD = maxD;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const s of this.map.get(`${cx + i},${cy + j}`) || []) {
          const d = segDist(x, y, s.a, s.b) + s.rank * 4;
          if (d < bestD) { bestD = d; best = s.name; }
        }
      }
    }
    return best;
  }
}

export function segDist(x: number, y: number, a: Point2, b: Point2) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

// Everything that moves or blocks, bucketed in 10 m cells (keyed by number: cell
// i * 2^17 + j, unique while |j| < 2^16 cells, far beyond any area).
export class SpatialHash<T extends { x: number; y: number }> {
  cell: number;
  map: Map<number, T[]>;

  constructor(cell = 10) { this.cell = cell; this.map = new Map(); }
  clear() { this.map.clear(); }
  add(o: T) {
    const k = Math.floor(o.x / this.cell) * 131072 + Math.floor(o.y / this.cell);
    let b = this.map.get(k);
    if (!b) this.map.set(k, (b = []));
    b.push(o);
  }
  // Everything in the cells within r of (x, y), added to `out`. (An array rather than
  // a generator: this runs thousands of times a frame.)
  near(x: number, y: number, r: number, out: T[] = []): T[] {
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const b = this.map.get(i * 131072 + j);
      if (b) for (let k = 0; k < b.length; k++) out.push(b[k]);
    }
    return out;
  }
}
