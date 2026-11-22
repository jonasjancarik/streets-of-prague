// The grass seen from the street. From above a lawn is a patterned green surface, which
// is all a camera 100 m up can make out; from the pavement it reads as paint on the
// ground. So round the eye, wherever your feet would sound grass (map/footing.ts), blades
// stand on it: strips of photographed lawn grass (assets/grass/) as low cards, each
// turned and leaning its own way, some 46 to a square metre close by and fewer further off.
// (webgpu/streetGrass.ts draws them, in the lawn's colour and the season's.)
//
// The lawn is worked through a cell of 6 m at a time, the nearest first, in short frame slices, and
// a cell is let go once you are well away. Where the grass is comes from the map; every
// blade's place is made up, and so is its length (a mown lawn here, longer there).

import * as THREE from 'three';
import { STREET_DETAIL } from './streetHedges.ts';

export const GRASS_REACH = 24, GRASS_FADE = 17; // m from the eye: where the last blades end, and begin to shrink
export const GRASS_THIN = 5; // m: from here on fewer cards are drawn, each wider
const CELL = 6; // m
const PER_M2 = 46; // cards to a square metre
const FORGET = 40; // m
const SLICE_MS = 1;

let material: (() => THREE.Material) | null = null, ready: { value: boolean } = { value: false };
export const setGrassMaterial = (make: () => THREE.Material, isReady: { value: boolean }) => { material = make; ready = isReady; };

export interface GrassGround {
  grass: (x: number, y: number) => boolean; // whether it's grass there, in the open
  height: (x: number, y: number) => number;
}

const hash = (x: number, y: number, salt: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
};
// How long the grass is at a place (m): mown short over most of a lawn, longer in patches.
const lengthAt = (x: number, y: number) => {
  const i = Math.floor(x / 9), j = Math.floor(y / 9), fx = x / 9 - i, fy = y / 9 - j;
  const a = hash(i, j, 3), b = hash(i + 1, j, 3), c = hash(i, j + 1, 3), d = hash(i + 1, j + 1, 3);
  const k = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  return 0.14 + 0.2 * Math.max(0, k - 0.45) / 0.55;
};

export class StreetGrass {
  readonly group = new THREE.Group();
  private cells = new Map<string, THREE.Mesh | null>(); // null: no grass there
  private made: THREE.Material | null = null;
  private on = false;
  private ground: GrassGround | null = null;
  private revision = -1;
  private pending: { i: number; j: number; job: Generator<void, THREE.Mesh | null> } | null = null;

  constructor() { this.group.name = 'street-grass'; }

  // Each frame: whether the view is from the street, where the eye is (the game's x, y),
  // the ground to ask, and a number that changes when the map round you does (cells found
  // empty before their tile had loaded are then asked again).
  street(on: boolean, x = 0, y = 0, ground: GrassGround | null = null, revision = 0) {
    on &&= !!material && STREET_DETAIL.value;
    if (!on && !this.on) return;
    this.on = on;
    if (!on) this.pending = null;
    if (on && !this.made) this.made = material!();
    const shown = on && ready.value;
    this.group.visible = shown;
    if (!shown || !ground) return;
    this.ground = ground;
    if (revision !== this.revision) {
      this.pending = null;
      this.revision = revision;
      for (const [k, m] of this.cells) if (!m) this.cells.delete(k);
    }
    const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL), r = Math.ceil(GRASS_REACH / CELL);
    let next: [number, number] | null = null, nearest = Infinity;
    for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
      const d = Math.hypot((i + 0.5) * CELL - x, (j + 0.5) * CELL - y);
      if (d > GRASS_REACH + CELL * 0.7 || this.cells.has(`${i},${j}`)) continue;
      if (d < nearest) { nearest = d; next = [i, j]; }
    }
    if (this.pending && Math.hypot((this.pending.i + .5) * CELL - x, (this.pending.j + .5) * CELL - y) > GRASS_REACH + CELL) this.pending = null;
    if (!this.pending && next) this.pending = { i: next[0], j: next[1], job: this.build(next[0], next[1]) };
    const pending = this.pending, until = performance.now() + SLICE_MS;
    if (pending) do {
      const step = pending.job.next();
      if (step.done) {
        this.cells.set(`${pending.i},${pending.j}`, step.value);
        this.pending = null;
        break;
      }
    } while (performance.now() < until);
    for (const [k, m] of this.cells) {
      const [i, j] = k.split(',').map(Number), d = Math.hypot((i + 0.5) * CELL - x, (j + 0.5) * CELL - y);
      if (m) m.visible = d < GRASS_REACH + CELL;
      if (d > FORGET) {
        if (m) { this.group.remove(m); m.geometry.dispose(); }
        this.cells.delete(k);
      }
    }
  }

  private *build(i: number, j: number): Generator<void, THREE.Mesh | null> {
    const g = this.ground!, at: number[] = [], corner: number[] = [], uv: number[] = [], blade: number[] = [], index: number[] = [];
    let seed = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) >>> 0 || 1;
    const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9 >>> 0) >>> 8) / 16777216;
    for (let n = 0, all = Math.round(CELL * CELL * PER_M2); n < all; n++) {
      if (n && n % 32 === 0) yield;
      const x = (i + rand()) * CELL, y = (j + rand()) * CELL, turn = rand() * Math.PI, wide = 0.22 + 0.2 * rand(), tone = rand(), rank = rand(), u0 = rand();
      // (Both ends of the card on grass, so no blade stands over a path's edge.)
      const dx = Math.cos(turn) * wide / 2, dy = Math.sin(turn) * wide / 2;
      if (!g.grass(x, y) || !g.grass(x + dx, y + dy) || !g.grass(x - dx, y - dy)) continue;
      const tall = lengthAt(x, y) * (0.75 + 0.5 * rand()), v = at.length / 3;
      const za = g.height(x - dx, y - dy), zb = g.height(x + dx, y + dy), zm = (za + zb) / 2;
      // A card's four corners share its middle; `corner` is each one's place from there, and
      // the top two lean a little to one side.
      // (Leaning well over, one way or the other: seen from above a tuft then shows its face, not an edge.)
      const lean = (rand() < 0.5 ? -1 : 1) * (0.2 + 0.45 * rand()) * tall;
      for (const [side, up] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
        at.push(x, zm, -y);
        corner.push(side * dx - up * Math.sin(turn) * lean, (side < 0 ? za : zb) - zm - 0.015 + up * tall, -(side * dy + up * Math.cos(turn) * lean));
        uv.push(u0 + (side > 0 ? wide / 0.55 : 0), up);
        blade.push(tone, rank, tall);
      }
      index.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    if (!index.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(at, 3));
    geo.setAttribute('corner', new THREE.Float32BufferAttribute(corner, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('blade', new THREE.Float32BufferAttribute(blade, 3));
    geo.setIndex(at.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    geo.boundingSphere!.radius += 1;
    const mesh = new THREE.Mesh(geo, this.made!);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }
}

export const streetGrass = new StreetGrass();
