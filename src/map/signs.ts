// Traffic signs on their posts, made in the land tile worker from pipeline/build_traffic_signs.py's
// points (src/signs.ts loads them and draws the faces). Each sign stands where the pipeline
// puts it, to the right of its traffic, facing it, then:
// - off the game's carriageway, or in from the pavement's far side to KERB_SET from the kerb;
// - on the wall where there is no pavement for a post (in the old town's narrow streets):
//   hung from a bracket, its edge to the wall;
// - signs for the same traffic within JOIN of each other share one post, at most
//   PER_POST besides plates, the most important on top (priority, then prohibitions and
//   zones, then orders, then information), a plate under the sign it was put with;
// - the lowest sign's bottom BOTTOM above the pavement, as the Czech rules ask over a footway.
// All a tile's signs are one mesh: grey galvanised posts and the signs' backs, rims and
// clamps in plain colour, the faces planar-mapped onto their cells of the sign atlas.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './geo.ts';
import { readDirections } from './directions.ts';
import type { DirectionSign } from './directions.ts';

export type SignShape = 'disc' | 'square' | 'give' | 'octagon' | 'diamond' | 'rect' | 'plate' | 'box';
// w × h in metres; rank: 0 priority, 1 prohibitions and zones, 2 orders, 3 information, 9 plates.
export interface SignStyle { shape: SignShape; w: number; h: number; rank: number }

const PROHIBITIONS = new Set(['no entry', 'no lorries', 'no motor vehicles', 'no left turn', 'no right turn']);
const ORDERS = new Set(['roundabout', 'ahead only', 'left only', 'right only']);
const INFORMATION = new Set(['one way', 'crossing', 'speed bump']);
export function signStyle(name: string): SignStyle | null {
  if (name === 'give way') return { shape: 'give', w: .75, h: .65, rank: 0 };
  if (name === 'stop') return { shape: 'octagon', w: .6, h: .6, rank: 0 };
  if (name === 'main road') return { shape: 'diamond', w: .6, h: .6, rank: 0 };
  if (name === 'crossing lit') return { shape: 'box', w: .7, h: .7, rank: 3 };
  if (name === 'except access') return { shape: 'plate', w: .55, h: .25, rank: 9 };
  if (INFORMATION.has(name)) return { shape: 'square', w: .5, h: .5, rank: 3 };
  if (ORDERS.has(name)) return { shape: 'disc', w: .6, h: .6, rank: 2 };
  if (PROHIBITIONS.has(name) || /^(speed \d+( end)?|weight [\d.]+|height [\d.]+)$/.test(name)) return { shape: 'disc', w: .6, h: .6, rank: 1 };
  if (/^(zone \d+|living street|pedestrian zone)( end)?$/.test(name)) return { shape: 'rect', w: .6, h: .85, rank: 1 };
  return null;
}

// The sign atlas: square cells of CELL px, `cols` to a row, cell 0 plain white, the signs
// in their file's order from cell 1. A face fills its cell's middle at its own proportions.
export const CELL = 128, CELL_MARGIN = 3;
export const atlasCols = (signs: number) => Math.ceil(Math.sqrt(signs + 1));
export function cellRect(cell: number, cols: number, style: Pick<SignStyle, 'w' | 'h'>) {
  const scale = (CELL - 2 * CELL_MARGIN) / Math.max(style.w, style.h), w = style.w * scale, h = style.h * scale;
  const x = (cell % cols) * CELL + (CELL - w) / 2, y = Math.floor(cell / cols) * CELL + (CELL - h) / 2;
  return { x, y, w, h, scale };
}

export const KERB_SET = .5, JOIN = 1.2, PER_POST = 2, BOTTOM = 2.1, PLATE = 9;
const GAP = .05, POST_R = .03, PULL = 4, PUSH = 8, STEP = .25;
// How far apart two headings are, 0 to π.
const turnBetween = (a: number, b: number) => Math.abs(((a - b) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
export interface SignPost { x: number; y: number; z: number; angle: number; wall: boolean; signs: number[]; from?: number[] }

// Where a sign put at (x, y) for the traffic `angle` faces (its local x away from the road)
// stands: off the carriageway, or in from the pavement, KERB_SET from the kerb; on the wall
// where a house front is there instead; null where neither works.
export function stand(x: number, y: number, angle: number, onRoad: (x: number, y: number) => boolean, inside: (x: number, y: number) => boolean) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let wall = false;
  if (onRoad(x, y)) {
    let moved = 0;
    while (moved < PUSH && onRoad(x, y)) { x += dx * STEP; y += dy * STEP; moved += STEP; }
    if (onRoad(x, y)) return null;
    x += dx * KERB_SET; y += dy * KERB_SET;
  } else {
    // In towards the kerb, to stand by it rather than out in the pavement.
    let moved = 0;
    while (moved < PULL && !onRoad(x - dx * STEP, y - dy * STEP)) { x -= dx * STEP; y -= dy * STEP; moved += STEP; }
    if (moved < PULL) { x += dx * KERB_SET; y += dy * KERB_SET; }
  }
  if (inside(x, y)) {
    // No room for a post: on the wall, where the house front meets the way back to the road.
    let moved = 0;
    while (moved < PUSH && inside(x, y)) { x -= dx * STEP / 2; y -= dy * STEP / 2; moved += STEP / 2; }
    if (inside(x, y)) return null;
    wall = true;
  }
  return { x, y, wall };
}

// `points`: [sign, x, y, angle] (the angle as street-furniture.json's: local x to the
// traffic's right, local +z its face); `names` the signs' names by index.
export function signPosts(points: Float32Array, names: string[], onRoad: (x: number, y: number) => boolean, inside: (x: number, y: number) => boolean,
  height: (x: number, y: number) => number): SignPost[] {
  const posts: SignPost[] = [];
  // The signs, most important first (to have the first places on the posts), then the
  // plates (to go under the signs already up).
  const order: number[] = [];
  for (let i = 0; i + 3 < points.length; i += 4) order.push(i);
  const rankOf = (i: number) => signStyle(names[points[i]] ?? '')?.rank ?? Infinity;
  order.sort((p, q) => rankOf(p) - rankOf(q) || p - q);
  for (const i of order) {
    const sign = points[i], angle = points[i + 3], style = signStyle(names[sign] ?? '');
    if (!style) continue;
    const at = stand(points[i + 1], points[i + 2], angle, onRoad, inside);
    if (!at) continue;
    const { x, y, wall } = at;
    const z = height(x, y);
    if (!Number.isFinite(z)) continue;
    // (A plate goes with the sign put at the same point: the pipeline gives them one.)
    const plate = style.rank === PLATE, src = points[i + 1] * 1e5 + points[i + 2];
    const signs = (p: SignPost) => p.signs.filter(s => signStyle(names[s])!.rank !== PLATE).length;
    const post = plate ? posts.find(p => p.from!.includes(src) && !p.signs.includes(sign))
      : posts.find(p => p.wall === wall && signs(p) < PER_POST && Math.hypot(p.x - x, p.y - y) < JOIN && turnBetween(p.angle, angle) < .5 && !p.signs.includes(sign));
    if (post) { post.signs.push(sign); post.from!.push(src); }
    else if (!plate) posts.push({ x, y, z, angle, wall, signs: [sign], from: [src] });
  }
  for (const p of posts) {
    // Each plate right under its sign; the signs by rank, in the order they came otherwise.
    const key = p.signs.map((s, k) => {
      const rank = signStyle(names[s])!.rank;
      if (rank !== PLATE) return rank * 100 + k;
      const parent = p.signs.findIndex((o, j) => j !== k && p.from![j] === p.from![k] && signStyle(names[o])!.rank !== PLATE);
      return parent < 0 ? 1e4 + k : signStyle(names[p.signs[parent]])!.rank * 100 + parent + .5;
    });
    const order = p.signs.map((_, k) => k).sort((a, b) => key[a] - key[b]);
    p.signs = order.map(k => p.signs[k]); p.from = order.map(k => p.from![k]);
  }
  return posts;
}

// A face's outline about its middle, anticlockwise seen from the front.
function outline(style: SignStyle): Point2[] {
  const { shape, w, h } = style, a = w / 2, b = h / 2;
  if (shape === 'disc') return Array.from({ length: 24 }, (_, k) => [Math.cos(k * Math.PI / 12) * a, Math.sin(k * Math.PI / 12) * a]);
  if (shape === 'give') return [[-a, b], [0, -b], [a, b]];
  if (shape === 'diamond') return [[0, -b], [a, 0], [0, b], [-a, 0]];
  if (shape === 'octagon') {
    const r = a / Math.cos(Math.PI / 8);
    return Array.from({ length: 8 }, (_, k) => [Math.cos(Math.PI / 8 + k * Math.PI / 4) * r, Math.sin(Math.PI / 8 + k * Math.PI / 4) * r]);
  }
  return [[-a, -b], [a, -b], [a, b], [-a, b]];
}

const GREY = new THREE.Color('#8e9394'), BACK = new THREE.Color('#9b9e9d'), WHITE = new THREE.Color('#ffffff');
// Geometry for a sign or a board in its local frame (face to +z, the post at x = 0), in
// plain colours (`white`: the atlas coordinates of a plain white texel) and faces mapped
// onto an atlas.
export class SignParts {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = [];
  white: number[];
  constructor(white: number[]) { this.white = white; }
  tri(p: number[][], n: number[], uv: number[][] | null, c: THREE.Color) {
    for (let k = 0; k < 3; k++) { this.pos.push(...p[k]); this.nor.push(...n); this.uv.push(...(uv ? uv[k] : this.white)); this.col.push(c.r, c.g, c.b); }
  }
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], col: THREE.Color) { this.tri([a, b, c], n, null, col); this.tri([a, c, d], n, null, col); }
  block(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col = GREY) {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).toNonIndexed();
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    for (let k = 0; k < P.length; k += 9) this.tri([[P[k], P[k + 1], P[k + 2]], [P[k + 3], P[k + 4], P[k + 5]], [P[k + 6], P[k + 7], P[k + 8]]], [N[k], N[k + 1], N[k + 2]], null, col);
    g.dispose();
  }
  // A six-sided tube of radius `r` from a to b.
  tube(a: number[], b: number[], r: number, col = GREY) {
    const start = new THREE.Vector3(a[0], a[1], a[2]), delta = new THREE.Vector3(b[0], b[1], b[2]).sub(start);
    const g = new THREE.CylinderGeometry(r, r, delta.length(), 6, 1, true).toNonIndexed();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.clone().normalize()));
    g.translate(start.x + delta.x / 2, start.y + delta.y / 2, start.z + delta.z / 2);
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    for (let k = 0; k < P.length; k += 9) this.tri([[P[k], P[k + 1], P[k + 2]], [P[k + 3], P[k + 4], P[k + 5]], [P[k + 6], P[k + 7], P[k + 8]]], [N[k], N[k + 1], N[k + 2]], null, col);
    g.dispose();
  }
  // A galvanised tube of radius `r` from the ground up to `top`, capped.
  post(top: number, x = 0, r = POST_R) {
    const sides = 8;
    for (let k = 0; k < sides; k++) {
      const a0 = k / sides * Math.PI * 2, a1 = (k + 1) / sides * Math.PI * 2;
      const p0 = [x + Math.cos(a0) * r, Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, Math.sin(a1) * r];
      const n = [Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)];
      this.quad([p0[0], 0, p0[1]], [p0[0], top + .04, p0[1]], [p1[0], top + .04, p1[1]], [p1[0], 0, p1[1]], n, GREY);
      this.tri([[p0[0], top + .04, p0[1]], [x, top + .07, 0], [p1[0], top + .04, p1[1]]], [0, 1, 0], null, GREY);
    }
  }
  // A plate of outline `ring` (anticlockwise from the front) about (cx, my), its back at z =
  // `back` and its face `depth` in front: the face mapped by `uvAt` (and the back too
  // when `both`: seen from behind, local x runs leftwards, so mirrored), a grey back
  // otherwise, and the folded rim.
  plate(ring: Point2[], cx: number, my: number, back: number, depth: number, uvAt: (x: number, y: number) => number[], both = false) {
    const front = back + depth;
    const face = (z: number, facing: 1 | -1, textured: boolean) => {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const pts = facing > 0 ? [[0, 0], a, b] : [[0, 0], b, a];
        this.tri(pts.map(([x, yy]) => [cx + x, my + yy, z]), [0, 0, facing], textured ? pts.map(([x, yy]) => uvAt(x * facing, yy)) : null, textured ? WHITE : BACK);
      }
    };
    face(front, 1, true);
    face(back, -1, both);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const n = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len, 0];
      this.quad([cx + a[0], my + a[1], front], [cx + a[0], my + a[1], back], [cx + b[0], my + b[1], back], [cx + b[0], my + b[1], front], n, BACK);
    }
  }
  // As a geometry stood at (x, y) on the ground at `z`, its local x to `angle`.
  placed(x: number, y: number, z: number, angle: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g.applyMatrix4(new THREE.Matrix4().makeRotationY(angle).setPosition(x, z - .02, -y));
  }
}
// The posts' geometries as one geometry's arrays, with where each post stands (x, y, 1 on a
// wall, how many faces) for tests and collision.
export function mergedArrays(parts: THREE.BufferGeometry[], posts: { x: number; y: number; wall: boolean; count: number }[]) {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts)!;
  parts.forEach(g => g.dispose());
  const a = (name: string) => merged.attributes[name].array as Float32Array;
  return { position: a('position'), normal: a('normal'), uv: a('uv'), color: a('color'), posts: new Float32Array(posts.flatMap(p => [p.x, p.y, p.wall ? 1 : 0, p.count])) };
}

// One tile's posts as one geometry's arrays. `cols`: the atlas's (atlasCols).
export function signGeometry(posts: SignPost[], names: string[], cols: number) {
  const size = cols * CELL, out: THREE.BufferGeometry[] = [];
  for (const post of posts) {
    const o = new SignParts([.5 / cols, 1 - .5 / cols]);
    const styles = post.signs.map(s => signStyle(names[s])!);
    // Bottom up from BOTTOM: each sign's middle height.
    const mids: number[] = [];
    let y = BOTTOM;
    for (let k = styles.length - 1; k >= 0; k--) { mids[k] = y + styles[k].h / 2; y += styles[k].h + GAP; }
    const widest = Math.max(...styles.map(s => s.w));
    // A wall sign stands out from the house front on two arms, its edge to the wall (the wall
    // is at local +x, away from the road).
    const cx = post.wall ? -(widest / 2 + .1) : 0;
    if (post.wall) {
      for (let k = 0; k < styles.length; k++) for (const s of [-1, 1]) {
        const ay = mids[k] + s * styles[k].h * .3;
        o.block(cx - .02, .02, ay - .015, ay + .015, -.015, .015);
      }
    } else o.post(y - GAP);
    for (let k = 0; k < styles.length; k++) {
      const style = styles[k], r = cellRect(post.signs[k] + 1, cols, style), my = mids[k];
      const uvAt = (x: number, yy: number) => [(r.x + r.w / 2 + x * r.scale) / size, 1 - (r.y + r.h / 2 - yy * r.scale) / size];
      // Clamps to the post (or the arms), then the plate. A lit box shows its sign both ways.
      const box = style.shape === 'box', back = post.wall ? .02 : POST_R + .025;
      if (!post.wall) for (const s of [-1, 1]) o.block(cx - .035, cx + .035, my + s * style.h * .28 - .02, my + s * style.h * .28 + .02, 0, back);
      o.plate(outline(style), cx, my, back, box ? .16 : .015, uvAt, box);
    }
    out.push(o.placed(post.x, post.y, post.z, post.angle));
  }
  return mergedArrays(out, posts.map(p => ({ x: p.x, y: p.y, wall: p.wall, count: p.signs.length })));
}
export type SignArrays = NonNullable<ReturnType<typeof signGeometry>>;

// The file (data/<area>_now/traffic-signs.json), read on the main thread within `timeout` ms.
export interface TrafficSigns {
  names: string[]; cols: number;
  points: Float32Array; // [sign, x, y, angle (radians)] per sign
  turns: Map<string, [number, string][]>; // junction node → [heading (radians), turn:lanes] of the streets into it
  directions: DirectionSign[]; // the direction plates and boards (map/directions.ts)
}

export async function loadTrafficSigns(url: string, timeout = 3000, fetcher: typeof fetch = fetch): Promise<TrafficSigns | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    try {
      const res = await fetcher(url, { signal: controller.signal });
      if (!res.ok) return null;
      const { signs, points, turns, directions } = await res.json() as { signs?: unknown; points?: unknown; turns?: unknown; directions?: unknown };
      if (!Array.isArray(signs) || !Array.isArray(points)) return null;
      const names = signs.map(String), out: number[] = [];
      for (const row of points) {
        if (!Array.isArray(row)) continue;
        const [x, y, sign, degrees] = row as number[];
        if (names[sign] !== undefined && Number.isFinite(x) && Number.isFinite(y)) out.push(sign, x, y, (degrees || 0) * Math.PI / 180);
      }
      const byNode = new Map<string, [number, string][]>();
      for (const row of Array.isArray(turns) ? turns : []) {
        if (!Array.isArray(row) || typeof row[2] !== 'string') continue;
        const key = String(row[0]), list = byNode.get(key) ?? [];
        list.push([Number(row[1]) * Math.PI / 180, row[2]]); byNode.set(key, list);
      }
      return { names, cols: atlasCols(names.length), points: new Float32Array(out), turns: byNode, directions: readDirections(directions) };
    } catch { return null; }
  };
  try {
    return await Promise.race([read(), new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
