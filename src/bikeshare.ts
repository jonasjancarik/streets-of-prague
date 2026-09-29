import { Car } from './car.ts';
import type { WalkEdge } from './network.ts';
import type { Point2 } from './map/geo.ts';

// Shared bikes (data/<area>_now/bikes.json, from pipeline/build_bikes.py): nextbike's
// stations, and Rekola's and the others' where the data has them. Near you each
// station has a row of its bikes, in the system's colour, standing as in a rack along
// the pavement.
//
// Riding one is a rental: it starts when you get on a bike from a station and ends
// when you get off it near a station of the same system; getting off anywhere else
// only parks it, and the rental goes on. Every finished rental is kept (`done`), with
// how long it took by the game's clock and the system's pricing plans (GBFS) in the
// data: that is where paying for rides will go. Until then every ride is free.

export interface BikeSystem {
  id: string; name: string; operator: string; url: string | null; colour: string;
  apps: unknown; plans: PricingPlan[];
}
// GBFS system_pricing_plans (v2.3), as the operator publishes them.
export interface PricingPlan {
  plan_id: string; name: string | { text: string; language: string }[]; currency: string; price: number;
  per_min_pricing?: { start: number; interval: number; rate: number; end?: number }[];
}
interface Station { x: number; y: number; system: number; capacity: number; id: string; name: string; left: number; stocked: boolean }
export interface Rental { system: BikeSystem; from: string; to: string | null; since: number; seconds: number }
interface Data { systems: BikeSystem[]; stations: [number, number, number, number, string, string][] }

const CELL = 200; // m, the stations' grid
const STOCK_R = 300; // stations this close get their bikes
const RETURN_R = 25; // m from a station to leave a bike there
const MOST = 8; // bikes at a station, at most (a big one keeps the rest out of sight)
const GAP = 0.8; // m between bikes in a row
const WEEK = 7 * 86400;

export interface BikeWorld {
  loose: Car[];
  free: (x: number, y: number) => boolean; // loaded and open ground
  loaded: (x: number, y: number) => boolean;
  walkNear: (x: number, y: number, r: number) => WalkEdge[];
  standAt: (x: number, y: number) => Point2;
  seeded: () => number;
}

export class BikeShare {
  systems: BikeSystem[] = [];
  stations: Station[] = [];
  done: Rental[] = [];
  private grid = new Map<string, Station[]>();
  private bikes = new Map<Station, Car[]>();
  private rentals = new Map<Car, Rental>();

  constructor(area: string) {
    void fetch(`data/${area}_now/bikes.json`).then((r) => (r.ok ? r.json() as Promise<Data> : null)).then((d) => {
      if (!d) return;
      this.systems = d.systems;
      for (const [x, y, system, capacity, id, name] of d.stations) {
        // How many bikes stand there: a third to four fifths of its places, one at least.
        const h = hash(id);
        const st = { x, y, system, capacity, id, name, left: Math.max(1, Math.round((capacity || 4) * (0.33 + 0.47 * h))), stocked: false };
        this.stations.push(st);
        const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
        (this.grid.get(k) || this.grid.set(k, []).get(k)!).push(st);
      }
    }).catch(() => {});
  }

  private near(x: number, y: number, r: number) {
    const out: Station[] = [];
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++)
      for (let j = Math.floor((y - r) / CELL); j <= Math.floor((y + r) / CELL); j++)
        for (const st of this.grid.get(`${i},${j}`) || []) if (Math.hypot(st.x - x, st.y - y) < r) out.push(st);
    return out;
  }

  // Now and then: stations near (x, y) get their bikes, and forget them once they're
  // gone with the rest of the far loose cars. A rented bike left parked far away goes
  // too, and its rental ends there, not returned (`to` null).
  update(x: number, y: number, now: number, w: BikeWorld) {
    for (const [c, rental] of this.rentals) {
      if (c.mode === 'player' || w.loose.includes(c)) continue;
      this.rentals.delete(c);
      this.done.push({ ...rental, seconds: (((now - rental.since) % WEEK) + WEEK) % WEEK });
    }
    for (const [st, cars] of this.bikes) {
      const still = cars.filter((c) => w.loose.includes(c) && c.share?.station === st.id);
      if (still.length) this.bikes.set(st, still);
      else { this.bikes.delete(st); st.stocked = false; }
    }
    for (const st of this.near(x, y, STOCK_R)) if (!st.stocked && w.loaded(st.x, st.y)) this.stock(st, w);
  }

  // A row of bikes along the nearest footpath, side by side, their fronts to the path.
  private stock(st: Station, w: BikeWorld) {
    st.stocked = true;
    const [ax, ay] = w.free(st.x, st.y) ? [st.x, st.y] : w.standAt(st.x, st.y);
    let ang = 0, best = Infinity;
    for (const e of w.walkNear(ax, ay, 40)) {
      for (let s = 0; s <= e.path.length; s += 2) {
        const q = e.path.at(s), d = Math.hypot(q.x - ax, q.y - ay);
        if (d < best) { best = d; ang = q.ang; }
      }
    }
    const n = Math.min(st.left, MOST), ux = Math.cos(ang), uy = Math.sin(ang);
    const sys = this.systems[st.system], cars: Car[] = [];
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * GAP, x = ax + ux * o, y = ay + uy * o;
      if (w.loose.some((c) => Math.abs(c.x - x) < 0.6 && Math.abs(c.y - y) < 0.6)) continue;
      const c = new Car('bike', w.seeded, x, y, ang + Math.PI / 2 + (w.seeded() - 0.5) * 0.12, sys?.colour);
      if (!c.worldSamples().every(([sx, sy]) => w.free(sx, sy))) continue;
      c.share = { system: st.system, station: st.id };
      w.loose.push(c);
      cars.push(c);
    }
    if (cars.length) this.bikes.set(st, cars);
  }

  // Getting on a shared bike (`now`: the game's clock). A bike from a station starts a
  // rental; one you parked on the way is still yours. False would mean you can't take
  // it (when rides cost money: you can't pay).
  rent(c: Car, now: number) {
    if (!c.share || this.rentals.has(c)) return true;
    const st = this.stations.find((s) => s.id === c.share!.station);
    if (st) st.left = Math.max(0, st.left - 1);
    this.rentals.set(c, { system: this.systems[c.share.system], from: c.share.station ?? '', to: null, since: now, seconds: 0 });
    c.share.station = null;
    return true;
  }

  // Getting off: near a station of its system the bike is returned there and the
  // rental ends (it's returned, to be paid for); anywhere else it's only parked.
  leave(c: Car, now: number): Rental | null {
    const rental = this.rentals.get(c);
    if (!c.share || !rental) return null;
    const st = this.near(c.x, c.y, RETURN_R).find((s) => s.system === c.share!.system);
    if (!st) return null;
    st.left++;
    c.share.station = st.id;
    (this.bikes.get(st) || this.bikes.set(st, []).get(st)!).push(c);
    this.rentals.delete(c);
    Object.assign(rental, { to: st.id, seconds: (((now - rental.since) % WEEK) + WEEK) % WEEK });
    this.done.push(rental);
    return rental;
  }
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
