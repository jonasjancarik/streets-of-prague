import * as THREE from 'three';
import { onPolygons, signedArea } from './map/geo.ts';
import { WATER } from './terrain.ts';
import { roadProfileBounds } from './roadProfiles.ts';
import type { RoadProfile } from './roadProfiles.ts';
import { stepSides } from './stepEdges.ts';
import { TerrainStepIndex, cutTerrainSteps } from './terrain-cut.ts';
import { edgeHeightSampler, conformTerrainEdges } from './terrain-edges.ts';
import type { Terrace } from './terrain.ts';
import { offsetLine } from './network.ts';
import type { Point2, Bounds, Polygons } from './map/geo.ts';
import type { GroundLayer } from './surface.ts';
import { pavingRaster, refineRasterRoad, roadRasterGeometry, type RoadRaster } from './roadRaster.ts';
import { PITCH_LOOKS } from './map/pitches.ts';
import { coverGeometry } from './map/utility.ts';
import type { UtilityMark } from './map/utility.ts';
import type { StationTracks } from './stationTracks.ts';

export interface GroundTileData {
  areas: Record<string, Polygons | undefined>;
  roads: Record<string, Polygons | undefined>;
  rails: { kind: string; pts: Point2[] }[];
  // The stretches of tram track on a bridge, each with its level (pipeline/structures.py,
  // OnLevels), in a tile with bridges; not in older maps.
  deckRails?: { level: number; pts: Point2[] }[];
  bridgeTracks?: { level: number; pts: Point2[] }[];
  station?: StationTracks;
  weirs?: Point2[][];
  crossings?: Point2[][];
  marks?: Point2[][];
  utility?: UtilityMark[]; // surveyed covers and drains (pipeline/ipr_utility.py)
}
export interface LevelMask { level: number; w: number; h: number; cells: Uint8Array; box: Bounds }
export interface GroundResult { layers: GroundLayer[]; masks: LevelMask[] }
export interface GroundRoadEdge {
  u: string; v: string; hw: string; pts: Point2[]; width: number;
  lanes?: number | null; oneway?: boolean; bridge?: boolean; tunnel?: boolean; surface?: string;
  maxspeed?: number | null;
  named?: boolean; // false: the map gives it no street name (true or unknown otherwise)
  name?: string; // on a bridge: the street's name (for BALUSTRADES)
  level?: number; // on a bridge or in a tunnel: its level, where the map says (see groundLayers)
}
// side: at a step in the ground, which side's height (terrain.ts, heightSampler).
type HeightAt = (x: number, y: number, side?: number | boolean) => number;
// A bridge or tunnel level of the tile, with its height at a point (NaN off it).
export interface GroundLevel { level: number; kind: 'bridge' | 'tunnel'; polys: Polygons; height: HeightAt }
type GroundGeometry = GroundLayer['geometry'];

// The present-day ground as real geometry: one mesh per surface kind, triangulated
// from OSM polygons, coloured by procedural shaders (shading.ts). Paint, rails and
// kerb lines are thin strips on top. Layers are drawn in a fixed order with no depth
// writes, so they never z-fight however far the camera pulls back.
//
// This part only works out the geometry, as plain arrays, so it runs in the tile
// workers (tileWorker.ts); surface.ts makes the meshes.

export const COLORS = {
  pavement: '#92908c', square: '#d7d3cb', squareSetts: '#9c958a', path: '#d8cbb6', dirt: '#bfa87e', worn: '#b49f72',
  park: '#79a24c', garden: '#80a552', wood: '#394a2b', orchard: '#89a858', pitch: '#6c9c55',
  field: '#b9b27a', yard: '#a9a69e', dtmYard: '#85837e', ballast: '#99948a', bare: '#bba888',
  water: '#4d7680', pool: '#62aec2', asphalt: '#6b6a68', sett: '#8a847a', parking: '#72706c',
  bed: '#6f5b43', shrubBed: '#5d6b3c', iron: '#3f3d3b',
  bridge: '#6d6c6a', trackbed: '#8a8a85', steel: '#3a3b3d', paint: '#efede4', kerb: '#aba79e',
  quay: '#7c776c', funicular: '#6e6a62', slab: '#8e8b84', tunnel: '#46484c', tunnelWall: '#a59f93',
};
// Paint of parking bays by paid-parking zone: [zone, colour, dashes].
const BAY_PAINT: [string | null, string, Point2 | null][] = [
  ['RES', '#3d7be0', null], ['MIX', COLORS.paint, [1, 1]], ['VIS', COLORS.paint, [1, 1]], [null, COLORS.paint, null],
];

// Land with a use but no mapped surface (osm_area.py): fields, work yards, railway
// land, ground being dug up. Drawn just above the plain base, under everything else.
const LAND_USE: [string, string][] = [
  ['field', 'field'], ['yard', 'concrete'], ['ballast', 'gravel'], ['bare', 'dirt'],
];
const WOOD_EDGE_WIDTH = 6, WOOD_EDGE_SHADE = 0.5, WOOD_EDGE_MIN_AREA = 1500;
// Surveyed courtyards and greenery fill unmapped ground. OSM and photo cover
// remain above these layers wherever their more specific shapes overlap.
const DTM_LAND: [string, string, string][] = [
  ['dtm_yard', COLORS.dtmYard, 'concrete'],
  ['dtm_green', COLORS.park, 'lawn'], ['dtm_garden', COLORS.garden, 'garden'],
  ['dtm_wood', COLORS.wood, 'wood'], ['dtm_pitch', COLORS.pitch, 'pitch'],
];
// What the aerial photographs say the unmapped ground is made of (ground_cover.py,
// layers.merge_cover), above those and under everything mapped. Tree canopy comes
// as wood.
const COVER: [string, string, string][] = [
  ['cover_grass', '#8fa860', 'grass'],
  ['cover_dirt', '#b39d78', 'dirt'], ['cover_gravel', '#a39d92', 'gravel'],
  ['cover_concrete', '#aeaaa0', 'concrete'], ['cover_paving', '#b7b0a3', 'slabs'],
  ['cover_asphalt', '#6e7174', 'asphalt'],
];

function polygons(polys: Polygons, raster: RoadRaster | null = null): GroundGeometry {
  const pos: number[] = [], idx: number[] = [];
  for (const rings of polys) {
    const contour = rings[0].map(([x, y]) => new THREE.Vector2(x, y));
    const holes = rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
    const base = pos.length / 3;
    for (const v of [contour, ...holes].flat()) pos.push(v.x, 0, -v.y);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) idx.push(base + a, base + b, base + c);
  }
  return finish(pos, idx, null, raster);
}

// Quads along polylines, `w` metres wide. `dash` = [on, off] in metres for dashed lines.
// `hold`: the strip keeps a width in pixels when seen from high up (held in shading.ts).
function strips(lines: Point2[][], w: number, dash: Point2 | null = null, hold = false): GroundGeometry {
  const pos: number[] = [], idx: number[] = [];
  const quad = (a: Point2, b: Point2) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = ((b[1] - a[1]) / len) * w / 2, ny = (-(b[0] - a[0]) / len) * w / 2;
    const i = pos.length / 3;
    pos.push(a[0] + nx, 0, -(a[1] + ny), a[0] - nx, 0, -(a[1] - ny), b[0] - nx, 0, -(b[1] - ny), b[0] + nx, 0, -(b[1] + ny));
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  for (const pts of lines) {
    if (!dash) {
      // Extend each segment by half the width so joints overlap instead of gapping.
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ex = ((b[0] - a[0]) / len) * w * 0.5, ey = ((b[1] - a[1]) / len) * w * 0.5;
        quad(i ? [a[0] - ex, a[1] - ey] : a, i < pts.length - 2 ? [b[0] + ex, b[1] + ey] : b);
      }
      continue;
    }
    const [on, off] = dash;
    let s = 0, drawing = true, left = on;
    for (let i = 0; i < pts.length - 1; i++) {
      let a = pts[i];
      const b = pts[i + 1];
      let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (seg > 1e-6) {
        const step = Math.min(seg, left);
        const t = step / seg;
        const c: Point2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (drawing) quad(a, c);
        a = c;
        seg -= step;
        left -= step;
        s += step;
        if (left <= 1e-6) { drawing = !drawing; left = drawing ? on : off; }
      }
    }
  }
  const g = finish(pos, idx);
  if (!hold) return g;
  // Each vertex's offset from the centre line it was drawn along (finish() adds vertices
  // where the strip crosses the terrain's grid, so they are measured afterwards).
  const segs: number[] = [];
  for (const pts of lines) for (let i = 0; i < pts.length - 1; i++) segs.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  const P = g.position, out = new Float32Array(P.length);
  for (let v = 0; v < P.length; v += 3) {
    const x = P[v], y = -P[v + 2];
    let best = Infinity, ox = 0, oy = 0;
    for (let k = 0; k < segs.length && best > 1e-6; k += 4) {
      const ax = segs[k], ay = segs[k + 1], dx = segs[k + 2] - ax, dy = segs[k + 3] - ay;
      if (Math.abs(x - ax) > w + Math.abs(dx) && Math.abs(x - segs[k + 2]) > w + Math.abs(dx)) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const qx = x - ax - dx * t, qy = y - ay - dy * t, d = qx * qx + qy * qy;
      if (d < best) { best = d; ox = qx; oy = qy; }
    }
    out[v] = ox; out[v + 1] = -oy; out[v + 2] = w;
  }
  return { ...g, hold: out };
}

// A soft band just outside each ring, fading from `alpha` at the ring to 0.
function skirts(ringsList: Polygons, width: number, outside: boolean, skip: (a: Point2, b: Point2) => boolean = () => false): GroundGeometry {
  const pos: number[] = [], alpha: number[] = [], idx: number[] = [];
  for (const rings of ringsList) {
    rings.forEach((ring, k) => {
      const ccw = signedArea(ring) > 0;
      // Outer rings fade outwards, holes (courtyards) fade into the hole.
      const d = (k === 0) === ccw ? width : -width;
      const closed = [...ring, ring[0], ring[1]];
      const off = offsetLine(closed, outside ? d : -d).slice(1, -1);
      const inner = closed.slice(1, -1);
      const n = inner.length;
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        pos.push(inner[i][0], 0, -inner[i][1], off[i][0], 0, -off[i][1]);
        alpha.push(1, 0);
      }
      for (let i = 0; i < n; i++) {
        if (skip(inner[i], inner[(i + 1) % n])) continue;
        const a = base + i * 2, b = base + ((i + 1) % n) * 2;
        idx.push(a, a + 1, b + 1, a, b + 1, b);
      }
    });
  }
  return finish(pos, idx, alpha);
}

// Split every edge longer than `max` metres (in halves, repeatedly) so a flat mesh can
// follow the terrain. The decision is per edge, so neighbours split the same edges and
// no cracks open between them. `extra`: an optional per-vertex value to interpolate.
// `also(i, j, d2)`: another reason to split an edge (d2: its length squared).
function subdivide(pos: number[], idx: number[], extra: number[] | null, max: number, also: ((i: number, j: number, d2: number) => boolean) | null = null) {
  const max2 = max * max;
  for (let pass = 0; pass < 12; pass++) {
    const mids = new Map<number, number>();
    const long = (i: number, j: number) => {
      const dx = pos[i * 3] - pos[j * 3], dz = pos[i * 3 + 2] - pos[j * 3 + 2], d2 = dx * dx + dz * dz;
      return d2 > max2 || (!!also && also(i, j, d2));
    };
    const mid = (i: number, j: number) => {
      const k = i < j ? i * 4194304 + j : j * 4194304 + i;
      let m = mids.get(k);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push((pos[i * 3] + pos[j * 3]) / 2, 0, (pos[i * 3 + 2] + pos[j * 3 + 2]) / 2);
        if (extra) extra.push((extra[i] + extra[j]) / 2);
        mids.set(k, m);
      }
      return m;
    };
    const out: number[] = [];
    let split = false;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const s0 = long(a, b), s1 = long(b, c), s2 = long(c, a);
      if (!s0 && !s1 && !s2) { out.push(a, b, c); continue; }
      split = true;
      const m0 = s0 ? mid(a, b) : -1, m1 = s1 ? mid(b, c) : -1, m2 = s2 ? mid(c, a) : -1;
      if (s0 && s1 && s2) out.push(a, m0, m2, m0, b, m1, m2, m1, c, m0, m1, m2);
      else if (s0 && s1) out.push(m0, b, m1, a, m0, m1, a, m1, c);
      else if (s1 && s2) out.push(m1, c, m2, a, b, m1, a, m1, m2);
      else if (s0 && s2) out.push(a, m0, m2, m0, b, c, m0, c, m2);
      else if (s0) out.push(a, m0, c, m0, b, c);
      else if (s1) out.push(a, b, m1, a, m1, c);
      else out.push(a, b, m2, m2, b, c);
    }
    idx = out;
    if (!split) break;
  }
  return idx;
}

// Set while a Surfaces is being built: terrain height (m) at a point, or null for flat.
let groundHeight: HeightAt | null = null;
// Set while the ground of a tile with steps in it is built (banks, retaining walls: see
// pointLabels in terrain.ts): the label of the side a point is on (the water, a terrace
// or the plain ground), and the outlines the steps run along. Every layer is cut along
// them, so the ground on each side lies at its own height right up to the step.
let sideOf: ((x: number, y: number) => number) | null = null;
let terraceOutlines: Polygons = []; // (the water's among them)
let stepIndex: TerrainStepIndex | null = null;
let groundBox: Bounds | null = null;
let roadBoxes: Bounds[] | null = null;
const ROAD_FINE = 2; // m between draped samples in the experimental corridor
// Set while the water itself is built: all of it lies at the water's level.
let afloat = false;
const STEP_FINE = 2; // m between a layer's points along a step, so the cut follows its bends
const WALL_MIN = 0.03; // m: a step lower than this gets no wall

function refineRoad(pos: number[], i: number, j: number, d2: number) {
  if (!roadBoxes || d2 <= ROAD_FINE * ROAD_FINE) return false;
  const ax = pos[i * 3], ay = -pos[i * 3 + 2], bx = pos[j * 3], by = -pos[j * 3 + 2];
  for (const [x0, y0, x1, y1] of roadBoxes) {
    if (Math.min(ax, bx) <= x1 && Math.max(ax, bx) >= x0
        && Math.min(ay, by) <= y1 && Math.max(ay, by) >= y0) return true;
  }
  return false;
}

// Keep the ordinary 8 m mesh away from steps, with closer samples along them.
// The actual cuts follow every outline, including narrow enclosed terraces and
// three levels meeting; triangle-corner labels alone cannot detect those cases.
function cutAtSteps(pos: number[], idx: number[], extra: number[] | null, at: (x: number, y: number) => number,
  refineRoads: ((i: number, j: number, d2: number) => boolean) | null) {
  const side: number[] = [];
  const sideAt = (i: number) => (side[i] ??= at(pos[i * 3], -pos[i * 3 + 2]));
  const crossesStep = (i: number, j: number, d2: number) => d2 > STEP_FINE * STEP_FINE && sideAt(i) !== sideAt(j);
  const refine = refineRoads ? (i: number, j: number, d2: number) => crossesStep(i, j, d2) || refineRoads(i, j, d2) : crossesStep;
  idx = subdivide(pos, idx, extra, 8, refine);
  return cutTerrainSteps(pos, idx, extra, at, stepIndex!);
}

// The walls at the steps: along the outlines of the water and the terraces, between the
// heights of the ground on either side (a quay wall, a retaining wall; a natural bank is
// hardly a step), facing the lower side.
function stepWalls(lines: Point2[][]): GroundGeometry {
  const q = quads(), H = groundHeight, at = sideOf;
  if (!H || !at) return polygons([]);
  for (const pts of lines) {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      // The sides on the left of a → b and on its right.
      const nx = -dy / len, ny = dx / len, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const left = at(mx + nx * 0.2, my + ny * 0.2), right = at(mx - nx * 0.2, my - ny * 0.2);
      if (left === right) continue;
      const n = Math.max(1, Math.ceil(len / STEP_FINE));
      for (let k = 0; k < n; k++) {
        const p = [a[0] + dx * (k / n), a[1] + dy * (k / n)], r = [a[0] + dx * ((k + 1) / n), a[1] + dy * ((k + 1) / n)];
        const pl = H(p[0], p[1], left), pr = H(p[0], p[1], right), rl = H(r[0], r[1], left), rr = H(r[0], r[1], right);
        if (Math.abs(pl - pr) < WALL_MIN && Math.abs(rl - rr) < WALL_MIN) continue;
        // A bank lower than the water (a slipway, a quay awash in the terrain model) has
        // no wall: it would face the land, and show from the water as a hole in the bank.
        if (left === WATER ? pl + rl > pr + rr : right === WATER && pr + rr > pl + rl) continue;
        const P0 = [p[0], Math.min(pl, pr), -p[1]], P1 = [p[0], Math.max(pl, pr), -p[1]];
        const R0 = [r[0], Math.min(rl, rr), -r[1]], R1 = [r[0], Math.max(rl, rr), -r[1]];
        // Facing the lower side: the wall is drawn from there only.
        const out = pl + rl < pr + rr ? 1 : -1;
        const normal = [nx * out, 0, -ny * out];
        if (out > 0) q.quad(R0, P0, P1, R1, normal); else q.quad(P0, R0, R1, P1, normal);
      }
    }
  }
  return joined(polygons([]), q);
}

function finish(pos: number[], idx: number[], extra: number[] | null = null, raster: RoadRaster | null = null): GroundGeometry {
  // Wind every triangle to face up, so lighting never sees a back face.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const up = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    if (up < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
  if (groundHeight) {
    let side: number[] | null = null;
    const refineRaster = raster ? refineRasterRoad(pos, raster, groundHeight, sideOf) : null;
    const refine = !afloat && (roadBoxes || refineRaster)
      ? (i: number, j: number, d2: number) => refineRoad(pos, i, j, d2) || !!refineRaster?.(i, j, d2) : null;
    if (sideOf && !afloat) ({ pos, idx, side, extra } = cutAtSteps(pos, idx, extra, sideOf, refine));
    else idx = subdivide(pos, idx, extra, 8, refine);
    if (groundBox) ({ pos, idx, extra, side } = conformTerrainEdges(pos, idx, extra, side, groundBox, STEP_FINE));
    for (let i = 0, k = 0; i < pos.length; i += 3, k++) pos[i + 1] = groundHeight(pos[i], -pos[i + 2], afloat ? WATER : side ? side[k] : false);
  }
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  return { position: new Float32Array(pos), normal: nor, index: new Uint32Array(idx), ...(extra ? { alpha: new Float32Array(extra) } : {}) };
}

// Every ground layer of a tile, in drawing order: { order, geometry, color, pattern }
// for a surface ("blend": drawn see-through, like the bridges' shadows) and
// { order, geometry, shade } for the soft shading at shores and round buildings.
// `d`: the tile's areas, roads, rails, weirs and crossings; `box`: its extent;
// `edges`: car network edges for the centre lines (already clipped to the tile);
// `buildings`: the ones to shade round; `parkingZones`: the paid-parking category
// of each parking area (or null); `height`: terrain height at a point, or null.
//
// With `levels` (the tile's bridges and tunnels, pipeline/structures.py), the ground
// stays bare under the bridges and over the tunnels, and each level comes on its own:
// - a bridge level as a slab ({ ..., slab: true }, with its edges and parapets) and
//   what's on it ({ ..., deck: true }: its surface, tram tracks, road paint);
// - a tunnel level as its floor, walls and road paint ({ ..., tunnel: true }), under
//   the ground, where the game only shows it round you when you're in it.
// Each such layer has its `level`, and the game draws what's on it only where that
// level's mask (in `masks`: the level rasterised, rows from the north) says it is.
//
// `steps`: the terrain knows the steps in it (the tile's terraces; its water is in `d`),
// so the layers are cut along them and the steps get walls (see `sideOf`).
export function groundLayers(d: GroundTileData, { box, edges = [], buildings = [], parkingZones = [], height = null, levels = null, steps = null, roadProfile, roadSurfaceBoxes, paint = true, rasterRoads = false }: {
  box: Bounds; edges?: GroundRoadEdge[]; buildings?: { rings: Point2[][] }[];
  parkingZones?: (string | null)[]; height?: HeightAt | null; levels?: GroundLevel[] | null; steps?: Terrace[] | null;
  // false: no lane lines (see TILE_LOOK in tiles.ts)
  paint?: boolean;
  roadProfile?: RoadProfile;
  roadSurfaceBoxes?: Bounds[];
  rasterRoads?: boolean;
}): GroundResult {
  paintRoads = paint;
  // The steps in the terrain: which side a point is on, and their outlines (stepEdges.ts).
  const sides = height ? stepSides(steps, d.areas.water ?? []) : null;
  const at: typeof sideOf = sides?.at ?? null, outlines = sides?.outlines ?? [];
  const stepped = <R>(build: () => R): R => {
    groundHeight = height ? edgeHeightSampler(height, box, STEP_FINE) : null;
    groundBox = height ? box : null;
    roadBoxes = height ? roadSurfaceBoxes ?? (roadProfile ? [roadProfileBounds(roadProfile)] : null) : null;
    sideOf = at;
    terraceOutlines = outlines;
    stepIndex = at ? new TerrainStepIndex(outlines) : null;
    try { return build(); } finally { groundHeight = sideOf = null; terraceOutlines = []; stepIndex = null; groundBox = roadBoxes = null; }
  };
  if (!levels) return { layers: stepped(() => layers(d, { box, edges, buildings, parkingZones, rasterRoads })), masks: [] };
  const T = height || (() => 0);
  // (A street on the ground with a level is on a bridge over an underpass's cutting
  // there, pipeline/structures.py's cuttings: painted on its deck.)
  const onDeck = (e: GroundRoadEdge) => !e.tunnel && (e.level === undefined ? !!e.bridge : e.level > 0);
  const lower = stepped(() => layers(d, { box, edges: edges.filter((e) => !onDeck(e) && !e.tunnel), buildings, parkingZones, bridges: false, rasterRoads }));
  const masks = levels.map((l) => levelMask(box, l.polys, l.level));
  const on = (k: number, x: number, y: number) => onMask(masks[k], x, y);
  // Each street on a bridge or in a tunnel is painted on one level, and each stretch of
  // tram track on a bridge lies on one: the level the map gives it (`level`,
  // `deckRails`: where two bridges cross, the outlines alone can't say which deck). A
  // map from before it did: the level most of the street lies on (not a flyover it
  // passes under), and for the tracks the lowest bridge they're on.
  const indexOf = new Map(levels.map((l, i) => [l.level, i]));
  const paintOn = new Map<number, GroundRoadEdge[]>();
  for (const e of edges) {
    if (!onDeck(e) && !e.tunnel) continue;
    const k = e.level !== undefined && indexOf.has(e.level) ? indexOf.get(e.level)! : mostlyOn(e.pts, (x, y) => levels.map((l, i) => (l.kind === (onDeck(e) ? 'bridge' : 'tunnel') && on(i, x, y) ? i : -1)).filter((i) => i >= 0));
    if (k >= 0) paintOn.set(k, [...(paintOn.get(k) || []), e]);
  }
  const trams = d.rails.filter((r) => r.kind === 'tram').map((r) => r.pts);
  let tramsOn = new Map<number, Point2[][]>();
  if (d.deckRails) {
    for (const r of d.deckRails) {
      const k = indexOf.get(r.level);
      if (k !== undefined) tramsOn.set(k, [...(tramsOn.get(k) || []), r.pts]);
    }
  } else {
    tramsOn = splitByLevel(trams, (x, y) => {
      let best = -1;
      levels.forEach((l, i) => { if (l.kind === 'bridge' && on(i, x, y) && (best < 0 || l.level < levels[best].level)) best = i; });
      return best;
    });
  }
  const upper: GroundLayer[] = [];
  const railway = new Map<number, Point2[][]>();
  for (const track of d.station?.bridgeTracks ?? d.bridgeTracks ?? []) {
    const lines = railway.get(track.level);
    if (lines) lines.push(track.pts); else railway.set(track.level, [track.pts]);
  }
  try {
    levels.forEach((l, k) => {
      const H = (x: number, y: number) => { const h = l.height(x, y); return Number.isNaN(h) ? T(x, y) : h; };
      if (l.kind === 'bridge') {
        groundHeight = H;
        const stone = (paintOn.get(k) || []).some((e) => !!e.name && BALUSTRADES.has(e.name));
        upper.push(...deckSlab(l.polys, box, masks[k], H, T, l.level, stone));
        // What's on the deck floats a hand's breadth above the slab: they're
        // triangulated differently, so they'd cut into each other.
        groundHeight = (x: number, y: number) => H(x, y) + 0.12;
        upper.push(...deckLayers(l.polys, tramsOn.get(k) || [], paintOn.get(k) || [], l.level, railway.get(l.level), !!d.station));
      } else {
        groundHeight = H;
        upper.push(...tunnelLayers(l.polys, box, masks[k], H, T, paintOn.get(k) || [], l.level));
      }
    });
  } finally { groundHeight = null; }
  return { layers: [...lower, ...upper], masks };
}

// The typed arrays in a tile's ground, to hand them over from a worker without copying.
export const layerBuffers = ({ layers, masks }: GroundResult): ArrayBuffer[] => {
  const buffers = [
    ...layers.flatMap((l) => [...Object.values(l.geometry).map((a) => a.buffer), ...(l.raster ? [l.raster.cells.buffer] : [])]),
    ...masks.map((m) => m.cells.buffer),
  ];
  if (buffers.some((buffer) => !(buffer instanceof ArrayBuffer))) throw new Error('Ground transfer requires ArrayBuffer storage');
  return buffers as ArrayBuffer[];
};

export const DECK_RES = 2; // level mask cells per metre

// A level rasterised: 255 where it is, 0 elsewhere, rows from the north.
export function levelMask([x0, y0, x1, y1]: Bounds, polys: Polygons, level: number): LevelMask {
  const w = Math.ceil((x1 - x0) * DECK_RES), h = Math.ceil((y1 - y0) * DECK_RES);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Cannot create level mask canvas');
  ctx.fillStyle = '#fff';
  for (const rings of polys) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo']((x - x0) * DECK_RES, (y1 - y) * DECK_RES));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  const img = ctx.getImageData(0, 0, w, h).data, cells = new Uint8Array(w * h);
  for (let i = 0; i < cells.length; i++) cells[i] = img[i * 4] > 127 ? 255 : 0;
  return { level, w, h, cells, box: [x0, y0, x1, y1] };
}

const onMask = (mask: LevelMask, x: number, y: number) => {
  const [x0, , , y1] = mask.box;
  const i = Math.floor((x - x0) * DECK_RES), j = Math.floor((y1 - y) * DECK_RES);
  return i >= 0 && j >= 0 && i < mask.w && j < mask.h && mask.cells[j * mask.w + i] > 0;
};

// Points every 3 m along a line.
function along(pts: Point2[], step = 3): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 0; s < n; s++) out.push([ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n]);
  }
  return out;
}

// Which of the levels `at(x, y)` lists a line mostly lies on (-1: none).
function mostlyOn(pts: Point2[], at: (x: number, y: number) => number[]) {
  const count = new Map<number, number>();
  for (const [x, y] of along(pts)) for (const k of at(x, y)) count.set(k, (count.get(k) || 0) + 1);
  let best = -1, most = 0;
  for (const [k, n] of count) if (n > most) { best = k; most = n; }
  return best;
}

// Lines cut into the stretches on each level (`level(x, y)`: -1 for none).
function splitByLevel(lines: Point2[][], level: (x: number, y: number) => number) {
  const out = new Map<number, Point2[][]>();
  for (const pts of lines) {
    let cur: Point2[] | null = null, curK = -1;
    const ps = [...along(pts, 4), pts[pts.length - 1]];
    for (let i = 0; i < ps.length - 1; i++) {
      const a = ps[i], b = ps[i + 1], k = level((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      if (k !== curK) {
        if (cur && curK >= 0) out.set(curK, [...(out.get(curK) || []), cur]);
        cur = k >= 0 ? [a] : null;
        curK = k;
      }
      cur?.push(b);
    }
    if (cur && curK >= 0) out.set(curK, [...(out.get(curK) || []), cur]);
  }
  return out;
}

const FASCIA = 1.2; // m: the deck's edge below its surface
export const PARAPET = 1.0; // m: the parapet above it
export const PARAPET_W = 0.35;
const TUNNEL_H = 5.5; // m: a tunnel's walls

// Along every open side of a level's outline (not where it meets the ground or
// carries on as another part of the level, nor along the tile's border, where it
// carries on in the next tile), `wall(a, b, ha, hb, out)` with the side's ends, their
// heights and the way out of the level.
function openSides(polys: Polygons, [x0, y0, x1, y1]: Bounds, mask: LevelMask, H: HeightAt, T: HeightAt,
  wall: (a: Point2, b: Point2, ha: number, hb: number, ox: number, oy: number) => void) {
  const cut = (a: Point2, b: Point2) => ([[0, x0], [0, x1], [1, y0], [1, y1]] as [0 | 1, number][]).some(([k, v]) => Math.abs(a[k] - v) < 0.05 && Math.abs(b[k] - v) < 0.05);
  for (const rings of polys) {
    for (const ring of rings) {
      for (let r = 0; r < ring.length; r++) {
        const p = ring[r], q = ring[(r + 1) % ring.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 0.05 || cut(p, q)) continue;
        const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
        const n = Math.ceil(len / 3);
        for (let s = 0; s < n; s++) {
          const a: Point2 = [p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n];
          const b: Point2 = [p[0] + ((q[0] - p[0]) * (s + 1)) / n, p[1] + ((q[1] - p[1]) * (s + 1)) / n];
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          // Which side is off the level; neither or both: not an open side.
          const left = onMask(mask, mx - uy * 0.8, my + ux * 0.8), right = onMask(mask, mx + uy * 0.8, my - ux * 0.8);
          if (left === right) continue;
          // Where the level runs at the height of the ground there's no side to see.
          if (Math.abs(H(mx, my) - T(mx, my)) < 1.2) continue;
          wall(a, b, H(a[0], a[1]), H(b[0], b[1]), left ? uy : -uy, left ? -ux : ux);
        }
      }
    }
  }
}

function quads(facing = false) {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  return {
    pos, nor, idx,
    quad(a: number[], b: number[], c: number[], d: number[], n: number[]) {
      const i = pos.length / 3;
      pos.push(...a, ...b, ...c, ...d);
      for (let k = 0; k < 4; k++) nor.push(...n);
      // With `facing`, wound to face its normal: a double-sided material lights a back
      // face from behind, which reads as dark.
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const f = (u[1] * v[2] - u[2] * v[1]) * n[0] + (u[2] * v[0] - u[0] * v[2]) * n[1] + (u[0] * v[1] - u[1] * v[0]) * n[2];
      if (facing && f < 0) idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
      else idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    },
  };
}

// A surface (draped by finish) and walls in one geometry.
function joined(top: GroundGeometry, q: ReturnType<typeof quads>): GroundGeometry {
  const base = top.position.length / 3;
  return {
    position: new Float32Array([...top.position, ...q.pos]),
    normal: new Float32Array([...top.normal, ...q.nor]),
    index: new Uint32Array([...top.index, ...q.idx.map((i) => i + base)]),
  };
}

// Bridges whose parapet is a stone balustrade, by the name of the street over them:
// a rail on short balusters between pillars, each pillar with a stone ball on top. From
// above that's the rail with the pillars and balls along it, and a shadow with light
// through it.
const BALUSTRADES = new Set(['most Legií']);
const RAIL_W = 0.42, PLINTH = 0.2, RAIL = 0.8, BALUSTER = 0.3, PILLAR = 3.2, BALL = 0.21;

// A bridge level as a solid slab: its surface, the edge below it and a parapet along
// every open side (a balustrade, with `stone`).
function deckSlab(polys: Polygons, box: Bounds, mask: LevelMask, D: HeightAt, T: HeightAt, level: number, stone = false): GroundLayer[] {
  const q = quads(true);
  let run = 0; // how far along the parapet, for the pillars
  openSides(polys, box, mask, D, T, (a, b, ha, hb, ox, oy) => {
    const out = [ox, 0, -oy], inn = [-ox, 0, oy];
    if (!stone) {
      const ia = [a[0] - ox * PARAPET_W, a[1] - oy * PARAPET_W], ib = [b[0] - ox * PARAPET_W, b[1] - oy * PARAPET_W];
      q.quad([a[0], ha - FASCIA, -a[1]], [b[0], hb - FASCIA, -b[1]], [b[0], hb + PARAPET, -b[1]], [a[0], ha + PARAPET, -a[1]], out);
      q.quad([ib[0], hb, -ib[1]], [ia[0], ha, -ia[1]], [ia[0], ha + PARAPET, -ia[1]], [ib[0], hb + PARAPET, -ib[1]], inn);
      q.quad([a[0], ha + PARAPET, -a[1]], [b[0], hb + PARAPET, -b[1]], [ib[0], hb + PARAPET, -ib[1]], [ia[0], ha + PARAPET, -ia[1]], [0, 1, 0]);
      return;
    }
    q.quad([a[0], ha - FASCIA, -a[1]], [b[0], hb - FASCIA, -b[1]], [b[0], hb, -b[1]], [a[0], ha, -a[1]], out);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    // A point `s` along the side and `c` in from its edge, `z` above the deck there.
    const at = (s: number, c: number, z: number) => [a[0] + ux * s - ox * c, ha + ((hb - ha) * s) / len + z, -(a[1] + uy * s - oy * c)];
    const block = (s0: number, s1: number, c0: number, c1: number, z0: number, z1: number) => {
      q.quad(at(s0, c0, z1), at(s1, c0, z1), at(s1, c1, z1), at(s0, c1, z1), [0, 1, 0]);
      q.quad(at(s0, c0, z0), at(s1, c0, z0), at(s1, c0, z1), at(s0, c0, z1), out);
      q.quad(at(s1, c1, z0), at(s0, c1, z0), at(s0, c1, z1), at(s1, c1, z1), inn);
      q.quad(at(s1, c0, z0), at(s1, c1, z0), at(s1, c1, z1), at(s1, c0, z1), [ux, 0, -uy]);
      q.quad(at(s0, c1, z0), at(s0, c0, z0), at(s0, c0, z1), at(s0, c1, z1), [-ux, 0, uy]);
    };
    block(0, len, 0, RAIL_W, 0, PLINTH);
    block(0, len, 0, RAIL_W, RAIL, RAIL + 0.16);
    for (let s = BALUSTER / 2; s < len; s += BALUSTER) block(s - 0.07, s + 0.07, 0.13, RAIL_W - 0.13, PLINTH, RAIL);
    for (let k = Math.ceil(run / PILLAR); k * PILLAR < run + len; k++) {
      const s = k * PILLAR - run, top = RAIL + 0.28;
      block(s - 0.26, s + 0.26, -0.04, RAIL_W + 0.04, 0, top);
      // The ball, on a short neck.
      const [cx, cy, cz] = at(s, RAIL_W / 2, top + 0.06 + BALL);
      block(s - 0.08, s + 0.08, RAIL_W / 2 - 0.08, RAIL_W / 2 + 0.08, top, top + 0.08);
      const ring = (i: number, j: number) => {
        const th = (Math.PI * j) / 4, ph = (Math.PI * 2 * i) / 8;
        const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
        return { p: [cx + n[0] * BALL, cy + n[1] * BALL, cz + n[2] * BALL], n };
      };
      for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) {
        const p = [ring(i, j), ring(i + 1, j), ring(i + 1, j + 1), ring(i, j + 1)];
        const m = ring(i + 0.5, j + 0.5).n;
        q.quad(p[3].p, p[2].p, p[1].p, p[0].p, m);
      }
    }
    run += len;
  });
  const geometry = joined(polygons(polys), q);
  return geometry.index.length ? [{ order: -600, geometry, color: COLORS.slab, pattern: 'concrete', blend: null, slab: true, level }] : [];
}

// What's drawn on a bridge level, over its slab: its surface, tram tracks and the
// bridges' road paint. Zebra crossings stay on the ground: they're far more often
// under a flyover than on a bridge. A deck that carries a street is paved, as the
// pavements are, from parapet to parapet, with the carriageway over it between granite
// kerbs (the survey has no pavements on the bridges); one that carries none (a railway
// bridge) stays plain.
function deckLayers(polys: Polygons, trams: Point2[][], edges: GroundRoadEdge[], level: number, railway: Point2[][] = [], station = false): GroundLayer[] {
  const out: GroundLayer[] = [];
  let order = -599;
  const add = (geometry: GroundGeometry, color: string, pattern = 'flat', topOnly = false) => {
    const o = order++;
    if (geometry.index.length) out.push({ order: o, geometry, color, pattern, blend: null, deck: true, level,
      ...(topOnly ? { topOnly } : {}) });
  };
  const streets = edges.filter((e) => e.pts.length > 1);
  if (streets.length) {
    add(polygons(polys), COLORS.path, 'mosaic');
    const ways = streets.map((e) => ({ pts: e.pts, half: carriageway(e, trams) / 2 }));
    for (const w of ways) add(strips([w.pts], w.half * 2), COLORS.bridge, 'asphalt');
    add(strips(ways.flatMap((w) => [offsetLine(w.pts, w.half), offsetLine(w.pts, -w.half)]), 0.25), COLORS.kerb, 'concrete');
  } else if (railway.length) add(polygons(polys), COLORS.ballast, 'gravel', true);
  else add(polygons(polys), COLORS.bridge, 'asphalt');
  add(strips(trams, 2.5), COLORS.trackbed, 'concrete');
  add(strips(trams.flatMap((pts) => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.1), COLORS.steel);
  if (station && railway.length) railwayLayers(railway, (g, color, pattern) => add(g, color, pattern, true));
  else if (railway.length) add(strips(railway.flatMap(pts => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.12), COLORS.steel, 'flat', true);
  const { dashed, solid } = roadPaint(edges, trams);
  add(strips(dashed, 0.13, [3, 6], true), COLORS.paint);
  add(strips(solid, 0.13, null, true), COLORS.paint);
  return out;
}

// Three batches for the station's track bed, sleepers and standard-gauge rails.
function railwayLayers(lines: Point2[][], add: (g: GroundGeometry, color: string, pattern?: string) => void) {
  const sleepers: Point2[][] = [];
  for (const line of lines) {
    let next = 0.4;
    for (let i = 1; i < line.length; i++) {
      const [x, y] = line[i - 1], [bx, by] = line[i];
      const len = Math.hypot(bx - x, by - y);
      if (len < 1e-6) continue;
      const ux = (bx - x) / len, uy = (by - y) / len;
      for (; next < len; next += 0.85) {
        const cx = x + ux * next, cy = y + uy * next;
        sleepers.push([[cx - uy * 1.2, cy + ux * 1.2], [cx + uy * 1.2, cy - ux * 1.2]]);
      }
      next -= len;
    }
  }
  add(strips(lines, 3.2), '#5d5750', 'gravel');
  add(strips(sleepers, 0.26), '#8b8175');
  add(strips(lines.flatMap(pts => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.16), '#c4beb1');
}

// How wide a street on a bridge is from kerb to kerb: as the map has it, or wider where
// tram tracks run along it, to take them and a lane beside them (the map's width leaves
// the tracks out: 7 m on most Legií, kerb to kerb 10 m).
function carriageway(e: GroundRoadEdge, trams: Point2[][]) {
  let off = -1;
  for (let i = 0; i < e.pts.length - 1; i++) {
    const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1], len = Math.hypot(bx - ax, by - ay);
    if (len < 0.1) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    for (const line of trams) for (const [x, y] of line) {
      const along = (x - ax) * ux + (y - ay) * uy, across = Math.abs((x - ax) * uy - (y - ay) * ux);
      if (along >= 0 && along <= len && across < 4) off = Math.max(off, across);
    }
  }
  return off < 0 ? e.width : Math.max(e.width, 2 * (off + 0.75 + 2.6));
}

// A tunnel level: its floor, the walls along it and its road paint.
function tunnelLayers(polys: Polygons, box: Bounds, mask: LevelMask, H: HeightAt, T: HeightAt, edges: GroundRoadEdge[], level: number): GroundLayer[] {
  const out: GroundLayer[] = [];
  const add = (order: number, geometry: GroundGeometry, color: string, pattern = 'flat') => {
    if (geometry.index.length) out.push({ order, geometry, color, pattern, blend: null, tunnel: true, level });
  };
  add(-700, polygons(polys), COLORS.tunnel, 'asphalt');
  const q = quads();
  openSides(polys, box, mask, H, T, (a, b, ha, hb, ox, oy) => {
    q.quad([b[0], hb, -b[1]], [a[0], ha, -a[1]], [a[0], ha + TUNNEL_H, -a[1]], [b[0], hb + TUNNEL_H, -b[1]], [-ox, 0, oy]);
  });
  add(-699, joined(polygons([]), q), COLORS.tunnelWall, 'concrete');
  const inner = groundHeight;
  groundHeight = (x: number, y: number) => (inner ? inner(x, y) : 0) + 0.05;
  try {
    const { dashed, solid } = roadPaint(edges, []);
    add(-698, strips(dashed, 0.13, [3, 6], true), COLORS.paint);
    add(-697, strips(solid, 0.13, null, true), COLORS.paint);
  } finally { groundHeight = inner; }
  return out;
}

function layers(d: GroundTileData, { box, edges, buildings, parkingZones, bridges: withBridges = true, rasterRoads = false }: {
  box: Bounds; edges: GroundRoadEdge[]; buildings: { rings: Point2[][] }[];
  parkingZones: (string | null)[]; bridges?: boolean; rasterRoads?: boolean;
}): GroundLayer[] {
  const out: GroundLayer[] = [];
  const A = d.areas, R = d.roads;
  // Fixed order per layer (whether or not it has anything), so tiles layer consistently.
  let order = -1000;
  const add = (geometry: GroundGeometry, color: string, pattern = 'flat', blend: number | null = null) => {
    const o = order++;
    if (geometry.index.length) out.push({ order: o, geometry, color, pattern, blend });
  };
  const shade = (geometry: GroundGeometry, opacity: number) => {
    const o = order++;
    if (geometry.index.length) out.push({ order: o, geometry, shade: opacity });
  };

  // The dark woodland floor fades out over the grass beside it, as the canopy's shade
  // would, instead of stopping on a line. The edge that shows is not always the wood's
  // own outline: a park or meadow is often drawn over a wood's floor, and then its
  // outline is the edge. So a band is laid along the wood outlines where the floor shows
  // and the neighbour is not wood, and along the grass outlines where wood floor shows on
  // the other side. Only real woods (the photo canopy's small blobs are left out).
  const woodEdges = () => {
    const wood = [...(A.dtm_wood || []), ...(A.wood || [])];
    const real = (polys: Polygons) => polys.filter((rings) => Math.abs(signedArea(rings[0])) > WOOD_EDGE_MIN_AREA);
    const grass = [...(A.park || []), ...(A.meadow || []), ...(A.lawn || []), ...(A.garden || []), ...(A.verge || [])];
    const onWood = onPolygons(wood), onTop = onPolygons(A.wood || []), onGrass = onPolygons(grass);
    const floorAt = (p: Point2) => onTop(p[0], p[1]) || (onWood(p[0], p[1]) && !onGrass(p[0], p[1]));
    const skipUnless = (test: (p: Point2, q: Point2) => boolean) => (a: Point2, b: Point2) => {
      if (cut(a, b)) return true;
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = (-dy / len) * 1.5, ny = (dx / len) * 1.5;
      const p: Point2 = [mx + nx, my + ny], q: Point2 = [mx - nx, my - ny];
      return !(test(p, q) || test(q, p));
    };
    // Wood outline: the floor on one side, no wood on the other. Where the other side is grass
    // that has its own outline right here (the grass has a hole where the wood is), the grass
    // outline lays the band.
    const outer = skipUnless((i, o) => floorAt(i) && !onWood(o[0], o[1]) && !(onGrass(o[0], o[1]) && !onGrass(i[0], i[1])));
    // Grass outline: grass that the wood does not cover on one side, the floor showing on the other.
    const inner = skipUnless((g, f) => onGrass(g[0], g[1]) && !onTop(g[0], g[1]) && floorAt(f) && !onGrass(f[0], f[1]));
    shade(skirts(real(wood), WOOD_EDGE_WIDTH, true, outer), WOOD_EDGE_SHADE);
    shade(skirts(real(grass), WOOD_EDGE_WIDTH, false, inner), WOOD_EDGE_SHADE);
  };

  // Base: everything unmapped between streets and houses is paved; gardens round
  // family houses come from the pipeline (osm_area.py, _gardens).
  const [x0, y0, x1, y1] = box;
  // Polygons are clipped to the tile: their edges along the tile border aren't real
  // shores or kerbs, so outlines and shading skip them.
  const cut = (a: Point2, b: Point2) => ([[0, x0], [0, x1], [1, y0], [1, y1]] as [0 | 1, number][]).some(([k, v]) => Math.abs(a[k] - v) < 0.05 && Math.abs(b[k] - v) < 0.05);
  const outlines = (polys: Polygons): Point2[][] => {
    const out: Point2[][] = [];
    for (const rings of polys) {
      for (const ring of rings) {
        let cur: Point2[] = [];
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          if (cut(a, b)) { if (cur.length > 1) out.push(cur); cur = []; continue; }
          if (!cur.length) cur.push(a);
          cur.push(b);
        }
        if (cur.length > 1) out.push(cur);
      }
    }
      return out;
    };
    const roadRaster = rasterRoads ? pavingRaster(box, R.road || []) : null;
    add(polygons([[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]], roadRaster), COLORS.pavement, 'asphalt');
    out[out.length - 1].base = true;
    for (const [key, pattern] of LAND_USE) add(polygons(A[key] || []), COLORS[key as keyof typeof COLORS], pattern);
    for (const [key, color, pattern] of DTM_LAND) add(polygons(A[key] || []), color, pattern);
    // Roadside verges (pipeline/verges.py): rough grass that nobody waters, drying like a
    // meadow. Under the photographs' ground: past the survey a verge is all the unmapped
    // land, and what the photographs show there goes on top of it.
    add(polygons(A.verge || []), COLORS.park, 'meadow');
    for (const [key, color, pattern] of COVER) add(polygons(A[key] || []), color, pattern);
    add(polygons(A.garden || []), COLORS.garden, 'garden');
    add(polygons(A.lawn || []), COLORS.garden, 'lawn');
    add(polygons(A.park || []), COLORS.park, 'grass');
    add(polygons(A.meadow || []), COLORS.park, 'meadow');
    // The greenery the city tends, surveyed (pipeline/ipr_greenery.py), over what is only
    // guessed there: lawns, meadows, the earth of flower beds and under groups of shrubs.
    // (Under a surveyed group of trees the grass goes on: a park's trees, not a wood.)
    add(polygons([...(A.ipr_lawn || []), ...(A.ipr_grove || [])]), COLORS.park, 'lawn');
    add(polygons(A.ipr_meadow || []), COLORS.park, 'meadow');
    add(polygons(A.ipr_shrubs || []), COLORS.shrubBed, 'garden');
    add(polygons(A.ipr_bed || []), COLORS.bed, 'dirt');
    // Each family plot's lawn kept its own way (tiles.ts, withPatches): over some a
    // pale, dry wash, over others a deeper green; from above the plots read apart.
    add(polygons(A.plot_dry || []), '#b8a868', 'flat', 0.2);
    add(polygons(A.plot_lush || []), '#3a5c2a', 'flat', 0.22);
    // Paths people have worn across the grass (worn_paths.py): a faint rim, then the bare earth.
    add(polygons(A.worn_edge || []), COLORS.worn, 'dirt', 0.35);
    add(polygons(A.worn || []), COLORS.worn, 'dirt', 0.9);
    add(polygons(A.orchard || []), COLORS.orchard, 'grass');
    add(polygons(A.wood || []), COLORS.wood, 'wood');
    // Clearings inside a wood (pipeline/young_woods.py): unmown grass instead of the dark floor.
    add(polygons(A.wood_clearing || []), COLORS.park, 'meadow');
    woodEdges();
    for (const [key, color, pattern] of PITCH_LOOKS) add(polygons(A[key] || []), color, pattern);
    add(polygons(A.pitch || []), COLORS.pitch, 'pitch');
    add(strips(d.marks || [], 0.12, null, true), COLORS.paint);
    add(polygons(A.square || []), COLORS.square, 'slabs');
    add(polygons(A.square_setts || []), COLORS.squareSetts, 'setts');
    add(polygons(A.square_asphalt || []), COLORS.asphalt, 'asphalt');
    add(polygons(A.square_loose || []), COLORS.dirt, 'gravel');
    add(polygons(A.pool || []), COLORS.pool); // garden pools (tiles.ts, withPatches)
    afloat = true;
    try {
      add(polygons(A.water || []), COLORS.water, 'water');
      shade(skirts(A.water || [], 6, false, cut), 0.35);
    } finally { afloat = false; }
    add(strips(outlines(A.water || []), 0.9), COLORS.quay, 'slabs');
    add(stepWalls(outlines(terraceOutlines)), COLORS.quay, 'slabs');
    if (out[out.length - 1].order === order - 1) out[out.length - 1].wall = true;
    add(strips(d.weirs || [], 2.4), '#9a978d', 'concrete');
    add(strips((d.weirs || []).map((w) => offsetLine(w, -1.6)), 2.2), '#dfe6e2');

    add(polygons(A.parking || []), COLORS.parking, 'asphalt');
    add(polygons(R.dirt || []), COLORS.dirt, 'dirt');
    add(polygons(R.path || []), COLORS.path, 'mosaic');
    // Pavements and traffic islands as the technical map surveyed them, kerb to wall
    // (pipeline/pavements.py): asphalt like the unmapped ground, or Prague's mosaic.
    add(polygons(R.pavement_asphalt || []), COLORS.pavement, 'asphalt');
    add(polygons(R.pavement || []), COLORS.path, 'mosaic');
    add(polygons(R.sett || []), COLORS.sett, 'setts');
    if (rasterRoads) {
      if (roadRaster) {
        const geometry = roadRasterGeometry(out[0].geometry, roadRaster);
        if (geometry.index.length) out.push({ order, geometry, color: COLORS.asphalt, pattern: 'asphalt', raster: roadRaster });
      }
      order++;
    } else add(polygons(R.road || []), COLORS.asphalt, 'asphalt');
    // Where the trams have a bed of their own beside the street: ballast under the tracks.
    add(polygons(R.trambed || []), COLORS.ballast, 'gravel');
    // Bay lines as Prague paints them: a solid blue line in residents' zones, white
    // dashes in the mixed (violet) and visitors' (orange) ones, plain white elsewhere.
    for (const [cat, color, dash] of BAY_PAINT) {
      const rings = (A.parking || []).filter((rs, k) => (parkingZones[k] || null) === cat);
      add(strips(bayLines(rings.map((rs) => rs[0]), edges, cut), 0.15, dash, true), color);
    }

    // Bridges: a soft shadow on the water, then the deck (unless the decks are drawn
    // above the ground, where they cast shadows of their own).
    const bridges = withBridges ? [...(A.bridge || []), ...(R.bridge || [])] : [];
    const shadow = polygons(bridges);
    for (let i = 0; i < shadow.position.length; i += 3) { shadow.position[i] += 3; shadow.position[i + 2] += 3.5; }
    add(shadow, '#000000', 'flat', 0.28);
    add(polygons(bridges), COLORS.bridge, 'asphalt');

    if (d.station) {
      railwayLayers(d.station.rails, add);
      add(polygons(d.station.platforms), '#b6afa0', 'concrete');
      add(strips(d.station.platformEdges, 0.23), '#d1c7b2');
    } else order += 5;

    // Tram tracks: concrete bed and two rails at standard gauge.
    const trams = d.rails.filter((r) => r.kind === 'tram').map((r) => r.pts);
    add(strips(trams, 2.5), COLORS.trackbed, 'concrete');
    add(strips(trams.flatMap((pts) => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.1), COLORS.steel);
    add(strips(d.rails.filter((r) => r.kind === 'funicular').map((r) => r.pts), 3), COLORS.funicular, 'concrete');

    const { dashed, solid } = roadPaint(edges, trams);
    add(strips(dashed, 0.13, [3, 6], true), COLORS.paint);
    add(strips(solid, 0.13, null, true), COLORS.paint);
    add(strips(zebras(d.crossings || [], edges, [...(R.road || []), ...(R.sett || [])], box), 0.5, null, true), COLORS.paint);
    // Manhole covers and storm drains: all of the tile's in one mesh.
    add(coverGeometry(d.utility || [], edges.map((e) => e.pts), groundHeight ?? (() => 0)), COLORS.iron);

    // Soft contact shadow where each wall meets the ground. The wider, fainter one that
    // used to darken courtyards and lanes is the sky view now (map/skyView.ts), which
    // dims only the ambient light and not the sun's.
    const rings = buildings.map((b) => b.rings);
    shade(skirts(rings, 1.8, true), 0.5);
  return out;
}

// The painted edges of parking areas. Along a street the line runs only on the
// street side of the bays, with short ones across at each end, and none along the
// pavement: a side that runs with the street and faces away from it is left bare.
// Car parks away from the streets keep their whole outline. `cut` = along the tile's
// border (not a real edge).
const BAY_REACH = 8, ALONG = 0.85;
function bayLines(rings: Point2[][], edges: GroundRoadEdge[], cut: (a: Point2, b: Point2) => boolean): Point2[][] {
  const out: Point2[][] = [];
  const inside = (x: number, y: number, ring: Point2[]) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const street = edges.filter((e) => !e.tunnel);
  for (const ring of rings) {
    const turn = signedArea(ring) > 0 ? 1 : -1; // outward normal of a→b is turn · (dy, −dx)
    const painted = (a: Point2, b: Point2) => {
      if (cut(a, b)) return false;
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 0.05) return false;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      // The nearest street centre line.
      let best = Infinity, px = 0, py = 0, rx = 0, ry = 0;
      for (const e of street) {
        for (let j = 1; j < e.pts.length; j++) {
          const p = e.pts[j - 1], q = e.pts[j], ex = q[0] - p[0], ey = q[1] - p[1], l2 = ex * ex + ey * ey || 1;
          const t = Math.max(0, Math.min(1, ((mx - p[0]) * ex + (my - p[1]) * ey) / l2));
          const cx = p[0] + ex * t, cy = p[1] + ey * t, d = Math.hypot(mx - cx, my - cy);
          if (d < best && d < e.width / 2 + BAY_REACH) { best = d; px = cx; py = cy; rx = ex; ry = ey; }
        }
      }
      if (best === Infinity) return true; // a car park off the street
      if (Math.abs(dx * rx + dy * ry) / (len * Math.hypot(rx, ry)) < ALONG) return true; // an end, across the street
      // Along the street: painted on the side that faces it (or where the centre line
      // runs through the bays, as down the middle of a wide street).
      return turn * (dy * (px - mx) - dx * (py - my)) > 0 || inside(px, py, ring);
    };
    let cur: Point2[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (!painted(a, b)) { if (cur.length > 1) out.push(cur); cur = []; continue; }
      if (!cur.length) cur.push(a);
      cur.push(b);
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

// Road paint from OSM lanes: dashed lane dividers, a centre line (double solid on
// roads of four lanes or more) and edge lines on the main roads, on every slip road
// and on the one-way carriageways of divided roads that are fast or have no street
// name (the connecting roads of an interchange are often mapped as plain main roads). An edge line stops where it
// would run over another road's lanes (where a slip road leaves or joins, across a side
// street's mouth, through a junction). Cobbled streets and the middle of tram streets
// stay unpainted.
const COBBLED = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones']);
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const EDGE_LINES = new Set(['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link']);
const FAST = 70; // km/h: a one-way main road at least this fast is a carriageway, not a street
const PAINT_STEP = 2; // m: an edge line is kept or dropped in pieces this long
let paintRoads = true;
function roadPaint(edges: GroundRoadEdge[], trams: Point2[][]) {
  if (!paintRoads) return { dashed: [] as Point2[][], solid: [] as Point2[][] };
  const near = (p: Point2) => trams.some((pts) => pts.some((q, i) => i > 0 && segDistPts(p, pts[i - 1], q) < 3));
  const dashed: Point2[][] = [], solid: Point2[][] = [];
  const edgeLines = (e: GroundRoadEdge, W: number) => {
    for (const line of [offsetLine(e.pts, W / 2 - 0.4), offsetLine(e.pts, -W / 2 + 0.4)]) solid.push(...offOtherRoads(line, e, edges));
  };
  for (const e of edges) {
    const n = e.lanes || 0;
    if (COBBLED.has(e.surface ?? '') || (!MAJOR.has(e.hw) && n < 2)) continue;
    if (!e.oneway && e.u > e.v) continue; // a two-way street has an edge each way: paint it once
    const W = e.width, pts = e.pts;
    if (e.oneway) {
      const lanes = Math.max(1, n || 1), lw = W / lanes;
      for (let k = 1; k < lanes; k++) dashed.push(offsetLine(pts, -W / 2 + k * lw));
      if (EDGE_LINES.has(e.hw) || lanes > 1 || e.hw.endsWith('_link') || (MAJOR.has(e.hw) && ((e.maxspeed ?? 0) >= FAST || e.named === false))) edgeLines(e, W);
      continue;
    }
    const per = Math.max(1, Math.floor(Math.max(2, n || 2) / 2)), lw = W / (2 * per);
    if (![pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].some(near)) {
      if (per >= 2) solid.push(offsetLine(pts, 0.15), offsetLine(pts, -0.15));
      else dashed.push(pts);
    }
    for (let k = 1; k < per; k++) dashed.push(offsetLine(pts, k * lw), offsetLine(pts, -k * lw));
    if (EDGE_LINES.has(e.hw)) edgeLines(e, W);
  }
  return { dashed, solid };
}

// The parts of an edge line of road `own` that lie on no other road's lanes: off every
// other edge at the same level by more than its half width less the line's own inset.
// (The other direction of a two-way road, and the other pieces of a clipped edge, are
// the same road.)
function offOtherRoads(line: Point2[], own: GroundRoadEdge, edges: GroundRoadEdge[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of line) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const others = edges.filter((o) => {
    if (o === own || (o.u === own.u && o.v === own.v) || (o.u === own.v && o.v === own.u)) return false;
    if (!!o.bridge !== !!own.bridge || !!o.tunnel !== !!own.tunnel) return false;
    const r = o.width / 2;
    return o.pts.some(([x, y]) => x > x0 - r - 30 && x < x1 + r + 30 && y > y0 - r - 30 && y < y1 + r + 30);
  });
  if (!others.length) return [line];
  const covered = (p: Point2) => others.some((o) => {
    const r = o.width / 2 - 0.6;
    for (let i = 1; i < o.pts.length; i++) if (segDistPts(p, o.pts[i - 1], o.pts[i]) < r) return true;
    return false;
  });
  const out: Point2[][] = [];
  let run: Point2[] = [], straight = false;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / PAINT_STEP));
    for (let k = 0; k < n; k++) {
      const p: Point2 = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
      const q: Point2 = [a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n];
      if (covered([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])) {
        if (run.length > 1) out.push(run);
        run = [];
      } else if (!run.length) {
        run.push(p, q);
        straight = true;
      } else if (straight && k > 0) {
        run[run.length - 1] = q; // the same straight piece, a little longer
      } else {
        run.push(q);
        straight = true;
      }
    }
  }
  if (run.length > 1) out.push(run);
  return out;
}

// Zebra crossings: bars along the road, one every metre across it, from kerb to kerb.
// OSM's crossing lines only say roughly where a crossing is: they often stop short of
// the kerb or run on over the pavement, and bend. So each crossing is laid out afresh
// where it meets a street's centre line: straight across the street (unless it's
// mapped 30° to 60° off square, as some are: then along the way it's mapped), as
// far as the road surface goes on each side, with the bars evened out between them.
const BAR = 0.5, PITCH = 1, BAR_LEN = 3, KERB_GAP = 0.3, REACH_SLACK = 2, SQUARE = Math.cos(Math.PI / 6);
function zebras(crossings: Point2[][], edges: GroundRoadEdge[], road: Polygons, box: Bounds): Point2[][] {
  const bars: Point2[][] = [];
  const done: Point2[] = [];
  for (const pts of crossings) {
    for (const hit of crossingHits(pts, edges)) {
      if (done.some((q) => Math.hypot(q[0] - hit.at[0], q[1] - hit.at[1]) < 2.5)) continue; // a two-way street's other edge
      done.push(hit.at);
      const [px, py] = hit.at, [rx, ry] = hit.road, nx = -ry, ny = rx;
      // Across the street, or along the crossing where it's mapped well off square.
      let [ax, ay] = hit.along;
      if (ax * nx + ay * ny < 0) { ax = -ax; ay = -ay; }
      const square = ax * nx + ay * ny;
      if (square > SQUARE || square < 0.5) { ax = nx; ay = ny; } // (or so far off it's a mapping slip)
      const k = ax * nx + ay * ny; // metres across the street per metre along the crossing
      // As far as the road surface reaches each way; where it runs off the tile, or
      // there's no mapped surface, half the street's width.
      const half = hit.width / 2 / k;
      const span = roadSpan(road, px, py, ax, ay) ?? [-half, half];
      const [x0, y0, x1, y1] = box;
      const offTile = (t: number) => { const x = px + ax * t, y = py + ay * t; return x < x0 + 0.5 || x > x1 - 0.5 || y < y0 + 0.5 || y > y1 - 0.5; };
      let lo = offTile(span[0]) ? Math.min(span[0], -half) : span[0];
      let hi = offTile(span[1]) ? Math.max(span[1], half) : span[1];
      // At a junction the surface of the side street and the main street run together,
      // so the span can be many street widths. A crossing never reaches further than
      // about one street width past the centre line of the street it crosses.
      const reach = (hit.width / 2 + REACH_SLACK) / k;
      lo = Math.max(lo, -reach); hi = Math.min(hi, reach);
      // Bars evened out between the kerbs, a little in from each.
      const width = (hi - lo) * k - 2 * KERB_GAP;
      if (width < BAR || width > 40) continue;
      const n = Math.floor((width - BAR) / PITCH) + 1;
      const first = lo * k + KERB_GAP + (width - (BAR + (n - 1) * PITCH)) / 2 + BAR / 2;
      for (let i = 0; i < n; i++) {
        const t = (first + i * PITCH) / k, cx = px + ax * t, cy = py + ay * t;
        bars.push([[cx - rx * BAR_LEN / 2, cy - ry * BAR_LEN / 2], [cx + rx * BAR_LEN / 2, cy + ry * BAR_LEN / 2]]);
      }
    }
  }
  return bars;
}

// Where a crossing meets the centre lines of the streets (not bridges or tunnels):
// the point, the street's heading there, the crossing's, and the street's width.
// A crossing that stops short of the centre line meets the nearest street it reaches.
function crossingHits(pts: Point2[], edges: GroundRoadEdge[]) {
  const hits: { at: Point2; road: Point2; along: Point2; width: number }[] = [];
  const unit = (a: Point2, b: Point2): Point2 => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  for (const e of edges) {
    if (e.bridge || e.tunnel) continue;
    for (let i = 1; i < pts.length; i++) {
      for (let j = 1; j < e.pts.length; j++) {
        const at = segCross(pts[i - 1], pts[i], e.pts[j - 1], e.pts[j]);
        if (at) hits.push({ at, road: unit(e.pts[j - 1], e.pts[j]), along: unit(pts[i - 1], pts[i]), width: e.width });
      }
    }
  }
  if (hits.length || pts.length < 2) return hits;
  const mid = pts[Math.floor((pts.length - 1) / 2)], next = pts[Math.floor((pts.length - 1) / 2) + 1];
  let best: { at: Point2; road: Point2; along: Point2; width: number } | null = null, bestD = Infinity;
  for (const e of edges) {
    if (e.bridge || e.tunnel) continue;
    for (let j = 1; j < e.pts.length; j++) {
      const a = e.pts[j - 1], b = e.pts[j], d = segDistPts(mid, a, b);
      if (d >= bestD || d > e.width / 2 + 3) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((mid[0] - a[0]) * dx + (mid[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      bestD = d;
      best = { at: [a[0] + dx * t, a[1] + dy * t], road: unit(a, b), along: unit(mid, next), width: e.width };
    }
  }
  return best ? [best] : [];
}

function segCross(a: Point2, b: Point2, c: Point2, d: Point2): Point2 | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + rx * t, a[1] + ry * t] : null;
}

// How far the road surface reaches from (px, py) along (ax, ay), both ways, as
// [back, ahead] in metres (back negative); null if (px, py) isn't on it. Pieces of
// surface that touch (separate polygons for each street, say) count as one.
function roadSpan(road: Polygons, px: number, py: number, ax: number, ay: number): [number, number] | null {
  const spans: [number, number][] = [];
  for (const rings of road) {
    const ts: number[] = [];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const ex = b[0] - a[0], ey = b[1] - a[1], den = ax * ey - ay * ex;
        if (Math.abs(den) < 1e-9) continue;
        const u = ((a[0] - px) * ay - (a[1] - py) * ax) / den; // along the ring's edge
        if (u < 0 || u >= 1) continue;
        ts.push(((a[0] - px) * ey - (a[1] - py) * ex) / den);
      }
    }
    ts.sort((p, q) => p - q);
    for (let i = 0; i + 1 < ts.length; i += 2) spans.push([ts[i], ts[i + 1]]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1] + 0.3) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp]);
  }
  return merged.find(([lo, hi]) => lo <= 0.3 && hi >= -0.3) ?? null;
}

function segDistPts(p: Point2, a: Point2, b: Point2) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
