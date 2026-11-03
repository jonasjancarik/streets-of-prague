import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Figures, Anim, SCALE } from './figures.ts';
import { locomote, knocked } from './people.ts';
import { steer } from './police.ts';
import { cutAway } from './shading.ts';
import { sendInstances } from './gpu.ts';
import type { Car, CarGrid } from './car.ts';
import type { DriveEdge } from './network.ts';
import type { Traffic, TrafficAgent } from './traffic.ts';
import type { FigureKit } from './figures.ts';

// The dustcarts. In the centre, by day, one or two are about on their rounds: crawling
// along the side streets with their amber lamps going, two dustmen riding on the steps
// at the back. Every few houses the cart stops; the dustmen jump down, go into the
// house beside it (bins in the old town are kept in the passage or the courtyard), wheel
// a bin out to the back of the cart, where the lift tips it into the hopper, wheel it
// back in, and climb on again. Cars behind wait, or get past where the street is wide
// enough. A cart that's crashed into or taken is left, and its crew walks off.

const CENTRE = [-3205, 3097], ROUNDS = 3000; // m from the Old Town Square: rounds only in the centre
const FROM = 5, TO = 22; // the hours they're out
const CREW = 2;
const CRAWL = 5.5; // m/s between houses
const GAP = 16; // m at least between stops (and up to as much again)
const REACH = 13; // m from the lane to a house's wall, at most
const WALK = 1.7, PUSH = 1.25; // m/s on foot, and wheeling a bin
const STEP = 0.45; // m: the height of the steps they ride on
const TIP = 5; // seconds a bin takes on the lift
const HANDLE = 0.8; // m from a dustman to the middle of the bin he's wheeling
const GIVE_UP = 14; // seconds getting no nearer before they leave it
const BINS = 32;
// The streets they don't work: the big through roads, bridges and tunnels.
const THROUGH = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);
const street = (e: DriveEdge) => !THROUGH.has(e.hw) && !e.bridge && !e.tunnel;
// Mixed waste in Prague goes in grey, black or dark green bins; now and then a brown one.
const COLOURS = ['#60676a', '#3b3e41', '#3a5b45', '#50575b', '#6e5236'].map((c) => new THREE.Color(c));

interface Door { x: number; y: number; nx: number; ny: number } // in front of a house's wall, and the way out of it
interface Bin { x: number; y: number; h: number; tilt: number; lift: number; colour: THREE.Color; left?: boolean }
type Job = 'ride' | 'fetch' | 'in' | 'wheel' | 'tip' | 'return' | 'out' | 'back' | 'leave';
interface Dustman {
  x: number; y: number; h: number; vx: number; vy: number; anim: Anim; round: Round; side: number;
  job: Job; t: number; door?: Door; bin?: Bin; down: number; detour?: number; best: number; stuck: number; gone?: boolean; gz?: number;
}
interface Round { agent: TrafficAgent; car: Car; crew: Dustman[]; since: number; gap: number; phase: 'drive' | 'brake' | 'work' | 'gone'; doors: Door[]; t: number }
interface RefuseOptions {
  scene: THREE.Scene; traffic: Traffic; grid: CarGrid; kit: FigureKit;
  height: (x: number, y: number, who?: Car) => number;
  rng: () => number; offscreen: (x: number, y: number) => boolean;
  edgesNear: (x: number, y: number, r: number) => DriveEdge[];
  spot: (x: number, y: number) => boolean; // where a new cart may turn up
  bodyAt: (x: number, y: number, r: number, skip: Car | null) => boolean;
  hour: () => number; quiet: () => boolean;
}

export class Refuse {
  o: RefuseOptions;
  rounds: Round[] = [];
  crew: Dustman[] = [];
  bins: Bin[] = [];
  fig: Figures;
  binMesh: THREE.InstancedMesh;
  spawnT = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();

  constructor(o: RefuseOptions) {
    this.o = o;
    this.fig = new Figures(o.kit, CREW * 4);
    for (let i = 0; i < CREW * 4; i++) this.fig.look(i, { shirt: '#ee7a1c', trousers: '#2e3540', skin: '#e3b99a', hair: '#3a2a1e', sleeves: true });
    this.fig.commit(0);
    o.scene.add(this.fig.mesh);
    this.binMesh = new THREE.InstancedMesh(binGeometry(), cutAway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), 'furniture'), BINS);
    this.binMesh.castShadow = this.binMesh.receiveShadow = true;
    this.binMesh.frustumCulled = false;
    this.binMesh.count = 0;
    this.binMesh.setColorAt(0, new THREE.Color());
    o.scene.add(this.binMesh);
  }

  // Dustcarts on their rounds, with their amber lamps going.
  get lit() { return this.rounds.filter((r) => r.phase !== 'gone').map((r) => r.car); }
  // The dustmen on foot, for the traffic to stop for (not the ones on the steps or indoors).
  get walking() { return this.crew.filter((m) => m.job !== 'ride' && m.job !== 'in' && m.job !== 'out'); }

  // A cart on its round from the nearest street it works to (x, y) within `r` m (any
  // street out of sight in the player's part of town when `r` is left out).
  send(x: number, y: number, r?: number) {
    const { o } = this;
    const edges = o.edgesNear(x, y, r ?? 330).filter((e) => street(e) && e.path.length > 30);
    if (!edges.length) return null;
    const avoid = r === undefined ? (sx: number, sy: number) => o.offscreen(sx, sy) && o.spot(sx, sy) : (sx: number, sy: number) => Math.hypot(sx - x, sy - y) < r && o.grid.at(sx, sy) === 0;
    const agent = o.traffic.spawn(avoid, edges, 'garbage');
    if (!agent) return null;
    const rnd = o.rng;
    agent.route.pick = (_e, opts) => { const ok = opts.filter(street); return ok.length ? ok[Math.floor(rnd() * ok.length)] : null; };
    agent.crawl = CRAWL;
    agent.cruise = 1;
    const round: Round = { agent, car: agent.car, crew: [], since: 0, gap: GAP * (1 + rnd()), phase: 'drive', doors: [], t: 0 };
    for (let i = 0; i < CREW; i++) {
      const m: Dustman = { x: agent.car.x, y: agent.car.y, h: agent.car.h, vx: 0, vy: 0, anim: new Anim(o.kit, 'hold', rnd()), round, side: i ? -1 : 1, job: 'ride', t: 0, down: 0, best: Infinity, stuck: 0 };
      this.ride(m);
      round.crew.push(m);
      this.crew.push(m);
    }
    this.rounds.push(round);
    return round;
  }

  // Dev teleport: everyone goes.
  reset() {
    for (const r of this.rounds) if (r.phase !== 'gone') { r.car.working = false; r.agent.crawl = r.agent.stop = undefined; }
    this.rounds = [];
    this.crew = [];
    this.bins = [];
  }

  knock(m: Dustman, vx: number, vy: number) {
    if (m.job === 'in' || m.job === 'out') return;
    if (m.bin) { m.bin.left = true; m.bin.tilt = 0; m.bin.lift = 0; m.bin = undefined; }
    if (m.job === 'ride') { m.gz = undefined; }
    Object.assign(m, { down: 3, vx, vy, h: Math.atan2(vy, vx) + Math.PI });
    m.anim.play('fall', true, 0.08);
    if (m.job !== 'leave') m.job = 'back';
  }

  // ---- Where things are ---------------------------------------------------

  // The step a dustman rides on: at the back of the cart, on his side.
  stepAt(c: Car, side: number) {
    const fx = Math.cos(c.h), fy = Math.sin(c.h), back = c.spec.L / 2 - 0.22, across = side * (c.spec.W / 2 - 0.32);
    return { x: c.x - fx * back - fy * across, y: c.y - fy * back + fx * across };
  }

  // Where his bin goes on the lift (and he stands behind it).
  slotAt(c: Car, side: number) {
    const fx = Math.cos(c.h), fy = Math.sin(c.h), back = c.spec.L / 2 + 0.45, across = side * 0.55;
    return { x: c.x - fx * back - fy * across, y: c.y - fy * back + fx * across };
  }

  ride(m: Dustman) {
    const c = m.round.car, s = this.stepAt(c, m.side);
    Object.assign(m, { x: s.x, y: s.y, h: c.h, vx: c.vx, vy: c.vy, job: 'ride' as Job });
    m.anim.play('hold', false, 0.2);
  }

  blocked(x: number, y: number) {
    const g = this.o.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  // The front of a house beside the lane at `s` along `e`, on its right (and on its
  // left too, on a one-way or a narrow street): the first thing solid out from the lane
  // that runs on deep and to either side, so a tree, a post or a parked car isn't taken for one.
  doors(e: DriveEdge, s: number): Door[] {
    const g = this.o.grid, out: Door[] = [];
    const sides = e.oneway || e.width < 8 ? [1, -1] : [1];
    for (const at of [s - 1, s + 6]) {
      const q = e.path.at(at), tx = Math.cos(q.ang), ty = Math.sin(q.ang);
      for (const side of sides) {
        const nx = Math.sin(q.ang) * side, ny = -Math.cos(q.ang) * side;
        for (let d = 1.5; d < REACH; d += 0.25) {
          const x = q.x + nx * d, y = q.y + ny * d;
          if (!g.at(x, y)) continue;
          const solid = (k: number, a = 0) => !!g.at(q.x + nx * (d + k) + tx * a, q.y + ny * (d + k) + ty * a);
          if (solid(1.2) && solid(2.5) && solid(0.5, 1.5) && solid(0.5, -1.5)) out.push({ x: q.x + nx * (d - 0.45), y: q.y + ny * (d - 0.45), nx: -nx, ny: -ny });
          break;
        }
      }
    }
    // (The same house twice from the two points along: once is enough, unless there's no other.)
    return out.filter((a, i) => !out.slice(0, i).some((b) => Math.hypot(a.x - b.x, a.y - b.y) < 3)).slice(0, CREW);
  }

  // ---- The rounds ---------------------------------------------------------

  update(dt: number, me: { x: number; y: number }) {
    const { o } = this;
    this.spawnT -= dt;
    if (this.spawnT < 0) {
      this.spawnT = 2;
      const h = o.hour(), centre = Math.hypot(me.x - CENTRE[0], me.y - CENTRE[1]) < ROUNDS;
      const want = o.quiet() || !centre || h < FROM || h >= TO ? 0 : h >= 6 && h < 11 ? 2 : 1;
      if (this.rounds.filter((r) => r.phase !== 'gone').length < want) this.send(me.x, me.y);
    }
    for (const r of this.rounds) {
      if (r.phase !== 'gone' && !o.traffic.agents.includes(r.agent)) this.abandon(r);
      else if (r.phase !== 'gone') this.drive(r, dt);
    }
    for (const m of this.crew) this.walk(m, dt);
    this.crew = this.crew.filter((m) => !m.gone);
    for (const r of this.rounds) r.crew = r.crew.filter((m) => !m.gone);
    this.rounds = this.rounds.filter((r) => r.phase !== 'gone' || r.crew.length);
    // Bins left standing (their dustman knocked over, the cart gone) go once nobody sees them.
    this.bins = this.bins.filter((b) => !b.left || !o.offscreen(b.x, b.y) || Math.hypot(b.x - me.x, b.y - me.y) < 60);
  }

  drive(r: Round, dt: number) {
    const a = r.agent, c = r.car;
    r.t += dt;
    if (r.phase === 'drive') {
      a.crawl = CRAWL;
      r.since += a.speed * dt;
      const e = a.route.leg.edge, s = a.route.s + 6;
      const centre = Math.hypot(c.x - CENTRE[0], c.y - CENTRE[1]) < ROUNDS;
      // Far enough on from the last house, on a street they work, and not in a junction.
      if (r.since > r.gap && e && street(e) && centre && s > a.route.leg.s0 + 8 && s < a.route.leg.s1 - 10) {
        const doors = this.doors(e, s);
        if (doors.length) {
          Object.assign(r, { phase: 'brake', doors, t: 0 });
          a.stop = { edge: e, s };
        } else r.since = r.gap - 5; // (no house here: a look again a little further on)
      }
    } else if (r.phase === 'brake') {
      const left = a.stop ? a.route.to(a.stop.edge, a.stop.s) : 0;
      if (a.speed < 0.3 && left < 1.5) this.stop(r);
      // Held up on the way (a car standing in the way, the lights): not this house.
      else if (r.t > 12 || left === Infinity) {
        Object.assign(r, { phase: 'drive', since: 0 });
        a.stop = undefined;
      }
    } else if (r.phase === 'work') {
      a.speed = 0;
      // Everyone back on the steps: off to the next house.
      if (r.t > 1 && r.crew.every((m) => m.job === 'ride')) {
        Object.assign(r, { phase: 'drive', since: 0, gap: GAP * (1 + this.o.rng()), t: 0 });
        a.stop = undefined;
        c.working = false;
      }
    }
    for (const m of r.crew) if (m.job === 'ride' && m.down <= 0) this.ride(m);
  }

  // Stopped by a house: the crew get down and go for its bins.
  stop(r: Round) {
    r.phase = 'work';
    r.t = 0;
    r.car.working = true;
    r.crew.forEach((m, i) => {
      if (m.job !== 'ride') return;
      // (Two dustmen and one door: the second goes in a little along from the first.)
      const d = r.doors[i % r.doors.length], tx = -d.ny, ty = d.nx, off = i >= r.doors.length ? 1.1 : 0;
      m.door = { ...d, x: d.x + tx * off, y: d.y + ty * off };
      const s = this.stepAt(r.car, m.side), lx = -Math.sin(r.car.h) * m.side, ly = Math.cos(r.car.h) * m.side;
      // Down off the step, out to the side.
      Object.assign(m, { x: s.x + lx * 0.5, y: s.y + ly * 0.5, job: 'fetch' as Job, best: Infinity, stuck: 0, t: 0 });
    });
  }

  // The cart is gone from its round (crashed into, set on fire, taken, or far behind you):
  // the crew jump down and walk off, leaving any bin where it stands.
  abandon(r: Round) {
    const { o } = this;
    r.phase = 'gone';
    r.car.working = false;
    r.agent.crawl = r.agent.stop = undefined;
    for (const m of r.crew) {
      if (m.bin) { m.bin.left = true; m.bin.lift = m.bin.tilt = 0; m.bin = undefined; }
      if (m.job === 'ride') { const lx = -Math.sin(r.car.h) * m.side, ly = Math.cos(r.car.h) * m.side; m.x += lx * 0.8; m.y += ly * 0.8; }
      m.job = 'leave';
      m.t = 0;
      if (o.offscreen(m.x, m.y)) m.gone = true;
    }
  }

  // Getting no nearer to where he's going for a while.
  stalled(m: Dustman, d: number, dt: number) {
    if (d < m.best - 0.3) { m.best = d; m.stuck = 0; } else m.stuck += dt;
    return m.stuck > GIVE_UP;
  }

  go(m: Dustman, job: Job) { Object.assign(m, { job, t: 0, best: Infinity, stuck: 0 }); }

  walk(m: Dustman, dt: number) {
    const { o } = this, r = m.round, c = r.car, rnd = o.rng;
    const inWay = (x: number, y: number, rr: number, skip: Car | null) => !!this.blocked(x, y) || o.bodyAt(x, y, rr, skip);
    const to = (x: number, y: number, speed: number) => {
      const d = Math.hypot(x - m.x, y - m.y);
      // (Close to the cart, past its body: the step and the lift are up against it.)
      if (d > 0.15) steer(m, x, y, Math.min(speed, d * 3), inWay, d < 2.5 ? c : null, rnd);
      else m.vx = m.vy = 0;
      return d;
    };
    m.t += dt;
    if (m.down > 0) {
      m.down -= dt;
      const k = Math.exp(-4 * dt);
      m.vx *= k;
      m.vy *= k;
    } else if (m.job === 'ride') {
      m.anim.step(dt);
      return;
    } else if (m.job === 'fetch') {
      const d = to(m.door!.x, m.door!.y, WALK);
      if (d < 0.5) { this.go(m, 'in'); m.vx = m.vy = 0; m.t = -(1.5 + rnd() * 2.5); }
      else if (this.stalled(m, d, dt)) this.go(m, 'back');
    } else if (m.job === 'in') {
      // Inside the house; out again with a bin.
      if (m.t >= 0) {
        const d = m.door!;
        m.h = Math.atan2(d.ny, d.nx);
        m.bin = { x: d.x + d.nx * HANDLE, y: d.y + d.ny * HANDLE, h: m.h, tilt: 0, lift: 0, colour: COLOURS[Math.floor(rnd() * (rnd() < 0.1 ? COLOURS.length : COLOURS.length - 1))] };
        this.bins.push(m.bin);
        this.go(m, 'wheel');
      }
    } else if (m.job === 'wheel') {
      const s = this.slotAt(c, m.side), d = to(s.x, s.y, PUSH);
      // (Up to the lift: the bin, ahead of him, is at it.)
      if (d < HANDLE + 0.15) { this.go(m, 'tip'); m.vx = m.vy = 0; }
      else if (this.stalled(m, d, dt)) this.go(m, 'return');
    } else if (m.job === 'tip') {
      // The lift takes the bin up, tips it over the hopper and lets it down again.
      const s = this.slotAt(c, m.side), b = m.bin!, u = m.t / TIP;
      b.x = s.x; b.y = s.y; b.h = c.h; b.tilt = 0;
      b.lift = u < 0.3 ? u / 0.3 : u < 0.7 ? 1 : Math.max(0, (1 - u) / 0.3);
      m.h = c.h;
      const back = HANDLE + 0.25;
      m.x += (s.x - Math.cos(c.h) * back - m.x) * Math.min(1, dt * 4);
      m.y += (s.y - Math.sin(c.h) * back - m.y) * Math.min(1, dt * 4);
      m.vx = m.vy = 0;
      if (u >= 1) { b.lift = 0; this.go(m, 'return'); }
    } else if (m.job === 'return') {
      const dr = m.door!, d = to(dr.x, dr.y, PUSH);
      if (d < HANDLE + 0.2) {
        // Back in the house with it, and sometimes out again with another.
        this.bins.splice(this.bins.indexOf(m.bin!), 1);
        m.bin = undefined;
        this.go(m, 'out');
        m.vx = m.vy = 0;
        m.t = rnd() < 0.3 ? -(2 + rnd() * 2) : -(0.8 + rnd());
        m.door = { ...dr, again: m.t < -2 } as Door;
      } else if (this.stalled(m, d, dt)) {
        if (m.bin) { m.bin.left = true; m.bin.tilt = 0; m.bin = undefined; }
        this.go(m, 'back');
      }
    } else if (m.job === 'out') {
      if (m.t >= 0) {
        const dr = m.door as Door & { again?: boolean };
        if (dr.again) { m.t = 0; dr.again = false; this.go(m, 'in'); }
        else this.go(m, 'back');
      }
    } else if (m.job === 'back') {
      if (r.phase === 'gone') { this.go(m, 'leave'); return; }
      const s = this.stepAt(c, m.side), d = to(s.x, s.y, WALK * 1.2);
      // On the step again (or, getting nowhere, round by any way: he's on).
      if (d < 1.3 || this.stalled(m, d, dt)) this.ride(m);
    } else {
      // Walking off, away from the cart; gone where nobody sees.
      steer(m, 2 * m.x - c.x, 2 * m.y - c.y, WALK, inWay, null, rnd);
      if (o.offscreen(m.x, m.y) || m.t > 90) m.gone = true;
    }
    if (m.job === 'in' || m.job === 'out') return;
    const nx = m.x + m.vx * dt, ny = m.y + m.vy * dt;
    if (!this.blocked(nx, m.y)) m.x = nx;
    if (!this.blocked(m.x, ny)) m.y = ny;
    // The bin goes ahead of him, tipped back onto its wheels.
    if (m.bin && m.job !== 'tip') {
      const b = m.bin, sp = Math.hypot(m.vx, m.vy);
      b.h = m.h;
      b.x = m.x + Math.cos(m.h) * HANDLE;
      b.y = m.y + Math.sin(m.h) * HANDLE;
      b.tilt += ((sp > 0.2 ? 0.4 : 0.15) - b.tilt) * Math.min(1, dt * 5);
    }
    if (m.down > 0) knocked(m.anim, dt, m.down);
    else if (m.bin && m.job !== 'tip') {
      // Wheeling a bin: the push clip, its steps in time with the ground (as the walk's).
      m.anim.play('push', false, 0.2);
      m.anim.step(dt, (Math.hypot(m.vx, m.vy) / 1.6) * m.anim.duration);
    } else locomote(m.anim, dt, Math.hypot(m.vx, m.vy));
  }

  // ---- Drawing ------------------------------------------------------------

  render() {
    const { o, m, q, p } = this;
    const sc = new THREE.Vector3(SCALE, SCALE, SCALE), up = THREE.Object3D.DEFAULT_UP;
    let n = 0;
    for (const d of this.crew) {
      if (d.job === 'in' || d.job === 'out' || n >= this.fig.capacity) continue;
      const riding = d.job === 'ride' && d.down <= 0;
      const z = riding ? o.height(d.round.car.x, d.round.car.y, d.round.car) + STEP : o.height(d.x, d.y);
      m.compose(p.set(d.x, z, -d.y), q.setFromAxisAngle(up, d.h), sc);
      this.fig.set(n++, m, d.anim);
    }
    this.fig.commit(n);
    let k = 0;
    const one = new THREE.Vector3(1, 1, 1), e = new THREE.Euler(), pivot = new THREE.Matrix4(), tip = new THREE.Matrix4();
    for (const b of this.bins) {
      if (k >= BINS) break;
      // Tipped back on its wheels (at its back, by the handle), or up on the lift and
      // turned over the hopper ahead of it.
      const z = o.height(b.x, b.y);
      m.compose(p.set(b.x, z + b.lift * 1.3, -b.y), q.setFromAxisAngle(up, b.h), one);
      if (b.lift > 0) {
        tip.makeRotationFromEuler(e.set(0, 0, -2.3 * b.lift));
        pivot.makeTranslation(0.36, 0.5, 0).multiply(tip).multiply(new THREE.Matrix4().makeTranslation(-0.36, -0.5, 0));
        m.multiply(pivot);
      } else if (b.tilt > 0) {
        tip.makeRotationFromEuler(e.set(0, 0, b.tilt));
        pivot.makeTranslation(-0.3, 0.1, 0).multiply(tip).multiply(new THREE.Matrix4().makeTranslation(0.3, -0.1, 0));
        m.multiply(pivot);
      }
      this.binMesh.setMatrixAt(k, m);
      this.binMesh.setColorAt(k, b.colour);
      k++;
    }
    this.binMesh.count = k;
    sendInstances(this.binMesh);
  }
}

// A 240-litre wheelie bin, in the instance's colour: facing +x (the end away from the
// handle), its wheels and handle at the back, its lid a little darker.
function binGeometry() {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, shade: number) => {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.deleteAttribute('uv');
    g.translate(x, y, z);
    const col = new Float32Array(g.attributes.position.count * 3).fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };
  return mergeGeometries([
    box(0.68, 0.92, 0.56, 0.02, 0.56, 0, 1), // the body, narrower at the foot
    box(0.6, 0.12, 0.5, 0.02, 0.1, 0, 1),
    box(0.76, 0.05, 0.6, 0.01, 1.04, 0, 0.72), // the lid
    box(0.06, 0.05, 0.5, -0.38, 1.0, 0, 0.45), // the handle
    box(0.2, 0.2, 0.07, -0.28, 0.1, 0.29, 0.2), // the wheels
    box(0.2, 0.2, 0.07, -0.28, 0.1, -0.29, 0.2),
  ])!;
}
