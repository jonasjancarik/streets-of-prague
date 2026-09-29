import { BusRun, busStart } from './buses.ts';
import type { BusLine } from './buses.ts';
import { COURIER_BOXES, Car, randomType } from './car.ts';
import { courierLook, randomLook } from './figures.ts';
import { MAIN_ROADS, Route, clamp, roadWeight } from './network.ts';
import type { DriveEdge, DriveGraph } from './network.ts';
import type { Signals } from './signals.ts';
import * as THREE from 'three';

export interface TrafficAgent {
  car: Car;
  route: Route;
  speed: number;
  stuck: number;
  jam: number;
  ignore: number;
  cruise: number;
  // How far right (+) or left of its lane it is steering round a car standing in the
  // way (m), and where it wants to be.
  off: number;
  gone?: boolean;
  // A bus on its line (buses.json): where it is along it and the stops it has served.
  bus?: BusRun;
  // Still up on the pavement (see adopt): this far right of the lane (m), with
  // `left` metres to go before it's back in it, the last `merge` of them pulling in.
  kerb?: { off: number; left: number; merge: number };
  // A taxi on a job (see taxi.ts): it stops at `stop`, keeps out of the clean-up round
  // the player, and with `reckless` drives like a ride-hailing driver late for the next fare.
  stop?: { edge: DriveEdge; s: number };
  hired?: boolean;
  reckless?: boolean;
}

// How busy the main roads are at each hour (0 = free-flowing, 1 = the slowest hour of
// the week), on weekdays, Saturdays and Sundays: how much slower TSK Praha's travel
// times on 73 main-road routes were than free flow, averaged over 2025 (published by
// Data Praha). Made by pipeline/build_traffic_profile.py.
const TRAFFIC_LOAD: Record<string, number[]> = {
  weekday: [0.04, 0.02, 0.02, 0.01, 0.02, 0.03, 0.21, 0.41, 0.60, 0.63, 0.64, 0.65, 0.65, 0.65, 0.73, 0.88, 1.00, 0.95, 0.72, 0.43, 0.30, 0.27, 0.11, 0.08],
  saturday: [0.06, 0.04, 0.03, 0.02, 0.02, 0.02, 0.12, 0.17, 0.21, 0.28, 0.36, 0.42, 0.43, 0.44, 0.47, 0.48, 0.50, 0.51, 0.49, 0.40, 0.33, 0.29, 0.13, 0.10],
  sunday: [0.06, 0.04, 0.03, 0.02, 0.02, 0.02, 0.12, 0.14, 0.18, 0.24, 0.31, 0.36, 0.39, 0.39, 0.41, 0.43, 0.45, 0.45, 0.41, 0.34, 0.29, 0.24, 0.09, 0.06],
};

// The cars kept about on the emptiest and the busiest roads.
const QUIET = 10, BUSY = 46;

// How many cars to keep about at clock time `t` (seconds into the week; see Clock).
// The hour's figure stands for the middle of the hour, with a straight line between.
// The square root is because travel times climb much faster than the number of cars
// once the roads are close to full.
export function trafficWanted(t: number): number {
  const day = Math.floor(t / 86400) % 7, h = ((t % 86400) / 3600 + 23.5) % 24;
  const row = TRAFFIC_LOAD[day === 5 ? 'saturday' : day === 6 ? 'sunday' : 'weekday'];
  const i = Math.floor(h), f = h - i;
  const load = row[i] * (1 - f) + row[(i + 1) % 24] * f;
  return Math.round(QUIET + (BUSY - QUIET) * Math.sqrt(load));
}

// The longest a car coming off the pavement takes to pull into its lane (m).
export const MERGE = 20;

// The furthest a car pulls out of its lane to get round a car standing in it (m), and
// how much room it leaves beside that car.
const SWERVE = 2.4, PASS = 0.35;

// Lorries keep to the motorways and, out in the suburbs (the warehouses and depots),
// the big roads. The centre of the map is the Old Town Square, in local metres.
const CENTRE = [-3205, 3097], SUBURB = 6500;
const BIG = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);
export function lorryRoad(e: DriveEdge): boolean {
  if (e.hw === 'motorway' || e.hw === 'motorway_link') return true;
  if (!BIG.has(e.hw)) return false;
  const p = e.path.at(e.path.length / 2);
  return Math.hypot(p.x - CENTRE[0], p.y - CENTRE[1]) > SUBURB;
}

interface Obstacle {
  x: number; y: number; z?: number; r: number; vx: number; vy: number;
  kind: string; car?: Car;
}

// AI traffic: cars glued to their lane along a Route. They brake for anything in
// front of them (cars, trams, people, the player), stop at red lights and give way
// to the right.
// A car that is hit hard enough leaves traffic and becomes a free body.

export class Traffic {
  g: DriveGraph;
  scene: THREE.Scene;
  r: () => number;
  count: number;
  agents: TrafficAgent[];
  // The bus lines through the area (buses.json); without them buses wander the main roads.
  busLines: BusLine[] = [];
  swerving = new Set<Car>();
  // The traffic lights at junctions.
  signals: Signals | null = null;

  constructor(graph: DriveGraph, scene: THREE.Scene, rng: () => number, count: number) {
    this.g = graph;
    this.scene = scene;
    this.r = rng;
    this.count = count;
    this.agents = [];
  }

  // A new car on a random street among `edges` (default: anywhere), where `avoid` allows.
  spawn(avoid: ((x: number, y: number) => boolean) | null, edges: DriveEdge[] = this.g.edges, type: string | null = null): TrafficAgent | null {
    const r = this.r;
    if (!edges.length) return null;
    // Ordinary cars start more often on the bigger roads (and lean towards them at
    // junctions); buses, taxis and police are placed as before.
    const ordinary = type === null;
    const weight = (e: DriveEdge) => e.path.length * (ordinary ? roadWeight(e.hw) : 1);
    const total = edges.reduce((a, e) => a + weight(e), 0);
    for (let tries = 0; tries < 40; tries++) {
      let x = r() * total, edge = edges[0];
      for (const e of edges) if ((x -= weight(e)) < 0) { edge = e; break; }
      if (edge.path.length < 12) continue;
      const bus = type === 'bus';
      // Now and then a lorry, where lorries may go.
      let kind = type || randomType(r, 'traffic');
      if (ordinary && lorryRoad(edge) && r() < (edge.hw.startsWith('motorway') ? 0.15 : 0.05)) kind = r() < 0.6 ? 'artic' : 'truck';
      const lorry = kind === 'truck' || kind === 'artic';
      const s = 4 + r() * (edge.path.length - 8);
      const p = edge.path.at(s);
      if (avoid && !avoid(p.x, p.y)) continue;
      if (this.agents.some((a) => Math.hypot(a.car.x - p.x, a.car.y - p.y) < (bus ? 20 : lorry ? 24 : 12))) continue;
      // Some of the ordinary bikes and mopeds are delivery couriers, with a box on their back.
      const box = ordinary && !lorry && (kind === 'bike' ? r() < 0.5 : kind === 'moto' && r() < 0.35) ? COURIER_BOXES[Math.floor(r() * COURIER_BOXES.length)] : undefined;
      const car = new Car(kind, r, p.x, p.y, p.ang, undefined, box);
      car.mode = 'traffic';
      // On a bridge, in a tunnel or on the ground under or over one (TileWorld.track).
      car.hint = edge.bridge ? 'bridge' : edge.tunnel ? 'tunnel' : 'ground';
      if (car.two) car.rider = box ? courierLook(r, box) : randomLook(r);
      const agent = { car, route: new Route(this.g, edge, s, r, bus, lorry ? (_e, opts) => { const ok = opts.filter(lorryRoad); return ok.length ? ok[Math.floor(r() * ok.length)] : null; } : undefined, ordinary && !lorry), speed: edge.speed * 0.6, stuck: 0, jam: 0, ignore: 0, cruise: 0.8 + r() * 0.3, off: 0 };
      this.agents.push(agent);
      return agent;
    }
    return null;
  }

  // Keep `want` buses about, on their lines (or, without them, on the main roads)
  // among `edges`, where `avoid` allows.
  buses(avoid: (x: number, y: number) => boolean, edges: DriveEdge[], want: number) {
    let n = 0;
    for (const a of this.agents) if (a.car.type === 'bus') n++;
    if (n >= want) return;
    if (this.busLines.length) {
      const start = busStart(this.busLines, edges, this.r, (x, y) => avoid(x, y) && !this.agents.some((a) => Math.hypot(a.car.x - x, a.car.y - y) < 20));
      if (!start) return;
      const { edge, s, run } = start;
      const p = edge.path.at(s);
      const car = new Car('bus', this.r, p.x, p.y, p.ang);
      car.mode = 'traffic';
      car.hint = 'ground';
      car.line = { ref: run.line.ref, to: run.line.to };
      this.agents.push({ car, route: new Route(this.g, edge, s, this.r, true, (e, opts) => run.pick(e, opts)), speed: edge.speed * 0.6, stuck: 0, jam: 0, ignore: 0, cruise: 0.9, off: 0, bus: run });
      return;
    }
    const main = edges.filter((e) => MAIN_ROADS.has(e.hw) && !e.bridge && !e.tunnel);
    if (main.length) this.spawn(avoid, main, 'bus');
  }

  // A parked car that joins the traffic from where it stands, `s` along `edge`: first
  // `run` metres along the pavement at walking pace, then over the kerb into the lane.
  adopt(car: Car, edge: DriveEdge, s: number, run: number) {
    const p = edge.path.at(s);
    const off = (car.x - p.x) * Math.sin(p.ang) - (car.y - p.y) * Math.cos(p.ang);
    car.mode = 'traffic';
    car.hint = 'ground';
    const agent: TrafficAgent = {
      car, route: new Route(this.g, edge, s, this.r), speed: 0, stuck: 0, jam: 0, ignore: 0, cruise: 0.8 + this.r() * 0.3, off: 0,
      // Pulling in over three times the distance it has to move across, so it doesn't swerve.
      kerb: { off, left: run + clamp(Math.abs(off) * 3, 8, MERGE), merge: clamp(Math.abs(off) * 3, 8, MERGE) },
    };
    this.agents.push(agent);
    return agent;
  }

  // Whether a car driving along the pavement is near (x, y).
  pavementNear(x: number, y: number, d: number) {
    return this.agents.some((a) => a.kerb && Math.abs(a.car.x - x) < d && Math.abs(a.car.y - y) < d);
  }

  release(agent: TrafficAgent) {
    agent.car.grounded = undefined;
    this.agents.splice(this.agents.indexOf(agent), 1);
  }

  // near(x, y, r): the obstacles ({ x, y, z, r, vx, vy, kind }) around a point.
  update(dt: number, near: (x: number, y: number, radius: number) => Iterable<Obstacle>) {
    // The cars out of their lanes, going round something: oncoming traffic stops for them.
    const out = this.swerving;
    out.clear();
    for (const a of this.agents) if (Math.abs(a.off) > 0.3) out.add(a.car);
    for (const a of this.agents) {
      const c = a.car, L = c.spec.L, W = c.spec.W;
      const look = a.route.lookahead(6 + a.speed * 1.2);
      // Cyclists keep to their own pace, whatever the limit.
      let target = a.reckless ? Math.min(look.limit * 1.4, c.spec.vmax * 0.9) : Math.min(look.limit * a.cruise, c.spec.vmax * 0.75);

      const fx = Math.cos(c.h), fy = Math.sin(c.h);
      const reach = L / 2 + 5 + a.speed * 1.6;
      // Where its lane is here, and which way it runs: what stands in the way is measured
      // across the lane, not across the car (turned while it pulls out).
      const here = a.route.leg.path.at(a.route.s), hx = Math.cos(here.ang), hy = Math.sin(here.ang);
      // Something standing a little left of the lane's middle on a two-way street is
      // still passed on its left, towards the middle of the street.
      const edge = a.route.leg.edge, keepLeft = edge?.oneway ? 0 : -0.5;
      // (Only along a street: through a junction, where the lane turns, across it says
      // little, and a car in the way is waited for as before.)
      const along0 = edge ? a.route.leg.s1 - a.route.s + 2 : -Infinity;
      let gap = Infinity, blocker = null;
      // Cars standing still (parked, left, crashed) near the lane: where this one may be
      // across from its lane (lo to hi) to get past them all, the nearest of them in
      // its way, and whether a car is coming the other way.
      let lo = -Infinity, hi = Infinity, stillGap = Infinity, still = null, oncoming = false;
      for (const o of near(c.x, c.y, reach + 8)) {
        if (o.car === c) continue;
        // On a bridge overhead, or under the one this car is on.
        if (o.z !== undefined && c.gz !== undefined && Math.abs(o.z - c.gz) > 3) continue;
        const dx = o.x - c.x, dy = o.y - c.y;
        if (Math.abs(dx) > reach + 8 || Math.abs(dy) > reach + 8) continue;
        const ahead = dx * fx + dy * fy;
        const side = dx * fy - dy * fx; // + = to the right
        const ov = Math.hypot(o.vx, o.vy);
        const lat = (o.x - here.x) * hy - (o.y - here.y) * hx, along = (o.x - here.x) * hx + (o.y - here.y) * hy;
        const parked = o.kind === 'car' && o.car?.mode !== 'traffic' && ov < 0.3 && along < along0;
        if (parked && along > -(L / 2 + o.r + 0.5) && along < reach + o.r) {
          // Pass it on the side away from where it stands across the lane, with room.
          const need = W / 2 + o.r + PASS;
          if (Math.abs(lat) < need + SWERVE) {
            if (lat >= keepLeft) hi = Math.min(hi, lat - need);
            else lo = Math.max(lo, lat + need);
          }
        }
        if (ahead < 0 || ahead > reach + o.r) continue;
        const inPath = Math.abs(side) < W / 2 + o.r + 0.25;
        if (o.kind === 'car' && ov > 1 && (o.vx * fx + o.vy * fy) / ov < -0.5 && lat < 0.5 && lat > -6) oncoming = true;
        if (parked) {
          // (Only if it is in the way where the car is now, not round the corner.)
          const d = ahead - L / 2 - o.r;
          if (inPath && d < stillGap) { stillGap = d; still = o; }
          continue;
        }
        // Out of its lane, it goes on past a car coming the other way that has stopped
        // for it, so long as they don't touch.
        if (out.has(c) && o.car?.mode === 'traffic' && Math.cos(o.car.h - c.h) < -0.5 && Math.abs(side) > W / 2 + o.r) continue;
        // Stuck a while (cars waiting for each other at a junction, a car left standing
        // on a corner): go anyway, but never into the back of the car ahead in the
        // same lane, or into a tram.
        if (a.ignore > 0 && o.kind !== 'person' && o.kind !== 'player') {
          const queue = o.kind === 'tram' || (o.car?.mode === 'traffic' && Math.cos(o.car.h - c.h) > 0.5);
          if (!queue || !inPath || ahead - L / 2 - o.r > 2) continue;
        }
        // Near the lookahead point too, so cars see what's round the corner.
        const lp = Math.hypot(o.x - look.p.x, o.y - look.p.y) < W / 2 + o.r + 0.4;
        if (!inPath && !lp) continue;
        if (o.kind === 'car' && ov > 1) {
          const cos = (o.vx * fx + o.vy * fy) / ov;
          // Oncoming traffic in its own lane is not in the way, unless it has pulled out
          // to get round something.
          if (cos < -0.5 && Math.abs(side) > 0.8 && !(o.car && out.has(o.car) && inPath)) continue;
          // Crossing traffic: give way to cars coming from the right only.
          if (Math.abs(cos) < 0.6 && side < -0.5 && ahead > L) continue;
        }
        const d = ahead - L / 2 - o.r;
        if (d < gap) { gap = d; blocker = o; }
      }
      // Where to be across the lane: as near its middle as gets past the cars standing
      // in it, within the street (on a street it knows) and never far out of the lane.
      // Pulling out towards the other side of the street waits for oncoming traffic.
      const left = Math.min(SWERVE, edge ? edge.laneOffset + edge.width / 2 - W / 2 : SWERVE);
      const right = Math.min(SWERVE, edge ? Math.max(0, edge.width / 2 - edge.laneOffset - W / 2) : 0.5);
      let want = clamp(0, lo, hi);
      const room = lo <= hi && want >= -left && want <= right;
      if (!room || a.kerb || (want < a.off - 0.05 && a.off > -0.3 && oncoming)) want = a.kerb ? 0 : a.off;
      if (!room && still && stillGap < gap) { gap = stillGap; blocker = still; }
      if (blocker) target = Math.min(target, Math.max(0, a.reckless ? (gap - 0.8) * 1.3 : (gap - 1.5) * 0.9));
      // Round a car in the way it slows down, and edges up to it while it pulls out.
      if (room && still) target = Math.min(target, 2.5, Math.max(0, (stillGap - 0.4) * 1.5));
      if (Math.abs(want) > 0.3 || Math.abs(a.off) > 0.3) target = Math.min(target, 6);
      // A bus on its line brakes for its next stop, stands there a while, and goes on.
      const run = a.bus;
      if (run && !run.lost) {
        run.track(c.x, c.y);
        const stop = run.line.stops[run.stop];
        if (run.dwell > 0) {
          target = 0;
          run.dwell -= dt;
          if (run.dwell <= 0) run.stop++;
        } else if (stop) {
          // (The front of the bus pulls up by the stop's sign.)
          const left = stop[0] - run.along - L / 2 + 1;
          if (left < -4) run.stop++;
          else if (left < 1 && a.speed < 0.6) run.dwell = 10 + this.r() * 5;
          else target = Math.min(target, Math.sqrt(2 * 1.1 * Math.max(0, left)) + 0.3);
        }
      }
      // Stopping at a red light (and at amber, if it can do so easily).
      let held = false;
      if (this.signals) {
        const light = this.signals.ahead(a.route, L / 2, a.speed, a.reckless);
        held = this.signals.held;
        if (light < Infinity) target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, light - 0.3)));
      }
      // Braking in time for where it has to stop.
      if (a.stop) target = Math.min(target, Math.sqrt(2 * 3 * Math.max(0, a.route.to(a.stop.edge, a.stop.s) - 0.3)));
      // On the pavement it creeps along, and a little faster pulling in.
      if (a.kerb) target = Math.min(target, a.kerb.left > a.kerb.merge ? 2.2 : 4);

      if (target < 0.3 && blocker) a.stuck += dt;
      else a.stuck = Math.max(0, a.stuck - dt * 2);
      if (a.stuck > (a.reckless ? 1.5 : 3.5)) { a.ignore = 1.5; a.stuck = 0; }
      // How long it's been standing in a queue that doesn't move (see main.ts); not
      // one waiting for the lights to change.
      a.jam = target < 0.3 && blocker && !held ? a.jam + dt : 0;
      a.ignore = Math.max(0, a.ignore - dt);

      // (A bus picks up speed slowly.)
      const acc = target > a.speed ? (c.spec.heavy ? 1.2 : 3) : 9;
      a.speed += clamp(target - a.speed, -acc * dt, acc * dt);
      const p = a.route.advance(a.speed * dt);
      if (a.route.ended || (c.spec.heavy && c.type !== 'bus' && !lorryRoad(a.route.head))) { a.gone = true; continue; }
      const prevX = c.x, prevY = c.y;
      c.x = p.x;
      c.y = p.y;
      let ang = p.ang;
      if (c.spec.heavy) {
        // A bus's or lorry's back wheels follow the lane, and its front ones are a wheelbase further on:
        // on a bend it lies across the inside of the curve rather than sticking out.
        const wb = c.spec.wheelbase ?? 6;
        const f = a.route.lookahead(wb).p;
        if (Math.hypot(f.x - p.x, f.y - p.y) > wb / 2) ang = Math.atan2(f.y - p.y, f.x - p.x);
        c.x = p.x + Math.cos(ang) * wb * 0.42;
        c.y = p.y + Math.sin(ang) * wb * 0.42;
      }
      if (a.kerb) {
        // Right of the lane by `off`, less and less over the last `merge` metres (a
        // smoothstep), turned towards the lane as it goes.
        const k = a.kerb;
        k.left -= a.speed * dt;
        const t = clamp(k.left / k.merge, 0, 1), f = t * t * (3 - 2 * t);
        c.x += Math.sin(p.ang) * k.off * f;
        c.y -= Math.cos(p.ang) * k.off * f;
        ang += Math.atan((k.off * 6 * t * (1 - t)) / k.merge);
        if (k.left <= 0) a.kerb = undefined;
      }
      // Across towards where it wants to be, faster the faster it goes (just edging out
      // when it has stopped), turned that way.
      const rate = clamp(a.speed * 0.5, 0.3, 1.6) * dt, shift = clamp(want - a.off, -rate, rate);
      a.off += shift;
      if (a.off) {
        c.x += Math.sin(p.ang) * a.off;
        c.y -= Math.cos(p.ang) * a.off;
        ang -= Math.atan2(shift, Math.max(a.speed, 1) * dt);
      }
      let dh = Math.atan2(Math.sin(ang - c.h), Math.cos(ang - c.h));
      c.h += dh * Math.min(1, dt * 10);
      c.vx = (c.x - prevX) / Math.max(dt, 1e-4);
      c.vy = (c.y - prevY) / Math.max(dt, 1e-4);
      c.w = 0;
      // On a street at ground level it is on the ground, whatever it passes over: a
      // tunnel just under the surface near its portal would otherwise take it in, and
      // it would sink into the road as the tunnel goes deeper (see TileWorld.track).
      // (Between two streets, on the ground only if both are.)
      const on = a.route.leg.edge, next = on ?? a.route.legs[1]?.edge;
      c.grounded = !!next && !next.bridge && !next.tunnel && (!!on || !!c.grounded);
      c.sync();
    }
    // Cars whose street runs off the loaded map just disappear.
    this.agents = this.agents.filter((a) => !a.gone);
  }
}
