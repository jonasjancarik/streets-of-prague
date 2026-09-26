import * as THREE from 'three';
import { Geo, Grid, fillPolys, strokeLines, rng, hash } from '../geo.js';
import { buildWalls } from '../buildings.js';
import { buildTrees } from '../vegetation.js';
import { Surfaces } from './surface.js';
import { shadeBuildings } from './shading.js';
import { parkCars } from './parking.js';

// Streams the map in square tiles (pipeline/build_tiles.py) around the camera. Each
// loaded tile has its own ground, buildings, trees, collision grid and parked cars;
// tiles far behind are dropped again. The street graphs stay global.

const RES = 2; // collision grid cells per metre

// A small pool of workers that build building meshes (see roofWorker.js).
class RoofBuilders {
  constructor(n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2))) {
    this.workers = [];
    this.jobs = new Map();
    this.next = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./roofWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const job = this.jobs.get(e.data.id);
        this.jobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data.arrays);
      };
      this.workers.push(w);
    }
    this.size = n;
  }

  build(data) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.workers[id % this.workers.length].postMessage({ id, data });
    });
  }
}

const buildingMaterial = () => shadeBuildings(new THREE.MeshLambertMaterial({ vertexColors: true }));

function buildingMesh(arrays) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(arrays.color, 3));
  g.setAttribute('drapeUv', new THREE.BufferAttribute(arrays.drapeUv, 2));
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

// Edges of a graph bucketed by the tiles their bounding boxes touch.
function bucket(edges, index) {
  const map = new Map();
  const { tile: T } = index, [ox, oy] = index.origin;
  for (const e of edges) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of e.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    for (let i = Math.floor((x0 + ox) / T); i <= Math.floor((x1 + ox) / T); i++) {
      for (let j = Math.floor((y0 + oy) / T); j <= Math.floor((y1 + oy) / T); j++) {
        const k = `${i}_${j}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(e);
      }
    }
  }
  return map;
}

// Walkable/drivable cells: 0 free, 255 solid, 254 free but walled in (a closed
// courtyard). Only cells reachable from the street network count as free.
function tileGrid(geo, t, seeds) {
  const grid = new Grid(geo, RES, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';
    if (t.areas.water) fillPolys(ctx, geo, t.areas.water, s);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.9 * s;
    strokeLines(ctx, geo, t.walls.map((w) => w.pts), s);
    ctx.fillStyle = '#000';
    fillPolys(ctx, geo, [...(t.areas.bridge || []), ...(t.roads.bridge || [])], s);
    ctx.fillStyle = '#fff';
    fillPolys(ctx, geo, t.buildings.map((b) => b.rings), s);
  });
  const { w, h, cells } = grid;
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i] > 100 ? 255 : 0;
  const seen = new Uint8Array(cells.length), stack = [];
  for (const [x, y] of seeds) {
    const [u, v] = geo.px(x, y, RES);
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const k = j * w + i;
    if (!cells[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
  }
  while (stack.length) {
    const k = stack.pop(), x = k % w;
    for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, k - w, k + w]) {
      if (n >= 0 && n < cells.length && !cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
  }
  for (let i = 0; i < cells.length; i++) if (!cells[i] && !seen[i]) cells[i] = 254;
  return grid;
}

function stampTrunks(grid, geo, trees) {
  const m = new THREE.Matrix4();
  for (let i = 0; i < trees.count; i++) {
    trees.getMatrixAt(i, m);
    const x = m.elements[12], y = -m.elements[14];
    const rad = 0.35 + Math.hypot(m.elements[0], m.elements[1], m.elements[2]) * 0.06;
    const [u, v] = geo.px(x, y, RES);
    const R = Math.ceil(rad * RES);
    for (let j = -R; j <= R; j++) {
      for (let k = -R; k <= R; k++) {
        if (Math.hypot(j, k) > rad * RES) continue;
        const cu = Math.floor(u) + k, cv = Math.floor(v) + j;
        if (cu >= 0 && cv >= 0 && cu < grid.w && cv < grid.h) grid.cells[cv * grid.w + cu] = 255;
      }
    }
  }
}

export class TileWorld {
  constructor({ area, index, scene, drive, walk, zones, time, night }) {
    this.area = area;
    this.index = index;
    this.scene = scene;
    this.zones = zones;
    this.time = time;
    this.night = night;
    this.T = index.tile;
    [this.ox, this.oy] = index.origin;
    this.available = new Set(index.tiles.map(([i, j]) => `${i}_${j}`));
    this.loaded = new Map(); // key → tile
    this.pending = new Map(); // key → Promise of tile JSON
    this.driveBy = bucket(drive.edges, index);
    this.walkBy = bucket(walk.edges, index);
    this.onCars = () => {};
    this.onDrop = () => {};
    this.building = 0;
    this.roofs = new RoofBuilders();
    // Collision lookups across tiles; anywhere not loaded counts as solid.
    this.grid = {
      res: RES,
      at: (x, y) => {
        const t = this.loaded.get(this.keyAt(x, y));
        return t ? t.grid.at(x, y) : 255;
      },
    };
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

  fetchTile(k) {
    if (!this.pending.has(k)) {
      this.pending.set(k, fetch(`data/${this.area}_now/tiles/${k}.json`).then((r) => r.json()));
    }
    return this.pending.get(k);
  }

  // Load everything within r now (used at start); returns when done.
  async loadNow(x, y, r) {
    await Promise.all(this.around(x, y, r).map(async (k) => {
      if (!this.loaded.has(k)) await this.build(k, await this.fetchTile(k));
    }));
  }

  // Called every frame: builds at most one tile, drops far ones.
  update(x, y, r) {
    const want = this.around(x, y, r);
    for (const k of want.slice(0, 12)) this.fetchTile(k);
    // One build per worker at a time; the main thread only assembles the result.
    this.inFlight ||= new Set();
    while (this.building < this.roofs.size) {
      const next = want.find((k) => !this.loaded.has(k) && !this.inFlight.has(k));
      if (!next) break;
      this.building++;
      this.inFlight.add(next);
      this.fetchTile(next).then((t) => this.build(next, t)).catch((e) => console.error(e)).finally(() => {
        this.building--;
        this.inFlight.delete(next);
      });
    }
    const keep = new Set(this.around(x, y, r + this.T * 1.5));
    for (const k of [...this.loaded.keys()]) if (!keep.has(k)) this.drop(k);
  }

  async build(k, t) {
    if (this.loaded.has(k)) return this.loaded.get(k);
    const [x0, y0, x1, y1] = t.box;
    const data = { ...t, size: [x1 - x0, y1 - y0], origin: [-x0, -y0] };
    const geo = new Geo(data);
    const own = t.buildings.filter((b) => b.own);
    const ms = {};
    let t0 = performance.now();
    const lap = (name) => { const t1 = performance.now(); ms[name] = Math.round(t1 - t0); t0 = t1; };
    const arrays = await this.roofs.build({ buildings: own, size: data.size, origin: data.origin });
    if (this.loaded.has(k)) return this.loaded.get(k);
    lap('roofs (worker)');
    // Spread the main-thread work over several frames.
    const breathe = () => new Promise((r) => setTimeout(r, 0));
    const group = new THREE.Group();

    const edges = this.driveBy.get(k) || [];
    const clipped = edges.flatMap((e) => clipLine(e.pts, t.box).map((pts) => ({ ...e, pts })));
    const surfaces = new Surfaces(geo, { edges: clipped, buildings: own, zones: this.zones, time: this.time });
    group.add(surfaces.group);
    lap('ground');
    await breathe();

    const buildings = buildingMesh(arrays);
    const walls = buildWalls(data);
    lap('buildings');
    const trees = buildTrees(geo).mesh;
    group.add(buildings, walls, trees);
    lap('trees');
    await breathe();

    // Seeds for the collision grid: points along every street and path in the tile.
    const seeds = [];
    for (const e of [...edges, ...(this.walkBy.get(k) || [])]) {
      for (const pts of clipLine(e.pts, t.box)) {
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) / 3);
          for (let s = 0; s <= n; s++) seeds.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
        }
      }
    }
    const grid = tileGrid(geo, data, seeds);
    stampTrunks(grid, geo, trees);
    lap('grid');
    await breathe();

    const inside = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const { cars } = parkCars({
      data, edges, zones: this.zones, r: rng(Math.floor(hash(`${this.area}/${k}`) * 1e9)), night: this.night,
      shares: new Map(t.sections.map((s) => [s.code, s.share])), inside,
      solid: (x, y) => (inside(x, y) ? grid.at(x, y) !== 0 : false),
    });

    lap('parking');
    if (this.loaded.has(k)) { surfaces.dispose(); return this.loaded.get(k); }
    this.scene.add(group);
    const tile = { k, box: t.box, group, surfaces, grid, cars, ms, disposables: [buildings, walls, trees] };
    this.loaded.set(k, tile);
    this.onCars(cars, tile);
    return tile;
  }

  drop(k) {
    const t = this.loaded.get(k);
    if (!t) return;
    this.scene.remove(t.group);
    t.surfaces.dispose();
    for (const m of t.disposables) { m.geometry.dispose(); m.material.dispose?.(); }
    this.loaded.delete(k);
    this.pending.delete(k);
    this.onDrop(t);
  }
}
