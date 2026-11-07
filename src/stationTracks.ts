import type { Point2, Polygons } from './map/geo.ts';

export interface StationTracks {
  rails: Point2[][];
  platforms: Polygons;
  platformEdges: Point2[][];
  bridgeTracks: { level: number; pts: Point2[] }[];
}

export function readStationTracks(value: unknown, area: string, built?: string): Record<string, StationTracks> | null {
  if (!value || typeof value !== 'object' || !built) return null;
  const f = value as { version?: number; area?: string; built?: string; tiles?: Record<string, StationTracks> };
  if (f.version !== 1 || f.area !== area || f.built !== built || !f.tiles || typeof f.tiles !== 'object' || Array.isArray(f.tiles)) return null;
  const lines = (v: unknown, min = 2) => Array.isArray(v) && v.every(line => Array.isArray(line)
    && line.length >= min && line.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));
  for (const [key, tile] of Object.entries(f.tiles)) {
    if (!/^\d+_\d+$/.test(key) || !tile || !lines(tile.rails) || !lines(tile.platformEdges)
        || !Array.isArray(tile.bridgeTracks) || tile.bridgeTracks.some(t => !t || !Number.isInteger(t.level) || t.level <= 0 || !lines([t.pts]))
        || !Array.isArray(tile.platforms) || tile.platforms.some(poly => !poly.length || !lines(poly, 3))) return null;
  }
  return f.tiles;
}
