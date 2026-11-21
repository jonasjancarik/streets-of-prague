import type { Polyline } from './network.ts';
import type { Point2 } from './map/geo.ts';

// Points of `poly` from s0 to s1 (backwards if s1 < s0), as [x, y].
export function slicePath(poly: Polyline, s0: number, s1: number): Point2[] {
  const a = poly.at(s0), b = poly.at(s1), out: Point2[] = [[a.x, a.y]];
  const { pts, cum } = poly;
  if (s1 >= s0) { for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]); }
  else for (let i = pts.length - 1; i >= 0; i--) if (cum[i] < s0 && cum[i] > s1) out.push(pts[i]);
  out.push([b.x, b.y]);
  return out;
}

// Smallest-first queue of [cost, value] for the route search (the taxis' too).
export class Heap {
  a: [number, string][];
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item: [number, string]) {
    const a = this.a;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length && last) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
