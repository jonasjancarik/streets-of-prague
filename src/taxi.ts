// Taxis. On foot, T brings up a choice: wave down a free taxi that is passing (80 m or nearer), or order one through
// one of the two ride-hailing apps (Zipp and Hopla, made up, standing in for the real
// ones: cheaper, and their drivers are in more of a hurry). The nearest free taxi in
// the traffic (for an app, or a new one out of sight) drives to the kerb next to you and waits.
// Get in with E and pick where to go: it drives there through the streets on its own,
// sped up like a tram ride, and you pay at the end. E gets you out early.
//
// The taxi stays an ordinary car in the traffic (traffic.ts), only following a planned
// route (Route.plan) instead of random turns, and stopping where it's told.

import { FAST } from './ride.ts';
import { project } from './assist.ts';
import { Heap } from './police.ts';
import type { Traffic, TrafficAgent } from './traffic.ts';
import type { DriveEdge, DriveGraph } from './network.ts';
import { getLang, t } from './i18n.ts';
import { kc } from './money.ts';
import { padLabels } from './gamepad.ts';
import type { Wallet } from './money.ts';
import * as THREE from 'three';

// Well-known places to be driven to, as lon, lat (at a street where a taxi can stop).
export const PLACES: [string, number, number][] = [
  ['Old Town Square', 14.4196, 50.0880],
  ['Wenceslas Square', 14.4282, 50.0802],
  ['Main Station', 14.4350, 50.0835],
  ['Charles Square', 14.4185, 50.0760],
  ['Náměstí Míru', 14.4378, 50.0754],
  ['Anděl', 14.4036, 50.0712],
  ['Újezd', 14.4052, 50.0808],
  ['Prague Castle', 14.3975, 50.0898],
  ['Letná', 14.4250, 50.0975],
  ['Vyšehrad', 14.4200, 50.0650],
];

interface Firm { name: string; app: boolean; start: number; perKm: number }
const FIRMS: Firm[] = [
  { name: 'street taxi', app: false, start: 60, perKm: 36 }, // Prague's regulated top fare
  { name: 'Zipp', app: true, start: 45, perKm: 24 },
  { name: 'Hopla', app: true, start: 40, perKm: 26 },
];

const MINOR = new Set(['service', 'living_street', 'pedestrian', 'track']);
const REACH = 500; // m round you a free taxi is sent from, when ordered through an app
const HAIL = 80; // m: a street taxi has to be passing this close to be waved down
const PATIENCE = 90; // s a taxi waits for you at the kerb
const SLOW_BEFORE = 200; // m before the end of the ride where it goes back to normal speed

interface Walker { gz?: number; x: number; y: number; h: number; vx: number; vy: number; mesh: { visible: boolean }; sync(): void }
interface TaxiWorld { keyAt(x: number, y: number): string; available: { has(key: string): boolean }; loaded: { has(key: string): boolean } }

export class Taxis {
  state: 'off' | 'menu' | 'coming' | 'waiting' | 'riding' = 'off';
  agent: TrafficAgent | null = null;
  firm: Firm = FIRMS[0];
  dest: number | null = null;
  scale = 1;
  waiting = false; // held back by streets still loading
  note = ''; // a short message in the hint line, for a few seconds
  noteT = 0;
  private places: { name: string; x: number; y: number }[];
  private final = false; // the stop is where you asked to go, not just as far as the map goes
  private replan = 0;
  private wait = 0;
  private metres = 0;
  private shown = '';
  private sel: number | null = null;
  private selFor = ''; // the row picked with the arrow keys or a pad's d-pad
  private touchButton: HTMLElement | null;
  private touchShown = '';
  private beacon = new THREE.Group();
  private pillar: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private arrow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private clock = 0;

  constructor(private o: {
    scene: THREE.Scene; traffic: Traffic; drive: DriveGraph; world: TaxiWorld; el: HTMLElement; walker: Walker;
    edgesNear: (x: number, y: number, r: number) => DriveEdge[];
    offscreen: (x: number, y: number) => boolean;
    toLocal: (lon: number, lat: number) => [number, number] | null;
    standAt: (x: number, y: number) => [number, number];
    banner: (text: string) => void;
    wallet: Wallet;
  }) {
    const mat = () => new THREE.MeshBasicMaterial({ color: '#ffd23a', transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 40, 16, 1, true), mat());
    this.pillar.position.y = 22;
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 4), mat());
    this.arrow.rotation.x = Math.PI;
    this.arrow.material.opacity = 0.95;
    this.beacon.add(this.pillar, this.arrow);
    this.beacon.visible = false;
    o.scene.add(this.beacon);
    this.places = PLACES.flatMap(([name, lon, lat]) => {
      const p = o.toLocal(lon, lat);
      return p ? [{ name, x: p[0], y: p[1] }] : [];
    });
    o.el.addEventListener('pointerdown', (e) => {
      const b = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-pick]') : null;
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      this.choose(Number(b.dataset.pick));
    });
    this.touchButton = document.getElementById('t-taxi');
    this.touchButton?.addEventListener('click', () => this.key('KeyT', true));
  }

  get riding() { return this.state === 'riding'; }
  get busy() { return this.state !== 'off'; }

  private firmName() { return this.firm.app ? this.firm.name : t('Taxi'); }
  private say(text: string) { this.note = text; this.noteT = 5; }

  // Keys (on foot or in the taxi). Returns true when the key was taken.
  key(code: string, onFoot: boolean) {
    if (code === 'KeyT' && (onFoot || this.state === 'menu')) {
      if (this.state === 'off') { this.note = ''; this.noteT = 0; this.state = 'menu'; }
      else if (this.state === 'menu') this.state = 'off';
      else if (this.state !== 'riding') { this.cancel(); this.say(t('Taxi cancelled')); }
      return true;
    }
    // Arrow keys move along the list, Space (a pad's A) takes the one picked.
    if ((this.state === 'menu' || this.riding) && ['ArrowUp', 'ArrowDown', 'Space'].includes(code)) {
      const count = this.state === 'menu' ? FIRMS.length : this.places.length, now = this.sel ?? 0;
      if (code === 'ArrowUp' || code === 'ArrowDown') this.sel = (now + count + (code === 'ArrowUp' ? -1 : 1)) % count;
      else this.choose(now);
      this.shown = '';
      return true;
    }
    const n = /^Digit([0-9])$/.exec(code);
    if (n && (this.state === 'menu' || this.riding)) {
      this.choose((Number(n[1]) + 9) % 10);
      return true;
    }
    return false;
  }

  private choose(i: number) {
    if (this.state === 'menu' && FIRMS[i]) this.call(FIRMS[i]);
    else if (this.riding && this.places[i]) this.goTo(i);
  }

  // What the ride costs so far, to the nearest 5 Kč.
  private fare() { return Math.round((this.firm.start + (this.metres / 1000) * this.firm.perKm) / 5) * 5; }

  // Send a taxi to the kerb nearest the player.
  call(firm: Firm) {
    const { walker: w, traffic } = this.o;
    if (!this.o.wallet.has(firm.start)) { this.state = 'off'; this.say(t('Not enough money for a taxi (from {fare})', { fare: kc(firm.start) })); return; }
    const stop = this.stopNear(w.x, w.y, 30);
    if (!stop) { this.state = 'off'; this.say(t('No street here for a taxi to stop in')); return; }
    let best: TrafficAgent | null = null, bestD = firm.app ? REACH : HAIL;
    for (const a of traffic.agents) {
      if (a.car.type !== 'taxi' || a.hired || a.kerb) continue;
      const d = Math.hypot(a.car.x - w.x, a.car.y - w.y);
      if (d < bestD) { bestD = d; best = a; }
    }
    // A street taxi isn't called: it has to be one that happens to be passing.
    if (!best && !firm.app) { this.state = 'off'; this.say(t('No free taxi passing by. Wait for one, or order one through an app')); return; }
    best ??= traffic.spawn((x, y) => this.o.offscreen(x, y) && Math.hypot(x - w.x, y - w.y) > 120, this.o.edgesNear(w.x, w.y, 350), 'taxi');
    if (!best) { this.state = 'off'; this.say(t('No taxi free nearby. Try again in a moment')); return; }
    this.firm = firm;
    this.agent = best;
    this.note = '';
    this.noteT = 0;
    this.waiting = false;
    best.hired = true;
    best.reckless = firm.app;
    if (firm.app) best.car.refit(Math.random, true);
    this.state = 'coming';
    this.head(stop, true);
  }

  // A pillar of light and a bobbing arrow over the taxi that is yours.
  mark(dt: number) {
    const a = this.agent, on = !!a && (this.state === 'coming' || this.state === 'waiting');
    this.beacon.visible = on;
    if (!on) return;
    this.clock += dt;
    const c = a.car, ready = this.near();
    this.beacon.position.set(c.x, c.gz ?? this.o.walker.gz ?? 0, -c.y);
    this.arrow.position.y = 3.4 + Math.sin(this.clock * 3) * 0.3;
    this.pillar.material.opacity = ready ? 0.45 : 0.22 + Math.sin(this.clock * 4) * 0.06;
    this.pillar.material.color.set(ready ? '#7dff9a' : '#ffd23a');
    this.arrow.material.color.set(ready ? '#7dff9a' : '#ffd23a');
  }

  cancel() {
    const a = this.agent;
    if (a) { a.hired = a.reckless = false; a.stop = undefined; a.route.follow(null); }
    this.agent = null;
    this.state = 'off';
    this.dest = null;
    this.scale = 1;
    this.waiting = false;
    this.final = false;
    this.replan = this.wait = this.metres = 0;
    this.note = '';
    this.noteT = 0;
    this.beacon.visible = false;
    this.o.el.hidden = true;
    this.shown = '';
  }

  // The lane point nearest (x, y), within r metres, to stop at.
  // (For a place to be driven to, on a proper street, not a service road off one.)
  private stopNear(x: number, y: number, r: number, street = false) {
    let best: { edge: DriveEdge; s: number } | null = null, bestD = r;
    for (const e of this.o.edgesNear(x, y, r + 60)) {
      if (e.path.length < 10 || e.tunnel || e.bridge || (street && MINOR.has(e.hw))) continue;
      const p = project(e.path, x, y);
      if (p.d < bestD) { bestD = p.d; best = { edge: e, s: Math.min(Math.max(p.s, 4), e.path.length - 3) }; }
    }
    return best;
  }

  // Plan the way to `stop` (or as close to it as the loaded streets go) and set off.
  private head(stop: { edge: DriveEdge; s: number } | null, final: boolean, to?: { x: number; y: number }) {
    const a = this.agent;
    if (!a) return;
    const route = a.route, from = route.head;
    if (stop && from === stop.edge && route.s < stop.s - 5) {
      route.follow([]);
      a.stop = stop;
      this.final = final;
      return;
    }
    const goal = stop ? stop.edge.pts[0] : to ? [to.x, to.y] : null;
    if (!goal) return;
    const plan = this.search(from, stop?.edge ?? null, goal[0], goal[1]);
    if (!plan) return;
    route.follow(plan.edges);
    const last = plan.edges[plan.edges.length - 1] ?? from;
    this.final = plan.reached && final;
    a.stop = plan.reached && stop ? stop : { edge: last, s: last.path.length - 2 };
    this.replan = 3;
  }

  // Quickest way (by time, along one-way streets) from the end of `from` to the start of
  // `target`; with no target or none in reach, to the street end nearest (gx, gy).
  private search(from: DriveEdge, target: DriveEdge | null, gx: number, gy: number) {
    const g = this.o.drive, cost = new Map<string, number>(), prev = new Map<string, DriveEdge>();
    const open = new Heap();
    open.push([0, from.v]);
    cost.set(from.v, 0);
    let bestNode = from.v, bestD = Infinity, reached = false, pops = 0;
    while (open.size && pops++ < 40000) {
      const [c, n] = open.pop();
      if (c > (cost.get(n) ?? Infinity)) continue;
      if (target && n === target.u) { bestNode = n; reached = true; break; }
      const last = prev.get(n) ?? from, end = last.pts[last.pts.length - 1];
      const d = Math.hypot(end[0] - gx, end[1] - gy);
      if (d < bestD) { bestD = d; bestNode = n; }
      for (const e of g.out.get(n) || []) {
        // (A U-turn only where there's nothing else.)
        const nc = c + e.path.length / e.speed + (e === last.twin ? 30 : 0);
        if (nc < (cost.get(e.v) ?? Infinity)) { cost.set(e.v, nc); prev.set(e.v, e); open.push([nc, e.v]); }
      }
    }
    const edges: DriveEdge[] = [];
    for (let n = bestNode; n !== from.v;) {
      const e = prev.get(n);
      if (!e) break;
      edges.unshift(e);
      n = e.u;
      if (edges.length > 5000) return null;
    }
    if (reached && target) edges.push(target);
    return { edges, reached };
  }

  // The taxi waiting for you is right there.
  near() {
    const a = this.agent, w = this.o.walker;
    return this.state === 'waiting' && !!a && Math.hypot(a.car.x - w.x, a.car.y - w.y) < 7;
  }

  enter() {
    const w = this.o.walker;
    if (!this.near()) return false;
    this.state = 'riding';
    this.dest = null;
    this.metres = 0;
    w.mesh.visible = false;
    this.o.el.hidden = false;
    return true;
  }

  // Out of the taxi onto the pavement on its right, paying for the ride so far (or not, after a crash).
  leave(pay = true) {
    const a = this.agent, w = this.o.walker;
    if (!a) return;
    const c = a.car, [x, y] = this.o.standAt(c.x + Math.sin(c.h) * 2.2, c.y - Math.cos(c.h) * 2.2);
    Object.assign(w, { x, y, h: c.h, vx: 0, vy: 0 });
    w.mesh.visible = true;
    w.sync();
    if (pay) this.o.banner(t('{firm} fare: {fare}', { firm: this.firmName(), fare: kc(this.o.wallet.take(this.fare(), 'taxi')) }));
    this.cancel();
  }

  private goTo(i: number) {
    const a = this.agent, p = this.places[i];
    if (!a || !p) return;
    this.dest = i;
    a.stop = undefined;
    this.head(this.stopNear(p.x, p.y, 100, true), true, p);
  }

  // Once a frame, before the world steps.
  update(dt: number) {
    this.noteT -= dt;
    this.mark(dt);
    const a = this.agent;
    if (!a) return;
    // Hit hard enough to leave the traffic, or gone off the map.
    if (!this.o.traffic.agents.includes(a)) {
      const was = this.riding;
      if (was) this.leave(false);
      else this.cancel();
      this.say(t(was ? 'The taxi crashed. You got out. The ride was free' : 'Your taxi had an accident on the way'));
      return;
    }
    const c = a.car, w = this.o.walker;
    if (this.riding) this.metres += Math.hypot(c.vx, c.vy) * dt * this.scale;
    if (this.riding && this.fare() >= this.o.wallet.balance) {
      this.leave();
      this.say(t('Your money ran out, so the driver let you out'));
      return;
    }
    const left = a.stop ? a.route.to(a.stop.edge, a.stop.s) : Infinity;
    // Not there yet: plan on as more of the map loads.
    if (a.stop && !this.final && (this.state === 'coming' || this.dest !== null)) {
      this.replan -= dt * this.scale;
      if (this.replan < 0 || left < 40) {
        if (this.state === 'coming') this.head(this.stopNear(w.x, w.y, 30), true);
        else this.goTo(this.dest!);
      }
    }
    const there = this.final && left < 2 && Math.hypot(c.vx, c.vy) < 0.5;
    if (this.state === 'coming' && there) { this.state = 'waiting'; this.wait = PATIENCE; }
    if (this.state === 'waiting') {
      this.wait -= dt;
      if (this.wait < 0) { this.cancel(); this.say(t('The taxi gave up waiting and drove off')); }
      else if (Math.hypot(c.x - w.x, c.y - w.y) > 120) { this.cancel(); this.say(t('You walked away from your taxi, so it left')); }
    }
    if (this.riding && this.dest !== null && there) this.leave();
  }

  // How much faster the world runs on the way (Shift for more), as long as the streets
  // ahead have loaded.
  speedUp(dt: number, hold: boolean) {
    const a = this.agent;
    const left = a?.stop ? a.route.to(a.stop.edge, a.stop.s) : Infinity;
    const want = hold || (this.dest !== null && (!this.final || left > SLOW_BEFORE));
    this.waiting = want && !this.loadedAhead();
    const target = want && !this.waiting ? FAST : 1;
    this.scale += (target - this.scale) * Math.min(1, dt * (target > this.scale ? 1.5 : 4));
    if (Math.abs(this.scale - target) < 0.02) this.scale = target;
    return this.scale;
  }

  private loadedAhead() {
    const a = this.agent, { world } = this.o;
    if (!a) return true;
    for (let d = 0; d <= Math.max(150, a.speed * FAST * 4); d += 60) {
      const p = a.route.lookahead(d).p, k = world.keyAt(p.x, p.y);
      if (world.available.has(k) && !world.loaded.has(k)) return false;
    }
    return true;
  }

  // Keep the player (hidden) in the taxi, for the camera and the life around.
  seat() {
    const a = this.agent;
    if (!a || !this.riding) return;
    const c = a.car;
    Object.assign(this.o.walker, { x: c.x, y: c.y, h: c.h, vx: c.vx * this.scale, vy: c.vy * this.scale });
  }

  // The line in the HUD while a taxi is involved (or a note for a few seconds after).
  hint(touch: boolean, pad = false) {
    const k = (s: string) => (touch ? '' : `<b>${s}</b> `);
    return padLabels(this.line(touch, pad, k));
  }

  private line(touch: boolean, pad: boolean, k: (s: string) => string) {
    const name = this.firm.app ? t('Your {name} driver', { name: this.firm.name }) : t('Your taxi');
    if (this.state === 'coming') {
      const a = this.agent!, left = a.stop ? a.route.to(a.stop.edge, a.stop.s) : Infinity;
      const far = Number.isFinite(left) && this.final ? left : Math.hypot(a.car.x - this.o.walker.x, a.car.y - this.o.walker.y) * 1.4;
      const secs = Math.max(10, Math.round(far / (this.firm.app ? 9 : 7) / 10) * 10);
      return `${t('{name} is on the way, about {secs} s', { name, secs })} · ${touch ? '' : `${t('hold <b>Space</b> to wait')} · `}${k('T')}${t('cancel')}`;
    }
    if (this.state === 'waiting') return `${t('{name} is waiting at the kerb', { name })} · ${this.near() ? `${k('E')}${t('get in')}` : t('walk up to it (yellow marker)')} · ${k('T')}${t('cancel')}`;
    if (this.riding) {
      const parts = [];
      if (this.waiting) parts.push(t('The streets ahead are still loading'));
      else if (this.agent && this.agent.jam > 15) parts.push(t('Stuck in traffic'));
      else if (this.scale > 1.5) parts.push(t('{n}× speed', { n: Math.round(this.scale) }));
      parts.push(t('Meter: {fare}', { fare: kc(this.fare()) }));
      parts.push(this.dest === null ? `${t('Where to?')} ${t(touch || pad ? 'Pick a place' : 'Press a number')}` : t('To {name}', { name: t(this.places[this.dest].name) }));
      if (!touch) parts.push(`<b>E</b> ${t('get out here')}`);
      return parts.join(' · ');
    }
    return this.noteT > 0 ? this.note : '';
  }

  // The panel: the firms to choose from, or the places to go.
  render(touch: boolean, pad = false) {
    const { el } = this.o;
    const menu = this.state === 'menu', riding = this.riding;
    const control = `${getLang()}|${this.state}`;
    if (this.touchButton && this.touchShown !== control) {
      this.touchShown = control;
      const label = menu ? 'Close taxi menu' : this.state === 'coming' || this.state === 'waiting' ? 'Cancel taxi' : 'Taxi';
      // Keep global language changes tied to the current action, too.
      this.touchButton.dataset.t = label;
      this.touchButton.textContent = t(label);
    }
    el.hidden = !menu && !riding;
    if (el.hidden) { this.shown = ''; this.selFor = ''; return; }
    if (this.selFor !== this.state) { this.selFor = this.state; this.sel = null; }
    if (pad && this.sel === null) this.sel = 0;
    const key = `${getLang()}|${this.state}|${this.dest}|${touch}|${pad}|${this.sel}`;
    if (key === this.shown) return;
    this.shown = key;
    const n = (i: number) => (touch || pad ? '' : `<kbd>${(i + 1) % 10}</kbd> `);
    const row = (i: number, dest = false) => (dest ? 'dest' : '') + (i === this.sel ? ' sel' : '');
    const items = menu
      ? FIRMS.map((f, i) => `<li><button data-pick="${i}" class="${row(i)}">${n(i)}${f.app ? t('{name} app: {start} Kč + {perKm}/km, drives fast', { name: f.name, start: f.start, perKm: f.perKm }) : t('Wave down a passing taxi: {start} Kč + {perKm}/km', { start: f.start, perKm: f.perKm })}</button></li>`)
      : this.places.map((p, i) => `<li><button data-pick="${i}" class="${row(i, i === this.dest)}">${n(i)}${t(p.name)}</button></li>`);
    const title = menu ? `${t('Get a taxi')}${touch ? '' : ` · <b>T</b> ${t('close')}`}` : t('{firm}: where to?', { firm: this.firmName() });
    el.innerHTML = `<div class="ride-line"><span class="ride-ref" style="background:#e9c62f;color:#221f1b">TAXI</span><span>${padLabels(title)}</span></div>
      <ol class="ride-stops">${items.join('')}</ol>`;
  }
}
