// Shared tile edges use one piecewise-linear height profile, independent of the
// triangle refinement and clipped-outline classification chosen inside each tile.
import type { Bounds } from './map/geo.ts';

type HeightAt = (x: number, y: number, side?: number | boolean) => number;
const EPS = 1e-7;
const sameUploadedNormal = (a: number, b: number, normal: number) => Math.fround(a) === Math.fround(normal) && Math.fround(b) === Math.fround(normal);

function edge(ax: number, ay: number, bx: number, by: number, [x0, y0, x1, y1]: Bounds) {
  // Classify the normal coordinate that is actually uploaded. A slightly inset
  // double can occupy the same Float32 edge as the exact perimeter coordinate.
  if (sameUploadedNormal(ax, bx, x0)) return { vertical: true, normal: x0, a: ay, b: by, lo: y0, hi: y1 };
  if (sameUploadedNormal(ax, bx, x1)) return { vertical: true, normal: x1, a: ay, b: by, lo: y0, hi: y1 };
  if (sameUploadedNormal(ay, by, y0)) return { vertical: false, normal: y0, a: ax, b: bx, lo: x0, hi: x1 };
  if (sameUploadedNormal(ay, by, y1)) return { vertical: false, normal: y1, a: ax, b: bx, lo: x0, hi: x1 };
  return null;
}

// The two tiles share world-aligned stations and their common edge endpoints.
// Additional cut vertices interpolate this same profile, rather than introducing
// a new sample of a curved height field on only one side. Use uploaded Float32
// coordinates for interpolation so large local map coordinates also stay joined.
export function edgeHeightSampler(raw: HeightAt, box: Bounds, spacing: number): HeightAt {
  const cache = new Map<string, number>();
  const sample = (x: number, y: number, side?: number | boolean) => {
    const key = `${x},${y}:${side}`;
    let h = cache.get(key);
    if (h === undefined) { h = raw(x, y, side); cache.set(key, h); }
    return h;
  };
  return (x, y, side) => {
    const e = edge(x, y, x, y, box);
    if (!e || e.a < e.lo - EPS || e.a > e.hi + EPS) return raw(x, y, side);
    // Choose the cell before Float32 rounding: a point just below a fractional
    // tile end can round beyond it, but its height anchors must remain in the tile.
    const u = Math.fround(e.a), start = Math.floor(Math.max(e.lo, Math.min(e.hi, e.a)) / spacing) * spacing;
    const lo = Math.max(e.lo, start), hi = Math.min(e.hi, start + spacing);
    const point = (v: number) => Math.fround(e.vertical ? sample(e.normal, v, side) : sample(v, e.normal, side));
    if (Math.abs(e.a - e.lo) < EPS) return point(e.lo);
    if (Math.abs(e.a - e.hi) < EPS) return point(e.hi);
    const a = Math.fround(lo), b = Math.fround(hi);
    if (b - a <= EPS) return point(lo);
    const t = Math.max(0, Math.min(1, (u - a) / (b - a)));
    return point(lo) * (1 - t) + point(hi) * t;
  };
}

// Ensure the mesh really contains every station used by edgeHeightSampler.
// A centroid fan preserves collinear edge stations that an ear-clipping pass
// might discard. Per-side vertices and optional alpha values stay separate.
export function conformTerrainEdges(pos: number[], idx: number[], extra: number[] | null, side: number[] | null,
  box: Bounds, spacing: number) {
  const cuts = new Map<string, number>(), out: number[] = [];
  for (let k = 0; k < idx.length; k += 3) {
    const tri = [idx[k], idx[k + 1], idx[k + 2]], ring: number[] = [];
    let changed = false;
    for (let j = 0; j < 3; j++) {
      const a = tri[j], b = tri[(j + 1) % 3];
      ring.push(a);
      const e = edge(pos[a * 3], -pos[a * 3 + 2], pos[b * 3], -pos[b * 3 + 2], box);
      if (!e || Math.abs(e.b - e.a) <= EPS) continue;
      const lo = Math.max(e.lo, Math.min(e.a, e.b)), hi = Math.min(e.hi, Math.max(e.a, e.b));
      if (hi - lo <= EPS) continue;
      const stations: number[] = [];
      if (e.lo > Math.min(e.a, e.b) + EPS && e.lo < Math.max(e.a, e.b) - EPS) stations.push(e.lo);
      for (let u = (Math.floor(lo / spacing) + 1) * spacing; u < hi - EPS; u += spacing) stations.push(u);
      if (e.hi > Math.min(e.a, e.b) + EPS && e.hi < Math.max(e.a, e.b) - EPS) stations.push(e.hi);
      if (e.b < e.a) stations.reverse();
      for (const u of stations) {
        const key = `${Math.min(a, b)},${Math.max(a, b)}:${u}`;
        let id = cuts.get(key);
        if (id === undefined) {
          const t = (u - e.a) / (e.b - e.a);
          id = pos.length / 3;
          pos.push(e.vertical ? e.normal : u, 0, -(e.vertical ? u : e.normal));
          extra?.push(extra[a] + (extra[b] - extra[a]) * t);
          side?.push(side[a]);
          cuts.set(key, id);
        }
        ring.push(id); changed = true;
      }
    }
    if (!changed) { out.push(...tri); continue; }
    const centre = pos.length / 3;
    pos.push(tri.reduce((sum, i) => sum + pos[i * 3], 0) / 3, 0, tri.reduce((sum, i) => sum + pos[i * 3 + 2], 0) / 3);
    extra?.push(tri.reduce((sum, i) => sum + extra[i], 0) / 3);
    side?.push(side[tri[0]]);
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j], b = ring[(j + 1) % ring.length];
      const area = (pos[a * 3] - pos[centre * 3]) * (pos[b * 3 + 2] - pos[centre * 3 + 2])
        - (pos[a * 3 + 2] - pos[centre * 3 + 2]) * (pos[b * 3] - pos[centre * 3]);
      if (Math.abs(area) > EPS * EPS) out.push(centre, a, b);
    }
  }
  return { pos, idx: out, extra, side };
}
