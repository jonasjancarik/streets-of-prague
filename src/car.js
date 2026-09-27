import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from './network.js';

// Arcade top-down car handling: grip on the long axis, lateral slip that decays
// (much slower with the handbrake), bounces off walls against the collision grid.

export const TYPES = {
  hatch: { L: 3.9, W: 1.75, H: 1.45, mass: 1100, accel: 9, vmax: 36, grip: 9, turn: 2.6, cabin: [-1.15, 0.85], weight: 4 },
  sedan: { L: 4.6, W: 1.82, H: 1.45, mass: 1450, accel: 10, vmax: 42, grip: 8.5, turn: 2.4, cabin: [-1.25, 0.8], weight: 4 },
  estate: { L: 4.7, W: 1.82, H: 1.5, mass: 1500, accel: 9, vmax: 40, grip: 8.5, turn: 2.3, cabin: [-1.95, 0.8], weight: 2 },
  van: { L: 5.2, W: 2.0, H: 2.3, mass: 2200, accel: 6.5, vmax: 31, grip: 8, turn: 1.9, cabin: [-2.5, 1.6], weight: 1 },
  taxi: { L: 4.6, W: 1.82, H: 1.45, mass: 1450, accel: 10, vmax: 42, grip: 8.5, turn: 2.4, cabin: [-1.25, 0.8], weight: 1, color: '#e9c62f' },
  // Never parked or in ordinary traffic: src/police.js puts these on the streets.
  police: { L: 4.7, W: 1.84, H: 1.5, mass: 1500, accel: 11, vmax: 44, grip: 9, turn: 2.5, cabin: [-1.3, 0.8], weight: 0, color: '#eef1f4' },
};
const PAINT = ['#e8e6e1', '#bfc3c7', '#8d9398', '#2c2f33', '#1d2a44', '#7a1f1f', '#b33a2c', '#2f5140', '#5b6d7c', '#d9d2c0', '#3f4a5a', '#9a7b4f'];

const cache = new Map();
function carGeometry(type, paint) {
  const k = `${type}|${paint}`;
  if (cache.has(k)) return cache.get(k);
  const S = TYPES[type];
  const parts = [];
  const box = (sx, sy, sz, x, y, z, color) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  const { L, W, H } = S;
  const body = S.color || paint;
  const glass = '#1b232b';
  const [c0, c1] = S.cabin;
  const bodyH = type === 'van' ? H * 0.55 : H * 0.5;
  box(L, bodyH, W, 0, 0.25 + bodyH / 2, 0, body);
  box(c1 - c0, H - bodyH - 0.3, W * 0.86, (c0 + c1) / 2, 0.25 + bodyH + (H - bodyH - 0.3) / 2, 0, glass);
  // Roof panel: shorter than the cabin, so the windscreen and rear window show from above.
  box(c1 - c0 - (type === 'van' ? 0.35 : 0.75), 0.08, W * 0.84, (c0 + c1) / 2 - (type === 'van' ? 0.15 : 0.1), H - 0.01, 0, body);
  box(0.06, 0.18, 0.34, L / 2 + 0.01, 0.62, W * 0.33, '#fff6d8');
  box(0.06, 0.18, 0.34, L / 2 + 0.01, 0.62, -W * 0.33, '#fff6d8');
  box(0.06, 0.16, 0.3, -L / 2 - 0.01, 0.66, W * 0.35, '#b3161b');
  box(0.06, 0.16, 0.3, -L / 2 - 0.01, 0.66, -W * 0.35, '#b3161b');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.66, 0.6, 0.24, sx * (L / 2 - 0.85), 0.3, sz * (W / 2 - 0.1), '#161616');
  if (type === 'taxi') box(0.28, 0.2, 0.7, (c0 + c1) / 2, H + 0.1, 0, '#fff4c2');
  if (type === 'police') {
    // Blue and yellow bands down the sides, a blue band across the bonnet, the light bar.
    box(L * 0.96, 0.16, W + 0.02, 0, 0.25 + bodyH * 0.5, 0, '#1d4fa3');
    box(L * 0.96, 0.07, W + 0.03, 0, 0.25 + bodyH * 0.5 + 0.115, 0, '#d4e02b');
    box(0.5, 0.02, W * 0.92, (c1 + L / 2) / 2, 0.25 + bodyH + 0.01, 0, '#1d4fa3');
    box(0.3, 0.12, W * 0.74, (c0 + c1) / 2, H + 0.06, 0, '#1b1f2a');
  }
  const g = mergeGeometries(parts);
  cache.set(k, g);
  return g;
}

const material = new THREE.MeshLambertMaterial({ vertexColors: true });

export function randomType(r) {
  const total = Object.values(TYPES).reduce((a, t) => a + t.weight, 0);
  let x = r() * total;
  for (const [k, t] of Object.entries(TYPES)) if ((x -= t.weight) < 0) return k;
  return 'sedan';
}

export class Car {
  constructor(type, r, x = 0, y = 0, h = 0) {
    this.type = type;
    this.spec = TYPES[type];
    this.mass = this.spec.mass;
    this.key = `${type}|${PAINT[Math.floor(r() * PAINT.length)]}`;
    carGeometry(...this.key.split('|'));
    this.x = x;
    this.y = y;
    this.h = h;
    this.vx = this.vy = this.w = 0;
    this.mode = 'loose'; // 'traffic' (driven by AI), 'loose' (free body), 'player', 'police' (chasing you)
    this.damage = 0;
    const { L, W } = this.spec;
    this.r = W / 2 + 0.02;
    this.offsets = [-(L / 2 - this.r), 0, L / 2 - this.r];
    this.samples = [];
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1], [0.5, 1], [0.5, -1], [-0.5, 1], [-0.5, -1]]) {
      this.samples.push([(a * L) / 2, (b * W) / 2]);
    }
    this.sync();
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  // Someone at the wheel: the player, or the police chasing them.
  get driven() { return this.mode === 'player' || this.mode === 'police'; }
  get forwardSpeed() { return this.vx * Math.cos(this.h) + this.vy * Math.sin(this.h); }

  circles() {
    const c = Math.cos(this.h), s = Math.sin(this.h);
    return this.offsets.map((o) => [this.x + c * o, this.y + s * o]);
  }

  // Free-body physics. `ctl` = { throttle -1..1, steer -1..1 (left +), handbrake }.
  update(dt, ctl, grid) {
    const S = this.spec;
    ctl = ctl || { throttle: 0, steer: 0, handbrake: false };
    const fx = Math.cos(this.h), fy = Math.sin(this.h);
    let vf = this.vx * fx + this.vy * fy;
    let vl = this.vx * fy - this.vy * fx;
    const fast = clamp(Math.abs(vf) / S.vmax, 0, 1);

    if (ctl.throttle > 0) {
      if (vf < -0.3) vf = Math.min(0, vf + 16 * dt);
      else vf += S.accel * ctl.throttle * (1 - fast * fast) * dt;
    } else if (ctl.throttle < 0) {
      if (vf > 0.3) vf = Math.max(0, vf - 16 * dt);
      else vf = Math.max(-S.vmax * 0.3, vf - S.accel * 0.6 * dt);
    } else {
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), (this.driven ? 0.6 : 5) * dt);
    }
    if (ctl.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);
    // Hills: gravity along the car's heading (rolls back down, slower uphill).
    if (grid.height) {
      const half = S.L / 2;
      const slope = (grid.height(this.x + fx * half, this.y + fy * half) - grid.height(this.x - fx * half, this.y - fy * half)) / S.L;
      vf -= 9.81 * slope * dt;
    }

    const grip = ctl.handbrake ? 1.1 : S.grip * (1 - 0.45 * fast);
    vl *= Math.exp(-grip * dt);

    const sgn = vf >= 0 ? 1 : -1;
    const maxW = S.turn * (1 - 0.35 * fast) * (ctl.handbrake ? 1.35 : 1);
    const wantW = ctl.steer * Math.min(Math.abs(vf) / 3.6, maxW) * sgn;
    if (this.driven) this.w += (wantW - this.w) * Math.min(1, dt * 9);
    else this.w *= Math.exp(-4 * dt);
    this.h += this.w * dt;

    const nx = Math.cos(this.h), ny = Math.sin(this.h);
    this.vx = nx * vf + ny * vl;
    this.vy = ny * vf - nx * vl;

    // Substeps so a fast car can't skip through a thin wall.
    const steps = Math.max(1, Math.ceil((this.speed * dt) / 0.25));
    let impact = 0;
    for (let i = 0; i < steps; i++) {
      this.x += (this.vx * dt) / steps;
      this.y += (this.vy * dt) / steps;
      impact = Math.max(impact, this.collideGrid(grid));
    }
    this.sync();
    return impact;
  }

  worldSamples() {
    const c = Math.cos(this.h), s = Math.sin(this.h);
    return this.samples.map(([a, b]) => [this.x + c * a - s * b, this.y + s * a + c * b]);
  }

  collideGrid(grid) {
    const solid = (x, y) => (grid.at(x, y) ? 1 : 0);
    let nx = 0, ny = 0, hits = 0, cx = 0, cy = 0;
    for (const [x, y] of this.worldSamples()) {
      if (!solid(x, y)) continue;
      const d = 0.7;
      nx += solid(x - d, y) - solid(x + d, y);
      ny += solid(x, y - d) - solid(x, y + d);
      cx += x;
      cy += y;
      hits++;
    }
    if (!hits) return 0;
    let len = Math.hypot(nx, ny);
    if (len < 1e-6) { nx = -this.vx; ny = -this.vy; len = Math.hypot(nx, ny) || 1; }
    nx /= len;
    ny /= len;
    for (let k = 0; k < 30; k++) {
      this.x += nx * 0.06;
      this.y += ny * 0.06;
      if (!this.worldSamples().some(([x, y]) => solid(x, y))) break;
    }
    const vn = this.vx * nx + this.vy * ny;
    if (vn >= 0) return 0;
    this.vx -= 1.3 * vn * nx;
    this.vy -= 1.3 * vn * ny;
    this.vx *= 0.92;
    this.vy *= 0.92;
    // Off-centre hits make the car spin.
    const rx = cx / hits - this.x, ry = cy / hits - this.y;
    this.w += (rx * ny - ry * nx) * vn * 0.09;
    this.damage += Math.max(0, -vn - 3);
    return -vn;
  }

  sync() {} // drawn by CarPool each frame
}

// Every car is an instance: one draw call per type and colour, however many are parked.
export class CarPool {
  constructor(scene) {
    this.scene = scene;
    this.meshes = new Map();
    this.groups = new Map();
    this.dummy = new THREE.Object3D();
  }

  // `height(x, y)`: terrain height; cars sit on it, pitched and rolled to the slope.
  render(cars, height = null) {
    for (const list of this.groups.values()) list.length = 0;
    for (const c of cars) {
      if (!this.groups.has(c.key)) this.groups.set(c.key, []);
      this.groups.get(c.key).push(c);
    }
    const d = this.dummy;
    for (const [k, list] of this.groups) {
      let m = this.meshes.get(k);
      if (!m || m.instanceMatrix.count < list.length) {
        if (m) { this.scene.remove(m); m.dispose(); }
        m = new THREE.InstancedMesh(cache.get(k), material, Math.max(8, Math.ceil(list.length * 1.5)));
        m.castShadow = true;
        m.frustumCulled = false;
        this.scene.add(m);
        this.meshes.set(k, m);
      }
      list.forEach((c, i) => {
        if (height) {
          const fx = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
          const hf = height(c.x + fx * L, c.y + fy * L), hb = height(c.x - fx * L, c.y - fy * L);
          const hl = height(c.x - fy * W, c.y + fx * W), hr = height(c.x + fy * W, c.y - fx * W);
          d.position.set(c.x, (hf + hb + hl + hr) / 4, -c.y);
          d.rotation.set(Math.atan2(hl - hr, 2 * W), c.h, Math.atan2(hf - hb, 2 * L), 'YZX');
        } else {
          d.position.set(c.x, 0, -c.y);
          d.rotation.set(0, c.h, 0);
        }
        d.updateMatrix();
        m.setMatrixAt(i, d.matrix);
      });
      m.count = list.length;
      m.instanceMatrix.needsUpdate = true;
    }
  }
}

// Circle-based collision between two bodies. `ia`/`ib` are inverse masses (0 = immovable).
// Returns the closing speed at contact, or 0 if they don't touch.
export function collideBodies(a, ca, ra, ia, b, cb, rb, ib, restitution = 0.25) {
  let best = null;
  for (const p of ca) {
    for (const q of cb) {
      const dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy);
      const pen = ra + rb - d;
      if (pen > 0 && (!best || pen > best.pen)) best = { pen, nx: dx / (d || 1), ny: dy / (d || 1), px: (p[0] + q[0]) / 2, py: (p[1] + q[1]) / 2 };
    }
  }
  if (!best || ia + ib === 0) return best ? 0.001 : 0;
  const { pen, nx, ny } = best;
  const sa = ia / (ia + ib), sb = ib / (ia + ib);
  a.x -= nx * pen * sa;
  a.y -= ny * pen * sa;
  b.x += nx * pen * sb;
  b.y += ny * pen * sb;
  const vrel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vrel >= 0) return 0.001;
  const j = (-(1 + restitution) * vrel) / (ia + ib);
  a.vx -= j * ia * nx;
  a.vy -= j * ia * ny;
  b.vx += j * ib * nx;
  b.vy += j * ib * ny;
  for (const [body, inv, sign] of [[a, ia, -1], [b, ib, 1]]) {
    if (!inv || body.w === undefined) continue;
    const rx = best.px - body.x, ry = best.py - body.y;
    body.w += (rx * ny - ry * nx) * sign * j * inv * 0.25;
  }
  return -vrel;
}
