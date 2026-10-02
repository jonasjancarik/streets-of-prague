import * as THREE from 'three';
import { Car } from './car.ts';
import { clamp } from './network.ts';
import { Figures, Anim, SCALE } from './figures.ts';
import { locomote, knocked } from './people.ts';
import { along, pedals, steer } from './police.ts';
import type { DriveEdge } from './network.ts';
import type { CarGrid } from './car.ts';
import type { Pedestrian } from './people.ts';
import type { Police, Follower } from './police.ts';
import type { FigureKit } from './figures.ts';

// The ambulance service. When someone is left lying hurt (run down hard, caught in a
// blast) an ambulance comes from out of view along the streets and stops by them. Its two
// paramedics get out, kneel by the patient for a while, the patient gets up, and the
// crew drive off again. It is made like the fire brigade (src/brigade.ts), with the same
// way of getting there; what differs is who it is for and what the crew does.

const RIGS = 2; // at most this many out on a call at once
const CREW = 2;
const WALK = 1.9; // paramedics on foot, m/s
const RUN = 4.6;
const TREAT = 9; // seconds by the patient before they are up again
const ON_FOOT = 70; // m: an ambulance that can't get on, this near, lets the crew run the rest
const GIVE_UP = 60; // seconds a call waits for a street to spawn an ambulance on
const WRECKED = 80; // damage that puts an ambulance out of action
const FAR = 900; // m: someone hurt further than this from you is left to get up on their own

interface Medic { x: number; y: number; h: number; vx: number; vy: number; rig: Rig; fig: Figures; anim: Anim; down: number; spot: { x: number; y: number }; back: boolean; gone?: boolean; gz?: number; detour?: number; best: number; stuck: number }
interface Rig extends Follower { car: Car; patient: Pedestrian; phase: 'go' | 'work' | 'leave'; t: number; wrecked: boolean; crew: boolean; gone?: boolean; goal: { x: number; y: number }; astray?: boolean; mark: { x: number; y: number }; direct?: boolean; roads?: boolean; treated: number; done: number }
interface Call { patient: Pedestrian; t: number; roads?: boolean }
interface AmbulanceOptions {
  scene: THREE.Scene; police: Police; grid: CarGrid; kit: FigureKit;
  height: (x: number, y: number, who?: Car | Medic) => number;
  rng: () => number; edgesNear: (x: number, y: number, radius: number) => DriveEdge[];
  offscreen: (x: number, y: number) => boolean;
  viewRadius: () => number;
  bodyAt: (x: number, y: number, r: number, skip: Car | null) => boolean;
  people: () => Pedestrian[]; // everyone on the pavement, to find those lying hurt
  revive: (p: Pedestrian) => void; // the patient is seen to and gets up
}

export class Ambulances {
  o: AmbulanceOptions;
  rigs: Rig[] = [];
  crew: Medic[] = [];
  calls: Call[] = [];
  spare: Figures[] = [];
  spawnT = 0;
  scanT = 0;

  constructor(o: AmbulanceOptions) { this.o = o; }

  // Whether someone is already on their way to this patient (or about to be sent).
  attended(p: Pedestrian) {
    return this.calls.some((k) => k.patient === p) || this.rigs.some((r) => r.patient === p);
  }

  // Everyone lying hurt within reach of the player's part of town who nobody has been sent to yet.
  scan(me: { x: number; y: number }) {
    for (const p of this.o.people()) {
      if (p.hurt === undefined || p.state !== 'down' || this.attended(p)) continue;
      if (Math.hypot(p.x - me.x, p.y - me.y) > FAR) continue;
      this.calls.push({ patient: p, t: 0 });
    }
  }

  // Where the crew's i-th kneels: beside the patient, on the side the ambulance came from.
  spot(r: Rig, i: number) {
    const tp = r.patient, a = Math.atan2(r.car.y - tp.y, r.car.x - tp.x) + (i ? 1 : -1) * 0.9;
    // (Closer in, where a wall or a parked car is in the way.)
    let stand = 1.1;
    while (stand > 0.5 && this.blocked(tp.x + Math.cos(a) * stand, tp.y + Math.sin(a) * stand)) stand -= 0.2;
    return { x: tp.x + Math.cos(a) * stand, y: tp.y + Math.sin(a) * stand };
  }

  // A new ambulance on a street out of view, 150–300 m from the patient (further, when the
  // camera is zoomed out), on its way there. Of a few such streets, the one with the
  // shortest way round.
  dispatch(patient: Pedestrian, roads = false) {
    const { o } = this, rnd = o.rng;
    const far = Math.max(300, o.viewRadius() + 120);
    const edges = o.edgesNear(patient.x, patient.y, far);
    const stop = o.police.roadside(patient.x, patient.y, !roads);
    if (!stop) return false;
    let best: { car: Car; path: NonNullable<Rig['path']>; time: number } | null = null;
    for (let t = 0, found = 0; t < 30 && found < 4 && edges.length; t++) {
      const e = edges[Math.floor(rnd() * edges.length)];
      if (e.bridge || e.tunnel || e.path.length < 14) continue;
      const q = e.path.at(rnd() * e.path.length), d = Math.hypot(q.x - patient.x, q.y - patient.y);
      if (d < 150 || d > far || !o.offscreen(q.x, q.y)) continue;
      const path = o.police.route(q.x, q.y, stop.x, stop.y, !roads);
      if (!path) continue;
      const car = new Car('ambulance', rnd, q.x, q.y, path.at(Math.min(6, path.length)).ang);
      // (Not into a wall, nor into a tram or a queue of cars it would be wedged in.)
      if (car.worldSamples().some(([sx, sy]) => o.grid.at(sx, sy) || o.bodyAt(sx, sy, 1.2, null))) continue;
      found++;
      const foot = (path.foot ?? []).reduce((sum, [a, b]) => sum + b - a, 0), gap = Math.hypot(stop.x - patient.x, stop.y - patient.y);
      const time = (path.length - foot) / 14 + foot / 5 + Math.max(0, gap - 14) / 3.5;
      if (!best || time < best.time) best = { car, path, time };
      if (best.time < d / 14 * 1.3) break;
    }
    if (!best) return false;
    best.car.h = best.path.at(Math.min(6, best.path.length)).ang;
    best.car.mode = 'fire';
    this.rigs.push({ car: best.car, patient, path: best.path, s: 0, replan: 2, stuck: 0, reverse: 0, phase: 'go', t: 0, wrecked: false, crew: true, goal: { x: patient.x, y: patient.y }, mark: { x: best.car.x, y: best.car.y }, roads, treated: 0, done: 0 });
    return true;
  }

  knock(m: Medic, vx: number, vy: number) {
    Object.assign(m, { down: 3, vx, vy, h: Math.atan2(vy, vx) + Math.PI });
    m.anim.play('fall', true, 0.08);
  }

  dismiss(m: Medic) {
    this.o.scene.remove(m.fig.mesh);
    this.spare.push(m.fig);
  }

  // Ambulances with their lights going.
  get lit() { return this.rigs.filter((r) => !r.wrecked && !r.gone).map((r) => r.car); }

  // Dev teleport: nobody is left behind.
  reset() {
    for (const m of this.crew) this.dismiss(m);
    this.crew = [];
    this.rigs = [];
    this.calls = [];
  }

  // ---- Crew ---------------------------------------------------------------

  // The paramedics get out of the ambulance's near side and go to the patient.
  getOut(r: Rig) {
    const { o } = this, car = r.car;
    r.crew = false;
    const lx = -Math.sin(car.h), ly = Math.cos(car.h), side = car.spec.W / 2 + 0.7;
    for (let i = 0; i < CREW; i++) {
      const s = i % 2 ? -1 : 1;
      let x = car.x + lx * s * side + Math.cos(car.h) * (1.2 - i * 1.2), y = car.y + ly * s * side + Math.sin(car.h) * (1.2 - i * 1.2);
      if (o.grid.at(x, y)) { x = car.x - lx * s * side; y = car.y - ly * s * side; }
      let fig = this.spare.pop();
      if (!fig) {
        fig = new Figures(o.kit, 1);
        fig.look(0, { shirt: '#d7e01f', trousers: '#1c3a2c', skin: '#e3b99a', hair: '#2b2118', sleeves: true });
      }
      o.scene.add(fig.mesh);
      this.crew.push({ x, y, h: car.h, vx: 0, vy: 0, rig: r, fig, anim: new Anim(o.kit, 'idle'), down: 0, back: false, spot: this.spot(r, i), best: Infinity, stuck: 0 });
    }
  }

  blocked(x: number, y: number) {
    const g = this.o.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  // No wall between two points.
  sees(a: { x: number; y: number }, b: { x: number; y: number }) {
    const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.ceil(d / 0.8);
    for (let i = 1; i < n; i++) if (this.o.grid.at(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) return false;
    return true;
  }

  inWay = (x: number, y: number, r: number, skip: Car | null) => !!this.blocked(x, y) || this.o.bodyAt(x, y, r, skip);

  walk(m: Medic, dt: number) {
    const { o } = this, r = m.rig, tp = r.patient;
    if (m.down > 0) {
      m.down -= dt;
      const k = Math.exp(-4 * dt);
      m.vx *= k;
      m.vy *= k;
    } else {
      const ride = this.rigs.includes(r) && !r.wrecked;
      const attending = r.phase === 'work' && !m.back && tp.hurt !== undefined && r.treated < TREAT;
      if (attending) {
        const d = Math.hypot(m.spot.x - m.x, m.spot.y - m.y);
        // How long they've got no nearer: a paramedic hemmed in by parked cars works from where they are.
        if (d < m.best - 0.3) { m.best = d; m.stuck = 0; } else if (d > 0.5) m.stuck += dt;
        if (d > 0.5) steer(m, m.spot.x, m.spot.y, d > 10 ? RUN : WALK * 1.6, this.inWay, r.car, o.rng);
        else {
          m.vx = m.vy = 0;
          m.h = Math.atan2(tp.y - m.y, tp.x - m.x);
        }
      } else {
        // Done (or the ambulance is gone): back to it, or away if it can't take them.
        m.back = true;
        const tx = ride ? r.car.x : 2 * m.x - tp.x, ty = ride ? r.car.y : 2 * m.y - tp.y;
        steer(m, tx, ty, ride ? WALK * 1.6 : WALK, this.inWay, r.car, o.rng);
        if (ride && Math.hypot(tx - m.x, ty - m.y) < 2.8) m.gone = true;
      }
    }
    const nx = m.x + m.vx * dt, ny = m.y + m.vy * dt;
    if (!this.blocked(nx, m.y)) m.x = nx;
    if (!this.blocked(m.x, ny)) m.y = ny;
    if (m.down > 0) knocked(m.anim, dt, m.down);
    else locomote(m.anim, dt, Math.hypot(m.vx, m.vy));
    if (m.back && !this.rigs.includes(r) && o.offscreen(m.x, m.y)) m.gone = true;
  }

  // ---- Ambulances ---------------------------------------------------------

  drive(r: Rig, dt: number) {
    const { o } = this, c = r.car, tp = r.patient;
    let tx: number, ty: number, want: number;
    r.replan -= dt;
    if (r.phase === 'go') {
      const was = r.replan;
      if (!r.path) { tx = tp.x; ty = tp.y; want = 8; } else ({ tx, ty, want } = along(c, r, r.path, 26));
      if (r.replan < was) r.astray = true;
      // At the end of the way there and the patient still a way off (on a square or a
      // lawn): straight to them, if no house stands in between.
      if (r.path && r.path.length - r.s < 10 && Math.hypot(tp.x - c.x, tp.y - c.y) > 18 && this.sees(c, tp)) { r.path = null; r.direct = true; }
      if (r.path) want = Math.min(want, clamp((r.path.length - r.s - 4) * 0.9, 0, 26));
      const dist = Math.hypot(tp.x - c.x, tp.y - c.y);
      if (dist < 9) want = 0;
      // `t`: how long it's been getting nowhere.
      if (Math.hypot(c.x - r.mark.x, c.y - r.mark.y) > 4) { r.mark = { x: c.x, y: c.y }; r.t = 0; } else r.t += dt;
      // Held up on a way through a pedestrian zone or a park: by the streets instead.
      if (r.t > 5 && !r.roads && r.path?.foot) { r.roads = true; r.astray = true; r.replan = -1; }
      if (r.replan < 0) {
        if ((!r.path && !r.direct) || r.astray || !(Math.hypot(tp.x - r.goal.x, tp.y - r.goal.y) <= 10)) {
          const stop = o.police.roadside(tp.x, tp.y, !r.roads);
          if (stop) { r.path = o.police.route(c.x, c.y, stop.x, stop.y, !r.roads); r.s = 0; r.goal = { x: tp.x, y: tp.y }; r.direct = false; }
          r.astray = false;
        }
        r.replan = 3;
      }
      // Already up again (someone else saw to them, or it took too long): turn round.
      if (tp.hurt === undefined) this.leave(r);
      else if (Math.abs(c.forwardSpeed) < 2.5 && (dist < 9 || (r.path && r.path.length - r.s < 8) || (dist < 18 && r.t > 2.5) || (dist < ON_FOOT && r.t > 6))) {
        r.phase = 'work';
        r.t = 0;
        this.getOut(r);
      }
    } else if (r.phase === 'work') {
      tx = c.x + Math.cos(c.h); ty = c.y + Math.sin(c.h); want = 0;
      r.t += dt;
      // The patient is seen to once a medic is beside them, for as long as the treatment takes.
      const there = this.crew.filter((m) => m.rig === r && !m.back && m.down <= 0 && (Math.hypot(m.spot.x - m.x, m.spot.y - m.y) < 0.8 || (m.stuck > 2.5 && Math.hypot(tp.x - m.x, tp.y - m.y) < 7))).length;
      if (tp.hurt !== undefined) {
        r.treated += dt * there / CREW;
        if (r.treated >= TREAT) o.revive(tp);
      }
      // Seen to, and a paramedic still hasn't got back to the ambulance (hemmed in by parked cars): they're taken as in.
      if (tp.hurt === undefined && (r.done += dt) > 20) for (const m of this.crew) if (m.rig === r) m.gone = true;
      const out = this.crew.some((m) => m.rig === r && !m.gone);
      if (!out && !r.crew) { r.crew = true; this.leave(r); }
    } else {
      if (!r.path) { tx = c.x + Math.cos(c.h) * 20; ty = c.y + Math.sin(c.h) * 20; want = 10; } else ({ tx, ty, want } = along(c, r, r.path, 24));
      if (r.path) want = Math.min(want, clamp((r.path.length - r.s - 4) * 0.9, 4, 24));
      r.t += dt;
    }
    if (!r.crew) want = 0;
    if (r.phase === 'go' && o.police.traffic.signals?.against(c.x, c.y, c.h, 22)) want = Math.min(want, 5);
    const { throttle, steer: st } = pedals(c, r, tx, ty, want, dt);
    return { throttle, steer: st, handbrake: want === 0 && Math.abs(c.forwardSpeed) < 3 };
  }

  // Off again: to a street 250 m or more away.
  leave(r: Rig) {
    const { o } = this, c = r.car;
    r.phase = 'leave';
    r.t = 0;
    r.path = null;
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
      if (ahead > best) { best = ahead; r.path = path; }
      if (best > 0.8) break;
    }
    r.s = 0;
  }

  update(dt: number, me: { x: number; y: number }) {
    const { o } = this;
    this.scanT -= dt;
    if (this.scanT < 0) { this.scanT = 1; this.scan(me); }
    // Calls wait for a street to send an ambulance from.
    this.spawnT -= dt;
    if (this.spawnT < 0 && this.calls.length) {
      this.spawnT = 1;
      const k = this.calls[0];
      // (Already up: nobody comes. An ambulance on its way home doesn't count: it may be a while getting out of sight.)
      if (k.patient.hurt === undefined) this.calls.shift();
      else if (this.rigs.filter((r) => r.phase !== 'leave').length >= RIGS || this.rigs.length >= RIGS + 2) { /* wait for one to be free */ }
      else if (this.dispatch(k.patient, k.roads)) this.calls.shift();
      else if ((k.t += 1) > GIVE_UP) this.calls.shift();
    }
    for (const r of this.rigs) {
      const c = r.car;
      if (!r.wrecked && c.damage > WRECKED) r.wrecked = true;
      let ctl = null;
      if (!r.wrecked) ctl = this.drive(r, dt);
      else c.mode = 'loose';
      c.update(dt, ctl, o.grid);
      const d = Math.hypot(c.x - me.x, c.y - me.y), waiting = this.crew.some((m) => m.rig === r);
      r.gone = !waiting && o.offscreen(c.x, c.y) && (r.wrecked ? d > 120 : d > 250 && r.phase === 'leave');
      // Stuck for good where nobody sees it: another is sent instead.
      if (!r.wrecked && r.phase === 'go' && r.t > 8 && o.offscreen(c.x, c.y) && r.patient.hurt !== undefined) { r.gone = true; this.calls.push({ patient: r.patient, t: 0, roads: !!r.path?.foot || r.roads }); }
    }
    this.rigs = this.rigs.filter((r) => !r.gone);
    for (const m of this.crew) this.walk(m, dt);
    for (const m of this.crew) if (m.gone) this.dismiss(m);
    this.crew = this.crew.filter((m) => !m.gone);
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
