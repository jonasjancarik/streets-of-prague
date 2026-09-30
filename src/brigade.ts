import * as THREE from 'three';
import { Car } from './car.ts';
import { clamp } from './network.ts';
import { Figures, Anim, SCALE } from './figures.ts';
import { locomote, knocked } from './people.ts';
import { along, pedals, steer } from './police.ts';
import type { DriveEdge } from './network.ts';
import type { CarGrid } from './car.ts';
import type { Fires } from './fire.ts';
import type { Police, Follower } from './police.ts';
import type { FigureKit } from './figures.ts';
import type { Point3 } from './guns.ts';

// The fire brigade. When a car catches fire an engine comes from out of view, along the
// streets, and stops by it. Its crew gets out, walks up to the fire and puts it out
// with the hoses, then they get back in and the engine drives off. A car that blew up
// before they got there still gets its flames put out. (Plans/006-firefighters.md.)

const ENGINES = 2; // at most this many out at once
const WALK = 1.9; // firefighters on foot, m/s
const CREW = 3;
const SPRAY = 7; // m: how far a hose reaches
const STAND = 5; // m from the fire they stand at
const HOSE = 1.3; // seconds of water (for `douse`) per second of spraying
const GIVE_UP = 30; // seconds a call waits for a street to spawn an engine on
const WRECKED = 90; // damage that puts an engine out of action

interface Fighter { x: number; y: number; h: number; vx: number; vy: number; engine: Engine; fig: Figures; anim: Anim; down: number; spot: { x: number; y: number }; back: boolean; spraying: boolean; gone?: boolean; gz?: number; detour?: number }
interface Engine extends Follower { car: Car; target: Car; phase: 'go' | 'work' | 'leave'; t: number; wrecked: boolean; crew: boolean; gone?: boolean }
interface Call { target: Car; t: number }
interface BrigadeOptions {
  scene: THREE.Scene; police: Police; grid: CarGrid; fires: Fires; kit: FigureKit;
  height: (x: number, y: number, who?: Car | Fighter) => number;
  rng: () => number; edgesNear: (x: number, y: number, radius: number) => DriveEdge[];
  offscreen: (x: number, y: number) => boolean;
  bodyAt: (x: number, y: number, r: number, skip: Car | null) => boolean;
}

export class Brigade {
  o: BrigadeOptions;
  engines: Engine[] = [];
  crew: Fighter[] = [];
  calls: Call[] = [];
  spare: Figures[] = [];
  // Hoses spraying this frame: from the nozzle to where the water lands.
  jets: { from: Point3; to: Point3 }[] = [];
  spawnT = 0;

  constructor(o: BrigadeOptions) { this.o = o; }

  // A car has caught fire (or blown up): an engine is sent, unless one is on its way to
  // that spot already.
  call(target: Car) {
    const near = (c: Car) => Math.hypot(c.x - target.x, c.y - target.y) < 60;
    if (this.engines.some((e) => e.phase !== 'leave' && near(e.target))) return;
    if (this.calls.some((k) => near(k.target))) return;
    this.calls.push({ target, t: 0 });
  }

  // A new engine on a street out of view, 150–300 m from `target`, on its way there.
  dispatch(target: Car) {
    const { o } = this, r = o.rng;
    const edges = o.edgesNear(target.x, target.y, 300);
    const stop = o.police.roadside(target.x, target.y);
    if (!stop) return false;
    for (let t = 0; t < 30 && edges.length; t++) {
      const e = edges[Math.floor(r() * edges.length)];
      if (e.bridge || e.tunnel || e.path.length < 14) continue;
      const q = e.path.at(r() * e.path.length), d = Math.hypot(q.x - target.x, q.y - target.y);
      if (d < 150 || d > 300 || !o.offscreen(q.x, q.y)) continue;
      const path = o.police.route(q.x, q.y, stop.x, stop.y);
      if (!path) continue;
      // Facing the way it's to go: a long engine can't turn round in a narrow street.
      const car = new Car('fire', r, q.x, q.y, path.at(Math.min(6, path.length)).ang);
      if (car.worldSamples().some(([sx, sy]) => o.grid.at(sx, sy))) continue;
      car.mode = 'fire';
      this.engines.push({ car, target, path, s: 0, replan: 2, stuck: 0, reverse: 0, phase: 'go', t: 0, wrecked: false, crew: true });
      return true;
    }
    return false;
  }

  // You got into an engine: it's yours, and its crew walks off.
  take(car: Car) {
    const i = this.engines.findIndex((e) => e.car === car);
    if (i < 0) return;
    this.engines.splice(i, 1);
    car.crew = false;
    for (const f of this.crew) if (f.engine.car === car) f.back = true;
  }

  knock(f: Fighter, vx: number, vy: number) {
    Object.assign(f, { down: 3, vx, vy, h: Math.atan2(vy, vx) + Math.PI, spraying: false });
    f.anim.play('fall', true, 0.08);
  }

  dismiss(f: Fighter) {
    this.o.scene.remove(f.fig.mesh);
    this.spare.push(f.fig);
  }

  // Dev teleport: nobody is left behind.
  // Engines with their lights going: on the way and while the crew works.
  get lit() { return this.engines.filter((e) => !e.wrecked && !e.gone).map((e) => e.car); }

  reset() {
    for (const f of this.crew) this.dismiss(f);
    this.crew = [];
    this.engines = [];
    this.calls = [];
  }

  // ---- Crew ---------------------------------------------------------------

  // The crew gets out of the engine's near side and spreads out round the fire.
  getOut(e: Engine) {
    const { o } = this, car = e.car, tc = e.target;
    e.crew = false;
    const lx = -Math.sin(car.h), ly = Math.cos(car.h), side = car.spec.W / 2 + 0.7;
    const a0 = Math.atan2(car.y - tc.y, car.x - tc.x);
    for (let i = 0; i < CREW; i++) {
      const s = i % 2 ? -1 : 1;
      let x = car.x + lx * s * side - Math.cos(car.h) * i * 0.9, y = car.y + ly * s * side - Math.sin(car.h) * i * 0.9;
      if (o.grid.at(x, y)) { x = car.x - lx * s * side; y = car.y - ly * s * side; }
      let fig = this.spare.pop();
      if (!fig) {
        fig = new Figures(o.kit, 1);
        fig.look(0, { shirt: '#232c4a', trousers: '#151a28', skin: '#e3b99a', hair: '#2b2118', sleeves: true });
      }
      o.scene.add(fig.mesh);
      // Along the near side of the fire, to the road's side of it first.
      const a = a0 + (i - (CREW - 1) / 2) * 0.9;
      this.crew.push({ x, y, h: car.h, vx: 0, vy: 0, engine: e, fig, anim: new Anim(o.kit, 'idle'), down: 0, back: false, spraying: false,
        spot: { x: tc.x + Math.cos(a) * STAND, y: tc.y + Math.sin(a) * STAND } });
    }
  }

  blocked(x: number, y: number) {
    const g = this.o.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  walk(f: Fighter, dt: number) {
    const { o } = this, e = f.engine, tc = e.target;
    f.spraying = false;
    if (f.down > 0) {
      f.down -= dt;
      const k = Math.exp(-4 * dt);
      f.vx *= k;
      f.vy *= k;
    } else {
      const ride = this.engines.includes(e) && !e.wrecked;
      const fighting = e.phase === 'work' && !f.back && e.t < 60;
      if (fighting && o.fires.onFire(tc)) {
        const d = Math.hypot(f.spot.x - f.x, f.spot.y - f.y);
        if (d > 0.7) steer(f, f.spot.x, f.spot.y, WALK * 1.6, o.bodyAt, e.car, o.rng);
        else f.vx = f.vy = 0;
        // Within reach, they face the fire and spray.
        const dx = tc.x - f.x, dy = tc.y - f.y;
        if (Math.hypot(dx, dy) < SPRAY + tc.spec.L / 2) {
          f.h = Math.atan2(dy, dx);
          f.spraying = true;
          o.fires.douse(tc, dt * HOSE);
        }
      } else {
        // Done (or the engine is gone): back to it, or away if it can't take them.
        f.back = true;
        const tx = ride ? e.car.x : 2 * f.x - tc.x, ty = ride ? e.car.y : 2 * f.y - tc.y;
        steer(f, tx, ty, ride ? WALK * 1.6 : WALK, o.bodyAt, e.car, o.rng);
        if (ride && Math.hypot(tx - f.x, ty - f.y) < 2.8) f.gone = true;
      }
    }
    const nx = f.x + f.vx * dt, ny = f.y + f.vy * dt;
    if (!this.blocked(nx, f.y)) f.x = nx;
    if (!this.blocked(f.x, ny)) f.y = ny;
    if (f.down > 0) knocked(f.anim, dt, f.down);
    else locomote(f.anim, dt, Math.hypot(f.vx, f.vy));
    if (f.back && !this.engines.includes(e) && o.offscreen(f.x, f.y)) f.gone = true;
  }

  // ---- Engines ------------------------------------------------------------

  drive(e: Engine, dt: number) {
    const { o } = this, c = e.car, tc = e.target;
    let tx: number, ty: number, want: number;
    e.replan -= dt;
    if (e.phase === 'go') {
      if (!e.path) { tx = tc.x; ty = tc.y; want = 8; } else ({ tx, ty, want } = along(c, e, e.path));
      if (e.path) want = Math.min(want, clamp((e.path.length - e.s - 4) * 0.9, 0, 25));
      const dist = Math.hypot(tc.x - c.x, tc.y - c.y);
      if (dist < 14) want = 0;
      if (e.replan < 0) {
        const stop = o.police.roadside(tc.x, tc.y);
        if (stop) { e.path = o.police.route(c.x, c.y, stop.x, stop.y); e.s = 0; }
        e.replan = 3;
      }
      // Nothing left to put out: turn round.
      if (!o.fires.onFire(tc)) this.leave(e);
      else if (Math.abs(c.forwardSpeed) < 2.5 && (dist < 22 || (e.path && e.path.length - e.s < 8))) {
        e.phase = 'work';
        e.t = 0;
        this.getOut(e);
      }
    } else if (e.phase === 'work') {
      tx = c.x + Math.cos(c.h); ty = c.y + Math.sin(c.h); want = 0;
      e.t += dt;
      const out = this.crew.some((f) => f.engine === e && !f.gone);
      if (!out && !e.crew) { e.crew = true; this.leave(e); }
    } else {
      if (!e.path) { tx = c.x + Math.cos(c.h) * 20; ty = c.y + Math.sin(c.h) * 20; want = 10; } else ({ tx, ty, want } = along(c, e, e.path));
      if (e.path) want = Math.min(want, clamp((e.path.length - e.s - 4) * 0.9, 4, 25));
      e.t += dt;
    }
    if (!e.crew) want = 0;
    const { throttle, steer: st } = pedals(c, e, tx, ty, want, dt);
    return { throttle, steer: st, handbrake: want === 0 && Math.abs(c.forwardSpeed) < 3 };
  }

  // Off again: to a street 250 m or more away.
  leave(e: Engine) {
    const { o } = this, c = e.car;
    e.phase = 'leave';
    e.t = 0;
    e.path = null;
    const edges = o.edgesNear(c.x, c.y, 350);
    // Of a few ways out, the one that doesn't start with a U-turn.
    let best = -2;
    for (let t = 0; t < 24 && edges.length; t++) {
      const ed = edges[Math.floor(o.rng() * edges.length)];
      if (ed.bridge || ed.tunnel) continue;
      const q = ed.path.at(o.rng() * ed.path.length);
      if (Math.hypot(q.x - c.x, q.y - c.y) < 250) continue;
      const path = o.police.route(c.x, c.y, q.x, q.y);
      if (!path) continue;
      const ahead = Math.cos(path.at(Math.min(10, path.length)).ang - c.h);
      if (ahead > best) { best = ahead; e.path = path; }
      if (best > 0.8) break;
    }
    e.s = 0;
  }

  update(dt: number, me: { x: number; y: number }) {
    const { o } = this;
    // Calls wait for a street to send an engine from.
    this.spawnT -= dt;
    if (this.spawnT < 0 && this.calls.length) {
      this.spawnT = 1;
      const k = this.calls[0];
      if (this.engines.length >= ENGINES) { /* wait for one to be free */ }
      else if (this.dispatch(k.target)) this.calls.shift();
      else if ((k.t += 1) > GIVE_UP) this.calls.shift();
    }
    for (const e of this.engines) {
      const c = e.car;
      if (!e.wrecked && c.damage > WRECKED) e.wrecked = true;
      let ctl = null;
      if (!e.wrecked) ctl = this.drive(e, dt);
      else c.mode = 'loose';
      c.update(dt, ctl, o.grid);
      const d = Math.hypot(c.x - me.x, c.y - me.y), waiting = this.crew.some((f) => f.engine === e);
      e.gone = !waiting && o.offscreen(c.x, c.y) && (e.wrecked ? d > 120 : d > 250 && (e.phase === 'leave'));
    }
    this.engines = this.engines.filter((e) => !e.gone);
    for (const f of this.crew) this.walk(f, dt);
    for (const f of this.crew) if (f.gone) this.dismiss(f);
    this.crew = this.crew.filter((f) => !f.gone);

    // Where each spraying hose's water goes: from the hands to the fire.
    this.jets.length = 0;
    for (const f of this.crew) {
      if (!f.spraying) continue;
      const tc = f.engine.target, z = o.height(f.x, f.y, f);
      this.jets.push({ from: [f.x + Math.cos(f.h) * 0.6, f.y + Math.sin(f.h) * 0.6, z + 1.3], to: [tc.x, tc.y, o.height(tc.x, tc.y, tc) + tc.spec.H * 0.5] });
    }
  }

  render() {
    const { o } = this;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(SCALE, SCALE, SCALE);
    for (const f of this.crew) {
      m.compose(p.set(f.x, o.height(f.x, f.y, f), -f.y), q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, f.h), sc);
      f.fig.set(0, m, f.anim);
      f.fig.commit(1);
    }
  }
}
