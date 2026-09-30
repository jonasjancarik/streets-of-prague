import * as THREE from 'three';
import type { Car } from './car.ts';
import { send, sendInstances } from './gpu.ts';

// Cars that catch fire and blow up, GTA 2 style. A car that's taken enough knocks
// (crashes, shots, a blast nearby) starts to smoke from under the bonnet; more and it
// catches fire, and a few seconds later it explodes. What's left is a burnt-out wreck
// that smoulders for a while and can't be driven. What the blast does to people, cars
// and you is up to the game (`onBlast`); this keeps track of the fires and draws them.

export const SMOKING = 50; // damage at which a car starts to smoke
export const BURNING = 90; // and catches fire (the police give up a car at the same point)
const FUSE = [4, 6]; // seconds from catching fire to the explosion
// A car nobody is driving burns this long, enough for a fire engine to get there.
const LONG_FUSE = [45, 75];
const LONG_RATE = 0.55; // those fires smoke and flame less thickly, so a few in view stay within the puffs' caps
// Seconds of water (from one hose) it takes to put out a burning car; a wreck needs the same to stop smouldering.
export const DOUSE = 2.5;
const SMOULDER = 25; // seconds a wreck gives off smoke, flames for the first half

interface Blaze { fuse: number; t: number; emit: number; flame: number; wet: number; steam: number; rate: number }
interface Puff { x: number; y: number; z: number; vx: number; vy: number; vz: number; r0: number; r1: number; age: number; life: number; rgb: [number, number, number]; a: number }

const VERT = /* glsl */ `
  attribute vec4 tint;
  varying vec2 vUv;
  varying vec4 vTint;
  void main() {
    vUv = uv;
    vTint = tint;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }`;
const FRAG = /* glsl */ `
  uniform bool glow;
  varying vec2 vUv;
  varying vec4 vTint;
  void main() {
    float a = smoothstep(1.0, 0.15, length(vUv * 2.0 - 1.0)) * vTint.a;
    if (a < 0.004) discard;
    gl_FragColor = glow ? vec4(vTint.rgb * a, 1.0) : vec4(vTint.rgb, a);
  }`;

// The WebGPU trial's own version of the puffs' material (webgpu/glows.ts), set before the fires are made.
let puffBy: ((glow: boolean) => THREE.Material) | null = null;
export const setPuffShade = (f: typeof puffBy) => { puffBy = f; };

// Soft round puffs lying flat (the view looks down on them), each with its own colour
// and fade: smoke drawn over the scene, flames and flashes added to it.
class Puffs {
  mesh: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.Material>;
  tint: THREE.InstancedBufferAttribute;
  list: Puff[] = [];
  cap: number;
  dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene, cap: number, glow: boolean) {
    this.cap = cap;
    const g = new THREE.PlaneGeometry(2, 2);
    g.rotateX(-Math.PI / 2);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    g.setAttribute('tint', this.tint);
    const m = puffBy ? puffBy(glow) : new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: { glow: { value: glow } },
      transparent: true, depthWrite: false, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(g, m, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = glow ? 3 : 2;
    scene.add(this.mesh);
  }

  add(p: Omit<Puff, 'age'>) {
    if (this.list.length >= this.cap) this.list.shift();
    this.list.push({ ...p, age: 0 });
  }

  update(dt: number) {
    const d = this.dummy, t = this.tint.array as Float32Array;
    let n = 0;
    for (const p of this.list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const k = p.age / p.life;
      d.position.set(p.x, p.z, -p.y);
      d.scale.setScalar(p.r0 + (p.r1 - p.r0) * Math.sqrt(k));
      d.updateMatrix();
      this.mesh.setMatrixAt(n, d.matrix);
      // In quickly, out slowly.
      const a = p.a * Math.min(1, p.age / Math.min(0.12, p.life * 0.2)) * (1 - k);
      t.set([p.rgb[0], p.rgb[1], p.rgb[2], a], n * 4);
      n++;
    }
    this.list = this.list.filter((p) => p.age < p.life);
    this.mesh.count = n;
    sendInstances(this.mesh);
    send(this.tint, n);
  }
}

export interface FiresOptions {
  scene: THREE.Scene;
  height: (x: number, y: number, c: Car) => number;
  rng: () => number;
  // A car has caught fire.
  onIgnite?: (c: Car) => void;
  // A car has blown up; `blamed` if the player set it going.
  onBlast: (c: Car, blamed: boolean) => void;
}

export class Fires {
  blazes = new Map<Car, Blaze>();
  blamed = new WeakSet<Car>();
  smoke: Puffs; flames: Puffs;
  height: FiresOptions['height']; r: () => number;
  onIgnite: NonNullable<FiresOptions['onIgnite']>; onBlast: FiresOptions['onBlast'];

  constructor({ scene, height, rng, onIgnite = () => {}, onBlast }: FiresOptions) {
    this.smoke = new Puffs(scene, 600, false);
    this.flames = new Puffs(scene, 300, true);
    this.height = height;
    this.r = rng;
    this.onIgnite = onIgnite;
    this.onBlast = onBlast;
  }

  // The player damaged this car: if it blows up, it's on you.
  blame(c: Car) { this.blamed.add(c); }

  // Start keeping an eye on a car once it's damaged enough to smoke. (Pedal bikes
  // don't burn.)
  check(c: Car) {
    if (c.burnt || c.two === 'bike' || c.damage < SMOKING || this.blazes.has(c)) return;
    this.blazes.set(c, { fuse: -1, t: 0, emit: 0, flame: 0, wet: 0, steam: 0, rate: 1 });
  }

  // `cars`: those that may have taken damage this step. `view`: where the camera looks,
  // so fires far out of sight aren't drawn (they still burn and blow up).
  update(dt: number, cars: Iterable<Car>, view: { x: number; y: number; r: number }) {
    for (const c of cars) this.check(c);
    for (const [c, b] of this.blazes) {
      const d = Math.hypot(c.x - view.x, c.y - view.y), seen = d < view.r;
      if (d > 700) { this.blazes.delete(c); continue; }
      b.t += dt;
      if (c.burnt) {
        if (b.t > SMOULDER) { this.blazes.delete(c); continue; }
        if (seen) this.emit(c, b, dt, b.t < SMOULDER / 2 ? 0.5 : 0, 1 - b.t / SMOULDER);
        if (seen && b.steam > 0) this.steam(c, b, dt);
        b.steam = Math.max(0, b.steam - dt);
        continue;
      }
      if (c.damage >= BURNING) {
        if (b.fuse < 0) {
          // Your own car (or a police car after you) is the quick one; any other has time.
          const [lo, hi] = c.driven ? FUSE : LONG_FUSE;
          b.fuse = lo + this.r() * (hi - lo);
          b.rate = c.driven ? 1 : LONG_RATE;
          this.onIgnite(c);
        }
        b.fuse -= dt;
        if (b.fuse <= 0) { this.explode(c, seen); b.t = 0; continue; }
        if (seen) this.emit(c, b, dt, 1 - b.wet / DOUSE, 1);
      } else if (seen) this.emit(c, b, dt, 0, (c.damage - SMOKING) / (BURNING - SMOKING));
      if (seen && b.steam > 0 && !c.burnt) this.steam(c, b, dt);
      b.steam = Math.max(0, b.steam - dt);
    }
    this.smoke.update(dt);
    this.flames.update(dt);
  }

  // Whether `c` is on fire right now: burning and waiting to explode, or a wreck still in flames.
  onFire(c: Car) {
    const b = this.blazes.get(c);
    if (!b) return false;
    return c.burnt ? b.t < SMOULDER / 2 && b.wet < DOUSE / 2 : b.fuse >= 0;
  }

  // Water on a car, `amount` seconds' worth from one hose. Enough of it brings a burning
  // car back under the point where it catches fire: it only smokes, steaming for a few
  // seconds, and won't explode. A wreck in flames loses them, and stops smouldering.
  douse(c: Car, amount: number) {
    const b = this.blazes.get(c);
    if (!b) return;
    b.wet += amount;
    b.steam = Math.max(b.steam, 3);
    if (c.burnt) {
      if (b.wet >= DOUSE / 2) b.t = Math.max(b.t, SMOULDER / 2);
      if (b.wet >= DOUSE) b.t = SMOULDER;
    } else if (b.fuse >= 0 && b.wet >= DOUSE) {
      c.damage = Math.min(c.damage, BURNING - 1);
      b.fuse = -1;
      b.wet = 0;
      b.rate = 1;
      b.steam = 6;
    }
  }

  // White steam where the water hits.
  steam(c: Car, b: Blaze, dt: number) {
    const S = c.spec, r = this.r, fx = Math.cos(c.h), fy = Math.sin(c.h), z = this.height(c.x, c.y, c) + S.H * 0.8;
    b.emit += dt * 10;
    for (; b.emit >= 1; b.emit--) {
      this.smoke.add({ x: c.x + fx * S.L * 0.2 + (r() - 0.5) * S.W, y: c.y + fy * S.L * 0.2 + (r() - 0.5) * S.W, z, vx: (r() - 0.5) * 0.8 + 0.6, vy: (r() - 0.5) * 0.8 + 0.4, vz: 1.6 + r(),
        r0: 0.5, r1: 1.6 + r(), life: 1.4 + r(), rgb: [0.92, 0.94, 0.96], a: 0.5 });
    }
  }

  // Smoke (and flames, `fire` 0–1) from under the bonnet; `thick` 0–1.
  emit(c: Car, b: Blaze, dt: number, fire: number, thick: number) {
    const S = c.spec, fx = Math.cos(c.h), fy = Math.sin(c.h), r = this.r;
    const x = c.x + fx * S.L * 0.3, y = c.y + fy * S.L * 0.3, z = this.height(c.x, c.y, c) + S.H * 0.75;
    // (Smoke drifts off a little to the north-east, as if on a light breeze.)
    b.emit += dt * (4 + 6 * thick + 4 * fire) * b.rate;
    for (; b.emit >= 1; b.emit--) {
      const grey = fire > 0 ? 0.1 + r() * 0.08 : 0.6 - thick * 0.35 + r() * 0.1;
      this.smoke.add({ x: x + (r() - 0.5) * 0.6, y: y + (r() - 0.5) * 0.6, z, vx: (r() - 0.5) * 0.8 + 0.8, vy: (r() - 0.5) * 0.8 + 0.6, vz: 2.5 + r(),
        r0: 0.5, r1: 1.8 + thick * 1.5 + fire * 1.5, life: 2 + r() * 1.2 + fire, rgb: [grey, grey * 0.97, grey * 0.95], a: 0.45 + 0.35 * Math.max(thick, fire) });
    }
    b.flame += dt * 30 * fire * b.rate;
    for (; b.flame >= 1; b.flame--) {
      this.flames.add({ x: x + (r() - 0.5) * S.W * 0.7, y: y + (r() - 0.5) * S.W * 0.7, z: z + 0.1, vx: 0.3, vy: 0.2, vz: 1.5,
        r0: 0.5 + r() * 0.4, r1: 1 + r() * 0.6, life: 0.35 + r() * 0.3, rgb: [1.3, 0.5 + r() * 0.25, 0.1], a: 0.85 });
    }
  }

  explode(c: Car, seen: boolean) {
    c.burn();
    c.rider = null;
    c.w += (this.r() - 0.5) * 3;
    const blamed = this.blamed.has(c);
    this.onBlast(c, blamed);
    if (!seen) return;
    const r = this.r, z = this.height(c.x, c.y, c) + 0.6;
    const at = (spread: number) => [c.x + (r() - 0.5) * spread, c.y + (r() - 0.5) * spread] as const;
    // The flash, and its glow on the ground round about.
    this.flames.add({ x: c.x, y: c.y, z: z + 1, vx: 0, vy: 0, vz: 0, r0: 2, r1: 7, life: 0.3, rgb: [1.6, 1.4, 1], a: 1 });
    this.flames.add({ x: c.x, y: c.y, z: z - 0.5, vx: 0, vy: 0, vz: 0, r0: 10, r1: 13, life: 0.7, rgb: [1, 0.45, 0.1], a: 0.5 });
    // A fireball of flames boiling up and out.
    for (let i = 0; i < 14; i++) {
      const [x, y] = at(3), a = r() * Math.PI * 2, v = 2 + r() * 4;
      this.flames.add({ x, y, z: z + r(), vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 3 + r() * 3,
        r0: 1 + r(), r1: 2.5 + r() * 2, life: 0.5 + r() * 0.5, rgb: [1.4, 0.5 + r() * 0.3, 0.1], a: 0.9 });
    }
    // Then a cloud of black smoke.
    for (let i = 0; i < 16; i++) {
      const [x, y] = at(4), a = r() * Math.PI * 2, v = 1 + r() * 2.5;
      this.smoke.add({ x, y, z: z + 1 + r() * 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: 3 + r() * 2,
        r0: 1.5, r1: 4 + r() * 3, life: 3 + r() * 2.5, rgb: [0.08, 0.075, 0.07], a: 0.75 });
    }
    // And a scorch mark on the ground under the wreck.
    this.smoke.add({ x: c.x, y: c.y, z: z - 0.55, vx: 0, vy: 0, vz: 0, r0: 3.4, r1: 3.6, life: 60, rgb: [0.03, 0.03, 0.03], a: 0.7 });
  }

  // Dev teleport and the like: nothing burning is left behind.
  reset() {
    this.blazes.clear();
  }
}
