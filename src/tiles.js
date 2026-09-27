import * as THREE from 'three';
import { Geo, Grid, rng, hash } from './map/geo.js';
import { wallMesh } from './map/buildings.js';
import { treeMesh } from './map/vegetation.js';
import { Surfaces } from './surface.js';
import { shadeBuildings } from './shading.js';
import { loadFacadeAtlas } from './facades.js';
import { Zones, parkCars } from './parking.js';
import { decodeHeights, heightSampler, fetchBinary } from './terrain.js';

// Streams the map in square tiles (pipeline/build_tiles.py) around the camera. Each
// loaded tile has its own ground, buildings, trees, collision grid and parked cars;
// tiles far behind are dropped again. The street graphs stay global. The heavy part
// of building a tile runs in workers (tileWorker.js); the main thread fetches the
// tile's files, joins up the street graphs and makes the meshes and parked cars.

const RES = 2; // collision grid cells per metre

// A small pool of workers that build tiles (see tileWorker.js).
class TileWorkers {
  constructor(n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2))) {
    this.workers = [];
    this.jobs = new Map();
    this.next = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const job = this.jobs.get(e.data.id);
        this.jobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data.result);
      };
      this.workers.push(w);
    }
    this.size = n;
  }

  run(type, data, transfer = []) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.workers[id % this.workers.length].postMessage({ id, type, data }, transfer);
    });
  }
}

// Hill shading for a tile from its terrain heights (pipeline/ipr_terrain.py), lit from
// the same north-west as the sun: 128 = unchanged, darker on slopes facing away.
function relief(buffer, bareBuffer, box, n, step, ref) {
  // Heights in metres above `ref` (the game's y = 0), bilinear and clamped to the tile.
  const hm = decodeHeights(buffer, n, ref);
  // Hill shading uses the bare ground where bridges were raised (see ipr_terrain.py).
  const hs = new Uint16Array(bareBuffer || buffer);
  const L = [-110, 80, 190], ll = Math.hypot(...L);
  const lx = L[0] / ll, ly = L[1] / ll, lz = L[2] / ll;
  const px = new Uint8Array(n * n);
  const at = (i, j) => hs[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))] / 10;
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
  return { texture: tex, box: [x0, y0, x0 + (n - 1) * step, y0 + (n - 1) * step], sample: heightSampler(hm, box, n, step), hm };
}

const buildingMaterial = () => shadeBuildings(new THREE.MeshLambertMaterial({ vertexColors: true }));

// Buildings from a worker's arrays: IPR's or extruded from OSM footprints, with their
// facade coordinates (facades.js).
function buildingMesh(arrays) {
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
export function clipLine(pts, [x0, y0, x1, y1]) {
  const out = [];
  let cur = null;
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
    const a = [ax + dx * t0, ay + dy * t0], b = [ax + dx * t1, ay + dy * t1];
    if (!cur) cur = [a];
    cur.push(b);
    if (t1 < 1) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((l) => l.length > 1);
}

// Whether (x, y) is within `pad` metres of a passage through a building.
function inPassage(passages, x, y, pad = 0) {
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
  constructor({ area, index, scene, drive, walk, time, night, osmBuildings = false }) {
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
    this.grid = {
      res: RES,
      height: (x, y) => this.heightAt(x, y),
      at: (x, y) => {
        const t = this.tileAt(x, y);
        return t ? t.grid.at(x, y) : 255;
      },
    };
  }

  // The loaded tile at a point. Lookups come by the thousand every frame and mostly
  // in the tile of the one before, so that one is kept at hand.
  tileAt(x, y) {
    const i = Math.floor((x + this.ox) / this.T), j = Math.floor((y + this.oy) / this.T), last = this.last;
    if (i !== last.i || j !== last.j) {
      last.i = i;
      last.j = j;
      last.tile = this.byIndex.get(i * 65536 + j);
    }
    return last.tile;
  }

  // Terrain height (m above this.ref) at a point, 0 where nothing is loaded.
  heightAt(x, y) {
    const t = this.tileAt(x, y);
    return t?.sample ? t.sample(x, y) : 0;
  }

  // Whether (x, y) is in a passage through a building (under its upper floors).
  passageAt(x, y) {
    const t = this.tileAt(x, y);
    return !!t && inPassage(t.passages, x, y, 0.5);
  }

  keyAt(x, y) { return `${Math.floor((x + this.ox) / this.T)}_${Math.floor((y + this.oy) / this.T)}`; }

  // Tile keys within r metres of (x, y), nearest first.
  around(x, y, r) {
    const T = this.T, out = [];
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

  // All of a tile's files at once: its JSON, terrain heights (and the bare ground
  // where bridges were raised) and IPR's buildings.
  fetchTile(k) {
    if (!this.pending.has(k)) {
      const base = `data/${this.area}_now/tiles/${k}`, gz = !!this.index.gzip;
      const bin = (name) => fetchBinary(`${base}.${name}.bin${gz ? '.gz' : ''}`, gz);
      const json = fetch(`${base}.json`).then((r) => r.json());
      const height = this.index.terrain ? bin('height') : null;
      const bare = this.index.terrain && this.bare.has(k) ? bin('bare') : null;
      const known = this.iprTiles.get(k);
      const ipr = this.osmBuildings || known === false ? null : known ? bin('ipr') : json.then((t) => (t.ipr ? bin('ipr') : null));
      const files = Promise.all([json, height, bare, ipr]).then(([t, height, bare, ipr]) => ({ t, height, bare, ipr }));
      files.catch(() => { if (this.pending.get(k) === files) this.failed(k); });
      this.pending.set(k, files);
    }
    return this.pending.get(k);
  }

  // A tile whose files or build failed is fetched afresh, after a pause (a file that
  // keeps failing would otherwise be asked for every frame).
  failed(k) {
    this.pending.delete(k);
    this.retry.set(k, performance.now() + 2000);
  }

  // Load everything within r now (used at start); returns when done.
  async loadNow(x, y, r) {
    await Promise.all(this.around(x, y, r).map(async (k) => {
      if (!this.loaded.has(k)) await this.build(k, await this.fetchTile(k));
    }));
  }

  // Called every frame: starts building the nearest missing tiles, drops far ones.
  update(x, y, r) {
    const now = performance.now();
    const want = this.around(x, y, r).filter((k) => !(this.retry.get(k) > now));
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
  build(k, files) {
    if (this.loaded.has(k)) return Promise.resolve(this.loaded.get(k));
    if (!this.builds.has(k)) {
      const made = this.make(k, files)
        .catch((e) => { this.failed(k); throw e; })
        .finally(() => this.builds.delete(k));
      this.builds.set(k, made);
    }
    return this.builds.get(k);
  }

  async make(k, { t, height, bare, ipr }) {
    const [x0, y0, x1, y1] = t.box;
    const data = { ...t, size: [x1 - x0, y1 - y0], origin: [-x0, -y0] };
    const geo = new Geo(data);
    const own = t.buildings.filter((b) => b.own);
    // The tile's paid-parking sections (clipped to it, with their share of spaces).
    const zones = new Zones({ sections: (t.sections || []).map((z) => ({ ...z, inside: z.share })) });
    if (t.drive && !this.driveBy.has(k)) {
      this.driveBy.set(k, this.drive.add(t.drive));
      this.walkBy.set(k, this.walk.add(t.walk));
      this.onEdges(this.driveBy.get(k), this.walk.fresh);
    }
    const ms = {};
    let t0 = performance.now();
    const lap = (name) => { const t1 = performance.now(); ms[name] = Math.round(t1 - t0); t0 = t1; };
    // Terrain first: everything in the tile stands on it.
    const terrain = this.index.terrain;
    const shade = height ? relief(height, bare, t.box, terrain.n, terrain.step, this.ref) : null;
    const hAt = shade ? shade.sample : () => 0;
    const ground = shade ? { hm: shade.hm, box: t.box, n: terrain.n, step: terrain.step } : null;
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
      { pts, u: e.u, v: e.v, hw: e.hw, lanes: e.lanes, oneway: e.oneway, width: e.width, surface: e.surface })));
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
        box: [geo.minX, geo.minY, geo.maxX, geo.maxY], edges: clipped, buildings: own.map((b) => ({ rings: b.rings })), parkingZones, ground,
      }),
      w.run('land', {
        data: { size: data.size, origin: data.origin, areas: t.areas, roads: t.roads, buildings: outlines, walls: t.walls, trees: t.trees, passages: t.passages || [] },
        seeds: seedArray, ground,
      }, [seedArray.buffer]),
      withIpr ? w.run('ipr', { buffer: ipr, box: t.box, absolute: this.index.iprRef != null, ground, bbox }, [ipr]) : null,
      !withIpr || extrude.length ? w.run('roofs', { buildings: extrude, size: data.size, origin: data.origin, ground, bbox }) : null,
    ]);
    lap('send');
    const [layers, land, iprArrays, roofArrays] = await jobs;
    if (this.loaded.has(k)) return this.loaded.get(k);
    t0 = performance.now();

    const group = new THREE.Group();
    const surfaces = new Surfaces(layers, { time: this.time, relief: shade });
    const buildings = [iprArrays, roofArrays].filter(Boolean).map(buildingMesh);
    const walls = wallMesh(land.walls);
    const trees = treeMesh(land.trees);
    group.add(surfaces.group, ...buildings, walls, trees);
    // Nothing in a tile ever moves: its matrices are worked out once, not every frame.
    group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    group.updateMatrixWorld(true);
    const grid = new Grid(geo, RES, null, land.cells);
    lap('meshes');

    const inside = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const { cars } = parkCars({
      data, edges, zones, r: rng(Math.floor(hash(`${this.area}/${k}`) * 1e9)), night: this.night,
      shares: new Map(t.sections.map((s) => [s.code, s.share])), inside,
      // No parking inside passages.
      solid: (x, y) => (inside(x, y) ? grid.at(x, y) !== 0 || inPassage(t.passages || [], x, y, 1) : false),
    });
    lap('parking');
    this.scene.add(group);
    const tile = { k, i: t.i, j: t.j, box: t.box, passages: t.passages || [], group, surfaces, grid, cars, ms, disposables: [...buildings, walls, trees], relief: shade, sample: shade?.sample };
    this.loaded.set(k, tile);
    this.byIndex.set(t.i * 65536 + t.j, tile);
    this.last.i = NaN;
    this.onCars(cars, tile);
    return tile;
  }

  drop(k) {
    const t = this.loaded.get(k);
    if (!t) return;
    this.scene.remove(t.group);
    t.surfaces.dispose();
    t.relief?.texture.dispose();
    for (const m of t.disposables) { m.geometry.dispose(); m.material.dispose?.(); m.dispose?.(); }
    this.loaded.delete(k);
    this.byIndex.delete(t.i * 65536 + t.j);
    this.last.i = NaN;
    this.pending.delete(k);
    this.onDrop(t);
  }
}
