// The built map without a browser: tiles read from public/data, the real street graph,
// parking and traffic modules (transpiled on import), and a collision grid rasterised
// the way src/tileWorker.ts paints it. For the offline checks (check-parking-city,
// check-taxi-streets, check-bus-lines…): far cheaper than a headless game.
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
}});
globalThis.location ??= { search: '' };
globalThis.self ??= globalThis;
if (!globalThis.localStorage) Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {} }, configurable: true });
globalThis.ProgressEvent ??= class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };

export const network = await import('../src/network.ts');
export const trafficModule = await import('../src/traffic.ts');
export const carModule = await import('../src/car.ts');
export const parking = await import('../src/parking.ts');
export const clearance = await import('../src/parkingClearance.ts');
export const geo = await import('../src/map/geo.ts');
export const three = await import('three');
const figures = await import('../src/figures.ts');

// The shipped car and figure models, straight from public/.
export async function loadModels() {
  const model = (file) => 'data:model/gltf-binary;base64,' + readFileSync(new URL('../public/' + file, import.meta.url)).toString('base64');
  await carModule.loadCars(model('cars.glb'));
  carModule.useKit(await figures.loadKit(model('figures.glb')));
}

const RES = 2, RAISED = 3; // as in src/tiles.ts
const { DriveGraph, Polyline } = network;

function fillRings(cells, w, h, px, rings, value) {
  // Even-odd over the polygon's rings, sampled at cell centres.
  let v0 = Infinity, v1 = -Infinity;
  const pts = rings.map((ring) => ring.map(([x, y]) => px(x, y)));
  for (const ring of pts) for (const [, v] of ring) { v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  for (let j = Math.max(0, Math.floor(v0)); j <= Math.min(h - 1, Math.ceil(v1)); j++) {
    const y = j + 0.5, xs = [];
    for (const ring of pts) for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [ua, va] = ring[k], [ub, vb] = ring[i];
      if (va > y !== vb > y) xs.push(ua + ((y - va) * (ub - ua)) / (vb - va));
    }
    xs.sort((a, b) => a - b);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      for (let i = Math.max(0, Math.ceil(xs[n] - 0.5)); i <= Math.min(w - 1, Math.floor(xs[n + 1] - 0.5)); i++) cells[j * w + i] = value;
    }
  }
}

function strokeLine(cells, w, h, px, line, width, value) {
  const r = width / 2;
  for (let n = 1; n < line.length; n++) {
    const [ax, ay] = px(...line[n - 1]), [bx, by] = px(...line[n]);
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    for (let j = Math.max(0, Math.floor(Math.min(ay, by) - r)); j <= Math.min(h - 1, Math.ceil(Math.max(ay, by) + r)); j++) {
      for (let i = Math.max(0, Math.floor(Math.min(ax, bx) - r)); i <= Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r)); i++) {
        // A square cap: the stroke reaches half its width past each end.
        const u = ((i + 0.5 - ax) * dx + (j + 0.5 - ay) * dy) / len, v = Math.abs((i + 0.5 - ax) * dy - (j + 0.5 - ay) * dx) / len;
        if (u >= -r && u <= len + r && v <= r) cells[j * w + i] = value;
      }
    }
  }
}

export class City {
  constructor(area) {
    this.area = area;
    this.dir = new URL(`../public/data/${area}_now/`, import.meta.url);
    this.index = JSON.parse(readFileSync(new URL('index.json', this.dir), 'utf8'));
    this.T = this.index.tile;
    [this.ox, this.oy] = this.index.origin;
    this.available = new Set(this.index.tiles.map(([i, j]) => `${i}_${j}`));
    this.cache = new Map();
  }

  keys() { return [...this.available]; }
  keyAt(x, y) { return `${Math.floor((x + this.ox) / this.T)}_${Math.floor((y + this.oy) / this.T)}`; }

  // A tile's JSON without what the checks never read (the last few dozen are kept).
  tile(k) {
    let t = this.cache.get(k);
    if (t) return t;
    const file = new URL(`tiles/${k}.json`, this.dir);
    if (!this.available.has(k) || !existsSync(file)) return null;
    t = JSON.parse(readFileSync(file, 'utf8'));
    for (const name of ['ipr', 'trees', 'fences', 'marks', 'crossings', 'terraces']) delete t[name];
    this.cache.set(k, t);
    if (this.cache.size > 450) this.cache.delete(this.cache.keys().next().value);
    return t;
  }

  halo(k) {
    const [i, j] = k.split('_').map(Number), out = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const t = this.tile(`${i + di}_${j + dj}`);
      if (t) out.push(t);
    }
    return out;
  }

  // The street graph of a set of tiles (all of them by default), as the game joins it.
  graph(keys = this.keys()) {
    const g = new DriveGraph();
    for (const k of keys) g.add(this.tile(k)?.drive || []);
    return g;
  }

  // The collision grid of a tile, as tileGrid paints it (trees and furniture left out):
  // 0 free, 255 solid, 254 walled in.
  grid(t) {
    const [x0, y0, x1, y1] = t.box, W = x1 - x0, H = y1 - y0;
    const w = Math.ceil(W * RES), h = Math.ceil(H * RES), cells = new Uint8Array(w * h);
    const px = (x, y) => [(x - x0) * RES, (H - (y - y0)) * RES];
    for (const rings of t.areas.water || []) fillRings(cells, w, h, px, rings, 255);
    for (const wall of t.walls || []) strokeLine(cells, w, h, px, wall.pts, 0.9 * RES, 255);
    const leveled = (t.structures || []).length > 0 && !!this.index.terrain;
    if (!leveled) for (const rings of [...(t.areas.bridge || []), ...(t.roads.bridge || [])]) fillRings(cells, w, h, px, rings, 0);
    for (const b of t.buildings) if (!((b.minh ?? 0) >= RAISED)) fillRings(cells, w, h, px, b.rings, 255);
    for (const p of t.passages || []) strokeLine(cells, w, h, px, p.pts, p.w * RES, 0);
    const seen = new Uint8Array(cells.length), stack = [];
    const visit = (n) => { if (!cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); } };
    for (const e of [...(t.drive || []), ...(t.walk || [])]) for (let n = 1; n < e.pts.length; n++) {
      const [ax, ay] = e.pts[n - 1], [bx, by] = e.pts[n], steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 3);
      for (let s = 0; s <= steps; s++) {
        const [u, v] = px(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps), i = Math.floor(u), j = Math.floor(v);
        if (i >= 0 && j >= 0 && i < w && j < h) visit(j * w + i);
      }
    }
    while (stack.length) {
      const k = stack.pop(), x = k % w;
      if (x > 0) visit(k - 1);
      if (x < w - 1) visit(k + 1);
      if (k >= w) visit(k - w);
      if (k + w < cells.length) visit(k + w);
    }
    for (let i = 0; i < cells.length; i++) if (!cells[i] && !seen[i]) cells[i] = 254;
    return {
      cells, w, h,
      at: (x, y) => {
        const i = Math.floor((x - x0) * RES), j = Math.floor((H - (y - y0)) * RES);
        return i < 0 || j < 0 || i >= w || j >= h ? 255 : cells[j * w + i];
      },
    };
  }

  // The tile's parked cars, placed as TileWorld.make places them: the same streets round
  // it for clearance, the same buildings for how full the kerb is, the same seed.
  park(k, { night = false } = {}) {
    const t = this.tile(k);
    if (!t) return null;
    const around = this.halo(k);
    const halo = new DriveGraph();
    halo.add(around.flatMap((tile) => tile.drive || []).sort((a, b) => a.id.localeCompare(b.id)));
    const own = new DriveGraph(), edges = own.add(t.drive || []);
    const [x0, y0, x1, y1] = t.box;
    const inside = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const grid = this.grid(t);
    const passages = t.passages || [];
    const inPassage = (x, y, pad) => passages.some((p) => p.pts.some((a, i) => i > 0 && network.segDist(x, y, p.pts[i - 1], a) < p.w / 2 + pad));
    const buildings = around.flatMap((tile) => tile.buildings.filter((b) => (b.minh ?? 0) < RAISED).map((b) => ({ id: b.id, rings: b.rings, kind: b.kind, h: b.h })));
    const { cars } = parking.parkCars({
      data: { ...t, size: [x1 - x0, y1 - y0], origin: [-x0, -y0] }, edges, clearanceEdges: halo.edges,
      zones: new parking.Zones({ sections: (t.sections || []).map((z) => ({ ...z, inside: z.share })) }),
      buildings, r: geo.rng(Math.floor(geo.hash(`${this.area}/${k}`) * 1e9)), night,
      shares: new Map((t.sections || []).map((s) => [s.code, s.share])), inside,
      solid: (x, y) => (inside(x, y) ? grid.at(x, y) !== 0 || inPassage(x, y, 1) : false),
    });
    return { t, cars, edges, halo: halo.edges, grid };
  }
}

// Drive-graph edges by 50 m cell, for edgesNear without the game's tiles.
export function edgeIndex(edges, cell = 50) {
  const map = new Map();
  for (const e of edges) {
    const seen = new Set();
    for (const [x, y] of e.pts) {
      const k = Math.floor(x / cell) * 131072 + Math.floor(y / cell);
      if (seen.has(k)) continue;
      seen.add(k);
      let list = map.get(k);
      if (!list) map.set(k, list = []);
      list.push(e);
    }
  }
  return (x, y, r) => {
    const out = new Set();
    for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) for (let j = Math.floor((y - r) / cell); j <= Math.floor((y + r) / cell); j++) {
      for (const e of map.get(i * 131072 + j) || []) out.add(e);
    }
    return [...out];
  };
}

// What Traffic.update is given by main.ts: a circle for each of a car's collision circles.
export function obstacleIndex(cars) {
  const hash = new network.SpatialHash(10);
  return {
    rebuild(moving = []) {
      hash.clear();
      for (const c of [...cars, ...moving]) for (const [x, y] of c.circles()) hash.add({ x, y, z: c.gz, r: c.r, vx: c.vx, vy: c.vy, kind: 'car', car: c });
    },
    near: (x, y, r) => hash.near(x, y, r + 3),
  };
}

export { Polyline };
