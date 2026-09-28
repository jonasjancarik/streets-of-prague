import * as THREE from 'three';
import { Geo, Grid, rng, hash } from './map/geo.ts';
import { wallMesh } from './map/buildings.ts';
import { treeMesh } from './map/vegetation.ts';
import { Surfaces } from './surface.ts';
import { shadeBuildings } from './shading.ts';
import { loadFacadeAtlas } from './facades.ts';
import { Zones, parkCars } from './parking.ts';
import { decodeHeights, heightSampler, fetchBinary } from './terrain.ts';
import type { DriveEdge, RawEdge, WalkEdge } from './network.ts';
import type {
  Box,
  BuildingArrays,
  GeneratedTile,
  GroundJobData,
  HeightAt,
  IprJobData,
  LandJobData,
  Point,
  Relief,
  TerrainData,
  TileData,
  TileEdge,
  TileIndex,
  TileJobMap,
  TileJobType,
  TilePassage,
  RawTileData,
  TileWorkerResponse,
  TileWorkerTransferList,
} from './tile-types.ts';

// Streams the map in square tiles (pipeline/build_tiles.py) around the camera. Each
// loaded tile has its own ground, buildings, trees, collision grid and parked cars;
// tiles far behind are dropped again. The street graphs stay global. The heavy part
// of building a tile runs in workers (tileWorker.ts); the main thread fetches the
// tile's files, joins up the street graphs and makes the meshes and parked cars.

const RES = 2; // collision grid cells per metre
// Metres a car or a walker can go up or down between the ground and a bridge deck:
// where a deck is that close to the ground (at its ends), they drive onto it; further
// apart, the deck is overhead, or the ground is below the parapet.
const CLIMB = 1.5;

// A small pool of workers that build tiles (see tileWorker.ts).
class TileWorkers {
  workers: Worker[];
  jobs: Map<number, { resolve: (result: unknown) => void; reject: (reason?: unknown) => void }>;
  next: number;
  size: number;

  constructor(n: number = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2))) {
    this.workers = [];
    this.jobs = new Map();
    this.next = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<TileWorkerResponse>) => {
        const job = this.jobs.get(e.data.id);
        this.jobs.delete(e.data.id);
        if (!job) return;
        if ('error' in e.data) job.reject(new Error(e.data.error));
        else job.resolve(e.data.result);
      };
      this.workers.push(w);
    }
    this.size = n;
  }

  run<Type extends TileJobType>(type: Type, data: TileJobMap[Type]['data'], transfer: TileWorkerTransferList = []): Promise<TileJobMap[Type]['result']> {
    const id = this.next++;
    return new Promise<TileJobMap[Type]['result']>((resolve, reject) => {
      this.jobs.set(id, { resolve: (result) => resolve(result as TileJobMap[Type]['result']), reject });
      this.workers[id % this.workers.length].postMessage({ id, type, data }, transfer);
    });
  }
}

// Hill shading for a tile from its terrain heights (pipeline/ipr_terrain.py), lit from
// the same north-west as the sun: 128 = unchanged, darker on slopes facing away.
function relief(buffer: ArrayBuffer, bareBuffer: ArrayBuffer | null, box: Box, n: number, step: number, ref: number): Relief {
  // Heights in metres above `ref` (the game's y = 0), bilinear and clamped to the tile.
  const hm = decodeHeights(buffer, n, ref);
  // Hill shading uses the bare ground where bridges were raised (see ipr_terrain.py).
  const hs = new Uint16Array(bareBuffer || buffer);
  const L = [-110, 80, 190], ll = Math.hypot(...L);
  const lx = L[0] / ll, ly = L[1] / ll, lz = L[2] / ll;
  const px = new Uint8Array(n * n);
  const at = (i: number, j: number): number => hs[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))] / 10;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * step), dy = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
      const nl = Math.hypot(dx, dy, 1);
      const lit = (-dx * lx - dy * ly + lz) / nl / lz; // 1 on flat ground
      px[j * n + i] = Math.max(0, Math.min(255, Math.round(128 * Math.max(0.55, Math.min(1.35, 1 + 1.1 * (lit - 1))))));
    }
  }
  const tex = new THREE.DataTexture(px, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const [x0, y0] = box;
  return { texture: tex, box: [x0, y0, x0 + (n - 1) * step, y0 + (n - 1) * step], sample: heightSampler(hm, [x0, y0], n, step), hm };
}

const buildingMaterial = () => shadeBuildings(new THREE.MeshLambertMaterial({ vertexColors: true }));

// Buildings from a worker's arrays: IPR's or extruded from OSM footprints, with their
// facade coordinates (facades.ts).
function buildingMesh(arrays: BuildingArrays): THREE.Mesh {
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
export function clipLine(pts: Point[], [x0, y0, x1, y1]: Box): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] | null = null;
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
    const a: Point = [ax + dx * t0, ay + dy * t0], b: Point = [ax + dx * t1, ay + dy * t1];
    if (!cur) cur = [a];
    cur.push(b);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.length > 1);
}

// Whether (x, y) is within `pad` metres of a passage through a building.
function inPassage(passages: TilePassage[], x: number, y: number, pad = 0): boolean {
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

interface DriveGraph {
  add(edges: RawEdge[]): DriveEdge[];
}

interface WalkGraph {
  add(edges: RawEdge[]): WalkEdge[];
  fresh: WalkEdge[];
}

interface TileWorldOptions {
  area: string;
  index: TileIndex;
  scene: THREE.Scene;
  drive: DriveGraph;
  walk: WalkGraph;
  time: { value: number };
  night: boolean;
  osmBuildings?: boolean;
}

export interface TrackedEntity {
  x: number;
  y: number;
  level?: number;
  gz?: number;
  _tx?: number;
  _ty?: number;
  _view?: CollisionGrid;
  e?: { bridge?: boolean };
}

interface CollisionGrid {
  res: number;
  height(x: number, y: number): number;
  at(x: number, y: number): number;
}

interface TileFiles {
  t: RawTileData;
  height: ArrayBuffer | null;
  bare: ArrayBuffer | null;
  ipr: ArrayBuffer | null;
  deck: ArrayBuffer | null;
}

function isRawTileData(value: unknown): value is RawTileData {
  if (typeof value !== 'object' || value === null) return false;
  const tile = value as Record<string, unknown>;
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const point = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  const edge = (v: unknown) => record(v) && 'id' in v && typeof v.id === 'string'
    && 'pts' in v && Array.isArray(v.pts) && v.pts.every(point);
  const building = (v: unknown) => record(v) && 'rings' in v && Array.isArray(v.rings)
    && v.rings.every((ring: unknown) => Array.isArray(ring) && ring.every(point));
  return Number.isInteger(tile.i) && Number.isInteger(tile.j)
    && Array.isArray(tile.box) && tile.box.length === 4 && tile.box.every((n) => typeof n === 'number' && Number.isFinite(n))
    && record(tile.areas) && record(tile.roads)
    && Array.isArray(tile.buildings) && tile.buildings.every(building)
    && Array.isArray(tile.walls) && Array.isArray(tile.rails) && Array.isArray(tile.trees)
    && (tile.passages === undefined || Array.isArray(tile.passages))
    && (tile.sections === undefined || Array.isArray(tile.sections))
    && (tile.lots === undefined || Array.isArray(tile.lots))
    && (tile.drive === undefined || (Array.isArray(tile.drive) && tile.drive.every(edge)))
    && (tile.walk === undefined || (Array.isArray(tile.walk) && tile.walk.every(edge)))
    && (tile.drive === undefined || Array.isArray(tile.walk))
    && (tile.ipr === undefined || record(tile.ipr));
}

export class TileWorld {
  osmBuildings: boolean;
  area: string;
  index: TileIndex;
  scene: THREE.Scene;
  time: { value: number };
  night: boolean;
  T: number;
  ox: number;
  oy: number;
  available: Set<string>;
  iprTiles: Map<string, boolean>;
  bare: Set<string>;
  decked: boolean;
  decks: Set<string>;
  loaded: Map<string, GeneratedTile>;
  byIndex: Map<number, GeneratedTile>;
  last: { i: number; j: number; tile: GeneratedTile | undefined };
  pending: Map<string, Promise<TileFiles>>;
  drive: DriveGraph;
  walk: WalkGraph;
  driveBy: Map<string, DriveEdge[]>;
  walkBy: Map<string, WalkEdge[]>;
  onEdges: (edges: DriveEdge[], fresh: WalkEdge[]) => void;
  onCars: (cars: GeneratedTile['cars'], tile: GeneratedTile) => void;
  onDrop: (tile: GeneratedTile) => void;
  building: number;
  inFlight: Set<string>;
  builds: Map<string, Promise<GeneratedTile>>;
  retry: Map<string, number>;
  workers: TileWorkers;
  ref: number;
  grid: CollisionGrid;

  constructor({ area, index, scene, drive, walk, time, night, osmBuildings = false }: TileWorldOptions) {
    this.osmBuildings = osmBuildings;
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
    // Bridge decks above the bare ground (ipr_terrain.py); older data raised them into it.
    this.decked = !!index.terrain?.decks;
    this.decks = new Set(index.terrain?.decks || []);
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
    // Anything on the ground or on a deck (for what doesn't keep track of which: see view).
    this.grid = {
      res: RES,
      height: (x, y) => this.heightAt(x, y),
      at: (x, y) => {
        const t = this.tileAt(x, y);
        if (!t) return 255;
        const g = t.grid.at(x, y);
        return g && t.deck?.grid.at(x, y) ? 0 : g;
      },
    };
  }

  // The loaded tile at a point. Lookups come by the thousand every frame and mostly
  // in the tile of the one before, so that one is kept at hand.
  tileAt(x: number, y: number): GeneratedTile | undefined {
    const i = Math.floor((x + this.ox) / this.T), j = Math.floor((y + this.oy) / this.T), last = this.last;
    if (i !== last.i || j !== last.j) {
      last.i = i;
      last.j = j;
      last.tile = this.byIndex.get(i * 65536 + j);
    }
    return last.tile;
  }

  // Ground height (m above this.ref) at a point, 0 where nothing is loaded.
  terrainAt(x: number, y: number): number {
    const t = this.tileAt(x, y);
    return t?.sample ? t.sample(x, y) : 0;
  }

  // Height of the bridge deck at a point, NaN off the decks.
  deckAt(x: number, y: number): number {
    const t = this.tileAt(x, y);
    if (!t?.deck?.grid.at(x, y)) return NaN;
    const h = t.deck.sample(x, y);
    return Number.isNaN(h) ? this.terrainAt(x, y) : h;
  }

  // Height of what's underfoot at a point: the ground (level 0) or a bridge deck
  // (level 1). Without a level, a guess: the deck, unless it's high over open ground
  // (a street under a flyover).
  surfaceAt(x: number, y: number, level?: number): number {
    const d = level === 0 ? NaN : this.deckAt(x, y);
    if (Number.isNaN(d)) return this.terrainAt(x, y);
    if (level === 1) return d;
    const g = this.terrainAt(x, y);
    return d - g < CLIMB || this.tileAt(x, y)!.grid.at(x, y) ? d : g;
  }

  heightAt(x: number, y: number): number { return this.surfaceAt(x, y); }

  // Keep track of whether someone or something (anything with x and y) is on the
  // ground or on a bridge deck: onto a deck where it meets the ground, off it where it
  // ends. Sets `level` and `gz` (the height underfoot) on it; returns the level.
  track(who: TrackedEntity): number {
    if (who._tx === who.x && who._ty === who.y && who.level !== undefined) return who.level;
    // Moved far since last time (put somewhere else): where it was says nothing.
    if (Math.abs(who.x - (who._tx ?? NaN)) + Math.abs(who.y - (who._ty ?? NaN)) > 12) who.level = undefined;
    who._tx = who.x;
    who._ty = who.y;
    const d = this.deckAt(who.x, who.y);
    if (Number.isNaN(d)) who.level = 0;
    else if (who.level === undefined) {
      // Someone on a footpath knows whether it's a bridge; anyone else, a guess.
      const g = this.terrainAt(who.x, who.y);
      who.level = who.e?.bridge !== undefined ? +who.e.bridge
        : d - g < CLIMB || this.tileAt(who.x, who.y)!.grid.at(who.x, who.y) ? 1 : 0;
    } else if (who.level === 0) {
      // Up onto the deck at its end (where the ground meets it, or where it was just
      // before: the ground may drop away at once, at a quay wall); or, far out over a
      // river, back onto it (a tram that came in from beyond the loaded tiles, say).
      const g = this.terrainAt(who.x, who.y);
      if (Math.abs(d - g) < CLIMB || Math.abs(d - (who.gz ?? NaN)) < CLIMB || this.tileAt(who.x, who.y)!.grid.at(who.x, who.y) === 255) who.level = 1;
    }
    who.gz = who.level ? d : this.terrainAt(who.x, who.y);
    return who.level;
  }

  // Height at (x, y) for someone at `who` (as track): a car's wheels, a tram's bogies.
  groundFor(who: TrackedEntity, x: number, y: number): number {
    return this.surfaceAt(x, y, this.track(who));
  }

  // Whether a bridge deck is overhead at a point, for someone on the ground there.
  deckAbove(x: number, y: number): boolean {
    const d = this.deckAt(x, y);
    return d - this.terrainAt(x, y) > CLIMB;
  }

  // Collision cell at (x, y) for someone at height z on `level`: on a deck, its
  // parapets are solid wherever the ground beside is well below or above it; on the
  // ground, a deck overhead is no wall, and one at its level is open.
  cellAt(x: number, y: number, level: number, z?: number): number {
    const t = this.tileAt(x, y);
    if (!t) return 255;
    const g = t.grid.at(x, y);
    const surfaceHeight = z ?? NaN;
    if (!t.deck) return level ? (g === 0 && Math.abs(this.terrainAt(x, y) - surfaceHeight) < CLIMB ? 0 : 255) : g;
    const d = this.deckAt(x, y);
    if (level) {
      if (!Number.isNaN(d) && Math.abs(d - surfaceHeight) < CLIMB) return 0;
      return g === 0 && Math.abs(this.terrainAt(x, y) - surfaceHeight) < CLIMB ? 0 : 255;
    }
    return g && !Number.isNaN(d) && Math.abs(d - surfaceHeight) < CLIMB ? 0 : g;
  }

  // The collision grid and ground as `who` meets them (a car, the walker): with the
  // bridge decks it's on or under. Same shape as this.grid.
  view(who: TrackedEntity): CollisionGrid {
    this.track(who);
    return (who._view ||= {
      res: RES,
      height: (x: number, y: number) => this.surfaceAt(x, y, who.level),
      at: (x: number, y: number) => this.cellAt(x, y, who.level ?? 0, who.gz),
    });
  }

  // Whether (x, y) is in a passage through a building (under its upper floors).
  passageAt(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    return !!t && inPassage(t.passages, x, y, 0.5);
  }

  keyAt(x: number, y: number): string { return `${Math.floor((x + this.ox) / this.T)}_${Math.floor((y + this.oy) / this.T)}`; }

  // Tile keys within r metres of (x, y), nearest first.
  around(x: number, y: number, r: number): string[] {
    const T = this.T, out: Array<[number, string]> = [];
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

  // All of a tile's files at once: its JSON, terrain heights, its bridge decks' heights
  // (or, from before decks, the bare ground where bridges were raised) and IPR's
  // buildings.
  fetchTile(k: string): Promise<TileFiles> {
    if (!this.pending.has(k)) {
      const base = `data/${this.area}_now/tiles/${k}`, gz = !!this.index.gzip;
      const bin = (name: string) => fetchBinary(`${base}.${name}.bin${gz ? '.gz' : ''}`, gz);
      const json = fetch(`${base}.json`).then(async (r): Promise<RawTileData> => {
        if (!r.ok) throw new Error(`Tile ${k} is unavailable.`);
        const data: unknown = await r.json();
        if (!isRawTileData(data)) throw new Error(`Tile ${k} has incomplete map data.`);
        return data;
      });
      const height = this.index.terrain ? bin('height') : null;
      const bare = this.index.terrain && this.bare.has(k) ? bin('bare') : null;
      const deck = this.decks.has(k) ? bin('deck') : null;
      const known = this.iprTiles.get(k);
      const ipr = this.osmBuildings || known === false ? null : known ? bin('ipr') : json.then((t) => (t.ipr ? bin('ipr') : null));
      const files: Promise<TileFiles> = Promise.all([json, height, bare, ipr, deck]).then(([t, height, bare, ipr, deck]) => ({ t, height, bare, ipr, deck }));
      files.catch(() => { if (this.pending.get(k) === files) this.failed(k); });
      this.pending.set(k, files);
    }
    return this.pending.get(k)!;
  }

  // A tile whose files or build failed is fetched afresh, after a pause (a file that
  // keeps failing would otherwise be asked for every frame).
  failed(k: string): void {
    this.pending.delete(k);
    this.retry.set(k, performance.now() + 2000);
  }

  // Load everything within r now (used at start); returns when done.
  async loadNow(x: number, y: number, r: number): Promise<void> {
    await Promise.all(this.around(x, y, r).map(async (k) => {
      if (!this.loaded.has(k)) await this.build(k, await this.fetchTile(k));
    }));
  }

  // Called every frame: starts building the nearest missing tiles, drops far ones.
  update(x: number, y: number, r: number): void {
    const now = performance.now();
    const want = this.around(x, y, r).filter((k) => !(this.retry.get(k)! > now));
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
  build(k: string, files: TileFiles): Promise<GeneratedTile> {
    if (this.loaded.has(k)) return Promise.resolve(this.loaded.get(k)!);
    if (!this.builds.has(k)) {
      const made = this.make(k, files)
        .catch((e) => { this.failed(k); throw e; })
        .finally(() => this.builds.delete(k));
      this.builds.set(k, made);
    }
    return this.builds.get(k)!;
  }

  async make(k: string, { t, height, bare, ipr, deck }: TileFiles): Promise<GeneratedTile> {
    const [x0, y0, x1, y1] = t.box;
    const data: TileData = { ...t, size: [x1 - x0, y1 - y0], origin: [-x0, -y0] };
    const geo = new Geo(data);
    const own = t.buildings.filter((b) => b.own);
    // The tile's paid-parking sections (clipped to it, with their share of spaces).
    const zones = new Zones({ sections: (t.sections || []).map((z) => ({ ...z, inside: z.share })) });
    if (t.drive && !this.driveBy.has(k)) {
      this.driveBy.set(k, this.drive.add(t.drive));
      this.walkBy.set(k, this.walk.add(t.walk!));
      this.onEdges(this.driveBy.get(k)!, this.walk.fresh);
    }
    const ms: Record<string, number> = {};
    let t0 = performance.now();
    const lap = (name: string): void => { const t1 = performance.now(); ms[name] = Math.round(t1 - t0); t0 = t1; };
    // Terrain first: everything in the tile stands on it.
    const terrain = this.index.terrain!;
    const shade = height ? relief(height, bare, t.box, terrain.n, terrain.step, this.ref) : null;
    const hAt = shade ? shade.sample : () => 0;
    const ground = shade ? { hm: shade.hm, box: t.box, n: terrain.n, step: terrain.step } : null;
    // Bridge decks, drawn above the ground; a tile's bridges without heights of their
    // own (too small to have any) lie on the ground.
    const deckHeights = deck ? { hm: decodeHeights(deck, terrain.n, this.ref), box: t.box, n: terrain.n, step: terrain.step } : null;
    const decks: GroundJobData['deck'] = this.decked ? deckHeights || {} : null;
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
      { pts, u: e.u, v: e.v, hw: e.hw, lanes: e.lanes, oneway: e.oneway, width: e.width, surface: e.surface, bridge: e.bridge })));
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
    const outlines = t.buildings.map((b) => ({ rings: b.rings }));
    const w = this.workers;
    const jobs = Promise.all([
      w.run('ground', {
        d: { areas: t.areas, roads: t.roads, rails: t.rails, weirs: t.weirs, crossings: t.crossings },
        box: [geo.minX, geo.minY, geo.maxX, geo.maxY] as Box, edges: clipped, buildings: own.map((b) => ({ rings: b.rings })), parkingZones, ground, deck: decks,
      }),
      w.run('land', {
        data: { size: data.size, origin: data.origin, areas: t.areas, roads: t.roads, buildings: outlines, walls: t.walls, trees: t.trees, rails: t.rails, passages: t.passages || [], decks: !!decks },
        seeds: seedArray, ground,
      }, [seedArray.buffer as ArrayBuffer]),
      withIpr ? w.run('ipr', { buffer: ipr as ArrayBuffer, box: t.box, absolute: this.index.iprRef != null, ground, bbox }, [ipr as ArrayBuffer]) : null,
      !withIpr || extrude.length ? w.run('roofs', { buildings: extrude, size: data.size, origin: data.origin, ground, bbox }) : null,
    ]);
    lap('send');
    const [{ layers, mask }, land, iprArrays, roofArrays] = await jobs;
    if (this.loaded.has(k)) return this.loaded.get(k)!;
    t0 = performance.now();

    const group = new THREE.Group();
    // Where the decks are: for drawing what's on them, and for getting about on them.
    let deckMask: { texture: THREE.DataTexture; box: Box } | null = null, tileDeck: GeneratedTile['deck'] = null;
    if (mask) {
      const texture = new THREE.DataTexture(mask.cells, mask.w, mask.h, THREE.RedFormat, THREE.UnsignedByteType);
      texture.unpackAlignment = 1;
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      deckMask = { texture, box: [x0, y1, x0 + mask.w / RES, y1 - mask.h / RES] };
      tileDeck = {
        grid: new Grid(geo, RES, null, mask.cells),
        sample: deckHeights ? heightSampler(deckHeights.hm, [t.box[0], t.box[1]], terrain.n, terrain.step) : () => NaN,
      };
    }
    const surfaces = new Surfaces(layers, { time: this.time, relief: shade, mask: deckMask });
    const buildings = [iprArrays, roofArrays].filter((arrays): arrays is BuildingArrays => arrays !== null).map(buildingMesh);
    const walls = wallMesh(land.walls);
    const trees = treeMesh(land.trees);
    group.add(surfaces.group, ...buildings, walls, trees);
    // Nothing in a tile ever moves: its matrices are worked out once, not every frame.
    group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    group.updateMatrixWorld(true);
    const grid = new Grid(geo, RES, null, land.cells);
    lap('meshes');

    const inside = (x: number, y: number): boolean => x >= x0 && x < x1 && y >= y0 && y < y1;
    const { cars } = parkCars({
      data, edges, zones, r: rng(Math.floor(hash(`${this.area}/${k}`) * 1e9)), night: this.night,
      shares: new Map((t.sections || []).map((s) => [s.code, s.share])), inside,
      // No parking inside passages.
      solid: (x: number, y: number) => (inside(x, y) ? grid.at(x, y) !== 0 || inPassage(t.passages || [], x, y, 1) : false),
    });
    lap('parking');
    this.scene.add(group);
    for (const c of cars) c.level = 0; // (nobody parks on a bridge)
    const tile = { k, i: t.i, j: t.j, box: t.box, passages: t.passages || [], group, surfaces, grid, deck: tileDeck, cars, ms, disposables: [...buildings, walls, trees], relief: shade, sample: shade?.sample };
    this.loaded.set(k, tile);
    this.byIndex.set(t.i * 65536 + t.j, tile);
    this.last.i = NaN;
    this.onCars(cars, tile);
    return tile;
  }

  drop(k: string): void {
    const t = this.loaded.get(k);
    if (!t) return;
    this.scene.remove(t.group);
    t.surfaces.dispose();
    t.relief?.texture.dispose();
    for (const m of t.disposables) { m.geometry.dispose(); (m.material as { dispose?: () => void }).dispose?.(); m.dispose?.(); }
    this.loaded.delete(k);
    this.byIndex.delete(t.i * 65536 + t.j);
    this.last.i = NaN;
    this.pending.delete(k);
    this.onDrop(t);
  }
}
