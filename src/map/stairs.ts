import type { Bounds, Point2 } from './geo.ts';
import type { GroundLayer } from '../surface.ts';
import type { RawStreetEdge } from '../network.ts';

export interface MappedStair { pts: Point2[]; width: number }

export function groundStairs(ways: RawStreetEdge[] = []): MappedStair[] {
  return ways.filter((e) => e.hw === 'steps' && !e.bridge && !e.tunnel && !e.level && !e.levels);
}

// The clear approach extends past the mapped end of each flight onto the landing.
export function stairLandings(stairs: MappedStair[]) {
  return stairs.flatMap(({ pts, width }) => {
    if (pts.length < 2 || !(width > 0)) return [];
    const radius = Math.min(1.3, width / 2);
    return [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]].flatMap(([end, next]) => {
      const dx = end[0] - next[0], dy = end[1] - next[1], length = Math.hypot(dx, dy);
      return length > 0.01 ? [{ x: end[0] + dx / length, y: end[1] + dy / length, radius }] : [];
    });
  });
}

// The walk graph has the line of a flight; its landings supply the rise. Keep the
// treads slightly above the continuous ground used for walking. Defer stairs with
// turns, tile seams, or uneven banks until there is a surveyed profile for them.
export function stairGeometry(stairs: MappedStair[], box: Bounds, height: (x: number, y: number) => number,
  blocked: (x: number, y: number) => boolean): { body: GroundLayer['geometry']; edges: GroundLayer['geometry'] } {
  const mesh = () => ({ position: [] as number[], normal: [] as number[], index: [] as number[] });
  const body = mesh(), edges = mesh();
  const quad = ({ position, normal, index }: ReturnType<typeof mesh>, vertices: [Point2, number][], nx: number, h: number, ny: number) => {
    const i = position.length / 3;
    for (const [[x, y], z] of vertices) { position.push(x, z, -y); normal.push(nx, h, -ny); }
    index.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  for (const { pts, width } of stairs) {
    if (pts.length < 2 || !(width > 0)) continue;
    let a = pts[0], b = pts[pts.length - 1];
    if (height(...a) > height(...b)) [a, b] = [b, a];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1.5 || length > 30) continue;
    const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
    if (pts.some(([x, y]) => Math.abs((y - a[1]) * ux - (x - a[0]) * uy) > 0.2)) continue;
    const half = Math.min(width / 2, 2.5);
    const point = (s: number, w: number): Point2 => [a[0] + ux * s - uy * w, a[1] + uy * s + ux * w];
    const samples = Math.ceil(length * 5);
    const sections: { s: number; left: Point2; right: Point2; lo: number; hi: number }[] = [];
    for (let i = 0; i <= samples; i++) {
      const s = i * length / samples;
      const left = point(s, half), right = point(s, -half), middle = point(s, 0);
      if ([left, right, middle].some(([x, y]) => x <= box[0] || x >= box[2] || y <= box[1] || y >= box[3] || blocked(x, y))) break;
      const heights = [height(...left), height(...middle), height(...right)];
      const lo = Math.min(...heights), hi = Math.max(...heights);
      if (!Number.isFinite(hi) || hi - lo > 0.22 || (sections.length && hi < sections[sections.length - 1].hi - 0.08)) break;
      sections.push({ s, left, right, lo, hi: Math.max(hi, sections[sections.length - 1]?.hi ?? hi) });
    }
    if (sections.length !== samples + 1) continue;
    const start = sections[0], end = sections[sections.length - 1], rise = end.hi - start.hi;
    if (rise < 0.3 || rise / length > 0.8) continue;
    const count = Math.max(2, Math.round(rise / 0.17));
    if (count > 60 || length / count < 0.2 || length / count > 0.85) continue;
    let previous = start, top = start.hi;
    for (let k = 1; k <= count; k++) {
      const target = start.hi + rise * k / count;
      const next = k === count ? end : sections.find((p) => p.s > previous.s && p.hi >= target);
      if (!next || next === previous) continue;
      const h = next.hi + 0.025;
      quad(body, [[previous.left, h], [previous.right, h], [next.right, h], [next.left, h]], 0, 1, 0);
      quad(body, [[previous.right, top], [previous.right, h], [previous.left, h], [previous.left, top]], -ux, 0, -uy);
      quad(body, [[previous.left, previous.lo], [previous.left, h], [next.left, h], [next.left, next.lo]], -uy, 0, ux);
      quad(body, [[next.right, next.lo], [next.right, h], [previous.right, h], [previous.right, previous.lo]], uy, 0, -ux);
      const edge = Math.min(previous.s + 0.055, next.s), line = h + 0.003;
      quad(edges, [[previous.left, line], [previous.right, line], [point(edge, -half), line], [point(edge, half), line]], 0, 1, 0);
      previous = next;
      top = h;
    }
  }
  const finish = ({ position, normal, index }: ReturnType<typeof mesh>) =>
    ({ position: new Float32Array(position), normal: new Float32Array(normal), index: new Uint32Array(index) });
  return { body: finish(body), edges: finish(edges) };
}
