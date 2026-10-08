import { Car, randomType } from './car.ts';
import { posts } from './posts.ts';
import { Polyline, segDist } from './network.ts';
import type { DriveEdge, ParkingOrientation } from './network.ts';
import type { Point2, Polygons, Bounds } from './map/geo.ts';
import { parkingClearance } from './parkingClearance.ts';
import { Demand, occupancy } from './parkingDemand.ts';
import type { DemandBuilding, Floors } from './parkingDemand.ts';

type BayOrientation = Exclude<ParkingOrientation, 'no'>;
interface ParkingSection {
  code: string; category: string; spaces: number; occDay?: number; occNight?: number;
  inside: number; polys: Polygons;
}
interface LocatedSection extends ParkingSection { box: Bounds }
interface ParkingData {
  box?: Bounds;
  lots?: { o: BayOrientation | null; rings: Point2[][]; i?: 1 }[];
  areas: { parking?: Polygons };
  rails: { pts: Point2[] }[];
  drives?: { x: number; y: number; h: number; g?: 1 }[];
}
interface ParkingSlot { x: number; y: number; h: number; lot: boolean; bay: boolean; angled: boolean; fwd?: boolean; withTraffic?: boolean; perp?: boolean }

// Cars left up on the pavement, facing the way the traffic beside them goes: the
// street, and how far along it (see PavementDrivers, which now and then has one of
// them drive off along the pavement before it pulls into the street).
export const onPavement = new WeakMap<Car, { edge: DriveEdge; s: number }>();

// Parked cars. Where TSK's paid-parking sections cover the street, each section
// gets as many cars as its spaces × measured occupancy (day or night). They go
// into OSM's mapped parking lanes and lots first, then along the kerb. Outside
// the zones, lots and kerbs are filled at random, as full as the buildings round them
// call for (src/parkingDemand.ts). And, this being Prague, a few more
// stand up on the pavement: at corners, and where the kerb is otherwise empty.

export function inRing(x: number, y: number, ring: Point2[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const inPoly = (x: number, y: number, rings: Point2[][]) => inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h));

export class Zones {
  sections: LocatedSection[];

  constructor(parking: { sections: ParkingSection[] } | null) {
    this.sections = (parking?.sections || []).map((s) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const rings of s.polys) for (const [x, y] of rings[0]) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      return { ...s, box: [x0, y0, x1, y1] as Bounds };
    });
  }

  at(x: number, y: number) {
    for (const s of this.sections) {
      const [x0, y0, x1, y1] = s.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (s.polys.some((rings) => inPoly(x, y, rings))) return s;
    }
    return null;
  }
}

// Angled bays: how far the cars turn from the kerb, and their spacing along it.
const ANGLE = 0.9, ANGLED_STEP = 3.0;
// Roads nobody leaves a car beside unless the map says they do: motorways, expressways
// and every slip road. (A hard shoulder is not a parking lane.)
const NO_KERB_PARKING = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const DIVIDED = new Set(['primary', 'secondary']);
const LANE = 3.0; // m: the least a driving lane takes of a carriageway

// How the cars stand in a parking area: OSM's `orientation` if it's tagged, else a
// guess from its width. Under 4.5 m is a parallel lane, up to 5.6 m angled bays (the
// usual depth of those), wider rows of perpendicular bays.
const guess = (width: number): BayOrientation => (width < 4.5 ? 'parallel' : width < 5.6 ? 'diagonal' : 'perpendicular');

// An area's width as a rectangle with the same area and perimeter would have it. A
// strip along a street that bends is as narrow as it looks, where the box round it
// isn't.
function stripWidth(ring: Point2[]) {
  let area = 0, perim = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    perim += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  area = Math.abs(area) / 2;
  return (perim - Math.sqrt(Math.max(0, perim * perim - 16 * area))) / 4;
}

// Which way the kerb runs at (x, y): the nearest side of the area within 30° of its
// axis `a`, turned to point the same way as `a`. Along a bending strip the cars follow
// the bend.
function kerbAt(ring: Point2[], x: number, y: number, a: number) {
  let best = Infinity, h = a;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const ang = Math.atan2(by - ay, bx - ax);
    if (Math.abs(Math.sin(ang - a)) > 0.5) continue;
    const d = segDist(x, y, ring[j], ring[i]);
    if (d < best) { best = d; h = Math.cos(ang - a) < 0 ? ang + Math.PI : ang; }
  }
  return h;
}

// Rows across the area (offsets from its long side) for cars `depth` deep.
function rows(v0: number, v1: number, depth: number, gap: number) {
  const out: number[] = [];
  for (let v = v0 + depth / 2; v <= v1 - depth / 2 + 1e-6; v += depth + gap) out.push(v);
  return out.length ? out : [(v0 + v1) / 2];
}

// Rows of bays across a stretch of paving that no street runs through (an inferred
// car park, see pipeline/osm_area.py `_inferred_lots`): a row against each edge,
// back-to-back pairs between them, and an aisle for the cars to drive along between
// every two rows. `face` is the side the cars nose towards.
const AISLE = 6, BAY = 5;
function aisleRows(v0: number, v1: number) {
  const out: { v: number; face: 1 | -1 }[] = [];
  let v = v0;
  if (v1 - v < BAY) return out;
  out.push({ v: v + BAY / 2, face: -1 });
  v += BAY;
  while (v + AISLE + BAY <= v1 + 1e-6) {
    v += AISLE;
    out.push({ v: v + BAY / 2, face: -1 });
    v += BAY;
    if (v + BAY <= v1 + 1e-6) { out.push({ v: v + BAY / 2, face: 1 }); v += BAY; }
  }
  return out;
}

// Where the line across the area at `u` goes in and out of it (`uv`: the ring in
// frame coordinates), in order: pairs of v, one for each stretch inside.
function crossings(uv: Point2[], u: number) {
  const vs: number[] = [];
  for (let i = 0, j = uv.length - 1; i < uv.length; j = i++) {
    const [ua, va] = uv[j], [ub, vb] = uv[i];
    if (ua > u !== ub > u) vs.push(va + ((u - ua) * (vb - va)) / (ub - ua));
  }
  return vs.sort((p, q) => p - q);
}

// The ring in coordinates along `a` (u) and across it (v), from its first corner.
function frame(ring: Point2[], a: number) {
  const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
  const [ox, oy] = ring[0];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of ring) {
    const u = (x - ox) * ux + (y - oy) * uy, v = (x - ox) * vx + (y - oy) * vy;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  return { ux, uy, vx, vy, ox, oy, u0, u1, v0, v1 };
}

// The traffic lane an angled parking area is beside: within 15 m, running along the
// area (axis `a`), and on a two-way street the lane that has the area on its right.
// Returns the lane's direction there and whether the area is on its right.
function laneBeside(ring: Point2[], a: number, edges: DriveEdge[]) {
  let cx = 0, cy = 0;
  for (const [x, y] of ring) { cx += x; cy += y; }
  cx /= ring.length;
  cy /= ring.length;
  let best = null;
  for (const e of edges) {
    const { pts } = e.path;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / len2));
      const d = Math.hypot(cx - ax - dx * t, cy - ay - dy * t);
      if (d > 15) continue;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(Math.sin(ang - a)) > 0.5) continue;
      const right = (cx - ax) * dy - (cy - ay) * dx > 0;
      const score = d + (right || e.oneway ? 0 : 100);
      if (!best || score < best.score) best = { score, ang, right };
    }
  }
  return best;
}

// Every possible parking spot: bays in OSM lots and lanes, then kerbside spots.
function slots(data: ParkingData, edges: DriveEdge[]) {
  const out: ParkingSlot[] = [];
  // Tiles built before the lots were kept separately only have the merged areas.
  const areas = data.lots || (data.areas.parking || []).map((rings) => ({ o: null, rings, i: undefined as 1 | undefined }));
  for (const { o, rings, i: inferred } of areas) {
    const ring = rings[0];
    let a = 0, best = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len > best) { best = len; a = Math.atan2(q[1] - p[1], q[0] - p[0]); }
    }
    let f = frame(ring, a);
    const kind = o || guess(Math.min(f.v1 - f.v0, stripWidth(ring)));
    // Angled bays slant forwards along the traffic beside them, so drivers pull in nose
    // first: turned right off a lane that has the area on its right, left otherwise.
    // Away from any street (inside a car park) the slant is arbitrary.
    let slant = ANGLE, nose = Math.PI / 2;
    // Parallel cars stand facing the traffic beside them too, so on a one-way street
    // they all point the way it goes.
    const lane = laneBeside(ring, a, edges);
    if (lane) {
      if (Math.cos(lane.ang - a) < 0) f = frame(ring, (a += Math.PI));
      if (kind === 'diagonal') slant = lane.right ? -ANGLE : ANGLE;
      // Perpendicular cars nose in towards the pavement, away from the lane.
      nose = lane.right ? -Math.PI / 2 : Math.PI / 2;
    }
    const withTraffic = kind === 'parallel' && !!lane;
    const { ux, uy, vx, vy, ox, oy, u0, u1 } = f;
    const uv: Point2[] = ring.map(([x, y]) => [(x - ox) * ux + (y - oy) * uy, (x - ox) * vx + (y - oy) * vy]);
    const lay = {
      parallel: { depth: 2, gap: 0.6, step: 6, end: 2.8, turn: 0 },
      diagonal: { depth: 4.8, gap: 0.7, step: ANGLED_STEP, end: 1.8, turn: slant },
      perpendicular: { depth: 5, gap: 0.6, step: 2.6, end: 1.3, turn: nose },
    }[kind];
    for (let u = u0 + lay.end; u < u1 - lay.end + 0.5; u += lay.step) {
      // The rows go across the area where it is at u, so they follow a strip that bends.
      const vs = crossings(uv, u);
      for (let i = 0; i + 1 < vs.length; i += 2) {
        if (vs[i + 1] - vs[i] < 1.2) continue;
        if (inferred && kind === 'perpendicular' && vs[i + 1] - vs[i] >= 2 * BAY + AISLE) {
          for (const { v, face } of aisleRows(vs[i], vs[i + 1])) {
            const x = ox + ux * u + vx * v, y = oy + uy * u + vy * v;
            if (inPoly(x, y, rings)) out.push({ x, y, h: kerbAt(ring, x, y, a) + face * Math.PI / 2, lot: true, bay: true, angled: false, withTraffic: false, perp: false });
          }
          continue;
        }
        for (const v of rows(vs[i], vs[i + 1], lay.depth, lay.gap)) {
          const x = ox + ux * u + vx * v, y = oy + uy * u + vy * v;
          if (inPoly(x, y, rings)) out.push({ x, y, h: kerbAt(ring, x, y, a) + lay.turn, lot: true, bay: kind !== 'parallel', angled: kind === 'diagonal', withTraffic, perp: kind === 'perpendicular' && !!lane });
        }
      }
    }
  }
  const lots = out.length;
  for (const e of edges) {
    if (e.bridge || e.tunnel || e.path.length < 30) continue;
    // Each side as OSM tags it (`park`: [right, left] of this edge); parallel if it
    // doesn't say. Cars stand along the kerb (`kerb`: its distance from the centre on
    // the right and left, from the pipeline's kerbs.py), angled and perpendicular ones
    // never inside the driving width, where they'd block the lane. Tiles built before
    // the kerbs only have that width: parallel cars stand inside its edge, the others
    // just outside it. Where a building is in the way, they don't fit (see place()).
    for (const side of e.oneway ? [1, -1] : [1]) {
      const tagged = e.park?.[side > 0 ? 0 : 1];
      const o = tagged || (NO_KERB_PARKING.has(e.hw) ? 'no' : 'parallel');
      if (o === 'no') continue;
      const edge = e.kerb?.[side > 0 ? 0 : 1];
      // One carriageway of a divided main road: nobody parks in its lanes, only where
      // the kerb leaves room beside them (a lay-by, a parking lane).
      if (!tagged && edge != null && e.oneway && (e.lanes ?? 0) >= 2 && DIVIDED.has(e.hw) && edge - (e.lanes! * LANE) / 2 < 1.9) continue;
      const kerb = edge == null
        ? e.width / 2 + { parallel: -1.05, diagonal: 2.55, perpendicular: 2.5 }[o]
        : o === 'parallel' ? edge - 1.05 : Math.max(edge - 2.45, e.width / 2 + 2.55);
      if (o === 'parallel' && Math.abs(side * kerb - e.laneOffset) < 2.3) continue;
      const step = { parallel: 6, diagonal: ANGLED_STEP, perpendicular: 2.6 }[o];
      // Angled cars nose in: turned right on the right-hand side, left on the left.
      const turn = { parallel: 0, diagonal: -ANGLE * side, perpendicular: -Math.PI / 2 * side }[o];
      const line = new Polyline(e.pts);
      for (let s = 10; s < line.length - 10; s += step) {
        const q = line.at(s);
        const x = q.x + Math.sin(q.ang) * kerb * side, y = q.y - Math.cos(q.ang) * kerb * side;
        // A mapped parking lane already covers this stretch.
        let dup = false;
        for (let i = 0; i < lots && !dup; i++) dup = Math.abs(out[i].x - x) < 4.5 && Math.abs(out[i].y - y) < 4.5;
        if (!dup) out.push({ x, y, h: q.ang + turn, lot: false, bay: o !== 'parallel', angled: o === 'diagonal', withTraffic: o === 'parallel', perp: o === 'perpendicular' });
      }
    }
  }
  return out;
}

// Streets where people put a car up on the pavement: not the big roads.
const PAVED_OVER = new Set(['residential', 'unclassified', 'tertiary', 'secondary', 'service']);

// Spots up on the pavement beside the kerb, on streets whose kerbs are known: a few
// metres from the corners, and every 12 m along the way (taken only where nobody has
// parked at the kerb, see parkCars). Half on (two wheels up) or right up on it.
function pavementSlots(edges: DriveEdge[], r: () => number) {
  const out: (ParkingSlot & { corner: boolean; edge: DriveEdge; s: number })[] = [];
  for (const e of edges) {
    if (e.bridge || e.tunnel || !PAVED_OVER.has(e.hw) || e.path.length < 16) continue;
    for (const side of e.oneway ? [1, -1] : [1]) {
      const edge = e.kerb?.[side > 0 ? 0 : 1];
      if (edge == null) continue;
      const line = new Polyline(e.pts);
      const along = [4 + r() * 2, line.length - 6 - r() * 2];
      for (let s = 16; s < line.length - 16; s += 12) along.push(s + (r() - 0.5) * 4);
      along.forEach((s, i) => {
        const q = line.at(s), kerb = edge + (r() < 0.5 ? 0.15 : 1.15);
        const x = q.x + Math.sin(q.ang) * kerb * side, y = q.y - Math.cos(q.ang) * kerb * side;
        // Left at a slant, the nose in towards the houses at a corner.
        const skew = (i < 2 ? 0.05 + r() * 0.2 : (r() - 0.5) * 0.1) * side;
        out.push({ x, y, h: q.ang - skew, lot: false, bay: false, angled: false, fwd: true, corner: i < 2, edge: e, s });
      });
    }
  }
  return out;
}

// Whether (x, y) is on the driving part of any street in `edges`.
function onCarriageway(x: number, y: number, edges: DriveEdge[]) {
  for (const e of edges) {
    if (e.bridge || e.tunnel) continue;
    const hw = e.width / 2 + 0.4;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1];
      if (x < Math.min(ax, bx) - hw || x > Math.max(ax, bx) + hw || y < Math.min(ay, by) - hw || y > Math.max(ay, by) + hw) continue;
      if (segDist(x, y, e.pts[i], e.pts[i + 1]) < hw) return true;
    }
  }
  return false;
}

// `shares`: code → share of each paid-parking section inside this piece of map (a
// tile); without it the whole section counts. `inside(x, y)` limits spots to the tile.
export function parkCars({ data, edges, clearanceEdges = edges, zones, solid, r, night = false, shares = null, inside = () => true, buildings = null }: {
  data: ParkingData; edges: DriveEdge[]; zones: Zones; solid: (x: number, y: number) => boolean | number;
  clearanceEdges?: DriveEdge[];
  // The buildings in and round the tile (as far as the neighbouring tiles reach): without
  // them, outside the zones a fifth of the kerb spots and under half of a car park's get a car.
  buildings?: DemandBuilding[] | null;
  r: () => number; night?: boolean; shares?: Map<string, number> | null;
  inside?: (x: number, y: number) => boolean;
}) {
  const railSegs: [Point2, Point2][] = [];
  for (const rl of data.rails) for (let i = 0; i < rl.pts.length - 1; i++) railSegs.push([rl.pts[i], rl.pts[i + 1]]);
  const nearRail = (x: number, y: number, d: number) => railSegs.some(([a, b]) => segDist(x, y, a, b) < d);
  const laneClear = parkingClearance(clearanceEdges, data.box);
  const cars: Car[] = [];
  // Parked cars by 5 m cell (keyed by number, as in SpatialHash: this is asked for
  // every spot tried).
  const cell = new Map<number, Car[]>();
  const key = (x: number, y: number) => Math.floor(x / 5) * 131072 + Math.floor(y / 5);
  const crowded = (x: number, y: number, d: number) => {
    const cx = Math.floor(x / 5), cy = Math.floor(y / 5);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = cell.get((cx + i) * 131072 + cy + j);
      if (list) for (const c of list) if (Math.hypot(c.x - x, c.y - y) < d) return true;
    }
    return false;
  };
  // Whether the car's body would touch one already parked: their collision circles, with
  // a hand's width between them. (The distance between their middles, `crowded`, is enough
  // only for cars standing in line or side by side: in a car park whose edge bends, the
  // cars of a row turn with it while the row's spacing stays, and they'd overlap.)
  const touching = (car: Car) => {
    const mine = car.circles(), cx = Math.floor(car.x / 5), cy = Math.floor(car.y / 5);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const list = cell.get((cx + i) * 131072 + cy + j);
      if (list) for (const c of list) {
        const reach = car.r + c.r + 0.1;
        for (const [ax, ay] of c.circles()) for (const [bx, by] of mine) if (Math.hypot(ax - bx, ay - by) < reach) return true;
      }
    }
    return false;
  };
  // Whether all of the car is in this piece of the map. Each tile parks its own cars
  // without knowing its neighbours', so one standing across the edge could be in a car
  // the next tile parked there.
  const within = (car: Car) => car.circles().every(([x, y]) => inside(x - car.r, y) && inside(x + car.r, y) && inside(x, y - car.r) && inside(x, y + car.r));
  const place = (s: ParkingSlot, type = randomType(r)) => {
    // Most people drive into angled bays forwards; elsewhere it's either way round.
    const car = new Car(type, r, s.x, s.y, s.h + (!s.fwd && !s.withTraffic && r() < (s.angled ? 0.08 : s.perp ? 0.05 : 0.5) ? Math.PI : 0));
    if (s.bay && (car.type === 'van' || car.type === 'pickup')) return false;
    if (!within(car) || touching(car)) return false;
    // Nothing sticking out into a lane, where the traffic would have to squeeze past:
    // where the kerb or a mapped parking lane leaves no room, the street has none.
    if (car.circles().some(([x, y]) => !laneClear(x, y, car.r))) return false;
    const outline = car.worldSamples();
    // No part of the car where a passing tram would hit it: half a tram's width from
    // the track and a little room. Whatever the map says about parking there.
    if (nearRail(s.x, s.y, 4.5) && outline.some(([x, y]) => nearRail(x, y, 1.65))) return false;
    if (outline.some(([x, y]) => solid(x, y)) || car.worldOutline().some(([x, y]) => solid(x, y)) || crowded(s.x, s.y, s.bay ? 2.4 : 4.8) || posts.touches(car)) return false;
    if (s.fwd && outline.some(([x, y]) => onCarriageway(x, y, clearanceEdges))) return false;
    car.mode = 'loose';
    cars.push(car);
    const k = key(s.x, s.y);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k)!.push(car);
    return true;
  };
  const shuffle = <T>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const bySection = new Map<LocatedSection, ParkingSlot[]>(), free: ParkingSlot[] = [];
  for (const s of slots(data, edges)) {
    if (!inside(s.x, s.y)) continue;
    const z = zones.at(s.x, s.y);
    if (!z) { free.push(s); continue; }
    if (!bySection.has(z)) bySection.set(z, []);
    bySection.get(z)!.push(s);
  }
  let wanted = 0;
  for (const [z, list] of bySection) {
    const occ = Math.min(130, (night ? z.occNight ?? z.occDay : z.occDay) ?? 80);
    const share = shares ? shares.get(z.code) || 0 : z.inside;
    let want = Math.round((z.spaces * share * occ) / 100);
    wanted += want;
    const ordered = [...shuffle(list.filter((s) => s.lot)), ...shuffle(list.filter((s) => !s.lot))];
    for (const s of ordered) if (want > 0 && place(s)) want--;
  }
  // Outside the zones: as many cars as the buildings round each spot would have (the
  // amount of building is worked out once for each 20 m square).
  let demand: Demand | null = null;
  const floors = new Map<number, Floors>();
  const taken = (s: ParkingSlot) => {
    if (!buildings) return s.lot ? 0.45 : 0.2;
    demand ??= new Demand(buildings);
    const cx = Math.floor(s.x / 20), cy = Math.floor(s.y / 20), k = cx * 131072 + cy;
    let f = floors.get(k);
    if (!f) floors.set(k, f = demand.floors(cx * 20 + 10, cy * 20 + 10));
    return occupancy(f, night, s.lot);
  };
  for (const s of shuffle(free)) if (r() < taken(s)) place(s);
  // Up on the pavement, where there's room beside it at the kerb: more often at a
  // corner, and as often as not a delivery van.
  for (const s of pavementSlots(edges, r)) {
    if (!inside(s.x, s.y) || r() > (s.corner ? 0.2 : 0.07) || crowded(s.x, s.y, 5.5)) continue;
    const n = cars.length;
    if (place(s, r() < 0.45 ? 'van' : randomType(r))) onPavement.set(cars[n], { edge: s.edge, s: s.s });
  }
  // On a drive: where the house has a place for one, as often as people are at home.
  // These never drive off, and they stand outside the street graph.
  // A second car, in front of the garage, half as often as the first.
  for (const d of shuffle([...(data.drives || [])])) {
    if (!inside(d.x, d.y) || r() > (night ? 0.55 : 0.3) * (d.g ? 0.5 : 1)) continue;
    place({ x: d.x, y: d.y, h: d.h, lot: false, bay: true, angled: false, perp: true });
  }
  return { cars, wanted, zoned: bySection.size };
}
