import type * as THREE from 'three';
import type { Car } from './car.ts';

export type TramPoint = { x: number; y: number; ang: number };

export interface TramHalt {
  s: number;
  dwell: number;
  name: string;
  to?: number;
}

export interface TramLineData {
  ref: string;
  colour?: string;
  pts: [number, number][];
  stops: Array<[number, string]>;
  turns: Array<{ at: number; to?: number; where: string }>;
  ends: [number, number];
  from: string;
  to: string;
  speed: Array<[number, number]>;
  perHour?: Record<string, number[]>;
  night: boolean;
}

export interface TramPath {
  length: number;
  wrap(s: number): number;
  ahead(from: number, to: number): number;
  at(s: number): TramPoint;
}

export interface PreparedTramLine extends TramLineData {
  path: TramPath;
  halts: TramHalt[];
  haltS: number[];
  limitS: number[];
  limitV: number[];
  trams: Tram[];
}

export type TramBlocker = Car;

export interface TramLook {
  sections: THREE.Mesh[];
  sign: THREE.Mesh;
}

export interface Tram {
  id: number;
  line: PreparedTramLine;
  s: number;
  speed: number;
  dwell: number;
  halt: number;
  stuck: number;
  ghost: number;
  waitFor: Tram | null;
  blocker: TramBlocker | null;
  held: number;
  shove: TramBlocker | null;
  look: TramLook | null;
  pending: number;
  parts: TramPoint[];
  cells?: TramGridEntry[];
  levels?: Array<Record<string, number>>;
  rider?: boolean;
}

export interface TramGridEntry {
  v: Tram;
  x: number;
  y: number;
  c: number;
  s: number;
}

export interface TramNearby {
  kind?: string;
  x: number;
  y: number;
  z?: number;
  r: number;
  vx?: number;
  vy?: number;
  car?: Car;
}

export type TramNear = (x: number, y: number, radius: number) => Iterable<TramNearby>;
export type TramSeen = (x: number, y: number) => boolean;
export type TramHeight = (x: number, y: number, track: Record<string, number>) => number;

export interface TramClock {
  kind: string;
  hour: number;
}
