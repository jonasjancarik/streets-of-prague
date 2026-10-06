import { BLANK, baysOf } from '../facades.ts';
import type { WallLine } from '../facades.ts';
import type { DetailArrays } from './roofDetails.ts';

// Roof clutter on IPR's pitched roofs, made in the tile worker when the graphics setting
// asks for it (ROOF_CLUTTER in shading.ts): television aerials and pots on the chimneys,
// a chimney through the slope here and there, and rows of small gabled dormers over the
// window bays of the wall below. All of it is more triangles in the tile's one building
// mesh: no objects and no draw calls of its own. Where things go depends only on where
// the roof is, so a tile looks the same each time it loads.

const CHIMNEY = 11; // roof materials, as tileWorker.ts reads them
const SHEET_METAL = 3;
const AERIAL_SHARE = 0.38; // of chimneys
const AERIAL_HEADING = 1.25; // radians from east: the way most of them point, towards the transmitter
const DORMER_SHARE = 0.4; // of roof faces big enough
const SLOPE_CHIMNEY_SHARE = 0.3;
const DORMER = { width: 1.25, height: 1.15, rise: 0.4, every: 5.8 };

type V3 = [number, number, number]; // three.js world: x, height, z
type Rgb = [number, number, number]; // linear

const srgb = (hex: string): Rgb => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return v.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as Rgb;
};
const METAL = srgb('#77787a'), POT = srgb('#9a5a41'), PLASTER = srgb('#d6cfbf'), GLASS = srgb('#252a32');
const CHIMNEY_BODY = [srgb('#d6d2c8'), srgb('#cbc8c0'), srgb('#c3c1bb')], CAP = srgb('#96938d'), FLUE = srgb('#464340');

const hash = (a: number, b: number, k: number) => {
  const s = Math.sin(Math.round(a * 10) * 12.9898 + Math.round(b * 10) * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
};

class Out {
  pos: number[] = []; nor: number[] = []; col: number[] = []; fac: number[] = [];
  private ground: (x: number, y: number) => number;
  constructor(ground: (x: number, y: number) => number) { this.ground = ground; }
  // A triangle facing `want`'s side. `w`: the facade attribute's fourth number (BLANK for
  // bare plaster on upright faces, a roof material on the others).
  tri(a: V3, b: V3, c: V3, want: V3, rgb: Rgb, w: number) {
    let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) { [b, c] = [c, b]; nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const v of [a, b, c]) {
      this.pos.push(v[0], v[1], v[2]);
      this.nor.push(nx / l, ny / l, nz / l);
      this.col.push(rgb[0], rgb[1], rgb[2]);
      this.fac.push(0, v[1] - this.ground(v[0], -v[2]), 0, w);
    }
  }
  quad(a: V3, b: V3, c: V3, d: V3, want: V3, rgb: Rgb, w: number) { this.tri(a, b, c, want, rgb, w); this.tri(a, c, d, want, rgb, w); }
  // An upright box: four sides, and a top unless it's too thin to see.
  box(x: number, z: number, ax: number, az: number, halfA: number, halfB: number, y0: number, y1: number, side: Rgb, top: Rgb | null) {
    const bx = -az, bz = ax;
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [x + ax * halfA * u + bx * halfB * v, z + az * halfA * u + bz * halfB * v]);
    for (let i = 0; i < 4; i++) {
      const p = c[i], q = c[(i + 1) % 4], mx = (p[0] + q[0]) / 2 - x, mz = (p[1] + q[1]) / 2 - z;
      this.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], [mx, 0, mz], side, BLANK);
    }
    if (top) this.quad([c[0][0], y1, c[0][1]], [c[1][0], y1, c[1][1]], [c[2][0], y1, c[2][1]], [c[3][0], y1, c[3][1]], [0, 1, 0], top, 0);
  }
  // A level bar from p to q, square in section and standing on its edge, so that no face of
  // it is drawn as a flat roof or a wall with windows.
  bar(p: V3, q: V3, half: number, rgb: Rgb) {
    const dx = q[0] - p[0], dz = q[2] - p[2], l = Math.hypot(dx, dz) || 1, sx = -dz / l * half, sz = dx / l * half;
    const ring = (o: V3): V3[] => [[o[0], o[1] + half, o[2]], [o[0] + sx, o[1], o[2] + sz], [o[0], o[1] - half, o[2]], [o[0] - sx, o[1], o[2] - sz]];
    const a = ring(p), b = ring(q);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const want: V3 = [a[i][0] + a[j][0] - 2 * p[0], a[i][1] + a[j][1] - 2 * p[1], a[i][2] + a[j][2] - 2 * p[2]];
      this.quad(a[i], b[i], b[j], a[j], want, rgb, SHEET_METAL);
    }
  }
  arrays(): DetailArrays {
    return { position: new Float32Array(this.pos), normal: new Float32Array(this.nor), color: new Float32Array(this.col), facade: new Float32Array(this.fac) };
  }
}

// A television aerial on a mast: a boom with five rods across it, shorter towards the front.
function aerial(out: Out, x: number, y: number, z: number, r: (k: number) => number) {
  const mast = 1.3 + r(1) * 1.1, heading = AERIAL_HEADING + (r(2) - 0.5) * 0.5;
  const dx = Math.cos(heading), dz = -Math.sin(heading);
  out.box(x, z, dx, dz, 0.025, 0.025, y - 0.3, y + mast, METAL, null);
  const len = 0.9 + r(3) * 0.5, top = y + mast - 0.08;
  out.bar([x - dx * len * 0.35, top, z - dz * len * 0.35], [x + dx * len * 0.65, top, z + dz * len * 0.65], 0.022, METAL);
  for (let i = 0; i < 5; i++) {
    const s = -0.3 + i * 0.22, half = (0.4 - i * 0.045) * (0.9 + r(3) * 0.2);
    const cx = x + dx * len * s, cz = z + dz * len * s;
    out.bar([cx + dz * half, top, cz - dx * half], [cx - dz * half, top, cz + dx * half], 0.016, METAL);
  }
}

interface Face { tris: number[]; n: V3; e: V3; u: V3; lo: number; hi: number; bottom: number; top: number; topY: number; d: number; first: number }

// The pitched roof faces among the first `count` triangles, told apart by their normal
// and plane (as facades.ts does for mansards): 25-57° steep.
function faces(p: Float32Array, count: number, material: (o: number) => number) {
  const found = new Map<string, Face>();
  for (let t = 0; t < count; t++) {
    const m = material(t);
    if (m > 4) continue;
    const i = t * 9;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0.01)) continue;
    nx /= l; ny /= l; nz /= l;
    if (ny < 0.55 || ny > 0.9) continue;
    const d = nx * p[i] + ny * p[i + 1] + nz * p[i + 2];
    const k = `${Math.round(nx * 40)},${Math.round(ny * 40)},${Math.round(nz * 40)},${Math.round(d / 0.4)}`;
    let f = found.get(k);
    if (!f) {
      const h = Math.hypot(nx, nz), ex = -nz / h, ez = nx / h;
      f = { tris: [], n: [nx, ny, nz], e: [ex, 0, ez], u: [-ny * ez, nx * ez - nz * ex, ny * ex], lo: Infinity, hi: -Infinity, bottom: Infinity, top: -Infinity, topY: -Infinity, d, first: t };
      found.set(k, f);
    }
    f.tris.push(t);
    for (let v = i; v < i + 9; v += 3) {
      const s = p[v] * f.e[0] + p[v + 2] * f.e[2], u = p[v] * f.u[0] + p[v + 1] * f.u[1] + p[v + 2] * f.u[2];
      f.lo = Math.min(f.lo, s); f.hi = Math.max(f.hi, s); f.bottom = Math.min(f.bottom, u); f.top = Math.max(f.top, u); f.topY = Math.max(f.topY, p[v + 1]);
    }
  }
  return [...found.values()];
}

// `p`: the tile's building triangles (x, height, -y), of which the first `count` are IPR's
// own (the roofs to build on) and the rest things already added; `col`: their colours
// (linear, a vertex); `material(o)`: triangle o's roof material; `lines`: the walls
// (facadeCoords), their styles in `facade`. Returns the clutter's triangles, or null.
export function roofClutter(p: Float32Array, col: Float32Array, facade: Float32Array, count: number, material: (o: number) => number,
  lines: WallLine[], ground: (x: number, y: number) => number): DetailArrays | null {
  const n = p.length / 9, out = new Out(ground);
  // What already stands on the roofs: every corner and middle of the triangles, by 2 m
  // squares, to keep new things clear of dormers, roof windows, chimneys and higher walls.
  const CELL = 2, taken = new Map<string, number[]>();
  const note = (x: number, y: number, z: number) => {
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`, at = taken.get(k);
    at ? at.push(x, y, z) : taken.set(k, [x, y, z]);
  };
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    for (let v = i; v < i + 9; v += 3) note(p[v], p[v + 1], p[v + 2]);
    note((p[i] + p[i + 3] + p[i + 6]) / 3, (p[i + 1] + p[i + 4] + p[i + 7]) / 3, (p[i + 2] + p[i + 5] + p[i + 8]) / 3);
  }
  // Whether something stands within `reach` m of (x, z), 0.25-5 m above the face's plane.
  const blocked = (f: Face, x: number, z: number, reach: number) => {
    const c0 = Math.floor((x - reach) / CELL), c1 = Math.floor((x + reach) / CELL), r0 = Math.floor((z - reach) / CELL), r1 = Math.floor((z + reach) / CELL);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
      const at = taken.get(`${c},${r}`);
      if (!at) continue;
      for (let i = 0; i < at.length; i += 3) {
        if (Math.hypot(at[i] - x, at[i + 2] - z) > reach) continue;
        const above = f.n[0] * at[i] + f.n[1] * at[i + 1] + f.n[2] * at[i + 2] - f.d;
        if (above > 0.25 && above < 5) return true;
      }
    }
    return false;
  };
  // Whether the point at (s along the eave, u up the slope) is on the face.
  const on = (f: Face, s: number, u: number) => {
    for (const t of f.tris) {
      const q = [0, 3, 6].map((k) => { const v = t * 9 + k; return [p[v] * f.e[0] + p[v + 2] * f.e[2], p[v] * f.u[0] + p[v + 1] * f.u[1] + p[v + 2] * f.u[2]]; });
      const det = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((s - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (u - q[0][1])) / det;
      const l2 = ((q[1][0] - q[0][0]) * (u - q[0][1]) - (s - q[0][0]) * (q[1][1] - q[0][1])) / det;
      if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) return true;
    }
    return false;
  };
  // The point of the face at (s, u), in the world.
  const at = (f: Face, s: number, u: number): V3 => {
    // e, u and n are at right angles: the point is s e + u u + d n.
    return [f.e[0] * s + f.u[0] * u + f.n[0] * f.d, f.u[1] * u + f.n[1] * f.d, f.e[2] * s + f.u[2] * u + f.n[2] * f.d];
  };

  // Chimneys (pipeline/roof_details.py): a body and a cap of ten triangles each, the last
  // two the top. Pots on most, an aerial on some.
  for (let o = count; o + 20 <= n; o++) {
    if (material(o) !== CHIMNEY) continue;
    let run = 0;
    while (o + run < n && material(o + run) === CHIMNEY) run++;
    if (run % 20) { o += run - 1; continue; }
    for (let k = o; k < o + run; k += 20) {
      const a = (k + 18) * 9; // the cap's top: (c0, c1, c2), (c0, c2, c3)
      const cx = (p[a] + p[a + 6]) / 2, cz = (p[a + 2] + p[a + 8]) / 2, y = p[a + 1];
      let ax = p[a + 3] - p[a], az = p[a + 5] - p[a + 2];
      const len = Math.hypot(ax, az) || 1;
      ax /= len; az /= len;
      const r = (j: number) => hash(cx, cz, j);
      const pots = r(4) < 0.25 ? 0 : len > 0.9 ? 2 : 1;
      for (let j = 0; j < pots; j++) {
        const s = pots === 1 ? 0 : (j - 0.5) * len * 0.5;
        out.box(cx + ax * s, cz + az * s, ax, az, 0.09, 0.09, y, y + 0.28 + r(5 + j) * 0.2, r(7) < 0.6 ? POT : METAL, FLUE);
      }
      if (r(0) < AERIAL_SHARE) aerial(out, cx + ax * (len / 2 + 0.03), y - 0.2, cz + az * (len / 2 + 0.03), r);
    }
    o += run - 1;
  }

  for (const f of faces(p, count, material)) {
    const length = f.hi - f.lo, slope = f.top - f.bottom, [nx, ny, nz] = f.n, h = Math.hypot(nx, nz);
    if (length < 6 || slope < 4) continue;
    const mid = at(f, (f.lo + f.hi) / 2, (f.bottom + f.top) / 2), r = (j: number) => hash(mid[0], mid[2], j);
    const c = f.first * 9, roof: Rgb = [col[c], col[c + 1], col[c + 2]], cover = material(f.first);
    // A chimney through the slope, a little below the ridge and rising above it.
    if (length >= 8 && r(1) < SLOPE_CHIMNEY_SHARE) {
      const s = f.lo + 1.5 + r(2) * (length - 3), u = f.top - 0.9 - r(3) * 0.8, q = at(f, s, u);
      if (on(f, s, u) && on(f, s, u - 0.5) && !blocked(f, q[0], q[2], 1.1)) {
        const top = f.topY + 0.5 + r(4) * 0.5, a = 0.28 + r(5) * 0.2, b = 0.3;
        out.box(q[0], q[2], f.e[0], f.e[2], a, b, q[1] - 0.6, top, CHIMNEY_BODY[Math.floor(r(6) * 3)], null);
        out.box(q[0], q[2], f.e[0], f.e[2], a + 0.06, b + 0.06, top, top + 0.08, CAP, FLUE);
        out.box(q[0], q[2], f.e[0], f.e[2], 0.09, 0.09, top + 0.08, top + 0.4, POT, FLUE);
        note(q[0], top, q[2]);
      }
    }
    // Dormers in a row a third of the way up: over the wall's window bays where there is a
    // wall below, evenly otherwise.
    if (r(7) >= DORMER_SHARE || ny > 0.86) continue;
    const u0 = f.bottom + Math.max(1.2, slope * 0.3);
    const run = (DORMER.height + DORMER.rise) * ny / h; // how far back the dormer's ridge meets the roof, level
    if (u0 + run / ny > f.top - 0.4) continue;
    const foot = at(f, (f.lo + f.hi) / 2, f.bottom);
    let wall: WallLine | null = null, bays = 0, under = 0.5 * length;
    for (const l of lines) {
      if ((l.nx * nx + l.nz * nz) / h < 0.97 || Math.abs(l.nx * (foot[0] - l.ax) + l.nz * (foot[2] - l.az)) > 1.5 || l.top < foot[1] - 3 || l.top > foot[1] + 1.5) continue;
      const along = l.tx * f.e[0] + l.tz * f.e[2], s0 = l.ax * f.e[0] + l.az * f.e[2] + along * l.from, s1 = s0 + along * l.length;
      const shared = Math.min(f.hi, Math.max(s0, s1)) - Math.max(f.lo, Math.min(s0, s1));
      const b = baysOf(Math.floor(facade[l.tris[0] * 12 + 3]), l.length);
      if (shared > under && b >= 1) { wall = l; bays = b; under = shared; }
    }
    const spots: number[] = [];
    if (wall) {
      const along = wall.tx * f.e[0] + wall.tz * f.e[2], s0 = wall.ax * f.e[0] + wall.az * f.e[2] + along * wall.from;
      const step = bays > 4 ? 2 : 1, first = bays > 4 && r(8) < 0.5 ? 1 : 0;
      for (let k = first; k < bays; k += step) spots.push(s0 + along * (k + 0.5) * wall.length / bays);
    } else {
      const k = Math.max(1, Math.floor(length / DORMER.every));
      for (let i = 0; i < k; i++) spots.push(f.lo + (i + 0.5) * length / k);
    }
    const back: V3 = [-nx / h, 0, -nz / h]; // level, into the roof
    for (const s of spots) {
      const w = DORMER.width / 2;
      if (s - w < f.lo + 0.4 || s + w > f.hi - 0.4) continue;
      if (!on(f, s - w, u0) || !on(f, s + w, u0) || !on(f, s, u0 + run / ny) || !on(f, s - w, u0 + run / ny * 0.7) || !on(f, s + w, u0 + run / ny * 0.7)) continue;
      const m = at(f, s, u0 + run / ny * 0.4);
      if (blocked(f, m[0], m[2], 1.5)) continue;
      const a0 = at(f, s - w, u0), a1 = at(f, s + w, u0);
      const up = (v: V3, y: number): V3 => [v[0], v[1] + y, v[2]];
      const into = (v: V3, d: number): V3 => [v[0] + back[0] * d, v[1], v[2] + back[2] * d];
      const b0 = up(a0, DORMER.height), b1 = up(a1, DORMER.height), g = up(at(f, s, u0), DORMER.height + DORMER.rise);
      const eaveRun = DORMER.height * ny / h;
      const c0 = into(b0, eaveRun), c1 = into(b1, eaveRun), ridge = into(g, run);
      const front: V3 = [-back[0], 0, -back[2]];
      out.quad(a0, a1, b1, b0, front, PLASTER, BLANK);
      out.tri(b0, b1, g, front, PLASTER, BLANK);
      out.tri(a0, b0, c0, [-f.e[0], 0, -f.e[2]], PLASTER, BLANK);
      out.tri(a1, b1, c1, [f.e[0], 0, f.e[2]], PLASTER, BLANK);
      out.quad(b0, g, ridge, c0, [-f.e[0], 1, -f.e[2]], roof, cover);
      out.quad(b1, g, ridge, c1, [f.e[0], 1, f.e[2]], roof, cover);
      // Its window: dark glass a little in front of the plaster.
      const wx = 0.36, y0 = 0.25, y1 = 0.98;
      const pane = (side: number, y: number): V3 => { const v = at(f, s + side * wx, u0); return [v[0] + front[0] * 0.02, v[1] + y, v[2] + front[2] * 0.02]; };
      out.quad(pane(-1, y0), pane(1, y0), pane(1, y1), pane(-1, y1), front, GLASS, BLANK);
      note(m[0], m[1] + 1, m[2]);
    }
  }
  return out.pos.length ? out.arrays() : null;
}
