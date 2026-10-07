// Countryside past the edge of the built map (plan 021, a prototype behind ?countryside):
// tiles made here from OpenStreetMap vector tiles (Protomaps' basemap, one PMTiles file)
// instead of by the pipeline. It writes the same TileJSON build_tiles.py does, only
// plainer, and everything after it (meshing, collisions, the street graphs, traffic)
// takes it as any other tile. No three.js and no DOM: it runs in countrysideWorker.ts
// and under Node (scripts/check-countryside.mjs).
//
// Near the built map its streets are joined to the built ones (countrysideJoin.ts): the
// map says which of its streets run on outside (leaving.json; on a map built before
// that file, its rim tiles).
//
// The work is in three steps, the first two kept per vector tile:
//   raw    decoded and cut to the vector tile: road lines in its own units, land,
//          water and buildings in the game's metres
//   graph  the road lines split where they meet into street edges, with ids that
//          come out the same whichever game tile asks
//   tile   a game tile cut out of the vector tiles under it
//
// The tables mirror pipeline/osm_area.py: ROAD_WIDTH and CAR_ROADS (the same names),
// guessHeight (_guess_height, by the footprint alone: these tiles don't say what a
// building is). A change to the OSM-only look there belongs here too.
import proj4 from 'proj4';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { union } from 'polyclip-ts';
import { REACH, boxOf, joinEdges, meet, paved } from './countrysideJoin.ts';
import type { JoinEdge, Stub } from './countrysideJoin.ts';
import type { Bounds, Point2 } from './map/geo.ts';
import type { TileBuilding, TileJSON } from './contracts.ts';
import type { RawStreetEdge } from './network.ts';

export interface CountrysideSetup {
  centre: [number, number]; // lon, lat of the built map's projection
  tile: number; origin: Point2; cols: number; rows: number;
}
// A street's width: by class, and for the small ones by whether houses stand near it.
function settingWidth(hw: string, pts: Point2[], buildings: { at: Point2 }[]): number {
  const table = SETTING_WIDTH[hw];
  if (!table) return ROAD_WIDTH[hw];
  let near = 0;
  for (const { at } of buildings) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
      const t = Math.max(0, Math.min(1, ((at[0] - ax) * dx + (at[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(ax + dx * t - at[0], ay + dy * t - at[1]) <= SETTING_RADIUS) { near++; break; }
    }
    if (near >= SETTING_HOUSES) return table[0];
  }
  return table[1];
}

// A vector tile's bytes (unzipped), or nothing where the file has none.
export type VectorSource = (z: number, x: number, y: number) => Promise<ArrayBuffer | undefined>;
// The street graphs of one of the built map's tiles (its JSON), or nothing where it has none.
export type BuiltSource = (i: number, j: number) => Promise<{ drive?: RawStreetEdge[]; walk?: RawStreetEdge[] } | undefined>;
// The built map's streets that run on outside it (its leaving.json).
export type LeavingSource = () => Promise<{ drive?: RawStreetEdge[]; walk?: RawStreetEdge[] }>;

const E = 4096; // a vector tile's width in its own units
const WATER_LAP = 4; // units water reaches past its vector tile, so the pieces join without a gap
const MATCH = 8; // units between the two sides' idea of where a road crosses a vector tile's edge
const SNAP = 3; // units from a road's loose end to the road it joins
const ON = 1.5; // units from a road's point to another road it lies on

const CAR_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
  'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service']);
const ROAD_WIDTH: Record<string, number> = {
  motorway: 22, trunk: 16, primary: 14, secondary: 12, tertiary: 10, residential: 8,
  motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 7, tertiary_link: 6.5,
  unclassified: 7, living_street: 6, service: 5, pedestrian: 6,
  footway: 3, path: 2, steps: 3, cycleway: 2.5, track: 3, bridleway: 2,
};
// What pipeline/lanes.py gives streets with no width tag by their setting: [among houses,
// in open land]. There are no blocks of flats out here, and the room between fences
// isn't measured; the bigger widths stay for the map's own streets.
const SETTING_WIDTH: Record<string, [number, number]> = {
  residential: [5.5, 7], unclassified: [5.5, 6], living_street: [5, 5], tertiary: [7.5, 8], service: [3.5, 4],
};
const SETTING_RADIUS = 35, SETTING_HOUSES = 3; // m, and how many buildings make it houses
// A motorway's line is one carriageway here (the tiles don't give lanes).
const ONE_WAY_WIDTH: Record<string, number> = { motorway: 11, trunk: 9, primary: 8 };
const FOOTWAYS: Record<string, string> = { sidewalk: 'footway', crossing: 'footway' };
const NO_WALKING = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link']);
const DIRT = new Set(['track', 'path', 'bridleway']);
// Protomaps' landuse kinds as the ground's (ground.ts). Farmland is the tile's base.
const LAND: Record<string, string> = {
  forest: 'wood', wood: 'wood',
  grass: 'lawn', meadow: 'meadow', park: 'park', village_green: 'park', recreation_ground: 'park', playground: 'park',
  cemetery: 'park', golf_course: 'park', garden: 'park', allotments: 'park', scrub: 'meadow', dog_park: 'park',
  orchard: 'orchard', vineyard: 'orchard', pitch: 'pitch', residential: 'garden',
  industrial: 'yard', commercial: 'yard', retail: 'yard', farmyard: 'yard', pedestrian: 'square',
};
const TREE_STEP = 9, ORCHARD_STEP = 6; // metres between trees scattered in a wood, planted in an orchard

interface Line { pts: Point2[]; hw: string; name: string | null; oneway: boolean; bridge: boolean; tunnel: boolean }
interface Crossing { pos: number; hw: string }
interface Shape { kind: string; rings: Point2[][]; box: Bounds }
interface Raw {
  X: number; Y: number; to: (x: number, y: number) => Point2; box: Bounds;
  lines: Line[]; east: Crossing[]; south: Crossing[];
  land: Shape[]; water: Shape[]; buildings: (TileBuilding & { box: Bounds; at: Point2 })[]; trees: Point2[];
}
interface Edge extends Omit<Line, 'pts'>, JoinEdge { n: number }
interface Chunk extends Raw { edges: Edge[] }

const r2 = (v: number) => Math.round(v * 100) / 100;
const within = (x: number, y: number, [x0, y0, x1, y1]: Bounds) => x >= x0 && x < x1 && y >= y0 && y < y1;
const area = (ring: Point2[]) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
};
const inRings = (x: number, y: number, rings: Point2[][]) => {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
};
// A number in 0–1 from two whole numbers, the same every time.
const chance = (a: number, b: number, salt = 0) => {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

// The part of each segment of a line inside a box, as a range of 0–1 along it (null: none).
function inside(a: Point2, b: Point2, [x0, y0, x1, y1]: Bounds): [number, number] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
  }
  return t0 < t1 ? [t0, t1] : null;
}
const along = (a: Point2, b: Point2, t: number): Point2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
// The same, for a point where a line crosses a box's side: exactly on that side.
const cross = (a: Point2, b: Point2, t: number, box: Bounds): Point2 => {
  const p = along(a, b, t);
  for (const k of [0, 1, 2, 3]) if (Math.abs(p[k % 2] - box[k]) < 1e-6) p[k % 2] = box[k];
  return p;
};

// The pieces of a line inside a box (keep = true) or outside it.
function cutLine(pts: Point2[], box: Bounds, keep: boolean): { pts: Point2[]; cutStart: boolean; cutEnd: boolean }[] {
  const out: { pts: Point2[]; cutStart: boolean; cutEnd: boolean }[] = [];
  let cur: Point2[] | null = null, cutStart = false;
  const close = (cutEnd: boolean) => { if (cur && cur.length > 1) out.push({ pts: cur, cutStart, cutEnd }); cur = null; };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], t = inside(a, b, box);
    // The stretches of this segment to keep, each a range along it.
    const spans: [number, number][] = keep ? (t ? [t] : []) : !t ? [[0, 1]] : [[0, t[0]], [t[1], 1]];
    for (const [s, e] of spans) {
      if (e - s <= 1e-9) continue;
      if (s > 0 || !cur) { close(true); cur = [s > 0 ? cross(a, b, s, box) : a]; cutStart = s > 0; }
      cur!.push(e < 1 ? cross(a, b, e, box) : b);
      if (e < 1) close(true);
    }
    if (!spans.some(([s, e]) => e - s > 1e-9 && e === 1)) close(true);
  }
  close(false);
  return out;
}

// A ring cut to a box (Sutherland and Hodgman): right for convex shapes, and for the
// rest it leaves edges running along the box's side, which draw as nothing.
function clipRing(ring: Point2[], [x0, y0, x1, y1]: Bounds): Point2[] {
  let pts = ring;
  for (const [k, v, sign] of [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]] as [0 | 1, number, number][]) {
    if (pts.length < 3) return [];
    const out: Point2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ain = (a[k] - v) * sign >= 0, bin = (b[k] - v) * sign >= 0;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = (v - a[k]) / (b[k] - a[k]), p = along(a, b, t);
        p[k] = v;
        out.push(p);
      }
    }
    pts = out;
  }
  return pts.length >= 3 && Math.abs(area(pts)) > 0.05 ? pts : [];
}
function clipRings(rings: Point2[][], box: Bounds): Point2[][] | null {
  const outer = clipRing(rings[0], box);
  if (!outer.length) return null;
  return [outer, ...rings.slice(1).map((r) => clipRing(r, box)).filter((r) => r.length)];
}

// pipeline/osm_area.py's _guess_height for a building of no known kind.
function guessHeight(m2: number, seed: number) {
  let n = 0;
  const rnd = () => chance(seed, n++, 7);
  const uniform = (a: number, b: number) => a + (b - a) * rnd();
  const pick = (...of: number[]) => of[Math.floor(rnd() * of.length)];
  const storeys = (k: number) => k * 3.4 + 1 + uniform(-0.4, 0.4);
  if (m2 < 25) return 2.5 + uniform(0, 0.8);
  if (m2 < 60) return storeys(1) - 0.8;
  if (m2 < 250) return storeys(pick(1, 2, 2));
  if (m2 < 600) return storeys(pick(2, 3));
  if (m2 < 1500) return storeys(pick(2, 3, 4));
  return Math.min(14, 6 + Math.sqrt(m2) / 15 + uniform(0, 2));
}

// Built streets in one order whichever way they were read: by graph, then id.
const inOrder = (a: Stub, b: Stub) => (a.graph !== b.graph ? (a.graph < b.graph ? -1 : 1) : a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0);

export class Countryside {
  private readonly proj: proj4.Converter;
  private readonly raws = new Map<string, Promise<Raw | null>>();
  private readonly loose = new Map<string, Promise<Chunk | null>>();
  private readonly graphs = new Map<string, Promise<Chunk | null>>();
  private readonly rims = new Map<string, Promise<Stub[]>>();
  private listed: Promise<Stub[]> | null = null;
  private readonly leaving?: LeavingSource;
  private readonly rect: Bounds;
  readonly stats = { fetched: 0, bytes: 0 };
  private readonly source: VectorSource;
  private readonly built: BuiltSource;
  private readonly setup: CountrysideSetup;
  private readonly zoom: number;

  constructor(source: VectorSource, built: BuiltSource, setup: CountrysideSetup, zoom = 15, leaving?: LeavingSource) {
    this.source = source;
    this.built = built;
    this.leaving = leaving;
    this.setup = setup;
    this.zoom = zoom;
    const [lon0, lat0] = setup.centre;
    this.proj = proj4(`+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`);
    const { tile: T, origin: [ox, oy], cols, rows } = setup;
    this.rect = [-ox, -oy, cols * T - ox, rows * T - oy];
  }

  // WGS84 → the game's metres.
  metres(lon: number, lat: number): Point2 { return this.proj.forward([lon, lat]) as Point2; }
  lonLat(x: number, y: number): Point2 { return this.proj.inverse([x, y]) as Point2; }

  // The vector tile (fractional) at a point in the game's metres.
  private vectorAt(x: number, y: number): Point2 {
    const [lon, lat] = this.proj.inverse([x, y]), n = 2 ** this.zoom;
    return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n];
  }

  private kept<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
    let hit = cache.get(key);
    if (hit) cache.delete(key);
    else {
      hit = make();
      hit.catch(() => { if (cache.get(key) === hit) cache.delete(key); });
    }
    cache.set(key, hit); // most recently used last
    if (cache.size > 48) cache.delete(cache.keys().next().value!);
    return hit;
  }

  private raw(X: number, Y: number) { return this.kept(this.raws, `${X}_${Y}`, () => this.readRaw(X, Y)); }
  private unjoined(X: number, Y: number) { return this.kept(this.loose, `${X}_${Y}`, () => this.makeGraph(X, Y)); }
  private graph(X: number, Y: number) { return this.kept(this.graphs, `${X}_${Y}`, () => this.joinGraph(X, Y)); }

  // Those of a list of the built map's streets that run on outside it.
  private stubsOf(t: { drive?: RawStreetEdge[]; walk?: RawStreetEdge[] } | undefined): Stub[] {
    const stubs: Stub[] = [];
    for (const graph of ['drive', 'walk'] as const) {
      for (const edge of t?.[graph] ?? []) {
        const outside = cutLine(edge.pts, this.rect, false).map((piece) => piece.pts);
        if (!outside.length) continue;
        const out = ([x, y]: Point2) => x < this.rect[0] || x > this.rect[2] || y < this.rect[1] || y > this.rect[3];
        const ends = ([[edge.u, edge.pts[0]], [edge.v, edge.pts[edge.pts.length - 1]]] as [string, Point2][])
          .filter(([, at]) => out(at)).map(([id, at]) => ({ id, at }));
        stubs.push({ graph, edge, outside, box: boxOf(outside.flat()), ends });
      }
    }
    return stubs;
  }

  // The streets of one of the built map's rim tiles that run on outside it.
  private rim(i: number, j: number): Promise<Stub[]> {
    const k = `${i}_${j}`;
    let hit = this.rims.get(k);
    if (!hit) {
      hit = this.built(i, j).then((t) => this.stubsOf(t));
      hit.catch(() => { if (this.rims.get(k) === hit) this.rims.delete(k); });
      this.rims.set(k, hit);
    }
    return hit;
  }

  // The built streets that pass through a box outside the built map (within `pad`),
  // each once, in an order that doesn't depend on who asks.
  private async stubsNear(box: Bounds, pad: number): Promise<Stub[]> {
    if (this.leaving) {
      // The map's own list, read once.
      if (!this.listed) {
        const listed = this.listed = this.leaving().then((t) => this.stubsOf(t).sort(inOrder));
        listed.catch(() => { if (this.listed === listed) this.listed = null; });
      }
      return (await this.listed).filter((s) => meet(s.box, box, pad));
    }
    // A map without the list: its rim tiles within REACH of the box.
    if (!meet(box, this.rect, REACH)) return [];
    const { tile: T, origin: [ox, oy], cols, rows } = this.setup;
    const span = (lo: number, hi: number, o: number, n: number) => [Math.max(0, Math.floor((lo - REACH + o) / T)), Math.min(n - 1, Math.floor((hi + REACH + o) / T))];
    const [i0, i1] = span(box[0], box[2], ox, cols), [j0, j1] = span(box[1], box[3], oy, rows);
    const wanted: Promise<Stub[]>[] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) wanted.push(this.rim(i, j));
    const seen = new Set<string>();
    return (await Promise.all(wanted)).flat().filter((s) => {
      const k = `${s.graph} ${s.edge.id}`;
      if (seen.has(k) || !meet(s.box, box, pad)) return false;
      seen.add(k);
      return true;
    }).sort(inOrder);
  }

  private async readRaw(X: number, Y: number): Promise<Raw | null> {
    const bytes = await this.source(this.zoom, X, Y);
    if (!bytes) return null;
    this.stats.fetched++;
    this.stats.bytes += bytes.byteLength;
    const vt = new VectorTile(new PbfReader(new Uint8Array(bytes)));
    // The tile's corners projected, and straight lines between them: over 800 m the
    // curve of either projection is a centimetre or two.
    const n = 2 ** this.zoom;
    const corner = (cx: number, cy: number) => this.metres(((X + cx) / n) * 360 - 180,
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (Y + cy)) / n))) * 180) / Math.PI);
    const p00 = corner(0, 0), p10 = corner(1, 0), p01 = corner(0, 1), p11 = corner(1, 1);
    const to = (x: number, y: number): Point2 => {
      const u = x / E, v = y / E, a = (1 - u) * (1 - v), b = u * (1 - v), c = (1 - u) * v, d = u * v;
      return [r2(p00[0] * a + p10[0] * b + p01[0] * c + p11[0] * d), r2(p00[1] * a + p10[1] * b + p01[1] * c + p11[1] * d)];
    };
    const own: Bounds = [0, 0, E, E];
    const rings = (f: { loadGeometry(): { x: number; y: number }[][] }) => f.loadGeometry().map((ring) => {
      const pts = ring.map((q): Point2 => [q.x, q.y]);
      const a = pts[0], b = pts[pts.length - 1];
      if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
      return pts;
    });
    // A feature's rings as polygons: an outer ring, then its holes (which wind the other way).
    const polygons = (list: Point2[][]) => {
      const out: Point2[][][] = [];
      let outer = 0;
      for (const ring of list) {
        const a = area(ring);
        if (!a) continue;
        if (!outer || Math.sign(a) === outer) { outer = Math.sign(a); out.push([ring]); } else out[out.length - 1].push(ring);
      }
      return out;
    };
    const project = (ring: Point2[]) => ring.map(([x, y]) => to(x, y));

    const lines: Line[] = [], east: Crossing[] = [], south: Crossing[] = [];
    const roads = vt.layers.roads;
    for (let i = 0; roads && i < roads.length; i++) {
      const f = roads.feature(i), p = f.properties;
      if (f.type !== 2) continue;
      const detail = String(p.kind_detail ?? ''), hw = FOOTWAYS[detail] ?? detail;
      if (!(hw in ROAD_WIDTH)) continue;
      for (const ring of f.loadGeometry()) {
        const pts: Point2[] = [];
        for (const q of ring) if (!pts.length || pts[pts.length - 1][0] !== q.x || pts[pts.length - 1][1] !== q.y) pts.push([q.x, q.y]);
        for (const piece of cutLine(pts, own, true)) {
          if (piece.pts.length < 2) continue;
          lines.push({ pts: piece.pts, hw, name: typeof p.name === 'string' ? p.name : null, oneway: p.oneway === 'yes', bridge: !!p.is_bridge, tunnel: !!p.is_tunnel });
          for (const [x, y] of [piece.pts[0], piece.pts[piece.pts.length - 1]]) {
            if (x === E) east.push({ pos: Y * E + y, hw });
            else if (y === E) south.push({ pos: X * E + x, hw });
          }
        }
      }
    }

    const land: Shape[] = [], water: Shape[] = [];
    const shapes = (layer: typeof roads | undefined, kindOf: (kind: string) => string | undefined, into: Shape[], lap: number) => {
      const cut: Bounds = [-lap, -lap, E + lap, E + lap];
      for (let i = 0; layer && i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.type !== 3) continue;
        const kind = kindOf(String(f.properties.kind));
        if (!kind) continue;
        for (const poly of polygons(rings(f))) {
          const clipped = clipRings(poly, cut);
          if (!clipped) continue;
          const projected = clipped.map(project);
          into.push({ kind, rings: projected, box: boxOf(projected[0]) });
        }
      }
    };
    shapes(vt.layers.landuse, (kind) => LAND[kind], land, 0);
    shapes(vt.layers.water, () => 'water', water, WATER_LAP);

    // A building belongs to the vector tile its middle is in. Either tile sees the
    // whole of one near their shared edge, so both find the same middle.
    const buildings: Raw['buildings'] = [];
    const built = vt.layers.buildings;
    for (let i = 0; built && i < built.length; i++) {
      const f = built.feature(i);
      if (f.type !== 3 || f.properties.kind !== 'building') continue;
      for (const poly of polygons(rings(f))) {
        const outer = poly[0];
        const cx = outer.reduce((a, q) => a + q[0], 0) / outer.length, cy = outer.reduce((a, q) => a + q[1], 0) / outer.length;
        if (!within(cx, cy, own)) continue;
        const shape = poly.map(project).filter((r) => r.length >= 3);
        if (!shape.length || shape[0].length < 3) continue;
        const m2 = Math.abs(area(shape[0]));
        if (m2 < 4) continue;
        const gx = Math.round(X * E + cx), gy = Math.round(Y * E + cy);
        const h = typeof f.properties.height === 'number' && f.properties.height > 2 ? f.properties.height : guessHeight(m2, gx * 31 + gy);
        buildings.push({ id: `c${gx}_${gy}`, kind: 'yes', name: null, h: r2(h), minh: 0, roof: null, church: false, rings: shape, box: boxOf(shape[0]), at: to(cx, cy) });
      }
    }

    const trees: Point2[] = [];
    const pois = vt.layers.pois;
    for (let i = 0; pois && i < pois.length; i++) {
      const f = pois.feature(i);
      if (f.type !== 1 || f.properties.kind !== 'tree') continue;
      const [[q]] = f.loadGeometry();
      if (within(q.x, q.y, own)) trees.push(to(q.x, q.y));
    }
    const a = to(0, 0), b = to(E, 0), c = to(0, E), d = to(E, E);
    return { X, Y, to, box: boxOf([a, b, c, d]), lines, east, south, land, water, buildings, trees };
  }

  // The vector tile's road lines as street edges. Lines are split wherever two of
  // them share a point, where one ends on another, and at the vector tile's edge. A
  // junction's id is its place on the whole map's grid, so the next vector tile and
  // every game tile name it alike; at the vector tile's edge the two sides place a
  // crossing a little differently, so the tile to the west or north of an edge decides.
  private async makeGraph(X: number, Y: number): Promise<Chunk | null> {
    const raw = await this.raw(X, Y);
    if (!raw) return null;
    const [west, north] = await Promise.all([this.raw(X - 1, Y), this.raw(X, Y - 1)]);
    const lines = raw.lines.map((l) => ({ ...l, pts: l.pts.map((p): Point2 => [p[0], p[1]]) }));
    const key = (p: Point2) => `${Math.round(p[0] * 4)},${Math.round(p[1] * 4)}`;
    const named = new Map<string, string>(); // the ids of the points on the vector tile's edge
    const nearest = (list: Crossing[] | undefined, pos: number, hw: string) => {
      let best: Crossing | null = null, at = MATCH;
      for (const c of list || []) {
        const d = Math.abs(c.pos - pos) + (c.hw === hw ? 0 : MATCH / 2);
        if (d < at) { at = d; best = c; }
      }
      return best;
    };
    for (const l of lines) {
      for (const p of [l.pts[0], l.pts[l.pts.length - 1]]) {
        if (p[0] === 0 || p[0] === E) {
          const theirs = p[0] === 0 ? nearest(west?.east, Y * E + p[1], l.hw) : null;
          if (theirs) p[1] = theirs.pos - Y * E;
          named.set(key(p), `v${X * E + p[0]}_${Math.round(Y * E + p[1])}`);
        } else if (p[1] === 0 || p[1] === E) {
          const theirs = p[1] === 0 ? nearest(north?.south, X * E + p[0], l.hw) : null;
          if (theirs) p[0] = theirs.pos - X * E;
          named.set(key(p), `h${Y * E + p[1]}_${Math.round(X * E + p[0])}`);
        }
      }
    }
    // A road's point lying on another road that has no point there (the tiles drop a
    // straight road's point at a side street or a crossing path): give that road the
    // point. A loose end may lie a little off (SNAP) and is moved onto it; any other
    // point has to lie right on it (ON), and stays where it is.
    const count = () => {
      const uses = new Map<string, number>();
      for (const l of lines) for (const p of l.pts) uses.set(key(p), (uses.get(key(p)) || 0) + 1);
      return uses;
    };
    let uses = count();
    const CELL = 128, cells = new Map<number, Line[]>(); // the lines passing through each square of the tile
    const cell = (x: number, y: number) => Math.floor(x / CELL) * 64 + Math.floor(y / CELL);
    for (const l of lines) {
      for (let i = 0; i < l.pts.length - 1; i++) {
        const [ax, ay] = l.pts[i], [bx, by] = l.pts[i + 1];
        for (let x = Math.floor((Math.min(ax, bx) - SNAP) / CELL); x <= Math.floor((Math.max(ax, bx) + SNAP) / CELL); x++) {
          for (let y = Math.floor((Math.min(ay, by) - SNAP) / CELL); y <= Math.floor((Math.max(ay, by) + SNAP) / CELL); y++) {
            const list = cells.get(x * 64 + y) ?? [];
            if (!list.includes(l)) list.push(l);
            cells.set(x * 64 + y, list);
          }
        }
      }
    }
    for (const l of lines) {
      for (let at = 0; at < l.pts.length; at++) {
        const p = l.pts[at], end = at === 0 || at === l.pts.length - 1, loose = end && uses.get(key(p)) === 1, reach = loose ? SNAP : ON;
        if (named.has(key(p)) || (!end && uses.get(key(p)) !== 1)) continue;
        let best: { line: Line; i: number; t: number; d: number } | null = null;
        for (const o of cells.get(cell(p[0], p[1])) ?? []) {
          if (o === l || o.bridge !== l.bridge || o.tunnel !== l.tunnel) continue;
          if (!loose && o.pts.some((q) => q[0] === p[0] && q[1] === p[1])) continue; // joined already
          for (let i = 0; i < o.pts.length - 1; i++) {
            const [ax, ay] = o.pts[i], [bx, by] = o.pts[i + 1], dx = bx - ax, dy = by - ay;
            const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
            const d = Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1]);
            if (d <= reach && (!best || d < best.d)) best = { line: o, i, t, d };
          }
        }
        if (!best) continue;
        const o = best.line, a = o.pts[best.i], b = o.pts[best.i + 1];
        if (!loose) {
          if (best.t > 0.02 && best.t < 0.98) o.pts.splice(best.i + 1, 0, [p[0], p[1]]);
          continue;
        }
        const on = best.t < 0.02 ? a : best.t > 0.98 ? b : along(a, b, best.t);
        if (on !== a && on !== b) o.pts.splice(best.i + 1, 0, on);
        l.pts[at] = [on[0], on[1]];
      }
    }
    uses = count();

    const edges: Edge[] = [], pairs = new Map<string, number>();
    const id = (p: Point2) => named.get(key(p)) ?? `n${Math.round((X * E + p[0]) * 4)}_${Math.round((Y * E + p[1]) * 4)}`;
    const nearRect = meet(raw.box, this.rect);
    for (const l of lines) {
      let from = 0;
      for (let i = 1; i < l.pts.length; i++) {
        if (i < l.pts.length - 1 && (uses.get(key(l.pts[i])) || 0) < 2) continue;
        const part = l.pts.slice(from, i + 1), u = id(part[0]), v = id(part[part.length - 1]);
        from = i;
        const pts = part.map(([x, y]) => raw.to(x, y));
        // Inside the built map its own streets stand: a generated street stops at its edge.
        const pieces = nearRect ? cutLine(pts, this.rect, false) : [{ pts, cutStart: false, cutEnd: false }];
        for (const piece of pieces) {
          const a = piece.pts[0], b = piece.pts[piece.pts.length - 1];
          let length = 0;
          for (let k = 1; k < piece.pts.length; k++) length += Math.hypot(piece.pts[k][0] - piece.pts[k - 1][0], piece.pts[k][1] - piece.pts[k - 1][1]);
          const pu = piece.cutStart ? `r${Math.round(a[0])}_${Math.round(a[1])}` : u, pv = piece.cutEnd ? `r${Math.round(b[0])}_${Math.round(b[1])}` : v;
          if (length < (pu === pv ? 1 : 0.01)) continue;
          const pair = pu < pv ? `${pu}|${pv}` : `${pv}|${pu}`, n = pairs.get(pair) || 0;
          pairs.set(pair, n + 1);
          const width = (l.oneway && ONE_WAY_WIDTH[l.hw]) || settingWidth(l.hw, piece.pts, raw.buildings);
          edges.push({ u: pu, v: pv, n, width, hw: l.hw, name: l.name, oneway: l.oneway, bridge: l.bridge, tunnel: l.tunnel, pts: piece.pts.map(([x, y]): Point2 => [r2(x), r2(y)]), box: boxOf(piece.pts),
            drive: CAR_ROADS.has(l.hw), walk: !NO_WALKING.has(l.hw) });
        }
      }
    }
    return { ...raw, edges };
  }

  // The vector tile's streets joined to the built map's where those run on out here.
  // A built street's end near the vector tile's edge may belong to a junction in the
  // next one, so those junctions are looked at too: both sides then decide alike.
  private async joinGraph(X: number, Y: number): Promise<Chunk | null> {
    const chunk = await this.unjoined(X, Y);
    if (!chunk) return null;
    const stubs = await this.stubsNear(chunk.box, 40);
    if (!stubs.length) return chunk;
    const [x0, y0, x1, y1] = chunk.box, rim = 40;
    const nearEdge = stubs.some((s) => s.ends.some(({ at: [x, y] }) => meet([x, y, x, y], chunk.box, rim) && !(x > x0 + rim && x < x1 - rim && y > y0 + rim && y < y1 - rim)));
    const others: Edge[] = [];
    if (nearEdge) {
      const around: Promise<Chunk | null>[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) around.push(this.unjoined(X + dx, Y + dy));
      for (const c of await Promise.all(around)) for (const e of c?.edges ?? []) if (meet(e.box, chunk.box, rim)) others.push(e);
    }
    return { ...chunk, edges: joinEdges(chunk.edges, stubs, chunk.box, others) };
  }

  // A game tile, as pipeline/build_tiles.py would write it.
  async tile(i: number, j: number): Promise<TileJSON> {
    const { tile: T, origin: [ox, oy] } = this.setup;
    const box: Bounds = [r2(i * T - ox), r2(j * T - oy), r2((i + 1) * T - ox), r2((j + 1) * T - oy)];
    const [x0, y0, x1, y1] = box, pad = 16; // metres: half the widest road past the tile
    const corners = [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x0 - pad, y1 + pad], [x1 + pad, y1 + pad]].map(([x, y]) => this.vectorAt(x, y));
    const X0 = Math.floor(Math.min(...corners.map((c) => c[0]))), X1 = Math.floor(Math.max(...corners.map((c) => c[0])));
    const Y0 = Math.floor(Math.min(...corners.map((c) => c[1]))), Y1 = Math.floor(Math.max(...corners.map((c) => c[1])));
    const wanted: Promise<Chunk | null>[] = [];
    for (let X = X0; X <= X1; X++) for (let Y = Y0; Y <= Y1; Y++) wanted.push(this.graph(X, Y));
    const chunks = (await Promise.all(wanted)).filter((c): c is Chunk => !!c);

    // Streets: each stretch a rectangle, with an octagon at every junction, end and
    // bend. They overlap, which the ground draws as one surface.
    const roads: Record<string, Point2[][][]> = {};
    const drive: RawStreetEdge[] = [], walk: RawStreetEdge[] = [];
    const lanes: { a: Point2; b: Point2; r: number }[] = []; // where trees keep off
    const street = (kind: string, ring: Point2[]) => {
      const cut = clipRing(ring, box);
      if (cut.length) (roads[kind] ||= []).push([cut.map(([x, y]): Point2 => [r2(x), r2(y)])]);
    };
    // A street's surface along a line: a four-sided piece per stretch, an octagon at each
    // end and bend; `half` gives the width to the left and to the right at each point.
    const pave = (kind: string, pts: Point2[], half: (k: number) => [number, number]) => {
      const knob = ([x, y]: Point2, [left, right]: [number, number], nx: number, ny: number) => {
        const r = (left + right) / 2, cx = x + nx * (left - right) / 2, cy = y + ny * (left - right) / 2;
        street(kind, Array.from({ length: 8 }, (_, k): Point2 => [cx + Math.cos((k + 0.5) * Math.PI / 4) * r * 1.082, cy + Math.sin((k + 0.5) * Math.PI / 4) * r * 1.082]));
      };
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const [la, ra] = half(k), [lb, rb] = half(k + 1), reach = Math.max(la, ra, lb, rb);
        if (!meet(boxOf([a, b]), box, reach + 1)) continue;
        const nx = -(b[1] - a[1]) / l, ny = (b[0] - a[0]) / l;
        lanes.push({ a, b, r: reach + 1.5 });
        street(kind, [[a[0] + nx * la, a[1] + ny * la], [b[0] + nx * lb, b[1] + ny * lb], [b[0] - nx * rb, b[1] - ny * rb], [a[0] - nx * ra, a[1] - ny * ra]]);
        const c2 = pts[k + 2];
        if (k === 0) knob(a, [la, ra], nx, ny);
        if (!c2 || Math.abs((b[0] - a[0]) * (c2[1] - b[1]) - (b[1] - a[1]) * (c2[0] - b[0])) > 0.07 * l * Math.hypot(c2[0] - b[0], c2[1] - b[1])) knob(b, [lb, rb], nx, ny);
      }
    };
    const surface = (hw: string) => (CAR_ROADS.has(hw) ? 'road' : DIRT.has(hw) ? 'dirt' : 'path');
    for (const c of chunks) {
      for (const e of c.edges) {
        if (!meet(e.box, box, e.width / 2 + 2)) continue;
        const kind = surface(e.hw);
        pave(kind, e.pts, (k) => { const r = (e.widths?.[k] ?? e.width) / 2; return [r, r]; });
        // ("c" keeps the id apart from a built street's between the same two junctions. A
        // loop's way back needs an id of its own: both ways run between the same junction.)
        const raw = (u: string, v: string, pts: Point2[], back = false): RawStreetEdge => ({
          id: `c${u}>${v}>${e.n}${back && u === v ? 'b' : ''}`, u, v, hw: e.hw, name: e.name, oneway: e.oneway, lanes: null, maxspeed: null,
          width: e.width, bridge: e.bridge, ...(e.tunnel ? { tunnel: true } : {}), ...(kind === 'road' ? { surface: 'asphalt' } : {}), pts,
        });
        if (e.drive) {
          drive.push(raw(e.u, e.v, e.pts));
          if (!e.oneway) drive.push(raw(e.v, e.u, [...e.pts].reverse(), true));
        }
        if (e.walk) walk.push(raw(e.u, e.v, e.pts));
      }
    }
    // The built map's streets that run on out here: the same edges its own tiles list
    // (one id, so the graphs take them once), and their surface from the map's edge on,
    // as wide as it is inside. A car road's walking edge lies on a surface already.
    const laid = new Set<string>();
    for (const s of await this.stubsNear(box, pad)) {
      const e = s.edge, [left, right] = paved(e);
      const here = s.outside.filter((pts) => cutLine(pts, [x0 - pad, y0 - pad, x1 + pad, y1 + pad], true).length);
      if (!here.length) continue;
      (s.graph === 'drive' ? drive : walk).push(e);
      // Once for the two directions of a street (but two streets may join the same two junctions).
      const first = e.pts[0], last = e.pts[e.pts.length - 1], back = e.u > e.v || (e.u === e.v && first[0] > last[0]);
      const pair = `${back ? e.v : e.u}|${back ? e.u : e.v}|${e.pts.length}|${e.pts[back ? e.pts.length - 2 : 1]}`;
      if (laid.has(pair) || (s.graph === 'walk' && CAR_ROADS.has(e.hw))) continue;
      laid.add(pair);
      for (const pts of here) pave(surface(e.hw), pts, () => [left, right]);
    }

    // Unmapped ground is farmland; what OSM maps goes over it.
    const areas: Record<string, Point2[][][]> = { field: [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]] };
    for (const c of chunks) {
      for (const s of c.land) {
        if (!meet(s.box, box)) continue;
        const rings = clipRings(s.rings, box);
        if (rings) (areas[s.kind] ||= []).push(rings);
      }
    }
    // Water is joined up across the vector tiles' edges, or each would end in a shore.
    const wet: Point2[][][] = [];
    for (const c of chunks) for (const s of c.water) { const rings = meet(s.box, box) && clipRings(s.rings, box); if (rings) wet.push(rings); }
    if (wet.length > 1) {
      try {
        const joined = union(wet[0], ...wet.slice(1));
        areas.water = joined.map((poly) => poly.map((ring) => ring.slice(0, -1).map(([x, y]): Point2 => [r2(x), r2(y)])));
      } catch { areas.water = wet; }
    } else if (wet.length) areas.water = wet;

    const buildings: TileBuilding[] = [];
    for (const c of chunks) {
      for (const { box: b, at, ...building } of c.buildings) {
        if (!meet(b, box) || within(at[0], at[1], this.rect)) continue;
        buildings.push(within(at[0], at[1], box) ? { ...building, own: true } : building);
      }
    }

    // Trees: the single ones OSM has, and others scattered through woods and set out
    // in orchards, on a grid over the whole map so that a tile comes out the same
    // every time and a wood carries on across tiles.
    const trees: TileJSON['trees'] = [];
    for (const c of chunks) for (const [x, y] of c.trees) if (within(x, y, box)) trees.push([x, y]);
    const clear = (x: number, y: number) => {
      for (const { a, b, r } of lanes) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y) < r) return false;
      }
      return !buildings.some((b) => inRings(x, y, b.rings)) && !(areas.water || []).some((w) => inRings(x, y, w));
    };
    const plant = (polys: Point2[][][] | undefined, step: number, wild: boolean) => {
      for (const rings of polys || []) {
        const [bx0, by0, bx1, by1] = boxOf(rings[0]);
        for (let gx = Math.floor(bx0 / step); gx * step < bx1; gx++) {
          for (let gy = Math.floor(by0 / step); gy * step < by1; gy++) {
            const x = r2((gx + (wild ? chance(gx, gy, 1) : 0.5)) * step), y = r2((gy + (wild ? chance(gx, gy, 2) : 0.5)) * step);
            if (!within(x, y, box) || !inRings(x, y, rings) || !clear(x, y)) continue;
            // Woods in stands of conifers and of broadleaves, with a few of the other among each.
            const conifers = chance(Math.floor(x / 90), Math.floor(y / 90), 3) < 0.6;
            if (!wild) trees.push([x, y, 2]);
            else if (conifers !== chance(gx, gy, 4) < 0.15) trees.push([x, y, 1]);
            else trees.push([x, y]);
          }
        }
      }
    };
    plant(areas.wood, TREE_STEP, true);
    plant(areas.orchard, ORCHARD_STEP, false);

    return { i, j, box, areas, lots: [], roads, buildings, walls: [], fences: [], rails: [], passages: [], weirs: [], crossings: [], marks: [], trees, drive, walk, sections: [] };
  }
}
