import type { Point2 } from './map/geo.ts';
import type { Path, TramPoint, RawTramLine } from './trams.ts';

// The city's tram tracks as a network, for a tram someone is driving. Nothing in
// lines.json says where the tracks branch, but every line is stitched from the same
// OpenStreetMap ways, so the lines share their points exactly: put all the lines'
// points together and wherever two lines part there is a point with two ways on.
// Those are the junctions, and `Route` is the track a driven tram leaves behind and
// lays out ahead of it, taking whichever way the driver picked at each junction.

export type Turn = -1 | 0 | 1; // right, straight on, left

export interface Option { turn: Turn; node: number }

const LOOK = 14; // m of track past a junction to judge which way each branch goes

export class TrackNet {
  xy: Point2[] = [];
  outs: number[][] = [];
  private ids = new Map<string, number>();

  constructor(lines: RawTramLine[]) {
    for (const line of lines) {
      let prev = -1;
      for (const p of line.pts) {
        const n = this.node(p);
        if (prev >= 0 && n !== prev && !this.outs[prev].includes(n)) this.outs[prev].push(n);
        prev = n;
      }
    }
  }

  node(p: Point2) {
    const key = `${p[0]},${p[1]}`;
    let n = this.ids.get(key);
    if (n === undefined) {
      n = this.xy.length;
      this.ids.set(key, n);
      this.xy.push(p);
      this.outs.push([]);
    }
    return n;
  }

  // Where each way out of `node` is heading, a little further on.
  private bearing(from: number, next: number) {
    const a = this.xy[from];
    let cur = next, run = Math.hypot(this.xy[next][0] - a[0], this.xy[next][1] - a[1]);
    for (let i = 0; i < 40 && run < LOOK && this.outs[cur].length === 1; i++) {
      const n = this.outs[cur][0];
      run += Math.hypot(this.xy[n][0] - this.xy[cur][0], this.xy[n][1] - this.xy[cur][1]);
      cur = n;
    }
    return Math.atan2(this.xy[cur][1] - a[1], this.xy[cur][0] - a[0]);
  }

  // The ways on from a junction for a tram arriving heading `heading`: left, straight
  // on and right, as many as there are (one way for each turn).
  options(node: number, heading: number): Option[] {
    const scored = this.outs[node].map((n) => {
      const d = this.bearing(node, n) - heading;
      return { node: n, angle: Math.atan2(Math.sin(d), Math.cos(d)) };
    });
    if (scored.length === 1) return [{ turn: 0, node: scored[0].node }];
    const straight = scored.reduce((a, b) => (Math.abs(b.angle) < Math.abs(a.angle) ? b : a));
    const out: Option[] = [{ turn: 0, node: straight.node }];
    const left = scored.filter((o) => o !== straight && o.angle > 0).sort((a, b) => b.angle - a.angle)[0];
    const right = scored.filter((o) => o !== straight && o.angle <= 0).sort((a, b) => a.angle - b.angle)[0];
    if (left) out.push({ turn: 1, node: left.node });
    if (right) out.push({ turn: -1, node: right.node });
    return out;
  }
}

// An open track: the points a tram has passed and the ones laid ahead of it, with how
// far along each is. It carries on past both ends in a straight line, so a tram's body
// can stick out behind the start of it.
export class Route implements Path {
  pts: Point2[] = [];
  cum: number[] = [];
  angs: number[] = [];
  nodes: number[] = [];

  get length() { return this.cum.length ? this.cum[this.cum.length - 1] : 0; }
  get last() { return this.nodes[this.nodes.length - 1]; }
  wrap(s: number) { return s; }
  ahead(from: number, to: number) { return to - from; }

  push(node: number, p: Point2) {
    const n = this.pts.length;
    if (n && this.nodes[n - 1] === node) return;
    const prev = this.pts[n - 1];
    this.cum.push(n ? this.cum[n - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]) : 0);
    this.angs.push(n ? Math.atan2(p[1] - prev[1], p[0] - prev[0]) : 0);
    this.pts.push(p);
    this.nodes.push(node);
    if (n === 1) this.angs[0] = this.angs[1];
  }

  at(s: number): TramPoint {
    const n = this.pts.length;
    let lo = 1, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    const a = this.pts[lo - 1], b = this.pts[lo];
    const t = (s - this.cum[lo - 1]) / (this.cum[lo] - this.cum[lo - 1] || 1);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, ang: this.angs[lo] };
  }
}
