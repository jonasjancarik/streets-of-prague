import { Car, randomType } from './car.ts';
import { randomLook } from './figures.ts';
import { Route, clamp } from './network.ts';
import type { DriveEdge, DriveGraph } from './network.ts';
import * as THREE from 'three';

interface TrafficAgent {
  car: Car & { level: number; gz?: number };
  route: Route;
  speed: number;
  stuck: number;
  jam: number;
  ignore: number;
  cruise: number;
  gone?: boolean;
}

interface Obstacle {
  x: number; y: number; z?: number; r: number; vx: number; vy: number;
  kind: string; car?: Car;
}

// AI traffic: cars glued to their lane along a Route. They brake for anything in
// front of them (cars, trams, people, the player) and give way to the right.
// A car that is hit hard enough leaves traffic and becomes a free body.

export class Traffic {
  g: DriveGraph;
  scene: THREE.Scene;
  r: () => number;
  count: number;
  agents: TrafficAgent[];

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
    const total = edges.reduce((a, e) => a + e.path.length, 0);
    for (let tries = 0; tries < 40; tries++) {
      let x = r() * total, edge = edges[0];
      for (const e of edges) if ((x -= e.path.length) < 0) { edge = e; break; }
      if (edge.path.length < 12) continue;
      const s = 4 + r() * (edge.path.length - 8);
      const p = edge.path.at(s);
      if (avoid && !avoid(p.x, p.y)) continue;
      if (this.agents.some((a) => Math.hypot(a.car.x - p.x, a.car.y - p.y) < 12)) continue;
      const car = new Car(type || randomType(r, 'traffic'), r, p.x, p.y, p.ang) as Car & { level: number; gz?: number };
      car.mode = 'traffic';
      car.level = edge.bridge ? 1 : 0; // on a bridge's deck, or under it (TileWorld.track)
      if (car.two) car.rider = randomLook(r);
      const agent = { car, route: new Route(this.g, edge, s, r), speed: edge.speed * 0.6, stuck: 0, jam: 0, ignore: 0, cruise: 0.8 + r() * 0.3 };
      this.agents.push(agent);
      return agent;
    }
    return null;
  }

  release(agent: TrafficAgent) {
    this.agents.splice(this.agents.indexOf(agent), 1);
  }

  // near(x, y, r): the obstacles ({ x, y, z, r, vx, vy, kind }) around a point.
  update(dt: number, near: (x: number, y: number, radius: number) => Iterable<Obstacle>) {
    for (const a of this.agents) {
      const c = a.car, L = c.spec.L, W = c.spec.W;
      const look = a.route.lookahead(6 + a.speed * 1.2);
      // Cyclists keep to their own pace, whatever the limit.
      let target = Math.min(look.limit * a.cruise, c.spec.vmax * 0.75);

      const fx = Math.cos(c.h), fy = Math.sin(c.h);
      const reach = L / 2 + 5 + a.speed * 1.6;
      let gap = Infinity, blocker = null;
      for (const o of near(c.x, c.y, reach + 8)) {
        if (o.car === c) continue;
        // On a bridge overhead, or under the one this car is on.
        if (o.z !== undefined && c.gz !== undefined && Math.abs(o.z - c.gz) > 3) continue;
        const dx = o.x - c.x, dy = o.y - c.y;
        if (Math.abs(dx) > reach + 8 || Math.abs(dy) > reach + 8) continue;
        const ahead = dx * fx + dy * fy;
        const side = dx * fy - dy * fx; // + = to the right
        if (ahead < 0 || ahead > reach + o.r) continue;
        const inPath = Math.abs(side) < W / 2 + o.r + 0.25;
        // Stuck a while (cars waiting for each other at a junction, a parked car
        // sticking out into the lane): go anyway, but never into the back of the car
        // ahead in the same lane, or into a tram.
        if (a.ignore > 0 && o.kind !== 'person' && o.kind !== 'player') {
          const queue = o.kind === 'tram' || (o.car?.mode === 'traffic' && Math.cos(o.car.h - c.h) > 0.5);
          if (!queue || !inPath || ahead - L / 2 - o.r > 2) continue;
        }
        // Near the lookahead point too, so cars see what's round the corner.
        const lp = Math.hypot(o.x - look.p.x, o.y - look.p.y) < W / 2 + o.r + 0.4;
        if (!inPath && !lp) continue;
        const ov = Math.hypot(o.vx, o.vy);
        if (o.kind === 'car' && ov > 1) {
          const cos = (o.vx * fx + o.vy * fy) / ov;
          // Oncoming traffic in its own lane is not in the way.
          if (cos < -0.5 && Math.abs(side) > 0.8) continue;
          // Crossing traffic: give way to cars coming from the right only.
          if (Math.abs(cos) < 0.6 && side < -0.5 && ahead > L) continue;
        }
        const d = ahead - L / 2 - o.r;
        if (d < gap) { gap = d; blocker = o; }
      }
      if (blocker) target = Math.min(target, Math.max(0, (gap - 1.5) * 0.9));

      if (target < 0.3 && blocker) a.stuck += dt;
      else a.stuck = Math.max(0, a.stuck - dt * 2);
      if (a.stuck > 3.5) { a.ignore = 1.5; a.stuck = 0; }
      // How long it's been standing in a queue that doesn't move (see main.ts).
      a.jam = target < 0.3 && blocker ? a.jam + dt : 0;
      a.ignore = Math.max(0, a.ignore - dt);

      const acc = target > a.speed ? 3 : 9;
      a.speed += clamp(target - a.speed, -acc * dt, acc * dt);
      const p = a.route.advance(a.speed * dt);
      if (a.route.ended) { a.gone = true; continue; }
      const prevX = c.x, prevY = c.y;
      c.x = p.x;
      c.y = p.y;
      let dh = Math.atan2(Math.sin(p.ang - c.h), Math.cos(p.ang - c.h));
      c.h += dh * Math.min(1, dt * 10);
      c.vx = (c.x - prevX) / Math.max(dt, 1e-4);
      c.vy = (c.y - prevY) / Math.max(dt, 1e-4);
      c.w = 0;
      c.sync();
    }
    // Cars whose street runs off the loaded map just disappear.
    this.agents = this.agents.filter((a) => !a.gone);
  }
}
