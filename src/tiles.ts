import { dataUrl } from './data.ts';
import * as telemetry from './telemetry.ts';
import * as THREE from 'three';
import { mirrored } from './mirror.ts';
import { streetOf } from './map/roofRules.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Geo, Grid, rng, hash, clipLine } from './map/geo.ts';
import { wallMesh } from './map/buildings.ts';
import { TreePool } from './trees.ts';
import { Surfaces } from './surface.ts';
import { shadeBuildings, shadeLandmark, cutAway, broad, ROOF_CLUTTER, roadRasterEnabled } from './shading.ts';
import { loadFacadeAtlas } from './facades.ts';
import type { Footprint } from './facades.ts';
import { Zones, parkCarsSteps, inRing, inPoly } from './parking.ts';
import { finish } from './parkingClearance.ts';
import { openWater } from './river.ts';
import { readRoadProfile, withRoadProfile } from './roadProfiles.ts';
import { readRoadSurfaces, withRoadSurfaces } from './roadSurfaces.ts';
import { bridgeSurfaceBuffers, bridgeSurfaceTile, readBridgeSurfacePreview } from './bridgeSurfacePreview.ts';
import { readStationTracks } from './stationTracks.ts';
import { decodeHeights, decodeLevels, flatTerraces, heightSampler, lineReach, pointLabels, stepLineIndex, terraceAt, fetchBinary, withRamps } from './terrain.ts';
import type { StepLine, Terrace } from './terrain.ts';
import { SKY_STEP, SKY_MARGIN } from './map/skyView.ts';
import type { Shadower } from './map/skyView.ts';
import type { Point2, Bounds, Polygons } from './map/geo.ts';
import { DriveGraph } from './network.ts';
import type { DriveEdge, WalkEdge, WalkGraph } from './network.ts';
import type { Car } from './car.ts';
import type { Landmark, TileJSON, MapIndex, TilePassage, BuildingArrays, HeightGrid, LevelInput, LandResult, WorkerJobs, WorkerResults } from './contracts.ts';
import type { LevelMask } from './ground.ts';
import { isTileJSON } from './contracts.ts';
import { TileWorkers } from './tileWorkers.ts';
import { SkyRefresh } from './skyRefresh.ts';
import { validateTileBinary, type TileBinaryKind } from './tileBinary.ts';
import { overheadWires } from './wires.ts';
import { posts, type Post } from './posts.ts';
import { fences, type FenceSection } from './fences.ts';
import { stepEdges, type Crosser, type StepEdge } from './stepEdges.ts';
import { byLevel, bridgeApproaches } from './roadLevels.ts';
import type { RoadHint } from './roadLevels.ts';
import { fenceMeshes } from './map/fences.ts';
import { shedMesh } from './map/sheds.ts';
import { furnitureMeshes, disposeFurniture } from './furniture.ts';
import { chimneySmoke, dropChimneySmoke } from './chimneySmoke.ts';
import { furnitureSurvey } from './furnitureSurvey.ts';
import { CountrysideTiles } from './countrysideTiles.ts';
import { blendHeights, edgeGrid } from './countrysideJoin.ts';

interface TileFiles { t: TileJSON; height: ArrayBuffer | null; bare: ArrayBuffer | null; ipr: ArrayBuffer | null; levels: ArrayBuffer | null }
// A bridge (1, 2, …) or tunnel (-1, -2, …) level in a tile: where it is and how high.
interface TileLevel { level: number; grid: Grid; sample: (x: number, y: number) => number }
// What a tile's meshes are made from, kept for as long as the tile is loaded.
interface TileSource {
  t: TileJSON; size: Point2; origin: Point2; bounds: Bounds;
  ground: HeightGrid | null; levels: LevelInput[] | null; masks: LevelMask[];
  marks: Landmark[]; hide: Point2[][][];
  // IPR's buildings as fetched, until a worker has taken them (then they're fetched again).
  withIpr: boolean; ipr: ArrayBuffer | null;
  extrude: (TileJSON['buildings'][number] & { base: number })[];
  clipped: WorkerJobs['ground']['edges']; parkingZones: (string | null)[];
  standing: { rings: Point2[][] }[]; // the buildings that stand on the ground
  footprints: Footprint[]; // the same and those round the tile, not their parts, for the party walls
  shapes: Shadower[]; trees: LandResult['trees'];
}
type MeshJobs = Promise<[WorkerResults['ground'], BuildingArrays | null, BuildingArrays | null]>;
// TileWorld.picks: one view's tiles, and everything they were worked out from.
// Which way a street-level view looks: its heading (radians, 0 east, anticlockwise)
// and how far either side of it the tiles to draw may lie.
export interface View { h: number; spread: number }
interface Picks {
  x: number; y: number; r: number; drawn: number; T: number; ox: number; oy: number; view: View | null;
  available: Set<string>; revision: number; country: CountrysideTiles | null; box: Bounds | null;
  around: string[]; show: string[]; shown: Set<string>; keep: Set<string>; keepDrawn: Set<string> | null;
}
// A tile's meshes while it's near the view: the ground, the buildings and what was
// made with them (own), all in one group in the scene.
interface TileMeshes { group: THREE.Group; surfaces: Surfaces; own: THREE.Mesh[]; smoke: THREE.Object3D | null }
interface Tile {
  k: string; i: number; j: number; box: Bounds; passages: TilePassage[]; raised: Point2[][][];
  grid: Grid; levels: TileLevel[];
  cars: Car[]; ms: Record<string, number>;
  // Drawn only near the view (see TileWorld.update): `shown` says it should be,
  // `dressing` that its meshes are on the way, `drawn` holds them once they're in the scene.
  source: TileSource; shown: boolean; dressing: Promise<void> | null; drawn: TileMeshes | null;
  drawMs: Record<string, number>; drawAfter: number;
  // The walls, fences and wires: made with the tile (cars knock the fences and poles
  // down wherever they are) and put in the scene with the rest.
  fixtures: THREE.Mesh[];
  roads: Polygons; // the carriageways (asphalt, setts, dirt)
  crossers: Crosser[]; // what may cross a step in the ground (stepEdges.ts)
  poles: Post[]; // the wires' poles, among the posts a car can hit
  fences: FenceSection[];
  furniture: THREE.InstancedMesh[];
  relief: { texture: THREE.DataTexture; box: number[]; sample: (x: number, y: number, side?: number | boolean) => number; hm: Float32Array; labels: Uint8Array | null; edges: () => void } | null;
  sample?: (x: number, y: number, side?: number | boolean) => number;
  // The tile's water (the river and ponds), each polygon with its bounding box.
  water: { rings: Point2[][]; box: Bounds }[];
  weirs: Point2[][];
}
export interface Tracked {
  x: number; y: number; _tx?: number; _ty?: number; level?: number; gz?: number;
  // Where it's put on a street: on a bridge, in a tunnel or on the ground (see track).
  hint?: RoadHint;
  // An AI driver's current named route span, for as long as it follows that lane.
  roadLevel?: number; _roadTerrainRevision?: number;
  // Kept on the ground, whatever is under it or over it (a car in traffic on a street
  // at ground level, see Traffic.update).
  grounded?: boolean;
  e?: { bridge?: boolean; tunnel?: boolean; level?: number }; _view?: { res: number; height: (x: number, y: number) => number; at: (x: number, y: number) => number };
}

// Streams the map in square tiles (pipeline/build_tiles.py) around the camera. Each
// loaded tile has its own collision grid, heights, bridges and tunnels, fences, posts
// and parked cars, which the city's traffic and people need well beyond the screen;
// tiles far behind are dropped again. The street graphs stay global. A tile's ground,
// buildings and trees are made only when it comes near the view (dress) and taken
// away again when it's left behind (undress), while the rest of it stays loaded. The
// heavy part of both runs in workers (tileWorker.ts); the main thread fetches the
// tile's files, joins up the street graphs and makes the meshes and parked cars.

const RES = 2; // collision grid cells per metre
// How the streets are painted: a game built on this city may turn off the lane lines and
// zebra crossings (Praha 1945's streets have none). On by default.
export const TILE_LOOK = { roadPaint: true };
const RAISED = 3; // a building whose underside is this high (m) or more doesn't block the way under it
// Metres a car or a walker can go up or down between the ground and a bridge or a
// tunnel, or between two levels: where a bridge is that close to the ground (at its
// ends), they drive onto it; further apart, it's overhead, or the ground is below the
// parapet.
const CLIMB = 1.5;
// A drawn tile keeps its meshes until it's this much (m) further from the view than
// where it would be drawn, so one at the edge isn't made and taken away over and over.
// The streets within this far (m) of a police car, a fire engine or the like stay in
// the graphs however far from you it is: as far as such a car looks for its way.
const ANCHOR_REACH = 400;
const DRAWN_KEEP = 40;

// Which bridge level the tram track at a point is on (0: none), from the stretches the
// map lists (TileJSON.deckRails): that of the stretch within 2 m, the nearest.
function deckRailLevel(stretches: { level: number; pts: Point2[] }[]) {
  return (x: number, y: number) => {
    let level = 0, best = 2;
    for (const { level: l, pts } of stretches) {
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
        const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(x - ax - dx * k, y - ay - dy * k);
        if (d < best) { best = d; level = l; }
      }
    }
    return level;
  };
}

// Hill shading for a tile from its terrain heights (pipeline/ipr_terrain.py), lit from
// the same north-west as the sun: 1 = unchanged, darker on slopes facing away. The
// ground's broad variation (broad) is multiplied in, sparing the shader its noise.
// `around(di, dj)`: the neighbouring tile's heights (hm) if it is loaded and shares this
// tile's edge points, for the slope at the edge; `edges()` shades the edges again once
// a neighbour has come.
function relief(buffer: ArrayBuffer, bareBuffer: ArrayBuffer | null, box: Bounds, n: number, step: number, ref: number,
  around: ((di: number, dj: number) => Float32Array | null) | null, terraces: Terrace[] | undefined, unit = 0.1, stepLines?: StepLine[]) {
  // Heights in metres above `ref` (the game's y = 0), bilinear and clamped to the tile.
  const hm = decodeHeights(buffer, n, ref, unit), labels = pointLabels(buffer, n);
  // Hill shading uses the bare ground where bridges were raised (see ipr_terrain.py).
  const hs = new Uint16Array(bareBuffer || buffer, 0, n * n);
  const L = [-110, 80, 190], ll = Math.hypot(...L);
  const lx = L[0] / ll, ly = L[1] / ll, lz = L[2] / ll;
  const px = new Uint16Array(n * n);
  // Height (m above 100 m a.s.l.) at a grid point; one past the edge, from the
  // neighbour's second row (its first is this tile's edge); NaN where there's none.
  const at = (i: number, j: number) => {
    if (i >= 0 && i < n && j >= 0 && j < n) return hs[j * n + i] * unit;
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
  // A bank or a retaining wall is a step, not a slope (terrain.ts, pointLabels): the
  // ground on each side of it is shaded by its own slope.
  const side = (i: number, j: number) => (labels && i >= 0 && i < n && j >= 0 && j < n ? labels[j * n + i] : -1);
  const beside = (i: number, j: number, s: number) => { const o = side(i, j); return o >= 0 && s >= 0 && o !== s ? NaN : at(i, j); };
  const paint = (i: number, j: number) => {
    const c = at(i, j), s = side(i, j);
    const dx = slope(beside(i - 1, j, s), c, beside(i + 1, j, s)), dy = slope(beside(i, j - 1, s), c, beside(i, j + 1, s));
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
  return { texture: tex, box: [x0 - half, y0 - half, x0 + (n - 1) * step + half, y0 + (n - 1) * step + half], sample: heightSampler(hm, box, n, step, labels, terraceAt(terraces), flatTerraces(terraces, ref), stepLineIndex(stepLines, ref, lineReach(step), unit)), hm, labels, edges };
}

const shadowerBox = new WeakMap<Shadower, Bounds>();
const buildingMaterial = () => shadeBuildings(new THREE.MeshLambertMaterial({ vertexColors: true }));

// A landmark's model (pipeline/landmarks.py), already in the game's coordinates. Its
// photographs have the day's light in them, so it's lit as if every face looked up:
// evenly, dimming at night and taking the street lamps' light like the rest. Baked
// models are one-sided; a raw piece of the mesh (--raw) says it's two-sided.
// The photographs are paler and yellower than Prague's roofs are to the eye: warm
// colours (roofs, plaster, brick) go a touch redder and a little more saturated; greys and
// blues stay as they are.
function warmUp(map: THREE.Texture) {
  const img = map.image as ImageBitmap;
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.04 || mx !== r || g < b) continue;
    let h = ((g - b) / d) / 6;
    if (h > 0.17) continue;
    const w = 1 - Math.max(0, h - 0.11) / 0.06;
    h = Math.max(0, h - 0.018 * w);
    const s = Math.min(1, (d / mx) * (1 + 0.08 * w));
    const k = h * 6;
    g = mx * (1 - s * (1 - k)); b = mx * (1 - s); r = mx;
    px[i] = r * 255; px[i + 1] = g * 255; px[i + 2] = b * 255;
  }
  ctx.putImageData(data, 0, 0);
  map.image = canvas;
  map.needsUpdate = true;
}

export async function landmarkModel(url: string, plain = false) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  const colourVersion = model.userData.landmarkColourVersion;
  if (colourVersion !== undefined && colourVersion !== 1) {
    throw new Error(`Unsupported landmark colour version ${String(colourVersion)} in ${url}`);
  }
  const legacyMaps = new Set<THREE.Texture>();
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const { map, side } = o.material as THREE.MeshStandardMaterial;
    if (map) {
      map.anisotropy = 4;
      if (colourVersion === undefined && !legacyMaps.has(map)) {
        warmUp(map);
        legacyMaps.add(map);
      }
    }
    // Without tiled roofs (`plain`), nothing is redrawn as tiles: dark glass on a slope would be.
    const material = new THREE.MeshLambertMaterial({ map, side });
    o.material = plain ? cutAway(material, 'landmark-plain') : shadeLandmark(material);
    // Up in the world, in the mesh's own axes (in case the file turns it).
    const up = new THREE.Vector3(0, 1, 0).applyMatrix3(new THREE.Matrix3().getNormalMatrix(o.matrixWorld).invert()).normalize();
    const n = o.geometry.attributes.position.count;
    o.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => up.getComponent(i % 3)), 3));
    o.castShadow = true;
  });
  return model;
}

// The ground of a tile as depth alone, a little below the ground itself: drawn after
// the ground's layers (which have no depth) and before the tunnels, so what's under
// the ground is hidden but for the hole round you. Where road surfaces lower the ground
// (`patched`, in `boxes`), each point goes under the lowest of the surface round it, or
// the cars on the road would be hidden too.
function depthOnlyGround(hm: Float32Array, [x0, y0]: Bounds, n: number, step: number,
  patched?: { sample: (x: number, y: number) => number; boxes: Bounds[] }) {
  const low = Float32Array.from(hm);
  if (patched) lowerUnder(low, x0, y0, n, step, patched.sample, patched.boxes);
  const pos = new Float32Array(n * n * 3), idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = (j * n + i) * 3;
    pos[k] = x0 + i * step;
    pos[k + 1] = low[j * n + i] - 0.3;
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

// Each lattice point in or next to a box goes down to the lowest height `sample` gives
// on a 2 m grid over the cells round it, so the lattice's flat triangles stay under it.
export function lowerUnder(hm: Float32Array, x0: number, y0: number, n: number, step: number,
  sample: (x: number, y: number) => number, boxes: Bounds[]) {
  const m = Math.max(1, Math.round(step / 2)), h = step / m, w = (n - 1) * m + 1;
  const fine = new Float32Array(w * w).fill(Infinity);
  const near = (x: number, y: number) => boxes.some(([bx0, by0, bx1, by1]) => x > bx0 - step && x < bx1 + step && y > by0 - step && y < by1 + step);
  for (let b = 0; b < w; b++) for (let a = 0; a < w; a++) {
    const x = x0 + a * h, y = y0 + b * h;
    if (near(x, y)) fine[b * w + a] = sample(x, y);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (!near(x0 + i * step, y0 + j * step)) continue;
    let low = hm[j * n + i];
    for (let b = Math.max(0, (j - 1) * m); b <= Math.min(w - 1, (j + 1) * m); b++)
      for (let a = Math.max(0, (i - 1) * m); a <= Math.min(w - 1, (i + 1) * m); a++) low = Math.min(low, fine[b * w + a]);
    hm[j * n + i] = low;
  }
}

// Buildings from a worker's arrays: IPR's or extruded from OSM footprints, with their
// facade coordinates (facades.ts).
function buildingMesh(arrays: BuildingArrays, sky: Float32Array | null) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
  g.setAttribute('color', new THREE.BufferAttribute(arrays.color, 3));
  if (arrays.drapeUv) g.setAttribute('drapeUv', new THREE.BufferAttribute(arrays.drapeUv, 2));
  g.setAttribute('facade', new THREE.BufferAttribute(arrays.facade, 4));
  g.setAttribute('sky', new THREE.BufferAttribute(sky ?? new Float32Array(arrays.position.length / 3).fill(1), 1));
  if (arrays.parts) g.userData.parts = { ...arrays.parts, end: arrays.position.length / 3 };
  const mesh = mirrored(new THREE.Mesh(g, buildingMaterial()));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Whether (x, y) is within `pad` metres of a passage through a building.
// The tile's areas with what stands on the plots of family houses laid over the garden
// (pipeline/plots.py): the paving joins the paved squares and the vegetable beds the
// worn earth, which look the same and so cost no draw of their own; pools get a layer.
// Each plot's lawn is kept a little differently (`plot_dry`, `plot_lush`, see
// ground.ts), and most houses have a paved terrace on the garden side (patios()).
function withPatches(t: TileJSON): TileJSON['areas'] {
  const p = t.patches ?? {};
  const dry: Polygons = [], lush: Polygons = [];
  for (const plot of t.plots ?? []) {
    const h = hash(`${plot.b}/lawn`);
    if (h < PLOT_DRY) dry.push([plot.ring]);
    else if (h > 1 - PLOT_LUSH) lush.push([plot.ring]);
  }
  const paving = [...(p.paving || []), ...patios(t)];
  if (!paving.length && !p.bed && !p.pool && !dry.length && !lush.length) return t.areas;
  return {
    ...t.areas,
    ...(paving.length ? { square: [...(t.areas.square || []), ...paving] } : {}),
    ...(p.bed ? { worn: [...(t.areas.worn || []), ...p.bed] } : {}),
    ...(p.pool ? { pool: p.pool } : {}),
    ...(dry.length ? { plot_dry: dry } : {}),
    ...(lush.length ? { plot_lush: lush } : {}),
  };
}

// The shares of plots whose lawn is drier and paler, and greener and thicker, than the rest.
const PLOT_DRY = 0.3, PLOT_LUSH = 0.25;
// A terrace: how often a house has one, how deep it is (m), and its longest.
const PATIO = 0.65, PATIO_DEPTH = 3, PATIO_LONGEST = 8;

// Paved terraces against the houses on family plots, on the side of the house away
// from the gate (the garden side), along the middle of that wall: only where all of it
// lies in the house's plot and in no other building.
function patios(t: TileJSON): Polygons {
  if (!t.plots?.length) return [];
  const byId = new Map<string, Point2[]>();
  for (const b of t.buildings) if (b.id && b.rings?.[0]) byId.set(String(b.id), b.rings[0]);
  const out: Polygons = [];
  for (const plot of t.plots) {
    const ring = byId.get(String(plot.b));
    if (!plot.gate || !ring || ring.length < 3 || hash(`${plot.b}/patio`) > PATIO) continue;
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length; cy /= ring.length;
    // The wall facing furthest from the gate.
    const gx = plot.gate[0] - cx, gy = plot.gate[1] - cy, gl = Math.hypot(gx, gy) || 1;
    let best: [Point2, Point2, number, number] | null = null, bestDot = 0.3;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 4) continue;
      let nx = (b[1] - a[1]) / len, ny = -(b[0] - a[0]) / len;
      if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      const away = -(nx * gx + ny * gy) / gl;
      if (away > bestDot) { bestDot = away; best = [a, b, nx, ny]; }
    }
    if (!best) continue;
    const [a, b, nx, ny] = best, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const half = Math.min(len * 0.7, PATIO_LONGEST) / 2, ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const mx = (a[0] + b[0]) / 2 + nx * 0.05, my = (a[1] + b[1]) / 2 + ny * 0.05;
    const quad: Point2[] = [
      [mx - ux * half, my - uy * half], [mx + ux * half, my + uy * half],
      [mx + ux * half + nx * PATIO_DEPTH, my + uy * half + ny * PATIO_DEPTH], [mx - ux * half + nx * PATIO_DEPTH, my - uy * half + ny * PATIO_DEPTH],
    ];
    const probes: Point2[] = [...quad, [mx + nx * PATIO_DEPTH / 2, my + ny * PATIO_DEPTH / 2]];
    if (!probes.every(([x, y]) => inRing(x, y, plot.ring))) continue;
    if (t.buildings.some((o) => o.rings?.[0] && o.rings[0] !== ring && probes.some(([x, y]) => inRing(x, y, o.rings[0])))) continue;
    out.push([quad]);
  }
  return out;
}

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
  // Prototype (ground_cover.py): `ortho`, the painted
  // photograph itself under everything mapped (?ortho).
  ortho: boolean; photos: Map<string, Promise<THREE.Texture | null>>;
  area: string;
  index: MapIndex;
  scene: THREE.Scene;
  trees: TreePool;
  time: { value: number };
  night: boolean;
  T: number; ox: number; oy: number;
  available: Set<string>; iprTiles: Map<string, boolean>;
  // Goes up whenever `available` changes, so update() looks again at which tiles are
  // round the camera. (Nothing changes it once the world is made, but whatever does
  // must bump this.)
  availableRevision = 0;
  // Tiles past the built map, made in the browser (?countryside), and the heights of
  // the built map's outermost tiles, which they carry on from.
  country: CountrysideTiles | null; edgeHeights: Map<string, Promise<Uint16Array>>;
  bare: Set<string>; leveled: boolean; structures: Set<string>;
  loaded: Map<string, Tile>; byIndex: Map<number, Tile>;
  // Goes up whenever a tile's heights or levels come or go (see insert and drop), so a
  // height worked out from the loaded tiles can be kept until then (CarPool.render).
  terrainRevision = 0;
  last: { i: number; j: number; tile: Tile | undefined };
  pending: Map<string, Promise<TileFiles>>;
  jsons: Map<string, Promise<TileJSON>>;
  jsonRange: { i: number; j: number; reach: number } | null;
  // Each loaded tile's buildings as shadow casters, and its sky-view texture (see map/skyView.ts).
  sky: Map<number, { shapes: Shadower[]; texture: THREE.DataTexture | null; tileBox: Bounds; ground: { hm: Float32Array; box: Bounds; n: number; step: number } | null; refresh: SkyRefresh<Uint8Array> | null }>;
  drive: DriveGraph; walk: WalkGraph;
  driveBy: Map<string, DriveEdge[]>; walkBy: Map<string, WalkEdge[]>;
  // The share of each countryside tile's ground that buildings stand on (for how busy it is).
  builtUp = new Map<string, number>();
  // Fresh walk edges are for the crowd's index; lamps also need the complete tile's
  // paths when a previously forgotten tile rejoins the graphs.
  onEdges: (drive: DriveEdge[], walk: WalkEdge[], buildings: Point2[][], key: string, paths: WalkEdge[]) => void;
  // The street graphs keep the tiles within this far (m) beyond the loading radius, and
  // those round each of `anchors` (whatever still drives a route out there: a police
  // car, a fire engine, a taxi on a job). Further off a tile's streets are forgotten
  // (onForget: the edges and tile keys that left) and joined again when the tile next loads.
  graphBeyond = 500;
  anchors: () => { x: number; y: number }[] = () => [];
  onForget: (drive: DriveEdge[], walk: WalkEdge[], keys: string[]) => void = () => {};
  private trimmed = 0;
  onCars: (cars: Car[], tile: Tile) => void;
  onDrop: (tile: Tile) => void;
  building: number; inFlight: Set<string>; builds: Map<string, Promise<Tile>>;
  // Mesh work belongs to a tile object: an older dropped tile and its replacement
  // can still be waiting for different workers under the same key.
  shown: Set<string>; dressing: Set<Tile>; drawTimes: number[];
  // The last update's tiles round the camera (see picks), for as long as the very same
  // view comes again: only the latest, not every view ever seen.
  private picked: Picks | null = null;
  // How far beyond the edge of the view (m) tiles are drawn: far enough for a tile's
  // meshes to be ready before it comes on screen, and for the shadows a low sun casts
  // across the edge.
  drawBeyond = 100;
  retry: Map<string, number>; workers: TileWorkers; ref: number;
  // Main-thread work too long for one frame (a tile's parked cars: up to 180 ms on a
  // Pixel 5), run from update() for at most `sliceMs` a frame, oldest first. While
  // loadNow runs (the start, a jump, the tests), which the game waits for, it is done
  // at once instead, so it never waits for frames that may not come.
  private jobs: { steps: Generator<void, unknown>; busy: number; done: (r: { value: unknown; busy: number }) => void; fail: (e: unknown) => void }[] = [];
  private urgent = 0;
  // Tiles whose meshes are ready wait their turn to join the scene, one a frame (update()
  // lets the next in): the frame a tile is first drawn its buffers go to the GPU and its
  // shaders are built, and several in one frame stalled the game.
  private turns: (() => void)[] = [];
  // At street level a tile joins in view, so even one tile's buffers at once stalled a
  // frame: there, its meshes start hidden and show a few a frame (far off, in the haze).
  private street = false;
  private reveal: THREE.Object3D[] = [];
  sliceMs = 8;
  buildTimes: number[];
  skyTotals: { coalesced: number; cancelled: number };
  landmarks: Promise<Landmark[]>; landmarkModels: Map<string, Promise<THREE.Group | null>>;
  furnitureReserved: Promise<Float32Array | null>;
  private roadSurfaces: Promise<ReturnType<typeof readRoadSurfaces>> | null;
  private roadProfiles: Promise<ReturnType<typeof readRoadProfile>> | null;
  private stationTracks: Promise<ReturnType<typeof readStationTracks>> | null;
  private stepLines: boolean;
  private bridgeSurfacePreview: Promise<ReturnType<typeof readBridgeSurfacePreview>> | null;
  grid: {
    res: number; height: (x: number, y: number) => number; at: (x: number, y: number) => number;
    view: (who: Tracked) => { res: number; height: (x: number, y: number) => number; at: (x: number, y: number) => number };
  };

  constructor({ area, index, scene, drive, walk, time, night, osmBuildings = false, ortho = false, countryside = false as boolean | 'live' }: {
    area: string; index: MapIndex; scene: THREE.Scene; drive: DriveGraph; walk: WalkGraph;
    time: { value: number }; night: boolean; osmBuildings?: boolean; ortho?: boolean; countryside?: boolean | 'live';
  }) {
    this.osmBuildings = osmBuildings;
    this.ortho = ortho;
    this.photos = new Map();
    this.area = area;
    this.index = index;
    const query = new URLSearchParams(location.search);
    const station = area === 'praha' && query.has('stationtracks');
    // ?lines=off: a map's step lines (pipeline/step_lines.py, a trial) left out, to compare.
    this.stepLines = query.get('lines') !== 'off';
    this.bridgeSurfacePreview = (query.has('bridgesurfaces') || station) ? fetch(dataUrl(area, 'bridge-surfaces.json'))
      .then(async (r) => r.ok ? readBridgeSurfacePreview(await r.json(), area, index.built) : null)
      .catch(() => null) : null;
    this.stationTracks = station && this.bridgeSurfacePreview ? this.bridgeSurfacePreview.then((bridges) =>
      bridges ? fetch(dataUrl(area, 'station-tracks.json'))
        .then(async (r) => r.ok ? readStationTracks(await r.json(), area, index.built) : null)
        .catch(() => null) : null) : null;
    const loadRoadSurfaces = (file: string) => fetch(dataUrl(area, file))
      .then(async (r) => r.ok ? readRoadSurfaces(await r.json(), area, index.built) : null)
      .catch(() => null);
    this.roadSurfaces = query.has('roadsurfaces') ? (async () => {
      // Pilot: one smooth surface over an area's streets (pipeline/road_fit.py).
      if (query.has('roadfit')) {
        const fits = await loadRoadSurfaces('road-fit.json');
        if (fits) return fits;
      }
      if (query.has('roadshelves')) {
        const fits = await loadRoadSurfaces('road-shelves.json');
        if (fits) return fits;
      }
      if (query.has('roadcorridors')) {
        const file = query.get('roadcorridors') === 'trial' ? 'road-corridors-trial.json' : 'road-corridors.json';
        const fits = await loadRoadSurfaces(file);
        if (fits) return fits;
      }
      if (query.has('roadcorridor')) {
        const fits = await loadRoadSurfaces('road-corridor.json');
        if (fits) return fits;
      }
      if (query.has('roadjunctions')) {
        const fits = await loadRoadSurfaces('road-junctions.json');
        if (fits) return fits;
      }
      return loadRoadSurfaces('road-surfaces.json');
    })() : null;
    this.roadProfiles = !this.roadSurfaces && query.has('roadprofiles') ? fetch(dataUrl(area, 'road-profile.json'))
      .then(async (r) => r.ok ? readRoadProfile(await r.json(), area, index.built) : null)
      .catch(() => null) : null;
    loadFacadeAtlas();
    this.scene = scene;
    this.trees = new TreePool(scene);
    this.time = time;
    this.night = night;
    this.T = index.tile;
    [this.ox, this.oy] = index.origin;
    this.available = new Set(index.tiles.map(([i, j]) => `${i}_${j}`));
    this.country = countryside ? new CountrysideTiles(index, area, countryside === 'live') : null;
    this.edgeHeights = new Map();
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
    this.jsons = new Map(); // JSON only: parking needs neighbours without their meshes/heights
    this.jsonRange = null;
    this.sky = new Map();
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
    this.shown = new Set();
    this.dressing = new Set();
    this.drawTimes = [];
    this.retry = new Map(); // key → when to try a tile that failed again
    this.workers = new TileWorkers();
    this.buildTimes = [];
    this.skyTotals = { coalesced: 0, cancelled: 0 };
    // Landmarks from IPR's photorealistic mesh, where the area has any (?osm: none).
    this.landmarks = osmBuildings ? Promise.resolve([]) : fetch(dataUrl(area, 'landmarks.json'))
      .then((r) => (r.ok ? r.json() as Promise<Landmark[]> : [])).catch(() => []);
    this.landmarkModels = new Map();
    // A stable survey source, independent of the live post index and load order.
    this.furnitureReserved = furnitureSurvey(dataUrl(area, 'lamps.bin.gz'));
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

  // Whether a point is on a carriageway (not a pavement): false too where nothing is loaded.
  onRoad(x: number, y: number) {
    const t = this.tileAt(x, y);
    return !!t && t.roads.some((rings) => inPoly(x, y, rings));
  }

  // Whether a point is on open water: true or false, null where nothing is loaded.
  waterAt(x: number, y: number): boolean | null {
    const t = this.tileAt(x, y);
    if (!t) return null;
    return openWater(t, x, y);
  }

  // Ground height (m above this.ref) at a point, 0 where nothing is loaded.
  // `onWater`: by a bank, the water's level, not the quay's (see heightSampler).
  terrainAt(x: number, y: number, onWater = false) {
    const t = this.tileAt(x, y);
    return t?.sample ? t.sample(x, y, onWater) : 0;
  }

  // The edges at the tops of the steps in the ground within r of a point, as the
  // collision grid has them, and where ways cross a step (stepEdges.ts; worked out
  // again here, for the checks).
  stepEdgesNear(x: number, y: number, r: number) {
    const edges: StepEdge[] = [], crossings: { x: number; y: number; dx: number; dy: number; drop: number; hw: string }[] = [];
    for (const t of this.loaded.values()) {
      const [x0, y0, x1, y1] = t.box;
      if (x < x0 - r || x > x1 + r || y < y0 - r || y > y1 + r || !t.sample) continue;
      for (const e of stepEdges(t.source.t.terraces, t.source.t.areas.water ?? [], t.sample, t.box, t.crossers,
        (w, cx, cy, drop, dx, dy) => { if (Math.hypot(cx - x, cy - y) <= r) crossings.push({ x: cx, y: cy, dx, dy, drop, hw: w.hw ?? '' }); })) {
        if (Math.hypot((e.a[0] + e.b[0]) / 2 - x, (e.a[1] + e.b[1]) / 2 - y) <= r) edges.push(e);
      }
    }
    return { edges, crossings };
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

  // What something in the air at height z has under it and over it at a point: the
  // bridge deck or the ground it would come down on (`level`, `h`), and the lowest
  // deck above it (`roof`, Infinity under the open sky).
  below(x: number, y: number, z: number) {
    const t = this.tileAt(x, y);
    let level = 0, h = this.terrainAt(x, y), roof = Infinity;
    if (t) for (const l of t.levels) {
      if (l.level <= 0 || !l.grid.at(x, y)) continue;
      const d = this.levelAt(x, y, l.level);
      if (d > z + CLIMB) roof = Math.min(roof, d);
      else if (d > h) { level = l.level; h = d; }
    }
    return { level, h, roof };
  }

  // Keep track of whether someone or something (anything with x and y) is on the
  // ground, a bridge or in a tunnel: onto a bridge or into a tunnel where it meets the
  // ground (or the level it's on), off it where it ends. Sets `level` and `gz` (the
  // height underfoot) on it; returns the level.
  track(who: Tracked) {
    const numericHint = typeof who.hint === 'number' ? who.hint : undefined;
    const roadLevel = who.roadLevel ?? numericHint;
    if (who._tx === who.x && who._ty === who.y && who.level !== undefined && numericHint === undefined
      && (roadLevel === undefined || (roadLevel === who.level && who._roadTerrainRevision === this.terrainRevision))
      && (!who.grounded || who.level === 0)) return who.level;
    // Moved far since last time (put somewhere else): where it was says nothing.
    if (who._tx !== undefined && who._ty !== undefined && Math.abs(who.x - who._tx) + Math.abs(who.y - who._ty) > 12) who.level = undefined;
    who._tx = who.x;
    who._ty = who.y;
    const { x, y } = who, t = this.tileAt(x, y);
    if (roadLevel !== undefined) {
      who.hint = undefined;
      who._roadTerrainRevision = this.terrainRevision;
      // A named level is useful only where its own deck or tunnel actually
      // exists. If missing, don't put the car on an unrelated crossing level.
      if (roadLevel && t) for (const l of t.levels) {
        if (l.level !== roadLevel || !l.grid.at(x, y)) continue;
        const h = l.sample(x, y);
        if (Number.isFinite(h)) { who.level = roadLevel; who.gz = h; return roadLevel; }
      }
      who.level = 0;
      who.gz = this.terrainAt(x, y);
      return 0;
    }
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
      // Its street's own level where the map gives one (and the level is here).
      const named = who.e?.level;
      if (Number.isNaN(level) && named !== undefined && t.levels.some((l) => l.level === named && l.grid.at(x, y))) level = named;
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

  // Whether `who` (as track) is in a tunnel with the ground over it: not in the open
  // cutting before its portal, where the tunnel's level already runs (from where it
  // meets the ground) but the ground beside is barely above it.
  buried(who: Tracked) {
    return this.track(who) < 0 && this.terrainAt(who.x, who.y) - (who.gz ?? 0) > CLIMB;
  }

  // Whether something is over `who` (as track): a bridge above it, or the ground above
  // a tunnel. There a round hole opens so it stays in view.
  covered(who: Tracked) {
    const level = this.track(who), z = who.gz ?? 0, t = this.tileAt(who.x, who.y);
    if (this.buried(who)) return true;
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

  // Whether there is a tile (i, j): one of the built map's, or one to make past it.
  has(i: number, j: number) { return this.available.has(`${i}_${j}`) || !!this.country?.covers(i, j); }
  hasAt(x: number, y: number) { return this.has(Math.floor((x + this.ox) / this.T), Math.floor((y + this.oy) / this.T)); }

  // The ground of a tile past the built map: flat outwards from the nearest point of
  // the built map's edge, so it meets the built ground and its own neighbours without
  // a step (the pipeline's outer ring does the same past IPR's terrain).
  edgeHeight(i: number, j: number): Promise<ArrayBuffer> {
    const { cols, rows, terrain } = this.index, n = terrain!.n;
    // No built map (?at=): the hills alone, or flat at the game's level without them.
    if (!cols || !rows) {
      return (this.country?.heights(i, j) ?? Promise.resolve(null))
        .then((hills) => (hills ?? new Uint16Array(n * n).fill(Math.round((this.ref - 100) * 10))).buffer as ArrayBuffer);
    }
    const k = `${Math.max(0, Math.min(cols - 1, i))}_${Math.max(0, Math.min(rows - 1, j))}`;
    if (!this.edgeHeights.has(k)) {
      const url = dataUrl(this.area, `tiles/${k}.height.bin${this.index.gzip ? '.gz' : ''}`);
      const heights = fetchBinary(url, !!this.index.gzip).then((buffer) => {
        if (!buffer || buffer.byteLength < n * n * 2) throw new Error(`Tile ${k}: height data could not be loaded (${url})`);
        return new Uint16Array(buffer, 0, n * n);
      });
      heights.catch(() => { if (this.edgeHeights.get(k) === heights) this.edgeHeights.delete(k); });
      this.edgeHeights.set(k, heights);
    }
    // …and from there out to the hills, where the countryside has them.
    return Promise.all([this.edgeHeights.get(k)!, this.country?.heights(i, j) ?? null]).then(([from, hills]) => {
      const flat = edgeGrid(from, n, i, j, cols, rows);
      return (hills ? blendHeights(flat, hills, n, this.T, i, j, cols, rows) : flat).buffer as ArrayBuffer;
    });
  }

  // Tile keys within r metres of (x, y), nearest first (or in no particular order, for
  // a set to look things up in).
  around(x: number, y: number, r: number, sorted = true): string[] {
    const T = this.T, out: [number, string][] = [], keys: string[] = [];
    const i0 = Math.floor((x - r + this.ox) / T), i1 = Math.floor((x + r + this.ox) / T);
    const j0 = Math.floor((y - r + this.oy) / T), j1 = Math.floor((y + r + this.oy) / T);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = `${i}_${j}`;
        if (!this.has(i, j)) continue;
        const cx = (i + 0.5) * T - this.ox, cy = (j + 0.5) * T - this.oy;
        const d = Math.max(0, Math.hypot(cx - x, cy - y) - T * 0.71);
        if (d <= r) { if (sorted) out.push([d, k]); else keys.push(k); }
      }
    }
    return sorted ? out.sort((a, b) => a[0] - b[0]).map((p) => p[1]) : keys;
  }

  // Shared by rendering and the parking halo. A failed neighbour is retried;
  // missing road evidence must never silently count as an empty street.
  fetchJSON(k: string): Promise<TileJSON> {
    if (!this.jsons.has(k)) {
      const base = dataUrl(this.area, `tiles/${k}`);

      const [i, j] = k.split('_').map(Number);
      const json: Promise<TileJSON> = (this.available.has(k) ? fetch(`${base}.json`).then(async (r): Promise<unknown> => {
        if (!r.ok) throw new Error(`Tile ${k} could not be loaded (${r.status})`);
        return r.json();
      }) : this.country!.tile(i, j)).then((value: unknown) => {
        if (!isTileJSON(value, !!this.index.graphs)) throw new Error(`Tile ${k} has invalid map data`);
        // (The built map's last tiles end where the map does: the countryside fills the rest.)
        if (this.available.has(k) && this.country?.partial(i, j)) return this.country.whole(value);
        return value;
      });
      json.catch(() => { if (this.jsons.get(k) === json) this.jsons.delete(k); });
      this.jsons.set(k, json);
    }
    return this.jsons.get(k)!;
  }

  // Complete before any cars are published: no removal/repopulation when a
  // neighbour finishes building, and no dependence on the global graph's history.
  async parkingEdges(t: TileJSON): Promise<DriveEdge[]> {
    if (!this.index.graphs) return this.drive.edges; // old maps load a complete graph separately
    const keys: string[] = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const key = `${t.i + di}_${t.j + dj}`;
      if (this.has(t.i + di, t.j + dj)) keys.push(key);
    }
    const tiles = await Promise.all(keys.map((key) => this.fetchJSON(key)));
    const graph = new DriveGraph();
    graph.add(tiles.flatMap((tile) => tile.drive || []).sort((a, b) => a.id.localeCompare(b.id)));
    return graph.edges;
  }

  // The buildings in a tile and its neighbours that people park for, from the same tiles
  // in the same order whenever the tile is built: how full the cars outside the paid zones
  // are doesn't depend on which neighbour happened to arrive first.
  async parkingBuildings(t: TileJSON) {
    const keys: string[] = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (this.has(t.i + di, t.j + dj)) keys.push(`${t.i + di}_${t.j + dj}`);
    const tiles = await Promise.all(keys.map((key) => this.fetchJSON(key)));
    return tiles.flatMap((tile) => tile.buildings.filter((b) => (b.minh ?? 0) < RAISED).map((b) => ({ id: b.id, rings: b.rings, kind: b.kind, h: b.h })));
  }

  // Keys of the tiles that reach within r metres of (x, y), nearest first (or unsorted).
  near(x: number, y: number, r: number, sorted = true): string[] {
    const T = this.T, out: [number, string][] = [], keys: string[] = [];
    const i0 = Math.floor((x - r + this.ox) / T), i1 = Math.floor((x + r + this.ox) / T);
    const j0 = Math.floor((y - r + this.oy) / T), j1 = Math.floor((y + r + this.oy) / T);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = `${i}_${j}`;
        if (!this.has(i, j)) continue;
        const ax = i * T - this.ox, ay = j * T - this.oy;
        const d = Math.hypot(Math.max(ax - x, 0, x - ax - T), Math.max(ay - y, 0, y - ay - T));
        if (d <= r) { if (sorted) out.push([d, k]); else keys.push(k); }
      }
    }
    return sorted ? out.sort((a, b) => a[0] - b[0]).map((p) => p[1]) : keys;
  }

  binaryUrl(k: string, name: TileBinaryKind) { return `${dataUrl(this.area, `tiles/${k}`)}.${name}.bin${this.index.gzip ? '.gz' : ''}`; }

  // One of a tile's binary files. They are required by the tile's metadata: failure
  // must retry rather than publish flat terrain or absent bridge/building geometry.
  async binary(k: string, name: TileBinaryKind) {
    const url = this.binaryUrl(k, name);
    const buffer = await fetchBinary(url, !!this.index.gzip);
    if (!buffer) throw new Error(`Tile ${k}: required ${name} data could not be loaded (${url})`);
    return buffer;
  }

  // The tiles to draw: those within `drawn` of the point, or everything loaded (within
  // r) when that's no less.
  reach(x: number, y: number, r: number, drawn: number) { return drawn < r ? this.near(x, y, drawn) : this.around(x, y, r); }

  // All of a tile's files at once: its JSON, terrain heights, its bridges' and tunnels'
  // heights (or, from before those, the bare ground where bridges were raised) and
  // IPR's buildings.
  fetchTile(k: string): Promise<TileFiles> {
    if (!this.pending.has(k)) {
      const bin = (name: TileBinaryKind) => this.binary(k, name);
      const json = this.fetchJSON(k);
      if (this.ortho && !this.photos.has(k)) {
        this.photos.set(k, new THREE.TextureLoader().loadAsync(dataUrl(this.area, `cover/ortho/${k}.jpg`)).then((tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          return tex;
        }).catch(() => null));
      }
      const [i, j] = k.split('_').map(Number);
      const height = !this.index.terrain ? null : this.available.has(k) ? bin('height') : this.edgeHeight(i, j);
      const bare = this.index.terrain && this.bare.has(k) ? bin('bare') : null;
      const levels = this.structures.has(k) ? bin('levels') : null;
      const known = this.iprTiles.get(k);
      const ipr = this.osmBuildings || known === false ? null : known ? bin('ipr') : json.then((t) => (t.ipr ? bin('ipr') : null));
      const files = Promise.all([json, height, bare, ipr, levels]).then(([t, height, bare, ipr, levels]) => {
        for (const [kind, buffer] of [['height', height], ['bare', bare], ['ipr', ipr], ['levels', levels]] as const) {
          if (buffer !== null) validateTileBinary(kind, buffer, { key: k, url: this.binaryUrl(k, kind), n: this.index.terrain?.n, tile: t });
        }
        return { t, height, bare, ipr, levels };
      });
      files.catch(() => { if (this.pending.get(k) === files) this.failed(k); });
      this.pending.set(k, files);
    }
    return this.pending.get(k)!;
  }

  // A tile whose files or build failed is fetched afresh, after a pause (a file that
  // keeps failing would otherwise be asked for every frame).
  failed(k: string) {
    telemetry.count('tileFailures');
    this.pending.delete(k);
    this.jsons.delete(k);
    this.retry.set(k, performance.now() + 2000);
  }

  // Load everything within r now (used at start); returns when done, with the tiles
  // within `drawn` of the point in the scene. A tile that fails (a dropped or cut-short
  // download on a busy machine) is tried again a couple of times, then left for update()
  // to load later, so one bad file never stops the start.
  async loadNow(x: number, y: number, r: number, drawn = r) {
    this.urgent++;
    try { await this.loadAround(x, y, r, drawn); } finally { this.urgent--; }
  }

  private async loadAround(x: number, y: number, r: number, drawn: number) {
    this.runJobs(Infinity);
    this.shown = new Set(this.reach(x, y, r, drawn));
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
      const tile = this.loaded.get(k);
      if (tile && this.shown.has(k)) await this.dress(tile);
    }));
  }

  // Which tiles update() works from: those within r, nearest first; those to draw, in
  // the order they are drawn; and those to keep loaded and drawn. They depend only on
  // the view and on which tiles there are, so exactly the same view as last time (as
  // when standing still) gets the same lists back. What has failed, finished or is due
  // is up to update(), every frame.
  private picks(x: number, y: number, r: number, drawn: number, view: View | null = null): Picks {
    const p = this.picked, box = this.country?.box ?? null;
    if (p && p.x === x && p.y === y && p.r === r && p.drawn === drawn && p.view?.h === view?.h && p.view?.spread === view?.spread && p.T === this.T && p.ox === this.ox && p.oy === this.oy
      && p.available === this.available && p.revision === this.availableRevision && p.country === this.country
      && (p.box === null ? box === null : !!box && p.box.every((v, n) => v === box[n]))) return p;
    const around = this.around(x, y, r), near = drawn < r ? this.near(x, y, drawn) : around;
    // Looking along the street, only the tiles in view are drawn (and those round you).
    // Ones already drawn stay drawn when you turn away, so looking back costs nothing.
    const show = view ? near.filter((k) => this.inView(k, x, y, view)) : near;
    // (The countryside's box is copied: it is its contents that decide what it covers.)
    return this.picked = {
      x, y, r, drawn, T: this.T, ox: this.ox, oy: this.oy, view: view && { ...view }, available: this.available, revision: this.availableRevision,
      country: this.country, box: box && [box[0], box[1], box[2], box[3]], around, show, shown: new Set(show),
      keep: new Set(this.around(x, y, r + this.T * 0.5, false)),
      keepDrawn: drawn < r ? new Set(this.near(x, y, drawn + DRAWN_KEEP, false)) : null,
    };
  }

  // Whether tile k lies (partly) within the view's wedge from (x, y), or right by you.
  private inView(k: string, x: number, y: number, view: View) {
    const [i, j] = k.split('_').map(Number), T = this.T;
    const cx = (i + 0.5) * T - this.ox - x, cy = (j + 0.5) * T - this.oy - y, d = Math.hypot(cx, cy);
    if (d < T) return true;
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(cy, cx) - view.h), Math.cos(Math.atan2(cy, cx) - view.h)));
    return off <= view.spread + Math.asin(Math.min(1, (T * Math.SQRT1_2) / d));
  }

  // Called every frame: starts building the nearest missing tiles within r and drops
  // far ones; of those loaded, the ones within `drawn` of the point get their meshes
  // (with a `view`, only the ones it looks towards).
  update(x: number, y: number, r: number, drawn = r, view: View | null = null) {
    const now = performance.now();
    this.turns.shift()?.();
    this.street = !!view;
    for (let n = 0; n < 6 && this.reveal.length; n++) this.reveal.shift()!.visible = true;
    const { around, show, shown, keep, keepDrawn } = this.picks(x, y, r, drawn, view);
    const want = around.filter((k) => !((this.retry.get(k) ?? 0) > now));
    for (const k of want.slice(0, 12)) this.fetchTile(k);
    this.shown = shown;
    // One build per worker at a time: first the meshes of tiles coming into view, then
    // the tiles further out.
    for (const k of show) {
      if (this.building + this.dressing.size >= this.workers.size) break;
      const tile = this.loaded.get(k);
      if (tile && !tile.drawn && !tile.dressing && tile.drawAfter <= now) void this.dress(tile);
    }
    while (this.building + this.dressing.size < this.workers.size) {
      const next = want.find((k) => !this.loaded.has(k) && !this.inFlight.has(k));
      if (!next) break;
      this.building++;
      this.inFlight.add(next);
      this.fetchTile(next).then((files) => this.build(next, files, true)).catch((e) => console.error(e)).finally(() => {
        this.building--;
        this.inFlight.delete(next);
      });
    }
    for (const k of [...this.loaded.keys()]) if (!keep.has(k)) this.drop(k);
    if (now - this.trimmed > 1000) { this.trimmed = now; this.forget(x, y, r); }
    if (keepDrawn) for (const tile of this.loaded.values()) if (tile.shown && !keepDrawn.has(tile.k)) this.undress(tile);
    // Files fetched ahead for tiles that are now far behind aren't needed any more.
    for (const k of [...this.pending.keys()]) if (!keep.has(k) && !this.loaded.has(k) && !this.inFlight.has(k)) this.pending.delete(k);
    // Photos start with prefetching too: a failed or never-built tile has no drop()
    // call to retire its image. Keep any photo still needed by a live build.
    for (const k of this.photos.keys()) {
      if (!keep.has(k) && !this.loaded.has(k) && !this.inFlight.has(k) && !this.builds.has(k)) this.dropPhoto(k);
    }
    // JSON-only halo, including diagonal neighbours, is slightly larger than the
    // rendered set. Prune by tile coordinates without constructing a new index.
    const ci = Math.floor((x + this.ox) / this.T), cj = Math.floor((y + this.oy) / this.T);
    const reach = Math.ceil(r / this.T) + 3;
    if (ci !== this.jsonRange?.i || cj !== this.jsonRange?.j || reach !== this.jsonRange?.reach) {
      this.jsonRange = { i: ci, j: cj, reach };
      for (const k of this.jsons.keys()) {
        const [i, j] = k.split('_').map(Number);
        if (Math.abs(i - ci) > reach || Math.abs(j - cj) > reach) this.jsons.delete(k);
      }
    }
    this.runJobs(this.sliceMs);
  }

  private sliced<T>(steps: Generator<void, T>): Promise<{ value: T; busy: number }> {
    return new Promise((done, fail) => {
      this.jobs.push({ steps, busy: 0, done: done as (r: { value: unknown; busy: number }) => void, fail });
      if (this.urgent) this.runJobs(Infinity);
    });
  }

  private runJobs(budget: number) {
    const t0 = performance.now();
    while (this.jobs.length && performance.now() - t0 < budget) {
      const job = this.jobs[0], s0 = performance.now();
      try {
        let s;
        do s = job.steps.next(); while (!s.done && performance.now() - t0 < budget);
        job.busy += performance.now() - s0;
        if (!s.done) return;
        this.jobs.shift();
        job.done({ value: s.value, busy: job.busy });
      } catch (e) {
        this.jobs.shift();
        job.fail(e);
      }
    }
  }

  // Forgets the streets of tiles far from (x, y) and from every anchor: without this
  // the graphs, and everything indexed from them, held every tile ever visited.
  forget(x: number, y: number, r: number) {
    if (this.driveBy.size <= this.loaded.size) return;
    const keep = new Set(this.around(x, y, r + this.graphBeyond, false));
    for (const a of this.anchors()) for (const k of this.around(a.x, a.y, ANCHOR_REACH, false)) keep.add(k);
    const drive: DriveEdge[] = [], walk: WalkEdge[] = [], keys: string[] = [];
    for (const k of [...this.driveBy.keys()]) {
      if (keep.has(k) || this.loaded.has(k) || this.builds.has(k)) continue;
      for (const e of this.driveBy.get(k)!) drive.push(e);
      for (const e of this.walkBy.get(k) || []) walk.push(e);
      this.driveBy.delete(k);
      this.walkBy.delete(k);
      keys.push(k);
    }
    if (!keys.length) return;
    this.onForget(this.drive.remove(drive), this.walk.remove(walk), keys);
  }

  // Whether tiles or their meshes are being made.
  get busy() { return this.inFlight.size > 0 || this.dressing.size > 0; }

  // Build a tile (once, however many ask: loadNow and update may both want it).
  // (`sliced`: its parked cars a few milliseconds a frame, see `jobs`.)
  build(k: string, files: TileFiles, sliced = false): Promise<Tile> {
    if (this.loaded.has(k)) return Promise.resolve(this.loaded.get(k)!);
    if (!this.builds.has(k)) {
      const started = performance.now();
      const made = this.make(k, files, sliced)
        .then((tile) => { this.retry.delete(k); this.buildTimes.push(performance.now() - started); if (this.buildTimes.length > 256) this.buildTimes.shift(); return tile; })
        .catch((e) => { this.failed(k); throw e; })
        .finally(() => this.builds.delete(k));
      this.builds.set(k, made);
    }
    return this.builds.get(k)!;
  }

  // A tile without its meshes: what the traffic, the people and the parked cars need.
  async make(k: string, { t, height, bare, ipr, levels }: TileFiles, sliced = false): Promise<Tile> {
    const preview = this.bridgeSurfacePreview ? await this.bridgeSurfacePreview : null;
    t = bridgeSurfaceTile(t, k, preview);
    ({ height, levels } = bridgeSurfaceBuffers(t, k, this.index.terrain?.n, height, levels, preview));
    // Fetch only the adjacent JSON, before any render resources/leases are created.
    const clearanceEdges = await this.parkingEdges(t);
    const nearBuildings = await this.parkingBuildings(t);
    const [x0, y0, x1, y1] = t.box;
    const data = { ...t, size: [x1 - x0, y1 - y0] as Point2, origin: [-x0, -y0] as Point2 };
    const geo = new Geo(data);
    const own = t.buildings.filter((b) => b.own);
    // Landmarks reaching into the tile: its buildings in their footprints give way.
    const marks = (await this.landmarks).filter((l) => l.tiles.includes(k));
    const hide = marks.flatMap((l) => l.polygons);
    const givesWay = (rings: Point2[][]) => {
      const cx = rings[0].reduce((a, p) => a + p[0], 0) / rings[0].length, cy = rings[0].reduce((a, p) => a + p[1], 0) / rings[0].length;
      return hide.some((r) => inRing(cx, cy, r[0]) && !r.slice(1).some((h) => inRing(cx, cy, h)));
    };
    // What stands on the ground: not the parts raised well above it (a covered bridge
    // between two buildings, an overhang on pillars), which you walk and drive under.
    const grounded = (b: { minh?: number }) => !((b.minh ?? 0) >= RAISED);
    // The tile's paid-parking sections (clipped to it, with their share of spaces).
    const zones = new Zones({ sections: (t.sections || []).map((z) => ({ ...z, inside: z.share })) });
    if (!this.available.has(k) || this.country?.partial(t.i, t.j)) {
      const ring = (r: Point2[]) => Math.abs(r.reduce((sum, p, n) => sum + p[0] * r[(n + 1) % r.length][1] - r[(n + 1) % r.length][0] * p[1], 0)) / 2;
      this.builtUp.set(k, t.buildings.reduce((sum, b) => sum + (b.own ? ring(b.rings[0]) : 0), 0) / (this.T * this.T));
    }
    if (t.drive && !this.driveBy.has(k)) {
      this.driveBy.set(k, this.drive.add(t.drive));
      this.walkBy.set(k, this.walk.add(t.walk ?? []));
      this.onEdges(this.driveBy.get(k)!, this.walk.fresh, t.buildings.filter(grounded).map((b) => b.rings[0]), k, this.walkBy.get(k)!);
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
    const shade = height && terrain ? relief(height, bare, t.box, terrain.n, terrain.step, this.ref, around, t.terraces, terrain.unit, this.stepLines ? t.stepLines : undefined) : null;
    const pilot = this.roadProfiles && this.available.has(k) && shade ? await this.roadProfiles : null;
    const roadProfile = pilot?.tiles.includes(k) ? pilot.profile : undefined;
    if (shade && roadProfile) shade.sample = withRoadProfile(shade.sample, roadProfile, this.ref);
    const trial = this.roadSurfaces && this.available.has(k) && shade ? (await this.roadSurfaces)?.get(k) : undefined;
    const lower = preview?.ground.get(k);
    const fits = lower ? [...lower, ...(trial ?? [])] : trial;
    const surfaces = fits;
    if (shade && surfaces) shade.sample = withRoadSurfaces(shade.sample, surfaces, this.ref, terraceAt(t.terraces));
    const hAt = shade ? shade.sample : () => 0;
    const ground = shade && terrain ? { hm: shade.hm, box: t.box, n: terrain.n, step: terrain.step, labels: shade.labels,
      terraces: t.terraces, stepLines: this.stepLines ? t.stepLines : undefined, unit: terrain.unit, ref: this.ref, ...(roadProfile ? { roadProfile } : {}), ...(surfaces ? { roadSurfaces: surfaces } : {}) } : null;
    // Bridges above the ground and tunnels below it, each level with its own heights.
    const structures = t.structures || [];
    const heights = levels && terrain ? decodeLevels(levels, terrain.n, structures.length, this.ref) : [];
    const tileLevels: LevelInput[] | null = this.leveled && terrain ? structures.map((s, i) => ({
      ...s, heights: { hm: heights[i] ?? new Float32Array(terrain.n * terrain.n).fill(NaN), box: t.box, n: terrain.n, step: terrain.step, ramps: s.ramps, ref: this.ref },
    })) : null;
    lap('terrain');

    // Real 3D buildings from IPR where the area has them (unless ?osm), else OSM
    // footprints extruded with roofs on their straight skeletons, each set on the lowest ground
    // under its footprint. In a tile with IPR buildings, the OSM ones IPR doesn't have
    // (noIpr, see ipr_buildings.py) are still extruded.
    const withIpr = !!(t.ipr && !this.osmBuildings && ipr);
    const edges = this.driveBy.get(k) || [];
    const extrude = own.filter((b) => (!withIpr || b.noIpr) && !givesWay(b.rings))
      .map((b) => ({ ...b, base: Math.min(...b.rings[0].map(([x, y]) => hAt(x, y))), street: streetOf(b.rings[0], edges) }));
    // (An edge that changes level along itself is painted stretch by stretch.)
    const clipped = edges.flatMap((e) => byLevel(e).flatMap((part) => clipLine(part.pts, t.box).map((pts) => (
      { pts, u: e.u, v: e.v, hw: e.hw, lanes: e.lanes, oneway: e.oneway, width: e.width, surface: e.surface, bridge: e.bridge, tunnel: e.tunnel, maxspeed: e.maxspeed, named: !!e.name, name: e.bridge ? e.name ?? undefined : undefined, level: part.level }))));
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
    // The streets, paths and stairs on the ground: where one crosses a step in the
    // terrain, the step's edge is open (stepEdges.ts).
    // (And a bridge's ends: the last metres of the street before it are a flat terrace,
    // pipeline/structures.py's pads, a step over the ground under the bridge, which the
    // street goes on across onto the deck.)
    const crossers = [
      ...clipped.filter((e) => !e.bridge && !e.tunnel).map((e) => ({ pts: e.pts, half: e.width / 2 + 2.5, hw: 'drive' })),
      ...edges.flatMap((e) => bridgeApproaches(e).map((pts) => ({ pts, half: e.width / 2 + 2.5, hw: 'drive' }))),
      ...(this.walkBy.get(k) || []).filter((e) => !e.bridge && !e.tunnel).flatMap((e) => clipLine(e.pts, t.box).map((pts) => ({ pts, half: Math.max(1.5, e.width / 2 + 0.5), hw: e.hw }))),
    ];
    const outlines = t.buildings.filter(grounded).map((b) => ({ rings: b.rings }));
    const reservedAll = await this.furnitureReserved, reserved: number[] = [];
    for (let n = 0; reservedAll && n < reservedAll.length; n += 2) {
      const x = reservedAll[n], y = reservedAll[n + 1];
      if (x > x0 - 4 && x < x1 + 4 && y > y0 - 4 && y < y1 + 4) reserved.push(x, y);
    }
    const shapes: Shadower[] = t.buildings.filter(grounded).map((b) => ({ rings: b.rings, h: b.h }));
    const bounds: Bounds = [geo.minX, geo.minY, geo.maxX, geo.maxY];
    const source: TileSource = {
      t, size: data.size, origin: data.origin, bounds, ground, levels: tileLevels, masks: [], marks, hide,
      withIpr, ipr: withIpr ? ipr : null, extrude, clipped, parkingZones, standing: own.filter(grounded).map((b) => ({ rings: b.rings })),
      shapes, footprints: t.buildings.filter((b) => grounded(b) && !b.part).map((b) => ({ rings: b.rings, h: b.h })), trees: { matrices: new Float32Array(0), colours: new Float32Array(0), yearly: new Float32Array(0), outlines: new Float32Array(0), count: 0, big: 0, shrubs: 0, conifers: 0 },
    };
    // A tile that's in view as soon as it's loaded: its meshes' jobs go to the workers
    // along with this one.
    const early = this.shown.has(k) ? this.meshJobs(k, source) : null;
    early?.catch(() => {});
    const landJob = this.workers.run('land', {
      data: { size: data.size, origin: data.origin, areas: withPatches(t), roads: t.roads, buildings: outlines, walls: t.walls, fences: t.fences, sheds: t.sheds ?? [], trees: t.trees, shrubs: t.shrubs, canopy: t.canopy, utility: t.utility, passages: t.passages || [], levels: !!tileLevels, crossers, stepEdges: !location.search.includes('nostepedges'),
        walk: t.walk ?? [], reserved: new Float32Array(reserved), structures: structures.flatMap(s => s.polys), furnitureBuildings: [...t.buildings.map(b => ({ rings: b.rings })), ...hide.map(rings => ({ rings }))], furnitureEnabled: reservedAll !== null && !location.search.includes('nofurniture') },
      seeds: seedArray, ground, bridges: (tileLevels || []).filter((l) => l.kind === 'bridge').map((l) => l.heights),
      box: bounds, structures: tileLevels ? structures : [],
    }, [seedArray.buffer]);
    lap('send');
    const land = await landJob;
    if (this.loaded.has(k)) return this.loaded.get(k)!;
    lap('workers');
    source.masks = land.masks;
    source.trees = land.trees;
    // Where each level is, for getting about on it.
    const onLevels: TileLevel[] = land.masks.map((mask) => {
      const input = tileLevels?.find((l) => l.level === mask.level);
      return {
        level: mask.level, grid: new Grid(geo, RES, null, mask.cells),
        sample: input ? withRamps(heightSampler(input.heights.hm, t.box, input.heights.n, input.heights.step), input.ramps, this.ref) : () => NaN,
      };
    });
    const walls = wallMesh(land.walls);
    const fenceRows = fenceMeshes(land.fences);
    const sheds = shedMesh(land.sheds);
    const furniture = furnitureMeshes(land.furniture);
    const fenceSections = fences.sections(k, land.fences.sections, fenceRows);
    // The overhead wires over the tram tracks, at the height of the bridge deck a track
    // is on (as ground.ts lays the tracks) or of the ground: the deck the map names for
    // that stretch (deckRails), or with an older map the lowest one there.
    const decks = onLevels.filter((l) => l.level > 0).sort((a, b) => a.level - b.level);
    const railLevel = t.deckRails ? deckRailLevel(t.deckRails) : null;
    const trackAt = (x: number, y: number) => {
      const named = railLevel?.(x, y);
      for (const l of decks) {
        if ((railLevel && l.level !== named) || !l.grid.at(x, y)) continue;
        const h = l.sample(x, y);
        if (!Number.isNaN(h)) return h;
      }
      return hAt(x, y);
    };
    const roads = [...(t.roads.road || []), ...(t.roads.sett || []), ...(t.roads.dirt || [])];
    const { meshes: wires, posts: poles } = overheadWires(t.rails.filter((r) => r.kind === 'tram').map((r) => r.pts), outlines.map((b) => b.rings[0]), trackAt, hAt, (x, y) => roads.some((rings) => inPoly(x, y, rings)));
    const grid = new Grid(geo, RES, null, land.cells);
    lap('meshes');

    // The wires' poles stand among the lamp posts from now on: cars hit them, and park clear of them.
    for (const p of poles) posts.add(p);
    fences.add(fenceSections);
    const inside = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const parking = parkCarsSteps({
      data, edges, clearanceEdges, zones, buildings: location.search.includes('oldparking') ? null : nearBuildings, r: rng(Math.floor(hash(`${this.area}/${k}`) * 1e9)), night: this.night,
      shares: new Map((t.sections ?? []).map((s) => [s.code, s.share])), inside, height: shade?.sample,
      // No parking inside passages.
      solid: (x, y) => (inside(x, y) ? grid.at(x, y) !== 0 || inPassage(t.passages || [], x, y, 1) : false),
    });
    // A tile that update() asked for parks its cars a few milliseconds a frame (`jobs`);
    // the same cars as at once, only later. (`parking`: the time it took on the main
    // thread, `parkingWait`: the time between.)
    const { value: { cars }, busy } = sliced ? await this.sliced(parking) : { value: finish(parking), busy: 0 };
    lap('parking');
    if (sliced) { ms.parkingWait = ms.parking - Math.round(busy); ms.parking = Math.round(busy); }
    for (const c of cars) c.level = 0; // (nobody parks on a bridge or in a tunnel)
    const tile: Tile = {
      k, i: t.i, j: t.j, box: t.box, passages: t.passages || [], raised: t.buildings.filter((b) => !grounded(b)).map((b) => b.rings), grid, levels: onLevels, cars, ms,
      source, shown: false, dressing: null, drawn: null, drawMs: {}, drawAfter: 0, fixtures: [walls, fenceRows.fence, fenceRows.hedge, fenceRows.rail, ...(sheds ? [sheds] : []), ...wires],
      roads, crossers, poles, fences: fenceSections, furniture, relief: shade, sample: shade?.sample,
      water: (t.areas.water || []).map((rings) => {
        const xs = rings[0].map((p) => p[0]), ys = rings[0].map((p) => p[1]);
        return { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as Bounds };
      }),
      weirs: t.weirs || [],
    };
    const key = t.i * 65536 + t.j;
    try {
      this.loaded.set(k, tile);
      this.byIndex.set(key, tile);
      // The tile's buildings as shadow casters, for its own sky view and its neighbours':
      // their ground next to these buildings is worked out again.
      this.sky.set(key, { shapes, texture: null, tileBox: t.box, ground, refresh: null });
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (di || dj) this.refreshSky(t.i + di, t.j + dj);
      // The neighbours' hill shading along the shared edges, now that this side is known.
      if (shared) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.byIndex.get((t.i + di) * 65536 + t.j + dj)?.relief?.edges();
      this.last.i = NaN;
      this.terrainRevision++;
      this.onCars(cars, tile);
    } catch (error) {
      disposeFurniture(furniture);
      this.loaded.delete(k);
      this.byIndex.delete(key);
      this.last.i = NaN;
      this.terrainRevision++;
      this.sky.delete(key);
      throw error;
    }
    if (this.shown.has(k)) void this.dress(tile, early ?? undefined);
    return tile;
  }

  // The worker jobs for a tile's meshes: the ground's layers and the buildings.
  private async meshJobs(k: string, s: TileSource): MeshJobs {
    const w = this.workers, { t } = s;
    let buffer = s.ipr;
    s.ipr = null; // (handed over to a worker, so it can't be used twice)
    if (s.withIpr && !buffer) {
      buffer = await this.binary(k, 'ipr');
      validateTileBinary('ipr', buffer, { key: k, url: this.binaryUrl(k, 'ipr'), n: this.index.terrain?.n, tile: t });
    }
    const station = this.stationTracks ? (await this.stationTracks)?.[k] : undefined;
    return Promise.all([
      w.run('ground', {
        d: { areas: withPatches(t), roads: t.roads, rails: t.rails, deckRails: t.deckRails, bridgeTracks: t.bridgeTracks, station, weirs: t.weirs, crossings: TILE_LOOK.roadPaint ? t.crossings : [], marks: t.marks, utility: t.utility },
        paint: TILE_LOOK.roadPaint, rasterRoads: !this.ortho && !!s.ground && roadRasterEnabled(), box: s.bounds, edges: s.clipped, buildings: s.standing, parkingZones: s.parkingZones, ground: s.ground, levels: s.levels,
      }),
      buffer ? w.run('ipr', { buffer, box: t.box, absolute: this.index.iprRef != null, ground: s.ground, bbox: this.index.bbox_wgs84, hide: s.hide, clutter: ROOF_CLUTTER.value > 0.5, footprints: s.footprints }, [buffer]) : null,
      !s.withIpr || s.extrude.length ? w.run('roofs', { buildings: s.extrude, size: s.size, origin: s.origin, ground: s.ground, bbox: this.index.bbox_wgs84, water: t.areas?.water ?? [] }) : null,
    ]);
  }

  // Give a loaded tile its meshes (once, however many ask). If the tile has been left
  // behind or dropped by the time they're ready, they're thrown away.
  dress(tile: Tile, jobs?: MeshJobs): Promise<void> {
    tile.shown = true;
    if (tile.drawn) return Promise.resolve();
    if (!tile.dressing) {
      const started = performance.now(), k = tile.k;
      this.dressing.add(tile);
      tile.dressing = this.assemble(tile, jobs ?? this.meshJobs(k, tile.source))
        .then(() => { this.drawTimes.push(performance.now() - started); if (this.drawTimes.length > 256) this.drawTimes.shift(); })
        .catch((e) => {
          // Tried again after a pause, like a tile that failed to load.
          console.warn(`Tile ${k} could not be drawn`, e);
          telemetry.count('tileFailures');
          tile.drawAfter = performance.now() + 2000;
        })
        .finally(() => { this.dressing.delete(tile); tile.dressing = null; });
    }
    return tile.dressing;
  }

  private async assemble(tile: Tile, jobs: MeshJobs) {
    const { k, source: s } = tile, { t } = s, [x0, y0, x1, y1] = t.box, key = t.i * 65536 + t.j;
    const ms: Record<string, number> = tile.drawMs = {};
    let t0 = performance.now();
    const lap = (name: string) => { const t1 = performance.now(); ms[name] = Math.round(t1 - t0); t0 = t1; };
    const gone = () => !tile.shown || this.loaded.get(k) !== tile;
    // The landmarks drawn with this tile (each with one tile only, where it mostly is).
    const models = Promise.all(s.marks.filter((l) => l.home === k).map((l) => {
      if (!this.landmarkModels.has(l.name)) {
        this.landmarkModels.set(l.name, landmarkModel(dataUrl(this.area, `${l.file}`), l.plain).catch((e) => {
          console.warn(`Landmark ${l.name} could not be loaded`, e);
          return null;
        }));
      }
      return this.landmarkModels.get(l.name)!;
    }));
    const [{ layers }, iprArrays, roofArrays] = await jobs;
    const landmarks = (await models).filter((m): m is THREE.Group => m !== null);
    if (gone()) return;
    lap('workers');
    // How much sky the ground and the walls see: the ground's texture, and a value for each wall vertex.
    const arraysOf = [iprArrays, roofArrays].filter((arrays): arrays is BuildingArrays => arrays !== null);
    const skyBox = [x0, y0, x0 + Math.ceil(Math.max(x1 - x0, y1 - y0) / SKY_STEP) * SKY_STEP, y0 + Math.ceil(Math.max(x1 - x0, y1 - y0) / SKY_STEP) * SKY_STEP];
    const neighboursThen = this.neighbourCount(t.i, t.j);
    const skyResult = await this.workers.run('sky', {
      box: t.box, ground: s.ground, shapes: this.shadowersFor(t.i, t.j, s.shapes),
      // postMessage clones these read-only inputs; keep the originals for the meshes below.
      meshes: arraysOf.map((a) => ({ position: a.position, normal: a.normal, facade: a.facade })),
    }).catch((e) => { console.warn(`Sky view of tile ${k} failed`, e); return null; });
    const photo = this.ortho ? await this.photos.get(k) : null;
    const entry = this.sky.get(key);
    if (gone() || !entry) return;
    let skyTexture: THREE.DataTexture | null = null;
    // `&nosky` in the address leaves the sky view out, to compare with and without it.
    if (skyResult && !location.search.includes('nosky')) {
      skyTexture = new THREE.DataTexture(skyResult.texels, skyResult.n, skyResult.n, THREE.RedFormat, THREE.UnsignedByteType);
      skyTexture.unpackAlignment = 1;
      skyTexture.magFilter = skyTexture.minFilter = THREE.LinearFilter;
      skyTexture.needsUpdate = true;
    }
    entry.texture = skyTexture;
    // (A neighbour that came while the worker was busy is only known now.)
    if (this.neighbourCount(t.i, t.j) !== neighboursThen) this.refreshSky(t.i, t.j);
    lap('sky');

    const group = new THREE.Group();
    // Where each level is, for drawing what's on it.
    const levelMasks = new Map<number, { texture: THREE.DataTexture; box: number[] }>();
    for (const mask of s.masks) {
      const texture = new THREE.DataTexture(mask.cells, mask.w, mask.h, THREE.RedFormat, THREE.UnsignedByteType);
      texture.unpackAlignment = 1;
      texture.magFilter = texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      levelMasks.set(mask.level, { texture, box: [x0, y1, x0 + mask.w / RES, y1 - mask.h / RES] });
    }
    const shade = tile.relief, terrain = this.index.terrain;
    const surfaces = new Surfaces(layers, { time: this.time, relief: shade ? { texture: shade.texture, box: shade.box, sky: skyTexture ? { texture: skyTexture, box: skyBox } : null } : null, masks: levelMasks, photo: photo ? { texture: photo, box: [x0, y0, x1, y1] } : null });
    // Under a tunnel, the ground hides what's below it (the tunnel, the cars in it)
    // except round you (CUTAWAY): the ground's own layers are drawn without depth.
    const hidden = shade && terrain && tile.levels.some((l) => l.level < 0) ? depthOnlyGround(shade.hm, t.box, terrain.n, terrain.step,
      s.ground?.roadSurfaces?.length ? { sample: shade.sample, boxes: s.ground.roadSurfaces.map((p) => p.box) } : undefined) : null;
    if (hidden) group.add(hidden);
    const buildings = arraysOf.map((arrays, n) => buildingMesh(arrays, (skyResult && !location.search.includes('nosky') ? skyResult.walls[n] : null)));
    const smoke = iprArrays?.chimneys ? chimneySmoke(iprArrays.chimneys, this.scene) : null;
    group.add(surfaces.group, ...buildings, ...tile.fixtures, ...landmarks, ...tile.furniture);
    if (smoke) group.add(smoke);
    // Nothing in a tile ever moves: its matrices are worked out once, not every frame,
    // and the renderer's walk through the scene each frame skips the tile's objects.
    group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
    group.updateMatrixWorld(true);
    group.updateMatrixWorld = () => {};
    // Its turn to join the scene (at once while loading at the start or after a jump).
    if (!this.urgent) {
      await new Promise<void>((go) => this.turns.push(go));
      // Left behind meanwhile: thrown away the way it would have been once drawn.
      if (gone()) { tile.drawn = { group, surfaces, own: [...buildings, ...(hidden ? [hidden] : [])], smoke }; this.undress(tile); return; }
    }
    // The tree pages are leased last: if they can't be, nothing is left half done.
    this.trees.add(k, s.trees);
    if (this.street && !this.urgent) group.traverse((o) => { if (o !== group && o.visible && (o as THREE.Mesh).geometry) { o.visible = false; this.reveal.push(o); } });
    this.scene.add(group);
    tile.drawn = { group, surfaces, own: [...buildings, ...(hidden ? [hidden] : [])], smoke };
    lap('meshes');
  }

  // Take a tile's meshes away again; the tile stays loaded.
  undress(tile: Tile) {
    tile.shown = false;
    const drawn = tile.drawn;
    if (!drawn) return;
    tile.drawn = null;
    this.trees.remove(tile.k);
    this.scene.remove(drawn.group);
    // (The landmarks and what stays with the tile go into a new group next time.)
    drawn.group.clear();
    drawn.surfaces.dispose();
    if (drawn.smoke) dropChimneySmoke(drawn.smoke);
    const sky = this.sky.get(tile.i * 65536 + tile.j);
    if (sky) {
      sky.refresh?.drop();
      this.skyTotals.coalesced += sky.refresh?.coalesced ?? 0;
      this.skyTotals.cancelled += sky.refresh?.cancelled ?? 0;
      sky.refresh = null;
      sky.texture?.dispose();
      sky.texture = null;
    }
    for (const m of drawn.own) {
      m.geometry.dispose();
      if (Array.isArray(m.material)) m.material.forEach((material) => material.dispose());
      else m.material.dispose();
    }
    // What stays with the tile gives up its copy on the graphics card until it's drawn again.
    for (const m of tile.fixtures) m.geometry.dispose();
    tile.relief?.texture.dispose();
  }

  // The buildings of a tile and the tiles round it that can shade its ground: the outlines
  // reach only so far, so a building across the street in the next tile has to come from there.
  // Of the neighbours' buildings only those within the sky view's reach of this tile go along:
  // the rest were copied to the worker and filled into its height field for nothing (eight
  // tiles' worth for every job). Each building's box is worked out once.
  shadowersFor(i: number, j: number, own: Shadower[]): Shadower[] {
    const out = own.slice(), box = this.sky.get(i * 65536 + j)?.tileBox;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      for (const s of this.sky.get((i + di) * 65536 + j + dj)?.shapes ?? []) {
        if (!box) { out.push(s); continue; }
        let b = shadowerBox.get(s);
        if (!b) {
          b = [Infinity, Infinity, -Infinity, -Infinity];
          for (const [x, y] of s.rings[0]) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
          shadowerBox.set(s, b);
        }
        if (b[2] > box[0] - SKY_MARGIN && b[0] < box[2] + SKY_MARGIN && b[3] > box[1] - SKY_MARGIN && b[1] < box[3] + SKY_MARGIN) out.push(s);
      }
    }
    return out;
  }

  neighbourCount(i: number, j: number) {
    let n = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if ((di || dj) && this.sky.has((i + di) * 65536 + j + dj)) n++;
    return n;
  }

  // A tile's sky-view texture again, once a neighbour whose buildings it lacked has come.
  refreshSky(i: number, j: number) {
    const key = i * 65536 + j;
    const entry = this.sky.get(key);
    if (!entry?.texture) return;
    entry.refresh ??= new SkyRefresh<Uint8Array>((started) => {
      const job = this.workers.submit('sky', () => {
        started();
        return { box: entry.tileBox, ground: entry.ground, shapes: this.shadowersFor(i, j, entry.shapes), meshes: [] };
      }, [], 'optional');
      return { promise: job.promise.then((result) => result.texels), cancel: job.cancel };
    }, (texels) => {
      if (this.sky.get(key) !== entry || !entry.texture) return;
      (entry.texture.image.data as Uint8Array).set(texels);
      entry.texture.needsUpdate = true;
    });
    entry.refresh.request();
  }

  get streamingStats() {
    let coalesced = this.skyTotals.coalesced, cancelled = this.skyTotals.cancelled;
    for (const entry of this.sky.values()) {
      coalesced += entry.refresh?.coalesced ?? 0;
      cancelled += entry.refresh?.cancelled ?? 0;
    }
    return { ...this.workers.counts, coalesced, cancelled, buildTimes: this.buildTimes, drawTimes: this.drawTimes, drawn: [...this.loaded.values()].filter((t) => t.drawn).length };
  }

  private dropPhoto(k: string) {
    this.photos.get(k)?.then((tex) => tex?.dispose());
    this.photos.delete(k);
  }

  drop(k: string) {
    const t = this.loaded.get(k);
    if (!t) return;
    this.undress(t);
    disposeFurniture(t.furniture);
    this.sky.delete(t.i * 65536 + t.j);
    this.dropPhoto(k);
    for (const m of t.fixtures) {
      m.geometry.dispose();
      if (Array.isArray(m.material)) m.material.forEach((material) => material.dispose());
      else m.material.dispose();
    }
    for (const p of t.poles) posts.remove(p);
    fences.remove(t.fences);
    this.loaded.delete(k);
    this.byIndex.delete(t.i * 65536 + t.j);
    this.last.i = NaN;
    this.terrainRevision++;
    this.pending.delete(k);
    this.onDrop(t);
  }
}
