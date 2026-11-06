import type { Point2, Polygons } from './map/geo.ts';
import type { TileJSON } from './contracts.ts';
import { readRoadSurfaces } from './roadSurfaces.ts';

type HeightNodes = [index: number, metres: number][];
interface RampApproach {
  pads: number[];
  ground: HeightNodes;
  decks: Record<string, HeightNodes>;
}

export interface BridgeSurfacePreview {
  version: number;
  area: string;
  built: string;
  decks: Record<string, Record<string, Polygons>>;
  tracks: Record<string, { level: number; pts: Point2[] }[]>;
  ground?: unknown[];
  approaches?: Record<string, RampApproach>;
  spans?: Record<string, [metres: number, level: number][]>;
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
  const nodes = (a: unknown) => Array.isArray(a) && a.every(p => Array.isArray(p) && p.length === 2
    && Number.isInteger(p[0]) && p[0] >= 0 && Number.isFinite(p[1]) && p[1] >= 100 && p[1] <= 700);
  if (f.approaches !== undefined && (!record(f.approaches) || Object.entries(f.approaches).some(([k, a]) =>
    !tile(k) || !a || !Array.isArray(a.pads) || a.pads.some(p => !Number.isInteger(p) || p < 2 || p > 255)
    || !nodes(a.ground) || !record(a.decks) || Object.entries(a.decks).some(([l, n]) => !/^[1-9]\d*$/.test(l) || !nodes(n))))) return null;
  if (f.spans !== undefined && (!record(f.spans) || Object.values(f.spans).some(s => !line(s, 2) || s[0][0] !== 0
      || s.some(([x, l], i) => !Number.isInteger(l) || l < 0 || (i > 0 && x <= s[i-1][0]))))) return null;
  const ground = readRoadSurfaces({ version: 1, area, built, patches: f.ground ?? [] }, area, built);
  return ground ? { decks: f.decks, tracks: f.tracks, ground, approaches: f.approaches, spans: f.spans } : null;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function bridgeSurfaceTile(t: TileJSON, key: string, preview: ReturnType<typeof readBridgeSurfacePreview>) {
  const decks = preview?.decks[key], tracks = preview?.tracks[key];
  const approach = preview?.approaches?.[key], spans = preview?.spans;
  const retag = (edge: NonNullable<TileJSON['drive']>[number]) => {
    const levels = spans?.[edge.id];
    return levels ? { ...edge, bridge: true, level: levels[0][1], levels } : edge;
  };
  const tagged = spans && (t.drive?.some(e => spans[e.id]) || t.walk?.some(e => spans[e.id]));
  if (!decks && !tracks && !approach && !tagged) return t;
  return {
    ...t,
    ...(tracks ? { bridgeTracks: tracks } : {}),
    structures: t.structures?.map(s => decks?.[s.level] ? { ...s, polys: decks[s.level] } : s),
    terraces: approach ? t.terraces?.filter(t => !approach.pads.includes(t.label)) : t.terraces,
    drive: tagged ? t.drive?.map(retag) : t.drive,
    walk: tagged ? t.walk?.map(retag) : t.walk,
  };
}

// The ground lattice used to include the flat approach pad. Restore the
// surveyed terrain beneath it, and fill the extended deck's height lattice.
export function bridgeSurfaceBuffers(t: TileJSON, key: string, n: number | undefined,
  height: ArrayBuffer | null, levels: ArrayBuffer | null, preview: ReturnType<typeof readBridgeSurfacePreview>) {
  const a = preview?.approaches?.[key];
  if (!a || !n) return { height, levels };
  const size = n*n;
  if (height && height.byteLength === size*3 && a.ground.length) {
    height = height.slice(0);
    const values = new Uint16Array(height, 0, size), labels = new Uint8Array(height, size*2, size);
    for (const [index, z] of a.ground) if (index < size && a.pads.includes(labels[index])) {
      values[index] = Math.round((z-100)*10);
      labels[index] = 0;
    }
  }
  if (levels && levels.byteLength === size*(t.structures?.length ?? 0)*2) {
    levels = levels.slice(0);
    const values = new Uint16Array(levels);
    t.structures?.forEach((s, i) => {
      for (const [index, z] of a.decks[s.level] ?? []) if (index < size)
        values[i*size+index] = Math.round((z-100)*100);
    });
  }
  return { height, levels };
}
