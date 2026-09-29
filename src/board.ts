import { headsignAt, frontOf, MEAN_SPEED } from './trams.ts';
import type { Trams, TramLine, TramVehicle } from './trams.ts';
import { t } from './i18n.ts';

interface StopSpot { line: TramLine; i: number; x: number; y: number; name: string; headsign: string }
interface DueTram { line: TramLine; headsign: string; eta: number; here: boolean; v: TramVehicle }

// Departure boards. Standing at a tram stop, the HUD lists the next trams due there and
// counts them down as they come. The times come from where the trams actually are
// (how far each has to go at a line's usual pace, stops included), not from the
// timetable, so a tram held up behind a car shows up late here too.

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

  constructor(trams: Trams, el: HTMLElement) {
    this.trams = trams;
    this.el = el;
    this.grid = new Map();
    this.shown = null; // the stop's name while you're at one
    this.next = Infinity; // seconds until the first tram
    this.t = 0;
    this.key = '';
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
    this.shown = at.name;
    this.next = rows.length ? rows[0].eta : Infinity;
    this.render(at.name, rows);
  }

  render(name: string, rows: DueTram[]) {
    const chars: Record<string, string> = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' };
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => `&${chars[c]};`);
    const when = (r: DueTram) => (r.here ? t('now') : r.eta < 45 ? t('arriving') : t('{n} min', { n: Math.round(r.eta / 60) }));
    const list = rows.length
      ? `<ol class="board-rows">${rows.map((r) => `<li><span class="ride-ref" style="background:${esc(r.line.colour || '#c4161c')}">${esc(r.line.ref)}</span>`
        + `<span class="board-to">${esc(r.headsign)}</span><span class="board-eta">${when(r)}</span></li>`).join('')}</ol>`
      : `<div class="board-none">${t('No trams due in the next half hour')}</div>`;
    const html = `<div class="board-title">${esc(t('Trams from {name}', { name }))}</div>${list}`;
    if (html === this.key) return;
    this.key = html;
    this.el.innerHTML = html;
    this.el.hidden = false;
  }
}
