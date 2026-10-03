import { padLabels } from './gamepad.ts';
import * as THREE from 'three';
import type { Point2 } from './map/geo.ts';
import type { Clock } from './clock.ts';
import { t } from './i18n.ts';
import { TICKETS, validity, kc } from './money.ts';
import type { TicketKind } from './money.ts';

interface Fares { valid(): boolean; afford(kind: TicketKind): boolean; buy(kind: TicketKind): boolean }
import { Track, Underground, DEPTH } from './underground.ts';

export interface MetroLine {
  ref: string; colour: string;
  // The track, first station to last, and how far along it each station is (m); data
  // from before build_metro.py wrote them has neither.
  path?: Point2[];
  stations: { name: string; at: Point2; t: number; d?: number; entrances: Point2[] }[];
  perHour: Record<'weekday' | 'saturday' | 'sunday', number[]>;
}
interface Station { name: string; entrances: Point2[]; lines: { line: MetroLine; i: number }[]; onMap: boolean }
// `placed`: moved out onto the pavement (see place()); `gone`: another of the
// station's entrances ended up in the same spot.
interface Entrance { x: number; y: number; station: Station; mesh: THREE.Group; shown: boolean; placed: boolean; gone: boolean }
interface MetroLeg { line: MetroLine; i: number; j: number }
// A stretch of the ride: the wait for a train, a change of line, or the ride from
// station a to the next one, b. `from`/`to` in game seconds; `real`: how many seconds
// it takes to watch.
interface MetroStep { kind: 'change' | 'wait' | 'ride'; leg: MetroLeg; from: number; to: number; real: number; a: number; b: number }
// The view during a ride: where to look (m), how fast that moves (m/s), the ground
// above the train, the hole round it and how high to watch from.
export interface MetroView { x: number; y: number; vx: number; vy: number; ground: number; floor: number; r: number; height: number }

// The metro (data/<area>_now/metro.json, from pipeline/build_metro.py). It runs
// underground, so here it's a way across town: walk up to an entrance (the M signs)
// and press E, pick a station on any line, and watch the ride with time passing
// quickly. The view follows your train along the real track deep under the streets,
// seen through a hole in the ground as in a road tunnel (underground.ts), stopping at
// every station on the way. The clock moves on by the
// real wait for a train, the travel time and any change of line, and you come up at
// one of the station's entrances. E skips to the end of the ride.

const REACH = 5; // m from an entrance
const MERGE = 6; // m: a station's entrances closer than this show as one sign
const TRANSFER = 180; // s to walk between lines at a change
const SLOWEST = 60; // without a track: at least this many game seconds per real second…
const LONGEST = 16; // …and a ride takes at most this many real seconds
const SHOW_WAIT = 3; // real seconds to watch the wait for a train (it pulls in at the end)…
const SHOW_CHANGE = 1.6; // …or a change of line
const APPROACH = 120; // m the train comes in from
const LEG_SECONDS = 25; // a leg of the ride takes about this long to watch…
const SLOW = 70, FAST = 140; // …at this many metres a second or more, and no faster
const HOP = 3; // real seconds at least from one station to the next…
const DWELL = 0.8; // …and standing at each
const HOLE = 62; // m round the train, opened in the ground (the train is 97 m long)

const chars: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' };
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => `&${chars[c]};`);
const mins = (s: number) => t('{n} min', { n: Math.max(1, Math.round(s / 60)) });

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
  ready: (x: number, y: number) => boolean;
  standAt: (x: number, y: number) => Point2;
  onArrive: (x: number, y: number, name: string) => void | Promise<void>;
  onStation: (name: string) => void;
  lines: MetroLine[];
  tracks = new Map<MetroLine, Track>();
  stations: Map<string, Station>;
  entrances: Entrance[];
  active: boolean;
  phase: 'ticket' | 'pick' | 'ride' | 'arriving' | null;
  dodging = false; // going without a ticket, on this trip
  choice = 1; // the ticket screen's pick: a ticket (0 to 3, by TICKETS), or 4 to go in without
  fares: Fares | null;
  tab = 0;
  sel = 0;
  from: Station | null = null;
  dest: Station | null = null;
  note = '';
  steps: MetroStep[] = [];
  total = 0;
  t = 0; // game seconds into the ride
  k = 0; // the step it's at…
  r = 0; // …and real seconds into that
  pace = 1; // slower while the map ahead is still loading
  shown = '';
  // The tunnels and the train (see underground.ts), and the ground above them.
  under: Underground;
  ground = 0;
  terrain: (x: number, y: number) => number;
  announced = -1; // the step whose station has been announced

  // `inMap(x, y)`: whether a spot is on the map (you can only come up there);
  // `ready(x, y)`: whether the map there has loaded (or never will);
  // `terrain(x, y)`: the height of the ground there (once loaded); `standAt(x, y)`:
  // the nearest spot there where you can stand (once loaded);
  // `onArrive(x, y, name)`: take the player there; `onStation(name)`: the train
  // stops at a station on the way.
  constructor(data: { lines: MetroLine[] }, scene: THREE.Scene, el: HTMLElement, { clock, inMap, ready, terrain, standAt, onArrive, onStation, fares }: {
    clock: Clock; inMap: (x: number, y: number) => boolean; ready: (x: number, y: number) => boolean;
    terrain: (x: number, y: number) => number; standAt: (x: number, y: number) => Point2;
    onArrive: (x: number, y: number, name: string) => void | Promise<void>; onStation: (name: string) => void;
    fares?: Fares;
  }) {
    this.fares = fares ?? null;
    this.el = el; this.scene = scene; this.clock = clock; this.inMap = inMap; this.ready = ready; this.terrain = terrain; this.standAt = standAt;
    this.onArrive = onArrive; this.onStation = onStation;
    this.under = new Underground(scene);
    this.lines = data.lines;
    for (const line of this.lines) {
      if (line.path && line.path.length > 1 && line.stations.every((s) => typeof s.d === 'number')) this.tracks.set(line, new Track(line.path));
    }
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
        this.entrances.push({ x, y, station: st, mesh, shown: false, placed: false, gone: false });
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
      if (act?.startsWith('buy:')) this.ticket(Number(act.slice(4)));
      if (act === 'nobuy') this.ticket(null);
      if (act === 'go') this.go(this.tabLine().stations[+arg].name);
      if (act === 'skip') this.skip();
    });
  }

  // The station whose entrance you're standing at, if any.
  near(x: number, y: number) {
    let best: Station | null = null, bestD = REACH;
    for (const en of this.entrances) {
      if (en.gone) continue;
      const d = Math.hypot(en.x - x, en.y - y);
      if (d < bestD) { best = en.station; bestD = d; }
    }
    return best;
  }

  // Signs near the view, on the ground. Only those are in the scene: hidden ones
  // would still be gone through every frame, all 331 of them.
  sync(x: number, y: number, r: number, height: (x: number, y: number) => number) {
    for (const en of this.entrances) {
      const near = Math.abs(en.x - x) < r && Math.abs(en.y - y) < r;
      if (near && !en.placed) this.place(en);
      const show = near && !en.gone;
      if (show !== en.shown) {
        en.shown = show;
        if (show) this.scene.add(en.mesh);
        else this.scene.remove(en.mesh);
      }
      if (show) en.mesh.position.set(en.x, height(en.x, en.y), -en.y);
    }
  }

  // Many entrances open from an arcade or a passage through a house, and the
  // timetable puts them inside it, where you can't walk: out onto the pavement in
  // front, once the map there has loaded. Two of a station's entrances that end up
  // together make one sign.
  private place(en: Entrance) {
    if (!this.ready(en.x, en.y)) return;
    [en.x, en.y] = this.standAt(en.x, en.y);
    en.placed = true;
    en.gone = this.entrances.some((o) => o !== en && o.station === en.station && o.placed && !o.gone && Math.hypot(o.x - en.x, o.y - en.y) < MERGE);
  }

  // Trips per hour on a line now, and the hour its trains start again when it's shut.
  perHour(line: MetroLine, clock = this.clock) { return line.perHour[clock.kind][clock.hour]; }
  opens(line: MetroLine) {
    for (let h = 1; h <= 24; h++) if (line.perHour[this.clock.kind][(this.clock.hour + h) % 24] > 0) return (this.clock.hour + h) % 24;
    return null;
  }

  shutNote(line: MetroLine) { return t('The metro isn’t running now: the first trains leave after {hour}:00', { hour: this.opens(line) ?? 4 }); }

  open(station: Station) {
    this.from = station;
    this.active = true;
    this.dodging = false;
    const shut = station.lines.find(({ line }) => this.perHour(line) === 0);
    this.phase = this.fares && !this.fares.valid() && !shut ? 'ticket' : 'pick';
    this.choice = 1;
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
    this.el.classList.remove('riding');
    this.under.hide();
  }

  tabLine() { return this.lines[this.tab]; }

  // The ticket screen: buy one (if you can), or go in without.
  private ticket(pick: number | null) {
    if (this.phase !== 'ticket') return;
    if (pick !== null && !this.fares?.buy(TICKETS[pick])) return;
    this.dodging = pick === null;
    this.phase = 'pick';
    this.render();
  }

  // Keyboard, while the metro screen is up.
  key(code: string, repeat = false) {
    if (this.phase === 'ride' && !repeat && ['KeyE', 'Enter', 'Space'].includes(code)) this.skip();
    if (this.phase === 'ticket') {
      if (code === 'Escape' || code === 'Backspace') this.close();
      else if (/^Digit[1-4]$/.test(code)) this.ticket(Number(code.slice(5)) - 1);
      else if (code === 'Digit5') this.ticket(null);
      else if (['KeyW', 'ArrowUp'].includes(code)) { this.choice = (this.choice + TICKETS.length) % (TICKETS.length + 1); this.render(); }
      else if (['KeyS', 'ArrowDown'].includes(code)) { this.choice = (this.choice + 1) % (TICKETS.length + 1); this.render(); }
      else if (code === 'KeyE' || code === 'Enter' || code === 'Space') this.ticket(this.choice < TICKETS.length ? this.choice : null);
      return;
    }
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
    // The ride as a timeline: wait for the train, ride station by station, (change,
    // wait, ride). Game seconds by the timetable; the real seconds it takes to watch go
    // by the distance, where the track is known.
    let t = 0;
    const steps: MetroStep[] = [];
    legs.forEach((leg, n) => {
      const { line, i, j } = leg, st = line.stations, dir = j > i ? 1 : -1, tracked = this.tracks.has(line);
      if (n) steps.push({ kind: 'change', leg, from: t, to: (t += TRANSFER), real: SHOW_CHANGE, a: i, b: i });
      const wait = Math.random() * (3600 / this.perHour(line));
      steps.push({ kind: 'wait', leg, from: t, to: (t += wait), real: SHOW_WAIT, a: i, b: i });
      const speed = Math.min(FAST, Math.max(SLOW, Math.abs((st[j].d ?? 0) - (st[i].d ?? 0)) / LEG_SECONDS));
      for (let a = i; a !== j; a += dir) {
        const b = a + dir, time = Math.abs(st[b].t - st[a].t);
        steps.push({ kind: 'ride', leg, from: t, to: (t += time), real: tracked ? Math.max(HOP, Math.abs(st[b].d! - st[a].d!) / speed) + DWELL : 0, a, b });
      }
    });
    // Without a track, the whole ride in at most LONGEST seconds, as before.
    const rate = Math.max(SLOWEST, t / LONGEST);
    for (const s of steps) if (!s.real) s.real = (s.to - s.from) / rate;
    this.steps = steps;
    this.total = t;
    this.t = this.r = this.k = 0;
    this.pace = 1;
    this.announced = -1;
    const first = this.state();
    if (first) this.ground = this.terrain(first.x, first.y);
    this.dest = dest;
    this.phase = 'ride';
    this.note = '';
    this.el.classList.add('riding');
    this.render();
  }

  // Every frame: the ride moves on, and so does the clock.
  update(dt: number) {
    if (this.phase !== 'ride') return;
    // Held back while the map along the track ahead is still loading.
    const ahead = this.loadedAhead();
    this.pace += ((ahead ? 1 : 0.15) - this.pace) * Math.min(1, dt * (ahead ? 2 : 6));
    this.r += dt * this.pace;
    while (this.k < this.steps.length && this.r >= this.steps[this.k].real) this.r -= this.steps[this.k++].real;
    const s = this.steps[this.k];
    this.moveTo(s ? s.from + (s.to - s.from) * (this.r / s.real) : this.total);
    // The train stands at a station: say which.
    if (s?.kind === 'ride' && this.tracks.has(s.leg.line) && this.r >= s.real - DWELL && this.announced !== this.k) {
      this.announced = this.k;
      this.onStation(s.leg.line.stations[s.b].name);
    }
    this.draw(dt);
    if (!s) this.arrive();
    else this.render();
  }

  // Straight to the end of the ride, the clock too.
  skip() {
    if (this.phase !== 'ride') return;
    this.k = this.steps.length;
    this.r = 0;
    this.moveTo(this.total);
    this.arrive();
  }

  private moveTo(t: number) {
    this.clock.advance(Math.max(0, t - this.t));
    this.t = Math.max(this.t, t);
  }

  private arrive() {
    this.phase = 'arriving';
    const dest = this.dest;
    if (!dest) return;
    const [x, y] = dest.entrances.find(([ex, ey]) => this.inMap(ex, ey)) || dest.entrances[0];
    this.render();
    Promise.resolve(this.onArrive(x, y, dest.name)).finally(() => this.close());
  }

  // Where the ride is: the station or the train to watch (m along the track, and x, y),
  // how fast that moves (m per real second), where the train is (its middle, m along;
  // null while it hasn't come in yet) and which way it goes along the track.
  private state() {
    if (this.phase !== 'ride' && this.phase !== 'arriving') return null;
    const step = this.steps[Math.min(this.k, this.steps.length - 1)];
    const track = step && this.tracks.get(step.leg.line);
    if (!step || !track) return null;
    const { line, i, j } = step.leg, st = line.stations, da = st[step.a].d!, db = st[step.b].d!;
    const dir = Math.sign(st[j].d! - st[i].d!) || 1, f = Math.min(1, this.r / step.real);
    let d = da, v = 0, train: number | null = da;
    if (this.phase === 'arriving') d = train = step.kind === 'ride' ? db : da;
    else if (step.kind === 'change') train = null;
    else if (step.kind === 'wait') {
      // The train comes in at the end of the wait, slowing to a stop.
      const u = (f - 0.35) / 0.65;
      train = u < 0 ? null : da - dir * APPROACH * (1 - u) ** 2;
    } else {
      // Pulling away from a station and slowing into the next, then standing there.
      const g = Math.min(1, this.r / (step.real - DWELL));
      d = train = da + (db - da) * (1 - Math.cos(Math.PI * g)) / 2;
      v = g < 1 ? ((db - da) * Math.PI / 2) * Math.sin(Math.PI * g) / (step.real - DWELL) * this.pace : 0;
    }
    const cruise = step.kind === 'ride' ? Math.abs(db - da) / (step.real - DWELL) : SLOW;
    const p = track.point(d);
    return { step, track, line, d, v, train, dir, cruise, x: p.x, y: p.y, ang: p.ang };
  }

  // Whether the map along the track has loaded for the next couple of seconds' ride.
  loadedAhead() {
    const s = this.state();
    if (!s) return true;
    for (let k = 0; k <= Math.max(200, s.cruise * 2.5); k += 100) {
      const p = s.track.point(s.d + s.dir * k);
      if (!this.ready(p.x, p.y)) return false;
    }
    return true;
  }

  // Where the view should be during the ride: over the train, going its way. Null
  // while choosing a station, or with no track to follow.
  view(): MetroView | null {
    const s = this.state();
    if (!s) return null;
    return {
      x: s.x, y: s.y, vx: Math.cos(s.ang) * s.v, vy: Math.sin(s.ang) * s.v,
      ground: this.ground, floor: this.ground - DEPTH, r: HOLE, height: 130 + s.cruise * 0.6,
    };
  }

  // The tunnels and the train where the ride is, under the ground (once it's loaded
  // there: until then, as deep as before).
  private draw(dt: number) {
    const s = this.state();
    if (!s) return this.under.hide();
    if (this.ready(s.x, s.y)) this.ground += (this.terrain(s.x, s.y) - this.ground) * Math.min(1, dt * 3);
    this.under.show(s.track, s.line.colour, s.line.stations.map((x) => x.d!));
    this.under.place(this.ground, s.train, s.dir);
  }

  render() {
    if (!this.phase) return;
    const pill = (line: MetroLine) => `<span class="ride-ref" style="background:${esc(line.colour)}">${esc(line.ref)}</span>`;
    const from = this.from;
    if (!from) return;
    let html;
    if (this.phase === 'ticket' && this.fares) {
      html = `<div class="metro-head"><div class="metro-title">${esc(t('Metro · {name}', { name: from.name }))}</div><button data-act="close" class="metro-close" aria-label="${esc(t('Back to the street'))}">×</button></div>
        <div class="metro-note">${esc(t('Going in without a ticket?'))}</div>
        <ol class="metro-stations" style="--line:var(--accent)">
          ${TICKETS.map((k, i) => { const can = this.fares!.afford(k); return `<li><button data-act="buy:${i}" class="${this.choice === i ? 'sel' : ''}"${can ? '' : ' disabled'}><span>${esc(t('Ticket for {validity}', { validity: validity(k.minutes) }))}</span><small>${esc(can ? kc(k.price) : t('Not enough money ({price})', { price: kc(k.price) }))}</small></button></li>`; }).join('')}
          <li><button data-act="nobuy" class="${this.choice === TICKETS.length ? 'sel' : ''}"><span>${esc(t('Go in without a ticket'))}</span></button></li>
        </ol>
        <div class="metro-keys">${padLabels(t('<b>W</b>/<b>S</b> choose · <b>E</b> confirm · <b>1</b>–<b>4</b> buy · <b>Esc</b> back to the street'))}</div>`;
    } else if (this.phase === 'pick') {
      const line = this.tabLine(), here = line.stations.findIndex((s) => s.name === from.name);
      // A line that doesn't stop here: where to change onto it.
      const change = here < 0 ? line.stations.find((s) => from.lines.some((a) => a.line.stations.some((x) => x.name === s.name)))?.name : null;
      const tabs = this.lines.map((l, k) => `<button data-act="tab:${k}" class="metro-tab${k === this.tab ? ' on' : ''}" style="--line:${esc(l.colour)}">${esc(l.ref)}</button>`).join('');
      const rows = line.stations.map((s, k) => {
        const st = this.stations.get(s.name), mine = s.name === from.name;
        if (!st) return '';
        const note = mine ? t('You’re here') : !st.onMap ? t('Off the map') : st.lines.length > 1 ? t('Change for {lines}', { lines: st.lines.filter((x) => x.line !== line).map((x) => x.line.ref).join(', ') }) : '';
        return `<li><button data-act="go:${k}" class="${k === this.sel ? 'sel' : ''}"${mine || !st.onMap ? ' disabled' : ''}>`
          + `<span>${esc(s.name)}</span>${note ? `<small>${esc(note)}</small>` : ''}</button></li>`;
      }).join('');
      html = `<div class="metro-head"><div class="metro-title">${esc(t('Metro · {name}', { name: from.name }))}</div><button data-act="close" class="metro-close" aria-label="${esc(t('Back to the street'))}">×</button></div>
        <div class="metro-tabs">${tabs}</div>
        ${change ? `<div class="metro-note">${esc(t('Change at {name}', { name: change }))}</div>` : ''}
        ${this.note ? `<div class="metro-note">${esc(this.note)}</div>` : ''}
        <ol class="metro-stations" style="--line:${esc(line.colour)}">${rows}</ol>
        <div class="metro-keys">${padLabels(t('<b>W</b>/<b>S</b> choose · <b>A</b>/<b>D</b> line · <b>E</b> go · <b>Esc</b> back to the street'))}</div>`;
    } else {
      const s = this.steps[Math.min(this.k, this.steps.length - 1)];
      if (!s || !this.dest) return;
      const { line, i, j } = s.leg, dir = j > i ? 1 : -1;
      const towards = line.stations[dir > 0 ? line.stations.length - 1 : 0].name;
      // The station the train is at or has last left.
      let pos = s.a, status;
      if (this.phase === 'arriving') { pos = j; status = t('Arriving at {name}…', { name: this.dest.name }); }
      else if (s.kind === 'wait') status = t('Next train to {towards} in {time}', { towards, time: mins(s.to - this.t) });
      else if (s.kind === 'change') status = t('Changing to line {line} at {name}', { line: line.ref, name: line.stations[i].name });
      else status = s.b === j ? t('Arriving at {name}', { name: line.stations[j].name }) : t('Next: {name}', { name: line.stations[s.b].name });
      const list = [];
      for (let k = i; ; k += dir) {
        list.push(`<li class="${(k - pos) * dir < 0 ? 'past' : k === pos ? 'now' : ''}${k === j ? ' end' : ''}">${esc(line.stations[k].name)}</li>`);
        if (k === j) break;
      }
      html = `<div class="metro-head"><div class="metro-title">${pill(line)} ${esc(t('to {name}', { name: towards }))}</div></div>
        <div class="metro-bar"><div style="width:${((100 * this.t) / this.total).toFixed(1)}%;background:${esc(line.colour)}"></div></div>
        <div class="metro-status">${esc(status)}</div>
        <ol class="metro-ride" style="--line:${esc(line.colour)}">${list.join('')}</ol>
        ${this.phase === 'ride' ? `<button data-act="skip" class="metro-skip">${esc(t('Skip to {name}', { name: this.dest.name }))}</button><div class="metro-keys">${padLabels(t('<b>E</b> skip · scroll to zoom'))}</div>` : ''}`;
    }
    if (html !== this.shown) {
      this.el.innerHTML = this.shown = html;
      this.el.querySelector('.sel, .now')?.scrollIntoView({ block: 'nearest' });
    }
  }
}
