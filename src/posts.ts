import type { Car } from './car.ts';

// The posts along the streets a car can hit: the lamp posts (lamps.ts) and the poles of
// the tram wires (wires.ts). Each is a circle a car bounces off; hit hard enough (faster
// into it than `tough`), it goes over the way the car was going, and the car carries on
// slowed. Whoever put a post up draws it, standing and falling (see fall).

export interface Post {
  x: number; y: number;
  z: number; // the ground it stands on (NaN: not known, any height)
  r: number; // m
  tough: number; // m/s into it that knocks it over
  give: number; // how much of the car's speed into it the car loses knocking it over (0..1)
  down: { ang: number; t: number } | null; // knocked over: the way it fell (radians), when (performance.now)
  knocked?: (p: Post) => void;
}

const CELL = 8;
const FALL = 1.1; // s from upright to on the ground
const FLAT = Math.PI / 2 - 0.06; // radians it lies at in the end (a head or a cap props it up)

// How far over a post is (0 upright … FLAT on the ground), at `now` (performance.now),
// falling faster and faster as it goes.
export function fall(p: Post, now: number) {
  if (!p.down) return 0;
  const u = Math.min(1, (now - p.down.t) / (FALL * 1000));
  return FLAT * u * u;
}

class Posts {
  private cells = new Map<number, Post[]>();
  private found: Post[] = [];

  private key(cx: number, cy: number) { return (cx + 32768) * 65536 + cy + 32768; }

  add(p: Post) {
    const k = this.key(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
    const list = this.cells.get(k);
    if (list) list.push(p); else this.cells.set(k, [p]);
  }

  remove(p: Post) {
    const k = this.key(Math.floor(p.x / CELL), Math.floor(p.y / CELL));
    const list = this.cells.get(k);
    const i = list ? list.indexOf(p) : -1;
    if (list && i >= 0) { list.splice(i, 1); if (!list.length) this.cells.delete(k); }
  }

  // The standing posts within r of (x, y) (the list is reused: use it before asking again).
  near(x: number, y: number, r: number) {
    const out = this.found;
    out.length = 0;
    for (let cx = Math.floor((x - r - 1) / CELL); cx <= Math.floor((x + r + 1) / CELL); cx++) {
      for (let cy = Math.floor((y - r - 1) / CELL); cy <= Math.floor((y + r + 1) / CELL); cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (list) for (const p of list) if (!p.down && Math.hypot(p.x - x, p.y - y) < r + p.r) out.push(p);
      }
    }
    return out;
  }

  // Whether a standing post is within `pad` of a car's box: for parking, where a car
  // must not be put down round one.
  touches(car: Car, pad = 0.15) {
    const L = car.spec.L / 2 + pad, W = car.spec.W / 2 + pad, c = Math.cos(car.h), s = Math.sin(car.h);
    return this.near(car.x, car.y, Math.hypot(L, W)).some((p) => {
      const dx = p.x - car.x, dy = p.y - car.y, lx = dx * c + dy * s, ly = -dx * s + dy * c;
      return Math.hypot(Math.max(0, Math.abs(lx) - L), Math.max(0, Math.abs(ly) - W)) < p.r;
    });
  }

  knock(p: Post, ang: number) {
    if (p.down) return;
    p.down = { ang, t: performance.now() };
    p.knocked?.(p);
  }

  // A car against the posts it touches: pushed out of each, and bounced off it or,
  // hit hard enough, knocking it over. Returns how hard it hit (m/s), as collideGrid.
  collide(car: Car) {
    const L = car.spec.L / 2, W = car.spec.W / 2, c = Math.cos(car.h), s = Math.sin(car.h);
    let impact = 0;
    for (const p of this.near(car.x, car.y, Math.hypot(L, W))) {
      if (!Number.isNaN(p.z) && car.gz !== undefined && Math.abs(car.gz - p.z) > 2.5) continue;
      impact = Math.max(impact, bump(car, p, c, s, L, W));
      if (hit.over) this.knock(p, Math.atan2(car.vy, car.vx));
    }
    return impact;
  }
}

// Whether the last bump was hard enough to go through what it hit.
export const hit = { over: false };

// A car against one round thing (fixed, or a post): pushed out of it, and bounced off it,
// or (faster into it than `tough`) carrying on through it, slowed by `give` of its speed
// into it. `c`, `s`: the car's heading, `L`, `W`: half its length and width. Returns how
// hard it hit (m/s); `hit.over` says whether it went through.
export function bump(car: Car, p: { x: number; y: number; r: number; tough: number; give: number }, c: number, s: number, L: number, W: number) {
  hit.over = false;
  // The post in the car's frame, and the nearest point of the car's box to it.
  const dx = p.x - car.x, dy = p.y - car.y, lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const qx = Math.max(-L, Math.min(L, lx)), qy = Math.max(-W, Math.min(W, ly));
  let ex = lx - qx, ey = ly - qy, d = Math.hypot(ex, ey), pen: number;
  if (d >= p.r) return 0;
  if (d > 1e-6) {
    pen = p.r - d;
    ex /= d; ey /= d;
  } else {
    // Its middle is inside the box: out the nearer side.
    const px = L - Math.abs(lx), py = W - Math.abs(ly);
    if (px < py) { ex = Math.sign(lx) || 1; ey = 0; pen = px + p.r; } else { ex = 0; ey = Math.sign(ly) || 1; pen = py + p.r; }
  }
  // (ex, ey): from the car towards the post; the car goes the other way.
  const nx = -(ex * c - ey * s), ny = -(ex * s + ey * c);
  car.x += nx * pen;
  car.y += ny * pen;
  const vn = car.vx * nx + car.vy * ny;
  if (vn >= 0) return 0;
  if (-vn > p.tough) {
    hit.over = true;
    car.vx -= p.give * vn * nx;
    car.vy -= p.give * vn * ny;
    car.damage += p.give * 2;
    return -vn * p.give;
  }
  car.vx -= 1.3 * vn * nx;
  car.vy -= 1.3 * vn * ny;
  car.vx *= 0.92;
  car.vy *= 0.92;
  // Off-centre hits make the car spin.
  const rx = p.x - car.x, ry = p.y - car.y;
  car.w += (rx * ny - ry * nx) * vn * 0.09;
  car.damage += Math.max(0, -vn - (car.spec.tough ?? 3));
  return -vn;
}

export const posts = new Posts();
