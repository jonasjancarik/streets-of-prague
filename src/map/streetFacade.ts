// Cut architectural profiles into existing wall triangles in the wall's own
// metre coordinates. Clipping retains gables, sloping pavements and passages.
import * as THREE from 'three';
import { baysOf, wallLength, BLANK, F_SURFACE as S, F_GROUND, F_STOREY, STOREY_FIT, F_UP, F_DOOR, F_WALL, F_MOD } from '../facades.ts';
import openings from './facadeOpenings.json' with {type: 'json'};
import caps from './facadeCaps.json' with {type: 'json'};
import type { BuildingArrays } from '../contracts.ts';

type Point = [number, number, number, number?]; // along, above foot, outward from wall, and how much light reaches it (1 when left out)
type Triangle = [Point, Point, Point, number, number]; // ambient shading and surface code
type V2 = [number, number];
// Exact integer arithmetic within float32's precision, also used by the street
// shader on distant shells. A portal stays in the same bay throughout approach.
function pick(seed: number, column: number, salt: number) {
  const n = (seed * 97 + column * 53 + salt * 181) % 997;
  return ((n * (n + 71) + 241) % 997) / 997;
}
export function streetModule(w: number, bay: number, floor: number, bays: number) {
  const packed = Math.floor((w - Math.floor(w)) * 32768), look = Math.min(F_MOD.length - 1, packed % 16), seed = packed % 997;
  if (floor === 0) {
    const run = Math.min(bays, 8);
    const entrance = Math.floor(pick(seed, 0, 1) * run);
    if (bay % run === entrance) {
      const door = F_DOOR[look * 3 + Math.floor(pick(seed, Math.floor(bay / run), 2) * 3)];
      return door === 19 ? 18 : door; // an inferred closed portal, not a painted passage to walk into
    }
    return F_WALL[look * 4 + Math.floor(pick(seed, Math.floor(bay / 6), 3) * 4)];
  }
  return F_UP[look * 6 + Math.floor(pick(seed, look === 3 || look === 10 ? bay : floor, 4) * 6)];
}

// Preserve the connectivity found by facadeCoords. Two parallel walls with
// the same length and paint are still separate walls.
export function packStreetWalls(f: Float32Array, lines: { tris: number[] }[]) {
  const out: number[] = [];
  for (const { tris } of lines) {
    const o = tris[0] * 12, width = wallLength(f[o + 2]);
    if (width < 2 || width > 100 || Math.floor(f[o + 3]) >= BLANK || !tris.every(t => wallLength(f[t * 12 + 2]) === width && f[t * 12 + 3] === f[o + 3])) continue;
    out.push(tris.length); for (const t of tris) out.push(t);
  }
  return new Uint32Array(out);
}

function rectangle(l: number, b: number, r: number, t: number): V2[] { return [[l, b], [r, b], [r, t], [l, t]]; }
function outline(l: number, b: number, r: number, t: number, rise: number, oval: boolean): V2[] {
  if (oval) return Array.from({ length: 20 }, (_, i) => [(l + r) / 2 + (r - l) / 2 * Math.cos(i * Math.PI / 10), (b + t) / 2 + (t - b) / 2 * Math.sin(i * Math.PI / 10)]);
  if (!rise) return rectangle(l, b, r, t);
  const p: V2[] = [[l, b], [r, b]];
  for (let j = 0; j <= 10; j++) { const a = j * Math.PI / 10; p.push([(l + r) / 2 + Math.cos(a) * (r - l) / 2, t - rise + Math.sin(a) * rise]); }
  return p;
}
// Shopfronts identified in the source artwork (assets/facades/sheet*.txt).
// Only their inset glass panes see merchandise; doors, shutters and flats keep their own finish.
const SHOPFRONTS = new Set([6, 20, 30, 58, 66, 71, 80, 81, 91, 95, 102, 115, 119, 128, 139]);
function cellShape(layer: number, bay: number, storey: number, moduleWidth: number, upper: boolean, style: number) {
  const tris: Triangle[] = [], holes: V2[][] = [], regions = openings[layer] || [];
  const pt = (p: V2, d: number): Point => [p[0], p[1], d];
  const ring = (outer: V2[], inner: V2[], da: (i: number) => number, db: (i: number) => number, ao: number, kind: number = S.masonry) => {
    for (let i = 0; i < outer.length; i++) {
const j = (i + 1) % outer.length;
      const a = pt(outer[i], da(i)), b = pt(outer[j], da(j)), c = pt(inner[j], db(j)), d = pt(inner[i], db(i));
      tris.push([a, b, c, ao, kind], [a, c, d, ao, kind]);
}
  };
  const fill = (outer: V2[], holes: V2[][], depth: number, ao: number, kind: number = S.masonry) => {
    const vec = (p: V2[]) => p.map(([x, y]) => new THREE.Vector2(x, y));
    const all = outer.concat(...holes);
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(vec(outer), holes.map(vec))) {
      tris.push([pt(all[i], depth), pt(all[j], depth), pt(all[k], depth), ao, kind]);
    }
  };
  const interruptions: [number, number, number, number][] = [];
  // Shade where a sill or a cornice keeps the sky off the plaster under it: a sheet a few
  // millimetres in front of the wall, darkest along its top edge between `lo` and `hi`,
  // fading out downwards over `drop` and sideways over `feather`. It stops above any
  // opening below it, so it never covers a cellar window.
  const shaded: [number, number, number, number, number, number][] = [];
  const shadeUnder = () => {
    for (const [lo, hi, top, drop, dark, feather] of shaded) {
      let bottom = Math.max(0, top - drop);
      for (const [l, r, , t] of interruptions) if (t <= top + .001 && r > lo - feather && l < hi + feather) bottom = Math.max(bottom, t + .01);
      if (top - bottom < .06) continue;
      const fade = 1 - (1 - dark) * Math.min(1, (top - bottom) / drop);
      const xs = [lo - feather, lo, hi, hi + feather].map(x => Math.min(bay, Math.max(0, x)));
      for (let i = 0; i < 3; i++) {
        const a: Point = [xs[i], bottom, SHADE_LIFT, 1], b: Point = [xs[i + 1], bottom, SHADE_LIFT, 1];
        const c: Point = [xs[i + 1], top, SHADE_LIFT, i < 2 ? fade : 1], d: Point = [xs[i], top, SHADE_LIFT, i > 0 ? fade : 1];
        tris.push([a, b, c, 1, S.masonry], [a, c, d, 1, S.masonry]);
      }
    }
  };
  for (const [x0, y0, x1, y1, arch, ...lights] of regions) {
    const l = (bay - moduleWidth) / 2 + moduleWidth * x0 / 256, r = (bay - moduleWidth) / 2 + moduleWidth * x1 / 256;
    const b = (1 - y1 / 512) * storey, t = (1 - y0 / 512) * storey;
    const doorway = !upper && (t - b) > storey * .49 && b < storey * .22;
    const inset = doorway ? .255 : upper ? .145 : (t - b) < 1.15 ? .112 : .175;
    const trim = style <= 1 ? .086 : .052;
    const pad = Math.min(trim, l * .75, (bay - r) * .75, b * .72, (storey - t) * .72);
    if (pad < .002) continue;
    const oval = layer === 26, rise = arch / 512 * storey;
    const outer = outline(l - pad, b - pad, r + pad, t + pad, rise ? rise + pad : 0, oval);
    const bead = outline(l - pad * .77, b - pad * .77, r + pad * .77, t + pad * .77, rise ? rise + pad * .77 : 0, oval);
    const lip = outline(l, b, r, t, rise, oval);
    // A planted frame above the plaster, a sill that throws rain clear,
    // then the reveal and sash set back into the masonry.
    const projection = (i: number) => lip[i][1] < b + .001 ? (doorway ? .075 : .145) : style <= 1 ? .047 : .022;
    const bevel = (i: number) => projection(i) * .88;
    holes.push(outer); interruptions.push([l - pad, r + pad, b - pad, t + pad]);
    if (!doorway && b - pad > .12) shaded.push([l - pad, r + pad, b - pad, SILL_SHADE[0], SILL_SHADE[1], .09]);
    ring(outer, bead, () => 0, bevel, .94);
    ring(bead, lip, bevel, projection, 1);
    const inner = outline(l + .014, b + .010, r - .014, t - .014, rise, oval);
    ring(lip, inner, projection, () => -inset, .75, S.reveal);
    const glassFinish = !upper && SHOPFRONTS.has(layer) ? S.display : S.glass;
    const panes: V2[][] = [];
    for (let k = 0; k < lights.length; k += 4) {
      const [lx, ty, rx, by] = lights.slice(k, k + 4), x = (q: number) => (bay - moduleWidth) / 2 + moduleWidth * q / 256;
      const glass = rectangle(x(lx), (1 - by / 512) * storey, x(rx), (1 - ty / 512) * storey);
      // A rectangular transom may sit under an arch. All four corners must fit.
      if (!glass.every(([x, y]) => inner.every((a, i) => { const b = inner[(i + 1) % inner.length]; return cross(b[0] - a[0], b[1] - a[1], x - a[0], y - a[1]) > .00001; }))) continue;
      if (panes.some(p => glass[0][0] < p[2][0] && glass[2][0] > p[0][0] && glass[0][1] < p[2][1] && glass[2][1] > p[0][1])) continue;
      panes.push(glass);
      ring(glass, glass, () => -inset, () => -inset - .038, .80);
      fill(glass, [], -inset - .038, .94, glassFinish);
    }
    const timber = [8, 9, 18, 19, 34, 42, 44, 45, 56, 57, 67, 69, 79, 82, 90, 93, 105, 114, 117, 130, 138, 141, 143].includes(layer);
    const barred = [10, 21, 22, 54, 55, 68, 92, 116, 140].includes(layer) && !panes.length;
    if (barred) {
      const width = r - l, centre = (r + l) / 2;
      const topAt = (x: number) => t - rise + rise * Math.sqrt(Math.max(0, 1 - ((x - centre) / (width / 2)) ** 2));
      const bars = Math.max(3, Math.round(width / .175));
      for (let j = 1; j <= bars; j++) {
        const x = l + j * width / (bars + 1), top = topAt(x) - .006;
        for (let k = 0; k < 6; k++) {
          const a = k * Math.PI / 3, c = (k + 1) * Math.PI / 3;
          const pt = (angle: number, y: number): Point => [x + Math.cos(angle) * .008, y, -.028 + Math.sin(angle) * .008];
          tris.push([pt(a, b), pt(a, top), pt(c, top), 1, S.iron], [pt(a, b), pt(c, top), pt(c, b), 1, S.iron]);
        }
      }
      const rows = (t - b) > .95 ? [.27, .67] : [.48];
      for (const y of rows) {
        const rail = rectangle(l + .008, b + y * (t - b) - .010, r - .008, b + y * (t - b) + .010);
        ring(rail, rail, () => -.032, () => -.016, 1, S.iron); fill(rail, [], -.016, 1, S.iron);
      }
    }
    fill(inner, panes, -inset, .92, barred ? S.grilleGlass : panes.length || timber ? S.joinery : glassFinish);
    // Cut limestone voussoirs around a round-headed portal. Their narrow
    // joints follow the arch; the centre keystone projects past its neighbours.
    if (rise > .12 && !oval && style <= 1) {
      const count = 9, cx = (l + r) / 2, cy = t - rise, rx = (r - l) / 2;
      for (let j = 0; j < count; j++) {
        const key = j === 4, thick = Math.min((r - l) * .18, key ? .238 : .16), depth = key ? .105 : .067;
        const arc = (k: number, outer: boolean): V2 => {
          const angle = (j + .025 + k * .95) * Math.PI / count;
          return [cx + Math.cos(angle) * (rx + (outer ? thick : .026)), cy + Math.sin(angle) * (rise + (outer ? thick : .026))];
        };
        const block = [arc(0, false), arc(0, true), arc(.5, true), arc(1, true), arc(1, false), arc(.5, false)];
        ring(block, block, () => .002, () => depth, .94, S.dressedStone);
        fill(block, [], depth, 1, S.dressedStone);
      }
    }
    // The tread has a top surface and a nosing; stop at each doorway jamb.
    if (doorway && b > .045 && b < .49) {
      const lo = l - pad, hi = r + pad, toe = Math.max(.01, b - .16);
      const section: V2[] = [[toe, .003], [toe, .168], [b - .019, .168], [b, .153], [b, .002]];
      for (let i = 1; i < section.length; i++) {
        const [y, z] = section[i - 1], [h, d] = section[i];
        tris.push([[lo, y, z], [hi, y, z], [hi, h, d], 1, S.plinth], [[lo, y, z], [hi, h, d], [lo, h, d], 1, S.plinth]);
      }
      for (const x of [lo, hi]) {
        const q = section.map(([y, z]): Point => [x, y, z]); if (x === hi) q.reverse();
        for (let j = 1; j < q.length - 1; j++)tris.push([q[0], q[j], q[j + 1], 1, S.plinth]);
      }
    }
    if (doorway && [8, 18, 56, 57, 67, 69, 79, 82, 90, 93, 114, 138, 141, 143].includes(layer)) {
      const hx = (l + r) * .5 + .051, hy = b + Math.min(1.03, (t - b) * .42);
      const plate = outline(hx - .027, hy - .081, hx + .027, hy + .081, .018, false);
      ring(plate, plate, () => -inset, () => -inset + .009, 1, S.brass); fill(plate, [], -inset + .009, 1, S.brass);
      const grip = rectangle(hx - .012, hy + .018, hx + .096, hy + .040);
      ring(grip, grip, () => -inset + .034, () => -inset + .050, 1, S.brass); fill(grip, [], -inset + .050, 1, S.brass);
      const spindle = rectangle(hx - .011, hy + .014, hx + .014, hy + .043);
      ring(spindle, spindle, () => -inset + .009, () => -inset + .039, 1, S.brass);
    }
  }
  fill(rectangle(0, 0, bay, storey), holes, 0, 1);
  const cap = caps[layer];
  if (upper && cap?.length) {
    const edge: V2[] = cap.map(([x, y]) => [(bay - moduleWidth) / 2 + x / 256 * moduleWidth, (1 - y / 512) * storey]);
    if (THREE.ShapeUtils.isClockWise(edge.map(([x, y]) => new THREE.Vector2(x, y)))) edge.reverse();
    // The painted hood (flat, arched or pedimented) projects as a shaped stone.
    ring(edge, edge, () => 0, () => .118, .91, S.reveal); fill(edge, [], .118, 1);
  }
  // Continuous stone courses cross the piers. Interrupt them at the measured
  // openings so a plinth never crosses a shop door or a basement window.
  function course(profile: V2[], kind: number, light?: number[]) {
    let spans: V2[] = [[0, bay]];
    for (const [l, r, b, t] of interruptions) {
      if (profile[0][0] >= t || profile[profile.length - 1][0] <= b) continue;
      spans = spans.flatMap(([a, c]) => c <= l || a >= r ? [[a, c]] : [[a, Math.min(l, c)], [Math.max(a, r), c]].filter(([x, y]) => y > x + .001) as V2[]);
    }
    for (const [a, b] of spans) for (let i = 1; i < profile.length; i++) {
      const [y, z] = profile[i - 1], [h, d] = profile[i];
      const p: Point = [a, y, z, light?.[i - 1]], q: Point = [b, y, z, light?.[i - 1]], r: Point = [b, h, d, light?.[i]], s: Point = [a, h, d, light?.[i]];
      tris.push([p, q, r, 1, kind], [p, r, s, 1, kind]);
    }
  }
  if (!upper) {
    course([[.01, .002], [.04, .057], [.47, .057], [.50, .071], [.54, .071], [.57, .003]], S.plinth);
    const e = storey - .025;
    course(style < 2 ? [[e - .25, .003], [e - .23, .045], [e - .15, .050], [e - .12, .10], [e - .074, .12], [e - .052, .16], [e - .019, .16], [e, .003]]
      : [[e - .105, .003], [e - .096, .054], [e - .018, .054], [e, .003]], S.dressedStone);
    const under = e - (style < 2 ? .25 : .105);
    course([[under - CORNICE_SHADE[0], SHADE_LIFT], [under, SHADE_LIFT]], S.masonry, [1, CORNICE_SHADE[1]]);
  }
  shadeUnder();
  return tris;
}

export interface FacadeGeometry {
  position: Float32Array; normal: Float32Array; color: Float32Array; facade: Float32Array; sky: Float32Array; detail: Float32Array;
  footShade: Float32Array; // the shade on the pavement along the wall's foot: triangles, x y z and darkness per corner
  plateMounts: Float32Array; // a clear patch of plaster near either end, in world coordinates
}
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
// The shade under sills and the ground floor's cornice: how far down it reaches (m) and
// how much light is left at its top; and how far in front of the plaster its sheet lies.
const SILL_SHADE = [.5, .5], CORNICE_SHADE = [.6, .5], SHADE_LIFT = .006;
// The shade on the pavement along a wall's foot: how far out it reaches, how dark it is
// at the wall (0-1) and how far above the paving it lies.
const FOOT_SHADE = [.7, .5, .03];
function clip(poly: Point[], a: V2, b: V2, sign: number) {
  const result: Point[] = []; const dx = b[0] - a[0], dy = b[1] - a[1];
  let last = poly[poly.length - 1], d0 = sign * cross(dx, dy, last[0] - a[0], last[1] - a[1]);
  for (const cur of poly) {
    const d = sign * cross(dx, dy, cur[0] - a[0], cur[1] - a[1]);
    if ((d >= 0) !== (d0 >= 0)) { const t = d0 / (d0 - d), l3 = last[3] ?? 1; result.push([last[0] + (cur[0] - last[0]) * t, last[1] + (cur[1] - last[1]) * t, last[2] + (cur[2] - last[2]) * t, l3 + ((cur[3] ?? 1) - l3) * t]); }
    if (d >= 0) result.push(cur);
    last = cur; d0 = d;
  }
  return result;
}

export function buildStreetWall(arrays: Pick<BuildingArrays, 'position' | 'color' | 'facade'>, sky: Float32Array, triangles: Uint32Array): FacadeGeometry | null {
  const { position: p, color: c, facade: f } = arrays, first = triangles[0] * 12, w = f[first + 3], width = wallLength(f[first + 2]), style = Math.floor(w), bays = baysOf(style, width);
  if (!bays || style >= BLANK || width < 2) return null;
  const look = Math.min(F_MOD.length - 1, Math.floor((w - style) * 32768) % 16), bay = width / bays, mw = Math.min(bay, F_MOD[look]);
  const ground = F_GROUND[style], storey = F_STOREY[style] * (STOREY_FIT[0] + (Math.floor((w - style) * 1024) % 32) * STOREY_FIT[1] / 31);
  const pos: number[] = [], norm: number[] = [], col: number[] = [], fac: number[] = [], shade: number[] = [], detail: number[] = [];
  const foot: number[] = [];
  const shapes = new Map<number, Triangle[]>();
  const eligible = new Map<number, boolean>();
  const onWall = (x: number, y: number) => {
    for (const tri of triangles) {
      const k = tri * 12, ax = f[k], ay = f[k + 1], bx = f[k + 4], by = f[k + 5], cx = f[k + 8], cy = f[k + 9];
      const v0 = cross(bx - ax, by - ay, x - ax, y - ay), v1 = cross(cx - bx, cy - by, x - bx, y - by), v2 = cross(ax - cx, ay - cy, x - cx, y - cy);
      if ((v0 >= -.00001 && v1 >= -.00001 && v2 >= -.00001) || (v0 <= .00001 && v1 <= .00001 && v2 <= .00001)) return true;
    }
    return false;
  };
  function fits(layer: number, j: number, row: number, bottom: number, h: number) {
    const key = row * bays + j, seen = eligible.get(key);
    if (seen !== undefined) return seen;
    const start = j * bay + (bay - mw) / 2;
    const ok = openings[layer].every(([x0, y0, x1, y1]) => {
      const lo = start + x0 / 256 * mw - .045, hi = start + x1 / 256 * mw + .045;
      const peak = caps[layer].reduce((y, p) => Math.min(y, p[1]), y0);
      const sill = bottom + (1 - y1 / 512) * h - .035, head = bottom + (1 - peak / 512) * h + .055;
      return [lo, (lo + hi) / 2, hi].every(x => onWall(x, sill) && onWall(x, head) && onWall(x, (sill + head) / 2));
    });
    eligible.set(key, ok); return ok;
  }
  let modeled = false;
  for (const id of triangles) {
    const o = id * 9, k = id * 12, vertex = id * 3;
    const a: V2 = [f[k], f[k + 1]], b: V2 = [f[k + 4], f[k + 5]], d: V2 = [f[k + 8], f[k + 9]];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - a[0], vy = d[1] - a[1], det = cross(ux, uy, vx, vy);
    if (Math.abs(det) < 1e-6) return null;
    const X = new THREE.Vector3().fromArray(p, o), U = new THREE.Vector3().fromArray(p, o + 3).sub(X), V = new THREE.Vector3().fromArray(p, o + 6).sub(X);
    const N = new THREE.Vector3().crossVectors(U, V).normalize();
    // Where this triangle meets the pavement (height 0 in the wall's coordinates), a strip of
    // shade lies on the paving, darkest at the wall.
    if (Math.abs(N.y) < .2) {
      const at = (q: V2) => { const u = cross(q[0] - a[0], q[1] - a[1], vx, vy) / det, v = cross(ux, uy, q[0] - a[0], q[1] - a[1]) / det; return X.clone().addScaledVector(U, u).addScaledVector(V, v); };
      const low = Math.min(a[1], b[1], d[1]), level = low > 0 && low < .08 ? low : 0, ends: V2[] = [];
      for (const [p0, p1] of [[a, b], [b, d], [d, a]]) {
        if (Math.abs(p0[1] - level) < 1e-4) { if (!ends.some(e => Math.abs(e[0] - p0[0]) < 1e-4)) ends.push([p0[0], level]); }
        else if ((p0[1] - level) * (p1[1] - level) < 0 && Math.abs(p1[1] - level) >= 1e-4) { const t = (level - p0[1]) / (p1[1] - p0[1]); ends.push([p0[0] + (p1[0] - p0[0]) * t, level]); }
      }
      if (ends.length === 2 && Math.abs(ends[0][0] - ends[1][0]) > .02) {
        const out = new THREE.Vector3(N.x, 0, N.z).normalize().multiplyScalar(FOOT_SHADE[0]);
        const [P, Q] = ends.map(at), P1 = P.clone().add(out), Q1 = Q.clone().add(out);
        for (const [v, dark] of [[P, 1], [Q, 1], [Q1, 0], [P, 1], [Q1, 0], [P1, 0]] as [THREE.Vector3, number][]) foot.push(v.x, v.y + FOOT_SHADE[2], v.z, dark * FOOT_SHADE[1]);
      }
    }
    const minX = Math.min(a[0], b[0], d[0]), maxX = Math.max(a[0], b[0], d[0]), minY = Math.min(a[1], b[1], d[1]), maxY = Math.max(a[1], b[1], d[1]);
    const emit = (poly: Point[], layer: number, ao: number, kind: number = S.masonry) => {
      const sign = Math.sign(det);
      for (const [p0, p1] of [[a, b], [b, d], [d, a]]) {
        if (!poly.length) return;
        poly = clip(poly, p0, p1, sign);
      }
      if (poly.length < 3) return;
      // The source triangle's two affine coordinates place even the back of
      // an arched door on the correct side of a sloping street.
      const placed = poly.map(([x, y, z, light = 1]) => {
        const u = cross(x - a[0], y - a[1], vx, vy) / det, v = cross(ux, uy, x - a[0], y - a[1]) / det;
        return { x, y, u, v, light, depth: z, world: X.clone().addScaledVector(U, u).addScaledVector(V, v).addScaledVector(N, z) };
      });
      for (let i = 1; i < placed.length - 1; i++) {
        const q = [placed[0], placed[i], placed[i + 1]];
        if (det < 0) q.reverse();
        const normal = new THREE.Vector3().crossVectors(q[1].world.clone().sub(q[0].world), q[2].world.clone().sub(q[0].world));
        if (normal.lengthSq() < 1e-14) continue; normal.normalize();
        for (const t of q) {
          pos.push(t.world.x, t.world.y, t.world.z); norm.push(normal.x, normal.y, normal.z);
          for (let j = 0; j < 3; j++)col.push(c[o + j] + t.u * (c[o + 3 + j] - c[o + j]) + t.v * (c[o + 6 + j] - c[o + j]));
          fac.push(t.x, t.y, f[k + 2], w); shade.push(sky[vertex] + t.u * (sky[vertex + 1] - sky[vertex]) + t.v * (sky[vertex + 2] - sky[vertex]));
          detail.push(layer, ao * t.light, kind, t.depth);
        }
      }
    };
    // Below grade and above the first three upper floors keep the exact flat
    // surface; only the reachable elevation needs the added geometry.
    const band = (lo: number, hi: number) => {
      if (hi <= lo) return;
      emit([[minX, lo, 0], [maxX, lo, 0], [maxX, hi, 0]], -1, 1, 1);
      emit([[minX, lo, 0], [maxX, hi, 0], [minX, hi, 0]], -1, 1, 1);
    };
    band(minY, Math.min(0, maxY)); band(Math.max(ground + 3 * storey, minY), maxY);
    for (let row = 0; row <= 3; row++) {
      const bottom = row ? ground + (row - 1) * storey : 0, h = row ? storey : ground;
      if (bottom >= maxY || bottom + h <= minY) continue;
      for (let j = Math.max(0, Math.floor(minX / bay)); j < Math.min(bays, Math.ceil(maxX / bay)); j++) {
        const layer = streetModule(w, j, row, bays), key = layer * 2 + (row ? 1 : 0);
        if (!fits(layer, j, row, bottom, h)) {
          // The map clips this bay at a passage, gable or parapet. Leave a
          // plain infill here instead of exposing half a window at the roofline.
          const lo = j * bay, hi = lo + bay, top = bottom + h;
          emit([[lo, bottom, 0], [hi, bottom, 0], [hi, top, 0]], layer, 1, S.infill);
          emit([[lo, bottom, 0], [hi, top, 0], [lo, top, 0]], layer, 1, S.infill);
          continue;
        }
        let shape = shapes.get(key);
        if (!shape) { shape = cellShape(layer, bay, h, mw, !!row, style); shapes.set(key, shape); }
        for (const [l, m, r, ao, kind] of shape) {
          const dx = j * bay;
          if (dx + Math.min(l[0], m[0], r[0]) > maxX || dx + Math.max(l[0], m[0], r[0]) < minX ||
            bottom + Math.min(l[1], m[1], r[1]) > maxY || bottom + Math.max(l[1], m[1], r[1]) < minY) continue;
          emit([l, m, r].map(([x, y, z, light]) => [dx + x, bottom + y, z, light]), layer, ao, kind);
        }
        if (openings[layer]?.length) modeled = true;
      }
    }
  }
  if (!modeled || !pos.length) return null;
  // Find room for an 80 × 40 cm enamel plate. Keep the whole tablet clear of
  // door surrounds, sills, the storey cornice and holes in the source wall.
  const mounts: number[] = [];
  function mount(u: number, h: number) {
    const left = u - .44, right = u + .44, low = h - .24, high = h + .24;
    if (left < 0 || right > width || high > ground - .30) return false;
    for (let j = Math.floor(left / bay); j <= Math.min(bays - 1, Math.floor(right / bay)); j++) {
      const start = j * bay + (bay - mw) / 2, layer = streetModule(w, j, 0, bays);
      if (openings[layer].some(([x0, y0, x1, y1]) =>
        right > start + x0 / 256 * mw - .23 && left < start + x1 / 256 * mw + .23 &&
        high > (1 - y1 / 512) * ground - .15 && low < (1 - y0 / 512) * ground + .24)) return false;
    }
    if (![left, right].every(x => onWall(x, low) && onWall(x, high))) return false;
    for (const tri of triangles) {
      const k = tri * 12, x = f[k], y = f[k + 1];
      const ux = f[k + 4] - x, uy = f[k + 5] - y, vx = f[k + 8] - x, vy = f[k + 9] - y;
      const det = cross(ux, uy, vx, vy);
      if (Math.abs(det) < 1e-6) continue;
      const a = cross(u - x, h - y, vx, vy) / det, b = cross(ux, uy, u - x, h - y) / det;
      if (a < -1e-5 || b < -1e-5 || a + b > 1.00001) continue;
      const i = tri * 9;
      for (let j = i; j < i + 3; j++) mounts.push(p[j] + a * (p[j + 3] - p[j]) + b * (p[j + 6] - p[j]));
      return true;
    }
    return false;
  }
  if (width >= 4) for (const end of [0, 1]) {
    for (const inset of [.58, .95, 1.45, 2.05]) {
      if (inset >= width / 2) break;
      if ([2.75, 3.1, 2.4, 3.55].some(h => mount(end ? width - inset : inset, h))) break;
    }
  }
  return { plateMounts: Float32Array.from(mounts), footShade: Float32Array.from(foot), position: new Float32Array(pos), normal: new Float32Array(norm), color: new Float32Array(col), facade: new Float32Array(fac), sky: new Float32Array(shade), detail: new Float32Array(detail) };
}
