import * as THREE from 'three';
import { clamp } from './network.js';
import { turnOf } from './assist.js';

// Police helicopters. From three stars up one joins the chase (two at five): it flies
// straight over the rooftops, keeps a searchlight on you and sees you wherever you
// are within about 160 m, buildings or not. It tops out at about 95 km/h, so the only
// way to lose it is to drive faster than that for long enough. When the stars drop
// below three it flies off.

const ALT = 55; // m above the ground
const TOP = 26; // m/s
const ACCEL = 7;
export const HELI_SIGHT = 160;

const POLICE = { body: '#eef1f4', band: '#1d4fa3', stripe: '#d4e02b' };

function model(paint = POLICE) {
  const g = new THREE.Group();
  const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
  const add = (geo, color, [x, y, z], parent = g, extra) => {
    const m = new THREE.Mesh(geo, mat(color, extra));
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const ball = (sx, sy, sz) => new THREE.SphereGeometry(1, 18, 12).scale(sx, sy, sz);
  const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
  // Local +x is the nose, +y up; the car models use the same axes.
  add(ball(2.4, 1.15, 1.1), paint.body, [0.3, 1.5, 0]);
  add(ball(1.3, 0.8, 0.95), '#1b232b', [1.45, 1.8, 0]);
  add(box(4.1, 0.34, 2.22), paint.band, [0.2, 1.3, 0]);
  add(box(3.9, 0.12, 2.24), paint.stripe, [0.2, 1.54, 0]);
  add(box(5.2, 0.42, 0.42), paint.body, [-3.8, 1.8, 0]);
  add(box(1.0, 1.5, 0.12), paint.band, [-6.2, 2.45, 0]);
  add(box(0.3, 0.08, 1.8), paint.band, [-5.9, 1.85, 0]);
  for (const z of [-1, 1]) {
    add(box(4.0, 0.1, 0.12), '#2a2d31', [0.3, 0.05, z]);
    for (const x of [-0.6, 1.2]) add(box(0.1, 0.6, 0.1), '#2a2d31', [x, 0.35, z * 0.95]);
  }
  add(new THREE.CylinderGeometry(0.16, 0.2, 0.6, 10), '#2a2d31', [0.2, 2.65, 0]);
  add(box(0.3, 0.25, 0.3), '#fff6d8', [1.8, 0.75, 0]); // searchlight
  const rotor = new THREE.Group();
  rotor.position.set(0.2, 2.98, 0);
  g.add(rotor);
  add(box(11.2, 0.05, 0.3), '#2a2d31', [0, 0, 0], rotor);
  add(box(0.3, 0.05, 11.2), '#2a2d31', [0, 0, 0], rotor);
  // A faint disc where the blades blur.
  const blur = new THREE.Mesh(new THREE.CircleGeometry(5.6, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#1a1c20', transparent: true, opacity: 0.16, depthWrite: false }));
  blur.position.set(0.2, 2.96, 0);
  g.add(blur);
  const tail = new THREE.Group();
  tail.position.set(-6.25, 2.45, 0.2);
  g.add(tail);
  add(box(0.1, 1.9, 0.06), '#2a2d31', [0, 0, 0], tail);
  return { g, rotor, tail };
}

export class Helicopters {
  constructor(scene, height) {
    this.scene = scene;
    this.height = height;
    this.list = [];
    const spot = new THREE.CircleGeometry(4, 28).rotateX(-Math.PI / 2);
    this.spot = new THREE.Mesh(spot, new THREE.MeshBasicMaterial({ color: '#fff1c4', transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.spot.visible = false;
    scene.add(this.spot);
    this.spots = [this.spot];
  }

  // A new helicopter `d` metres from (x, y), flying in.
  spawn(x, y, d = 260) {
    const a = Math.random() * Math.PI * 2;
    const hx = x + Math.cos(a) * d, hy = y + Math.sin(a) * d;
    const { g, rotor, tail } = model();
    this.scene.add(g);
    const h = { x: hx, y: hy, z: this.height(hx, hy) + ALT, vx: 0, vy: 0, h: a + Math.PI, w: 0, g, rotor, tail, leaving: false, orbit: Math.random() * 6, air: true };
    this.list.push(h);
    return h;
  }

  // The ones that are watching you (not flying off).
  get watching() { return this.list.filter((h) => !h.leaving); }

  reset() {
    for (const h of this.list) this.scene.remove(h.g);
    this.list = [];
  }

  // `want`: how many should be over you; `me`: the player { x, y, vx, vy }.
  update(dt, me, want) {
    let on = this.watching;
    if (on.length < want && !on.some((h) => Math.hypot(h.x - me.x, h.y - me.y) > 200)) this.spawn(me.x, me.y);
    on = this.watching;
    for (const h of on.slice(want)) h.leaving = true;

    for (const h of this.list) {
      // Keep over you, a little ahead when you move; circle when you stand still.
      h.orbit += dt * 0.35;
      const slow = clamp(1 - Math.hypot(me.vx, me.vy) / 8, 0, 1);
      let tx = me.x + me.vx * 1.2 + Math.cos(h.orbit) * 18 * slow;
      let ty = me.y + me.vy * 1.2 + Math.sin(h.orbit) * 18 * slow;
      if (h.leaving) {
        const dx = h.x - me.x, dy = h.y - me.y, d = Math.hypot(dx, dy) || 1;
        tx = h.x + (dx / d) * 500;
        ty = h.y + (dy / d) * 500;
        if (d > 600) h.gone = true;
      }
      let dvx = (tx - h.x) * 0.8, dvy = (ty - h.y) * 0.8;
      const dv = Math.hypot(dvx, dvy);
      if (dv > TOP) { dvx *= TOP / dv; dvy *= TOP / dv; }
      const ax = dvx - h.vx, ay = dvy - h.vy, a = Math.hypot(ax, ay), k = Math.min(1, (ACCEL * dt) / (a || 1));
      h.vx += ax * k;
      h.vy += ay * k;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      const sp = Math.hypot(h.vx, h.vy);
      // Nose into the flight; towards you while hovering.
      const face = sp > 4 ? Math.atan2(h.vy, h.vx) : Math.atan2(me.y - h.y, me.x - h.x);
      const turn = clamp(turnOf(h.h, face), -1.2 * dt, 1.2 * dt);
      h.h += turn;
      h.w += (turn / Math.max(dt, 1e-4) - h.w) * Math.min(1, dt * 3);
      h.z += (this.height(h.x, h.y) + ALT - h.z) * Math.min(1, dt * 0.8);
      h.pitch = -0.22 * clamp((h.vx * Math.cos(h.h) + h.vy * Math.sin(h.h)) / TOP, -1, 1);
      h.roll = clamp(-h.w * sp * 0.04, -0.3, 0.3);
    }
    for (const h of this.list) if (h.gone) this.scene.remove(h.g);
    this.list = this.list.filter((h) => !h.gone);
    this.me = me;
  }

  render(time, dt = 1 / 60) {
    let n = 0;
    for (const h of this.list) {
      h.g.position.set(h.x, h.z, -h.y);
      h.g.rotation.set(h.roll || 0, h.h, h.pitch || 0, 'YZX');
      h.rotor.rotation.y += dt * 38;
      h.tail.rotation.z += dt * 60;
      if (h.leaving || !this.me) continue;
      // The searchlight follows you, wobbling a little.
      if (n >= this.spots.length) {
        const s = this.spot.clone();
        this.scene.add(s);
        this.spots.push(s);
      }
      const s = this.spots[n++];
      const x = this.me.x + Math.sin(time * 1.3 + h.orbit) * 1.5, y = this.me.y + Math.cos(time * 1.7 + h.orbit) * 1.5;
      s.position.set(x, this.height(x, y) + 0.15, -y);
      s.visible = Math.hypot(h.x - this.me.x, h.y - this.me.y) < HELI_SIGHT;
    }
    for (let i = n; i < this.spots.length; i++) this.spots[i].visible = false;
  }
}

// A helicopter you fly yourself (the developer tools put one next to you). W and S
// fly forwards and back, A and D turn, Space climbs and Shift comes down; let go and
// it holds its height. Below the rooftops the buildings are in the way, so either fly
// along the streets or climb over them. You can only get out once it has landed on
// open ground.

const ROOFS = 30; // m above the ground: higher than that, the buildings don't matter
const FLY = { top: 42, accel: 14, yaw: 1.7, climb: 9 };

export class Chopper {
  constructor(scene, grid, height, x, y, h) {
    Object.assign(this, { grid, height, x, y, h, vx: 0, vy: 0, vz: 0, w: 0, spin: 0 });
    this.z = height(x, y);
    const m = model({ body: '#c8312b', band: '#f2efe8', stripe: '#2a2d31' });
    Object.assign(this, m);
    scene.add(m.g);
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get air() { return this.z - this.height(this.x, this.y); }
  // Rooftop height counts as the floor over buildings.
  solid(x, y) { return this.grid.at(x, y) === 255; }
  floor(x, y) { return this.height(x, y) + (this.solid(x, y) ? ROOFS : 0); }
  get landed() { return this.air < 0.6 && !this.solid(this.x, this.y); }

  // `ctl`: { move -1..1, turn -1..1 (left +), up, down } or null when nobody's flying it.
  update(dt, ctl) {
    const flying = !!ctl;
    this.spin += ((flying ? 1 : 0) - this.spin) * Math.min(1, dt * (flying ? 0.8 : 0.4));
    const lift = this.spin > 0.85; // the rotor needs to be up to speed
    ctl = ctl || { move: 0, turn: 0, up: false, down: false };
    const low = this.air < 0.6;
    const fx = Math.cos(this.h), fy = Math.sin(this.h);
    // Forwards and back along the nose; the air slows everything else down.
    if (lift && !low) {
      this.vx += fx * ctl.move * FLY.accel * dt;
      this.vy += fy * ctl.move * FLY.accel * dt;
      this.w += (ctl.turn * FLY.yaw - this.w) * Math.min(1, dt * 4);
    } else this.w *= Math.exp(-6 * dt);
    const drag = Math.exp(-(ctl.move ? 0.35 : 1.1) * dt);
    this.vx *= drag;
    this.vy *= drag;
    const sp = this.speed;
    if (sp > FLY.top) { this.vx *= FLY.top / sp; this.vy *= FLY.top / sp; }
    if (low) { this.vx *= Math.exp(-8 * dt); this.vy *= Math.exp(-8 * dt); }
    this.h += this.w * dt;
    const wantZ = lift ? (ctl.up ? FLY.climb : ctl.down ? -FLY.climb * 0.8 : 0) : -4;
    this.vz += (wantZ - this.vz) * Math.min(1, dt * 3);

    // Below the rooftops, buildings stop you like walls.
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
    const under = this.z - this.height(nx, ny) < ROOFS;
    const hits = (x, y) => under && [[3, 0], [-3, 0], [0, 3], [0, -3], [0, 0]].some(([a, b]) => this.solid(x + a, y + b));
    if (!hits(nx, this.y)) this.x = nx; else this.vx *= -0.2;
    if (!hits(this.x, ny)) this.y = ny; else this.vy *= -0.2;
    this.z += this.vz * dt;
    const floor = this.floor(this.x, this.y);
    if (this.z < floor) { this.z = floor; this.vz = Math.max(0, this.vz); }
    this.z = Math.min(this.z, this.height(this.x, this.y) + 220);

    const vf = this.vx * fx + this.vy * fy;
    this.pitch = -0.25 * clamp(vf / FLY.top, -1, 1) * (low ? 0 : 1);
    this.roll = clamp(-this.w * this.speed * 0.02, -0.35, 0.35);
  }

  render(dt) {
    this.g.position.set(this.x, this.z, -this.y);
    this.g.rotation.set(this.roll || 0, this.h, this.pitch || 0, 'YZX');
    this.rotor.rotation.y += dt * 38 * this.spin;
    this.tail.rotation.z += dt * 60 * this.spin;
  }

  remove(scene) { scene.remove(this.g); }
}
