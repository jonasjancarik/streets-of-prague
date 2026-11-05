// Road stretches and bridge approaches shared by tile assembly and offline checks.
import type { Point2 } from './map/geo.ts';

// An edge cut where it changes level along itself (RawStreetEdge.levels): its stretches,
// each with its level; whole, with its one level, when it doesn't.
export function byLevel(e: { pts: Point2[]; level?: number; levels?: [number, number][] }): { pts: Point2[]; level?: number }[] {
  if (!e.levels || e.levels.length < 2) return [{ pts: e.pts, level: e.level }];
  const out: { pts: Point2[]; level?: number }[] = [];
  let k = 0, s = 0, cur: Point2[] = [e.pts[0]];
  for (let i = 0; i < e.pts.length - 1; i++) {
    const a = e.pts[i], b = e.pts[i + 1], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (k + 1 < e.levels.length && e.levels[k + 1][0] <= s + d) {
      const f = d ? (e.levels[k + 1][0] - s) / d : 0, at: Point2 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      cur.push(at);
      out.push({ pts: cur, level: e.levels[k][1] });
      cur = [at];
      k++;
    }
    cur.push(b);
    s += d;
  }
  out.push({ pts: cur, level: e.levels[k][1] });
  return out.filter((part) => part.pts.length > 1);
}

// The two ends of a bridge's way, each as a short line from 4 m inside the bridge to
// 4 m out along the street it continues.
function bridgeEnds(pts: Point2[], reach = 4): Point2[][] {
  const end = (a: Point2, b: Point2): Point2[] => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / d, uy = (b[1] - a[1]) / d, r = Math.min(reach, d);
    return [[a[0] - ux * reach, a[1] - uy * reach], [a[0] + ux * r, a[1] + uy * r]];
  };
  return pts.length < 2 ? [] : [end(pts[0], pts[1]), end(pts[pts.length - 1], pts[pts.length - 2])];
}

// Only the ends of raised stretches open a terrain step; a bridge overhead does not.
export function bridgeApproaches(e: { bridge?: boolean; pts: Point2[]; level?: number; levels?: [number, number][] }): Point2[][] {
  return e.bridge ? byLevel(e).filter((part) => part.level).flatMap((part) => bridgeEnds(part.pts)) : [];
}
