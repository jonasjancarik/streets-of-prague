// Street graphs from pipeline/build_tiles.py: a directed car network with lanes
// offset to the right, and an undirected pedestrian network.

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Polyline {
  constructor(pts) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  at(s) {
    s = clamp(s, 0, this.length);
    let lo = 1, hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    const a = this.pts[lo - 1], b = this.pts[lo];
    const t = (s - this.cum[lo - 1]) / (this.cum[lo] - this.cum[lo - 1] || 1);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
}

// Shift a polyline sideways; positive d = to the right of the direction of travel.
export function offsetLine(pts, d) {
  if (!d) return pts;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] + ((b[1] - a[1]) / len) * d, p[1] - ((b[0] - a[0]) / len) * d];
  });
}

function bezier(a, c, b, n = 8) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

const CLASS_SPEED = { primary: 14, secondary: 13, tertiary: 12, tertiary_link: 9, residential: 9, unclassified: 9, living_street: 5, service: 5 };

// Where traffic drives, right of the street's centre line: the outer lane on two-way
// streets, the middle (or right of middle) lane on one-way ones.
function laneOffset(e) {
  const n = e.lanes || 0;
  if (e.oneway) {
    const lanes = Math.max(1, n || 1), lw = e.width / lanes;
    return e.width / 2 - lw * (Math.floor((lanes - 1) / 2) + 0.5);
  }
  const per = Math.max(1, Math.floor(Math.max(2, n || 2) / 2)), lw = e.width / (2 * per);
  return clamp(lw * (per - 0.5), 1.6, e.width / 2 - 1);
}

// The car network, filled in as tiles arrive. Edges are keyed by id and joined at
// shared (OSM) node ids; `out` lists the edges leaving each node.
export class DriveGraph {
  constructor() {
    this.byId = new Map();
    this.out = new Map();
    this.edges = [];
  }

  // Adds raw edges; returns the graph's own edge objects (new or already known).
  add(list) {
    return list.map((raw) => {
      const known = this.byId.get(raw.id);
      if (known) return known;
      const e = { ...raw };
      e.laneOffset = laneOffset(e);
      e.path = new Polyline(offsetLine(e.pts, e.laneOffset));
      e.speed = e.maxspeed ? Math.min(e.maxspeed / 3.6, CLASS_SPEED[e.hw] || 9) : CLASS_SPEED[e.hw] || 9;
      this.byId.set(e.id, e);
      this.edges.push(e);
      if (!this.out.has(e.u)) this.out.set(e.u, []);
      this.out.get(e.u).push(e);
      e.twin = (this.out.get(e.v) || []).find((f) => f.v === e.u) || null;
      if (e.twin && !e.twin.twin) e.twin.twin = e;
      return e;
    });
  }
}

// Next edge after `e`: anything but a U-turn, unless the street is a dead end.
// Null where the network isn't loaded (the far side of the map).
export function nextEdge(g, e, r) {
  const all = g.out.get(e.v) || [];
  const opts = all.filter((f) => f !== e.twin);
  const list = opts.length ? opts : all;
  return list.length ? list[Math.floor(r() * list.length)] : null;
}

// A route is a chain of legs: the lane of each edge, trimmed at both ends, and a
// short curve through each junction so turns are smooth.
export class Route {
  constructor(g, edge, s, r) {
    this.g = g;
    this.r = r;
    this.legs = [{ path: edge.path, s0: 0, s1: edge.path.length, edge }];
    this.s = s;
    this.extend();
  }

  get leg() { return this.legs[0]; }

  extend() {
    while (!this.dead && this.legs.filter((l) => l.edge).length < 4) {
      const last = this.legs[this.legs.length - 1];
      const e = last.edge, f = nextEdge(this.g, e, this.r);
      if (!f) { this.dead = true; return; }
      const trim = Math.min(7, e.path.length / 3, f.path.length / 3);
      last.s1 = Math.max(last.s0, e.path.length - trim);
      const a = e.path.at(last.s1), b = f.path.at(trim);
      const turn = Math.abs(Math.atan2(Math.sin(b.ang - a.ang), Math.cos(b.ang - a.ang)));
      const conn = new Polyline(bezier([a.x, a.y], corner(a, b), [b.x, b.y]));
      this.legs.push({ path: conn, s0: 0, s1: conn.length, edge: null, turn, speed: Math.min(e.speed, f.speed) });
      this.legs.push({ path: f.path, s0: trim, s1: f.path.length, edge: f });
    }
  }

  // Advance by ds metres; returns the current point.
  advance(ds) {
    this.s += ds;
    while (this.s > this.leg.s1) {
      if (this.legs.length === 1) { this.s = this.leg.s1; this.ended = true; break; }
      const over = this.s - this.leg.s1;
      this.legs.shift();
      this.s = this.leg.s0 + over;
      this.extend();
    }
    return this.leg.path.at(this.s);
  }

  // Point `d` metres ahead along the route, and the lowest speed limit on the way there.
  lookahead(d) {
    let s = this.s, limit = Infinity;
    for (const leg of this.legs) {
      limit = Math.min(limit, leg.edge ? leg.edge.speed : leg.speed, !leg.edge && leg.turn > 1.1 ? 4.5 : !leg.edge && leg.turn > 0.5 ? 7 : Infinity);
      if (s + d <= leg.s1) return { p: leg.path.at(s + d), limit };
      d -= leg.s1 - s;
      s = leg === this.legs[this.legs.length - 1] ? leg.s1 : this.legs[this.legs.indexOf(leg) + 1].s0;
    }
    const last = this.legs[this.legs.length - 1];
    return { p: last.path.at(last.s1), limit };
  }
}

// Where the incoming and outgoing lanes would cross; the midpoint when they're parallel.
function corner(a, b) {
  const dax = Math.cos(a.ang), day = Math.sin(a.ang), dbx = Math.cos(b.ang), dby = Math.sin(b.ang);
  const den = dax * dby - day * dbx;
  const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  if (Math.abs(den) < 0.2) return mid;
  const t = ((b.x - a.x) * dby - (b.y - a.y) * dbx) / den;
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  if (t < 0 || t > gap * 1.5) return mid;
  return [a.x + dax * t, a.y + day * t];
}

// The footpath network, filled in as tiles arrive (edges are undirected).
const ROADLIKE = new Set(['residential', 'tertiary', 'secondary', 'primary', 'service', 'unclassified', 'living_street', 'busway']);
export class WalkGraph {
  constructor() {
    this.byId = new Map();
    this.adj = new Map();
    this.edges = [];
  }

  add(list) {
    const fresh = [];
    const res = list.map((raw) => {
      const known = this.byId.get(raw.id);
      if (known) return known;
      const e = { ...raw, path: new Polyline(raw.pts) };
      // Streets without a separately mapped pavement: people keep to the edge.
      e.side = ROADLIKE.has(e.hw) ? Math.max(0, e.width / 2 - 0.9) : 0;
      this.byId.set(e.id, e);
      this.edges.push(e);
      for (const [n, fwd] of [[e.u, true], [e.v, false]]) {
        if (!this.adj.has(n)) this.adj.set(n, []);
        this.adj.get(n).push({ e, fwd });
      }
      fresh.push(e);
      return e;
    });
    this.fresh = fresh;
    return res;
  }
}

// Spatial hash of named street segments, for the "you are on …" label.
export class StreetNames {
  constructor(...edgeLists) {
    this.cell = 20;
    this.map = new Map();
    this.seen = new Set();
    for (const list of edgeLists) this.add(list);
  }

  add(list) {
    for (const e of list) {
      if (this.seen.has(e)) continue;
      this.seen.add(e);
      if (!e.name) continue;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        const seg = { a, b, name: e.name, rank: e.hw === 'footway' || e.hw === 'steps' ? 1 : 0 };
        const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / this.cell) + 1;
        const keys = new Set();
        for (let k = 0; k <= n; k++) keys.add(this.key(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
        for (const key of keys) {
          if (!this.map.has(key)) this.map.set(key, []);
          this.map.get(key).push(seg);
        }
      }
    }
  }

  key(x, y) { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }

  at(x, y, maxD = 14) {
    let best = null, bestD = maxD;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const s of this.map.get(`${cx + i},${cy + j}`) || []) {
          const d = segDist(x, y, s.a, s.b) + s.rank * 4;
          if (d < bestD) { bestD = d; best = s.name; }
        }
      }
    }
    return best;
  }
}

export function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

// Rebuilt every frame: everything that moves or blocks, bucketed in 10 m cells.
export class SpatialHash {
  constructor(cell = 10) { this.cell = cell; this.map = new Map(); }
  clear() { this.map.clear(); }
  add(o) {
    const k = `${Math.floor(o.x / this.cell)},${Math.floor(o.y / this.cell)}`;
    let b = this.map.get(k);
    if (!b) this.map.set(k, (b = []));
    b.push(o);
  }
  *near(x, y, r) {
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((y - r) / c), j1 = Math.floor((y + r) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const b = this.map.get(`${i},${j}`);
      if (b) yield* b;
    }
  }
}
