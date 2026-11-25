import type * as THREE from 'three';
import { Car } from './car.ts';
import type { Impact } from './impacts.ts';
import { Sprites } from './particles.ts';

// What flies off when something is hit: sparks off metal, a shower of broken glass and
// bits of paint and plastic that bounce and skid across the road, and a puff of dust or
// grit. Blown-up cars throw burning embers and charred bits of body (`blast`). Drawn only
// near the camera; nothing here touches the game.

const NEAR = 160; // m from the camera within which anything is thrown
const GLASS: [number, number, number] = [0.78, 0.86, 0.9];
const PLASTIC: [number, number, number] = [0.07, 0.07, 0.075];
const LEAF: [number, number, number] = [0.2, 0.32, 0.12];

const hex = new Map<string, [number, number, number]>();
function paintOf(c: unknown): [number, number, number] {
  const p = c instanceof Car ? c.paint : '';
  if (!p) return [0.5, 0.5, 0.5];
  let v = hex.get(p);
  if (!v) {
    const n = parseInt(p.replace('#', ''), 16) || 0x888888;
    // (sRGB numbers, as the fire's colours are.)
    v = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    hex.set(p, v);
  }
  return v;
}

export class Debris {
  sparks: Sprites;
  chips: Sprites;
  private smoke: Sprites;
  private glows: Sprites;
  private r: () => number;

  constructor(scene: THREE.Scene, smoke: Sprites, glows: Sprites, rng: () => number) {
    this.sparks = new Sprites(scene, 700, 'spark');
    this.chips = new Sprites(scene, 500, 'chip');
    this.smoke = smoke;
    this.glows = glows;
    this.r = rng;
  }

  // A blow (impacts.ts) `z` metres up at the point of contact; `seen` whether it's near enough to draw.
  hit(e: Impact, z: number, near: boolean) {
    if (!near || e.kind === 'person') return;
    const r = this.r, s = e.speed;
    const metal = e.kind !== 'hedge';
    let x = e.x, y = e.y;
    const a = e.a instanceof Car ? e.a : null;
    let bx = 0, by = 0; // which way the bits tend to fly
    if (a && !e.b) {
      // Against a wall, a post or a fence: at the car's front, thrown back off it.
      const fx = Math.cos(a.h), fy = Math.sin(a.h);
      x = a.x + fx * a.spec.L * 0.48;
      y = a.y + fy * a.spec.L * 0.48;
      bx = -fx * 0.6 + a.vx * 0.08; by = -fy * 0.6 + a.vy * 0.08;
    } else if (a) {
      // Two cars: along with them as they slide together.
      const b = e.b as { vx?: number; vy?: number };
      bx = (a.vx + (b.vx ?? 0)) * 0.05; by = (a.vy + (b.vy ?? 0)) * 0.05;
    }
    const ground = z - 0.5;
    const hard = Math.min(1, Math.max(0, (s - 3) / 14)); // 0 at a knock, 1 at a real smash
    // Sparks, from the first scrape on.
    if (metal) {
      const n = Math.min(70, Math.round(2 + s * 1.6 + hard * 30));
      for (let i = 0; i < n; i++) {
        const t = r() * Math.PI * 2, v = 2 + r() * (3 + s * 0.45);
        this.sparks.add({
          x: x + (r() - 0.5) * 0.4, y: y + (r() - 0.5) * 0.4, z: z + (r() - 0.5) * 0.3,
          vx: Math.cos(t) * v + bx * v, vy: Math.sin(t) * v + by * v, vz: 0.5 + r() * (2 + s * 0.2),
          r0: 0.012 + r() * 0.012, life: 0.25 + r() * 0.55, rgb: [1.7, 1.25, 0.75], a: 1,
          fall: 9.8, drag: 0.6, floor: ground, bounce: 0.35, heat: true,
        });
      }
      // A hot flash where the metal met.
      if (s > 7) this.glows.add({ x, y, z, r0: 0.3, r1: 0.6 + hard * 0.8, life: 0.09, rgb: [1.5, 1.2, 0.8], a: 0.6 + 0.4 * hard });
    }
    if (s < 5) return;
    // Glass and bits of the car: a few from a knock, a shower from a smash.
    const glass = metal ? Math.round(hard * 34) : 0, bits = Math.round(2 + hard * 14);
    const paint = paintOf(a);
    for (let i = 0; i < glass + bits; i++) {
      const isGlass = i < glass, t = r() * Math.PI * 2, v = 1 + r() * (2 + s * 0.25);
      const tone = 0.8 + r() * 0.4;
      const rgb: [number, number, number] = !metal ? LEAF : isGlass ? GLASS : r() < 0.55 ? paint : PLASTIC;
      this.chips.add({
        x: x + (r() - 0.5) * 0.8, y: y + (r() - 0.5) * 0.8, z: z + r() * 0.4,
        vx: Math.cos(t) * v + bx * v, vy: Math.sin(t) * v + by * v, vz: 1 + r() * (1.5 + s * 0.15),
        r0: isGlass ? 0.02 + r() * 0.03 : 0.04 + r() * 0.07, life: 4 + r() * 5,
        rgb: [rgb[0] * tone, rgb[1] * tone, rgb[2] * tone], a: isGlass ? 0.85 : 1,
        spin: (r() - 0.5) * 30, fall: 9.8, drag: 0.3, floor: ground + 0.01 + r() * 0.01, bounce: 0.3,
      });
    }
    // Grit and dust kicked up.
    const puffs = Math.round(1 + hard * 5);
    const grey = metal ? 0.42 : 0.35;
    for (let i = 0; i < puffs; i++) {
      this.smoke.add({
        x: x + (r() - 0.5) * 1.2, y: y + (r() - 0.5) * 1.2, z: z - 0.1 + r() * 0.4,
        vx: (r() - 0.5) * 2 + bx * 3, vy: (r() - 0.5) * 2 + by * 3, vz: 0.4 + r() * 0.8,
        r0: 0.4, r1: 1.4 + hard * 1.6 + r(), life: 1.2 + r() * 1.2, rgb: [grey, grey * 0.96, grey * 0.9], a: 0.22 + hard * 0.25,
        spin: (r() - 0.5) * 0.8, drag: 1.5,
      });
    }
  }

  // A car blowing up at (x, y), `z` the ground: burning embers and charred bits of it thrown far and wide.
  blast(x: number, y: number, z: number) {
    const r = this.r;
    for (let i = 0; i < 60; i++) {
      const t = r() * Math.PI * 2, v = 3 + r() * 13;
      this.sparks.add({
        x: x + (r() - 0.5) * 2, y: y + (r() - 0.5) * 2, z: z + 0.6 + r(),
        vx: Math.cos(t) * v, vy: Math.sin(t) * v, vz: 3 + r() * 12,
        r0: 0.012 + r() * 0.015, life: 0.8 + r() * 1.6, rgb: [1.7, 1.15, 0.6], a: 1,
        fall: 9.8, drag: 0.5, floor: z, bounce: 0.3, heat: true,
      });
    }
    for (let i = 0; i < 46; i++) {
      const t = r() * Math.PI * 2, v = 2 + r() * 10, glass = i < 18, g = 0.05 + r() * 0.06;
      this.chips.add({
        x: x + (r() - 0.5) * 2, y: y + (r() - 0.5) * 2, z: z + 0.5 + r(),
        vx: Math.cos(t) * v, vy: Math.sin(t) * v, vz: 4 + r() * 9,
        r0: glass ? 0.025 + r() * 0.03 : 0.05 + r() * 0.1, life: 8 + r() * 8,
        rgb: glass ? [GLASS[0] * 0.8, GLASS[1] * 0.8, GLASS[2] * 0.8] : [g, g * 0.95, g * 0.9], a: glass ? 0.8 : 1,
        spin: (r() - 0.5) * 24, fall: 9.8, drag: 0.15, floor: z + 0.01, bounce: 0.25,
      });
    }
  }

  update(dt: number) {
    this.sparks.update(dt);
    this.chips.update(dt);
  }

  reset() {
    this.sparks.clear();
    this.chips.clear();
  }

  static readonly NEAR = NEAR;
}
