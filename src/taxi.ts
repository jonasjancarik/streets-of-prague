// Taxis. On foot, T brings up a choice: wave down a street taxi, or order one through
// one of the two ride-hailing apps (Zipp and Hopla, made up, standing in for the real
// ones: cheaper, and their drivers are in more of a hurry). The nearest free taxi in
// the traffic (or a new one, out of sight) drives to the kerb next to you and waits.
// Get in with E and pick where to go: it drives there through the streets on its own,
// sped up like a tram ride, and you pay at the end. E gets you out early.
//
// The taxi stays an ordinary car in the traffic (traffic.ts), only following a planned
// route (Route.plan) instead of random turns, and stopping where it's told.

import { FAST } from './ride.ts';
import { project } from './assist.ts';
import type { Traffic, TrafficAgent } from './traffic.ts';
import type { DriveEdge, DriveGraph } from './network.ts';

// Well-known places to be driven to, as lon, lat (at a street where a taxi can stop).
export const PLACES: [string, number, number][] = [
  ['Old Town Square', 14.4196, 50.0880],
  ['Wenceslas Square', 14.4265, 50.0815],
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

const REACH = 500; // m round you a free taxi is sent from
const PATIENCE = 90; // s a taxi waits for you at the kerb
const SLOW_BEFORE = 200; // m before the end of the ride where it goes back to normal speed

interface Walker { x: number; y: number; h: number; vx: number; vy: number; mesh: { visible: boolean }; sync(): void }
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

  constructor(private o: {
    traffic: Traffic; drive: DriveGraph; world: TaxiWorld; el: HTMLElement; walker: Walker;
    edgesNear: (x: number, y: number, r: number) => DriveEdge[];
    offscreen: (x: number, y: number) => boolean;
    toLocal: (lon: number, lat: number) => [number, number] | null;
    standAt: (x: number, y: number) => [number, number];
    banner: (text: string) => void;
  }) {
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
  }

  get riding() { return this.state === 'riding'; }
  get busy() { return this.state !== 'off'; }

  private say(text: string) { this.note = text; this.noteT = 5; }

  // Keys (on foot or in the taxi). Returns true when the key was taken.
  key(code: string, onFoot: boolean) {
    if (code === 'KeyT' && (onFoot || this.state === 'menu')) {
      if (this.state === 'off') this.state = 'menu';
      else if (this.state === 'menu') this.state = 'off';
      else if (this.state !== 'riding') { this.cancel(); this.say('Taxi cancelled'); }
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

  // Send a taxi to the kerb nearest the player.
  call(firm: Firm) {
    const { walker: w, traffic } = this.o;
    const stop = this.stopNear(w.x, w.y, 30);
    if (!stop) { this.state = 'off'; this.say('No street here for a taxi to stop in'); return; }
    let best: TrafficAgent | null = null, bestD = REACH;
    for (const a of traffic.agents) {
      if (a.car.type !== 'taxi' || a.hired || a.kerb) continue;
      const d = Math.hypot(a.car.x - w.x, a.car.y - w.y);
      if (d < bestD) { bestD = d; best = a; }
    }
    best ??= traffic.spawn((x, y) => this.o.offscreen(x, y) && Math.hypot(x - w.x, y - w.y) > 120, this.o.edgesNear(w.x, w.y, 350), 'taxi');
    if (!best) { this.state = 'off'; this.say('No taxi free nearby. Try again in a moment'); return; }
    this.firm = firm;
    this.agent = best;
    best.hired = true;
    best.reckless = firm.app;
    this.state = 'coming';
    this.head(stop, true);
  }

  cancel() {
    const a = this.agent;
    if (a) { a.hired = a.reckless = false; a.stop = undefined; a.route.follow(null); }
    this.agent = null;
    this.state = 'off';
    this.dest = null;
    this.scale = 1;
    this.o.el.hidden = true;
    this.shown = '';
  }

  // The lane point nearest (x, y), within r metres, to stop at.
  private stopNear(x: number, y: number, r: number) {
    let best: { edge: DriveEdge; s: number } | null = null, bestD = r;
    for (const e of this.o.edgesNear(x, y, r + 60)) {
      if (e.path.length < 10 || e.tunnel || e.bridge) continue;
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
    const open: [number, string][] = [[0, from.v]];
    cost.set(from.v, 0);
    let bestNode = from.v, bestD = Infinity, reached = false, pops = 0;
    while (open.length && pops++ < 40000) {
      let k = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[k][0]) k = i;
      const [c, n] = open[k];
      open[k] = open[open.length - 1];
      open.pop();
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

  // Get in: the taxi waiting for you is right there.
  enter() {
    const a = this.agent, w = this.o.walker;
    if (this.state !== 'waiting' || !a || Math.hypot(a.car.x - w.x, a.car.y - w.y) > 7) return false;
    this.state = 'riding';
    this.dest = null;
    this.metres = 0;
    w.mesh.visible = false;
    this.o.el.hidden = false;
    return true;
  }

  // Out of the taxi onto the pavement on its right, paying for the ride so far.
  leave() {
    const a = this.agent, w = this.o.walker;
    if (!a) return;
    const c = a.car, [x, y] = this.o.standAt(c.x + Math.sin(c.h) * 2.2, c.y - Math.cos(c.h) * 2.2);
    Object.assign(w, { x, y, h: c.h, vx: 0, vy: 0 });
    w.mesh.visible = true;
    w.sync();
    const fare = Math.round((this.firm.start + (this.metres / 1000) * this.firm.perKm) / 5) * 5;
    this.o.banner(`${this.firm.app ? this.firm.name : 'Taxi'} fare: ${fare} Kč`);
    this.cancel();
  }

  private goTo(i: number) {
    const a = this.agent, p = this.places[i];
    if (!a || !p) return;
    this.dest = i;
    a.stop = undefined;
    this.head(this.stopNear(p.x, p.y, 80), true, p);
  }

  // Once a frame, before the world steps.
  update(dt: number) {
    this.noteT -= dt;
    const a = this.agent;
    if (!a) return;
    // Hit hard enough to leave the traffic, or gone off the map.
    if (!this.o.traffic.agents.includes(a)) {
      const was = this.riding;
      if (was) this.leave();
      else this.cancel();
      this.say(was ? 'The taxi crashed. You got out' : 'Your taxi had an accident on the way');
      return;
    }
    const c = a.car, w = this.o.walker;
    if (this.riding) this.metres += Math.hypot(c.vx, c.vy) * dt * this.scale;
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
      if (this.wait < 0) { this.cancel(); this.say('The taxi gave up waiting and drove off'); }
      else if (Math.hypot(c.x - w.x, c.y - w.y) > 120) { this.cancel(); this.say('You walked away from your taxi, so it left'); }
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
  hint(touch: boolean) {
    const k = (s: string) => (touch ? '' : `<b>${s}</b> `);
    const name = this.firm.app ? `Your ${this.firm.name} driver` : 'Your taxi';
    if (this.state === 'coming') {
      const a = this.agent!, left = a.stop ? a.route.to(a.stop.edge, a.stop.s) : Infinity;
      const far = Number.isFinite(left) && this.final ? left : Math.hypot(a.car.x - this.o.walker.x, a.car.y - this.o.walker.y) * 1.4;
      const secs = Math.max(10, Math.round(far / (this.firm.app ? 9 : 7) / 10) * 10);
      return `${name} is on the way, about ${secs} s · ${k('T')}cancel`;
    }
    if (this.state === 'waiting') return `${name} is waiting at the kerb · ${k('E')}get in · ${k('T')}cancel`;
    if (this.riding) {
      const parts = [];
      if (this.waiting) parts.push('The streets ahead are still loading');
      else if (this.scale > 1.5) parts.push(`${Math.round(this.scale)}× speed`);
      parts.push(this.dest === null ? `Where to? ${touch ? 'Pick a place' : 'Press a number'}` : `To ${this.places[this.dest].name}`);
      if (!touch) parts.push('<b>E</b> get out here');
      return parts.join(' · ');
    }
    return this.noteT > 0 ? this.note : '';
  }

  // The panel: the firms to choose from, or the places to go.
  render(touch: boolean) {
    const { el } = this.o;
    const menu = this.state === 'menu', riding = this.riding;
    el.hidden = !menu && !riding;
    if (el.hidden) { this.shown = ''; return; }
    const key = `${this.state}|${this.dest}|${touch}`;
    if (key === this.shown) return;
    this.shown = key;
    const n = (i: number) => (touch ? '' : `<kbd>${(i + 1) % 10}</kbd> `);
    const items = menu
      ? FIRMS.map((f, i) => `<li><button data-pick="${i}">${n(i)}${f.app ? `Order a ${f.name} (app, cheaper, drivers in a hurry)` : 'Wave down a street taxi'}</button></li>`)
      : this.places.map((p, i) => `<li><button data-pick="${i}" class="${i === this.dest ? 'dest' : ''}">${n(i)}${p.name}</button></li>`);
    const title = menu ? `Get a taxi${touch ? '' : ' · <b>T</b> close'}` : `${this.firm.app ? this.firm.name : 'Taxi'}: where to?`;
    el.innerHTML = `<div class="ride-line"><span class="ride-ref" style="background:#e9c62f;color:#221f1b">TAXI</span><span>${title}</span></div>
      <ol class="ride-stops">${items.join('')}</ol>`;
  }
}
