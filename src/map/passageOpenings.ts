// Cut the opening that the walking grid already leaves through a building.
// Clip a wall triangle against a short section of the mapped passage, preserving
// the triangle's own façade coordinates, normals and colours on the cut edges.
import type { BuildingArrays, TilePassage } from '../contracts.ts';
import type { Point2 } from './geo.ts';

type Height = (x: number, y: number) => number;
export const PASSAGE_HEAD = 3.25;
export interface PassageSection {
  ax: number;
  ay: number;
  dx: number;
  dy: number;
  length: number;
  half: number;
  start: number;
  end: number;
  h: number;
  slope: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
export function walkingPassage({ pts, w, hw }: TilePassage) {
  return pts.length >= 2 && w >= 1.2 && w <= 6 && (!hw || ['footway', 'pedestrian', 'path', 'steps'].includes(hw));
}
export function passageSections(paths: TilePassage[], height: Height): PassageSection[] {
  const sections: PassageSection[] = [];
  for (const path of paths) {
    if (!walkingPassage(path)) continue;
    const { pts, w } = path;
    const half = w / 2 + .08;
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (dist < .03) continue;
      const dx = (b[0] - a[0]) / dist, dy = (b[1] - a[1]) / dist;
      const count = Math.ceil(dist / 6), length = dist / count;
      for (let j = 0; j < count; j++) {
        const ax = a[0] + dx * length * j, ay = a[1] + dy * length * j;
        const bx = ax + dx * length, by = ay + dy * length, h = height(ax, ay);
        const start = j === 0 ? -half : 0, end = j === count - 1 ? length + half : length;
        const pad = half * 1.5;
        sections.push({
          ax,
          ay,
          dx,
          dy,
          length,
          half,
          start,
          end,
          h,
          slope: (height(bx, by) - h) / length,
          minX: Math.min(ax, bx) - pad,
          maxX: Math.max(ax, bx) + pad,
          minY: Math.min(ay, by) - pad,
          maxY: Math.max(ay, by) + pad,
        });
      }
    }
  }
  return sections;
}
// One joined outline per surveyed polyline, with square ends like the walking
// grid. Millimetre rounding avoids almost-coincident edges in the polygon union.
export function passageOutline(path: TilePassage): Point2[][] {
  const pts = path.pts.filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > .01);
  if (pts.length < 2) return [];
  const half = path.w / 2 + .08;
  const directions = pts.slice(1).map(([x, y], i) => {
    const dx = x - pts[i][0], dy = y - pts[i][1], length = Math.hypot(dx, dy);
    return [dx / length, dy / length] as Point2;
  });
  const left: Point2[] = [], right: Point2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = directions[Math.max(0, i - 1)], next = directions[Math.min(i, directions.length - 1)];
    const k = half / Math.max(.35, 1 + prev[0] * next[0] + prev[1] * next[1]);
    const nx = -(prev[1] + next[1]) * k, ny = (prev[0] + next[0]) * k;
    const end = i === 0 ? -half : i === pts.length - 1 ? half : 0;
    const x = pts[i][0] + next[0] * end, y = pts[i][1] + next[1] * end;
    const mm = (v: number) => Math.round(v * 1000) / 1000;
    left.push([mm(x + nx), mm(y + ny)]);
    right.push([mm(x - nx), mm(y - ny)]);
  }
  return [[...left, ...right.reverse()]];
}

// x, map y, altitude, and two weights on the original triangle.
type V = [number, number, number, number, number];
type Polygon = V[];
function subtract(poly: Polygon, s: PassageSection): Polygon[] {
  const along = (p: V) => (p[0] - s.ax) * s.dx + (p[1] - s.ay) * s.dy;
  const across = (p: V) => (p[1] - s.ay) * s.dx - (p[0] - s.ax) * s.dy;
  const planes = [
    (p: V) => along(p) - s.start,
    (p: V) => s.end - along(p),
    (p: V) => s.half - across(p),
    (p: V) => s.half + across(p),
    (p: V) => s.h + s.slope * along(p) + PASSAGE_HEAD - p[2],
    (p: V) => p[2] - s.h - s.slope * along(p) + .7,
  ];
  let inside = poly;
  const scraps: Polygon[] = [];
  for (const plane of planes) {
    const d = inside.map(plane);
    if (Math.max(...d) < .00001) return [poly];
    if (Math.min(...d) >= -.00001) continue;
    const next: Polygon = [], outside: Polygon = [];
    for (let i = 0; i < inside.length; i++) {
      const j = (i + 1) % inside.length, a = inside[i], b = inside[j];
      if (d[i] >= 0) next.push(a);
      else outside.push(a);
      if ((d[i] >= 0) === (d[j] >= 0)) continue;
      const t = d[i] / (d[i] - d[j]), cut = a.map((v, k) => v + t * (b[k] - v)) as V;
      next.push(cut);
      outside.push(cut);
    }
    if (outside.length >= 3) scraps.push(outside);
    inside = next;
  }
  return scraps;
}

export function openPassages(a: BuildingArrays, paths: TilePassage[] | undefined, height: Height): BuildingArrays {
  if (!paths?.length) return a;
  const spans = passageSections(paths, height);
  if (!spans.length) return a;
  // Only the few wall triangles beside a mapped path need clipping. A tile can
  // contain a large building complex with thousands of unrelated wall triangles.
  const bucketSize = 12, buckets = new Map<number, number[]>();
  spans.forEach((s, i) => {
    for (let x = Math.floor(s.minX / bucketSize); x <= Math.floor(s.maxX / bucketSize); x++) {
      for (let y = Math.floor(s.minY / bucketSize); y <= Math.floor(s.maxY / bucketSize); y++) {
        const key = x * 65536 + y, list = buckets.get(key);
        if (list) list.push(i);
        else buckets.set(key, [i]);
      }
    }
  });
  const seen = new Int32Array(spans.length).fill(-1), candidates: number[] = [];
  const count = a.position.length / 9, edits = new Map<number, V[]>();
  const wallCount = a.parts ? a.parts.extras / 3 : count;
  for (let t = 0; t < wallCount; t++) {
    const o = t * 9;
    if (Math.abs(a.normal[o + 1]) > .18) continue;
    const p = a.position;
    const x0 = Math.min(p[o], p[o + 3], p[o + 6]), x1 = Math.max(p[o], p[o + 3], p[o + 6]);
    const y0 = -Math.max(p[o + 2], p[o + 5], p[o + 8]), y1 = -Math.min(p[o + 2], p[o + 5], p[o + 8]);
    const low = Math.min(p[o + 1], p[o + 4], p[o + 7]);
    let pieces: Polygon[] | undefined, original: Polygon | undefined;
    candidates.length = 0;
    for (let x = Math.floor(x0 / bucketSize); x <= Math.floor(x1 / bucketSize); x++) {
      for (let y = Math.floor(y0 / bucketSize); y <= Math.floor(y1 / bucketSize); y++) {
        const list = buckets.get(x * 65536 + y);
        if (list) {
          for (const id of list) {
            if (seen[id] !== t) {
              seen[id] = t;
              candidates.push(id);
            }
          }
        }
      }
    }
    for (const id of candidates) {
      const s = spans[id];
      if (
        x0 > s.maxX || x1 < s.minX || y0 > s.maxY || y1 < s.minY ||
        low > s.h + Math.max(s.slope * s.start, s.slope * s.end) + PASSAGE_HEAD
      ) continue;
      original ??= [0, 1, 2].map((k) => [p[o + 3 * k], -p[o + 3 * k + 2], p[o + 3 * k + 1], +(k === 1), +(k === 2)] as V);
      pieces = (pieces ?? [original]).flatMap((poly) => subtract(poly, s));
    }
    if (!pieces || (pieces.length === 1 && pieces[0] === original)) continue;
    const vertices: V[] = [];
    for (const poly of pieces) {
      for (let j = 1; j < poly.length - 1; j++) {
        const [a, b, c] = [poly[0], poly[j], poly[j + 1]];
        if (Math.abs((b[3] - a[3]) * (c[4] - a[4]) - (b[4] - a[4]) * (c[3] - a[3])) > 1e-8) vertices.push(a, b, c);
      }
    }
    edits.set(t, vertices);
  }
  if (!edits.size) return a;
  const offsets = new Uint32Array(count + 1);
  for (let t = 0; t < count; t++) offsets[t + 1] = offsets[t] + (edits.get(t)?.length ?? 3) / 3;
  function remap(src: Float32Array, width: number) {
    const out = new Float32Array(offsets[count] * 3 * width);
    let last = 0, i = 0;
    for (const [t, replacements] of edits) {
      const at = t * 3 * width;
      out.set(src.subarray(last, at), i);
      i += at - last;
      for (const v of replacements) {
        for (let j = 0; j < width; j++) {
          const a = src[at + j], b = src[at + width + j], c = src[at + 2 * width + j];
          out[i++] = a + v[3] * (b - a) + v[4] * (c - a);
        }
      }
      last = at + 3 * width;
    }
    out.set(src.subarray(last), i);
    return out;
  }
  const groups: number[] = [], old = a.streetWalls;
  if (old) {
    for (let k = 0; k < old.length;) {
      const end = k + 1 + old[k], mark = groups.length;
      groups.push(0);
      for (k++; k < end; k++) for (let t = offsets[old[k]]; t < offsets[old[k] + 1]; t++) groups.push(t);
      groups[mark] = groups.length - mark - 1;
      if (!groups[mark]) groups.pop();
    }
  }
  return {
    ...a,
    position: remap(a.position, 3),
    color: remap(a.color, 3),
    normal: remap(a.normal, 3),
    facade: remap(a.facade, 4),
    drapeUv: a.drapeUv && remap(a.drapeUv, 2),
    streetWalls: old && Uint32Array.from(groups),
    parts: a.parts && { extras: offsets[a.parts.extras / 3] * 3, clutter: offsets[a.parts.clutter / 3] * 3 },
  };
}
