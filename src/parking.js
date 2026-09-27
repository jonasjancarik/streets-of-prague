import { Car, randomType } from './car.js';
import { Polyline, segDist } from './network.js';

// Parked cars. Where TSK's paid-parking sections cover the street, each section
// gets as many cars as its spaces × measured occupancy (day or night). They go
// into OSM's mapped parking lanes and lots first, then along the kerb. Outside
// the zones, lots and kerbs are filled at random.

export function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPoly = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((h) => inRing(x, y, h));

export class Zones {
  constructor(parking) {
    this.sections = (parking?.sections || []).map((s) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const rings of s.polys) for (const [x, y] of rings[0]) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      return { ...s, box: [x0, y0, x1, y1] };
    });
  }

  at(x, y) {
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

// How the cars stand in a parking area: OSM's `orientation` if it's tagged, else a
// guess from its width. Under 4.5 m is a parallel lane, up to 5.6 m angled bays (the
// usual depth of those), wider rows of perpendicular bays.
const guess = (width) => (width < 4.5 ? 'parallel' : width < 5.6 ? 'diagonal' : 'perpendicular');

// Rows across the area (offsets from its long side) for cars `depth` deep.
function rows(v0, v1, depth, gap) {
  const out = [];
  for (let v = v0 + depth / 2; v <= v1 - depth / 2 + 1e-6; v += depth + gap) out.push(v);
  return out.length ? out : [(v0 + v1) / 2];
}

// The ring in coordinates along `a` (u) and across it (v), from its first corner.
function frame(ring, a) {
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
function laneBeside(ring, a, edges) {
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
function slots(data, edges) {
  const out = [];
  // Tiles built before the lots were kept separately only have the merged areas.
  const areas = data.lots || (data.areas.parking || []).map((rings) => ({ o: null, rings }));
  for (const { o, rings } of areas) {
    const ring = rings[0];
    let a = 0, best = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len > best) { best = len; a = Math.atan2(q[1] - p[1], q[0] - p[0]); }
    }
    let f = frame(ring, a);
    const kind = o || guess(f.v1 - f.v0);
    // Angled bays slant forwards along the traffic beside them, so drivers pull in nose
    // first: turned right off a lane that has the area on its right, left otherwise.
    // Away from any street (inside a car park) the slant is arbitrary.
    let slant = ANGLE;
    const lane = kind === 'diagonal' ? laneBeside(ring, a, edges) : null;
    if (lane) {
      if (Math.cos(lane.ang - a) < 0) f = frame(ring, (a += Math.PI));
      slant = lane.right ? -ANGLE : ANGLE;
    }
    const { ux, uy, vx, vy, ox, oy, u0, u1, v0, v1 } = f;
    const lay = {
      parallel: { rows: rows(v0, v1, 2, 0.6), step: 6, end: 2.8, turn: 0 },
      diagonal: { rows: rows(v0, v1, 4.8, 0.7), step: ANGLED_STEP, end: 1.8, turn: slant },
      perpendicular: { rows: rows(v0, v1, 5, 0.6), step: 2.6, end: 1.3, turn: Math.PI / 2 },
    }[kind];
    for (const v of lay.rows) {
      for (let u = u0 + lay.end; u < u1 - lay.end + 0.5; u += lay.step) {
        const x = ox + ux * u + vx * v, y = oy + uy * u + vy * v;
        if (inPoly(x, y, rings)) out.push({ x, y, h: a + lay.turn, lot: true, bay: kind !== 'parallel', angled: kind === 'diagonal' });
      }
    }
  }
  const lots = out.length;
  for (const e of edges) {
    if (e.bridge || e.path.length < 30) continue;
    // Each side as OSM tags it (`park`: [right, left] of this edge); parallel if it
    // doesn't say. Cars stand along the kerb (`kerb`: its distance from the centre on
    // the right and left, from the pipeline's kerbs.py), angled and perpendicular ones
    // never inside the driving width, where they'd block the lane. Tiles built before
    // the kerbs only have that width: parallel cars stand inside its edge, the others
    // just outside it. Where a building is in the way, they don't fit (see place()).
    for (const side of e.oneway ? [1, -1] : [1]) {
      const o = e.park?.[side > 0 ? 0 : 1] || 'parallel';
      if (o === 'no') continue;
      const edge = e.kerb?.[side > 0 ? 0 : 1];
      const kerb = edge == null
        ? e.width / 2 + { parallel: -1.05, diagonal: 2.55, perpendicular: 2.5 }[o]
        : o === 'parallel' ? edge - 1.05 : Math.max(edge - 2.45, e.width / 2 + 2.55);
      if (o === 'parallel' && Math.abs(side * kerb - e.laneOffset) < 2.3) continue;
      const step = { parallel: 6, diagonal: ANGLED_STEP, perpendicular: 2.6 }[o];
      // Angled cars nose in: turned right on the right-hand side, left on the left.
      const turn = { parallel: 0, diagonal: -ANGLE * side, perpendicular: Math.PI / 2 }[o];
      const line = new Polyline(e.pts);
      for (let s = 10; s < line.length - 10; s += step) {
        const q = line.at(s);
        const x = q.x + Math.sin(q.ang) * kerb * side, y = q.y - Math.cos(q.ang) * kerb * side;
        // A mapped parking lane already covers this stretch.
        let dup = false;
        for (let i = 0; i < lots && !dup; i++) dup = Math.abs(out[i].x - x) < 4.5 && Math.abs(out[i].y - y) < 4.5;
        if (!dup) out.push({ x, y, h: q.ang + turn, lot: false, bay: o !== 'parallel', angled: o === 'diagonal' });
      }
    }
  }
  return out;
}

// `shares`: code → share of each paid-parking section inside this piece of map (a
// tile); without it the whole section counts. `inside(x, y)` limits spots to the tile.
export function parkCars({ data, edges, zones, solid, r, night = false, shares = null, inside = () => true }) {
  const railSegs = [];
  for (const rl of data.rails) for (let i = 0; i < rl.pts.length - 1; i++) railSegs.push([rl.pts[i], rl.pts[i + 1]]);
  // Half a tram and half a car apart, and a little room between them.
  const nearRail = (x, y) => railSegs.some(([a, b]) => segDist(x, y, a, b) < 2.6);
  const cars = [];
  const cell = new Map();
  const key = (x, y) => `${Math.floor(x / 5)},${Math.floor(y / 5)}`;
  const crowded = (x, y, d) => {
    const cx = Math.floor(x / 5), cy = Math.floor(y / 5);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const c of cell.get(`${cx + i},${cy + j}`) || []) if (Math.hypot(c.x - x, c.y - y) < d) return true;
    }
    return false;
  };
  const place = (s) => {
    if (!s.lot && nearRail(s.x, s.y)) return false;
    // Most people drive into angled bays forwards; elsewhere it's either way round.
    const car = new Car(randomType(r), r, s.x, s.y, s.h + (r() < (s.angled ? 0.08 : 0.5) ? Math.PI : 0));
    if (s.bay && car.type === 'van') return false;
    if (car.worldSamples().some(([x, y]) => solid(x, y)) || crowded(s.x, s.y, s.bay ? 2.4 : 4.8)) return false;
    car.mode = 'loose';
    cars.push(car);
    const k = key(s.x, s.y);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(car);
    return true;
  };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const bySection = new Map(), free = [];
  for (const s of slots(data, edges)) {
    if (!inside(s.x, s.y)) continue;
    const z = zones.at(s.x, s.y);
    if (!z) { free.push(s); continue; }
    if (!bySection.has(z)) bySection.set(z, []);
    bySection.get(z).push(s);
  }
  let wanted = 0;
  for (const [z, list] of bySection) {
    const occ = Math.min(130, (night ? z.occNight : z.occDay) ?? 80);
    const share = shares ? shares.get(z.code) || 0 : z.inside;
    let want = Math.round((z.spaces * share * occ) / 100);
    wanted += want;
    const ordered = [...shuffle(list.filter((s) => s.lot)), ...shuffle(list.filter((s) => !s.lot))];
    for (const s of ordered) if (want > 0 && place(s)) want--;
  }
  for (const s of shuffle(free)) if (r() < (s.lot ? 0.45 : 0.2)) place(s);
  return { cars, wanted, zoned: bySection.size };
}
