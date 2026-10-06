// What lies in and stands on the streets, surveyed (pipeline/ipr_utility.py, a tile's
// `utility`): manhole covers, storm drains and the small covers of underground hydrants,
// flat on the ground; hydrants and phone boxes, standing. Worked out in the tile workers.
import type { Point2 } from './geo.ts';

export type UtilityMark = [number, number, number]; // x, y (m), kind
export const MANHOLE = 0, DRAIN = 1, HYDRANT = 2, PHONE = 3, HYDRANT_COVER = 4;

// Which way the nearest street runs at a point (radians, 0 if none is within `reach`):
// a drain's bars and a phone box's door follow it.
export function streetAngle(lines: Point2[][], reach = 25) {
  const segments: number[] = [];
  for (const pts of lines) for (let i = 0; i < pts.length - 1; i++) segments.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  return (x: number, y: number) => {
    let best = reach * reach, angle = 0;
    for (let s = 0; s < segments.length; s += 4) {
      const ax = segments[s], ay = segments[s + 1], dx = segments[s + 2] - ax, dy = segments[s + 3] - ay;
      if (x < Math.min(ax, ax + dx) - reach || x > Math.max(ax, ax + dx) + reach || y < Math.min(ay, ay + dy) - reach || y > Math.max(ay, ay + dy) + reach) continue;
      const len = dx * dx + dy * dy, t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
      const d = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
      if (d < best) { best = d; angle = Math.atan2(dy, dx); }
    }
    return angle;
  };
}

// All of a tile's covers and drains as one flat mesh in the colour of cast iron, each
// lying on the ground under it: a manhole is a round lid in its frame (the gap between
// them shows the street), a drain a square grate of five bars along the kerb, a
// hydrant's cover a small oval. No object and no draw of its own per cover.
export function coverGeometry(marks: UtilityMark[], lines: Point2[][], height: (x: number, y: number) => number) {
  const pos: number[] = [], idx: number[] = [];
  const angleAt = streetAngle(lines);
  const point = (x: number, y: number) => { pos.push(x, height(x, y), -y); return pos.length / 3 - 1; };
  const disc = (x: number, y: number, rx: number, ry: number, n: number, turn: number) => {
    const c = Math.cos(turn), s = Math.sin(turn), centre = point(x, y), first = pos.length / 3;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, u = Math.cos(a) * rx, v = Math.sin(a) * ry;
      point(x + c * u - s * v, y + s * u + c * v);
    }
    for (let k = 0; k < n; k++) idx.push(centre, first + k, first + (k + 1) % n);
  };
  const ring = (x: number, y: number, r0: number, r1: number, n: number) => {
    const first = pos.length / 3;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      point(x + c * r0, y + s * r0); point(x + c * r1, y + s * r1);
    }
    for (let k = 0; k < n; k++) {
      const a = first + k * 2, b = first + ((k + 1) % n) * 2;
      idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  };
  for (const [x, y, kind] of marks) {
    if (kind === MANHOLE) {
      ring(x, y, 0.29, 0.35, 8);
      disc(x, y, 0.265, 0.265, 8, 0);
    } else if (kind === DRAIN) {
      // Five bars with the street showing between them, the way the water runs along the kerb.
      const a = angleAt(x, y), c = Math.cos(a), s = Math.sin(a);
      for (let b = -2; b <= 2; b++) {
        const v = b * 0.11, first = pos.length / 3;
        for (const [du, dv] of [[-0.25, -0.032], [0.25, -0.032], [0.25, 0.032], [-0.25, 0.032]]) point(x + c * du - s * (v + dv), y + s * du + c * (v + dv));
        idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
    } else if (kind === HYDRANT_COVER) disc(x, y, 0.17, 0.12, 6, angleAt(x, y));
  }
  const normal = new Float32Array(pos.length);
  for (let i = 1; i < normal.length; i += 3) normal[i] = 1;
  return { position: new Float32Array(pos), normal, index: new Uint32Array(idx) };
}

// Where the surveyed hydrants and phone boxes stand: { kind (the furniture's 3 or 4), x,
// y, angle }. A phone box faces along the nearest path or street.
export function standingMarks(marks: UtilityMark[], lines: Point2[][]) {
  const angleAt = streetAngle(lines, 15);
  const out: { kind: 3 | 4; x: number; y: number; angle: number }[] = [];
  for (const [x, y, kind] of marks) {
    if (kind === HYDRANT) out.push({ kind: 3, x, y, angle: 0 });
    else if (kind === PHONE) out.push({ kind: 4, x, y, angle: angleAt(x, y) });
  }
  return out;
}
