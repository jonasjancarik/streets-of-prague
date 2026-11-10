import { headsignAt, frontOf, MEAN_SPEED } from './trams.ts';
import type { Trams, TramLine, TramVehicle } from './trams.ts';
import { t } from './i18n.ts';

interface StopSpot { line: TramLine; i: number; x: number; y: number; name: string; headsign: string }
interface DueTram { line: TramLine; headsign: string; eta: number; here: boolean; v: TramVehicle }
// A row of the board: a tram or a bus (src/busstops.ts) on its way.
interface Row { ref: string; colour: string; headsign: string; eta: number; here: boolean }

// Departure boards. Standing at a tram stop, the HUD lists the next trams due there and
// counts them down as they come. The times come from where the trams actually are
// (how far each has to go at a line's usual pace, stops included), not from the
// timetable, so a tram held up behind a car shows up late here too. At a bus stop it
// lists the buses coming the same way (`buses`, from src/busstops.ts).

const NEAR = 16; // m from a stop's track position that counts as standing at it
const SAME = 150; // m: stops with the same name this close are one stop (both ways, all lines)
const SHOWN = 6;
const HORIZON = 30 * 60; // s: trams further off than this aren't listed
const CELL = 50;

export class StopBoard {
  trams: Trams;
  el: HTMLElement;
  grid: Map<string, StopSpot[]>;
  shown: string | null;
  next: number;
  t: number;
  key: string;
  expanded = false;
  kind: 'tram' | 'bus' = 'tram';
  // The bus stop you stand at and the buses due there, if any.
  buses: ((x: number, y: number, dt: number) => { name: string; rows: Row[] } | null) | null = null;

  constructor(trams: Trams, el: HTMLElement) {
    this.trams = trams;
    this.el = el;
    this.grid = new Map();
    this.shown = null; // the stop's name while you're at one
    this.next = Infinity; // seconds until the first tram
    this.t = 0;
    this.key = '';
    el.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.board-toggle')) return;
      this.expanded = !this.expanded;
      el.classList.toggle('expanded', this.expanded);
      el.querySelector('.board-toggle')?.setAttribute('aria-expanded', String(this.expanded));
    });
    // Every stop of every line, by where it is.
    for (const line of trams.lines) {
      line.halts.forEach((h, i) => {
        const p = line.path.at(h.s);
        const spot = { line, i, x: p.x, y: p.y, name: h.name, headsign: headsignAt(line, h.s) };
        const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k)!.push(spot);
      });
    }
  }

  near(x: number, y: number, r: number) {
    const out: StopSpot[] = [];
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((y - r) / CELL); j <= Math.floor((y + r) / CELL); j++) {
        for (const s of this.grid.get(`${i},${j}`) || []) if (Math.hypot(s.x - x, s.y - y) < r) out.push(s);
      }
    }
    return out;
  }

  // Every frame: `here` is false when you can't use the board (in a car, on a tram).
  update(dt: number, x: number, y: number, here: boolean) {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.25;
    const at = here ? this.near(x, y, NEAR).sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0] : null;
    const bus = !at && here && this.buses ? this.buses(x, y, 0.25) : null;
    if (bus) {
      this.show('bus', bus.name, bus.rows);
      return;
    }
    if (!at) {
      this.shown = null;
      this.next = Infinity;
      this.el.hidden = true;
      this.key = '';
      return;
    }
    const spots = this.near(at.x, at.y, SAME).filter((s) => s.name === at.name);
    const due: DueTram[] = [];
    for (const s of spots) {
      const { line } = s, h = line.halts[s.i];
      for (const v of line.trams) {
        const atStop = v.dwell > 0 && v.halt === s.i;
        const d = line.path.ahead(frontOf(v), h.s);
        if (!atStop && d > line.path.length - 30) continue; // just left
        const eta = atStop ? 0 : d / MEAN_SPEED;
        if (eta < HORIZON) due.push({ line, headsign: s.headsign, eta, here: atStop, v });
      }
    }
    // One row per tram (a tram due at both platforms shows for the sooner one).
    due.sort((a, b) => a.eta - b.eta);
    const rows = due.filter((d, i) => due.findIndex((e) => e.v === d.v) === i).slice(0, SHOWN);
    this.show('tram', at.name, rows.map((r) => ({ ref: r.line.ref, colour: r.line.colour || '#c4161c', headsign: r.headsign, eta: r.eta, here: r.here })));
  }

  private show(kind: 'tram' | 'bus', name: string, rows: Row[]) {
    if (this.shown !== name || this.kind !== kind) { this.expanded = false; this.el.classList.remove('expanded'); }
    this.kind = kind;
    this.shown = name;
    this.next = rows.length ? rows[0].eta : Infinity;
    this.render(name, rows);
  }

  render(name: string, rows: Row[]) {
    const chars: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' };
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => `&${chars[c]};`);
    const bus = this.kind === 'bus', none = t(bus ? 'No bus due yet' : 'No trams due in the next half hour');
    const when = (r: Row) => (r.here ? t('now') : r.eta < 45 ? t('arriving') : t('{n} min', { n: Math.round(r.eta / 60) }));
    const list = rows.length
      ? `<ol class="board-rows">${rows.map((r) => `<li><span class="ride-ref" style="background:${esc(r.colour)}">${esc(r.ref)}</span>`
        + `<span class="board-to">${esc(r.headsign)}</span><span class="board-eta">${when(r)}</span></li>`).join('')}</ol>`
      : `<div class="board-none">${none}</div>`;
    const title = esc(t(bus ? 'Buses from {name}' : 'Trams from {name}', { name }));
    const first = rows[0];
    const summary = first ? `${esc(first.ref)} · ${esc(first.headsign)} · ${when(first)}` : none;
    const html = `<div class="board-title">${title}</div><button class="board-toggle" aria-expanded="${this.expanded}" aria-controls="board-list">${title}<span>${summary}</span><small>${t('Timetable')} ▾</small></button><div id="board-list">${list}</div>`;
    if (html === this.key) return;
    this.key = html;
    this.el.innerHTML = html;
    this.el.hidden = false;
  }
}
