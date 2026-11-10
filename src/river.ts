// The river as the boats know it: where the water is open (a tile's water polygons
// without its weirs), and the area's river.json (pipeline/build_river.py): the fairway
// the cruise boats keep to, through the locks past the weirs, and PID's ferries.
import type { Point2, Bounds } from './map/geo.ts';

export interface TileWater { water: { rings: Point2[][]; box: Bounds }[]; weirs: Point2[][] }
export const WEIR_CLEAR = 5; // m: no boat this near a weir's line

// Whether a point of a tile is on open water. A weir across the river isn't: boats stop
// short of it.
export function openWater(t: TileWater, x: number, y: number) {
  for (const { rings, box } of t.water) {
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [ax, ay] = r[i], [bx, by] = r[j];
        if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      }
    }
    if (!inside) continue;
    for (const w of t.weirs) {
      for (let i = 0; i < w.length - 1; i++) {
        const [ax, ay] = w[i], [bx, by] = w[i + 1], dx = bx - ax, dy = by - ay;
        const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(x - ax - dx * k, y - ay - dy * k) < WEIR_CLEAR) return false;
      }
    }
    return true;
  }
  return false;
}

// A stretch of the fairway: points along the middle of the navigable water, each with
// the distance to the nearest bank.
export interface Reach { pts: [number, number, number][] }
export interface Landing { name: string; berth: Point2; gate: Point2 }
export interface FerryLine {
  ref: string; name: string; colour: string;
  stops: Landing[]; // in order
  legs: Point2[][]; // the way from each landing to the next
  mins: number[]; every: number; // the timetable's minutes for each leg, and between sailings
  hours: [number, number]; // first and last sailing on a weekday
  allYear: boolean; // the others sail from April to October
}
export interface RiverData { fairway: Reach[]; locks: Point2[][]; ferries: FerryLine[] }

const isPoint = (p: unknown, n = 2): boolean => Array.isArray(p) && p.length >= n && p.slice(0, n).every((v) => typeof v === 'number' && Number.isFinite(v));

// river.json as the game takes it: what doesn't fit is left out, so an older or broken
// file means no fairway or no ferries, not a crash.
export function parseRiver(raw: unknown): RiverData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const fairway = list(d.fairway).filter((r): r is Reach => {
    const pts = (r as Reach | null)?.pts;
    return Array.isArray(pts) && pts.length > 1 && pts.every((p) => isPoint(p, 3));
  });
  const locks = list(d.locks).filter((l): l is Point2[] => Array.isArray(l) && l.length > 1 && l.every((p) => isPoint(p)));
  const ferries = list(d.ferries).filter((f): f is FerryLine => {
    const l = f as FerryLine | null;
    return !!l && typeof l.ref === 'string' && Array.isArray(l.stops) && l.stops.length > 1 && Array.isArray(l.legs) && l.legs.length === l.stops.length - 1
      && l.stops.every((s) => typeof s?.name === 'string' && isPoint(s.berth) && isPoint(s.gate))
      && l.legs.every((leg) => Array.isArray(leg) && leg.length > 1 && leg.every((p) => isPoint(p)))
      && Array.isArray(l.hours) && isPoint(l.hours) && typeof l.every === 'number';
  });
  return { fairway, locks, ferries };
}

// A line to sail along: where it is `s` metres from its start, which way it runs there
// and how far the bank is (`w`, Infinity for a line without widths).
const RUN = 32;
export class Course {
  pts: number[][];
  cum: number[];
  length: number;

  constructor(pts: number[][]) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.cum[this.cum.length - 1];
  }

  at(s: number) {
    s = Math.max(0, Math.min(this.length, s));
    let lo = 1, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < s) lo = mid + 1; else hi = mid; }
    const a = this.pts[lo - 1], b = this.pts[lo], k = (s - this.cum[lo - 1]) / (this.cum[lo] - this.cum[lo - 1] || 1);
    return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, ang: Math.atan2(b[1] - a[1], b[0] - a[0]), w: a.length > 2 ? a[2] + (b[2] - a[2]) * k : Infinity };
  }

  // How far along the line the point nearest (x, y) is; with `near`, looking only
  // `reach` metres either side of it. With `within`, for a caller that only wants a
  // place no further than that from the line: the answer is the same up to there, and
  // beyond it `d` is only known to be more (the boats ask every frame where the river
  // is, from anywhere in the city, and the Vltava has 3000 points).
  project(x: number, y: number, near?: number, reach = 60, within = Infinity) {
    let best = Infinity, s = 0;
    const pts = this.pts, cum = this.cum, boxes = within < Infinity ? (this.boxes ??= this.box()) : null;
    for (let i = 1; i < pts.length; i++) {
      if (boxes && (i - 1) % RUN === 0) {
        // The next RUN pieces lie in this box: none of them is nearer than the box is.
        const o = ((i - 1) / RUN) * 4, bx = Math.max(boxes[o] - x, 0, x - boxes[o + 2]), by = Math.max(boxes[o + 1] - y, 0, y - boxes[o + 3]);
        const far = Math.sqrt(bx * bx + by * by) - 1e-6;
        if (far > within || far >= best) { i += RUN - 1; continue; }
      }
      if (near !== undefined && (cum[i] < near - reach || cum[i - 1] > near + reach)) continue;
      const a = pts[i - 1], b = pts[i], ax = a[0], ay = a[1], dx = b[0] - ax, dy = b[1] - ay;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - ax - dx * k, y - ay - dy * k);
      if (d < best) { best = d; s = cum[i - 1] + (cum[i] - cum[i - 1]) * k; }
    }
    return { s, d: best };
  }

  // The box (min x, min y, max x, max y) round each run of RUN pieces of the line.
  private boxes: Float64Array | null = null;
  private box() {
    const pts = this.pts, boxes = new Float64Array(Math.ceil((pts.length - 1) / RUN) * 4);
    for (let i = 0, o = 0; i < pts.length - 1; i += RUN, o += 4) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let j = i; j <= Math.min(i + RUN, pts.length - 1); j++) {
        x0 = Math.min(x0, pts[j][0]); y0 = Math.min(y0, pts[j][1]); x1 = Math.max(x1, pts[j][0]); y1 = Math.max(y1, pts[j][1]);
      }
      boxes[o] = x0; boxes[o + 1] = y0; boxes[o + 2] = x1; boxes[o + 3] = y1;
    }
    return boxes;
  }

  // The narrowest the water gets between two places along the line.
  narrowest(from: number, to: number) {
    const [a, b] = from < to ? [from, to] : [to, from];
    let w = Math.min(this.at(a).w, this.at(b).w);
    for (let i = 0; i < this.pts.length; i++) if (this.cum[i] > a && this.cum[i] < b) w = Math.min(w, this.pts[i][2] ?? Infinity);
    return w;
  }
}
