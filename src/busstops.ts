import * as THREE from 'three';
import type { BusLine } from './buses.ts';
import type { DriveEdge } from './network.ts';
import type { Traffic, TrafficAgent } from './traffic.ts';
import { project } from './buses.ts';
import { nameMaterial, postGeometry, postMaterial } from './tramstops.ts';
import { getLang, t } from './i18n.ts';

// Bus stops, and riding a bus. Every stop of the bus lines (buses.json) gets a sign on
// the pavement beside where the bus pulls up: a blue plate with a black bus, as on the
// real stops, lying flat so it reads from above, and the stop's name on the pole.
//
// Standing at one, the board (src/board.ts) lists the buses coming, counted down from
// where they actually are. Few buses are about at a time, so when none of the stop's
// lines has one on its way, one is sent: it joins its line out of sight some way back
// and comes along it. Hold Space to wait for it, as at a tram stop.
//
// When it stands at the stop, E gets you on. The strip lists the stops ahead: pick one
// (W/S, or tap it) and the ride speeds up until you're nearly there, then you get off
// when it stops there. Shift speeds up at any time, and E gets you off at the next stop
// (at once while it stands). PID's ticket covers buses as it does trams.

export const BUS_COLOUR = '#0a72b8'; // PID's blue for bus lines
const NEAR = 9; // m from a sign that counts as standing at the stop
const SAME = 150; // m: stops with the same name this close are one stop (both ways)
const MERGE = 25; // m: lines' stops this close, with the same name and heading, share a sign
const PACE = 6.5; // m/s: a bus's usual pace along its line, stops included
const HORIZON = 20 * 60; // s: buses further off than this aren't listed
const SEND_BACK = [220, 400]; // m before the stop along the line where a bus sent for you joins it
const SHOWN = 6;
const SLOW_BEFORE = 200; // m before your stop where the ride goes back to normal speed
const CELL = 50;
const STUCK = 10; // seconds standing between stops before you can get off there
const CLOSE = 40; // m: held up this near your stop, you get off and walk

// The kerb at the bus stops, kept clear of parked cars as on the real ones: from a bus's
// length behind where its front stops to a little past it, on the right of the line
// (where the bus pulls in and the sign stands, out to a wide pavement's edge).
const ZONE_BACK = 16, ZONE_ON = 4, ZONE_OUT = 12;
export function busStopZones(lines: BusLine[]) {
  const cells = new Map<number, [number, number, number, number][]>(); // x, y, cos, sin (asked for every point parking tries)
  for (const line of lines) for (const [at] of line.stops) {
    const p = line.path.at(at), z: [number, number, number, number] = [p.x, p.y, Math.cos(p.ang), Math.sin(p.ang)];
    const k = Math.floor(p.x / CELL) * 131072 + Math.floor(p.y / CELL);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(z);
  }
  return (x: number, y: number) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      for (const [zx, zy, c, s] of cells.get(i * 131072 + j) || []) {
        const dx = x - zx, dy = y - zy, along = dx * c + dy * s, side = dx * s - dy * c;
        if (along > -ZONE_BACK && along < ZONE_ON && side > 0.5 && side < ZONE_OUT) return true;
      }
    }
    return false;
  };
}

export interface BusStop {
  x: number; y: number; ang: number; name: string;
  // The lines that stop here, and where along each.
  lines: { line: BusLine; at: number; i: number }[];
  placed: boolean; mesh: THREE.Group | null; shown: boolean;
}
export interface DueBus { ref: string; colour: string; headsign: string; eta: number; here: boolean; key: unknown }

const topMaterial = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw new Error('Cannot create bus stop sign canvas');
  // The blue stop plate with a white frame, a pale field and a black bus in side view.
  g.fillStyle = '#0b4a9c';
  g.beginPath();
  g.roundRect(1, 1, 62, 62, 5);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 2.5;
  g.strokeRect(6, 6, 52, 52);
  g.fillStyle = '#eef0ee';
  g.fillRect(10, 10, 44, 44);
  g.fillStyle = '#16181a';
  g.beginPath();
  g.roundRect(13, 22, 38, 17, 3); // body
  g.fill();
  g.fillStyle = '#eef0ee';
  for (const x of [16, 23, 30, 37]) g.fillRect(x, 25, 5, 6); // windows
  g.fillRect(44, 25, 4, 10); // the front door
  g.fillStyle = '#16181a';
  for (const x of [20, 43]) { g.beginPath(); g.arc(x, 40, 3.5, 0, Math.PI * 2); g.fill(); } // wheels
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
})();
const topGeometry = new THREE.PlaneGeometry(1.9, 1.9).rotateX(-Math.PI / 2);
const plateGeometry = new THREE.PlaneGeometry(1.6, 0.3);

interface BusStopsOptions {
  scene: THREE.Scene; traffic: Traffic;
  edgesNear: (x: number, y: number, r: number) => DriveEdge[];
  solid: (x: number, y: number) => boolean; // a building or a wall there
  loaded: (x: number, y: number) => boolean; // the ground there has loaded
  onRoad: (x: number, y: number) => boolean; // on the carriageway
  offscreen: (x: number, y: number) => boolean;
  send: (line: BusLine, along: number) => boolean; // a bus onto `line` at `along` (out of sight)
  rng: () => number;
}

export class BusStops {
  o: BusStopsOptions;
  stops: BusStop[] = [];
  private grid = new Map<string, BusStop[]>();
  private sendT = 0;

  constructor(lines: BusLine[], o: BusStopsOptions) {
    this.o = o;
    for (const line of lines) {
      line.stops.forEach(([at, name], i) => {
        const p = line.path.at(at);
        const same = this.near(p.x, p.y, MERGE).find((s) => s.name === name && Math.cos(s.ang - p.ang) > 0.5);
        if (same) { same.lines.push({ line, at, i }); return; }
        const stop: BusStop = { x: p.x, y: p.y, ang: p.ang, name, lines: [{ line, at, i }], placed: false, mesh: null, shown: false };
        this.stops.push(stop);
        const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k)!.push(stop);
      });
    }
  }

  // (By where the line puts it; once placed, by its sign.)
  near(x: number, y: number, r: number) {
    const out: BusStop[] = [];
    const pad = r + 15; // (a placed sign is a few metres off where it was filed)
    for (let i = Math.floor((x - pad) / CELL); i <= Math.floor((x + pad) / CELL); i++) {
      for (let j = Math.floor((y - pad) / CELL); j <= Math.floor((y + pad) / CELL); j++) {
        for (const s of this.grid.get(`${i},${j}`) || []) if (Math.hypot(s.x - x, s.y - y) < r) out.push(s);
      }
    }
    return out;
  }

  // Out from the line onto the pavement, on its right: past the kerb of the street the
  // bus drives there (once that street has loaded), short of any wall.
  private place(s: BusStop) {
    let best: { e: DriveEdge; d: number; at: number } | null = null;
    for (const e of this.o.edgesNear(s.x, s.y, 30)) {
      const [at, d] = project(e.path, s.x, s.y);
      if (d > 8 || (best && d >= best.d)) continue;
      if (Math.cos(e.path.at(at).ang - s.ang) < 0.7) continue;
      best = { e, d, at };
    }
    if (!best) return false;
    const { e, at } = best, q = e.path.at(at), rx = Math.sin(q.ang), ry = -Math.cos(q.ang);
    const o = this.o, x = (d: number) => q.x + rx * d, y = (d: number) => q.y + ry * d;
    // (The surveyed kerb where there is one: a parking lane or a bay can lie between it and the lane.)
    let off = Math.max(1.8, (e.kerb?.[0] ?? e.width / 2) - e.laneOffset + 0.8);
    if (!o.loaded(q.x, q.y) || !o.loaded(x(off + 2), y(off + 2))) return false;
    while (off < 12 && o.onRoad(x(off), y(off))) off += 0.25;
    off += 0.3; // (a little way onto the pavement)
    while (off > 1.2 && o.solid(x(off), y(off))) off -= 0.25;
    Object.assign(s, { x: q.x + rx * off, y: q.y + ry * off, ang: q.ang, placed: true });
    return true;
  }

  private build(s: BusStop) {
    const mesh = new THREE.Group();
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.castShadow = true;
    const top = new THREE.Mesh(topGeometry, topMaterial);
    top.position.y = 2.7;
    top.rotation.y = s.ang;
    const plate = new THREE.Mesh(plateGeometry, nameMaterial(s.name));
    plate.position.y = 2.35;
    plate.rotation.y = s.ang;
    mesh.add(post, top, plate);
    return mesh;
  }

  // Only signs near the view are in the scene (and only once their street has loaded).
  sync(x: number, y: number, r: number, height: (x: number, y: number) => number) {
    for (const s of this.stops) {
      const show = Math.abs(s.x - x) < r && Math.abs(s.y - y) < r && (s.placed || this.place(s));
      if (show !== s.shown) {
        s.shown = show;
        if (show) this.o.scene.add(s.mesh ??= this.build(s));
        else if (s.mesh) this.o.scene.remove(s.mesh);
      }
      if (show) s.mesh!.position.set(s.x, height(s.x, s.y), -s.y);
    }
  }

  // The stop you're standing at, if any.
  at(x: number, y: number) {
    return this.near(x, y, NEAR).filter((s) => s.placed).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0] ?? null;
  }

  // The buses coming to the stop `s` (and the stops of its name across the street),
  // soonest first; one is sent when none is on its way. For the board.
  due(s: BusStop, dt: number) {
    const spots = this.near(s.x, s.y, SAME).filter((o) => o.name === s.name);
    const out: DueBus[] = [];
    for (const a of this.o.traffic.agents) {
      const run = a.bus;
      if (!run || run.lost) continue;
      let best: DueBus | null = null;
      for (const o of spots) for (const l of o.lines) {
        if (l.line !== run.line || l.i < run.stop) continue;
        const here = run.dwell > 0 && run.stop === l.i;
        const eta = here ? 0 : Math.max(0, l.at - run.along) / PACE;
        if (eta < HORIZON && (!best || eta < best.eta)) best = { ref: run.line.ref, colour: BUS_COLOUR, headsign: run.line.to, eta, here, key: a };
      }
      if (best) out.push(best);
    }
    out.sort((p, q) => p.eta - q.eta);
    this.sendT -= dt;
    // (Sent to the side you stand on: a bus to the other side of the street is no use to you.)
    const mine = out.some((d) => s.lines.some((l) => l.line === (d.key as TrafficAgent).bus!.line));
    if (!mine && this.sendT <= 0) {
      this.sendT = 3;
      const ways = s.lines.filter((l) => l.at > SEND_BACK[0] + 50);
      const rnd = this.o.rng;
      for (let k = 0; k < 4 && ways.length; k++) {
        const l = ways[Math.floor(rnd() * ways.length)];
        const back = SEND_BACK[0] + rnd() * (SEND_BACK[1] - SEND_BACK[0]);
        if (this.o.send(l.line, Math.max(0, l.at - back))) break;
      }
    }
    return out.slice(0, SHOWN);
  }
}

interface Rider { x: number; y: number; h: number; vx: number; vy: number; mesh: { visible: boolean }; sync(): void }
interface RideWorld { keyAt(x: number, y: number): string; available: { has(key: string): boolean }; loaded: { has(key: string): boolean } }

export class BusRide {
  a: TrafficAgent | null = null;
  dest: number | null = null; // index of the line's stop you're riding to
  off = false; // getting off at the next stop
  held = 0; // seconds the bus has stood still between stops
  scale = 1;
  waiting = false;
  private shown = '';
  constructor(private traffic: Traffic, private world: RideWorld, private el: HTMLElement, private fast: number) {
    el.addEventListener('pointerdown', (e) => {
      const b = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-stop]') : null;
      if (!b || !this.a) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(b.dataset.stop);
      this.dest = this.dest === i ? null : i;
    });
  }

  get on() { return !!this.a; }
  get run() { return this.a?.bus ?? null; }

  // A bus on its line standing at a stop beside (x, y), its doors open.
  boardable(x: number, y: number) {
    for (const a of this.traffic.agents) {
      const run = a.bus, c = a.car;
      if (!run || run.dwell <= 0.5 || run.lost) continue;
      const dx = x - c.x, dy = y - c.y, cs = Math.cos(c.h), sn = Math.sin(c.h);
      // (From the pavement: the kerb can be a parking lane away from where it stands.)
      if (Math.abs(dx * cs + dy * sn) < c.spec.L / 2 + 1.5 && Math.abs(dx * sn - dy * cs) < c.spec.W / 2 + 6) return a;
    }
    return null;
  }

  board(a: TrafficAgent, w: Rider) {
    this.a = a;
    a.hired = true; // (not taken off the streets while you're on it)
    a.bus!.dwell = Math.max(a.bus!.dwell, 2);
    Object.assign(this, { dest: null, off: false, scale: 1, shown: '', held: 0 });
    w.mesh.visible = false;
    this.el.hidden = false;
  }

  // Off at the front door, onto the pavement on its right.
  leave(w: Rider, standAt: (x: number, y: number) => [number, number]) {
    const a = this.a;
    if (!a) return;
    const c = a.car, f = c.spec.L / 2 - 1.2;
    const [x, y] = standAt(c.x + Math.cos(c.h) * f + Math.sin(c.h) * (c.spec.W / 2 + 1), c.y + Math.sin(c.h) * f - Math.cos(c.h) * (c.spec.W / 2 + 1));
    Object.assign(w, { x, y, h: c.h, vx: 0, vy: 0 });
    w.mesh.visible = true;
    w.sync();
    a.hired = false;
    this.a = null;
    this.scale = 1;
    this.el.hidden = true;
    this.shown = '';
  }

  atStop() { return (this.run?.dwell ?? 0) > 0; }
  // Held up between stops long enough that you may as well walk.
  get stuck() { return this.held > STUCK; }
  canLeave() { return this.atStop() || this.stuck; }
  watch(dt: number) { this.held = this.a && this.a.speed < 0.2 && !this.atStop() ? this.held + dt : 0; }
  // Whether you've come to the stop you're getting off at (or are held up just short of it).
  arrived() {
    const r = this.run;
    if (!r) return false;
    const getting = this.off || (this.dest !== null && r.stop >= this.dest);
    const close = r.line.stops[r.stop] && r.line.stops[r.stop][0] - r.along < CLOSE;
    return getting && (r.dwell > 0 || (this.held > 3 && close));
  }
  // Gone from the streets (crashed, or off its line where the map ends).
  get lost() { return !!this.a && (!this.traffic.agents.includes(this.a) || this.a.bus!.lost); }

  upcoming(n = SHOWN) {
    const r = this.run;
    if (!r) return [];
    const out: number[] = [];
    for (let i = r.stop + (r.dwell > 0 ? 1 : 0); i < r.line.stops.length && out.length < n; i++) out.push(i);
    return out;
  }

  pick(step: number) {
    const list = this.upcoming();
    const i = this.dest === null ? -1 : list.indexOf(this.dest);
    const j = Math.max(-1, Math.min(list.length - 1, i + step));
    this.dest = j < 0 ? null : list[j];
  }

  private toDest() {
    const r = this.run;
    return r && this.dest !== null ? r.line.stops[this.dest][0] - r.along : Infinity;
  }

  speedUp(dt: number, hold: boolean) {
    const want = hold || (this.dest !== null && !this.off && this.toDest() > SLOW_BEFORE);
    this.waiting = want && !this.loadedAhead();
    const target = want && !this.waiting ? this.fast : 1;
    this.scale += (target - this.scale) * Math.min(1, dt * (target > this.scale ? 1.5 : 4));
    if (Math.abs(this.scale - target) < 0.02) this.scale = target;
    return this.scale;
  }

  private loadedAhead() {
    const a = this.a;
    if (!a) return true;
    for (let d = 0; d <= Math.max(150, a.speed * this.fast * 4); d += 60) {
      const p = a.route.lookahead(d).p, k = this.world.keyAt(p.x, p.y);
      if (this.world.available.has(k) && !this.world.loaded.has(k)) return false;
    }
    return true;
  }

  // Keep the player (hidden) in the bus, for the camera and the life around.
  seat(w: Rider) {
    const c = this.a?.car;
    if (!c) return;
    Object.assign(w, { x: c.x, y: c.y, h: c.h, vx: c.vx * this.scale, vy: c.vy * this.scale });
  }

  render() {
    const r = this.run;
    if (!r) return;
    const list = this.upcoming(), stops = r.line.stops;
    const key = `${getLang()}|${r.line.ref}|${list.join(',')}|${this.dest}|${this.off}|${r.dwell > 0}|${this.stuck}`;
    if (key === this.shown) return;
    this.shown = key;
    const chars: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' };
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => `&${chars[c]};`);
    const here = r.dwell > 0 && stops[r.stop] ? `<div class="ride-here">${esc(t('At {name}', { name: stops[r.stop][1] }))}</div>`
      : this.stuck ? `<div class="ride-here">${esc(t('Held up in traffic'))}</div>` : '';
    this.el.innerHTML = `
      <div class="ride-line"><span class="ride-ref" style="background:${BUS_COLOUR}">${esc(r.line.ref)}</span>
      <span>${esc(t('to {name}', { name: r.line.to }))}</span></div>${here}
      <ol class="ride-stops">${list.map((i, n) => `<li><button data-stop="${i}" class="${i === this.dest || (this.off && n === 0) ? 'dest' : ''}${n === 0 ? ' next' : ''}">${esc(stops[i][1])}</button></li>`).join('')}</ol>`;
  }
}
