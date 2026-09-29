// City buses on their real PID routes (data/<area>_now/buses.json, from
// pipeline/build_buses.py). A line is one direction's path through the area and its
// stops; a bus on it drives the ordinary street network (see Traffic), taking at each
// junction the street that keeps it on the line, and pulls up at the stops. Where the
// line and the streets part ways (a street missing from the map, the end of the line)
// it carries on as a bus on the main roads.

import type { Point2 } from './map/geo.ts';
import { Polyline } from './network.ts';
import type { DriveEdge } from './network.ts';

export interface BusLine { ref: string; to: string; path: Polyline; stops: [number, string][] }

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

// A bus working a line: how far along it is, how far its planned route reaches, and
// the next stop it hasn't served.
export class BusRun {
  line: BusLine;
  along: number; // where the bus is (its middle), m along the line
  ahead: number; // where its planned route has got to
  stop: number; // index of the next stop
  dwell = 0; // seconds left standing at a stop
  lost = false;

  constructor(line: BusLine, along: number) {
    this.line = line;
    this.along = this.ahead = along;
    this.stop = line.stops.findIndex((s) => s[0] > along + 8);
    if (this.stop < 0) this.stop = line.stops.length;
  }

  // Of the streets out of the junction at the end of `e`, the one the line goes on
  // (null: none of them).
  pick(e: DriveEdge, opts: DriveEdge[]): DriveEdge | null {
    if (this.lost || !opts.length) return null;
    const end = e.path.at(e.path.length);
    this.ahead = Math.max(this.ahead, project(this.line.path, end.x, end.y, this.ahead - 15, this.ahead + e.path.length + 60)[0]);
    let best: DriveEdge | null = null, bestD = OFF;
    for (const f of opts) {
      const len = f.path.length;
      let worst = 0;
      for (const s of [Math.min(8, len), Math.min(25, len), Math.min(len, Math.max(8, this.line.path.length - this.ahead - 5))]) {
        const p = f.path.at(s);
        worst = Math.max(worst, project(this.line.path, p.x, p.y, this.ahead - 15, this.ahead + len + 60)[1]);
        if (worst >= bestD) break;
      }
      if (worst < bestD) { bestD = worst; best = f; }
    }
    if (!best || this.ahead > this.line.path.length - 10) this.lost = true;
    return this.lost ? null : best;
  }

  // Follow the bus's position along the line (it only moves forward).
  track(x: number, y: number) {
    const [a, d] = project(this.line.path, x, y, this.along - 5, this.along + 40);
    if (d < OFF) this.along = Math.max(this.along, a);
  }
}

// Where on the street network a bus can join a line: a random spot of a line among
// `edges` (the streets round the player), on a lane that runs the line's way.
export function busStart(lines: BusLine[], edges: DriveEdge[], rand: () => number, ok: (x: number, y: number) => boolean) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of edges) for (const q of e.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
  // The stretches of line in that box.
  const spans: [BusLine, number, number][] = [];
  let total = 0;
  for (const line of lines) {
    const { pts, cum } = line.path;
    for (let i = 1; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (x > x0 && x < x1 && y > y0 && y < y1) { spans.push([line, cum[i - 1], cum[i]]); total += cum[i] - cum[i - 1]; }
    }
  }
  if (!spans.length) return null;
  for (let tries = 0; tries < 12; tries++) {
    let pick = rand() * total, span = spans[0];
    for (const sp of spans) if ((pick -= sp[2] - sp[1]) < 0) { span = sp; break; }
    const line = span[0], along = span[1] + rand() * (span[2] - span[1]);
    const p = line.path.at(along);
    if (!ok(p.x, p.y)) continue;
    let best: { edge: DriveEdge; s: number } | null = null, bestD = 6;
    for (const e of edges) {
      if (e.bridge || e.tunnel || e.path.length < 16) continue;
      const pts = e.path.pts;
      // (A quick look at the edge's box first.)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const q of pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
      if (p.x < x0 - bestD || p.x > x1 + bestD || p.y < y0 - bestD || p.y > y1 + bestD) continue;
      const [s, d] = project(e.path, p.x, p.y);
      if (d >= bestD || s < 6 || s > e.path.length - 8) continue;
      const q = e.path.at(s);
      if (Math.cos(q.ang - p.ang) < 0.8) continue;
      best = { edge: e, s };
      bestD = d;
    }
    if (best) return { ...best, run: new BusRun(line, along) };
  }
  return null;
}
