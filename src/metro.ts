import * as THREE from 'three';
import type { Point2 } from './map/geo.ts';
import type { Clock } from './clock.ts';

export interface MetroLine {
  ref: string; colour: string;
  stations: { name: string; at: Point2; t: number; entrances: Point2[] }[];
  perHour: Record<'weekday' | 'saturday' | 'sunday', number[]>;
}
interface Station { name: string; entrances: Point2[]; lines: { line: MetroLine; i: number }[]; onMap: boolean }
interface Entrance { x: number; y: number; station: Station; mesh: THREE.Group; shown: boolean }
interface MetroLeg { line: MetroLine; i: number; j: number }
interface MetroStep { kind: 'change' | 'wait' | 'ride'; leg: MetroLeg; from: number; to: number }

// The metro (data/<area>_now/metro.json, from pipeline/build_metro.py). It runs
// underground, so here it's a way across town: walk up to an entrance (the M signs)
// and press E, pick a station on any line, and watch the ride on the line's map with
// time passing quickly. The clock moves on by the real wait for a train, the travel
// time and any change of line, and you come up at one of the station's entrances.

const REACH = 5; // m from an entrance
const TRANSFER = 180; // s to walk between lines at a change
const SLOWEST = 60; // at least this many game seconds pass per real second of the ride…
const LONGEST = 16; // …and a ride takes at most this many real seconds

const chars: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' };
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => `&${chars[c]};`);
const mins = (s: number) => `${Math.max(1, Math.round(s / 60))} min`;

// The sign over an entrance: a white M on the line's colour, seen from above.
const signs = new Map<string, THREE.MeshBasicMaterial>();
function signMaterial(colour: string) {
  if (!signs.has(colour)) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (!g) throw new Error('Cannot create metro sign canvas');
    g.fillStyle = colour;
    g.beginPath();
    g.roundRect(2, 2, 60, 60, 12);
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 46px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('M', 32, 35);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    signs.set(colour, new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  }
  return signs.get(colour)!;
}
const signGeometry = new THREE.PlaneGeometry(2.2, 2.2).rotateX(-Math.PI / 2);
const postGeometry = new THREE.BoxGeometry(0.16, 2.8, 0.16).translate(0, 1.4, 0);
const postMaterial = new THREE.MeshLambertMaterial({ color: '#3a3d40' });

export class Metro {
  el: HTMLElement;
  scene: THREE.Scene;
  clock: Clock;
  inMap: (x: number, y: number) => boolean;
  onArrive: (x: number, y: number, name: string) => void | Promise<void>;
  lines: MetroLine[];
  stations: Map<string, Station>;
  entrances: Entrance[];
  active: boolean;
  phase: 'pick' | 'ride' | 'arriving' | null;
  tab = 0;
  sel = 0;
  from: Station | null = null;
  dest: Station | null = null;
  note = '';
  steps: MetroStep[] = [];
  total = 0;
  rate = 0;
  t = 0;
  shown = '';

  // `inMap(x, y)`: whether a spot is on the map (you can only come up there);
  // `onArrive(x, y, name)`: take the player there.
  constructor(data: { lines: MetroLine[] }, scene: THREE.Scene, el: HTMLElement, { clock, inMap, onArrive }: {
    clock: Clock; inMap: (x: number, y: number) => boolean;
    onArrive: (x: number, y: number, name: string) => void | Promise<void>;
  }) {
    this.el = el; this.scene = scene; this.clock = clock; this.inMap = inMap; this.onArrive = onArrive;
    this.lines = data.lines;
    this.stations = new Map(); // name → { name, entrances, lines: [{ line, i }] }
    this.entrances = [];
    for (const line of this.lines) {
      line.stations.forEach((s, i) => {
        if (!this.stations.has(s.name)) this.stations.set(s.name, { name: s.name, entrances: s.entrances, lines: [], onMap: false });
        this.stations.get(s.name)!.lines.push({ line, i });
      });
    }
    for (const st of this.stations.values()) {
      st.onMap = st.entrances.some(([x, y]) => inMap(x, y));
      for (const [x, y] of st.entrances) {
        const mesh = new THREE.Group();
        const post = new THREE.Mesh(postGeometry, postMaterial);
        post.castShadow = true;
        const sign = new THREE.Mesh(signGeometry, signMaterial(st.lines[0].line.colour));
        sign.position.y = 2.85;
        mesh.add(post, sign);
        this.entrances.push({ x, y, station: st, mesh, shown: false });
      }
    }
    this.active = false; // the metro screen is up
    this.phase = null; // 'pick' or 'ride'
    el.addEventListener('pointerdown', (e) => {
      const b = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-act]') : null;
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      const [act, arg] = (b.dataset.act ?? '').split(':');
      if (act === 'close') this.close();
      if (act === 'tab') { this.tab = +arg; this.sel = 0; this.render(); }
      if (act === 'go') this.go(this.tabLine().stations[+arg].name);
    });
  }

  // The station whose entrance you're standing at, if any.
  near(x: number, y: number) {
    let best: Station | null = null, bestD = REACH;
    for (const en of this.entrances) {
      const d = Math.hypot(en.x - x, en.y - y);
      if (d < bestD) { best = en.station; bestD = d; }
    }
    return best;
  }

  // Signs near the view, on the ground. Only those are in the scene: hidden ones
  // would still be gone through every frame, all 331 of them.
  sync(x: number, y: number, r: number, height: (x: number, y: number) => number) {
    for (const en of this.entrances) {
      const show = Math.abs(en.x - x) < r && Math.abs(en.y - y) < r;
      if (show !== en.shown) {
        en.shown = show;
        if (show) this.scene.add(en.mesh);
        else this.scene.remove(en.mesh);
      }
      if (show) en.mesh.position.set(en.x, height(en.x, en.y), -en.y);
    }
  }

  // Trips per hour on a line now, and the hour its trains start again when it's shut.
  perHour(line: MetroLine, clock = this.clock) { return line.perHour[clock.kind][clock.hour]; }
  opens(line: MetroLine) {
    for (let h = 1; h <= 24; h++) if (line.perHour[this.clock.kind][(this.clock.hour + h) % 24] > 0) return (this.clock.hour + h) % 24;
    return null;
  }

  shutNote(line: MetroLine) { return `The metro isn't running now: the first trains leave after ${this.opens(line) ?? 4}:00`; }

  open(station: Station) {
    this.from = station;
    this.active = true;
    this.phase = 'pick';
    const shut = station.lines.find(({ line }) => this.perHour(line) === 0);
    this.note = shut ? this.shutNote(shut.line) : '';
    this.tab = this.lines.indexOf(station.lines[0].line);
    this.sel = station.lines[0].i;
    this.el.hidden = false;
    this.render();
  }

  close() {
    this.active = false;
    this.phase = null;
    this.el.hidden = true;
  }

  tabLine() { return this.lines[this.tab]; }

  // Keyboard, while the metro screen is up.
  key(code: string) {
    if (this.phase !== 'pick') return;
    const n = this.tabLine().stations.length;
    if (code === 'Escape' || code === 'Backspace') this.close();
    else if (code === 'KeyA' || code === 'ArrowLeft') { this.tab = (this.tab + this.lines.length - 1) % this.lines.length; this.sel = Math.min(this.sel, this.tabLine().stations.length - 1); }
    else if (code === 'KeyD' || code === 'ArrowRight') { this.tab = (this.tab + 1) % this.lines.length; this.sel = Math.min(this.sel, this.tabLine().stations.length - 1); }
    else if (code === 'KeyW' || code === 'ArrowUp') this.sel = (this.sel + n - 1) % n;
    else if (code === 'KeyS' || code === 'ArrowDown') this.sel = (this.sel + 1) % n;
    else if (code === 'KeyE' || code === 'Enter' || code === 'Space') { this.go(this.tabLine().stations[this.sel].name); return; }
    this.render();
  }

  // The way from here to a station: one line, or two with a change where they meet.
  plan(to: string): MetroLeg[] | null {
    const from = this.from, dest = this.stations.get(to);
    if (!from || !dest) return null;
    for (const a of from.lines) for (const b of dest.lines) if (a.line === b.line) return [{ line: a.line, i: a.i, j: b.i }];
    for (const a of from.lines) {
      for (const b of dest.lines) {
        const x = a.line.stations.findIndex((s) => b.line.stations.some((t) => t.name === s.name));
        if (x < 0) continue;
        const y = b.line.stations.findIndex((t) => t.name === a.line.stations[x].name);
        return [{ line: a.line, i: a.i, j: x }, { line: b.line, i: y, j: b.i }];
      }
    }
    return null;
  }

  go(to: string) {
    const dest = this.stations.get(to);
    if (!dest || dest === this.from || !dest.onMap) return;
    const legs = this.plan(to);
    if (!legs) return;
    const shut = legs.find((l) => this.perHour(l.line) === 0);
    if (shut) {
      this.note = this.shutNote(shut.line);
      this.render();
      return;
    }
    // The ride as a timeline in game seconds: wait for the train, ride, (change, wait, ride).
    let t = 0;
    this.steps = [];
    legs.forEach((leg, k) => {
      if (k) { this.steps.push({ kind: 'change', leg, from: t, to: (t += TRANSFER) }); }
      const wait = Math.random() * (3600 / this.perHour(leg.line));
      this.steps.push({ kind: 'wait', leg, from: t, to: (t += wait) });
      const ride = Math.abs(leg.line.stations[leg.j].t - leg.line.stations[leg.i].t);
      this.steps.push({ kind: 'ride', leg, from: t, to: (t += ride) });
    });
    this.total = t;
    this.rate = Math.max(SLOWEST, t / LONGEST);
    this.t = 0;
    this.dest = dest;
    this.phase = 'ride';
    this.note = '';
    this.render();
  }

  // Every frame: the ride moves on, and so does the clock.
  update(dt: number) {
    if (this.phase !== 'ride') return;
    const step = Math.min(dt * this.rate, this.total - this.t);
    this.t += step;
    this.clock.advance(step);
    if (this.t >= this.total) {
      this.phase = 'arriving';
      const dest = this.dest;
      if (!dest) return;
      const [x, y] = dest.entrances.find(([ex, ey]) => this.inMap(ex, ey)) || dest.entrances[0];
      this.render();
      Promise.resolve(this.onArrive(x, y, dest.name)).finally(() => this.close());
      return;
    }
    this.render();
  }

  render() {
    if (!this.phase) return;
    const pill = (line: MetroLine) => `<span class="ride-ref" style="background:${esc(line.colour)}">${esc(line.ref)}</span>`;
    const from = this.from;
    if (!from) return;
    let html;
    if (this.phase === 'pick') {
      const line = this.tabLine(), here = line.stations.findIndex((s) => s.name === from.name);
      // A line that doesn't stop here: where to change onto it.
      const change = here < 0 ? line.stations.find((s) => from.lines.some((a) => a.line.stations.some((x) => x.name === s.name)))?.name : null;
      const tabs = this.lines.map((l, k) => `<button data-act="tab:${k}" class="metro-tab${k === this.tab ? ' on' : ''}" style="--line:${esc(l.colour)}">${esc(l.ref)}</button>`).join('');
      const rows = line.stations.map((s, k) => {
        const st = this.stations.get(s.name), mine = s.name === from.name;
        if (!st) return '';
        const note = mine ? 'You’re here' : !st.onMap ? 'Off the map' : st.lines.length > 1 ? `Change for ${st.lines.filter((x) => x.line !== line).map((x) => x.line.ref).join(', ')}` : '';
        return `<li><button data-act="go:${k}" class="${k === this.sel ? 'sel' : ''}"${mine || !st.onMap ? ' disabled' : ''}>`
          + `<span>${esc(s.name)}</span>${note ? `<small>${esc(note)}</small>` : ''}</button></li>`;
      }).join('');
      html = `<div class="metro-head"><div class="metro-title">Metro · ${esc(from.name)}</div><button data-act="close" class="metro-close" aria-label="Back to the street">×</button></div>
        <div class="metro-tabs">${tabs}</div>
        ${change ? `<div class="metro-note">Change at ${esc(change)}</div>` : ''}
        ${this.note ? `<div class="metro-note">${esc(this.note)}</div>` : ''}
        <ol class="metro-stations" style="--line:${esc(line.colour)}">${rows}</ol>
        <div class="metro-keys"><b>W</b>/<b>S</b> choose · <b>A</b>/<b>D</b> line · <b>E</b> go · <b>Esc</b> back to the street</div>`;
    } else {
      const s = this.steps.find((x) => this.t < x.to) || this.steps[this.steps.length - 1];
      if (!s || !this.dest) return;
      const { line, i, j } = s.leg, dir = j > i ? 1 : -1;
      const towards = line.stations[dir > 0 ? line.stations.length - 1 : 0].name;
      // How far along this leg the train is, in stations.
      let pos = i, status;
      if (this.phase === 'arriving') { pos = j; status = `Arriving at ${this.dest.name}…`; }
      else if (s.kind === 'wait') status = `Next train to ${towards} in ${mins(s.to - this.t)}`;
      else if (s.kind === 'change') status = `Changing to line ${line.ref} at ${line.stations[i].name}`;
      else {
        const at = line.stations[i].t + dir * (this.t - s.from);
        for (let k = i; k !== j; k += dir) if ((line.stations[k + dir].t - at) * dir <= 0) pos = k + dir;
        status = pos === j ? `Arriving at ${line.stations[j].name}` : `Next: ${line.stations[pos + dir].name}`;
      }
      const list = [];
      for (let k = i; ; k += dir) {
        list.push(`<li class="${(k - pos) * dir < 0 ? 'past' : k === pos ? 'now' : ''}${k === j ? ' end' : ''}">${esc(line.stations[k].name)}</li>`);
        if (k === j) break;
      }
      html = `<div class="metro-head"><div class="metro-title">${pill(line)} to ${esc(towards)}</div></div>
        <div class="metro-bar"><div style="width:${((100 * this.t) / this.total).toFixed(1)}%;background:${esc(line.colour)}"></div></div>
        <div class="metro-status">${esc(status)}</div>
        <ol class="metro-ride" style="--line:${esc(line.colour)}">${list.join('')}</ol>`;
    }
    if (html !== this.shown) {
      this.el.innerHTML = this.shown = html;
      this.el.querySelector('.sel, .now')?.scrollIntoView({ block: 'nearest' });
    }
  }
}
