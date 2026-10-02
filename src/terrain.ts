// A tile's terrain (pipeline/ipr_terrain.py): n × n heights every `step` metres from the
// tile's south-west corner, as uint16 decimetres above 100 m a.s.l., then each point's
// label as a byte. Used on the main thread and in the tile workers alike.
import { onPolygons } from './map/geo.ts';
import type { Polygons } from './map/geo.ts';

// Heights in metres above `ref` (the game's y = 0).
export function decodeHeights(buffer: ArrayBuffer, n: number, ref: number) {
  const h = new Uint16Array(buffer, 0, n * n), hm = new Float32Array(n * n);
  for (let i = 0; i < hm.length; i++) hm[i] = h[i] / 10 + 100 - ref;
  return hm;
}

// What a point of the terrain is on (pipeline/dtm_heights.py): the plain ground (0),
// water (WATER) or one of the tile's terraces at the foot of a retaining wall (2 and up,
// see Terrace). A bank or a retaining wall is a step in the ground, not a slope: where
// the labels in a cell differ, the height at a point is read from the corners with that
// point's own label alone (heightSampler). null where the whole tile is plain ground.
export function pointLabels(buffer: ArrayBuffer, n: number) {
  if (buffer.byteLength < n * n * 3) return null;
  const labels = new Uint8Array(buffer, n * n * 2, n * n);
  return labels.some((l) => l > 0) ? labels.slice() : null;
}
export const WATER = 1;
// A tile's terrace: its label in the terrain and its outline.
export interface Terrace { label: number; polys: Polygons }

// Which terrace a point is on (its label), or 0 for none.
export function terraceAt(terraces: Terrace[] | null | undefined) {
  if (!terraces?.length) return null;
  const on = terraces.map((t) => onPolygons(t.polys));
  return (x: number, y: number) => {
    for (let k = 0; k < on.length; k++) if (on[k](x, y)) return terraces[k].label;
    return 0;
  };
}

// A tile's bridge and tunnel levels (.levels.bin): `count` lattices one after another,
// in centimetres above 100 m a.s.l., with 0 away from the level: NaN here.
export function decodeLevels(buffer: ArrayBuffer, n: number, count: number, ref: number) {
  const h = new Uint16Array(buffer), out: Float32Array[] = [];
  for (let k = 0; k < count; k++) {
    const hm = new Float32Array(n * n), o = k * n * n;
    for (let i = 0; i < hm.length; i++) hm[i] = h[o + i] ? h[o + i] / 100 + 100 - ref : NaN;
    out.push(hm);
  }
  return out;
}

// Height at a point, bilinear and clamped to the tile (NaN next to a missing height).
// With `labels` (pointLabels), in a cell a step crosses only the corners on the point's
// own side count. `side`: the label of that side; true for the water's; left out, it's
// the terrace the point is on (`terrace`, see terraceAt) or else the plain ground, and
// never the water, so what stands by a quay wall stands on the quay.
export function heightSampler(hm: Float32Array, [bx, by]: [number, number] | [number, number, number, number], n: number, step: number,
  labels: Uint8Array | null = null, terrace: ((x: number, y: number) => number) | null = null) {
  return (x: number, y: number, side: number | boolean = false) => {
    const u = Math.min(n - 1.001, Math.max(0, (x - bx) / step)), v = Math.min(n - 1.001, Math.max(0, (y - by) / step));
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const o = j * n + i;
    const a = hm[o], b = hm[o + 1], c = hm[o + n], d = hm[o + n + 1];
    if (labels) {
      const la = labels[o], lb = labels[o + 1], lc = labels[o + n], ld = labels[o + n + 1];
      const mixed = la !== lb || lb !== lc || lc !== ld;
      // (In a cell all of one kind, only a side asked for by name can be another: the
      // tip of a quay narrower than a cell, cut out of the water round it.)
      if (mixed || (side !== false && la !== (side === true ? WATER : side))) {
        const want = side === true ? WATER : side === false ? (terrace ? terrace(x, y) : 0) : side;
        let ka = la === want ? 1 : 0, kb = lb === want ? 1 : 0, kc = lc === want ? 1 : 0, kd = ld === want ? 1 : 0;
        if (!(ka + kb + kc + kd)) {
          // No corner of its own (a sliver of a terrace, a spit of land): the points of
          // its side a cell further out, the nearer the more.
          let sum = 0, total = 0;
          for (let q = Math.max(0, j - 1); q <= Math.min(n - 1, j + 2); q++) {
            for (let p = Math.max(0, i - 1); p <= Math.min(n - 1, i + 2); p++) {
              if (labels[q * n + p] !== want) continue;
              const w = 1 / ((p - u) * (p - u) + (q - v) * (q - v) + 0.01);
              sum += hm[q * n + p] * w;
              total += w;
            }
          }
          if (total) return sum / total;
          // None there either: the dry corners.
          if (want !== WATER) { ka = la !== WATER ? 1 : 0; kb = lb !== WATER ? 1 : 0; kc = lc !== WATER ? 1 : 0; kd = ld !== WATER ? 1 : 0; }
        }
        const count = ka + kb + kc + kd;
        if (count && mixed) {
          const wa = ka * (1 - fu) * (1 - fv), wb = kb * fu * (1 - fv), wc = kc * (1 - fu) * fv, wd = kd * fu * fv, k = wa + wb + wc + wd;
          // Right at a corner of another side: the mean of this side's corners.
          return k > 1e-4 ? (a * wa + b * wb + c * wc + d * wd) / k : (a * ka + b * kb + c * kc + d * kd) / count;
        }
      }
    }
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  };
}

// A tile's data file; `gz`: gzipped by the pipeline (index.json has "gzip"). A server
// may already have undone the gzip on the way, so it's only unpacked if it still
// starts with gzip's header (magic number, deflate).
export async function fetchBinary(url: string, gz = false) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
  if (!gz || b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
