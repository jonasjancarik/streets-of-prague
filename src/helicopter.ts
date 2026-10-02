import * as THREE from 'three';
import { clamp } from './network.ts';
import { turnOf } from './assist.ts';

interface Flyer { x: number; y: number; vx: number; vy: number }
interface Helicopter {
  x: number; y: number; z: number; vx: number; vy: number; h: number; w: number;
  g: THREE.Group; rotor: THREE.Group; tail: THREE.Group;
  leaving: boolean; orbit: number; air: boolean; gone?: boolean; pitch?: number; roll?: number;
}

// Police helicopters. From three stars up one joins the chase (two at five): it flies
// straight over the rooftops, keeps a searchlight on you and sees you wherever you
// are within about 160 m, buildings or not. It tops out at about 95 km/h, so the only
// way to lose it is to drive faster than that for long enough. When the stars drop
// below three it flies off.

const ALT = 55; // m above the ground
const TOP = 26; // m/s
const ACCEL = 7;
const OFFSET = 16; // m to the side of you
export const HELI_SIGHT = 160;

const POLICE = { body: '#eef1f4', band: '#1d4fa3', stripe: '#d4e02b' };

function model(paint = POLICE) {
  const g = new THREE.Group();
  const mat = (color: string, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
  const add = (geo: THREE.BufferGeometry, color: string, [x, y, z]: [number, number, number], parent = g, extra?: THREE.MeshLambertMaterialParameters) => {
    const m = new THREE.Mesh(geo, mat(color, extra));
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const ball = (sx: number, sy: number, sz: number) => new THREE.SphereGeometry(1, 18, 12).scale(sx, sy, sz);
  const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
  // Local +x is the nose, +y up; the car models use the same axes.
  add(ball(2.4, 1.15, 1.1), paint.body, [0.3, 1.5, 0]);
  add(ball(1.3, 0.8, 0.95), '#1b232b', [1.45, 1.8, 0]);
  // The band and stripe wrap the body just outside it, stopping short of the canopy;
  // `from` and `to` are heights on the body, -1 at the bottom and 1 at the top.
  const wrap = (from: number, to: number) => new THREE.SphereGeometry(1, 36, 2, Math.PI + 0.7, Math.PI * 2 - 1.4, Math.acos(to), Math.acos(from) - Math.acos(to)).scale(2.46, 1.18, 1.14);
  add(wrap(-0.32, -0.02), paint.band, [0.3, 1.5, 0]);
  add(wrap(-0.02, 0.09), paint.stripe, [0.3, 1.5, 0]);
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
  scene: THREE.Scene;
  height: (x: number, y: number) => number;
  list: Helicopter[];
  spot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  spots: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>[];
  me: Flyer | null = null;
  // How dark it is (0..1): at night the searchlight is a real light (lamps.ts), by day a faint disc.
  night = 0;
  // Where each searchlight is and what it shines on, for the lamps (x, y, height; target x, y).
  lit: { x: number; y: number; z: number; tx: number; ty: number }[] = [];

  constructor(scene: THREE.Scene, height: (x: number, y: number) => number) {
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
  spawn(x: number, y: number, d = 260) {
    const a = Math.random() * Math.PI * 2;
    const hx = x + Math.cos(a) * d, hy = y + Math.sin(a) * d;
    const { g, rotor, tail } = model();
    this.scene.add(g);
    const h: Helicopter = { x: hx, y: hy, z: this.height(hx, hy) + ALT, vx: 0, vy: 0, h: a + Math.PI, w: 0, g, rotor, tail, leaving: false, orbit: Math.random() * 6, air: true };
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
  update(dt: number, me: Flyer, want: number) {
    let on = this.watching;
    if (on.length < want && !on.some((h) => Math.hypot(h.x - me.x, h.y - me.y) > 200)) this.spawn(me.x, me.y);
    on = this.watching;
    for (const h of on.slice(want)) h.leaving = true;

    for (const h of this.list) {
      // Circle a little off to one side so it never hides you. The lead makes up for
      // the lag of the chase below, so a steady pace keeps it on the circle.
      h.orbit += dt * 0.35;
      let tx = me.x + me.vx / 0.8 + Math.cos(h.orbit) * OFFSET;
      let ty = me.y + me.vy / 0.8 + Math.sin(h.orbit) * OFFSET;
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

  render(time: number, dt = 1 / 60) {
    let n = 0;
    this.lit.length = 0;
    this.spot.material.opacity = 0.32 * (1 - this.night);
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
      if (s.visible) this.lit.push({ x: h.x, y: h.y, z: h.z + 0.75, tx: x, ty: y });
    }
    for (let i = n; i < this.spots.length; i++) this.spots[i].visible = false;
  }
}

// A helicopter you fly yourself (the developer tools put one next to you). W and S
// fly forwards and back, A and D turn, Space climbs and Shift comes down; let go and
// it holds its height. Below the rooftops the buildings are in the way, so either fly
// along the streets or climb over them. A bridge's deck is ground to land on from
// above and a ceiling from below. You can only get out once it has landed on open
// ground or on a bridge.

const ROOFS = 30; // m above the ground: higher than that, the buildings don't matter
const TALL = 4; // m: the room it needs under a bridge
// What's under and over a point in the air (see TileWorld.below).
type Below = (x: number, y: number, z: number) => { level: number; h: number; roof: number };
const FLY = { top: 42, accel: 14, yaw: 1.7, climb: 9 };

export class Chopper {
  grid: { at(x: number, y: number): number };
  below: Below;
  x: number; y: number; h: number; z: number;
  vx: number; vy: number; vz: number; w: number; spin: number;
  g: THREE.Group; rotor: THREE.Group; tail: THREE.Group;
  pitch?: number; roll?: number;

  // `z`: the height to put it down from (onto a bridge's deck, or the ground under it).
  constructor(scene: THREE.Scene, grid: { at(x: number, y: number): number }, below: Below, x: number, y: number, h: number, z = Infinity) {
    this.grid = grid; this.below = below; this.x = x; this.y = y; this.h = h;
    this.vx = 0; this.vy = 0; this.vz = 0; this.w = 0; this.spin = 0;
    this.z = below(x, y, z).h;
    const m = model({ body: '#c8312b', band: '#f2efe8', stripe: '#2a2d31' });
    this.g = m.g; this.rotor = m.rotor; this.tail = m.tail;
    scene.add(m.g);
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  // The ground or the bridge deck under it.
  height(x: number, y: number) { return this.below(x, y, this.z).h; }
  // The bridge it's over or on (0 for the ground).
  get level() { return this.below(this.x, this.y, this.z).level; }
  get air() { return this.z - this.height(this.x, this.y); }
  // Rooftop height counts as the floor over buildings.
  solid(x: number, y: number) { return this.grid.at(x, y) === 255 && !this.below(x, y, this.z).level; }
  floor(x: number, y: number) { return this.height(x, y) + (this.solid(x, y) ? ROOFS : 0); }
  get landed() { return this.air < 0.6 && !this.solid(this.x, this.y); }

  // `ctl`: { move -1..1, turn -1..1 (left +), up, down } or null when nobody's flying it.
  update(dt: number, ctl: { move: number; turn: number; up: boolean; down: boolean } | null) {
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
    // So does the side of a bridge's deck.
    const hits = (x: number, y: number) => this.below(x, y, this.z).roof - TALL < this.z - 1
      || (under && [[3, 0], [-3, 0], [0, 3], [0, -3], [0, 0]].some(([a, b]) => this.solid(x + a, y + b)));
    if (!hits(nx, this.y)) this.x = nx; else this.vx *= -0.2;
    if (!hits(this.x, ny)) this.y = ny; else this.vy *= -0.2;
    this.z += this.vz * dt;
    const floor = Math.min(this.floor(this.x, this.y), Math.max(this.height(this.x, this.y), this.below(this.x, this.y, this.z).roof - TALL));
    const roof = this.below(this.x, this.y, this.z).roof - TALL;
    if (this.z > roof) { this.z = roof; this.vz = Math.min(0, this.vz); }
    if (this.z < floor) { this.z = floor; this.vz = Math.max(0, this.vz); }
    this.z = Math.min(this.z, this.height(this.x, this.y) + 220);

    const vf = this.vx * fx + this.vy * fy;
    this.pitch = -0.25 * clamp(vf / FLY.top, -1, 1) * (low ? 0 : 1);
    this.roll = clamp(-this.w * this.speed * 0.02, -0.35, 0.35);
  }

  render(dt: number) {
    this.g.position.set(this.x, this.z, -this.y);
    this.g.rotation.set(this.roll || 0, this.h, this.pitch || 0, 'YZX');
    this.rotor.rotation.y += dt * 38 * this.spin;
    this.tail.rotation.z += dt * 60 * this.spin;
  }

  remove(scene: THREE.Scene) { scene.remove(this.g); }
}
