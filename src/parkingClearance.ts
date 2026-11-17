import { junctionCurve, junctionTrim, segDist, SpatialHash } from './network.ts';
import type { DriveEdge, RawStreetEdge } from './network.ts';
import { onPolygons, type Point2, type Bounds, type Polygons } from './map/geo.ts';
import { TYPES } from './car.ts';
import type { Car } from './car.ts';
import { distanceToCarBody } from './treeEscape.ts';

export interface ParkingObstacle { x: number; y: number; radius: number }

// Parking aisles can be present only in the walk graph so through traffic does
// not route through a lot. Keep them clear wherever a lot covers the way.
export function* parkingAisles(walk: RawStreetEdge[], drive: RawStreetEdge[], lots: Polygons): Generator<ParkingObstacle> {
  if (!lots.length || !walk.length) return;
  const isLot = onPolygons(lots);
  const endpoints = ({ u, v }: RawStreetEdge) => u < v ? `${u}>${v}` : `${v}>${u}`;
  const used = new Set(drive.map(endpoints));
  for (const edge of walk) {
    if (edge.hw !== 'service' || edge.bridge || edge.tunnel || edge.level || edge.levels || !(edge.width > 0)) continue;
    const key = endpoints(edge);
    if (used.has(key)) continue;
    used.add(key);
    const radius = Math.min(edge.width / 2, 3);
    for (let i = 1; i < edge.pts.length; i++) {
      const [x, y] = edge.pts[i - 1], [u, v] = edge.pts[i];
      const dx = u - x, dy = v - y;
      const steps = Math.ceil(Math.hypot(dx, dy) / 0.8);
      if (!steps) continue;
      for (let j = i === 1 ? 0 : 1; j <= steps; j++) {
        const a = x + dx * j / steps, b = y + dy * j / steps;
        if (isLot(a, b)) yield { x: a, y: b, radius };
      }
    }
  }
}

// A trunk or landing inside the body can miss every sampled point on its outline.
export function parkingObstacleClearance(obstacles?: Iterable<ParkingObstacle>) {
  const index = new SpatialHash<ParkingObstacle>();
  let radius = 0;
  for (const obstacle of new Set(obstacles)) {
    index.add(obstacle);
    radius = Math.max(radius, obstacle.radius);
  }
  const candidates: ParkingObstacle[] = [];
  return (car: Car) => {
    if (!radius) return true;
    const [halfLength, halfWidth] = car.samples[0];
    candidates.length = 0;
    index.near(car.x, car.y, Math.hypot(halfLength, halfWidth) + radius, candidates);
    return candidates.every((obstacle) => distanceToCarBody(car, obstacle.x, obstacle.y) > obstacle.radius);
  };
}

// Built once per parking pass, including the neighbouring tiles' roads. No live
// graph lookups or rebuilding while cars move. Bridges/tunnels occupy another level.
export function parkingClearance(edges: DriveEdge[], box?: Bounds) {
  return finish(clearanceSteps(edges, box));
}

// Runs a step-wise job (below, and parkCarsSteps) to its end at once.
export function finish<T>(steps: Generator<void, T>): T {
  for (;;) {
    const s = steps.next();
    if (s.done) return s.value;
  }
}

// The same, a street at a time: it pauses (yields) after each, so the game can spread
// the work over frames (TileWorld's jobs). It takes tens of milliseconds a tile on a phone.
export function* clearanceSteps(edges: DriveEdge[], box?: Bounds): Generator<void, (x: number, y: number, radius: number) => boolean> {
  type Segment = { a: Point2; b: Point2; clearance: number };
  const cells = new Map<number, Segment[]>();
  const key = (x: number, y: number) => Math.floor(x / 10) * 131072 + Math.floor(y / 10);
  const add = (a: Point2, b: Point2, clearance = 1.25) => {
    // Query radius includes a parked car's circle and the passing vehicle's half
    // width, including queries on the other side of a cell seam.
    const pad = 4;
    // A car is owned by its centre, but its front/rear circles can cross the tile
    // edge. Keep those queries' reach too when cropping the neighbouring index.
    const cropPad = 8;
    if (box && (Math.max(a[0], b[0]) < box[0] - cropPad || Math.min(a[0], b[0]) > box[2] + cropPad
      || Math.max(a[1], b[1]) < box[1] - cropPad || Math.min(a[1], b[1]) > box[3] + cropPad)) return;
    const segment = { a, b, clearance };
    for (let i = Math.floor((Math.min(a[0], b[0]) - pad) / 10); i <= Math.floor((Math.max(a[0], b[0]) + pad) / 10); i++) {
      for (let j = Math.floor((Math.min(a[1], b[1]) - pad) / 10); j <= Math.floor((Math.max(a[1], b[1]) + pad) / 10); j++) {
        const k = i * 131072 + j;
        let list = cells.get(k);
        if (!list) cells.set(k, list = []);
        list.push(segment);
      }
    }
  };
  const ground = edges.filter((e) => !e.bridge && !e.tunnel);
  const out = new Map<string, DriveEdge[]>();
  for (const e of ground) {
    let list = out.get(e.u);
    if (!list) out.set(e.u, list = []);
    list.push(e);
    for (let i = 1; i < e.path.pts.length; i++) add(e.path.pts[i - 1], e.path.pts[i]);
    // A sharp bend inside a street has the same body overhang as a junction.
    // Cover the pickup's collision circles while its heading catches up.
    const radius = TYPES.pickup.W / 2 + 0.02, end = TYPES.pickup.L / 2 - radius;
    const offsets = [-end, 0, end];
    // Three heading-response time constants at ordinary traffic's fastest pace.
    const lagDistance = Math.max(1, Math.min(TYPES.pickup.vmax * 0.75, e.speed * 1.2) * 0.3);
    for (let k = 1; k < e.path.pts.length - 1; k++) {
      const p = e.path.pts[k];
      const same = (a: Point2) => Math.hypot(a[0] - p[0], a[1] - p[1]) < 1e-6;
      if (k > 1 && same(e.path.pts[k - 1])) continue;
      let beforeIndex = k - 1, afterIndex = k + 1;
      while (beforeIndex >= 0 && same(e.path.pts[beforeIndex])) beforeIndex--;
      while (afterIndex < e.path.pts.length && same(e.path.pts[afterIndex])) afterIndex++;
      if (beforeIndex < 0 || afterIndex === e.path.pts.length) continue;
      const a = e.path.pts[beforeIndex], b = e.path.pts[afterIndex];
      if (box && (p[0] < box[0] - 22 || p[0] > box[2] + 22 || p[1] < box[1] - 22 || p[1] > box[3] + 22)) continue;
      const before = Math.atan2(p[1] - a[1], p[0] - a[0]), after = Math.atan2(b[1] - p[1], b[0] - p[0]);
      const turn = Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
      if (end * Math.sin(Math.min(turn, Math.PI / 2)) <= 1.25 - radius) continue;
      const steps = Math.ceil((8 + lagDistance) / 0.75);
      let previous: Point2[] | null = null;
      for (let i = 0; i <= steps; i++) {
        const s = e.path.cum[k] - 4 + (8 + lagDistance) * i / steps, at = e.path.at(s);
        const lag = e.path.at(s - lagDistance).ang, delta = Math.atan2(Math.sin(at.ang - lag), Math.cos(at.ang - lag));
        const circleAt = (o: number, h: number): Point2 => [at.x + Math.cos(h) * o, at.y + Math.sin(h) * o];
        const circles = [lag, at.ang].flatMap((h) => offsets.map((o) => circleAt(o, h)));
        const rotations = Math.max(1, Math.ceil(Math.abs(delta) / 0.3));
        for (const o of offsets) for (let j = 1; j <= rotations; j++)
          add(circleAt(o, lag + delta * (j - 1) / rotations), circleAt(o, lag + delta * j / rotations), radius + 0.4);
        if (previous) for (let j = 0; j < circles.length; j++) add(previous[j], circles[j], radius + 0.4);
        previous = circles;
      }
    }

    // Police, ambulances and fire engines route along the mapped street's middle.
    // On a wide one-way road that can lie outside the ordinary lane corridor.
    for (let i = 1; i < e.pts.length; i++) add(e.pts[i - 1], e.pts[i], TYPES.fire.W / 2 + 0.02);
    yield;
  }
  for (const e of ground) {
    const all = out.get(e.v) || [], forward = all.filter((f) => f !== e.twin);
    for (const f of forward.length ? forward : all) for (const main of [false, true]) {
      const trim = junctionTrim(e, f, main);
      const path = junctionCurve(e.path.at(e.path.length - trim), f.path.at(trim));
      // Neighbours' distant junctions cannot affect this tile. The padding covers
      // the bus's 8 m approach, overhangs, and the parked car's own overhang.
      if (box && (path.pts.every(([x]) => x < box[0] - 22) || path.pts.every(([x]) => x > box[2] + 22)
        || path.pts.every(([, y]) => y < box[1] - 22) || path.pts.every(([, y]) => y > box[3] + 22))) continue;
      // Sweep the same longitudinal collision circles Car uses, rather than just
      // the curve's centre. A pickup covers ordinary traffic; buses take the wider
      // curve, with their rear axle on the route and front axle looking ahead.
      const spec = main ? TYPES.bus : TYPES.pickup, radius = spec.W / 2 + 0.02;
      const n = Math.max(3, Math.ceil((spec.L - 2 * radius) / (2 * radius)) + 1), end = spec.L / 2 - radius;
      const offsets = Array.from({ length: n }, (_, i) => -end + 2 * end * i / (n - 1));
      const at = (s: number) => s < 0 ? e.path.at(e.path.length - trim + s)
        : s > path.length ? f.path.at(trim + s - path.length) : path.at(s);
      const wb = main ? spec.wheelbase ?? 6 : 0;
      let previous: Point2[] | null = null;
      // Include the entry and exit: overhangs can reach the corner while the
      // vehicle's reference point is still on the incoming/outgoing straight.
      const approach = main ? 8 : 4;
      const steps = Math.ceil((path.length + 2 * approach) / 0.75);
      for (let i = 0; i <= steps; i++) {
        const s = -approach + (path.length + 2 * approach) * i / steps, p = at(s);
        const front = at(s + wb);
        const ang = wb && Math.hypot(front.x - p.x, front.y - p.y) > wb / 2 ? Math.atan2(front.y - p.y, front.x - p.x) : p.ang;
        const cx = p.x + Math.cos(ang) * wb * 0.42, cy = p.y + Math.sin(ang) * wb * 0.42;
        // Traffic smooths the body's heading after positioning the axle. Cover
        // the rotation between a recent route heading and its current target too,
        // especially a bus's tail as its front axle starts round the corner.
        const lag = at(s - 1).ang, delta = Math.atan2(Math.sin(ang - lag), Math.cos(ang - lag));
        const circleAt = (o: number, h: number): Point2 => [cx + Math.cos(h) * o, cy + Math.sin(h) * o];
        const circles = [lag, ang].flatMap((h) => offsets.map((o) => circleAt(o, h)));
        const rotations = Math.max(1, Math.ceil(Math.abs(delta) / 0.3));
        for (const o of offsets) for (let j = 1; j <= rotations; j++) {
          add(circleAt(o, lag + delta * (j - 1) / rotations), circleAt(o, lag + delta * j / rotations), radius + 0.4);
        }
        if (previous) for (let j = 0; j < circles.length; j++) add(previous[j], circles[j], radius + 0.4);
        previous = circles;
      }
      yield;
    }
  }
  // Each segment carries its lane or swept-body clearance; add the parked
  // circle's radius so neither its centre nor its outline enters that corridor.
  return (x: number, y: number, radius: number) => {
    const list = cells.get(key(x, y));
    if (list) for (const { a, b, clearance } of list) if (segDist(x, y, a, b) < radius + clearance) return false;
    return true;
  };
}
