import * as THREE from 'three';
import { mirrored } from './mirror.ts';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from './network.ts';
import { Figures, Anim, SCALE } from './figures.ts';
import type { FigureKit, Look } from './figures.ts';
import type { Point2 } from './map/geo.ts';
import { posts } from './posts.ts';
import { fences } from './fences.ts';
import { lampLit, LAMP_ON } from './lamps.ts';
import { SNOW, STREET_SNOW, WET, SKY_REF, STREET_REF, SUN_DIR, SUN_LIGHT } from './shading.ts';
import { send, sendInstances } from './gpu.ts';
import { KINDS, STRIPS, STRIPS_ON } from './reflections.ts';

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
  // A crossover such as a Torra or Ionia: taller and heavier than an estate.
  suv: { L: 4.65, W: 1.88, H: 1.65, mass: 1900, accel: 8.5, vmax: 40, grip: 8.3, turn: 2.2, cabin: [-2, 0.85], weight: 3, radius: 4.4, response: 8.5, brake: 15 },
  van: { L: 5.2, W: 2.0, H: 2.3, mass: 2200, accel: 6.5, vmax: 31, grip: 8, turn: 1.9, cabin: [-2.5, 1.6], weight: 1, drive: 'rwd', radius: 6, response: 7, brake: 11, tough: 4.5, drag: 0.5, weather: 1.1 },
  taxi: { L: 4.6, W: 1.82, H: 1.45, mass: 1450, accel: 10, vmax: 42, grip: 8.5, turn: 2.4, cabin: [-1.25, 0.8], weight: 1, color: '#e9c62f', radius: 3.8 },
  // A full-size American pickup (an F-150): rare, long, heavy and rear-wheel drive.
  pickup: { L: 5.9, W: 2.03, H: 1.95, mass: 2500, accel: 8, vmax: 38, grip: 7.6, turn: 1.9, cabin: [-1, 0.7], weight: 0.5, drive: 'rwd', radius: 5.8, response: 7.5, brake: 13, tough: 4.5, drag: 0.5, weather: 1.05 },
  // Never parked or in ordinary traffic: src/police.ts puts these on the streets.
  police: { L: 4.7, W: 1.84, H: 1.5, mass: 1500, accel: 11, vmax: 44, grip: 9, turn: 2.5, cabin: [-1.3, 0.8], weight: 0, color: '#c9ced2', drive: 'rwd', radius: 3.8, brake: 19, tough: 4 },
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
  // The small buses of the centre's lines (194, 207): the same build, 7.5 m long.
  minibus: { L: 7.5, W: 2.2, H: 2.8, mass: 5500, accel: 3.4, vmax: 24, grip: 7.5, turn: 1.7, weight: 0, color: '#c8102e', heavy: true, drive: 'rwd', radius: 6.5, response: 5, brake: 9, fade: 0.3, drag: 0.4, reverse: 0.2, tough: 4.5, weather: 1.15 },
  // A fire engine: src/brigade.ts sends these to burning cars. Never parked or in traffic.
  fire: { L: 8.5, W: 2.5, H: 3.2, mass: 14000, accel: 2.4, vmax: 25, grip: 7, turn: 1.3, weight: 0, traffic: 0, color: '#c4161c', heavy: true, wheelbase: 5, drive: 'rwd', radius: 8.5, response: 4, brake: 8, fade: 0.3, drag: 0.4, reverse: 0.2, tough: 6, weather: 1.15 },
  // An ambulance: src/ambulance.ts sends these to people lying hurt. Never parked or in traffic.
  ambulance: { L: 6, W: 2.1, H: 2.7, mass: 3200, accel: 5.5, vmax: 30, grip: 8, turn: 1.8, weight: 0, traffic: 0, color: '#f2f3ef', wheelbase: 3.6, drive: 'rwd', radius: 6, response: 6, brake: 11, tough: 4.5, drag: 0.5, weather: 1.1 },
};
// A variant of a body type: the same geometry (so the same draw call) with its own
// handling and engine. `make`, `model` and `engine` (made-up names, never translated) are shown when
// you drive it, `id` picks the engine in audio.ts (a type's own engine when it has none),
// `freq` is how common it is among the variants of its type. Types without an entry
// (taxi, police, two-wheelers, bus) have none.
// `app` is the weight among the cars of the ride-hailing apps' drivers (taxi only), who
// drive older cars than the street taxis; the ones without it are never app cars.
export interface Variant { id: string; make: string; model: string; engine: string; freq: number; app?: number; tune: Partial<CarSpec> }
export const variantName = (v: Variant) => `${v.make} ${v.model} ${v.engine}`;
export const VARIANTS: Record<string, Variant[]> = {
  hatch: [
    // The Vima 1.2: three light cylinders, slow but willing, soft brakes.
    { id: 'threecyl', make: 'Schade', model: 'Vima', engine: '1.2', freq: 0.16, tune: { accel: 6, vmax: 33, brake: 14, weather: 1.2, mass: 1000 } },
    { id: 'hatch', make: 'Nordwerk', model: 'Vento', engine: '1.6', freq: 0.1, tune: {} },
    { id: 'hatch', make: 'Schade', model: 'Tavo', engine: '1.2 T', freq: 0.1, tune: { accel: 9.5, vmax: 37 } },
    { id: 'hatch', make: 'Schade', model: 'Alva', engine: '1.0 T', freq: 0.08, tune: { accel: 9.2, vmax: 36, mass: 1150 } },
    { id: 'diesel', make: 'Rivière', model: 'Sora', engine: '1.5 D', freq: 0.08, tune: { accel: 8, vmax: 34, mass: 1150 } },
    { id: 'hatch', make: 'Prairie', model: 'Dova', engine: '1.0 T', freq: 0.08, tune: { accel: 9.5, vmax: 36, mass: 1050 } },
    { id: 'hatch', make: 'Hanbit', model: 'Dalia', engine: '1.4', freq: 0.08, tune: { accel: 8.8, vmax: 36, mass: 1250 } },
    { id: 'diesel', make: 'Dalmaji', model: 'Kuro', engine: '1.6 D', freq: 0.07, tune: { accel: 9, vmax: 37, mass: 1350 } },
    { id: 'hatch', make: 'Lyonel', model: 'Vell', engine: '1.2 T', freq: 0.06, tune: { accel: 9.3, vmax: 36, mass: 1050 } },
    { id: 'hatch', make: 'Sakura', model: 'Mika', engine: '1.5 Hybrid', freq: 0.05, tune: { accel: 9.5, vmax: 35, mass: 1100, brake: 15 } },
    { id: 'hatch', make: 'Blitzen', model: 'Kovi', engine: '1.2', freq: 0.05, tune: { accel: 8.5, vmax: 35, mass: 1050 } },
    { id: 'hatch', make: 'Schade', model: 'Nuvo', engine: '1.0', freq: 0.04, tune: { accel: 6.5, vmax: 32, mass: 900, weather: 1.2 } },
    { id: 'hatch', make: 'Nordwerk', model: 'Brisa', engine: '1.0 T', freq: 0.05, tune: { accel: 9, vmax: 36, mass: 1100 } },
  ],
  sedan: [
    // The Avanta 1.9 D (older): strong from low revs, a little short at the top.
    { id: 'diesel', make: 'Schade', model: 'Avanta', engine: '1.9 D', freq: 0.14, tune: { accel: 10.5, vmax: 39, tough: 4 } },
    // The Avanta 2.0 D (103 kW): the same diesel character, a little quicker.
    { id: 'diesel', make: 'Schade', model: 'Avanta', engine: '2.0 D', freq: 0.1, tune: { accel: 11.5, vmax: 41, tough: 4 } },
    { id: 'sedan', make: 'Schade', model: 'Avanta', engine: '1.4 T', freq: 0.1, tune: { accel: 10.5, vmax: 42 } },
    { id: 'sedan', make: 'Schade', model: 'Regia', engine: '2.0 T', freq: 0.08, tune: { accel: 11.5, vmax: 45, mass: 1600 } },
    { id: 'diesel', make: 'Nordwerk', model: 'Corvan', engine: '2.0 D', freq: 0.08, tune: { accel: 11, vmax: 43, mass: 1550 } },
    { id: 'diesel', make: 'Lumen', model: 'Kora', engine: '2.0 D', freq: 0.07, tune: { accel: 11.5, vmax: 44, mass: 1550 } },
    { id: 'diesel', make: 'Kronberg', model: 'Tarn', engine: '2.0 D', freq: 0.07, tune: { accel: 12, vmax: 46, mass: 1500, drive: 'rwd' } },
    { id: 'diesel', make: 'Aurum', model: 'Solen', engine: '2.2 D', freq: 0.05, tune: { accel: 11.8, vmax: 45, mass: 1550, drive: 'rwd' } },
    { id: 'sedan', make: 'Kaze', model: 'Aiko', engine: '2.0', freq: 0.05, tune: { accel: 10.5, vmax: 43, mass: 1400 } },
    { id: 'sedan', make: 'Sakura', model: 'Hana', engine: '1.8 Hybrid', freq: 0.05, tune: { accel: 9.8, vmax: 40, mass: 1400, brake: 15 } },
    { id: 'diesel', make: 'Norrland', model: 'Skarn', engine: '2.0 D', freq: 0.04, tune: { accel: 11.5, vmax: 44, mass: 1600 } },
    { id: 'sedan', make: 'Hanbit', model: 'Seon', engine: '1.6', freq: 0.04, tune: { accel: 9.5, vmax: 40, mass: 1300 } },
    // An electric car: quick off the line, regenerative braking when you lift off, all-wheel drive.
    { id: 'electric', make: 'Voltar', model: 'Axion', engine: 'Elektro', freq: 0.05, tune: { accel: 13, vmax: 45, drag: 1.2, mass: 1850, drive: 'awd' } },
    { id: 'sedan', make: 'Schade', model: 'Tavo Wide', engine: '1.6 D', freq: 0.04, tune: { accel: 9.5, vmax: 40, mass: 1300 } },
  ],
  suv: [
    { id: 'electric', make: 'Schade', model: 'Ionia', engine: 'Elektro 80 kWh', freq: 0.1, tune: { accel: 10.5, vmax: 40, drag: 1.1, mass: 2100, drive: 'rwd' } },
    { id: 'electric', make: 'Voltar', model: 'Axion X', engine: 'Elektro', freq: 0.06, tune: { accel: 12.5, vmax: 44, drag: 1.2, mass: 2000, drive: 'awd' } },
    { id: 'diesel', make: 'Schade', model: 'Torra', engine: '2.0 D', freq: 0.12, tune: { accel: 9.5, vmax: 41, mass: 1900, drive: 'awd' } },
    { id: 'suv', make: 'Schade', model: 'Vexa', engine: '1.5 T', freq: 0.12, tune: { accel: 9.5, vmax: 41, mass: 1500 } },
    { id: 'suv', make: 'Schade', model: 'Kiro', engine: '1.0 T', freq: 0.09, tune: { accel: 8.8, vmax: 38, mass: 1300 } },
    { id: 'diesel', make: 'Nordwerk', model: 'Tavira', engine: '2.0 D', freq: 0.08, tune: { accel: 9.5, vmax: 41, mass: 1700, drive: 'awd' } },
    { id: 'suv', make: 'Hanbit', model: 'Rovi', engine: '1.6 T', freq: 0.07, tune: { accel: 9.5, vmax: 41, mass: 1600 } },
    { id: 'diesel', make: 'Dalmaji', model: 'Vala', engine: '1.6 D', freq: 0.06, tune: { accel: 9, vmax: 40, mass: 1650 } },
    { id: 'suv', make: 'Sakura', model: 'Tano', engine: '2.5 Hybrid', freq: 0.05, tune: { accel: 10, vmax: 41, mass: 1700, drive: 'awd', brake: 15 } },
    { id: 'diesel', make: 'Kronberg', model: 'Rhena', engine: '2.0 D', freq: 0.04, tune: { accel: 10.5, vmax: 44, mass: 1900, drive: 'awd' } },
    { id: 'diesel', make: 'Carpatia', model: 'Brava', engine: '1.5 D', freq: 0.06, tune: { accel: 7.5, vmax: 37, mass: 1350, drive: 'awd', tough: 4 } },
    { id: 'diesel', make: 'Prairie', model: 'Mesa', engine: '2.0 D', freq: 0.04, tune: { accel: 9.3, vmax: 41, mass: 1700 } },
    { id: 'suv', make: 'Lumen', model: 'Lorix', engine: '2.0 T', freq: 0.04, tune: { accel: 10.5, vmax: 44, mass: 1900, drive: 'awd' } },
    { id: 'suv', make: 'Kaze', model: 'Hoshi', engine: '2.0', freq: 0.03, tune: { accel: 9, vmax: 40, mass: 1500 } },
    { id: 'suv', make: 'Lyonel', model: 'Veluz', engine: '1.2 T', freq: 0.04, tune: { accel: 9, vmax: 39, mass: 1400 } },
  ],
  taxi: [
    // Street taxis (freq): the newer cars of the fleets and the big ranks.
    { id: 'taxi', make: 'Schade', model: 'Avanta', engine: '1.5 T', freq: 0.18, app: 0.04, tune: { accel: 10.5, vmax: 43 } },
    { id: 'taxi', make: 'Schade', model: 'Regia', engine: '1.4 Plug-in', freq: 0.1, tune: { accel: 11, vmax: 45, mass: 1700, brake: 15 } },
    { id: 'taxi', make: 'Sakura', model: 'Hana', engine: '1.8 Hybrid', freq: 0.14, app: 0.03, tune: { accel: 9.8, vmax: 40, mass: 1400, brake: 15 } },
    { id: 'taxi', make: 'Sakura', model: 'Shiro', engine: '2.5 Hybrid', freq: 0.08, tune: { accel: 10.5, vmax: 42, mass: 1600, brake: 15 } },
    { id: 'taxi', make: 'Hanbit', model: 'Ione', engine: 'Elektro', freq: 0.05, tune: { accel: 12, vmax: 42, drag: 1.1, mass: 2000, drive: 'rwd' } },
    { id: 'electric', make: 'Voltar', model: 'Axion', engine: 'Elektro', freq: 0.08, app: 0.02, tune: { accel: 13, vmax: 45, drag: 1.2, mass: 1850, drive: 'awd' } },
    { id: 'diesel', make: 'Aurum', model: 'Maris', engine: '2.0 D', freq: 0.1, tune: { accel: 11.5, vmax: 46, mass: 1650, drive: 'rwd' } },
    { id: 'diesel', make: 'Schade', model: 'Regia', engine: '2.0 D', freq: 0.13, app: 0.05, tune: { accel: 11, vmax: 44, mass: 1600 } },
    { id: 'diesel', make: 'Nordwerk', model: 'Corvan', engine: '2.0 D', freq: 0.08, app: 0.1, tune: { accel: 11, vmax: 43, mass: 1550 } },
    { id: 'diesel', make: 'Schade', model: 'Avanta', engine: '2.0 D', freq: 0.06, app: 0.2, tune: { accel: 11.5, vmax: 41, tough: 4 } },
    // Ride-hailing cars (app): older and cheaper, diesels and small petrols with plenty of miles.
    { id: 'diesel', make: 'Schade', model: 'Avanta', engine: '1.9 D', freq: 0, app: 0.16, tune: { accel: 10.5, vmax: 39, tough: 4 } },
    { id: 'diesel', make: 'Schade', model: 'Avanta', engine: '1.6 D', freq: 0, app: 0.12, tune: { accel: 10, vmax: 40, tough: 4 } },
    { id: 'diesel', make: 'Schade', model: 'Tavo', engine: '1.6 D', freq: 0, app: 0.1, tune: { accel: 9.5, vmax: 40, mass: 1300 } },
    { id: 'diesel', make: 'Carpatia', model: 'Lemo', engine: '1.5 D', freq: 0, app: 0.07, tune: { accel: 8, vmax: 36, mass: 1150, tough: 4 } },
    { id: 'diesel', make: 'Prairie', model: 'Cadro', engine: '2.0 D', freq: 0, app: 0.07, tune: { accel: 10.5, vmax: 42, mass: 1550 } },
    { id: 'diesel', make: 'Blitzen', model: 'Zenta', engine: '1.7 D', freq: 0, app: 0.06, tune: { accel: 9, vmax: 38, mass: 1350 } },
    { id: 'threecyl', make: 'Schade', model: 'Vima', engine: '1.2', freq: 0, app: 0.05, tune: { accel: 6, vmax: 33, brake: 14, weather: 1.2, mass: 1000 } },
    { id: 'taxi', make: 'Sakura', model: 'Nami', engine: '1.6', freq: 0, app: 0.03, tune: { accel: 9, vmax: 39, mass: 1300 } },
  ],
  pickup: [{ id: 'v8', make: 'Prairie', model: 'Rancher', engine: '5.0 V8', freq: 1, tune: {} }],
  estate: [
    { id: 'diesel', make: 'Schade', model: 'Avanta Kombi', engine: '1.9 D', freq: 0.14, tune: { accel: 10, vmax: 38, tough: 4 } },
    { id: 'diesel', make: 'Schade', model: 'Avanta Kombi', engine: '2.0 D', freq: 0.1, tune: { accel: 11, vmax: 40, tough: 4 } },
    { id: 'estate', make: 'Schade', model: 'Avanta Kombi', engine: '1.4 T', freq: 0.08, tune: { accel: 10, vmax: 41 } },
    { id: 'diesel', make: 'Schade', model: 'Regia Kombi', engine: '2.0 D', freq: 0.08, tune: { accel: 11, vmax: 43, mass: 1650 } },
    { id: 'diesel', make: 'Nordwerk', model: 'Corvan Kombi', engine: '2.0 D', freq: 0.09, tune: { accel: 11, vmax: 42, mass: 1600 } },
    { id: 'diesel', make: 'Nordwerk', model: 'Vento Kombi', engine: '1.6 D', freq: 0.07, tune: { accel: 9.5, vmax: 38, mass: 1350 } },
    { id: 'threecyl', make: 'Schade', model: 'Vima Kombi', engine: '1.2', freq: 0.07, tune: { accel: 6.5, vmax: 34, mass: 1100, brake: 14, weather: 1.2 } },
    { id: 'diesel', make: 'Prairie', model: 'Orla Kombi', engine: '1.5 D', freq: 0.06, tune: { accel: 9.5, vmax: 39, mass: 1400 } },
    { id: 'diesel', make: 'Blitzen', model: 'Arvo Kombi', engine: '2.0 D', freq: 0.05, tune: { accel: 10, vmax: 41, mass: 1650 } },
    { id: 'diesel', make: 'Norrland', model: 'Skarn Kombi', engine: '2.0 D', freq: 0.05, tune: { accel: 11, vmax: 42, mass: 1700 } },
    { id: 'diesel', make: 'Lumen', model: 'Kora Kombi', engine: '2.0 D', freq: 0.05, tune: { accel: 11.5, vmax: 44, mass: 1650 } },
    { id: 'diesel', make: 'Kronberg', model: 'Tarn Kombi', engine: '2.0 D', freq: 0.04, tune: { accel: 12, vmax: 45, mass: 1650, drive: 'rwd' } },
    { id: 'diesel', make: 'Dalmaji', model: 'Kuro Kombi', engine: '1.6 D', freq: 0.05, tune: { accel: 9, vmax: 38, mass: 1450 } },
    { id: 'estate', make: 'Hanbit', model: 'Dalia Kombi', engine: '1.4', freq: 0.04, tune: { accel: 8.8, vmax: 37, mass: 1350 } },
    { id: 'estate', make: 'Sakura', model: 'Hana Kombi', engine: '1.8 Hybrid', freq: 0.03, tune: { accel: 9.5, vmax: 38, mass: 1450, brake: 15 } },
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
export interface CarBody { type: string; box?: string; pages?: number }

// The counting drive peaked at 104 hatchbacks, 83 sedans and 59 SUVs. One
// 128-instance page per type covers those peaks, well below the matrix UBO limit.
const bodyKey = (type: string, box?: string) => box ? `${type}|box:${box}` : type;
// The frame on the nose of some police cars (a body of its own, like a courier's box).
export const RAM = 'ram';

// A car's lamps, as bits of `Car.broken`: the headlamps left and right, then the tail
// lamps. The shader darkens a broken one and lights the ones that are on. WebGPU allows a
// mesh only eight vertex buffers, so the lamps ride in the ones the paint already has: a
// lamp's vertices have twice its number (1 to 4) in `painted`, and each car's `paint.w` is
// `broken`, plus 16 with the headlamps on, plus 32 with the tail lamps on or 64 braking.
export const LAMP = { headLeft: 1, headRight: 2, tailLeft: 4, tailRight: 8 };
const BREAKS = 4.5; // m/s: a knock this hard breaks a lamp it lands on
// Every vertex of a lamp's part gets its number: headlamp or tail lamp, left (-z) or right.
function markLamp(g: THREE.BufferGeometry, head: boolean) {
  const pos = g.getAttribute('position'), painted = g.getAttribute('painted');
  for (let i = 0; i < pos.count; i++) painted.setX(i, 2 * ((head ? 1 : 3) + (pos.getZ(i) > 0 ? 1 : 0)));
}

// Preparation is independent of paint, including colours from the bike feed, and
// never constructs dummy cars or advances the game's seeded random sequence.
export function ordinaryCarBodies(_bikeColours: readonly string[] = []): CarBody[] {
  const bodies: CarBody[] = [];
  for (const [type, spec] of Object.entries(TYPES)) {
    bodies.push({ type });
    if (type === 'police') bodies.push({ type, box: RAM });
    if (spec.two) for (const box of COURIER_BOXES) bodies.push({ type, box });
  }
  return bodies;
}
// Where the box sits on the rider's back, in the figures kit's units, and how far it
// leans forward with them (radians).
const BOX_AT: Record<string, { x: number; y: number; lean: number }> = {
  bike: { x: -0.36, y: 1.38, lean: 0.52 },
  moto: { x: -0.35, y: 1.3, lean: 0.42 },
  // On a walker's back, and lying on the ground (a courier's bag left behind).
  foot: { x: -0.3, y: 1.32, lean: 0.12 },
  ground: { x: 0, y: 0.17, lean: 1.25 },
};
export function boxGeometry(kind: string, colour: string): THREE.BufferGeometry {
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
    g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count), 1));
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
function carGeometry(type: string, box?: string): THREE.BufferGeometry {
  const k = bodyKey(type, box);
  const known = cache.get(k);
  if (known) return known;
  const S = TYPES[type];
  if (S.two) {
    if (!kit) throw new Error('Figures kit is not loaded');
    const geometry = box ? mergeGeometries([kit.vehicles[S.two](), boxGeometry(S.two, box)]) : kit.vehicles[S.two]();
    cache.set(k, geometry);
    return geometry;
  }
  if (type === 'truck' || type === 'artic') {
    const geometry = truckGeometry(type, S);
    cache.set(k, geometry);
    return geometry;
  }
  if (type === 'bus' || type === 'minibus') {
    const geometry = busGeometry(S);
    cache.set(k, geometry);
    return geometry;
  }
  if (type === 'fire') {
    const geometry = fireGeometry(S);
    cache.set(k, geometry);
    return geometry;
  }
  if (type === 'ambulance') {
    const geometry = ambulanceGeometry(S);
    cache.set(k, geometry);
    return geometry;
  }
  if (!bodies) throw new Error('Car bodies are not loaded');
  const c = new THREE.Color();
  const parts: THREE.BufferGeometry[] = [];
  const doors: Door[] = [], at = new THREE.Vector3();
  const nodes = [type, ...(box ? [`${type}_${box}`] : [])].map((name) => {
    const node = bodies!.getObjectByName(name);
    if (!node) throw new Error(`Missing ${name} in cars.glb`);
    return node;
  });
  for (const node of nodes) node.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = new THREE.BufferGeometry();
    g.setIndex(o.geometry.index);
    g.setAttribute('position', o.geometry.attributes.position.clone());
    g.setAttribute('normal', o.geometry.attributes.normal.clone());
    g.applyMatrix4(o.matrixWorld);
    // A door (an object of its own in cars.glb, its origin on the hinge): each vertex
    // carries the hinge and the door's number, and the shader swings it open.
    let hung: THREE.Object3D | null = o;
    while (hung && hung !== node && !/_door\d$/.test(hung.name)) hung = hung.parent;
    const n = hung && hung !== node ? Number(hung.name.slice(-1)) : 0;
    const hinge = new Float32Array(g.attributes.position.count * 3);
    if (n) {
      hung!.getWorldPosition(at);
      for (let i = 0; i < hinge.length; i += 3) hinge.set([at.x, at.z, n], i);
      g.computeBoundingBox();
      const door = doors.find((d) => d.n === n);
      if (door) door.back = Math.min(door.back, g.boundingBox!.min.x);
      else doors.push({ n, side: at.z < 0 ? 1 : -1, front: at.x, back: g.boundingBox!.min.x, real: true });
    }
    g.setAttribute('hinge', new THREE.BufferAttribute(hinge, 3));
    const name = (Array.isArray(o.material) ? o.material[0] : o.material).name;
    c.set(name === 'Paint' ? '#ffffff' : PART[name] || '#777777');
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(name === 'Paint' ? 1 : 0), 1));
    if (name === 'Lamp' || name === 'Tail') markLamp(g, name === 'Lamp');
    parts.push(g);
  });
  const g = mergeGeometries(parts);
  cache.set(k, g);
  DOORS.set(type, doors.sort((a, b) => a.n - b.n));
  return g;
}

// A car's doors: 1 front left (the driver's), 2 front right, 3 and 4 behind them. `side`
// is 1 on the left; `front` (the hinge) and `back` are along the car from its middle.
// Vehicles built here from boxes (buses, lorries, the fire engine, the ambulance) have
// no door to swing (`real`), only the places to get in at the cab.
export interface Door { n: number; side: number; front: number; back: number; real: boolean }
const DOORS = new Map<string, Door[]>();
export const DOOR_OPEN = 1.1; // radians a door swings out
const DOOR_SPEED = 5.5; // radians a second
function doorsOf(type: string) {
  let doors = DOORS.get(type);
  if (!doors) {
    const { L, two } = TYPES[type], front = L / 2 - 0.7;
    doors = two ? [] : [1, -1].map((side, i) => ({ n: i + 1, side, front, back: front - 1, real: false }));
    DOORS.set(type, doors);
  }
  return doors;
}

// The bus is built here from boxes rather than in Blender: red below the windows, a
// white roof with the air conditioning on top, a dark band of glass all round with
// white pillars, three doors on the right, and the line board over the windscreen.
// (Forward is +x, right +z, the ground y = 0, as for the car bodies.)
const HEADLAMP = '#fff6d8', TAIL_LAMP = '#b3161b'; // (a box in one of these is a lamp)
function boxBuilder(paintColour?: string) {
  const parts: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  const add = (g: THREE.BufferGeometry, colour: string, x: number, y: number, z: number) => {
    g.deleteAttribute('uv');
    g.translate(x, y, z);
    c.set(colour === paintColour ? '#ffffff' : colour);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(colour === paintColour ? 1 : 0), 1));
    if (colour === HEADLAMP || colour === TAIL_LAMP) markLamp(g, colour === HEADLAMP);
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const box = (colour: string, x0: number, x1: number, y0: number, y1: number, w: number, z = 0) =>
    add(new THREE.BoxGeometry(x1 - x0, y1 - y0, w), colour, (x0 + x1) / 2, (y0 + y1) / 2, z);
  // A box with its corners rounded off in plan (radius r, or [front, back]) and, with
  // `bevel`, its top edges too: from above that's what keeps a bus or a lorry from
  // reading as a crate.
  const rounded = (colour: string, x0: number, x1: number, y0: number, y1: number, w: number, r: number | [number, number], bevel = 0, z = 0) => {
    const [rf, rb] = (typeof r === 'number' ? [r, r] : r).map((v) => Math.max(v - bevel, 0.005));
    const h = w / 2 - bevel, a = x0 + bevel, b = x1 - bevel, shape = new THREE.Shape();
    shape.moveTo(a + rb, -h);
    shape.lineTo(b - rf, -h);
    shape.absarc(b - rf, -h + rf, rf, -Math.PI / 2, 0, false);
    shape.lineTo(b, h - rf);
    shape.absarc(b - rf, h - rf, rf, 0, Math.PI / 2, false);
    shape.lineTo(a + rb, h);
    shape.absarc(a + rb, h - rb, rb, Math.PI / 2, Math.PI, false);
    shape.lineTo(a, -h + rb);
    shape.absarc(a + rb, -h + rb, rb, Math.PI, Math.PI * 1.5, false);
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: Math.max(y1 - y0 - 2 * bevel, 0.001), curveSegments: 3,
      bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
    });
    g.rotateX(-Math.PI / 2); // the shape's plane flat, its height up
    add(g, colour, 0, y0 + bevel, z);
  };
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
  return { box, rounded, wheel, done: () => mergeGeometries(parts) };
}

function busGeometry(S: CarSpec): THREE.BufferGeometry {
  const { box, rounded, wheel, done } = boxBuilder(S.color || '#c8102e');
  const L = S.L / 2, W = S.W, red = S.color || '#c8102e', white = '#eeeeea', glass = '#1b242c', grey = '#8a8f94';
  const small = S.L < 10;
  const sill = 1.15, top = small ? 2.3 : 2.55, roof = small ? 2.65 : 2.95;
  // Rounded at the corners, more at the front than the back.
  const nose = 0.3, tail = 0.16;
  rounded('#2a2c2f', -L + 0.05, L - 0.05, 0.28, 0.5, W - 0.02, [nose, tail]); // skirt and bumpers
  rounded(red, -L, L, 0.5, sill, W, [nose, tail]);
  rounded(glass, -L + 0.02, L - 0.02, sill, top, W - 0.06, [nose - 0.02, tail - 0.02]);
  // The roof stops short of the front, so from above the dark windscreen and line
  // board show which way the bus faces; its edges are rounded off.
  rounded(white, -L, L - 0.4, top, roof, W, [0.06, tail], 0.1);
  rounded('#141414', L - 0.4, L, top, roof - 0.08, W - 0.04, [nose, 0.01], 0.04);
  const ac = small ? 0.6 : 1;
  rounded('#9a9fa3', -3.3 * ac, 0.9 * ac, roof - 0.02, roof + 0.18, 1.8 * (small ? 0.85 : 1), 0.25, 0.05); // air conditioning
  rounded('#e2e4e2', -3.2 * ac, 0.8 * ac, roof + 0.1, roof + 0.3, 1.7 * (small ? 0.85 : 1), 0.2, 0.06);
  rounded('#9a9fa3', -L + 0.3, -L + 2.0, roof - 0.02, roof + 0.25, W - 0.55, 0.12, 0.05); // engine vents
  if (!small) {
    box('#b9bdbf', 1.9, 2.7, roof, roof + 0.06, 0.8); // roof hatches
    box('#b9bdbf', -5.0, -4.2, roof, roof + 0.06, 0.8);
  }
  // Pillars between the side windows (none where the doors are).
  const doors = small ? [L - 1.1, -L + 2.6] : [L - 1.35, 0.6, -3.8];
  for (let x = -L + 0.9; x < L - 2.2; x += 1.45) {
    if (doors.some((d) => Math.abs(x - d) < 0.9)) continue;
    box(white, x - 0.07, x + 0.07, sill, top, W + 0.01);
  }
  box(white, L - 2.25, L - 2.1, sill, top, W + 0.01);
  rounded(white, -L + 0.02, -L + 0.5, sill, top, W + 0.01, [0.005, tail]); // the back corners
  // Doors on the right (+z): glass nearly down to the kerb, a red frame round them.
  for (const d of doors) {
    box(red, d - 0.68, d + 0.68, 0.32, top, 0.04, W / 2);
    box('#26313a', d - 0.6, d + 0.6, 0.38, top - 0.08, 0.06, W / 2 + 0.005);
    box('#15191d', d - 0.02, d + 0.02, 0.38, top - 0.08, 0.08, W / 2 + 0.005);
  }
  // Front: a tall windscreen, the line board above it, headlamps; tail lamps at the back.
  // (Everything on the front and back stays inside the rounded corners.)
  box(glass, L - 0.05, L + 0.02, 0.9, top, W - 2 * nose);
  box('#141414', L - 0.04, L + 0.03, top + 0.04, roof - 0.06, W - 0.62);
  box('#ffb020', L - 0.03, L + 0.035, top + 0.1, roof - 0.12, W - 0.9);
  for (const z of [-1, 1]) {
    box('#fff6d8', L - 0.05, L + 0.03, 0.55, 0.72, 0.36, z * (W / 2 - nose - 0.2));
    box('#b3161b', -L - 0.03, -L + 0.05, 0.6, 1.1, 0.22, z * (W / 2 - tail - 0.13));
  }
  box(glass, -L - 0.02, -L + 0.05, 1.4, top - 0.1, W - 0.5);
  box('#e3e5e0', L - 0.03, L + 0.04, 0.3, 0.42, 0.52); // number plate
  // Wheels: two at the front, twin tyres at the back.
  wheel(L - (small ? 1.3 : 2.7), W);
  wheel(-L + (small ? 1.7 : 3.3), W);
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

// A fire engine from boxes, after the Prague brigade's water tenders: a red crew cab with
// a white band round it and a white bumper, aluminium roller shutters along the body, and
// on the roof what shows from above: a tread-plate deck inside a rail, the ladder, the
// suction hoses, a locker and the light bars. HASIČI on the front and chevrons at the back.
function fireGeometry(S: CarSpec): THREE.BufferGeometry {
  const { box, rounded, wheel, done } = boxBuilder(S.color || '#c4161c');
  const L = S.L / 2, W = S.W, red = S.color || '#c4161c', glass = '#1b242c', white = '#e9e9e4', alu = '#b4b9bd', dark = '#2a2c2f';
  const cab = 3.1, cx = L - cab, floor = 0.55, top = 2.95, cabTop = 3.05, axle = -L + 2.55, nose = 0.22;
  box(dark, -L + 0.05, L - 0.05, 0.3, floor, W - 0.3); // chassis
  rounded(red, -L, cx, floor, top, W, [0.005, 0.08], 0.04); // body
  rounded(red, cx, L, floor, cabTop, W, [nose, 0.005], 0.08); // cab, its front corners and roof edges rounded
  box(dark, cx - 0.03, cx + 0.03, floor + 0.1, top - 0.05, W + 0.01); // the gap between them
  box(glass, L - 0.05, L + 0.02, 1.75, cabTop - 0.2, W - 2 * nose - 0.04); // windscreen
  box(glass, L - 1.25, L - 0.3, 1.75, cabTop - 0.3, W + 0.02); // the front doors' windows
  box(glass, cx + 0.3, L - 1.55, 1.75, cabTop - 0.3, W + 0.02); // and the crew's
  box(dark, L - 0.05, L + 0.06, 0.9, 1.2, W - 0.7); // grille
  box(white, L - 0.05, L + 0.03, 1.2, 1.7, W - 2 * nose); // the band HASIČI is on
  rounded(white, L - 0.15, L + 0.2, 0.32, 0.88, W, nose); // bumper
  for (const side of [-1, 1]) {
    const z = side * W / 2;
    box(white, cx, L - nose, 1.25, 1.6, 0.03, z); // the band along the cab
    box('#e8d21a', -L, cx, 0.6, 0.7, 0.03, z); // reflective strip under the lockers
    // Three roller shutters, the one over the back wheels shorter.
    for (let i = 0; i < 3; i++) {
      const a = -L + 0.3 + i * 1.65, b = a + 1.55, low = a < axle && axle < b ? 1.3 : 0.78;
      box(alu, a, b, low, 2.6, 0.05, z);
      for (let y = low + 0.26; y < 2.5; y += 0.26) box('#8d9296', a, b, y, y + 0.025, 0.06, z); // slats
    }
    box(HEADLAMP, L + 0.15, L + 0.21, 0.5, 0.76, 0.36, side * (W / 2 - nose - 0.2));
    box(TAIL_LAMP, -L - 0.03, -L + 0.05, 0.7, 1.0, 0.22, side * (W / 2 - 0.2));
    // Mirrors on arms out past the cab's corners.
    box(dark, L - 0.25, L - 0.1, 2.5, 2.58, 0.3, side * (W / 2 + 0.1));
    box(dark, L - 0.22, L - 0.08, 1.9, 2.58, 0.12, side * (W / 2 + 0.2));
    // The roof's rail, and a post at the back for a blue lamp (beacons.ts).
    box('#c9cdd0', -L + 0.05, cx - 0.05, top, top + 0.22, 0.06, side * (W / 2 - 0.06));
    box(dark, -3.9, -3.7, top, 3.28, 0.3, side * 1.0);
    box('#1d4fa3', L - 0.72, L - 0.38, cabTop + 0.1, cabTop + 0.27, 0.75, side * 0.62); // the bar's blue lenses
  }
  // On the roof: the deck, the ladder on the right, two suction hoses on the left, a
  // locker, a hatch and the folded light mast between them.
  box('#a3a8ac', -L + 0.1, cx - 0.1, top, top + 0.03, W - 0.2);
  for (const x of [-L + 0.05, cx - 0.11]) box('#c9cdd0', x, x + 0.06, top, top + 0.22, W - 0.12);
  for (const z of [0.55, 0.95]) box('#d9dcde', -L + 0.7, cx - 0.4, top + 0.1, top + 0.2, 0.07, z);
  for (let x = -L + 0.85; x < cx - 0.45; x += 0.33) box('#c2c6c9', x - 0.025, x + 0.025, top + 0.12, top + 0.17, 0.4, 0.75);
  for (const z of [-0.6, -0.92]) {
    box('#33363a', -L + 0.5, cx - 0.9, top + 0.03, top + 0.18, 0.15, z);
    for (const x of [-L + 0.5, cx - 1.02]) box('#c4c8cb', x, x + 0.12, top + 0.03, top + 0.2, 0.17, z); // couplings
  }
  box('#8f9499', -L + 0.6, -L + 1.9, top + 0.03, top + 0.3, 0.6, -0.02);
  box('#d8d8d4', -1.2, -0.5, top + 0.03, top + 0.08, 0.6, -0.02);
  box('#55595d', 0, 0.85, top + 0.03, top + 0.2, 0.25, -0.02);
  // The cab's roof: a hatch, and the light bar across the front of it.
  box('#a8adb1', cx + 0.5, cx + 1.3, cabTop, cabTop + 0.05, 0.8);
  box('#1b1f2a', L - 0.75, L - 0.35, cabTop, cabTop + 0.1, W - 0.5);
  box('#dfe3e6', L - 0.7, L - 0.4, cabTop + 0.1, cabTop + 0.24, 0.45);
  // At the back the pump's shutter, and red and yellow chevrons under it.
  box(alu, -L - 0.02, -L + 0.03, 1.6, 2.6, W - 0.5);
  for (let i = 0; i < 6; i++) box(i % 2 ? '#e8d21a' : '#c4161c', -L - 0.04, -L + 0.04, 1.1, 1.5, (W - 0.3) / 6, -W / 2 + 0.15 + (i + 0.5) * ((W - 0.3) / 6));
  box('#e3e5e0', L + 0.17, L + 0.21, 0.36, 0.48, 0.52); // number plate
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
  wheel(axle, W, true);
  return done();
}

// An ambulance from boxes: a white van with a lime stripe, a green cross panel on each
// side, a light bar on the cab, double doors at the back and a ramp of tail lamps.
function ambulanceGeometry(S: CarSpec): THREE.BufferGeometry {
  const { box, rounded, wheel, done } = boxBuilder();
  const L = S.L / 2, W = S.W, white = '#f2f3ef', glass = '#1b242c', lime = '#b6d90f', green = '#12935a';
  const cx = L - 1.9, floor = 0.45, top = 2.55, roof = 2.7, nose = 0.24, tail = 0.08;
  box('#2a2c2f', -L + 0.05, L - 0.05, 0.3, floor, W - 0.3); // chassis and bumpers
  rounded(white, -L, cx, floor, roof, W, [0.005, tail], 0.07); // the box where the patient lies
  rounded(white, cx, L, floor, top, W, [nose, 0.005]); // cab
  rounded(white, cx, L - 0.6, top - 0.1, roof, W, 0.005, 0.07); // the roof carries on over the cab
  rounded(white, L - 0.6, L, top - 0.15, top, W - 0.1, [nose, 0.005], 0.05); // the sloping front of the roof
  box(glass, L - 0.05, L + 0.02, 1.35, top - 0.12, W - 2 * nose - 0.02); // windscreen
  box(glass, cx + 0.35, L - 0.55, 1.4, top - 0.18, W + 0.02); // cab side windows
  box('#2a2c2f', L - 0.05, L + 0.06, 0.65, 1.0, W - 0.5); // grille
  rounded('#2a2c2f', L - 0.1, L + 0.18, 0.3, 0.65, W - 0.05, nose); // front bumper
  box('#2a2c2f', cx + 0.1, cx + 1.1, roof, roof + 0.1, W - 0.9); // base of the light bar
  box('#9a9fa3', -L + 0.8, -L + 1.6, roof, roof + 0.12, W - 0.8); // roof vent
  for (const side of [-1, 1]) {
    box(lime, -L + tail, L - nose, 0.95, 1.2, 0.03, side * W / 2); // the stripe
    box(lime, -L + tail, L - nose, 1.55, 1.7, 0.03, side * W / 2);
    // A green panel with a white cross on the side of the box.
    box(green, -L + 1.0, cx - 0.9, 1.75, 2.35, 0.03, side * W / 2);
    box('#ffffff', -L + 1.6, -L + 2.4, 1.98, 2.12, 0.05, side * W / 2);
    box('#ffffff', -L + 1.93, -L + 2.07, 1.8, 2.3, 0.05, side * W / 2);
    box('#fff6d8', L - 0.05, L + 0.05, 0.65, 0.9, 0.32, side * (W / 2 - nose - 0.18)); // headlamps
    box('#b3161b', -L - 0.03, -L + 0.05, 0.8, 1.3, 0.2, side * (W / 2 - tail - 0.12)); // tail lamps
  }
  box('#9ea3a7', cx - 0.03, cx + 0.03, floor, top, W + 0.01); // the line between cab and box
  box('#9ea3a7', -L - 0.03, -L + 0.03, floor + 0.05, roof - 0.1, 0.04); // the join of the rear doors
  box('#d8dbd6', -L - 0.03, -L + 0.04, 1.35, 1.55, W - 0.3); // the band across the back
  box(lime, -L - 0.04, -L + 0.04, 0.95, 1.2, W - 0.05);
  box('#e3e5e0', L - 0.03, L + 0.04, 0.3, 0.42, 0.52); // number plate
  wheel(L - 1.1, W);
  wheel(-L + 1.2, W);
  return done();
}

// Lorries are boxes too: a cab in the paint colour and a white box or trailer behind
// it (with a stripe in the cab's colour), a dark chassis, tail lamps and a bar at the back.
// The artic is a tractor with a trailer, the box truck one rigid body.
function truckGeometry(type: string, S: CarSpec): THREE.BufferGeometry {
  const paint = '#ffffff';
  const { box, rounded, wheel, done } = boxBuilder(paint);
  const L = S.L / 2, W = S.W, glass = '#1b242c', artic = type === 'artic', nose = 0.22;
  const cab = artic ? 2.5 : 2.2, cabTop = artic ? 3.3 : 2.9, floor = artic ? 1.0 : 0.85, top = artic ? 4.0 : 3.6;
  const cx = L - cab; // where the cab starts
  box('#2a2c2f', -L, L, 0.35, floor, W - 0.5); // chassis
  rounded(paint, cx, L, floor - 0.2, cabTop, W, [nose, 0.005], 0.08); // cab
  box(glass, L - 0.05, L + 0.02, floor + 0.65, cabTop - 0.2, W - 2 * nose - 0.04); // windscreen
  box(glass, cx + 0.5, L - 0.4, floor + 0.7, cabTop - 0.25, W + 0.02); // side windows
  if (artic) rounded(paint, cx + 0.05, cx + 0.6, cabTop - 0.05, cabTop + 0.5, W - 0.3, 0.15, 0.08); // roof deflector
  rounded('#2a2c2f', L - 0.1, L + 0.15, 0.35, 0.75, W - 0.1, nose); // bumper
  const bx = artic ? cx - 0.9 : cx - 0.1; // the box's front end
  rounded('#e6e7e3', -L, bx, floor, top, W, 0.06, 0.05); // box or trailer, its edges just rounded off
  rounded(paint, -L, bx, floor + 0.7, floor + 1.05, W + 0.01, 0.06); // stripe
  box('#9a9fa3', -L, -L + 0.06, floor + 0.15, top - 0.15, W - 0.3); // rear doors
  for (const z of [-1, 1]) {
    box('#fff6d8', L - 0.05, L + 0.05, floor - 0.1, floor + 0.2, 0.36, z * (W / 2 - nose - 0.2));
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
  Plate: '#e3e5e0', Sign: '#fff4c2', Blue: '#1d4fa3', Yellow: '#d4e02b', Bar: '#1b1f2a', Seat: '#3a393b',
};
let bodies: THREE.Object3D | null = null;
export async function loadCars(url = 'cars.glb') {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  bodies = gltf.scene;
}

// How much of its own colour a lamp that's on gives off.
export const LAMP_GLOW = 1.6;
// Painted metal, not matte: the sun catches the roof, the bonnet and the windscreen as they
// tilt towards it (CAR_PAINT), on top of the gloss below.
export const CAR_PAINT = { specular: 0.22, shininess: 45 };
const material = new THREE.MeshPhongMaterial({ vertexColors: true, specular: new THREE.Color().setScalar(CAR_PAINT.specular), shininess: CAR_PAINT.shininess });
// The bodies are open shells, not closed solids. three.js draws only the back faces into the
// shadow map by default, so the roof and bonnet (front faces from the sun) cast nothing and
// the shadow comes out as a hollow outline.
material.shadowSide = THREE.DoubleSide;
// The paint and the glass have a gloss: what faces up mirrors a little of the sky and of the
// lamps' light, and what's seen at a slant (the sides, the edges of the roof and the bonnet)
// mirrors more of it, as a car's clear coat does; all of it more when it's wet, when the paint
// is a little darker too (the same in TSL: webgpu/vehicles.ts).
// The glass mirrors `glass` times as much as the paint: from above, a windscreen and a rear
// window that catch the sky are what make a car read as a car, not a dark slab.
export const CAR_GLOSS = { dry: 0.25, sky: 0.5, lamps: 0.12, rim: [0.5, 0.8], rimSky: 4, rimLamps: 0.3, darker: 0.85, glass: 3.5 };
// What the paint and glass mirror (CAR_MIRROR 1; 0 is the plain tint of the sky above, for
// comparing): a street round the car, looked up by the direction each point reflects (plan
// 037). Above the street's walls the sky, lighter towards the horizon, with a glint where the
// sun is; along the horizon a darker band for the buildings and trees, its top edge uneven;
// below it the street. `top` is how much a surface facing the camera mirrors, `side` how
// much more one seen at a slant does, `wet` how much more of both in the rain; the band's
// top is `edge` (the sine of its height) give or take `ragged`.
export const CAR_MIRROR = { value: 1 };
export const CAR_REFLECT = { top: 0.32, side: 2.4, wet: 1.5, edge: 0.17, ragged: 0.09, horizon: 2.4, zenith: 1.3, glint: 0.08, sharp: 400 };
// The strips of real-looking streets (reflections.ts) cover from below the horizon up to
// `stripTop` (the tangent of the top's height, 35°), the horizon `stripHorizon` of the way
// down each; `stripGain` brings their colours to the light of the made-up street.
export const CAR_STRIPS = { stripTop: 0.7, stripHorizon: 0.806, stripGain: 3.5, kinds: KINDS.length };
// A car's kind of area rides in paint.w above its lamps (256 a step), and in the vertex
// stage into vLit, 4 a step, so it needs no varying of its own.
export const AREA_STEP = 256;
const R = CAR_REFLECT, CS = CAR_STRIPS;
const COAT_GLSL = /* glsl */ `
uniform float uWet, uMirror, uStripsOn;
uniform vec3 uSkyRef, uStreetRef, uSunDir, uSunLight;
uniform sampler2D uStrips;
float carTop(vec3 n) { return smoothstep(.35, .9, dot(n, (viewMatrix * vec4(0., 1., 0., 0.)).xyz)); }
// The street round the car, seen in the direction r (world), in the car's kind of area.
vec3 carStreet(vec3 r, float area) {
  float a = atan(r.z, r.x);
  float edge = ${R.edge.toFixed(3)} + ${R.ragged.toFixed(3)} * (.55 * sin(a * 5.) + .3 * sin(a * 13. + 1.7) + .15 * sin(a * 31. + .4));
  vec3 sky = uSkyRef * mix(${R.horizon.toFixed(2)}, ${R.zenith.toFixed(2)}, smoothstep(.1, .9, r.y));
  vec3 walls = uStreetRef * mix(.75, 1.05, smoothstep(-.02, edge, r.y));
  vec3 ground = uStreetRef * .5, above = smoothstep(-.06, 0., r.y);
  vec3 c = mix(ground, mix(walls, sky, smoothstep(edge - .015, edge + .015, r.y)), above);
  if (uStripsOn > .5) {
    float t = r.y / max(length(r.xz), .001) / ${CS.stripTop.toFixed(3)};
    float v = ${CS.stripHorizon.toFixed(3)} * (1. - t);
    vec4 s = texture2D(uStrips, vec2(a / 6.2832 + .5, 1. - (area + clamp(v, .01, .99)) / ${CS.kinds.toFixed(1)}));
    s.a *= step(0., v);
    vec3 street = s.rgb * dot(uStreetRef, vec3(.3, .59, .11)) * ${CS.stripGain.toFixed(2)};
    c = mix(mix(ground, sky, above), street, v > 1. ? 0. : s.a);
    c = v > 1. ? ground : c;
  }
  return c + uSunLight * pow(max(dot(r, uSunDir), 0.), ${R.sharp.toFixed(1)}) * ${R.glint.toFixed(3)};
}
vec3 carCoat(vec3 c, vec3 n, vec3 v, vec3 lamp, float area) {
  float glass = dot(c, vec3(.3, .59, .11)) < .04 && c.b > c.r * 1.25 ? ${CAR_GLOSS.glass.toFixed(2)} : 1.;
  float coat = mix(${CAR_GLOSS.dry.toFixed(2)}, 1., uWet) * glass * carTop(n);
  float slant = 1. - max(dot(n, v), 0.), rim = slant * slant * slant * slant * mix(${CAR_GLOSS.rim[0].toFixed(2)}, ${CAR_GLOSS.rim[1].toFixed(2)}, uWet) * glass;
  vec3 tint = uSkyRef * ${CAR_GLOSS.sky.toFixed(1)} * coat + uSkyRef * ${CAR_GLOSS.rimSky.toFixed(1)} * rim;
  vec3 r = (vec4(reflect(-v, n), 0.) * viewMatrix).xyz;
  float s4 = slant * slant * slant * slant;
  vec3 mirrored = carStreet(r, area) * (${R.top.toFixed(2)} + ${R.side.toFixed(2)} * s4) * glass * mix(1., ${R.wet.toFixed(2)}, uWet);
  return mix(tint, mirrored, uMirror) + lamp * (${CAR_GLOSS.lamps.toFixed(2)} * coat + ${CAR_GLOSS.rimLamps.toFixed(2)} * rim);
}`;
// Snow settles on the roofs and bonnets (weather.ts).
material.onBeforeCompile = (sh) => {
  lampLit(sh);
  // An open door turns about its hinge (the same in TSL: webgpu/vehicles.ts).
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', `#include <common>
attribute float painted;
attribute vec4 paint;
attribute vec3 hinge;
attribute vec4 doors;
varying float vLit;
vec2 swing(vec2 p) {
  if (hinge.z < .5) return p;
  float a = hinge.z < 1.5 ? -doors.x : hinge.z < 2.5 ? doors.y : hinge.z < 3.5 ? -doors.z : doors.w;
  float c = cos(a), s = sin(a);
  return vec2(p.x * c + p.y * s, p.y * c - p.x * s);
}`)
    // A lamp: dark when it's broken, glowing when it's on (the same in TSL: webgpu/vehicles.ts).
    .replace('#include <color_vertex>', `#include <color_vertex>
float lamp = floor(painted * .5 + .01);
vColor.rgb *= mix(vec3(1.), paint.rgb, painted - 2. * lamp);
vLit = 0.;
if (lamp > .5) {
  float tail = mod(floor(paint.w / 32.), 4.);
  vLit = lamp < 2.5 ? mod(floor(paint.w / 16.), 2.) : tail > 1.5 ? 1.5 : tail * .45;
  if (mod(floor(paint.w / exp2(lamp - 1.)), 2.) > .5) { vLit = -1.; vColor.rgb = vec3(.05, .05, .055); }
}
vLit += 4. * floor(paint.w / ${AREA_STEP}.);`)
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal.xz = swing(objectNormal.xz);')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xz = hinge.xy + swing(transformed.xz - hinge.xy);');
  sh.uniforms.uSnow = SNOW;
  Object.assign(sh.uniforms, { uWet: WET, uSkyRef: SKY_REF, uStreetRef: STREET_REF, uSunDir: SUN_DIR, uSunLight: SUN_LIGHT, uMirror: CAR_MIRROR, uStrips: STRIPS, uStripsOn: STRIPS_ON });
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform float uSnow;\nvarying float vLit;\n${COAT_GLSL}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  float area = floor((vLit + 1.5) / 4.), lit = vLit - 4. * area;
  totalEmissiveRadiance += diffuseColor.rgb * max(lit, 0.) * ${LAMP_GLOW.toFixed(2)};`)
    .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  if (uSnow > .01) {
    float up = dot(normal, (viewMatrix * vec4(0., 1., 0., 0.)).xyz);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.8, .82, .86), smoothstep(.75, .95, up) * smoothstep(.1, .6, uSnow) * .6);
  }
  vec3 coatC = diffuseColor.rgb;
  diffuseColor.rgb *= mix(1., ${CAR_GLOSS.darker.toFixed(2)}, uWet * carTop(normal));`)
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directDiffuse += carCoat(coatC, normal, normalize(vViewPosition), lampLightOn(vLampW, normal), area);');
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
  paint: string;
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
  // The radio station last tuned in this car (an index in STATIONS, -1 for off), heard again when you get back in.
  radio?: number;
  // Doors that are open or moving: how far each is open, then how far it's meant to be
  // (radians; undefined while all are shut).
  door?: Float32Array;
  // How hard the back and front tyres scrub the road (0–1), for their marks (skids.ts).
  skidBack = 0; skidFront = 0;
  // Which lamps are smashed (bits of LAMP), and whether the brake lights are on.
  broken = 0;
  braking = false;
  // A police car with the frame on its nose, which keeps its headlamps from breaking.
  ram?: boolean;
  // The resting index's last obstacle state (main.ts, restingCars.ts). The pose is
  // kept as plain numbers; the circle offsets are the constructor's own array, so a
  // change of shape must replace the array to be noticed.
  _tx?: number; _ty?: number; resting?: boolean; restAt?: [number, number, number];
  restFields?: { gz?: number; r: number; vx: number; vy: number; offsetsRef: readonly number[]; n: number };
  stamp?: number;

  constructor(type: string, r: () => number, x = 0, y = 0, h = 0, colour?: string, box?: string) {
    this.type = type;
    this.spec = TYPES[type];
    const paints = TWO_PAINT[type] || PAINT;
    // Keep the colour pick before refitting, even for a fixed or explicit colour.
    const pick = paints[Math.floor(r() * paints.length)], paint = colour || this.spec.color || pick;
    this.refit(r);
    this.mass = this.spec.mass;
    this.paint = this.spec.color || paint;
    this.key = bodyKey(type, box);
    carGeometry(type, box);
    this.courier = box;
    this.x = x;
    this.y = y;
    this.h = h;
    this.vx = this.vy = this.w = 0;
    this.mode = 'loose'; // 'traffic' (driven by AI), 'loose' (free body), 'player', 'police' (chasing you), 'fire' (an engine or an ambulance on call)
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

  get modelName() { return this.variant ? `${this.variant.make}|${this.variant.model}|${this.variant.engine}` : null; }
  get speed() { return Math.hypot(this.vx, this.vy); }
  get two() { return this.spec.two; }
  // Someone at the wheel: the player, or the police chasing them.
  get driven() { return this.mode === 'player' || this.mode === 'police' || this.mode === 'fire'; }
  get forwardSpeed() { return this.vx * Math.cos(this.h) + this.vy * Math.sin(this.h); }

  get doors() { return doorsOf(this.type); }

  // Called as a door swings shut (the game plays the slam).
  static onShut?: (car: Car) => void;

  // Opens or shuts door n.
  open(n: number, on = true) {
    if (!on && !this.door) return;
    this.door ||= new Float32Array(8);
    this.door[3 + n] = on ? DOOR_OPEN : 0;
  }

  // How far open door n is, 0 to 1.
  ajar(n: number) { return this.door ? this.door[n - 1] / DOOR_OPEN : 0; }

  // The doors swing towards where they're meant to be; a car that pulls away shuts them, at a
  // walking pace already (a patrol car moving off with its officer left behind used to crawl
  // along with the doors open until it reached 15 km/h).
  swing(dt: number) {
    const d = this.door;
    if (!d) return;
    let open = 0;
    for (let i = 0; i < 4; i++) {
      if (this.speed > 1.5) d[4 + i] = 0;
      const was = d[i];
      d[i] += clamp(d[4 + i] - d[i], -DOOR_SPEED * dt, DOOR_SPEED * dt);
      if (was > 0 && d[i] <= 0) Car.onShut?.(this);
      open += d[i] + d[4 + i];
    }
    if (!open) this.door = undefined;
  }

  // Where on the ground you stand to use a door, and where its seat is.
  beside(door: Door, out = 0.55): Point2 { return this.local((door.front + door.back) / 2 - 0.25, door.side * (this.spec.W / 2 + out)); }
  seat(door: Door): Point2 { return this.local((door.front + door.back) / 2 - 0.1, door.side * this.spec.W * 0.24); }
  local(along: number, left: number): Point2 {
    const c = Math.cos(this.h), s = Math.sin(this.h);
    return [this.x + c * along - s * left, this.y + s * along + c * left];
  }

  // Fits the ram frame (a police car's).
  armour() {
    if (this.ram || this.burnt) return;
    this.ram = true;
    this.broken &= ~(LAMP.headLeft | LAMP.headRight);
    this.key = bodyKey(this.type, RAM);
    carGeometry(this.type, RAM);
  }

  // Something hit the car at (x, y) at `force` m/s: a lamp the blow lands on is smashed.
  // The harder the knock, the further from it a lamp still breaks.
  knock(x: number, y: number, force: number) {
    if (this.two || force < BREAKS || this.broken === 15) return;
    const c = Math.cos(this.h), s = Math.sin(this.h), dx = x - this.x, dy = y - this.y;
    const L = this.spec.L / 2, W = this.spec.W / 2;
    const along = clamp(dx * c + dy * s, -L, L), left = clamp(dy * c - dx * s, -W, W);
    // (A wall met nose first is first touched with one corner: at 60 km/h the blow still
    // reaches the lamp at the other one, at 50 it doesn't.)
    const reach = Math.min(1.7, 0.5 + 0.1 * (force - BREAKS)) * Math.max(1, W / 0.95);
    for (const [bit, a, l] of [[LAMP.headLeft, L, W - 0.3], [LAMP.headRight, L, 0.3 - W], [LAMP.tailLeft, -L, W - 0.3], [LAMP.tailRight, -L, 0.3 - W]]) {
      if (this.ram && a > 0) continue;
      if (Math.hypot(along - a, left - l) < reach) this.broken |= bit;
    }
  }

  // Choose (or choose again) which model of its type this is, by the variants' weights.
  refit(r: () => number, app = false) {
    const options = VARIANTS[this.type];
    if (!options) return;
    const w = (v: Variant) => (app && this.type === 'taxi' ? v.app ?? 0 : v.freq);
    let x = r() * options.reduce((a, v) => a + w(v), 0);
    this.variant = options.find((v) => w(v) > 0 && (x -= w(v)) < 0) ?? options[0];
    this.spec = tuned(this.type, this.variant);
    this.mass = this.spec.mass;
  }

  // Be this model of the type (a saved game's), written as `make|model|engine`, if there is one.
  setVariant(name: string) {
    const v = VARIANTS[this.type]?.find((o) => `${o.make}|${o.model}|${o.engine}` === name);
    if (!v) return;
    this.variant = v;
    this.spec = tuned(this.type, v);
    this.mass = this.spec.mass;
  }

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
    this.braking = this.driven && ((throttle < 0 && vf > 0.3) || (throttle > 0 && vf < -0.3) || (ctl.handbrake && Math.abs(vf) > 0.3)
      || (ctl.cap != null && vf > ctl.cap + 0.5));

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
    this.knock(cx / hits, cy / hits, -vn);
    return -vn;
  }

  // Takes the courier's box off, or puts one (a colour from COURIER_BOXES) on, a bike or moped.
  setBox(box?: string) {
    if (!this.spec.two || this.burnt) return;
    this.courier = box;
    this.key = bodyKey(this.type, box);
    carGeometry(this.type, box);
  }

  // Charred: the same body, drawn nearly black (one wreck colour for each type).
  burn() {
    const fit = this.courier ?? (this.ram ? RAM : undefined);
    const k = `${this.type}${this.ram ? '|ram' : ''}|burnt`;
    if (!cache.has(k)) {
      const g = carGeometry(this.type, fit).clone(), col = g.getAttribute('color');
      const painted = g.getAttribute('painted'), paint = new THREE.Color(this.paint);
      if (col) for (let i = 0; i < col.count; i++) {
        // Reproduce the old baked colour before charring the first wreck of a type.
        const tint = painted.getX(i) === 1 ? 1 : 0;
        const v = 0.02 + 0.05 * (col.getX(i) * (1 + (paint.r - 1) * tint)
          + col.getY(i) * (1 + (paint.g - 1) * tint) + col.getZ(i) * (1 + (paint.b - 1) * tint)) / 3;
        col.setXYZ(i, v, v, v * 1.05);
      }
      painted.array.fill(0);
      cache.set(k, g);
    }
    this.key = k;
    this.burnt = true;
    this.braking = false;
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
  if (to) {
    g.font = 'bold 54px sans-serif';
    g.fillText(ref, 10, 35, 170);
    g.font = 'bold 40px sans-serif';
    g.fillText(to, 190, 35, 312);
  } else {
    // The front board is for the number alone, readable as the bus approaches.
    g.textAlign = 'center';
    g.font = 'bold 58px sans-serif';
    g.fillText(ref, 256, 35, 480);
  }
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
const boardPlacement = (type: 'bus' | 'minibus') => {
  const spec = TYPES[type], L = spec.L / 2, W = spec.W, small = type === 'minibus', m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const top = small ? 2.3 : 2.55, roof = small ? 2.65 : 2.95;
  const front = m.clone().compose(new THREE.Vector3(L + 0.045, (top + roof) / 2, 0), q.clone().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), s.clone().set(W - 0.5, roof - top - 0.06, 1));
  const side = m.clone().compose(new THREE.Vector3(L - (small ? 2.4 : 3.4), top - 0.17, W / 2 + 0.05), q.clone(), s.clone().set(small ? 1.6 : 2, 0.28, 1));
  // On the roof between the hatch and the front, lying flat, reading from the front.
  const flat = new THREE.Matrix4().compose(new THREE.Vector3(L - (small ? 1.2 : 1.95), roof + 0.005, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, -Math.PI / 2, 0, 'YXZ')), new THREE.Vector3(small ? 1.8 : 2.2, small ? 0.9 : 1.1, 1));
  return { boards: [front, side], roof: flat };
};
const BOARD_AT = { bus: boardPlacement('bus'), minibus: boardPlacement('minibus') };

// Every car is an instance: one draw per type/page, with paint per instance.
// Riders are drawn here too, sitting on their bikes.
// What a parked car's matrix was worked out from: the ground (the height function and
// the terrain's revision), where the car is and how it's turned, and how the tiles
// track it (TileWorld.track). The same again means the same matrix.
interface Placing {
  m: number[]; height: unknown; terrain: number;
  x: number; y: number; h: number; lean: number; L: number; W: number;
  level?: number; gz?: number; hint?: string; grounded?: boolean; tx?: number; ty?: number; e?: unknown;
}

function placed(p: Placing, c: Car, height: unknown, terrain: number) {
  const t = c as Car & { _tx?: number; _ty?: number; e?: unknown };
  return p.height === height && p.terrain === terrain && p.x === c.x && p.y === c.y && p.h === c.h && p.lean === c.lean &&
    p.L === c.spec.L && p.W === c.spec.W && p.level === c.level && p.gz === c.gz && p.hint === c.hint &&
    p.grounded === c.grounded && p.tx === t._tx && p.ty === t._ty && p.e === t.e;
}

// Notes a matrix for reuse (in `p`, if there is one already), unless something in it
// isn't a number.
function place(p: Placing | undefined, c: Car, height: unknown, terrain: number, m: THREE.Matrix4): Placing | undefined {
  if (!m.elements.every(Number.isFinite)) return undefined;
  const t = c as Car & { _tx?: number; _ty?: number; e?: unknown };
  p ??= { m: new Array(16), height, terrain, x: 0, y: 0, h: 0, lean: 0, L: 0, W: 0 };
  m.toArray(p.m);
  p.height = height; p.terrain = terrain; p.x = c.x; p.y = c.y; p.h = c.h; p.lean = c.lean; p.L = c.spec.L; p.W = c.spec.W;
  p.level = c.level; p.gz = c.gz; p.hint = c.hint; p.grounded = c.grounded; p.tx = t._tx; p.ty = t._ty; p.e = t.e;
  return p;
}

export class CarPool {
  scene: THREE.Scene;
  // 128 cars (8 KiB of matrices); overflow retains the original page.
  static readonly pageCapacity = 128;
  meshes: Map<string, THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>[]>;
  prepared = new Set<string>();
  overflowPages = 0;
  latePages = 0;
  groups: Map<string, Car[]>;
  dummy: THREE.Object3D;
  riders: Figures;
  scale: THREE.Matrix4;
  m: THREE.Matrix4;
  boards: THREE.Mesh[] = [];
  private colours = new Map<string, THREE.Color>();
  private hingeless = new WeakMap<THREE.BufferGeometry, THREE.BufferAttribute>();
  // Each parked four-wheeler's matrix and what it was worked out from (see placed).
  private placings = new WeakMap<Car, Placing>();
  // The kind of area at a place (reflections.ts; main.ts sets it), and each car's, looked
  // up again once it has gone some way.
  area: ((x: number, y: number) => number) | null = null;
  private areas = new WeakMap<Car, { x: number; y: number; k: number }>();

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

  private page(key: string) {
    const body = cache.get(key);
    if (!body) throw new Error(`Missing car geometry: ${key}`);
    // Each page owns its paint buffer; fixed vertex/index buffers are shared.
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(body.index);
    for (const [name, attr] of Object.entries(body.attributes)) {
      (attr as THREE.BufferAttribute & { shared?: boolean }).shared = true;
      geometry.setAttribute(name, attr);
    }
    if (body.index) (body.index as THREE.BufferAttribute & { shared?: boolean }).shared = true;
    const paint = new THREE.InstancedBufferAttribute(new Float32Array(CarPool.pageCapacity * 4).fill(1), 4);
    geometry.setAttribute('paint', paint);
    // (Bodies without doors still need the attributes the shader reads.)
    if (!body.getAttribute('hinge')) {
      let hinge = this.hingeless.get(body);
      if (!hinge) {
        hinge = new THREE.BufferAttribute(new Float32Array(body.getAttribute('position').count * 3), 3);
        (hinge as THREE.BufferAttribute & { shared?: boolean }).shared = true;
        this.hingeless.set(body, hinge);
      }
      geometry.setAttribute('hinge', hinge);
    }
    geometry.setAttribute('doors', new THREE.InstancedBufferAttribute(new Float32Array(CarPool.pageCapacity * 4), 4));
    const mesh = mirrored(new THREE.InstancedMesh(geometry, material, CarPool.pageCapacity));
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = true;
    // And in the shade of the buildings and trees they're in it too.
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = depthMaterial;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    const pages = this.meshes.get(key) || [];
    pages.push(mesh);
    this.meshes.set(key, pages);
    return mesh;
  }

  private areaOf(c: Car) {
    if (!this.area) return 0;
    const was = this.areas.get(c);
    if (was && Math.abs(c.x - was.x) + Math.abs(c.y - was.y) < 25) return was.k;
    const k = this.area(c.x, c.y);
    this.areas.set(c, { x: c.x, y: c.y, k });
    return k;
  }

  prepare(bodies: readonly CarBody[]) {
    for (const { type, box, pages = 1 } of bodies) {
      const key = bodyKey(type, box);
      carGeometry(type, box);
      while ((this.meshes.get(key)?.length || 0) < pages) this.page(key);
      this.prepared.add(key);
    }
  }

  // Compile the actual retained meshes with a valid instance, then restore every
  // count and matrix even if the renderer's guarded compile times out.
  async warm(compile: () => Promise<unknown>) {
    const saved: { mesh: THREE.InstancedMesh; count: number; visible: boolean; matrix: number[] }[] = [];
    try {
      for (const pages of this.meshes.values()) for (const mesh of pages) {
        saved.push({ mesh, count: mesh.count, visible: mesh.visible, matrix: Array.from(mesh.instanceMatrix.array.slice(0, 16)) });
        mesh.setMatrixAt(0, this.m.identity());
        mesh.count = 1;
        mesh.visible = true;
        sendInstances(mesh);
      }
      await compile();
    } finally {
      for (const { mesh, count, visible, matrix } of saved) {
        mesh.instanceMatrix.array.set(matrix, 0);
        mesh.count = count;
        mesh.visible = visible;
        if (count) sendInstances(mesh);
      }
    }
  }

  get matrixBytes() {
    return [...this.meshes.values()].reduce((sum, pages) => sum + pages.reduce((n, page) => n + page.instanceMatrix.array.byteLength, 0), 0);
  }

  // `height(x, y, car)`: the height of the ground (or the bridge deck) under a car's
  // wheels; cars sit on it, pitched and rolled to the slope. `terrain` goes up whenever
  // what `height` reads changes (TileWorld.terrainRevision); with it, a parked car that
  // hasn't moved keeps its matrix instead of sampling the ground again every frame.
  render(cars: Car[], height: ((x: number, y: number, car: Car) => number) | null = null, dt = 0, terrain?: number) {
    for (const c of cars) {
      if (c.two) this.lean(c, dt);
      else if (c.door) c.swing(dt);
    }
    for (const list of this.groups.values()) list.length = 0;
    for (const c of cars) {
      if (!this.groups.has(c.key)) this.groups.set(c.key, []);
      this.groups.get(c.key)!.push(c);
    }
    const d = this.dummy;
    let riders = 0, nb = 0;
    // By night the cars that are driving have their lamps on (as in lamps.ts); the brake
    // lights show by day as well.
    const night = LAMP_ON.value > 0.005;
    for (const [k, list] of this.groups) {
      let pages = this.meshes.get(k);
      if (!pages) { this.latePages++; this.page(k); pages = this.meshes.get(k)!; }
      while (pages.length * CarPool.pageCapacity < list.length) { this.page(k); this.overflowPages++; }
      list.forEach((c, i) => {
        const m = pages[Math.floor(i / CarPool.pageCapacity)];
        const slot = i % CarPool.pageCapacity;
        const keep = height && terrain !== undefined && !c.two && c.mode === 'loose';
        const was = keep ? this.placings.get(c) : undefined;
        if (was && placed(was, c, height!, terrain!)) d.matrix.fromArray(was.m);
        else {
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
          // Noted after the ground was sampled, which tracks the car (level, gz, …).
          if (keep) {
            const p = place(was, c, height!, terrain!, d.matrix);
            if (p) this.placings.set(c, p); else this.placings.delete(c);
          }
        }
        m.setMatrixAt(slot, d.matrix);
        let paint = this.colours.get(c.paint);
        if (!paint) { paint = new THREE.Color(c.paint); this.colours.set(c.paint, paint); }
        const on = night && !c.burnt && !(c.mode === 'loose' && c.speed < 0.5);
        const lamps = c.broken + (on ? 16 : 0) + (c.braking && c.mode !== 'loose' ? 64 : on ? 32 : 0) + AREA_STEP * this.areaOf(c);
        (m.geometry.getAttribute('paint') as THREE.InstancedBufferAttribute).setXYZW(slot, paint.r, paint.g, paint.b, lamps);
        if (c.rider && riders < this.riders.capacity) this.ride(c, riders++, d.matrix, dt);
        const ref = c.line?.ref.trim();
        if (ref && !c.burnt && (c.type === 'bus' || c.type === 'minibus')) {
          const at = BOARD_AT[c.type === 'minibus' ? 'minibus' : 'bus'];
          this.board(nb++, boardMaterial(ref, ''), d.matrix, at.boards[0]);
          this.board(nb++, boardMaterial(ref, c.line!.to), d.matrix, at.boards[1]);
          this.board(nb++, roofMaterial(ref), d.matrix, at.roof);
        }
      });
      for (let i = 0; i < pages.length; i++) {
        const m = pages[i];
        m.count = Math.max(0, Math.min(CarPool.pageCapacity, list.length - i * CarPool.pageCapacity));
        m.visible = m.count > 0;
        sendInstances(m);
        send(m.geometry.getAttribute('paint') as THREE.InstancedBufferAttribute, m.count);
        // The doors only while one on this page is open, and once more after the last has shut.
        const from = i * CarPool.pageCapacity;
        let open = false;
        for (let k = 0; k < m.count && !open; k++) open = !!list[from + k].door;
        if (open || m.userData.open) {
          const doors = m.geometry.getAttribute('doors') as THREE.InstancedBufferAttribute;
          for (let k = 0; k < m.count; k++) {
            const d = list[from + k].door;
            doors.setXYZW(k, d ? d[0] : 0, d ? d[1] : 0, d ? d[2] : 0, d ? d[3] : 0);
          }
          send(doors, m.count);
        }
        m.userData.open = open;
      }
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

// Where the last two bodies that collided met.
export const contact = { x: 0, y: 0 };
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
  contact.x = best.px;
  contact.y = best.py;
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
