// Builds a tile off the main thread, which then only turns the arrays into meshes:
//   roofs   OSM buildings extruded with straight-skeleton roofs (by far the slowest
//           part of a tile, up to a second or so), with their facade coordinates
//   ipr     IPR's 3D buildings unpacked from the tile's .ipr.bin, with normals and
//           facade coordinates
//   ground  the ground's layers (ground.ts), the bridges above it and the tunnels below
//   land    trees, walls, the collision grid, and where the bridges and tunnels are
// Everything stands on the tile's terrain, sampled from the heights sent along.
import * as THREE from 'three';
import { initRoofs, buildBuildings, wallArrays } from './map/buildings.ts';
import { planDetails, partArrays } from './map/roofDetails.ts';
import type { DetailArrays, RoofSite } from './map/roofDetails.ts';
import { iprRoofSites } from './map/iprRoofs.ts';
import { fenceArrays } from './map/fences.ts';
import { shedArrays, shedCorners } from './map/sheds.ts';
import { treeInstances } from './map/vegetation.ts';
import { furnitureInstances, furnitureMatrices, FURNITURE_SIZE } from './map/furniture.ts';
import { standingMarks } from './map/utility.ts';
import { onPolygons } from './map/geo.ts';
import { Geo, Grid, fillPolys, strokeLines } from './map/geo.ts';
import { styleFor, facadeCoords, paintWalls, mansardCoords, BLANK } from './facades.ts';
import type { WallLine } from './facades.ts';
import { roofClutter } from './map/roofClutter.ts';
import { groundLayers, layerBuffers, levelMask } from './ground.ts';
import { flatTerraces, heightSampler, terraceAt } from './terrain.ts';
import { skyView } from './map/skyView.ts';
import { stepEdges, stampEdges, parapetArrays } from './stepEdges.ts';
import type { StepEdge } from './stepEdges.ts';
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
// Things on flat roofs (map/roofDetails.ts): one set of arrays for all the roofs given.
function detailArrays(sites: RoofSite[], ground: (x: number, y: number) => number): DetailArrays | null {
  const sets: DetailArrays[] = [];
  for (const site of sites) {
    const parts = planDetails(site);
    if (parts.length) sets.push(partArrays(parts, site.z, ground));
  }
  if (!sets.length) return null;
  const join = (k: keyof DetailArrays) => {
    const out = new Float32Array(sets.reduce((a, s) => a + s[k].length, 0));
    let o = 0;
    for (const s of sets) { out.set(s[k], o); o += s[k].length; }
    return out;
  };
  return { position: join('position'), normal: join('normal'), color: join('color'), facade: join('facade') };
}
const appendTo = (a: BuildingArrays, d: DetailArrays | null, uv?: (x: number, y: number) => [number, number]): BuildingArrays => {
  if (!d) return a;
  const cat = (x: Float32Array, y: Float32Array) => { const out = new Float32Array(x.length + y.length); out.set(x); out.set(y, x.length); return out; };
  const res: BuildingArrays = { position: cat(a.position, d.position), normal: cat(a.normal, d.normal), color: cat(a.color, d.color), facade: cat(a.facade, d.facade) };
  if (a.drapeUv && uv) {
    const du = new Float32Array((d.position.length / 3) * 2);
    for (let i = 0; i < d.position.length / 3; i++) [du[i * 2], du[i * 2 + 1]] = uv(d.position[i * 3], -d.position[i * 3 + 2]);
    res.drapeUv = cat(a.drapeUv, du);
  }
  return res;
};

const groundAt = (g: HeightGrid | null) => (g ? heightSampler(g.hm, g.box, g.n, g.step, g.labels, terraceAt(g.terraces), flatTerraces(g.terraces, g.ref ?? 0)) : () => 0);

async function roofs({ buildings, size, origin, ground, bbox, water }: WorkerJobs['roofs']): Promise<BuildingArrays> {
  await (roofsReady ??= initRoofs());
  const hAt = groundAt(ground);
  // One building at a time, each lifted onto its own ground height (`base`).
  const keys = ['position', 'normal', 'color', 'drapeUv'] as const;
  const parts: Record<(typeof keys)[number], Float32Array[]> = { position: [], normal: [], color: [], drapeUv: [] };
  const sites: RoofSite[] = [];
  for (const b of buildings) {
    const built = buildBuildings({ size, origin, buildings: [b] , areas: { water } });
    for (const s of built.sites) sites.push({ ...s, z: s.z + (b.base || 0) });
    const g = built.mesh.geometry;
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
  const [W, H] = size, [ox, oy] = origin;
  return appendTo({ ...arrays, facade: facadeCoords(arrays.position, hAt, styleAt(bbox)) }, detailArrays(sites, hAt), (x, y) => [(x + ox) / W, (y + oy) / H]);
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

const MEASURED_WALL = 15; // pipeline/ipr_buildings.py
const ROOF_WINDOW = 10; // pipeline/roof_details.py
const CHIMNEY = 11;
// Arrays with `d` put in at vertex `at`.
const insertAt = (a: BuildingArrays, d: DetailArrays, at: number): BuildingArrays => {
  const put = (x: Float32Array, y: Float32Array, size: number) => { const out = new Float32Array(x.length + y.length); out.set(x.subarray(0, at * size)); out.set(y, at * size); out.set(x.subarray(at * size), at * size + y.length); return out; };
  return { position: put(a.position, d.position, 3), normal: put(a.normal, d.normal, 3), color: put(a.color, d.color, 3), facade: put(a.facade, d.facade, 4) };
};

// IPR Praha's 3D buildings for a tile (pipeline/ipr_buildings.py): triangles with
// positions in centimetres from the tile corner, a colour per triangle and, in newer
// data, a material per triangle. Those in a landmark's footprint (`hide`) are left
// out: the landmark stands there instead.
function ipr({ buffer, box: [x0, y0], absolute, ground, bbox, hide, clutter }: WorkerJobs['ipr']): BuildingArrays {
  const all = new DataView(buffer).getUint32(0, true);
  const p16 = new Int16Array(buffer, 8, all * 9);
  const colAt = 8 + all * 18 + ((4 - ((8 + all * 18) % 4)) % 4);
  const c8 = new Uint8Array(buffer, colAt, all * 3);
  // Newer data: a byte per triangle after the colours, the roof's material (0 not known;
  // pitched: 1 tiles, 2 slate, 3 sheet metal, 4 copper; flat: 5 bitumen, 6 membrane,
  // 7 gravel, 8 planted, 9 paving; 10 a roof window), passed on as the facade
  // attribute's w.
  // On walls, MEASURED_WALL: their colour was measured on the photo mesh, so paintWalls
  // leaves it as it is; 11 a chimney, which keeps its colour too. That's the byte's lower
  // half; on walls the upper half is the facade's style plus one, where the pipeline
  // picked it by the building's age (0: the game picks, styleFor).
  const m8 = buffer.byteLength >= colAt + all * 4 ? new Uint8Array(buffer, colAt + all * 3, all) : null;
  // Chimneys and roof windows go after everything else, in the order they came, so they
  // can be counted and left out as one run of triangles (BuildingArrays.parts).
  const kept: number[] = [], extras: number[] = [];
  for (let t = 0; t < all; t++) {
    const x = x0 + (p16[t * 9] + p16[t * 9 + 3] + p16[t * 9 + 6]) / 300, y = y0 + (p16[t * 9 + 2] + p16[t * 9 + 5] + p16[t * 9 + 8]) / 300;
    if (hide.some((rings) => inPolygon(x, y, rings))) continue;
    const m = m8 ? m8[t] & 15 : 0;
    (m === ROOF_WINDOW || m === CHIMNEY ? extras : kept).push(t);
  }
  const own = kept.length;
  for (const t of extras) kept.push(t);
  const low = (o: number) => (m8 ? m8[kept[o]] & 15 : 0);
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
  const lines: WallLine[] = [];
  const facade = facadeCoords(pos, groundAt(ground), styleAt(bbox), lines);
  if (m8) for (let o = 0; o < n; o++) {
    const style = (m8[kept[o]] >> 4) - 1;
    if (style < 0 || !(facade[o * 12 + 2] > 0)) continue; // not given, or a roof
    for (let f = o * 12 + 3; f < o * 12 + 12; f += 4) {
      const was = facade[f], whole = Math.floor(was);
      facade[f] = style + (whole >= BLANK ? BLANK : 0) + (was - whole);
    }
  }
  paintWalls(pos, col, facade, (o) => { const t = kept[o] * 3; return [c8[t], c8[t + 1], c8[t + 2]]; },
    m8 ? (o) => low(o) === MEASURED_WALL || low(o) === CHIMNEY : undefined);
  if (m8) for (let o = 0; o < n; o++) {
    const m = low(o);
    if (m && m <= ROOF_WINDOW) for (let v = 0; v < 3; v++) facade[(o * 3 + v) * 4 + 3] = m; // roofs only
  }
  mansardCoords(pos, facade, lines);
  // Roof windows (pipeline/roof_details.py): two triangles (A, B, C) and (A, C, D), B
  // across the slope from A and D up it. Their facade coordinates: 0-1 across and up
  // the window, and its width.
  if (m8) for (let o = 0; o + 1 < n; o++) {
    if (low(o) !== ROOF_WINDOW || low(o + 1) !== ROOF_WINDOW) continue;
    const a = o * 9, ux = pos[a + 3] - pos[a], uy = pos[a + 4] - pos[a + 1], uz = pos[a + 5] - pos[a + 2];
    const d = (o + 1) * 9 + 6, vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
    const lu = ux * ux + uy * uy + uz * uz || 1, lv = vx * vx + vy * vy + vz * vz || 1;
    for (let t = o; t <= o + 1; t++) for (let v = 0; v < 3; v++) {
      const q = t * 9 + v * 3, f = (t * 3 + v) * 4;
      const px = pos[q] - pos[a], py = pos[q + 1] - pos[a + 1], pz = pos[q + 2] - pos[a + 2];
      facade[f] = (px * ux + py * uy + pz * uz) / lu;
      facade[f + 1] = (px * vx + py * vy + pz * vz) / lv;
      facade[f + 2] = Math.sqrt(lu);
    }
    o++;
  }
  const result: BuildingArrays = { position: pos, color: col, normal: g.attributes.normal.array as Float32Array, facade };
  if (!m8) return result;
  const hAt = groundAt(ground);
  // In the order: the buildings, the things on flat roofs, the chimneys and roof windows,
  // then the roof clutter.
  const flat = detailArrays(iprRoofSites(pos, low, hAt), hAt);
  const more = clutter ? roofClutter(pos, col, facade, own, low, lines, hAt) : null;
  const built = flat ? insertAt(result, flat, own * 3) : result;
  const extrasAt = own * 3 + (flat ? flat.position.length / 3 : 0);
  return { ...appendTo(built, more), parts: { extras: extrasAt, clutter: extrasAt + (n - own) * 3 } };
}

// Walkable/drivable cells: 0 free, 255 solid, 254 free but walled in (a closed
// courtyard). Only cells reachable from the street network (`seeds`: x, y pairs
// along every street and path in the tile) count as free.
function tileGrid(geo: Geo<LandData>, t: LandData, seeds: Float64Array, edges: StepEdge[]) {
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
    fillPolys(ctx, geo, t.sheds.map((shed) => [shedCorners(shed)]), s);
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
  // The tops of quay walls and retaining walls stop you like a wall (stepEdges.ts).
  stampEdges(edges, cells, w, h, (x, y) => geo.px(x, y, RES));
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

function joinWalls(a: LandResult['walls'], b: LandResult['walls']): LandResult['walls'] {
  if (!b.position.length) return a;
  const cat = (x: Float32Array, y: Float32Array) => { const out = new Float32Array(x.length + y.length); out.set(x); out.set(y, x.length); return out; };
  return { position: cat(a.position, b.position), normal: cat(a.normal, b.normal) };
}

function land({ data, seeds, ground, bridges, box, structures }: WorkerJobs['land']): LandResult {
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
  const edges = ground && data.stepEdges ? stepEdges(ground.terraces, data.areas.water ?? [], heightSampler(ground.hm, ground.box, ground.n, ground.step, ground.labels, terraceAt(ground.terraces), flatTerraces(ground.terraces, ground.ref ?? 0)), ground.box, data.crossers) : [];
  const walls = joinWalls(wallArrays(data, hAt), parapetArrays(edges));
  const fences = fenceArrays(data, hAt);
  const sheds = shedArrays(data.sheds, hAt);
  const grid = tileGrid(geo, data, seeds, edges);
  stampTrunks(grid, geo, trees);
  const furniture = ground && data.furnitureEnabled ? furnitureInstances(new Geo({ ...data, buildings: data.furnitureBuildings }), trees, hAt) : { matrices: furnitureMatrices([]), spots: [] };
  // The surveyed hydrants and phone boxes stand where the survey has them.
  if (ground && data.furnitureEnabled && data.utility?.length) {
    // (Not one the game's carriageway covers: its streets are not always as wide as the real ones.)
    const onRoad = onPolygons([...(data.roads.road || []), ...(data.roads.sett || []), ...(data.roads.dirt || [])]);
    for (const p of standingMarks(data.utility, data.walk.map((e) => e.pts))) if (!onRoad(p.x, p.y)) furniture.spots.push({ ...p, z: hAt(p.x, p.y) });
    furniture.matrices = furnitureMatrices(furniture.spots);
  }
  // The same solid-cell convention as tree trunks, stamped before parking.
  for (const p of furniture.spots) {
    const [hx, hy] = FURNITURE_SIZE[p.kind], c = Math.cos(p.angle), s = Math.sin(p.angle);
    const [u, v] = geo.px(p.x, p.y, RES), rad = Math.hypot(hx, hy) + 0.35, R = Math.ceil(rad * RES);
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      const col = Math.floor(u) + i, row = Math.floor(v) + j;
      const x = (col + 0.5) / RES - geo.ox - p.x, y = geo.H - (row + 0.5) / RES - geo.oy - p.y;
      if (Math.abs(c * x + s * y) <= hx + 0.15 && Math.abs(-s * x + c * y) <= hy + 0.15 && col >= 0 && row >= 0 && col < grid.w && row < grid.h) grid.cells[row * grid.w + col] = 255;
    }
  }
  return { trees, walls, fences, sheds, furniture, cells: grid.cells, masks: structures.map((l) => levelMask(box, l.polys, l.level)) };
}

function isRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return typeof message.id === 'number' && ['roofs', 'ipr', 'ground', 'land', 'sky'].includes(String(message.type))
    && typeof message.data === 'object' && message.data !== null;
}

function transferBuffers(arrays: BuildingArrays): ArrayBuffer[] {
  const buffers = Object.values(arrays).filter((array) => array instanceof Float32Array).map((array) => array.buffer);
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
          ...opts, height: ground ? groundAt(ground) : null, steps: ground?.labels ? ground.terraces ?? [] : null,
          levels: levels ? levels.map((l) => ({ level: l.level, kind: l.kind, polys: l.polys, height: groundAt(l.heights) })) : null,
        });
        worker.postMessage({ id, result } satisfies WorkerResponse, layerBuffers(result));
        break;
      }
      case 'sky': {
        const result = skyView(event.data.data);
        worker.postMessage({ id, result } satisfies WorkerResponse, [result.texels.buffer, ...result.walls.map((a) => a.buffer)] as ArrayBuffer[]);
        break;
      }
      case 'land': {
        const result = land(event.data.data);
        const buffers = [result.trees.matrices.buffer, result.trees.colours.buffer, result.trees.yearly.buffer, result.walls.position.buffer, result.walls.normal.buffer, ...Object.values(result.fences.fence).map((a) => a.buffer), ...Object.values(result.fences.hedge).map((a) => a.buffer), ...Object.values(result.fences.rail).map((a) => a.buffer), result.fences.sections.buffer, ...Object.values(result.sheds).map((a) => a.buffer), result.cells.buffer, ...result.masks.map((m) => m.cells.buffer)];
        buffers.push(...result.furniture.matrices.map(a => a.buffer));
        if (buffers.some((buffer) => !(buffer instanceof ArrayBuffer))) throw new Error('Land transfer requires ArrayBuffer storage');
        worker.postMessage({ id, result } satisfies WorkerResponse, buffers as ArrayBuffer[]);
        break;
      }
    }
  } catch (err) {
    worker.postMessage({ id, error: String(err instanceof Error ? err.stack || err.message : err) } satisfies WorkerResponse);
  }
};
