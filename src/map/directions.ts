// Direction signs (pipeline/build_traffic_signs.py `directions`): at a junction, an arrow
// plate for each way on that leads somewhere named, stacked on a post (on the wall where
// there is no pavement); before a junction on the bigger roads, a board on two posts with
// the junction drawn and the places on each branch; over the lanes of the main roads, a
// gantry with a panel over each run of lanes going the same way (an arm from the kerb
// where only the lanes turning off have one). Their text is their own, so each tile
// draws its signs' faces onto a canvas of its own (src/signs.ts drawDirections); this
// module lays the canvas out the same way in the land worker, which builds the geometry.
import * as THREE from 'three';
import { SignParts, mergedArrays, stand, ARM_INTO } from './signs.ts';
import type { WallMount } from './signs.ts';
import type { Point2 } from './geo.ts';

export type PlateColour = 'green' | 'blue' | 'white' | 'brown';
export interface Branch { turn: number; places: string[]; refs: string[]; symbol: string; colour: PlateColour }
// A gantry's panel: over lanes `first` to `last` (0 the left one), with their turns.
export interface Panel { first: number; last: number; places: string[]; refs: string[]; symbol: string; colour: PlateColour; turns: string[] }
// (x, y): a plate's or board's post, by the kerb; a gantry's middle on the street's line.
export interface DirectionSign {
  x: number; y: number; angle: number; kind: 'plates' | 'board' | 'gantry'; branches: Branch[];
  gantry?: { panels: Panel[]; lanes: number; half: number };
}
// One face: a plate (pointing -1 left, 1 right, 0 straight on), a board or a gantry's panel,
// w × h m, drawn at `px` px a metre.
export interface Face {
  kind: 'plate' | 'board' | 'panel'; w: number; h: number; px: number; point: -1 | 0 | 1; places: string[]; refs: string[];
  branch: Branch | null; panel?: Panel; sign: DirectionSign;
}

export const STRAIGHT = 30, PER_PLATE = 2, PLATES_PER_BRANCH = 2;
export const PX = 150; // px a metre on the canvas
const LINE = .2, CHAR = .1, REF = .34, PAD = .2, MIN_W = .9, MAX_W = 2.2;
export const BOARD_W = 2.6;
// A panel is LANE_W a lane wide (less PANEL_GAP), drawn coarser so the widest fit the canvas.
export const LANE_W = 3.3, PANEL_GAP = .3, PANEL_PX = 80, PANEL_LINE = .4;

// A branch's places, two to a plate, at most PLATES_PER_BRANCH plates; the road numbers on the first.
export function signFaces(sign: DirectionSign): Face[] {
  const out: Face[] = [];
  if (sign.kind === 'gantry') {
    // Each panel: its road numbers, up to four places, the lanes' arrows underneath.
    for (const p of sign.gantry?.panels ?? []) {
      const places = p.places.slice(0, 4), lines = places.length + (p.refs.length ? 1 : 0);
      out.push({ kind: 'panel', w: Math.min((WIDTH - 12) / PANEL_PX, Math.max(2.2, (p.last - p.first + 1) * LANE_W - PANEL_GAP)), h: .5 + lines * PANEL_LINE + .55, px: PANEL_PX,
        point: 0, places, refs: p.refs, branch: null, panel: p, sign });
    }
    return out;
  }
  if (sign.kind === 'board') {
    const lines = sign.branches.reduce((n, b) => n + Math.min(3, Math.max(1, b.places.length)), 0);
    out.push({ kind: 'board', w: BOARD_W, h: Math.min(2.2, Math.max(1.4, .9 + lines * .17)), px: PX, point: 0, places: [], refs: [], branch: null, sign });
    return out;
  }
  for (const b of sign.branches) {
    const point = Math.abs(b.turn) < STRAIGHT ? 0 : b.turn > 0 ? -1 : 1;
    const places = b.places.length ? b.places : [''];
    for (let k = 0; k < Math.min(PLATES_PER_BRANCH, Math.ceil(places.length / PER_PLATE)); k++) {
      const lines = places.slice(k * PER_PLATE, (k + 1) * PER_PLATE), refs = k ? [] : b.refs;
      const h = lines.length > 1 ? .52 : .32;
      const chars = Math.max(...lines.map(l => l.length));
      const w = Math.min(MAX_W, Math.max(MIN_W, chars * CHAR + refs.length * REF + (b.symbol ? .3 : 0) + (point ? h / 2 : .3) + PAD));
      out.push({ kind: 'plate', w, h, px: PX, point: point as -1 | 0 | 1, places: lines, refs, branch: b, sign });
    }
  }
  return out;
}

export interface Rect { x: number; y: number; w: number; h: number }
// The tile's canvas: a white corner (for the plain parts), then every face in order, packed
// on shelves WIDTH px wide.
export const WIDTH = 1024, WHITE_CORNER = 8;
export function directionLayout(signs: DirectionSign[]) {
  const faces = signs.flatMap(signFaces), rects: Rect[] = [];
  let x = WHITE_CORNER, y = 0, shelf = WHITE_CORNER;
  for (const f of faces) {
    const w = Math.ceil(f.w * f.px) + 4, h = Math.ceil(f.h * f.px) + 4;
    if (x + w > WIDTH) { x = 0; y += shelf; shelf = 0; }
    rects.push({ x: x + 2, y: y + 2, w: w - 4, h: h - 4 });
    x += w; shelf = Math.max(shelf, h);
  }
  return { faces, rects, width: WIDTH, height: Math.max(WHITE_CORNER, Math.ceil((y + shelf) / 4) * 4) };
}

// A face's outline about its middle, anticlockwise from the front.
export function faceOutline(f: Pick<Face, 'w' | 'h' | 'point'>): Point2[] {
  const a = f.w / 2, b = f.h / 2, p = b;
  if (f.point > 0) return [[-a, -b], [a - p, -b], [a, 0], [a - p, b], [-a, b]];
  if (f.point < 0) return [[-a, 0], [-a + p, -b], [a, -b], [a, b], [-a + p, b]];
  return [[-a, -b], [a, -b], [a, b], [-a, b]];
}

export const PLATE_BOTTOM = 2.2, PLATE_GAP = .04;
const POST_R = .03, BOARD_POST_R = .045;

// The tile's direction signs' geometry (in its canvas's coordinates) and their posts.
export function directionGeometry(signs: DirectionSign[], onRoad: (x: number, y: number) => boolean, inside: (x: number, y: number) => boolean,
  height: (x: number, y: number) => number) {
  const { faces, rects, width, height: H } = directionLayout(signs);
  const white = [WHITE_CORNER / 2 / width, 1 - WHITE_CORNER / 2 / H];
  const out: THREE.BufferGeometry[] = [], posts: { x: number; y: number; wall: boolean; count: number }[] = [], walls: WallMount[] = [];
  let k = 0;
  for (const sign of signs) {
    const own = faces.slice(k, k += signFaces(sign).length), boxes = rects.slice(k - own.length, k);
    // (A face drawn \`px\` px a metre and shown \`stretch\` times as wide as drawn.)
    const uvFor = (r: Rect, px = PX, stretch = 1) => (x: number, y: number) => [(r.x + r.w / 2 + x / stretch * px) / width, 1 - (r.y + r.h / 2 - y * px) / H];
    const o = new SignParts(white);
    const dx = Math.cos(sign.angle), dy = Math.sin(sign.angle);
    if (sign.kind === 'gantry' && sign.gantry && own.length) {
      const built = gantry(o, sign, own, boxes.map((r, i) => (stretch: number) => uvFor(r, own[i].px, stretch)), onRoad, height);
      if (!built) continue;
      out.push(o.placed(sign.x, sign.y, built.z, sign.angle));
      for (const s of built.legs) posts.push({ x: sign.x + dx * s, y: sign.y + dy * s, wall: false, count: own.length });
      continue;
    }
    const at = stand(sign.x, sign.y, sign.angle, onRoad, inside);
    if (!at || !own.length) continue;
    if (sign.kind === 'board') {
      // On two posts, its near edge where a post would stand: only where there is room.
      const f = own[0];
      if (at.wall) continue;
      const cx = at.x + dx * f.w / 2, cy = at.y + dy * f.w / 2;
      if ([0, .5, 1].some(t => inside(at.x + dx * f.w * t, at.y + dy * f.w * t))) continue;
      const z = height(cx, cy);
      if (!Number.isFinite(z)) continue;
      const my = PLATE_BOTTOM + f.h / 2, legs = f.w / 2 - .35;
      for (const s of [-1, 1]) o.post(PLATE_BOTTOM + f.h - .05, s * legs, BOARD_POST_R);
      for (const s of [-1, 1]) for (const t of [-.3, .3]) o.block(s * legs - .05, s * legs + .05, my + t * f.h - .03, my + t * f.h + .03, 0, .06);
      o.plate(faceOutline(f), 0, my, .06, .04, uvFor(boxes[0]));
      out.push(o.placed(cx, cy, z, sign.angle));
      posts.push({ x: cx - dx * legs, y: cy - dy * legs, wall: false, count: 1 }, { x: cx + dx * legs, y: cy + dy * legs, wall: false, count: 1 });
      continue;
    }
    const z = height(at.x, at.y);
    if (!Number.isFinite(z)) continue;
    // The plates top down in the pipeline's order (straight on, then left to right), the lowest PLATE_BOTTOM up.
    const mids: number[] = [];
    let y = PLATE_BOTTOM;
    for (let i = own.length - 1; i >= 0; i--) { mids[i] = y + own[i].h / 2; y += own[i].h + PLATE_GAP; }
    const widest = Math.max(...own.map(f => f.w));
    const cx = at.wall ? -(widest / 2 + .1) : 0;
    if (!at.wall) o.post(y - PLATE_GAP);
    own.forEach((f, i) => {
      if (at.wall) for (const s of [-1, 1]) o.block(cx - .02, ARM_INTO, mids[i] + s * f.h * .28 - .015, mids[i] + s * f.h * .28 + .015, -.015, .015);
      else o.block(-.035, .035, mids[i] - .02, mids[i] + .02, 0, POST_R + .025);
      o.plate(faceOutline(f), cx, mids[i], at.wall ? .02 : POST_R + .025, .02, uvFor(boxes[i]));
    });
    if (at.wall) walls.push({ part: out.length, x: at.x, y: at.y, z, angle: sign.angle });
    out.push(o.placed(at.x, at.y, z, sign.angle));
    posts.push({ x: at.x, y: at.y, wall: at.wall, count: own.length });
  }
  return mergedArrays(out, posts, walls);
}
export type DirectionArrays = NonNullable<ReturnType<typeof directionGeometry>>;

// A gantry across the carriageway at the sign's point, in the sign's frame (local x to the
// traffic's right): the carriageway's edges found on the game's own road out from the line
// (OSM's half width where the line isn't on it), its lanes shared out evenly, each panel
// over its lanes (narrowed where the lanes are narrower than LANE_W), the panels' bottom
// GANTRY_CLEAR up. A truss of two chords and zigzag braces on a post past each edge; an arm
// from a post past the right edge where only the lanes on the right have a panel. Gives the
// ground height it stands at and its posts along local x, or null.
export const GANTRY_CLEAR = 5.3, GANTRY_POST = .17, EDGE_REACH = 20;
function gantry(o: SignParts, sign: DirectionSign, faces: Face[], uv: ((stretch: number) => (x: number, y: number) => number[])[],
  onRoad: (x: number, y: number) => boolean, height: (x: number, y: number) => number) {
  const { lanes, half } = sign.gantry!, dx = Math.cos(sign.angle), dy = Math.sin(sign.angle);
  const at = (s: number): Point2 => [sign.x + dx * s, sign.y + dy * s];
  const edge = (dir: 1 | -1) => {
    if (!onRoad(...at(0))) return dir * half;
    let s = 0;
    while (s < EDGE_REACH && onRoad(...at(dir * (s + .25)))) s += .25;
    return dir * s;
  };
  let left = edge(-1), right = edge(1);
  if (right - left < 2.5 * lanes || right - left > 5 * lanes + 4) { left = -half; right = half; }
  const lw = (right - left) / lanes;
  const arm = faces.every(f => f.panel!.first >= Math.ceil(lanes / 2));
  const legs = arm ? [right + 1] : [left - 1, right + 1];
  const zs = legs.map(s => height(...at(s))).filter(Number.isFinite);
  if (!zs.length) return null;
  const z = Math.min(...zs);
  const tallest = Math.max(...faces.map(f => f.h)), bottom = GANTRY_CLEAR, top = bottom + tallest;
  const chords = [bottom + .3, top - .3], from = arm ? Math.min(...faces.map(f => left + f.panel!.first * lw)) - .4 : legs[0];
  // The posts, on concrete footings, and the truss.
  for (const s of legs) {
    o.post(top + .15, s, GANTRY_POST);
    o.block(s - .4, s + .4, -.3, .25, -.4, .4, FOOTING);
  }
  for (const y of chords) o.tube([from, y, 0], [legs[legs.length - 1], y, 0], .08);
  for (let x = from, i = 0; x < legs[legs.length - 1] - .2; x += 1.4, i++) {
    const x1 = Math.min(legs[legs.length - 1], x + 1.4);
    o.tube([x, chords[i % 2], 0], [x1, chords[(i + 1) % 2], 0], .035);
  }
  faces.forEach((f, i) => {
    const p = f.panel!, span = (p.last - p.first + 1) * lw - PANEL_GAP, w = Math.min(f.w, span), stretch = w / f.w;
    const cx = left + (p.first + p.last + 1) / 2 * lw, my = bottom + f.h / 2;
    for (const s of [-1, 1]) o.block(cx + s * w * .35 - .04, cx + s * w * .35 + .04, my - f.h / 2 + .1, my + f.h / 2 - .1, .05, .16);
    o.plate(faceOutline({ ...f, w }), cx, my, .16, .06, uv[i](stretch));
  });
  return { z, legs };
}
const FOOTING = new THREE.Color('#9b9a94');

// The file's `directions` rows as signs.
export function readDirections(rows: unknown): DirectionSign[] {
  const out: DirectionSign[] = [];
  const COLOURS = new Set(['green', 'blue', 'white', 'brown']);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || !Array.isArray(row[4])) continue;
    const [x, y, degrees, kind] = row as [number, number, number, string];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (kind !== 'plates' && kind !== 'board' && kind !== 'gantry')) continue;
    if (kind === 'gantry') {
      // [x, y, angle, 'gantry', [[first lane, last lane, places, road numbers, symbol, colour, turns]], lanes, one way, half width]
      const lanes = Number(row[5]) || 0, half = Number(row[7]) || 0;
      const panels = (row[4] as unknown[][]).filter(p => Array.isArray(p)).map(([first, last, to, ref, symbol, colour, turns]) => ({
        first: Number(first) || 0, last: Number(last) || 0, places: String(to ?? '').split(';').map(s => s.trim()).filter(Boolean),
        refs: String(ref ?? '').split(';').map(s => s.trim()).filter(Boolean), symbol: String(symbol ?? '').split(';')[0],
        colour: (COLOURS.has(String(colour)) ? colour : 'blue') as PlateColour, turns: String(turns ?? '').split('|'),
      })).filter(p => p.first >= 0 && p.last >= p.first && p.last < lanes);
      if (panels.length && lanes > 0 && half > 0) out.push({ x, y, angle: degrees * Math.PI / 180, kind, branches: [], gantry: { panels, lanes, half } });
      continue;
    }
    const branches =(row[4] as unknown[][]).filter(b => Array.isArray(b)).map(([turn, to, ref, symbol, colour]) => ({
      turn: Number(turn) || 0, places: String(to ?? '').split(';').map(s => s.trim()).filter(Boolean),
      refs: String(ref ?? '').split(';').map(s => s.trim()).filter(Boolean), symbol: String(symbol ?? '').split(';')[0],
      colour: (COLOURS.has(String(colour)) ? colour : 'blue') as PlateColour,
    }));
    if (branches.length) out.push({ x, y, angle: degrees * Math.PI / 180, kind, branches });
  }
  return out;
}
