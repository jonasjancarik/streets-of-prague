// The Prague mosaic's stones, scattered as they were drawn before (stones() in
// common.ts, eleven a metre, one in ten dark), but drawn once into a texture that
// repeats every 2 m instead of worked out anew for each pixel, which cost about 14% of
// a frame on WebGL. The texture's mipmaps fade the stones out as they get smaller than
// a pixel.

import * as THREE from 'three';
import { texture, floor, vec2, select } from 'three/tsl';
import { type N, hash12 } from './common.ts';

const CELLS = 22; // stones across a repeat
const REPEAT = 2; // metres
const SIZE = 1024; // texels across a repeat
const SCALE = 1.25; // the brightest factor, stored as 1

const hash = (i: number, j: number, s: number) => {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The factor the pavement's colour is multiplied by: the stone's own shade (dark or
// light), darker in the joints; / SCALE. Three layouts of the same stones, one in each of
// the picture's first three channels:
//   0  scattered: light stones with one in ten dark, as a plain pavement is laid;
//   1  a chessboard on the diagonal, squares 70 cm a side in light and grey;
//   2  a lattice: dark lines a stone or two wide crossing on the diagonal every metre.
// The last two are the patterns Prague's pavements are known for. Each stone is wholly dark
// or light, by where its middle lies, as a paver lays them. Which stretch of pavement has
// which is not surveyed: pavedStones picks by where it is.
export function stonesData() {
  const px = new Uint8Array(SIZE * SIZE * 4);
  const cells = CELLS * CELLS, cx = new Float32Array(cells), cy = new Float32Array(cells), id = new Float32Array(cells);
  for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
    const k = j * CELLS + i;
    cx[k] = i + 0.1 + 0.8 * hash(i, j, 1);
    cy[k] = j + 0.1 + 0.8 * hash(i, j, 2);
    id[k] = hash(i, j, 3);
  }
  // A stone's shade in each layout, by its middle (metres within the repeat) and its own number.
  const frac = (v: number) => v - Math.floor(v);
  const shades = (k: number) => {
    const x = (cx[k] / CELLS) * REPEAT, y = (cy[k] / CELLS) * REPEAT, a = x + y, b = x - y, own = id[k];
    const light = own * 0.14 + 0.94, dark = 0.6 + own * 0.1;
    const chess = (Math.floor(a) + Math.floor(b)) % 2 === 0;
    const line = Math.min(frac(a), 1 - frac(a)) < 0.075 || Math.min(frac(b), 1 - frac(b)) < 0.075;
    return [own > 0.9 ? 0.62 : own * 0.18 + 0.9, chess ? dark + 0.08 : light, line ? dark : light];
  };
  const shade = Array.from({ length: cells }, (_, k) => shades(k));
  for (let v = 0; v < SIZE; v++) {
    for (let u = 0; u < SIZE; u++) {
      const x = ((u + 0.5) / SIZE) * CELLS, y = ((v + 0.5) / SIZE) * CELLS;
      const fi = Math.floor(x), fj = Math.floor(y);
      let d1 = 64, d2 = 64, near = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        // Wrapping round the repeat, so it tiles without a seam.
        const i = fi + di, j = fj + dj, k = (((j % CELLS) + CELLS) % CELLS) * CELLS + (((i % CELLS) + CELLS) % CELLS);
        const ox = cx[k] - (((i % CELLS) + CELLS) % CELLS) + i - x, oy = cy[k] - (((j % CELLS) + CELLS) % CELLS) + j - y;
        const d = ox * ox + oy * oy;
        if (d < d1) { d2 = d1; d1 = d; near = k; } else if (d < d2) d2 = d;
      }
      const joint = smooth(0.03, 0.12, Math.sqrt(d2) - Math.sqrt(d1)), o = (v * SIZE + u) * 4;
      for (let c = 0; c < 3; c++) px[o + c] = Math.round((255 * (0.6 + (shade[near][c] - 0.6) * joint)) / SCALE);
      px[o + 3] = 255;
    }
  }
  return px;
}

function stonesTexture() {
  const tex = new THREE.DataTexture(stonesData(), SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8; // the pavement is seen at a low angle
  tex.needsUpdate = true;
  return tex;
}
const stones = texture(stonesTexture());

// The stones' factor at p (metres, x east, y north): scattered, as a path's are.
export const mosaicStones = (p: N) => stones.sample(p.div(REPEAT)).r.mul(SCALE);

// A surveyed pavement's: one of the three layouts, the same for a stretch some PLOT metres
// long (in the old streets the pattern changes from house to house), a little under half of
// them scattered, a third chessboard, the rest lattice.
const PLOT = 44;
export const pavedStones = (p: N) => {
  const s: N = stones.sample(p.div(REPEAT)), pick: N = hash12(floor(p.div(PLOT).add(vec2(0.37, 0.71))).add(9.1));
  return select(pick.lessThan(0.45), s.r, select(pick.lessThan(0.78), s.g, s.b)).mul(SCALE);
};
