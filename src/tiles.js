import * as THREE from 'three';
import { Geo, Grid, fillPolys, strokeLines, rng, hash } from '../geo.js';
import { buildWalls } from '../buildings.js';
import { buildTrees } from '../vegetation.js';
import { Surfaces } from './surface.js';
import { shadeBuildings } from './shading.js';
import { Zones, parkCars } from './parking.js';

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

// IPR Praha's 3D buildings for a tile (pipeline/ipr_buildings.py): triangles with
// positions in centimetres from the tile corner and a colour per triangle.
async function iprMesh(url, [x0, y0], absolute) {
  const buf = await (await fetch(url)).arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  const p16 = new Int16Array(buf, 8, n * 9);
  const colAt = 8 + n * 18 + ((4 - ((8 + n * 18) % 4)) % 4);
  const c8 = new Uint8Array(buf, colAt, n * 3);
  const pos = new Float32Array(n * 9), col = new Float32Array(n * 9);
  const c = new THREE.Color();
  for (let t = 0; t < n; t++) {
    c.setRGB(c8[t * 3] / 255, c8[t * 3 + 1] / 255, c8[t * 3 + 2] / 255, THREE.SRGBColorSpace);
    for (let v = 0; v < 3; v++) {
      const i = t * 9 + v * 3;
      const h = p16[i + 1] / 100;
      pos[i] = x0 + p16[i] / 100;
      pos[i + 1] = h;
      pos[i + 2] = -(y0 + p16[i + 2] / 100);
      const k = absolute ? 1 : 0.62 + 0.38 * Math.min(1, h / 6); // older data: darker towards the street
      col[i] = c.r * k; col[i + 1] = c.g * k; col[i + 2] = c.b * k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, buildingMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Hill shading for a tile from its terrain heights (pipeline/ipr_terrain.py), lit from
// the same north-west as the sun: 128 = unchanged, darker on slopes facing away.
async function relief(url, box, n, step, ref, bareUrl = null) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const h = new Uint16Array(await res.arrayBuffer());
  // Hill shading uses the bare ground where bridges were raised (see ipr_terrain.py).
  const bareRes = bareUrl ? await fetch(bareUrl) : null;
  const hs = bareRes?.ok ? new Uint16Array(await bareRes.arrayBuffer()) : h;
  // Heights in metres above `ref` (the game's y = 0), bilinear and clamped to the tile.
  const hm = new Float32Array(n * n);
  for (let i = 0; i < hm.length; i++) hm[i] = h[i] / 10 + 100 - ref;
  const [bx, by] = box;
  const sample = (x, y) => {
    const u = Math.min(n - 1.001, Math.max(0, (x - bx) / step)), v = Math.min(n - 1.001, Math.max(0, (y - by) / step));
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const a = hm[j * n + i], b = hm[j * n + i + 1], c = hm[(j + 1) * n + i], d = hm[(j + 1) * n + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  };
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
  return { texture: tex, box: [x0, y0, x0 + (n - 1) * step, y0 + (n - 1) * step], sample };
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
  constructor({ area, index, scene, drive, walk, zones, time, night, osmBuildings = false }) {
    this.osmBuildings = osmBuildings;
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
    this.drive = drive;
    this.walk = walk;
    // Tiles built with their own street graphs join them up as they load; older
    // areas come with one graph for the whole area.
    this.driveBy = index.graphs ? new Map() : bucket(drive.edges, index);
    this.walkBy = index.graphs ? new Map() : bucket(walk.edges, index);
    this.onEdges = () => {};
    this.onCars = () => {};
    this.onDrop = () => {};
    this.building = 0;
    this.roofs = new RoofBuilders();
    // Collision lookups across tiles; anywhere not loaded counts as solid.
    // Game y = 0 is this height above sea level (IPR buildings are stored against it).
    this.ref = index.iprRef ?? 180;
    this.grid = {
      res: RES,
      height: (x, y) => this.heightAt(x, y),
      at: (x, y) => {
        const t = this.loaded.get(this.keyAt(x, y));
        return t ? t.grid.at(x, y) : 255;
      },
    };
  }

  // Terrain height (m above this.ref) at a point, 0 where nothing is loaded.
  heightAt(x, y) {
    const t = this.loaded.get(this.keyAt(x, y));
    return t?.sample ? t.sample(x, y) : 0;
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
    // Newer tiles carry their own paid-parking sections; older ones use the area's.
    const zones = t.sections?.[0]?.polys ? new Zones({ sections: t.sections.map((z) => ({ ...z, inside: z.share })) }) : this.zones;
    if (t.drive && !this.driveBy.has(k)) {
      this.driveBy.set(k, this.drive.add(t.drive));
      this.walkBy.set(k, this.walk.add(t.walk));
      this.onEdges(this.driveBy.get(k), this.walk.fresh);
    }
    const ms = {};
    let t0 = performance.now();
    const lap = (name) => { const t1 = performance.now(); ms[name] = Math.round(t1 - t0); t0 = t1; };
    // Terrain first: everything in the tile stands on it.
    const shade = this.index.terrain
      ? await relief(`data/${this.area}_now/tiles/${k}.height.bin`, t.box, this.index.terrain.n, this.index.terrain.step, this.ref,
        this.index.terrain.bare?.includes(k) ? `data/${this.area}_now/tiles/${k}.bare.bin` : null)
      : null;
    const hAt = shade ? shade.sample : () => 0;
    // Real 3D buildings from IPR where the area has them (unless ?osm), else OSM
    // footprints extruded with straight-skeleton roofs in a worker, each set on the
    // lowest ground under its footprint.
    const onGround = own.map((b) => ({ ...b, base: Math.min(...b.rings[0].map(([x, y]) => hAt(x, y))) }));
    const buildings = t.ipr && !this.osmBuildings
      ? await iprMesh(`data/${this.area}_now/tiles/${k}.ipr.bin`, t.box, this.index.iprRef != null)
      : buildingMesh(await this.roofs.build({ buildings: onGround, size: data.size, origin: data.origin }));
    if (this.loaded.has(k)) return this.loaded.get(k);
    lap('buildings');
    // Spread the main-thread work over several frames.
    const breathe = () => new Promise((r) => setTimeout(r, 0));
    const group = new THREE.Group();

    const edges = this.driveBy.get(k) || [];
    const clipped = edges.flatMap((e) => clipLine(e.pts, t.box).map((pts) => ({ ...e, pts })));
    const surfaces = new Surfaces(geo, { edges: clipped, buildings: own, zones, time: this.time, relief: shade, height: shade ? hAt : null });
    group.add(surfaces.group);
    lap('ground');
    await breathe();

    const walls = buildWalls(data);
    const wp = walls.geometry.attributes.position;
    for (let i = 0; i < wp.count; i++) wp.setY(i, wp.getY(i) + hAt(wp.getX(i), -wp.getZ(i)));
    lap('walls');
    const trees = buildTrees(geo).mesh;
    {
      const m = new THREE.Matrix4();
      for (let i = 0; i < trees.count; i++) {
        trees.getMatrixAt(i, m);
        m.elements[13] += hAt(m.elements[12], -m.elements[14]);
        trees.setMatrixAt(i, m);
      }
      trees.instanceMatrix.needsUpdate = true;
    }
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
      data, edges, zones, r: rng(Math.floor(hash(`${this.area}/${k}`) * 1e9)), night: this.night,
      shares: new Map(t.sections.map((s) => [s.code, s.share])), inside,
      solid: (x, y) => (inside(x, y) ? grid.at(x, y) !== 0 : false),
    });

    lap('parking');
    if (this.loaded.has(k)) { surfaces.dispose(); return this.loaded.get(k); }
    this.scene.add(group);
    const tile = { k, box: t.box, group, surfaces, grid, cars, ms, disposables: [buildings, walls, trees], relief: shade, sample: shade?.sample };
    this.loaded.set(k, tile);
    this.onCars(cars, tile);
    return tile;
  }

  drop(k) {
    const t = this.loaded.get(k);
    if (!t) return;
    this.scene.remove(t.group);
    t.surfaces.dispose();
    t.relief?.texture.dispose();
    for (const m of t.disposables) { m.geometry.dispose(); m.material.dispose?.(); }
    this.loaded.delete(k);
    this.pending.delete(k);
    this.onDrop(t);
  }
}
