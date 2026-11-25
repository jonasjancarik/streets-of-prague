// Downward-facing soffits and inward-facing wall lining for the street camera.
// Use the actual floor mesh and the terrain over its centre. A shallow cutting
// or a portal approach remains open to daylight.
import type { Bounds, Point2, Polygons } from './geo.ts';
import type { GroundLayer } from '../surface.ts';

type Geometry = GroundLayer['geometry'];
type Height = (x: number, y: number) => number;
interface Frame {
  x: number;
  y: number;
  dx: number;
  dy: number;
  length: number;
  before: number;
  after: number;
}
interface Slice {
  x: number;
  y: number;
  floor: number;
  ceiling: number;
  along: number;
  across: number;
  inside: number;
}
interface Buffers {
  position: number[];
  normal: number[];
  index: number[];
  uv: number[];
}

function frames(lines: Point2[][], box?: Bounds) {
  const onEdge = ([x, y]: Point2) =>
    box && Math.min(Math.abs(x - box[0]), Math.abs(x - box[2]), Math.abs(y - box[1]), Math.abs(y - box[3])) < .1;
  const continuation = box ? Math.hypot(box[2] - box[0], box[3] - box[1]) : 0;
  const all: Frame[] = [];
  for (const pts of lines) {
    let before = 0;
    const length = pts.slice(1).reduce((n, b, i) => n + Math.hypot(b[0] - pts[i][0], b[1] - pts[i][1]), 0);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d < .02) continue;
      all.push({
        x: a[0],
        y: a[1],
        dx: (b[0] - a[0]) / d,
        dy: (b[1] - a[1]) / d,
        length: d,
        before: onEdge(pts[0]) ? continuation : before,
        after: onEdge(pts[pts.length - 1]) ? continuation : length - before - d,
      });
      before += d;
    }
  }
  return all;
}
function clip(points: Slice[]) {
  const out: Slice[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (a.inside >= 0) out.push(a);
    if ((a.inside >= 0) === (b.inside >= 0)) continue;
    const t = a.inside / (a.inside - b.inside);
    const lerp = (key: keyof Slice) => a[key] + (b[key] - a[key]) * t;
    out.push({
      x: lerp('x'),
      y: lerp('y'),
      floor: lerp('floor'),
      ceiling: lerp('ceiling'),
      along: lerp('along'),
      across: lerp('across'),
      inside: 0,
    });
  }
  return out;
}
const buffers = (): Buffers => ({ position: [], normal: [], index: [], uv: [] });
const result = (g: Buffers): Geometry => ({
  position: Float32Array.from(g.position),
  normal: Float32Array.from(g.normal),
  index: Uint32Array.from(g.index),
  uv: Float32Array.from(g.uv),
});

export function tunnelInterior(
  polys: Polygons,
  floorMesh: Geometry,
  lines: Point2[][],
  box: Bounds,
  ground: Height,
  floorAt: Height,
) {
  const roof = buffers(), walls = buffers(), axes = frames(lines, box);
  // Older maps can have a tunnel floor but no named network level for its paint.
  const fallback = frames(polys.flatMap((poly) => poly.map((r) => [...r, r[0]]))).sort((a, b) => b.length - a.length)[0];
  if (!fallback) return { roof: result(roof), walls: result(walls) };
  function nearest(x: number, y: number) {
    let guide = fallback, best = Infinity;
    for (const a of axes) {
      const t = Math.max(0, Math.min(a.length, (x - a.x) * a.dx + (y - a.y) * a.dy));
      const d = (x - a.x - t * a.dx) ** 2 + (y - a.y - t * a.dy) ** 2;
      if (d < best) {
        best = d;
        guide = a;
      }
    }
    return guide;
  }
  function slice(x: number, y: number) {
    const a = nearest(x, y), ux = a.dx, uy = a.dy, nx = -uy, ny = ux;
    // Intersect the cross section with the actual tunnel polygon. OSM's road
    // line can lie several metres to one side of the floor in the survey.
    const cuts: number[] = [];
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          const u = (p[0] - x) * ux + (p[1] - y) * uy, v = (q[0] - x) * ux + (q[1] - y) * uy;
          if ((u > 0) === (v > 0)) continue;
          const t = u / (u - v);
          cuts.push((p[0] + (q[0] - p[0]) * t - x) * nx + (p[1] + (q[1] - p[1]) * t - y) * ny);
        }
      }
    }
    cuts.sort((p, q) => p - q);
    let offset = 0, across = .5, width = 7;
    for (let i = 1; i < cuts.length; i += 2) {
      const lo = cuts[i - 1], hi = cuts[i];
      if (lo <= .08 && hi >= -.08 && hi - lo > .05) {
        width = hi - lo;
        offset = (lo + hi) / 2;
        across = Math.max(0, Math.min(1, -lo / (hi - lo)));
        break;
      }
    }
    const cx = x + offset * nx, cy = y + offset * ny, h = floorAt(x, y), depth = ground(cx, cy) - floorAt(cx, cy);
    const along = (x - a.x) * ux + (y - a.y) * uy;
    const covered = axes.length ? Math.min(a.before + along, a.after + a.length - along) : Infinity;
    const clearance = (axes.length ? Math.min(4.95, 3.3 + width * .105) : Math.max(2.65, Math.min(5.05, depth - .52))) -
      .14 * (2 * across - 1) ** 2;
    // A mapped centreline can extend into an open ramp. Keep both the crown
    // and its outer panels under the actual surface above this part of the bore.
    const cover = Math.min(depth, ground(x, y) - h);
    return {
      x,
      y,
      floor: h,
      ceiling: h + Math.min(clearance, cover - .5),
      along: along + a.x * ux + a.y * uy,
      across,
      inside: Math.min(covered, cover - (axes.length ? 2.9 : 3.18)),
    };
  }
  const pos = floorMesh.position, ids = floorMesh.index, samples: Slice[] = [];
  for (let i = 0; i < pos.length; i += 3) samples.push(slice(pos[i], -pos[i + 2]));
  for (let i = 0; i < ids.length; i += 3) {
    const cut = clip([samples[ids[i]], samples[ids[i + 1]], samples[ids[i + 2]]]);
    const first = roof.position.length / 3;
    for (const p of cut) {
      roof.position.push(p.x, p.ceiling, -p.y);
      roof.normal.push(0, -1, 0);
      roof.uv.push(p.along / 6.4, p.across);
    }
    // Ground triangles face up. The ceiling faces the people underneath it.
    for (let j = 1; j < cut.length - 1; j++) roof.index.push(first, first + j + 1, first + j);
  }
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < .05) continue;
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, guide = nearest(mx, my);
        if (
          Math.min(Math.abs(mx - box[0]), Math.abs(mx - box[2]), Math.abs(my - box[1]), Math.abs(my - box[3])) < .02
        ) continue;
        const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
        if (Math.abs(dx * guide.dx + dy * guide.dy) < .42) continue; // no end wall across the way out
        const n = Math.ceil(len / 2), s = slice(mx, my), side = s.across < .5 ? 1 : -1;
        const nx = -guide.dy * side, ny = guide.dx * side;
        let first = slice(a[0], a[1]);
        for (let j = 1; j <= n; j++) {
          const next = slice(a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n);
          const ends = clip([first, next]);
          if (ends.length >= 2) {
            // Clipping a two-point segment can produce the same intersection twice.
            const l = ends[0], r = ends.find((q) => Math.hypot(q.x - l.x, q.y - l.y) > .015);
            if (r) {
              const base = walls.position.length / 3;
              for (const [p, top] of [[l, false], [r, false], [r, true], [l, true]] as const) {
                const h = top ? p.ceiling + .025 : p.floor + .01;
                walls.position.push(p.x + .025 * nx, h, -p.y - .025 * ny);
                walls.normal.push(nx, 0, -ny);
                walls.uv.push(p.along / 4.8, Math.max(0, (h - p.floor) / 5.15));
              }
              walls.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
            }
          }
          first = next;
        }
      }
    }
  }
  return { roof: result(roof), walls: result(walls) };
}
