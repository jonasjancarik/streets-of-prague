import * as THREE from 'three';
import { Figures, Anim, SCALE, randomLook } from './figures.ts';
import { locomote, knocked } from './people.ts';
import { steer } from './police.ts';
import { DECIDE, FINE, FINE_LATE } from './money.ts';
import { t } from './i18n.ts';
import * as telemetry from './telemetry.ts';
import type { FigureKit } from './figures.ts';
import type { CarGrid, Car } from './car.ts';
import type { Wallet } from './money.ts';

// Ticket inspectors. Riding without a ticket, you may be checked (see the chances in
// money.ts). You get a few seconds to pay the fine or get off and run.
//
// If you run, a plain-clothes inspector appears beside you and chases you on foot.
// They never shoot or drive. Catching you costs the fine. After 10 s without a catch,
// or at once if you get into a vehicle, they phone the police: that's the crime
// `fareDodge` (one star), and the fine goes up. It's collected if the police then
// arrest you (`owed`), and forgotten if you get away. The inspector gives up after
// 30 s or 60 m, walks off and vanishes out of sight. They can be knocked over like
// anyone else.

const RUN = 6; // m/s
const REACH = 1.1; // m: within it, they've caught you
const CALL_AFTER = 10; // s of running before they phone the police
const GIVE_UP = 30; // s
const FAR = 60; // m
const APPEAR = 0.5; // s after you get off a tram
const STREET_MOVE = 3; // m you may move from where you were checked before it counts as running

export interface Chaser { x: number; y: number; h: number; vx: number; vy: number; gz?: number; down: number; detour?: number }
interface Me { x: number; y: number; h: number; onFoot: boolean; inVehicle: boolean }

export class Inspector {
  phase: 'off' | 'decide' | 'chase' | 'leaving' = 'off';
  where: 'tram' | 'funicular' | 'street' = 'street';
  left = 0; // s to decide
  called = false; // the police have been called
  owed = 0; // Kč owed for running off, collected if the police catch you
  person: Chaser | null = null;
  private t = 0; // s since you ran
  private delay = 0; // s until the figure appears
  private at: [number, number] = [0, 0]; // where the check began
  private fig: Figures | null = null;
  private anim: Anim | null = null;

  constructor(private o: {
    scene: THREE.Scene; kit: FigureKit; grid: CarGrid; rng: () => number; wallet: Wallet;
    bodyAt: (x: number, y: number, r: number, skip: Car | null) => boolean;
    offscreen: (x: number, y: number) => boolean;
    crime: (x: number, y: number) => void;
    fined: (paid: number) => void;
    banner: (text: string) => void;
  }) {}

  start(where: 'tram' | 'funicular' | 'street', x = 0, y = 0) {
    this.reset();
    telemetry.did('ticket inspection');
    this.phase = 'decide';
    this.where = where;
    this.left = DECIDE;
    this.at = [x, y];
  }

  // Pay the fine (all you have, if it's not enough).
  pay() {
    if (this.phase === 'off') return;
    this.o.fined(this.o.wallet.take(FINE, 'fine'));
    this.owed = 0;
    if (this.phase === 'decide') this.reset(); else this.phase = 'leaving';
  }

  // You've got off and run: the inspector comes out beside where you are.
  run(x: number, y: number, h: number) {
    if (this.phase !== 'decide') return;
    telemetry.did('ran from the inspector');
    this.phase = 'chase';
    this.t = 0;
    this.called = false;
    this.delay = this.where === 'tram' ? APPEAR : 0;
    let px = x, py = y;
    for (const side of [1, -1]) {
      const sx = x + Math.cos(h + side * Math.PI / 2) * 1.5, sy = y + Math.sin(h + side * Math.PI / 2) * 1.5;
      if (!this.o.grid.at(sx, sy)) { px = sx; py = sy; break; }
    }
    if (!this.fig) {
      this.fig = new Figures(this.o.kit, 1);
      this.fig.look(0, randomLook(this.o.rng));
      this.fig.mesh.visible = false;
      this.o.scene.add(this.fig.mesh);
    } else this.fig.look(0, randomLook(this.o.rng));
    this.anim = new Anim(this.o.kit, 'idle');
    this.person = { x: px, y: py, h, vx: 0, vy: 0, down: 0 };
  }

  knock(vx: number, vy: number) {
    const p = this.person;
    if (!p || !this.anim) return;
    Object.assign(p, { down: 3, vx, vy, h: Math.atan2(vy, vx) + Math.PI });
    this.anim.play('fall', true, 0.08);
  }

  private call() {
    const p = this.person;
    if (this.called || !p) return;
    this.called = true;
    this.owed = FINE_LATE;
    this.o.crime(p.x, p.y);
    this.o.banner(t('The inspector called the police'));
  }

  private blocked(x: number, y: number) {
    const g = this.o.grid, r = 0.3;
    return g.at(x, y) || g.at(x + r, y) || g.at(x - r, y) || g.at(x, y + r) || g.at(x, y - r);
  }

  update(dt: number, me: Me) {
    if (this.phase === 'off') return;
    if (this.phase === 'decide') {
      this.left -= dt;
      if (this.where === 'street' && Math.hypot(me.x - this.at[0], me.y - this.at[1]) > STREET_MOVE) this.run(me.x, me.y, me.h);
      else if (this.left <= 0) this.pay();
      return;
    }
    const p = this.person;
    if (!p) { this.phase = 'off'; return; }
    if (this.delay > 0) { this.delay -= dt; return; }
    this.t += dt;
    const d = Math.hypot(me.x - p.x, me.y - p.y);
    if (this.phase === 'chase') {
      if (!this.called && (this.t > CALL_AFTER || me.inVehicle)) this.call();
      if (this.t > GIVE_UP || d > FAR || (this.called && me.inVehicle)) this.phase = 'leaving';
      else if (me.onFoot && p.down <= 0 && d < REACH) { this.pay(); return; }
    }
    if (p.down > 0) {
      p.down -= dt;
      const k = Math.exp(-4 * dt);
      p.vx *= k;
      p.vy *= k;
    } else if (this.phase === 'chase') steer(p, me.x, me.y, RUN, this.o.bodyAt, null, this.o.rng);
    else steer(p, 2 * p.x - me.x, 2 * p.y - me.y, 1.4, this.o.bodyAt, null, this.o.rng);
    const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
    if (!this.blocked(nx, p.y)) p.x = nx;
    if (!this.blocked(p.x, ny)) p.y = ny;
    if (this.anim) {
      if (p.down > 0) knocked(this.anim, dt, p.down);
      else locomote(this.anim, dt, Math.hypot(p.vx, p.vy));
    }
    if (this.phase === 'leaving' && this.o.offscreen(p.x, p.y)) this.reset();
  }

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private sc = new THREE.Vector3(SCALE, SCALE, SCALE);

  render(height: (x: number, y: number, who: Chaser) => number) {
    const p = this.person, fig = this.fig;
    if (!fig) return;
    fig.mesh.visible = !!p && this.delay <= 0;
    if (!p || !this.anim || this.delay > 0) return;
    this.m.compose(this.v.set(p.x, height(p.x, p.y, p), -p.y), this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.h), this.sc);
    fig.set(0, this.m, this.anim);
    fig.commit(1);
  }

  // The check and the chase are over (a teleport, being wasted or busted). What's owed
  // stays, for the police to collect.
  reset() {
    this.phase = 'off';
    this.person = null;
    this.called = false;
    this.delay = 0;
    if (this.fig) this.fig.mesh.visible = false;
  }
}
