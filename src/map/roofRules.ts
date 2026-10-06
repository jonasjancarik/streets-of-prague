import { signedArea, hash } from './geo.ts';
import type { Point2 } from './geo.ts';
import { ROOF_TILES } from './roofPalette.ts';

// Roofs for buildings that come from OSM alone: past the city limits, in the countryside
// tiles and for the few buildings inside IPR's area it doesn't model. Shape and colour are
// guesses by kind, size and footprint, and the neighbours: a street was built in one go, so
// its roofs look alike. A building has no access to its neighbours here (each is built on
// its own in a tile worker), so "neighbours" means the others on the same named street, or,
// where the tile knows of none within reach, the others in the same 90 m grid cell of the
// map: they all draw on the same hash (neighbourhoodOf).
//
// The shares come from IPR's measured roofs in the outermost districts (Kolovraty, Klánovice,
// Zbraslav, Čakovice, Satalice): flat roofs on 9 % to 49 % of buildings by district, and
// among pitched roofs about a third each of red or orange clay, brown, and grey, with
// a few dark ones.

const CELL = 90;

export interface RoofSpec {
  id: string;
  kind: string;
  h: number;
  minh: number;
  church?: boolean;
  rings: Point2[][];
}

const FLAT_KINDS = new Set([
  'industrial', 'warehouse', 'barn', 'farm_auxiliary', 'transportation', 'hangar', 'manufacture',
  'retail', 'supermarket', 'storage_tank', 'sports_hall', 'cowshed', 'stable', 'parking',
  'commercial', 'office', 'school', 'university', 'hospital', 'kindergarten', 'public', 'civic',
  'government', 'dormitory',
]);
const HOUSES = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow']);
const SHEDS = new Set(['garage', 'garages', 'shed', 'carport', 'hut', 'cabin', 'service', 'static_caravan', 'greenhouse', 'allotment_house']);

// The 90 m cell of the building, from its middle and the tile origin (global metres).
export function cellOf(origin: Point2, ring: Point2[]) {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  return `${Math.floor((origin[0] + cx / ring.length) / CELL)},${Math.floor((origin[1] + cy / ring.length) / CELL)}`;
}

// Whose roofs a building's take after: the others on its street, when the tile knows which
// named street it stands on (tiles.ts), since a street was built in one go; else the others
// in its 90 m cell. A cell alone changed the roofs' class wherever a street crossed its edge.
export function neighbourhoodOf(origin: Point2, ring: Point2[], street?: string | null) {
  return street ? `street ${street}` : cellOf(origin, ring);
}

// The named street nearest a footprint's middle, within REACH metres of it (null if none).
const STREET_REACH = 60;
export function streetOf(ring: Point2[], streets: { name?: string | null; pts: Point2[] }[]): string | null {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length; cy /= ring.length;
  let best = STREET_REACH * STREET_REACH, name: string | null = null;
  for (const s of streets) {
    if (!s.name) continue;
    for (let i = 0; i < s.pts.length - 1; i++) {
      const [ax, ay] = s.pts[i], dx = s.pts[i + 1][0] - ax, dy = s.pts[i + 1][1] - ay;
      const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = (cx - ax - dx * t) ** 2 + (cy - ay - dy * t) ** 2;
      // (Ties go to the first name in the alphabet, so two tiles with the same streets agree.)
      if (d < best - 1e-6 || (Math.abs(d - best) <= 1e-6 && name !== null && s.name < name)) { best = d; name = s.name; }
    }
  }
  return name;
}

function squareCornered(ring: Point2[]) {
  const n = ring.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % n], [cx, cy] = ring[(i + 2) % n];
    const ux = bx - ax, uy = by - ay, vx = cx - bx, vy = cy - by;
    const cos = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
    if (Math.abs(cos) > 0.06) return false;
  }
  return true;
}

export function footprintArea(rings: Point2[][]) {
  return Math.abs(rings.reduce((sum, r) => sum + signedArea(r), 0));
}

// Flat, gabled or hipped, for a building OSM gives no roof shape for.
export function roofShapeFor(b: RoofSpec, cell: string): 'flat' | 'gabled' | 'hipped' {
  const ring = b.rings[0];
  const area = footprintArea(b.rings);
  const storeys = (b.h - b.minh) / 3.2;
  const house = HOUSES.has(b.kind);
  let flat = false;
  if (b.church || b.kind === 'farm') flat = false;
  else if (FLAT_KINDS.has(b.kind)) flat = true;
  else if (b.kind === 'apartments' && storeys > 3.6) flat = true;
  else if (area > 400 && !house) flat = hash(b.id + 'big') < 0.85;
  else if (area > 250 && ring.length > 8 && !house) flat = hash(b.id + 'many') < 0.6;
  else {
    // Some houses are flat, as new ones are: more in some neighbourhoods than in others,
    // more with exact right angles, more when large.
    const base = 0.06 + 0.3 * Math.pow(hash('flat' + cell), 1.5);
    const p = base * (squareCornered(ring) ? 1.6 : 0.7) * (area > 150 ? 1.2 : 1) * (house ? 0.8 : 1);
    flat = hash(b.id + 'flat') < p;
  }
  if (flat) return 'flat';
  return b.rings.length === 1 && ring.length === 4 ? 'gabled' : 'hipped';
}

type Palette = readonly string[];
const CLAY = ROOF_TILES;
const BROWN: Palette = ['#7a5446', '#6e4c3f', '#84604d', '#76584a'];
const GREY: Palette = ['#7f7f7c', '#8a8884', '#74767a', '#6f716f'];
const ANTHRACITE: Palette = ['#4a4c50', '#3e4044', '#55524f', '#45464a'];
const SHEET: Palette = ['#7b3c35', '#4e6b55', '#6b7076', '#8a4a38'];
const CLASSES: { weight: number; colours: Palette }[] = [
  { weight: 0.45, colours: CLAY },
  { weight: 0.22, colours: BROWN },
  { weight: 0.23, colours: GREY },
  { weight: 0.1, colours: ANTHRACITE },
];

function pick(u: number, classes = CLASSES) {
  let t = u * classes.reduce((s, c) => s + c.weight, 0);
  for (const c of classes) { if (t < c.weight) return c; t -= c.weight; }
  return classes[classes.length - 1];
}

// A pitched roof's colour (a tile, fibre cement or sheet roof), same as most of its neighbours
// in the cell. Old farms keep to red clay.
export function pitchedColour(b: RoofSpec, cell: string, hv: number) {
  if (b.kind === 'farm') return CLAY[Math.floor(hv * 997) % CLAY.length];
  if (SHEDS.has(b.kind) && hash(b.id + 'sheet') < 0.3) return SHEET[Math.floor(hv * 31) % SHEET.length];
  const own = pick(hash(b.id + 'class'));
  const cls = hash(b.id + 'follow') < 0.55 ? pick(hash('dominant' + cell)) : own;
  return cls.colours[Math.floor(hv * 997) % cls.colours.length];
}

const GRAVEL: Palette = ['#8a8782', '#807d78', '#95918b'];
const BITUMEN: Palette = ['#4b4a48', '#55534f', '#403f3e'];
const MEMBRANE: Palette = ['#b9b9b4', '#c4c3bd', '#a9aaa8'];

// What a flat roof is covered with: gravel, bitumen sheet or a pale membrane.
export function flatColour(b: RoofSpec, hv: number) {
  const u = hash(b.id + 'surface');
  const set = u < 0.5 ? GRAVEL : u < 0.78 ? BITUMEN : MEMBRANE;
  return set[Math.floor(hv * 997) % set.length];
}

// A parapet goes on flat roofs over this footprint, and is this wide and high.
export const PARAPET_MIN_AREA = 60;
export const PARAPET_WIDTH = 0.3;
export const parapetHeight = (id: string) => 0.35 + hash(id + 'parapet') * 0.5;
export const hasParapet = (b: RoofSpec) => !SHEDS.has(b.kind) && !['kiosk', 'roof'].includes(b.kind) && footprintArea(b.rings) >= PARAPET_MIN_AREA;

// Every ring moved `t` metres to its left (towards the roof: outer rings run counter-
// clockwise and holes clockwise), corners mitred. Null if a short edge folds over, in
// which case the building gets no parapet.
export function insetRings(rings: Point2[][], t: number): Point2[][] | null {
  const out: Point2[][] = [];
  for (const ring of rings) {
    const n = ring.length;
    const norm = ring.map(([x, y], i) => {
      const [x2, y2] = ring[(i + 1) % n];
      const len = Math.hypot(x2 - x, y2 - y) || 1;
      return [-(y2 - y) / len, (x2 - x) / len];
    });
    const moved: Point2[] = [];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = norm[(i + n - 1) % n], [bx, by] = norm[i];
      const d = 1 + ax * bx + ay * by;
      if (d < 0.2) return null;
      moved.push([ring[i][0] + ((ax + bx) * t) / d, ring[i][1] + ((ay + by) * t) / d]);
    }
    for (let i = 0; i < n; i++) {
      const [x, y] = ring[i], [x2, y2] = ring[(i + 1) % n];
      const [mx, my] = moved[i], [mx2, my2] = moved[(i + 1) % n];
      if ((x2 - x) * (mx2 - mx) + (y2 - y) * (my2 - my) <= 0) return null;
    }
    out.push(moved);
  }
  return out;
}
