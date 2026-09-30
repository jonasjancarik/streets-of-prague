import type { Crowd, Pedestrian } from './people.ts';
import type { Trams, TramVehicle } from './trams.ts';
import { HALF } from './trams.ts';

// People getting off and on the tram you drive, at the real stops. Stop with the front
// of the tram at a stop's sign and open the doors (X): some of the passengers step
// out, and people waiting nearby walk over and get in, each paying you a fare. The
// doors shut by themselves when everyone is in or out, and the tram can't move while
// they're open.

export interface Stop { x: number; y: number; ang: number; name: string }
export interface StopAhead { stop: Stop; dist: number }

const FARE = 20; // Kč from each person who gets on
const CELL = 50;
const AT_SIGN = 9; // m: how near the front has to be to a stop's sign to open the doors there
const WAITING = 28; // m: people this near the stop come to get on
const MAX_ON = 8, MAX_OFF = 7;
const OUT = 1.6; // m from a section's middle to its door

export class Passengers {
  stops: Stop[] = [];
  doors = false;
  off = 0; // got off at this stop
  on = 0; // got on
  private grid = new Map<number, Stop[]>();
  private leaving = 0;
  private timer = 0;
  private spawnT = 0;
  private boarding: Pedestrian[] = [];
  private v: TramVehicle | null = null;

  constructor(trams: Trams, private crowd: () => Crowd, private pay: (kc: number) => void, private rng: () => number) {
    for (const line of trams.lines) {
      for (const h of line.halts) {
        const p = line.path.at(h.s);
        if (this.near(p.x, p.y, 12).some((s) => s.name === h.name)) continue;
        const stop = { x: p.x, y: p.y, ang: p.ang, name: h.name };
        this.stops.push(stop);
        const k = this.key(p.x, p.y);
        const b = this.grid.get(k);
        if (b) b.push(stop); else this.grid.set(k, [stop]);
      }
    }
  }

  private key(x: number, y: number) { return Math.floor(x / CELL) * 131072 + Math.floor(y / CELL); }

  near(x: number, y: number, r: number) {
    const out: Stop[] = [];
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((y - r) / CELL); j <= Math.floor((y + r) / CELL); j++) {
        for (const s of this.grid.get(i * 131072 + j) || []) if (Math.hypot(s.x - x, s.y - y) <= r) out.push(s);
      }
    }
    return out;
  }

  // A stop that the tram is going the right way along (not the one across the street).
  private facing(s: Stop, ang: number) { return Math.cos(s.ang - ang) > 0.5; }

  // The stop the front of the tram is at, if it is.
  at(v: TramVehicle) {
    const f = v.line.path.at(v.s + HALF);
    return this.near(f.x, f.y, AT_SIGN).find((s) => this.facing(s, f.ang)) ?? null;
  }

  // The next stop along the track within `reach` m of the front, and how far it is.
  ahead(v: TramVehicle, reach = 350): StopAhead | null {
    const path = v.line.path, front = v.s + HALF;
    for (let d = 0; d <= reach; d += 10) {
      const p = path.at(front + d), s = this.near(p.x, p.y, 7).find((q) => this.facing(q, p.ang));
      if (s) return { stop: s, dist: d };
    }
    return null;
  }

  private doorsAt(v: TramVehicle) {
    return v.parts.map((p) => ({ x: p.x + Math.sin(p.ang) * OUT, y: p.y - Math.cos(p.ang) * OUT, ang: p.ang }));
  }

  // Open the doors, if the tram stands at a stop.
  open(v: TramVehicle) {
    if (this.doors || v.speed > 0.3 || !this.at(v)) return false;
    const crowd = this.crowd(), mid = v.parts[1];
    this.v = v;
    this.doors = true;
    this.off = this.on = 0;
    this.timer = 0;
    this.spawnT = 0;
    this.leaving = 1 + Math.floor(this.rng() * MAX_OFF);
    this.boarding = crowd.people
      .filter((p) => (p.state === 'walk' || p.state === 'rejoin') && Math.hypot(p.x - mid.x, p.y - mid.y) < WAITING)
      .sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y))
      .slice(0, 1 + Math.floor(this.rng() * MAX_ON));
    return true;
  }

  close() {
    this.doors = false;
    for (const p of this.boarding) if (p.state === 'flee') p.t = 0; // they go back to their walk
    this.boarding = [];
    this.v = null;
  }

  update(dt: number) {
    const v = this.v;
    if (!this.doors || !v) return;
    const crowd = this.crowd(), doors = this.doorsAt(v);
    this.timer += dt;
    this.spawnT -= dt;
    if (this.leaving > 0 && this.spawnT <= 0) {
      this.spawnT = 0.6 + this.rng() * 0.6;
      const d = doors[Math.floor(this.rng() * doors.length)], p = crowd.spawnAt(d.x, d.y);
      Object.assign(p, { state: 'flee', t: 2 + this.rng(), vx: Math.sin(d.ang) * 1.5, vy: -Math.cos(d.ang) * 1.5 });
      this.leaving--;
      this.off++;
    }
    this.boarding = this.boarding.filter((p) => {
      if (p.state === 'down' || !crowd.people.includes(p)) return false;
      let best = doors[0], bd = Infinity;
      for (const d of doors) {
        const e = Math.hypot(d.x - p.x, d.y - p.y);
        if (e < bd) { bd = e; best = d; }
      }
      if (bd < 1.1) {
        crowd.retire(p);
        this.on++;
        this.pay(FARE);
        return false;
      }
      Object.assign(p, { state: 'flee', t: 2, vx: ((best.x - p.x) / bd) * 1.8, vy: ((best.y - p.y) / bd) * 1.8 });
      return true;
    });
    if ((this.leaving === 0 && !this.boarding.length && this.timer > 3) || this.timer > 25) this.close();
  }
}
