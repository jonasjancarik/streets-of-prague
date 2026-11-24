// Something has hit something: a car a wall, a lamp post, a fence, another car or a tram,
// or a car someone on foot. Whoever notices a blow calls `crash`; the game's sound
// (Sound.crash in src/audio.ts) listens, and so can anything else that wants to know
// (the police ramming you, say). Nothing but a type imported, so car.ts and the rest
// can use it freely.

import type { CrashKind } from './soundmix.ts';

// What was hit: 'wall' (a house or anything else in the collision grid), 'post' (a lamp
// or a pole), 'fence', 'hedge', 'rail' (a crash barrier), 'car', 'tram' (or a funicular
// car), 'person'.
export type ImpactKind = CrashKind;

export interface Impact {
  speed: number; // m/s: how fast the two closed on each other
  x: number; y: number; // where (game metres)
  kind: ImpactKind; // what was hit
  a: object; // what hit it (a car, usually)
  b: object | null; // the other car or tram, if there was one
  mass: number; // kg: the heavier of the cars in it (1400 if it isn't known)
}

type Listener = (e: Impact) => void;
const listeners: Listener[] = [];
const event: Impact = { speed: 0, x: 0, y: 0, kind: 'wall', a: {}, b: null, mass: 1400 };

// Below this nothing is heard: cars resting against each other, or pushed out of a wall.
export const CRASH_MIN = 1.2; // m/s

// Tell everyone listening about a blow `speed` m/s hard at (x, y). The event object is
// reused, so a listener copies what it wants to keep.
export function crash(a: object, b: object | null, speed: number, kind: ImpactKind, x: number, y: number, mass = 1400) {
  if (!(speed >= CRASH_MIN) || !listeners.length) return;
  Object.assign(event, { speed, x, y, kind, a, b, mass });
  for (const l of listeners) l(event);
}

// Listen for blows; returns the function that stops listening.
export function onCrash(l: Listener) {
  listeners.push(l);
  return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
}
