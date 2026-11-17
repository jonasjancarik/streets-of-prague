// Trial (?area=walls-tin): a tile's ground as a TIN instead of the 4 m lattice. The map
// copy has, for some tiles, the TIN's points with a height for each side of a step and
// the step lines (docs/terrain-tin-plan.md); the triangles are built here with the step
// lines kept as edges. Not part of the shipped map format.
import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { WATER } from './terrain.ts';

export interface TinFile {
  box: [number, number, number, number];
  xy: [number, number][]; // metres from the box's corner
  h: [number, number][][]; // per point: [side, height a.s.l.], one per side it has
  segs: [number, number, number, number][]; // step pieces: from, to, left side, right side
  grid: { g: number; nx: number; ny: number; sides: string }; // side lattice (base64), for triangles off the steps
}

// What a worker gets (structured clone): the built triangles and the points' heights.
export interface TinMesh {
  box: [number, number, number, number];
  coords: Float64Array; tri: Uint32Array; labels: Int32Array;
  side: Int32Array; height: Float32Array; // two slots a point: side (-1 unused) and height
  kept: number; lost: number;
}

export function buildTin(f: TinFile): TinMesh {
  const n = f.xy.length, coords = new Float64Array(n * 2);
  f.xy.forEach(([x, y], i) => { coords[2 * i] = x; coords[2 * i + 1] = y; });
  const del = new Delaunator(coords);
  const con = new Constrainautor(del);
  // A step along the tile's edge passes through the edge's own points: cut it there.
  const pc = 2, pn = Math.ceil((f.box[2] - f.box[0]) / pc) + 1, pb: number[][] = Array.from({ length: pn * pn }, () => []);
  const cl = (v: number) => Math.max(0, Math.min(pn - 1, Math.floor(v / pc)));
  for (let i = 0; i < n; i++) pb[cl(coords[2 * i + 1]) * pn + cl(coords[2 * i])].push(i);
  const pieces = (a: number, b: number): [number, number][] => {
    const ax = coords[2 * a], ay = coords[2 * a + 1], dx = coords[2 * b] - ax, dy = coords[2 * b + 1] - ay, L2 = dx * dx + dy * dy;
    const on: [number, number][] = [];
    for (let j = cl(Math.min(ay, ay + dy)); j <= cl(Math.max(ay, ay + dy)); j++)
      for (let i = cl(Math.min(ax, ax + dx)); i <= cl(Math.max(ax, ax + dx)); i++)
        for (const v of pb[j * pn + i]) {
          if (v === a || v === b) continue;
          const u = ((coords[2 * v] - ax) * dx + (coords[2 * v + 1] - ay) * dy) / L2;
          const off = Math.abs((coords[2 * v] - ax) * dy - (coords[2 * v + 1] - ay) * dx) / Math.sqrt(L2);
          if (u > 0 && u < 1 && off < 0.002) on.push([u, v]);
        }
    on.sort((p, q) => p[0] - q[0]);
    const ids = [a, ...on.map((o) => o[1]), b];
    return ids.slice(1).map((v, k) => [ids[k], v]);
  };
  const step = new Map<number, [number, number]>();
  let kept = 0, lost = 0;
  for (const [a0, b0, l, r] of f.segs) for (const [a, b] of pieces(a0, b0)) {
    try { con.constrainOne(a, b); kept++; } catch { lost++; }
    step.set(a * n + b, [l, r]); step.set(b * n + a, [r, l]);
  }
  const T = del.triangles, nt = T.length / 3;
  const sides = Uint8Array.from(atob(f.grid.sides), (c) => c.charCodeAt(0));
  const G = f.grid;
  // A triangle on a step takes that step's side (Delaunator's triangles run clockwise:
  // the right of the line); any other, the side at its middle.
  const labels = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    let s = -1;
    for (let k = 0; k < 3 && s < 0; k++) {
      const lr = step.get(T[3 * t + k] * n + T[3 * t + (k + 1) % 3]);
      if (lr) s = lr[1];
    }
    if (s < 0) {
      const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
      const mx = (coords[2 * a] + coords[2 * b] + coords[2 * c]) / 3, my = (coords[2 * a + 1] + coords[2 * b + 1] + coords[2 * c + 1]) / 3;
      const gi = Math.min(G.nx - 1, Math.max(0, Math.round(mx / G.g))), gj = Math.min(G.ny - 1, Math.max(0, Math.round(my / G.g)));
      s = sides[gj * G.nx + gi];
    }
    labels[t] = s;
  }
  const side = new Int32Array(2 * n).fill(-1), height = new Float32Array(2 * n);
  f.h.forEach((hs, i) => hs.slice(0, 2).forEach(([s, h], m) => { side[2 * i + m] = s; height[2 * i + m] = h; }));
  return { box: f.box, coords, tri: Uint32Array.from(T), labels, side, height, kept, lost };
}

// The TIN's height above `ref` at (x, y) in the game's map metres, `fallback` off it.
// `side` as heightSampler takes it: a label, true for the water, false for whatever is there.
export function tinSampler(m: TinMesh, ref: number, fallback: (x: number, y: number, side?: number | boolean) => number) {
  const [x0, y0, x1, y1] = m.box, W = x1 - x0, cell = 4, nc = Math.ceil(W / cell) + 1;
  const { coords: C, tri: T } = m, nt = T.length / 3;
  const start = new Int32Array(nc * nc + 1), lists: number[][] = Array.from({ length: nc * nc }, () => []);
  for (let t = 0; t < nt; t++) {
    let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
    for (let k = 0; k < 3; k++) { const v = T[3 * t + k]; ax = Math.min(ax, C[2 * v]); bx = Math.max(bx, C[2 * v]); ay = Math.min(ay, C[2 * v + 1]); by = Math.max(by, C[2 * v + 1]); }
    for (let j = Math.floor(ay / cell); j <= Math.floor(by / cell); j++)
      for (let i = Math.floor(ax / cell); i <= Math.floor(bx / cell); i++) lists[j * nc + i].push(t);
  }
  let total = 0;
  for (let c = 0; c < lists.length; c++) { start[c] = total; total += lists[c].length; }
  start[lists.length] = total;
  const flat = new Int32Array(total);
  lists.forEach((l, c) => flat.set(l, start[c]));
  const hOf = (v: number, s: number, own: number) => {
    const S = m.side, H = m.height;
    if (S[2 * v] === s) return H[2 * v];
    if (S[2 * v + 1] === s) return H[2 * v + 1];
    if (S[2 * v + 1] === own) return H[2 * v + 1];
    return H[2 * v];
  };
  const find = (lx: number, ly: number) => {
    const c = Math.floor(ly / cell) * nc + Math.floor(lx / cell);
    for (let q = start[c]; q < start[c + 1]; q++) {
      const t = flat[q], a = T[3 * t], b = T[3 * t + 1], d = T[3 * t + 2];
      const ax = C[2 * a], ay = C[2 * a + 1], bx = C[2 * b], by = C[2 * b + 1], cx = C[2 * d], cy = C[2 * d + 1];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((by - cy) * (lx - cx) + (cx - bx) * (ly - cy)) / det, l2 = ((cy - ay) * (lx - cx) + (ax - cx) * (ly - cy)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
      return [t, l1, l2, l3] as const;
    }
    return null;
  };
  const sample = (x: number, y: number, side: number | boolean = false) => {
    const lx = x - x0, ly = y - y0;
    if (!(lx >= 0 && lx <= W && ly >= 0 && ly <= y1 - y0)) return fallback(x, y, side);
    const f = find(lx, ly);
    if (!f) return fallback(x, y, side);
    const [t, l1, l2, l3] = f, own = m.labels[t];
    const s = side === true ? WATER : side === false ? own : side;
    return l1 * hOf(T[3 * t], s, own) + l2 * hOf(T[3 * t + 1], s, own) + l3 * hOf(T[3 * t + 2], s, own) - ref;
  };
  const labelAt = (x: number, y: number) => { const f = find(x - x0, y - y0); return f ? m.labels[f[0]] : -1; };
  return { sample, labelAt };
}
