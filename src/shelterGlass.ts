import type { Car } from './car.ts';
import { crash } from './impacts.ts';
import { shelterOf, shelterParts, stopLines, type Shelter } from './map/stopShelters.ts';
import type { Grid } from './map/geo.ts';
import type { Point2 } from './map/geo.ts';

// The stop shelters' glass (map/stopShelters.ts). It isn't drawn (the game can't make it
// see-through), but it's there: the shelter's outline is solid in the collision grid. A car
// closing on it faster than TOUGH shatters it: heard as glass, its crumbs thrown on
// (`onShatter`), and the outline's cells freed so the car goes on through under the roof.
// The posts and the light box stay solid. It's whole again when its tile is made again.

const TOUGH = 3; // m/s (11 km/h)
const GIVE = 0.08; // the share of the car's speed into it the glass takes
const PAD = 0.45; // m round the outline its grid cells reach
const KEEP = 0.3; // m round a post or the light box whose cells stay solid

interface Pane { tile: string; sh: Shelter; grid: Grid; cells: number[]; broken: boolean }
// A shelter's glass shattered: where (game metres), how fast the car was going, how many crumbs.
export interface Shatter { x: number; y: number; vx: number; vy: number; n: number }

class ShelterGlass {
  private byTile = new Map<string, Pane[]>();
  onShatter: ((e: Shatter) => void) | null = null;
  // (For tests: every shattering so far.)
  shattered = 0;

  // A tile's shelters, found as the roofs job finds them, from its buildings and its stop
  // lines, and its collision grid. (A shelter stands on the ground: the grid is the
  // ground's, and a car on a bridge above doesn't meet it.)
  addTile(tile: string, t: { buildings: { kind: string; h: number; rings: Point2[][]; shelter?: 1 }[]; rails?: { kind: string; pts: Point2[] }[]; drive?: { pts: Point2[]; width: number }[] },
    grid: Grid) {
    this.removeTile(tile);
    const lines = stopLines(t), marked = t.buildings.some((b) => b.shelter), list: Pane[] = [];
    for (const b of t.buildings) {
      const sh = shelterOf(b, lines, marked);
      if (!sh) continue;
      // What stays solid: the posts and the light box (the parts standing up to the roof).
      const keep = shelterParts(sh).filter((p) => p.h > 1.5 && p.a < 0.5);
      const cells = new Set<number>();
      // (All of the outline, a little over: the grid has it as OSM drew it, not as deep as
      // the shelter drawn in it.)
      for (let u = -sh.length / 2 - 0.3; u <= sh.length / 2 + 0.3; u += 0.2) for (let v = -sh.depth / 2 - 0.3; v <= sh.depth / 2 + 0.3; v += 0.2) {
        const x = sh.x + sh.c * u - sh.s * v, y = sh.y + sh.s * u + sh.c * v, i = grid.indexAt(x, y);
        if (i < 0 || grid.cells[i] !== 255) continue;
        if (keep.some((p) => Math.abs((x - p.x) * p.c + (y - p.y) * p.s) < p.a / 2 + KEEP && Math.abs(-(x - p.x) * p.s + (y - p.y) * p.c) < p.b / 2 + KEEP)) continue;
        cells.add(i);
      }
      if (cells.size) list.push({ tile, sh, grid, cells: [...cells], broken: false });
    }
    if (list.length) this.byTile.set(tile, list);
  }

  removeTile(tile: string) { this.byTile.delete(tile); }

  // (For tests: the shelters within r m of (x, y): their middle, axis, length, depth, and
  // whether their glass is broken.)
  near(x: number, y: number, r: number) {
    const out: { x: number; y: number; c: number; s: number; length: number; depth: number; broken: boolean }[] = [];
    for (const list of this.byTile.values()) for (const p of list) if (Math.hypot(p.sh.x - x, p.sh.y - y) < r)
      out.push({ x: p.sh.x, y: p.sh.y, c: p.sh.c, s: p.sh.s, length: p.sh.length, depth: Math.max(1.5, Math.min(2.2, p.sh.depth)), broken: p.broken });
    return out;
  }

  // A car against the shelters near it (before the grid): one it closes on fast enough
  // shatters.
  collide(car: Car) {
    if (!this.byTile.size) return;
    const L = car.spec.L / 2, W = car.spec.W / 2, c = Math.cos(car.h), s = Math.sin(car.h);
    for (const list of this.byTile.values()) for (const p of list) {
      const sh = p.sh;
      if (p.broken || Math.abs(sh.x - car.x) > sh.length + 6 || Math.abs(sh.y - car.y) > sh.length + 6) continue;
      if (car.overboard || (car.level ?? 0) > 0) continue;
      const n = touch(car.x, car.y, c, s, L, W, sh);
      if (!n) continue;
      const vn = car.vx * n[0] + car.vy * n[1];
      if (vn <= TOUGH) continue;
      p.broken = true;
      this.shattered++;
      for (const i of p.cells) p.grid.cells[i] = 0;
      car.vx -= n[0] * vn * GIVE; car.vy -= n[1] * vn * GIVE;
      car.knock(car.x + n[0] * L, car.y + n[1] * L, vn * 0.3);
      // Heard as glass breaking (soundmix.ts: a poster case's 'panel' is glass in a frame).
      const x = car.x + n[0] * (L + 0.3), y = car.y + n[1] * (L + 0.3);
      crash(car, p, Math.max(vn, 6), 'panel', x, y, 300);
      this.onShatter?.({ x, y, vx: car.vx, vy: car.vy, n: Math.round(Math.min(160, 40 + sh.length * 25)) });
    }
  }
}

// Whether a car's box (heading c, s; half L, W) is within PAD of a shelter's outline; if so
// the way from the car towards it, else null.
function touch(x: number, y: number, c: number, s: number, L: number, W: number, sh: Shelter): [number, number] | null {
  const hx = sh.length / 2 + PAD, hy = sh.depth / 2 + PAD;
  const dx = sh.x - x, dy = sh.y - y;
  const axes: [number, number, number][] = [[c, s, L], [-s, c, W], [sh.c, sh.s, hx], [-sh.s, sh.c, hy]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay, own] = axes[i];
    const other = i < 2 ? hx * Math.abs(sh.c * ax + sh.s * ay) + hy * Math.abs(-sh.s * ax + sh.c * ay)
      : L * Math.abs(c * ax + s * ay) + W * Math.abs(-s * ax + c * ay);
    if (Math.abs(dx * ax + dy * ay) > own + other) return null;
  }
  // From the nearest point of the car's box to the shelter's middle.
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  let ex = lx - Math.max(-L, Math.min(L, lx)), ey = ly - Math.max(-W, Math.min(W, ly));
  const d = Math.hypot(ex, ey);
  if (d > 1e-6) { ex /= d; ey /= d; } else if (L - Math.abs(lx) < W - Math.abs(ly)) { ex = Math.sign(lx) || 1; ey = 0; } else { ex = 0; ey = Math.sign(ly) || 1; }
  return [ex * c - ey * s, ex * s + ey * c];
}

export const shelterGlass = new ShelterGlass();
