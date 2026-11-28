import * as THREE from 'three';
import type { Car } from './car.ts';
import { crash, type ImpactKind } from './impacts.ts';
import { sendInstances } from './gpu.ts';
import { furnitureModels } from './furnitureModels.ts';
import { FURNITURE_SIZE, KIND, KNOCKABLE, type FurnitureSpot } from './map/furniture.ts';
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
// `spills` how many times at most (a knock, a hard landing, tipping over).
interface Make { mass: number; tough: number; give: number; sound: ImpactKind; castors?: boolean; spill?: Spill; spills?: number }
export type Spill = 'rubbish' | 'bottles';
const CONTAINER: Make = { mass: 70, tough: 2, give: 0, sound: 'container', castors: true, spill: 'rubbish', spills: 1 };
// A glass bell full of bottles: heavy, sitting loose on the pavement.
const BELL: Make = { mass: 250, tough: 2.5, give: 0, sound: 'bottles', spill: 'bottles', spills: 3 };
const MAKES: Record<number, Make> = {
  [KIND.bin]: { mass: 25, tough: 2.5, give: 0.05, sound: 'bin', spill: 'rubbish', spills: 2 },
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
  spilled: number; // times it has spilled
  from: [number, number]; // where it stood (game metres)
}

export interface LooseWorld {
  ground: (x: number, y: number, level: number) => number; // game (x, y)
  grid: (x: number, y: number) => Grid | undefined; // the collision grid of the tile there
}

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
        if (vn > p.make.tough) impact = Math.max(impact, this.loosen(car, p, n, vn));
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
  private touchBox(car: Car, c: number, s: number, L: number, W: number, p: Standing): [number, number] | null {
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

  // A standing piece hit `vn` m/s along `n`: its cells freed, made a body, thrown.
  private loosen(car: Car, p: Standing, n: [number, number], vn: number) {
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
      tile: p.tile, make, mesh: p.mesh, index: p.index, level: car.level ?? 0,
      p: pos, v: new THREE.Vector3(), q, w: new THREE.Vector3(),
      half: half.clone(), offset: mid.clone(),
      invMass: 1 / m, invI: new THREE.Vector3(12 / (m * (b * b + cc * cc)), 12 / (m * (a * a + cc * cc)), 12 / (m * (a * a + b * b))),
      radius: Math.max(0.3, Math.min(half.x, half.z) * 0.6 + Math.max(half.x, half.z) * 0.4),
      awake: true, still: 0, heard: this.clock, spilled: 0, from: [p.x, p.y],
    };
    this.bodies.push(body);
    this.knocks++;
    // The car's share: the fixings' give, and the blow by momentum.
    const M = car.spec.mass, j = (1 + 0.15) * vn / (1 / M + 1 / m);
    const groundZ = p.spot.z;
    // Struck at bumper height on the side facing the car, so a tall piece goes over.
    rr.set(-n[0] * half.x * 0.8, groundZ + 0.45 - pos.y, n[1] * half.z * 0.8);
    const tangent = (-car.vx * n[1] + car.vy * n[0]) * 0.25; // a glancing blow drags it along
    v1.set(n[0] * j + -n[1] * tangent * m, j * 0.08, -(n[1] * j + n[0] * tangent * m));
    push(body, v1, rr);
    // (A bit of a spin, never the same twice.)
    body.w.y += (Math.random() - 0.5) * vn * 0.6;
    const loss = j / M + make.give * vn;
    car.vx -= n[0] * loss;
    car.vy -= n[1] * loss;
    if (make.give) { car.takeImpactDamage(make.give * vn * 0.5); car.knock(p.x, p.y, vn * make.give); }
    this.grow(p.mesh);
    this.cap();
    const heard = vn * Math.min(1, Math.max(0.3, Math.sqrt(m / 300)));
    crash(car, null, heard, make.sound, p.x, p.y, M);
    // A bin hit hard enough empties, a glass bell breaks.
    // (A bin's rubbish mostly comes out where it lands: a little here.)
    if (make.spill && vn > 4) this.spill(body, make.spill === 'bottles' ? 30 + vn * 5 : 4 + vn * 0.5);
    return 0;
  }

  // A car against a loose piece: the piece pushed out of it and given its share of the blow.
  private shove(car: Car, b: Body, c: number, s: number, L: number, W: number) {
    const ground = this.world!.ground(b.p.x, -b.p.z, b.level);
    if (b.p.y - b.half.y * 0.5 > ground + car.spec.H || (car.gz !== undefined && Math.abs(car.gz - ground) > 2.5)) return 0;
    const dx = b.p.x - car.x, dy = -b.p.z - car.y, lx = dx * c + dy * s, ly = -dx * s + dy * c;
    let ex = lx - Math.max(-L, Math.min(L, lx)), ey = ly - Math.max(-W, Math.min(W, ly));
    let d = Math.hypot(ex, ey), pen: number;
    if (d >= b.radius) return 0;
    if (d > 1e-6) { ex /= d; ey /= d; pen = b.radius - d; } else {
      const px = L - Math.abs(lx), py = W - Math.abs(ly);
      if (px < py) { ex = Math.sign(lx) || 1; ey = 0; pen = px + b.radius; } else { ex = 0; ey = Math.sign(ly) || 1; pen = py + b.radius; }
      d = 0;
    }
    const nx = ex * c - ey * s, ny = ex * s + ey * c;
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
    while (this.left >= STEP) {
      this.left -= STEP;
      this.clock += STEP;
      for (const b of this.bodies) if (b.awake) this.step(b);
    }
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

  // Whether a loose piece is stopped at (x, y): by a wall, a tree or a post, but not by
  // furniture still standing (it passes through that; knocking it on is for later).
  private solid(x: number, y: number) {
    const grid = this.world!.grid(x, y);
    if (!grid) return true;
    const i = grid.indexAt(x, y);
    return i < 0 || (grid.cells[i] === 255 && !this.shared.get(grid)?.has(i));
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
  standingNear(x: number, y: number, r: number) {
    return this.near(x, y, r).filter((s) => Math.hypot(s.x - x, s.y - y) < r).map((s) => ({ x: s.x, y: s.y, angle: s.angle, kind: s.kind, z: s.spot.z }));
  }
}

export const looseFurniture = new LooseFurniture();
