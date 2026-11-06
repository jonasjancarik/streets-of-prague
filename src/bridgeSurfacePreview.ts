import type { Point2, Polygons } from './map/geo.ts';
import type { TileJSON } from './contracts.ts';
import { readRoadSurfaces } from './roadSurfaces.ts';

export interface BridgeSurfacePreview {
  version: number;
  area: string;
  built: string;
  decks: Record<string, Record<string, Polygons>>;
  tracks: Record<string, { level: number; pts: Point2[] }[]>;
  ground?: unknown[];
}

export function readBridgeSurfacePreview(value: unknown, area: string, built?: string) {
  if (!value || typeof value !== 'object' || !built) return null;
  const f = value as BridgeSurfacePreview;
  if (f.version !== 1 || f.area !== area || f.built !== built || !record(f.decks) || !record(f.tracks)) return null;
  const line = (a: unknown, min: number) => Array.isArray(a) && a.length >= min
    && a.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
  const tile = (k: string) => /^\d+_\d+$/.test(k);
  for (const [key, levels] of Object.entries(f.decks)) {
    if (!tile(key) || !record(levels)) return null;
    for (const [level, polys] of Object.entries(levels)) {
      if (!/^[1-9]\d*$/.test(level) || !Array.isArray(polys) || !polys.length
          || polys.some(p => !Array.isArray(p) || !p.length || p.some(r => !line(r, 3)))) return null;
    }
  }
  for (const [key, tracks] of Object.entries(f.tracks)) {
    if (!tile(key) || !Array.isArray(tracks) || tracks.some(t => !t || !Number.isInteger(t.level) || t.level <= 0 || !line(t.pts, 2))) return null;
  }
  const ground = readRoadSurfaces({ version: 1, area, built, patches: f.ground ?? [] }, area, built);
  return ground ? { decks: f.decks, tracks: f.tracks, ground } : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function bridgeSurfaceTile(t: TileJSON, key: string, preview: ReturnType<typeof readBridgeSurfacePreview>) {
  const decks = preview?.decks[key], tracks = preview?.tracks[key];
  if (!decks && !tracks) return t;
  return { ...t, bridgeTracks: tracks, structures: t.structures?.map(s =>
    decks?.[s.level] ? { ...s, polys: decks[s.level] } : s) };
}
