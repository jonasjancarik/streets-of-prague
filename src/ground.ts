import * as THREE from 'three';
import { signedArea } from './map/geo.ts';
import { offsetLine } from './network.ts';
import type { Point2, Bounds, Polygons } from './map/geo.ts';
import type { GroundLayer } from './surface.ts';

export interface GroundTileData {
  areas: Record<string, Polygons | undefined>;
  roads: Record<string, Polygons | undefined>;
  rails: { kind: string; pts: Point2[] }[];
  weirs?: Point2[][];
  crossings?: Point2[][];
}
export interface LevelMask { level: number; w: number; h: number; cells: Uint8Array; box: Bounds }
export interface GroundResult { layers: GroundLayer[]; masks: LevelMask[] }
export interface GroundRoadEdge {
  u: string; v: string; hw: string; pts: Point2[]; width: number;
  lanes?: number | null; oneway?: boolean; bridge?: boolean; tunnel?: boolean; surface?: string;
}
type HeightAt = (x: number, y: number) => number;
// A bridge or tunnel level of the tile, with its height at a point (NaN off it).
export interface GroundLevel { level: number; kind: 'bridge' | 'tunnel'; polys: Polygons; height: HeightAt }
type GroundGeometry = GroundLayer['geometry'];

// The present-day ground as real geometry: one mesh per surface kind, triangulated
// from OSM polygons, coloured by procedural shaders (shading.ts). Paint, rails and
// kerb lines are thin strips on top. Layers are drawn in a fixed order with no depth
// writes, so they never z-fight however far the camera pulls back.
//
// This part only works out the geometry, as plain arrays, so it runs in the tile
// workers (tileWorker.ts); surface.ts makes the meshes.

export const COLORS = {
  pavement: '#c6c0b4', square: '#cbc4b6', path: '#d0cabe', dirt: '#bfa87e',
  park: '#86a85a', garden: '#8dab5e', wood: '#587a40', orchard: '#95ad64', pitch: '#6c9c55',
  water: '#4d7680', asphalt: '#5c5f63', sett: '#8a847a', parking: '#666a6e',
  bridge: '#62656a', trackbed: '#8a8a85', steel: '#3a3b3d', paint: '#efede4',
  quay: '#7c776c', funicular: '#6e6a62', slab: '#8e8b84', tunnel: '#46484c', tunnelWall: '#a59f93',
};
const ZONE = { RES: '#3d7be0', MIX: '#9b59d0', VIS: '#e8962c' };

function polygons(polys: Polygons): GroundGeometry {
  const pos: number[] = [], idx: number[] = [];
  for (const rings of polys) {
    const contour = rings[0].map(([x, y]) => new THREE.Vector2(x, y));
    const holes = rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
    const base = pos.length / 3;
    for (const v of [contour, ...holes].flat()) pos.push(v.x, 0, -v.y);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) idx.push(base + a, base + b, base + c);
  }
  return finish(pos, idx);
}

// Quads along polylines, `w` metres wide. `dash` = [on, off] in metres for dashed lines.
function strips(lines: Point2[][], w: number, dash: Point2 | null = null): GroundGeometry {
  const pos: number[] = [], idx: number[] = [];
  const quad = (a: Point2, b: Point2) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = ((b[1] - a[1]) / len) * w / 2, ny = (-(b[0] - a[0]) / len) * w / 2;
    const i = pos.length / 3;
    pos.push(a[0] + nx, 0, -(a[1] + ny), a[0] - nx, 0, -(a[1] - ny), b[0] - nx, 0, -(b[1] - ny), b[0] + nx, 0, -(b[1] + ny));
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  for (const pts of lines) {
    if (!dash) {
      // Extend each segment by half the width so joints overlap instead of gapping.
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ex = ((b[0] - a[0]) / len) * w * 0.5, ey = ((b[1] - a[1]) / len) * w * 0.5;
        quad(i ? [a[0] - ex, a[1] - ey] : a, i < pts.length - 2 ? [b[0] + ex, b[1] + ey] : b);
      }
      continue;
    }
    const [on, off] = dash;
    let s = 0, drawing = true, left = on;
    for (let i = 0; i < pts.length - 1; i++) {
      let a = pts[i];
      const b = pts[i + 1];
      let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (seg > 1e-6) {
        const step = Math.min(seg, left);
        const t = step / seg;
        const c: Point2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (drawing) quad(a, c);
        a = c;
        seg -= step;
        left -= step;
        s += step;
        if (left <= 1e-6) { drawing = !drawing; left = drawing ? on : off; }
      }
    }
  }
  return finish(pos, idx);
}

// A soft band just outside each ring, fading from `alpha` at the ring to 0.
function skirts(ringsList: Polygons, width: number, outside: boolean, skip: (a: Point2, b: Point2) => boolean = () => false): GroundGeometry {
  const pos: number[] = [], alpha: number[] = [], idx: number[] = [];
  for (const rings of ringsList) {
    rings.forEach((ring, k) => {
      const ccw = signedArea(ring) > 0;
      // Outer rings fade outwards, holes (courtyards) fade into the hole.
      const d = (k === 0) === ccw ? width : -width;
      const closed = [...ring, ring[0], ring[1]];
      const off = offsetLine(closed, outside ? d : -d).slice(1, -1);
      const inner = closed.slice(1, -1);
      const n = inner.length;
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        pos.push(inner[i][0], 0, -inner[i][1], off[i][0], 0, -off[i][1]);
        alpha.push(1, 0);
      }
      for (let i = 0; i < n; i++) {
        if (skip(inner[i], inner[(i + 1) % n])) continue;
        const a = base + i * 2, b = base + ((i + 1) % n) * 2;
        idx.push(a, a + 1, b + 1, a, b + 1, b);
      }
    });
  }
  return finish(pos, idx, alpha);
}

// Split every edge longer than `max` metres (in halves, repeatedly) so a flat mesh can
// follow the terrain. The decision is per edge, so neighbours split the same edges and
// no cracks open between them. `extra`: an optional per-vertex value to interpolate.
function subdivide(pos: number[], idx: number[], extra: number[] | null, max: number) {
  const max2 = max * max;
  for (let pass = 0; pass < 12; pass++) {
    const mids = new Map<number, number>();
    const long = (i: number, j: number) => {
      const dx = pos[i * 3] - pos[j * 3], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
      return dx * dx + dz * dz > max2;
    };
    const mid = (i: number, j: number) => {
      const k = i < j ? i * 4194304 + j : j * 4194304 + i;
      let m = mids.get(k);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push((pos[i * 3] + pos[j * 3]) / 2, 0, (pos[i * 3 + 2] + pos[j * 3 + 2]) / 2);
        if (extra) extra.push((extra[i] + extra[j]) / 2);
        mids.set(k, m);
      }
      return m;
    };
    const out: number[] = [];
    let split = false;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const s0 = long(a, b), s1 = long(b, c), s2 = long(c, a);
      if (!s0 && !s1 && !s2) { out.push(a, b, c); continue; }
      split = true;
      const m0 = s0 ? mid(a, b) : -1, m1 = s1 ? mid(b, c) : -1, m2 = s2 ? mid(c, a) : -1;
      if (s0 && s1 && s2) out.push(a, m0, m2, m0, b, m1, m2, m1, c, m0, m1, m2);
      else if (s0 && s1) out.push(m0, b, m1, a, m0, m1, a, m1, c);
      else if (s1 && s2) out.push(m1, c, m2, a, b, m1, a, m1, m2);
      else if (s0 && s2) out.push(a, m0, m2, m0, b, c, m0, c, m2);
      else if (s0) out.push(a, m0, c, m0, b, c);
      else if (s1) out.push(a, b, m1, a, m1, c);
      else out.push(a, b, m2, m2, b, c);
    }
    idx = out;
    if (!split) break;
  }
  return idx;
}

// Set while a Surfaces is being built: terrain height (m) at a point, or null for flat.
let groundHeight: HeightAt | null = null;

function finish(pos: number[], idx: number[], extra: number[] | null = null): GroundGeometry {
  // Wind every triangle to face up, so lighting never sees a back face.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const up = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    if (up < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
  if (groundHeight) {
    idx = subdivide(pos, idx, extra, 8);
    for (let i = 0; i < pos.length; i += 3) pos[i + 1] = groundHeight(pos[i], -pos[i + 2]);
  }
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  return { position: new Float32Array(pos), normal: nor, index: new Uint32Array(idx), ...(extra ? { alpha: new Float32Array(extra) } : {}) };
}

// Every ground layer of a tile, in drawing order: { order, geometry, color, pattern }
// for a surface ("blend": drawn see-through, like the bridges' shadows) and
// { order, geometry, shade } for the soft shading at shores and round buildings.
// `d`: the tile's areas, roads, rails, weirs and crossings; `box`: its extent;
// `edges`: car network edges for the centre lines (already clipped to the tile);
// `buildings`: the ones to shade round; `parkingZones`: the paid-parking category
// of each parking area (or null); `height`: terrain height at a point, or null.
//
// With `levels` (the tile's bridges and tunnels, pipeline/structures.py), the ground
// stays bare under the bridges and over the tunnels, and each level comes on its own:
// - a bridge level as a slab ({ ..., slab: true }, with its edges and parapets) and
//   what's on it ({ ..., deck: true }: its surface, tram tracks, road paint);
// - a tunnel level as its floor, walls and road paint ({ ..., tunnel: true }), under
//   the ground, where the game only shows it round you when you're in it.
// Each such layer has its `level`, and the game draws what's on it only where that
// level's mask (in `masks`: the level rasterised, rows from the north) says it is.
export function groundLayers(d: GroundTileData, { box, edges = [], buildings = [], parkingZones = [], height = null, levels = null }: {
  box: Bounds; edges?: GroundRoadEdge[]; buildings?: { rings: Point2[][] }[];
  parkingZones?: (string | null)[]; height?: HeightAt | null; levels?: GroundLevel[] | null;
}): GroundResult {
  if (!levels) {
    groundHeight = height;
    try { return { layers: layers(d, { box, edges, buildings, parkingZones }), masks: [] }; } finally { groundHeight = null; }
  }
  const T = height || (() => 0);
  groundHeight = height;
  let lower;
  try { lower = layers(d, { box, edges: edges.filter((e) => !e.bridge && !e.tunnel), buildings, parkingZones, bridges: false }); } finally { groundHeight = null; }
  const masks = levels.map((l) => levelMask(box, l.polys, l.level));
  const on = (k: number, x: number, y: number) => onMask(masks[k], x, y);
  // Each street on a bridge or in a tunnel is painted on one level: the one most of it
  // lies on (not a flyover it passes under); each stretch of tram track on the lowest
  // bridge it's on.
  const paintOn = new Map<number, GroundRoadEdge[]>();
  for (const e of edges) {
    if (!e.bridge && !e.tunnel) continue;
    const k = mostlyOn(e.pts, (x, y) => levels.map((l, i) => (l.kind === (e.bridge ? 'bridge' : 'tunnel') && on(i, x, y) ? i : -1)).filter((i) => i >= 0));
    if (k >= 0) paintOn.set(k, [...(paintOn.get(k) || []), e]);
  }
  const trams = d.rails.filter((r) => r.kind === 'tram').map((r) => r.pts);
  const tramsOn = splitByLevel(trams, (x, y) => {
    let best = -1;
    levels.forEach((l, i) => { if (l.kind === 'bridge' && on(i, x, y) && (best < 0 || l.level < levels[best].level)) best = i; });
    return best;
  });
  const upper: GroundLayer[] = [];
  try {
    levels.forEach((l, k) => {
      const H = (x: number, y: number) => { const h = l.height(x, y); return Number.isNaN(h) ? T(x, y) : h; };
      if (l.kind === 'bridge') {
        groundHeight = H;
        upper.push(...deckSlab(l.polys, box, masks[k], H, T, l.level));
        // What's on the deck floats a hand's breadth above the slab: they're
        // triangulated differently, so they'd cut into each other.
        groundHeight = (x: number, y: number) => H(x, y) + 0.12;
        upper.push(...deckLayers(l.polys, tramsOn.get(k) || [], paintOn.get(k) || [], l.level));
      } else {
        groundHeight = H;
        upper.push(...tunnelLayers(l.polys, box, masks[k], H, T, paintOn.get(k) || [], l.level));
      }
    });
  } finally { groundHeight = null; }
  return { layers: [...lower, ...upper], masks };
}

// The typed arrays in a tile's ground, to hand them over from a worker without copying.
export const layerBuffers = ({ layers, masks }: GroundResult): ArrayBuffer[] => {
  const buffers = [...layers.flatMap((l) => Object.values(l.geometry).map((a) => a.buffer)), ...masks.map((m) => m.cells.buffer)];
  if (buffers.some((buffer) => !(buffer instanceof ArrayBuffer))) throw new Error('Ground transfer requires ArrayBuffer storage');
  return buffers as ArrayBuffer[];
};

export const DECK_RES = 2; // level mask cells per metre

// A level rasterised: 255 where it is, 0 elsewhere, rows from the north.
function levelMask([x0, y0, x1, y1]: Bounds, polys: Polygons, level: number): LevelMask {
  const w = Math.ceil((x1 - x0) * DECK_RES), h = Math.ceil((y1 - y0) * DECK_RES);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Cannot create level mask canvas');
  ctx.fillStyle = '#fff';
  for (const rings of polys) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo']((x - x0) * DECK_RES, (y1 - y) * DECK_RES));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const img = ctx.getImageData(0, 0, w, h).data, cells = new Uint8Array(w * h);
  for (let i = 0; i < cells.length; i++) cells[i] = img[i * 4] > 127 ? 255 : 0;
  return { level, w, h, cells, box: [x0, y0, x1, y1] };
}

const onMask = (mask: LevelMask, x: number, y: number) => {
  const [x0, , , y1] = mask.box;
  const i = Math.floor((x - x0) * DECK_RES), j = Math.floor((y1 - y) * DECK_RES);
  return i >= 0 && j >= 0 && i < mask.w && j < mask.h && mask.cells[j * mask.w + i] > 0;
};

// Points every 3 m along a line.
function along(pts: Point2[], step = 3): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 0; s < n; s++) out.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
  }
  return out;
}

// Which of the levels `at(x, y)` lists a line mostly lies on (-1: none).
function mostlyOn(pts: Point2[], at: (x: number, y: number) => number[]) {
  const count = new Map<number, number>();
  for (const [x, y] of along(pts)) for (const k of at(x, y)) count.set(k, (count.get(k) || 0) + 1);
  let best = -1, most = 0;
  for (const [k, n] of count) if (n > most) { best = k; most = n; }
  return best;
}

// Lines cut into the stretches on each level (`level(x, y)`: -1 for none).
function splitByLevel(lines: Point2[][], level: (x: number, y: number) => number) {
  const out = new Map<number, Point2[][]>();
  for (const pts of lines) {
    let cur: Point2[] | null = null, curK = -1;
    const ps = [...along(pts, 4), pts[pts.length - 1]];
    for (let i = 0; i < ps.length - 1; i++) {
      const a = ps[i], b = ps[i + 1], k = level((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (k !== curK) {
        if (cur && curK >= 0) out.set(curK, [...(out.get(curK) || []), cur]);
        cur = k >= 0 ? [a] : null;
        curK = k;
      }
      cur?.push(b);
    }
    if (cur && curK >= 0) out.set(curK, [...(out.get(curK) || []), cur]);
  }
  return out;
}

const FASCIA = 1.2; // m: the deck's edge below its surface
const PARAPET = 1.0; // m: the parapet above it
const PARAPET_W = 0.35;
const TUNNEL_H = 5.5; // m: a tunnel's walls

// Along every open side of a level's outline (not where it meets the ground or
// carries on as another part of the level, nor along the tile's border, where it
// carries on in the next tile), `wall(a, b, ha, hb, out)` with the side's ends, their
// heights and the way out of the level.
function openSides(polys: Polygons, [x0, y0, x1, y1]: Bounds, mask: LevelMask, H: HeightAt, T: HeightAt,
  wall: (a: Point2, b: Point2, ha: number, hb: number, ox: number, oy: number) => void) {
  const cut = (a: Point2, b: Point2) => ([[0, x0], [0, x1], [1, y0], [1, y1]] as [0 | 1, number][]).some(([k, v]) => Math.abs(a[k] - v) < 0.05 && Math.abs(b[k] - v) < 0.05);
  for (const rings of polys) {
    for (const ring of rings) {
      for (let r = 0; r < ring.length; r++) {
        const p = ring[r], q = ring[(r + 1) % ring.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 0.05 || cut(p, q)) continue;
        const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
        const n = Math.ceil(len / 3);
        for (let s = 0; s < n; s++) {
          const a: Point2 = [p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n];
          const b: Point2 = [p[0] + ((q[0] - p[0]) * (s + 1)) / n, p[1] + ((q[1] - p[1]) * (s + 1)) / n];
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          // Which side is off the level; neither or both: not an open side.
          const left = onMask(mask, mx - uy * 0.8, my + ux * 0.8), right = onMask(mask, mx + uy * 0.8, my - ux * 0.8);
          if (left === right) continue;
          // Where the level runs at the height of the ground there's no side to see.
          if (Math.abs(H(mx, my) - T(mx, my)) < 1.2) continue;
          wall(a, b, H(a[0], a[1]), H(b[0], b[1]), left ? uy : -uy, left ? -ux : ux);
        }
      }
    }
  }
}

function quads() {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  return {
    pos, nor, idx,
    quad(a: number[], b: number[], c: number[], d: number[], n: number[]) {
      const i = pos.length / 3;
      pos.push(...a, ...b, ...c, ...d);
      for (let k = 0; k < 4; k++) nor.push(...n);
      idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    },
  };
}

// A surface (draped by finish) and walls in one geometry.
function joined(top: GroundGeometry, q: ReturnType<typeof quads>): GroundGeometry {
  const base = top.position.length / 3;
  return {
    position: new Float32Array([...top.position, ...q.pos]),
    normal: new Float32Array([...top.normal, ...q.nor]),
    index: new Uint32Array([...top.index, ...q.idx.map((i) => i + base)]),
  };
}

// A bridge level as a solid slab: its surface, the edge below it and a parapet along
// every open side.
function deckSlab(polys: Polygons, box: Bounds, mask: LevelMask, D: HeightAt, T: HeightAt, level: number): GroundLayer[] {
  const q = quads();
  openSides(polys, box, mask, D, T, (a, b, ha, hb, ox, oy) => {
    const out = [ox, 0, -oy], inn = [-ox, 0, oy];
    const ia = [a[0] - ox * PARAPET_W, a[1] - oy * PARAPET_W], ib = [b[0] - ox * PARAPET_W, b[1] - oy * PARAPET_W];
    q.quad([a[0], ha - FASCIA, -a[1]], [b[0], hb - FASCIA, -b[1]], [b[0], hb + PARAPET, -b[1]], [a[0], ha + PARAPET, -a[1]], out);
    q.quad([ib[0], hb, -ib[1]], [ia[0], ha, -ia[1]], [ia[0], ha + PARAPET, -ia[1]], [ib[0], hb + PARAPET, -ib[1]], inn);
    q.quad([a[0], ha + PARAPET, -a[1]], [b[0], hb + PARAPET, -b[1]], [ib[0], hb + PARAPET, -ib[1]], [ia[0], ha + PARAPET, -ia[1]], [0, 1, 0]);
  });
  const geometry = joined(polygons(polys), q);
  return geometry.index.length ? [{ order: -600, geometry, color: COLORS.slab, pattern: 'concrete', blend: null, slab: true, level }] : [];
}

// What's drawn on a bridge level, over its slab: its surface, tram tracks and the
// bridges' road paint. Zebra crossings stay on the ground: they're far more often
// under a flyover than on a bridge.
function deckLayers(polys: Polygons, trams: Point2[][], edges: GroundRoadEdge[], level: number): GroundLayer[] {
  const out: GroundLayer[] = [];
  let order = -599;
  const add = (geometry: GroundGeometry, color: string, pattern = 'flat') => {
    const o = order++;
    if (geometry.index.length) out.push({ order: o, geometry, color, pattern, blend: null, deck: true, level });
  };
  add(polygons(polys), COLORS.bridge, 'asphalt');
  add(strips(trams, 2.5), COLORS.trackbed, 'concrete');
  add(strips(trams.flatMap((pts) => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.1), COLORS.steel);
  const { dashed, solid } = roadPaint(edges, trams);
  add(strips(dashed, 0.13, [3, 6]), COLORS.paint);
  add(strips(solid, 0.13), COLORS.paint);
  return out;
}

// A tunnel level: its floor, the walls along it and its road paint.
function tunnelLayers(polys: Polygons, box: Bounds, mask: LevelMask, H: HeightAt, T: HeightAt, edges: GroundRoadEdge[], level: number): GroundLayer[] {
  const out: GroundLayer[] = [];
  const add = (order: number, geometry: GroundGeometry, color: string, pattern = 'flat') => {
    if (geometry.index.length) out.push({ order, geometry, color, pattern, blend: null, tunnel: true, level });
  };
  add(-700, polygons(polys), COLORS.tunnel, 'asphalt');
  const q = quads();
  openSides(polys, box, mask, H, T, (a, b, ha, hb, ox, oy) => {
    q.quad([b[0], hb, -b[1]], [a[0], ha, -a[1]], [a[0], ha + TUNNEL_H, -a[1]], [b[0], hb + TUNNEL_H, -b[1]], [-ox, 0, oy]);
  });
  add(-699, joined(polygons([]), q), COLORS.tunnelWall, 'concrete');
  const inner = groundHeight;
  groundHeight = (x: number, y: number) => (inner ? inner(x, y) : 0) + 0.05;
  try {
    const { dashed, solid } = roadPaint(edges, []);
    add(-698, strips(dashed, 0.13, [3, 6]), COLORS.paint);
    add(-697, strips(solid, 0.13), COLORS.paint);
  } finally { groundHeight = inner; }
  return out;
}

function layers(d: GroundTileData, { box, edges, buildings, parkingZones, bridges: withBridges = true }: {
  box: Bounds; edges: GroundRoadEdge[]; buildings: { rings: Point2[][] }[];
  parkingZones: (string | null)[]; bridges?: boolean;
}): GroundLayer[] {
  const out: GroundLayer[] = [];
  const A = d.areas, R = d.roads;
  // Fixed order per layer (whether or not it has anything), so tiles layer consistently.
  let order = -1000;
  const add = (geometry: GroundGeometry, color: string, pattern = 'flat', blend: number | null = null) => {
    const o = order++;
    if (geometry.index.length) out.push({ order: o, geometry, color, pattern, blend });
  };
  const shade = (geometry: GroundGeometry, opacity: number) => {
    const o = order++;
    if (geometry.index.length) out.push({ order: o, geometry, shade: opacity });
  };

  // Base: everything unmapped between streets and houses is paved; gardens round
  // family houses come from the pipeline (osm_area.py, _gardens).
  const [x0, y0, x1, y1] = box;
  // Polygons are clipped to the tile: their edges along the tile border aren't real
  // shores or kerbs, so outlines and shading skip them.
  const cut = (a: Point2, b: Point2) => ([[0, x0], [0, x1], [1, y0], [1, y1]] as [0 | 1, number][]).some(([k, v]) => Math.abs(a[k] - v) < 0.05 && Math.abs(b[k] - v) < 0.05);
  const outlines = (polys: Polygons): Point2[][] => {
    const out: Point2[][] = [];
    for (const rings of polys) {
      for (const ring of rings) {
        let cur: Point2[] = [];
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          if (cut(a, b)) { if (cur.length > 1) out.push(cur); cur = []; continue; }
          if (!cur.length) cur.push(a);
          cur.push(b);
        }
        if (cur.length > 1) out.push(cur);
      }
    }
      return out;
    };
    add(polygons([[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]]), COLORS.pavement, 'mosaic');
    add(polygons(A.garden || []), COLORS.garden, 'grass');
    add(polygons(A.park || []), COLORS.park, 'grass');
    add(polygons(A.orchard || []), COLORS.orchard, 'grass');
    add(polygons(A.wood || []), COLORS.wood, 'wood');
    add(polygons(A.pitch || []), COLORS.pitch, 'pitch');
    add(strips(outlines((A.pitch || []).map((r) => [r[0]])), 0.12), COLORS.paint);
    add(polygons(A.square || []), COLORS.square, 'slabs');
    add(polygons(A.water || []), COLORS.water, 'water');
    shade(skirts(A.water || [], 6, false, cut), 0.35);
    add(strips(outlines(A.water || []), 0.9), COLORS.quay, 'slabs');
    add(strips(d.weirs || [], 2.4), '#9a978d', 'concrete');
    add(strips((d.weirs || []).map((w) => offsetLine(w, -1.6)), 2.2), '#dfe6e2');

    add(polygons(A.parking || []), COLORS.parking, 'asphalt');
    add(polygons(R.dirt || []), COLORS.dirt, 'dirt');
    add(polygons(R.path || []), COLORS.path, 'mosaic');
    add(polygons(R.sett || []), COLORS.sett, 'setts');
    add(polygons(R.road || []), COLORS.asphalt, 'asphalt');
    // Bay outlines in the paid zone's colour: blue residents, violet mixed, orange visitors.
    for (const [cat, color] of [...Object.entries(ZONE), [null, COLORS.paint] as [null, string]]) {
      const rings = (A.parking || []).filter((rs, k) => (parkingZones[k] || null) === cat);
      add(strips(outlines(rings.map((rs) => [rs[0]])), 0.15), color);
    }

    // Bridges: a soft shadow on the water, then the deck (unless the decks are drawn
    // above the ground, where they cast shadows of their own).
    const bridges = withBridges ? [...(A.bridge || []), ...(R.bridge || [])] : [];
    const shadow = polygons(bridges);
    for (let i = 0; i < shadow.position.length; i += 3) { shadow.position[i] += 3; shadow.position[i + 2] += 3.5; }
    add(shadow, '#000000', 'flat', 0.28);
    add(polygons(bridges), COLORS.bridge, 'asphalt');

    // Tram tracks: concrete bed and two rails at standard gauge.
    const trams = d.rails.filter((r) => r.kind === 'tram').map((r) => r.pts);
    add(strips(trams, 2.5), COLORS.trackbed, 'concrete');
    add(strips(trams.flatMap((pts) => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.1), COLORS.steel);
    add(strips(d.rails.filter((r) => r.kind === 'funicular').map((r) => r.pts), 3), COLORS.funicular, 'concrete');

    const { dashed, solid } = roadPaint(edges, trams);
    add(strips(dashed, 0.13, [3, 6]), COLORS.paint);
    add(strips(solid, 0.13), COLORS.paint);
    add(strips(zebras(d.crossings || [], edges, [...(R.road || []), ...(R.sett || [])], box), 0.5), COLORS.paint);

    // Soft contact shadow round every building.
    shade(skirts(buildings.map((b) => b.rings), 1.8, true), 0.5);
  return out;
}

// Road paint from OSM lanes: dashed lane dividers, a centre line (double solid on
// roads of four lanes or more) and edge lines on the main roads. Cobbled streets
// and the middle of tram streets stay unpainted.
const COBBLED = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones']);
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const EDGE_LINES = new Set(['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link']);
function roadPaint(edges: GroundRoadEdge[], trams: Point2[][]) {
  const near = (p: Point2) => trams.some((pts) => pts.some((q, i) => i > 0 && segDistPts(p, pts[i - 1], q) < 3));
  const dashed: Point2[][] = [], solid: Point2[][] = [];
  for (const e of edges) {
    const n = e.lanes || 0;
    if (COBBLED.has(e.surface ?? '') || (!MAJOR.has(e.hw) && n < 2)) continue;
    if (!e.oneway && e.u > e.v) continue; // a two-way street has an edge each way: paint it once
    const W = e.width, pts = e.pts;
    if (e.oneway) {
      const lanes = Math.max(1, n || 1), lw = W / lanes;
      for (let k = 1; k < lanes; k++) dashed.push(offsetLine(pts, -W / 2 + k * lw));
      if (EDGE_LINES.has(e.hw) || lanes > 1) solid.push(offsetLine(pts, W / 2 - 0.4), offsetLine(pts, -W / 2 + 0.4));
      continue;
    }
    const per = Math.max(1, Math.floor(Math.max(2, n || 2) / 2)), lw = W / (2 * per);
    if (![pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].some(near)) {
      if (per >= 2) solid.push(offsetLine(pts, 0.15), offsetLine(pts, -0.15));
      else dashed.push(pts);
    }
    for (let k = 1; k < per; k++) dashed.push(offsetLine(pts, k * lw), offsetLine(pts, -k * lw));
    if (EDGE_LINES.has(e.hw)) solid.push(offsetLine(pts, W / 2 - 0.4), offsetLine(pts, -W / 2 + 0.4));
  }
  return { dashed, solid };
}

// Zebra crossings: bars along the road, one every metre across it, from kerb to kerb.
// OSM's crossing lines only say roughly where a crossing is: they often stop short of
// the kerb or run on over the pavement, and bend. So each crossing is laid out afresh
// where it meets a street's centre line: straight across the street (unless it's
// mapped 30° to 60° off square, as some are: then along the way it's mapped), as
// far as the road surface goes on each side, with the bars evened out between them.
const BAR = 0.5, PITCH = 1, BAR_LEN = 3, KERB_GAP = 0.3, SQUARE = Math.cos(Math.PI / 6);
function zebras(crossings: Point2[][], edges: GroundRoadEdge[], road: Polygons, box: Bounds): Point2[][] {
  const bars: Point2[][] = [];
  const done: Point2[] = [];
  for (const pts of crossings) {
    for (const hit of crossingHits(pts, edges)) {
      if (done.some((q) => Math.hypot(q[0] - hit.at[0], q[1] - hit.at[1]) < 2.5)) continue; // a two-way street's other edge
      done.push(hit.at);
      const [px, py] = hit.at, [rx, ry] = hit.road, nx = -ry, ny = rx;
      // Across the street, or along the crossing where it's mapped well off square.
      let [ax, ay] = hit.along;
      if (ax * nx + ay * ny < 0) { ax = -ax; ay = -ay; }
      const square = ax * nx + ay * ny;
      if (square > SQUARE || square < 0.5) { ax = nx; ay = ny; } // (or so far off it's a mapping slip)
      const k = ax * nx + ay * ny; // metres across the street per metre along the crossing
      // As far as the road surface reaches each way; where it runs off the tile, or
      // there's no mapped surface, half the street's width.
      const half = hit.width / 2 / k;
      const span = roadSpan(road, px, py, ax, ay) ?? [-half, half];
      const [x0, y0, x1, y1] = box;
      const offTile = (t: number) => { const x = px + ax * t, y = py + ay * t; return x < x0 + 0.5 || x > x1 - 0.5 || y < y0 + 0.5 || y > y1 - 0.5; };
      const lo = offTile(span[0]) ? Math.min(span[0], -half) : span[0];
      const hi = offTile(span[1]) ? Math.max(span[1], half) : span[1];
      // Bars evened out between the kerbs, a little in from each.
      const width = (hi - lo) * k - 2 * KERB_GAP;
      if (width < BAR || width > 40) continue;
      const n = Math.floor((width - BAR) / PITCH) + 1;
      const first = lo * k + KERB_GAP + (width - (BAR + (n - 1) * PITCH)) / 2 + BAR / 2;
      for (let i = 0; i < n; i++) {
        const t = (first + i * PITCH) / k, cx = px + ax * t, cy = py + ay * t;
        bars.push([[cx - rx * BAR_LEN / 2, cy - ry * BAR_LEN / 2], [cx + rx * BAR_LEN / 2, cy + ry * BAR_LEN / 2]]);
      }
    }
  }
  return bars;
}

// Where a crossing meets the centre lines of the streets (not bridges or tunnels):
// the point, the street's heading there, the crossing's, and the street's width.
// A crossing that stops short of the centre line meets the nearest street it reaches.
function crossingHits(pts: Point2[], edges: GroundRoadEdge[]) {
  const hits: { at: Point2; road: Point2; along: Point2; width: number }[] = [];
  const unit = (a: Point2, b: Point2): Point2 => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  for (const e of edges) {
    if (e.bridge || e.tunnel) continue;
    for (let i = 1; i < pts.length; i++) {
      for (let j = 1; j < e.pts.length; j++) {
        const at = segCross(pts[i - 1], pts[i], e.pts[j - 1], e.pts[j]);
        if (at) hits.push({ at, road: unit(e.pts[j - 1], e.pts[j]), along: unit(pts[i - 1], pts[i]), width: e.width });
      }
    }
  }
  if (hits.length || pts.length < 2) return hits;
  const mid = pts[Math.floor((pts.length - 1) / 2)], next = pts[Math.floor((pts.length - 1) / 2) + 1];
  let best: { at: Point2; road: Point2; along: Point2; width: number } | null = null, bestD = Infinity;
  for (const e of edges) {
    if (e.bridge || e.tunnel) continue;
    for (let j = 1; j < e.pts.length; j++) {
      const a = e.pts[j - 1], b = e.pts[j], d = segDistPts(mid, a, b);
      if (d >= bestD || d > e.width / 2 + 3) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((mid[0] - a[0]) * dx + (mid[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      bestD = d;
      best = { at: [a[0] + dx * t, a[1] + dy * t], road: unit(a, b), along: unit(mid, next), width: e.width };
    }
  }
  return best ? [best] : [];
}

function segCross(a: Point2, b: Point2, c: Point2, d: Point2): Point2 | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + rx * t, a[1] + ry * t] : null;
}

// How far the road surface reaches from (px, py) along (ax, ay), both ways, as
// [back, ahead] in metres (back negative); null if (px, py) isn't on it. Pieces of
// surface that touch (separate polygons for each street, say) count as one.
function roadSpan(road: Polygons, px: number, py: number, ax: number, ay: number): [number, number] | null {
  const spans: [number, number][] = [];
  for (const rings of road) {
    const ts: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const ex = b[0] - a[0], ey = b[1] - a[1], den = ax * ey - ay * ex;
        if (Math.abs(den) < 1e-9) continue;
        const u = ((a[0] - px) * ay - (a[1] - py) * ax) / den; // along the ring's edge
        if (u < 0 || u >= 1) continue;
        ts.push(((a[0] - px) * ey - (a[1] - py) * ex) / den);
      }
    }
    ts.sort((p, q) => p - q);
    for (let i = 0; i + 1 < ts.length; i += 2) spans.push([ts[i], ts[i + 1]]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1] + 0.3) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  return merged.find(([lo, hi]) => lo <= 0.3 && hi >= -0.3) ?? null;
}

function segDistPts(p: Point2, a: Point2, b: Point2) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
