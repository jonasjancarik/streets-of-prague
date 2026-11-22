// Leaving out what the buildings hide, in the street views (docs/occlusion-culling.md).
// A trial behind ?cull.
//
// The buildings of the drawn tiles are rasterised into a height grid (2 m cells: the
// top of their walls, a cell in from their outlines, passages and buildings a landmark
// replaces cut out). A worker sweeps over that grid from the camera (occlusionSweep.ts)
// and works out, for every cell within reach, the lowest height at which something
// there can be seen, from anywhere within a few metres of the eye: the result holds
// while the eye moves on and the next one is worked out. Each frame
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
import { CELL, N, SECTORS, LEVELS, type SweepResult } from './occlusionSweep.ts';
import type { CullMessage } from './occlusionWorker.ts';

const SQUARE = 31.25; // the squares a tile mesh's tops are kept for (64 a tile)
const MARGIN = 0.5; // metres added to every top
const PITCHED_EAVES = 0.65; // a pitched roof's eaves, as a share of the building's height
// How far the eye may be from where a sweep was asked for and still use it (the sweep
// runs in a worker and comes back a frame or so later): sideways and up or down. Each
// sweep is asked for from where the eye will be in the frame that uses it, so this only
// has to cover how the movement differs from that guess. Anything above zero shrinks the
// buildings by a cell (scripts/hidden-draws.js `shift` checks it).
const SLACK = 0.5;
const RISE = 0.5;
// How far the eye moves before the next sweep is asked for.
const REASK = 0.1;
// Milliseconds a frame for finding new tile meshes' tops (and the tests before them).
const TOPS_MS = 1.5;
// Frames between tests of something drawn, against a new sweep.
const RETEST = 4;

// What this needs of a tile (TileWorld's own type isn't exported).
export interface CullTile {
  box: Bounds;
  source: { t: TileJSON; hide: Point2[][][] };
  drawn: { group: THREE.Group; own: THREE.Mesh[] } | null;
}
export interface CullWorld { loaded: Map<string, CullTile>; terrainAt(x: number, y: number): number }

const SHADOW = 1 << CAST_LAYER;

export class Culler {
  // The latest sweep back from the worker (occlusionSweep.ts), and its tiles.
  private result: SweepResult | null = null;
  private resultKeys: string[] = [];
  private mins: { b: number; n: number; v: Float32Array }[] = [];
  private worker = new Worker(new URL('./occlusionWorker.ts', import.meta.url), { type: 'module' });
  private asked = 0; // the id of the last sweep asked for
  private pending = false;
  private askedAt = { x: NaN, y: NaN, z: NaN, tiles: '' };
  private askTime = 0;
  // The eye's speed (metres a millisecond, smoothed) and how long a sweep takes to come back.
  private last = { x: NaN, y: NaN, z: NaN, t: 0 };
  private v = { x: 0, y: 0, z: 0 };
  // From asking for a sweep to the first frame that uses it (milliseconds, smoothed).
  private lag = 50;
  private fresh = false;
  private posted = new Map<CullTile, string>(); // the tiles the worker has
  // Where the squares a tile mesh's tops are kept for start (the tiles' own grid).
  private sq: Point2 | null = null;
  private tileOcc = new WeakMap<CullTile, Float32Array>();
  private tops = new WeakMap<THREE.Object3D, Float32Array>();
  private verdicts = new Map<THREE.Object3D, boolean>();
  private verdictSweep = -1;
  private squares = new Map<number, number>();
  private squaresSweep = -1;
  private masks = new Map<THREE.Object3D, number>();
  private candidates: THREE.Object3D[] = [];
  private tileMeshes = new Map<THREE.Object3D, Bounds>();
  private frame = 0;
  private retested = 0;
  private frameStart = 0;
  private deferred = false; // (a verdict put off, not to be kept)
  // Off for comparing (bench.mjs --ab): everything drawn as without ?cull.
  enabled = true;
  // No new sweeps (scripts/hidden-draws.js checks a result from an eye moved off it).
  hold = false;
  slack = SLACK; rise = RISE;
  readonly stats = { active: false, culled: 0, tested: 0, sweepMs: 0, testMs: 0, sweeps: 0, postMs: 0, frames: 0, waits: 0, retested: 0, testMsMax: 0, testMsSum: 0, tests: 0,
    why: { none: 0, away: 0, inside: 0, tiles: 0 } };

  constructor(private scene: THREE.Scene, private world: CullWorld) {
    this.worker.onmessage = (e: MessageEvent<{ id: number; keys: string[]; result: SweepResult }>) => {
      if (e.data.id === this.asked) { this.pending = false; this.fresh = true; }
      const r = e.data.result;
      this.result = r.ok ? r : null;
      this.resultKeys = e.data.keys;
      this.mins = LEVELS.map((b, l) => ({ b, n: Math.ceil(N / b), v: r.mins[l] }));
      this.stats.sweepMs = r.ms;
      this.stats.sweeps++;
    };
  }

  // What is left out now (for scripts/hidden-draws.js and the developer panel).
  culled() { return [...this.masks.keys()]; }

  update(camera: THREE.Camera, active: boolean) {
    this.stats.active = false;
    if (!active || !this.enabled) { this.restoreAll(); return; }
    this.stats.frames++;
    const eye = camera.getWorldPosition(SPOT);
    const ex = eye.x, ey = -eye.z, ez = eye.y;
    if (!(ez > this.world.terrainAt(ex, ey) - 0.5)) { this.restoreAll(); return; }
    const now = performance.now(), l = this.last, dt = now - l.t;
    if (dt > 0 && dt < 500 && Number.isFinite(l.x) && Math.hypot(ex - l.x, ey - l.y, ez - l.z) < dt * 0.1) {
      const k = Math.min(1, dt / 150), v = this.v;
      v.x += ((ex - l.x) / dt - v.x) * k; v.y += ((ey - l.y) / dt - v.y) * k; v.z += ((ez - l.z) / dt - v.z) * k;
    } else this.v = { x: 0, y: 0, z: 0 }; // (standing, or a jump: a teleport)
    this.last = { x: ex, y: ey, z: ez, t: now };
    const tiles = [...this.world.loaded.values()].filter((t) => t.drawn && t.drawn.group.parent && t.drawn.own.every((m) => m.visible));
    const keys = tiles.map((t) => t.box[0] + ',' + t.box[1]), key = keys.join(';');
    if (this.fresh) { this.lag += (Math.min(now - this.askTime, 500) - this.lag) * 0.3; this.fresh = false; }
    // Where the eye will be in the frame that uses the sweep (the first after it comes
    // back; the next one is asked for then).
    const lead = this.lag;
    const ax = ex + this.v.x * lead, ay = ey + this.v.y * lead, az = ez + this.v.z * lead;
    const a = this.askedAt;
    if (!this.hold && !this.pending && (key !== a.tiles || Math.hypot(ax - a.x, ay - a.y) > REASK || Math.abs(az - a.z) > this.rise / 4)) {
      this.ask(tiles, keys, ax, ay, az);
      this.askedAt = { x: ax, y: ay, z: az, tiles: key };
      this.askTime = now;
    }
    const why = this.usable(ex, ey, ez, keys, key);
    if (why) { this.stats.waits++; this.stats.why[why]++; this.restoreAll(); return; }
    this.stats.active = true;
    if (this.frame++ % 30 === 0 || !this.candidates.length) this.gather();
    const c0 = performance.now();
    this.frameStart = c0;
    this.retested = 0;
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
    const ms = performance.now() - c0;
    this.stats.testMs = ms; this.stats.testMsMax = Math.max(this.stats.testMsMax, ms); this.stats.testMsSum += ms; this.stats.tests++;
    this.stats.retested = this.retested; this.retested = 0;
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
    // Something drawn may stay drawn a few frames more (always safe): with a new sweep
    // every frame while moving, it is tested again in its turn, a quarter each frame.
    // What is left out is tested against every sweep.
    if (was && !was.hide && (o.id + this.frame) % RETEST !== 0) return false;
    this.deferred = false;
    const hide = this.test(o);
    this.retested++;
    if (this.deferred) return hide;
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
    if (!this.deferred) this.verdicts.set(m, verdict);
    return verdict;
  }

  private tileVerdict(m: THREE.Mesh, [bx0, by0, bx1, by1]: Bounds): boolean {
    let tops = this.tops.get(m);
    const sq = this.sq ?? [0, 0];
    if (!tops) {
      // (Working them out goes through every vertex: a few meshes a frame, the others
      // drawn until their turn.)
      if (performance.now() - this.frameStart > TOPS_MS) { this.deferred = true; return false; }
      tops = squareTops(m, sq);
      for (let k = 0; k < tops.length; k += 3) {
        const x = sq[0] + (tops[k] + 0.5) * SQUARE, y = sq[1] + (tops[k + 1] + 0.5) * SQUARE;
        if (x < bx0 - 150 || x > bx1 + 150 || y < by0 - 150 || y > by1 + 150) { tops = new Float32Array(0); break; }
      }
      this.tops.set(m, tops);
    }
    // (Each square's lowest height seen is worked out once a sweep, for all meshes.)
    if (this.squaresSweep !== this.stats.sweeps) { this.squares.clear(); this.squaresSweep = this.stats.sweeps; }
    const n = tops.length / 3, first = (this.shown.get(m) ?? 0) % Math.max(n, 1);
    for (let q = 0; q < n; q++) {
      const k = ((first + q) % n) * 3, key = (tops[k] + 4096) * 8192 + tops[k + 1] + 4096;
      let low = this.squares.get(key);
      if (low === undefined) {
        const x = sq[0] + tops[k] * SQUARE, y = sq[1] + tops[k + 1] * SQUARE;
        low = this.minSeen(x, y, x + SQUARE, y + SQUARE);
        this.squares.set(key, low);
      }
      if (!(tops[k + 2] + MARGIN < low)) { this.shown.set(m, k / 3); return false; }
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
    // From the instance seen last time: in a batch that shows, usually the only one tested.
    const n = b.count, first = (this.shown.get(b) ?? 0) % n;
    for (let k = 0; k < n; k++) {
      const i = (first + k) % n, o = i * 16;
      const scale = Math.sqrt(Math.max(a[o] ** 2 + a[o + 1] ** 2 + a[o + 2] ** 2, a[o + 4] ** 2 + a[o + 5] ** 2 + a[o + 6] ** 2, a[o + 8] ** 2 + a[o + 9] ** 2 + a[o + 10] ** 2));
      // The sphere's centre in the instance, then in the world.
      const cx0 = a[o] * s.center.x + a[o + 4] * s.center.y + a[o + 8] * s.center.z + a[o + 12];
      const cy0 = a[o + 1] * s.center.x + a[o + 5] * s.center.y + a[o + 9] * s.center.z + a[o + 13];
      const cz0 = a[o + 2] * s.center.x + a[o + 6] * s.center.y + a[o + 10] * s.center.z + a[o + 14];
      const cx = plain ? cx0 : w[0] * cx0 + w[4] * cy0 + w[8] * cz0 + w[12];
      const cy = plain ? cy0 : w[1] * cx0 + w[5] * cy0 + w[9] * cz0 + w[13];
      const cz = plain ? cz0 : w[2] * cx0 + w[6] * cy0 + w[10] * cz0 + w[14];
      const r = s.radius * scale * ws;
      if (!(r < 300) || !(cy + r + MARGIN < this.minSeen(cx - r, -cz - r, cx + r, -cz + r))) { this.shown.set(b, i); return false; }
    }
    return true;
  }
  private shown = new WeakMap<THREE.Object3D, number>(); // (the instance or square seen last)

  // The lowest height seen anywhere in a box (game metres, x and y north); -Infinity
  // where any of it is outside the window.
  private minSeen(x0: number, y0: number, x1: number, y1: number): number {
    const r = this.result!;
    const i0 = Math.floor((x0 - r.x0) / CELL), j0 = Math.floor((y0 - r.y0) / CELL);
    const i1 = Math.floor((x1 - r.x0) / CELL), j1 = Math.floor((y1 - r.y0) / CELL);
    if (i0 < 0 || j0 < 0 || i1 >= N || j1 >= N) {
      const beyond = this.beyond(x0, y0, x1, y1);
      if (beyond === -Infinity) return beyond;
      const ci0 = Math.max(0, i0), cj0 = Math.max(0, j0), ci1 = Math.min(N - 1, i1), cj1 = Math.min(N - 1, j1);
      if (ci0 > ci1 || cj0 > cj1) return beyond;
      return Math.min(beyond, this.minSeen(r.x0 + ci0 * CELL, r.y0 + cj0 * CELL, r.x0 + ci1 * CELL + CELL * 0.5, r.y0 + cj1 * CELL + CELL * 0.5));
    }
    const span = Math.max(i1 - i0, j1 - j0) + 1;
    let level = null as null | { b: number; n: number; v: Float32Array };
    for (const l of this.mins) if (span >= l.b * 4) level = l;
    let low = Infinity;
    if (!level) {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const v = r.seen[j * N + i]; if (v < low) low = v; }
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
  // (Distances from the eye the sweep was from, which hold for the eye anywhere near:
  // see occlusionSweep.ts. A box within that reach of the eye isn't worked out.)
  private beyond(x0: number, y0: number, x1: number, y1: number): number {
    const r = this.result!, { ex, ey, slack } = r, ez = r.ez + r.rise;
    if (ex >= x0 - slack && ex <= x1 + slack && ey >= y0 - slack && ey <= y1 + slack) return -Infinity;
    const near = Math.hypot(Math.max(x0 - ex, 0, ex - x1), Math.max(y0 - ey, 0, ey - y1));
    const far = Math.hypot(Math.max(Math.abs(x0 - ex), Math.abs(x1 - ex)), Math.max(Math.abs(y0 - ey), Math.abs(y1 - ey)));
    const angles = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => Math.atan2(y - ey, x - ex));
    // The corners' angles span less than half a turn (the eye is outside the box).
    let lo = Math.min(...angles), hi = Math.max(...angles);
    if (hi - lo > Math.PI) { const shifted = angles.map((a) => (a < 0 ? a + 2 * Math.PI : a)); lo = Math.min(...shifted); hi = Math.max(...shifted); }
    const s0 = Math.floor(((lo / (2 * Math.PI)) + 1) * SECTORS), s1 = Math.floor(((hi / (2 * Math.PI)) + 1) * SECTORS);
    let low = Infinity;
    for (let k = s0; k <= s1; k++) {
      const h = r.horizon[k % SECTORS];
      if (h === -Infinity) return -Infinity;
      const v = ez + h * (h >= 0 ? near : far);
      if (v < low) low = v;
    }
    return low;
  }

  // Sends the worker the tiles it hasn't got and asks for a sweep from the eye.
  private ask(tiles: CullTile[], keys: string[], ex: number, ey: number, ez: number) {
    const p0 = performance.now();
    const now = new Set(tiles);
    for (const t of this.posted.keys()) if (!now.has(t)) this.posted.delete(t);
    tiles.forEach((t, k) => {
      if (this.posted.has(t)) return;
      const [bx0, by0, bx1, by1] = t.box;
      // (Tiles out of the sweep's reach are sent when they come into it.)
      if (bx1 < ex - N * CELL || by1 < ey - N * CELL || bx0 > ex + N * CELL || by0 > ey + N * CELL) return;
      let grid = this.tileOcc.get(t);
      if (!grid) { grid = this.rasterise(t); this.tileOcc.set(t, grid); }
      this.post({ type: 'tile', key: keys[k], box: [bx0, by0, bx1, by1], grid });
      this.posted.set(t, keys[k]);
    });
    this.post({ type: 'sweep', id: ++this.asked, keys, ask: { ex, ey, ez, slack: this.slack, rise: this.rise } });
    this.pending = true;
    this.stats.postMs = performance.now() - p0;
  }

  private post(m: CullMessage) { this.worker.postMessage(m); }

  // Why the latest sweep doesn't hold for the eye, or '' if it does: none back, the eye
  // too far from where it was asked for or inside a building, or a tile it counted gone.
  private usable(ex: number, ey: number, ez: number, keys: string[], key: string): '' | 'none' | 'away' | 'inside' | 'tiles' {
    const r = this.result;
    if (!r) return 'none';
    if (Math.hypot(ex - r.ex, ey - r.ey) > r.slack || Math.abs(ez - r.ez) > r.rise) return 'away';
    const w = 2 * r.around + 1;
    const di = Math.floor(ex / CELL) - Math.floor(r.ex / CELL) + r.around, dj = Math.floor(ey / CELL) - Math.floor(r.ey / CELL) + r.around;
    if (di < 0 || dj < 0 || di >= w || dj >= w || r.patch[dj * w + di] > ez - 0.3) return 'inside';
    if (this.resultKeys !== this.checked.of || key !== this.checked.now) {
      const now = new Set(keys);
      this.checked = { of: this.resultKeys, now: key, held: this.resultKeys.every((k) => now.has(k)) };
    }
    return this.checked.held ? '' : 'tiles';
  }
  private checked = { of: [] as string[], now: '', held: false };

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
