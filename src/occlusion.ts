// Leaving out what the buildings hide, in the street views (docs/occlusion-culling.md).
// A trial behind ?cull.
//
// The buildings of the drawn tiles are rasterised into a height grid (2 m cells: the
// top of their walls, a cell in from their outlines, passages and buildings a landmark
// replaces cut out). From the camera a sweep over that grid works out, for every cell
// within reach, the lowest height at which something there can be seen. Each frame
// every tile mesh, every instanced batch (all of whose instances must be hidden) and
// every other mesh is tested against it; what is hidden leaves the main pass (layer 0)
// but keeps casting shadows (CAST_LAYER, which only the sun's shadow camera sees).
//
// Conservative on purpose: walls stop at their eaves (two thirds of a pitched
// building's height), floating parts, bridges, walls, trees, landmarks and the terrain
// hide nothing, a sweep cell keeps the lower of the two paths to it, and an eye inside a
// building, below the ground or with no buildings drawn round it culls nothing.
import * as THREE from 'three';
import type { Bounds, Point2 } from './map/geo.ts';
import type { TileJSON } from './contracts.ts';
import { CAST_LAYER } from './figures.ts';

const CELL = 2; // metres a cell of the occluder grid
const REACH = 400; // as far as the street views draw (EYES_REACH in main.ts)
const N = Math.ceil((2 * REACH) / CELL) + 1; // cells a side of the sweep's window
const HALF = (N - 1) / 2;
const SQUARE = 31.25; // the squares a tile mesh's tops are kept for (64 a tile)
const MARGIN = 0.5; // metres added to every top
const RESWEEP = 1; // metres the eye may move before the sweep is done again
const PITCHED_EAVES = 0.65; // a pitched roof's eaves, as a share of the building's height
const SECTORS = 1024; // directions round the eye for what lies beyond the window

// What this needs of a tile (TileWorld's own type isn't exported).
export interface CullTile {
  box: Bounds;
  source: { t: TileJSON; hide: Point2[][][] };
  drawn: { group: THREE.Group; own: THREE.Mesh[] } | null;
}
export interface CullWorld { loaded: Map<string, CullTile>; terrainAt(x: number, y: number): number }

const SHADOW = 1 << CAST_LAYER;

export class Culler {
  // The sweep's result: the lowest height seen in each cell (-Infinity: anything),
  // and its minimums over blocks of 4, 16 and 64 cells for quick box tests.
  private seen = new Float32Array(N * N);
  private occ = new Float32Array(N * N);
  private slope = new Float32Array(N * N);
  private mins: { b: number; n: number; v: Float32Array }[] = [4, 16, 64].map((b) => ({ b, n: Math.ceil(N / b), v: new Float32Array(Math.ceil(N / b) ** 2) }));
  private x0 = 0; private y0 = 0; // the window's lower corner (game metres)
  // Beyond the window: for each of SECTORS directions round the eye, the lowest slope
  // of the window's edge cells that way. Anything further that way has to climb at
  // least that slope to be seen (whatever lies beyond the edge only hides more).
  private horizon = new Float32Array(SECTORS);
  private ex = 0; private ey = 0; private ez = 0;
  // Where the squares a tile mesh's tops are kept for start (the tiles' own grid).
  private sq: Point2 | null = null;
  private eye = new THREE.Vector3(NaN, NaN, NaN);
  private swept = false;
  private sweptTiles = '';
  private tileOcc = new WeakMap<CullTile, Float32Array>();
  private tops = new WeakMap<THREE.Object3D, Float32Array>();
  private verdicts = new Map<THREE.Object3D, boolean>();
  private verdictSweep = -1;
  private masks = new Map<THREE.Object3D, number>();
  private candidates: THREE.Object3D[] = [];
  private tileMeshes = new Map<THREE.Object3D, Bounds>();
  private frame = 0;
  // Off for comparing (bench.mjs --ab): everything drawn as without ?cull.
  enabled = true;
  readonly stats = { active: false, culled: 0, tested: 0, sweepMs: 0, testMs: 0, sweeps: 0 };

  constructor(private scene: THREE.Scene, private world: CullWorld) {}

  // What is left out now (for scripts/hidden-draws.js and the developer panel).
  culled() { return [...this.masks.keys()]; }

  update(camera: THREE.Camera, active: boolean) {
    this.stats.active = false;
    if (!active || !this.enabled) { this.restoreAll(); return; }
    const eye = camera.getWorldPosition(new THREE.Vector3());
    const ex = eye.x, ey = -eye.z, ez = eye.y;
    if (!(ez > this.world.terrainAt(ex, ey) - 0.5)) { this.restoreAll(); return; }
    const tiles = [...this.world.loaded.values()].filter((t) => t.drawn && t.drawn.group.parent && t.drawn.own.every((m) => m.visible));
    const key = tiles.map((t) => t.box[0] + ',' + t.box[1]).join(';');
    if (!this.swept || key !== this.sweptTiles || Math.abs(ex - this.eye.x) > RESWEEP || Math.abs(ey + this.eye.z) > RESWEEP || Math.abs(ez - this.eye.y) > RESWEEP) {
      const s0 = performance.now();
      this.swept = this.sweep(tiles, ex, ey, ez);
      this.sweptTiles = key;
      this.eye.copy(eye);
      this.stats.sweepMs = performance.now() - s0;
      this.stats.sweeps++;
    }
    if (!this.swept) { this.restoreAll(); return; }
    this.stats.active = true;
    if (this.frame++ % 30 === 0 || !this.candidates.length) this.gather();
    const c0 = performance.now();
    let culled = 0;
    for (const o of this.candidates) {
      const hide = this.hidden(o);
      if (hide) culled++;
      const was = this.masks.get(o);
      if (hide && was === undefined) {
        this.masks.set(o, o.layers.mask);
        o.layers.mask = (o.layers.mask & ~1) | (o.layers.mask & 1 ? SHADOW : 0);
      } else if (!hide && was !== undefined) {
        o.layers.mask = was;
        this.masks.delete(o);
      }
    }
    // Anything culled that is no longer a candidate (removed, or its tile dropped).
    if (this.masks.size > culled) {
      const now = new Set(this.candidates);
      for (const [o, m] of this.masks) if (!now.has(o)) { o.layers.mask = m; this.masks.delete(o); }
    }
    this.stats.culled = culled;
    this.stats.tested = this.candidates.length;
    this.stats.testMs = performance.now() - c0;
  }

  restoreAll() {
    for (const [o, m] of this.masks) o.layers.mask = m;
    this.masks.clear();
  }

  // The meshes that might be left out: those of the drawn tiles and the scene's other
  // meshes and batches that are frustum-culled, or instanced (their bounds come from
  // their instances). Not the sky or anything that opted out of frustum culling.
  private gather() {
    const list: THREE.Object3D[] = [];
    this.tileMeshes.clear();
    for (const t of this.world.loaded.values()) {
      if (!t.drawn) continue;
      this.sq ??= [t.box[0] - Math.floor(t.box[0] / SQUARE) * SQUARE, t.box[1] - Math.floor(t.box[1] / SQUARE) * SQUARE];
      t.drawn.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { this.tileMeshes.set(o, t.box); list.push(o); } });
    }
    for (const top of this.scene.children) {
      top.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || this.tileMeshes.has(o)) return;
        if ((m as THREE.SkinnedMesh).isSkinnedMesh ? o.userData.cullRadius && (m as THREE.SkinnedMesh).skeleton?.bones.length : (m as THREE.InstancedMesh).isInstancedMesh || m.frustumCulled) list.push(o);
      });
    }
    this.candidates = list;
    if (this.kept.size > list.length * 2) { const now = new Set(list); for (const o of this.kept.keys()) if (!now.has(o)) this.kept.delete(o); }
  }

  // A verdict holds until the next sweep, unless the thing moved: a batch's instances
  // changed (its instanceMatrix's version or count) or a mesh's place did.
  private kept = new Map<THREE.Object3D, { sweep: number; key: number; hide: boolean }>();
  private keyOf(o: THREE.Object3D): number {
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) return inst.instanceMatrix.version * 65536 + inst.count;
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) return NaN; // (people walk: always tested)
    const e = o.matrixWorld.elements;
    return e[12] * 7.1 + e[13] * 3.3 + e[14] * 1.7;
  }

  private hidden(o: THREE.Object3D): boolean {
    const key = this.keyOf(o), was = this.kept.get(o);
    if (was && was.sweep === this.stats.sweeps && was.key === key) return was.hide;
    const hide = this.test(o);
    this.kept.set(o, { sweep: this.stats.sweeps, key, hide });
    return hide;
  }

  private test(o: THREE.Object3D): boolean {
    if (!o.visible || !(o.layers.mask & 1) && !this.masks.has(o)) return false;
    const m = o as THREE.Mesh;
    const box = this.tileMeshes.get(o);
    if (box) return this.tileHidden(m, box);
    const inst = o as THREE.InstancedMesh;
    if (inst.isInstancedMesh) return this.batchHidden(inst);
    const skinned = o as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      // A person near by: a sphere round the hips (their bounds are of the bind pose).
      const r = o.userData.cullRadius as number, c = skinned.skeleton.bones[0].getWorldPosition(SPOT);
      return c.y + r + MARGIN < this.minSeen(c.x - r, -c.z - r, c.x + r, -c.z + r);
    }
    const g = m.geometry;
    if (!g) return false;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const s = g.boundingSphere!;
    if (!Number.isFinite(s.radius)) return false;
    o.updateWorldMatrix(true, false);
    const c = s.center.clone().applyMatrix4(o.matrixWorld), r = s.radius * o.matrixWorld.getMaxScaleOnAxis();
    if (r > 300) return false;
    return c.y + r + MARGIN < this.minSeen(c.x - r, -c.z - r, c.x + r, -c.z + r);
  }

  // A tile mesh: its highest point in each 31.25 m square it covers, worked out once.
  // One whose vertices aren't in or near its tile is placed by its shader (its
  // geometry says nothing about where it shows): never left out.
  private tileHidden(m: THREE.Mesh, [bx0, by0, bx1, by1]: Bounds): boolean {
    // (Tile meshes stand still: their verdict holds until the next sweep.)
    if (this.verdictSweep !== this.stats.sweeps) { this.verdicts.clear(); this.verdictSweep = this.stats.sweeps; }
    const known = this.verdicts.get(m);
    if (known !== undefined) return known;
    const verdict = this.tileVerdict(m, [bx0, by0, bx1, by1]);
    this.verdicts.set(m, verdict);
    return verdict;
  }

  private tileVerdict(m: THREE.Mesh, [bx0, by0, bx1, by1]: Bounds): boolean {
    let tops = this.tops.get(m);
    const sq = this.sq ?? [0, 0];
    if (!tops) {
      tops = squareTops(m, sq);
      for (let k = 0; k < tops.length; k += 3) {
        const x = sq[0] + (tops[k] + 0.5) * SQUARE, y = sq[1] + (tops[k + 1] + 0.5) * SQUARE;
        if (x < bx0 - 150 || x > bx1 + 150 || y < by0 - 150 || y > by1 + 150) { tops = new Float32Array(0); break; }
      }
      this.tops.set(m, tops);
    }
    for (let k = 0; k < tops.length; k += 3) {
      const x = sq[0] + tops[k] * SQUARE, y = sq[1] + tops[k + 1] * SQUARE;
      if (!(tops[k + 2] + MARGIN < this.minSeen(x, y, x + SQUARE, y + SQUARE))) return false;
    }
    return tops.length > 0;
  }

  // A batch: hidden if it draws nothing or every instance is hidden.
  private batchHidden(b: THREE.InstancedMesh): boolean {
    if (b.count === 0) return true;
    const g = b.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const s = g.boundingSphere!;
    if (!Number.isFinite(s.radius)) return false;
    b.updateWorldMatrix(true, false);
    const w = b.matrixWorld.elements, a = b.instanceMatrix.array as Float32Array;
    const plain = b.matrixWorld.equals(IDENTITY), ws = plain ? 1 : b.matrixWorld.getMaxScaleOnAxis();
    for (let i = 0; i < b.count; i++) {
      const o = i * 16;
      const scale = Math.sqrt(Math.max(a[o] ** 2 + a[o + 1] ** 2 + a[o + 2] ** 2, a[o + 4] ** 2 + a[o + 5] ** 2 + a[o + 6] ** 2, a[o + 8] ** 2 + a[o + 9] ** 2 + a[o + 10] ** 2));
      // The sphere's centre in the instance, then in the world.
      const cx0 = a[o] * s.center.x + a[o + 4] * s.center.y + a[o + 8] * s.center.z + a[o + 12];
      const cy0 = a[o + 1] * s.center.x + a[o + 5] * s.center.y + a[o + 9] * s.center.z + a[o + 13];
      const cz0 = a[o + 2] * s.center.x + a[o + 6] * s.center.y + a[o + 10] * s.center.z + a[o + 14];
      const cx = plain ? cx0 : w[0] * cx0 + w[4] * cy0 + w[8] * cz0 + w[12];
      const cy = plain ? cy0 : w[1] * cx0 + w[5] * cy0 + w[9] * cz0 + w[13];
      const cz = plain ? cz0 : w[2] * cx0 + w[6] * cy0 + w[10] * cz0 + w[14];
      const r = s.radius * scale * ws;
      if (!(r < 300) || !(cy + r + MARGIN < this.minSeen(cx - r, -cz - r, cx + r, -cz + r))) return false;
    }
    return true;
  }

  // The lowest height seen anywhere in a box (game metres, x and y north); -Infinity
  // where any of it is outside the window.
  private minSeen(x0: number, y0: number, x1: number, y1: number): number {
    const i0 = Math.floor((x0 - this.x0) / CELL), j0 = Math.floor((y0 - this.y0) / CELL);
    const i1 = Math.floor((x1 - this.x0) / CELL), j1 = Math.floor((y1 - this.y0) / CELL);
    if (i0 < 0 || j0 < 0 || i1 >= N || j1 >= N) {
      const beyond = this.beyond(x0, y0, x1, y1);
      if (beyond === -Infinity) return beyond;
      const ci0 = Math.max(0, i0), cj0 = Math.max(0, j0), ci1 = Math.min(N - 1, i1), cj1 = Math.min(N - 1, j1);
      if (ci0 > ci1 || cj0 > cj1) return beyond;
      return Math.min(beyond, this.minSeen(this.x0 + ci0 * CELL, this.y0 + cj0 * CELL, this.x0 + ci1 * CELL + CELL * 0.5, this.y0 + cj1 * CELL + CELL * 0.5));
    }
    const span = Math.max(i1 - i0, j1 - j0) + 1;
    let level = null as null | { b: number; n: number; v: Float32Array };
    for (const l of this.mins) if (span >= l.b * 4) level = l;
    let low = Infinity;
    if (!level) {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const v = this.seen[j * N + i]; if (v < low) low = v; }
      return low;
    }
    const { b, n, v } = level;
    for (let j = Math.floor(j0 / b); j <= Math.floor(j1 / b); j++) for (let i = Math.floor(i0 / b); i <= Math.floor(i1 / b); i++) {
      const x = v[j * n + i];
      if (x < low) low = x;
    }
    return low;
  }

  // The lowest height seen in a box that reaches beyond the window, from the horizon
  // in the directions it lies in: the eye's height plus the slope times the distance
  // (the nearest corner's when the slope climbs, the furthest's when it falls).
  private beyond(x0: number, y0: number, x1: number, y1: number): number {
    const { ex, ey, ez } = this;
    if (ex >= x0 && ex <= x1 && ey >= y0 && ey <= y1) return -Infinity;
    const near = Math.hypot(Math.max(x0 - ex, 0, ex - x1), Math.max(y0 - ey, 0, ey - y1));
    const far = Math.hypot(Math.max(Math.abs(x0 - ex), Math.abs(x1 - ex)), Math.max(Math.abs(y0 - ey), Math.abs(y1 - ey)));
    const angles = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => Math.atan2(y - ey, x - ex));
    // The corners' angles span less than half a turn (the eye is outside the box).
    let lo = Math.min(...angles), hi = Math.max(...angles);
    if (hi - lo > Math.PI) { const shifted = angles.map((a) => (a < 0 ? a + 2 * Math.PI : a)); lo = Math.min(...shifted); hi = Math.max(...shifted); }
    const s0 = Math.floor(((lo / (2 * Math.PI)) + 1) * SECTORS), s1 = Math.floor(((hi / (2 * Math.PI)) + 1) * SECTORS);
    let low = Infinity;
    for (let k = s0; k <= s1; k++) {
      const h = this.horizon[k % SECTORS];
      if (h === -Infinity) return -Infinity;
      const v = ez + h * (h >= 0 ? near : far);
      if (v < low) low = v;
    }
    return low;
  }

  // The occluders round the eye from the drawn tiles, then the lowest height seen in
  // every cell. False when the eye is inside a building or nothing could be worked out.
  private sweep(tiles: CullTile[], ex: number, ey: number, ez: number): boolean {
    const occ = this.occ, seen = this.seen, slope = this.slope;
    // The window, aligned to the cell grid, with the eye in its middle cell.
    const ci = Math.floor(ex / CELL), cj = Math.floor(ey / CELL);
    this.x0 = (ci - HALF) * CELL; this.y0 = (cj - HALF) * CELL;
    this.ex = ex; this.ey = ey; this.ez = ez;
    occ.fill(-Infinity);
    for (const t of tiles) {
      const [bx0, by0, bx1, by1] = t.box;
      if (bx1 < this.x0 || by1 < this.y0 || bx0 > this.x0 + N * CELL || by0 > this.y0 + N * CELL) continue;
      let grid = this.tileOcc.get(t);
      if (!grid) { grid = this.rasterise(t); this.tileOcc.set(t, grid); }
      const n = Math.round((bx1 - bx0) / CELL), gi = Math.round((bx0 - this.x0) / CELL), gj = Math.round((by0 - this.y0) / CELL);
      // (Tiles don't overlap: their rows are copied as they are.)
      const i0 = Math.max(0, -gi), i1 = Math.min(n, N - gi);
      if (i0 >= i1) continue;
      for (let j = Math.max(0, -gj); j < n && gj + j < N; j++) occ.set(grid.subarray(j * n + i0, j * n + i1), (gj + j) * N + gi + i0);
    }
    const c = HALF;
    if (occ[c * N + c] > ez - 0.3) return false;
    // Rays from the eye to every edge cell of the window, half a cell a step. Each
    // cell keeps the lowest slope a ray reached it with (the steepest it had to climb
    // over what lay before), then the ray counts the cell's own occluder. Rays are
    // closer than a cell everywhere, so every cell is reached; a cell no ray passes
    // stays at -Infinity (seen).
    const ox = (ci + 0.5) * CELL - ex, oy = (cj + 0.5) * CELL - ey; // the eye's cell centre from the eye
    slope.fill(Infinity);
    this.horizon.fill(Infinity);
    const ix = c + 0.5 - ox / CELL, iy = c + 0.5 - oy / CELL; // the eye in cell units
    const ray = (ti: number, tj: number) => {
      // Cell by cell (a grid walk), each cell the ray passes through once.
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
        // (Its occluder from the ray's entry into the cell: the nearest it can be.)
        if (o !== -Infinity) { const v = (o - ez) / Math.max(t * len, 0.5); if (v > run) run = v; }
      }
      const a = Math.atan2(dy, dx), q = Math.floor(((a / (2 * Math.PI)) + 1) * SECTORS) % SECTORS;
      for (const r of [q - 1, q, q + 1]) { const w = (r + SECTORS) % SECTORS; if (run < this.horizon[w]) this.horizon[w] = run; }
    };
    for (let e = 0; e < N; e++) { ray(0, e); ray(N - 1, e); ray(e, 0); ray(e, N - 1); }
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) slope[(c + dj) * N + c + di] = -Infinity;
    // (Distances from the eye's cell centre, give or take the eye's place in its cell:
    // the nearer for a climbing slope, the further for a falling one.)
    for (let p = 0; p < N * N; p++) {
      const s = slope[p];
      seen[p] = s === -Infinity || s === Infinity ? -Infinity : ez + s * (s > 0 ? NEAR[p] : FAR[p]);
    }
    // Each level from the one below it (4 cells, then 4 × 4 blocks, …).
    let below: Float32Array = seen, bn = N, bb = 1;
    for (const level of this.mins) {
      const { b, n, v } = level, f = b / bb;
      v.fill(Infinity);
      for (let j = 0; j < bn; j++) {
        const row = Math.floor(j / f) * n;
        for (let i = 0; i < bn; i++) { const q = row + Math.floor(i / f), x = below[j * bn + i]; if (x < v[q]) v[q] = x; }
      }
      below = v; bn = n; bb = b;
    }
    return true;
  }

  // A tile's buildings as solid columns up to their eaves: a cell in from the outlines,
  // not those that float, are too low or a landmark replaces, with the passages through
  // them open.
  private rasterise(t: CullTile): Float32Array {
    const [bx0, by0, bx1] = t.box, n = Math.round((bx1 - bx0) / CELL);
    const grid = new Float32Array(n * n).fill(-Infinity);
    const { t: data, hide } = t.source;
    for (const b of data.buildings) {
      if ((b.minh ?? 0) > 0.5 || !(b.h >= 3) || !b.rings?.[0]?.length) continue;
      let base = Infinity;
      for (const [x, y] of b.rings[0]) base = Math.min(base, this.world.terrainAt(x, y));
      if (!Number.isFinite(base)) continue;
      const top = base + (b.roof === 'flat' ? b.h : b.h * PITCHED_EAVES);
      fill(grid, n, bx0, by0, b.rings, (v) => Math.max(v, top));
    }
    for (const rings of hide) fill(grid, n, bx0, by0, rings, () => -Infinity);
    // A cell in: solid only where its four neighbours are.
    const out = new Float32Array(n * n).fill(-Infinity);
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const p = j * n + i;
      out[p] = Math.min(grid[p], grid[p - 1], grid[p + 1], grid[p - n], grid[p + n]);
    }
    for (const p of data.passages ?? []) {
      const r = p.w / 2 + CELL;
      for (let k = 0; k + 1 < p.pts.length; k++) {
        const [ax, ay] = p.pts[k], [qx, qy] = p.pts[k + 1];
        const i0 = Math.max(0, Math.floor((Math.min(ax, qx) - r - bx0) / CELL)), i1 = Math.min(n - 1, Math.floor((Math.max(ax, qx) + r - bx0) / CELL));
        const j0 = Math.max(0, Math.floor((Math.min(ay, qy) - r - by0) / CELL)), j1 = Math.min(n - 1, Math.floor((Math.max(ay, qy) + r - by0) / CELL));
        const dx = qx - ax, dy = qy - ay, l2 = dx * dx + dy * dy || 1;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = bx0 + (i + 0.5) * CELL, y = by0 + (j + 0.5) * CELL;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
          if (Math.hypot(ax + dx * u - x, ay + dy * u - y) < r) out[j * n + i] = -Infinity;
        }
      }
    }
    return out;
  }
}

// Each cell's distance from the window's middle cell, less and plus how far the eye can
// be from that cell's centre.
const NEAR = new Float32Array(N * N), FAR = new Float32Array(N * N);
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const d = Math.hypot(i - HALF, j - HALF) * CELL;
  NEAR[j * N + i] = Math.max(0, d - CELL * Math.SQRT1_2); FAR[j * N + i] = d + CELL * Math.SQRT1_2;
}
const IDENTITY = new THREE.Matrix4();
const SPOT = new THREE.Vector3();

// Set the cells inside a polygon (outer ring, then holes) to f(their value).
function fill(grid: Float32Array, n: number, ox: number, oy: number, rings: Point2[][], f: (v: number) => number) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of rings[0]) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const j0 = Math.max(0, Math.floor((y0 - oy) / CELL)), j1 = Math.min(n - 1, Math.floor((y1 - oy) / CELL));
  for (let j = j0; j <= j1; j++) {
    const y = oy + (j + 0.5) * CELL, xs: number[] = [];
    for (const r of rings) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const [xa, ya] = r[a], [xb, yb] = r[b];
        if (ya > y !== yb > y) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - ox) / CELL - 0.5)), i1 = Math.min(n - 1, Math.floor((xs[k + 1] - ox) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) grid[j * n + i] = f(grid[j * n + i]);
    }
  }
}

// A mesh's highest point in each square (SQUARE) it covers: [i, j, top] triples, where
// the square starts at (sx, sy) + [i, j] × SQUARE in game metres (y north).
function squareTops(m: THREE.Mesh, [sx, sy]: Point2): Float32Array {
  const tops = new Map<number, number>();
  const add = (x: number, y: number, h: number) => {
    const i = Math.floor((x - sx) / SQUARE), j = Math.floor((y - sy) / SQUARE), k = (i + 4096) * 8192 + (j + 4096);
    const was = tops.get(k);
    if (was === undefined || h > was) tops.set(k, h);
  };
  m.updateWorldMatrix(true, false);
  const w = m.matrixWorld.elements;
  const inst = m as THREE.InstancedMesh;
  if (inst.isInstancedMesh) {
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    const s = g.boundingSphere!, a = inst.instanceMatrix.array as Float32Array, v = new THREE.Vector3(), mat = new THREE.Matrix4();
    for (let i = 0; i < inst.count; i++) {
      mat.fromArray(a, i * 16).premultiply(m.matrixWorld);
      v.copy(s.center).applyMatrix4(mat);
      const r = s.radius * mat.getMaxScaleOnAxis();
      for (const dx of [-r, r]) for (const dy of [-r, r]) add(v.x + dx, -v.z + dy, v.y + r);
    }
  } else {
    const pos = m.geometry?.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!pos) return new Float32Array(0);
    const plain = (pos as THREE.BufferAttribute).isBufferAttribute && pos.itemSize === 3 ? (pos as THREE.BufferAttribute).array as ArrayLike<number> : null;
    const end = m.geometry.drawRange.count === Infinity ? pos.count : Math.min(pos.count, m.geometry.drawRange.start + m.geometry.drawRange.count);
    for (let i = 0; i < end; i++) {
      const x0 = plain ? plain[i * 3] : pos.getX(i), y0 = plain ? plain[i * 3 + 1] : pos.getY(i), z0 = plain ? plain[i * 3 + 2] : pos.getZ(i);
      const x = w[0] * x0 + w[4] * y0 + w[8] * z0 + w[12], y = w[1] * x0 + w[5] * y0 + w[9] * z0 + w[13], z = w[2] * x0 + w[6] * y0 + w[10] * z0 + w[14];
      add(x, -z, y);
    }
  }
  const out = new Float32Array(tops.size * 3);
  let n = 0;
  for (const [k, h] of tops) { out[n++] = Math.floor(k / 8192) - 4096; out[n++] = (k % 8192) - 4096; out[n++] = h; }
  return out;
}
