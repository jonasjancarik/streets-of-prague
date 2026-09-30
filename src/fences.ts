import * as THREE from 'three';
import type { Car } from './car.ts';
import { bump, hit } from './posts.ts';
import { SECTION_STRIDE, VERTS } from './map/fences.ts';

// The fences and hedges along the streets and round the gardens. A car goes through a
// fence (the section it hits lies down), a hedge only when it's going fast, and slower
// than that it bounces off; a person can't walk through either, but can jump a low fence.
// (Walls are solid and part of the tile's collision grid, not here.)

export interface FenceSection {
  id: string; // tile and number, to lay the same sections down again when the tile is back
  x1: number; y1: number; x2: number; y2: number;
  z: number; // the ground under it
  h: number;
  hedge: boolean;
  broken: boolean;
  mesh: THREE.Mesh;
  first: number; // its first vertex in the mesh
}

const CELL = 8;
const REACH = 1.6; // m: half the longest section, and a little
const STEP = 0.6; // m between the points of a section a car is tested against
const FENCE = { r: 0.12, tough: 1.5, give: 0.04 }; // m/s into it that takes a fence down
const HEDGE = { r: 0.4, tough: 5, give: 0.2 };
const FEET = 0.6; // m: how far below your feet's height a jump clears a fence

// Lay a section down: a fence falls over the way the car was going, a hedge is squashed.
function lay(s: FenceSection, side: number) {
  const pos = s.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const n = s.hedge ? VERTS.hedge : VERTS.fence;
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

  // A tile's sections, from its buffers; the two meshes are the fences' and the hedges'.
  sections(tile: string, table: Float32Array, meshes: { fence: THREE.Mesh; hedge: THREE.Mesh }) {
    const out: FenceSection[] = [];
    for (let i = 0; i < table.length; i += SECTION_STRIDE) {
      const hedge = table[i + 6] === 1;
      const s: FenceSection = {
        id: `${tile}/${i / SECTION_STRIDE}`, x1: table[i], y1: table[i + 1], x2: table[i + 2], y2: table[i + 3],
        z: table[i + 4], h: table[i + 5], hedge, broken: false, mesh: hedge ? meshes.hedge : meshes.fence, first: table[i + 7],
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
    for (const f of this.near(car.x, car.y, Math.hypot(L, W))) {
      if (car.gz !== undefined && Math.abs(car.gz - f.z) > 2.5) continue;
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

  private lay(f: FenceSection, car: Car) {
    f.broken = true;
    this.down.add(f.id);
    // It falls the way the car was going.
    lay(f, Math.sign((car.vx * (f.y2 - f.y1) - car.vy * (f.x2 - f.x1))) || 1);
  }
}

export const fences = new Fences();
