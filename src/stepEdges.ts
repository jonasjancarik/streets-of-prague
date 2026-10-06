// The tops of the steps in the ground (quay walls, retaining walls: terrain.ts): where
// a step is high enough to fall off, its edge stops cars and people like a wall, and
// has a parapet along it. Open where a street, a path or stairs really crosses the
// step, and where the step is low (the top of a ramp). Runs in the tile workers.
import { onPolygons } from './map/geo.ts';
import type { Bounds, Point2, Polygons } from './map/geo.ts';
import { WATER } from './terrain.ts';
import type { Terrace } from './terrain.ts';

export const EDGE_DROP = 0.8; // m: a lower step is one you drive or walk down
const PIECE = 1; // m: an edge is judged piece by piece
const PARAPET_WATER = 2.5; // m above the water: a lower quay has no parapet (the water stops you)
const SQUARE = 0.35; // sine of the angle to the edge: a way running along it doesn't cross it
const PARAPET_H = 0.9, PARAPET_W = 0.4; // m
const CELL = 8;

type HeightAt = (x: number, y: number, side?: number | boolean) => number;
// A way that may cross a step: its centre line and half its width.
export interface Crosser { pts: Point2[]; half: number; hw?: string }
// A piece of a step's top edge: from a to b, (nx, ny) towards the higher ground, whose
// heights at the two ends are ha and hb, `drop` m above the lower (`wet`: the water). `parapet`: one stands on it. `first`, `last`:
// the edge starts or stops here (a gap, the step's end).
export interface StepEdge { a: Point2; b: Point2; nx: number; ny: number; ha: number; hb: number; drop: number; wet: boolean; parapet: boolean; first: boolean; last: boolean }

// Which side of the steps a point is on (its label), and the steps' outlines: the water
// as the terrain has it (else the map's) and the terraces. null with no steps.
export function stepSides(steps: Terrace[] | null | undefined, mapWater: Polygons) {
  const water = steps?.find((t) => t.label === WATER)?.polys ?? mapWater;
  const terraces = (steps ?? []).filter((t) => t.label !== WATER);
  if (!steps || !(water.length || terraces.length)) return null;
  // (The flat terraces, the last of a street before its bridge, lie over the water too.)
  const wet = onPolygons(water), on = terraces.map((t) => onPolygons(t.polys));
  const at = (x: number, y: number) => {
    for (let k = 0; k < on.length; k++) if (terraces[k].h !== undefined && on[k](x, y)) return terraces[k].label;
    if (wet(x, y)) return WATER;
    for (let k = 0; k < on.length; k++) if (terraces[k].h === undefined && on[k](x, y)) return terraces[k].label;
    return 0;
  };
  return { at, outlines: [...water, ...terraces.flatMap((t) => t.polys)] };
}

// The edges to stop at in a tile. `height`: the terrain with its sides (heightSampler);
// `box`: the tile, whose border the clipped outlines run along; `ways`: what may cross;
// `crossed`: told of each crossing and the way's direction there (for the checks).
export function stepEdges(steps: Terrace[] | null | undefined, mapWater: Polygons, height: HeightAt, [x0, y0, x1, y1]: Bounds, ways: Crosser[],
  crossed: ((way: Crosser, x: number, y: number, drop: number, dx: number, dy: number) => void) | null = null): StepEdge[] {
  const sides = stepSides(steps, mapWater);
  if (!sides) return [];
  const cut = (a: Point2, b: Point2) => ([[0, x0], [0, x1], [1, y0], [1, y1]] as [0 | 1, number][]).some(([k, v]) => Math.abs(a[k] - v) < 0.05 && Math.abs(b[k] - v) < 0.05);
  const found: StepEdge[] = [];
  for (const rings of sides.outlines) {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len < 1e-6 || cut(a, b)) continue;
        // The sides on the left of a → b and on its right, as the walls are drawn (ground.ts).
        const nx = -dy / len, ny = dx / len, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const left = sides.at(mx + nx * 0.2, my + ny * 0.2), right = sides.at(mx - nx * 0.2, my - ny * 0.2);
        if (left === right) continue;
        const n = Math.max(1, Math.ceil(len / PIECE));
        for (let k = 0; k < n; k++) {
          const p: Point2 = [a[0] + dx * (k / n), a[1] + dy * (k / n)], r: Point2 = [a[0] + dx * ((k + 1) / n), a[1] + dy * ((k + 1) / n)];
          const pl = height(p[0], p[1], left), pr = height(p[0], p[1], right), rl = height(r[0], r[1], left), rr = height(r[0], r[1], right);
          const drop = (pl + rl - pr - rr) / 2; // the left above the right
          if (!(Math.abs(drop) >= EDGE_DROP)) continue;
          // (A bank lower than the water is no wall, see stepWalls.)
          if (left === WATER ? drop > 0 : right === WATER && drop < 0) continue;
          const up = drop > 0 ? 1 : -1, wet = (drop > 0 ? right : left) === WATER;
          found.push({ a: p, b: r, nx: nx * up, ny: ny * up, ha: Math.max(pl, pr), hb: Math.max(rl, rr), drop: Math.abs(drop), wet, parapet: !wet || Math.abs(drop) >= PARAPET_WATER, first: false, last: false });
        }
      }
    }
  }
  if (!found.length) return found;
  // Where a way crosses an edge, the edge is open over the way's width.
  const cells = new Map<number, number[]>(), key = (cx: number, cy: number) => (cx + 32768) * 65536 + cy + 32768;
  found.forEach((e, k) => {
    const c = key(Math.floor((e.a[0] + e.b[0]) / 2 / CELL), Math.floor((e.a[1] + e.b[1]) / 2 / CELL));
    const cell = cells.get(c);
    if (cell) cell.push(k); else cells.set(c, [k]);
  });
  const gaps: [number, number, number][] = [];
  for (const w of ways) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [cx, cy] = w.pts[i], [ex, ey] = w.pts[i + 1], wx = ex - cx, wy = ey - cy, wl = Math.hypot(wx, wy);
      if (wl < 1e-6) continue;
      for (let gx = Math.floor((Math.min(cx, ex) - PIECE) / CELL); gx <= Math.floor((Math.max(cx, ex) + PIECE) / CELL); gx++) {
        for (let gy = Math.floor((Math.min(cy, ey) - PIECE) / CELL); gy <= Math.floor((Math.max(cy, ey) + PIECE) / CELL); gy++) {
          for (const k of cells.get(key(gx, gy)) ?? []) {
            const e = found[k], px = e.b[0] - e.a[0], py = e.b[1] - e.a[1], pl = Math.hypot(px, py);
            const den = wx * py - wy * px;
            if (Math.abs(den) < SQUARE * wl * pl) continue;
            const t = ((e.a[0] - cx) * py - (e.a[1] - cy) * px) / den, u = ((e.a[0] - cx) * wy - (e.a[1] - cy) * wx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            gaps.push([cx + wx * t, cy + wy * t, w.half]);
            crossed?.(w, cx + wx * t, cy + wy * t, e.drop, wx / wl, wy / wl);
          }
        }
      }
    }
  }
  const kept = found.filter((e) => {
    const mx = (e.a[0] + e.b[0]) / 2, my = (e.a[1] + e.b[1]) / 2;
    return !gaps.some(([x, y, half]) => Math.hypot(x - mx, y - my) < half + PIECE / 2);
  });
  for (let k = 0; k < kept.length; k++) {
    const e = kept[k], before = kept[k - 1], after = kept[k + 1];
    e.first = !before || Math.hypot(before.b[0] - e.a[0], before.b[1] - e.a[1]) > 0.01;
    e.last = !after || Math.hypot(after.a[0] - e.b[0], after.a[1] - e.b[1]) > 0.01;
  }
  return kept;
}

// The edges in a collision grid (`cells`, rows from the north, `res` cells per metre,
// `px`: a point's column and row): solid from the wall's face to half a metre back
// from the edge, so a car stops with its wheels on the ground.
export function stampEdges(edges: StepEdge[], cells: Uint8Array, w: number, h: number, px: (x: number, y: number) => [number, number]) {
  for (const e of edges) {
    const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]), n = Math.max(1, Math.ceil(len / 0.25));
    for (let s = 0; s <= n; s++) {
      const x = e.a[0] + (e.b[0] - e.a[0]) * s / n, y = e.a[1] + (e.b[1] - e.a[1]) * s / n;
      for (let d = -0.25; d <= 0.5; d += 0.25) {
        const [u, v] = px(x + e.nx * d, y + e.ny * d), i = Math.floor(u), j = Math.floor(v);
        if (i >= 0 && j >= 0 && i < w && j < h) cells[j * w + i] = 255;
      }
    }
  }
}

// The parapets as the walls are drawn (wallArrays in map/buildings.ts): the outer face
// flush with the step's wall.
export function parapetArrays(edges: StepEdge[]) {
  const pos: number[] = [], nor: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    for (const p of [a, b, c, a, c, d]) {
      pos.push(p[0], p[2], -p[1]);
      nor.push(n[0], n[2], -n[1]);
    }
  };
  for (const e of edges) {
    if (!e.parapet) continue;
    const ox = e.nx * PARAPET_W, oy = e.ny * PARAPET_W, sink = 0.1;
    const A = [e.a[0], e.a[1]], B = [e.b[0], e.b[1]], Ai = [A[0] + ox, A[1] + oy], Bi = [B[0] + ox, B[1] + oy];
    const a0 = e.ha - sink, a1 = e.ha + PARAPET_H, b0 = e.hb - sink, b1 = e.hb + PARAPET_H;
    quad([...A, a0], [...B, b0], [...B, b1], [...A, a1], [-e.nx, -e.ny, 0]);
    quad([...Bi, b0], [...Ai, a0], [...Ai, a1], [...Bi, b1], [e.nx, e.ny, 0]);
    quad([...A, a1], [...B, b1], [...Bi, b1], [...Ai, a1], [0, 0, 1]);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, tx = (B[0] - A[0]) / len, ty = (B[1] - A[1]) / len;
    if (e.first) quad([...Ai, a0], [...A, a0], [...A, a1], [...Ai, a1], [-tx, -ty, 0]);
    if (e.last) quad([...B, b0], [...Bi, b0], [...Bi, b1], [...B, b1], [tx, ty, 0]);
  }
  return { position: new Float32Array(pos), normal: new Float32Array(nor) };
}
