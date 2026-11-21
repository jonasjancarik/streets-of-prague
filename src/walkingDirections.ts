// The pedestrian graph runs both ways, including down stairs and through arcades.
// If the destination lies beyond the loaded neighbourhood, follow connected paths
// towards it and extend the route as new tiles arrive.
import { project, turnOf } from './assist.ts';
import { Polyline, type WalkEdge, type WalkGraph } from './network.ts';
import { Heap, slicePath } from './pathfinding.ts';
import type { Point2 } from './map/geo.ts';

type Spot = { x: number; y: number; level?: number };
type Access = (a: Point2, b: Point2, level: number) => boolean;
type Near = (x: number, y: number, r: number) => WalkEdge[];
interface Leg {
  e: WalkEdge;
  from: number;
  to: number;
}
export interface WalkingTurn {
  at: number;
  kind: 'left' | 'right' | 'back' | 'stairs';
  onto: string | null;
}
export interface WalkingWay {
  line: Polyline;
  turns: WalkingTurn[];
  reached: boolean;
  streets: number;
  nearestPath: boolean;
}
export interface Footpaths {
  graph: WalkGraph;
  near: Near;
  accessible?: Access;
}

function nearest(near: Near, p: Spot, radius: number, accessible?: Access) {
  let best: { e: WalkEdge; s: number; d: number } | null = null;
  for (const e of new Set(near(p.x, p.y, radius))) {
    if (e.path.length < .01) continue;
    const hit = project(e.path, p.x, p.y);
    if (p.level !== undefined) {
      let level = e.level;
      if (e.levels) {
        for (const [start, span] of e.levels) {
          if (start > hit.s) break;
          level = span;
        }
      }
      if (level !== undefined ? level !== p.level : Math.sign(p.level) !== (e.bridge ? 1 : e.tunnel ? -1 : 0)) continue;
    }
    if (hit.d >= radius || (best && hit.d >= best.d)) continue;
    const q = e.path.at(hit.s);
    if (!accessible || accessible([p.x, p.y], [q.x, q.y], p.level ?? 0)) best = { e, s: hit.s, d: hit.d };
  }
  return best;
}

function follow(legs: Leg[], goal: Spot | null, accessible?: Access): WalkingWay | null {
  const pts: Point2[] = [], turns: WalkingTurn[] = [];
  let distance = 0, previous: WalkEdge | undefined, incoming: number | undefined;
  for (const { e, from, to } of legs) {
    if (Math.abs(to - from) < .02) continue;
    const points = slicePath(e.path, from, to);
    const a = points[0], b = points[1], out = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const angle = incoming === undefined ? 0 : turnOf(incoming, out);
    const kind = e.hw === 'steps' && previous?.hw !== 'steps'
      ? 'stairs'
      : Math.abs(angle) > 2.65
      ? 'back'
      : Math.abs(angle) > .82
      ? (angle > 0 ? 'left' : 'right')
      : null;
    if (kind) turns.push({ at: distance, kind, onto: e.name && previous?.name !== e.name ? e.name : null });
    for (const p of points) {
      const last = pts[pts.length - 1];
      const d = last ? Math.hypot(p[0] - last[0], p[1] - last[1]) : 0;
      if (last && d < .02) continue;
      distance += d;
      pts.push(p);
    }
    if (pts.length > 1) {
      const last = pts[pts.length - 1], before = pts[pts.length - 2];
      incoming = Math.atan2(last[1] - before[1], last[0] - before[0]);
    }
    previous = e;
  }
  let nearestPath = false;
  if (goal && legs.length) {
    const leg = legs[legs.length - 1], q = leg.e.path.at(leg.to);
    const last: Point2 = pts[pts.length - 1] ?? [q.x, q.y], pin: Point2 = [goal.x, goal.y];
    if (!pts.length) pts.push(last);
    if (Math.hypot(last[0] - pin[0], last[1] - pin[1]) > .25) {
      if (!accessible || accessible(last, pin, leg.e.level ?? (leg.e.bridge ? 1 : leg.e.tunnel ? -1 : 0))) pts.push(pin);
      else nearestPath = true;
    }
  }
  // A pin behind a wall may project onto the very point where the player stands.
  if (pts.length === 1 && nearestPath) pts.push([...pts[0]]);
  return pts.length > 1 ? { line: new Polyline(pts), turns, reached: !!goal, nearestPath, streets: legs.length } : null;
}

export function* walkingSearch(
  { graph, near, accessible }: Footpaths,
  from: Spot,
  goal: Spot,
): Generator<void, WalkingWay | null> {
  let began = performance.now();
  const a = nearest(near, from, 30, accessible);
  if (!a) return null;
  if (performance.now() - began > 1.5) {
    yield;
    began = performance.now();
  }
  const b = nearest(near, goal, 20);
  if (b?.e === a.e) return follow([{ e: a.e, from: a.s, to: b.s }], goal, accessible);
  const costs = new Map<string, number>(), came = new Map<string, { parent: string | null; leg: Leg }>(), open = new Heap();
  let end: string | null = null, remaining = Infinity, bestCost = Infinity, finish: Leg | null = null;
  const target = b ? b.e.path.at(b.s) : goal;
  const relax = (node: string, parent: string | null, leg: Leg, cost: number) => {
    if (cost >= (costs.get(node) ?? Infinity)) return;
    costs.set(node, cost);
    came.set(node, { parent, leg });
    const p = leg.e.path.at(leg.to), d = Math.hypot(target.x - p.x, target.y - p.y);
    open.push([cost + d, node]);
    if (!finish && d < remaining) {
      remaining = d;
      end = node;
    }
    if (b && (node === b.e.u || node === b.e.v)) {
      const s = node === b.e.u ? 0 : b.e.path.length, total = cost + Math.abs(b.s - s);
      if (total < bestCost) {
        bestCost = total;
        end = node;
        finish = { e: b.e, from: s, to: b.s };
      }
    }
  };
  relax(a.e.u, null, { e: a.e, from: a.s, to: 0 }, a.s);
  relax(a.e.v, null, { e: a.e, from: a.s, to: a.e.path.length }, a.e.path.length - a.s);
  for (let i = 0; open.size && i < 7000; i++) {
    // A destination across Prague can require the whole loaded neighbourhood.
    // Share that search over frames while the player keeps moving.
    if ((i & 31) === 31 && performance.now() - began > 1.5) {
      yield;
      began = performance.now();
    }
    const [score, node] = open.pop()!;
    if (score >= bestCost) break;
    const cost = costs.get(node)!, leg = came.get(node)!.leg, p = leg.e.path.at(leg.to);
    if (score > cost + Math.hypot(target.x - p.x, target.y - p.y) + 1e-5) continue;
    for (const { e, fwd } of graph.adj.get(node) ?? []) {
      const next = fwd ? e.v : e.u;
      // Favour a separately mapped pavement when two walks are otherwise similar.
      const length = e.path.length, nextCost = cost + length * (e.side > 0 ? 1.08 : 1);
      if (nextCost >= (costs.get(next) ?? Infinity)) continue;
      relax(next, node, { e, from: fwd ? 0 : length, to: fwd ? length : 0 }, nextCost);
    }
  }
  if (end === null || (!finish && remaining + 2 >= Math.hypot(target.x - from.x, target.y - from.y))) return null;
  const legs: Leg[] = [];
  for (let n: string | null = end; n !== null;) {
    const step: { parent: string | null; leg: Leg } = came.get(n)!;
    legs.push(step.leg);
    n = step.parent;
  }
  legs.reverse();
  if (finish) legs.push(finish);
  return follow(legs, finish ? goal : null, accessible);
}
