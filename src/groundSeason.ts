// Seasonal surface colours, computed only when the fixed game date changes.
// RGB multipliers are linear (the shaders multiply linear material colours).
// No geometry, texture or material is rebuilt; existing noise supplies dry patches.
import * as THREE from 'three';
import type { Season } from './season.ts';

// How much of the summer's drying each kind of grass takes: meadows, grassland and
// scrub all of it, the mown lawns of housing estates most, parks about half (they are
// mown and sometimes watered), private gardens a quarter, pitches none. It scales only
// the dry part of the tint, so every kind keeps the same palette up to 15 July.
export const GRASS_DRYNESS = { meadow: 1, lawn: 0.8, park: 0.5, garden: 0.25, pitch: 0 };
export type GrassKind = keyof typeof GRASS_DRYNESS;
// Grass tint in xyz, strength of its existing dry patches in w, one per kind (the
// shader of each kind reads its own, so no pixel does extra work).
export const GRASS_SEASON = Object.fromEntries(
  (Object.keys(GRASS_DRYNESS) as GrassKind[]).map((k) => [k, { value: new THREE.Vector4(1, 1, 1, 1) }]),
) as Record<GrassKind, { value: THREE.Vector4 }>;
// Parks, and the plain 'grass' pattern in general.
export const GROUND_SEASON = GRASS_SEASON.park;
export const WOOD_SEASON = { value: new THREE.Color(1, 1, 1) };
export const FIELD_SEASON = { value: new THREE.Color(1, 1, 1) };
export const HEDGE_SEASON = { value: new THREE.Color(1, 1, 1) };

const ramp = (day: number, from: number, to: number) => {
  const t = Math.min(1, Math.max(0, (day - from) / (to - from)));
  return t * t * (3 - 2 * t);
};
// 15 July preserves the original summer palette and patch strength exactly.
const SUMMER_DRY = ramp(196, 182, 235);
// The photos were taken in a dry July and show more straw than the game does on 15 July.
// ?straw=0..1 starts the summer's drying already in the weeks before and through July
// (how much of the full August drying is there by 15 July); 0 keeps the original palette.
const STRAW = typeof location === 'undefined' ? 0 : Math.min(1, Math.max(0, Number(new URLSearchParams(location.search).get('straw')) || 0));
const fieldBase = new THREE.Color('#b9b27a');
const fieldGreen = new THREE.Color('#79a452');
const fieldEarth = new THREE.Color('#947658');
const woodBase = new THREE.Color('#394a2b');
const woodLitter = new THREE.Color('#80633f');
let sharedDay = -1;

export function shareGroundSeason(season: Season) {
  if (sharedDay === season.day) return;
  sharedDay = season.day;
  const { day, fresh, cold } = season;
  const drying = Math.max(0, (season.dry - SUMMER_DRY) / (1 - SUMMER_DRY));
  const early = STRAW * ramp(day, 160, 196) * (1 - ramp(day, 245, 275));
  const total = early + (1 - early) * drying;
  for (const k of Object.keys(GRASS_DRYNESS) as GrassKind[]) {
    const dry = total * GRASS_DRYNESS[k];
    GRASS_SEASON[k].value.set(
      (1 + 0.15 * fresh) * (1 + 0.08 * dry) * (1 + 0.13 * cold),
      (1 + 0.12 * fresh) * (1 - 0.04 * dry) * (1 - 0.12 * cold),
      (1 - 0.1 * fresh) * (1 - 0.2 * dry) * (1 - 0.33 * cold),
      1 - 0.65 * fresh + 0.5 * dry - 0.2 * cold,
    );
  }
  // Leaf litter on the woodland floor from November through March; this is a
  // broad colour, not a claim that the shader knows where individual trees stand.
  const litter = Math.max(1 - ramp(day, 90, 120), ramp(day, 285, 309));
  WOOD_SEASON.value.copy(woodBase).lerp(woodLitter, litter);
  WOOD_SEASON.value.setRGB(WOOD_SEASON.value.r / woodBase.r, WOOD_SEASON.value.g / woodBase.g, WOOD_SEASON.value.b / woodBase.b);
  // Spring crops, ripe summer straw (the base colour), then harvested earth.
  const green = ramp(day, 80, 110) * (1 - ramp(day, 166, 196));
  const earth = Math.max(1 - ramp(day, 75, 105), ramp(day, 258, 285));
  FIELD_SEASON.value.copy(fieldBase).lerp(fieldGreen, green).lerp(fieldEarth, earth);
  FIELD_SEASON.value.setRGB(FIELD_SEASON.value.r / fieldBase.r, FIELD_SEASON.value.g / fieldBase.g, FIELD_SEASON.value.b / fieldBase.b);
  // Hedges are evergreen shrubs: a little fresh growth or winter dulling, never
  // autumn leaf fall, blossom or a brown deciduous crown.
  HEDGE_SEASON.value.setRGB(1 + 0.12 * fresh - 0.05 * cold, 1 + 0.12 * fresh - 0.1 * cold, 1 - 0.1 * fresh - 0.12 * cold);
}
