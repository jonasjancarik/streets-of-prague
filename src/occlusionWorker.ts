// The worker for occlusion.ts: keeps the drawn tiles' occluder grids and sweeps from
// the eye when asked (occlusionSweep.ts).
import { CELL, N, HALF, sweep, type SweepAsk } from './occlusionSweep.ts';

export type CullMessage =
  | { type: 'tile'; key: string; box: [number, number, number, number]; grid: Float32Array }
  | { type: 'sweep'; id: number; keys: string[]; ask: SweepAsk };

const tiles = new Map<string, { box: [number, number, number, number]; grid: Float32Array }>();

self.onmessage = (e: MessageEvent<CullMessage>) => {
  const m = e.data;
  if (m.type === 'tile') { tiles.set(m.key, { box: m.box, grid: m.grid }); return; }
  // Only the tiles asked for count; the others are forgotten.
  const keys = new Set(m.keys);
  for (const k of tiles.keys()) if (!keys.has(k)) tiles.delete(k);
  const { ex, ey } = m.ask;
  const x0 = (Math.floor(ex / CELL) - HALF) * CELL, y0 = (Math.floor(ey / CELL) - HALF) * CELL;
  const occ = new Float32Array(N * N).fill(-Infinity);
  for (const k of m.keys) {
    const t = tiles.get(k);
    if (!t) continue;
    const [bx0, by0, bx1] = t.box, n = Math.round((bx1 - bx0) / CELL);
    const gi = Math.round((bx0 - x0) / CELL), gj = Math.round((by0 - y0) / CELL);
    const i0 = Math.max(0, -gi), i1 = Math.min(n, N - gi);
    if (i0 >= i1) continue;
    // (Tiles don't overlap: their rows are copied as they are.)
    for (let j = Math.max(0, -gj); j < n && gj + j < N; j++) occ.set(t.grid.subarray(j * n + i0, j * n + i1), (gj + j) * N + gi + i0);
  }
  const r = sweep(occ, m.ask);
  (self as unknown as Worker).postMessage({ id: m.id, keys: m.keys, result: r }, [r.seen.buffer, r.horizon.buffer, r.patch.buffer, ...r.mins.map((v) => v.buffer)]);
};
