// Cut the opening that the walking grid already leaves through a building.
// Clip a wall triangle against a short section of the mapped passage, preserving
// the triangle's own façade coordinates, normals and colours on the cut edges.
import type { BuildingArrays, TilePassage } from '../contracts.ts';
import { onPolygons } from './geo.ts';
import type { Bounds, Point2 } from './geo.ts';

type Height = (x: number, y: number) => number;
// A covered walkway (pasáž) has a flat ceiling this high.
export const PASSAGE_HEAD = 3.25;
// A gateway for carts and cars (průjezd) is vaulted: its walls stand this high and
// its arch rises up to ARCH_RISE above them, less in a narrow one (a semicircle).
export const ARCH_SPRING = 2.9;
export const ARCH_RISE = 1.9;
const WALKS = ['footway', 'pedestrian', 'path', 'steps'];
export type PassageKind = 'walk' | 'drive';
// Tram tracks are left out: where they really run through a house, a road is mapped
// through it with them; elsewhere they only run close to the buildings' outlines.
function ownKind({ pts, w, hw }: TilePassage): PassageKind | null {
  if (pts.length < 2) return null;
  if (!hw || WALKS.includes(hw)) return w >= .8 && w <= 6 ? 'walk' : null;
  return hw !== 'tram' && w >= 2.4 && w <= 10 ? 'drive' : null;
}
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
  kind: PassageKind;
  // Wall height and the arch's rise above it (0 for a flat ceiling), and the crown.
  spring: number;
  rise: number;
  top: number;
}
export interface OpenPassage extends TilePassage { kind: PassageKind }
export function passageKind(p: TilePassage): PassageKind | null {
  return (p as Partial<OpenPassage>).kind ?? ownKind(p);
}
export function walkingPassage(p: TilePassage) {
  return passageKind(p) === 'walk';
}
export function archRise(half: number) {
  return Math.min(ARCH_RISE, half);
}
// The height of a gateway's vault (above its floor) at `across` metres from its axis.
export function vaultHeight(across: number, half: number) {
  const rise = archRise(half), u = Math.min(1, Math.abs(across) / half);
  return ARCH_SPRING + rise * Math.sqrt(1 - u * u);
}

function segDist(px: number, py: number, a: Point2, b: Point2) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(a[0] + dx * u - px, a[1] + dy * u - py);
}
function lineDist(px: number, py: number, pts: Point2[]) {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(px, py, pts[i - 1], pts[i]));
  return d;
}

// The passages to open and line, each as a walkway or a gateway, with their loose
// ends carried on to where the building ends. Mapped passages often stop short of
// the façade, and a tile's copy of one stops at the tile's edge although the house
// it runs through may belong to the neighbouring tile. A footway sharing a gateway
// (a pavement in the arch) is part of the gateway.
export const REACH = 8; // m a loose end is carried on at most to leave the building
export const REACH_EDGE = 25; // m from a tile's edge
export const PAVEMENT_GAP = 1.5; // m
export function reachPassages(paths: TilePassage[], houses: { rings: Point2[][] }[], box: Bounds): OpenPassage[] {
  const open = paths.map((p) => ({ ...p, kind: ownKind(p) })).filter((p): p is OpenPassage => !!p.kind);
  if (!open.length) return [];
  // Whether two strips overlap: points every metre along one, within both half widths of the other.
  const samples = (pts: Point2[]) => pts.flatMap((a, i) => {
    if (!i) return [a];
    const b = pts[i - 1], n = Math.max(1, Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1])));
    return Array.from({ length: n }, (_, k) => [b[0] + (a[0] - b[0]) * (k + 1) / n, b[1] + (a[1] - b[1]) * (k + 1) / n] as Point2);
  });
  // A pavement within PAVEMENT_GAP of a road's strip counts as beside it (two roads
  // must overlap: those either side of a pillar are two arches).
  const near = (a: TilePassage, b: TilePassage) => {
    const reach = (a.w + b.w) / 2 + (WALKS.includes(a.hw ?? '') !== WALKS.includes(b.hw ?? '') ? PAVEMENT_GAP : 0);
    return samples(a.pts).some((p) => lineDist(p[0], p[1], b.pts) < reach) ||
      samples(b.pts).some((p) => lineDist(p[0], p[1], a.pts) < reach);
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const p of open) {
      if (p.kind === 'walk' && open.some((q) => q.kind === 'drive' && near(p, q))) {
        p.kind = 'drive';
        changed = true;
      }
    }
  }
  // Strips side by side in one arch (a road and its pavement) become one wider
  // strip on a shared axis, so the arch and its vault span both.
  const heading = (pts: Point2[]) => {
    const a = pts[0], b = pts.at(-1)!, l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  // Grouped by the strips as mapped, so a widened strip never reaches the next arch.
  const group = open.map((_, i) => i);
  const root = (i: number): number => group[i] === i ? i : (group[i] = root(group[i]));
  open.forEach((a, i) => open.forEach((b, j) => {
    if (j <= i || a.kind !== 'drive' || b.kind !== 'drive' || !near(a, b)) return;
    const [ax, ay] = heading(a.pts), [bx, by] = heading(b.pts);
    if (Math.abs(ax * bx + ay * by) >= .92) group[root(j)] = root(i);
  }));
  const length = (p: TilePassage) => p.pts.slice(1).reduce((l, q, i) => l + Math.hypot(q[0] - p.pts[i][0], q[1] - p.pts[i][1]), 0);
  for (let i = 0; i < open.length; i++) {
    const members = open.filter((_, j) => root(j) === i);
    if (members.length < 2) continue;
    // Across the widest road among them (a footway only widens it).
    const ref = members.reduce((r, p) => (WALKS.includes(p.hw ?? '') ? 0 : p.w * 100) + length(p) > (WALKS.includes(r.hw ?? '') ? 0 : r.w * 100) + length(r) ? p : r);
    const [ax, ay] = heading(ref.pts), nx = -ay, ny = ax;
    // How far each point of theirs lies to the side of its line (the strips are
    // often drawn askew, and a tile has only its own pieces of them).
    const offset = ([mx, my]: Point2) => {
      let best = Infinity, o = 0;
      for (let j = 1; j < ref.pts.length; j++) {
        const d = segDist(mx, my, ref.pts[j - 1], ref.pts[j]);
        if (d < best) [best, o] = [d, (mx - ref.pts[j - 1][0]) * nx + (my - ref.pts[j - 1][1]) * ny];
      }
      return o;
    };
    const sides = members.flatMap((p) => samples(p.pts).map((q) => [offset(q) - p.w / 2, offset(q) + p.w / 2]));
    const lo = Math.min(...sides.map((v) => v[0])), hi = Math.max(...sides.map((v) => v[1]));
    // One strip on the widest road's line, as long as all of them together.
    const c = (lo + hi) / 2, [x0, y0] = ref.pts[0], [xn, yn] = ref.pts.at(-1)!;
    const along = members.flatMap((p) => p.pts.map(([x, y]) => (x - x0) * ax + (y - y0) * ay));
    const total = (xn - x0) * ax + (yn - y0) * ay;
    const pts = ref.pts.slice();
    if (Math.min(...along) < 0) pts[0] = [x0 + ax * Math.min(...along), y0 + ay * Math.min(...along)];
    if (Math.max(...along) > total) pts[pts.length - 1] = [x0 + ax * Math.max(...along), y0 + ay * Math.max(...along)];
    ref.pts = pts.map(([x, y]) => [x + nx * c, y + ny * c]);
    ref.w = Math.round((hi - lo) * 100) / 100;
    for (const p of members) if (p !== ref) p.pts = [];
  }
  const merged = open.filter((p) => p.pts.length > 1);
  const inside = onPolygons(houses.map((b) => b.rings).filter((r) => r[0]?.length >= 3));
  const [x0, y0, x1, y1] = box;
  return merged.map((p) => {
    const pts = p.pts.slice();
    const half = Math.max(.3, p.w / 2 - .1);
    for (const end of [0, 1]) {
      const at = end ? pts.length - 1 : 0, from = end ? pts.length - 2 : 1;
      const [ex, ey] = pts[at], len = Math.hypot(ex - pts[from][0], ey - pts[from][1]);
      if (len < .05) continue;
      // A junction with another of the passages stays where it is.
      if (merged.some((q) => q !== p && lineDist(ex, ey, q.pts) < .3)) continue;
      const dx = (ex - pts[from][0]) / len, dy = (ey - pts[from][1]) / len;
      const edge = Math.min(Math.abs(ex - x0), Math.abs(ex - x1), Math.abs(ey - y0), Math.abs(ey - y1)) < .05;
      const covered = (s: number) =>
        [-half, 0, half].some((o) => inside(ex + dx * s - dy * o, ey + dy * s + dx * o));
      if (!covered(0) && !covered(.3)) continue;
      const cap = edge ? REACH_EDGE : REACH;
      let s = .25;
      while (s <= cap && covered(s)) s += .25;
      if (s > cap) continue;
      pts[at] = [ex + dx * s, ey + dy * s];
    }
    return { ...p, pts };
  });
}

export function passageSections(paths: TilePassage[], height: Height): PassageSection[] {
  const sections: PassageSection[] = [];
  for (const path of paths) {
    const kind = passageKind(path);
    if (!kind) continue;
    const { pts, w } = path;
    const half = w / 2 + .08;
    const rise = kind === 'drive' ? archRise(half) : 0, spring = kind === 'drive' ? ARCH_SPRING : PASSAGE_HEAD;
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
          kind,
          spring,
          rise,
          top: spring + rise,
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
// The arch as a polygon round its curve (scaled to a circle of the half width),
// a little outside it so the vault's edge never shows a sliver of the house.
const ARCH_PLANES = Array.from({ length: 11 }, (_, k) => {
  const a = (k - 5) * Math.PI / 12;
  return [Math.sin(a), Math.cos(a)] as const;
});
function subtract(poly: Polygon, s: PassageSection): Polygon[] {
  const along = (p: V) => (p[0] - s.ax) * s.dx + (p[1] - s.ay) * s.dy;
  const across = (p: V) => (p[1] - s.ay) * s.dx - (p[0] - s.ax) * s.dy;
  const planes = [
    (p: V) => along(p) - s.start,
    (p: V) => s.end - along(p),
    (p: V) => s.half - across(p),
    (p: V) => s.half + across(p),
    (p: V) => p[2] - s.h - s.slope * along(p) + .7,
    ...(s.rise ? ARCH_PLANES.map(([sin, cos]) =>
      (p: V) => s.half - across(p) * sin - (p[2] - s.h - s.slope * along(p) - s.spring) * s.half / s.rise * cos
    ) : [(p: V) => s.h + s.slope * along(p) + s.spring - p[2]]),
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
  // Where the walls cross each passage's axis, the façade as built (x, y and the
  // wall's normal in plan), for the lining to end there (passageLining.ts).
  const hits: number[] = [];
  function facadeHit(s: PassageSection, tri: V[], t: number) {
    let nx = a.normal[t * 9], ny = -a.normal[t * 9 + 2];
    const l = Math.hypot(nx, ny);
    if (l < .5) return;
    nx /= l;
    ny /= l;
    const cross = nx * s.dx + ny * s.dy;
    if (Math.abs(cross) < .34) return; // a wall along the passage, not across it
    const along = ((tri[0][0] - s.ax) * nx + (tri[0][1] - s.ay) * ny) / cross;
    if (along < s.start - .01 || along > s.end + .01) return;
    const x = s.ax + s.dx * along, y = s.ay + s.dy * along;
    const xs = tri.map((v) => v[0]), ys = tri.map((v) => v[1]);
    if (x < Math.min(...xs) - .15 || x > Math.max(...xs) + .15 || y < Math.min(...ys) - .15 || y > Math.max(...ys) + .15) return;
    for (let k = 0; k < hits.length; k += 4) if (Math.hypot(hits[k] - x, hits[k + 1] - y) < .1) return;
    hits.push(x, y, nx, ny);
  }
  const seen = new Int32Array(spans.length).fill(-1), candidates: number[] = [];
  const count = a.position.length / 9, edits = new Map<number, V[]>();
  const wallCount = a.parts ? a.parts.extras / 3 : count;
  for (let t = 0; t < wallCount; t++) {
    const o = t * 9;
    // Walls, and the sloping and flat bits reaching down into an opening (a
    // plinth's chamfer, the underside of a lintel): never roofs or eaves above it.
    const sloped = Math.abs(a.normal[o + 1]) > .18;
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
        low > s.h + Math.max(s.slope * s.start, s.slope * s.end) + s.top ||
        (sloped && low > s.h + Math.min(s.slope * s.start, s.slope * s.end) + s.spring - .1)
      ) continue;
      original ??= [0, 1, 2].map((k) => [p[o + 3 * k], -p[o + 3 * k + 2], p[o + 3 * k + 1], +(k === 1), +(k === 2)] as V);
      const before = pieces ?? [original];
      pieces = before.flatMap((poly) => subtract(poly, s));
      if (pieces.length !== 1 || pieces[0] !== before[0]) facadeHit(s, original, t);
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
    facades: Float32Array.from(hits),
  };
}
