// Builds a tile off the main thread, which then only turns the arrays into meshes:
//   roofs   OSM buildings extruded with straight-skeleton roofs (by far the slowest
//           part of a tile, up to a second or so), with their facade coordinates
//   ipr     IPR's 3D buildings unpacked from the tile's .ipr.bin, with normals and
//           facade coordinates
//   ground  the ground's layers (ground.ts), the bridges above it and the tunnels below
//   land    trees, walls and the collision grid
// Everything stands on the tile's terrain, sampled from the heights sent along.
import * as THREE from 'three';
import { initRoofs, buildBuildings, wallArrays } from './map/buildings.ts';
import { treeInstances } from './map/vegetation.ts';
import { Geo, Grid, fillPolys, strokeLines } from './map/geo.ts';
import { styleFor, facadeCoords } from './facades.ts';
import { groundLayers, layerBuffers } from './ground.ts';
import { heightSampler } from './terrain.ts';
import type { Bounds, Point2 } from './map/geo.ts';
import type { HeightGrid, BuildingArrays, LandResult, WorkerJobs, WorkerRequest, WorkerResponse } from './contracts.ts';

type LandData = WorkerJobs['land']['data'];
type StyleAt = (x: number, y: number, height: number) => number;

const RES = 2; // collision grid cells per metre

let roofsReady: Promise<void> | null = null;
let styles: StyleAt | null = null, stylesOf = '';
// A facade's style by where it is and how tall (facades.ts), for this area.
const styleAt = (bbox: Bounds): StyleAt => {
  if (stylesOf !== bbox.join()) { styles = styleFor({ bbox_wgs84: bbox }); stylesOf = bbox.join(); }
  if (!styles) throw new Error('Facade styles are unavailable');
  return styles;
};
const groundAt = (g: HeightGrid | null) => (g ? heightSampler(g.hm, g.box, g.n, g.step) : () => 0);

async function roofs({ buildings, size, origin, ground, bbox }: WorkerJobs['roofs']): Promise<BuildingArrays> {
  await (roofsReady ??= initRoofs());
  const hAt = groundAt(ground);
  // One building at a time, each lifted onto its own ground height (`base`).
  const keys = ['position', 'normal', 'color', 'drapeUv'] as const;
  const parts: Record<(typeof keys)[number], Float32Array[]> = { position: [], normal: [], color: [], drapeUv: [] };
  for (const b of buildings) {
    const g = buildBuildings({ size, origin, buildings: [b] }).mesh.geometry;
    const pos = g.attributes.position.array as Float32Array;
    for (let i = 1; i < pos.length; i += 3) pos[i] += b.base || 0;
    for (const k of keys) parts[k].push(g.attributes[k].array as Float32Array);
  }
  const arrays: Record<(typeof keys)[number], Float32Array> = { position: new Float32Array(0), normal: new Float32Array(0), color: new Float32Array(0), drapeUv: new Float32Array(0) };
  for (const k of keys) {
    const n = parts[k].reduce((a, x) => a + x.length, 0);
    arrays[k] = new Float32Array(n);
    let o = 0;
    for (const x of parts[k]) { arrays[k].set(x, o); o += x.length; }
  }
  return { ...arrays, facade: facadeCoords(arrays.position, hAt, styleAt(bbox)) };
}

// Whether (x, y) is inside a polygon (outer ring, then holes).
function inPolygon(x: number, y: number, rings: Point2[][]) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// IPR Praha's 3D buildings for a tile (pipeline/ipr_buildings.py): triangles with
// positions in centimetres from the tile corner and a colour per triangle. Those in a
// landmark's footprint (`hide`) are left out: the landmark stands there instead.
function ipr({ buffer, box: [x0, y0], absolute, ground, bbox, hide }: WorkerJobs['ipr']): BuildingArrays {
  const all = new DataView(buffer).getUint32(0, true);
  const p16 = new Int16Array(buffer, 8, all * 9);
  const colAt = 8 + all * 18 + ((4 - ((8 + all * 18) % 4)) % 4);
  const c8 = new Uint8Array(buffer, colAt, all * 3);
  const kept: number[] = [];
  for (let t = 0; t < all; t++) {
    const x = x0 + (p16[t * 9] + p16[t * 9 + 3] + p16[t * 9 + 6]) / 300, y = y0 + (p16[t * 9 + 2] + p16[t * 9 + 5] + p16[t * 9 + 8]) / 300;
    if (!hide.some((rings) => inPolygon(x, y, rings))) kept.push(t);
  }
  const n = kept.length;
  const pos = new Float32Array(n * 9), col = new Float32Array(n * 9);
  const c = new THREE.Color();
  for (let o = 0; o < n; o++) {
    const t = kept[o];
    c.setRGB(c8[t * 3] / 255, c8[t * 3 + 1] / 255, c8[t * 3 + 2] / 255, THREE.SRGBColorSpace);
    for (let v = 0; v < 3; v++) {
      const s = t * 9 + v * 3, i = o * 9 + v * 3;
      const h = p16[s + 1] / 100;
      pos[i] = x0 + p16[s] / 100;
      pos[i + 1] = h;
      pos[i + 2] = -(y0 + p16[s + 2] / 100);
      const k = absolute ? 1 : 0.62 + 0.38 * Math.min(1, h / 6); // older data: darker towards the street
      col[i] = c.r * k; col[i + 1] = c.g * k; col[i + 2] = c.b * k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return { position: pos, color: col, normal: g.attributes.normal.array as Float32Array, facade: facadeCoords(pos, groundAt(ground), styleAt(bbox)) };
}

// Walkable/drivable cells: 0 free, 255 solid, 254 free but walled in (a closed
// courtyard). Only cells reachable from the street network (`seeds`: x, y pairs
// along every street and path in the tile) count as free.
function tileGrid(geo: Geo<LandData>, t: LandData, seeds: Float64Array) {
  const grid = new Grid(geo, RES, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';
    if (t.areas.water) fillPolys(ctx, geo, t.areas.water, s);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.9 * s;
    strokeLines(ctx, geo, t.walls.map((w) => w.pts), s);
    // Bridges are open ground, unless they have levels of their own (see tiles.ts):
    // then the ground under them stays as it is (a river, or a street under a flyover).
    if (!t.levels) {
      ctx.fillStyle = '#000';
      fillPolys(ctx, geo, [...(t.areas.bridge || []), ...(t.roads.bridge || [])], s);
    }
    ctx.fillStyle = '#fff';
    fillPolys(ctx, geo, t.buildings.map((b) => b.rings), s);
    // Gateways and passages through buildings stay open, a little past both ends
    // (mapped passages often stop just short of the building's edge).
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'square';
    for (const p of t.passages) {
      ctx.lineWidth = p.w * s;
      strokeLines(ctx, geo, [p.pts], s);
    }
  });
  const { w, h, cells } = grid;
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i] > 100 ? 255 : 0;
  const seen = new Uint8Array(cells.length), stack: number[] = [];
  for (let s = 0; s < seeds.length; s += 2) {
    const [u, v] = geo.px(seeds[s], seeds[s + 1], RES);
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const k = j * w + i;
    if (!cells[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
  }
  const visit = (n: number) => { if (!cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); } };
  while (stack.length) {
    const k = stack.pop()!, x = k % w;
    if (x > 0) visit(k - 1);
    if (x < w - 1) visit(k + 1);
    if (k >= w) visit(k - w);
    if (k + w < cells.length) visit(k + w);
  }
  for (let i = 0; i < cells.length; i++) if (!cells[i] && !seen[i]) cells[i] = 254;
  return grid;
}

// Tree trunks are solid.
function stampTrunks(grid: Grid, geo: Geo<LandData>, { matrices, count }: LandResult['trees']) {
  for (let i = 0; i < count; i++) {
    const e = matrices.subarray(i * 16, i * 16 + 16);
    const x = e[12], y = -e[14];
    const rad = 0.35 + Math.hypot(e[0], e[1], e[2]) * 0.06;
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

function land({ data, seeds, ground, bridges }: WorkerJobs['land']): LandResult {
  const geo = new Geo(data), hAt = groundAt(ground);
  // How much room a tree has under the bridges (Infinity where there's none over it).
  const decks = bridges.map((b) => groundAt(b));
  const room = (x: number, y: number) => {
    let r = Infinity;
    for (const d of decks) {
      const h = d(x, y) - hAt(x, y);
      if (h > 0) r = Math.min(r, h);
    }
    return r;
  };
  const trees = treeInstances(geo, hAt, room);
  const walls = wallArrays(data, hAt);
  const grid = tileGrid(geo, data, seeds);
  stampTrunks(grid, geo, trees);
  return { trees, walls, cells: grid.cells };
}

function isRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return typeof message.id === 'number' && ['roofs', 'ipr', 'ground', 'land'].includes(String(message.type))
    && typeof message.data === 'object' && message.data !== null;
}

function transferBuffers(arrays: BuildingArrays): ArrayBuffer[] {
  const buffers = Object.values(arrays).map((array) => array.buffer);
  if (buffers.some((buffer) => !(buffer instanceof ArrayBuffer))) throw new Error('Building transfer requires ArrayBuffer storage');
  return buffers as ArrayBuffer[];
}

const worker = self as DedicatedWorkerGlobalScope;
worker.onmessage = async (event: MessageEvent<unknown>) => {
  if (!isRequest(event.data)) {
    const id = typeof event.data === 'object' && event.data !== null && 'id' in event.data ? event.data.id : null;
    if (typeof id === 'number') worker.postMessage({ id, error: 'Unknown tile job' } satisfies WorkerResponse);
    return;
  }
  const { id } = event.data;
  try {
    switch (event.data.type) {
      case 'roofs': {
        const result = await roofs(event.data.data);
        worker.postMessage({ id, result } satisfies WorkerResponse, transferBuffers(result));
        break;
      }
      case 'ipr': {
        const result = ipr(event.data.data);
        worker.postMessage({ id, result } satisfies WorkerResponse, transferBuffers(result));
        break;
      }
      case 'ground': {
        const { d, ground, levels, ...opts } = event.data.data;
        const result = groundLayers(d, {
          ...opts, height: ground ? groundAt(ground) : null,
          levels: levels ? levels.map((l) => ({ level: l.level, kind: l.kind, polys: l.polys, height: groundAt(l.heights) })) : null,
        });
        worker.postMessage({ id, result } satisfies WorkerResponse, layerBuffers(result));
        break;
      }
      case 'land': {
        const result = land(event.data.data);
        const buffers = [result.trees.matrices.buffer, result.trees.colours.buffer, result.trees.evergreen.buffer, result.walls.position.buffer, result.walls.normal.buffer, result.cells.buffer];
        if (buffers.some((buffer) => !(buffer instanceof ArrayBuffer))) throw new Error('Land transfer requires ArrayBuffer storage');
        worker.postMessage({ id, result } satisfies WorkerResponse, buffers as ArrayBuffer[]);
        break;
      }
    }
  } catch (err) {
    worker.postMessage({ id, error: String(err instanceof Error ? err.stack || err.message : err) } satisfies WorkerResponse);
  }
};
