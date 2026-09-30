import * as THREE from 'three';
import { Car } from './car.ts';
import { Polyline, clamp } from './network.ts';
import { project, speedLimit, turnOf } from './assist.ts';
import { Figures, Anim, SCALE } from './figures.ts';
import { locomote, knocked } from './people.ts';
import { Helicopters, HELI_SIGHT } from './helicopter.ts';
import type { CarGrid } from './car.ts';
import type { DriveEdge, DriveGraph } from './network.ts';
import type { Traffic } from './traffic.ts';
import type { FigureKit } from './figures.ts';
import type { Point2 } from './map/geo.ts';
import type { Point3 } from './guns.ts';
import { sendInstances } from './gpu.ts';

interface ChaseCar { car: Car; path: Polyline | null; s: number; replan: number; stuck: number; reverse: number; calm: boolean; wrecked: boolean; gone?: boolean; reload?: number }
interface Officer { x: number; y: number; h: number; vx: number; vy: number; car: Car; fig: Figures; anim: Anim; down: number; back: boolean; gone?: boolean; gz?: number; detour?: number; reload?: number }
interface Link { to: string; e: DriveEdge; back: boolean }
interface PlayerTarget { x: number; y: number; z: number; vx: number; vy: number; speed: number; car: Car | null; air: boolean; riding: boolean }
interface PoliceOptions {
  scene: THREE.Scene; drive: DriveGraph; traffic: Traffic; grid: CarGrid;
  height: (x: number, y: number, who?: Car | Officer) => number;
  rng: () => number; edgesNear: (x: number, y: number, radius: number) => DriveEdge[];
  offscreen: (x: number, y: number) => boolean; onBusted: () => void; kit: FigureKit;
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
// Speeding past a police car (20 km/h over the limit) gets you one star.
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
const HELIS = [0, 0, 0, 1, 1, 2];
const PATROLS = 3;
const POINTS = { knock: 1, carjack: 1, wreck: 0.6, hitCop: 2, stealCop: 3, blowUp: 1.5, blowUpCop: 3, fareDodge: 2 };
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

export class Police {
  scene: THREE.Scene; drive: DriveGraph; traffic: Traffic; grid: CarGrid;
  r: () => number; edgesNear: PoliceOptions['edgesNear']; offscreen: PoliceOptions['offscreen'];
  onBusted: () => void; kit: FigureKit; bodyAt: NonNullable<PoliceOptions['bodyAt']>;
  height: PoliceOptions['height']; onShot: NonNullable<PoliceOptions['onShot']>;
  spare: Figures[]; helis: Helicopters; heat: number; cars: ChaseCar[]; officers: Officer[];
  seen: boolean; lose: number; cool: Record<string, number>; spawnT: number; checkT: number; limit: number;
  nodes: Map<string, Point2>; links: Map<string, Link[]>; linked: number;
  lamps: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  glow: THREE.InstancedMesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  dummy: THREE.Object3D; lastT?: number; stolen: WeakSet<Car>;

  constructor({ scene, drive, traffic, grid, height, rng, edgesNear, offscreen, onBusted, kit, bodyAt = () => false, onShot = () => {} }: PoliceOptions) {
    this.scene = scene; this.drive = drive; this.traffic = traffic; this.grid = grid;
    this.r = rng; this.edgesNear = edgesNear; this.offscreen = offscreen;
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

    const lamp = new THREE.BoxGeometry(0.26, 0.14, 0.3);
    this.lamps = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial(), 32);
    const glow = new THREE.CircleGeometry(5, 28);
    glow.rotateX(-Math.PI / 2);
    this.glow = new THREE.InstancedMesh(glow, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }), 16);
    for (const m of [this.lamps, this.glow]) {
      m.count = 0;
      m.frustumCulled = false;
      m.setColorAt(0, new THREE.Color());
      scene.add(m);
    }
    this.dummy = new THREE.Object3D();
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
    if (kind === 'hitCop' && car?.crew) this.getOut(car);
    if (this.cool[kind] > 0) return;
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

  sync() {
    const edges = this.drive.edges;
    for (; this.linked < edges.length; this.linked++) {
      const e = edges[this.linked];
      e.mid = e.mid || new Polyline(e.pts);
      this.nodes.set(e.u, e.pts[0]);
      this.nodes.set(e.v, e.pts[e.pts.length - 1]);
      for (const [a, b, back] of [[e.u, e.v, false], [e.v, e.u, true]] as [string, string, boolean][]) {
        if (!this.links.has(a)) this.links.set(a, []);
        this.links.get(a)!.push({ to: b, e, back });
      }
    }
  }

  nearestStreet(x: number, y: number, radius = 40) {
    let best: { e: DriveEdge & { mid: Polyline }; s: number; d: number } | null = null;
    for (const e of this.edgesNear(x, y, radius)) {
      e.mid = e.mid || new Polyline(e.pts);
      const p = project(e.mid, x, y);
      if (p.d < radius && (!best || p.d < best.d)) best = { e: e as DriveEdge & { mid: Polyline }, s: p.s, d: p.d };
    }
    return best;
  }

  // Where a police car stops for you on foot: in the traffic lane nearest you, the
  // side of the street you're on. The lanes keep clear of the parked cars, so the car
  // doesn't drive over them (or up on the pavement) to get to you. A street on a
  // bridge or in a tunnel counts only if nothing else is much nearer.
  roadside(x: number, y: number) {
    let best: { x: number; y: number } | null = null, bestD = 80;
    for (const e of this.edgesNear(x, y, 80)) {
      const q = project(e.path, x, y), d = q.d + (e.bridge || e.tunnel ? 15 : 0);
      if (d >= bestD) continue;
      const p = e.path.at(q.s);
      best = { x: p.x, y: p.y };
      bestD = d;
    }
    return best;
  }

  // Shortest way by road from (ax, ay) to (bx, by), as a Polyline, or null.
  route(ax: number, ay: number, bx: number, by: number): Polyline | null {
    this.sync();
    const A = this.nearestStreet(ax, ay), B = this.nearestStreet(bx, by);
    if (!A || !B) return null;
    const lenA = A.e.mid.length, lenB = B.e.mid.length;
    let pts: Point2[];
    if (A.e === B.e || A.e.twin === B.e) {
      const sb = A.e === B.e ? B.s : lenA - B.s;
      pts = slice(A.e.mid, A.s, sb);
    } else {
      const goal = new Map<string, number>([[B.e.u, B.s], [B.e.v, lenB - B.s]]);
      const [gx, gy] = [bx, by];
      const g = new Map<string, number>(), from = new Map<string, Link>(), heap = new Heap();
      for (const [n, cost] of [[A.e.u, A.s], [A.e.v, lenA - A.s]] as [string, number][]) {
        g.set(n, cost);
        heap.push([cost, n]);
      }
      let end: string | null = null;
      for (let pops = 0; heap.size && pops < 6000; pops++) {
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
          const c = gn + (l.e.mid?.length ?? 0);
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
      pts = slice(A.e.mid, A.s, first === A.e.u ? 0 : lenA);
      for (const l of chain) pts.push(...(l.back ? [...l.e.pts].reverse() : l.e.pts));
      pts.push(...slice(B.e.mid, end === B.e.u ? 0 : lenB, B.s));
    }
    return new Polyline([[ax, ay], ...pts, [bx, by]]);
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
    let tx, ty, want;
    if (me.car && dist < 40 && this.clear(c.x, c.y, me.x, me.y)) {
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
        const to = me.car ? null : this.roadside(me.x, me.y);
        p.path = this.route(c.x, c.y, to ? to.x : me.x, to ? to.y : me.y);
        p.s = 0;
        p.replan = 1.2 + this.r() * 0.8;
      }
      if (!p.path) { tx = me.x; ty = me.y; want = 8; }
      else {
        const q = project(p.path, c.x, c.y, p.s - 10, p.s + 40);
        p.s = q.s;
        // Off the route: a new one soon (still no more than a few times a second).
        if (q.d > 12) p.replan = Math.min(p.replan, 0.3);
        const L = 6 + Math.abs(vf) * 0.6, t = p.path.at(p.s + L);
        tx = t.x;
        ty = t.y;
        // Slow down for the bends coming up.
        let bend = 0;
        for (const d of [8, 18, 30]) bend = Math.max(bend, Math.abs(turnOf(c.h, p.path.at(p.s + d).ang)));
        want = clamp(24 - bend * 14, 7, 24);
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
    const alpha = turnOf(c.h, Math.atan2(ty - c.y, tx - c.x));
    let steer = clamp(alpha * 2.2, -1, 1);
    let throttle = vf < want - 1 ? 1 : vf > want + 2 ? -1 : 0;
    if (throttle > 0 && Math.abs(vf) < 1.2) p.stuck += dt;
    else p.stuck = Math.max(0, p.stuck - dt);
    if (p.stuck > 1.2) { p.reverse = 1.1; p.stuck = 0; }
    if (p.reverse > 0) {
      p.reverse -= dt;
      throttle = -1;
      steer = -steer;
    }
    // Close enough and you're not going anywhere: an officer gets out.
    // On foot, also once the car has got as near as the road goes: the officer runs
    // the rest of the way.
    const there = behind || (!me.car && dist < 60 && !!p.path && p.path.length - p.s < 8);
    if (c.crew && !me.air && Math.abs(vf) < 2.5 && (me.car ? me.speed < 2 && dist < 14 : dist < 18 || there)) this.getOut(c);
    // Near you and in sight, from four stars: a shot out of the window now and then.
    p.reload = (p.reload ?? 1) - dt;
    if (c.crew && this.stars >= FROM_CARS && !me.air && dist < RANGE && p.reload <= 0 && this.clear(c.x, c.y, me.x, me.y)) {
      p.reload = this.pace() + 1;
      this.shoot(c.x, c.y, c, me);
    }
    return { throttle, steer, handbrake: want === 0 && Math.abs(vf) < 3 };
  }

  // ---- Guns ----------------------------------------------------------------

  // Seconds to the next shot: quicker with more stars.
  pace() { return (this.stars >= 5 ? 0.5 : this.stars >= 4 ? 0.7 : 0.9) + this.r() * 0.5; }

  // A shot at you from (x, y). It's likelier to hit close up, with more stars, and when
  // you're standing still; a miss goes past you, a little to one side.
  shoot(x: number, y: number, who: Car | Officer, me: PlayerTarget) {
    const d = Math.hypot(me.x - x, me.y - y) || 1, ux = (me.x - x) / d, uy = (me.y - y) / d;
    const odds = clamp(0.5 + 0.07 * (this.stars - ARMED) - d / 60 - me.speed * 0.03, 0.08, 0.8);
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
    let x = car.x + lx * (car.spec.W / 2 + 0.7), y = car.y + ly * (car.spec.W / 2 + 0.7);
    // Out of the other door if a wall or another car is on this side.
    if (this.grid.at(x, y) || this.bodyAt(x, y, 0.4, car)) { x = car.x - lx * (car.spec.W / 2 + 0.7); y = car.y - ly * (car.spec.W / 2 + 0.7); }
    let fig = this.spare.pop();
    if (!fig) {
      fig = new Figures(this.kit, 1);
      fig.look(0, { shirt: '#1f3a68', trousers: '#1a2438', skin: '#e3b99a', hair: '#15233f', sleeves: true });
    }
    this.scene.add(fig.mesh);
    this.officers.push({ x, y, h: car.h, vx: 0, vy: 0, car, fig, anim: new Anim(this.kit, 'idle'), down: 0, back: false });
  }

  blocked(x: number, y: number) {
    const g = this.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  walk(o: Officer, dt: number, me: PlayerTarget) {
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
      // Armed, in range and in sight: they stand and shoot. Closer in they still come to
      // arrest you.
      o.reload = (o.reload ?? 0.5 + this.r() * 0.6) - dt;
      const aiming = !o.back && this.stars >= ARMED && !me.air && toMe > 5 && toMe < RANGE && this.clear(o.x, o.y, me.x, me.y);
      if (aiming) {
        o.vx = o.vy = 0;
        o.h = Math.atan2(me.y - o.y, me.x - o.x);
        if (o.reload <= 0) { o.reload = this.pace(); this.shoot(o.x, o.y, o, me); }
      } else {
        // No car to go back to: they walk off.
        const tx = !o.back ? me.x : ride ? o.car.x : 2 * o.x - me.x, ty = !o.back ? me.y : ride ? o.car.y : 2 * o.y - me.y;
        const d = Math.hypot(tx - o.x, ty - o.y) || 1;
        steer(o, tx, ty, o.back && !ride ? 1.4 : RUN, this.bodyAt, o.back ? o.car : null, this.r);
        if (o.back && ride && d < 2.6) { o.gone = true; o.car.crew = true; return; }
        if (!o.back && this.heat > 0 && !me.air) {
          const reach = me.car ? me.car.spec.L / 2 + 1 : 1.1;
          if (toMe < reach && (!me.car || me.speed < 2)) this.onBusted();
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
      this.traffic.spawn((x, y) => {
        const d = Math.hypot(x - me.x, y - me.y);
        return d > 80 && d < 320 && this.offscreen(x, y);
      }, this.edgesNear(me.x, me.y, 320), 'police');
    }

    // Speeding past the police.
    this.checkT -= dt;
    if (this.checkT < 0) {
      this.checkT = 0.5;
      if (me.car) this.limit = speedLimit(this.nearestStreet(me.x, me.y)?.e);
      if (me.car && me.speed * 3.6 > this.limit + 20 && this.sees(me.x, me.y, 60)) this.heat = Math.max(this.heat, STARS[0]);
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
    }
    this.cars = this.cars.filter((p) => !p.gone);

    this.helis.update(dt, me, HELIS[this.stars]);
    for (const o of this.officers) this.walk(o, dt, me);
    for (const o of this.officers) if (o.gone) this.dismiss(o);
    this.officers = this.officers.filter((o) => !o.gone);
  }

  // After an arrest: the stars go, the officers go back to their cars.
  forgive() {
    this.heat = 0;
    this.lose = 0;
    for (const p of this.cars) p.calm = true;
  }

  // `mine`: the car the player is driving; a stolen police car keeps its lights going
  // while it moves.
  render(height: (x: number, y: number, who: Car | Officer) => number, time: number, mine: Car | null = null) {
    this.helis.render(time, time - (this.lastT ?? time));
    this.lastT = time;
    const d = this.dummy, col = new THREE.Color(), blue = new THREE.Color('#3d7bff'), dim = new THREE.Color('#0d1a3a');
    const flip = Math.floor(time * 5) % 2;
    let n = 0, g = 0;
    const lit = this.cars.filter((p) => !p.calm && !p.wrecked).map((p) => p.car);
    if (mine?.type === 'police' && mine.speed > 0.5) lit.push(mine);
    for (const c of lit) {
      const S = c.spec, cabin = S.cabin ?? [0, 0], mid = (cabin[0] + cabin[1]) / 2;
      const fx = Math.cos(c.h), fy = Math.sin(c.h);
      const base = height(c.x, c.y, c);
      for (const side of [-1, 1]) {
        if (n >= this.lamps.instanceMatrix.count) break;
        const off = side * S.W * 0.24;
        d.position.set(c.x + fx * mid - fy * off, base + S.H + 0.18, -(c.y + fy * mid + fx * off));
        d.rotation.set(0, c.h, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.lamps.setMatrixAt(n, d.matrix);
        this.lamps.setColorAt(n, (side > 0) === !!flip ? blue : dim);
        n++;
      }
      if (g < this.glow.instanceMatrix.count) {
        d.position.set(c.x, base + 0.2, -c.y);
        d.rotation.set(0, 0, 0);
        d.updateMatrix();
        this.glow.setMatrixAt(g, d.matrix);
        this.glow.setColorAt(g, col.set('#2a5cff').multiplyScalar(0.25 + 0.2 * Math.abs(Math.sin(time * 8))));
        g++;
      }
    }
    for (const [m, k] of [[this.lamps, n], [this.glow, g]] as [THREE.InstancedMesh, number][]) {
      m.count = k;
      sendInstances(m);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(SCALE, SCALE, SCALE);
    for (const o of this.officers) {
      m.compose(p.set(o.x, height(o.x, o.y, o), -o.y), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, o.h), sc);
      o.fig.set(0, m, o.anim);
      o.fig.commit(1);
    }
  }
}
