import type { DriveEdge, DriveGraph } from './network.ts';
import type { Point2 } from './map/geo.ts';

// A small round map in the corner: the streets loaded round you (the drive graph, so it
// shows as far as the game knows them), the way the directions give, where it leads, the
// police, and you in the middle. North is up, as in the game's camera. The streets are
// drawn into a bigger picture now and then, which each look only slides along; the way
// and the dots go on top, a dozen times a second.

const R = 560; // m from the middle to the edge (the screen shows about 350)
const SIZE = 150; // css px across
const LAYER = 3; // the streets' picture: this many times the map across
const TICK = 1 / 12; // s between looks

let on = true;
try { on = localStorage.getItem('minimap') !== 'off'; } catch { /* no storage: stay on */ }
export const minimapOn = () => on;
export function setMinimap(enabled: boolean) {
  on = enabled;
  try { localStorage.setItem('minimap', enabled ? 'on' : 'off'); } catch { /* not saved */ }
}

const WIDE = new Set(['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link']);
const MID = new Set(['secondary', 'tertiary', 'secondary_link', 'tertiary_link']);

export interface Dot { x: number; y: number; colour: string }

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement('canvas');
  private lx = NaN; ly = NaN;
  private learnt = -1;
  private builtAt = -Infinity;
  private clock = 0;
  private wait = 0;
  private dpr = 1;

  constructor(private el: HTMLCanvasElement, private g: DriveGraph, private near: (x: number, y: number, r: number) => DriveEdge[]) {
    this.ctx = el.getContext('2d')!;
    el.style.width = el.style.height = `${SIZE}px`;
  }

  // Once a frame. `way`: the directions' line and its colour; `goal`: where it leads.
  update(dt: number, show: boolean, me: { x: number; y: number; h: number }, way: { pts: Point2[]; cum: number[]; from: number; colour: string } | null, goal: Dot | null, dots: Dot[]) {
    if (this.el.hidden !== !show) this.el.hidden = !show;
    if (!show) return;
    this.clock += dt;
    if ((this.wait -= dt) > 0) return;
    this.wait = TICK;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (dpr !== this.dpr || this.el.width !== Math.round(SIZE * dpr)) {
      this.dpr = dpr;
      this.el.width = this.el.height = Math.round(SIZE * dpr);
      this.lx = NaN;
    }
    const S = this.el.width, k = S / (2 * R), c = this.ctx;
    // The streets again once you've gone far into the picture, or more have loaded (at most every 2 s).
    const far = !(Math.abs(me.x - this.lx) < R * 0.45 && Math.abs(me.y - this.ly) < R * 0.45); // (before the circle reaches the picture's edge)
    if (far || (this.g.count !== this.learnt && this.clock - this.builtAt > 2)) this.build(me.x, me.y, k);
    const W = this.layer.width;
    const px = (x: number) => (x - me.x) * k + S / 2, py = (y: number) => (me.y - y) * k + S / 2;
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - dpr, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(20, 13, 12, 0.78)';
    c.fillRect(0, 0, S, S);
    c.drawImage(this.layer, (me.x - this.lx) * k + W / 2 - S / 2, (this.ly - me.y) * k + W / 2 - S / 2, S, S, 0, 0, S, S);
    if (way && way.pts.length > 1) {
      c.strokeStyle = way.colour;
      c.lineWidth = 3.5 * dpr;
      c.lineJoin = c.lineCap = 'round';
      c.beginPath();
      // From the car on (the part behind you is done with).
      const { pts, cum, from } = way;
      let i = 0;
      while (i + 2 < pts.length && cum[i + 1] <= from) i++;
      const f = Math.min(1, Math.max(0, (from - cum[i]) / (cum[i + 1] - cum[i] || 1)));
      c.moveTo(px(pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f), py(pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f));
      for (let k = i + 1; k < pts.length; k++) c.lineTo(px(pts[k][0]), py(pts[k][1]));
      c.stroke();
    }
    for (const d of dots) {
      const x = px(d.x), y = py(d.y);
      if (x < -5 || y < -5 || x > S + 5 || y > S + 5) continue;
      c.fillStyle = d.colour;
      c.beginPath();
      c.arc(x, y, 3 * dpr, 0, Math.PI * 2);
      c.fill();
    }
    if (goal) {
      // Beyond the edge, it waits at the edge on the side it lies.
      let x = px(goal.x) - S / 2, y = py(goal.y) - S / 2;
      const d = Math.hypot(x, y), edge = S / 2 - 7 * dpr;
      if (d > edge) { x *= edge / d; y *= edge / d; }
      c.fillStyle = goal.colour;
      c.strokeStyle = '#140d0c';
      c.lineWidth = 2 * dpr;
      c.beginPath();
      c.arc(x + S / 2, y + S / 2, 5 * dpr, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
    // You: an arrowhead the way you face.
    c.translate(S / 2, S / 2);
    c.rotate(-me.h);
    c.scale(dpr, dpr);
    c.fillStyle = '#ece4d6';
    c.strokeStyle = '#140d0c';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(8, 0); c.lineTo(-6, 6); c.lineTo(-3, 0); c.lineTo(-6, -6); c.closePath();
    c.fill();
    c.stroke();
    c.restore();
    c.strokeStyle = 'rgba(236, 228, 214, 0.45)';
    c.lineWidth = 1.5 * dpr;
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - dpr, 0, Math.PI * 2);
    c.stroke();
  }

  private build(x: number, y: number, k: number) {
    this.lx = x; this.ly = y;
    this.learnt = this.g.count;
    this.builtAt = this.clock;
    const W = Math.round(2 * R * LAYER * k);
    if (this.layer.width !== W) this.layer.width = this.layer.height = W;
    const c = this.layer.getContext('2d')!;
    c.clearRect(0, 0, W, W);
    c.lineJoin = c.lineCap = 'round';
    c.strokeStyle = 'rgba(236, 228, 214, 0.55)';
    const done = new Set<DriveEdge>(), dpr = this.dpr;
    const lines: Map<number, DriveEdge[]> = new Map();
    for (const e of this.near(x, y, R * LAYER * 0.75)) {
      if (done.has(e) || (e.twin && done.has(e.twin))) continue;
      done.add(e);
      const w = WIDE.has(e.hw) ? 3.2 : MID.has(e.hw) ? 2.4 : 1.5;
      if (!lines.has(w)) lines.set(w, []);
      lines.get(w)!.push(e);
    }
    // The thin ones first, so main roads run over the side streets.
    for (const [w, edges] of [...lines].sort((a, b) => a[0] - b[0])) {
      c.lineWidth = w * dpr;
      c.beginPath();
      for (const e of edges) e.pts.forEach(([ex, ey], i) => {
        const sx = (ex - x) * k + W / 2, sy = (y - ey) * k + W / 2;
        if (i) c.lineTo(sx, sy); else c.moveTo(sx, sy);
      });
      c.stroke();
    }
  }
}
