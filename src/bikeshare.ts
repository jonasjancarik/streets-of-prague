import { Car } from './car.ts';
import type { WalkEdge } from './network.ts';
import type { Point2 } from './map/geo.ts';
import { rentalCost, type PricingPlan } from './pricing.ts';

// Shared bikes (data/<area>_now/bikes.json, from pipeline/build_bikes.py): nextbike's
// stations, and Rekola's and the others' where the data has them. Near you each
// station has a row of its bikes, in the system's colour, standing as in a rack along
// the pavement.
//
// Riding one is a rental: it starts when you get on a bike from a station and ends
// when you get off it near a station of the same system; getting off anywhere else
// only parks it, and the rental goes on. Every finished rental is kept (`done`), with
// how long it took by the game's clock and what it cost. The price follows the system's
// pricing plan (GBFS): each interval is paid for as it begins, up to the plan's cap.
// A rented bike left parked far from you, or burnt out, costs a fee on top.

export interface BikeSystem {
  id: string; name: string; operator: string; url: string | null; colour: string;
  apps: unknown; plans: PricingPlan[];
}
interface Station { x: number; y: number; system: number; capacity: number; id: string; name: string; left: number; stocked: boolean }
export interface Rental { system: BikeSystem; from: string; to: string | null; since: number; seconds: number; paid: number }
interface Data { systems: BikeSystem[]; stations: [number, number, number, number, string, string][] }

const CELL = 200; // m, the stations' grid
const STOCK_R = 300; // stations this close get their bikes
const RETURN_R = 25; // m from a station to leave a bike there
const MOST = 8; // bikes at a station, at most (a big one keeps the rest out of sight)
const GAP = 0.8; // m between bikes in a row
const WEEK = 7 * 86400;
const ABANDON = 300; // m from you: a rented bike parked farther is given up
const FEE_OFF_STATION = 500; // Kč for a bike given up
const FEE_FAR = 1000; // Kč when the nearest station of its system is over 3 km away

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
  private gone: { rental: Rental; fee: number }[] = [];

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
      this.end(rental, c, now, true);
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

  private end(rental: Rental, c: Car, now: number, abandoned: boolean) {
    rental.seconds = (((now - rental.since) % WEEK) + WEEK) % WEEK;
    this.done.push(rental);
    if (!abandoned) return;
    const d = this.stations.reduce((m, s) => (s.system === c.share?.system ? Math.min(m, Math.hypot(s.x - c.x, s.y - c.y)) : m), Infinity);
    this.gone.push({ rental, fee: d > 3000 ? FEE_FAR : FEE_OFF_STATION });
  }

  planOf(system: BikeSystem): PricingPlan | undefined {
    return system.plans.find((p) => p.per_min_pricing?.length) || system.plans[0];
  }

  rental(c: Car) { return this.rentals.get(c); }

  // Getting on a shared bike (`now`: the game's clock). A bike from a station starts a
  // rental, if you can afford its start (`afford`); one you parked on the way is still yours.
  rent(c: Car, now: number, afford: (price: number) => boolean) {
    if (!c.share || this.rentals.has(c)) return true;
    const sys = this.systems[c.share.system];
    if (!afford(rentalCost(sys && this.planOf(sys), 0))) return false;
    const st = this.stations.find((s) => s.id === c.share!.station);
    if (st) st.left = Math.max(0, st.left - 1);
    this.rentals.set(c, { system: this.systems[c.share.system], from: c.share.station ?? '', to: null, since: now, seconds: 0, paid: 0 });
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
    rental.to = st.id;
    this.end(rental, c, now, false);
    return rental;
  }

  // What each rental owes by now, less what it has paid: `take` gets the amount and
  // returns what it could take.
  charge(now: number, take: (n: number) => number) {
    for (const rental of this.rentals.values()) {
      const minutes = (((now - rental.since) % WEEK) + WEEK) % WEEK / 60;
      const due = rentalCost(this.planOf(rental.system), minutes) - rental.paid;
      if (due > 0) rental.paid += take(due);
    }
  }

  // Rented bikes given up: parked far from you, burnt out, or gone. Each ends its
  // rental and owes a fee.
  abandon(px: number, py: number, now: number) {
    for (const [c, rental] of this.rentals) {
      if (c.mode === 'player' || !(c.burnt || Math.hypot(c.x - px, c.y - py) > ABANDON)) continue;
      this.rentals.delete(c);
      this.end(rental, c, now, true);
    }
    return this.gone.splice(0);
  }
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
