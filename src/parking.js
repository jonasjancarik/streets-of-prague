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

// Every possible parking spot: bays in OSM lots and lanes, then kerbside spots.
function slots(data, drive) {
  const out = [];
  for (const rings of data.areas.parking || []) {
    const ring = rings[0];
    let a = 0, best = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len > best) { best = len; a = Math.atan2(q[1] - p[1], q[0] - p[0]); }
    }
    const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
    const [ox, oy] = ring[0];
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of ring) {
      const u = (x - ox) * ux + (y - oy) * uy, v = (x - ox) * vx + (y - oy) * vy;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    // Narrow strips beside the street are parallel parking; wider lots get rows of bays.
    const strip = v1 - v0 < 4.5;
    const rows = strip ? [(v0 + v1) / 2] : [];
    for (let v = v0 + 3; !strip && v < v1 - 2.5; v += 5.6) rows.push(v);
    for (const v of rows) {
      for (let u = u0 + (strip ? 3 : 1.4); u < u1 - (strip ? 2.5 : 1.2); u += strip ? 6 : 2.6) {
        const x = ox + ux * u + vx * v, y = oy + uy * u + vy * v;
        if (inPoly(x, y, rings)) out.push({ x, y, h: a + (strip ? 0 : Math.PI / 2), lot: true, bay: !strip });
      }
    }
  }
  const lots = out.length;
  for (const e of drive.edges) {
    if (e.bridge || e.path.length < 30) continue;
    const kerb = e.width / 2 - 1.05;
    for (const side of e.oneway ? [1, -1] : [1]) {
      if (Math.abs(side * kerb - e.laneOffset) < 2.3) continue;
      const line = new Polyline(e.pts);
      for (let s = 10; s < line.length - 10; s += 6) {
        const q = line.at(s);
        const x = q.x + Math.sin(q.ang) * kerb * side, y = q.y - Math.cos(q.ang) * kerb * side;
        // A mapped parking lane already covers this stretch.
        let dup = false;
        for (let i = 0; i < lots && !dup; i++) dup = Math.abs(out[i].x - x) < 4.5 && Math.abs(out[i].y - y) < 4.5;
        if (!dup) out.push({ x, y, h: q.ang, lot: false });
      }
    }
  }
  return out;
}

export function parkCars({ data, drive, zones, grid, r, night = false }) {
  const railSegs = [];
  for (const rl of data.rails) for (let i = 0; i < rl.pts.length - 1; i++) railSegs.push([rl.pts[i], rl.pts[i + 1]]);
  const nearRail = (x, y) => railSegs.some(([a, b]) => segDist(x, y, a, b) < 3.2);
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
    const car = new Car(randomType(r), r, s.x, s.y, s.h + (r() > 0.5 ? Math.PI : 0));
    if (s.bay && car.type === 'van') return false;
    if (!car.worldSamples().every(([x, y]) => grid.at(x, y) === 0) || crowded(s.x, s.y, s.bay ? 2.4 : 4.8)) return false;
    car.mode = 'loose';
    cars.push(car);
    const k = key(s.x, s.y);
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(car);
    return true;
  };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const bySection = new Map(), free = [];
  for (const s of slots(data, drive)) {
    const z = zones.at(s.x, s.y);
    if (!z) { free.push(s); continue; }
    if (!bySection.has(z)) bySection.set(z, []);
    bySection.get(z).push(s);
  }
  let wanted = 0;
  for (const [z, list] of bySection) {
    const occ = Math.min(130, (night ? z.occNight : z.occDay) ?? 80);
    let want = Math.round((z.spaces * z.inside * occ) / 100);
    wanted += want;
    const ordered = [...shuffle(list.filter((s) => s.lot)), ...shuffle(list.filter((s) => !s.lot))];
    for (const s of ordered) if (want > 0 && place(s)) want--;
  }
  for (const s of shuffle(free)) if (r() < (s.lot ? 0.45 : 0.2)) place(s);
  return { cars, wanted, zoned: bySection.size };
}
