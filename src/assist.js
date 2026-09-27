import { clamp } from './network.js';

// Lane assist (hold Shift while driving): picks up the lane you're driving in and
// steers along it, through bends and across junctions. A or D works like an indicator:
// press it any time and the assist takes the next left or right turn; otherwise it goes
// straight on. Gas and brakes stay yours.
//
// It only works within the speed limit of the street you're on (OSM maxspeed, else
// the Czech defaults): go faster and it lets go of the wheel, and it takes over again
// once you're 5 km/h under the limit.

// Nearest point of a polyline to (x, y), searching [s0, s1]: { s, d, ang }.
export function project(path, x, y, s0 = 0, s1 = path.length) {
  const { pts, cum } = path;
  let best = { s: 0, d: Infinity, ang: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    if (cum[i + 1] < s0 || cum[i] > s1) continue;
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1);
    const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
    if (d < best.d) best = { s: cum[i] + t * Math.sqrt(len2), d, ang: Math.atan2(dy, dx) };
  }
  return best;
}

export const turnOf = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// km/h: the tagged limit, else 80 on motorways, 70 on trunk roads, 50 in town.
export function speedLimit(e) {
  if (e?.maxspeed) return e.maxspeed;
  if (e?.hw?.startsWith('motorway')) return 80;
  if (e?.hw?.startsWith('trunk')) return 70;
  return 50;
}

export class LaneAssist {
  constructor(drive, edgesNear) {
    this.g = drive;
    this.edgesNear = edgesNear;
    this.edge = null;
    this.next = null;
    this.s = 0;
    this.intent = 0; // +1 left, -1 right at the next junction
  }

  reset() { this.edge = this.next = null; this.intent = 0; this.tripped = false; }

  // A lane within 5 m running roughly the way the car points.
  acquire(car) {
    let best = null, score = Infinity;
    for (const e of this.edgesNear(car.x, car.y, 40)) {
      const p = project(e.path, car.x, car.y);
      if (p.d > 5) continue;
      const off = Math.abs(turnOf(car.h, p.ang));
      if (off > 0.8) continue;
      const sc = p.d + off * 4;
      if (sc < score) { score = sc; best = { e, s: p.s }; }
    }
    if (!best) return false;
    this.edge = best.e;
    this.s = best.s;
    this.next = null;
    return true;
  }

  // Which way to leave the current street: straight on, or the turn you're asking for.
  choose(steer) {
    const e = this.edge;
    const opts = (this.g.out.get(e.v) || []).filter((f) => f !== e.twin);
    if (!opts.length) return null;
    const endAng = e.path.at(e.path.length).ang;
    const turns = opts.map((f) => ({ f, t: turnOf(endAng, f.path.at(Math.min(8, f.path.length)).ang) }));
    if (steer > 0.3) return turns.reduce((a, b) => (b.t > a.t ? b : a)).f;   // leftmost
    if (steer < -0.3) return turns.reduce((a, b) => (b.t < a.t ? b : a)).f;  // rightmost
    return turns.reduce((a, b) => (Math.abs(b.t) < Math.abs(a.t) ? b : a)).f;
  }

  // The steering (-1..1, left positive) that keeps the car in lane, or null if there's
  // no lane to follow here.
  steer(car, playerSteer) {
    if (!this.edge && !this.acquire(car)) return null;
    let p = project(this.edge.path, car.x, car.y, this.s - 15, this.s + 40);
    if (p.d > 7) {
      if (!this.acquire(car)) return null;
      p = project(this.edge.path, car.x, car.y);
    }
    this.s = p.s;
    const speed = Math.abs(car.forwardSpeed);
    this.limit = speedLimit(this.edge);
    const kmh = speed * 3.6;
    if (this.tripped && kmh < this.limit - 5) this.tripped = false;
    if (!this.tripped && kmh > this.limit) this.tripped = true;
    if (this.tripped) return null;
    const L = 6 + speed * 0.8;
    const left = this.edge.path.length - this.s;
    // A/D sets the turn for the next junction; the way on is picked as it comes up.
    if (Math.abs(playerSteer) > 0.3 && Math.sign(playerSteer) !== this.intent) {
      this.intent = Math.sign(playerSteer);
      this.next = null;
    }
    if (left < L + 15 && !this.next) this.next = this.choose(this.intent);
    if (left < 0.5 && this.next) {
      this.edge = this.next;
      this.next = null;
      this.intent = 0;
      this.s = 0;
      return this.steer(car, 0);
    }
    const target = left >= L || !this.next ? this.edge.path.at(this.s + L) : this.next.path.at(L - left);
    // Pure pursuit: the curvature that reaches the target, turned into a yaw rate the
    // car's steering can deliver.
    const alpha = turnOf(car.h, Math.atan2(target.y - car.y, target.x - car.x));
    const dist = Math.hypot(target.x - car.x, target.y - car.y) || 1;
    const yaw = (2 * Math.sin(alpha) * Math.max(speed, 1)) / dist;
    const S = car.spec, fast = clamp(speed / S.vmax, 0, 1);
    const maxW = Math.min(speed / 3.6, S.turn * (1 - 0.35 * fast)) || 1;
    return clamp((yaw / maxW) * Math.sign(car.forwardSpeed || 1), -1, 1);
  }
}
