// City buses on their real PID routes (data/<area>_now/buses.json, from
// pipeline/build_buses.py). A line is one direction's path through the area and its
// stops; a bus on it drives the ordinary street network (see Traffic), taking at each
// junction the street that keeps it on the line, and pulls up at the stops. Where the
// line goes where the map has no street for cars (a street for buses and trams only),
// the bus goes round by the streets there are and takes the line up again further on.
// At the end of the line, or where no way round is found, it carries on as a bus on
// the main roads.

import type { Point2 } from './map/geo.ts';
import { Polyline } from './network.ts';
import type { DriveEdge } from './network.ts';

export interface BusLine { ref: string; to: string; path: Polyline; stops: [number, string][] }

// The lines through the centre that run small buses.
const MINIBUS = new Set(['194', '207']);
export const busType = (ref: string) => MINIBUS.has(ref) ? 'minibus' : 'bus';

// Buses of the same line and direction keep at least this far (m along it) apart.
const GAP = 400;

// Off the line by more than this (m) and the street isn't the line's.
const OFF = 12;

export function parseBusLines(raw: unknown): BusLine[] {
  const lines = (raw as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return [];
  const out: BusLine[] = [];
  for (const l of lines as { ref?: unknown; to?: unknown; pts?: unknown; stops?: unknown }[]) {
    if (typeof l?.ref !== 'string' || !Array.isArray(l.pts) || l.pts.length < 2) continue;
    const stops = Array.isArray(l.stops) ? (l.stops as [number, string][]).filter((s) => Array.isArray(s) && typeof s[0] === 'number') : [];
    out.push({ ref: l.ref, to: typeof l.to === 'string' ? l.to : '', path: new Polyline(l.pts as Point2[]), stops });
  }
  return out;
}

// The nearest point of `line` to (x, y) between `from` and `to` metres along it:
// [distance along, distance away].
export function project(line: Polyline, x: number, y: number, from = 0, to = line.length): [number, number] {
  const { pts, cum } = line;
  let best = Infinity, at = from;
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] < from) continue;
    if (cum[i - 1] > to) break;
    const ax = pts[i - 1][0], ay = pts[i - 1][1], dx = pts[i][0] - ax, dy = pts[i][1] - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + dx * t, py = ay + dy * t, d = Math.hypot(x - px, y - py);
    if (d < best) { best = d; at = cum[i - 1] + t * Math.sqrt(len2); }
  }
  return [at, best];
}

// A way round is looked for this far by road (m), to where the line is at most this much further on.
const ROUND = 2500, SKIP = 3500;

// A bus working a line: how far along it is, how far its planned route reaches, and
// the next stop it hasn't served.
export class BusRun {
  line: BusLine;
  along: number; // where the bus is (its middle), m along the line
  ahead: number; // where its planned route has got to
  stop: number; // index of the next stop
  dwell = 0; // seconds left standing at a stop
  lost = false;
  // The streets out of a junction (the street network): for seeing past a short street
  // to the one after it, and for finding a way round where the line has no street.
  out: ((node: string) => DriveEdge[]) | null;
  // The streets still to take on a way round, and where along the line it comes back.
  plan: DriveEdge[] = [];
  back = 0;
  // On a way round (the bus itself, not its planned route): off the line, so it makes
  // for no stop till it's back.
  away = false;

  constructor(line: BusLine, along: number, out: ((node: string) => DriveEdge[]) | null = null) {
    this.line = line;
    this.along = this.ahead = along;
    this.out = out;
    this.stop = line.stops.findIndex((s) => s[0] > along + 8);
    if (this.stop < 0) this.stop = line.stops.length;
  }

  // How far off the line (m) the first `need` metres of `f` are, for a bus whose route has
  // got to `ahead`: the worst of a few points along it, given up on once past `most`.
  // A street shorter than `need` is judged along with the best of the streets after it:
  // a few metres of side street lie as close to the line as the street the line takes.
  private off(f: DriveEdge, need: number, most: number, depth = 0, before = 0): number {
    const len = f.path.length, left = this.line.path.length - this.ahead - before - 5;
    let worst = 0;
    for (const s of depth ? [Math.min(8, len), Math.min(need, len)] : [Math.min(8, len), Math.min(25, len), Math.min(len, Math.max(8, left))]) {
      const p = f.path.at(s);
      worst = Math.max(worst, project(this.line.path, p.x, p.y, this.ahead - 15, this.ahead + before + len + 60)[1]);
      if (worst >= most) return worst;
    }
    if (len >= need || depth >= 3 || !this.out || left < len + 10) return worst;
    const next = this.out(f.v).filter((o) => o !== f.twin);
    if (!next.length) return worst;
    let best = Infinity;
    for (const o of next) best = Math.min(best, this.off(o, need - len, most, depth + 1, before + len));
    return Math.max(worst, best);
  }

  // Of the streets out of the junction at the end of `e`, the one the line goes on
  // (null: none of them).
  pick(e: DriveEdge, opts: DriveEdge[]): DriveEdge | null {
    if (this.lost || !opts.length) return null;
    if (this.plan.length) {
      const f = this.plan.shift()!;
      if (opts.includes(f)) {
        if (!this.plan.length) this.ahead = this.back;
        return f;
      }
      this.plan = [];
    }
    const end = e.path.at(e.path.length);
    this.ahead = Math.max(this.ahead, project(this.line.path, end.x, end.y, this.ahead - 15, this.ahead + e.path.length + 60)[0]);
    let best: DriveEdge | null = null, bestD = OFF;
    for (const f of opts) {
      const d = this.off(f, 25, bestD);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (this.ahead > this.line.path.length - 10) this.lost = true;
    // The line goes where the map has no street for it (a street for buses and trams
    // only, a hospital's grounds): round by the streets there are, if they lead back to it.
    else if (!best) best = this.round(e);
    if (!best) this.lost = true;
    return this.lost ? null : best;
  }

  // The shortest way by street from the end of `e` to a street the line takes further on.
  // Sets `plan` to the streets after the first, which it returns (null: no way found).
  private round(e: DriveEdge): DriveEdge | null {
    const out = this.out, path = this.line.path;
    if (!out) return null;
    const cost = new Map<string, number>([[e.v, 0]]), via = new Map<string, DriveEdge>();
    // (A few hundred junctions at most: a plain list does as a queue.)
    const open: [number, string][] = [[0, e.v]];
    while (open.length) {
      let k = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[k][0]) k = i;
      const [c, n] = open.splice(k, 1)[0];
      if (c > (cost.get(n) ?? Infinity)) continue;
      for (const f of out(n)) {
        // (Back the way it came only out of a dead end.)
        if (n === e.v && f === e.twin && out(n).length > 1) continue;
        // On the line again: both ends by it, further on, and going its way.
        const len = f.path.length, p = f.path.at(Math.min(8, len)), q = f.path.at(len);
        const [a0, d0] = project(path, p.x, p.y, this.ahead + 10, this.ahead + SKIP);
        if (d0 < OFF && len > 12 && Math.cos(path.at(a0).ang - p.ang) > 0.7) {
          const [a1, d1] = project(path, q.x, q.y, a0, a0 + len + 60);
          if (d1 < OFF && a1 > a0 + len / 2) {
            const way = [f];
            for (let at = n; at !== e.v;) { const g = via.get(at)!; way.unshift(g); at = g.u; }
            this.back = a1;
            this.plan = way.slice(1);
            if (!this.plan.length) this.ahead = a1;
            return way[0];
          }
        }
        const nc = c + len;
        if (nc > ROUND || nc >= (cost.get(f.v) ?? Infinity)) continue;
        cost.set(f.v, nc);
        via.set(f.v, f);
        open.push([nc, f.v]);
      }
    }
    return null;
  }

  // Follow the bus's position along the line (it only moves forward).
  track(x: number, y: number) {
    let [a, d] = project(this.line.path, x, y, this.along - 5, this.along + 40);
    // Off the line on a way round: back on it where that comes back, a good way further on.
    if (d >= OFF && this.back) [a, d] = project(this.line.path, x, y, this.back - 80, this.back + 40);
    if (d >= OFF) { this.away = this.away || !!this.back; return; }
    if (a <= this.along) return;
    this.along = a;
    // (The stops it went round are behind it.)
    if (this.away) while (this.stop < this.line.stops.length && this.line.stops[this.stop][0] < a + 8) this.stop++;
    this.away = false;
  }
}

// Where on the street network a bus can join a line: a random spot of a line among
// `edges` (the streets round the player), on a lane that runs the line's way.
export function busStart(lines: BusLine[], edges: DriveEdge[], rand: () => number, ok: (x: number, y: number) => boolean, running: BusRun[] = [], out: ((node: string) => DriveEdge[]) | null = null) {
  // The lanes a bus can start on, each with its box, and the box round them all.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const lanes: Lane[] = [];
  for (const e of edges) {
    if (e.bridge || e.tunnel || e.path.length < 16) continue;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const q of e.path.pts) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); }
    lanes.push([e, a, b, c, d]);
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d);
  }
  // The stretches of line in that box.
  // Each line is as likely as the next however much of the box it covers, and a
  // direction that already has a bus nearby is passed over.
  const perLine = new Map<BusLine, [BusLine, number, number][]>();
  for (const line of lines) {
    const { pts, cum } = line.path;
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (x > x0 && x < x1 && y > y0 && y < y1) {
        const list = perLine.get(line) ?? [];
        list.push([line, cum[i - 1], cum[i]]);
        perLine.set(line, list);
      }
    }
  }
  const free = [...perLine.keys()];
  if (!free.length) return null;
  for (let tries = 0; tries < 12; tries++) {
    const line = free[Math.floor(rand() * free.length)];
    const list = perLine.get(line)!;
    let total = 0;
    for (const sp of list) total += sp[2] - sp[1];
    let pick = rand() * total, span = list[0];
    for (const sp of list) if ((pick -= sp[2] - sp[1]) < 0) { span = sp; break; }
    const along = span[1] + rand() * (span[2] - span[1]);
    if (running.some((r) => r.line.ref === line.ref && r.line.to === line.to && Math.abs(r.along - along) < GAP)) continue;
    const p = line.path.at(along);
    if (!ok(p.x, p.y)) continue;
    const best = laneAt(lanes, p);
    if (best) return { ...best, run: new BusRun(line, along, out) };
  }
  return null;
}

type Lane = [DriveEdge, number, number, number, number];

// The lane (of `lanes`, each with its box) a bus at `p` on its line would be in.
function laneAt(lanes: Lane[], p: { x: number; y: number; ang: number }) {
  let best: { edge: DriveEdge; s: number } | null = null, bestD = 8;
  for (const [e, ex0, ey0, ex1, ey1] of lanes) {
    if (p.x < ex0 - bestD || p.x > ex1 + bestD || p.y < ey0 - bestD || p.y > ey1 + bestD) continue;
    const [s, d] = project(e.path, p.x, p.y);
    if (d >= bestD || s < 6 || s > e.path.length - 8) continue;
    const q = e.path.at(s);
    if (Math.cos(q.ang - p.ang) < 0.8) continue;
    best = { edge: e, s };
    bestD = d;
  }
  return best;
}

// A bus joining `line` at `along` (or the first place a little further on where a
// street of `edges` takes it), for a bus sent for someone waiting at a stop.
export function busAt(line: BusLine, along: number, edges: DriveEdge[], ok: (x: number, y: number) => boolean, out: ((node: string) => DriveEdge[]) | null = null) {
  const lanes: Lane[] = [];
  for (const e of edges) {
    if (e.bridge || e.tunnel || e.path.length < 16) continue;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const q of e.path.pts) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); d = Math.max(d, q[1]); }
    lanes.push([e, a, b, c, d]);
  }
  for (let at = along; at < along + 150 && at < line.path.length - 50; at += 15) {
    const p = line.path.at(at);
    if (!ok(p.x, p.y)) continue;
    const best = laneAt(lanes, p);
    if (best) return { ...best, run: new BusRun(line, at, out) };
  }
  return null;
}
