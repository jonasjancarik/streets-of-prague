import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clamp } from './network.ts';
import { turnOf } from './assist.ts';

interface Flyer { x: number; y: number; vx: number; vy: number }
interface Helicopter {
  x: number; y: number; z: number; vx: number; vy: number; h: number; w: number;
  g: THREE.Group; rotor: THREE.Group; tail: THREE.Group;
  leaving: boolean; orbit: number; air: boolean; gone?: boolean; pitch?: number; roll?: number;
  blades: number; fan: number; // the rotors' angles
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

// The body comes from public/helicopters.glb (built in Blender by
// assets/helicopters/build.py): heli_body, and heli_rotor and heli_tail with their origins
// on their hubs. Paint, Band and Stripe take the livery; the other parts are named after
// what they are.
const PART: Record<string, string> = { Glass: '#1b232b', Dark: '#2a2d31', Metal: '#7b7f84', Blade: '#26282c', Tip: '#e9e4d6', Lamp: '#fff6d8', Beacon: '#d0242a' };
interface Part { geometry: THREE.BufferGeometry; part: string }
let built: { body: Part[]; rotor: Part[]; tail: Part[]; hub: THREE.Vector3; tailHub: THREE.Vector3 } | null = null;

export async function loadHelicopters(url = 'helicopters.glb') {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const node = (name: string) => {
    const n = gltf.scene.getObjectByName(name);
    if (!n) throw new Error(`Missing ${name} in helicopters.glb`);
    return n;
  };
  const parts = (n: THREE.Object3D) => {
    const inv = n.matrixWorld.clone().invert(), out: Part[] = [];
    n.traverse((o) => {
      if (o instanceof THREE.Mesh) out.push({ geometry: o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)), part: (o.material as THREE.Material).name });
    });
    return out;
  };
  const rotor = node('heli_rotor'), tail = node('heli_tail');
  built = { body: parts(node('heli_body')), rotor: parts(rotor), tail: parts(tail), hub: rotor.position.clone(), tailHub: tail.position.clone() };
}

// Turning blades leave two fainter copies trailing behind them, so the rotor reads as
// spinning from above at any frame rate (`spin` 0..1 fades them in).
const TRAIL = [0.13, 0.26];
// How fast the rotors turn (rad/s). Slower than a real one's, so that from frame to frame
// they move on by less than half the angle between their blades and are seen turning
// the right way at 30, 60 or 120 frames a second.
const ROTOR = 14, FAN = 40;
const materials = new Map<string, THREE.MeshLambertMaterial>();
const shared = (color: string) => {
  let m = materials.get(color);
  if (!m) materials.set(color, (m = new THREE.MeshLambertMaterial({ color })));
  return m;
};

function model(paint = POLICE) {
  if (!built) throw new Error('loadHelicopters first');
  const colour = (part: string) => part === 'Paint' ? paint.body : part === 'Band' ? paint.band : part === 'Stripe' ? paint.stripe : PART[part] || '#777777';
  const g = new THREE.Group();
  const meshes = (parts: Part[], parent: THREE.Object3D, mat = (p: Part) => shared(colour(p.part))) => {
    for (const p of parts) {
      const m = new THREE.Mesh(p.geometry, mat(p));
      m.castShadow = true;
      parent.add(m);
    }
  };
  meshes(built.body, g);
  const rotor = new THREE.Group();
  rotor.position.copy(built.hub);
  g.add(rotor);
  meshes(built.rotor, rotor);
  const trails: THREE.MeshLambertMaterial[] = [];
  for (const back of TRAIL) {
    const ghost = new THREE.Group();
    ghost.rotation.y = -back;
    rotor.add(ghost);
    meshes(built.rotor.filter((p) => p.part === 'Blade' || p.part === 'Tip'), ghost, (p) => {
      const m = new THREE.MeshLambertMaterial({ color: colour(p.part), transparent: true, opacity: 0, depthWrite: false });
      trails.push(m);
      return m;
    });
    ghost.traverse((o) => { o.castShadow = false; });
  }
  // A faint disc where the blades blur.
  const blur = new THREE.Mesh(new THREE.CircleGeometry(5.6, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#1a1c20', transparent: true, opacity: 0, depthWrite: false }));
  blur.position.copy(built.hub).y -= 0.02;
  g.add(blur);
  const tail = new THREE.Group();
  tail.position.copy(built.tailHub);
  g.add(tail);
  meshes(built.tail, tail);
  // How fast the rotor turns, 0..1.
  const blurred = (spin: number) => {
    blur.material.opacity = 0.13 * spin;
    trails.forEach((m, i) => { m.opacity = spin * (i < trails.length / 2 ? 0.4 : 0.2); });
  };
  return { g, rotor, tail, blurred };
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
    const { g, rotor, tail, blurred } = model();
    blurred(1);
    this.scene.add(g);
    const h: Helicopter = { x: hx, y: hy, z: this.height(hx, hy) + ALT, vx: 0, vy: 0, h: a + Math.PI, w: 0, g, rotor, tail, leaving: false, orbit: Math.random() * 6, air: true, blades: 0, fan: 0 };
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
      // (The rotors turn with the world's time, so they turn evenly in footage too.)
      h.blades = (h.blades + dt * ROTOR) % (Math.PI * 2);
      h.fan = (h.fan + dt * FAN) % (Math.PI * 2);
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

  render(time: number) {
    let n = 0;
    this.lit.length = 0;
    this.spot.material.opacity = 0.32 * (1 - this.night);
    for (const h of this.list) {
      h.g.position.set(h.x, h.z, -h.y);
      h.g.rotation.set(h.roll || 0, h.h, h.pitch || 0, 'YZX');
      h.rotor.rotation.y = h.blades;
      h.tail.rotation.z = h.fan;
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
  blades = 0; fan = 0; // the rotors' angles
  private blurred: (spin: number) => void;

  // `z`: the height to put it down from (onto a bridge's deck, or the ground under it).
  constructor(scene: THREE.Scene, grid: { at(x: number, y: number): number }, below: Below, x: number, y: number, h: number, z = Infinity) {
    this.grid = grid; this.below = below; this.x = x; this.y = y; this.h = h;
    this.vx = 0; this.vy = 0; this.vz = 0; this.w = 0; this.spin = 0;
    this.z = below(x, y, z).h;
    const m = model({ body: '#c8312b', band: '#f2efe8', stripe: '#2a2d31' });
    this.g = m.g; this.rotor = m.rotor; this.tail = m.tail; this.blurred = m.blurred;
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
    this.blades = (this.blades + dt * ROTOR * this.spin) % (Math.PI * 2);
    this.fan = (this.fan + dt * FAN * this.spin) % (Math.PI * 2);
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
    // (Below the rooftops from the ground at each spot looked at: over a bridge's deck,
    // its parapet is low and the river beside it lower still, so 25 m above the deck
    // the helicopter flies on over the parapet instead of catching on it.)
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt;
    // So does the side of a bridge's deck.
    const hits = (x: number, y: number) => this.below(x, y, this.z).roof - TALL < this.z - 1
      || [[3, 0], [-3, 0], [0, 3], [0, -3], [0, 0]].some(([a, b]) => this.z - this.height(x + a, y + b) < ROOFS && this.solid(x + a, y + b));
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

  render() {
    this.g.position.set(this.x, this.z, -this.y);
    this.g.rotation.set(this.roll || 0, this.h, this.pitch || 0, 'YZX');
    this.rotor.rotation.y = this.blades;
    this.tail.rotation.z = this.fan;
    this.blurred(this.spin);
  }

  remove(scene: THREE.Scene) { scene.remove(this.g); }
}
