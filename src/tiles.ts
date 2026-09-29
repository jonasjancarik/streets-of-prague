import * as THREE from 'three';
import { Geo, Grid, rng, hash } from './map/geo.ts';
import { wallMesh } from './map/buildings.ts';
import { treeMesh } from './map/vegetation.ts';
import { Surfaces } from './surface.ts';
import { shadeBuildings, cutAway, broad } from './shading.ts';
import { loadFacadeAtlas } from './facades.ts';
import { Zones, parkCars, inRing } from './parking.ts';
import { decodeHeights, decodeLevels, heightSampler, fetchBinary } from './terrain.ts';
import type { Point2, Bounds } from './map/geo.ts';
import type { DriveEdge, DriveGraph, WalkEdge, WalkGraph } from './network.ts';
import type { Car } from './car.ts';
import type { TileJSON, MapIndex, TilePassage, BuildingArrays, WorkerJobs, WorkerKind, WorkerResults, WorkerResponse, HeightGrid, LevelInput } from './contracts.ts';
import { isTileJSON } from './contracts.ts';

interface TileFiles { t: TileJSON; height: ArrayBuffer | null; bare: ArrayBuffer | null; ipr: ArrayBuffer | null; levels: ArrayBuffer | null }
// A bridge (1, 2, …) or tunnel (-1, -2, …) level in a tile: where it is and how high.
interface TileLevel { level: number; grid: Grid; sample: (x: number, y: number) => number }
interface Tile {
  k: string; i: number; j: number; box: Bounds; passages: TilePassage[]; raised: Point2[][][];
  group: THREE.Group; surfaces: Surfaces; grid: Grid; levels: TileLevel[];
  cars: Car[]; ms: Record<string, number>; disposables: THREE.Mesh[];
  relief: { texture: THREE.DataTexture; box: number[]; sample: (x: number, y: number) => number; hm: Float32Array; edges: () => void } | null;
  sample?: (x: number, y: number) => number;
  // The tile's water (the river and ponds), each polygon with its bounding box.
  water: { rings: Point2[][]; box: Bounds }[];
  weirs: Point2[][];
}
export interface Tracked {
  x: number; y: number; _tx?: number; _ty?: number; level?: number; gz?: number;
  // Where it's put on a street: on a bridge, in a tunnel or on the ground (see track).
  hint?: 'bridge' | 'tunnel' | 'ground';
  // Kept on the ground, whatever is under it or over it (a car in traffic on a street
  // at ground level, see Traffic.update).
  grounded?: boolean;
  e?: { bridge?: boolean; tunnel?: boolean }; _view?: { res: number; height: (x: number, y: number) => number; at: (x: number, y: number) => number };
}

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const response = value as Record<string, unknown>;
  return typeof response.id === 'number' && (typeof response.error === 'string' || 'result' in response);
}

// Streams the map in square tiles (pipeline/build_tiles.py) around the camera. Each
// loaded tile has its own ground, buildings, trees, collision grid and parked cars;
// tiles far behind are dropped again. The street graphs stay global. The heavy part
// of building a tile runs in workers (tileWorker.ts); the main thread fetches the
// tile's files, joins up the street graphs and makes the meshes and parked cars.

const RES = 2; // collision grid cells per metre
const RAISED = 3; // a building whose underside is this high (m) or more doesn't block the way under it
// Metres a car or a walker can go up or down between the ground and a bridge or a
// tunnel, or between two levels: where a bridge is that close to the ground (at its
// ends), they drive onto it; further apart, it's overhead, or the ground is below the
// parapet.
const CLIMB = 1.5;

// A small pool of workers that build tiles (see tileWorker.ts).
class TileWorkers {
  workers: Worker[];
  jobs: Map<number, { worker: Worker; resolve: (result: unknown) => void; reject: (error: Error) => void }>;
  next: number;
  size: number;

  constructor(n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2))) {
    this.workers = [];
    this.jobs = new Map();
    this.next = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<unknown>) => {
        if (!isWorkerResponse(e.data)) return;
        const job = this.jobs.get(e.data.id);
        if (!job) return;
        this.jobs.delete(e.data.id);
        if ('error' in e.data && e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data.result);
      };
      w.onerror = (event) => {
        for (const [id, job] of this.jobs) if (job.worker === w) {
          this.jobs.delete(id);
          job.reject(new Error(event.message || 'Tile worker failed'));
        }
      };
      this.workers.push(w);
    }
    this.size = n;
  }

  run<K extends WorkerKind>(type: K, data: WorkerJobs[K], transfer: Transferable[] = []): Promise<WorkerResults[K]> {
    const id = this.next++;
    return new Promise<WorkerResults[K]>((resolve, reject) => {
      const worker = this.workers[id % this.workers.length];
      this.jobs.set(id, { worker, resolve: (result) => resolve(result as WorkerResults[K]), reject });
      worker.postMessage({ id, type, data }, transfer);
    });
  }
}

// Hill shading for a tile from its terrain heights (pipeline/ipr_terrain.py), lit from
// the same north-west as the sun: 1 = unchanged, darker on slopes facing away. The
// ground's broad variation (broad) is multiplied in, sparing the shader its noise.
// `around(di, dj)`: the neighbouring tile's heights (hm) if it is loaded and shares this
// tile's edge points, for the slope at the edge; `edges()` shades the edges again once
// a neighbour has come.
function relief(buffer: ArrayBuffer, bareBuffer: ArrayBuffer | null, box: Bounds, n: number, step: number, ref: number,
  around: ((di: number, dj: number) => Float32Array | null) | null) {
  // Heights in metres above `ref` (the game's y = 0), bilinear and clamped to the tile.
  const hm = decodeHeights(buffer, n, ref);
  // Hill shading uses the bare ground where bridges were raised (see ipr_terrain.py).
  const hs = new Uint16Array(bareBuffer || buffer);
  const L = [-110, 80, 190], ll = Math.hypot(...L);
  const lx = L[0] / ll, ly = L[1] / ll, lz = L[2] / ll;
  const px = new Uint16Array(n * n);
  // Height (m above 100 m a.s.l.) at a grid point; one past the edge, from the
  // neighbour's second row (its first is this tile's edge); NaN where there's none.
  const at = (i: number, j: number) => {
    if (i >= 0 && i < n && j >= 0 && j < n) return hs[j * n + i] / 10;
    const o = around?.(i < 0 ? -1 : i >= n ? 1 : 0, j < 0 ? -1 : j >= n ? 1 : 0);
    return o ? o[(j < 0 ? n - 2 : j >= n ? 1 : j) * n + (i < 0 ? n - 2 : i >= n ? 1 : i)] + ref - 100 : NaN;
  };
  // Each texel's middle sits on its grid point: the box reaches half a step past the
  // outer points. (Since 2026-09-29 the outer points lie on the tile's edges, shared
  // with the neighbours; older data stops a little short, see ipr_terrain.py.)
  const [x0, y0] = box, half = step / 2;
  // The slope across the neighbouring points, or at an edge with no neighbour between
  // the edge point and the next one in (halving it there by leaving out the missing
  // side would draw a line along the tile edge).
  const slope = (a: number, c: number, b: number) =>
    Number.isNaN(a) ? (Number.isNaN(b) ? 0 : (b - c) / step) : Number.isNaN(b) ? (c - a) / step : (b - a) / (2 * step);
  const paint = (i: number, j: number) => {
    const c = at(i, j), dx = slope(at(i - 1, j), c, at(i + 1, j)), dy = slope(at(i, j - 1), c, at(i, j + 1));
    const nl = Math.hypot(dx, dy, 1);
    const lit = (-dx * lx - dy * ly + lz) / nl / lz; // 1 on flat ground
    const shade = Math.round(128 * Math.max(0.55, Math.min(1.35, 1 + 1.1 * (lit - 1)))) / 127.5;
    px[j * n + i] = THREE.DataUtils.toHalfFloat(shade * broad(x0 + i * step, y0 + j * step));
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) paint(i, j);
  const tex = new THREE.DataTexture(px, n, n, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const edges = () => {
    for (let k = 0; k < n; k++) { paint(k, 0); paint(k, n - 1); paint(0, k); paint(n - 1, k); }
    tex.needsUpdate = true;
  };
  return { texture: tex, box: [x0 - half, y0 - half, x0 + (n - 1) * step + half, y0 + (n - 1) * step + half], sample: heightSampler(hm, box, n, step), hm, edges };
}

const buildingMaterial = () => shadeBuildings(new THREE.MeshLambertMaterial({ vertexColors: true }));

// The ground of a tile as depth alone, a little below the ground itself: drawn after
// the ground's layers (which have no depth) and before the tunnels, so what's under
// the ground is hidden but for the hole round you.
function depthOnlyGround(hm: Float32Array, [x0, y0]: Bounds, n: number, step: number) {
  const pos = new Float32Array(n * n * 3), idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 3;
    pos[k] = x0 + i * step;
    pos[k + 1] = hm[j * n + i] - 0.3;
    pos[k + 2] = -(y0 + j * step);
  }
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, cutAway(new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), 'depth-ground'));
  mesh.renderOrder = -800;
  return mesh;
}

// Buildings from a worker's arrays: IPR's or extruded from OSM footprints, with their
// facade coordinates (facades.ts).
function buildingMesh(arrays: BuildingArrays) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(arrays.color, 3));
  if (arrays.drapeUv) g.setAttribute('drapeUv', new THREE.BufferAttribute(arrays.drapeUv, 2));
  g.setAttribute('facade', new THREE.BufferAttribute(arrays.facade, 4));
  const mesh = new THREE.Mesh(g, buildingMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Clip a polyline to a box; returns the pieces inside.
export function clipLine(pts: Point2[], [x0, y0, x1, y1]: Bounds): Point2[][] {
  const out: Point2[][] = [];
  let cur: Point2[] | null = null;
  for (let i = 0; i < pts.length - 1; i++) {
    let [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    let ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) ok = false; continue; }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (!ok || t0 > t1) { if (cur) { out.push(cur); cur = null; } continue; }
    const a: Point2 = [ax + dx * t0, ay + dy * t0], b: Point2 = [ax + dx * t1, ay + dy * t1];
    if (!cur) cur = [a];
    cur.push(b);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.length > 1);
}

// Whether (x, y) is within `pad` metres of a passage through a building.
function inPassage(passages: TilePassage[], x: number, y: number, pad = 0) {
  for (const p of passages) {
    const r = p.w / 2 + pad;
    for (let i = 0; i < p.pts.length - 1; i++) {
      const [ax, ay] = p.pts[i], [bx, by] = p.pts[i + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      if (Math.hypot(ax + dx * u - x, ay + dy * u - y) < r) return true;
    }
  }
  return false;
}

export class TileWorld {
  osmBuildings: boolean;
  // Prototype (ground_cover.py): `cover`, the unmapped ground classified from aerial
  // photographs by that method (?cover=rules|model|jev); `ortho`, the painted
  // photograph itself under everything mapped (?ortho).
  cover: string | null; ortho: boolean; photos: Map<string, Promise<THREE.Texture | null>>;
  area: string;
  index: MapIndex;
  scene: THREE.Scene;
  time: { value: number };
  night: boolean;
  T: number; ox: number; oy: number;
  available: Set<string>; iprTiles: Map<string, boolean>;
  bare: Set<string>; leveled: boolean; structures: Set<string>;
  loaded: Map<string, Tile>; byIndex: Map<number, Tile>;
  last: { i: number; j: number; tile: Tile | undefined };
  pending: Map<string, Promise<TileFiles>>;
  drive: DriveGraph; walk: WalkGraph;
  driveBy: Map<string, DriveEdge[]>; walkBy: Map<string, WalkEdge[]>;
  onEdges: (drive: DriveEdge[], walk: WalkEdge[]) => void;
  onCars: (cars: Car[], tile: Tile) => void;
  onDrop: (tile: Tile) => void;
  building: number; inFlight: Set<string>; builds: Map<string, Promise<Tile>>;
  retry: Map<string, number>; workers: TileWorkers; ref: number;
  grid: {
    res: number; height: (x: number, y: number) => number; at: (x: number, y: number) => number;
    view: (who: Tracked) => { res: number; height: (x: number, y: number) => number; at: (x: number, y: number) => number };
  };

  constructor({ area, index, scene, drive, walk, time, night, osmBuildings = false, cover = null, ortho = false }: {
    area: string; index: MapIndex; scene: THREE.Scene; drive: DriveGraph; walk: WalkGraph;
    time: { value: number }; night: boolean; osmBuildings?: boolean; cover?: string | null; ortho?: boolean;
  }) {
    this.osmBuildings = osmBuildings;
    this.cover = cover;
    this.ortho = ortho;
    this.photos = new Map();
    this.area = area;
    this.index = index;
    loadFacadeAtlas();
    this.scene = scene;
    this.time = time;
    this.night = night;
    this.T = index.tile;
    [this.ox, this.oy] = index.origin;
    this.available = new Set(index.tiles.map(([i, j]) => `${i}_${j}`));
    // Which tiles have IPR buildings, where index.json says (else the tile JSON does).
    this.iprTiles = new Map(index.tiles.filter((t) => t.length > 3).map(([i, j, , ipr]) => [`${i}_${j}`, !!ipr]));
    this.bare = new Set(index.terrain?.bare || []);
    // Bridges and tunnels with levels of their own (ipr_terrain.py); older data raised
    // bridges into the ground and had no tunnels.
    this.leveled = !!index.terrain?.structures;
    this.structures = new Set(index.terrain?.structures || []);
    this.loaded = new Map(); // key → tile
    this.byIndex = new Map(); // i * 65536 + j → tile, for lookups by position
    this.last = { i: NaN, j: NaN, tile: undefined };
    this.pending = new Map(); // key → Promise of the tile's files
    this.drive = drive;
    this.walk = walk;
    // Each tile's street graph edges, joined into drive/walk as tiles load.
    this.driveBy = new Map();
    this.walkBy = new Map();
    this.onEdges = () => {};
    this.onCars = () => {};
    this.onDrop = () => {};
    this.building = 0;
    this.inFlight = new Set();
    this.builds = new Map(); // key → Promise of the tile, while it's being built
    this.retry = new Map(); // key → when to try a tile that failed again
    this.workers = new TileWorkers();
    // Collision lookups across tiles; anywhere not loaded counts as solid.
    // Game y = 0 is this height above sea level (IPR buildings are stored against it).
    this.ref = index.iprRef ?? 180;
    // Anything on the ground or on a bridge, for what doesn't keep track of which;
    // `view` gives a car or the walker the grid as it meets it.
    this.grid = {
      res: RES,
      view: (who) => this.view(who),
      height: (x, y) => this.heightAt(x, y),
      at: (x, y) => {
        const t = this.tileAt(x, y);
        if (!t) return 255;
        const g = t.grid.at(x, y);
        if (g) for (const l of t.levels) if (l.level > 0 && l.grid.at(x, y)) return 0;
        return g;
      },
    };
  }

  // The loaded tile at a point. Lookups come by the thousand every frame and mostly
  // in the tile of the one before, so that one is kept at hand.
  tileAt(x: number, y: number) {
    const i = Math.floor((x + this.ox) / this.T), j = Math.floor((y + this.oy) / this.T), last = this.last;
    if (i !== last.i || j !== last.j) {
      last.i = i;
      last.j = j;
      last.tile = this.byIndex.get(i * 65536 + j);
    }
    return last.tile;
  }

  // Whether a point is on open water: true or false, null where nothing is loaded.
  waterAt(x: number, y: number): boolean | null {
    const t = this.tileAt(x, y);
    if (!t) return null;
    for (const { rings, box } of t.water) {
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      let inside = false;
      for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const [ax, ay] = r[i], [bx, by] = r[j];
          if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
        }
      }
      if (!inside) continue;
      // A weir across the river isn't open water either: boats stop short of it.
      for (const w of t.weirs) {
        for (let i = 0; i < w.length - 1; i++) {
          const [ax, ay] = w[i], [bx, by] = w[i + 1], dx = bx - ax, dy = by - ay;
          const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
          if (Math.hypot(x - ax - dx * k, y - ay - dy * k) < 5) return false;
        }
      }
      return true;
    }
    return false;
  }

  // Ground height (m above this.ref) at a point, 0 where nothing is loaded.
  terrainAt(x: number, y: number) {
    const t = this.tileAt(x, y);
    return t?.sample ? t.sample(x, y) : 0;
  }

  // Height of a level at a point: of the ground at level 0, of a bridge or tunnel
  // level where it is (NaN elsewhere).
  levelAt(x: number, y: number, level: number) {
    if (level === 0) return this.terrainAt(x, y);
    const t = this.tileAt(x, y);
    if (t) for (const l of t.levels) {
      if (l.level !== level || !l.grid.at(x, y)) continue;
      const h = l.sample(x, y);
      return Number.isNaN(h) ? this.terrainAt(x, y) : h;
    }
    return NaN;
  }

  // The bridge closest above the ground at a point, where it's a guess which one
  // something is on: the level and its height, or null.
  lowestBridge(x: number, y: number) {
    const t = this.tileAt(x, y);
    let best: { level: number; h: number } | null = null;
    if (t) for (const l of t.levels) {
      if (l.level <= 0 || !l.grid.at(x, y) || (best && l.level > best.level)) continue;
      best = { level: l.level, h: this.levelAt(x, y, l.level) };
    }
    return best;
  }

  // Height of what's underfoot at a point on a level: the ground (0), a bridge or a
  // tunnel. Without a level, a guess: a bridge, unless it's high over open ground (a
  // street under a flyover).
  surfaceAt(x: number, y: number, level?: number) {
    if (level !== undefined) {
      const h = this.levelAt(x, y, level);
      return Number.isNaN(h) ? this.terrainAt(x, y) : h;
    }
    return this.guess(x, y).h;
  }

  guess(x: number, y: number) {
    const g = this.terrainAt(x, y), b = this.lowestBridge(x, y);
    return b && (b.h - g < CLIMB || this.tileAt(x, y)?.grid.at(x, y)) ? b : { level: 0, h: g };
  }

  heightAt(x: number, y: number) { return this.surfaceAt(x, y); }

  // Keep track of whether someone or something (anything with x and y) is on the
  // ground, a bridge or in a tunnel: onto a bridge or into a tunnel where it meets the
  // ground (or the level it's on), off it where it ends. Sets `level` and `gz` (the
  // height underfoot) on it; returns the level.
  track(who: Tracked) {
    if (who._tx === who.x && who._ty === who.y && who.level !== undefined) return who.level;
    // Moved far since last time (put somewhere else): where it was says nothing.
    if (who._tx !== undefined && who._ty !== undefined && Math.abs(who.x - who._tx) + Math.abs(who.y - who._ty) > 12) who.level = undefined;
    who._tx = who.x;
    who._ty = who.y;
    const { x, y } = who, t = this.tileAt(x, y);
    if (!t?.levels.length || who.grounded) {
      who.level = 0;
      who.gz = this.terrainAt(x, y);
      return 0;
    }
    if (who.level === undefined) {
      // Someone on a street knows whether it's a bridge or a tunnel; anyone else, a guess.
      const hint = who.hint ?? (who.e ? (who.e.tunnel ? 'tunnel' : who.e.bridge ? 'bridge' : 'ground') : undefined);
      who.hint = undefined;
      let level = hint === 'ground' ? 0 : hint === undefined ? this.guess(x, y).level : NaN;
      if (Number.isNaN(level)) {
        // The level of that kind nearest the ground here.
        level = 0;
        for (const l of t.levels) {
          if ((hint === 'bridge') !== (l.level > 0) || !l.grid.at(x, y)) continue;
          if (!level || Math.abs(l.level) < Math.abs(level)) level = l.level;
        }
      }
      who.level = level;
    } else {
      const z = who.gz ?? this.terrainAt(x, y), here = this.levelAt(x, y, who.level);
      // What there is to be on here, and how far up or down from where it was.
      let reach: number | undefined, reachD = CLIMB, near = 0, nearD = Infinity;
      const g = this.terrainAt(x, y);
      const consider = (level: number, h: number) => {
        const d = Math.abs(h - z);
        // Within reach of where it was, or where the level meets the ground here (a
        // tunnel's portal, a bridge's end), for something on the ground.
        const at = who.level === 0 ? Math.min(d, Math.abs(h - g)) : d;
        if (at < reachD && level !== 0) { reach = level; reachD = at; }
        if (d < nearD) { near = level; nearD = d; }
      };
      consider(0, g);
      for (const l of t.levels) if (l.grid.at(x, y)) consider(l.level, this.levelAt(x, y, l.level));
      if (who.level === 0) {
        // Onto a bridge or into a tunnel at its end; or, over a river, back onto the
        // bridge (a tram that came in from beyond the loaded tiles, say).
        if (reach !== undefined) who.level = reach;
        else if (t.grid.at(x, y) === 255) { const b = this.lowestBridge(x, y); if (b) who.level = b.level; }
      } else if (Number.isNaN(here) || Math.abs(here - z) > 2 * CLIMB) {
        // Off the end of this level: onto whatever is within reach (another level, or
        // the ground), else the nearest.
        who.level = reach ?? (Math.abs(this.terrainAt(x, y) - z) < CLIMB ? 0 : near);
      }
    }
    who.gz = this.surfaceAt(x, y, who.level);
    return who.level;
  }

  // Height at (x, y) for someone at `who` (as track): a car's wheels, a tram's bogies.
  groundFor(who: Tracked, x: number, y: number) {
    return this.surfaceAt(x, y, this.track(who));
  }

  // Whether something is over `who` (as track): a bridge above it, or the ground above
  // a tunnel. There a round hole opens so it stays in view.
  covered(who: Tracked) {
    const level = this.track(who), z = who.gz ?? 0, t = this.tileAt(who.x, who.y);
    if (level < 0) return true;
    if (t) for (const l of t.levels) {
      if (l.level <= level || !l.grid.at(who.x, who.y)) continue;
      if (this.levelAt(who.x, who.y, l.level) - z > CLIMB) return true;
    }
    return false;
  }

  // Collision cell at (x, y) for someone at height z on `level`: on a bridge, its
  // parapets are solid wherever the ground beside is well below or above it; in a
  // tunnel, its walls; on the ground, a bridge overhead or a tunnel below is no wall,
  // and one at its height is open.
  cellAt(x: number, y: number, level: number, z: number) {
    const t = this.tileAt(x, y);
    if (!t) return 255;
    const g = t.grid.at(x, y);
    if (level === 0 && g === 0) return 0;
    for (const l of t.levels) {
      if (!l.grid.at(x, y)) continue;
      if (Math.abs(this.levelAt(x, y, l.level) - z) < CLIMB) return 0;
    }
    if (level !== 0) return g === 0 && Math.abs(this.terrainAt(x, y) - z) < CLIMB ? 0 : 255;
    return g;
  }

  // The collision grid and ground as `who` meets them (a car, the walker): with the
  // bridge or tunnel it's on or under. Same shape as this.grid.
  view(who: Tracked) {
    this.track(who);
    return (who._view ||= {
      res: RES,
      height: (x, y) => this.surfaceAt(x, y, who.level),
      at: (x, y) => this.cellAt(x, y, who.level ?? 0, who.gz ?? 0),
    });
  }

  // Whether (x, y) is in a passage through a building (under its upper floors), or
  // under a building raised off the ground (see RAISED).
  passageAt(x: number, y: number) {
    const t = this.tileAt(x, y);
    return !!t && (inPassage(t.passages, x, y, 0.5)
      || t.raised.some((rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h))));
  }

  keyAt(x: number, y: number) { return `${Math.floor((x + this.ox) / this.T)}_${Math.floor((y + this.oy) / this.T)}`; }

  // Tile keys within r metres of (x, y), nearest first.
  around(x: number, y: number, r: number): string[] {
    const T = this.T, out: [number, string][] = [];
    const i0 = Math.floor((x - r + this.ox) / T), i1 = Math.floor((x + r + this.ox) / T);
    const j0 = Math.floor((y - r + this.oy) / T), j1 = Math.floor((y + r + this.oy) / T);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = `${i}_${j}`;
        if (!this.available.has(k)) continue;
        const cx = (i + 0.5) * T - this.ox, cy = (j + 0.5) * T - this.oy;
        const d = Math.max(0, Math.hypot(cx - x, cy - y) - T * 0.71);
        if (d <= r) out.push([d, k]);
      }
    }
    return out.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  }

  // All of a tile's files at once: its JSON, terrain heights, its bridges' and tunnels'
  // heights (or, from before those, the bare ground where bridges were raised) and
  // IPR's buildings.
  fetchTile(k: string): Promise<TileFiles> {
    if (!this.pending.has(k)) {
      const base = `data/${this.area}_now/tiles/${k}`, gz = !!this.index.gzip;
      const bin = (name: string) => fetchBinary(`${base}.${name}.bin${gz ? '.gz' : ''}`, gz);
      const json: Promise<TileJSON> = fetch(`${base}.json`).then(async (r) => {
        if (!r.ok) throw new Error(`Tile ${k} could not be loaded (${r.status})`);
        const value: unknown = await r.json();
        if (!isTileJSON(value)) throw new Error(`Tile ${k} has invalid map data`);
        if (this.cover) {
          const c = await fetch(`data/${this.area}_now/cover/${this.cover}/${k}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          if (c) {
            // Tree canopy becomes wood, which the game fills with trees of its own.
            for (const [kind, polys] of Object.entries(c.areas || {})) {
              const key = kind === 'trees' ? 'wood' : `cover_${kind}`;
              value.areas[key] = [...(value.areas[key] || []), ...(polys as NonNullable<TileJSON['areas'][string]>)];
            }
            value.trees = [...value.trees, ...(c.trees || [])];
          }
        }
        return value;
      });
      if (this.ortho && !this.photos.has(k)) {
        this.photos.set(k, new THREE.TextureLoader().loadAsync(`data/${this.area}_now/cover/ortho/${k}.jpg`).then((tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          return tex;
        }).catch(() => null));
      }
      const height = this.index.terrain ? bin('height') : null;
      const bare = this.index.terrain && this.bare.has(k) ? bin('bare') : null;
      const levels = this.structures.has(k) ? bin('levels') : null;
      const known = this.iprTiles.get(k);
      const ipr = this.osmBuildings || known === false ? null : known ? bin('ipr') : json.then((t) => (t.ipr ? bin('ipr') : null));
      const files = Promise.all([json, height, bare, ipr, levels]).then(([t, height, bare, ipr, levels]) => ({ t, height, bare, ipr, levels }));
      files.catch(() => { if (this.pending.get(k) === files) this.failed(k); });
      this.pending.set(k, files);
    }
    return this.pending.get(k)!;
  }

  // A tile whose files or build failed is fetched afresh, after a pause (a file that
  // keeps failing would otherwise be asked for every frame).
  failed(k: string) {
    this.pending.delete(k);
    this.retry.set(k, performance.now() + 2000);
  }

  // Load everything within r now (used at start); returns when done. A tile that fails
  // (a dropped or cut-short download on a busy machine) is tried again a couple of
  // times, then left for update() to load later, so one bad file never stops the start.
  async loadNow(x: number, y: number, r: number) {
    await Promise.all(this.around(x, y, r).map(async (k) => {
      for (let tries = 1; !this.loaded.has(k); tries++) {
        try {
          await this.build(k, await this.fetchTile(k));
        } catch (e) {
          // fetchTile and build have already called failed(k), so the next try fetches afresh.
          if (tries >= 3) {
            console.warn(`Tile ${k} failed to load at start; it will be tried again shortly`, e);
            this.failed(k);
            return;
          }
          await new Promise((done) => setTimeout(done, 300 * tries));
        }
      }
    }));
  }

  // Called every frame: starts building the nearest missing tiles, drops far ones.
  update(x: number, y: number, r: number) {
    const now = performance.now();
    const want = this.around(x, y, r).filter((k) => !((this.retry.get(k) ?? 0) > now));
    for (const k of want.slice(0, 12)) this.fetchTile(k);
    // One build per worker at a time.
    while (this.building < this.workers.size) {
      const next = want.find((k) => !this.loaded.has(k) && !this.inFlight.has(k));
      if (!next) break;
      this.building++;
      this.inFlight.add(next);
      this.fetchTile(next).then((files) => this.build(next, files)).catch((e) => console.error(e)).finally(() => {
        this.building--;
        this.inFlight.delete(next);
      });
    }
    const keep = new Set(this.around(x, y, r + this.T * 0.5));
    for (const k of [...this.loaded.keys()]) if (!keep.has(k)) this.drop(k);
    // Files fetched ahead for tiles that are now far behind aren't needed any more.
    for (const k of [...this.pending.keys()]) if (!keep.has(k) && !this.loaded.has(k) && !this.inFlight.has(k)) this.pending.delete(k);
  }

  // Build a tile (once, however many ask: loadNow and update may both want it, and
  // its IPR buildings are handed over to a worker, so they can't be used twice).
  build(k: string, files: TileFiles): Promise<Tile> {
    if (this.loaded.has(k)) return Promise.resolve(this.loaded.get(k)!);
    if (!this.builds.has(k)) {
      const made = this.make(k, files)
        .catch((e) => { this.failed(k); throw e; })
        .finally(() => this.builds.delete(k));
      this.builds.set(k, made);
    }
    return this.builds.get(k)!;
  }

  async make(k: string, { t, height, bare, ipr, levels }: TileFiles): Promise<Tile> {
    const [x0, y0, x1, y1] = t.box;
    const data = { ...t, size: [x1 - x0, y1 - y0] as Point2, origin: [-x0, -y0] as Point2 };
    const geo = new Geo(data);
    const own = t.buildings.filter((b) => b.own);
    // What stands on the ground: not the parts raised well above it (a covered bridge
    // between two buildings, an overhang on pillars), which you walk and drive under.
    const grounded = (b: { minh?: number }) => !((b.minh ?? 0) >= RAISED);
    // The tile's paid-parking sections (clipped to it, with their share of spaces).
    const zones = new Zones({ sections: (t.sections || []).map((z) => ({ ...z, inside: z.share })) });
    if (t.drive && !this.driveBy.has(k)) {
      this.driveBy.set(k, this.drive.add(t.drive));
      this.walkBy.set(k, this.walk.add(t.walk ?? []));
      this.onEdges(this.driveBy.get(k)!, this.walk.fresh);
    }
    const ms: Record<string, number> = {};
    let t0 = performance.now();
    const lap = (name: string) => { const t1 = performance.now(); ms[name] = Math.round(t1 - t0); t0 = t1; };
    // Terrain first: everything in the tile stands on it.
    const terrain = this.index.terrain;
    if ((height || levels) && !terrain) throw new Error(`Terrain metadata missing for tile ${k}`);
    // Data from 2026-09-29 on shares the grid points along tile edges with the neighbours.
    const shared = !!terrain && Math.abs((terrain.n - 1) * terrain.step - (x1 - x0)) < 0.01;
    const around = shared ? (di: number, dj: number) => this.byIndex.get((t.i + di) * 65536 + t.j + dj)?.relief?.hm ?? null : null;
    const shade = height && terrain ? relief(height, bare, t.box, terrain.n, terrain.step, this.ref, around) : null;
    const hAt = shade ? shade.sample : () => 0;
    const ground = shade && terrain ? { hm: shade.hm, box: t.box, n: terrain.n, step: terrain.step } : null;
    // Bridges above the ground and tunnels below it, each level with its own heights.
    const structures = t.structures || [];
    const heights = levels && terrain ? decodeLevels(levels, terrain.n, structures.length, this.ref) : [];
    const tileLevels: LevelInput[] | null = this.leveled && terrain ? structures.map((s, i) => ({
      ...s, heights: { hm: heights[i] ?? new Float32Array(terrain.n * terrain.n).fill(NaN), box: t.box, n: terrain.n, step: terrain.step },
    })) : null;
    lap('terrain');

    // Real 3D buildings from IPR where the area has them (unless ?osm), else OSM
    // footprints extruded with straight-skeleton roofs, each set on the lowest ground
    // under its footprint. In a tile with IPR buildings, the OSM ones IPR doesn't have
    // (noIpr, see ipr_buildings.py) are still extruded.
    const withIpr = !!(t.ipr && !this.osmBuildings && ipr);
    const extrude = own.filter((b) => !withIpr || b.noIpr)
      .map((b) => ({ ...b, base: Math.min(...b.rings[0].map(([x, y]) => hAt(x, y))) }));
    const bbox = this.index.bbox_wgs84;
    const edges = this.driveBy.get(k) || [];
    const clipped = edges.flatMap((e) => clipLine(e.pts, t.box).map((pts) => (
      { pts, u: e.u, v: e.v, hw: e.hw, lanes: e.lanes, oneway: e.oneway, width: e.width, surface: e.surface, bridge: e.bridge, tunnel: e.tunnel })));
    // Paid-parking colour of each parking area's bay lines.
    const parkingZones = (t.areas.parking || []).map((rs) => {
      const r = rs[0], cx = r.reduce((a, p) => a + p[0], 0) / r.length, cy = r.reduce((a, p) => a + p[1], 0) / r.length;
      return zones.at(cx, cy)?.category || null;
    });
    // Seeds for the collision grid: points along every street and path in the tile.
    const seeds = [];
    for (const e of [...edges, ...(this.walkBy.get(k) || [])]) {
      for (const pts of clipLine(e.pts, t.box)) {
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) / 3);
          for (let s = 0; s <= n; s++) seeds.push(ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n);
        }
      }
    }
    const seedArray = new Float64Array(seeds);
    const outlines = t.buildings.filter(grounded).map((b) => ({ rings: b.rings }));
    const w = this.workers;
    const jobs = Promise.all([
      w.run('ground', {
        d: { areas: t.areas, roads: t.roads, rails: t.rails, weirs: t.weirs, crossings: t.crossings },
        box: [geo.minX, geo.minY, geo.maxX, geo.maxY] as Bounds, edges: clipped, buildings: own.filter(grounded).map((b) => ({ rings: b.rings })), parkingZones, ground, levels: tileLevels,
      }),
      w.run('land', {
        data: { size: data.size, origin: data.origin, areas: t.areas, roads: t.roads, buildings: outlines, walls: t.walls, trees: t.trees, passages: t.passages || [], levels: !!tileLevels },
        seeds: seedArray, ground, bridges: (tileLevels || []).filter((l) => l.kind === 'bridge').map((l) => l.heights),
      }, [seedArray.buffer]),
      withIpr ? w.run('ipr', { buffer: ipr, box: t.box, absolute: this.index.iprRef != null, ground, bbox }, [ipr]) : null,
      !withIpr || extrude.length ? w.run('roofs', { buildings: extrude, size: data.size, origin: data.origin, ground, bbox }) : null,
    ]);
    lap('send');
    const [{ layers, masks }, land, iprArrays, roofArrays] = await jobs;
    if (this.loaded.has(k)) return this.loaded.get(k)!;
    t0 = performance.now();

    const group = new THREE.Group();
    // Where each level is: for drawing what's on it, and for getting about on it.
    const levelMasks = new Map<number, { texture: THREE.DataTexture; box: number[] }>();
    const onLevels: TileLevel[] = [];
    for (const mask of masks) {
      const texture = new THREE.DataTexture(mask.cells, mask.w, mask.h, THREE.RedFormat, THREE.UnsignedByteType);
      texture.unpackAlignment = 1;
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      levelMasks.set(mask.level, { texture, box: [x0, y1, x0 + mask.w / RES, y1 - mask.h / RES] });
      const input = tileLevels?.find((l) => l.level === mask.level);
      onLevels.push({
        level: mask.level, grid: new Grid(geo, RES, null, mask.cells),
        sample: input ? heightSampler(input.heights.hm, t.box, input.heights.n, input.heights.step) : () => NaN,
      });
    }
    const photo = this.ortho ? await this.photos.get(k) : null;
    const surfaces = new Surfaces(layers, { time: this.time, relief: shade, masks: levelMasks, photo: photo ? { texture: photo, box: [x0, y0, x1, y1] } : null });
    // Under a tunnel, the ground hides what's below it (the tunnel, the cars in it)
    // except round you (CUTAWAY): the ground's own layers are drawn without depth.
    const hidden = shade && terrain && onLevels.some((l) => l.level < 0) ? depthOnlyGround(shade.hm, t.box, terrain.n, terrain.step) : null;
    if (hidden) group.add(hidden);
    const buildings = [iprArrays, roofArrays].filter((arrays): arrays is BuildingArrays => arrays !== null).map(buildingMesh);
    const walls = wallMesh(land.walls);
    const trees = treeMesh(land.trees);
    group.add(surfaces.group, ...buildings, walls, trees);
    // Nothing in a tile ever moves: its matrices are worked out once, not every frame,
    // and the renderer's walk through the scene each frame skips the tile's objects.
    group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    group.updateMatrixWorld(true);
    group.updateMatrixWorld = () => {};
    const grid = new Grid(geo, RES, null, land.cells);
    lap('meshes');

    const inside = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const { cars } = parkCars({
      data, edges, zones, r: rng(Math.floor(hash(`${this.area}/${k}`) * 1e9)), night: this.night,
      shares: new Map((t.sections ?? []).map((s) => [s.code, s.share])), inside,
      // No parking inside passages.
      solid: (x, y) => (inside(x, y) ? grid.at(x, y) !== 0 || inPassage(t.passages || [], x, y, 1) : false),
    });
    lap('parking');
    this.scene.add(group);
    for (const c of cars) c.level = 0; // (nobody parks on a bridge or in a tunnel)
    const tile: Tile = {
      k, i: t.i, j: t.j, box: t.box, passages: t.passages || [], raised: t.buildings.filter((b) => !grounded(b)).map((b) => b.rings), group, surfaces, grid, levels: onLevels, cars, ms,
      disposables: [...buildings, walls, trees, ...(hidden ? [hidden] : [])], relief: shade, sample: shade?.sample,
      water: (t.areas.water || []).map((rings) => {
        const xs = rings[0].map((p) => p[0]), ys = rings[0].map((p) => p[1]);
        return { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Bounds };
      }),
      weirs: t.weirs || [],
    };
    this.loaded.set(k, tile);
    this.byIndex.set(t.i * 65536 + t.j, tile);
    // The neighbours' hill shading along the shared edges, now that this side is known.
    if (shared) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.byIndex.get((t.i + di) * 65536 + t.j + dj)?.relief?.edges();
    this.last.i = NaN;
    this.onCars(cars, tile);
    return tile;
  }

  drop(k: string) {
    const t = this.loaded.get(k);
    if (!t) return;
    this.scene.remove(t.group);
    t.surfaces.dispose();
    t.relief?.texture.dispose();
    this.photos.get(k)?.then((tex) => tex?.dispose());
    this.photos.delete(k);
    for (const m of t.disposables) {
      m.geometry.dispose();
      if (Array.isArray(m.material)) m.material.forEach((material) => material.dispose());
      else m.material.dispose();
      if ('dispose' in m && typeof m.dispose === 'function') m.dispose();
    }
    this.loaded.delete(k);
    this.byIndex.delete(t.i * 65536 + t.j);
    this.last.i = NaN;
    this.pending.delete(k);
    this.onDrop(t);
  }
}
