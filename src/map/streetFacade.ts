// Cut architectural profiles into existing wall triangles in the wall's own
// metre coordinates. Clipping retains gables, sloping pavements and passages.
import * as THREE from 'three';
import { baysOf, wallLength, BLANK, F_SURFACE as S, F_GROUND, F_STOREY, STOREY_FIT, F_UP, F_DOOR, F_WALL, F_MOD, F_ELEVATION, F_PANEL, F_STREET_WIDTH, SHOPFRONTS, LOOK, STYLE, DOOR_PLATES, PLAQUE, FLOWERS } from '../facades.ts';
import openings from './facadeOpenings.json' with {type: 'json'};
import caps from './facadeCaps.json' with {type: 'json'};
import { rainpipe } from './rainpipe.ts';
import { SIGN_WORDS } from '../facadeFinishes.ts';
import type { BuildingArrays } from '../contracts.ts';

// Along, above foot, outward from wall, how much light reaches it (1 when left out), and on
// lettering that doesn't lie along the wall (a projecting sign) where in its word it is (0–1).
type Point = [number, number, number, number?, number?];
type Triangle = [Point, Point, Point, number, number]; // ambient shading and surface code
type V2 = [number, number];
const FURNISHED_PANE = -1; // replaced by glass and a furnishing seed when emitting this bay
const NAME_STRIP = -2; // a bell panel's name strip: painted shop surface in NAME_PAINT
const NAME_PAINT = new THREE.Color('#ddd8c8');
// A gas main's door and a meter door (painted shop surface in their colours).
const GAS_DOOR = -3, METER_DOOR = -4;
const UTILITY_PAINT = { [GAS_DOOR]: new THREE.Color('#d6ad2b'), [METER_DOOR]: new THREE.Color('#8d918d') } as Record<number, THREE.Color>;
// The utility door: width, height and how high its foot is above the pavement (m).
const UTILITY_DOOR = [.40, .48, .64];
// A house's own entrance (not a shop door or an open passage), which has a bell panel and
// the house numbers beside it.
const houseDoor = (layer: number) => F_DOOR.includes(layer) && !SHOPFRONTS.has(layer) && layer !== 19;
// The bell panel: width, height and how high its foot is above the pavement (m).
const INTERCOM = [.13, .34, 1.17];
const isLoggia = (layer: number) => layer === 28 || layer === 122 || layer === 123 || layer === 125;
// Exact integer arithmetic within float32's precision, also used by the street
// shader on distant shells. A portal stays in the same bay throughout approach.
function pick(seed: number, column: number, salt: number) {
  const n = (seed * 97 + column * 53 + salt * 181) % 997;
  return ((n * (n + 71) + 241) % 997) / 997;
}
export function streetModule(w: number, bay: number, floor: number, bays: number) {
  const packed = Math.floor((w - Math.floor(w)) * 32768), look = Math.min(F_MOD.length - 1, packed % 16), seed = packed % 997;
  const composition = Math.floor(w * 262144) % 8;
  if (look === LOOK.panel || look === LOOK.renovatedPanel) {
    const renovated = look === LOOK.renovatedPanel;
    if (bays < 3) return renovated ? (floor ? 120 : 127) : (floor ? 27 : 33);
    const part = F_PANEL[(renovated ? 24 : 0) + (packed >= 16384 ? 12 : 0) + (floor ? 6 : 0) + bay % 6];
    return (part === 122 || part === 123) && pick(seed, bay + floor * 23, 11) < .38 ? 125 : part;
  }
  if (floor === 0) {
    const run = Math.min(bays, 8);
    const entrance = Math.floor(pick(seed, 0, 1) * run);
    const residential = Math.floor(w) < 2 && composition >= 5;
    if (bay % run === entrance) {
      if (residential) return F_DOOR[look * 3];
      const door = F_DOOR[look * 3 + Math.floor(pick(seed, Math.floor(bay / run), 2) * 3)];
      return door === 19 ? 18 : door; // an inferred closed portal, not a painted passage to walk into
    }
    if (residential) return F_ELEVATION[look * 10 + (bay % run === (entrance + 1) % run ? 9 : 8)];
    return F_WALL[look * 4 + Math.floor(pick(seed, Math.floor(bay / 3), 3) * 4)];
  }
  if (look === LOOK.interwarFlats) return bays >= 4 && (bay === 0 || bay === bays - 1) ? 113 : 77;
  if (look === LOOK.house) return F_UP[look * 6 + Math.floor(pick(seed, floor, 4) * 6)];
  const edge = Math.min(bay, bays - 1 - bay), rhythm = composition % 3;
  const accent = bays >= 3 && (rhythm === 0 ? edge === 0 : rhythm === 1 ? edge === Math.floor((bays - 1) / 2) : edge % 2 === 1);
  const role = floor === 1 || look === LOOK.modern ? Number(accent) : floor === 2 ? 2 : 3;
  return F_ELEVATION[look * 10 + composition % 2 * 4 + role];
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
// Shop joinery and its canvas, sRGB. Neighbouring lights of the same premises
// share a finish. The worker bakes these few colours into the wall's own mesh.
const SHOP_FINISHES = [
  [0x415750, 0xe8d4ad], [0x624343, 0xa85343], [0x455263, 0xd8cbb3],
  [0x76573e, 0xb99a70], [0x444545, 0x819381], [0x4a6062, 0xdbcbac],
].map(pair => pair.map(hex => new THREE.Color(hex)));
// How far the bottom step reaches out from the wall below a sill `b` above the pavement.
const stairFront = (b: number) => .15 + (Math.ceil(b / .182) - 1) * .215;
// The steps up to each raised doorway of a ground-floor module, as cellShape draws them:
// across the module from lo to hi (the surround included), the sill's height and how far
// out the bottom step reaches. (buildStreetWall: their shade on the paving, and the
// footprint cars run into.)
function doorSteps(layer: number, bay: number, storey: number, moduleWidth: number, style: number) {
  const out: { lo: number; hi: number; b: number; front: number }[] = [];
  for (const [x0, y0, x1, y1] of openings[layer] || []) {
    const l = (bay - moduleWidth) / 2 + moduleWidth * x0 / 256, r = (bay - moduleWidth) / 2 + moduleWidth * x1 / 256;
    const b = (1 - y1 / 512) * storey, t = (1 - y0 / 512) * storey;
    if (!((t - b) > storey * .49 && b < storey * .22) || !(b > .045 && b < .66)) continue;
    const pad = Math.min(style <= 1 ? .086 : .052, l * .75, (bay - r) * .75, b * .72, (storey - t) * .72);
    if (pad < .002) continue;
    out.push({ lo: l - pad, hi: r + pad, b, front: stairFront(b) });
  }
  return out;
}

// A projecting shop sign: a lettered board SIGN_SIZE (along its arm, tall) hung from an
// iron arm at x along the wall, its foot `low` above the pavement, both faces lettered so
// the word reads from either way along the street; an edge of the shop's paint. Faces
// come in both windings: the board is seen from all round.
const SIGN_SIZE = [1.05, .25];
const CHALKBOARD = new Set(['KAVÁRNA', 'PEKAŘSTVÍ', 'CUKRÁRNA', 'RESTAURACE', 'PIVNICE', 'BISTRO', 'ZMRZLINA'].map(w => SIGN_WORDS.indexOf(w)));
// A chalkboard's slate.
const CHALK = new THREE.Color('#262b28');
const PROJECTING = new Set(['LÉKÁRNA', 'PIVNICE', 'BANKA', 'SMĚNÁRNA', 'RESTAURACE', 'KAVÁRNA'].map(w => SIGN_WORDS.indexOf(w)));
function projectingSign(x: number, low: number): [Point[], number, number][] {
  const out: [Point[], number, number][] = [], [reach, tall] = SIGN_SIZE, near = .22, far = near + reach, top = low + tall, half = .022;
  const quad = (a: Point, b: Point, c: Point, d: Point, kind: number, ao: number) => {
    out.push([[a, b, c], kind, ao], [[a, c, d], kind, ao], [[a, c, b], kind, ao], [[a, d, c], kind, ao]);
  };
  // The lettered faces: v (light) up the board, u along it; on the +x face the word runs
  // out from the wall, on the -x face back towards it.
  for (const side of [1, -1]) {
    const sx = x + side * half, u = (z: number) => side > 0 ? .08 + .84 * (z - near) / reach : .92 - .84 * (z - near) / reach;
    quad([sx, low, near, 0, u(near)], [sx, low, far, 0, u(far)], [sx, top, far, 1, u(far)], [sx, top, near, 1, u(near)], S.shopSign, 1);
  }
  quad([x - half, top, near], [x + half, top, near], [x + half, top, far], [x - half, top, far], S.shopPaint, 1);
  quad([x - half, low, near], [x + half, low, near], [x + half, low, far], [x - half, low, far], S.shopPaint, .7);
  quad([x - half, low, far], [x + half, low, far], [x + half, top, far], [x - half, top, far], S.shopPaint, .9);
  quad([x - half, low, near], [x + half, low, near], [x + half, top, near], [x - half, top, near], S.shopPaint, .9);
  // The arm along the top from the wall plate, two hangers and a stay below.
  const bar = (y0: number, z0: number, y1: number, z1: number, r: number) => {
    // A square iron bar: its section is ±r across the wall and ±r square to its run.
    const len = Math.hypot(y1 - y0, z1 - z0), ny = -(z1 - z0) / len * r, nz = (y1 - y0) / len * r;
    const corner = (end: 0 | 1, i: number): Point => {
      const [sx, sn] = [[-1, -1], [1, -1], [1, 1], [-1, 1]][i];
      return [x + sx * r, (end ? y1 : y0) + sn * ny, (end ? z1 : z0) + sn * nz];
    };
    for (let i = 0; i < 4; i++) quad(corner(0, i), corner(0, (i + 1) % 4), corner(1, (i + 1) % 4), corner(1, i), S.iron, .9);
  };
  bar(top + .06, .002, top + .06, far + .04, .014);
  for (const z of [near + .1, far - .1]) bar(top + .06, z, top, z, .006);
  bar(low - .02, .002, top + .05, near + reach * .55, .009);
  quad([x - .07, low - .08, .004], [x + .07, low - .08, .004], [x + .07, top + .12, .004], [x - .07, top + .12, .004], S.iron, .9);
  return out;
}

// A utility door in the wall from lo to hi (UTILITY_DOOR): a steel frame standing a few
// centimetres proud, the painted leaf (shopPaint, its colour given when emitting) and a lock.
function utilityDoor(lo: number, hi: number): [Point[], number, number][] {
  const out: [Point[], number, number][] = [], [, high, foot] = UTILITY_DOOR, top = foot + high, e = .025;
  const quad = (a: Point, b: Point, c: Point, d: Point, kind: number, ao: number) =>
    out.push([[a, b, c], kind, ao], [[a, c, d], kind, ao], [[a, c, b], kind, ao], [[a, d, c], kind, ao]);
  const slab = (x0: number, y0: number, x1: number, y1: number, z: number, kind: number) => {
    quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], kind, 1);
    quad([x0, y0, .001], [x1, y0, .001], [x1, y0, z], [x0, y0, z], kind, .75);
    quad([x0, y1, .001], [x1, y1, .001], [x1, y1, z], [x0, y1, z], kind, .95);
    quad([x0, y0, .001], [x0, y1, .001], [x0, y1, z], [x0, y0, z], kind, .85);
    quad([x1, y0, .001], [x1, y1, .001], [x1, y1, z], [x1, y0, z], kind, .85);
  };
  slab(lo, foot, hi, foot + e, .034, S.metalFrame); slab(lo, top - e, hi, top, .034, S.metalFrame);
  slab(lo, foot + e, lo + e, top - e, .034, S.metalFrame); slab(hi - e, foot + e, hi, top - e, .034, S.metalFrame);
  slab(lo + e, foot + e, hi - e, top - e, .026, S.shopPaint);
  slab(hi - .075, foot + high / 2 - .02, hi - .055, foot + high / 2 + .02, .036, S.iron);
  return out;
}

// Things hung on an upper storey's wall (wallKit): an air conditioner under a window on
// brackets, or a satellite dish beside it. Painted shop surface in WALL_KIT_PAINT.
const WALL_KIT_PAINT = [new THREE.Color('#e6e6e0'), new THREE.Color('#3b3e3d'), new THREE.Color('#d9d9d2'), new THREE.Color('#b3271e'),
  new THREE.Color('#6e4a33'), new THREE.Color('#3f6a2c'), new THREE.Color('#c8283a'), new THREE.Color('#e9e3da')];
function boxFaces(out: [Point[], number, number][], x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, kind: number) {
  const q = (a: Point, b: Point, c: Point, d: Point, ao: number) => out.push([[a, b, c], kind, ao], [[a, c, d], kind, ao], [[a, c, b], kind, ao], [[a, d, c], kind, ao]);
  q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 1);
  q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], .97);
  q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], .7);
  q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], .85);
  q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], .85);
}
// Kind -10 - i paints WALL_KIT_PAINT[i] (see the emission).
// A planter on a sill with geraniums (kinds -14 box, -15 leaves, -16 and -17 flowers): at
// `x` to `x1` along the wall, standing on the sill at `y`.
function windowBox(x0: number, x1: number, y: number, seed: number): [Point[], number, number][] {
  const out: [Point[], number, number][] = [];
  boxFaces(out, x0, y, x1, y + .17, .03, .22, -14);
  const n = Math.max(3, Math.round((x1 - x0) / .12));
  for (let i = 0; i < n; i++) {
    const x = x0 + (i + .5) * (x1 - x0) / n, h = .1 + .07 * ((seed * 7 + i * 13) % 5) / 4, z = .09 + .06 * ((i * 5 + seed) % 3) / 2;
    boxFaces(out, x - .07, y + .14, x + .07, y + .14 + h, z - .06, z + .06, -15);
    if ((i + seed) % 3 !== 2) boxFaces(out, x - .035, y + .14 + h, x + .035, y + .2 + h, z - .035, z + .035, (seed + i) % 4 ? -16 : -17);
  }
  return out;
}
function airConditioner(x: number, top: number): [Point[], number, number][] {
  const out: [Point[], number, number][] = [], w = .78, h = .52;
  boxFaces(out, x - w / 2, top - h, x + w / 2, top, .07, .33, -10);
  boxFaces(out, x - w / 2 + .06, top - h + .07, x + .08, top - .07, .33, .336, -11);
  for (const bx of [x - w / 2 + .1, x + w / 2 - .1]) boxFaces(out, bx - .015, top - h - .05, bx + .015, top - h, .002, .36, S.iron);
  boxFaces(out, x + w / 2 - .07, top - h - .9, x + w / 2 - .045, top - h, .02, .045, -12);
  return out;
}
function satelliteDish(x: number, y: number): [Point[], number, number][] {
  const out: [Point[], number, number][] = [], r = .3, n = 10;
  // The reflector faces south-ish and up a little: a disc tilted out from the wall.
  const at = (a: number): Point => [x + Math.cos(a) * r, y + Math.sin(a) * r * .9, .42 + Math.sin(a) * .1];
  for (let i = 0; i < n; i++) {
    const c: Point = [x, y, .47], a = at(i * 2 * Math.PI / n), b = at((i + 1) * 2 * Math.PI / n);
    out.push([[c, a, b], -12, 1], [[c, b, a], -12, .85]);
  }
  boxFaces(out, x - .02, y - .02, x + .02, y + .02, .002, .42, S.iron);
  boxFaces(out, x - .012, y - .012, x + .012, y + .012, .47, .72, S.iron);
  return out;
}

// A café's or bakery's chalkboard on the pavement in front of it: two boards leaning
// together, the shop's word chalked on both (lettering u along the board, light up it), in
// a timber frame. At x along the wall, `out` from it.
const A_FRAME = [.56, .86, .26]; // width, height, how far apart its feet stand
function chalkboard(x: number, out: number): [Point[], number, number][] {
  const res: [Point[], number, number][] = [], [w, h, spread] = A_FRAME, l = x - w / 2, r = x + w / 2;
  for (const side of [-1, 1]) {
    // Each board from its foot to the ridge; the lettered face looks away from the other.
    const foot = out + side * spread / 2, ridge = out, u = (xx: number) => side > 0 ? .1 + .8 * (r - xx) / w : .1 + .8 * (xx - l) / w;
    const a: Point = [l, .02, foot, 0, u(l)], b: Point = [r, .02, foot, 0, u(r)], c: Point = [r, h, ridge, 1, u(r)], d: Point = [l, h, ridge, 1, u(l)];
    res.push([[a, b, c], S.shopSign, 1], [[a, c, d], S.shopSign, 1], [[a, c, b], S.shopSign, 1], [[a, d, c], S.shopSign, 1]);
    for (const xx of [l - .02, r + .02]) {
      const e: Point = [xx, 0, foot], f2: Point = [xx, h + .03, ridge];
      res.push([[e, f2, [xx, h + .03, ridge + .03 * side]], S.shopPaint, .9], [[e, [xx, h + .03, ridge + .03 * side], f2], S.shopPaint, .9]);
    }
  }
  return res;
}
// A burglar alarm's box high on the wall by a shop: a small red or blue steel case.
function alarmBox(x: number, y: number): [Point[], number, number][] {
  const out: [Point[], number, number][] = [];
  boxFaces(out, x - .13, y - .17, x + .13, y + .17, .004, .09, -13);
  boxFaces(out, x - .09, y + .06, x + .09, y + .13, .09, .1, -12);
  return out;
}

function cellShape(layer: number, bay: number, storey: number, moduleWidth: number, upper: boolean, style: number, awning: boolean) {
  const tris: Triangle[] = [], holes: V2[][] = [], regions = openings[layer] || [];
  const pt = (p: V2, d: number): Point => [p[0], p[1], d];
  const ring = (outer: V2[], inner: V2[], da: number, db: number, ao: number, kind: number = S.masonry) => {
    for (let i = 0; i < outer.length; i++) {
      const j = (i + 1) % outer.length;
      const a = pt(outer[i], da), b = pt(outer[j], da), c = pt(inner[j], db), d = pt(inner[i], db);
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
  if (isLoggia(layer)) {
    // A balcony is a room behind a guard. The atlas gives the perimeter of
    // its mouth; the ceiling, cheeks and rear door must move in parallax.
    const [x0, y0, x1, y1] = regions[0];
    const l = (bay - moduleWidth) / 2 + x0 / 256 * moduleWidth, r = l + (x1 - x0) / 256 * moduleWidth;
    const b = (1 - y1 / 512) * storey, t = (1 - y0 / 512) * storey, rear = -.92;
    const mouth = rectangle(l, b, r, t);
    fill(rectangle(0, 0, bay, storey), [mouth], 0, 1);
    ring(mouth, mouth, 0, rear, .83, S.precast);
    fill(mouth, [], rear, .69, S.precast);
    const solid = (face: V2[], back: number, front: number, ao: number, kind: number) => {
      ring(face, face, back, front, ao, kind);
      fill(face, [], front, ao, kind);
    };
    const span = r - l, left = l + span * .09, right = r - span * .09, mullion = left + span * .29;
    const head = t - .27, foot = b + .06, sill = b + .79;
    const frame: V2[] = [[left, foot], [mullion, foot], [mullion, sill], [right, sill], [right, head], [left, head]];
    const door = rectangle(left + .055, foot + .10, mullion - .027, head - .055);
    const light = rectangle(mullion + .027, sill + .055, right - .055, head - .055);
    ring(frame, frame, rear, rear + .055, .85, S.metalFrame);
    fill(frame, [door, light], rear + .055, .9, S.metalFrame);
    for (const pane of [door, light]) {
      ring(pane, pane, rear + .055, rear + .025, .88, S.metalFrame);
      fill(pane, [], rear + .025, 1, S.balconyGlass);
    }
    const guard = storey * (1 - 319 / 512);
    if (layer === 123) {
      const bars = Math.ceil(span / .14);
      for (let i = 1; i < bars; i++) {
        const x = l + i * span / bars;
        solid(rectangle(x - .014, b + .045, x + .014, guard), -.055, -.025, .92, S.metalFrame);
      }
    } else {
      const sheet = rectangle(l, b + .045, r, guard);
      solid(sheet, -.075, -.025, .94, S.joinery);
      fill([...sheet].reverse(), [], -.075, .78, S.precast);
    }
    solid(rectangle(l, guard - .018, r, guard + .022), -.075, .012, 1, S.metalFrame);
    if (layer === 125) {
      // Slim aluminium meeting stiles and top track of a glazed-in loggia.
      // The clear lights leave the real door visible a metre behind them.
      for (const portion of [1 / 3, 2 / 3]) {
        const x = l + span * portion;
        solid(rectangle(x - .012, guard, x + .012, t), -.07, -.035, .96, S.metalFrame);
      }
      solid(rectangle(l, t - .035, r, t), -.07, -.025, .98, S.metalFrame);
    }
    solid(rectangle(0, 0, bay, b + .04), -.01, .075, .98, S.precast);
    return tris;
  }
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
    const inset = doorway ? (arch > 0 && style <= STYLE.baroque ? .39 : .255) : upper ? .145 : (t - b) < 1.15 ? .112 : .175;
    const trim = style <= 1 ? .086 : .052;
    const pad = Math.min(trim, l * .75, (bay - r) * .75, b * .72, (storey - t) * .72);
    if (pad < .002) continue;
    const oval = layer === 26, rise = arch / 512 * storey;
    const outer = outline(l - pad, b - pad, r + pad, t + pad, rise ? rise + pad : 0, oval);
    const bead = outline(l - pad * .77, b - pad * .77, r + pad * .77, t + pad * .77, rise ? rise + pad * .77 : 0, oval);
    const lip = outline(l, b, r, t, rise, oval);
    // A planted frame above the plaster, a sill that throws rain clear,
    // then the reveal and sash set back into the masonry.
    const projection = style <= 1 ? .047 : .022, bevel = projection * .88;
    holes.push(outer); interruptions.push([l - pad, r + pad, b - pad, t + pad]);
    if (!doorway && !oval && b - pad > .12) {
      // Only the horizontal sill projects beyond the surround. The jambs
      // stay parallel to the glazing down to their feet.
      const sill = rectangle(l - pad, b - pad, r + pad, b - .006);
      const depth = style <= 1 ? .115 : .075;
      const material = style === STYLE.panel ? S.metalFrame : S.dressedStone;
      ring(sill, sill, .002, depth, .94, material);
      fill(sill, [], depth, 1, material);
      shaded.push([l - pad, r + pad, b - pad, SILL_SHADE[0], SILL_SHADE[1], .09]);
    }
    ring(outer, bead, 0, bevel, .94);
    ring(bead, lip, bevel, projection, 1);
    const inner = outline(l + .014, b + .010, r - .014, t - .014, rise, oval);
    ring(lip, inner, projection, -inset, .75, style === STYLE.panel ? S.precast : S.reveal);
    const glassFinish = !upper && SHOPFRONTS.has(layer) ? S.display : S.glass;
    const panes: V2[][] = [];
    for (let k = 0; k < lights.length; k += 4) {
      const [lx, ty, rx, by] = lights.slice(k, k + 4), x = (q: number) => (bay - moduleWidth) / 2 + moduleWidth * q / 256;
      const glass = rectangle(x(lx), (1 - by / 512) * storey, x(rx), (1 - ty / 512) * storey);
      // A rectangular transom may sit under an arch. All four corners must fit.
      if (!glass.every(([x, y]) => inner.every((a, i) => { const b = inner[(i + 1) % inner.length]; return cross(b[0] - a[0], b[1] - a[1], x - a[0], y - a[1]) > .00001; }))) continue;
      if (panes.some(p => glass[0][0] < p[2][0] && glass[2][0] > p[0][0] && glass[0][1] < p[2][1] && glass[2][1] > p[0][1])) continue;
      panes.push(glass);
      ring(glass, glass, -inset, -inset - .038, .80);
      fill(glass, [], -inset - .038, .94, upper ? FURNISHED_PANE : glassFinish);
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
        ring(rail, rail, -.032, -.016, 1, S.iron); fill(rail, [], -.016, 1, S.iron);
      }
    }
    const back = barred ? S.grilleGlass : panes.length || timber ? S.joinery : glassFinish;
    fill(inner, panes, -inset, .92, !panes.length && (layer === 96 || layer === 107) ? FURNISHED_PANE : back);
    // The shopfitter inserts a frame between the masonry piers, with a
    // continuous head above the lights. Keep the stone arch of older shops.
    if (glassFinish === S.display && !rise && !oval && r - l > 1.25 && t > 2.45) {
      const side = Math.min(.105, l * .7, (bay - r) * .7);
      const head = Math.min(storey - .32, t + .31);
      const board = (lo: number, low: number, hi: number, high: number, depth: number, sign = false) => {
        const face = rectangle(lo, low, hi, high);
        ring(face, face, .001, depth, .94, S.shopPaint);
        if (sign) {
          // On the fascia's front the fourth coordinate is the vertical position
          // in the lettering. It survives clipping across source triangles.
          const [a, b, c, d] = face.map(([x, y], i): Point => [x, y, depth, i < 2 ? 0 : 1]);
          tris.push([a,b,c,1,S.shopSign], [a,c,d,1,S.shopSign]);
        } else fill(face, [], depth, 1, S.shopPaint);
      };
      if (head > t + .10 && side > .03) {
        board(l - side, b, l, t, .066);
        board(r, b, r + side, t, .066);
        board(l - side, t, r + side, head, .078, true);
        board(l - side - .016, head, r + side + .016, head + .034, .105);
        // A lowered folding awning with a short valance. Both winding orders
        // are needed for the inside of the thin fabric when walking under it.
        if (awning && t - .51 > 2.24) {
          const lo = l - side, hi = r + side, reach = Math.min(.94, (hi - lo) * .42);
          const strip = (y: number, z: number, nextY: number, nextZ: number, light: number) => {
            const a: Point = [lo, y, z], b: Point = [hi, y, z], c: Point = [hi, nextY, nextZ], d: Point = [lo, nextY, nextZ];
            tris.push([a,c,b,light,S.canvas], [a,d,c,light,S.canvas], [a,b,c,.73,S.canvas], [a,c,d,.73,S.canvas]);
          };
          strip(t, .09, t - .32, reach, 1);
          strip(t - .32, reach, t - .45, reach, .94);
          // Narrow hinged arms under the roller, visible when looking up.
          for (const x of [lo + .09, hi - .09]) {
            const arm = (offset: number): Point[] => [
              [x + offset, t - .51, .055], [x + offset, t - .35, reach - .025],
              [x + offset, t - .323, reach - .025], [x + offset, t - .48, .055],
            ];
            const left = arm(-.014), right = arm(.014);
            tris.push([left[0], left[1], left[2], 1, S.iron], [left[0], left[2], left[3], 1, S.iron],
              [right[2], right[1], right[0], 1, S.iron], [right[3], right[2], right[0], 1, S.iron]);
            for (let i = 0; i < 4; i++) {
              const j = (i + 1) % 4;
              tris.push([left[i], right[i], right[j], 1, S.iron], [left[i], right[j], left[j], 1, S.iron]);
            }
          }
        }
      }
    }
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
        ring(block, block, .002, depth, .94, S.dressedStone);
        fill(block, [], depth, 1, S.dressedStone);
      }
    }
    // A raised portal needs enough risers to reach it from the pavement.
    // The upper landing continues through the reveal to the timber leaves.
    if (doorway && b > .045 && b < .66) {
      const lo = l - pad, hi = r + pad, risers = Math.ceil(b/.182), rise = b/risers;
      const run = .215, front = stairFront(b);
      const section: V2[] = [[.003, .004], [.003, front-.014]];
      for (let step=0;step<risers;step++) {
        const height=(step+1)*rise, edge=front-step*run;
        section.push([height-.025,edge-.014],[height-.021,edge],[height-.008,edge],[height,edge-.012],
          [height,step===risers-1 ? -inset+.003 : edge-run-.014]);
      }
      for (let i = 1; i < section.length; i++) {
        const [y,z]=section[i-1],[h,d]=section[i];
        const ao = h===y ? 1 : d>z ? .66 : .89;
        tris.push([[lo,y,z],[hi,y,z],[hi,h,d],ao,S.dressedStone], [[lo,y,z],[hi,h,d],[lo,h,d],ao,S.dressedStone]);
      }
      // Close each riser separately. A fan across the stepped outline would
      // fill the air over the lower treads.
      for (let step=0;step<risers;step++) {
        const low=step*rise, high=low+rise, edge=front-step*run-.012;
        for (const x of [lo,hi]) {
          const side: Point[]=[[x,low,.002],[x,low,edge],[x,high,edge],[x,high,.002]];
          if (x===hi) side.reverse();
          tris.push([side[0],side[1],side[2],.83,S.dressedStone],[side[0],side[2],side[3],.83,S.dressedStone]);
        }
      }
    }
    if (doorway && timber && panes.length===0 && r-l>1.28) {
      // The overlapping timber stile and rail stand proud of the flat boards.
      const middle=(l+r)/2;
      const stile=rectangle(middle-.027,b+.021,middle+.027,t-rise-.036);
      ring(stile,stile,-inset,-inset+.027,.84,S.joinery);
      fill(stile,[],-inset+.027,.98,S.joinery);
      for (const [lo,hi] of [[l+.046,middle-.031],[middle+.031,r-.046]]) {
        const rail=rectangle(lo,b+.038,hi,b+.145);
        ring(rail,rail,-inset,-inset+.021,.82,S.joinery);
        fill(rail,[],-inset+.021,.96,S.joinery);
      }
    }
    if (doorway && [8, 18, 56, 57, 67, 69, 79, 82, 90, 93, 114, 138, 141, 143].includes(layer)) {
      const hx = (l + r) * .5 + .051, hy = b + Math.min(1.03, (t - b) * .42);
      const plate = outline(hx - .027, hy - .081, hx + .027, hy + .081, .018, false);
      ring(plate, plate, -inset, -inset + .009, 1, S.brass); fill(plate, [], -inset + .009, 1, S.brass);
      const grip = rectangle(hx - .012, hy + .018, hx + .096, hy + .040);
      ring(grip, grip, -inset + .034, -inset + .050, 1, S.brass); fill(grip, [], -inset + .050, 1, S.brass);
      const spindle = rectangle(hx - .011, hy + .014, hx + .014, hy + .043);
      ring(spindle, spindle, -inset + .009, -inset + .039, 1, S.brass);
    }
    if (doorway && houseDoor(layer)) {
      // The bell panel of the flats: a steel plate beside the door with a speaker at the
      // top and a column of name strips, each with its button. The wall's own house
      // numbers hang on the other side (doorPlates in buildStreetWall).
      const reach = rise > .12 && style <= 1 ? .19 : pad, x0 = r + reach + .05;
      if (x0 + INTERCOM[0] + .02 < bay) {
        const [wide, high, foot] = INTERCOM, x1 = x0 + wide, top = foot + high;
        const plate = rectangle(x0, foot, x1, top);
        ring(plate, plate, .001, .016, .9, S.metalFrame); fill(plate, [], .016, 1, S.metalFrame);
        fill(rectangle(x0 + .022, top - .062, x1 - .022, top - .022), [], .0165, 1, S.iron);
        const rows = Math.max(3, Math.min(8, Math.round(storey * 1.6)));
        const step = (high - .10) / rows;
        for (let i = 0; i < rows; i++) {
          const y = foot + .026 + i * step;
          fill(rectangle(x0 + .014, y, x1 - .040, y + step * .62), [], .0165, 1, NAME_STRIP);
          const button = rectangle(x1 - .032, y + step * .08, x1 - .014, y + step * .56);
          ring(button, button, .016, .022, .85, S.iron); fill(button, [], .022, 1, S.iron);
        }
      }
    }
  }
  fill(rectangle(0, 0, bay, storey), holes, 0, 1);
  const cap = caps[layer];
  if (upper && cap?.length) {
    const edge: V2[] = cap.map(([x, y]) => [(bay - moduleWidth) / 2 + x / 256 * moduleWidth, (1 - y / 512) * storey]);
    if (THREE.ShapeUtils.isClockWise(edge.map(([x, y]) => new THREE.Vector2(x, y)))) edge.reverse();
    // The painted hood (flat, arched or pedimented) projects as a shaped stone.
    ring(edge, edge, 0, .118, .91, S.reveal); fill(edge, [], .118, 1);
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
  if (!upper && style === STYLE.panel) {
    course([[.01, .002], [.025, .035], [.33, .035], [.35, .002]], S.plinth);
  } else if (!upper) {
    course([[.01, .002], [.04, .057], [.47, .057], [.50, .071], [.54, .071], [.57, .003]], S.plinth);
    const e = storey - .025;
    course(style < 2 ? [[e - .25, .003], [e - .23, .045], [e - .15, .050], [e - .12, .10], [e - .074, .12], [e - .052, .16], [e - .019, .16], [e, .003]]
      : [[e - .105, .003], [e - .096, .054], [e - .018, .054], [e, .003]], S.dressedStone);
    const under = e - (style < 2 ? .25 : .105);
    course([[under - CORNICE_SHADE[0], SHADE_LIFT], [under, SHADE_LIFT]], S.masonry, [1, CORNICE_SHADE[1]]);
  }
  shadeUnder();
  if (layer === 113) {
    // Cast balcony with rounded front corners. Both cheeks run back to the
    // wall, leaving the doorway clear. Distances are in the wall's frame.
    const half = moduleWidth * .47, centre = bay / 2, reach = .82;
    const contour = (inset: number): V2[] => {
      const radius = .23 - inset, edge = half - inset, front = reach - inset;
      const points: V2[] = [[centre-edge, 0]];
      for (const side of [-1, 1]) for (let i = 0; i <= 4; i++) {
        const angle = (side === -1 ? i : 4-i) * Math.PI / 8;
        points.push([centre + side * (edge-radius+radius*Math.cos(angle)), front-radius+radius*Math.sin(angle)]);
      }
      points.push([centre+edge, 0]);
      return points;
    };
    const outside = contour(0), inside = contour(.09);
    const deck = storey * 28/512, top = storey * 176/512;
    const at = ([x,z]: V2, y: number): Point => [x,y,z];
    const quad = (a: Point, b: Point, c: Point, d: Point, kind: number) =>
      tris.push([a,b,c,1,kind],[a,c,d,1,kind]);
    for (let i = 1; i < outside.length; i++) {
      const a = outside[i-1], b = outside[i], c = inside[i], d = inside[i-1];
      quad(at(a,deck-.12),at(b,deck-.12),at(b,deck),at(a,deck),S.dressedStone);
      if (Math.abs(a[1]-reach) < .001 && Math.abs(b[1]-reach) < .001) {
        const low = deck + (top-deck)*.13, high = deck + (top-deck)*.24;
        const cuts = [.08,.43,.57,.92].map(u => a[0] + (b[0]-a[0])*u);
        const face = rectangle(a[0],deck,b[0],top);
        const slots = [rectangle(cuts[0],low,cuts[1],high),rectangle(cuts[2],low,cuts[3],high)];
        fill(face, slots, reach, 1, S.infill);
        // Reverse the inner face so the parapet is visible from above.
        const start = tris.length;
        fill(face, slots, reach-.09, .84, S.infill);
        for (let j=start; j<tris.length; j++) [tris[j][0],tris[j][1]] = [tris[j][1],tris[j][0]];
        for (const slot of slots) ring(slot,slot,reach,reach-.09,.76,S.infill);
      } else {
        quad(at(a,deck),at(b,deck),at(b,top),at(a,top),S.infill);
        quad(at(c,deck),at(d,deck),at(d,top),at(c,top),S.infill);
      }
      quad(at(a,top),at(b,top),at(c,top),at(d,top),S.dressedStone);
      tris.push([[centre,deck,0],at(a,deck),at(b,deck),1,S.dressedStone],
        [[centre,deck-.12,0],at(b,deck-.12),at(a,deck-.12),.8,S.infill]);
    }
  }
  return tris;
}

export interface FacadeGeometry {
  position: Float32Array; normal: Float32Array; color: Float32Array; facade: Float32Array; sky: Float32Array; detail: Float32Array;
  footShade: Float32Array; // the shade on the pavement along the wall's foot: triangles, x y z and darkness per corner
  // The steps up to raised doorways, 8 floats a flight (three.js world): the two ends of
  // its foot along the wall (x z, x z), how far out it reaches (x z), the pavement and its top.
  steps: Float32Array;
  plateMounts: Float32Array; // a clear patch of plaster near either end, in world coordinates
  plaqueMounts: Float32Array; // the middle of each mapped memorial plaque (PLAQUE), in world coordinates
  doorPlates: Float32Array; // the middle of each house door's number plates (DOOR_PLATES), in world coordinates
  boards: Float32Array; // the chalkboards on the pavement: [x, y, z (its feet, world), runs, first vertex, count, …] each
}
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
// The shade under sills and the ground floor's cornice: how far down it reaches (m) and
// how much light is left at its top; and how far in front of the plaster its sheet lies.
const SILL_SHADE = [.5, .5], CORNICE_SHADE = [.6, .5], SHADE_LIFT = .006;
// The shade on the pavement along a wall's foot: how far out it reaches, how dark it is
// at the wall (0-1) and how far above the paving it lies.
const FOOT_SHADE = [.7, .5, .03];
const PIPE_ZINC = ['#78817f','#828685','#647673','#716d64'].map(c=>new THREE.Color(c));
const PIPE_CAST = new THREE.Color('#474845'), PIPE_STRAP = new THREE.Color('#595d59'), PIPE_INSIDE = new THREE.Color('#222522');
function clip(poly: Point[], a: V2, b: V2, sign: number) {
  const result: Point[] = []; const dx = b[0] - a[0], dy = b[1] - a[1];
  let last = poly[poly.length - 1], d0 = sign * cross(dx, dy, last[0] - a[0], last[1] - a[1]);
  for (const cur of poly) {
    const d = sign * cross(dx, dy, cur[0] - a[0], cur[1] - a[1]);
    if ((d >= 0) !== (d0 >= 0)) {
      const t = d0 / (d0 - d), l3 = last[3] ?? 1, at: Point = [last[0] + (cur[0] - last[0]) * t, last[1] + (cur[1] - last[1]) * t, last[2] + (cur[2] - last[2]) * t, l3 + ((cur[3] ?? 1) - l3) * t];
      if (last[4] !== undefined && cur[4] !== undefined) at.push(last[4] + (cur[4] - last[4]) * t);
      result.push(at);
    }
    if (d >= 0) result.push(cur);
    last = cur; d0 = d;
  }
  return result;
}

export function buildStreetWall(arrays: Pick<BuildingArrays, 'position' | 'color' | 'facade'> & { shops?: Float32Array; plaques?: Float32Array }, sky: Float32Array, triangles: Uint32Array): FacadeGeometry | null {
  const { position: p, color: c, facade: f } = arrays, first = triangles[0] * 12, w = f[first + 3], width = wallLength(f[first + 2]), style = Math.floor(w), bays = baysOf(w, width);
  if (!bays || style >= BLANK || width < 2) return null;
  const seed = Math.floor((w - style) * 32768) % 997, bay = width / bays;
  const ground = F_GROUND[style], storey = F_STOREY[style] * (STOREY_FIT[0] + (Math.floor((w - style) * 1024) % 32) * STOREY_FIT[1] / 31);
  const pos: number[] = [], norm: number[] = [], col: number[] = [], fac: number[] = [], shade: number[] = [], detail: number[] = [];
  const foot: number[] = [], steps: number[] = [];
  // Each chalkboard's vertices, by its bay: first vertex and how many, a run for each of the
  // wall's triangles it was drawn in (signFalls.ts knocks one over by them).
  const boardRuns = new Map<number, number[]>();
  // Ground-floor bays a mapped shop looks out of (mappedFrontages.ts: u, stock, word).
  const displays = new Map<number,{ stock: number; word: number }>();
  const shops=arrays.shops;
  if (shops && style<=STYLE.baroque && bay>=1.8) for (let i=0;i+2<shops.length;i+=3) {
    const u=shops[i], j=Math.floor(u/bay);
    const neighbour = u/bay-j>.5 ? 1 : -1;
    for (const k of [j,j+neighbour,j-neighbour]) {
      if (k<0 || k>=bays || Math.abs((k+.5)*bay-u)>4 || displays.has(k)) continue;
      const layer=streetModule(w,k,0,bays);
      if (F_DOOR.includes(layer) && !SHOPFRONTS.has(layer)) continue;
      displays.set(k,{ stock: shops[i+1], word: shops[i+2] }); break;
    }
  }
  // Where in a bay the shaders find lettering u (0–1) of a projecting sign: the inverse of
  // the fascia's u = .5 + (.5 - fract(x / bay)) * 1.55.
  const signX = (x: number, u: number) => Math.floor(x / bay) * bay + bay * (.5 - (u - .5) / 1.55);
  const moduleAt = (j:number,row:number) => !row && displays.has(j)
    ? (pick(seed,j,19)<.5 ? 58 : 66) : streetModule(w,j,row,bays);
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
    const mw = Math.min(bay, F_STREET_WIDTH[layer]), start = j * bay + (bay - mw) / 2;
    const ok = openings[layer].every(([x0, y0, x1, y1]) => {
      const lo = start + x0 / 256 * mw - .045, hi = start + x1 / 256 * mw + .045;
      const peak = caps[layer].reduce((y, p) => Math.min(y, p[1]), y0);
      const sill = bottom + (1 - y1 / 512) * h - .035, head = bottom + (1 - peak / 512) * h + .055;
      return [lo, (lo + hi) / 2, hi].every(x => onWall(x, sill) && onWall(x, head) && onWall(x, (sill + head) / 2));
    });
    eligible.set(key, ok); return ok;
  }
  // Look for a continuous strip beside the openings. A clipped party wall,
  // recessed entrance or full-width shopfront need not carry a downpipe.
  function pipeHeight(u: number) {
    let top = 0;
    for (const tri of triangles) for (let j=0;j<3;j++) {
      const a=tri*12+j*4, b=tri*12+((j+1)%3)*4, dx=f[b]-f[a];
      if (Math.abs(dx)<.001) continue;
      const k=(u-f[a])/dx;
      if (k>=0 && k<=1) top=Math.max(top,f[a+1]+k*(f[b+1]-f[a+1]));
    }
    const j=Math.min(bays-1,Math.floor(u/bay));
    for (let row=0, bottom=0; bottom<top-.4; row++) {
      const h=row?storey:ground, layer=moduleAt(j,row);
      const mw=Math.min(bay,F_STREET_WIDTH[layer]), left=j*bay+(bay-mw)*.5;
      if (!onWall(u,Math.min(top-.3,bottom+.38)) ||
          openings[layer].some(([lo,,hi]) => u+.16>left+lo*mw/256 && u-.16<left+hi*mw/256)) return 0;
      bottom+=h;
    }
    return onWall(u-.09,top-.35) && onWall(u+.09,top-.35) ? top : 0;
  }
  let pipeU=-1, pipeFaces: ReturnType<typeof rainpipe> = [];
  if (width>=5.5 && style!==STYLE.panel && pick(seed,0,37)<.56) {
    const offset=.23+.16*pick(seed,1,37);
    const choices = pick(seed,2,37)<.5 ? [offset,width-offset] : [width-offset,offset];
    for (const u of choices) {
      const h=pipeHeight(u);
      if (h<ground+2 || h>32) continue;
      pipeU=u; pipeFaces=rainpipe(u,h,ground); break;
    }
  }
  const pipePaint = {
    zinc: PIPE_ZINC[Math.floor(pick(seed,3,37)*PIPE_ZINC.length)],
    cast: PIPE_CAST, strap: PIPE_STRAP, inside: PIPE_INSIDE,
  };
  // Each house door's number plates (DOOR_PLATES): beside the door on the side away from
  // its bell panel, or above the panel where that side has no room.
  const doors: number[] = [], plated: [number, number][] = [], utilities: [number, number, number][] = [];
  const [plateWide, plateLow, plateHigh] = DOOR_PLATES;
  for (let j = 0; j < bays; j++) {
    const layer = moduleAt(j, 0);
    if (!houseDoor(layer) || !fits(layer, j, 0, 0, ground)) continue;
    const mw = Math.min(bay, F_STREET_WIDTH[layer]), start = j * bay + (bay - mw) / 2;
    const portal = openings[layer].find(([, y0, , y1, ]) => {
      const b = (1 - y1 / 512) * ground, t = (1 - y0 / 512) * ground;
      return (t - b) > ground * .49 && b < ground * .22;
    });
    if (!portal) continue;
    const [x0, , x1, , arch] = portal, l = start + x0 / 256 * mw, r = start + x1 / 256 * mw;
    const reach = arch > 0 && style <= 1 ? .19 : style <= 1 ? .086 : .052;
    const clear = (lo: number, hi: number, low = plateLow, high = plateHigh) => lo >= 0 && hi <= width && (pipeU < 0 || pipeU < lo - .08 || pipeU > hi + .08) &&
      [lo, hi].every(x => onWall(x, low) && onWall(x, high)) &&
      [Math.floor(lo / bay), Math.floor(hi / bay)].every(k => k === j || k < 0 || k >= bays || !openings[moduleAt(k, 0)].some(([a, y0, c, y1]) => {
        const kw = Math.min(bay, F_STREET_WIDTH[moduleAt(k, 0)]), ks = k * bay + (bay - kw) / 2;
        return hi > ks + a / 256 * kw - .12 && lo < ks + c / 256 * kw + .12 &&
          high > (1 - y1 / 512) * ground - .1 && low < (1 - y0 / 512) * ground + .1;
      }));
    const beside = l - reach - .04, above = r + reach + .05 + INTERCOM[0] / 2;
    const u = clear(beside - plateWide, beside) ? beside - plateWide / 2
      : clear(above - plateWide / 2, above + plateWide / 2) ? above : -1;
    const at = u < 0 ? null : worldAt(u, (plateLow + plateHigh) / 2);
    if (!at) continue;
    doors.push(...at);
    // Under the numbers beside the door, the steel door of the house's gas main (yellow) or
    // its electricity meters (grey), above the plinth (utilityDoor).
    const [wide, high, foot] = UTILITY_DOOR;
    if (u < l && clear(beside - wide, beside, foot, foot + high)) utilities.push([beside - wide, beside, layer % 2 ? GAS_DOOR : METER_DOOR]);
    plated.push([u - plateWide / 2, u + plateWide / 2]);
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
        const low=Math.min(ends[0][0],ends[1][0]), high=Math.max(ends[0][0],ends[1][0]);
        const outward=out.clone().normalize();
        for (let j=Math.max(0,Math.floor(low/bay));j<Math.min(bays,Math.ceil(high/bay));j++) {
          const layer=moduleAt(j,0), mw=Math.min(bay,F_STREET_WIDTH[layer]);
          if (!fits(layer,j,0,0,ground)) continue;
          for (const s of doorSteps(layer,bay,ground,mw,style)) {
            const lo=Math.max(low,j*bay+s.lo), hi=Math.min(high,j*bay+s.hi);
            if (hi<=lo) continue;
            const foot0=at([lo,0]), foot1=at([hi,0]);
            steps.push(foot0.x,foot0.z,foot1.x,foot1.z,outward.x*s.front,outward.z*s.front,foot0.y,foot0.y+s.b);
            const a=foot0.clone().addScaledVector(outward,s.front-.012), z=foot1.clone().addScaledVector(outward,s.front-.012);
            const c=z.clone().addScaledVector(outward,.16), d=a.clone().addScaledVector(outward,.16);
            for (const [v,alpha] of [[a,.34],[z,.34],[c,0],[a,.34],[c,0],[d,0]] as [THREE.Vector3,number][])
              foot.push(v.x,v.y+FOOT_SHADE[2],v.z,alpha);
          }
        }
      }
    }
    const minX = Math.min(a[0], b[0], d[0]), maxX = Math.max(a[0], b[0], d[0]), minY = Math.min(a[1], b[1], d[1]), maxY = Math.max(a[1], b[1], d[1]);
    const emit = (poly: Point[], layer: number, ao: number, kind: number = S.masonry, paint?: THREE.Color, finish?: number) => {
      const sign = Math.sign(det);
      for (const [p0, p1] of [[a, b], [b, d], [d, a]]) {
        if (!poly.length) return;
        poly = clip(poly, p0, p1, sign);
      }
      if (poly.length < 3) return;
      // The source triangle's two affine coordinates place even the back of
      // an arched door on the correct side of a sloping street.
      const placed = poly.map(([x, y, z, light = 1, word]) => {
        const u = cross(x - a[0], y - a[1], vx, vy) / det, v = cross(ux, uy, x - a[0], y - a[1]) / det;
        return { x, y, u, v, light, word, depth: z, world: X.clone().addScaledVector(U, u).addScaledVector(V, v).addScaledVector(N, z) };
      });
      for (let i = 1; i < placed.length - 1; i++) {
        const q = [placed[0], placed[i], placed[i + 1]];
        if (det < 0) q.reverse();
        const normal = new THREE.Vector3().crossVectors(q[1].world.clone().sub(q[0].world), q[2].world.clone().sub(q[0].world));
        if (normal.lengthSq() < 1e-14) continue; normal.normalize();
        for (const t of q) {
          pos.push(t.world.x, t.world.y, t.world.z); norm.push(normal.x, normal.y, normal.z);
          if (paint) col.push(paint.r, paint.g, paint.b);
          else for (let j = 0; j < 3; j++)col.push(c[o + j] + t.u * (c[o + 3 + j] - c[o + j]) + t.v * (c[o + 6 + j] - c[o + j]));
          // (The shaders letter a sign by its facade x within the bay: SIGN_U.)
          fac.push(t.word === undefined ? t.x : signX(t.x, t.word), t.y, f[k + 2], w); shade.push(sky[vertex] + t.u * (sky[vertex + 1] - sky[vertex]) + t.v * (sky[vertex + 2] - sky[vertex]));
          // For a glazed light the spare depth channel identifies the curtains
          // or blind shared by its sashes. Reveal faces still carry real depth.
          const fascia = kind === S.shopSign;
          const value = fascia ? (finish ?? 0) + .04 + .92 * t.light : finish ?? t.depth;
          detail.push(layer, fascia || kind === S.shopPaint ? ao : ao * t.light, kind, value);
        }
      }
    };
    for (const [lo, hi, paint] of utilities) {
      if (hi < minX || lo > maxX || UTILITY_DOOR[2] > maxY || UTILITY_DOOR[2] + UTILITY_DOOR[1] < minY) continue;
      for (const [poly, kind, ao] of utilityDoor(lo, hi)) emit(poly, 0, ao, kind === S.shopPaint ? S.shopPaint : kind, kind === S.shopPaint ? UTILITY_PAINT[paint] : undefined);
    }
    if (pipeFaces.length && pipeU+.10>=minX && pipeU-.10<=maxX) {
      for (const face of pipeFaces) {
        if (face.points.every(q=>q[1]<minY) || face.points.every(q=>q[1]>maxY)) continue;
        emit(face.points,0,1,S.shopPaint,pipePaint[face.finish]);
      }
    }
    // Most openings only need relief near the pavement. A deep loggia casts
    // a visible shadow even several floors up when you stand below the block.
    const band = (lo: number, hi: number) => {
      if (hi <= lo) return;
      const shell = style === STYLE.panel ? S.masonry : S.glass;
      emit([[minX, lo, 0], [maxX, lo, 0], [maxX, hi, 0]], -1, 1, shell);
      emit([[minX, lo, 0], [maxX, hi, 0], [minX, hi, 0]], -1, 1, shell);
    };
    const interwar = Math.floor(w * 32768) % 16 === LOOK.interwarFlats;
    const upperRows = style === STYLE.panel ? 12 : interwar ? 8 : 3;
    band(minY, Math.min(0, maxY)); band(Math.max(ground + upperRows * storey, minY), maxY);
    for (let row = 0; row <= upperRows; row++) {
      const bottom = row ? ground + (row - 1) * storey : 0, h = row ? storey : ground;
      if (bottom >= maxY || bottom + h <= minY) continue;
      for (let j = Math.max(0, Math.floor(minX / bay)); j < Math.min(bays, Math.ceil(maxX / bay)); j++) {
        const layer = moduleAt(j,row);
        const fitsBay = fits(layer, j, row, bottom, h);
        if (!fitsBay || (row > 3 && layer !== 113 && !isLoggia(layer))) {
          // The map clips this bay at a passage, gable or parapet. Leave a
          // plain infill here instead of exposing half a window at the roofline.
          const lo = j * bay, hi = lo + bay, top = bottom + h;
          const surface = fitsBay ? S.masonry : S.infill;
          emit([[lo, bottom, 0], [hi, bottom, 0], [hi, top, 0]], layer, 1, surface);
          emit([[lo, bottom, 0], [hi, top, 0], [lo, top, 0]], layer, 1, surface);
          continue;
        }
        const shop = !row && SHOPFRONTS.has(layer), group = Math.floor(j / 2);
        const finish = shop ? SHOP_FINISHES[Math.floor(pick(seed, group, 12) * SHOP_FINISHES.length)] : null;
        const awning = shop && pick(seed, group, 13) < .36;
        // Two adjacent displays see one room; only its first fascia names it. A mapped
        // shop names its own trade, and the other bay of its room stays plain.
        const mapped = !row ? displays.get(j) : undefined;
        const sign = shop && (mapped ? mapped.word >= 0
          : !displays.has(j % 2 ? j - 1 : j + 1) && (j % 2 === 0 || !SHOPFRONTS.has(moduleAt(j-1,0))));
        const trade = mapped ? mapped.word : Math.floor(pick(seed, group, 9) * 4);
        const furnishing = pick(seed, j, 20 + row);
        const key = layer * 4 + Number(!!row) * 2 + Number(awning);
        let shape = shapes.get(key);
        if (!shape) {
          shape = cellShape(layer, bay, h, Math.min(bay, F_STREET_WIDTH[layer]), !!row, style, awning);
          shapes.set(key, shape);
        }
        for (const [l, m, r, ao, kind] of shape) {
          const dx = j * bay;
          if (dx + Math.min(l[0], m[0], r[0]) > maxX || dx + Math.max(l[0], m[0], r[0]) < minX ||
            bottom + Math.min(l[1], m[1], r[1]) > maxY || bottom + Math.max(l[1], m[1], r[1]) < minY) continue;
          const paint = kind === NAME_STRIP ? NAME_PAINT : kind in UTILITY_PAINT ? UTILITY_PAINT[kind] : kind === S.shopPaint || kind === S.shopSign ? finish?.[0] : kind === S.canvas ? finish?.[1] : undefined;
          const pane = kind === FURNISHED_PANE;
          const surface = pane ? S.glass : (kind === S.shopSign && !sign) || kind === NAME_STRIP || kind in UTILITY_PAINT ? S.shopPaint : kind;
          const finishValue = pane ? furnishing : surface === S.shopSign ? trade
            : surface===S.display && mapped && mapped.stock >= 0 ? mapped.stock+1 : undefined;
          emit([l, m, r].map(([x, y, z, light]) => [dx + x, bottom + y, z, light]), layer === 113 ? 41 : layer, ao, surface, paint, finishValue);
        }
        // A window box of geraniums on some first-floor sills of older houses, spring to autumn.
        if (row === 1 && style <= STYLE.baroque && !isLoggia(layer) && openings[layer]?.length && layer !== 113 && pick(seed, j + 7, 33) < .22) {
          const [x0, , x1, y1] = openings[layer][0], mw = Math.min(bay, F_STREET_WIDTH[layer]), start = j * bay + (bay - mw) / 2;
          const sill = (1 - y1 / 512) * h, lo = start + x0 / 256 * mw + .04, hi = start + x1 / 256 * mw - .04;
          if (hi - lo > .5 && sill > .4) for (const [poly, kind, ao] of windowBox(lo, hi, sill - .005, seed + j)) {
            emit(poly.map(([x, y, z]) => [x, bottom + y, z]), layer, ao, S.shopPaint, WALL_KIT_PAINT[-10 - kind], kind <= -15 ? FLOWERS : undefined);
          }
        }
        // Now and then an air conditioner under a window, mostly on modern and panel fronts,
        // or a satellite dish beside one.
        if (row && !isLoggia(layer) && openings[layer]?.length && layer !== 113) {
          const chance = pick(seed, j + row * 41, 31), modern = style >= STYLE.functionalist;
          const [x0, , x1, y1] = openings[layer][0], mw = Math.min(bay, F_STREET_WIDTH[layer]), start = j * bay + (bay - mw) / 2;
          const sill = (1 - y1 / 512) * h, middle = start + (x0 + x1) / 512 * mw, side = start + x1 / 256 * mw + .45;
          const kit = chance < (modern ? .09 : .025) && sill > .75 ? airConditioner(middle, sill - .16)
            : chance > (modern ? .96 : .995) && side + .35 < (j + 1) * bay ? satelliteDish(side, sill + .9) : [];
          for (const [poly, kind, ao] of kit) {
            emit(poly.map(([x, y, z]) => [x, bottom + y, z]), layer, ao, kind <= -10 ? S.shopPaint : kind, kind <= -10 ? WALL_KIT_PAINT[-10 - kind] : undefined);
          }
        }
        // In front of a café, bakery, restaurant or pub the map names, now and then a chalkboard
        // with its word; above some shops an alarm box.
        if (!row && shop && sign) {
          const board = mapped && CHALKBOARD.has(mapped.word) && pick(seed, j, 25) < .55;
          const first = pos.length / 3;
          if (board) for (const [poly, kind, ao] of chalkboard(j * bay + bay * (pick(seed, j, 26) < .5 ? .3 : .7), .95)) {
            emit(poly.map(([x, y, z, light, u]) => [x, bottom + y, z, light, u]), layer, ao, kind, kind === S.shopSign ? CHALK : finish?.[0], kind === S.shopSign ? mapped!.word : undefined);
          }
          if (pos.length / 3 > first) { const runs = boardRuns.get(j) ?? []; runs.push(first, pos.length / 3 - first); boardRuns.set(j, runs); }
          if (pick(seed, j, 27) < .3 && h > 3.3) for (const [poly, kind, ao] of alarmBox(j * bay + bay - .35, h - .45)) {
            emit(poly.map(([x, y, z]) => [x, bottom + y, z]), layer, ao, S.shopPaint, WALL_KIT_PAINT[kind === -13 ? 3 : 2]);
          }
        }
        // A mapped shop's sign standing out from the wall at the bay's edge, level with the
        // top of the fascia, lettered with its trade on both faces (projectingSign).
        if (sign && mapped && mapped.word >= 0 && (PROJECTING.has(mapped.word) || pick(seed, j, 23) < .5)) {
          // As high as the ground storey allows, under the first floor's sills.
          const low = h - .5;
          if (low > 2.5) for (const [poly, kind, ao] of projectingSign(j * bay + .14, low)) {
            emit(poly.map(([x, y, z, light, u]) => [x, bottom + y, z, light, u]), layer, ao, kind, kind === S.iron ? undefined : finish?.[0], kind === S.shopSign ? trade : undefined);
          }
        }
        if (openings[layer]?.length) modeled = true;
      }
    }
  }
  if (!modeled || !pos.length) return null;
  // The point (u, h) of the wall in the world, through the source triangle it lies on.
  function worldAt(u: number, h: number) {
    for (const tri of triangles) {
      const k = tri * 12, x = f[k], y = f[k + 1];
      const ux = f[k + 4] - x, uy = f[k + 5] - y, vx = f[k + 8] - x, vy = f[k + 9] - y;
      const det = cross(ux, uy, vx, vy);
      if (Math.abs(det) < 1e-6) continue;
      const a = cross(u - x, h - y, vx, vy) / det, b = cross(ux, uy, u - x, h - y) / det;
      if (a < -1e-5 || b < -1e-5 || a + b > 1.00001) continue;
      const i = tri * 9;
      return [0, 1, 2].map(j => p[i + j] + a * (p[i + 3 + j] - p[i + j]) + b * (p[i + 6 + j] - p[i + j]));
    }
    return null;
  }
  // Find room for an 80 × 40 cm enamel plate. Keep the whole tablet clear of
  // door surrounds, sills, the storey cornice and holes in the source wall.
  const mounts: number[] = [], taken: [number, number, number, number][] = [];
  // `hw`, `hh`: half the tablet's width and height; the middle goes into `into`.
  function mount(u: number, h: number, hw = .44, hh = .24, into = mounts) {
    if (pipeU >= 0 && Math.abs(u-pipeU) < hw + .08) return false;
    const left = u - hw, right = u + hw, low = h - hh, high = h + hh;
    if (taken.some(([l, r, b, t]) => right > l - .1 && left < r + .1 && high > b - .1 && low < t + .1)) return false;
    if (left < 0 || right > width || high > ground - .30) return false;
    if (low < plateHigh + .05 && plated.some(([lo, hi]) => right > lo - .05 && left < hi + .05)) return false;
    for (let j = Math.floor(left / bay); j <= Math.min(bays - 1, Math.floor(right / bay)); j++) {
      const layer = moduleAt(j,0), mw = Math.min(bay, F_STREET_WIDTH[layer]), start = j * bay + (bay - mw) / 2;
      if (openings[layer].some(([x0, y0, x1, y1]) =>
        right > start + x0 / 256 * mw - .23 && left < start + x1 / 256 * mw + .23 &&
        high > (1 - y1 / 512) * ground - .15 && low < (1 - y0 / 512) * ground + (SHOPFRONTS.has(layer) ? .36 : .24))) return false;
    }
    if (![left, right].every(x => onWall(x, low) && onWall(x, high))) return false;
    const at = worldAt(u, h);
    if (at) { into.push(...at); taken.push([left, right, low, high]); }
    return !!at;
  }
  if (width >= 4) for (const end of [0, 1]) {
    // On a wide bay the first doorway or window can occupy every position
    // near the corner. Try the plaster pier between it and the next bay too.
    for (const inset of [.58, .95, 1.45, 2.05, Math.min(4.5, bay)]) {
      if (inset >= width / 2) break;
      if ([2.75, 3.1, 2.4, 3.55].some(h => mount(end ? width - inset : inset, h))) break;
    }
  }
  // A mapped memorial plaque goes on the nearest clear plaster to where its ray meets the
  // wall, at about the height people put them (PLAQUE).
  const plaques: number[] = [];
  for (const u of arrays.plaques ?? []) {
    const [hw, hh] = PLAQUE;
    [0, .5, -.5, 1, -1, 1.6, -1.6, 2.3, -2.3].some(du => [2.7, 3.0, 2.4].some(h => mount(u + du, h, hw, hh, plaques)));
  }
  // The chalkboards: the middle of each one's feet (three.js world) and its runs of vertices,
  // [x, y, z, runs, first, count, …] one after another.
  const boards: number[] = [];
  for (const runs of boardRuns.values()) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity;
    for (let r = 0; r < runs.length; r += 2) for (let i = runs[r]; i < runs[r] + runs[r + 1]; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); y0 = Math.min(y0, y);
    }
    boards.push((x0 + x1) / 2, y0, (z0 + z1) / 2, runs.length / 2, ...runs);
  }
  return { boards: Float32Array.from(boards), plateMounts: Float32Array.from(mounts), plaqueMounts: Float32Array.from(plaques), doorPlates: Float32Array.from(doors), footShade: Float32Array.from(foot), steps: Float32Array.from(steps), position: new Float32Array(pos), normal: new Float32Array(norm), color: new Float32Array(col), facade: new Float32Array(fac), sky: new Float32Array(shade), detail: new Float32Array(detail) };
}
