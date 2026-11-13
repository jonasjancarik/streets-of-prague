import { hash } from './geo.ts';
import type { Point2 } from './geo.ts';
import { footprintArea, PARAPET_MIN_AREA } from './roofRules.ts';
import { BLANK } from '../facades.ts';
import { GRAIN } from './roofEdges.ts';

// What stands on a flat roof: lift and stair houses on tall blocks, a hatch on lower ones,
// air-conditioning units with their fans and the ducts from them, vents and air-handling
// boxes, vent stubs, a walkway of slabs to the plant, rows of skylights on halls, solar
// panels in rows facing south. All of it is made up by rule: neither IPR nor OSM shows it. Small boxes with
// no textures of their own, made from a roof's outline and seeded by its id, so the same
// roof gets the same things every time. A roof comes from OSM (a footprint) or from IPR's
// triangles (map/iprRoofs.ts), both as a RoofSite; no three.js in here, so node can check it.
//
// Coordinates are the tile's: x east, y north, z up. `partArrays` turns the parts into
// the buffers of a building mesh (x, y-up, -y), with colours in linear RGB.

export interface RoofSite {
  id: string;
  kind?: string;
  z: number; // the roof surface, m
  height: number; // of the roof over the ground, m
  area: number; // m²
  box: [number, number, number, number]; // minX, minY, maxX, maxY
  axis: number; // the roof's main direction, radians
  contains: (x: number, y: number) => boolean; // on the flat part of the roof
}

export type PartShape = 'box' | 'skylight' | 'panel' | 'slab'; // a slab: its top only
export interface Part {
  shape: PartShape;
  x: number; y: number; // middle
  a: number; b: number; // size along and across the axis
  c: number; s: number; // cos and sin of the axis
  h: number; // height; a panel's rise at its back
  rgb: Rgb; // top (and a panel's face)
  side: Rgb;
  top: number; // the top's facade w (see shading.ts)
  lift?: number; // m its bottom stands above `z` (a stop shelter's roof on its posts)
}
type Rgb = [number, number, number];

const lin = (u: number) => (u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4));
const srgb = (hex: string): Rgb => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)) as Rgb;
const LIFT_WALL = ['#cdc6b8', '#bdb8ae', '#d6d0c3', '#b3afa6'].map(srgb);
const LIFT_TOP = ['#4b4a48', '#55534f', '#6f6e6a'].map(srgb);
const METAL = ['#9b9fa1', '#85898b', '#b0b3b3', '#a4a7a2'].map(srgb);
const CURB = srgb('#8d9091');
const PANEL = ['#1e2a3c', '#22304a', '#1a2535'].map(srgb);
const PANEL_BACK = srgb('#8a8d90');
const UNIT_TOP = ['#c9cbc8', '#bfc2c1', '#d3d3cd'].map(srgb);
const STUB = ['#55585a', '#6e7174', '#9a9d9f'].map(srgb);
const SLAB = ['#8f8d88', '#97948d', '#878580'].map(srgb);
const FAN_TOP = 12; // facade w: an air-conditioning unit's top, fans drawn on it (shading.ts)

const SOLAR_BIG = new Set(['school', 'kindergarten', 'university', 'public', 'civic', 'government', 'hospital', 'dormitory']);
const SOLAR_MID = new Set(['commercial', 'office', 'retail', 'supermarket', 'warehouse', 'industrial', 'hangar', 'manufacture', 'sports_hall']);
const HALLS = new Set(['industrial', 'warehouse', 'hangar', 'manufacture', 'supermarket', 'retail', 'sports_hall', 'barn']);
const LIFT_STOREYS = 13; // m of roof height from which a block has a lift or stair house
const TILT = (18 * Math.PI) / 180;

// The roof's main direction: the edges' angles folded into a quarter turn, weighted by length.
export function dominantAxis(edges: Iterable<[number, number, number, number]>) {
  let sx = 0, sy = 0;
  for (const [x1, y1, x2, y2] of edges) {
    const len = Math.hypot(x2 - x1, y2 - y1), a = 4 * Math.atan2(y2 - y1, x2 - x1);
    sx += len * Math.cos(a); sy += len * Math.sin(a);
  }
  return sx || sy ? Math.atan2(sy, sx) / 4 : 0;
}

function inRings(x: number, y: number, rings: Point2[][]) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// A roof from an OSM building: its footprint (outer ring counter-clockwise, then the holes).
// Null where the building gets no parapet and so no details either (sheds, kiosks, small
// roofs): the same test as for the parapet, from roofRules.ts.
export function ringSite(b: { id: string; kind?: string }, rings: Point2[][], z: number, height: number): RoofSite | null {
  const area = footprintArea(rings);
  if (area < PARAPET_MIN_AREA) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const edges: [number, number, number, number][] = [];
  for (const ring of rings) ring.forEach(([x, y], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length];
    edges.push([x, y, x2, y2]);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  });
  return { id: b.id, kind: b.kind, z, height, area, box: [minX, minY, maxX, maxY], axis: dominantAxis(edges), contains: (x, y) => inRings(x, y, rings) };
}

interface Rect { x: number; y: number; hw: number; hd: number; c: number; s: number }
const rectOf = (p: Part, grow = 0): Rect => ({ x: p.x, y: p.y, hw: p.a / 2 + grow, hd: p.b / 2 + grow, c: p.c, s: p.s });

// Separating-axis test for two turned rectangles.
function overlaps(p: Rect, q: Rect) {
  for (const r of [p, q]) {
    for (const [ax, ay] of [[r.c, r.s], [-r.s, r.c]]) {
      const reach = (o: Rect) => Math.abs(o.c * ax + o.s * ay) * o.hw + Math.abs(-o.s * ax + o.c * ay) * o.hd;
      if (Math.abs((q.x - p.x) * ax + (q.y - p.y) * ay) >= reach(p) + reach(q)) return false;
    }
  }
  return true;
}

// Whether the whole rectangle, and `margin` all round it, is on the roof.
function onRoof(site: RoofSite, p: Part, margin: number) {
  const hw = p.a / 2 + margin, hd = p.b / 2 + margin;
  const nu = Math.max(1, Math.ceil((2 * hw) / 1.5)), nv = Math.max(1, Math.ceil((2 * hd) / 1.5));
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const u = -hw + (2 * hw * i) / nu, v = -hd + (2 * hd * j) / nv;
    if (!site.contains(p.x + p.c * u - p.s * v, p.y + p.s * u + p.c * v)) return false;
  }
  return true;
}

const pickOf = <T>(list: T[], u: number) => list[Math.floor(u * list.length) % list.length];
// A roof material with the roof's direction in its fraction (map/roofEdges.ts), so the
// shader lays a top's sheets and slabs square to it.
const grained = (material: number, axis: number) => {
  const q = Math.PI / 2, a = ((axis % q) + q) % q;
  return material + Math.min(GRAIN * a / q, GRAIN - 1e-4);
};
const MARGIN = 0.9; // from the roof's edge, m
const GAP = 0.8; // between parts

// The details of one roof.
export function planDetails(site: RoofSite): Part[] {
  const parts: Part[] = [];
  const { box: [x0, y0, x1, y1], area, kind } = site;
  let n = 0;
  const r = () => hash(`${site.id}:${n++}`);
  const c = Math.cos(site.axis), s = Math.sin(site.axis);
  const hall = kind ? HALLS.has(kind) : false;
  const tall = site.height >= LIFT_STOREYS;
  const placed: Rect[] = [];
  // `skip`: the parts placed from this index on may touch it (a duct leaving its unit).
  const add = (part: Part, margin = MARGIN, gap = GAP, skip = Infinity) => {
    const rc = rectOf(part, gap / 2);
    if (!onRoof(site, part, margin) || placed.some((o, i) => i < skip && overlaps(rc, o))) return false;
    placed.push(rc);
    parts.push(part);
    return true;
  };
  const near = (u: number, v: number, spread: number): [number, number] => [(x0 + x1) / 2 + (u - 0.5) * spread * (x1 - x0), (y0 + y1) / 2 + (v - 0.5) * spread * (y1 - y0)];
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  // Along the roof's axis and across it, from the box's middle, and back.
  const toU = (x: number, y: number): [number, number] => [c * (x - mx) + s * (y - my), -s * (x - mx) + c * (y - my)];
  const fromU = (u: number, v: number): [number, number] => [mx + c * u - s * v, my + s * u + c * v];
  const flatTop = (m: number) => grained(m, site.axis);
  // Where people walk to: the lift houses or the hatch, and the plant.
  const doors: [number, number][] = [], plant: [number, number][] = [];

  // Lift and stair houses: one on a block, up to three on a long one.
  if (tall && area >= 150 && !hall) {
    const want = 1 + (area > 500 ? 1 : 0) + (area > 1300 ? 1 : 0);
    let got = 0;
    for (let t = 0; t < 30 && got < want; t++) {
      const [x, y] = near(r(), r(), t < 10 ? 0.5 : 0.9);
      const a = 2.8 + r() * 1.6, b = 3 + r() * 2;
      if (add({ shape: 'box', x, y, a, b, c, s, h: 2.4 + r() * 0.6, rgb: pickOf(LIFT_TOP, r()), side: pickOf(LIFT_WALL, r()), top: flatTop(5) })) { got++; doors.push([x, y]); }
    }
  }
  // A hatch where there's no stair house.
  if (!doors.length && area >= 90) {
    for (let t = 0; t < 12; t++) {
      const [x, y] = near(r(), r(), 0.7);
      if (add({ shape: 'box', x, y, a: 0.9 + r() * 0.4, b: 1 + r() * 0.4, c, s, h: 0.45 + r() * 0.2, rgb: pickOf(METAL, r()), side: pickOf(METAL, r()), top: 3 })) { doors.push([x, y]); break; }
    }
  }

  // Air-conditioning: a row of units side by side, each with one fan or two on top, and a
  // duct from the row towards the middle of the roof. Most roofs of any size have some.
  if (area >= 100 && (hall || area >= 400 || hash(site.id + ':plant') < 0.85)) {
    const groups = Math.min(5, 1 + Math.floor(area / 450));
    for (let g = 0; g < groups; g++) {
      for (let t = 0; t < 14; t++) {
        const cell = 0.9 + r() * 0.35, fans = r() < 0.4 ? 1 : 2, units = 1 + Math.floor(r() * (hall || area > 600 ? 4 : 2.5));
        const a = cell * fans, gapU = 0.25, run = units * a + (units - 1) * gapU, h = 1 + r() * 0.4;
        const [x, y] = near(r(), r(), 0.9);
        const [u0, v0] = toU(x, y);
        const whole: Part = { shape: 'box', x, y, a: run, b: cell, c, s, h, rgb: UNIT_TOP[0], side: METAL[0], top: 0 };
        if (!onRoof(site, whole, MARGIN) || placed.some((o) => overlaps(rectOf(whole, GAP / 2), o))) continue;
        const from = placed.length, top = pickOf(UNIT_TOP, r()), side = pickOf(METAL, r());
        for (let k = 0; k < units; k++) {
          const [ux, uy] = fromU(u0 - run / 2 + a / 2 + k * (a + gapU), v0);
          add({ shape: 'box', x: ux, y: uy, a, b: cell, c, s, h, rgb: top, side, top: FAN_TOP }, MARGIN, 0.2);
        }
        plant.push([x, y]);
        // The duct: out of the row's side, along the roof's axis or across it.
        const across = r() < 0.5, dir = toU(mx, my)[across ? 1 : 0] - (across ? v0 : u0) >= 0 ? 1 : -1;
        const len = 3 + r() * 8, wd = 0.4 + r() * 0.2;
        const start = across ? cell / 2 : run / 2;
        const mid = start + len / 2;
        const [dx, dy] = across ? fromU(u0 + (r() - 0.5) * (run - wd), v0 + dir * mid) : fromU(u0 + dir * mid, v0 + (r() - 0.5) * (cell - wd));
        add({ shape: 'box', x: dx, y: dy, a: across ? wd : len, b: across ? len : wd, c, s, h: wd, rgb: side, side, top: 3 }, 0.5, 0.2, from);
        break;
      }
    }
  }

  // Skylights in rows on big, lower roofs and halls.
  if ((area >= 500 && !tall) || (hall && area >= 300)) {
    const pitchU = 5 + r() * 4, pitchV = 7 + r() * 3, len = 3 + r() * 3, wid = 1.2;
    const cap = Math.min(24, Math.floor(area / 110));
    let got = 0;
    const ux = (x1 - x0) / 2 + (y1 - y0) / 2;
    for (let v = -ux; v <= ux && got < cap; v += pitchV) for (let u = -ux; u <= ux && got < cap; u += pitchU + len) {
      const x = (x0 + x1) / 2 + c * u - s * v, y = (y0 + y1) / 2 + s * u + c * v;
      if (add({ shape: 'skylight', x, y, a: len, b: wid, c, s, h: 0.32, rgb: CURB, side: CURB, top: 10 }, MARGIN + 1, 1.2)) got++;
    }
  }

  // Solar panels in rows facing south, on a share of the roofs: schools and other public
  // buildings the most.
  const share = kind && SOLAR_BIG.has(kind) ? 0.5 : kind && SOLAR_MID.has(kind) ? 0.3 : 0.14;
  if (area >= 120 && hash(site.id + ':solar') < share) {
    const maxRows = Math.min(6, 1 + Math.floor(area / 250)), depth = 1.6, pitch = 3.1;
    const rgb = pickOf(PANEL, r());
    const cell = (x: number, y: number, a: number): Part => ({ shape: 'panel', x, y, a, b: depth, c: 1, s: 0, h: depth * Math.tan(TILT), rgb, side: PANEL_BACK, top: 3 });
    let made = 0, rows = 0;
    for (let y = y0 + MARGIN + depth / 2; y <= y1 - MARGIN && rows < maxRows && made < 14; y += pitch) {
      let run = 0, from = 0;
      const before = made;
      const flush = () => {
        if (run >= 2 && made < 14 && add(cell(from + run / 2, y, run), 0.4, 0.3)) made++;
        run = 0;
      };
      for (let x = x0 + MARGIN; x <= x1 - MARGIN; x += 1) {
        const one = cell(x + 0.5, y, 1);
        if (onRoof(site, one, 0.4) && !placed.some((o) => overlaps(rectOf(one), o))) {
          if (!run) from = x;
          if (++run >= 12) flush();
        } else flush();
      }
      flush();
      if (made > before) rows++;
    }
  }

  // Vents and air-handling boxes: a few on any roof, more and bigger on halls and big roofs.
  if (area >= 90) {
    const count = Math.min(12, Math.floor((1.5 + area / 200) * (0.6 + r() * 0.8)));
    for (let k = 0; k < count; k++) {
      for (let t = 0; t < 12; t++) {
        const [x, y] = near(r(), r(), 0.95);
        const big = (hall || area > 700) && r() < 0.5;
        const a = big ? 2 + r() * 1.6 : 0.5 + r() * 0.9, b = big ? 1.5 + r() : 0.5 + r() * 1.3;
        if (add({ shape: 'box', x, y, a, b, c, s, h: big ? 1.2 + r() * 0.7 : 0.4 + r() * 0.7, rgb: pickOf(METAL, r()), side: pickOf(METAL, r()), top: flatTop(0) })) break;
      }
    }
  }

  // Vent stubs: pipes up out of the roof, a handful scattered.
  if (area >= 90) {
    const count = Math.min(20, 2 + Math.floor(area / 90 * (0.5 + r())));
    for (let k = 0; k < count; k++) {
      const [x, y] = near(r(), r(), 0.95), d = 0.2 + r() * 0.15;
      add({ shape: 'box', x, y, a: d, b: d, c, s, h: 0.3 + r() * 0.4, rgb: pickOf(STUB, r()), side: pickOf(STUB, r()), top: flatTop(0) }, 0.5, 0.3);
    }
  }

  // On bigger roofs, a walkway of slabs from the way up to each lot of plant: along the
  // roof's axis, then across it. A slab that would land on something is left out.
  if (doors.length && plant.length && area >= 400) {
    const rgb = pickOf(SLAB, r()), top = flatTop(0);
    for (const [px, py] of plant) {
      const [du, dv] = toU(...doors[0]), [pu, pv] = toU(px, py);
      const legs: [number, number, number, number][] = [[du, dv, pu, dv], [pu, dv, pu, pv]];
      for (const [ua, va, ub, vb] of legs) {
        const len = Math.hypot(ub - ua, vb - va), steps = Math.floor(len / 0.52);
        for (let k = 1; k < steps; k++) {
          const [x, y] = fromU(ua + (ub - ua) * k / steps, va + (vb - va) * k / steps);
          add({ shape: 'slab', x, y, a: 0.5, b: 0.5, c, s, h: 0.05, rgb: rgb.map((v) => v * (0.92 + 0.16 * r())) as Rgb, side: rgb, top }, 0.3, 0.01);
        }
      }
    }
  }
  return parts;
}

export interface DetailArrays { position: Float32Array; normal: Float32Array; color: Float32Array; facade: Float32Array }

type V3 = [number, number, number];

// The parts as triangles: `z` is the roof's height in the world, `ground(x, y)` the ground's
// there (for the facade coordinate that says how high a wall stands). Walls get BLANK
// plaster and no windows; a skylight's top is a roof window (facade w 10), a panel's face
// sheet metal (w 3), a lift house's top bitumen sheets (w 5), and an air-conditioning
// unit's top fans (w 12, with its x and y in metres and its depth).
export function partArrays(parts: Part[], z: number, ground: (x: number, y: number) => number): DetailArrays {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], fac: number[] = [];
  const tri = (p: V3[], want: V3, rgb: Rgb, f: (v: V3, i: number) => number[]) => {
    let [a, b, c] = p;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    if ((uy * vz - uz * vy) * want[0] + (uz * vx - ux * vz) * want[1] + (ux * vy - uy * vx) * want[2] < 0) [b, c] = [c, b];
    const order: V3[] = [a, b, c];
    for (const v of order) {
      pos.push(v[0], v[2], -v[1]);
      nor.push(want[0], want[2], -want[1]);
      col.push(...rgb);
      fac.push(...f(v, p.indexOf(v)));
    }
  };
  const wallF = (v: V3) => [0, v[2] - ground(v[0], v[1]), 0, BLANK];
  const quad = (a: V3, b: V3, c: V3, d: V3, want: V3, rgb: Rgb, f: (v: V3, i: number) => number[]) => {
    tri([a, b, c], want, rgb, (v) => f(v, [a, b, c, d].indexOf(v)));
    tri([a, c, d], want, rgb, (v) => f(v, [a, b, c, d].indexOf(v)));
  };
  for (const p of parts) {
    const z0 = z + (p.lift ?? 0);
    const at = (u: number, v: number, h: number): V3 => [p.x + p.c * u - p.s * v, p.y + p.s * u + p.c * v, z0 + h];
    const hu = p.a / 2, hv = p.b / 2;
    if (p.shape === 'panel') {
      // Axis-aligned, low edge to the south, rising to the north.
      const lo = 0.15, hi = lo + p.h;
      const sw = at(-hu, -hv, lo), se = at(hu, -hv, lo), ne = at(hu, hv, hi), nw = at(-hu, hv, hi);
      const n: V3 = [0, -Math.sin(TILT), Math.cos(TILT)];
      quad(sw, se, ne, nw, n, p.rgb, (v) => [v[0], v[2] - ground(v[0], v[1]), 0, p.top]);
      quad(at(-hu, hv, 0), at(hu, hv, 0), ne, nw, [0, 1, 0], p.side, wallF);
      tri([at(-hu, -hv, 0), at(-hu, hv, 0), nw], [-1, 0, 0], p.side, wallF);
      tri([at(hu, hv, 0), at(hu, -hv, 0), ne], [1, 0, 0], p.side, wallF);
      continue;
    }
    const sides: [V3, V3, V3][] = [
      [at(-hu, -hv, 0), at(hu, -hv, 0), [p.s, -p.c, 0]],
      [at(hu, -hv, 0), at(hu, hv, 0), [p.c, p.s, 0]],
      [at(hu, hv, 0), at(-hu, hv, 0), [-p.s, p.c, 0]],
      [at(-hu, hv, 0), at(-hu, -hv, 0), [-p.c, -p.s, 0]],
    ];
    if (p.shape !== 'slab') for (const [a, b, out] of sides) quad(a, b, [b[0], b[1], z0 + p.h], [a[0], a[1], z0 + p.h], out, p.side, wallF);
    const ta = at(-hu, -hv, p.h), tb = at(hu, -hv, p.h), tc = at(hu, hv, p.h), td = at(-hu, hv, p.h);
    if (p.shape === 'skylight') {
      const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
      quad(ta, tb, tc, td, [0, 0, 1], p.rgb, (_v, i) => [uv[i][0], uv[i][1], p.b, 10]);
    } else if (p.top === FAN_TOP) {
      // Metres along and across the top, and its depth (one fan's cell), for the fans.
      const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
      quad(ta, tb, tc, td, [0, 0, 1], p.rgb, (_v, i) => [uv[i][0] * p.a, uv[i][1] * p.b, p.b, FAN_TOP]);
    } else {
      quad(ta, tb, tc, td, [0, 0, 1], p.rgb, (v) => [0, v[2] - ground(v[0], v[1]), 0, p.top]);
    }
  }
  return { position: new Float32Array(pos), normal: new Float32Array(nor), color: new Float32Array(col), facade: new Float32Array(fac) };
}
