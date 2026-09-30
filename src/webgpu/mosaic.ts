// The Prague mosaic's stones, scattered as they were drawn before (stones() in
// common.ts, eleven a metre, one in ten dark), but drawn once into a texture that
// repeats every 2 m instead of worked out anew for each pixel, which cost about 14% of
// a frame on WebGL. The texture's mipmaps fade the stones out as they get smaller than
// a pixel.

import * as THREE from 'three';
import { texture } from 'three/tsl';
import type { N } from './common.ts';

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
// light), darker in the joints; / SCALE.
export function stonesData() {
  const px = new Uint8Array(SIZE * SIZE);
  const cells = CELLS * CELLS, cx = new Float32Array(cells), cy = new Float32Array(cells), id = new Float32Array(cells);
  for (let j = 0; j < CELLS; j++) for (let i = 0; i < CELLS; i++) {
    const k = j * CELLS + i;
    cx[k] = i + 0.1 + 0.8 * hash(i, j, 1);
    cy[k] = j + 0.1 + 0.8 * hash(i, j, 2);
    id[k] = hash(i, j, 3);
  }
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
        if (d < d1) { d2 = d1; d1 = d; near = id[k]; } else if (d < d2) d2 = d;
      }
      const stone = near > 0.9 ? 0.62 : near * 0.18 + 0.9;
      const m = 0.6 + (stone - 0.6) * smooth(0.03, 0.12, Math.sqrt(d2) - Math.sqrt(d1));
      px[v * SIZE + u] = Math.round((255 * m) / SCALE);
    }
  }
  return px;
}

function stonesTexture() {
  const tex = new THREE.DataTexture(stonesData(), SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8; // the pavement is seen at a low angle
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
const stones = texture(stonesTexture());

// The stones' factor at p (metres, x east, y north).
export const mosaicStones = (p: N) => stones.sample(p.div(REPEAT)).r.mul(SCALE);
