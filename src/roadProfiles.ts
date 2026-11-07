// Experimental level-zero road profile fitted from both surveyed kerbs. Coordinates
// are in the map's local projection and elevation is in metres above sea level.
// The core is a cubic longitudinal profile with a single measured cross-slope.
import type { Bounds, Point2 } from './map/geo.ts';

export interface RoadProfile {
  from: Point2;
  to: Point2;
  half: number;
  shoulder: number;
  taper: number;
  elevation: [number, number, number, number];
  cross: number;
}

interface RoadProfileFile { version: 1; area: string; built: string; tiles: string[]; profile: RoadProfile }
type HeightAt = (x: number, y: number, side?: number | boolean) => number;

// Match the underlying assembled map. Older maps and other builds can safely ignore
// this optional file. The fitter's geometric safety checks run before writing it.
export function readRoadProfile(value: unknown, area: string, built?: string): RoadProfileFile | null {
  if (!value || typeof value !== 'object' || !built) return null;
  const f = value as Partial<RoadProfileFile>, p = f.profile;
  if (f.version !== 1 || f.area !== area || f.built !== built || !Array.isArray(f.tiles) || !f.tiles.length
    || !f.tiles.every((key) => typeof key === 'string' && /^\d+_\d+$/.test(key)) || !p) return null;
  const finite = (v: unknown, size: number) => Array.isArray(v) && v.length === size && v.every(Number.isFinite);
  if (!finite(p.from, 2) || !finite(p.to, 2) || !finite(p.elevation, 4)
    || ![p.half, p.shoulder, p.taper, p.cross].every(Number.isFinite)
    || p.half <= 0 || p.shoulder <= 0 || p.taper <= 0 || Math.abs(p.cross) > 0.08
    || 2 * p.taper >= Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1])) return null;
  return f as RoadProfileFile;
}

const smooth = (v: number) => v * v * (3 - 2 * v);

export function withRoadProfile(base: HeightAt, profile: RoadProfile | undefined, ref: number): HeightAt {
  if (!profile) return base;
  const { from: [x0, y0], to: [x1, y1], half, shoulder, taper, elevation: [a, b, c, d], cross } = profile;
  const length = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / length, uy = (y1 - y0) / length;
  const width = half + shoulder;
  return (x, y, side) => {
    // A requested water or terrace height always remains the original height.
    if (side) return base(x, y, side);
    const dx = x - x0, dy = y - y0, along = dx * ux + dy * uy, across = dy * ux - dx * uy;
    const reach = Math.min(along, length - along), room = width - Math.abs(across);
    if (reach <= 0 || room <= 0) return base(x, y, side);
    const w = smooth(Math.min(1, reach / taper)) * smooth(Math.min(1, room / shoulder));
    const u = along / length;
    const h = a + u * (b + u * (c + u * d)) + cross * across - ref;
    return w === 1 ? h : w * h + (1 - w) * base(x, y, side);
  };
}

export function roadProfileBounds({ from: [x0, y0], to: [x1, y1], half, shoulder }: RoadProfile): Bounds {
  const dx = x1 - x0, dy = y1 - y0, scale = (half + shoulder) / Math.hypot(dx, dy);
  const x = Math.abs(dy * scale), y = Math.abs(dx * scale);
  return [Math.min(x0, x1) - x, Math.min(y0, y1) - y, Math.max(x0, x1) + x, Math.max(y0, y1) + y];
}
