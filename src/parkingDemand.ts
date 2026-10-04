import type { Point2 } from './map/geo.ts';

// How full the parking outside the paid zones is, from the buildings round each spot.
// Cars belong to someone's home or workplace: blocks of flats and tenements fill both
// sides of a street day and night, family houses keep their cars on the plot, offices,
// shops and halls fill their car parks by day and are empty at night, and where nothing
// stands, nobody parks.

export interface DemandBuilding { id?: string; rings: Point2[][]; kind: string; h: number }
export type Use = 'flats' | 'terrace' | 'houses' | 'work';
export type Floors = Record<Use, number>;

// What fills the street, by kind of building (OSM `building`). Sheds, garages, barns and
// the like have no one to park for. Tall `yes` / `house` buildings are flats, whatever
// OSM calls them.
const FLATS = new Set(['apartments', 'dormitory']);
const WORK = new Set(['office', 'commercial', 'retail', 'supermarket', 'industrial', 'warehouse', 'civic', 'school', 'kindergarten',
  'hospital', 'university', 'college', 'government', 'public', 'hotel', 'sports_centre', 'sports_hall', 'stadium', 'laboratory',
  'transportation', 'train_station', 'hangar']);
const HOUSES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'cabin', 'allotment_house', 'farm', 'hut']);
const NOBODY = new Set(['garage', 'garages', 'shed', 'roof', 'barn', 'farm_auxiliary', 'greenhouse', 'kiosk', 'carport', 'service',
  'houseboat', 'ruins', 'bridge', 'pavilion', 'church', 'chapel', 'cathedral', 'toilets']);

export function useOf(kind: string, h: number): Use | null {
  if (NOBODY.has(kind)) return null;
  if (FLATS.has(kind)) return 'flats';
  if (WORK.has(kind)) return 'work';
  if (HOUSES.has(kind) && h < 10) return 'houses';
  if (kind === 'residential' || kind === 'yes' || HOUSES.has(kind)) return h >= 12 ? 'flats' : h >= 9 ? 'terrace' : 'houses';
  return h < 9 ? 'houses' : 'terrace';
}

// Cars standing out per kind of surroundings, day and night, where flats-and-tenement
// streets of a typical density stand: this is the share of kerb spots taken.
const RATE: Record<Use, [number, number]> = { flats: [0.88, 0.88], terrace: [0.65, 0.65], houses: [0.3, 0.3], work: [0.7, 0.3] };
// Floor area (m²) within reach of a typical built-up street; and how steeply the number
// of cars follows the amount of building around (TSK's counts: 48 % where there is a
// sixth of that, 88 % where there is three times as much).
const TYPICAL = 13000, STEEP = 0.3, REACH = 60;
const CELL = 50;
// A car park with no building in reach still has the odd car in it.
const EMPTY_LOT = 0.08;

interface Entry { x: number; y: number; floor: number; use: Use; reach: number }

export class Demand {
  private cells = new Map<number, Entry[]>();

  constructor(buildings: DemandBuilding[]) {
    const seen = new Set<string>();
    for (const b of buildings) {
      if (b.id) { if (seen.has(b.id)) continue; seen.add(b.id); }
      const use = useOf(b.kind, b.h);
      if (!use) continue;
      const ring = b.rings[0];
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const c = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        a += c; cx += (ring[j][0] + ring[i][0]) * c; cy += (ring[j][1] + ring[i][1]) * c;
      }
      const area = Math.abs(a) / 2;
      if (area < 1e-6) continue;
      const e: Entry = { x: cx / (3 * a), y: cy / (3 * a), floor: area * Math.max(1, Math.round(b.h / 3)), use, reach: Math.sqrt(area) / 2 };
      const k = Math.floor(e.x / CELL) * 131072 + Math.floor(e.y / CELL);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, list = []);
      list.push(e);
    }
  }

  // Floor area by use within reach of (x, y); a big building counts from further away.
  floors(x: number, y: number): Floors {
    const f: Floors = { flats: 0, terrace: 0, houses: 0, work: 0 };
    const r = REACH + 40, c0 = Math.floor((x - r) / CELL), c1 = Math.floor((x + r) / CELL), r0 = Math.floor((y - r) / CELL), r1 = Math.floor((y + r) / CELL);
    for (let i = c0; i <= c1; i++) for (let j = r0; j <= r1; j++) {
      const list = this.cells.get(i * 131072 + j);
      if (list) for (const e of list) if (Math.hypot(e.x - x, e.y - y) < REACH + e.reach) f[e.use] += e.floor;
    }
    return f;
  }
}

// The share of spots taken, 0–1: the mix of buildings sets how many cars each has, the
// amount of building how crowded the streets get; a car park is fuller than the kerb
// beside it.
export function occupancy(f: Floors, night: boolean, lot = false) {
  const total = f.flats + f.terrace + f.houses + f.work;
  if (total <= 0) return lot ? EMPTY_LOT : 0;
  const n = night ? 1 : 0;
  const rate = (f.flats * RATE.flats[n] + f.terrace * RATE.terrace[n] + f.houses * RATE.houses[n] + f.work * RATE.work[n]) / total;
  const occ = rate * Math.min(1.15, (total / TYPICAL) ** STEEP);
  return Math.min(1, lot ? Math.max(EMPTY_LOT, occ * 1.35) : occ);
}
