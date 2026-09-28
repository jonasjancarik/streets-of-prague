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
export interface DeckMask { w: number; h: number; cells: Uint8Array; box: Bounds }
export interface GroundResult { layers: GroundLayer[]; mask: DeckMask | null }
export interface GroundRoadEdge {
  u: string; v: string; hw: string; pts: Point2[]; width: number;
  lanes?: number | null; oneway?: boolean; bridge?: boolean; surface?: string;
}
type HeightAt = (x: number, y: number) => number;
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
  park: '#7d9a55', garden: '#83a058', wood: '#52703c', orchard: '#8aa25e', pitch: '#6c9c55',
  water: '#4d7680', asphalt: '#5c5f63', sett: '#8a847a', parking: '#666a6e',
  bridge: '#62656a', trackbed: '#8a8a85', steel: '#3a3b3d', paint: '#efede4',
  quay: '#7c776c', funicular: '#6e6a62', slab: '#8e8b84',
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
// With `deck` (the height of the tile's bridge decks at a point, NaN off them), the
// ground stays bare under the bridges and the decks come separately, above it: a
// slab ({ order, geometry, slab: true }, with its edges and parapets) and the layers
// on top of it ({ ..., deck: true }: the deck's surface, tram tracks, paint), which
// the game only draws where `mask` (the decks rasterised, `res` cells per metre,
// rows from the north) says there is a deck.
export function groundLayers(d: GroundTileData, { box, edges = [], buildings = [], parkingZones = [], height = null, deck = null }: {
  box: Bounds; edges?: GroundRoadEdge[]; buildings?: { rings: Point2[][] }[];
  parkingZones?: (string | null)[]; height?: HeightAt | null; deck?: HeightAt | null;
}): GroundResult {
  const bridges = [...(d.areas.bridge || []), ...(d.roads.bridge || [])];
  if (!deck || !bridges.length) {
    groundHeight = height;
    try { return { layers: layers(d, { box, edges, buildings, parkingZones }), mask: null }; } finally { groundHeight = null; }
  }
  const T = height || (() => 0);
  const D = (x: number, y: number) => { const h = deck(x, y); return Number.isNaN(h) ? T(x, y) : h; };
  const mask = deckMask(box, bridges);
  groundHeight = height;
  let lower;
  try { lower = layers(d, { box, edges: edges.filter((e) => !e.bridge), buildings, parkingZones, bridges: false }); } finally { groundHeight = null; }
  groundHeight = D;
  let slab;
  try { slab = deckSlab(bridges, box, mask, D, T); } finally { groundHeight = null; }
  // What's on the deck floats a hand's breadth above the slab: they're triangulated
  // differently, and the heights come in decimetres, so they'd cut into each other.
  groundHeight = (x: number, y: number) => D(x, y) + 0.12;
  try {
    return { layers: [...lower, ...slab, ...deckLayers(d, { box, edges: edges.filter((e) => e.bridge), bridges })], mask };
  } finally { groundHeight = null; }
}

// The typed arrays in a tile's ground, to hand them over from a worker without copying.
export const layerBuffers = ({ layers, mask }: GroundResult): ArrayBuffer[] => {
  const buffers = [...layers.flatMap((l) => Object.values(l.geometry).map((a) => a.buffer)), ...(mask ? [mask.cells.buffer] : [])];
  if (buffers.some((buffer) => !(buffer instanceof ArrayBuffer))) throw new Error('Ground transfer requires ArrayBuffer storage');
  return buffers as ArrayBuffer[];
};

export const DECK_RES = 2; // deck mask cells per metre

// The decks rasterised: 255 on a deck, 0 off it, rows from the north.
function deckMask([x0, y0, x1, y1]: Bounds, polys: Polygons): DeckMask {
  const w = Math.ceil((x1 - x0) * DECK_RES), h = Math.ceil((y1 - y0) * DECK_RES);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Cannot create deck mask canvas');
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
  return { w, h, cells, box: [x0, y0, x1, y1] };
}

const onDeck = (mask: DeckMask, x: number, y: number) => {
  const [x0, , , y1] = mask.box;
  const i = Math.floor((x - x0) * DECK_RES), j = Math.floor((y1 - y) * DECK_RES);
  return i >= 0 && j >= 0 && i < mask.w && j < mask.h && mask.cells[j * mask.w + i] > 0;
};

const FASCIA = 1.2; // m: the deck's edge below its surface
const PARAPET = 1.0; // m: the parapet above it
const PARAPET_W = 0.35;

// The decks as a solid slab: their surface, the edge below it and a parapet along
// every side that's open (not where a deck meets the ground or another deck, nor along
// the tile's border, where the slab carries on in the next tile).
function deckSlab(bridges: Polygons, [x0, y0, x1, y1]: Bounds, mask: DeckMask, D: HeightAt, T: HeightAt): GroundLayer[] {
  const top = polygons(bridges);
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    for (let k = 0; k < 4; k++) nor.push(...n);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const cut = (a: Point2, b: Point2) => ([[0, x0], [0, x1], [1, y0], [1, y1]] as [0 | 1, number][]).some(([k, v]) => Math.abs(a[k] - v) < 0.05 && Math.abs(b[k] - v) < 0.05);
  for (const rings of bridges) {
    for (const ring of rings) {
      for (let r = 0; r < ring.length; r++) {
        const p = ring[r], q = ring[(r + 1) % ring.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 0.05 || cut(p, q)) continue;
        const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
        const n = Math.ceil(len / 3);
        for (let s = 0; s < n; s++) {
          const a = [p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n];
          const b = [p[0] + ((q[0] - p[0]) * (s + 1)) / n, p[1] + ((q[1] - p[1]) * (s + 1)) / n];
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          // Which side is off the deck; neither or both: not an open side.
          const left = onDeck(mask, mx - uy * 0.8, my + ux * 0.8), right = onDeck(mask, mx + uy * 0.8, my - ux * 0.8);
          if (left === right) continue;
          // Where the deck runs at the level of the ground there's no edge to see.
          if (D(mx, my) - T(mx, my) < 1.2) continue;
          const ox = left ? uy : -uy, oy = left ? -ux : ux; // outwards, off the deck
          const ha = D(a[0], a[1]), hb = D(b[0], b[1]);
          const out = [ox, 0, -oy], inn = [-ox, 0, oy];
          const ia = [a[0] - ox * PARAPET_W, a[1] - oy * PARAPET_W], ib = [b[0] - ox * PARAPET_W, b[1] - oy * PARAPET_W];
          quad([a[0], ha - FASCIA, -a[1]], [b[0], hb - FASCIA, -b[1]], [b[0], hb + PARAPET, -b[1]], [a[0], ha + PARAPET, -a[1]], out);
          quad([ib[0], hb, -ib[1]], [ia[0], ha, -ia[1]], [ia[0], ha + PARAPET, -ia[1]], [ib[0], hb + PARAPET, -ib[1]], inn);
          quad([a[0], ha + PARAPET, -a[1]], [b[0], hb + PARAPET, -b[1]], [ib[0], hb + PARAPET, -ib[1]], [ia[0], ha + PARAPET, -ia[1]], [0, 1, 0]);
        }
      }
    }
  }
  // One geometry: the surface (draped by finish) and the edges.
  const base = top.position.length / 3;
  const geometry = {
    position: new Float32Array([...top.position, ...pos]),
    normal: new Float32Array([...top.normal, ...nor]),
    index: new Uint32Array([...top.index, ...idx.map((i) => i + base)]),
  };
  return geometry.index.length ? [{ order: -600, geometry, color: COLORS.slab, pattern: 'concrete', blend: null, slab: true }] : [];
}

// What's drawn on the decks, over the slab: their surface, tram tracks and the bridges'
// road paint, clipped to the decks by the game (with `mask`). Zebra crossings stay on
// the ground: they're far more often under a flyover than on a bridge.
function deckLayers(d: GroundTileData, { box, edges, bridges }: { box: Bounds; edges: GroundRoadEdge[]; bridges: Polygons }): GroundLayer[] {
  const out: GroundLayer[] = [];
  let order = -599;
  const add = (geometry: GroundGeometry, color: string, pattern = 'flat') => {
    const o = order++;
    if (geometry.index.length) out.push({ order: o, geometry, color, pattern, blend: null, deck: true });
  };
  add(polygons(bridges), COLORS.bridge, 'asphalt');
  const trams = d.rails.filter((r) => r.kind === 'tram').map((r) => r.pts);
  add(strips(trams, 2.5), COLORS.trackbed, 'concrete');
  add(strips(trams.flatMap((pts) => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.1), COLORS.steel);
  const { dashed, solid } = roadPaint(edges, trams);
  add(strips(dashed, 0.13, [3, 6]), COLORS.paint);
  add(strips(solid, 0.13), COLORS.paint);
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
    add(strips(zebras(d.crossings || []), 0.5), COLORS.paint);

    // Soft contact shadow round every building: a tight dark one where the wall meets
    // the ground, and a wide faint one, which adds up in courtyards and narrow lanes.
    const rings = buildings.map((b) => b.rings);
    shade(skirts(rings, 7, true), 0.38);
    shade(skirts(rings, 1.8, true), 0.5);
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

// Zebra crossings: bars along the road, one every metre across it.
function zebras(crossings: Point2[][]): Point2[][] {
  const bars: Point2[][] = [];
  for (const pts of crossings) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len, vx = -uy, vy = ux;
      for (let t = 0.5; t < len - 0.25; t += 1) {
        const px = ax + ux * t, py = ay + uy * t;
        bars.push([[px - vx * 1.5, py - vy * 1.5], [px + vx * 1.5, py + vy * 1.5]]);
      }
    }
  }
  return bars;
}

function segDistPts(p: Point2, a: Point2, b: Point2) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
