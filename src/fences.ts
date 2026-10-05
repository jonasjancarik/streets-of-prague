import * as THREE from 'three';
import type { Car } from './car.ts';
import { bump, hit } from './posts.ts';
import { SECTION_STRIDE, VERTS } from './map/fences.ts';

// The fences and hedges along the streets and round the gardens, and the crash barriers
// along the big roads. A car goes through a fence (the section it hits lies down), a
// hedge only when it's going fast, and a crash barrier only when it drives nearly
// straight into it at speed; otherwise it bounces off, so a car that drifts into a
// barrier is turned back onto the road. A person can't walk through any of them, but
// can jump a low fence or a barrier.
// (Walls are solid and part of the tile's collision grid, not here.)

export interface FenceSection {
  id: string; // tile and number, to lay the same sections down again when the tile is back
  x1: number; y1: number; x2: number; y2: number;
  z: number; // the ground under it
  h: number;
  hedge: boolean;
  rail: boolean; // a crash barrier
  broken: boolean;
  mesh: THREE.Mesh;
  first: number; // its first vertex in the mesh
}

const CELL = 8;
const REACH = 1.6; // m: half the longest section, and a little
const STEP = 0.6; // m between the points of a section a car is tested against
const FENCE = { r: 0.12, tough: 1.5, give: 0.04 }; // m/s into it that takes a fence down
const HEDGE = { r: 0.4, tough: 5, give: 0.2 };
// 14 m/s (50 km/h) square into it; a car sliding along it meets it at far less.
const RAIL = { r: 0.15, tough: 14, give: 0.5 };
const FEET = 0.6; // m: how far below your feet's height a jump clears a fence

// Lay a section down: a fence falls over the way the car was going, a hedge is squashed.
function lay(s: FenceSection, side: number) {
  const pos = s.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = s.hedge ? VERTS.hedge : s.rail ? VERTS.rail : VERTS.fence;
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy) || 1;
  // (Three's x, z = -y.) Pushed out sideways by up to the fence's height.
  const nx = dy / len * side, nz = dx / len * side;
  let lo = Infinity;
  for (let i = 0; i < n; i++) lo = Math.min(lo, pos.getY(s.first + i));
  for (let i = 0; i < n; i++) {
    const v = s.first + i, up = pos.getY(v) - lo;
    if (s.hedge) { pos.setY(v, lo + up * 0.15); continue; }
    if (up < s.h * 0.5) continue;
    pos.setXYZ(v, pos.getX(v) + nx * s.h * 0.9, lo + 0.12, pos.getZ(v) + nz * s.h * 0.9);
  }
  pos.needsUpdate = true;
}

class Fences {
  private cells = new Map<number, FenceSection[]>();
  private found: FenceSection[] = [];
  private down = new Set<string>(); // ids of the sections that have been broken

  private key(cx: number, cy: number) { return (cx + 32768) * 65536 + cy + 32768; }
  private cell(s: FenceSection) { return this.key(Math.floor((s.x1 + s.x2) / 2 / CELL), Math.floor((s.y1 + s.y2) / 2 / CELL)); }

  // A tile's sections, from its buffers, and the mesh of each kind.
  sections(tile: string, table: Float32Array, meshes: { fence: THREE.Mesh; hedge: THREE.Mesh; rail: THREE.Mesh }) {
    const out: FenceSection[] = [];
    for (let i = 0; i < table.length; i += SECTION_STRIDE) {
      const hedge = table[i + 6] === 1, rail = table[i + 6] === 2;
      const s: FenceSection = {
        id: `${tile}/${i / SECTION_STRIDE}`, x1: table[i], y1: table[i + 1], x2: table[i + 2], y2: table[i + 3],
        z: table[i + 4], h: table[i + 5], hedge, rail, broken: false, mesh: hedge ? meshes.hedge : rail ? meshes.rail : meshes.fence, first: table[i + 7],
      };
      if (this.down.has(s.id)) { s.broken = true; lay(s, 1); }
      out.push(s);
    }
    return out;
  }

  add(list: FenceSection[]) {
    for (const s of list) {
      const k = this.cell(s), cell = this.cells.get(k);
      if (cell) cell.push(s); else this.cells.set(k, [s]);
    }
  }

  remove(list: FenceSection[]) {
    for (const s of list) {
      const k = this.cell(s), cell = this.cells.get(k);
      const i = cell ? cell.indexOf(s) : -1;
      if (cell && i >= 0) { cell.splice(i, 1); if (!cell.length) this.cells.delete(k); }
    }
  }

  // The standing sections whose middle is within r + REACH of (x, y) (the list is reused).
  private near(x: number, y: number, r: number) {
    const out = this.found;
    out.length = 0;
    for (let cx = Math.floor((x - r - REACH) / CELL); cx <= Math.floor((x + r + REACH) / CELL); cx++) {
      for (let cy = Math.floor((y - r - REACH) / CELL); cy <= Math.floor((y + r + REACH) / CELL); cy++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (cell) for (const s of cell) if (!s.broken) out.push(s);
      }
    }
    return out;
  }

  // Whether someone at (x, y) with feet `up` m off the ground is in a fence or hedge that
  // stops them: within r of a standing section, and not high enough to clear it.
  blocks(x: number, y: number, r: number, up: number) {
    for (const s of this.near(x, y, r)) {
      if (up + FEET >= s.h && !s.hedge) continue;
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / len2));
      if (Math.hypot(s.x1 + dx * t - x, s.y1 + dy * t - y) < r + (s.hedge ? HEDGE.r : 0)) return true;
    }
    return false;
  }

  // A car against the sections it touches, like the posts (posts.ts) but along a line:
  // the car is tested at points along each section. Returns how hard it hit (m/s).
  collide(car: Car) {
    const L = car.spec.L / 2, W = car.spec.W / 2, c = Math.cos(car.h), s = Math.sin(car.h);
    let impact = 0;
    this.through = false;
    for (const f of this.near(car.x, car.y, Math.hypot(L, W))) {
      if (car.gz !== undefined && Math.abs(car.gz - f.z) > 2.5) continue;
      if (f.rail) {
        impact = Math.max(impact, this.rail(f, car, c, s, L, W));
        continue;
      }
      const kind = f.hedge ? HEDGE : FENCE;
      const len = Math.hypot(f.x2 - f.x1, f.y2 - f.y1), n = Math.max(1, Math.ceil(len / STEP));
      const p = { x: 0, y: 0, r: kind.r, tough: kind.tough, give: kind.give };
      for (let i = 0; i <= n && !f.broken; i++) {
        p.x = f.x1 + (f.x2 - f.x1) * i / n;
        p.y = f.y1 + (f.y2 - f.y1) * i / n;
        impact = Math.max(impact, bump(car, p, c, s, L, W));
        if (hit.over) this.lay(f, car);
      }
    }
    return impact;
  }

  // A car against a crash barrier, as a line and not a row of posts: what counts is how
  // fast the car comes at the barrier's face, so one that drifts into it at speed slides
  // along it and is turned back, and only one driven nearly square into it breaks through.
  private through = false; // the car has just broken through a barrier in this pass

  private rail(f: FenceSection, car: Car, c: number, s: number, L: number, W: number) {
    const dx = f.x2 - f.x1, dy = f.y2 - f.y1, len = Math.hypot(dx, dy) || 1, tx = dx / len, ty = dy / len;
    // The barrier's normal, towards the side the car's middle is on.
    const side = Math.sign((car.x - f.x1) * -ty + (car.y - f.y1) * tx) || 1, nx = -ty * side, ny = tx * side;
    // How far the deepest corner over this section has gone past the barrier's face.
    let pen = 0, px = 0, py = 0;
    for (const [lx, ly] of [[L, W], [L, -W], [-L, W], [-L, -W]]) {
      const x = car.x + lx * c - ly * s, y = car.y + lx * s + ly * c;
      const along = (x - f.x1) * tx + (y - f.y1) * ty;
      if (along < -RAIL.r || along > len + RAIL.r) continue;
      const depth = RAIL.r - ((x - f.x1) * nx + (y - f.y1) * ny);
      if (depth > pen && depth < 2.5) { pen = depth; px = x; py = y; }
    }
    if (pen <= 0) return 0;
    const vn = car.vx * nx + car.vy * ny;
    if (vn >= 0) return 0;
    // A car wider than the gap it made takes the next section with it, at no further cost.
    if (this.through) { this.lay(f, car); return 0; }
    if (-vn > RAIL.tough) {
      this.through = true;
      car.vx -= RAIL.give * vn * nx;
      car.vy -= RAIL.give * vn * ny;
      car.damage += RAIL.give * 4;
      car.knock(px, py, -vn * RAIL.give);
      this.lay(f, car);
      return -vn * RAIL.give;
    }
    car.x += nx * pen;
    car.y += ny * pen;
    // Off the face with a little spring, and scraping along it.
    car.vx -= 1.2 * vn * nx;
    car.vy -= 1.2 * vn * ny;
    const scrape = 1 - Math.min(0.08, -vn * 0.012);
    car.vx *= scrape;
    car.vy *= scrape;
    car.w += ((px - car.x) * ny - (py - car.y) * nx) * vn * 0.03;
    car.damage += Math.max(0, -vn - (car.spec.tough ?? 3));
    car.knock(px, py, -vn);
    return -vn;
  }

  private lay(f: FenceSection, car: Car) {
    f.broken = true;
    this.down.add(f.id);
    // It falls the way the car was going.
    lay(f, Math.sign((car.vx * (f.y2 - f.y1) - car.vy * (f.x2 - f.x1))) || 1);
  }
}

export const fences = new Fences();
