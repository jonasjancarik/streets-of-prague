// Conservative scenery inferred from mapped land use, made once in a tile worker.
import * as THREE from 'three';
import { Grid, fillPolys, strokeLines, rng, onPolygons } from './geo.ts';
import { PITCH_KINDS } from './pitches.ts';
import type { Geo, Point2, Bounds, Polygons } from './geo.ts';
import type { TreeTileData, TreeInstances } from './vegetation.ts';
import type { RawStreetEdge } from '../network.ts';

// The furniture's kinds, the index of each one's model, size and draw. Inferred from land
// use: bench, bin, courtyard planter; mapped in OSM (MAPPED, build_street_furniture.py): the
// rest down to the drinking fountain, and benches and bins too; a post box mapped by a
// building hangs on its wall (mappedSpots); inferred: the grate round a street tree in
// paving (treeGrates). (The traffic signs are map/signs.ts's.) (No standing
// hydrants: Prague's are underground, their covers drawn with the street's ironwork.)
export const KIND = {
  bench: 0, bin: 1, planter: 2, bikeStand: 3, parkingMachine: 4, bollard: 5, postBox: 6,
  glass: 7, clearGlass: 8, paper: 9, plastic: 10, cartons: 11, metal: 12, wallPostBox: 13, stolperstein: 14,
  cabinet: 15, advertisingColumn: 16, posterCase: 17, drinkingFountain: 18, treeGrate: 19,
} as const;
export type FurnitureKind = (typeof KIND)[keyof typeof KIND];
// Kinds that lie flat in the ground and stop nobody.
export const FLAT_FURNITURE = new Set<number>([KIND.stolperstein, KIND.treeGrate]);
// Kinds a car can knock loose (src/looseFurniture.ts): the tile worker notes which grid
// cells only these made solid, so they can be freed when they come loose.
export const KNOCKABLE = new Set<number>([KIND.bench, KIND.bin, KIND.paper, KIND.plastic, KIND.cartons, KIND.metal, KIND.posterCase,
  KIND.glass, KIND.clearGlass, KIND.bikeStand, KIND.parkingMachine, KIND.cabinet]);
// pipeline/build_street_furniture.py's kinds, by name.
export const MAPPED: Record<string, FurnitureKind> = {
  bin: KIND.bin, 'bike stand': KIND.bikeStand, 'parking machine': KIND.parkingMachine, bollard: KIND.bollard, 'post box': KIND.postBox,
  glass: KIND.glass, 'clear glass': KIND.clearGlass, paper: KIND.paper, plastic: KIND.plastic, cartons: KIND.cartons, metal: KIND.metal,
  stolperstein: KIND.stolperstein, bench: KIND.bench, cabinet: KIND.cabinet, 'advertising column': KIND.advertisingColumn,
  'poster case': KIND.posterCase, 'drinking fountain': KIND.drinkingFountain,
};
export interface FurnitureSpot { kind: FurnitureKind; x: number; y: number; z: number; angle: number }
export interface FurnitureInstances { matrices: Float32Array[]; spots: FurnitureSpot[] }
export interface FurnitureData extends TreeTileData {
  walk: RawStreetEdge[];
  passages: { pts: Point2[]; w: number }[];
  fences?: { pts: Point2[] }[];
  reserved: Float32Array; // surveyed lamps, independent of tile arrival order
  structures: Polygons;
}
// The mapped items of a tile (mappedFurniture.ts: kind, x, y, angle) as spots. A post box
// mapped within WALL_BOX of a building hangs on its wall, facing out (KIND.wallPostBox); anything
// else whose point is inside a building, or on the game's carriageway, is left out.
const WALL_BOX = 1.2;
export function mappedSpots(m: Float32Array, buildings: { rings: Point2[][] }[], onRoad: (x: number, y: number) => boolean,
  height: (x: number, y: number) => number) {
  const inside = onPolygons(buildings.map(b => b.rings));
  const wall = (x: number, y: number) => {
    let best: { x: number; y: number; d: number; angle: number } | null = null;
    for (const { rings } of buildings) for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      if (!len || x < Math.min(ax, bx) - WALL_BOX || x > Math.max(ax, bx) + WALL_BOX || y < Math.min(ay, by) - WALL_BOX || y > Math.max(ay, by) + WALL_BOX) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)), px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px - x, py - y);
      if (d <= WALL_BOX && (!best || d < best.d)) best = { x: px, y: py, d, angle: Math.atan2(dy, dx) };
    }
    return best;
  };
  const out: FurnitureSpot[] = [];
  for (let i = 0; i + 3 < m.length; i += 4) {
    let kind = m[i] as FurnitureKind, x = m[i + 1], y = m[i + 2], angle = m[i + 3];
    const hung = kind === KIND.postBox ? wall(x, y) : null;
    if (hung) {
      // Local +z is (sin a, -cos a): turn it away from the building, and stand just off the wall.
      const backwards = inside(hung.x + Math.sin(hung.angle) * .3, hung.y - Math.cos(hung.angle) * .3);
      angle = hung.angle + (backwards ? Math.PI : 0);
      x = hung.x + Math.sin(angle) * .13; y = hung.y - Math.cos(angle) * .13;
      // (Its front, the slot, faces local -z on the freestanding box; on the wall it faces out.)
      kind = KIND.wallPostBox;
    } else if (inside(x, y) || onRoad(x, y)) continue;
    out.push({ kind, x, y, z: height(x, y), angle });
  }
  return out;
}

// A surveyed tree planted in paving (no mapped green under it, and a road within
// GRATE_ROAD or a paved square round it) has a cast-iron grate round its foot, square to
// the nearest road it finds.
const GRATE_ROAD = 7;
export function treeGrates(trees: readonly (readonly (number | undefined)[])[], areas: Record<string, Polygons | undefined>, onRoad: (x: number, y: number) => boolean,
  box: Bounds, height: (x: number, y: number) => number) {
  const green = onPolygons(["park", "garden", "lawn", "verge", "meadow", "field", "wood", "orchard", "cover_grass", "dtm_green", "dtm_garden", "dtm_wood", "dtm_yard", "dtm_pitch", "bare",
    "ipr_lawn", "ipr_meadow", "ipr_bed", "ipr_shrubs", "ipr_grove"].flatMap(k => areas[k] ?? []));
  const square = onPolygons(["square", "square_setts", "square_asphalt"].flatMap(k => areas[k] ?? []));
  const out: FurnitureSpot[] = [];
  for (const tree of trees) {
    const x = tree[0] ?? NaN, y = tree[1] ?? NaN;
    if (!(x >= box[0]) || x >= box[2] || y < box[1] || y >= box[3] || green(x, y) || onRoad(x, y)) continue;
    let angle = NaN;
    for (let r = 1.5; r <= GRATE_ROAD && Number.isNaN(angle); r += 1.5) for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      if (onRoad(x + Math.cos(a) * r, y + Math.sin(a) * r)) { angle = a; break; }
    }
    if (Number.isNaN(angle) && !square(x, y)) continue;
    out.push({ kind: KIND.treeGrate, x, y, z: height(x, y), angle: Number.isNaN(angle) ? 0 : angle });
  }
  return out;
}

// Half its footprint along its local x and z (m), for collision.
export const FURNITURE_SIZE = [[0.95, 0.42], [0.32, 0.32], [0.65, 0.65],
  [0.05, 0.40], [0.24, 0.18], [0.12, 0.12], [0.2, 0.16],
  [0.66, 0.66], [0.66, 0.66], [0.70, 0.56], [0.70, 0.56], [0.70, 0.56], [0.70, 0.56], [0.18, 0.12], [0.05, 0.05],
  [0.42, 0.2], [0.62, 0.62], [0.62, 0.1], [0.2, 0.2], [0.6, 0.6]] as const;
export const FURNITURE_KINDS = FURNITURE_SIZE.length;
const STEP = 14;
const INSET = 12; // neighbouring generated tree crowns can reach across a tile edge
export const PARK = 40, GARDEN = 80, YARD = 120;

export interface FurnitureContext {
  zone: (x: number, y: number) => number;
  clear: (x: number, y: number) => boolean;
  height: (x: number, y: number) => number;
  path: (x: number, y: number) => { x: number; y: number; distance: number; halfWidth: number } | null;
}

// Map-fixed cells own their jittered point. Half-open ownership and a footprint
// inset avoid seam duplicates, even when a tile edge cuts through a lattice cell.
export function furnitureSpots(box: Bounds, ctx: FurnitureContext): FurnitureSpot[] {
  const [x0, y0, x1, y1] = box, out: FurnitureSpot[] = [];
  for (let j = Math.floor(y0 / STEP); j * STEP < y1; j++) {
    for (let i = Math.floor(x0 / STEP); i * STEP < x1; i++) {
      const r = rng(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ 0x7ab34);
      let x = (i + 0.25 + r() * 0.5) * STEP, y = (j + 0.25 + r() * 0.5) * STEP;
      if (x < x0 + INSET || x >= x1 - INSET || y < y0 + INSET || y >= y1 - INSET) continue;
      const zone = ctx.zone(x, y);
      if (![PARK, GARDEN, YARD].includes(zone) || r() > (zone === YARD ? 0.25 : 0.45)) continue;
      const path = ctx.path(x, y);
      // Benches are useful beside a real path, never in the middle of a lawn.
      // Courtyards are often closed, with no mapped path; leave only a planter.
      if (zone !== YARD && (!path || path.distance <= path.halfWidth || path.distance > path.halfWidth + 7)) continue;
      const kind: FurnitureKind = zone === YARD ? 2 : r() < 0.22 ? 1 : 0;
      if (zone !== YARD && path) {
        // Bring the seat/bin to the mapped path's edge, preserving a small lawn
        // setback. Keep it within its cell's middle so neighbours cannot overlap.
        const edge = (kind === 0 ? 1.9 : 1.7) + r() * 0.3;
        const scale = (path.halfWidth + edge) / path.distance;
        x = path.x + (x - path.x) * scale; y = path.y + (y - path.y) * scale;
        if (x < (i + 0.18) * STEP || x > (i + 0.82) * STEP || y < (j + 0.18) * STEP || y > (j + 0.82) * STEP) continue;
        if (x < x0 + INSET || x >= x1 - INSET || y < y0 + INSET || y >= y1 - INSET) continue;
      }
      const angle = path ? Math.atan2(path.y - y, path.x - x) - Math.PI / 2 : r() * Math.PI * 2;
      const [hx, hy] = FURNITURE_SIZE[kind], c = Math.cos(angle), s = Math.sin(angle);
      const z = ctx.height(x, y);
      if (!Number.isFinite(z)) continue;
      let okay = true;
      // Sample a padded footprint throughout its interior, not just its corners.
      for (let u = -hx - 0.8; u <= hx + 0.81 && okay; u += 0.35) {
        for (let v = -hy - 0.8; v <= hy + 0.81; v += 0.35) {
          const px = x + c * u - s * v, py = y + s * u + c * v;
          const h = ctx.height(px, py);
          if (ctx.zone(px, py) !== zone || !ctx.clear(px, py) || !Number.isFinite(h) || Math.abs(h - z) > 0.16) { okay = false; break; }
        }
      }
      if (okay) out.push({ kind, x, y, z, angle });
    }
  }
  return out;
}

export function furnitureInstances(geo: Geo<FurnitureData>, trees: TreeInstances,
  height: (x: number, y: number) => number): FurnitureInstances {
  const d = geo.data;
  const zones = new Grid(geo, 2, (ctx, s) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const fill = (polys: Polygons | undefined, n: number) => {
      ctx.fillStyle = `rgb(${n},0,0)`; if (polys) fillPolys(ctx, geo, polys, s);
    };
    fill(d.areas.dtm_yard, YARD); fill(d.areas.yard, YARD);
    fill(d.areas.dtm_green, PARK); fill(d.areas.dtm_garden, GARDEN);
    fill(d.areas.garden, GARDEN); fill(d.areas.lawn, GARDEN);
    fill(d.areas.park, PARK); fill(d.areas.meadow, PARK); fill(d.areas.verge, PARK);
    // Higher priority surfaces and sports/rail/service uses never receive furniture.
    // `square` also represents explicit paving slabs. Named outlines must have
    // their lawns removed by the surface pipeline, not guessed here.
    for (const k of ['wood', 'dtm_wood', 'orchard', ...PITCH_KINDS, 'dtm_pitch', 'parking', 'water', 'pool', 'bridge', 'ballast', 'bare', 'square', 'square_setts', 'square_asphalt', 'square_loose']) fill(d.areas[k], 0);
    for (const polys of Object.values(d.roads)) fill(polys, 0);
    fill(d.structures, 0);
    fill(d.buildings.map(b => b.rings), 0);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 5 * s; ctx.stroke(); // entrance/wall clearance
    ctx.lineWidth = 3 * s;
    strokeLines(ctx, geo, [...d.walls, ...(d.fences ?? [])].map(w => w.pts), s);
    for (const p of d.passages) { ctx.lineWidth = (p.w + 4) * s; strokeLines(ctx, geo, [p.pts], s); }
    // Mapped footways may be absent from the road polygons in older tiles.
    for (const e of d.walk) { ctx.lineWidth = (Math.max(1.5, e.width) + 0.4) * s; strokeLines(ctx, geo, [e.pts], s); }
    const circle = (x: number, y: number, rad: number) => {
      const [u, v] = geo.px(x, y, s); ctx.beginPath(); ctx.arc(u, v, rad * s, 0, Math.PI * 2); ctx.fill();
    };
    ctx.fillStyle = '#000';
    for (let i = 0; i < trees.count; i++) {
      const m = trees.matrices.subarray(i * 16, i * 16 + 16);
      circle(m[12], -m[14], Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[8], m[9], m[10])) + 0.8);
    }
    for (let i = 0; i < d.reserved.length; i += 2) circle(d.reserved[i], d.reserved[i + 1], 2);
  });
  const paths = d.walk.filter(e => ['footway', 'path', 'pedestrian'].includes(e.hw) && !e.bridge && !e.tunnel);
  const segments = paths.flatMap(e => e.pts.slice(1).map((b, i) => [e.pts[i], b, Math.max(0.75, e.width / 2)] as const));
  const path = (x: number, y: number) => {
    let best = null, distance = Infinity;
    for (const [[ax, ay], [bx, by], halfWidth] of segments) {
      const reach = halfWidth + 8;
      if (x < Math.min(ax, bx) - reach || x > Math.max(ax, bx) + reach || y < Math.min(ay, by) - reach || y > Math.max(ay, by) + reach) continue;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
      const px = ax + dx * t, py = ay + dy * t, dist = Math.hypot(px - x, py - y);
      // Tie breaking is geometric, never dependent on feature input order.
      const edgeDistance = dist - halfWidth;
      if (edgeDistance < distance || (edgeDistance === distance && best && (px < best.x || (px === best.x && (py < best.y || (py === best.y && halfWidth < best.halfWidth)))))) {
        distance = edgeDistance; best = { x: px, y: py, distance: dist, halfWidth };
      }
    }
    return best;
  };
  const spots = furnitureSpots([geo.minX, geo.minY, geo.maxX, geo.maxY], { zone: (x, y) => zones.at(x, y), clear: () => true, height, path });
  return { spots, matrices: furnitureMatrices(spots) };
}

// One matrix array per kind, in the kinds' order.
export function furnitureMatrices(spots: FurnitureSpot[]) {
  return Array.from({ length: FURNITURE_KINDS }, (_, kind) => {
    const own = spots.filter(p => p.kind === kind), out = new Float32Array(own.length * 16);
    const m = new THREE.Matrix4();
    own.forEach((p, i) => { m.makeRotationY(p.angle); m.setPosition(p.x, p.z - 0.04, -p.y); m.toArray(out, i * 16); });
    return out;
  });
}
