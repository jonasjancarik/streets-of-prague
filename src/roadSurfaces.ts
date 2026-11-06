// Local survey fits. The mask feathers into ordinary terrain and the terrain
// labels keep the two sides of a retaining wall separate.
import type { Bounds } from './map/geo.ts';

interface SurfaceFootprint {
  id: string;
  box: Bounds;
  n: [number, number];
  weights: number[];
}

export type RoadSurface = SurfaceFootprint & (
  { z: [number, number, number, number, number, number]; heights?: never }
  | { heights: number[]; z?: never }
);

type HeightAt = (x: number, y: number, side?: number | boolean) => number;

export function readRoadSurfaces(value: unknown, area: string, built?: string): Map<string, RoadSurface[]> | null {
  if (!value || typeof value !== 'object' || !built) return null;
  const f = value as { version?: number; area?: string; built?: string; patches?: unknown };
  if (f.version !== 1 || f.area !== area || f.built !== built || !Array.isArray(f.patches)) return null;
  const tiles = new Map<string, RoadSurface[]>();
  const ids = new Set<string>();
  const finite = (a: unknown, size: number) => Array.isArray(a) && a.length === size && a.every(Number.isFinite);
  for (const p of f.patches as (RoadSurface & { tiles: string[] })[]) {
    if (!p || typeof p.id !== 'string' || ids.has(p.id) || !finite(p.box, 4) || !p.box.every(Number.isInteger) || !finite(p.n, 2)
      || !p.n.every((n) => Number.isInteger(n) && n >= 2 && n <= 128)
      || p.box[2] - p.box[0] !== p.n[0] - 1 || p.box[3] - p.box[1] !== p.n[1] - 1
      || !Array.isArray(p.weights) || p.weights.length !== p.n[0] * p.n[1]
      || !p.weights.every((w) => Number.isInteger(w) && w >= 0 && w <= 255)
      || !Array.isArray(p.tiles) || !p.tiles.length || new Set(p.tiles).size !== p.tiles.length
      || !p.tiles.every((k) => typeof k === 'string' && /^\d+_\d+$/.test(k))) return null;
    const [nx, ny] = p.n;
    if (p.heights === undefined ? !finite(p.z, 6) : p.z !== undefined || !finite(p.heights, nx * ny)) return null;
    if (p.weights.some((w, i) => w !== 0
      && (i < nx || i >= nx * (ny - 1) || i % nx === 0 || i % nx === nx - 1))) return null;
    ids.add(p.id);
    for (const key of p.tiles) {
      const list = tiles.get(key) ?? [];
      list.push(p);
      tiles.set(key, list);
    }
  }
  return tiles;
}

export function withRoadSurfaces(base: HeightAt, patches: RoadSurface[] | undefined, ref: number,
  label: ((x: number, y: number) => number) | null): HeightAt {
  if (!patches?.length) return base;
  const sample = (x: number, y: number, side: number | boolean = false, start = 0): number => {
    if (side) return base(x, y, side);
    for (let i = start; i < patches.length; i++) {
      const p = patches[i];
      const [x0, y0, x1, y1] = p.box;
      if (x <= x0 || x >= x1 || y <= y0 || y >= y1) continue;
      const u = x - x0, v = y - y0, col = Math.floor(u), row = Math.floor(v), n = p.n[0];
      const a = u - col, b = v - row, k = row * n + col;
      const strength = bilinear(p.weights, k, n, a, b) / 255;
      if (!strength) continue;
      if (side === false && label?.(x, y)) return base(x, y, side);
      if (p.heights) {
        const fitted = bilinear(p.heights, k, n, a, b) - ref;
        // A corridor can taper into the junction fit below it.
        return strength === 1 ? fitted : strength * fitted + (1 - strength) * sample(x, y, side, i + 1);
      }
      const s = 2 * u / (x1 - x0) - 1, t = 2 * v / (y1 - y0) - 1;
      const [h, dx, dy, xx, xy, yy] = p.z;
      const fitted = h + s * (dx + s * xx + t * xy) + t * (dy + t * yy) - ref;
      return strength === 1 ? fitted : strength * fitted + (1 - strength) * base(x, y, side);
    }
    return base(x, y, side);
  };
  return sample;
}

function bilinear(v: number[], k: number, stride: number, a: number, b: number) {
  return (v[k] * (1 - a) + v[k + 1] * a) * (1 - b)
    + (v[k + stride] * (1 - a) + v[k + stride + 1] * a) * b;
}
