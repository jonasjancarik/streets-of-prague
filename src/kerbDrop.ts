// Raised kerbs: the carriageway lies a kerb's height below what is beside it.
//
// The terrain has one height for a street and its pavements, so the step is made here: a
// small picture of each tile says how far the ground at a point lies below the terrain
// (0 on a pavement, a kerb's height on the carriageway, a short ramp between). Whatever
// asks for the ground's height gets it less that (withKerbs), so cars, trams and people
// stand on the lowered street, and the ground's layers are built to match (ground.ts).
//
// The height is the same everywhere and is not surveyed. Towards a bridge or a tunnel the
// street comes back up to the terrain, since their decks and floors have heights of their
// own with no step in them.
import type { Bounds, Point2, Polygons } from './map/geo.ts';

export const KERB_HEIGHT = 0.12; // m
const RES = 4; // cells a metre
const FADE_RES = 1, FADE_PAD = 9; // the way up to a bridge: cells a metre, and how far past the tile it looks (m)
const JOIN_NEAR = 1.5, JOIN_FAR = 8; // m from a bridge or tunnel: level with it, a full kerb

type HeightAt = (x: number, y: number, side?: number | boolean) => number;

// `drop`: per cell, 0–255 for 0 to a kerb's height. `fade`: per coarse cell, how much of
// the kerb's height the street has there (255 away from bridges and tunnels); null where
// the tile has none.
export interface KerbDrop {
  box: Bounds; w: number; h: number; drop: Uint8Array;
  fade: { w: number; h: number; cells: Uint8Array } | null;
}

// Which cells of a picture of `box` (plus `pad` metres round it) the polygons cover.
function covered(polys: Polygons, [x0, y0, x1, y1]: Bounds, res: number, pad: number) {
  const w = Math.ceil((x1 - x0 + 2 * pad) * res), h = Math.ceil((y1 - y0 + 2 * pad) * res);
  const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  for (const rings of polys) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y]: Point2, i: number) => (i ? ctx.lineTo((x - x0 + pad) * res, (y - y0 + pad) * res) : ctx.moveTo((x - x0 + pad) * res, (y - y0 + pad) * res)));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const data = ctx.getImageData(0, 0, w, h).data, cells = new Uint8Array(w * h);
  canvas.width = canvas.height = 0;
  // (Covered or not: two polygons side by side would otherwise leave a faint ridge along
  // the edge they share, each covering half of its cells.)
  for (let i = 0; i < cells.length; i++) cells[i] = data[i * 4 + 3] > 127 ? 255 : 0;
  return { w, h, cells };
}

// How much of the kerb's height each coarse cell has: none within JOIN_NEAR of a bridge
// or tunnel, all of it past JOIN_FAR.
function fadeFrom(joins: Polygons, box: Bounds) {
  const pic = joins.length ? covered(joins, box, FADE_RES, FADE_PAD) : null;
  if (!pic || !pic.cells.includes(255)) return null;
  const { w, h, cells } = pic, far = (JOIN_FAR + 2) * FADE_RES, dist = new Float32Array(w * h);
  for (let i = 0; i < dist.length; i++) dist[i] = cells[i] ? 0 : far;
  // Distance to the nearest covered cell, there and back (a chamfer, good to a few per cent).
  const D = Math.SQRT2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    let d = dist[k];
    if (i) d = Math.min(d, dist[k - 1] + 1);
    if (j) { d = Math.min(d, dist[k - w] + 1); if (i) d = Math.min(d, dist[k - w - 1] + D); if (i < w - 1) d = Math.min(d, dist[k - w + 1] + D); }
    dist[k] = d;
  }
  for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) {
    const k = j * w + i;
    let d = dist[k];
    if (i < w - 1) d = Math.min(d, dist[k + 1] + 1);
    if (j < h - 1) { d = Math.min(d, dist[k + w] + 1); if (i) d = Math.min(d, dist[k + w - 1] + D); if (i < w - 1) d = Math.min(d, dist[k + w + 1] + D); }
    dist[k] = d;
  }
  for (let i = 0; i < dist.length; i++) {
    const t = Math.min(1, Math.max(0, (dist[i] / FADE_RES - JOIN_NEAR) / (JOIN_FAR - JOIN_NEAR)));
    cells[i] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return { w, h, cells };
}

// A tile's kerbs: `low` is its carriageway (asphalt, setts, parking bays, the trams' own
// bed), `joins` its bridges and tunnels. null with no carriageway, or with no canvas to
// draw on (the tests outside a browser: the ground stays flat there).
export function kerbDrop(box: Bounds, low: Polygons, joins: Polygons): KerbDrop | null {
  if (typeof OffscreenCanvas === 'undefined' || !low.length) return null;
  const pic = covered(low, box, RES, 0);
  if (!pic || !pic.cells.includes(255)) return null;
  const { w, h, cells } = pic, fade = fadeFrom(joins, box);
  // The ramp at the kerb: a cell takes the mean of itself and its neighbours (twice its
  // own), which spreads the step over half a metre. Then the street's half of the ramp is
  // taken as street, so a wheel by the kerb is down on the asphalt and the ramp lies on
  // the pavement's last quarter metre.
  const row = new Uint16Array(w * h), k: KerbDrop = { box, w, h, drop: new Uint8Array(w * h), fade };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const at = j * w + i;
    row[at] = cells[at - (i ? 1 : 0)] + 2 * cells[at] + cells[at + (i < w - 1 ? 1 : 0)];
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const at = j * w + i, v = (row[at - (j ? w : 0)] + 2 * row[at] + row[at + (j < h - 1 ? w : 0)]) / 16;
    if (!v) continue;
    const x = box[0] + (i + 0.5) / RES, y = box[1] + (j + 0.5) / RES;
    k.drop[at] = Math.round(Math.min(255, v * 2) * streetDepth(k, x, y));
  }
  return k;
}

// How much of a kerb's height the street lies below the terrain at a point (0–1): all of
// it, less towards a bridge or a tunnel.
export function streetDepth(k: KerbDrop | null | undefined, x: number, y: number) {
  const f = k?.fade;
  if (!f) return k ? 1 : 0;
  const u = Math.min(f.w - 1, Math.max(0, (x - k.box[0] + FADE_PAD) * FADE_RES - 0.5)), v = Math.min(f.h - 1, Math.max(0, (y - k.box[1] + FADE_PAD) * FADE_RES - 0.5));
  const i = Math.min(f.w - 2, Math.floor(u)), j = Math.min(f.h - 2, Math.floor(v)), a = u - i, b = v - j, at = j * f.w + i, c = f.cells;
  return ((c[at] * (1 - a) + c[at + 1] * a) * (1 - b) + (c[at + f.w] * (1 - a) + c[at + f.w + 1] * a) * b) / 255;
}

// How far the ground at a point lies below the terrain (m).
export function dropAt(k: KerbDrop, x: number, y: number) {
  const u = Math.min(k.w - 1, Math.max(0, (x - k.box[0]) * RES - 0.5)), v = Math.min(k.h - 1, Math.max(0, (y - k.box[1]) * RES - 0.5));
  const i = Math.min(k.w - 2, Math.floor(u)), j = Math.min(k.h - 2, Math.floor(v)), a = u - i, b = v - j, at = j * k.w + i, c = k.drop;
  return ((c[at] * (1 - a) + c[at + 1] * a) * (1 - b) + (c[at + k.w] * (1 - a) + c[at + k.w + 1] * a) * b) * (KERB_HEIGHT / 255);
}

// A height sampler with the kerbs in it.
export function withKerbs(base: HeightAt, k: KerbDrop | null | undefined): HeightAt {
  if (!k) return base;
  return (x, y, side) => base(x, y, side) - dropAt(k, x, y);
}
