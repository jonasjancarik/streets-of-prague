// Riding a tram. Get on while one waits at a stop (E) and it carries you along its
// line. The strip in the HUD lists the stops ahead: pick one (W/S, or tap it) and the
// ride speeds up until you're nearly there, then you watch the tram pull in and get
// off. Hold Shift to speed up at any time, and E gets you off at the next stop.
//
// Speeding up runs the whole world faster (see simulate() in main.js), so the city
// keeps moving around you; it holds back while the streets ahead are still loading.

import { headsignAt, frontOf } from './trams.js';

export const FAST = 6; // how much faster the world runs
const SHOWN = 6; // stops listed ahead
const SLOW_BEFORE = 250; // m before your stop where the ride goes back to normal speed

export class TramRide {
  constructor(trams, world, el) {
    Object.assign(this, { trams, world, el });
    this.v = null;
    this.dest = null; // index of the halt you're riding to
    this.scale = 1;
    this.waiting = false; // held back by streets still loading
    this.shown = '';
    el.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('[data-halt]');
      if (!b || !this.v) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(b.dataset.halt);
      this.dest = this.dest === i ? null : i;
    });
  }

  get on() { return !!this.v; }

  // A tram waiting at a stop right next to (x, y), if there is one.
  boardable(x, y) {
    for (const v of this.trams.list) {
      if (v.dwell <= 0 || !v.look) continue;
      for (const p of v.parts) {
        const dx = x - p.x, dy = y - p.y, c = Math.cos(p.ang), s = Math.sin(p.ang);
        const along = Math.abs(dx * c + dy * s), side = Math.abs(dx * s - dy * c);
        if (along < 5.4 && side < 3.6) return v;
      }
    }
    return null;
  }

  board(v) {
    this.v = v;
    v.rider = true;
    this.dest = null;
    this.el.hidden = false;
  }

  // Off the tram: where to stand (beside its middle door, on the right, the side
  // Prague's platforms are on) and which way to face.
  leave() {
    const v = this.v, p = v.parts[1];
    v.rider = false;
    this.v = null;
    this.dest = null;
    this.scale = 1;
    this.el.hidden = true;
    this.shown = '';
    return [p.x + Math.sin(p.ang) * 3, p.y - Math.cos(p.ang) * 3, p.ang];
  }

  atStop() { return this.v.dwell > 0; }
  arrived() { return this.v.dwell > 0 && this.v.halt === this.dest; }
  // Get off at the next stop.
  requestStop() { this.dest = this.upcoming()[0]; }

  // The halts ahead, as indices (the one you're standing at isn't one of them).
  upcoming(n = SHOWN) {
    const { v } = this, count = v.line.halts.length, out = [];
    for (let k = v.dwell > 0 ? 1 : 0; out.length < Math.min(n, count - 1); k++) out.push((v.halt + k) % count);
    return out;
  }

  // Keyboard: move your pick along the stops ahead (from none to the furthest shown).
  pick(step) {
    const list = this.upcoming();
    const i = this.dest === null ? -1 : list.indexOf(this.dest);
    const j = Math.max(-1, Math.min(list.length - 1, i + step));
    this.dest = j < 0 ? null : list[j];
  }

  // Where a tram (yours by default) is heading: the terminus of the way it's going.
  headsign(v = this.v) { return headsignAt(v.line, frontOf(v)); }

  toDest() {
    const { v } = this;
    return v.line.path.ahead(frontOf(v), v.line.halts[this.dest].s);
  }

  // How much faster the world should run this frame: with Shift held, or on the way to
  // your stop (stops on the way included) until you're nearly there, as long as the
  // streets ahead have loaded.
  speedUp(dt, hold) {
    const want = hold || (this.dest !== null && !this.arrived() && this.toDest() > SLOW_BEFORE);
    this.waiting = want && !this.loadedAhead();
    const target = want && !this.waiting ? FAST : 1;
    this.scale += (target - this.scale) * Math.min(1, dt * (target > this.scale ? 1.5 : 4));
    if (Math.abs(this.scale - target) < 0.02) this.scale = target;
    return this.scale;
  }

  // Whether the map is loaded along the track for the next few seconds of fast ride.
  loadedAhead() {
    const { v, world } = this, reach = Math.max(150, v.speed * FAST * 4);
    for (let d = 0; d <= reach; d += 60) {
      const p = v.line.path.at(v.s + d), k = world.keyAt(p.x, p.y);
      if (world.available.has(k) && !world.loaded.has(k)) return false;
    }
    return true;
  }

  // Keep the player (hidden) in the tram, for the camera, the police and the life around.
  seat(walker) {
    const p = this.v.parts[1], sp = this.v.speed * this.scale;
    Object.assign(walker, { x: p.x, y: p.y, h: p.ang, vx: Math.cos(p.ang) * sp, vy: Math.sin(p.ang) * sp });
  }

  // The strip: line, where it's heading, and the stops ahead with your pick.
  render() {
    const { v } = this;
    if (!v) return;
    const list = this.upcoming(), halts = v.line.halts;
    const key = `${v.line.ref}|${this.headsign()}|${list.join(',')}|${this.dest}|${v.dwell > 0}`;
    if (key === this.shown) return;
    this.shown = key;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
    const here = v.dwell > 0 ? `<div class="ride-here">At ${esc(halts[v.halt].name)}</div>` : '';
    this.el.innerHTML = `
      <div class="ride-line"><span class="ride-ref" style="background:${esc(v.line.colour || '#c4161c')}">${esc(v.line.ref)}</span>
      <span>to ${esc(this.headsign())}</span></div>${here}
      <ol class="ride-stops">${list.map((i, n) => `<li><button data-halt="${i}" class="${i === this.dest ? 'dest' : ''}${n === 0 ? ' next' : ''}">${esc(halts[i].name)}</button></li>`).join('')}</ol>`;
  }
}
