import * as THREE from 'three';
import type { Car } from './car.ts';
import { crash, type ImpactKind } from './impacts.ts';
import { sendInstances } from './gpu.ts';
import { furnitureModels } from './furnitureModels.ts';
import { FURNITURE_SIZE, KIND, KNOCKABLE, POST_OWNER, type FurnitureSpot } from './map/furniture.ts';
import type { Grid } from './map/geo.ts';

// Street furniture a car can knock loose (plan 040): bins, the 1100 l containers, benches,
// poster cases and glass bells, and, bolted down and needing a harder blow, bike stands,
// parking machines and street cabinets. Standing, each is solid cells in its tile's
// collision grid like any other furniture, and a rotated box here. A car closing on one faster than its `tough`
// frees its cells (the ones the tile worker noted it alone made solid, `looseCells`) and
// throws it: from then on it's a rigid box that tumbles, skids and comes to rest on the
// ground however it lands, and a car that runs into it again shoves it on. It's drawn
// where it is by its own instance in the tile's furniture mesh, so both cameras show it.
// A container rolls on its castors while it stands; a bin empties and a glass bell breaks
// (`onSpill`, which src/debris.ts throws).
//
// The bodies are simulated in three.js's frame (x east, y up, z south), so a body's pose
// goes straight into its instance matrix; the game's (x, y) is (x, -z).

// mass kg; tough: m/s into it that knocks it loose; give: the share of the car's closing
// speed the fixings take when it does; sound: what it sounds like (src/soundmix.ts);
// castors: rolls on them while it stands upright; spill: what comes out of it, and
// `spills` how many times at most (a knock, a hard landing, tipping over); kick: m/s on
// foot into it that knocks it loose (none: it stays put for someone on foot).
interface Make { mass: number; tough: number; give: number; sound: ImpactKind; castors?: boolean; spill?: Spill; spills?: number; kick?: number }
export type Spill = 'rubbish' | 'bottles';
const CONTAINER: Make = { mass: 70, tough: 2, give: 0, sound: 'container', castors: true, spill: 'rubbish', spills: 1, kick: 3 };
// A glass bell full of bottles: heavy, sitting loose on the pavement.
const BELL: Make = { mass: 250, tough: 2.5, give: 0, sound: 'bottles', spill: 'bottles', spills: 3 };
const MAKES: Record<number, Make> = {
  [KIND.bin]: { mass: 25, tough: 2.5, give: 0.05, sound: 'bin', spill: 'rubbish', spills: 2, kick: 5 },
  [KIND.paper]: CONTAINER, [KIND.plastic]: CONTAINER, [KIND.cartons]: CONTAINER, [KIND.metal]: CONTAINER,
  [KIND.bench]: { mass: 90, tough: 5, give: 0.15, sound: 'timber' },
  [KIND.posterCase]: { mass: 45, tough: 4, give: 0.1, sound: 'panel' },
  [KIND.glass]: BELL, [KIND.clearGlass]: BELL,
  // Bolted down: they need a harder blow and take more of it.
  [KIND.bikeStand]: { mass: 25, tough: 7, give: 0.25, sound: 'post' },
  [KIND.parkingMachine]: { mass: 140, tough: 7, give: 0.35, sound: 'rail' },
  [KIND.cabinet]: { mass: 90, tough: 6, give: 0.3, sound: 'container' },
};
// What a piece spilling gives anyone listening (src/debris.ts throws it): what, how many
// pieces, where (game metres, z the ground) and how fast it was going.
export interface SpillEvent { what: Spill; n: number; x: number; y: number; z: number; vx: number; vy: number }

const CELL = 8; // m, the standing pieces' hash
const PAD = 0.45; // m round a standing piece: its grid cells reach this far (0.15 stamped, half a 0.5 m cell)
const STEP = 1 / 120; // s
const ITERATIONS = 4;
const AWAKE = 48; // bodies simulated at once at most
const G = 9.81;
const FRICTION = 0.7, BOUNCE = 0.25;
const ROLL = 0.45; // the grip of castors rolling (rolling resistance and a little sideways drag)
const PERSON = 80; // kg, someone on foot
const REACH = 0.35; // m, round someone on foot

interface Standing {
  tile: string; x: number; y: number; angle: number; hx: number; hy: number;
  make: Make; kind: number; spot: FurnitureSpot; spotIndex: number; mesh: THREE.InstancedMesh; index: number;
  grid: Grid; cells: Shared[]; // the grid cells it makes solid
}
// A grid cell knockable pieces make solid: what it was without them, and which still stand.
interface Shared { cell: number; was: number; standing: Set<number> }

interface Body {
  tile: string; make: Make; mesh: THREE.InstancedMesh; index: number;
  level: number;
  p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3;
  half: THREE.Vector3; offset: THREE.Vector3; // the box's half size, and its middle in the model
  invMass: number; invI: THREE.Vector3; // the inverse inertia about the box's own axes
  radius: number; // m, round it on the ground, for cars
  awake: boolean; still: number; heard: number;
  cars: Car[]; // the cars near it, found once a frame while it's awake
  spilled: number; // times it has spilled
  from: [number, number]; // where it stood (game metres)
}

export interface LooseWorld {
  ground: (x: number, y: number, level: number) => number; // game (x, y)
  grid: (x: number, y: number) => Grid | undefined; // the collision grid of the tile there
  cars?: (x: number, y: number, r: number, out: Car[]) => Car[]; // the cars near a point, moving or parked
}

// What knocks a standing piece loose: a car, or someone on foot. `lift`: the share of the
// blow that goes up; `at`: how high it lands (m over the ground).
interface Hitter { vx: number; vy: number; mass: number; level: number; who: object; car?: Car; lift: number; at: number }
const hitter: Hitter = { vx: 0, vy: 0, mass: 0, level: 0, who: {}, lift: 0.08, at: 0.45 };
const hit = { nx: 0, ny: 0, pen: 0 };

// The street models' boxes, per kind: [half size, middle], in the model's frame.
let boxes: Map<number, [THREE.Vector3, THREE.Vector3]> | undefined;
function boxOf(kind: number) {
  if (!boxes) {
    boxes = new Map();
    const models = furnitureModels();
    models.forEach((g, k) => {
      if (KNOCKABLE.has(k)) {
        g.computeBoundingBox();
        const b = g.boundingBox!, half = new THREE.Vector3(), mid = new THREE.Vector3();
        b.getSize(half).multiplyScalar(0.5); b.getCenter(mid);
        boxes!.set(k, [half, mid]);
      }
      g.dispose();
    });
  }
  return boxes.get(kind)!;
}

const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), rr = new THREE.Vector3();
const qa = new THREE.Quaternion(), m4 = new THREE.Matrix4(), m5 = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);
const corners: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3());

// out = I⁻¹ a, the body's inverse inertia in the world's frame.
function invInertia(b: Body, a: THREE.Vector3, out: THREE.Vector3) {
  qa.copy(b.q).invert();
  out.copy(a).applyQuaternion(qa).multiply(b.invI).applyQuaternion(b.q);
  return out;
}

// An impulse `j` (world, N s) on the body at `r` from its middle.
function push(b: Body, j: THREE.Vector3, r: THREE.Vector3) {
  b.v.addScaledVector(j, b.invMass);
  b.w.add(invInertia(b, v3.crossVectors(r, j), v2));
}

class LooseFurniture {
  world: LooseWorld | null = null;
  private cells = new Map<number, Standing[]>();
  private byTile = new Map<string, Standing[]>();
  private bodies: Body[] = [];
  private found: Standing[] = [];
  private dirty = new Set<THREE.InstancedMesh>();
  private grown = new WeakSet<THREE.InstancedMesh>();
  // Each tile's cells that standing knockable pieces make solid.
  private shared = new WeakMap<Grid, Map<number, Shared>>();
  private left = 0; // s of simulation owed
  private clock = 0;
  // (For tests: every knock so far.)
  knocks = 0;
  // Told when a piece spills its rubbish or its broken glass.
  onSpill: ((e: SpillEvent) => void) | null = null;

  private key(cx: number, cy: number) { return (cx + 32768) * 65536 + cy + 32768; }

  // A tile's knockable pieces, as they stand: `spots` its furniture, `meshes` their
  // instanced meshes (src/furniture.ts, one per kind, the instances in the spots' order),
  // `looseCells` from the worker, `grid` the tile's collision grid.
  addTile(tile: string, spots: FurnitureSpot[], meshes: THREE.InstancedMesh[], looseCells: Map<number, number[]> | undefined, grid: Grid) {
    this.removeTile(tile); // (a tile made again without being dropped first)
    if (!looseCells) return;
    const byKind = new Map<number, THREE.InstancedMesh>();
    for (const m of meshes) byKind.set(m.userData.kind, m);
    const owned = new Map<number, Shared[]>(), cells = new Map<number, Shared>();
    this.shared.set(grid, cells);
    for (const [cell, [was, ...by]] of looseCells) {
      const shared: Shared = { cell, was, standing: new Set(by) };
      cells.set(cell, shared);
      for (const spot of by) { const list = owned.get(spot); if (list) list.push(shared); else owned.set(spot, [shared]); }
    }
    const counts = new Map<number, number>(), list: Standing[] = [];
    spots.forEach((spot, i) => {
      const index = counts.get(spot.kind) ?? 0;
      counts.set(spot.kind, index + 1);
      const make = MAKES[spot.kind], mesh = byKind.get(spot.kind);
      if (!make || !mesh) return;
      const [hx, hy] = FURNITURE_SIZE[spot.kind];
      const s: Standing = { tile, x: spot.x, y: spot.y, angle: spot.angle, hx, hy, make, kind: spot.kind, spot, spotIndex: i, mesh, index, grid, cells: owned.get(i) ?? [] };
      list.push(s);
      const k = this.key(Math.floor(s.x / CELL), Math.floor(s.y / CELL)), at = this.cells.get(k);
      if (at) at.push(s); else this.cells.set(k, [s]);
    });
    this.byTile.set(tile, list);
  }

  removeTile(tile: string) {
    for (const s of this.byTile.get(tile) ?? []) this.unhash(s);
    this.byTile.delete(tile);
    this.bodies = this.bodies.filter((b) => b.tile !== tile);
  }

  private unhash(s: Standing) {
    const k = this.key(Math.floor(s.x / CELL), Math.floor(s.y / CELL)), at = this.cells.get(k);
    const i = at ? at.indexOf(s) : -1;
    if (at && i >= 0) { at.splice(i, 1); if (!at.length) this.cells.delete(k); }
  }

  private near(x: number, y: number, r: number) {
    const out = this.found;
    out.length = 0;
    for (let cx = Math.floor((x - r - 2) / CELL); cx <= Math.floor((x + r + 2) / CELL); cx++) {
      for (let cy = Math.floor((y - r - 2) / CELL); cy <= Math.floor((y + r + 2) / CELL); cy++) {
        const at = this.cells.get(this.key(cx, cy));
        if (at) for (const s of at) out.push(s);
      }
    }
    return out;
  }

  // A car against the pieces it touches: a standing one it closes on fast enough comes
  // loose, a loose one is shoved. (A standing one hit slower is the grid's: a wall.)
  // Returns how hard it hit (m/s), as Posts.collide.
  collide(car: Car) {
    if (!this.world) return 0;
    const L = car.spec.L / 2, W = car.spec.W / 2, c = Math.cos(car.h), s = Math.sin(car.h);
    const reach = Math.hypot(L, W);
    let impact = 0;
    if (this.cells.size) {
      for (const p of this.near(car.x, car.y, reach + 1.5)) {
        if (car.gz !== undefined && Math.abs(car.gz - p.spot.z) > 2.5) continue;
        const n = this.touchBox(car, c, s, L, W, p);
        if (!n) continue;
        const vn = car.vx * n[0] + car.vy * n[1];
        if (vn > p.make.tough) {
          Object.assign(hitter, { vx: car.vx, vy: car.vy, mass: car.spec.mass, level: car.level ?? 0, who: car, car, lift: 0.08, at: 0.45 });
          this.loosen(hitter, p, n, vn);
          car.vx = hitter.vx; car.vy = hitter.vy;
        }
      }
    }
    for (const b of this.bodies) {
      const bx = b.p.x, by = -b.p.z;
      if (Math.abs(bx - car.x) > reach + 2 || Math.abs(by - car.y) > reach + 2) continue;
      impact = Math.max(impact, this.shove(car, b, c, s, L, W));
    }
    return impact;
  }

  // Whether a car's box (heading c, s; half L, W) overlaps a standing piece's box grown
  // by PAD; if so the way out of the car towards it (game frame), else null.
  private touchBox(car: { x: number; y: number }, c: number, s: number, L: number, W: number, p: Standing): [number, number] | null {
    const pc = Math.cos(p.angle), ps = Math.sin(p.angle), hx = p.hx + PAD, hy = p.hy + PAD;
    const dx = p.x - car.x, dy = p.y - car.y;
    // Separating axes: the car's two and the piece's two.
    const axes: [number, number, number, number, number][] = [[c, s, L, hx, hy], [-s, c, W, hx, hy], [pc, ps, hx, L, W], [-ps, pc, hy, L, W]];
    for (let i = 0; i < 4; i++) {
      const [ax, ay, own] = axes[i];
      const d = Math.abs(dx * ax + dy * ay);
      // The other box's extent along this axis.
      let other: number;
      if (i < 2) other = hx * Math.abs(pc * ax + ps * ay) + hy * Math.abs(-ps * ax + pc * ay);
      else other = L * Math.abs(c * ax + s * ay) + W * Math.abs(-s * ax + c * ay);
      if (d > own + other) return null;
    }
    // The way out: from the nearest point of the car's box to the piece's middle.
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    let ex = lx - Math.max(-L, Math.min(L, lx)), ey = ly - Math.max(-W, Math.min(W, ly));
    const d = Math.hypot(ex, ey);
    if (d > 1e-6) { ex /= d; ey /= d; } else if (L - Math.abs(lx) < W - Math.abs(ly)) { ex = Math.sign(lx) || 1; ey = 0; } else { ex = 0; ey = Math.sign(ly) || 1; }
    return [ex * c - ey * s, ex * s + ey * c];
  }

  // A standing piece hit `vn` m/s along `n`: its cells freed, made a body, thrown. What
  // the blow takes off the hitter's speed comes off `by`.
  private loosen(by: Hitter, p: Standing, n: [number, number], vn: number) {
    this.unhash(p);
    const own = this.byTile.get(p.tile);
    if (own) own.splice(own.indexOf(p), 1);
    for (const c of p.cells) {
      c.standing.delete(p.spotIndex);
      if (!c.standing.size) p.grid.cells[c.cell] = c.was;
    }
    const [half, mid] = boxOf(p.kind), make = p.make, m = make.mass;
    const q = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, p.angle);
    const pos = new THREE.Vector3(p.x, p.spot.z - 0.04, -p.y).add(mid.clone().applyQuaternion(q));
    const [a, b, cc] = [half.x * 2, half.y * 2, half.z * 2];
    const body: Body = {
      tile: p.tile, make, mesh: p.mesh, index: p.index, level: by.level,
      p: pos, v: new THREE.Vector3(), q, w: new THREE.Vector3(),
      half: half.clone(), offset: mid.clone(),
      invMass: 1 / m, invI: new THREE.Vector3(12 / (m * (b * b + cc * cc)), 12 / (m * (a * a + cc * cc)), 12 / (m * (a * a + b * b))),
      radius: Math.max(0.3, Math.min(half.x, half.z) * 0.6 + Math.max(half.x, half.z) * 0.4),
      awake: true, still: 0, heard: this.clock, spilled: 0, from: [p.x, p.y], cars: [],
    };
    this.bodies.push(body);
    this.knocks++;
    // The hitter's share: the fixings' give, and the blow by momentum.
    const M = by.mass, j = (1 + 0.15) * vn / (1 / M + 1 / m);
    const groundZ = p.spot.z;
    // Struck at bumper height (a car's) on the side facing it, so a tall piece goes over.
    rr.set(-n[0] * half.x * 0.8, groundZ + by.at - pos.y, n[1] * half.z * 0.8);
    const tangent = (-by.vx * n[1] + by.vy * n[0]) * 0.25; // a glancing blow drags it along
    v1.set(n[0] * j + -n[1] * tangent * m, j * by.lift, -(n[1] * j + n[0] * tangent * m));
    push(body, v1, rr);
    // (A bit of a spin, never the same twice.)
    body.w.y += (Math.random() - 0.5) * vn * (by.car ? 0.6 : 0.2);
    const loss = j / M + make.give * vn;
    by.vx -= n[0] * loss;
    by.vy -= n[1] * loss;
    if (make.give && by.car) { by.car.takeImpactDamage(make.give * vn * 0.5); by.car.knock(p.x, p.y, vn * make.give); }
    this.grow(p.mesh);
    this.cap();
    const heard = vn * Math.min(1, Math.max(0.3, Math.sqrt(m / 300)));
    crash(by.who, null, heard, make.sound, p.x, p.y, M);
    // A bin hit hard enough empties, a glass bell breaks.
    // (A bin's rubbish mostly comes out where it lands: a little here.)
    if (make.spill && vn > 4) this.spill(body, make.spill === 'bottles' ? 30 + vn * 5 : 4 + vn * 0.5);
    return 0;
  }

  // Whether a body overlaps a car's box (at x, y, heading c, s, half L, W) on the ground:
  // if so `hit` holds the way out of the car towards it and how far in it is.
  private overlap(b: Body, x: number, y: number, c: number, s: number, L: number, W: number) {
    const dx = b.p.x - x, dy = -b.p.z - y, lx = dx * c + dy * s, ly = -dx * s + dy * c;
    let ex = lx - Math.max(-L, Math.min(L, lx)), ey = ly - Math.max(-W, Math.min(W, ly));
    const d = Math.hypot(ex, ey);
    if (d >= b.radius) return false;
    if (d > 1e-6) { ex /= d; ey /= d; hit.pen = b.radius - d; } else {
      const px = L - Math.abs(lx), py = W - Math.abs(ly);
      if (px < py) { ex = Math.sign(lx) || 1; ey = 0; hit.pen = px + b.radius; } else { ex = 0; ey = Math.sign(ly) || 1; hit.pen = py + b.radius; }
    }
    hit.nx = ex * c - ey * s; hit.ny = ex * s + ey * c;
    return true;
  }

  // Whether `f` moved the body (put it out of the way, or gave it a push).
  private awakeAfter(b: Body, f: () => void) {
    const x = b.p.x, z = b.p.z, vx = b.v.x, vz = b.v.z;
    f();
    return b.p.x !== x || b.p.z !== z || b.v.x !== vx || b.v.z !== vz;
  }

  // Whether a body is down where a car of height `h` standing on `gz` could touch it.
  private within(b: Body, gz: number | undefined, h: number) {
    const ground = this.world!.ground(b.p.x, -b.p.z, b.level);
    return !(b.p.y - b.half.y * 0.5 > ground + h || (gz !== undefined && Math.abs(gz - ground) > 2.5));
  }

  // The loose pieces near a traffic car shoved out of its way. (Its lane moves it, so
  // nothing slows it; it seldom gets this close, as it waits or goes round them.)
  brush(car: Car) {
    if (!this.bodies.length) return;
    const L = car.spec.L / 2, W = car.spec.W / 2, c = Math.cos(car.h), s = Math.sin(car.h), reach = Math.hypot(L, W) + 2;
    for (const b of this.bodies) {
      if (Math.abs(b.p.x - car.x) > reach || Math.abs(-b.p.z - car.y) > reach) continue;
      const vx = car.vx, vy = car.vy, touched = this.awakeAfter(b, () => this.shove(car, b, c, s, L, W));
      car.vx = vx; car.vy = vy;
      // Edged past at a crawl, it's nudged aside, not pushed along the street ahead of it.
      if (touched) {
        const dx = b.p.x - car.x, dy = -b.p.z - car.y, ahead = dx * c + dy * s, left = -dx * s + dy * c;
        if (ahead > L * 0.5) { const k = left >= 0 ? 1 : -1; b.v.x += -s * k * 0.8; b.v.z -= c * k * 0.8; }
      }
    }
  }

  // Something round, `r` across, at (x, y) going (vx, vy) through the loose pieces: a tram
  // (mass Infinity) or someone on foot. Each is pushed out of it and given its share of
  // the blow; the share of the way back it pushes the pusher is returned (out, game m).
  sweep(who: object, x: number, y: number, gz: number | undefined, r: number, vx: number, vy: number, mass: number, out: [number, number] = [0, 0]) {
    out[0] = out[1] = 0;
    for (const b of this.bodies) {
      const dx = b.p.x - x, dy = -b.p.z - y, reach = r + b.radius;
      if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;
      if (!this.within(b, gz, mass === Infinity ? 4 : 1)) continue;
      const d = Math.hypot(dx, dy);
      if (d >= reach) continue;
      const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0, pen = reach - d;
      const m = b.make.mass, share = mass === Infinity ? 1 : mass / (mass + m);
      b.p.x += nx * pen * share; b.p.z -= ny * pen * share;
      out[0] -= nx * pen * (1 - share); out[1] -= ny * pen * (1 - share);
      const rel = (vx - b.v.x) * nx + (vy + b.v.z) * ny;
      if (rel <= 0) { this.wake(b); continue; }
      const j = (1 + 0.1) * rel / (1 / mass + 1 / m);
      // (Low down: a foot, or a tram's lifeguard.)
      rr.set(-nx * b.radius, Math.min(0.2, this.world!.ground(b.p.x, -b.p.z, b.level) + 0.3 - b.p.y), ny * b.radius);
      v1.set(nx * j, j * 0.03, -ny * j);
      push(b, v1, rr);
      this.wake(b);
      if (rel > 2 && this.clock - b.heard > 0.3) {
        b.heard = this.clock;
        crash(who, null, rel * Math.min(1, Math.max(0.3, Math.sqrt(m / 300))), b.make.sound, b.p.x, -b.p.z, Math.min(mass, 30000));
      }
    }
    return out;
  }

  // Someone on foot (`r` round, going vx, vy) against the furniture: a standing bin run
  // into knocks over and a container walked into rolls away (`kick`); a loose piece is
  // shoved, and a heavy one holds them back. Returns how far they're pushed back (game m).
  kick(who: { x: number; y: number; gz?: number; vx: number; vy: number }, level = 0, out: [number, number] = [0, 0]) {
    if (!this.world) { out[0] = out[1] = 0; return out; }
    if (this.cells.size) {
      for (const p of this.near(who.x, who.y, 2)) {
        if (!p.make.kick || (who.gz !== undefined && Math.abs(who.gz - p.spot.z) > 1.5)) continue;
        // (A box REACH round them, square with the piece's.)
        const n = this.touchBox(who, Math.cos(p.angle), Math.sin(p.angle), REACH, REACH, p);
        if (!n) continue;
        const vn = who.vx * n[0] + who.vy * n[1];
        if (vn <= p.make.kick) continue;
        Object.assign(hitter, { vx: who.vx, vy: who.vy, mass: PERSON, level, who, car: undefined, lift: 0, at: 0.6 });
        this.loosen(hitter, p, n, vn);
      }
    }
    return this.sweep(who, who.x, who.y, who.gz, REACH, who.vx, who.vy, PERSON, out);
  }

  // Whether any piece lies loose.
  get any() { return this.bodies.length > 0; }

  // Each loose piece, as a circle on the ground: what traffic waits for or goes round and
  // people step round (main.ts puts them in with the cars).
  each(f: (x: number, y: number, z: number, r: number, vx: number, vy: number, key: object) => void) {
    // (With a margin: a car pulling out round it swings its corners out past the circles it's
    // measured with.)
    for (const b of this.bodies) f(b.p.x, -b.p.z, b.p.y, b.radius + 0.25, b.v.x, -b.v.z, b);
  }

  // A car against a loose piece: the piece pushed out of it and given its share of the blow.
  private shove(car: Car, b: Body, c: number, s: number, L: number, W: number) {
    if (!this.within(b, car.gz, car.spec.H)) return 0;
    const ground = this.world!.ground(b.p.x, -b.p.z, b.level);
    if (!this.overlap(b, car.x, car.y, c, s, L, W)) return 0;
    const { nx, ny, pen } = hit;
    // Out of the car's way, never the car out of it.
    b.p.x += nx * pen; b.p.z -= ny * pen;
    const rel = (car.vx - b.v.x) * nx + (car.vy + b.v.z) * ny;
    if (rel <= 0) return 0;
    const M = car.spec.mass, m = b.make.mass, j = (1 + 0.15) * rel / (1 / M + 1 / m);
    rr.set(-nx * b.radius, Math.min(0.3, ground + 0.45 - b.p.y), ny * b.radius);
    v1.set(nx * j, j * 0.08, -ny * j);
    push(b, v1, rr);
    car.vx -= nx * j / M;
    car.vy -= ny * j / M;
    this.wake(b);
    if (rel > 2 && this.clock - b.heard > 0.3) {
      b.heard = this.clock;
      crash(car, null, rel * Math.min(1, Math.max(0.3, Math.sqrt(m / 300))), b.make.sound, b.p.x, -b.p.z, M);
    }
    return 0;
  }

  // Some of what's in it out on the ground (at most `spills` times a piece).
  private spill(b: Body, n: number) {
    const make = b.make;
    if (!make.spill || b.spilled >= (make.spills ?? 1) || !this.onSpill) return;
    b.spilled++;
    const x = b.p.x, y = -b.p.z;
    this.onSpill({ what: make.spill, n: Math.round(Math.min(n, 120)), x, y, z: this.world!.ground(x, y, b.level), vx: b.v.x, vy: -b.v.z });
  }

  private wake(b: Body) {
    if (b.awake) return;
    b.awake = true; b.still = 0;
    this.cap();
  }

  // No more than AWAKE at once: the oldest awake one rests where it is.
  private cap() {
    let awake = 0;
    for (const b of this.bodies) if (b.awake) awake++;
    for (const b of this.bodies) {
      if (awake <= AWAKE) break;
      if (b.awake) { this.sleep(b); awake--; }
    }
  }

  private sleep(b: Body) { b.awake = false; b.v.set(0, 0, 0); b.w.set(0, 0, 0); }

  // The mesh's bounds, made big enough once that a piece thrown off its spot isn't culled.
  private grow(mesh: THREE.InstancedMesh) {
    if (this.grown.has(mesh)) return;
    this.grown.add(mesh);
    if (!mesh.boundingSphere) mesh.computeBoundingSphere();
    mesh.boundingSphere!.radius += 40;
    mesh.boundingBox = null;
  }

  // On by `dt` s of the game.
  update(dt: number) {
    if (!this.world || !this.bodies.some((b) => b.awake)) { this.left = 0; return; }
    this.left = Math.min(this.left + dt, 0.1);
    // The cars each could run into this frame.
    const cars = this.world.cars;
    for (const b of this.bodies) {
      if (!b.awake) continue;
      if (cars && b.v.lengthSq() > 0.09) cars(b.p.x, -b.p.z, 6 + b.v.length() * this.left, b.cars);
      else b.cars.length = 0;
    }
    while (this.left >= STEP) {
      this.left -= STEP;
      this.clock += STEP;
      for (const b of this.bodies) if (b.awake) this.step(b);
    }
    this.apart();
    for (const b of this.bodies) if (b.awake) this.draw(b);
    for (const mesh of this.dirty) sendInstances(mesh);
    this.dirty.clear();
  }

  private step(b: Body) {
    const world = this.world!, h = STEP;
    b.v.y -= G * h;
    // The slope under it.
    const gx = b.p.x, gy = -b.p.z, g0 = world.ground(gx, gy, b.level);
    const nrm = v1.set(world.ground(gx - 0.3, gy, b.level) - world.ground(gx + 0.3, gy, b.level), 0.6,
      -(world.ground(gx, gy - 0.3, b.level) - world.ground(gx, gy + 0.3, b.level))).normalize();
    // The box's corners, and how far each is in the ground.
    const depth: number[] = [];
    let deepest = 0;
    for (let i = 0; i < 8; i++) {
      const r = corners[i].set(i & 1 ? b.half.x : -b.half.x, i & 2 ? b.half.y : -b.half.y, i & 4 ? b.half.z : -b.half.z).applyQuaternion(b.q);
      const gx2 = b.p.x + r.x, gy2 = -(b.p.z + r.z);
      // (The ground under a corner off a ledge is the ground under the middle, within reason.)
      let g = world.ground(gx2, gy2, b.level);
      if (!Number.isFinite(g) || Math.abs(g - g0) > 1) g = g0;
      depth[i] = g - (b.p.y + r.y);
      deepest = Math.max(deepest, depth[i]);
    }
    let landed = 0;
    // Standing on its castors it rolls; on its side or its lid it scrapes.
    const upright = new THREE.Vector3(0, 1, 0).applyQuaternion(b.q).y, rolling = !!b.make.castors && upright > 0.9;
    const grip = rolling ? ROLL : FRICTION;
    for (let it = 0; it < ITERATIONS; it++) {
      for (let i = 0; i < 8; i++) {
        if (depth[i] < -0.01) continue;
        const r = corners[i];
        // The corner's velocity.
        const vp = v2.crossVectors(b.w, r).add(b.v);
        const vn = vp.dot(nrm);
        if (vn >= 0) continue;
        if (it === 0) landed = Math.max(landed, -vn);
        // How hard to push along a direction d at the corner: 1 / (1/m + (I⁻¹(r×d)×r)·d).
        const kn = b.invMass + v3.crossVectors(invInertia(b, rr.crossVectors(r, nrm), v3), r).dot(nrm);
        let jn = -(1 + (vn < -1 && it === 0 ? BOUNCE : 0)) * vn / kn;
        if (jn < 0) jn = 0;
        // Friction against the slide, no more than it can grip.
        const vt = vp.addScaledVector(nrm, -vn), slide = vt.length();
        const imp = rr.copy(nrm).multiplyScalar(jn);
        if (slide > 1e-4) {
          vt.divideScalar(slide);
          const kt = b.invMass + v3.crossVectors(invInertia(b, v3.crossVectors(r, vt), v3), r).dot(vt);
          const jt = Math.min(slide / kt, grip * jn);
          imp.addScaledVector(vt, -jt);
        }
        push(b, imp.clone(), r);
      }
    }
    // Out of the ground (a little at a time, so it settles rather than jumps).
    if (deepest > 0.005) b.p.y += (deepest - 0.005) * 0.6;
    // Scraping and crumpling on the ground (a box tumbling on its corners otherwise rolls
    // on like a wheel), and the air.
    if (deepest > -0.01 && !rolling) { b.w.multiplyScalar(0.975); b.v.x *= 0.992; b.v.z *= 0.992; } else b.w.multiplyScalar(deepest > -0.01 ? 0.99 : 0.999);
    // On, against the walls: back off whichever way runs into one.
    const ox = b.p.x, oz = b.p.z;
    b.p.addScaledVector(b.v, h);
    if (this.solid(b.p.x, -oz)) { b.p.x = ox; b.v.x *= -0.3; b.w.multiplyScalar(0.8); }
    if (this.solid(b.p.x, -b.p.z)) { b.p.z = oz; b.v.z *= -0.3; b.w.multiplyScalar(0.8); }
    for (let i = 0; i < b.cars.length; i++) this.against(b, b.cars[i]);
    qa.set(b.w.x, b.w.y, b.w.z, 0).multiply(b.q);
    b.q.set(b.q.x + qa.x * h * 0.5, b.q.y + qa.y * h * 0.5, b.q.z + qa.z * h * 0.5, b.q.w + qa.w * h * 0.5).normalize();
    // Heard landing hard.
    if (landed > 2.5 && this.clock - b.heard > 0.25) {
      b.heard = this.clock;
      // Landing hard, or a container going over onto its side (its lid comes open).
      if (landed > (b.make.spill === 'rubbish' ? 2.5 : 4) || (b.make.castors && upright < 0.5)) this.spill(b, b.make.spill === 'bottles' ? 10 + landed * 4 : 14 + landed * 3);
      crash(b, null, landed * Math.min(1, Math.max(0.3, Math.sqrt(b.make.mass / 300))), b.make.sound, b.p.x, -b.p.z, b.make.mass);
    }
    // At rest: asleep, costing nothing, until a car runs into it.
    if (b.v.length() < 0.15 && b.w.length() < 0.4 && deepest > -0.02) {
      b.still += h;
      if (b.still > 0.5) { this.sleep(b); this.draw(b); }
    } else b.still = 0;
    // Fallen out of the world (into the river, off the map): gone.
    if (b.p.y < g0 - 20) { this.sleep(b); b.mesh.setMatrixAt(b.index, m4.makeScale(0, 0, 0)); this.dirty.add(b.mesh); }
  }

  // A moving body against a car (parked, in traffic, yours): out of its box, and the blow
  // shared by mass. A traffic car keeps to its lane whatever hits it; a parked one is
  // nudged and dented.
  private against(b: Body, car: Car) {
    if (car.overboard || !this.within(b, car.gz, car.spec.H)) return;
    const L = car.spec.L / 2, W = car.spec.W / 2;
    if (!this.overlap(b, car.x, car.y, Math.cos(car.h), Math.sin(car.h), L, W)) return;
    const { nx, ny, pen } = hit;
    b.p.x += nx * pen; b.p.z -= ny * pen;
    // (How fast it closes on the car: n runs from the car to it.)
    const rel = -((b.v.x - car.vx) * nx + (-b.v.z - car.vy) * ny);
    if (rel <= 0) return;
    const m = b.make.mass, M = car.spec.mass, fixed = car.mode === 'traffic';
    const j = (1 + BOUNCE) * rel / (1 / m + (fixed ? 0 : 1 / M));
    rr.set(-nx * b.radius, 0, ny * b.radius);
    v1.set(nx * j, 0, -ny * j);
    push(b, v1, rr);
    if (!fixed) { car.vx -= nx * j / M; car.vy -= ny * j / M; }
    // (A bin at 30 km/h leaves a small dent in a door; a glass bell a deep one.)
    const heard = rel * Math.min(1, Math.max(0.3, Math.sqrt(m / 300)));
    if (rel > 3) car.knock(b.p.x, -b.p.z, rel * Math.min(1, Math.max(0.3, Math.sqrt(m / 150))), -nx, -ny);
    if (rel > 1.5 && this.clock - b.heard > 0.25) {
      b.heard = this.clock;
      crash(b, car, heard, b.make.sound, b.p.x, -b.p.z, m);
    }
  }

  // The awake pieces against each other (once a frame): pushed apart, the blow shared by
  // mass, and one lying still woken.
  private apart() {
    const list = this.bodies;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.awake) continue;
      for (let k = 0; k < list.length; k++) {
        const b = list[k];
        if (b === a || (b.awake && k < i)) continue;
        const dx = b.p.x - a.p.x, dy = -b.p.z + a.p.z, reach = a.radius + b.radius;
        if (Math.abs(dx) > reach || Math.abs(dy) > reach || Math.abs(a.p.y - b.p.y) > 1) continue;
        const d = Math.hypot(dx, dy);
        if (d >= reach) continue;
        const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0, pen = reach - d;
        const ia = a.invMass, ib = b.invMass, sa = ia / (ia + ib), sb = ib / (ia + ib);
        a.p.x -= nx * pen * sa; a.p.z += ny * pen * sa;
        b.p.x += nx * pen * sb; b.p.z -= ny * pen * sb;
        // (a closing on b along n.)
        const rel = (a.v.x - b.v.x) * nx + (-a.v.z + b.v.z) * ny;
        this.wake(b);
        if (rel <= 0) continue;
        const j = (1 + BOUNCE) * rel / (ia + ib);
        a.v.x -= nx * j * ia; a.v.z += ny * j * ia;
        b.v.x += nx * j * ib; b.v.z -= ny * j * ib;
        if (rel > 2 && this.clock - b.heard > 0.25) {
          b.heard = this.clock;
          crash(a, b, rel * Math.min(1, Math.max(0.3, Math.sqrt(b.make.mass / 300))), b.make.sound, b.p.x, -b.p.z, a.make.mass);
        }
      }
    }
  }

  // Whether a loose piece is stopped at (x, y): by a wall, a tree or a post, but not by
  // furniture still standing (it passes through that; knocking it on is for later).
  private solid(x: number, y: number) {
    const grid = this.world!.grid(x, y);
    if (!grid) return true;
    const i = grid.indexAt(x, y);
    if (i < 0) return true;
    if (grid.cells[i] !== 255) return false;
    // (Not furniture still standing, but a sign post that still stands: that it bounces off.)
    const shared = this.shared.get(grid)?.get(i);
    if (!shared) return true;
    for (const o of shared.standing) if (o >= POST_OWNER) return true;
    return false;
  }

  // A sign post knocked over (src/signFalls.ts): the grid cells only it held, freed. `owner`
  // is POST_OWNER and its index in the tile's sign posts.
  release(grid: Grid, owner: number) {
    const cells = this.shared.get(grid);
    if (!cells) return;
    for (const c of cells.values()) if (c.standing.delete(owner) && !c.standing.size) grid.cells[c.cell] = c.was;
  }

  private draw(b: Body) {
    m4.compose(b.p, b.q, ONE).multiply(m5.makeTranslation(-b.offset.x, -b.offset.y, -b.offset.z));
    b.mesh.setMatrixAt(b.index, m4);
    this.dirty.add(b.mesh);
  }

  // Whether furniture a car could knock loose still stands at (x, y) (a test's run up may go through it).
  standsAt(x: number, y: number) {
    const grid = this.world?.grid(x, y), i = grid ? grid.indexAt(x, y) : -1;
    return !!grid && i >= 0 && !!this.shared.get(grid)?.get(i)?.standing.size;
  }

  // (For tests and the console.)
  status() {
    return { standing: [...this.byTile.values()].reduce((n, l) => n + l.length, 0), bodies: this.bodies.length, awake: this.bodies.filter((b) => b.awake).length, knocks: this.knocks };
  }
  pieces() {
    return this.bodies.map((b) => ({ from: b.from, x: b.p.x, y: -b.p.z, z: b.p.y, vx: b.v.x, vy: -b.v.z, vz: b.v.y, spin: b.w.length(), awake: b.awake, up: new THREE.Vector3(0, 1, 0).applyQuaternion(b.q).y }));
  }
  // (For tests: the standing piece nearest (x, y) within r m set loose where it stands, of
  // `kind` if given; its index in pieces(), or -1.)
  free(x: number, y: number, r: number, kind?: number) {
    let best: Standing | null = null, d = r;
    for (const s of this.near(x, y, r)) {
      const e = Math.hypot(s.x - x, s.y - y);
      if (e < d && (kind === undefined || s.kind === kind)) { d = e; best = s; }
    }
    if (!best) return -1;
    Object.assign(hitter, { vx: 0, vy: 0, mass: PERSON, level: 0, who: this, car: undefined, lift: 0, at: 0.3 });
    this.loosen(hitter, best, [1, 0], 0);
    const b = this.bodies[this.bodies.length - 1];
    b.v.set(0, 0, 0); b.w.set(0, 0, 0);
    return this.bodies.length - 1;
  }
  // (For tests: loose piece `i` put at (x, y) on the ground, upright, going vx, vy.)
  place(i: number, x: number, y: number, vx = 0, vy = 0) {
    const b = this.bodies[i];
    if (!b || !this.world) return;
    b.q.identity();
    b.p.set(x, this.world.ground(x, y, b.level) + b.half.y + 0.02, -y);
    b.v.set(vx, 0, -vy); b.w.set(0, 0, 0);
    this.wake(b);
    this.draw(b);
  }
  standingNear(x: number, y: number, r: number) {
    return this.near(x, y, r).filter((s) => Math.hypot(s.x - x, s.y - y) < r).map((s) => ({ x: s.x, y: s.y, angle: s.angle, kind: s.kind, z: s.spot.z }));
  }
}

export const looseFurniture = new LooseFurniture();
