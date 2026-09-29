import * as THREE from 'three';

// Gunfire and your health. Only the police have guns so far (src/police.ts decides
// who shoots and whether it hits); this draws the shots and keeps count of what
// they, and cars running you down, have taken out of you.

export type Point3 = [number, number, number]; // x, y on the map, z up

const SHOTS = 24;
const SPEED = 160; // m/s, slowed down enough to be seen
const STREAK = 2.4; // m
const FLASH = 0.06; // seconds the muzzle flash lasts

interface Shot { from: Point3; to: Point3; len: number; age: number }

// Each shot as a bright streak flying from the muzzle to where the bullet went, and a
// flash at the muzzle.
export class Tracers {
  streaks: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  flashes: THREE.InstancedMesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  shots: Shot[] = [];
  dummy = new THREE.Object3D(); color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    plane.translate(-0.5, 0, 0); // the head at the origin, the tail behind it
    const disc = new THREE.CircleGeometry(1, 12);
    disc.rotateX(-Math.PI / 2);
    const mat = () => new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    this.streaks = new THREE.InstancedMesh(plane, mat(), SHOTS);
    this.flashes = new THREE.InstancedMesh(disc, mat(), SHOTS);
    for (const m of [this.streaks, this.flashes]) {
      m.count = 0;
      m.frustumCulled = false;
      m.setColorAt(0, this.color);
      scene.add(m);
    }
  }

  fire(from: Point3, to: Point3) {
    if (this.shots.length >= SHOTS) this.shots.shift();
    this.shots.push({ from, to, len: Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1, age: 0 });
  }

  update(dt: number) {
    const d = this.dummy;
    let n = 0, f = 0;
    for (const s of this.shots) {
      s.age += dt;
      const head = Math.min(s.len, s.age * SPEED), tail = Math.max(0, head - STREAK);
      const k = head / s.len, [x0, y0, z0] = s.from, [x1, y1, z1] = s.to;
      if (tail < s.len) {
        d.position.set(x0 + (x1 - x0) * k, z0 + (z1 - z0) * k, -(y0 + (y1 - y0) * k));
        d.rotation.set(0, Math.atan2(y1 - y0, x1 - x0), 0);
        d.scale.set(head - tail, 1, 0.12);
        d.updateMatrix();
        this.streaks.setMatrixAt(n, d.matrix);
        this.streaks.setColorAt(n, this.color.setRGB(1.6, 1.3, 0.6));
        n++;
      }
      if (s.age < FLASH) {
        const glow = 1 - s.age / FLASH;
        d.position.set(x0, z0, -y0);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(0.25 + 0.35 * glow);
        d.updateMatrix();
        this.flashes.setMatrixAt(f, d.matrix);
        this.flashes.setColorAt(f, this.color.setRGB(2 * glow, 1.6 * glow, 0.7 * glow));
        f++;
      }
    }
    this.shots = this.shots.filter((s) => s.age < FLASH || s.age * SPEED - STREAK < s.len);
    for (const [m, k] of [[this.streaks, n], [this.flashes, f]] as [THREE.InstancedMesh, number][]) {
      m.count = k;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
}

export const MAX_HEALTH = 100;
const HEAL_AFTER = 7; // seconds without being hurt before you start to get better
const HEAL_RATE = 5; // points a second

export class Health {
  value = MAX_HEALTH;
  quiet = 0; // seconds since you were last hurt
  flash = 0; // the red at the edges of the screen, 0–1

  get dead() { return this.value <= 0; }

  // Returns true if this was the blow that killed you.
  hurt(points: number) {
    if (this.dead || points <= 0) return false;
    this.value = Math.max(0, this.value - points);
    this.quiet = 0;
    this.flash = Math.min(1, this.flash + 0.25 + points / 40);
    return this.dead;
  }

  update(dt: number) {
    this.flash = Math.max(0, this.flash - dt * 1.6);
    if (this.dead) return;
    this.quiet += dt;
    if (this.quiet > HEAL_AFTER) this.value = Math.min(MAX_HEALTH, this.value + HEAL_RATE * dt);
  }

  reset() {
    this.value = MAX_HEALTH;
    this.quiet = 0;
    this.flash = 0;
  }
}
