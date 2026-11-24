import { GLYPHS, letteringGeometry } from './vehicleLettering.ts';
import { StreetHandling, ROLL_CENTRE } from './streetHandling.ts';
import { KEEP, STREET_QUALITY } from './streetQuality.ts';
import { drivingSpec } from './driveTune.ts';
import { Rollover, SCRAPE, tripSpeed } from './rollover.ts';
import { busCabin, commercialCab } from './commercialCab.ts';
import { twoWheelerStreet } from './twoWheelerStreet.ts';
import { CycleCranks } from './cycleCranks.ts';
import * as THREE from 'three';
import { SeatedDrivers, passengerCabin } from './passengerCabin.ts';
import { buildStreetWheels } from './streetWheels.ts';
import { sedanFinish, sedanInstruments, sedanWeave } from './sedanFinish.ts';
import { registrationAtlas, registrationFaces } from './registrationPlates.ts';
import { fireEngineStreet } from './fireEngineStreet.ts';
import { ambulanceStreet } from './ambulanceStreet.ts';
import { mirrored } from './mirror.ts';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from './network.ts';
import type { RoadHint } from './roadLevels.ts';
import { Figures, Anim, SCALE, FIGURE_SIZE } from './figures.ts';
import type { FigureKit, Look } from './figures.ts';
import type { Point2 } from './map/geo.ts';
import { posts } from './posts.ts';
import { fences } from './fences.ts';
import { crash } from './impacts.ts';
import type { ImpactKind } from './impacts.ts';
import { TreeEscape } from './treeEscape.ts';
import type { TreeTrunk } from './contracts.ts';
import { lampLit, LAMP_ON } from './lamps.ts';
import { SNOW, STREET_SNOW, WET, SKY_REF, STREET_REF, SUN_DIR, SUN_LIGHT } from './shading.ts';
import { send, sendInstances } from './gpu.ts';
import { softShade } from './surface.ts';
import { KINDS, STRIPS, STRIPS_ON } from './reflections.ts';
import { PROBE_AT, PROBE_K, PROBE_MAP, PROBE_MIX, PROBE_NEAR, PROBE_PREV } from './probe.ts';

// VR (vr.ts): the car you drive, and where your eyes are in it this frame (three.js world
// coordinates; `frame` equals `frames` when the street model's seat placed them this frame).
export const VR_SEAT = { car: null as Car | null, eye: new THREE.Vector3(), frame: -1, frames: 0 };
// The box-built vehicles have no seat to read: how far behind the front the driver's eyes
// are, and how high above the road (from the cabs built below; the driver sits on the left).
export const VR_CAB: Record<string, [number, number]> = {
  bus: [1.1, 1.95], minibus: [1.05, 1.85], truck: [0.95, 2.3], artic: [1, 2.45],
  garbage: [1, 2.35], fire: [0.95, 2.4], ambulance: [1.85, 1.95],
};
// The car you drive in VR leaves out its glass when seen from inside it: where it stands
// (three.js x, height of its middle, z and its heading) and how far it reaches (half its
// length and width, half its height, and 1 while it is on).
export const VR_GLASS = { at: { value: new THREE.Vector4() }, box: { value: new THREE.Vector4() } };

// Inverse chassis rotation for the one sprung player car. Its instance marks
// the registration negative so the other cars in the same draw keep their pose.
export const WHEEL_LEVEL = { value: new THREE.Vector4(0, 0, 0, 1) };

export interface CarSpec {
  headlights?: { forward: number; across: number; height: number; glow: number; streetReach?: number };
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
  trunkAt?: (x: number, y: number) => TreeTrunk | undefined;
}
// (`upset`: told of the turn a blow gave it, `dw`, landing (rx, ry) from its middle; see Car.upset.)
// (`jolted`: told of the change of speed (m/s) a blow gave it, for a rollover; see Car.jolted.)
export interface Body { x: number; y: number; vx: number; vy: number; w?: number; upset?(rx: number, ry: number, dw: number): void; jolted?(dvx: number, dvy: number): void }

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
  fire: { L: 8.5, W: 2.5, H: 3.2, headlights: { forward: 4.32, across: .75, height: .71, glow: .38 }, mass: 14000, accel: 2.4, vmax: 25, grip: 7, turn: 1.3, weight: 0, traffic: 0, color: '#c4161c', heavy: true, wheelbase: 5, drive: 'rwd', radius: 8.5, response: 4, brake: 8, fade: 0.3, drag: 0.4, reverse: 0.2, tough: 6, weather: 1.15 },
  // An ambulance: src/ambulance.ts sends these to people lying hurt. Never parked or in traffic.
  ambulance: { L: 6, W: 2.1, H: 2.7, headlights: { forward: 2.96, across: 0.74, height: 1.085, glow: 0.42 }, mass: 3200, accel: 5.5, vmax: 30, grip: 8, turn: 1.8, weight: 0, traffic: 0, color: '#e6dc24', wheelbase: 3.6, drive: 'rwd', radius: 6, response: 6, brake: 11, tough: 4.5, drag: 0.5, weather: 1.1 },
  // A dustcart: src/refuse.ts keeps one or two on their rounds in the centre. Never parked or in the ordinary mix.
  garbage: { L: 9.6, W: 2.5, H: 3.3, mass: 18000, accel: 2, vmax: 22, grip: 7, turn: 1.3, weight: 0, traffic: 0, color: '#e8701e', heavy: true, wheelbase: 4.6, drive: 'rwd', radius: 9, response: 4, brake: 8, fade: 0.3, drag: 0.4, reverse: 0.2, tough: 6, weather: 1.15 },
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
const CITY_PATROL = 'police_city', CITY_WHITE = '#e9ebe7';

// A car's lamps, as bits of `Car.broken`: the headlamps left and right, then the tail
// lamps. The shader darkens a broken one and lights the ones that are on. WebGPU allows a
// mesh only eight vertex buffers, so the lamps ride in the ones the paint already has: a
// lamp's vertices have twice its number (1 to 4) in `painted`, and each car's `paint.w` is
// `broken`, plus 16 with the headlamps on, plus 32 with the tail lamps on or 64 braking.
export const LAMP = { headLeft: 1, headRight: 2, tailLeft: 4, tailRight: 8 };
const BREAKS = 4.5; // m/s: a knock this hard breaks a lamp it lands on
// A car's dents, `Car.crush`: how crumpled (0 to 3) its front left and right corners, its
// rear left and right ones, and the middle of its left and right sides are. A knock
// harder than `from` (m/s) crumples where it lands by a level for every `per` m/s more;
// a blow within `end` metres of the nose or the tail lands on the corners. Two bits each
// in `paint.w` above the lamps and the kind of area (DENT_STEP), for the shader to push
// those parts in; a corner at level 2 or more cracks the window at its end, a side its
// side windows.
export const DENT = { from: 3, per: 5, end: 0.9 };
// A blow to a driven car's tail that turns it faster than `from` rad/s sets it spinning
// (Car.upset): the turn grows by `carry` times the blow's own (the back tyres let go), to
// no more than `fastest`, for `per` seconds per rad/s of it, `most` at most, the last
// `fade` of them coming back. Meanwhile the tyres grip `slide` less sideways and the
// steering keeps only 1 - `hold` of its say.
export const SPIN = { from: 0.5, carry: 2, fastest: 4, per: 1, most: 1.5, fade: 0.4, slide: 0.75, hold: 0.9 };
export const DENT_STEP = 2048;
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
  const S = TYPES[type === CITY_PATROL ? 'police' : type];
  if (S.two) {
    if (!kit) throw new Error('Figures kit is not loaded');
    const geometry = box ? mergeGeometries([kit.vehicles[S.two](), boxGeometry(S.two, box)]) : kit.vehicles[S.two]();
    cache.set(k, geometry);
    return geometry;
  }
  const geometry = type === 'truck' || type === 'artic' ? truckGeometry(type, S)
    : type === 'bus' || type === 'minibus' ? busGeometry(S)
    : type === 'fire' ? fireGeometry(S)
    : type === 'ambulance' ? ambulanceGeometry(S)
    : type === 'garbage' ? garbageGeometry(S)
    : bodyGeometry(type, box);
  markZones(geometry);
  cache.set(k, geometry);
  return geometry;
}

// Keep the original GLB body in the overhead view and at a distance. Only
// assets that describe their wheel mounts can exchange the low-poly hubs.
// Other cars change STREET_QUALITY.carReach from the camera, the tier's; the car you drive
// at least this far, at every tier.
const STREET_CAR_REACH = 24; // m from the camera
interface CloseBody {
  key: string; type: string; box?: string; radius: number; wheelbase: number; front: number; rear: number; track: number;
  layout?: number[]; formed?: string; fittedLamps?: CarSpec['headlights'];
}
const closeBodies = new Map<string, CloseBody>();
function prepareStreetCar(type: string, box?: string) {
  const mounts = bodies?.getObjectByName(type)?.userData.wheelMounts as number[] | undefined;
  if (mounts?.length !== 16) return;
  const key = bodyKey(type, box), street = key + '|street-wheels';
  if (!cache.has(street)) {
    const g = bodyGeometry(type, box, true);
    markZones(g);
    cache.set(street, g);
    closeBodies.set(key, { key: street, type, box, radius: mounts[1], wheelbase: Math.abs(mounts[0] - mounts[8]), front: mounts[0], rear: mounts[8], track: 2 * Math.abs(mounts[2]), layout: bodies?.getObjectByName(type)?.userData.cabinLayout });
  }
  return street;
}

// Cab and cycle detail has no moving wheel shader. Keep its page on the normal
// car material, sharing the two-wheeler itself across all courier box colours.
const streetFleet = new Map<string, string>();
function prepareFleetBody(type: string, box?: string): string | undefined {
  const key = bodyKey(type, box), street = key + '|fitted';
  if (streetFleet.has(key)) return street;
  const spec = TYPES[type];
  let g: THREE.BufferGeometry;
  if (spec?.two) {
    const bare = box ? cache.get(prepareFleetBody(type)!)! : undefined;
    const frame = spec.two === 'bike' ? kit!.vehicles.bike(true) : carGeometry(type);
    g = bare ? mergeGeometries([bare, boxGeometry(type, box!)]) : twoWheelerStreet(spec.two, frame);
    g.userData.movingCranks = frame.userData.movingCranks === true;
  } else if (type === 'bus' || type === 'minibus') g = busGeometry(spec, true);
  else if (type === 'truck' || type === 'artic') g = truckGeometry(type, spec, true);
  else if (type === 'garbage') g = garbageGeometry(spec, true);
  else return;
  if (!spec.two) markZones(g);
  cache.set(street, g);
  streetFleet.set(key, street);
  return street;
}

// Request one body type at a time. A patrol's ordinary and armoured pages
// share a download. The already-prepared body works while loading or retrying.
const STREET_SEDAN = 'sedan|coachwork|street-wheels';
const loadingForms = new Set<string>(), retryFormAt = new Map<string, number>();
let carAssetUrl = '';
function requestStreetForm(type: string) {
  if (!carAssetUrl || loadingForms.has(type) || performance.now() < (retryFormAt.get(type) ?? 0)) return;
  loadingForms.add(type);
  const url = new URL(type + '-street.glb', carAssetUrl).href;
  void new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).then(({ scene }) => {
    scene.updateMatrixWorld(true);
    const sedan = type === 'sedan';
    const shell = scene.getObjectByName(sedan ? 'sedan_coachwork' : type);
    const trim = sedan ? undefined : scene.getObjectByName(type + '_street_trim');
    if (!shell || (!sedan && !trim)) throw Error('Missing street body or fittings: ' + type);
    const lens = (trim ?? shell).userData.headlamp;
    for (const fit of closeBodies.values()) {
      if (fit.type !== type || fit.formed) continue;
      const g = bodyGeometry(type, fit.box, true, { shell, trim });
      markZones(g);
      const key = sedan ? STREET_SEDAN : bodyKey(type, fit.box) + '|formed|street-wheels';
      cache.set(key, g);
      if (Array.isArray(lens) && lens.length === 3 && lens.every(Number.isFinite)) {
        const [forward, across, height] = lens;
        fit.fittedLamps = { forward, across, height, glow: .42, streetReach: STREET_CAR_REACH };
      }
      fit.formed = key;
    }
  }).catch(error => {
    retryFormAt.set(type, performance.now() + 60000);
    console.warn('Could not load street car body', type, error);
  }).finally(() => loadingForms.delete(type));
}

const STREET_FIRE = 'fire|street';
function prepareStreetFire() {
  if (cache.has(STREET_FIRE)) return;
  const builder = boxBuilder(TYPES.fire.color, 'fire');
  fireEngineStreet(builder);
  const body = builder.done();
  markZones(body);
  cache.set(STREET_FIRE, body);
}

const STREET_AMBULANCE = 'ambulance|street';
function streetAmbulanceBody() {
  let body = cache.get(STREET_AMBULANCE);
  if (!body) {
    body = ambulanceGeometry(TYPES.ambulance, true);
    markZones(body);
    cache.set(STREET_AMBULANCE, body);
  }
  return body;
}

function charBody(k: string, body: THREE.BufferGeometry, colour: string) {
  if (!cache.has(k)) {
    const g = body.clone(), col = g.getAttribute('color');
    const painted = g.getAttribute('painted'), paint = new THREE.Color(colour);
    if (col) for (let i = 0; i < col.count; i++) {
      // Reproduce the old baked colour before charring the first wreck of a type.
      const tint = painted.getX(i) % 16 === 1 ? 1 : 0;
      const v = 0.02 + 0.05 * (col.getX(i) * (1 + (paint.r - 1) * tint)
        + col.getY(i) * (1 + (paint.g - 1) * tint) + col.getZ(i) * (1 + (paint.b - 1) * tint)) / 3;
      col.setXYZ(i, v, v, v * 1.05);
    }
    for (let i = 0; i < painted.count; i++) painted.setX(i, Math.floor(painted.getX(i) / 16) * 16);
    cache.set(k, g);
  }
}

// Where on the car each vertex is, for the dents: along it (-1 the tail, 1 the nose) and
// across (-1 the left, 1 the right), each in 32 steps, as 16 × (along + 32 × across)
// on top of what `painted` holds (under 16).
function markZones(g: THREE.BufferGeometry) {
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!, pos = g.getAttribute('position'), painted = g.getAttribute('painted');
  const step = (v: number, lo: number, hi: number) => Math.round(Math.min(1, Math.max(0, v > 0 ? 0.5 + 0.5 * v / hi : 0.5 - 0.5 * v / lo)) * 31);
  for (let i = 0; i < pos.count; i++) {
    const along = step(pos.getX(i), min.x, max.x), across = step(pos.getZ(i), min.z, max.z);
    painted.setX(i, painted.getX(i) + 16 * (along + 32 * across));
  }
}

// A car body from cars.glb.
function bodyGeometry(type: string, box?: string, closeCar = false,
  replacement?: { shell: THREE.Object3D; trim?: THREE.Object3D }): THREE.BufferGeometry {
  if (!bodies) throw new Error('Car bodies are not loaded');
  const c = new THREE.Color();
  const parts: THREE.BufferGeometry[] = [];
  const doors: Door[] = [], at = new THREE.Vector3();
  const accessoryBody = type === CITY_PATROL ? 'police' : type;
  const nodes = [type, ...(box ? [`${accessoryBody}_${box}`] : [])].map((name) => {
    const node = bodies!.getObjectByName(name);
    if (!node) throw new Error(`Missing ${name} in cars.glb`);
    return node;
  });
  const glazing: THREE.BufferGeometry[] = [];
  const base = nodes[0];
  const layout = closeCar ? base.userData.cabinLayout as number[] | undefined : undefined;
  const coachwork = type === 'sedan' ? replacement?.shell : undefined;
  nodes[0] = replacement?.shell ?? base;
  const trim = replacement?.trim ?? (closeCar && !coachwork ? bodies.getObjectByName(type + '_street_trim') : undefined);
  if (trim) nodes.push(trim);
  for (const node of nodes) node.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const name = (Array.isArray(o.material) ? o.material[0] : o.material).name;
    if (closeCar && (name === 'Tyre' || name === 'WheelHub')) return;
    if (layout && (name === 'SimpleSeat' || name === 'WindowInside' || name === 'WindowBacking' ||
      name === 'DoorBacking' || (name === 'RearBacking' && type !== 'van'))) return;
    if (trim && node !== trim && (name === 'Lamp' || name === 'Tail' || name === 'Plate' || name === 'Bumper')) return;
    if (closeCar && (name.startsWith('SimpleMirror') || name === 'SimpleWiper')) return;
    if (!closeCar && (name.startsWith('Door') && name !== 'DoorBacking')) return;
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
      // The alternate skin has its own local mesh origins. Animate it about the
      // hinge used by entry, open-door clearance and the distant body.
      const pivot = replacement?.trim ? base.getObjectByName(type + '_door' + n) : hung;
      (pivot ?? hung)!.getWorldPosition(at);
      for (let i = 0; i < hinge.length; i += 3) hinge.set([at.x, at.z, n], i);
      g.computeBoundingBox();
      const door = doors.find((d) => d.n === n);
      if (door) door.back = Math.min(door.back, g.boundingBox!.min.x);
      else doors.push({ n, side: at.z < 0 ? 1 : -1, front: at.x, back: g.boundingBox!.min.x, real: true });
    }
    g.setAttribute('hinge', new THREE.BufferAttribute(hinge, 3));
    const paint = name === 'Paint' || name === 'DoorPaint' || name === 'SimpleMirrorPaint';
    const authored = Array.isArray(o.material) ? o.material[0] : o.material;
    c.set(paint ? '#ffffff' : name === 'Window' && !layout ? PART.Glass : PART[name] || (coachwork ? authored.color : '#777777'));
    const col = new Float32Array(g.attributes.position.count * 3);
    const ao = coachwork && !['Window', 'RearWindow', 'LensCover', 'Lamp', 'Tail', 'GaugeFace', 'DisplayFace'].includes(name) && o.geometry.getAttribute('_cavity');
    for (let i = 0; i < col.length; i += 3) {
      const shade = ao ? ao.getX(i / 3) : 1;
      col[i] = c.r * shade; col[i + 1] = c.g * shade; col[i + 2] = c.b * shade;
    }
    if (coachwork && (name === 'GaugeFace' || name === 'DisplayFace')) {
      g.computeBoundingBox();
      const { min, max } = g.boundingBox!, pos = g.attributes.position, gauge = name === 'GaugeFace';
      for (let i = 0; i < pos.count; i++) {
        const u = (pos.getZ(i) - min.z) / (max.z - min.z), v = (pos.getY(i) - min.y) / (max.y - min.y);
        hinge.set([u, gauge ? (108 + 148 * v) / 256 : (.012 + .325 * v), gauge ? 14 : 15], i * 3);
      }
    }
    if (coachwork && name === 'Cloth') {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) hinge.set([pos.getZ(i) / .39, (pos.getX(i) - pos.getY(i)) / .39, 16], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(paint ? 1 : 0), 1));
    if (name === 'Lamp' || name === 'Tail') markLamp(g, name === 'Lamp');
    if (coachwork) {
      const tag = sedanFinish(name) / 16, attr = g.attributes.painted;
      for (let i = 0; i < attr.count; i++) attr.setX(i, attr.getX(i) + tag);
    }
    (layout && (name === 'Window' || name === 'RearWindow' || name === 'LensCover') ? glazing : parts).push(g);
    if ((node === trim || node === coachwork) && name === 'Plate') parts.push(registrationFaces(g));
  });
  if (closeCar) parts.push(...buildStreetWheels(coachwork ? 'sport-sedan' : type, base.userData.wheelMounts));
  else DOORS.set(type, doors.sort((a, b) => a.n - b.n));
  if (layout && !coachwork) parts.push(...passengerCabin(type, layout));
  if (!glazing.length) return mergeGeometries(parts);
  const result = mergeGeometries(parts.concat(glazing));
  const solid = parts.reduce((sum, g) => sum + g.index!.count, 0);
  result.addGroup(0, solid, 0);
  result.addGroup(solid, result.index!.count - solid, 1);
  return result;
}

// A car's doors: 1 front left (the driver's), 2 front right, 3 and 4 behind them. `side`
// is 1 on the left; `front` (the hinge) and `back` are along the car from its middle.
// Vehicles built here from boxes (buses, lorries, the fire engine, the ambulance, the dustcart) have
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
function boxBuilder(paintColour?: string, serviceAtlas?: 'ambulance' | 'fire') {
  const parts: THREE.BufferGeometry[] = [], windows: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  const add = (g: THREE.BufferGeometry, colour: string, x: number, y: number, z: number) => {
    if (serviceAtlas && !g.userData.printed) {
      // An unprinted part samples the blank margin of the service livery.
      const uv = new Float32Array(g.attributes.position.count * 2);
      for (let i = 0; i < uv.length; i += 2) { uv[i] = 0.99; uv[i + 1] = 0.03; }
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    } else if (!serviceAtlas) g.deleteAttribute('uv');
    g.translate(x, y, z);
    c.set(colour === paintColour ? '#ffffff' : colour);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(colour === paintColour ? 1 : 0), 1));
    if (colour === HEADLAMP || colour === TAIL_LAMP) markLamp(g, colour === HEADLAMP);
    const target = g.userData.cabWindow ? windows : parts;
    if (serviceAtlas === 'fire') {
      // Keep the curved wheel, lens and tube vertices shared between triangles.
      if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
      target.push(g);
    } else target.push(g.index ? g.toNonIndexed() : g);
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
  const panel = (colour: string, outline: [number, number][], width: number, z = 0) => {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    add(new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false }), colour, 0, 0, z - width / 2);
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
  // Exposed steel wheel faces. Twin tyres are inset so the outer shoulder
  // and its hub occupy the same track as a single front tyre.
  const roadWheel = (x: number, width: number, twin = false) => {
    wheel(x, twin ? width - 0.24 : width, twin);
    for (const side of [-1, 1]) {
      const face = side * (width / 2 - 0.035);
      const disc = (r: number, depth: number, offset: number, colour: string) =>
        add(new THREE.CylinderGeometry(r, r, depth, 16).rotateX(Math.PI / 2), colour, x, 0.5, face + side * offset);
      disc(0.29, 0.045, 0, '#a4a7a4');
      disc(0.13, 0.052, 0.024, '#63686a');
      for (let i = 0; i < 6; i++) {
        const angle = i * Math.PI / 3;
        add(new THREE.CircleGeometry(0.039, 6).rotateY(side < 0 ? Math.PI : 0), '#42474a',
          x + Math.cos(angle) * 0.206, 0.5 + Math.sin(angle) * 0.206, face + side * 0.025);
      }
    }
  };
  let driverSeat: number[] | undefined;
  const setSeat = (x: number, pelvis: number, z: number, roof: number) => { driverSeat = [x, pelvis, z, roof]; };
  const done = () => {
    if (!windows.length) return mergeGeometries(parts);
    const body = mergeGeometries(parts.concat(windows));
    body.userData.driverSeat = driverSeat;
    const opaqueCount = parts.reduce((sum, g) => sum + (g.index?.count ?? g.attributes.position.count), 0);
    body.addGroup(0, opaqueCount, 0);
    body.addGroup(opaqueCount, (body.index?.count ?? body.attributes.position.count) - opaqueCount, 1);
    return body;
  };
  return { add, box, rounded, panel, wheel, roadWheel, setSeat, done };
}

function busGeometry(S: CarSpec, street = false): THREE.BufferGeometry {
  const builder = boxBuilder(S.color || '#c8102e');
  const { box, rounded, done } = builder;
  const wheel = street ? builder.roadWheel : builder.wheel;
  const L = S.L / 2, W = S.W, red = S.color || '#c8102e', white = '#eeeeea', glass = '#1b242c', grey = '#8a8f94';
  const small = S.L < 10;
  const sill = 1.15, top = small ? 2.3 : 2.55, roof = small ? 2.65 : 2.95;
  // Rounded at the corners, more at the front than the back.
  const nose = 0.3, tail = 0.16;
  rounded('#2a2c2f', -L + 0.05, L - 0.05, 0.28, 0.5, W - (street ? .70 : .02), [nose, tail]); // skirt and bumpers
  const doors = small ? [L - (street ? 2.75 : 1.1), -L + 2.6] : [L - 1.35, 0.6, -3.8];
  if (street) {
    busCabin(builder, L, W, small, sill, top, doors, red);
    for (const x of [-L + .12, L - .12]) rounded('#2a2c2f', x - .12, x + .12, .28, .50, W - .08, .10);
  }
  else {
    rounded(red, -L, L, 0.5, sill, W, [nose, tail]);
    rounded(glass, -L + 0.02, L - 0.02, sill, top, W - 0.06, [nose - 0.02, tail - 0.02]);
  }
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
  if (!street) {
    // Pillars between the side windows (none where the doors are).
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
  }
  box('#141414', L - 0.04, L + 0.03, top + 0.04, roof - 0.06, W - 0.62);
  box('#ffb020', L - 0.03, L + 0.035, top + 0.1, roof - 0.12, W - 0.9);
  for (const z of [-1, 1]) {
    box('#fff6d8', L - 0.05, L + 0.03, 0.55, 0.72, 0.36, z * (W / 2 - nose - 0.2));
    box('#b3161b', -L - 0.03, -L + 0.05, 0.6, 1.1, 0.22, z * (W / 2 - tail - 0.13));
  }
  if (!street) box(glass, -L - 0.02, -L + 0.05, 1.4, top - 0.1, W - 0.5);
  box('#e3e5e0', L - 0.03, L + 0.04, 0.3, 0.42, 0.52); // number plate
  // Wheels: two at the front, twin tyres at the back.
  wheel(L - (small ? 1.3 : 2.7), W);
  wheel(-L + (small ? 1.7 : 3.3), W);
  return done();
}

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
    box('#285891', -3.95, -3.65, 3.28, 3.395, .31, side);
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

// Prague's yellow box ambulance. The short bonnet and inclined screen distinguish
// the van cab from its full-height patient compartment in both camera views.
function ambulanceGeometry(S: CarSpec, street = false): THREE.BufferGeometry {
  const { add, box, panel, rounded, roadWheel, done } = boxBuilder(undefined, street ? 'ambulance' : undefined);
  const L = S.L / 2, W = S.W, cab = 0.77, roof = S.H;
  const yellow = '#e6dc24', red = '#df3829', blue = '#15569b', trim = '#303438', glass = '#273841';
  const frontAxle = 1.82, rearAxle = -1.78;
  box(trim, -L + 0.04, L - (street ? 0.34 : 0.06), 0.36, 0.73, W - 0.50);
  if (street) ambulanceStreet(add);
  else {
    // The skirt is cut around the wheel; only the belt above it spans the axle.
    panel(yellow, [[-L, 0.56], [rearAxle - 0.60, 0.56], [rearAxle - 0.49, 0.91],
      [rearAxle - 0.30, 1.05], [rearAxle + 0.30, 1.05], [rearAxle + 0.49, 0.91],
      [rearAxle + 0.60, 0.56], [cab, 0.56], [cab, 1.19], [-L, 1.19]], W - 0.03);
    rounded(yellow, -L, cab, 1.17, roof, W, 0.09, 0.055);
    panel(yellow, [[cab, 0.55], [frontAxle - 0.57, 0.55], [frontAxle - 0.46, 0.92],
      [frontAxle - 0.27, 1.05], [frontAxle + 0.28, 1.05], [frontAxle + 0.50, 0.88],
      [frontAxle + 0.60, 0.56], [L - 0.02, 0.56], [L, 1.02], [L - 0.13, 1.23],
      [L - 0.75, 1.45], [cab, 1.45]], W - 0.12);
    panel(glass, [[cab + 0.04, 1.44], [L - 0.74, 1.44], [L - 1.35, 2.39], [cab + 0.04, 2.39]], W - 0.21);
    rounded(yellow, cab - 0.05, L - 1.30, 2.32, 2.51, W - 0.12, 0.12, 0.08);
    panel(yellow, [[cab - 0.03, 2.36], [1.66, 2.37], [1.50, 2.56], [cab, roof - 0.02]], W - 0.22);
    rounded(trim, L - 0.22, L + 0.04, 0.40, 0.75, W - 0.13, 0.10);
    box(trim, L - 0.04, L + 0.018, 0.77, 1.01, 1.10);
    box('#bac0bd', L + 0.018, L + 0.026, 0.91, 0.94, 1.02);
    box('#eeeada', L + 0.035, L + 0.048, 0.53, 0.65, 0.49);
  }
  const number = street ? null : letteringGeometry(['155'], 0.048);
  // Outline the six arms of the Star of Life in a single plane.
  const star = new THREE.Shape();
  const corners = [[0.10, 0.32], [-0.10, 0.32], [-0.10, 0.174]];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    corners.forEach(([x, y], j) => {
      const u = x * Math.cos(a) - y * Math.sin(a), v = x * Math.sin(a) + y * Math.cos(a);
      if (!i && !j) star.moveTo(u, v); else star.lineTo(u, v);
    });
  }
  const emblem = new THREE.ShapeGeometry(star);
  const staff = new THREE.Shape();
  staff.moveTo(0.009, 0.18);
  staff.lineTo(-0.013, 0.18);
  staff.lineTo(-0.009, -0.18);
  staff.lineTo(0.008, -0.18);
  const serpent = new THREE.Shape();
  serpent.moveTo(0.060, 0.15);
  serpent.bezierCurveTo(-0.12, 0.19, -0.09, 0.04, 0.016, 0.015);
  serpent.bezierCurveTo(0.10, -0.014, 0.045, -0.065, -0.031, -0.086);
  serpent.quadraticCurveTo(-0.078, -0.13, -0.009, -0.151);
  serpent.bezierCurveTo(-0.059, -0.095, 0.10, -0.092, 0.072, -0.002);
  serpent.bezierCurveTo(0.051, 0.071, -0.080, 0.043, -0.047, 0.113);
  serpent.quadraticCurveTo(-0.032, 0.145, 0.054, 0.121);
  const insignia = new THREE.ShapeGeometry([staff, serpent], 5);
  add(emblem.clone().scale(2, 2, 1).rotateX(-Math.PI / 2), blue, -0.24, roof + 0.006, 0);
  add(insignia.clone().scale(2, 2, 1).rotateX(-Math.PI / 2), '#f5f5e8', -0.24, roof + 0.010, 0);
  rounded('#c7c9bd', -2.38, -1.57, roof - 0.02, roof + 0.13, 0.90, 0.11, 0.04);
  for (let i = 0; i < 5; i++) box(trim, -2.25 + i * 0.12, -2.21 + i * 0.12, roof + 0.126, roof + 0.136, 0.63);
  // The coloured lenses are visible with the beacons switched off as well.
  if (!street) {
    box(trim, 1.12, 1.43, 2.47, 2.63, 1.78);
    box('#cdd7de', 1.13, 1.42, 2.62, 2.74, 0.52);
  }
  for (const side of [-1, 1]) {
    const z = side * W / 2, facing = side < 0 ? Math.PI : 0;
    if (!street) {
      panel(yellow, [[cab, 1.43], [cab + 0.19, 1.43], [cab + 0.19, 2.36], [cab, 2.36]], 0.07, z - side * 0.10);
      panel(yellow, [[2.10, 1.44], [2.26, 1.44], [1.64, 2.40], [1.53, 2.40]], 0.07, z - side * 0.10);
      box(trim, 1.93, 2.01, 1.66, 1.74, 0.30, z);
      box(trim, 1.91, 2.04, 1.59, 1.88, 0.10, z + side * 0.15);
      box(trim, cab + 0.22, cab + 0.39, 1.34, 1.39, 0.04, z - side * 0.06);
      box(red, -L + 0.08, cab - 0.06, 2.40, 2.49, 0.015, z);
      for (let i = 0; i < 8; i++) {
        const x = -L + 0.09 + i * 0.45, y = i % 2 === 0 ? 1.08 : 1.29;
        box(red, x, x + 0.45, y, y + 0.21, 0.026, z);
      }
      add(emblem.clone().rotateY(facing), blue, -2.39, 1.94, z + side * 0.008);
      add(insignia.clone().rotateY(facing), '#f5f5e8', -2.39, 1.94, z + side * 0.012);
      box(red, cab + 0.06, 1.84, 1.12, 1.24, 0.025, z - side * 0.056);
      box('#90914b', cab + 0.10, cab + 0.12, 0.65, 1.42, 0.02, z - side * 0.057);
      box(trim, cab + 0.10, frontAxle - 0.53, 0.47, 0.54, 0.15, z - side * 0.09);
    }
    if (number) add(number.clone().rotateY(facing), '#253544', -1.23, 1.75, z + side * 0.008);
    // Access to the treatment compartment is on the kerb side.
    if (!street && side > 0) {
      for (const x of [-0.39, 0.62]) box('#8f8d47', x, x + 0.018, 0.64, 2.35, 0.035, z);
      box(glass, -0.30, 0.52, 1.75, 2.25, 0.03, z);
      box(trim, -0.32, -0.22, 1.53, 1.67, 0.05, z);
      box(trim, -0.36, 0.65, 0.41, 0.49, 0.20, z - 0.01);
    }
    if (!street) {
      box(side < 0 ? red : blue, 1.13, 1.42, 2.62, 2.74, 0.57, side * 0.60);
      box(side < 0 ? red : blue, -2.96, -2.65, 2.64, 2.77, 0.30, side * 0.84);
      // Wrap the headlamp round the shoulder of the bonnet.
      panel(HEADLAMP, [[L - 0.34, 1.16], [L - 0.13, 1.20], [L, 1.02],
        [L - 0.02, 0.94], [L - 0.22, 1.00]], 0.27, side * 0.84);
      box(HEADLAMP, L - 0.04, L + 0.014, 0.91, 1.04, 0.34, side * 0.75);
      box(glass, -L - 0.026, -L + 0.015, 1.65, 2.22, 0.67, side * 0.41);
    }
    if (!street) box(red, -L - 0.035, -L + 0.01, 1.14, 1.39, 0.85, side * 0.46);
    if (!street) box(TAIL_LAMP, -L - 0.045, -L + 0.02, 0.86, 1.52, 0.13, side * 0.95);
  }
  box(trim, -L - 0.031, -L, 0.61, 2.51, 0.022);
  box(trim, -L - 0.057, -L, 1.43, 1.49, 0.17, 0.12);
  if (!street) {
    box(trim, -L - 0.13, -L + 0.04, 0.38, 0.49, W - 0.19);
    roadWheel(frontAxle, W);
    roadWheel(rearAxle, W);
  }
  return done();
}

// Prague rear loader. +x is the cab, +z the kerb. The steps and bin slots at
// the tail line up with the two members of the crew in refuse.ts.
function garbageGeometry(S: CarSpec, street = false): THREE.BufferGeometry {
  const orange = S.color || '#e8701e';
  const builder = boxBuilder(orange);
  const { add, box, rounded, panel, wheel, done } = builder;
  const L = S.L / 2, W = S.W, cab = L - 2.2, back = -L + 0.45;
  const green = '#43803c', steel = '#a6a7a0', rubber = '#292a29', iron = '#555650';
  const glass = '#27343c', lift = '#c36727', pale = '#e7e6db';

  const pipe = (colour: string, radius: number, points: [number, number, number][]) => {
    const path = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    add(new THREE.TubeGeometry(path, points.length === 2 ? 1 : 16, radius, 6, false), colour, 0, 0, 0);
  };

  const lettering = letteringGeometry(['PRAŽSKÉ', 'SLUŽBY'], 0.019);
  const plastics = letteringGeometry(['PLASTY'], 0.022);

  // Four lobes of the municipal clover, repeated in lighter orange on the bin.
  const clover = new THREE.Shape();
  const outline = (path: THREE.Path, scale: number) => {
    for (let i = 0; i <= 40; i++) {
      const angle = i * Math.PI / 20;
      const radius = scale * (0.72 + 0.28 * Math.cos(angle * 4));
      const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
      if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
  };
  outline(clover, 1);
  const hole = new THREE.Path();
  outline(hole, 0.82);
  clover.holes.push(hole);
  const flower = new THREE.ShapeGeometry(clover);
  box(iron, back, L - 0.05, 0.36, 0.74, W - 0.68);
  const frontAxle = L - 1.25, rearAxle = frontAxle - S.wheelbase!;
  wheel(frontAxle, W);
  wheel(rearAxle, W - 0.24, true);
  // A cab-over with a raked windscreen. The roof ends short of the nose,
  // leaving a strip of glass visible from the normal overhead camera.
  panel(orange, [[cab, 0.67], [frontAxle - 0.60, 0.67], [frontAxle - 0.46, 1.00],
    [frontAxle - 0.24, 1.11], [frontAxle + 0.30, 1.11], [frontAxle + 0.54, 0.91],
    [frontAxle + 0.63, 0.62], [L - 0.05, 0.62], [L, 1.56], [cab, 1.56]], W - 0.09);
  if (street) commercialCab(builder, cab + .05, L, W - .15, 1.55, 2.72, .30);
  else panel(glass, [[cab + 0.05, 1.55], [L, 1.55], [L - 0.30, 2.72], [cab + 0.05, 2.72]], W - 0.15);
  rounded(orange, cab, L - 0.24, 2.65, 2.86, W - 0.04, [0.24, 0.10], 0.08);
  rounded(rubber, cab + 0.62, cab + 1.25, 2.854, 2.89, 0.86, 0.10);
  rounded(iron, L - 0.15, L + 0.11, 0.37, 0.68, W - 0.08, 0.10);
  box(rubber, L - 0.02, L + 0.015, 0.85, 1.31, 1.32);
  for (const y of [0.96, 1.13]) box(iron, L + 0.015, L + 0.025, y, y + 0.035, 1.26);
  box(pale, L + 0.10, L + 0.12, 0.46, 0.58, 0.49);

  const join = -1.08, front = cab - 0.24, deckEnd = -3.98;
  // The main bin has a shallow crowned lid between two orange crossmembers.
  // Its lower rear corner follows the diagonal hinge of the green tailgate.
  panel(orange, [[join - 0.48, 1.16], [front, 1.16], [front, 3.17], [join, 3.17]], W - 0.09);
  rounded(orange, join, front, 3.04, 3.27, W - 0.07, 0.12, 0.11);
  for (const x of [join, front - 0.14]) box(orange, x, x + 0.14, 3.12, 3.35, W);
  box(iron, join + 0.14, front - 0.14, 3.26, 3.28, 0.31, 0.74);
  for (const z of [0.65, 0.74, 0.83]) {
    pipe(steel, 0.027, [[join + 0.09, 3.30, z], [front - 0.08, 3.30, z]]);
  }

  panel(green, [[join - 0.50, 1.12], [join - 0.04, 3.17], [deckEnd, 3.10],
    [deckEnd + 0.16, 2.65], [-3.34, 1.40], [-2.78, 0.90]], W - 0.04);
  box('#969993', deckEnd, join - 0.06, 3.095, 3.19, W - 0.14);
  box(green, join - 0.14, join - 0.06, 3.16, 3.22, W - 0.02);
  box('#797d78', -2.96, -2.94, 3.185, 3.194, W - 0.15);
  // The slack hydraulic line loops across the bare steel cover to the loader.
  pipe(rubber, 0.052, [[join + 0.04, 3.32, 0.74], [-1.60, 3.27, 0.55],
    [-2.36, 3.25, -0.16], [-2.94, 3.25, -0.34], [-3.60, 3.25, 0.07],
    [deckEnd, 3.26, 0.47], [deckEnd - 0.12, 3.04, 0.48]]);

  pipe(steel, 0.062, [[-3.48, 3.25, -0.018], [-3.61, 3.25, 0.075]]);

  // A recessed loading trough with a sloping steel floor and two hanging
  // rubber curtains. The lifting arms and comb sit below the open mouth.
  panel(iron, [[-3.54, 1.52], [-3.33, 1.54], [-3.81, 0.96], [back - 0.07, 0.92],
    [back - 0.07, 1.10], [-3.88, 1.15]], 1.87);
  box(lift, back - 0.12, back + 0.04, 1.04, 1.16, 1.94);
  box(iron, deckEnd - 0.05, deckEnd + 0.15, 2.85, 3.14, W - 0.10);
  box(pale, deckEnd - 0.07, deckEnd - 0.05, 2.93, 3.06, 0.52);
  box(lift, -4.14, -3.88, 2.72, 2.84, 1.93);
  const beacon = (x: number, roof: number, z: number) => {
    add(new THREE.CylinderGeometry(0.15, 0.16, 0.055, 10), iron, x, roof + 0.027, z);
    add(new THREE.CylinderGeometry(0.09, 0.12, 0.14, 10), '#de861c', x, roof + 0.125, z);
  };
  for (const side of [-1, 1]) {
    const z = side * (W / 2 - 0.04);
    box(green, deckEnd, join - 0.06, 3.09, 3.22, 0.085, z);
    for (const axle of [frontAxle, rearAxle]) {
      const disc = (radius: number, depth: number, x: number, y: number, offset: number, colour: string) =>
        add(new THREE.CylinderGeometry(radius, radius, depth, 12).rotateX(Math.PI / 2), colour, x, y, side * offset);
      disc(0.29, 0.045, axle, 0.5, 1.22, '#858480');
      disc(0.15, 0.05, axle, 0.5, 1.25, iron);
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        disc(0.035, 0.012, axle + Math.cos(a) * 0.21, 0.5 + Math.sin(a) * 0.21, 1.25, rubber);
      }
      panel(iron, [[axle - 0.64, 0.62], [axle - 0.54, 0.97], [axle - 0.32, 1.12],
        [axle + 0.34, 1.12], [axle + 0.58, 0.94], [axle + 0.65, 0.62], [axle + 0.55, 0.62],
        [axle + 0.46, 0.89], [axle + 0.26, 1.02], [axle - 0.27, 1.02],
        [axle - 0.46, 0.89], [axle - 0.55, 0.62]], 0.23, side * 1.15);
    }
    const mark = (x: number, y: number, size: number, across: number, colour: string) =>
      add(flower.clone().scale(size, size, 1).rotateY(side < 0 ? Math.PI : 0), colour, x, y, side * across);
    mark(-2.66, 2.63, 0.21, (W - 0.04) / 2 + 0.003, pale);
    const facing = side < 0 ? Math.PI : 0;
    add(lettering.clone().scale(0.56, 0.56, 1).rotateY(facing), pale, -2.66, 2.32, side * ((W - 0.04) / 2 + 0.003));
    mark(cab + 0.45, 1.22, 0.11, (W - 0.09) / 2 + 0.003, pale);
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 7; i++) {
        mark(join + 0.22 + i * 0.46 + 0.15 * (row % 2), 1.58 + row * 0.53 + 0.08 * (i % 2),
          i % 3 === 0 ? 0.12 : 0.075, (W - 0.09) / 2 + 0.003, '#ef9c52');
      }
    }
    box(pale, -0.16, 1.10, 1.15, 1.52, 0.045, z);
    box('#ebbd37', -0.01, 0.95, 1.23, 1.44, 0.05, z);
    add(plastics.clone().rotateY(facing), rubber, 0.47, 1.26, z + side * 0.027);
    box(steel, -0.10, 0.99, 0.52, 1.12, 0.41, side * 0.76);
    for (const x of [0.06, 0.79]) box(iron, x, x + 0.08, 0.51, 1.13, 0.43, side * 0.76);
    // Cab pillars, door handle, steps and mirror on its arm.
    box(orange, cab + 0.02, cab + 0.30, 1.48, 2.67, 0.09, z - side * 0.05);
    panel(orange, [[L - 0.18, 1.54], [L - 0.02, 1.54], [L - 0.30, 2.69],
      [L - 0.41, 2.69]], 0.07, z - side * 0.04);
    box(rubber, cab + 0.38, cab + 0.62, 1.37, 1.43, 0.035, z);
    box(steel, frontAxle + 0.60, L - 0.15, 0.54, 0.63, 0.26, side * 1.05);
    box(rubber, L - 0.43, L - 0.36, 2.30, 2.37, 0.32, side * 1.31);
    box(rubber, L - 0.46, L - 0.30, 1.97, 2.43, 0.13, side * 1.47);
    box(HEADLAMP, L - 0.01, L + 0.04, 0.84, 1.07, 0.31, side * 0.92);
    beacon(2.99, 2.86, side * 0.75);

    for (const y of [0.45, 0.76]) box(steel, rearAxle + 0.68, cab + 0.09, y, y + 0.07, 0.09, z);
    for (const x of [-0.18, 2.12]) box(iron, x, x + 0.08, 0.48, 1.17, 0.08, z - side * 0.06);
    pipe(steel, 0.054, [[join - 0.48, 1.16, z], [join, 3.17, z]]);
    pipe(iron, 0.085, [[-3.49, 1.46, z], [-2.27, 2.47, z]]);
    pipe(steel, 0.043, [[-2.27, 2.47, z], [-1.52, 3.07, z]]);
    // The cheek plates project past the curtains, framing the mouth from behind.
    panel(lift, [[-3.62, 1.24], [-3.88, 2.80], [-4.15, 2.80], [back - 0.05, 2.49],
      [back - 0.10, 1.02], [back + 0.21, 0.87]], 0.11, side * 0.91);
    panel(rubber, [[-4.04, 2.76], [-3.94, 2.76], [-3.75, 1.62],
      [-3.90, 1.57]], 0.85, side * 0.44);
    add(lettering.clone().rotateX(0.117).rotateY(-Math.PI / 2), '#c6c3af', -3.976, 2.16, side * 0.44);
    const arm = side * 0.52;
    pipe(iron, 0.070, [[-3.99, 1.04, arm], [back - 0.22, 0.50, arm]]);
    box(lift, back - 0.32, back - 0.12, 0.46, 0.62, 0.84, arm);
    for (const offset of [-0.26, 0, 0.26]) {
      box(iron, back - 0.31, back - 0.22, 0.62, 0.72, 0.07, arm + offset);
    }
    box(TAIL_LAMP, deckEnd - 0.08, deckEnd, 2.90, 3.08, 0.18, side * 1.04);
    beacon(deckEnd, 3.14, side * 0.8);
    // Rear corner markers, grab rails and the two low riding steps.
    box(green, -4.13, -3.91, 0.79, 2.86, 0.28, side * 1.08);
    box(pale, -4.14, -4.12, 1.70, 2.67, 0.22, side * 1.08);
    for (const y of [1.75, 2.10, 2.45]) {
      const stripe = new THREE.Shape([new THREE.Vector2(-0.11, 0), new THREE.Vector2(0.11, 0.11),
        new THREE.Vector2(0.11, 0.26), new THREE.Vector2(-0.11, 0.15)]);
      add(new THREE.ShapeGeometry(stripe).rotateY(-Math.PI / 2), '#c63829', -4.145, y, side * 1.08);
    }
    const step = side * (W / 2 - 0.32);
    box(iron, -L, back, 0.37, 0.45, 0.61, step);
    pipe(steel, 0.034, [[-4.10, 1.38, z], [-4.28, 1.42, z], [-4.28, 2.12, z], [-4.10, 2.18, z]]);
  }
  return done();
}

// A refrigerated delivery lorry and a long-haul tractor with a curtain-sided
// trailer. Both keep their cab paint from the traffic palette.
function truckGeometry(type: string, S: CarSpec, street = false): THREE.BufferGeometry {
  const paint = '#ffffff', glass = '#24333c', dark = '#2d3336', alloy = '#a8afaf';
  const builder = boxBuilder(paint);
  const { box, rounded, panel, add, roadWheel, done } = builder;
  const L = S.L / 2, W = S.W, artic = type === 'artic';
  const cab = L - (artic ? 2.65 : 1.96), top = artic ? 3.15 : 2.76;
  const frontAxle = L - 1.1, bodyFront = cab - (artic ? 0.92 : 0.40);
  const cargoFloor = 1.13, roof = S.H, bodyWidth = W - 0.04;
  const coldChain = artic ? null : letteringGeometry(['POLÁR'], 0.048);
  box(dark, -L + 0.07, artic ? bodyFront : cab, 0.66, cargoFloor, W - 0.85);
  box(dark, artic ? cab - 2.5 : cab - 0.5, L - 0.04, 0.43, 0.92, W - 0.64);
  // Raked cab-over windscreen, recessed wheel arch and a separate roof fairing.
  panel(paint, [[cab, 0.64], [frontAxle - 0.59, 0.64], [frontAxle - 0.49, 0.93],
    [frontAxle - 0.29, 1.07], [frontAxle + 0.29, 1.07], [frontAxle + 0.49, 0.93],
    [frontAxle + 0.59, 0.64], [L, 0.64], [L, 1.63], [cab, 1.63]], W - 0.09);
  if (street) commercialCab(builder, cab + .04, L, W - .13, 1.62, top - .11, .32);
  else panel(glass, [[cab + 0.04, 1.62], [L, 1.62], [L - 0.32, top - 0.11],
    [cab + 0.04, top - 0.11]], W - 0.13);
  rounded(paint, cab, L - 0.25, top - 0.19, top + 0.02, W - 0.07, 0.13, 0.08);
  const fairing = artic ? 0.69 : 0.37;
  panel(paint, [[cab + 0.06, top], [L - 0.48, top], [L - 0.80, top + 0.16],
    [cab + 0.49, top + fairing], [cab + 0.06, top + fairing]], W - 0.29);
  rounded('#515a5d', cab + 0.12, cab + 0.47, top + fairing - 0.005, top + fairing + 0.035, 0.76, 0.055);
  rounded(dark, L - 0.20, L + 0.07, 0.37, 0.76, W - 0.07, 0.13);
  box(dark, L - 0.02, L + 0.018, 0.81, 1.51, W - 0.66);
  for (const y of [0.93, 1.11, 1.32]) box('#737d80', L + 0.018, L + 0.029, y, y + 0.037, W - 0.80);
  box('#e8e7db', L + 0.064, L + 0.078, 0.46, 0.60, 0.53);

  // The reefer has smooth insulated panels; the semitrailer has a flexible
  // curtain with shallow vertical folds between the tension buckles.
  box('#dedfd9', -L, bodyFront, cargoFloor, roof, bodyWidth - (artic ? 0.13 : 0));
  if (artic) {
    const folds = 14, pitch = (bodyFront + L - 0.22) / folds;
    for (const side of [-1, 1]) {
      const edge = side * (bodyWidth / 2 - 0.048);
      // Each strap pulls the hem in; the fabric bellies out between straps.
      // The folds die away where the curtain hangs from the straight top rail.
      const fabric: number[] = [], indices: number[] = [];
      for (let column = 0; column <= folds * 4; column++) {
        const u = column / 4, x = -L + 0.10 + u * pitch;
        const swell = Math.sin((u % 1) * Math.PI);
        for (const [y, bulge] of [[cargoFloor + 0.13 - 0.055 * swell, 0.042],
          [cargoFloor + 0.55, 0.097], [roof - 0.49, 0.035], [roof - 0.08, 0.012]]) {
          fabric.push(x, y, edge + side * bulge * swell);
        }
        if (column === 0) continue;
        for (let row = 0; row < 3; row++) {
          const a = (column - 1) * 4 + row;
          if (side > 0) indices.push(a, a + 4, a + 5, a, a + 5, a + 1);
          else indices.push(a, a + 5, a + 4, a, a + 1, a + 5);
        }
      }
      const cloth = new THREE.BufferGeometry();
      cloth.setAttribute('position', new THREE.Float32BufferAttribute(fabric, 3));
      cloth.setIndex(indices);
      cloth.computeVertexNormals();
      add(cloth, '#416883', 0, 0, 0);
      for (let i = 0; i < folds; i++) {
        const x = -L + 0.10 + i * pitch;
        box(dark, x - 0.033, x + 0.033, 1.22, 1.57, 0.032, side * bodyWidth / 2);
        box(alloy, x - 0.049, x + 0.049, 1.28, 1.36, 0.041, side * bodyWidth / 2);
      }
    }
    for (let x = -L + 1.20; x < bodyFront - 0.28; x += 1.38) {
      box('#cbcdc7', x, x + 0.052, roof - 0.004, roof + 0.012, bodyWidth - 0.17);
    }
    // Tractor catwalk and turntable, visible through the gap ahead of the curtain.
    box('#7d8384', bodyFront - 0.15, cab, 0.94, 1.01, W - 0.58);
    add(new THREE.CylinderGeometry(0.50, 0.50, 0.09, 12), dark, bodyFront - 0.26, 1.06, 0);
  } else {
    rounded('#e8e9df', bodyFront - 0.18, bodyFront + 0.39, roof - 0.71, roof - 0.03, W - 0.44, 0.12, 0.07);
    for (let i = 0; i < 5; i++) box(dark, bodyFront + 0.38, bodyFront + 0.40, roof - 0.54 + i * 0.075,
      roof - 0.50 + i * 0.075, W - 0.76);
    // Paired condenser fans inside the shallow roof housing.
    rounded('#d4d8d4', bodyFront - 0.99, bodyFront - 0.01, roof, roof + 0.12, 1.65, 0.09, 0.04);
    for (const z of [-0.40, 0.40]) {
      add(new THREE.CylinderGeometry(0.29, 0.29, 0.024, 16), dark, bodyFront - 0.52, roof + 0.12, z);
      for (let i = 0; i < 3; i++) {
        add(new THREE.BoxGeometry(0.54, 0.025, 0.033).rotateY(i * Math.PI / 3), alloy, bodyFront - 0.52, roof + 0.14, z);
      }
    }
  }
  for (const side of [-1, 1]) {
    const z = side * W / 2, boxEdge = side * bodyWidth / 2;
    const pillar = artic ? 0.81 : 0.25;
    box(paint, cab, cab + pillar, 1.59, top - 0.12, 0.08, z - side * 0.075);
    panel(paint, [[L - 0.13, 1.63], [L, 1.63], [L - 0.32, top - 0.11],
      [L - 0.44, top - 0.11]], 0.075, z - side * 0.075);
    box(dark, cab + pillar + 0.10, cab + pillar + 0.36, 1.45, 1.51, 0.05, z - side * 0.04);
    box(dark, L - 0.44, L - 0.36, top - 0.46, top - 0.40, 0.34, z + side * 0.07);
    box(dark, L - 0.46, L - 0.32, top - 0.69, top - 0.31, 0.13, z + side * 0.22);
    for (const y of [0.49, 0.71]) box(alloy, L - 0.52, L - 0.11, y, y + 0.04, 0.14, z - side * 0.025);
    box(dark, cab + pillar + 0.01, cab + pillar + 0.035, 0.82, 1.60, 0.025, z - side * 0.04);
    box(HEADLAMP, L - 0.02, L + 0.074, 0.62, 0.82, 0.35, side * 0.97);
    box(alloy, -L, bodyFront, roof - 0.10, roof + 0.025, 0.065, boxEdge);
    box(alloy, -L, bodyFront, cargoFloor - 0.05, cargoFloor + 0.09, 0.065, boxEdge);
    if (coldChain) {
      add(coldChain.clone().rotateY(side < 0 ? Math.PI : 0), '#315060', bodyFront - 1.60, 2.39, boxEdge + side * 0.005);
      // A snowflake beside the carrier name on the insulated box.
      const flakeX = bodyFront - 1.60 - side * 0.99;
      for (let i = 0; i < 3; i++) {
        add(new THREE.BoxGeometry(0.055, 0.59, 0.015).rotateZ(i * Math.PI / 3), '#568da2', flakeX, 2.56, boxEdge);
      }
      box(paint, -L + 0.06, bodyFront - 0.06, 1.54, 1.72, 0.023, boxEdge);
      box('#9eaaae', -L + 0.06, bodyFront - 0.06, 1.46, 1.49, 0.023, boxEdge);
    }
    for (const x of [-L + 0.04, bodyFront - 0.09]) {
      box(alloy, x, x + 0.055, cargoFloor, roof, 0.05, boxEdge);
      box('#e39c44', x - 0.04, x + 0.10, 1.16, 1.22, 0.078, boxEdge);
    }
    const guardStart = -L + (artic ? 4.80 : 2.02), guardEnd = artic ? cab - 2.5 : cab - 0.09;
    for (const y of [0.53, 0.79]) box(alloy, guardStart, guardEnd, y, y + 0.075, 0.09, z - side * 0.12);
    for (const x of [guardStart + 0.13, guardEnd - 0.16]) box(dark, x, x + 0.08, 0.55, 1.12, 0.10, z - side * 0.19);
    box(artic ? alloy : dark, guardEnd - 1.26, guardEnd - 0.10, 0.48, 1.01, 0.52, side * 0.76);
    // Rear door leaves, separate locking rods, handles and hinge straps.
    box('#cfd3cf', -L - 0.018, -L + 0.008, cargoFloor + 0.09, roof - 0.09, W / 2 - 0.10, side * W / 4);
    box(alloy, -L - 0.055, -L - 0.018, cargoFloor + 0.13, roof - 0.14, 0.055, side * 0.39);
    box(dark, -L - 0.076, -L - 0.047, 1.60, 1.66, 0.26, side * 0.48);
    for (const y of [1.48, 2.28, roof - 0.34]) box(alloy, -L - 0.048, -L - 0.018, y, y + 0.065, 0.27, side * 1.05);
    box(TAIL_LAMP, -L - 0.07, -L + 0.04, 0.80, 1.01, 0.30, side * 0.95);
  }
  box(dark, -L - 0.08, -L + 0.07, 0.44, 0.59, W - 0.18);
  // The twin tyres sit inside the cargo width with their steel rims outboard.
  const axles = artic ? [frontAxle, cab - 1.63, -L + 1.55, -L + 2.76, -L + 3.97] : [frontAxle, -L + 1.43];
  for (const axle of axles) roadWheel(axle, W, axle !== frontAxle);
  return done();
}

// Car bodies from public/cars.glb (built in Blender by assets/cars/build.py): one per
// type, each part a material named after it. Paint takes the car's colour; the rest:
const PART: Record<string, string> = {
  SimpleMirrorPaint: '#ffffff', SimpleMirrorTrim: '#1f2022', SimpleMirrorGlass: '#1e2830', SimpleWiper: '#1f2022',
  DoorPaint: '#ffffff', DoorTrim: '#282d2e', DoorMirror: '#273a46', DoorSeam: '#303637', DoorBright: '#a0a6a5', GlassSeal: '#24292b',
  Window: '#263844', WindowInside: '#1e2830', SimpleSeat: '#3a393b', WindowBacking: '#3a393b',
  DoorBacking: '#3a393b', RearBacking: '#3a393b', PanelGap: '#48505a', Bumper: '#1f2022', RubStrip: '#313638', LensBed: '#697478', Optic: '#c2cccf',
  DarkChrome: '#666e71', RedLens: '#91232d', Indicator: '#dfa154', EUBlue: '#24528a',
  WheelHub: '#70757b', Glass: '#1e2830', Trim: '#1f2022', Tyre: '#161616', Metal: '#70757b', Lamp: '#fff6d8', Tail: '#b3161b',
  PatrolNavy: '#234574', PatrolWhite: '#e9ebe7', BeaconLens: '#365d91', BeaconLED: '#a8c1c9',
  Plate: '#e3e5e0', Sign: '#fff4c2', Blue: '#1d4fa3', Yellow: '#d4e02b', Bar: '#1b1f2a', Seat: '#3a393b',
};
let bodies: THREE.Object3D | null = null;
export async function loadCars(url = 'cars.glb') {
  const gltf = await new GLTFLoader().loadAsync(url);
  if (typeof document !== 'undefined' && !/^(data|blob):/.test(url)) {
    carAssetUrl = new URL(url, document.baseURI).href;
  }
  gltf.scene.updateMatrixWorld(true);
  bodies = gltf.scene;
  for (const [type, spec] of Object.entries(TYPES)) {
    const mount = bodies.getObjectByName(type + '_street_trim')?.userData.headlamp;
    if (Array.isArray(mount) && mount.length === 3 && mount.every(Number.isFinite)) {
      const [forward, across, height] = mount;
      spec.headlights = { forward, across, height, glow: 0.42, streetReach: STREET_CAR_REACH };
    }
  }
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
// At street level (CAR_STREET 1, set by CarPool.render) a car fills the view, and a sharp,
// bright street on every panel makes smooth paint look crumpled: there the paint and the
// glass mirror less (`street.top`, `street.side`, and `street.glass` times as much for
// glass instead of CAR_GLOSS.glass), and what they mirror is out of focus (`street.soft`,
// how many mip levels down the strip of the street is read).
export const CAR_STREET = { value: 0 };
export const CAR_REFLECT = { top: 0.32, side: 2.4, wet: 1.5, edge: 0.17, ragged: 0.09, horizon: 2.4, zenith: 1.3, glint: 0.08, sharp: 400,
  street: { top: 0.07, side: 1.1, glass: 1.8, soft: 3 } };
// The strips of real-looking streets (reflections.ts) cover from below the horizon up to
// `stripTop` (the tangent of the top's height, 35°), the horizon `stripHorizon` of the way
// down each; `stripGain` brings their colours to the light of the made-up street.
export const CAR_STRIPS = { stripTop: 0.7, stripHorizon: 0.806, stripGain: 3.5, kinds: KINDS.length };
// A car's kind of area rides in paint.w above its lamps (256 a step, up to 8 kinds), and
// in the vertex stage into vLit, 4 a step, so it needs no varying of its own.
export const AREA_STEP = 256;
if (KINDS.length * AREA_STEP > DENT_STEP) throw new Error('Too many kinds of area for paint.w');
// The dents in the vertex stage (DENT; the same in TSL: webgpu/vehicles.ts). `zoneAt`:
// where on the car a vertex is (markZones), along it and across, left positive.
// `dentAt`: how far in the nose, the tail, the left and the right are pushed there (0
// to 3). `bumpy`: a smooth unevenness (0 to 1), so the crumpled metal isn't flat.
// A dented part comes in by up to `nose` or `side` metres a level, sags by up to `sag`
// of its height and tilts by up to `tilt`. A crazed window (crackedAt) is a web of pale
// cracks (`crack`, their colour) over glass a little milky (`milk`).
export const DENT_SHAPE = { nose: 0.13, side: 0.11, sag: 0.03, tilt: 0.12, crack: [0.7, 0.72, 0.74], milk: 0.2 };
const DENT_GLSL = /* glsl */ `
float dentLevel(float i) { return mod(floor(floor(paint.w / ${DENT_STEP}.) / exp2(2. * i)), 4.); }
vec2 zoneAt() { float z = floor(painted / 16.); return vec2(mod(z, 32.) / 15.5 - 1., 1. - floor(z / 32.) / 15.5); }
vec4 dentAt(vec2 at) {
  float l = smoothstep(-.9, .7, at.y), r = smoothstep(-.9, .7, -at.y), mid = 1. - at.x * at.x;
  return vec4(smoothstep(.45, 1., at.x) * (dentLevel(0.) * l + dentLevel(1.) * r),
    smoothstep(.45, 1., -at.x) * (dentLevel(2.) * l + dentLevel(3.) * r),
    smoothstep(.4, 1., at.y) * mid * dentLevel(4.), smoothstep(.4, 1., -at.y) * mid * dentLevel(5.));
}
float bumpy(vec3 p) { return .5 + .25 * (sin(p.x * 11. + p.z * 7.) + sin(p.z * 13. - p.y * 9. + 2.)); }
vec3 dented(vec3 p, vec4 d) {
  float w = .5 + bumpy(p);
  p.x += (d.y - d.x) * ${DENT_SHAPE.nose.toFixed(2)} * w;
  p.z += (d.z - d.w) * ${DENT_SHAPE.side.toFixed(2)} * w;
  p.y *= 1. - (d.x + d.y + d.z + d.w) * ${DENT_SHAPE.sag.toFixed(2)} * bumpy(p.zyx);
  return p;
}
vec3 dentNormal(vec3 n, vec3 p, vec4 d) {
  float k = (d.x + d.y + d.z + d.w) * ${DENT_SHAPE.tilt.toFixed(2)};
  return normalize(n + vec3(sin(p.z * 17. + 1.), 0., sin(p.x * 19.)) * k);
}
// A window at a corner or side crumpled to level 2 or more is crazed.
float crackedAt(vec2 at) {
  float end = at.x > .05 ? max(dentLevel(0.), dentLevel(1.)) : at.x < -.05 ? max(dentLevel(2.), dentLevel(3.)) : 0.;
  float side = at.y > .4 ? dentLevel(4.) : at.y < -.4 ? dentLevel(5.) : 0.;
  return step(2., max(end, side));
}`;
// The cracks, at a point of the window (x and z on the car, metres): three sets of wavy
// lines across each other, some 15 cm apart (the same in TSL: webgpu/vehicles.ts).
const CRACKS_GLSL = /* glsl */ `
float cracks(vec2 p) {
  float a = abs(fract(p.x * 6. + .35 * sin(p.y * 17.)) - .5);
  float b = abs(fract((p.x * .5 + p.y * .87) * 7. + .3 * sin(p.x * 23.)) - .5);
  float c = abs(fract((p.x * .5 - p.y * .87) * 8. + .3 * sin(p.y * 19. + 1.)) - .5);
  return 1. - smoothstep(.03, .09, min(a, min(b, c)));
}`;
const R = CAR_REFLECT, CS = CAR_STRIPS;
export const VEHICLE_VIEW_UNIFORMS = { uStreetView: CAR_STREET, uSkyRef: SKY_REF, uStreetRef: STREET_REF, uSunDir: SUN_DIR, uSunLight: SUN_LIGHT, uStrips: STRIPS, uStripsOn: STRIPS_ON, uProbe: PROBE_MAP, uProbePrev: PROBE_PREV, uProbeMix: PROBE_MIX, uProbeAt: PROBE_AT, uProbeNear: PROBE_NEAR, uProbeK: PROBE_K };
export const VEHICLE_VIEW_GLSL = /* glsl */ `
uniform float uWet, uMirror, uStripsOn, uStreetView;
uniform vec3 uSkyRef, uStreetRef, uSunDir, uSunLight;
uniform sampler2D uStrips;
uniform samplerCube uProbe, uProbePrev;
uniform float uProbeMix;
uniform vec4 uProbeAt;
uniform vec2 uProbeNear;
uniform float uProbeK;
float carTop(vec3 n) { return smoothstep(.35, .9, dot(n, (viewMatrix * vec4(0., 1., 0., 0.)).xyz)); }
// The street round the car, seen in the direction r (world), in the car's kind of area.
// (soft: how many mip levels down the strip is read, for paint that isn't a mirror.)
vec3 carStreetSoft(vec3 r, float area, vec3 p, float soft) {
  float a = atan(r.z, r.x);
  float edge = ${R.edge.toFixed(3)} + ${R.ragged.toFixed(3)} * (.55 * sin(a * 5.) + .3 * sin(a * 13. + 1.7) + .15 * sin(a * 31. + .4));
  vec3 sky = uSkyRef * mix(${R.horizon.toFixed(2)}, ${R.zenith.toFixed(2)}, smoothstep(.1, .9, r.y));
  vec3 walls = uStreetRef * mix(.75, 1.05, smoothstep(-.02, edge, r.y));
  vec3 ground = uStreetRef * .5;
  float above = smoothstep(-.06, 0., r.y);
  vec3 c = mix(ground, mix(walls, sky, smoothstep(edge - .015, edge + .015, r.y)), above);
  if (uStripsOn > .5) {
    float t = r.y / max(length(r.xz), .001) / ${CS.stripTop.toFixed(3)};
    float v = ${CS.stripHorizon.toFixed(3)} * (1. - t);
    vec4 s = texture2D(uStrips, vec2(a / 6.2832 + .5, 1. - (area + clamp(v, .01, .99)) / ${CS.kinds.toFixed(1)}), soft);
    s.a *= step(0., v);
    vec3 street = s.rgb * dot(uStreetRef, vec3(.3, .59, .11)) * ${CS.stripGain.toFixed(2)};
    c = mix(mix(ground, sky, above), street, v > 1. ? 0. : s.a);
    c = v > 1. ? ground : c;
  }
  // On Ultra, near the middle of the view: the real street (probe.ts).
  if (uProbeAt.w > .5) {
    float w = 1. - smoothstep(uProbeNear.y, uProbeNear.x, distance(p.xz, uProbeAt.xz));
    vec4 m = mix(textureCube(uProbePrev, r), textureCube(uProbe, r), uProbeMix);
    c = mix(c, m.rgb * uProbeK, m.a * w);
  }
  return c + uSunLight * pow(max(dot(r, uSunDir), 0.), ${R.sharp.toFixed(1)}) * ${R.glint.toFixed(3)};
}
vec3 carStreet(vec3 r, float area, vec3 p) { return carStreetSoft(r, area, p, 0.); }
`;
const COAT_GLSL = /* glsl */ `${VEHICLE_VIEW_GLSL}
vec3 carCoat(vec3 c, vec3 n, vec3 v, vec3 lamp, float area, vec3 p) {
  float glass = dot(c, vec3(.3, .59, .11)) < .04 && c.b > c.r * 1.25 ? mix(${CAR_GLOSS.glass.toFixed(2)}, ${R.street.glass.toFixed(2)}, uStreetView) : 1.;
  float coat = mix(${CAR_GLOSS.dry.toFixed(2)}, 1., uWet) * glass * carTop(n);
  float slant = 1. - max(dot(n, v), 0.), rim = slant * slant * slant * slant * mix(${CAR_GLOSS.rim[0].toFixed(2)}, ${CAR_GLOSS.rim[1].toFixed(2)}, uWet) * glass;
  vec3 tint = uSkyRef * ${CAR_GLOSS.sky.toFixed(1)} * coat + uSkyRef * ${CAR_GLOSS.rimSky.toFixed(1)} * rim;
  vec3 r = (vec4(reflect(-v, n), 0.) * viewMatrix).xyz;
  float s4 = slant * slant * slant * slant;
  vec3 mirrored = carStreetSoft(r, area, p, ${R.street.soft.toFixed(1)} * uStreetView) * (mix(${R.top.toFixed(2)}, ${R.street.top.toFixed(2)}, uStreetView) + mix(${R.side.toFixed(2)}, ${R.street.side.toFixed(2)}, uStreetView) * s4) * glass * mix(1., ${R.wet.toFixed(2)}, uWet);
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
varying vec3 vCrack;
vec2 swing(vec2 p) {
  if (hinge.z < .5) return p;
  float a = hinge.z < 1.5 ? -doors.x : hinge.z < 2.5 ? doors.y : hinge.z < 3.5 ? -doors.z : doors.w;
  float c = cos(a), s = sin(a);
  return vec2(p.x * c + p.y * s, p.y * c - p.x * s);
}
${DENT_GLSL}`)
    // A lamp: dark when it's broken, glowing when it's on (the same in TSL: webgpu/vehicles.ts).
    .replace('#include <color_vertex>', `#include <color_vertex>
float own = mod(floor(painted), 16.), lamp = floor(own * .5 + .01);
vColor.rgb *= mix(vec3(1.), paint.rgb, own - 2. * lamp);
vCrack = vec3(position.xz, own < .5 && dot(vColor.rgb, vec3(.3, .59, .11)) < .04 && vColor.b > vColor.r * 1.25 ? crackedAt(zoneAt()) : 0.);
vLit = 0.;
if (lamp > .5) {
  float tail = mod(floor(paint.w / 32.), 4.);
  vLit = lamp < 2.5 ? mod(floor(paint.w / 16.), 2.) : tail > 1.5 ? 1.5 : tail * .45;
  if (mod(floor(paint.w / exp2(lamp - 1.)), 2.) > .5) { vLit = -1.; vColor.rgb = vec3(.05, .05, .055); }
}
vLit += 4. * mod(floor(paint.w / ${AREA_STEP}.), ${DENT_STEP / AREA_STEP}.);`)
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvec4 dents = dentAt(zoneAt());\nobjectNormal = dentNormal(objectNormal, position, dents);\nobjectNormal.xz = swing(objectNormal.xz);')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = dented(transformed, dents);\ntransformed.xz = hinge.xy + swing(transformed.xz - hinge.xy);');
  sh.uniforms.uSnow = SNOW;
  Object.assign(sh.uniforms, { uWet: WET, ...VEHICLE_VIEW_UNIFORMS, uMirror: CAR_MIRROR, uVrAt: VR_GLASS.at, uVrBox: VR_GLASS.box });
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\nuniform float uSnow;\nvarying float vLit;\nvarying vec3 vCrack;\nuniform vec4 uVrAt, uVrBox;\n#define VR_GLAZED (dot(vColor.rgb, vec3(.3, .59, .11)) < .04 && vColor.b > vColor.r * 1.25)\n${COAT_GLSL}\n${CRACKS_GLSL}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (uVrBox.w > .5) {
    vec3 vrW = cameraPosition + (vec4(-vViewPosition, 0.) * viewMatrix).xyz - uVrAt.xyz;
    float vrC = cos(uVrAt.w), vrS = sin(uVrAt.w);
    if (abs(vrW.x * vrC - vrW.z * vrS) < uVrBox.x && abs(vrW.x * vrS + vrW.z * vrC) < uVrBox.y && abs(vrW.y) < uVrBox.z
      && (opacity < .99 || VR_GLAZED)) discard;
  }
  float area = floor((vLit + 1.5) / 4.), lit = vLit - 4. * area;
  totalEmissiveRadiance += diffuseColor.rgb * max(lit, 0.) * ${LAMP_GLOW.toFixed(2)};`)
    .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
  if (uSnow > .01) {
    float up = dot(normal, (viewMatrix * vec4(0., 1., 0., 0.)).xyz);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.8, .82, .86), smoothstep(.75, .95, up) * smoothstep(.1, .6, uSnow) * .6);
  }
  if (vCrack.z > .01) diffuseColor.rgb = mix(mix(diffuseColor.rgb, vec3(.6), ${DENT_SHAPE.milk.toFixed(2)}), vec3(${DENT_SHAPE.crack.map((v) => v.toFixed(2)).join(', ')}), cracks(vCrack.xy)) * vCrack.z + diffuseColor.rgb * (1. - vCrack.z);
  vec3 coatC = diffuseColor.rgb;
  diffuseColor.rgb *= mix(1., ${CAR_GLOSS.darker.toFixed(2)}, uWet * carTop(normal));`)
    .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directDiffuse += carCoat(coatC, normal, normalize(vViewPosition), lampLightOn(vLampW, normal), area, cameraPosition + (vec4(-vViewPosition, 0.) * viewMatrix).xyz);');
};
material.customProgramCacheKey = () => 'cars';
// Worn enamel and rubber pick up little of the surrounding street when dry.
// The blue-grey cab glazing keeps the normal vehicle reflections.
export const DUSTCART_COAT = { dry: 0.055, wet: 0.23 };
const dustcartMaterial = material.clone();
dustcartMaterial.specular.setScalar(0.035);
dustcartMaterial.shininess = 18;
dustcartMaterial.customProgramCacheKey = () => 'cars-dustcart';
dustcartMaterial.onBeforeCompile = (sh, renderer) => {
  material.onBeforeCompile(sh, renderer);
  sh.fragmentShader = sh.fragmentShader.replace('reflectedLight.directDiffuse += carCoat(',
    `float finish = (dot(vColor.rgb, vec3(.3,.59,.11)) < .04 && vColor.b > vColor.r * 1.25)
      ? 1. : mix(${DUSTCART_COAT.dry}, ${DUSTCART_COAT.wet}, uWet);
     reflectedLight.directDiffuse += finish * carCoat(`);
};
// The window pass shares the car shader (including dents, cracks and reflections)
// and instance transforms with the opaque service body.
const serviceMaterials = new Map<string, THREE.MeshPhongMaterial[]>();
function streetMaterials(atlas: string) {
  let materials = serviceMaterials.get(atlas);
  if (!materials) {
    const body = material.clone(), glass = material.clone();
    body.map = new THREE.TextureLoader().load(import.meta.env.BASE_URL + atlas);
    body.map.colorSpace = THREE.SRGBColorSpace;
    body.map.anisotropy = 4;
    glass.transparent = true;
    glass.opacity = 0.48;
    glass.depthWrite = false;
    for (const part of [body, glass]) {
      part.onBeforeCompile = material.onBeforeCompile;
      part.customProgramCacheKey = material.customProgramCacheKey;
    }
    body.specular.setScalar(0.07);
    body.customProgramCacheKey = () => 'cars-service';
    body.onBeforeCompile = (sh, renderer) => {
      material.onBeforeCompile(sh, renderer);
      sh.fragmentShader = sh.fragmentShader.replace('reflectedLight.directDiffuse += carCoat(',
        'reflectedLight.directDiffuse += mix(.035, 1., smoothstep(.035, .22, dot(vColor.rgb, vec3(.3,.59,.11)))) * carCoat(');
    };
    materials = [body, glass];
    serviceMaterials.set(atlas, materials);
  }
  return materials;
}
// roll.xy rotates the wheels. roll.z packs steering and diagonal axle travel.
// The magnitude of roll.w is the registration; a negative sign marks the sprung car.
const streetWheelMaterial = material.clone();
streetWheelMaterial.customProgramCacheKey = () => 'cars-close';
streetWheelMaterial.onBeforeCompile = (sh, renderer) => {
  material.onBeforeCompile(sh, renderer);
  sh.fragmentShader = sh.fragmentShader.replace(/#define VR_GLAZED .*/, '#define VR_GLAZED false'); // (its glass is passengerGlass: a navy paint isn't glass)
  sh.uniforms.uRegistration = { value: registrationAtlas() };
  sh.uniforms.uWheelLevel = WHEEL_LEVEL;
  sh.vertexShader = sh.vertexShader.replace('if (hinge.z < .5) return p;', 'if (hinge.z < .5 || hinge.z > 4.5) return p;').replace('vec2 swing(vec2 p)', `
attribute vec4 roll;
uniform vec4 uWheelLevel;
vec3 wheelLevel(vec3 p) { return p + 2. * cross(uWheelLevel.xyz, cross(uWheelLevel.xyz, p) + uWheelLevel.w*p); }
varying float vWheelCoat;
varying vec2 vPlateUV;
vec3 rollWheel(vec3 p) {
  vec2 spun = hinge.z < -1. ? p.xy : vec2(roll.x*p.x-roll.y*p.y, roll.y*p.x+roll.x*p.y);
  float steer = roll.z-2.*floor((roll.z+1.)*.5);
  float c = sqrt(max(0.,1.-steer*steer));
  return hinge.x > 0. ? vec3(c*spun.x+steer*p.z, spun.y, -steer*spun.x+c*p.z) : vec3(spun,p.z);
}
vec2 swing(vec2 p)`)
    .replace('vec4 dents = dentAt(zoneAt());', 'vec4 dents = dentAt(zoneAt()); if (hinge.z < 0.) { objectNormal = rollWheel(objectNormal); if (roll.w < 0.) objectNormal = wheelLevel(objectNormal); }')
    .replace('transformed = dented(transformed, dents);', `float brightness = dot(color.rgb,vec3(.3,.59,.11));
bool glazed = brightness < .04 && color.b > color.r*1.25;
vWheelCoat = (mod(floor(painted),16.) == 0. && !glazed) ? mix(.08,1.,smoothstep(.035,.17,brightness)) : 1.;
vPlateUV = vec2(-1.);
if (hinge.z > 4.5 && hinge.z < 11.5) {
  float slot = hinge.z - 5.;
  float digit = slot == 1. ? 10. : mod(floor(abs(roll.w) / pow(10., min(5.,6.-slot))), 10.);
  vPlateUV = vec2((digit + .02 + .96 * hinge.x) / 16., .02 + .96*hinge.y);
}
if (hinge.z < 0.) {
  vec3 axle = vec3(hinge.x, -hinge.z - (hinge.z < -1. ? 2. : 0.), hinge.y);
  transformed = axle + rollWheel(transformed - axle);
  transformed.y += sign(-hinge.x*hinge.y)*.0025*floor((roll.z+1.)*.5);
  if (roll.w < 0.) {
    vec3 pivot = vec3(0., ${ROLL_CENTRE}, 0.);
    transformed = pivot + wheelLevel(transformed - pivot);
  }
  vWheelCoat = mix(.045,.45,smoothstep(.045,.24,dot(color.rgb,vec3(.3,.59,.11))));
}
if (hinge.z > 11.5) vWheelCoat = .065;
transformed = dented(transformed, dents);`);
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vWheelCoat; varying vec2 vPlateUV; uniform sampler2D uRegistration;')
    .replace('#include <color_fragment>', '#include <color_fragment>\n if (vPlateUV.x >= 0.) diffuseColor.rgb *= texture2D(uRegistration, vPlateUV).rgb;')
    .replace('#include <specularmap_fragment>', '#include <specularmap_fragment>\n specularStrength *= vWheelCoat;')
    .replace('reflectedLight.directDiffuse += carCoat(', 'reflectedLight.directDiffuse += vWheelCoat * carCoat(');
};
const passengerGlass = material.clone();
passengerGlass.transparent = true;
passengerGlass.opacity = 0.7;
passengerGlass.depthWrite = false;
passengerGlass.side = THREE.DoubleSide;
passengerGlass.forceSinglePass = true;
passengerGlass.onBeforeCompile = material.onBeforeCompile;
passengerGlass.customProgramCacheKey = material.customProgramCacheKey;
const passengerMaterials = [streetWheelMaterial, passengerGlass];
const coachGlass = passengerGlass.clone();
coachGlass.customProgramCacheKey = () => 'cars-coachglass';
coachGlass.onBeforeCompile = (sh, renderer) => {
  material.onBeforeCompile(sh, renderer);
  sh.vertexShader = sh.vertexShader.replace('varying float vLit;', 'varying float vLit; varying vec2 vGlassTint;')
    .replace('#include <color_vertex>', '#include <color_vertex>\nvGlassTint=vec2(floor(fract(painted)*16.+.5), position.y);');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vGlassTint;')
    .replace('#include <opaque_fragment>', `
    float grazing = pow(1. - abs(dot(normal, normalize(vViewPosition))), 3.);
    float cover = step(7.5,vGlassTint.x), rear = 1.-step(.4,abs(vGlassTint.x-7.));
    diffuseColor.a = mix(.39+.15*smoothstep(1.22,1.41,vGlassTint.y)+.18*rear, .085, cover) + grazing * mix(.32,.26,cover);
    #include <opaque_fragment>`);
};
const coachPaint = new THREE.MeshPhysicalMaterial({
  vertexColors: true, roughness: .42, metalness: .30, clearcoat: .86, clearcoatRoughness: .18,
  shadowSide: THREE.DoubleSide,
});
coachPaint.customProgramCacheKey = () => 'cars-coachwork';
coachPaint.onBeforeCompile = (sh, renderer) => {
  streetWheelMaterial.onBeforeCompile(sh, renderer);
  sh.uniforms.uInstruments = { value: sedanInstruments() };
  sh.uniforms.uWeave = { value: sedanWeave() };
  sh.vertexShader = sh.vertexShader
    .replace('varying float vWheelCoat;', 'varying float vWheelCoat; varying float vFinish; varying vec3 vDial; varying float vEngine;')
    .replace('vec2 spun = hinge.z < -1. ? p.xy : vec2(roll.x*p.x-roll.y*p.y, roll.y*p.x+roll.x*p.y);',
      'vec2 phase = normalize(roll.xy); vec2 spun = hinge.z < -1. ? p.xy : vec2(phase.x*p.x-phase.y*p.y,phase.y*p.x+phase.x*p.y);')
    .replace('transformed = axle + rollWheel(transformed - axle);', `transformed= axle + rollWheel(transformed - axle);
      if(hinge.z > -1.) transformed.y=max(0.,transformed.y-.010*(1.-smoothstep(0.,.045,transformed.y)));`)
    .replace('vPlateUV = vec2(-1.);', `vPlateUV = vec2(-1.);
      vFinish = floor(fract(painted)*16.+.5);
      if (hinge.z<0.) vFinish=brightness>.068?2.:4.;
      vDial=vec3(hinge.xy,hinge.z); vEngine=length(roll.xy);`);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vFinish; varying vec3 vDial; varying float vEngine; uniform sampler2D uInstruments; uniform sampler2D uWeave;')
    .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor=vFinish==1.?mix(.34,.23,uWet):vFinish==2.?.28:vFinish==3.?.91:vFinish==5.?.20:.68;`)
    .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
      metalnessFactor=vFinish==1.?.28:vFinish==2.?.72:.015;`)
    .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      material.clearcoat=vFinish==1.?.86:vFinish==5.?.38:0.;`)
    .replace('#include <color_fragment>', `#include <color_fragment>
      if(vDial.z>13.5 && vDial.z<15.5){
        vec3 art=texture2D(uInstruments,vDial.xy).rgb;
        if(vDial.z<14.5){
          vec2 p=vec2(vDial.x*512.-256.,(1.-vDial.y)*256.-78.);
          float a=radians(136.+268.*clamp(vEngine-2.,0.,1.)); vec2 d=vec2(cos(a),sin(a));
          float tip=1.-smoothstep(.7,2.,length(p-d*clamp(dot(p,d),3.,51.)));
          art=mix(art,vec3(.71,.16,.063),tip);
        }else art=mix(vec3(.014,.021,.025),art,step(1.5,vEngine));
        diffuseColor.rgb*=art;
      } else if(vDial.z>15.5 && vDial.z<16.5){
        diffuseColor.rgb*=.35+1.32*texture2D(uWeave,vDial.xy).r;
      }`)
    .replace('reflectedLight.directDiffuse += vWheelCoat * carCoat(', 'reflectedLight.directDiffuse += (vFinish==3.?.018:vFinish==4.?.065:vFinish==6.?.085:vWheelCoat) * carCoat(');
};
const sedanMaterials = [coachPaint, coachGlass];
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
  streetHeadlights?: CarSpec['headlights'];
  type: string;
  variant: Variant | null = null;
  spec: CarSpec;
  mass: number;
  key: string;
  paint: string;
  x: number; y: number; h: number;
  vx: number; vy: number; w: number;
  mode: string;
  entryDriver = false; // waits in the seat while the normal door interaction runs
  damage: number;
  touchDriving = false;
  pedaling = false;
  rider: Look | null;
  lean: number;
  suspension?: StreetHandling;
  // Which side an unmounted bike fell onto.
  tipped?: -1 | 1;
  // A car or van rolling over, or lying where it stopped (rollover.ts); gone once it's
  // back on its wheels.
  roll?: Rollover;
  r: number;
  offsets: number[];
  samples: Point2[];
  level?: number;
  gz?: number;
  hint?: RoadHint;
  grounded?: boolean;
  roadLevel?: number;
  lastH?: number;
  anim?: Anim;
  crew?: boolean;
  // A police car, fire engine or ambulance you're driving: its blue lights, the lights and
  // the siren, or neither (X). Lights alone until you change it.
  beacon?: 'lights' | 'siren' | 'off';
  // A dustcart standing at a house while its crew fetch the bins (refuse.ts).
  working?: boolean;
  // A dustcart out on its round: traffic behind it leaves room at the back for the crew
  // tipping bins into it.
  binRound?: boolean;
  // In traffic, standing for a tram in its way (traffic.ts): where that tram's body is.
  // The tram, if it is waiting for this car in turn, pushes it aside at once (trams.ts).
  forTram?: [number, number];
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
  // How crumpled the corners and sides are (see DENT).
  crush = [0, 0, 0, 0, 0, 0];
  braking = false;
  treeEscape?: TreeEscape;
  // A police car with the frame on its nose, which keeps its headlamps from breaking.
  ram?: boolean;
  // Seconds still spinning after a blow to its tail (see upset).
  spin = 0;
  // The resting index's last obstacle state (main.ts, restingCars.ts). The pose is
  // kept as plain numbers; the circle offsets are the constructor's own array, so a
  // change of shape must replace the array to be noticed.
  _tx?: number; _ty?: number; resting?: boolean; restAt?: [number, number, number];
  restFields?: { gz?: number; r: number; vx: number; vy: number; offsetsRef: readonly number[]; n: number };
  stamp?: number;
  // Looked over since it last stood still: not inside another car (main.ts). Two
  // standing cars aren't checked against each other, so one that stops inside another,
  // or is put down there, gets steps until nothing pushes it any more.
  settled?: boolean;

  constructor(type: string, r: () => number, x = 0, y = 0, h = 0, colour?: string, box?: string) {
    this.type = type;
    this.spec = TYPES[type];
    const paints = TWO_PAINT[type] || PAINT;
    // Keep the colour pick before refitting, even for a fixed or explicit colour.
    const paintRoll = r();
    const pick = paints[Math.floor(paintRoll * paints.length)], paint = colour || this.spec.color || pick;
    this.refit(r);
    this.mass = this.spec.mass;
    this.paint = this.spec.color || paint;
    // Police liveries come as a set with their body. The saved paint identifies
    // the set on reload, including the silver estates in older saves.
    if (type === 'police' && (colour ? colour === CITY_WHITE : paintRoll >= .65)) this.paint = CITY_WHITE;
    this.key = bodyKey(this.bodyType, box);
    carGeometry(this.bodyType, box);
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

  private get bodyType() { return this.type === 'police' && this.paint === CITY_WHITE ? CITY_PATROL : this.type; }
  get doors() { return doorsOf(this.bodyType); }

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
      if (this.speed > 1.5 && !(this.mode === 'police' && !this.crew)) d[4 + i] = 0;
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

  // A blow that turned the car by `dw` rad/s, landing (rx, ry) from its middle (from
  // collideBodies). Behind the middle and from the side (a police car's PIT manoeuvre, a
  // car clipping your back corner) it swings the tail out faster than the back tyres can
  // hold it, and the car spins on for a moment (`spin`, arcadeVelocity). Not a bike or a
  // motorbike, nor a bus or a lorry, nor a car nobody drives (that one turns freely anyway).
  // On its side or its roof: nobody drives it or gets into it.
  get overturned() { return !!this.roll && (this.roll.moving || this.roll.face !== 'wheels'); }
  // Rollovers are for four wheels, and only for your car and the ones nobody drives (a car
  // in traffic that's been hit leaves the traffic first; the police and the fire brigade
  // don't know what to do with one on its roof).
  private get canRoll() { return !this.two && (this.mode === 'player' || this.mode === 'loose'); }
  // Tips it over: the roof thrown to its left (side +1) or right (−1) by a trip that
  // stopped `speed` m/s of sideways slide.
  tip(side: number, speed: number) {
    if (this.roll) this.roll.push(this.spec, side, speed);
    else this.roll = new Rollover(this.spec, side, speed);
    this.suspension = undefined;
    this.spin = 0;
  }
  // A blow from another vehicle changed its speed by (dvx, dvy): pushed sideways hard
  // enough, the tyres hold the bottom while the body goes on over them.
  jolted(dvx: number, dvy: number) {
    if (!this.canRoll) return;
    const across = -dvx * Math.sin(this.h) + dvy * Math.cos(this.h), need = tripSpeed(this.spec);
    if (Math.abs(across) > 3 * need || (this.roll && Math.abs(across) > 1.5 * need)) this.tip(Math.sign(across), Math.abs(across) * 0.6);
  }

  upset(rx: number, ry: number, dw: number) {
    if (!this.driven || this.two || this.spec.heavy || Math.abs(dw) < SPIN.from) return;
    if (rx * Math.cos(this.h) + ry * Math.sin(this.h) > -this.spec.L * 0.15) return;
    this.w = clamp(this.w + dw * SPIN.carry, -SPIN.fastest, SPIN.fastest);
    this.spin = Math.min(SPIN.most, Math.max(this.spin, Math.abs(dw) * SPIN.per));
  }

  // Fits the ram frame (a police car's).
  armour() {
    if (this.ram || this.burnt) return;
    this.ram = true;
    this.broken &= ~(LAMP.headLeft | LAMP.headRight);
    this.key = bodyKey(this.bodyType, RAM);
    carGeometry(this.bodyType, RAM);
  }

  // Something hit the car at (x, y) at `force` m/s: a lamp the blow lands on is smashed.
  // The harder the knock, the further from it a lamp still breaks.
  knock(x: number, y: number, force: number) {
    if (this.two || force < DENT.from) return;
    const c = Math.cos(this.h), s = Math.sin(this.h), dx = x - this.x, dy = y - this.y;
    const L = this.spec.L / 2, W = this.spec.W / 2;
    const along = clamp(dx * c + dy * s, -L, L), left = clamp(dy * c - dx * s, -W, W);
    this.dent(along, left, (force - DENT.from) / DENT.per);
    if (force < BREAKS || this.broken === 15) return;
    // (A wall met nose first is first touched with one corner: at 60 km/h the blow still
    // reaches the lamp at the other one, at 50 it doesn't.)
    const reach = Math.min(1.7, 0.5 + 0.1 * (force - BREAKS)) * Math.max(1, W / 0.95);
    for (const [bit, a, l] of [[LAMP.headLeft, L, W - 0.3], [LAMP.headRight, L, 0.3 - W], [LAMP.tailLeft, -L, W - 0.3], [LAMP.tailRight, -L, 0.3 - W]]) {
      if (this.ram && a > 0) continue;
      if (Math.hypot(along - a, left - l) < reach) this.broken |= bit;
    }
  }

  // Crumples the car where a blow lands (`along` and `left` of its middle) by `levels`:
  // the corners at that end, the more the nearer it is (a blow in the middle of the nose
  // takes both), or the side.
  dent(along: number, left: number, levels: number) {
    const L = this.spec.L / 2, u = left / (this.spec.W / 2), k = this.crush;
    const add = (i: number, v: number) => { k[i] = Math.min(3, k[i] + levels * clamp(v, 0, 1)); };
    if (Math.abs(along) > L - DENT.end) {
      const i = along > 0 ? 0 : 2;
      add(i, 1 + 1.5 * u);
      add(i + 1, 1 - 1.5 * u);
    } else add(u > 0 ? 4 : 5, 0.7);
  }
  // The dents as the shader takes them (DENT).
  get dents() {
    let d = 0;
    for (let i = 0; i < 6; i++) d += Math.min(3, Math.floor(this.crush[i])) * 4 ** i;
    return d;
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
  update(dt: number, ctl: CarControl | null, grid: CarGrid, realistic = false) {
    if (grid.view) grid = grid.view(this);
    if (this.roll) return this.rolling(dt, grid);
    ctl = ctl || { throttle: 0, steer: 0, handbrake: false };
    // (Your own car takes the developer panel's handling multipliers, driveTune.ts.)
    const S = this.mode === 'player' ? drivingSpec(this.spec) : this.spec, fx = Math.cos(this.h), fy = Math.sin(this.h);
    let slope = 0;
    if (grid.height) {
      const half = S.L / 2;
      slope = (grid.height(this.x + fx * half, this.y + fy * half) - grid.height(this.x - fx * half, this.y - fy * half)) / S.L;
    }
    const weatherLoss = this.driven ? (S.weather ?? 1) * Math.max(.25 * WET.value, .45 * SNOW.value * STREET_SNOW.value, .25 * SNOW.value) : 0;
    // Sliding sideways up a kerb (or a step in the ground) fast enough trips it over.
    const tripAt = this.canRoll ? tripSpeed(S) : Infinity;
    const across = -this.vx * fy + this.vy * fx;
    // (Half as fast again as the bare trip speed: a kerb's edge and a tyre's wall give a little.)
    if (grid.height && Math.abs(across) > 1.5 * tripAt) {
      const side = Math.sign(across), lx = -fy * side, ly = fx * side, out = S.W / 2 + 0.25, here = grid.height(this.x, this.y);
      let rise = 0;
      for (const a of [-S.L / 3, 0, S.L / 3]) rise = Math.max(rise, grid.height(this.x + fx * a + lx * out, this.y + fy * a + ly * out) - here);
      if (rise > 0.07 && rise < 0.8) {
        this.vx += fy * across;
        this.vy -= fx * across;
        this.tip(side, Math.abs(across));
        return this.rolling(dt, grid);
      }
    }
    const thrust = ctl.cap == null || ctl.throttle <= 0 ? ctl.throttle : Math.min(ctl.throttle, clamp((ctl.cap - (this.vx * fx + this.vy * fy)) / 2, 0, 1));
    if (S.two === 'bike') this.pedaling = thrust > .02 && !ctl.handbrake;
    if (realistic && this.mode === 'player' && S.cabin) {
      this.suspension ??= new StreetHandling(this.forwardSpeed, closeBodies.get(this.key)?.wheelbase ?? S.L * .62);
      this.suspension.advance(this, S, ctl, 1 - weatherLoss, slope, dt);
    } else {
      this.suspension = undefined;
      this.arcadeVelocity(S, dt, ctl, thrust, fx, fy, slope, 1 - weatherLoss * (S.drive === 'awd' ? .6 : 1));
    }

    // Substeps so a fast car can't skip through a thin wall.
    const escape = this.mode === 'player' && grid.trunkAt ? (this.treeEscape ??= new TreeEscape()) : undefined;
    escape?.begin(this, !ctl.handbrake && Math.abs(thrust) >= .2 ? Math.sign(thrust) : 0);
    const before = -this.vx * Math.sin(this.h) + this.vy * Math.cos(this.h);
    const impact = this.move(dt, grid);
    escape?.end(this, dt);
    // Sliding sideways into a post or a wall: stopped hard enough, it goes over.
    const stopped = -this.vx * Math.sin(this.h) + this.vy * Math.cos(this.h) - before;
    if (before * stopped < 0 && Math.abs(stopped) > 2.6 * tripAt) this.tip(Math.sign(before), Math.abs(stopped) * 0.7);
    return impact;
  }

  // Moves it on by its speed, against posts, fences and walls. Returns the hardest blow.
  private move(dt: number, grid: CarGrid) {
    // Substeps so a fast car can't skip through a thin wall.
    const steps = Math.max(1, Math.ceil((this.speed * dt) / 0.25));
    let impact = 0, struck: ImpactKind = 'wall';
    for (let i = 0; i < steps; i++) {
      this.x += (this.vx * dt) / steps;
      this.y += (this.vy * dt) / steps;
      const post = posts.collide(this), fence = fences.collide(this), wall = this.collideGrid(grid);
      if (post > impact) { impact = post; struck = 'post'; }
      if (fence > impact) { impact = fence; struck = fences.struck; }
      if (wall > impact) { impact = wall; struck = 'wall'; }
    }
    this.sync();
    // Heard (src/impacts.ts), whoever's car it is.
    crash(this, null, impact, struck, this.x, this.y, this.spec.mass);
    return impact;
  }

  // Rolling over, or lying on its side or roof: no driving, the body scraping along the
  // road until it stops. Back on its wheels, it drives again.
  private rolling(dt: number, grid: CarGrid) {
    const r = this.roll!;
    const speed = this.speed, keep = speed > 0 ? Math.max(0, speed - (r.face === 'wheels' && !r.moving ? 2 : SCRAPE) * dt) / speed : 0;
    this.vx *= keep;
    this.vy *= keep;
    this.w *= Math.exp(-3 * dt);
    this.h += this.w * dt;
    this.braking = false;
    this.skidBack = this.skidFront = 0;
    const { across, landing } = r.step(dt);
    this.x += -Math.sin(this.h) * across;
    this.y += Math.cos(this.h) * across;
    this.lean = -r.angle;
    if (landing > 0.5) {
      this.takeImpactDamage(landing * 2);
      crash(this, null, landing * 2.2, 'car', this.x, this.y, this.spec.mass);
    }
    if (!r.moving && r.face === 'wheels') { this.roll = undefined; this.lean = 0; }
    return Math.max(this.move(dt, grid), landing * 2.2);
  }

  private arcadeVelocity(S: CarSpec, dt: number, ctl: CarControl, throttle: number, fx: number, fy: number, slope: number, road: number) {
    let vf = this.vx * fx + this.vy * fy;
    let vl = this.vx * fy - this.vy * fx;
    const fast = clamp(Math.abs(vf) / S.vmax, 0, 1);
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
    vf -= 9.81 * slope * dt;
    if (ctl.cap != null && vf > ctl.cap) vf = Math.max(ctl.cap, vf - 3 * dt);

    // Spun by a blow to the tail (upset): the tyres slide and the steering barely holds
    // the car until it wears off. Steering against the spin gets it back three times as fast.
    let lost = 0;
    if (this.spin > 0) {
      this.spin -= dt * (ctl.steer * this.w * vf < 0 && Math.abs(ctl.steer) > 0.3 ? 3 : 1);
      lost = clamp(this.spin / SPIN.fade, 0, 1);
    }

    // Full throttle in a bend: the driven wheels lose sideways grip (rear-wheel drive)
    // or the car runs wide (front-wheel drive, below).
    const power = this.driven && !S.two ? clamp(throttle, 0, 1) : 0;
    const bend = power * Math.min(1, Math.abs(ctl.steer)) * clamp(Math.abs(vf) / 10, 0, 1);
    // A car already sliding keeps sliding more easily (a tyre skidding grips less than
    // one rolling), so a slide carries on for a moment after the handbrake is let go,
    // and longer with the gas held in a rear-wheel-drive car.
    const sliding = clamp((Math.abs(vl) - 1) / 5, 0, 1);
    const grip = (ctl.handbrake ? 1.1 : S.grip * (1 - (S.fade ?? 0.45) * fast) * (S.drive === 'rwd' ? 1 - (0.3 + 0.5 * sliding) * bend : 1) * (1 - 0.6 * sliding)) * road;
    vl *= Math.exp(-grip * (1 - SPIN.slide * lost) * dt);
    // How much of the car's turning its travel follows. Rolling tyres take it all; with
    // the back wheels locked by the handbrake the nose swings round while the car goes
    // on the way it was going, and the difference is the slide.
    // A wet or snowy road lets the car drift wide in any brisk turn, a little in the rain
    // and more on snow.
    const loose = 1.8 * (1 - road) * clamp((Math.abs(vf) - 4) / 10, 0, 1);
    const follow = ctl.handbrake && this.driven ? 1 - 0.8 * clamp((Math.abs(vf) - 3) / 5, 0, 1)
      : (S.drive === 'rwd' ? 1 - 0.6 * bend * sliding : 1) * (1 - loose);
    // Tyre marks: sliding sideways, the back wheels locked by the handbrake, or all
    // four braking hard.
    const slide = clamp((Math.abs(vl) - 1.5) / 4, 0, 1);
    const braking = (throttle < 0 && vf > 4) || (throttle > 0 && vf < -4) ? 0.6 : 0;
    this.skidBack = Math.max(slide, braking, ctl.handbrake && Math.abs(vf) > 2 ? 0.8 : 0);
    this.skidFront = Math.max(slide * 0.7, braking);

    const sgn = vf >= 0 ? 1 : -1;
    const maxW = S.turn * (1 - 0.35 * fast) * (ctl.handbrake ? 1.35 : 1) * (!S.drive || S.drive === 'fwd' ? 1 - 0.12 * bend : 1);
    // Sliding, the back keeps swinging round on the car's whole speed, not just the part
    // still along its nose.
    const swing = ctl.handbrake ? Math.hypot(vf, vl) : Math.abs(vf);
    const wantW = ctl.steer * Math.min(swing / (S.radius ?? 3.6), maxW) * sgn;
    // (Spun by a blow, the steering answers at the car's own pace, whatever the driving
    // sliders say: quicker steering would catch every spin at once.)
    const response = lost > 0 ? this.spec.response ?? 9 : S.response ?? 9;
    if (this.driven) this.w += (wantW - this.w) * Math.min(1, dt * response) * (1 - SPIN.hold * lost);
    else this.w *= Math.exp(-4 * dt);
    this.h += this.w * dt;

    const travel = this.h - this.w * dt * (1 - follow * (1 - lost));
    const nx = Math.cos(travel), ny = Math.sin(travel);
    this.vx = nx * vf + ny * vl;
    this.vy = ny * vf - nx * vl;

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

  // Scale damage separately from the force of a collision.
  takeImpactDamage(amount: number) {
    const scale = this.two ? 1 : this.mode === 'player' && this.touchDriving ? 0.7 : 0.85;
    this.damage += amount * scale;
  }

  collideGrid(grid: CarGrid) {
    const escape = this.mode === 'player' && grid.trunkAt ? this.treeEscape : undefined;
    const ignored = escape?.ignored, seeking = escape?.seeking;
    const solid = (x: number, y: number) => grid.at(x, y) && (!ignored || grid.trunkAt?.(x, y) !== ignored) ? 1 : 0;
    let nx = 0, ny = 0, hits = 0, cx = 0, cy = 0;
    for (const [x, y] of this.worldOutline()) {
      if (!solid(x, y)) continue;
      if (seeking) escape?.hit(grid.trunkAt?.(x, y));
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
    this.takeImpactDamage(Math.max(0, -vn - (this.spec.tough ?? 3)));
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

  // Both views draw the same wreck, including when the camera changes afterwards.
  burn() {
    const fit = this.courier ?? (this.ram ? RAM : undefined);
    const k = `${this.bodyType}${this.ram ? '|ram' : ''}|burnt`;
    charBody(k, carGeometry(this.bodyType, fit), this.paint);
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
  wheelTwist?: number;
  m: number[]; height: unknown; terrain: number;
  x: number; y: number; h: number; lean: number; L: number; W: number;
  level?: number; gz?: number; hint?: RoadHint; grounded?: boolean; roadLevel?: number; tx?: number; ty?: number; e?: unknown;
}

function placed(p: Placing, c: Car, height: unknown, terrain: number) {
  const t = c as Car & { _tx?: number; _ty?: number; e?: unknown };
  return p.height === height && p.terrain === terrain && p.x === c.x && p.y === c.y && p.h === c.h && p.lean === c.lean &&
    p.L === c.spec.L && p.W === c.spec.W && p.level === c.level && p.gz === c.gz && p.hint === c.hint &&
    p.grounded === c.grounded && p.roadLevel === c.roadLevel && p.tx === t._tx && p.ty === t._ty && p.e === t.e;
}

// Notes a matrix for reuse (in `p`, if there is one already), unless something in it
// isn't a number.
function place(p: Placing | undefined, c: Car, height: unknown, terrain: number, m: THREE.Matrix4): Placing | undefined {
  if (!m.elements.every(Number.isFinite)) return undefined;
  const t = c as Car & { _tx?: number; _ty?: number; e?: unknown };
  p ??= { m: new Array(16), height, terrain, x: 0, y: 0, h: 0, lean: 0, L: 0, W: 0 };
  m.toArray(p.m);
  p.height = height; p.terrain = terrain; p.x = c.x; p.y = c.y; p.h = c.h; p.lean = c.lean; p.L = c.spec.L; p.W = c.spec.W;
  p.level = c.level; p.gz = c.gz; p.hint = c.hint; p.grounded = c.grounded; p.roadLevel = c.roadLevel; p.tx = t._tx; p.ty = t._ty; p.e = t.e;
  return p;
}

// The shade under a car (CarPool.under): how dark, how far under the car it is full
// (half its length, as a share), where it has faded out, how much further out at the sides,
// and how many cars at most. CAR_SHADE: whether it is drawn (graphics.ts: not on Lowest).
const UNDER = { shade: 0.5, dark: 0.4, out: 0.6, side: 0.12, most: 1500 };
export const CAR_SHADE = { value: 1 };
export class CarPool {
  scene: THREE.Scene;
  // 128 cars (8 KiB of matrices); overflow retains the original page.
  static readonly pageCapacity = 128;
  meshes: Map<string, THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>[]>;
  prepared = new Set<string>();
  overflowPages = 0;
  latePages = 0;
  groups: Map<string, Car[]>;
  dummy: THREE.Object3D;
  riders: Figures;
  playerRider?: Figures;
  // A packed draw slot changes as traffic enters and leaves the view. Track
  // the occupant separately so two vehicles can even share the same look.
  private riderIds = new WeakMap<Car,{look:Look; id:number}>();
  private nextRider = 0;
  private cranks?: CycleCranks;
  scale: THREE.Matrix4;
  life: THREE.Matrix4;
  m: THREE.Matrix4;
  boards: THREE.Mesh[] = [];
  private springEuler = new THREE.Euler(0, 0, 0, 'ZXY');
  private springRotation = new THREE.Quaternion();
  private springPose = new THREE.Matrix4();
  private springGround = new THREE.Matrix4();
  private colours = new Map<string, THREE.Color>();
  private hingeless = new WeakMap<THREE.BufferGeometry, THREE.BufferAttribute>();
  // Each parked four-wheeler's matrix and what it was worked out from (see placed).
  private placings = new WeakMap<Car, Placing>();
  // The kind of area at a place (reflections.ts; main.ts sets it), and each car's, looked
  // up again once it has gone some way.
  area: ((x: number, y: number) => number) | null = null;
  private areas = new WeakMap<Car, { x: number; y: number; k: number }>();

  // A soft dark patch on the ground under every car, a little wider than it: where the
  // sky can't reach. It is what makes a car sit on the street in shade, where it has no
  // shadow of its own to stand on. One mesh for all of them; sent again only when a car
  // drawn has moved.
  private under: THREE.InstancedMesh | null = null;
  private underSum = NaN;

  constructor(scene: THREE.Scene) {
    if (!kit) throw new Error('Figures kit is not loaded');
    this.scene = scene;
    this.meshes = new Map();
    this.groups = new Map();
    this.dummy = new THREE.Object3D();
    this.riders = new Figures(kit, 64);
    this.riders.lifeSize = true;
    scene.add(this.riders.mesh);
    this.scale = new THREE.Matrix4().makeScale(SCALE, SCALE, SCALE);
    this.life = new THREE.Matrix4();
    this.m = new THREE.Matrix4();
    const shade = softShade(UNDER.shade);
    if (shade) {
      // A unit rectangle (the car's length by its width): dark under the car, fading out past its edges.
      const g = new THREE.BufferGeometry(), pos: number[] = [], alpha: number[] = [];
      for (const [half, a] of [[UNDER.dark, 1], [UNDER.out, 0]]) for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(x * half, 0.05, z * (half + (a ? 0 : UNDER.side))); alpha.push(a); }
      const idx = [0, 2, 1, 0, 3, 2];
      for (let k = 0; k < 4; k++) { const n = (k + 1) % 4; idx.push(k, 4 + n, 4 + k, k, n, 4 + n); }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('alpha', new THREE.Float32BufferAttribute(alpha, 1));
      g.setIndex(idx);
      // (Unlike the ground's shading it is tested against the depth: a car under a bridge doesn't shade the deck.)
      Object.assign(shade, { depthTest: true, side: THREE.DoubleSide });
      this.under = new THREE.InstancedMesh(g, shade, UNDER.most);
      this.under.count = 0;
      this.under.frustumCulled = false;
      this.under.renderOrder = -1; // after the ground, before the cars and houses
      this.under.matrixAutoUpdate = false;
      scene.add(this.under);
    }
  }

  private page(key: string) {
    if (key === STREET_AMBULANCE) streetAmbulanceBody();
    if (key === STREET_AMBULANCE + '|burnt') charBody(key, streetAmbulanceBody(), TYPES.ambulance.color!);
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
    const wheels = key.endsWith('|street-wheels');
    if (wheels) geometry.setAttribute('roll', new THREE.InstancedBufferAttribute(new Float32Array(CarPool.pageCapacity * 4), 4));
    const street = key === STREET_AMBULANCE || key === STREET_FIRE;
    if (street || wheels || key.endsWith('|fitted')) {
      for (const g of body.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    }
    const finish = key === STREET_SEDAN ? sedanMaterials : wheels ? (body.groups.length ? passengerMaterials : streetWheelMaterial) : key === 'garbage' || key === 'garbage|burnt' ? dustcartMaterial : material;
    const fitted = key.endsWith('|fitted') && body.groups.length > 0;
    const materials = fitted ? [key === 'garbage|fitted' ? dustcartMaterial : material, passengerGlass] : street ? streetMaterials(key === STREET_FIRE ? 'fire-appliance.webp' : 'ambulance-livery.webp') : finish;
    const mesh = mirrored(new THREE.InstancedMesh(geometry, materials, CarPool.pageCapacity));
    mesh.userData.sharedMatrices = true; // (see configureRenderer in webgpu.ts)
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

  // Every page of every body (for the probe to leave out: probe.ts).
  *allMeshes() {
    for (const pages of this.meshes.values()) yield* pages;
    if (this.drivers) yield* this.drivers.meshes();
  }

  private drivers?: SeatedDrivers;
  private streetView = false;
  private closeCars = new Map<Car, string>();
  private closeBefore = new Map<Car, string>(); // (the last frame's, for KEEP)
  private departingCar?: Car;
  private departingSeat = new THREE.Matrix4();
  private departingDonor = 0;
  driverAtDoor(c: Car) {
    return c === this.departingCar ? {seat:this.departingSeat, donor:this.departingDonor} : null;
  }
  private rememberDriver(c: Car, donor: number, seat?: THREE.Matrix4) {
    if (!c.entryDriver || !seat) return;
    this.departingCar=c; this.departingDonor=donor; this.departingSeat.copy(seat);
  }
  private wheelTravel = new WeakMap<Car, { x: number; y: number; angle: number; plate: number }>();
  private renderKey(key: string) {
    if (this.streetView) {
      if (key === 'ambulance') return STREET_AMBULANCE;
      if (key === 'ambulance|burnt') return STREET_AMBULANCE + '|burnt';
    }
    return key;
  }

  // Where the last render put `c` (on the ground, tilted with it), into `out`; false if it wasn't drawn.
  matrixOf(c: Car, out: THREE.Matrix4) {
    const key = this.closeCars.get(c) ?? this.renderKey(c.key);
    const i = this.groups.get(key)?.indexOf(c) ?? -1;
    const page = i < 0 ? undefined : this.meshes.get(key)?.[Math.floor(i / CarPool.pageCapacity)];
    if (!page) return false;
    page.getMatrixAt(i % CarPool.pageCapacity, out);
    return true;
  }

  private areaOf(c: Car) {
    if (!this.area) return 0;
    const was = this.areas.get(c);
    if (was && Math.abs(c.x - was.x) + Math.abs(c.y - was.y) < 25) return was.k;
    const k = this.area(c.x, c.y);
    this.areas.set(c, { x: c.x, y: c.y, k });
    return k;
  }

  prepare(inventory: readonly CarBody[]) {
    for (const { type, box, pages = 1 } of inventory) {
      this.prepareBody(type, box, pages);
      if (type === 'police') this.prepareBody(CITY_PATROL, box, pages);
    }
  }

  private prepareBody(type: string, box: string | undefined, pages: number) {
    const key = bodyKey(type, box);
    carGeometry(type, box);
    while ((this.meshes.get(key)?.length || 0) < pages) this.page(key);
    this.prepared.add(key);
    const close = prepareStreetCar(type, box) ?? prepareFleetBody(type, box);
    if (close && !this.meshes.has(close)) {
      this.page(close); this.prepared.add(close);
      this.drivers ??= new SeatedDrivers(this.scene);
    }
    if (key === 'fire' && !this.meshes.has(STREET_FIRE)) {
      prepareStreetFire();
      this.page(STREET_FIRE);
      this.prepared.add(STREET_FIRE);
    }
    if (key === 'ambulance' && !this.meshes.has(STREET_AMBULANCE)) {
      this.page(STREET_AMBULANCE);
      this.prepared.add(STREET_AMBULANCE);
    }
  }

  // Compile the actual retained meshes with a valid instance, then restore every
  // count and matrix even if the renderer's guarded compile times out.
  async warm(compile: () => Promise<unknown>) {
    const saved: { mesh: THREE.InstancedMesh; count: number; visible: boolean; matrix: number[] }[] = [];
    try {
      for (const mesh of this.allMeshes()) {
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
  render(cars: Car[], height: ((x: number, y: number, car: Car) => number) | null = null, dt = 0, terrain?: number, streetView = false, eye?: { x: number; z: number }) {
    this.streetView = streetView;
    CAR_STREET.value = streetView ? 1 : 0;
    for (const c of cars) {
      if (c.two) this.lean(c, dt);
      else if (c.door) c.swing(dt);
    }
    [this.closeBefore, this.closeCars] = [this.closeCars, this.closeBefore];
    this.closeCars.clear();
    this.departingCar=undefined;
    this.drivers?.begin();
    this.cranks?.begin();
    for (const list of this.groups.values()) list.length = 0;
    for (const c of cars) {
      let key = this.renderKey(c.key);
      c.streetHeadlights = undefined;
      if (streetView && eye) {
        const distance2 = (c.x - eye.x) ** 2 + (c.y + eye.z) ** 2;
        // (The tier's reach, KEEP further once close, so a car near the line keeps one body.)
        const reach = (c.mode === 'player' ? Math.max(STREET_CAR_REACH, STREET_QUALITY.carReach) : STREET_QUALITY.carReach) * (this.closeBefore.has(c) ? KEEP : 1);
        // Start decoding a little before the model can enter the close view.
        const fit = distance2 < (reach + 14) ** 2 ? closeBodies.get(c.key) : undefined;
        if (fit && !fit.formed) requestStreetForm(fit.type);
        const close = distance2 < reach ** 2 ? fit : undefined;
        // (streetHeadlights: the lamps fitted into the close body, whose own glows lamps.ts leaves out.)
        if (c.key === 'fire' && distance2 < reach ** 2) {
          prepareStreetFire();
          key = STREET_FIRE;
          c.streetHeadlights = c.spec.headlights;
          this.closeCars.set(c, key);
        } else if (distance2 < reach ** 2 && streetFleet.has(c.key)) {
          key = streetFleet.get(c.key)!;
          c.streetHeadlights = c.spec.headlights;
          this.closeCars.set(c, key);
        } else if (close) {
          key = close.formed ?? close.key;
          c.streetHeadlights = close.fittedLamps;
          this.closeCars.set(c, key);
        }
      }
      if (!this.groups.has(key)) this.groups.set(key, []);
      this.groups.get(key)!.push(c);
    }
    const d = this.dummy;
    let riders = 0, nb = 0, shaded = 0, sum = 0;
    const under = this.under && CAR_SHADE.value > 0 ? this.under : null;
    // By night the cars that are driving have their lamps on (as in lamps.ts); the brake
    // lights show by day as well.
    const night = LAMP_ON.value > 0.005;
    for (const [k, list] of this.groups) {
      let pages = this.meshes.get(k);
      if (!pages) { this.latePages++; this.page(k); pages = this.meshes.get(k)!; }
      while (pages.length * CarPool.pageCapacity < list.length) { this.page(k); this.overflowPages++; }
      const driverSeat: number[] | undefined = cache.get(k)?.userData.driverSeat;
      list.forEach((c, i) => {
        const m = pages[Math.floor(i / CarPool.pageCapacity)];
        const slot = i % CarPool.pageCapacity;
        const keep = height && terrain !== undefined && !c.two && c.mode === 'loose' && !c.roll?.moving;
        const was = keep ? this.placings.get(c) : undefined;
        const suspension = streetView && c.mode === 'player' ? c.suspension : undefined;
        const axleFit = (k === STREET_SEDAN || (suspension && k.endsWith('|street-wheels'))) && !c.tipped && !c.roll ? closeBodies.get(c.key) : undefined;
        let twist = 0;
        if (was && (was.wheelTwist !== undefined) === !!axleFit && placed(was, c, height!, terrain!)) {
          d.matrix.fromArray(was.m); twist = was.wheelTwist ?? 0;
        }
        else {
          if (height) {
            const fx = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
            if (axleFit) {
              // Fit the chassis plane to the actual tyre contacts. Four heights
              // leave a single diagonal residual: opposing wheels take it up
              // in the suspension when one tyre is on a cobble or a kerb.
              const {front,rear,track,wheelbase}=axleFit, half=track/2;
              const wheel=(x:number,left:number)=>height(c.x+fx*x-fy*left,c.y+fy*x+fx*left,c);
              const fl=wheel(front,half),fr=wheel(front,-half),rl=wheel(rear,half),rr=wheel(rear,-half);
              const frontZ=(fl+fr)/2,rearZ=(rl+rr)/2;
              d.position.set(c.x,rearZ+(frontZ-rearZ)*(-rear/wheelbase),-c.y);
              d.rotation.set(Math.atan2((fl+rl-fr-rr)/2,track)-c.lean,c.h,Math.atan2(frontZ-rearZ,wheelbase),'YZX');
              twist=clamp((fl-fr-rl+rr)/4,-.10,.10);
            } else {
              const hf = height(c.x + fx * L, c.y + fy * L, c), hb = height(c.x - fx * L, c.y - fy * L, c);
              const hl = height(c.x - fy * W, c.y + fx * W, c), hr = height(c.x + fy * W, c.y - fx * W, c);
              d.position.set(c.x, (hf + hb + hl + hr) / 4, -c.y);
              d.rotation.set(Math.atan2(hl - hr, 2 * W) - c.lean, c.h, Math.atan2(hf - hb, 2 * L), 'YZX');
            }
          } else {
            d.position.set(c.x, 0, -c.y);
            d.rotation.set(-c.lean, c.h, 0, 'YZX');
          }
          if (c.tipped) d.position.y += Math.abs(Math.sin(c.lean)) * c.spec.W / 2;
          else if (c.roll) d.position.y += c.roll.lift;
          d.updateMatrix();
          // Noted after the ground was sampled, which tracks the car (level, gz, …).
          if (keep) {
            const p = place(was, c, height!, terrain!, d.matrix);
            if (p) { p.wheelTwist = axleFit ? twist : undefined; this.placings.set(c, p); } else this.placings.delete(c);
          }
        }
        if (suspension) {
          this.springGround.copy(d.matrix);
          const q = this.springRotation.setFromEuler(this.springEuler.set(suspension.roll, 0, suspension.pitch));
          const pose = this.springPose.makeRotationFromQuaternion(q), e = pose.elements;
          pose.setPosition(-e[4] * ROLL_CENTRE, (1 - e[5]) * ROLL_CENTRE, -e[6] * ROLL_CENTRE);
          d.matrix.multiply(pose);
          WHEEL_LEVEL.value.set(-q.x, -q.y, -q.z, q.w);
        }
        // A bike or motorbike shrinks with its rider in first person (FIGURE_SIZE).
        m.setMatrixAt(slot, c.two && FIGURE_SIZE.value < SCALE ? this.m.copy(d.matrix).multiply(this.life.makeScale(FIGURE_SIZE.value / SCALE, FIGURE_SIZE.value / SCALE, FIGURE_SIZE.value / SCALE)) : d.matrix);
        const roll = m.geometry.getAttribute('roll') as THREE.InstancedBufferAttribute | undefined;
        if (roll) {
          const fit = closeBodies.get(c.key)!;
          let travel = this.wheelTravel.get(c);
          if (!travel) {
            const hash = Math.imul(Math.round(c.x * 100), 73856093) ^ Math.imul(Math.round(c.y * 100), 19349663);
            travel = { x: c.x, y: c.y, angle: (c.x + c.y) % (2 * Math.PI), plate: 100000 + (hash >>> 0) % 900000 };
            this.wheelTravel.set(c, travel);
          }
          const distance = (c.x - travel.x) * Math.cos(c.h) + (c.y - travel.y) * Math.sin(c.h);
          travel.angle = (travel.angle - distance / fit.radius) % (2 * Math.PI);
          travel.x = c.x; travel.y = c.y;
          const speed = c.forwardSpeed;
          const steer = suspension?.steer ?? (Math.abs(speed) > 0.25 ? clamp(Math.atan(c.w * fit.wheelbase / speed), -0.55, 0.55) : 0);
          const occupied = c.mode === 'player' || c.mode === 'traffic' || c.entryDriver || (c.mode === 'police' && c.crew);
          // Direction retains the rotation; its length on the coachwork page
          // carries ignition and speed to the dashboard without a ninth vertex buffer.
          const dial = k === STREET_SEDAN && occupied ? 2 + Math.min(1, Math.abs(speed) * 3.6 / 240) : 1;
          roll.setXYZW(slot, dial * Math.cos(travel.angle), dial * Math.sin(travel.angle), Math.sin(steer) + 2 * Math.round(twist / .0025), suspension ? -travel.plate : travel.plate);
          // In VR you sit in the driver's seat yourself: no driver there, and your eyes where theirs would be.
          if (c === VR_SEAT.car && fit.layout) {
            const l = fit.layout, pelvis = l[3] + 0.205;
            VR_SEAT.eye.set(l[9] - 0.06, Math.min(pelvis + 0.74, l[5] - 0.1), -l[10]).applyMatrix4(d.matrix);
            VR_SEAT.frame = VR_SEAT.frames;
          } else if (occupied && fit.layout) {
            const seat=this.drivers?.put(fit.layout,travel.plate,c.type==='police' && c.mode!=='player',d.matrix);
            if (c.entryDriver) this.rememberDriver(c,travel.plate%2,seat);
          }
        }
        if (driverSeat && (c.mode !== 'loose' || c.entryDriver) && c !== VR_SEAT.car) {
          const seat=this.drivers?.putAt(driverSeat[0],driverSeat[1],driverSeat[2],driverSeat[3],0,false,d.matrix);
          if (c.entryDriver) this.rememberDriver(c,0,seat);
        }
        if (under && !c.two && shaded < UNDER.most) {
          under.setMatrixAt(shaded++, this.m.copy(suspension ? this.springGround : d.matrix).multiply(this.life.makeScale(c.spec.L, 1, c.spec.W)));
          sum += c.x * 1.37 + c.y * 0.73 + c.h * 11 + d.matrix.elements[13] * 3.1;
        }
        let paint = this.colours.get(c.paint);
        if (!paint) { paint = new THREE.Color(c.paint); this.colours.set(c.paint, paint); }
        const on = night && !c.burnt && !(c.mode === 'loose' && c.speed < 0.5);
        const lamps = c.broken + (on ? 16 : 0) + (c.braking && c.mode !== 'loose' ? 64 : on ? 32 : 0) + AREA_STEP * this.areaOf(c) + DENT_STEP * c.dents;
        (m.geometry.getAttribute('paint') as THREE.InstancedBufferAttribute).setXYZW(slot, paint.r, paint.g, paint.b, lamps);
        if (c.rider && this.ride(c,riders,d.matrix,dt,streetView)) riders++;
        if (c.two === 'bike' && cache.get(k)?.userData.movingCranks) {
          (this.cranks ??= new CycleCranks(this.scene)).add(d.matrix,c.anim ? c.anim.t/c.anim.duration : .25,FIGURE_SIZE.value);
        }
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
        const roll = m.geometry.getAttribute('roll') as THREE.InstancedBufferAttribute | undefined;
        if (roll) send(roll, m.count);
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
    if (this.under) {
      this.under.visible = !!under && shaded > 0;
      if (under && (sum !== this.underSum || under.count !== shaded)) { under.count = shaded; this.underSum = sum; sendInstances(under); }
    }
    this.drivers?.end();
    this.riders.commit(riders);
    this.cranks?.end();
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
    const want = c.tipped ? c.tipped * Math.PI / 2
      : !c.rider && c.speed < 0.3 ? 0.2 : clamp(Math.atan((c.forwardSpeed * yaw) / 9.81), -0.7, 0.7);
    c.lean += (want - c.lean) * Math.min(1, dt * 6);
  }

  ride(c: Car, slot: number, matrix: THREE.Matrix4, dt: number, street = false) {
    if (!kit || !c.rider || !c.two) return false;
    if (slot>=this.riders.capacity && !(street && (c.mode==='player' || this.closeCars.has(c)))) return false;
    c.anim ??= new Anim(kit,c.two,c.two === 'bike' ? kit.clips.bike.duration*.25 : 0);
    const driving = c.mode === 'player';
    c.anim.footDown = 1-THREE.MathUtils.smoothstep(c.speed,.15,1.6);
    // A bicycle advances one crank revolution in six metres of driven travel.
    // Coasting keeps both the shoes and cranks at their last angle.
    const cadence = driving && !c.pedaling ? 0 : Math.max(0,c.forwardSpeed)/6;
    c.anim.step(dt,c.two === 'bike' ? cadence*c.anim.duration : 1);
    const at = this.m.copy(matrix).multiply(this.scale);
    if (street && c!==VR_SEAT.car && (driving || this.closeCars.has(c))) {
      if (driving && this.playerRider) {
        // Reuse the player's claimed slot and wardrobe on mount and dismount.
        c.anim.riderSeed = undefined;
        if (this.playerRider.streetModel(0,at,c.anim)) return false;
      } else {
        let occupant = this.riderIds.get(c);
        if (occupant?.look!==c.rider) {
          occupant = {look:c.rider,id:this.nextRider++};
          this.riderIds.set(c,occupant);
        }
        c.anim.riderSeed = c.rider.riderSeed ??= (occupant.id+1)*104729;
        if (this.riders.streetModel(occupant.id,at,c.anim)) return false;
      }
    }
    if (slot>=this.riders.capacity) return false;
    this.riders.look(slot,c.rider);
    this.riders.place(slot,at,c.anim);
    return true;
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
  a.jolted?.(-j * ia * nx, -j * ia * ny);
  b.jolted?.(j * ib * nx, j * ib * ny);
  for (const [body, inv, sign] of [[a, ia, -1], [b, ib, 1]] as [Body, number, number][]) {
    if (!inv || body.w === undefined) continue;
    const rx = best.px - body.x, ry = best.py - body.y;
    const dw = (rx * ny - ry * nx) * sign * j * inv * 0.25;
    body.w += dw;
    body.upset?.(rx, ry, dw);
  }
  // Heard (src/impacts.ts): two cars, or a car and a tram or funicular car.
  crash(a, b, -vrel, a instanceof Car && b instanceof Car ? 'car' : 'tram', best.px, best.py,
    Math.max(a instanceof Car ? a.spec.mass : 30000, b instanceof Car ? b.spec.mass : 30000));
  return -vrel;
}
