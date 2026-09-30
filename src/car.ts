import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from './network.ts';
import { Figures, Anim, SCALE } from './figures.ts';
import type { FigureKit, Look } from './figures.ts';
import type { Point2 } from './map/geo.ts';
import { posts } from './posts.ts';
import { fences } from './fences.ts';
import { lampLit } from './lamps.ts';
import { SNOW, STREET_SNOW, WET } from './shading.ts';
import { sendInstances } from './gpu.ts';

export interface CarSpec {
  L: number; W: number; H: number; mass: number; accel: number; vmax: number;
  grip: number; turn: number; weight: number; cabin?: Point2; color?: string;
  wheelbase?: number; traffic?: number; two?: 'bike' | 'moto'; heavy?: boolean;
  // Handling when someone drives it (each defaults to the value in brackets): braking
  // (m/s², 16), tightest turning circle (m, 3.6), how fast the steering answers (9),
  // how much speed costs grip (0.45), coasting drag with a driver (m/s², 0.6), top
  // reverse speed as a share of vmax (0.3), the impact speed (m/s) before damage
  // starts (3) and how much rain and snow matter (1).
  // Which wheels drive it (fwd): rwd slides out when you floor it in a bend, fwd runs
  // wide (understeers), awd suffers less from rain and snow.
  drive?: 'fwd' | 'rwd' | 'awd';
  brake?: number; radius?: number; response?: number; fade?: number; drag?: number; reverse?: number; tough?: number; weather?: number;
}
export interface CarControl { throttle: number; steer: number; handbrake: boolean; cap?: number | null }
export interface CarGrid {
  at(x: number, y: number): number;
  height?: (x: number, y: number) => number;
  view?: (car: Car) => CarGrid;
}
export interface Body { x: number; y: number; vx: number; vy: number; w?: number }

// Arcade top-down car handling: grip on the long axis, lateral slip that decays
// (much slower with the handbrake), bounces off walls against the collision grid.

export const TYPES: Record<string, CarSpec> = {
  hatch: { L: 3.9, W: 1.75, H: 1.45, mass: 1100, accel: 9, vmax: 36, grip: 9, turn: 2.6, cabin: [-1.15, 0.85], weight: 4, radius: 3.2, response: 11, brake: 17 },
  sedan: { L: 4.6, W: 1.82, H: 1.45, mass: 1450, accel: 10, vmax: 42, grip: 8.5, turn: 2.4, cabin: [-1.25, 0.8], weight: 4, radius: 3.8 },
  estate: { L: 4.7, W: 1.82, H: 1.5, mass: 1500, accel: 9, vmax: 40, grip: 8.5, turn: 2.3, cabin: [-1.95, 0.8], weight: 2, radius: 4, brake: 15 },
  // A crossover such as a Kodiaq or Enyaq: taller and heavier than an estate.
  suv: { L: 4.65, W: 1.88, H: 1.65, mass: 1900, accel: 8.5, vmax: 40, grip: 8.3, turn: 2.2, cabin: [-2, 0.85], weight: 3, radius: 4.4, response: 8.5, brake: 15 },
  van: { L: 5.2, W: 2.0, H: 2.3, mass: 2200, accel: 6.5, vmax: 31, grip: 8, turn: 1.9, cabin: [-2.5, 1.6], weight: 1, drive: 'rwd', radius: 6, response: 7, brake: 11, tough: 4.5, drag: 0.5, weather: 1.1 },
  taxi: { L: 4.6, W: 1.82, H: 1.45, mass: 1450, accel: 10, vmax: 42, grip: 8.5, turn: 2.4, cabin: [-1.25, 0.8], weight: 1, color: '#e9c62f', radius: 3.8 },
  // A full-size American pickup (an F-150): rare, long, heavy and rear-wheel drive.
  pickup: { L: 5.9, W: 2.03, H: 1.95, mass: 2500, accel: 8, vmax: 38, grip: 7.6, turn: 1.9, cabin: [-1, 0.7], weight: 0.5, drive: 'rwd', radius: 5.8, response: 7.5, brake: 13, tough: 4.5, drag: 0.5, weather: 1.05 },
  // Never parked or in ordinary traffic: src/police.ts puts these on the streets.
  police: { L: 4.7, W: 1.84, H: 1.5, mass: 1500, accel: 11, vmax: 44, grip: 9, turn: 2.5, cabin: [-1.3, 0.8], weight: 0, color: '#eef1f4', drive: 'rwd', radius: 3.8, brake: 19, tough: 4 },
  // Two-wheelers (drawn from the figures kit, as big as the people riding them). A bike
  // is never parked in a car bay; `traffic` is how often each type turns up on the road.
  bike: { L: 2.3, W: 0.8, H: 1.5, mass: 90, accel: 3.2, vmax: 9, grip: 12, turn: 3.4, weight: 0, traffic: 1.6, two: 'bike', radius: 2, brake: 10, tough: 1.5, weather: 1.3 },
  moto: { L: 2.8, W: 1.0, H: 1.6, mass: 260, accel: 12, vmax: 48, grip: 9.5, turn: 2.8, weight: 0.3, traffic: 1.2, two: 'moto', radius: 2.5, response: 12, brake: 22, fade: 0.35, tough: 1.5, weather: 1.5 },
  // A 12 m city bus in PID colours: slow to pick up speed, wide in the turns. Never
  // parked or in the ordinary mix: Traffic.buses keeps a few on their lines.
  // Lorries: only on the motorways and out in the suburbs (Traffic.spawn), never parked.
  truck: { L: 8, W: 2.5, H: 3.6, mass: 7500, accel: 3.2, vmax: 25, grip: 7, turn: 1.4, weight: 0, traffic: 0, heavy: true, wheelbase: 4.6, drive: 'rwd', radius: 8, response: 5, brake: 9, fade: 0.3, drag: 0.4, reverse: 0.2, tough: 5, weather: 1.15 },
  artic: { L: 16.5, W: 2.55, H: 4, mass: 30000, accel: 2, vmax: 24, grip: 6.5, turn: 1.1, weight: 0, traffic: 0, heavy: true, wheelbase: 9, drive: 'rwd', radius: 12, response: 3.5, brake: 7, fade: 0.25, drag: 0.35, reverse: 0.15, tough: 6, weather: 1.2 },
  bus: { L: 12, W: 2.55, H: 3.1, mass: 12000, accel: 2.6, vmax: 24, grip: 7, turn: 1.25, weight: 0, color: '#c8102e', heavy: true, drive: 'rwd', radius: 10, response: 4, brake: 8, fade: 0.3, drag: 0.4, reverse: 0.2, tough: 5, weather: 1.15 },
  // A fire engine: src/brigade.ts sends these to burning cars. Never parked or in traffic.
  fire: { L: 8.5, W: 2.5, H: 3.2, mass: 14000, accel: 2.4, vmax: 25, grip: 7, turn: 1.3, weight: 0, traffic: 0, color: '#c4161c', heavy: true, wheelbase: 5, drive: 'rwd', radius: 8.5, response: 4, brake: 8, fade: 0.3, drag: 0.4, reverse: 0.2, tough: 6, weather: 1.15 },
};
// A variant of a body type: the same geometry (so the same draw call) with its own
// handling and engine. `id` picks the engine in audio.ts, `name` (a model's own name,
// never translated) is shown when you get in, `freq` is how common it is among the
// variants of its type. Types without an entry (taxi, police, two-wheelers, bus) have none.
export interface Variant { id: string; name?: string; freq: number; tune: Partial<CarSpec> }
export const VARIANTS: Record<string, Variant[]> = {
  hatch: [
    // The Fabia I 1.2 HTP: three light cylinders, slow but willing, soft brakes.
    { id: 'fabia', name: 'Škoda Fabia 1.2', freq: 0.4, tune: { accel: 6, vmax: 33, brake: 14, weather: 1.2, mass: 1000 } },
    { id: 'hatch', freq: 0.6, tune: {} },
  ],
  sedan: [
    // The Octavia I 1.9 TDI: strong from low revs, a little short at the top.
    { id: 'octavia', name: 'Škoda Octavia 1.9 TDI', freq: 0.4, tune: { accel: 10.5, vmax: 39, tough: 4 } },
    // An electric car: quick off the line, regenerative braking when you lift off, all-wheel drive.
    { id: 'model3', name: 'Tesla Model 3', freq: 0.06, tune: { accel: 13, vmax: 45, drag: 1.2, mass: 1850, drive: 'awd' } },
    { id: 'sedan', freq: 0.54, tune: {} },
  ],
  suv: [
    { id: 'enyaq', name: 'Škoda Enyaq iV 80', freq: 0.15, tune: { accel: 10.5, vmax: 40, drag: 1.1, mass: 2100, drive: 'rwd' } },
    { id: 'modely', name: 'Tesla Model Y', freq: 0.08, tune: { accel: 12.5, vmax: 44, drag: 1.2, mass: 2000, drive: 'awd' } },
    { id: 'suv', freq: 0.77, tune: {} },
  ],
  pickup: [{ id: 'f150', name: 'Ford F-150', freq: 1, tune: {} }],
  estate: [
    { id: 'octavia', name: 'Škoda Octavia 1.9 TDI', freq: 0.4, tune: { accel: 10, vmax: 38, tough: 4 } },
    { id: 'estate', freq: 0.6, tune: {} },
  ],
};
// The body's spec with a variant's changes, made once for each pair.
const merged = new Map<Variant, CarSpec>();
function tuned(type: string, v: Variant): CarSpec {
  let m = merged.get(v);
  if (!m) merged.set(v, (m = { ...TYPES[type], ...v.tune }));
  return m;
}
const PAINT = ['#e8e6e1', '#bfc3c7', '#8d9398', '#2c2f33', '#1d2a44', '#7a1f1f', '#b33a2c', '#2f5140', '#5b6d7c', '#d9d2c0', '#3f4a5a', '#9a7b4f'];
const TWO_PAINT: Record<string, string[]> = {
  bike: ['#1d2a44', '#b33a2c', '#2f5140', '#e8e6e1', '#2c2f33', '#d94f8c', '#e0b32a', '#5b6d7c', '#8fb3c9'],
  truck: ['#1d4fa3', '#b33a2c', '#2f5140', '#e8e6e1', '#e0b32a', '#5b6d7c', '#2c2f33'],
  artic: ['#1d4fa3', '#b33a2c', '#2f5140', '#e8e6e1', '#e0b32a', '#2c2f33', '#7a1f1f'],
  moto: ['#b3161b', '#1d2a44', '#2c2f33', '#e8e6e1', '#d9d2c0', '#2f5140', '#e07b1f'],
};

// Delivery couriers' boxes: pink, green and blue, as on the streets.
export const COURIER_BOXES = ['#d70f64', '#2fbf71', '#0a9fdc'];
// Where the box sits on the rider's back, in the figures kit's units, and how far it
// leans forward with them (radians).
const BOX_AT: Record<string, { x: number; y: number; lean: number }> = {
  bike: { x: -0.36, y: 1.38, lean: 0.52 },
  moto: { x: -0.35, y: 1.3, lean: 0.42 },
};
function boxGeometry(kind: string, colour: string): THREE.BufferGeometry {
  const at = BOX_AT[kind], c = new THREE.Color(colour);
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, dy: number, shade: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.deleteAttribute('uv');
    g.translate(0, dy, 0);
    g.rotateZ(-at.lean);
    g.translate(at.x, at.y, 0);
    g.scale(SCALE, SCALE, SCALE);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r * shade, c.g * shade, c.b * shade], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  add(0.34, 0.36, 0.44, 0, 1);
  add(0.36, 0.06, 0.46, 0.21, 0.8); // the lid
  return mergeGeometries(parts);
}

let kit: FigureKit | null = null;
// Two-wheelers come from the figures kit, which has to be loaded before the first one.
export function useKit(k: FigureKit) { kit = k; }

const cache = new Map<string, THREE.BufferGeometry>();
function carGeometry(type: string, paint: string, box?: string): THREE.BufferGeometry {
  const k = box ? `${type}|${paint}|${box}` : `${type}|${paint}`;
  const known = cache.get(k);
  if (known) return known;
  const S = TYPES[type];
  if (S.two) {
    if (!kit) throw new Error('Figures kit is not loaded');
    const geometry = box ? mergeGeometries([kit.vehicles[S.two](paint), boxGeometry(S.two, box)]) : kit.vehicles[S.two](paint);
    cache.set(k, geometry);
    return geometry;
  }
  if (type === 'truck' || type === 'artic') {
    const geometry = truckGeometry(type, S, paint);
    cache.set(k, geometry);
    return geometry;
  }
  if (type === 'bus') {
    const geometry = busGeometry(S);
    cache.set(k, geometry);
    return geometry;
  }
  if (type === 'fire') {
    const geometry = fireGeometry(S);
    cache.set(k, geometry);
    return geometry;
  }
  if (!bodies) throw new Error('Car bodies are not loaded');
  const node = bodies.getObjectByName(type);
  if (!node) throw new Error(`Missing ${type} in cars.glb`);
  const c = new THREE.Color();
  const parts: THREE.BufferGeometry[] = [];
  node.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = new THREE.BufferGeometry();
    g.setIndex(o.geometry.index);
    g.setAttribute('position', o.geometry.attributes.position.clone());
    g.setAttribute('normal', o.geometry.attributes.normal.clone());
    g.applyMatrix4(o.matrixWorld);
    const name = (Array.isArray(o.material) ? o.material[0] : o.material).name;
    c.set(name === 'Paint' ? S.color || paint : PART[name] || '#777777');
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  });
  const g = mergeGeometries(parts);
  cache.set(k, g);
  return g;
}

// The bus is built here from boxes rather than in Blender: red below the windows, a
// white roof with the air conditioning on top, a dark band of glass all round with
// white pillars, three doors on the right, and the line board over the windscreen.
// (Forward is +x, right +z, the ground y = 0, as for the car bodies.)
function boxBuilder() {
  const parts: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  const add = (g: THREE.BufferGeometry, colour: string, x: number, y: number, z: number) => {
    g.deleteAttribute('uv');
    g.translate(x, y, z);
    c.set(colour);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const box = (colour: string, x0: number, x1: number, y0: number, y1: number, w: number, z = 0) =>
    add(new THREE.BoxGeometry(x1 - x0, y1 - y0, w), colour, (x0 + x1) / 2, (y0 + y1) / 2, z);
  const wheel = (x: number, W: number, twin = false) => {
    for (const z of [-1, 1]) {
      const w = new THREE.CylinderGeometry(0.5, 0.5, twin ? 0.6 : 0.34, 14);
      w.rotateX(Math.PI / 2);
      add(w, '#161616', x, 0.5, z * (W / 2 - 0.22));
      const hub = new THREE.CylinderGeometry(0.24, 0.24, 0.02, 10);
      hub.rotateX(Math.PI / 2);
      add(hub, '#70757b', x, 0.5, z * (W / 2 - 0.04));
    }
  };
  return { box, wheel, done: () => mergeGeometries(parts) };
}

function busGeometry(S: CarSpec): THREE.BufferGeometry {
  const { box, wheel, done } = boxBuilder();
  const L = S.L / 2, W = S.W, red = S.color || '#c8102e', white = '#eeeeea', glass = '#1b242c', grey = '#8a8f94';
  const sill = 1.15, top = 2.55, roof = 2.95;
  box('#2a2c2f', -L + 0.05, L - 0.05, 0.28, 0.5, W - 0.02); // skirt and bumpers
  box(red, -L, L, 0.5, sill, W);
  box(glass, -L + 0.02, L - 0.02, sill, top, W - 0.06);
  // The roof stops short of the front, so from above the dark windscreen and line
  // board show which way the bus faces.
  box(white, -L, L - 0.4, top, roof, W);
  box('#141414', L - 0.4, L, top, roof - 0.08, W - 0.04);
  box('#9a9fa3', -3.3, 0.9, roof, roof + 0.18, 1.8); // air conditioning
  box('#e2e4e2', -3.2, 0.8, roof + 0.18, roof + 0.3, 1.7);
  box('#9a9fa3', -L + 0.3, -L + 2.0, roof, roof + 0.25, 2.0); // engine vents
  box('#b9bdbf', 1.9, 2.7, roof, roof + 0.06, 0.8); // roof hatches
  box('#b9bdbf', -5.0, -4.2, roof, roof + 0.06, 0.8);
  // Pillars between the side windows (none where the doors are).
  const doors = [L - 1.35, 0.6, -3.8];
  for (let x = -L + 0.9; x < L - 2.2; x += 1.45) {
    if (doors.some((d) => Math.abs(x - d) < 0.9)) continue;
    box(white, x - 0.07, x + 0.07, sill, top, W + 0.01);
  }
  box(white, L - 2.25, L - 2.1, sill, top, W + 0.01);
  box(white, -L + 0.02, -L + 0.5, sill, top, W + 0.01); // the back corners
  // Doors on the right (+z): glass nearly down to the kerb, a red frame round them.
  for (const d of doors) {
    box(red, d - 0.68, d + 0.68, 0.32, top, 0.04, W / 2);
    box('#26313a', d - 0.6, d + 0.6, 0.38, top - 0.08, 0.06, W / 2 + 0.005);
    box('#15191d', d - 0.02, d + 0.02, 0.38, top - 0.08, 0.08, W / 2 + 0.005);
  }
  // Front: a tall windscreen, the line board above it, headlamps; tail lamps at the back.
  box(glass, L - 0.05, L + 0.02, 0.9, top, W - 0.2);
  box('#141414', L - 0.04, L + 0.03, top + 0.04, roof - 0.06, W - 0.5);
  box('#ffb020', L - 0.03, L + 0.035, top + 0.1, roof - 0.12, W - 0.9);
  for (const z of [-1, 1]) {
    box('#fff6d8', L - 0.05, L + 0.03, 0.55, 0.72, 0.4, z * (W / 2 - 0.3));
    box('#b3161b', -L - 0.03, -L + 0.05, 0.6, 1.1, 0.22, z * (W / 2 - 0.2));
  }
  box(glass, -L - 0.02, -L + 0.05, 1.4, top - 0.1, W - 0.5);
  box('#e3e5e0', L - 0.03, L + 0.04, 0.3, 0.42, 0.52); // number plate
  // Wheels: two at the front, twin tyres at the back.
  wheel(L - 2.7, W);
  wheel(-L + 3.3, W);
  return done();
}

// The word on the front of the fire engine, as a 5 × 7 pixel font (Č has a caron row above).
const GLYPHS: Record<string, string[]> = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  Č: ['01010', '01110', '10001', '10000', '10000', '10000', '10001', '01110'],
};

// A fire engine from boxes: a red cab and body, grey roller shutters along the sides
// under a yellow stripe, a ladder on the roof, HASIČI on the front and chevrons at the back.
function fireGeometry(S: CarSpec): THREE.BufferGeometry {
  const { box, wheel, done } = boxBuilder();
  const L = S.L / 2, W = S.W, red = S.color || '#c4161c', glass = '#1b242c', grey = '#8c9196';
  const cab = 2.3, cx = L - cab, floor = 0.55, top = 2.7, cabTop = 3.0;
  box('#2a2c2f', -L + 0.05, L - 0.05, 0.3, floor, W - 0.3); // chassis and bumpers
  box(red, -L, cx, floor, top, W); // body
  box(red, cx, L, floor, cabTop, W); // cab
  box(glass, L - 0.05, L + 0.02, 1.65, cabTop - 0.15, W - 0.25); // windscreen
  box(glass, cx + 0.5, L - 0.45, 1.65, cabTop - 0.2, W + 0.02); // side windows
  box('#2a2c2f', L - 0.05, L + 0.06, 0.75, 1.15, W - 0.5); // grille
  box('#d8d8d4', L - 0.05, L + 0.03, 1.2, 1.7, W - 0.3); // the band HASIČI is on
  box('#2a2c2f', L - 0.1, L + 0.18, 0.3, 0.7, W - 0.05); // front bumper
  for (const side of [-1, 1]) {
    box('#e8d21a', -L, L, 1.35, 1.5, 0.03, side * W / 2); // reflective stripe
    for (let i = 0; i < 3; i++) {
      const a = -L + 0.35 + i * 1.5, b = a + 1.35;
      box(grey, a, Math.min(b, cx - 0.2), 0.75, 1.3, 0.05, side * W / 2); // shutters
      box(grey, a, Math.min(b, cx - 0.2), 1.55, 2.4, 0.05, side * W / 2);
    }
    box('#fff6d8', L - 0.05, L + 0.05, 0.75, 1.0, 0.35, side * (W / 2 - 0.3)); // headlamps
    box('#b3161b', -L - 0.03, -L + 0.05, 0.7, 1.0, 0.22, side * (W / 2 - 0.2)); // tail lamps
  }
  // The ladder lies on the roof, two rails with rungs; tool boxes and a hose reel beside it.
  for (const z of [-0.45, 0.45]) box('#c4c8cb', -L + 0.3, cx - 0.3, top, top + 0.2, 0.08, z);
  for (let x = -L + 0.5; x < cx - 0.3; x += 0.4) box('#9a9fa3', x - 0.03, x + 0.03, top + 0.12, top + 0.18, 0.9);
  for (const z of [-0.95, 0.95]) box('#a8adb1', -L + 0.5, cx - 0.6, top, top + 0.12, 0.3, z);
  box('#a8adb1', cx + 0.1, L - 0.3, cabTop, cabTop + 0.06, W - 0.6); // the cab's roof rail
  // Red and white chevrons across the back.
  for (let i = 0; i < 6; i++) box(i % 2 ? '#d8d8d4' : '#c4161c', -L - 0.04, -L + 0.04, 1.1, 1.5, (W - 0.3) / 6, -W / 2 + 0.15 + (i + 0.5) * ((W - 0.3) / 6));
  box('#e3e5e0', L - 0.03, L + 0.04, 0.3, 0.42, 0.52); // number plate
  // HASIČI on the band, read from the front: the right-hand side of someone facing the
  // engine is -z, so the letters run from +z to -z.
  const px = 0.05, word = [...'HASIČI'], pitch = 6 * px, z0 = (word.length * pitch - px) / 2;
  word.forEach((ch, i) => {
    const rows = GLYPHS[ch];
    rows.forEach((row, r) => {
      const y1 = 1.68 - r * px - (rows.length === 8 ? 0 : px);
      for (let c = 0; c < 5;) {
        if (row[c] !== '1') { c++; continue; }
        let e = c;
        while (e < 5 && row[e] === '1') e++;
        box('#b3121a', L + 0.03, L + 0.05, y1 - px, y1, (e - c) * px, z0 - i * pitch - ((c + e) / 2) * px + 0.0);
        c = e;
      }
    });
  });
  wheel(L - 1.45, W);
  wheel(-L + 1.5, W, true);
  wheel(-L + 2.8, W, true);
  return done();
}

// Lorries are boxes too: a cab in the paint colour and a white box or trailer behind
// it (with a stripe in the cab's colour), a dark chassis, tail lamps and a bar at the back.
// The artic is a tractor with a trailer, the box truck one rigid body.
function truckGeometry(type: string, S: CarSpec, paint: string): THREE.BufferGeometry {
  const { box, wheel, done } = boxBuilder();
  const L = S.L / 2, W = S.W, glass = '#1b242c', artic = type === 'artic';
  const cab = artic ? 2.5 : 2.2, cabTop = artic ? 3.3 : 2.9, floor = artic ? 1.0 : 0.85, top = artic ? 4.0 : 3.6;
  const cx = L - cab; // where the cab starts
  box('#2a2c2f', -L, L, 0.35, floor, W - 0.5); // chassis
  box(paint, cx, L, floor - 0.2, cabTop, W); // cab
  box(glass, L - 0.05, L + 0.02, floor + 0.65, cabTop - 0.2, W - 0.25); // windscreen
  box(glass, cx + 0.5, L - 0.4, floor + 0.7, cabTop - 0.25, W + 0.02); // side windows
  box(paint, cx + 0.05, cx + 0.5, cabTop, cabTop + (artic ? 0.5 : 0.0), W - 0.3); // roof deflector
  box('#2a2c2f', L - 0.1, L + 0.15, 0.35, 0.75, W - 0.1); // bumper
  const bx = artic ? cx - 0.9 : cx - 0.1; // the box's front end
  box('#e6e7e3', -L, bx, floor, top, W); // box or trailer
  box(paint, -L, bx, floor + 0.7, floor + 1.05, W + 0.01); // stripe
  box('#9a9fa3', -L, -L + 0.06, floor + 0.15, top - 0.15, W - 0.3); // rear doors
  for (const z of [-1, 1]) {
    box('#fff6d8', L - 0.05, L + 0.05, floor - 0.1, floor + 0.2, 0.4, z * (W / 2 - 0.3));
    box('#b3161b', -L - 0.03, -L + 0.05, floor - 0.1, floor + 0.3, 0.25, z * (W / 2 - 0.2));
  }
  box('#3a3c3f', -L - 0.1, -L + 0.05, 0.55, 0.75, W - 0.2); // under-run bar
  if (artic) box('#2a2c2f', bx, cx + 0.3, floor, floor + 0.3, W - 0.6); // the fifth wheel between them
  box('#e3e5e0', L - 0.03, L + 0.04, 0.3, 0.42, 0.52); // number plate
  wheel(L - 1.1, W);
  if (artic) { wheel(cx + 0.4, W, true); wheel(-L + 1.6, W, true); wheel(-L + 2.9, W, true); }
  else { wheel(-L + 1.5, W, true); }
  return done();
}

// Car bodies from public/cars.glb (built in Blender by assets/cars/build.py): one per
// type, each part a material named after it. Paint takes the car's colour; the rest:
const PART: Record<string, string> = {
  Glass: '#1e2830', Trim: '#1f2022', Tyre: '#161616', Metal: '#70757b', Lamp: '#fff6d8', Tail: '#b3161b',
  Plate: '#e3e5e0', Sign: '#fff4c2', Blue: '#1d4fa3', Yellow: '#d4e02b', Bar: '#1b1f2a',
};
let bodies: THREE.Object3D | null = null;
export async function loadCars(url = 'cars.glb') {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  bodies = gltf.scene;
}

const material = new THREE.MeshLambertMaterial({ vertexColors: true });
// Snow settles on the roofs and bonnets (weather.ts).
material.onBeforeCompile = (sh) => {
  lampLit(sh);
  sh.uniforms.uSnow = SNOW;
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uSnow;')
    .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  if (uSnow > .01) {
    float up = dot(normal, (viewMatrix * vec4(0., 1., 0., 0.)).xyz);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.8, .82, .86), smoothstep(.75, .95, up) * smoothstep(.1, .6, uSnow) * .6);
  }`);
};
material.customProgramCacheKey = () => 'cars';
const depthMaterial = new THREE.MeshDepthMaterial();

// Points round a car's outline for its collisions, the same for every car of a type
// (shared: parking tries thousands of cars when a tile loads).
const outlines = new Map<string, Point2[]>();
const denseOutlines = new Map<string, Point2[]>();
function samplesOf(type: string, L: number, W: number) {
  let out = outlines.get(type);
  if (!out) {
    out = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1], [0.5, 1], [0.5, -1], [-0.5, 1], [-0.5, -1]].map(([a, b]) => [(a * L) / 2, (b * W) / 2] as Point2);
    // A bus: more along its sides, every metre and a half or so.
    for (const a of [-0.75, -0.25, 0.25, 0.75]) if (L > 6) out.push([(a * L) / 2, W / 2], [(a * L) / 2, -W / 2]);
    outlines.set(type, out);
  }
  return out;
}

// A random type, by `weight` for parking and by `traffic` (where it's set) on the road.
export function randomType(r: () => number, use: 'weight' | 'traffic' = 'weight') {
  const w = (t: CarSpec) => t[use] ?? t.weight;
  const total = Object.values(TYPES).reduce((a, t) => a + w(t), 0);
  let x = r() * total;
  for (const [k, t] of Object.entries(TYPES)) if ((x -= w(t)) < 0) return k;
  return 'sedan';
}

export class Car {
  type: string;
  variant: Variant | null = null;
  spec: CarSpec;
  mass: number;
  key: string;
  x: number; y: number; h: number;
  vx: number; vy: number; w: number;
  mode: string;
  damage: number;
  rider: Look | null;
  lean: number;
  r: number;
  offsets: number[];
  samples: Point2[];
  level?: number;
  gz?: number;
  hint?: 'bridge' | 'tunnel' | 'ground';
  grounded?: boolean;
  lastH?: number;
  anim?: Anim;
  crew?: boolean;
  // A delivery courier's box colour (COURIER_BOXES), on a bike or moped.
  courier?: string;
  // Blown up (src/fire.ts): a charred wreck nobody can drive.
  burnt?: boolean;
  // A bus on a line: its number and where it's going, for the boards (Traffic.buses).
  line?: { ref: string; to: string };
  // A shared bike (src/bikeshare.ts): its system, and the station it stands at (null
  // while rented).
  share?: { system: number; station: string | null };
  // How hard the back and front tyres scrub the road (0–1), for their marks (skids.ts).
  skidBack = 0; skidFront = 0;
  _tx?: number; _ty?: number; resting?: boolean; restAt?: [number, number, number]; stamp?: number;

  constructor(type: string, r: () => number, x = 0, y = 0, h = 0, colour?: string, box?: string) {
    this.type = type;
    this.spec = TYPES[type];
    const paints = TWO_PAINT[type] || PAINT;
    // (One colour for the types painted alike, so they share a draw call.)
    const pick = paints[Math.floor(r() * paints.length)], paint = colour || this.spec.color || pick;
    const options = VARIANTS[type];
    if (options) {
      let x = r() * options.reduce((a, v) => a + v.freq, 0);
      this.variant = options.find((v) => (x -= v.freq) < 0) ?? options[options.length - 1];
      this.spec = tuned(type, this.variant);
    }
    this.mass = this.spec.mass;
    this.key = box ? `${type}|${paint}|${box}` : `${type}|${paint}`;
    carGeometry(type, paint, box);
    this.courier = box;
    this.x = x;
    this.y = y;
    this.h = h;
    this.vx = this.vy = this.w = 0;
    this.mode = 'loose'; // 'traffic' (driven by AI), 'loose' (free body), 'player', 'police' (chasing you), 'fire' (an engine on call)
    this.damage = 0;
    this.rider = null; // on a two-wheeler: the look of whoever is riding it
    this.lean = 0;
    const { L, W } = this.spec;
    this.r = W / 2 + 0.02;
    // Circles along the length, at least three, close enough to cover a bus's sides.
    const n = Math.max(3, Math.ceil((L - 2 * this.r) / (2 * this.r)) + 1), end = L / 2 - this.r;
    this.offsets = Array.from({ length: n }, (_, i) => -end + (2 * end * i) / (n - 1));
    this.samples = samplesOf(type, L, W);
    this.sync();
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
  get two() { return this.spec.two; }
  // Someone at the wheel: the player, or the police chasing them.
  get driven() { return this.mode === 'player' || this.mode === 'police' || this.mode === 'fire'; }
  get forwardSpeed() { return this.vx * Math.cos(this.h) + this.vy * Math.sin(this.h); }

  // How far (x, y) is from the car, for getting in: from its middle less half its
  // length, as for any car, but for a bus from the nearest point along its middle, or
  // you could get in from across the street.
  gap(x: number, y: number) {
    const c = Math.cos(this.h), s = Math.sin(this.h), dx = x - this.x, dy = y - this.y;
    const half = Math.min(this.spec.L / 2, 2.3), run = this.spec.L / 2 - half;
    const along = clamp(dx * c + dy * s, -run, run);
    return Math.hypot(dx - c * along, dy - s * along) - half;
  }

  // How high the top of the car is at (x, y), for someone climbing over it: the roof
  // over the cabin, sloping down to the bonnet in front and the boot behind.
  topAt(x: number, y: number) {
    const S = this.spec, u = (x - this.x) * Math.cos(this.h) + (y - this.y) * Math.sin(this.h);
    const [a, b] = S.cabin ?? [-S.L / 2, S.L / 2], low = Math.min(0.9, S.H * 0.62);
    const beyond = Math.max(a - u, u - b, 0);
    return S.H - (S.H - low) * Math.min(1, beyond / 0.6);
  }

  circles(): Point2[] {
    const c = Math.cos(this.h), s = Math.sin(this.h);
    return this.offsets.map((o) => [this.x + c * o, this.y + s * o]);
  }

  // Free-body physics. `ctl` = { throttle -1..1, steer -1..1 (left +), handbrake, cap }.
  // `cap` (m/s, optional) limits the speed: the gas fades as the car gets near it, and
  // above it the car eases down, as if you'd lifted off and touched the brake.
  update(dt: number, ctl: CarControl | null, grid: CarGrid) {
    // The ground and walls as this car meets them: on a bridge deck or under it.
    if (grid.view) grid = grid.view(this);
    const S = this.spec;
    ctl = ctl || { throttle: 0, steer: 0, handbrake: false };
    const fx = Math.cos(this.h), fy = Math.sin(this.h);
    let vf = this.vx * fx + this.vy * fy;
    let vl = this.vx * fy - this.vy * fx;
    const fast = clamp(Math.abs(vf) / S.vmax, 0, 1);
    const throttle = ctl.cap == null || ctl.throttle <= 0 ? ctl.throttle : Math.min(ctl.throttle, clamp((ctl.cap - vf) / 2, 0, 1));
    // A wet road and snow take some of the tyres' grip: longer braking, wider slides
    // (for the cars someone is driving hard; the traffic keeps to its lanes as before).
    const road = this.driven ? 1 - (S.weather ?? 1) * (S.drive === 'awd' ? 0.6 : 1) * Math.max(0.25 * WET.value, 0.45 * SNOW.value * STREET_SNOW.value, 0.25 * SNOW.value) : 1;
    const brake = S.brake ?? 16;

    if (throttle > 0) {
      if (vf < -0.3) vf = Math.min(0, vf + brake * road * dt);
      else vf += S.accel * throttle * (1 - fast * fast) * (0.6 + 0.4 * road) * dt;
    } else if (throttle < 0) {
      if (vf > 0.3) vf = Math.max(0, vf - brake * road * dt);
      else vf = Math.max(-S.vmax * (S.reverse ?? 0.3), vf - S.accel * 0.6 * dt);
    } else {
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), (this.driven ? S.drag ?? 0.6 : 5) * dt);
    }
    if (ctl.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);
    // Hills: gravity along the car's heading (rolls back down, slower uphill).
    if (grid.height) {
      const half = S.L / 2;
      const slope = (grid.height(this.x + fx * half, this.y + fy * half) - grid.height(this.x - fx * half, this.y - fy * half)) / S.L;
      vf -= 9.81 * slope * dt;
    }
    if (ctl.cap != null && vf > ctl.cap) vf = Math.max(ctl.cap, vf - 3 * dt);

    // Full throttle in a bend: the driven wheels lose sideways grip (rear-wheel drive)
    // or the car runs wide (front-wheel drive, below).
    const power = this.driven && !S.two ? clamp(throttle, 0, 1) : 0;
    const bend = power * Math.min(1, Math.abs(ctl.steer)) * clamp(Math.abs(vf) / 10, 0, 1);
    const grip = (ctl.handbrake ? 1.1 : S.grip * (1 - (S.fade ?? 0.45) * fast) * (S.drive === 'rwd' ? 1 - 0.3 * bend : 1)) * road;
    vl *= Math.exp(-grip * dt);
    // Tyre marks: sliding sideways, the back wheels locked by the handbrake, or all
    // four braking hard.
    const slide = clamp((Math.abs(vl) - 1.5) / 4, 0, 1);
    const braking = (throttle < 0 && vf > 4) || (throttle > 0 && vf < -4) ? 0.6 : 0;
    this.skidBack = Math.max(slide, braking, ctl.handbrake && Math.abs(vf) > 2 ? 0.8 : 0);
    this.skidFront = Math.max(slide * 0.7, braking);

    const sgn = vf >= 0 ? 1 : -1;
    const maxW = S.turn * (1 - 0.35 * fast) * (ctl.handbrake ? 1.35 : 1) * (!S.drive || S.drive === 'fwd' ? 1 - 0.12 * bend : 1);
    const wantW = ctl.steer * Math.min(Math.abs(vf) / (S.radius ?? 3.6), maxW) * sgn;
    if (this.driven) this.w += (wantW - this.w) * Math.min(1, dt * (S.response ?? 9));
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
      impact = Math.max(impact, posts.collide(this), fences.collide(this), this.collideGrid(grid));
    }
    this.sync();
    return impact;
  }

  // The whole outline every ~0.4 m, for checking against walls: a wall's corner can
  // slip between the few points `samples` holds.
  worldOutline(): Point2[] {
    let local = denseOutlines.get(this.type);
    if (!local) {
      const [L, W] = [this.samples[0][0] * 2, this.samples[0][1] * 2];
      const nL = Math.ceil(L / 0.4), nW = Math.ceil(W / 0.4);
      local = [];
      for (let i = 0; i <= nL; i++) { const a = (i / nL - 0.5) * L; local.push([a, W / 2], [a, -W / 2]); }
      for (let i = 1; i < nW; i++) { const b = (i / nW - 0.5) * W; local.push([L / 2, b], [-L / 2, b]); }
      denseOutlines.set(this.type, local);
    }
    const c = Math.cos(this.h), s = Math.sin(this.h);
    return local.map(([a, b]) => [this.x + c * a - s * b, this.y + s * a + c * b]);
  }

  worldSamples(): Point2[] {
    const c = Math.cos(this.h), s = Math.sin(this.h);
    return this.samples.map(([a, b]) => [this.x + c * a - s * b, this.y + s * a + c * b]);
  }

  collideGrid(grid: CarGrid) {
    const solid = (x: number, y: number) => (grid.at(x, y) ? 1 : 0);
    let nx = 0, ny = 0, hits = 0, cx = 0, cy = 0;
    for (const [x, y] of this.worldOutline()) {
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
      if (!this.worldOutline().some(([x, y]) => solid(x, y))) break;
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
    this.damage += Math.max(0, -vn - (this.spec.tough ?? 3));
    return -vn;
  }

  // Charred: the same body, drawn nearly black (one wreck colour for each type).
  burn() {
    const k = `${this.type}|burnt`;
    if (!cache.has(k)) {
      const [paint, box] = this.key.slice(this.type.length + 1).split('|');
      const g = carGeometry(this.type, paint, box).clone(), col = g.getAttribute('color');
      if (col) for (let i = 0; i < col.count; i++) {
        const v = 0.02 + 0.05 * (col.getX(i) + col.getY(i) + col.getZ(i)) / 3;
        col.setXYZ(i, v, v, v * 1.05);
      }
      cache.set(k, g);
    }
    this.key = k;
    this.burnt = true;
  }

  sync() {} // drawn by CarPool each frame
}

// A line board: the number big on the left and where the bus is going, in amber on
// black, one small texture per line and direction (there are only ever a few buses).
const boards = new Map<string, THREE.MeshBasicMaterial>();
function boardMaterial(ref: string, to: string) {
  const k = `${ref}|${to}`;
  let m = boards.get(k);
  if (m) return m;
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#0c0c0c';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#ffb020';
  g.textBaseline = 'middle';
  g.font = 'bold 54px sans-serif';
  g.fillText(ref, 10, 35, 130);
  g.font = 'bold 40px sans-serif';
  if (to) g.fillText(to, 150, 35, 352);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  m = new THREE.MeshBasicMaterial({ map: t });
  boards.set(k, m);
  return m;
}
// The line number painted big on the roof, so it can be read from above: dark on the
// white roof, the top of the digits towards the front.
const roofs = new Map<string, THREE.MeshBasicMaterial>();
function roofMaterial(ref: string) {
  let m = roofs.get(ref);
  if (m) return m;
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#23272b';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 112px sans-serif';
  g.fillText(ref, 128, 68, 244);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  m = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
  roofs.set(ref, m);
  return m;
}
const boardPlane = new THREE.PlaneGeometry(1, 1);
// Where the boards sit on a bus (see busGeometry): over the windscreen, facing
// forward, and on the right over the glass behind the front door.
const BOARDS = (() => {
  const L = TYPES.bus.L / 2, W = TYPES.bus.W, m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const front = m.clone().compose(new THREE.Vector3(L + 0.04, 2.74, 0), q.clone().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), s.clone().set(W - 0.9, 0.2, 1));
  const side = m.clone().compose(new THREE.Vector3(L - 3.4, 2.38, W / 2 + 0.012), q.clone(), s.clone().set(1.5, 0.19, 1));
  return [front, side];
})();
// On the roof between the hatch and the front, lying flat, reading from the front.
const ROOF = new THREE.Matrix4().compose(new THREE.Vector3(TYPES.bus.L / 2 - 1.95, 2.955, 0),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, -Math.PI / 2, 0, 'YXZ')), new THREE.Vector3(2.2, 1.1, 1));

// Every car is an instance: one draw call per type and colour, however many are parked.
// Riders are drawn here too, sitting on their bikes.
export class CarPool {
  scene: THREE.Scene;
  meshes: Map<string, THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>>;
  groups: Map<string, Car[]>;
  dummy: THREE.Object3D;
  riders: Figures;
  scale: THREE.Matrix4;
  m: THREE.Matrix4;
  boards: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene) {
    if (!kit) throw new Error('Figures kit is not loaded');
    this.scene = scene;
    this.meshes = new Map();
    this.groups = new Map();
    this.dummy = new THREE.Object3D();
    this.riders = new Figures(kit, 64);
    scene.add(this.riders.mesh);
    this.scale = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
    this.m = new THREE.Matrix4();
  }

  // `height(x, y, car)`: the height of the ground (or the bridge deck) under a car's
  // wheels; cars sit on it, pitched and rolled to the slope.
  render(cars: Car[], height: ((x: number, y: number, car: Car) => number) | null = null, dt = 0) {
    for (const c of cars) if (c.two) this.lean(c, dt);
    for (const list of this.groups.values()) list.length = 0;
    for (const c of cars) {
      if (!this.groups.has(c.key)) this.groups.set(c.key, []);
      this.groups.get(c.key)!.push(c);
    }
    const d = this.dummy;
    let riders = 0, nb = 0;
    for (const [k, list] of this.groups) {
      let m = this.meshes.get(k);
      if (!m || m.instanceMatrix.count < list.length) {
        if (m) { this.scene.remove(m); m.dispose(); }
        const geometry = cache.get(k);
        if (!geometry) throw new Error(`Missing car geometry: ${k}`);
        m = new THREE.InstancedMesh(geometry, material, Math.max(8, Math.ceil(list.length * 1.5)));
        m.castShadow = true;
        m.customDepthMaterial = depthMaterial; // (see treeMesh)
        m.frustumCulled = false;
        this.scene.add(m);
        this.meshes.set(k, m);
      }
      list.forEach((c, i) => {
        if (height) {
          const fx = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
          const hf = height(c.x + fx * L, c.y + fy * L, c), hb = height(c.x - fx * L, c.y - fy * L, c);
          const hl = height(c.x - fy * W, c.y + fx * W, c), hr = height(c.x + fy * W, c.y - fx * W, c);
          d.position.set(c.x, (hf + hb + hl + hr) / 4, -c.y);
          d.rotation.set(Math.atan2(hl - hr, 2 * W) - c.lean, c.h, Math.atan2(hf - hb, 2 * L), 'YZX');
        } else {
          d.position.set(c.x, 0, -c.y);
          d.rotation.set(-c.lean, c.h, 0, 'YZX');
        }
        d.updateMatrix();
        m.setMatrixAt(i, d.matrix);
        if (c.rider && riders < this.riders.capacity) this.ride(c, riders++, d.matrix, dt);
        if (c.line) {
          for (const at of BOARDS) this.board(nb++, boardMaterial(c.line.ref, c.line.to), d.matrix, at);
          this.board(nb++, roofMaterial(c.line.ref), d.matrix, ROOF);
        }
      });
      m.count = list.length;
      sendInstances(m);
    }
    this.riders.commit(riders);
    for (let i = 0; i < this.boards.length; i++) this.boards[i].visible = i < nb;
  }

  // A line board on a bus: a quad over the plain amber one, placed by hand each frame.
  board(i: number, material: THREE.MeshBasicMaterial, matrix: THREE.Matrix4, at: THREE.Matrix4) {
    let b = this.boards[i];
    if (!b) {
      b = new THREE.Mesh(boardPlane, material);
      b.matrixAutoUpdate = false;
      b.frustumCulled = false;
      this.scene.add(b);
      this.boards[i] = b;
    }
    b.material = material;
    b.matrix.multiplyMatrices(matrix, at);
    b.matrixWorldNeedsUpdate = true;
    b.visible = true;
  }

  // Lean into the turns (worked out from how fast the heading changes, so it works
  // for traffic too); a parked bike leans on its stand.
  lean(c: Car, dt: number) {
    const yaw = dt > 0 && c.lastH !== undefined ? Math.atan2(Math.sin(c.h - c.lastH), Math.cos(c.h - c.lastH)) / dt : 0;
    c.lastH = c.h;
    const want = !c.rider && c.speed < 0.3 ? 0.2 : clamp(Math.atan((c.forwardSpeed * yaw) / 9.81), -0.7, 0.7);
    c.lean += (want - c.lean) * Math.min(1, dt * 6);
  }

  ride(c: Car, i: number, matrix: THREE.Matrix4, dt: number) {
    if (!kit || !c.rider || !c.two) return;
    c.anim = c.anim || new Anim(kit, c.two, Math.random());
    // Pedal as fast as the bike goes: about 6 m a turn of the cranks.
    c.anim.step(dt, c.two === 'bike' ? Math.max(0, c.forwardSpeed) / 6 : 1);
    this.riders.look(i, c.rider);
    this.riders.set(i, this.m.copy(matrix).multiply(this.scale), c.anim);
  }
}

// Circle-based collision between two bodies. `ia`/`ib` are inverse masses (0 = immovable).
// Returns the closing speed at contact, or 0 if they don't touch.
export function collideBodies(a: Body, ca: Point2[], ra: number, ia: number, b: Body, cb: Point2[], rb: number, ib: number, restitution = 0.25) {
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
  for (const [body, inv, sign] of [[a, ia, -1], [b, ib, 1]] as [Body, number, number][]) {
    if (!inv || body.w === undefined) continue;
    const rx = best.px - body.x, ry = best.py - body.y;
    body.w += (rx * ny - ry * nx) * sign * j * inv * 0.25;
  }
  return -vrel;
}
