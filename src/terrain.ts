// A tile's terrain (pipeline/ipr_terrain.py): n × n heights every `step` metres from the
// tile's south-west corner, as uint16 decimetres above 100 m a.s.l. (`unit` metres each:
// a prototype's are centimetres), then each point's label as a byte. Used on the main
// thread and in the tile workers alike.
import { onPolygons } from './map/geo.ts';
import type { Polygons } from './map/geo.ts';

// Heights in metres above `ref` (the game's y = 0).
export function decodeHeights(buffer: ArrayBuffer, n: number, ref: number, unit = 0.1) {
  const h = new Uint16Array(buffer, 0, n * n), hm = new Float32Array(n * n);
  for (let i = 0; i < hm.length; i++) hm[i] = h[i] * unit + 100 - ref;
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
// A tile's terrace: its label in the terrain and its outline. Under WATER, the tile's
// water as the terrain has it, where that's not simply the map's (the map's water runs on
// under streets it doesn't call bridges).
// With `h` (m a.s.l.) it's flat at that height whatever the lattice says: the last metres
// of a street before its bridge, too small for the lattice (pipeline/structures.py, pads).
export interface Terrace { label: number; polys: Polygons; h?: number }

// The flat terraces' heights above `ref` by label, or null with none.
export function flatTerraces(all: Terrace[] | null | undefined, ref: number) {
  const flat = new Map<number, number>();
  for (const t of all ?? []) if (t.h !== undefined) flat.set(t.label, t.h - ref);
  return flat.size ? flat : null;
}

// Which terrace a point is on (its label), or 0 for none. (The flat ones first: they lie
// over whatever else is there.)
export function terraceAt(all: Terrace[] | null | undefined) {
  const terraces = (all ?? []).filter((t) => t.label !== WATER).sort((a, b) => Number(b.h !== undefined) - Number(a.h !== undefined));
  if (!terraces.length) return null;
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

// Stairs on a bridge level (pipeline/structures.py, ramps): steeper and narrower than the
// lattice can hold, so they come with their own profile, a line with a height (m a.s.l.)
// at each point, `w` wide.
export interface Ramp { w: number; pts: [number, number, number][] }

// A level's height at a point: on its stairs their own profile, elsewhere `base` (the
// level's lattice). `ref`: the game's zero in metres a.s.l.
export function withRamps(base: (x: number, y: number) => number, ramps: Ramp[] | null | undefined, ref: number) {
  if (!ramps?.length) return base;
  const boxes = ramps.map(({ w, pts }) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const r = w / 2 + 0.05;
    return [x0 - r, y0 - r, x1 + r, y1 + r, r];
  });
  return (x: number, y: number) => {
    let best = Infinity, h = NaN;
    for (let k = 0; k < ramps.length; k++) {
      const b = boxes[k];
      if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) continue;
      const pts = ramps[k].pts, last = pts.length - 2;
      for (let i = 0; i <= last; i++) {
        const [ax, ay, ah] = pts[i], [bx, by, bh] = pts[i + 1], dx = bx - ax, dy = by - ay;
        const t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1);
        // (Square ends: nothing past the stairs' first or last point.)
        if ((t < 0 && i === 0) || (t > 1 && i === last)) continue;
        const k2 = Math.max(0, Math.min(1, t)), d = Math.hypot(x - ax - dx * k2, y - ay - dy * k2);
        if (d <= b[4] && d < best) { best = d; h = ah + (bh - ah) * k2 - ref; }
      }
    }
    return best < Infinity ? h : base(x, y);
  };
}

// How a point by a step gets its height (heightSampler): `plane`, from its own side's
// slope (sidePlane); off, from its own side's corners of the cell alone, which is flat
// across the cell where it has one (a wall running down a hill had a staircase for a top).
// `lines`: from the tile's step lines where it has them (stepLineIndex).
export const sampling = { plane: false, lines: true };

// A stand-in height at lattice point (p0, q0), which is on another side of a step, for
// the side `want`: the plane through that side's points within two steps of it (least
// squares, the nearer the more), there. Every cell with that point for a corner reads the
// same, so the ground on each side keeps its own slope up to the step, and doesn't jump
// from cell to cell. NaN with none of that side about.
function sidePlane(hm: Float32Array, labels: Uint8Array, n: number, p0: number, q0: number, want: number) {
  let s0 = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sz = 0, sxz = 0, syz = 0, lo = Infinity, hi = -Infinity;
  for (let q = Math.max(0, q0 - 2); q <= Math.min(n - 1, q0 + 2); q++) {
    for (let p = Math.max(0, p0 - 2); p <= Math.min(n - 1, p0 + 2); p++) {
      if (labels[q * n + p] !== want) continue;
      const z = hm[q * n + p];
      if (Number.isNaN(z)) continue;
      const dx = p - p0, dy = q - q0, w = 1 / (dx * dx + dy * dy);
      s0 += w; sx += w * dx; sy += w * dy; sxx += w * dx * dx; sxy += w * dx * dy; syy += w * dy * dy;
      sz += w * z; sxz += w * dx * z; syz += w * dy * z;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  if (!s0) return NaN;
  const mx = sx / s0, my = sy / s0, mz = sz / s0;
  const cxx = sxx / s0 - mx * mx, cxy = sxy / s0 - mx * my, cyy = syy / s0 - my * my;
  const cxz = sxz / s0 - mx * mz, cyz = syz / s0 - my * mz, det = cxx * cyy - cxy * cxy;
  let gx = 0, gy = 0;
  if (det > 0.01) { gx = (cxz * cyy - cyz * cxy) / det; gy = (cyz * cxx - cxz * cxy) / det; }
  // (Its points all in a row: the slope along the row.)
  else if (cxx > 0.05 && cxx >= cyy) gx = cxz / cxx;
  else if (cyy > 0.05) gy = cyz / cyy;
  // (Never further out than its points' own spread, should the plane be a poor one.)
  const span = hi - lo;
  return Math.max(lo - span, Math.min(hi + span, mz - gx * mx - gy * my));
}

// A step in the ground as a line (pipeline/step_lines.py, a trial): `l` and `r` the
// labels on its left and right, and at each point the ground's height (m a.s.l.) on
// either side, smoothed along the line (null where there was none to read).
export interface StepLine { l: number; r: number; pts: [number, number, number | null, number | null][] }
export interface StepLineIndex { cell: (x: number, y: number) => number[] | undefined; near: (x: number, y: number, want: number, pieces: number[], loose: number, ground: number) => [number, number] }

const ON_LINE = 0.3; // m: this near a step line, a point may be on either side of it
const FACING = 0.3; // past a line's end, its say fades as a point comes round to the other side (cosines)
const HOLD = 1; // m from a step line where it has the say whatever the lattice's cell
// m: a line this far from the lattice's height at a point has its full say there, and none
// from twice as far: it's another place's ground with the same label (the hillside past a
// small terrace by the street at K Vlásence, an embankment over Prokopova). A third more
// on the line itself (to ON_LINE / 2), where the walls' tops and feet are read and the
// lattice's staircase is worst. Not on a map in centimetres, whose ground is the scan
// (ipr_terrain.py --lidar-ground): its lattice blurs each wall into a ramp, so a line read
// from the scan may well be metres off it (nábřeží Edvarda Beneše and Chotkova got their
// sawtooth back).
const AGREE = 1.5;
// How far from a step its line has the say over the lattice (heightSampler): past where
// the lattice's points by a step read one corner and its ramp.
export const lineReach = (step: number) => Math.max(3, 1.5 * step);

// A tile's step lines for heightSampler, their heights above `ref`, or null with none.
// `unit`: the map's height unit (index.json's terrain).
// `near(x, y, want, pieces, loose)`: of each line within `reach` with the side `want`,
// its height on that side at the nearest point, weighted 1 at the line to 0 at `reach`,
// and only on that side of it: the same label past the line is another place (the
// street below a terrace and the hillside above it). Past HOLD from the line, the weight
// is only `loose`: how much of the lattice's cell there is another side's. A line far off
// `ground`, the lattice's height there, has less say (AGREE). [sum of weight × height,
// sum of weights].
export function stepLineIndex(lines: StepLine[] | null | undefined, ref: number, reach: number, unit = 0.1): StepLineIndex | null {
  if (!sampling.lines || !lines?.length) return null;
  const agreeBy = unit < 0.1 ? Infinity : AGREE;
  const ax: number[] = [], ay: number[] = [], bx: number[] = [], by: number[] = [], h: number[][] = [], lab: number[][] = [], line: number[] = [];
  lines.forEach((ln, id) => {
    for (let k = 0; k + 1 < ln.pts.length; k++) {
      const p = ln.pts[k], q = ln.pts[k + 1];
      ax.push(p[0]); ay.push(p[1]); bx.push(q[0]); by.push(q[1]);
      h.push([p[2] === null ? NaN : p[2] - ref, q[2] === null ? NaN : q[2] - ref, p[3] === null ? NaN : p[3] - ref, q[3] === null ? NaN : q[3] - ref]);
      lab.push([ln.l, ln.r]);
      line.push(id);
    }
  });
  if (!ax.length) return null;
  const cells = new Map<number, number[]>(), key = (cx: number, cy: number) => (cx + 32768) * 65536 + cy + 32768;
  for (let k = 0; k < ax.length; k++) {
    for (let cx = Math.floor((Math.min(ax[k], bx[k]) - reach) / reach); cx <= Math.floor((Math.max(ax[k], bx[k]) + reach) / reach); cx++) {
      for (let cy = Math.floor((Math.min(ay[k], by[k]) - reach) / reach); cy <= Math.floor((Math.max(ay[k], by[k]) + reach) / reach); cy++) {
        const c = cells.get(key(cx, cy));
        if (c) c.push(k); else cells.set(key(cx, cy), [k]);
      }
    }
  }
  const best = new Map<number, [number, number, number]>();
  return {
    cell: (x, y) => cells.get(key(Math.floor(x / reach), Math.floor(y / reach))),
    near: (x, y, want, pieces, loose, ground) => {
      best.clear();
      for (const k of pieces) {
        if (lab[k][0] !== want && lab[k][1] !== want) continue;
        const dx = bx[k] - ax[k], dy = by[k] - ay[k];
        const t = Math.max(0, Math.min(1, ((x - ax[k]) * dx + (y - ay[k]) * dy) / (dx * dx + dy * dy || 1)));
        const ex = x - ax[k] - dx * t, ey = y - ay[k] - dy * t, d = Math.hypot(ex, ey);
        if (d >= reach) continue;
        const side = lab[k][0] === want ? 0 : 1;
        // How squarely the point lies on that side: 1 off the piece's middle on it, 0 on
        // the other side, and in between round an end; on the line (to ON_LINE) its label
        // says (a wall's foot and top are read there, a hair either side).
        const c = d > 1e-6 ? (side ? -1 : 1) * (dx * ey - dy * ex) / ((Math.hypot(dx, dy) || 1) * d) : 1;
        const on = Math.max(0, 1 - d / ON_LINE), g = Math.max(0, Math.min(1, (c + (1 - c) * on + FACING) / (2 * FACING)));
        const facing = g * g * (3 - 2 * g);
        if (!facing) continue;
        const hk = h[k][side * 2] * (1 - t) + h[k][side * 2 + 1] * t;
        if (Number.isNaN(hk)) continue;
        const was = best.get(line[k]);
        if (!was || d < was[0] - 1e-6 || (d < was[0] + 1e-6 && facing > was[2])) best.set(line[k], [d, hk, facing]);
      }
      let sum = 0, weight = 0;
      for (const [d, hk, facing] of best.values()) {
        const f = d / reach, e = Math.min(1, d / HOLD), hold = 1 - e * e * (3 - 2 * e);
        const off = Math.max(0, Math.min(1, 2 * d / ON_LINE - 1)), tol = agreeBy * (1 + (1 - off) / 3);
        const a = Math.max(0, Math.min(1, Math.abs(hk - ground) / tol - 1)), agree = Number.isNaN(a) ? 1 : 1 - a * a * (3 - 2 * a);
        const w = (1 - f * f * (3 - 2 * f)) * facing * Math.max(hold, loose) * agree;
        sum += w * hk;
        weight += w;
      }
      return [sum, weight];
    },
  };
}

// Height at a point, bilinear and clamped to the tile (NaN next to a missing height).
// With `labels` (pointLabels), in a cell a step crosses only the corners on the point's
// own side count. `side`: the label of that side; true for the water's; left out, it's
// the terrace the point is on (`terrace`, see terraceAt) or else the plain ground, and
// never the water, so what stands by a quay wall stands on the quay. `flat`: the flat
// terraces' heights (flatTerraces).
export function heightSampler(hm: Float32Array, [bx, by]: [number, number] | [number, number, number, number], n: number, step: number,
  labels: Uint8Array | null = null, terrace: ((x: number, y: number) => number) | null = null, flat: Map<number, number> | null = null,
  lines: StepLineIndex | null = null) {
  const ghosts = new Map<number, number>(); // (sidePlane's, by point and side)
  const sideOf = (x: number, y: number, side: number | boolean) => (side === true ? WATER : side === false ? (terrace ? terrace(x, y) : 0) : side);
  const lattice = (x: number, y: number, side: number | boolean = false) => {
    let want = -1;
    if (flat) {
      want = sideOf(x, y, side);
      const level = flat.get(want);
      if (level !== undefined) return level;
    }
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
        if (want < 0) want = sideOf(x, y, side);
        if (sampling.plane) {
          const at = (k: number, p: number, q: number) => {
            if (labels[k] === want) return hm[k];
            const key = k * 256 + want;
            let h = ghosts.get(key);
            if (h === undefined) ghosts.set(key, h = sidePlane(hm, labels, n, p, q, want));
            return h;
          };
          const ga = at(o, i, j), gb = at(o + 1, i + 1, j), gc = at(o + n, i, j + 1), gd = at(o + n + 1, i + 1, j + 1);
          if (!Number.isNaN(ga + gb + gc + gd)) return (ga * (1 - fu) + gb * fu) * (1 - fv) + (gc * (1 - fu) + gd * fu) * fv;
        }
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
  if (!lines || !labels) return lattice;
  // How much of the point's cell (its corners, bilinearly) is another side's than `want`:
  // 0 in a cell all of its side, where the lattice is right as it is.
  const loose = (x: number, y: number, want: number) => {
    const u = Math.min(n - 1.001, Math.max(0, (x - bx) / step)), v = Math.min(n - 1.001, Math.max(0, (y - by) / step));
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, o = j * n + i;
    return 1 - ((labels[o] === want ? (1 - fu) * (1 - fv) : 0) + (labels[o + 1] === want ? fu * (1 - fv) : 0)
      + (labels[o + n] === want ? (1 - fu) * fv : 0) + (labels[o + n + 1] === want ? fu * fv : 0));
  };
  // Near a step, its line's height on the point's side, going over into the lattice
  // out to the line's reach (stepLineIndex), and from HOLD out only as far as the
  // lattice's cell is mixed: a line's height is the ground at the step, and spread over
  // a cell of the lattice's own it lifted a street with a bank's (nábřeží Edvarda
  // Beneše). (Putting the lattice right by the line's difference from it instead carried
  // the lattice's staircase out onto the streets.)
  return (x: number, y: number, side: number | boolean = false) => {
    const pieces = lines.cell(x, y);
    if (!pieces) return lattice(x, y, side);
    const want = sideOf(x, y, side);
    if (flat?.has(want)) return flat.get(want)!;
    const ground = lattice(x, y, side);
    const [sum, weight] = lines.near(x, y, want, pieces, loose(x, y, want), ground);
    if (!weight) return ground;
    return weight >= 1 ? sum / weight : sum + (1 - weight) * ground;
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
