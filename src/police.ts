import * as telemetry from './telemetry.ts';
import { aim } from './difficulty.ts';
import * as THREE from 'three';
import { Car } from './car.ts';
import { Polyline, clamp } from './network.ts';
import { project, speedLimit, turnOf } from './assist.ts';
import { Figures, Anim, SCALE } from './figures.ts';
import { locomote, knocked } from './people.ts';
import { Helicopters, HELI_SIGHT } from './helicopter.ts';
import type { CarGrid } from './car.ts';
import type { DriveEdge, DriveGraph, WalkEdge, WalkGraph } from './network.ts';
import type { Traffic } from './traffic.ts';
import type { FigureKit } from './figures.ts';
import type { Point2 } from './map/geo.ts';
import type { Point3 } from './guns.ts';

interface ChaseCar extends Follower { car: Car; calm: boolean; wrecked: boolean; gone?: boolean; reload?: number }
// `door`: the one of their car they got out of, left open till they're back. `led`: making
// an arrest, moved by src/arrest.ts.
export interface Officer { x: number; y: number; h: number; vx: number; vy: number; car: Car; fig: Figures; anim: Anim; down: number; back: boolean; gone?: boolean; level?: number; gz?: number; detour?: number; reload?: number; door?: number; led?: boolean }
// A stretch of the way a police car or a fire engine can take: a street, or (`foot`) a
// way meant for people.
type Way = (DriveEdge | WalkEdge) & { mid?: Polyline; twin?: DriveEdge | null };
interface Link { to: string; e: Way; back: boolean; foot: boolean; cost: number }
// Where people walk and an emergency vehicle may drive: pedestrian streets and squares,
// and paths through parks and courtyards wide enough for it. Not steps, footbridges or
// subways.
const FOOT_OK = new Set(['pedestrian', 'footway', 'path', 'track']);
const FOOT_WIDTH = 4; // m (pedestrian streets and squares count whatever width the map gives them)
// The pavement beside a street: only as the few metres from the street into a park, say.
const PAVEMENT_COST = 10;
const FOOT_COST = 3; // a metre there counts as this many by road: the street is taken where there is one
const FOOT_SPEED = 10; // m/s among people
const FOOT_FAR = 15; // m: a footpath is where a way starts or ends only if it's this much nearer than any street (a pavement runs beside every street)
const OTHER_LEVEL = 15; // m: a street on another level than the one wanted counts as this much further
const LEVEL_APART = 3; // m of height between two that are on different levels (as main.ts's `apart`)
// Whether a street is on a level of that kind: in a tunnel (below 0), on a bridge (above), or on the ground.
export const onLevel = (e: { bridge?: boolean; tunnel?: boolean }, level: number) => (level < 0 ? !!e.tunnel : level > 0 ? !!e.bridge : !e.bridge && !e.tunnel);
// (`level`: on the ground 0, in a tunnel below it, on a bridge above it; see TileWorld.track.)
interface PlayerTarget { x: number; y: number; z: number; level: number; vx: number; vy: number; speed: number; car: Car | null; air: boolean; riding: boolean }
interface PoliceOptions {
  scene: THREE.Scene; drive: DriveGraph; traffic: Traffic; grid: CarGrid;
  height: (x: number, y: number, who?: Car | Officer) => number;
  rng: () => number; edgesNear: (x: number, y: number, radius: number) => DriveEdge[];
  // The footpath network, for the ways an emergency vehicle may take through pedestrian zones and parks.
  walk?: WalkGraph; walkNear?: (x: number, y: number, radius: number) => WalkEdge[];
  offscreen: (x: number, y: number) => boolean; onBusted: (by: Officer) => void; kit: FigureKit;
  // Whether a car or a tram (other than `skip`) takes up a circle of radius r at (x, y).
  bodyAt?: (x: number, y: number, r: number, skip: Car | null) => boolean;
  // A shot at the player, from the muzzle to where the bullet went, and whether it hit.
  onShot?: (from: Point3, to: Point3, hit: boolean) => void;
}

// The police and your wanted level, GTA 2 style.
//
// Crimes build up heat, and heat is shown as stars. A crime the police see counts
// three times as much as one somebody phones in: knocking people over, pulling
// drivers out of their cars, wrecking traffic, ramming or stealing a police car.
// Speeding past a police car gets you one star: never up to 10 km/h over the limit, then
// more and more likely, nearly certain at 30 km/h over.
//
// A few police cars patrol with the traffic. Once you're wanted, cars chase you along
// the street network, more of them the more stars you have, and ram you. When you're
// on foot or stopped, an officer gets out and runs after you: if they reach you,
// you're busted. Stay out of their sight for a while and you lose a star at a time.
// From three stars a helicopter joins in (src/helicopter.ts), and the officers draw
// their pistols: they stop where they can see you and shoot rather than run you down.
// From four stars they shoot from the cars as well.

const STARS = [1, 4, 9, 16, 25]; // heat for each star
const CHASERS = [0, 1, 2, 3, 4, 6]; // police cars after you, by stars
const HELIS = [0, 0, 0, 1, 1, 1];
const PATROLS = 3;
const RAMS = [0.15, 0.2, 0.35, 0.5, 0.7, 0.85]; // how many of the cars sent after you carry the ram frame, by stars
const POINTS = { knock: 1, carjack: 1, wreck: 0.6, hitCop: 2, stealCop: 3, stealTram: 1.5, blowUp: 1.5, blowUpCop: 3, fareDodge: 2 };
// What each is called in the statistics (src/telemetry.ts).
const CRIME_NAMES: Record<keyof typeof POINTS, string> = {
  knock: 'knocked someone over', carjack: 'took a car from its driver', wreck: 'wrecked a car', hitCop: 'hit the police',
  stealCop: 'took a police car', stealTram: 'took a tram', blowUp: 'blew up a car', blowUpCop: 'blew up a police car', fareDodge: 'ran from a ticket inspector',
};
const COOLDOWN: Partial<Record<keyof typeof POINTS, number>> = { hitCop: 1 }; // one scrape shouldn't count ten times
const RUN = 6.4; // officers on foot, m/s: you can outrun them, but not walking
const WRECKED = 90; // damage that puts a police car out of the chase
const ARMED = 3; // stars from which officers on foot shoot
const FROM_CARS = 4; // and from which they shoot from the cars
const RANGE = 24; // m; further off they come closer first

// Points of `poly` from s0 to s1 (backwards if s1 < s0), as [x, y].
function slice(poly: Polyline, s0: number, s1: number): Point2[] {
  const a = poly.at(s0), b = poly.at(s1), out: Point2[] = [[a.x, a.y]];
  const { pts, cum } = poly;
  if (s1 >= s0) { for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]); }
  else for (let i = pts.length - 1; i >= 0; i--) if (cum[i] < s0 && cum[i] > s1) out.push(pts[i]);
  out.push([b.x, b.y]);
  return out;
}

// Smallest-first queue of [cost, value] for the route search (the taxis' too).
export class Heap {
  a: [number, string][];
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item: [number, string]) {
    const a = this.a;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length && last) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Walking towards (tx, ty) at `speed`: round the cars and trams in the way, not into
// them: the first way clear a step ahead, turning further and further off the straight
// line, the same side as last time first (so they don't dither). Not `skip`.
export function steer(o: { x: number; y: number; vx: number; vy: number; h: number; detour?: number }, tx: number, ty: number, speed: number,
  bodyAt: (x: number, y: number, r: number, skip: Car | null) => boolean, skip: Car | null, rng: () => number) {
  const dx = tx - o.x, dy = ty - o.y, d = Math.hypot(dx, dy) || 1;
  let ang = Math.atan2(dy, dx);
  const step = Math.min(d, 0.9);
  const clear = (a: number) => !bodyAt(o.x + Math.cos(a) * step, o.y + Math.sin(a) * step, 0.4, skip);
  if (!clear(ang)) {
    const side = o.detour || (rng() < 0.5 ? 1 : -1);
    let found = false;
    for (let k = 1; k <= 5 && !found; k++) {
      for (const sgn of [side, -side]) {
        if (!clear(ang + sgn * k * 0.5)) continue;
        ang += sgn * k * 0.5;
        o.detour = sgn;
        found = true;
        break;
      }
    }
    // (Hemmed in all round: straight on, and the cars push them back out.)
  } else o.detour = 0;
  o.vx = Math.cos(ang) * speed;
  o.vy = Math.sin(ang) * speed;
  o.h = ang;
}

// What a car driving along a route needs to keep track of (police chasing, engines on call).
export interface Follower { path: Polyline | null; s: number; replan: number; stuck: number; reverse: number }

// Where a car on `p.path` should head (a little way ahead along it) and how fast: no
// more than `top` m/s, less for the bends coming up (`bendy` m/s off for a right angle).
// A car that's strayed off the route asks for a new one soon.
export function along(c: Car, p: Follower, path: Polyline, top = 24, bendy = 14) {
  const q = project(path, c.x, c.y, p.s - 10, p.s + 40);
  p.s = q.s;
  // Off the route: a new one soon (still no more than a few times a second).
  if (q.d > 12) p.replan = Math.min(p.replan, 0.3);
  // Slowly where people walk, from a little before.
  // And keeping to the middle through the bends: these ways have house corners where a
  // street has a kerb, and aiming far ahead cuts across them.
  const foot = !!path.foot?.some(([a, b]) => p.s + 15 > a && p.s < b);
  if (foot) top = Math.min(top, FOOT_SPEED);
  const t = path.at(p.s + (foot ? 4 + Math.abs(c.forwardSpeed) * 0.3 : 6 + Math.abs(c.forwardSpeed) * 0.6));
  let bend = 0;
  for (const d of [8, 18, 30]) bend = Math.max(bend, Math.abs(turnOf(c.h, path.at(p.s + d).ang)));
  return { tx: t.x, ty: t.y, want: clamp(top - bend * bendy, foot ? 4 : 7, top) };
}

// Steering and pedals for heading at (tx, ty) at `want` m/s, backing up and trying again
// when stuck.
export function pedals(c: Car, p: Follower, tx: number, ty: number, want: number, dt: number) {
  const vf = c.forwardSpeed;
  let steer = clamp(turnOf(c.h, Math.atan2(ty - c.y, tx - c.x)) * 2.2, -1, 1);
  let throttle = vf < want - 1 ? 1 : vf > want + 2 ? -1 : 0;
  if (throttle > 0 && Math.abs(vf) < 1.2) p.stuck += dt;
  else p.stuck = Math.max(0, p.stuck - dt);
  if (p.stuck > 1.2) { p.reverse = 1.1; p.stuck = 0; }
  if (p.reverse > 0) {
    p.reverse -= dt;
    throttle = -1;
    steer = -steer;
  }
  return { throttle, steer };
}

export class Police {
  scene: THREE.Scene; drive: DriveGraph; traffic: Traffic; grid: CarGrid;
  r: () => number; edgesNear: PoliceOptions['edgesNear']; offscreen: PoliceOptions['offscreen'];
  onBusted: (by: Officer) => void; kit: FigureKit; bodyAt: NonNullable<PoliceOptions['bodyAt']>;
  height: PoliceOptions['height']; onShot: NonNullable<PoliceOptions['onShot']>;
  spare: Figures[]; helis: Helicopters; heat: number; cars: ChaseCar[]; officers: Officer[];
  seen: boolean; lose: number; cool: Record<string, number>; spawnT: number; checkT: number; limit: number;
  nodes: Map<string, Point2>; links: Map<string, Link[]>; linked: number; walked = 0;
  paths: WalkGraph | null; walkNear: NonNullable<PoliceOptions['walkNear']>;
  lastT?: number; stolen: WeakSet<Car>;
  // An arrest is being made (src/arrest.ts): nobody shoots, the other officers stand round.
  arresting = false;

  constructor({ scene, drive, traffic, grid, height, rng, edgesNear, walk = undefined, walkNear = () => [], offscreen, onBusted, kit, bodyAt = () => false, onShot = () => {} }: PoliceOptions) {
    this.scene = scene; this.drive = drive; this.traffic = traffic; this.grid = grid;
    this.r = rng; this.edgesNear = edgesNear; this.offscreen = offscreen;
    this.paths = walk ?? null; this.walkNear = walkNear;
    this.onBusted = onBusted; this.kit = kit; this.bodyAt = bodyAt;
    this.height = height; this.onShot = onShot;
    this.spare = []; // figures of officers who've gone, to reuse
    this.helis = new Helicopters(scene, height);
    this.heat = 0;
    this.cars = []; // chasing: { car, path, s, replan, stuck, reverse, calm, wrecked }
    this.officers = [];
    this.seen = false; // the police can see you right now
    this.lose = 0; // seconds out of sight
    this.cool = {};
    this.stolen = new WeakSet(); // police cars you've taken
    this.spawnT = 0;
    this.checkT = 0;
    this.limit = 50;
    // Street network for chasing, both ways along every street (the police ignore one-way signs).
    this.nodes = new Map();
    this.links = new Map();
    this.linked = 0;
  }

  get stars() { return STARS.filter((t) => this.heat >= t).length; }

  // Police cars that are after you, not wrecked or given up.
  get chasing() { return this.cars.filter((p) => !p.calm && !p.wrecked); }

  // Everyone who can spot you: patrols, chasing cars and officers on foot.
  *eyes() {
    for (const a of this.traffic.agents) if (a.car.type === 'police') yield a.car;
    for (const p of this.cars) if (!p.wrecked) yield p.car;
    for (const o of this.officers) if (o.down <= 0) yield o;
    yield* this.helis.watching;
  }

  // Whether a police car or an officer is on your level (not on the road over the
  // tunnel you're in, or under the bridge you're on).
  level(who: Car | Officer, me: PlayerTarget) {
    return Math.abs(this.height(who.x, who.y, who) - me.z) < LEVEL_APART;
  }

  clear(ax: number, ay: number, bx: number, by: number) {
    const d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / 2);
    for (let i = 1; i < n; i++) if (this.grid.at(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n) === 255) return false;
    return true;
  }

  sees(x: number, y: number, far = 110) {
    for (const e of this.eyes()) {
      const d = Math.hypot(e.x - x, e.y - y);
      if ('air' in e && e.air) { if (d < HELI_SIGHT) return true; continue; }
      if (d < 40 || (d < far && this.clear(e.x, e.y, x, y))) return true;
    }
    return false;
  }

  // `car`: the police car that was hit, if any; its crew gets out and comes after you,
  // wrecked or not.
  crime(kind: keyof typeof POINTS, x: number, y: number, car?: Car) {
    if (kind === 'hitCop' && car?.crew) {
      this.getOut(car);
      // A patrol riding along with the traffic has no one to drive it once its officer is
      // out (the traffic would carry on with an empty car, the door open): it joins the
      // chase cars, which wait for their officers.
      const ride = this.traffic.agents.find((a) => a.car === car);
      if (ride) {
        this.traffic.release(ride);
        car.mode = 'police';
        this.cars.push({ car, path: null, s: 0, replan: 0, stuck: 0, reverse: 0, calm: false, wrecked: false });
      }
    }
    if (this.cool[kind] > 0) return;
    telemetry.did(`crime: ${CRIME_NAMES[kind]}`);
    this.cool[kind] = COOLDOWN[kind] || 0;
    const seen = this.sees(x, y);
    this.heat = Math.min(40, this.heat + POINTS[kind] * (seen ? 1.5 : 0.5));
    if (seen) this.lose = 0;
  }

  // You got into a police car, with its crew or one they've left to come after you on
  // foot: whoever was in it gets out and comes after you, and the car is yours, out of
  // the chase. Stealing it is a crime once; getting back into it later isn't another.
  take(car: Car) {
    const i = this.cars.findIndex((p) => p.car === car);
    if (i >= 0) this.cars.splice(i, 1);
    if (car.crew) this.getOut(car);
    if (this.stolen.has(car)) return;
    this.stolen.add(car);
    this.crime('stealCop', car.x, car.y);
  }

  knock(o: Officer, vx: number, vy: number) {
    Object.assign(o, { down: 3, vx, vy, h: Math.atan2(vy, vx) + Math.PI });
    o.anim.play('fall', true, 0.08);
  }

  dismiss(o: Officer) {
    this.scene.remove(o.fig.mesh);
    this.spare.push(o.fig);
  }

  // Dev teleport: the chase doesn't follow you across town.
  reset() {
    for (const o of this.officers) this.dismiss(o);
    this.officers = [];
    this.cars = [];
    this.helis.reset();
  }

  // ---- Street network ----------------------------------------------------

  // Links the streets and paths learnt since the last time. (The graphs keep their
  // edges in the order they learnt them and number them, so the new ones are at the
  // end whatever has been taken out since.)
  sync() {
    const edges = this.drive.edges;
    let i = edges.length;
    while (i > 0 && edges[i - 1].n > this.linked) i--;
    for (; i < edges.length; i++) {
      const e = edges[i];
      e.mid = e.mid || new Polyline(e.pts);
      this.nodes.set(e.u, e.pts[0]);
      this.nodes.set(e.v, e.pts[e.pts.length - 1]);
      this.link(e, false);
    }
    this.linked = this.drive.count;
    const paths = this.paths?.edges ?? [];
    i = paths.length;
    while (i > 0 && paths[i - 1].n > this.walked) i--;
    const walked = this.paths?.count ?? 0;
    for (; i < paths.length; i++) {
      const e = paths[i];
      if (!this.drivable(e)) continue;
      (e as Way).mid = e.path;
      this.nodes.set(e.u, e.pts[0]);
      this.nodes.set(e.v, e.pts[e.pts.length - 1]);
      this.link(e, true, this.pavement(e) ? PAVEMENT_COST : FOOT_COST);
    }
    this.walked = walked;
  }

  // Streets and paths that have left the graphs (their tiles are far behind) leave the
  // chase network too.
  forget(edges: Way[]) {
    for (const e of edges) {
      for (const n of e.u === e.v ? [e.u] : [e.u, e.v]) {
        const list = this.links.get(n);
        if (!list) continue;
        const left = list.filter((l) => l.e !== e);
        if (left.length) this.links.set(n, left);
        else { this.links.delete(n); this.nodes.delete(n); }
      }
    }
  }

  link(e: Way, foot: boolean, cost = 1) {
    for (const [a, b, back] of [[e.u, e.v, false], [e.v, e.u, true]] as [string, string, boolean][]) {
      if (!this.links.has(a)) this.links.set(a, []);
      this.links.get(a)!.push({ to: b, e, back, foot, cost });
    }
  }

  // Whether a footpath is the pavement of a street: it runs along one, a few metres off.
  pavement(e: WalkEdge) {
    if (e.hw === 'pedestrian') return false;
    let beside = 0;
    for (const k of [0.25, 0.5, 0.75]) {
      const p = e.path.at(e.path.length * k), st = this.nearestStreet(p.x, p.y, 9);
      if (st && Math.abs(Math.cos(st.e.mid.at(st.s).ang - p.ang)) > 0.8) beside++;
    }
    return beside >= 2;
  }

  // Whether a police car or a fire engine may take this footpath. (The streets people
  // walk along are in the footpath network too, under other names: those it has already.)
  drivable(e: WalkEdge) {
    return FOOT_OK.has(e.hw) && !e.bridge && !e.tunnel && (e.hw === 'pedestrian' || e.width >= FOOT_WIDTH);
  }

  nearestStreet(x: number, y: number, radius = 40): { e: DriveEdge & { mid: Polyline }; s: number; d: number } | null {
    return this.nearestWay(x, y, radius, false) as { e: DriveEdge & { mid: Polyline }; s: number; d: number } | null;
  }

  // The same, with (`foot`) the footpaths an emergency vehicle may take. With a
  // `level`, a street on another one (the road over a tunnel you're in) counts only if
  // nothing on yours is much nearer.
  nearestWay(x: number, y: number, radius: number, foot: boolean, level?: number) {
    let best: { e: Way & { mid: Polyline }; s: number; d: number; foot: boolean } | null = null;
    for (const e of this.edgesNear(x, y, radius)) {
      e.mid = e.mid || new Polyline(e.pts);
      const p = project(e.mid, x, y), d = p.d + (level !== undefined && !onLevel(e, level) ? OTHER_LEVEL : 0);
      if (p.d < radius && (!best || d < best.d)) best = { e: e as DriveEdge & { mid: Polyline }, s: p.s, d, foot: false };
    }
    if (foot) for (const e of this.walkNear(x, y, radius)) {
      if (!this.drivable(e) || this.pavement(e)) continue;
      const p = project(e.path, x, y), d = p.d + FOOT_FAR;
      if (p.d < radius && (!best || d < best.d)) best = { e: Object.assign(e, { mid: e.path }), s: p.s, d, foot: true };
    }
    return best;
  }

  // Where a police car stops for you on foot: in the traffic lane nearest you, the
  // side of the street you're on. The lanes keep clear of the parked cars, so the car
  // doesn't drive over them (or up on the pavement) to get to you. A street on
  // another level than yours (a bridge or a tunnel, when you're on the ground; the
  // street above, when you're in the tunnel) counts only if nothing else is much nearer.
  roadside(x: number, y: number, foot = true, level = 0) {
    let best: { x: number; y: number } | null = null, bestD = 80;
    for (const e of this.edgesNear(x, y, 80)) {
      const q = project(e.path, x, y), d = q.d + (onLevel(e, level) ? 0 : OTHER_LEVEL);
      if (d >= bestD) continue;
      const p = e.path.at(q.s);
      best = { x: p.x, y: p.y };
      bestD = d;
    }
    // In a pedestrian zone or a park: on the path through it, if that's nearer than any street.
    if (foot && !level) for (const e of this.walkNear(x, y, 80)) {
      if (!this.drivable(e)) continue;
      const q = project(e.path, x, y);
      if (q.d + FOOT_FAR >= bestD || this.pavement(e)) continue;
      const p = e.path.at(q.s);
      best = { x: p.x, y: p.y };
      bestD = q.d + FOOT_FAR;
    }
    return best;
  }

  // Shortest way from (ax, ay) to (bx, by), as a Polyline, or null: by road, and where
  // there's none, through pedestrian zones and parks (police cars and fire engines
  // may). If the paths lead nowhere, by road as near as it gets.
  // (`foot` false: by road only. `levels`: those of the start and the end, so a way to
  // someone in a tunnel ends in the tunnel, not on the street above it.)
  route(ax: number, ay: number, bx: number, by: number, foot = true, levels?: [number, number]): Polyline | null {
    this.sync();
    return (foot && this.way(ax, ay, bx, by, true, levels)) || this.way(ax, ay, bx, by, false, levels);
  }

  way(ax: number, ay: number, bx: number, by: number, foot: boolean, levels?: [number, number]): Polyline | null {
    const A = this.nearestWay(ax, ay, 40, foot, levels?.[0]), B = this.nearestWay(bx, by, 40, foot, levels?.[1]);
    if (!A || !B) return null;
    const lenA = A.e.mid.length, lenB = B.e.mid.length;
    let pts: Point2[];
    // The stretches on footpaths, as ranges of `pts`.
    const spans: [number, number][] = [];
    const add = (more: Point2[], onFoot: boolean) => {
      if (onFoot && more.length) spans.push([pts.length, pts.length + more.length - 1]);
      pts.push(...more);
    };
    if (A.e === B.e || A.e.twin === B.e) {
      const sb = A.e === B.e ? B.s : lenA - B.s;
      pts = [];
      add(slice(A.e.mid, A.s, sb), A.foot);
    } else {
      const goal = new Map<string, number>([[B.e.u, B.s], [B.e.v, lenB - B.s]]);
      const [gx, gy] = [bx, by];
      const g = new Map<string, number>(), from = new Map<string, Link>(), heap = new Heap();
      for (const [n, cost] of [[A.e.u, A.s], [A.e.v, lenA - A.s]] as [string, number][]) {
        g.set(n, cost);
        heap.push([cost, n]);
      }
      let end: string | null = null;
      for (let pops = 0, most = foot ? 20000 : 6000; heap.size && pops < most; pops++) { // (the footpaths are a much finer net)
        const item = heap.pop();
        if (!item) break;
        const [f, n] = item;
        const gn = g.get(n);
        const node = this.nodes.get(n);
        if (gn === undefined || !node) continue;
        const [nx, ny] = node;
        if (f > gn + Math.hypot(gx - nx, gy - ny) + 1e-6) continue; // stale entry
        if (goal.has(n)) { end = n; break; }
        for (const l of this.links.get(n) || []) {
          if (l.foot && !foot) continue;
          const c = gn + (l.e.mid?.length ?? 0) * l.cost;
          if (c >= (g.get(l.to) ?? Infinity)) continue;
          g.set(l.to, c);
          from.set(l.to, l);
          const next = this.nodes.get(l.to);
          if (!next) continue;
          const [tx, ty] = next;
          heap.push([c + Math.hypot(gx - tx, gy - ty), l.to]);
        }
      }
      if (end === null) return null;
      const chain: Link[] = [];
      let first = end;
      for (let l = from.get(end); l; l = from.get(first)) { chain.unshift(l); first = l.back ? l.e.v : l.e.u; }
      pts = [];
      add(slice(A.e.mid, A.s, first === A.e.u ? 0 : lenA), A.foot);
      for (const l of chain) add(l.back ? [...l.e.pts].reverse() : l.e.pts, l.foot);
      add(slice(B.e.mid, end === B.e.u ? 0 : lenB, B.s), B.foot);
    }
    const path = new Polyline([[ax, ay], ...pts, [bx, by]]);
    // (One point was put in front of `pts`.)
    if (spans.length) path.foot = spans.map(([i, j]) => [path.cum[i + 1], path.cum[j + 1]]);
    return path;
  }

  // ---- Cars --------------------------------------------------------------

  // A new police car on a street out of view, 90–250 m from (x, y).
  spawn(x: number, y: number) {
    const edges = this.edgesNear(x, y, 250);
    for (let t = 0; t < 30 && edges.length; t++) {
      const e = edges[Math.floor(this.r() * edges.length)];
      if (e.bridge || e.tunnel || e.path.length < 12) continue;
      const q = e.path.at(this.r() * e.path.length), d = Math.hypot(q.x - x, q.y - y);
      if (d < 90 || d > 250 || !this.offscreen(q.x, q.y)) continue;
      const car = new Car('police', this.r, q.x, q.y, q.ang);
      if (car.worldSamples().some(([sx, sy]) => this.grid.at(sx, sy))) continue;
      if (this.r() < RAMS[this.stars]) car.armour();
      this.enlist(car);
      return true;
    }
    return false;
  }

  enlist(car: Car) {
    car.mode = 'police';
    car.crew = true;
    this.cars.push({ car, path: null, s: 0, replan: 0, stuck: 0, reverse: 0, calm: false, wrecked: false });
  }

  // Steering and pedals for a car chasing the player.
  chase(p: ChaseCar, dt: number, me: PlayerTarget) {
    const c = p.car, vf = c.forwardSpeed;
    const dx = me.x - c.x, dy = me.y - c.y, dist = Math.hypot(dx, dy);
    // (Not on the street over the tunnel you're in, nor in the tunnel under you.)
    const level = this.level(c, me);
    let tx, ty, want;
    if (me.car && dist < 40 && level && this.clear(c.x, c.y, me.x, me.y)) {
      // In sight and you're driving: straight at you, to ram you.
      tx = me.x + me.vx * Math.min(0.8, dist / 25);
      ty = me.y + me.vy * Math.min(0.8, dist / 25);
      want = Math.max(12, me.speed + 6);
    } else {
      p.replan -= dt;
      // Where there's no way through (you're somewhere the street graph doesn't reach,
      // or it isn't loaded yet) it heads straight for you and tries again on the timer,
      // not every frame: a search that fails has looked at thousands of streets. On
      // foot the way ends at the roadside nearest you, and the car doesn't look for a
      // new one while its officer is out.
      if (c.crew && (p.replan < 0 || (me.car && p.path && p.s > p.path.length - 6))) {
        const to = me.car ? null : this.roadside(me.x, me.y, true, me.level);
        p.path = this.route(c.x, c.y, to ? to.x : me.x, to ? to.y : me.y, true, [c.level ?? 0, me.level]);
        p.s = 0;
        p.replan = 1.2 + this.r() * 0.8;
      }
      if (!p.path) { tx = me.x; ty = me.y; want = 8; }
      else {
        ({ tx, ty, want } = along(c, p, p.path));
        // On foot: slow down for the end of the way and stop there.
        if (!me.car) want = Math.min(want, clamp((p.path.length - p.s - 4) * 0.9, 0, 24));
      }
      // And stop short of you, should you be out in the road.
      if (!me.car) want = Math.min(want, dist < 12 ? 0 : clamp((dist - 10) * 0.8, 3, 24));
    }
    // Another police car got there first and stands just ahead: stop behind it, not
    // squeeze past it over the parked cars.
    const behind = !me.car && dist < 60 && this.cars.some((q) => q !== p && q.car.speed < 2
      && Math.hypot(q.car.x - c.x, q.car.y - c.y) < 9 && (q.car.x - c.x) * Math.cos(c.h) + (q.car.y - c.y) * Math.sin(c.h) > 0);
    if (behind) want = 0;
    // An officer out on foot: the car waits.
    if (!c.crew) want = 0;
    // Through a red light with care.
    if (!p.calm && this.traffic.signals?.against(c.x, c.y, c.h, 22)) want = Math.min(want, 5);
    const { throttle, steer } = pedals(c, p, tx, ty, want, dt);
    // Close enough and you're not going anywhere: an officer gets out.
    // On foot, also once the car has got as near as the road goes: the officer runs
    // the rest of the way.
    const there = behind || (!me.car && dist < 60 && !!p.path && p.path.length - p.s < 8);
    if (c.crew && !me.air && level && Math.abs(vf) < 2.5 && (me.car ? me.speed < 2 && dist < 14 : dist < 18 || there)) this.getOut(c);
    // Near you and in sight, from four stars: a shot out of the window now and then.
    p.reload = (p.reload ?? 1) - dt;
    if (c.crew && this.stars >= FROM_CARS && !me.air && level && dist < RANGE && p.reload <= 0 && this.clear(c.x, c.y, me.x, me.y)) {
      p.reload = this.pace() + 1;
      this.shoot(c.x, c.y, c, me);
    }
    return { throttle, steer, handbrake: want === 0 && Math.abs(vf) < 3 };
  }

  // ---- Guns ----------------------------------------------------------------

  // Seconds to the next shot: quicker with more stars.
  pace() { return (this.stars >= 5 ? 0.5 : this.stars >= 4 ? 0.7 : 0.9) + this.r() * 0.5; }

  // A shot at you from (x, y). It's likelier to hit close up, with more stars, and when
  // you're standing still, and with the difficulty; a miss goes past you, a little to one side.
  shoot(x: number, y: number, who: Car | Officer, me: PlayerTarget) {
    if (this.arresting) return;
    const d = Math.hypot(me.x - x, me.y - y) || 1, ux = (me.x - x) / d, uy = (me.y - y) / d;
    const k = aim(), odds = clamp((0.5 + 0.07 * (this.stars - ARMED) - d / 60 - me.speed * 0.03) * k, 0.08 * k, 0.9);
    const hit = this.r() < odds;
    const from: Point3 = [x + ux * 0.6, y + uy * 0.6, this.height(x, y, who) + (who instanceof Car ? who.spec.H + 0.1 : 1.3)];
    const z = me.z + (me.car ? me.car.spec.H * 0.7 : 1.1);
    let to: Point3 = [me.x, me.y, z];
    if (!hit) {
      const a = Math.atan2(uy, ux) + (this.r() - 0.5) * 0.3, far = d + 4 + this.r() * 8;
      to = [x + Math.cos(a) * far, y + Math.sin(a) * far, z - this.r()];
    }
    this.onShot(from, to, hit);
  }

  // ---- Officers on foot --------------------------------------------------

  getOut(car: Car) {
    car.crew = false;
    const lx = -Math.sin(car.h), ly = Math.cos(car.h);
    let x = car.x + lx * (car.spec.W / 2 + 0.7), y = car.y + ly * (car.spec.W / 2 + 0.7), door = 1;
    // Out of the other door if a wall or another car is on this side.
    if (this.grid.at(x, y) || this.bodyAt(x, y, 0.4, car)) { x = car.x - lx * (car.spec.W / 2 + 0.7); y = car.y - ly * (car.spec.W / 2 + 0.7); door = 2; }
    // (It stays open till they're back.)
    car.open(door);
    let fig = this.spare.pop();
    if (!fig) {
      fig = new Figures(this.kit, 1);
      fig.look(0, { shirt: '#1f3a68', trousers: '#1a2438', skin: '#e3b99a', hair: '#15233f', sleeves: true });
    }
    this.scene.add(fig.mesh);
    // On the car's level: out of a car in a tunnel, in the tunnel (not on the street above).
    this.officers.push({ x, y, h: car.h, vx: 0, vy: 0, car, fig, anim: new Anim(this.kit, 'idle'), down: 0, back: false, door, level: car.level, gz: car.gz });
  }

  blocked(x: number, y: number) {
    const g = this.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  walk(o: Officer, dt: number, me: PlayerTarget) {
    if (o.led) return;
    if (o.down > 0) {
      o.down -= dt;
      const k = Math.exp(-4 * dt);
      o.vx *= k;
      o.vy *= k;
    } else {
      const ride = this.cars.find((p) => p.car === o.car && !p.wrecked);
      // Back to the car when you drive off (or the chase is over); after you otherwise.
      const toMe = Math.hypot(me.x - o.x, me.y - o.y);
      o.back = this.heat <= 0 || !!(ride && me.car && me.speed > 6 && toMe > 12);
      // You in a car: they make for the nearer of its front doors, not for its middle
      // (which they can't get near from the front or the back).
      let gx = me.x, gy = me.y, door = Infinity;
      for (const d of me.car?.doors ?? []) {
        if (d.n > 2) continue;
        const [x, y] = me.car!.beside(d, 0.9), far = Math.hypot(x - o.x, y - o.y);
        if (far < door && !this.blocked(x, y)) { door = far; gx = x; gy = y; }
      }
      // Armed, in range and in sight: they stand and shoot. Closer in they still come to
      // arrest you.
      o.reload = (o.reload ?? 0.5 + this.r() * 0.6) - dt;
      const level = this.level(o, me);
      const aiming = !o.back && !this.arresting && this.stars >= ARMED && !me.air && level && toMe > 5 && toMe < RANGE && this.clear(o.x, o.y, me.x, me.y);
      if (this.arresting && !o.back) {
        // Someone else has you: come up and stand by.
        if (toMe > 3.4) steer(o, me.x, me.y, RUN, this.bodyAt, null, this.r);
        else { o.vx = o.vy = 0; o.h = Math.atan2(me.y - o.y, me.x - o.x); }
      } else if (aiming) {
        o.vx = o.vy = 0;
        o.h = Math.atan2(me.y - o.y, me.x - o.x);
        if (o.reload <= 0) { o.reload = this.pace(); this.shoot(o.x, o.y, o, me); }
      } else {
        // No car to go back to: they walk off.
        const tx = !o.back ? gx : ride ? o.car.x : 2 * o.x - me.x, ty = !o.back ? gy : ride ? o.car.y : 2 * o.y - me.y;
        const d = Math.hypot(tx - o.x, ty - o.y) || 1;
        steer(o, tx, ty, o.back && !ride ? 1.4 : RUN, this.bodyAt, o.back ? o.car : null, this.r);
        if (o.back && ride && d < 2.6) { o.gone = true; o.car.crew = true; if (o.door) o.car.open(o.door, false); return; }
        if (!o.back && this.heat > 0 && !me.air && level) {
          const reach = me.car ? me.car.spec.L / 2 + 1 : 1.1;
          if ((toMe < reach || door < 0.8) && (!me.car || me.speed < 2)) this.onBusted(o);
        }
      }
    }
    const nx = o.x + o.vx * dt, ny = o.y + o.vy * dt;
    if (!this.blocked(nx, o.y)) o.x = nx;
    if (!this.blocked(o.x, ny)) o.y = ny;
    if (o.down > 0) knocked(o.anim, dt, o.down);
    else locomote(o.anim, dt, Math.hypot(o.vx, o.vy));
    if (o.back && !this.cars.some((p) => p.car === o.car) && this.offscreen(o.x, o.y)) o.gone = true;
  }

  // ---- Every frame -------------------------------------------------------

  // `me`: { x, y, vx, vy, speed, car, air, riding } for the player (car is null on
  // foot; air while flying a helicopter or riding a tram, out of the officers' reach).
  update(dt: number, me: PlayerTarget) {
    for (const k in this.cool) this.cool[k] -= dt;
    const stars = this.stars;

    // Patrols ride along with the traffic.
    const patrols = this.traffic.agents.filter((a) => a.car.type === 'police');
    for (const a of patrols) a.car.crew = true;
    this.spawnT -= dt;
    if (patrols.length < PATROLS && this.spawnT < 0) {
      this.spawnT = 2;
      const patrol = this.traffic.spawn((x, y) => {
        const d = Math.hypot(x - me.x, y - me.y);
        return d > 80 && d < 320 && this.offscreen(x, y);
      }, this.edgesNear(me.x, me.y, 320), 'police');
      if (patrol && this.r() < RAMS[0]) patrol.car.armour();
    }

    // Speeding past the police.
    this.checkT -= dt;
    if (this.checkT < 0) {
      this.checkT = 0.5;
      if (me.car) this.limit = speedLimit(this.nearestStreet(me.x, me.y)?.e);
      // Up to 10 km/h over the limit is never noticed. From there the chance at each check
      // (twice a second, and police see you for a few seconds) grows steeply: about 6% of
      // passes at 15 over, 40% at 20, most at 25, nearly all at 30.
      const over = me.speed * 3.6 - this.limit;
      if (me.car && over > 10 && this.r() < 0.5 * ((over - 10) / 20) ** 3 && this.sees(me.x, me.y, 60)) this.heat = Math.max(this.heat, STARS[0]);
    }

    // Out of sight long enough, you lose a star.
    this.seen = stars > 0 && this.sees(me.x, me.y);
    if (stars === 0 || this.seen) this.lose = 0;
    else if ((this.lose += dt * (me.riding ? 2 : 1)) > 8 + 3 * stars) { // faster on a tram
      this.heat = stars >= 2 ? STARS[stars - 2] : 0;
      this.lose = 0;
    }

    // As many cars on your tail as your stars call for: patrols nearby join in first.
    const want = CHASERS[this.stars];
    let chasing = this.chasing;
    for (const a of patrols) {
      if (chasing.length >= want) break;
      if (Math.hypot(a.car.x - me.x, a.car.y - me.y) > 250) continue;
      this.traffic.release(a);
      this.enlist(a.car);
      chasing = this.chasing;
    }
    if (chasing.length < want && this.spawnT < 0) {
      this.spawnT = 1.5;
      this.spawn(me.x, me.y);
    }
    if (chasing.length > want) {
      const far = [...chasing].sort((a, b) => Math.hypot(b.car.x - me.x, b.car.y - me.y) - Math.hypot(a.car.x - me.x, a.car.y - me.y));
      for (const p of far.slice(0, chasing.length - want)) p.calm = true;
    }

    for (const p of this.cars) {
      const c = p.car;
      if (!p.wrecked && c.damage > WRECKED) p.wrecked = true;
      let ctl = null;
      if (!p.wrecked && !p.calm) ctl = this.chase(p, dt, me);
      else if (!p.wrecked) ctl = { throttle: c.forwardSpeed > 0.3 ? -1 : 0, steer: 0, handbrake: false };
      if (p.wrecked) c.mode = 'loose';
      c.update(dt, ctl, this.grid);
      const d = Math.hypot(c.x - me.x, c.y - me.y);
      const waiting = this.officers.some((o) => o.car === c);
      p.gone = !waiting && this.offscreen(c.x, c.y) && (p.calm || p.wrecked ? d > 120 : d > 450);
      // Once its officers are back aboard, a car that has given up pulls out into the traffic
      // instead of standing in the lane.
      if (!p.gone && p.calm && !p.wrecked && !waiting && c.crew && Math.abs(c.forwardSpeed) < 0.5 && this.rejoin(c)) p.gone = true;
    }
    this.cars = this.cars.filter((p) => !p.gone);

    this.helis.update(dt, me, HELIS[this.stars]);
    for (const o of this.officers) this.walk(o, dt, me);
    for (const o of this.officers) if (o.gone) this.dismiss(o);
    this.officers = this.officers.filter((o) => !o.gone);
  }

  // Hands a stopped police car to the traffic, on the lane that's nearest and runs most the way
  // it's facing (it stopped wherever the chase ended, often at an angle; if it's facing
  // against a one-way street it turns round in the lane).
  rejoin(car: Car) {
    let best: { e: DriveEdge; s: number; score: number } | null = null;
    for (const e of this.edgesNear(car.x, car.y, 15)) {
      const q = project(e.path, car.x, car.y), cos = Math.cos(car.h - e.path.at(q.s).ang);
      const score = q.d + 8 * (1 - cos);
      if (q.d > 12 || (best && score >= best.score)) continue;
      best = { e, s: q.s, score };
    }
    if (!best) return false;
    this.traffic.adopt(car, best.e, best.s, 0);
    return true;
  }

  // After an arrest: the stars go, the officers go back to their cars.
  forgive() {
    this.heat = 0;
    this.lose = 0;
    for (const p of this.cars) p.calm = true;
  }

  // The cars with their lights going: those chasing you, and a police car you're driving,
  // including while stopped. Ownership, not speed, keeps its lights on.
  // (`mine`: the car the player is driving).
  lit(mine: Car | null = null) {
    const lit = this.cars.filter((p) => !p.calm && !p.wrecked).map((p) => p.car);
    if (mine?.type === 'police' && mine.mode === 'player' && !mine.burnt && !lit.includes(mine)) lit.push(mine);
    return lit;
  }

  render(height: (x: number, y: number, who: Car | Officer) => number, time: number) {
    this.helis.render(time, time - (this.lastT ?? time));
    this.lastT = time;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(SCALE, SCALE, SCALE);
    for (const o of this.officers) {
      m.compose(p.set(o.x, height(o.x, o.y, o), -o.y), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, o.h), sc);
      o.fig.set(0, m, o.anim);
      o.fig.commit(1);
    }
  }
}
