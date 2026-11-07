// Ordinary asphalt uses a coverage texture on the tile's terrain
// triangles. The worker builds them from the same outlines as the mesh path.
import type { Bounds, Point2, Polygons } from './map/geo.ts';
import type { GroundLayer } from './surface.ts';

export interface RoadRaster {
  box: Bounds; // west, north, east, south, in texture row order
  w: number;
  h: number;
  cells: Uint8Array;
}

const RES = 2;
const EDGE_EPS = 1e-7;

// Road polygons are already clipped to the tile. At a join, paint the
// common vector intervals rather than the two different interior texels.
export function rasterSeamCoverage(polys: Polygons, axis: 0 | 1, edge: number, origin: number, count: number) {
  const events: [number, number][] = [];
  const offset = (v: number) => (v - origin) * (axis === 0 ? -RES : RES);
  for (const rings of polys) for (let r = 0; r < rings.length; r++) {
    const ring = rings[r], sign = r === 0 ? 1 : -1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (Math.abs(a[axis] - edge) > EDGE_EPS || Math.abs(b[axis] - edge) > EDGE_EPS) continue;
      const u = offset(a[1 - axis]), v = offset(b[1 - axis]);
      events.push([Math.min(u, v), sign], [Math.max(u, v), -sign]);
    }
  }
  events.sort((a, b) => a[0] - b[0]);
  const coverage = new Float64Array(count);
  let depth = 0, last = 0;
  for (const [at, change] of events) {
    if (depth > 0) {
      const lo = Math.max(0, last), hi = Math.min(count, at);
      for (let i = Math.floor(lo); i < hi; i++) coverage[i] += Math.min(i + 1, hi) - Math.max(i, lo);
    }
    depth += change;
    last = at;
  }
  return Uint8Array.from(coverage, (v) => Math.round(Math.min(1, v) * 255));
}

export function pavingRaster(box: Bounds, polys: Polygons): RoadRaster | null {
  let loX = Infinity, loY = Infinity, hiX = -Infinity, hiY = -Infinity;
  for (const rings of polys) for (const ring of rings) for (const [x, y] of ring) {
    loX = Math.min(loX, x); loY = Math.min(loY, y);
    hiX = Math.max(hiX, x); hiY = Math.max(hiY, y);
  }
  if (loX >= hiX || loY >= hiY) return null;
  const [x0, y0, x1, y1] = box;
  const cols = Math.ceil((x1 - x0) * RES - EDGE_EPS), rows = Math.ceil((y1 - y0) * RES - EDGE_EPS);
  const a = Math.max(0, Math.floor((loX - x0) * RES) - 1);
  const b = Math.min(cols, Math.ceil((hiX - x0) * RES) + 1);
  const c = Math.max(0, Math.floor((y1 - hiY) * RES) - 1);
  const d = Math.min(rows, Math.ceil((y1 - loY) * RES) + 1);
  const w = b - a, h = d - c;
  if (w <= 0 || h <= 0) return null;
  const west = x0 + a / RES, north = y1 - c / RES;
  const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Cannot create a road coverage canvas');
  ctx.setTransform(RES, 0, 0, -RES, -west * RES, north * RES);
  ctx.fillStyle = '#fff';
  for (const rings of polys) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x, y));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const cells = new Uint8Array(w * h);
  for (let i = 0; i < cells.length; i++) cells[i] = rgba[i * 4 + 3];
  canvas.width = canvas.height = 0;
  const column = (x: number, edge: number) => {
    const values = rasterSeamCoverage(polys, 0, edge, north, h);
    values.forEach((v, y) => { cells[y * w + x] = v; });
  };
  if (a === 0) column(0, x0);
  if (b === cols) column(w - 1, x1);
  if (c === 0) cells.set(rasterSeamCoverage(polys, 1, y1, west, w));
  if (d === rows) cells.set(rasterSeamCoverage(polys, 1, y0, west, w), (h - 1) * w);
  // A road passing through a tile corner has a vertex there in each clipped
  // piece. Give those shared corner texels the same point coverage.
  for (const [touchX, touchY, x, y, i] of [
    [a === 0, c === 0, x0, y1, 0], [b === cols, c === 0, x1, y1, w - 1],
    [a === 0, d === rows, x0, y0, (h - 1) * w], [b === cols, d === rows, x1, y0, cells.length - 1],
  ] as const) {
    if (touchX && touchY) cells[i] = polys.some(([outer]) => outer.some(([px, py]) =>
      Math.abs(px - x) <= EDGE_EPS && Math.abs(py - y) <= EDGE_EPS)) ? 255 : 0;
  }
  return cells.some((v) => v !== 0) ? { box: [west, north, x0 + b / RES, y1 - d / RES], w, h, cells } : null;
}

// One extra texel includes the coverage reachable by linear filtering.
function coverageBounds({ box: [west, north], w, h, cells }: RoadRaster) {
  // An integral image avoids rescanning the texels under every mesh edge.
  const stride = w + 1, sums = new Uint32Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += cells[y * w + x] ? 1 : 0;
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + row;
    }
  }
  return (x0: number, y0: number, x1: number, y1: number) => {
    const lo = Math.max(0, Math.floor((x0 - west) * RES) - 1);
    const hi = Math.min(w - 1, Math.ceil((x1 - west) * RES) + 1);
    const top = Math.max(0, Math.floor((north - y1) * RES) - 1);
    const bottom = Math.min(h - 1, Math.ceil((north - y0) * RES) + 1);
    if (lo > hi || top > bottom) return false;
    const first = top * stride, last = (bottom + 1) * stride;
    return sums[last + hi + 1] + sums[first + lo] > sums[first + hi + 1] + sums[last + lo];
  };
}

// Refine the shared terrain near roads where a linear edge misses the
// height sampler. Step cuts still decide which side a vertex lies on.
export function refineRasterRoad(
  pos: number[], raster: RoadRaster, height: (x: number, y: number, side?: number) => number,
  sideAt: ((x: number, y: number) => number) | null,
) {
  const covered = coverageBounds(raster);
  const heights: number[] = [], labels: number[] = [];
  const decisions = new Map<number, boolean>();
  const needsSplit = (a: number, b: number) => {
    const ax = pos[a * 3], ay = -pos[a * 3 + 2], bx = pos[b * 3], by = -pos[b * 3 + 2];
    if (!covered(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) return false;
    const side = sideAt ? labels[a] ??= sideAt(ax, ay) : undefined;
    if (sideAt && side !== (labels[b] ??= sideAt(bx, by))) return false;
    const ha = heights[a] ??= height(ax, ay, side), hb = heights[b] ??= height(bx, by, side);
    for (let probe = 1; probe <= 3; probe++) {
      const f = probe / 4;
      const x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
      if (side !== sideAt?.(x, y)) continue;
      if (Math.abs(height(x, y, side) - (ha + (hb - ha) * f)) > 0.08) return true;
    }
    return false;
  };
  return (a: number, b: number, d2: number) => {
    if (d2 <= 1.5 ** 2) return false;
    // Both faces incident to an edge make the same refinement decision.
    const key = Math.min(a, b) * 4194304 + Math.max(a, b);
    let split = decisions.get(key);
    if (split === undefined) {
      split = needsSplit(a, b);
      decisions.set(key, split);
    }
    return split;
  };
}

// Copy only terrain triangles whose plan bounds meet the texture.
export function roadRasterGeometry(base: GroundLayer['geometry'], raster: RoadRaster): GroundLayer['geometry'] {
  const out: number[] = [], positions: number[] = [], normals: number[] = [];
  const { position: pos, normal, index } = base;
  const ids = new Int32Array(pos.length / 3).fill(-1), covered = coverageBounds(raster);
  const vertex = (i: number) => {
    if (ids[i] >= 0) return ids[i];
    const v = positions.length / 3, at = i * 3;
    positions.push(pos[at], pos[at + 1], pos[at + 2]);
    normals.push(normal[at], normal[at + 1], normal[at + 2]);
    ids[i] = v;
    return v;
  };
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const x0 = Math.min(pos[a], pos[b], pos[c]), x1 = Math.max(pos[a], pos[b], pos[c]);
    const y0 = -Math.max(pos[a + 2], pos[b + 2], pos[c + 2]), y1 = -Math.min(pos[a + 2], pos[b + 2], pos[c + 2]);
    if (covered(x0, y0, x1, y1)) out.push(vertex(index[i]), vertex(index[i + 1]), vertex(index[i + 2]));
  }
  return { position: new Float32Array(positions), normal: new Float32Array(normals), index: new Uint32Array(out) };
}
