import type { CarSpec } from './car.ts';

// Handling multipliers for the car you drive, set from the developer panel (dev.ts):
// each scales that value of whatever vehicle you're in (TYPES and VARIANTS in car.ts),
// in both the top-down handling and the realistic one. 1 everywhere is the game as it ships.
export const DRIVE_TUNE = {
  accel: 1, vmax: 1, brake: 1, grip: 1, fade: 1, radius: 1, turn: 1, response: 1, drag: 1, weather: 1,
};
export type DriveTuneKey = keyof typeof DRIVE_TUNE;
export const DRIVE_TUNE_DEFAULT: Readonly<typeof DRIVE_TUNE> = { ...DRIVE_TUNE };

// The value each spec field falls back to when a type leaves it out (see CarSpec).
const UNSET: Partial<Record<DriveTuneKey, number>> = { brake: 16, fade: 0.45, radius: 3.6, response: 9, drag: 0.6, weather: 1 };

let seen = '', cache = new WeakMap<object, Partial<CarSpec>>();
export function drivingSpec<T extends Partial<CarSpec>>(spec: T): T {
  const key = Object.values(DRIVE_TUNE).join();
  if (key !== seen) { seen = key; cache = new WeakMap(); }
  if (Object.values(DRIVE_TUNE).every((v) => v === 1)) return spec;
  let out = cache.get(spec) as T | undefined;
  if (!out) {
    out = { ...spec };
    for (const k of Object.keys(DRIVE_TUNE) as DriveTuneKey[]) if (DRIVE_TUNE[k] !== 1) (out as Partial<CarSpec>)[k] = (spec[k] ?? UNSET[k] ?? 0) * DRIVE_TUNE[k];
    cache.set(spec, out);
  }
  return out;
}
