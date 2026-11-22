// The sweep behind occlusion.ts, run in its worker (occlusionWorker.ts): from an eye,
// over a height grid of the buildings round it, the lowest height at which anything in
// each cell can be seen. The result comes back a frame or two later, while the eye
// moves on, so it is made to hold for an eye anywhere within `slack` metres sideways
// and `rise` metres up or down of where it was asked for:
//
// - Sideways: a sightline from the moved eye E' to a target T and the one from E to T
//   pass any occluder at the same share of the way to T (the distances' ratio, which
//   is all that decides whether T shows over it, is the same), and the two lines are
//   never more than `slack` apart. So the occluders are shrunk by `slack` more: where
//   the line from E meets what is left, the line from E' meets the building.
// - Up: a higher eye sees more of everything behind the columns, so the sweep is from
//   the highest the eye can be. A lower one sees less.
// - Inside a building: the eye's own cell is checked on the main thread against the
//   patch of grid round it the result carries.

export const CELL = 2; // metres a cell of the occluder grid
export const REACH = 400; // as far as the street views draw (EYES_REACH in main.ts)
export const N = Math.ceil((2 * REACH) / CELL) + 1; // cells a side of the sweep's window
export const HALF = (N - 1) / 2;
export const SECTORS = 1024; // directions round the eye for what lies beyond the window
export const LEVELS = [4, 16, 64]; // blocks of cells the minimums are kept for

export interface SweepAsk { ex: number; ey: number; ez: number; slack: number; rise: number }
export interface SweepResult {
  ok: boolean;
  // The window's lower corner (game metres, y north) and the eye it was swept from.
  x0: number; y0: number; ex: number; ey: number; ez: number; slack: number; rise: number;
  // The lowest height seen in each cell (-Infinity: anything), its minimums over the
  // LEVELS' blocks, and beyond the window, the lowest slope in each of SECTORS
  // directions, from the eye `rise` up.
  seen: Float32Array; mins: Float32Array[]; horizon: Float32Array;
  // The occluders (before the shrinking) in the cells within `around` of the eye's.
  around: number; patch: Float32Array;
  ms: number;
}

// Each cell's distance from the window's middle cell, less and plus how far the eye can
// be from that cell's centre.
const NEAR = new Float32Array(N * N), FAR = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const d = Math.hypot(i - HALF, j - HALF) * CELL;
  NEAR[j * N + i] = Math.max(0, d - CELL * Math.SQRT1_2); FAR[j * N + i] = d + CELL * Math.SQRT1_2;
}

// The window of occluders (absolute tops, -Infinity where open) is `occ`, aligned so
// that the eye is in its middle cell. The shrinking is done in it in place.
export function sweep(occ: Float32Array, { ex, ey, ez, slack, rise }: SweepAsk): SweepResult {
  const t0 = performance.now();
  const ci = Math.floor(ex / CELL), cj = Math.floor(ey / CELL), c = HALF;
  const x0 = (ci - HALF) * CELL, y0 = (cj - HALF) * CELL;
  const mins = LEVELS.map((b) => new Float32Array(Math.ceil(N / b) ** 2));
  const seen = new Float32Array(N * N), horizon = new Float32Array(SECTORS).fill(Infinity);
  // Cells a point can be from one `slack` away from it (in the same or any cell).
  const k = slack > 0 ? Math.floor(slack / CELL) + 1 : 0, around = k + 1;
  const patch = new Float32Array((2 * around + 1) ** 2);
  for (let dj = -around; dj <= around; dj++) for (let di = -around; di <= around; di++) {
    patch[(dj + around) * (2 * around + 1) + di + around] = occ[(c + dj) * N + c + di];
  }
  const out: SweepResult = { ok: false, x0, y0, ex, ey, ez, slack, rise, seen, mins, horizon, around, patch, ms: 0 };
  if (occ[c * N + c] > ez - 0.3) { out.ms = performance.now() - t0; return out; }
  shrink(occ, k);
  const top = ez + rise;
  const ox = (ci + 0.5) * CELL - ex, oy = (cj + 0.5) * CELL - ey; // the eye's cell centre from the eye
  const ix = c + 0.5 - ox / CELL, iy = c + 0.5 - oy / CELL; // the eye in cell units
  const slope = new Float32Array(N * N).fill(Infinity);
  // Rays from the eye to every edge cell of the window, cell by cell (a grid walk).
  // Each cell keeps the lowest slope a ray reached it with (the steepest it had to
  // climb over what lay before), then the ray counts the cell's own occluder (from the
  // ray's entry into the cell: the shrunk cells are solid all over).
  const ray = (ti: number, tj: number) => {
    const dx = ti + 0.5 - ix, dy = tj + 0.5 - iy;
    const stepI = dx > 0 ? 1 : -1, stepJ = dy > 0 ? 1 : -1;
    const tdI = dx ? Math.abs(1 / dx) : Infinity, tdJ = dy ? Math.abs(1 / dy) : Infinity;
    let i = Math.floor(ix), j = Math.floor(iy);
    let tI = dx ? (dx > 0 ? i + 1 - ix : ix - i) * tdI : Infinity, tJ = dy ? (dy > 0 ? j + 1 - iy : iy - j) * tdJ : Infinity;
    const len = Math.hypot(dx, dy) * CELL;
    let run = -Infinity;
    while (true) {
      let t: number;
      if (tI < tJ) { t = tI; tI += tdI; i += stepI; } else { t = tJ; tJ += tdJ; j += stepJ; }
      if (t > 1 || i < 0 || j < 0 || i >= N || j >= N) break;
      const p = j * N + i;
      if (run < slope[p]) slope[p] = run;
      const o = occ[p];
      if (o !== -Infinity) { const v = (o - top) / Math.max(t * len, 0.5); if (v > run) run = v; }
    }
    const a = Math.atan2(dy, dx), q = Math.floor(((a / (2 * Math.PI)) + 1) * SECTORS) % SECTORS;
    for (const r of [q - 1, q, q + 1]) { const w = (r + SECTORS) % SECTORS; if (run < horizon[w]) horizon[w] = run; }
  };
  for (let e = 0; e < N; e++) { ray(0, e); ray(N - 1, e); ray(e, 0); ray(e, N - 1); }
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) slope[(c + dj) * N + c + di] = -Infinity;
  for (let p = 0; p < N * N; p++) {
    const s = slope[p];
    seen[p] = s === -Infinity || s === Infinity ? -Infinity : top + s * (s > 0 ? NEAR[p] : FAR[p]);
  }
  // Each level from the one below it.
  let below: Float32Array = seen, bn = N, bb = 1;
  LEVELS.forEach((b, l) => {
    const n = Math.ceil(N / b), v = mins[l], f = b / bb;
    v.fill(Infinity);
    for (let j = 0; j < bn; j++) {
      const row = Math.floor(j / f) * n;
      for (let i = 0; i < bn; i++) { const q = row + Math.floor(i / f), x = below[j * bn + i]; if (x < v[q]) v[q] = x; }
    }
    below = v; bn = n; bb = b;
  });
  out.ok = true;
  out.ms = performance.now() - t0;
  return out;
}

// Each cell the lowest of those within k cells of it either way (a square round it),
// along the rows, then the columns; outside the window counts as open.
function shrink(occ: Float32Array, k: number) {
  const row = new Float32Array(N);
  for (let j = 0; j < N; j++) {
    const o = j * N;
    for (let i = 0; i < N; i++) row[i] = occ[o + i];
    for (let i = 0; i < N; i++) {
      if (row[i] === -Infinity) continue;
      let m = i < k || i >= N - k ? -Infinity : row[i];
      for (let d = 1; d <= k && m !== -Infinity; d++) m = Math.min(m, row[i - d], row[i + d]);
      occ[o + i] = m;
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) row[j] = occ[j * N + i];
    for (let j = 0; j < N; j++) {
      if (row[j] === -Infinity) continue;
      let m = j < k || j >= N - k ? -Infinity : row[j];
      for (let d = 1; d <= k && m !== -Infinity; d++) m = Math.min(m, row[j - d], row[j + d]);
      occ[j * N + i] = m;
    }
  }
}
