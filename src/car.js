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
    this.mesh = new THREE.Mesh(carGeometry(type, PAINT[Math.floor(r() * PAINT.length)]), material);
    this.mesh.castShadow = true;
    this.x = x;
    this.y = y;
    this.h = h;
    this.vx = this.vy = this.w = 0;
    this.mode = 'loose'; // 'traffic' (driven by AI), 'loose' (free body), 'player'
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
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), (this.mode === 'player' ? 1.8 : 5) * dt);
    }
    if (ctl.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);

    const grip = ctl.handbrake ? 1.1 : S.grip * (1 - 0.45 * fast);
    vl *= Math.exp(-grip * dt);

    const sgn = vf >= 0 ? 1 : -1;
    const maxW = S.turn * (1 - 0.35 * fast) * (ctl.handbrake ? 1.35 : 1);
    const wantW = ctl.steer * Math.min(Math.abs(vf) / 3.6, maxW) * sgn;
    if (this.mode === 'player') this.w += (wantW - this.w) * Math.min(1, dt * 9);
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

  sync() {
    this.mesh.position.set(this.x, 0, -this.y);
    this.mesh.rotation.y = this.h;
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
