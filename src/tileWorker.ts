// Builds a tile off the main thread, which then only turns the arrays into meshes:
//   roofs   OSM buildings extruded with straight-skeleton roofs (by far the slowest
//           part of a tile, up to a second or so), with their facade coordinates
//   ipr     IPR's 3D buildings unpacked from the tile's .ipr.bin, with normals and
//           facade coordinates
//   ground  the ground's layers (ground.ts), and the bridge decks above it
//   land    trees, walls and the collision grid
// Everything stands on the tile's terrain, sampled from the heights sent along.
import * as THREE from 'three';
import { initRoofs, buildBuildings, wallArrays } from './map/buildings.ts';
import { treeInstances } from './map/vegetation.ts';
import { Geo, Grid, fillPolys, strokeLines } from './map/geo.ts';
import { styleFor, facadeCoords } from './facades.ts';
import { groundLayers, layerBuffers } from './ground.ts';
import { heightSampler } from './terrain.ts';
import type { Building, MapData, NetworkEdge } from './map/types.ts';
import type {
  Box,
  BuildingArrays,
  GroundBuilding,
  GroundDeckData,
  GroundEdge,
  GroundJobData,
  GroundJobResult,
  GroundMapData,
  HeightAt,
  IprJobData,
  LandJobData,
  LandJobResult,
  RoofsJobData,
  TerrainData,
  TileWorkerRequest,
  TileWorkerResponse,
  TileWorkerTransferList,
} from './tile-types.ts';

const RES = 2; // collision grid cells per metre

let roofsReady: Promise<void> | null = null;
let styles: ReturnType<typeof styleFor> | null = null, stylesOf = '';
// A facade's style by where it is and how tall (facades.ts), for this area.
const styleAt = (bbox: Box): ReturnType<typeof styleFor> => {
  if (stylesOf !== bbox.join()) { styles = styleFor({ bbox_wgs84: bbox }); stylesOf = bbox.join(); }
  return styles!;
};
const groundAt = (g: TerrainData | null): HeightAt => {
  if (!g) return () => 0;
  const [x, y] = g.box;
  return heightSampler(g.hm, [x, y], g.n, g.step);
};

function groundMapData({ areas, roads, rails, weirs, crossings }: GroundMapData): MapData {
  return { size: [0, 0], origin: [0, 0], areas, roads, buildings: [], walls: [], trees: [], rails, weirs, crossings };
}

function groundBuildings(buildings: GroundBuilding[]): Building[] {
  return buildings.map(({ rings }) => ({ id: '', rings, h: 0, minh: 0 }));
}

function groundEdges(edges: GroundEdge[]): NetworkEdge[] {
  return edges.map(({ bridge, lanes, surface, hw, oneway, u, v, width, pts }) => ({ bridge, lanes: lanes ?? undefined, surface: surface ?? undefined, hw, oneway: !!oneway, u, v, width, pts }));
}

function hasTerrainDeck(deck: GroundDeckData): deck is TerrainData {
  return deck !== null && 'hm' in deck;
}

async function roofs({ buildings, size, origin, ground, bbox }: RoofsJobData): Promise<BuildingArrays> {
  await (roofsReady ??= initRoofs());
  const hAt = groundAt(ground);
  // One building at a time, each lifted onto its own ground height (`base`).
  const parts: Record<'position' | 'normal' | 'color' | 'drapeUv', Float32Array[]> = { position: [], normal: [], color: [], drapeUv: [] };
  for (const b of buildings) {
    const g = buildBuildings({ size, origin, buildings: [b] }).mesh.geometry;
    const pos = g.attributes.position.array;
    for (let i = 1; i < pos.length; i += 3) pos[i] += b.base || 0;
    for (const k of Object.keys(parts) as Array<keyof typeof parts>) parts[k].push(g.attributes[k].array as Float32Array);
  }
  const arrays = {} as BuildingArrays;
  for (const k of Object.keys(parts) as Array<keyof typeof parts>) {
    const n = parts[k].reduce((a, x) => a + x.length, 0);
    arrays[k] = new Float32Array(n);
    let o = 0;
    for (const x of parts[k]) { arrays[k].set(x, o); o += x.length; }
  }
  arrays.facade = facadeCoords(arrays.position, hAt, styleAt(bbox));
  return arrays;
}

// IPR Praha's 3D buildings for a tile (pipeline/ipr_buildings.py): triangles with
// positions in centimetres from the tile corner and a colour per triangle.
function ipr({ buffer, box: [x0, y0], absolute, ground, bbox }: IprJobData): BuildingArrays {
  const n = new DataView(buffer).getUint32(0, true);
  const p16 = new Int16Array(buffer, 8, n * 9);
  const colAt = 8 + n * 18 + ((4 - ((8 + n * 18) % 4)) % 4);
  const c8 = new Uint8Array(buffer, colAt, n * 3);
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
  g.computeVertexNormals();
  return { position: pos, color: col, normal: g.attributes.normal.array as Float32Array, facade: facadeCoords(pos, groundAt(ground), styleAt(bbox)) };
}

// Walkable/drivable cells: 0 free, 255 solid, 254 free but walled in (a closed
// courtyard). Only cells reachable from the street network (`seeds`: x, y pairs
// along every street and path in the tile) count as free.
function tileGrid(geo: InstanceType<typeof Geo>, t: LandJobData['data'], seeds: Float64Array): InstanceType<typeof Grid> {
  const grid = new Grid(geo, RES, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';
    if (t.areas.water) fillPolys(ctx, geo, t.areas.water, s);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.9 * s;
    strokeLines(ctx, geo, t.walls.map((w) => w.pts), s);
    // Bridges are open ground, unless they have decks of their own (see tiles.ts):
    // then the ground under them stays as it is (a river, or a street under a flyover).
    if (!t.decks) {
      ctx.fillStyle = '#000';
      fillPolys(ctx, geo, [...(t.areas.bridge || []), ...(t.roads.bridge || [])], s);
    }
    ctx.fillStyle = '#fff';
    fillPolys(ctx, geo, t.buildings.map((b) => b.rings), s);
    // Gateways and passages through buildings stay open, a little past both ends
    // (mapped passages often stop just short of the building's edge).
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'square';
    for (const p of t.passages!) {
      ctx.lineWidth = p.w * s;
      strokeLines(ctx, geo, [p.pts], s);
    }
  });
  const { w, h } = grid;
  const cells = grid.cells!;
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i] > 100 ? 255 : 0;
  const seen = new Uint8Array(cells.length), stack = [];
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
function stampTrunks(grid: InstanceType<typeof Grid>, geo: InstanceType<typeof Geo>, { matrices, count }: LandJobResult['trees']): void {
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
        if (cu >= 0 && cv >= 0 && cu < grid.w && cv < grid.h) grid.cells![cv * grid.w + cu] = 255;
      }
    }
  }
}

function land({ data, seeds, ground }: LandJobData): LandJobResult {
  const geo = new Geo({ ...data, buildings: groundBuildings(data.buildings) }), hAt = groundAt(ground);
  const trees = treeInstances(geo, hAt);
  const walls = wallArrays(data, hAt);
  const grid = tileGrid(geo, data, seeds);
  stampTrunks(grid, geo, trees);
  return { trees, walls, cells: grid.cells! };
}

function ground({ d, ground: terrain, deck, box, edges, buildings, parkingZones }: GroundJobData): GroundJobResult {
  return groundLayers(groundMapData(d), {
    box,
    edges: groundEdges(edges),
    buildings: groundBuildings(buildings),
    parkingZones,
    height: terrain ? groundAt(terrain) : null,
    deck: deck === null ? null : hasTerrainDeck(deck) ? groundAt(deck) : () => NaN,
  });
}

const transferBuffer = (buffer: ArrayBufferLike): ArrayBuffer => buffer as ArrayBuffer;

function buildingBuffers(result: BuildingArrays): TileWorkerTransferList {
  return Object.values(result).filter((array): array is Float32Array => array instanceof Float32Array).map((array) => transferBuffer(array.buffer));
}

function groundBuffers(result: GroundJobResult): TileWorkerTransferList {
  return layerBuffers(result).map(transferBuffer);
}

function landBuffers(result: LandJobResult): TileWorkerTransferList {
  return [result.trees.matrices, result.trees.colours, result.walls.position, result.walls.normal, result.cells].map((array) => transferBuffer(array.buffer));
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (e: MessageEvent<TileWorkerRequest>): Promise<void> => {
  const { id, type, data } = e.data;
  try {
    switch (type) {
      case 'roofs': {
        const result = await roofs(data);
        workerScope.postMessage({ id, result } satisfies TileWorkerResponse, buildingBuffers(result));
        return;
      }
      case 'ipr': {
        const result = ipr(data);
        workerScope.postMessage({ id, result } satisfies TileWorkerResponse, buildingBuffers(result));
        return;
      }
      case 'ground': {
        const result = ground(data);
        workerScope.postMessage({ id, result } satisfies TileWorkerResponse, groundBuffers(result));
        return;
      }
      case 'land': {
        const result = land(data);
        workerScope.postMessage({ id, result } satisfies TileWorkerResponse, landBuffers(result));
        return;
      }
    }
  } catch (err) {
    workerScope.postMessage({ id, error: String((err as { stack?: unknown } | undefined)?.stack || err) });
  }
};
