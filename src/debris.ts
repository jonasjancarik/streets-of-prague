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
const PLASTIC: [number, number, number] = [0.13, 0.13, 0.14];
const LEAF: [number, number, number] = [0.2, 0.32, 0.12];
// What's hit that throws no sparks: leaves, people, timber and glass.
const SOFT = new Set(['hedge', 'person', 'timber', 'bottles']);
// What a knocked bin or a broken glass bell spills (`spill`): paper and wrappers, cans,
// crushed plastic and a dark bag or two; green, clear and brown bottle glass.
const RUBBISH: [number, number, number][] = [[0.86, 0.85, 0.8], [0.75, 0.72, 0.62], [0.6, 0.62, 0.64], [0.7, 0.18, 0.14], [0.2, 0.36, 0.62], [0.9, 0.8, 0.3]];
const BOTTLES: [number, number, number][] = [[0.22, 0.42, 0.2], [0.3, 0.52, 0.26], [0.8, 0.86, 0.85], [0.45, 0.28, 0.12]];

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
    this.chips = new Sprites(scene, 900, 'chip');
    this.smoke = smoke;
    this.glows = glows;
    this.r = rng;
  }

  // A blow (impacts.ts) `z` metres up at the point of contact; `under` the ground's height round it.
  hit(e: Impact, z: number, under: (x: number, y: number) => number) {
    if (e.kind === 'person') return;
    const r = this.r, s = e.speed;
    const metal = !SOFT.has(e.kind);
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
    const ground = under(x, y);
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
    // Glass and bits of the car: a few from a knock, a shower from a smash. Safety glass breaks into
    // crumbs a centimetre or two across; bits of lamp, trim and paint are a few centimetres, now and
    // then a bigger piece.
    const glass = metal ? Math.round(hard * 110) : 0, bits = Math.round(2 + hard * 14);
    const paint = paintOf(a);
    for (let i = 0; i < glass + bits; i++) {
      // (Glass mostly drops where it broke; harder bits fly on.)
      const isGlass = i < glass, t = r() * Math.PI * 2, v = isGlass ? 0.4 + r() * (0.8 + s * 0.1) : 1 + r() * (2 + s * 0.25);
      const tone = 0.8 + r() * 0.4, big = r();
      const rgb: [number, number, number] = !metal ? LEAF : isGlass ? GLASS : r() < 0.55 ? paint : PLASTIC;
      const lift = 0.004 + r() * 0.008;
      this.chips.add({
        x: x + (r() - 0.5) * 0.8, y: y + (r() - 0.5) * 0.8, z: z + r() * 0.4,
        vx: Math.cos(t) * v + bx * v, vy: Math.sin(t) * v + by * v, vz: isGlass ? 0.3 + r() * (0.6 + s * 0.06) : 0.5 + r() * (1 + s * 0.12),
        r0: !metal ? 0.02 + r() * 0.02 : isGlass ? 0.005 + r() * 0.009 : 0.012 + big * big * 0.05,
        life: 14 + r() * 10, glass: isGlass,
        rgb: [rgb[0] * tone, rgb[1] * tone, rgb[2] * tone], a: 1,
        spin: (r() - 0.5) * 30, fall: 9.8, drag: !metal ? 2 : 0.1, floor: ground + lift, under, lift, bounce: isGlass ? 0.25 : 0.3,
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

  // A knocked bin's rubbish or a glass bell's broken bottles at (x, y), `z` the ground
  // (`under`: round it), thrown on at (vx, vy) m/s; `n` pieces. Rubbish lies where it
  // falls for a minute or so, as glass does.
  spill(what: 'rubbish' | 'bottles', x: number, y: number, z: number, vx: number, vy: number, n: number, under?: (x: number, y: number) => number) {
    const r = this.r, glass = what === 'bottles', palette = glass ? BOTTLES : RUBBISH;
    for (let i = 0; i < n; i++) {
      const t = r() * Math.PI * 2, v = 0.3 + r() * (glass ? 2.5 : 1.5), keep = glass ? 0.2 + r() * 0.4 : 0.08 + r() * 0.25; // (paper drops near; glass skids on)
      const rgb = palette[Math.floor(r() * palette.length)], tone = 0.8 + r() * 0.35;
      // (Now and then a black bin bag, much bigger than the rest.)
      const bag = !glass && r() < 0.05, lift = 0.004 + r() * 0.01;
      this.chips.add({
        x: x + (r() - 0.5) * 0.6, y: y + (r() - 0.5) * 0.6, z: z + 0.2 + r() * 0.6,
        vx: vx * keep + Math.cos(t) * v, vy: vy * keep + Math.sin(t) * v, vz: 0.5 + r() * 2.5,
        r0: bag ? 0.14 + r() * 0.06 : glass ? 0.008 + r() * 0.02 : 0.02 + r() * 0.035,
        life: 50 + r() * 30, glass,
        rgb: bag ? [0.07, 0.07, 0.08] : [rgb[0] * tone, rgb[1] * tone, rgb[2] * tone], a: 1,
        spin: (r() - 0.5) * 20, fall: 9.8, drag: glass ? 0.15 : 1.2, floor: z + lift, under, lift, bounce: glass ? 0.25 : 0.1,
      });
    }
  }

  // A car blowing up at (x, y), `z` the ground (`under`: round it): burning embers and charred bits of it thrown far and wide.
  blast(x: number, y: number, z: number, under?: (x: number, y: number) => number) {
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
    for (let i = 0; i < 110; i++) {
      const t = r() * Math.PI * 2, v = 2 + r() * 10, glass = i < 70, g = 0.05 + r() * 0.06, big = r();
      const lift = 0.004 + r() * 0.008;
      this.chips.add({
        x: x + (r() - 0.5) * 2, y: y + (r() - 0.5) * 2, z: z + 0.5 + r(),
        vx: Math.cos(t) * v, vy: Math.sin(t) * v, vz: 3 + r() * 7,
        r0: glass ? 0.006 + r() * 0.01 : 0.015 + big * big * 0.08, life: 20 + r() * 10, glass,
        rgb: glass ? [GLASS[0] * 0.8, GLASS[1] * 0.8, GLASS[2] * 0.8] : [g, g * 0.95, g * 0.9], a: 1,
        spin: (r() - 0.5) * 24, fall: 9.8, drag: 0.1, floor: z + lift, under, lift, bounce: 0.25,
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
