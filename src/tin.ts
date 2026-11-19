// A tile's ground as a triangulated mesh instead of the 4 m lattice (docs/terrain-tin-plan.md,
// "The move off the lattice"). The map has, for the tiles index.json lists under `tin`,
// tiles/<k>.tin.bin.gz (pipeline/tin_tiles.py): the mesh's points with a height for each
// side of a wall, and its breaklines (the walls' outlines, the water's edges and the
// kerbs). The triangles are built here with the breaklines kept as edges. The trial copy
// ?area=walls-tin has the same as JSON in tin/<k>.json.
import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import { WATER } from './terrain.ts';

export const TIN_FORMAT = 1;

export interface TinFile {
  box: [number, number, number, number];
  xy: [number, number][]; // metres from the box's corner
  h: [number, number][][]; // per point: [side, height a.s.l.], one per side it has
  segs: [number, number, number, number][]; // breakline pieces: from, to, left side, right side (the same for a kerb)
}

// tiles/<k>.tin.bin.gz, unpacked (the layout is in pipeline/tin.py, `write`). `box` is
// the tile's own (the file's is float32).
export function decodeTin(buf: ArrayBuffer, box: [number, number, number, number]): TinFile {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== 'TIN1') throw new Error('not a mesh file');
  const format = dv.getUint16(4, true), wide = dv.getUint16(6, true) & 1;
  if (format !== TIN_FORMAT) throw new Error(`mesh format ${format}; the game reads ${TIN_FORMAT}`);
  const base = dv.getFloat32(24, true);
  const n = dv.getUint32(28, true), m = dv.getUint32(32, true), r = dv.getUint32(36, true), nid = dv.getUint32(40, true);
  let o = 44;
  const u16 = (c: number) => { const a = new Uint16Array(buf.slice(o, o + 2 * c)); o += 2 * c; return a; };
  const u32 = (c: number) => { const a = new Uint32Array(buf.slice(o, o + 4 * c)); o += 4 * c; return a; };
  const u8 = (c: number) => { const a = new Uint8Array(buf, o, c); o += c; return a; };
  const qx = u16(n), qy = u16(n), h0 = u16(n), s0 = u8(n), more = u8(n), hx = u16(m), sx = u8(m);
  const len = u16(r), lr = u8(2 * r), ids = wide ? u32(nid) : u16(nid);
  const W = box[2] - box[0], H = box[3] - box[1];
  const xy: [number, number][] = new Array(n), h: [number, number][][] = new Array(n);
  let y = 0, e = 0;
  for (let i = 0; i < n; i++) {
    y += qy[i];
    xy[i] = [(qx[i] / 65535) * W, (y / 65535) * H];
    const own: [number, number][] = [[s0[i], base + h0[i] / 100]];
    for (let k = 0; k < more[i]; k++, e++) own.push([sx[e], base + hx[e] / 100]);
    h[i] = own;
  }
  const segs: [number, number, number, number][] = [];
  for (let q = 0, at = 0; q < r; at += len[q], q++)
    for (let k = at; k < at + len[q] - 1; k++) segs.push([ids[k], ids[k + 1], lr[2 * q], lr[2 * q + 1]]);
  return { box, xy, h, segs };
}

// What a worker gets (structured clone): the built triangles and the points' heights.
export interface TinMesh {
  box: [number, number, number, number];
  coords: Float64Array; tri: Uint32Array; labels: Int32Array;
  first: Uint32Array; side: Int32Array; height: Float32Array; // point i's sides and heights: first[i] to first[i + 1]
  segs: Int32Array; // step pieces: from, to, left side, right side
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
  const segs: number[] = [];
  let kept = 0, lost = 0;
  const hs = f.h.map((x) => x.slice());
  const hOf = (v: number, q: number) => hs[v].find(([w]) => w === q)?.[1];
  for (const [a0, b0, l, r] of f.segs) for (const [a, b] of pieces(a0, b0)) {
    segs.push(a, b, l, r);
    // A point the step was cut at (on the tile's edge) has only its own side's height:
    // the step's two sides there, from the step's ends.
    for (const v of [a, b]) if (v !== a0 && v !== b0) for (const q of [l, r]) {
      if (hOf(v, q) !== undefined) continue;
      const ha = hOf(a0, q), hb = hOf(b0, q);
      if (ha === undefined || hb === undefined) continue;
      const dx = coords[2 * b0] - coords[2 * a0], dy = coords[2 * b0 + 1] - coords[2 * a0 + 1];
      const u = ((coords[2 * v] - coords[2 * a0]) * dx + (coords[2 * v + 1] - coords[2 * a0 + 1]) * dy) / (dx * dx + dy * dy || 1);
      hs[v].push([q, ha + (hb - ha) * u]);
    }
    try { con.constrainOne(a, b); kept++; } catch { lost++; }
    step.set(a * n + b, [l, r]); step.set(b * n + a, [r, l]);
  }
  const T = del.triangles, HE = del.halfedges, nt = T.length / 3;
  // Each triangle's side (pipeline/tin.py, `game_labels`, checks this against the fit): a
  // triangle with a breakline for an edge is on the side of it it lies on (of two such
  // edges, the side all its corners have wins); else the side of a corner with one side;
  // the rest (all its corners on breaklines, as across a narrow arm of water) from its
  // neighbours, across edges that aren't breaklines; failing that, a side its corners share.
  const labels = new Int32Array(nt).fill(-1);
  const has = (v: number, q: number) => hs[v].some(([w]) => w === q);
  const queue: number[] = [];
  for (let t = 0; t < nt; t++) {
    let s = -1;
    for (let k = 0; k < 3; k++) {
      const a = T[3 * t + k], b = T[3 * t + (k + 1) % 3], c = T[3 * t + (k + 2) % 3];
      const lr = step.get(a * n + b);
      if (!lr) continue;
      const cross = (coords[2 * b] - coords[2 * a]) * (coords[2 * c + 1] - coords[2 * a + 1]) - (coords[2 * b + 1] - coords[2 * a + 1]) * (coords[2 * c] - coords[2 * a]);
      const side = cross > 0 ? lr[0] : lr[1];
      if (s < 0) s = side;
      if (has(T[3 * t], side) && has(T[3 * t + 1], side) && has(T[3 * t + 2], side)) { s = side; break; }
    }
    if (s < 0) for (let k = 0; k < 3; k++) if (hs[T[3 * t + k]].length === 1) { s = hs[T[3 * t + k]][0][0]; break; }
    if (s >= 0) { labels[t] = s; queue.push(t); }
  }
  for (let q = 0; q < queue.length; q++) {
    const t = queue[q];
    for (let k = 0; k < 3; k++) {
      const e = 3 * t + k, o = HE[e];
      if (o < 0) continue;
      const u = Math.floor(o / 3);
      if (labels[u] >= 0 || step.has(T[e] * n + T[3 * t + (k + 1) % 3])) continue;
      labels[u] = labels[t];
      queue.push(u);
    }
  }
  for (let t = 0; t < nt; t++) {
    if (labels[t] >= 0) continue;
    let s = 0;
    for (const [q] of hs[T[3 * t]]) if (has(T[3 * t + 1], q) && has(T[3 * t + 2], q)) { s = q; break; }
    labels[t] = s;
  }
  const first = new Uint32Array(n + 1);
  hs.forEach((x, i) => { first[i + 1] = first[i] + x.length; });
  const side = new Int32Array(first[n]), height = new Float32Array(first[n]);
  hs.forEach((x, i) => x.forEach(([s, h], k) => { side[first[i] + k] = s; height[first[i] + k] = h; }));
  return { box: f.box, coords, tri: Uint32Array.from(T), labels, first, side, height, segs: Int32Array.from(segs), kept, lost };
}

// Which triangle each point of a regular grid lies in, and the height there (a.s.l.) on
// that triangle's own side, as the sampler reads it: the points ox + i·res, oy + j·res
// in metres from the box's corner, i < nx, j < ny; -1 and NaN where no triangle covers
// one. One pass over the triangles, each filling the points inside it, instead of
// looking up each point's triangle as the sampler does.
export function tinGrid(m: TinMesh, ox: number, oy: number, nx: number, ny: number, res: number) {
  const { coords: C, tri: T, labels, first, side: S, height: H } = m, nt = T.length / 3;
  const tri = new Int32Array(nx * ny).fill(-1), h = new Float32Array(nx * ny).fill(NaN);
  const hOf = (v: number, s: number) => { for (let k = first[v]; k < first[v + 1]; k++) if (S[k] === s) return H[k]; return H[first[v]]; };
  for (let t = 0; t < nt; t++) {
    const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2], s = labels[t];
    const ax = C[2 * a], ay = C[2 * a + 1], bx = C[2 * b], by = C[2 * b + 1], cx = C[2 * c], cy = C[2 * c + 1];
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - ox) / res - 1e-6)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - ox) / res + 1e-6));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - oy) / res - 1e-6)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - oy) / res + 1e-6));
    if (i0 > i1 || j0 > j1) continue;
    const ha = hOf(a, s), hb = hOf(b, s), hc = hOf(c, s);
    const gx = ((hb - ha) * (cy - ay) - (hc - ha) * (by - ay)) / det, gy = ((hc - ha) * (bx - ax) - (hb - ha) * (cx - ax)) / det;
    // Inside: on the inner side of all three edges, with the sampler's tolerance.
    const sg = det > 0 ? 1 : -1, e = -1e-7 * Math.abs(det);
    for (let j = j0; j <= j1; j++) {
      const py = oy + j * res;
      for (let i = i0; i <= i1; i++) {
        const q = j * nx + i;
        if (tri[q] >= 0) continue;
        const px = ox + i * res;
        if (sg * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < e || sg * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) < e
          || sg * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) < e) continue;
        tri[q] = t;
        h[q] = ha + gx * (px - ax) + gy * (py - ay);
      }
    }
  }
  return { tri, h };
}

// The points of the grid i·res, j·res (n × n, metres from the box's corner) within
// `reach` of a breakline piece with two sides (a wall, the water's edge), where the
// sampler reads heights off the piece and not the triangles (tinSampler, `ON`).
export function tinNearSteps(m: TinMesh, n: number, res: number, reach: number) {
  const near = new Uint8Array(n * n), C = m.coords, sg = m.segs, r2 = reach * reach;
  for (let q = 0; q < sg.length / 4; q++) {
    if (sg[4 * q + 2] === sg[4 * q + 3]) continue;
    const a = sg[4 * q], b = sg[4 * q + 1], ax = C[2 * a], ay = C[2 * a + 1], dx = C[2 * b] - ax, dy = C[2 * b + 1] - ay, L2 = dx * dx + dy * dy || 1;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, ax + dx) - reach) / res)), i1 = Math.min(n - 1, Math.floor((Math.max(ax, ax + dx) + reach) / res));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, ay + dy) - reach) / res)), j1 = Math.min(n - 1, Math.floor((Math.max(ay, ay + dy) + reach) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = i * res, py = j * res, u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
      const ex = ax + dx * u - px, ey = ay + dy * u - py;
      if (ex * ex + ey * ey <= r2) near[j * n + i] = 1;
    }
  }
  return near;
}

// The TIN's height above `ref` at (x, y) in the game's map metres, `fallback` off it.
// `side` as heightSampler takes it: a label, true for the water, false for whatever is there.
export function tinSampler(m: TinMesh, ref: number, fallback: (x: number, y: number, side?: number | boolean) => number) {
  // (Cells over the tile; a map's last row and column of tiles are narrower.)
  const [x0, y0, x1, y1] = m.box, W = x1 - x0, cell = 4, nc = Math.ceil(W / cell) + 1, nr = Math.ceil((y1 - y0) / cell) + 1;
  const { coords: C, tri: T } = m, nt = T.length / 3;
  const start = new Int32Array(nc * nr + 1), lists: number[][] = Array.from({ length: nc * nr }, () => []);
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
    const S = m.side, H = m.height, a = m.first[v], b = m.first[v + 1];
    for (let k = a; k < b; k++) if (S[k] === s) return H[k];
    for (let k = a; k < b; k++) if (S[k] === own) return H[k];
    return H[a];
  };
  // The triangle at a point; with `want`, the nearest triangle of that side within
  // NEAR, the point clamped onto it. (The game's step outlines and the TIN's thinned
  // step lines are a few centimetres apart: a point on the outline asked for one side
  // can lie in a triangle of the other, whose corners off the line have only its own
  // heights, and the wall's top took a mix of both.)
  const NEAR = 0.5;
  const find = (lx: number, ly: number, want = -1): readonly [number, number, number, number] | null => {
    const ci = Math.floor(lx / cell), cj = Math.floor(ly / cell);
    let best: readonly [number, number, number, number] | null = null, bestD = NEAR;
    // Its own cell first; for a side asked for, the cells round it too (NEAR reaches them).
    const cells = [cj * nc + ci];
    if (want >= 0) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++)
      if ((di || dj) && ci + di >= 0 && ci + di < nc && cj + dj >= 0 && cj + dj < nr) cells.push((cj + dj) * nc + ci + di);
    for (const c of cells) for (let q = start[c]; q < start[c + 1]; q++) {
      const t = flat[q], a = T[3 * t], b = T[3 * t + 1], d = T[3 * t + 2];
      const ax = C[2 * a], ay = C[2 * a + 1], bx = C[2 * b], by = C[2 * b + 1], cx = C[2 * d], cy = C[2 * d + 1];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((by - cy) * (lx - cx) + (cx - bx) * (ly - cy)) / det, l2 = ((cy - ay) * (lx - cx) + (ax - cx) * (ly - cy)) / det, l3 = 1 - l1 - l2;
      const inside = l1 >= -1e-7 && l2 >= -1e-7 && l3 >= -1e-7;
      if (want < 0 || m.labels[t] === want) {
        if (inside) return [t, l1, l2, l3] as const;
        if (want < 0) continue;
        // How far outside: to the nearest point of the triangle, by its clamped weights.
        const k1 = Math.max(0, l1), k2 = Math.max(0, l2), k3 = Math.max(0, l3), ks = k1 + k2 + k3;
        const px = (k1 * ax + k2 * bx + k3 * cx) / ks, py = (k1 * ay + k2 * by + k3 * cy) / ks, dd = Math.hypot(px - lx, py - ly);
        if (dd < bestD) { bestD = dd; best = [t, k1 / ks, k2 / ks, k3 / ks] as const; }
      }
    }
    return best ?? (want >= 0 ? find(lx, ly) : null);
  };
  // The step pieces by cell, for a side's height right at a step: read off the nearest
  // piece with that side (within ON), not the triangles, whose sides near a step line
  // the game's outline doesn't quite follow. Only pieces with two sides: a kerb has one,
  // and the ground beside it is the triangles' (it read a band 0.6 m wide along every
  // kerb at the kerb line's height).
  const ON = 0.3, sg = m.segs, ns = sg.length / 4;
  const sStart = new Int32Array(nc * nr + 1), sLists: number[][] = Array.from({ length: nc * nr }, () => []);
  for (let q = 0; q < ns; q++) {
    if (sg[4 * q + 2] === sg[4 * q + 3]) continue;
    const a = sg[4 * q], b = sg[4 * q + 1];
    const ax = Math.min(C[2 * a], C[2 * b]) - ON, bx = Math.max(C[2 * a], C[2 * b]) + ON, ay = Math.min(C[2 * a + 1], C[2 * b + 1]) - ON, by = Math.max(C[2 * a + 1], C[2 * b + 1]) + ON;
    for (let j = Math.max(0, Math.floor(ay / cell)); j <= Math.min(nr - 1, Math.floor(by / cell)); j++)
      for (let i = Math.max(0, Math.floor(ax / cell)); i <= Math.min(nc - 1, Math.floor(bx / cell)); i++) sLists[j * nc + i].push(q);
  }
  let sTotal = 0;
  for (let c = 0; c < sLists.length; c++) { sStart[c] = sTotal; sTotal += sLists[c].length; }
  sStart[sLists.length] = sTotal;
  const sFlat = new Int32Array(sTotal);
  sLists.forEach((l, c) => sFlat.set(l, sStart[c]));
  const onStep = (lx: number, ly: number, want: number) => {
    const c = Math.floor(ly / cell) * nc + Math.floor(lx / cell);
    let best = NaN, bestD = ON;
    for (let q = sStart[c]; q < sStart[c + 1]; q++) {
      const k = sFlat[q], a = sg[4 * k], b = sg[4 * k + 1];
      if (sg[4 * k + 2] !== want && sg[4 * k + 3] !== want) continue;
      const ax = C[2 * a], ay = C[2 * a + 1], dx = C[2 * b] - ax, dy = C[2 * b + 1] - ay, L2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((lx - ax) * dx + (ly - ay) * dy) / L2));
      const d = Math.hypot(ax + dx * u - lx, ay + dy * u - ly);
      if (d < bestD) { bestD = d; best = hOf(a, want, want) * (1 - u) + hOf(b, want, want) * u; }
    }
    return best;
  };
  const sample = (x: number, y: number, side: number | boolean = false) => {
    const lx = x - x0, ly = y - y0;
    if (!(lx >= 0 && lx <= W && ly >= 0 && ly <= y1 - y0)) return fallback(x, y, side);
    const want = side === true ? WATER : side === false ? -1 : side;
    if (want >= 0) {
      const h = onStep(lx, ly, want);
      if (Number.isFinite(h)) return h - ref;
    }
    const f = find(lx, ly, want);
    if (!f) return fallback(x, y, side);
    const [t, l1, l2, l3] = f, own = m.labels[t];
    const s = want >= 0 ? want : own;
    return l1 * hOf(T[3 * t], s, own) + l2 * hOf(T[3 * t + 1], s, own) + l3 * hOf(T[3 * t + 2], s, own) - ref;
  };
  const labelAt = (x: number, y: number) => { const f = find(x - x0, y - y0); return f ? m.labels[f[0]] : -1; };
  return { sample, labelAt };
}
