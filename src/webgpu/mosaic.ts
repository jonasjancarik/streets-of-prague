// The Prague mosaic's stones, scattered as they were drawn before (stones() in
// common.ts, eleven a metre, one in ten dark), but drawn once into a texture that
// repeats every 2 m instead of worked out anew for each pixel, which cost about 14% of
// a frame on WebGL. The texture's mipmaps fade the stones out as they get smaller than
// a pixel.

import * as THREE from 'three';
import { Fn, If, texture, floor, vec2, vec3, select, normalize, abs, normalWorldGeometry, transformNormalToView } from 'three/tsl';
import { pavement, pavementRelief, pavementReady } from '../streetSurface.ts';
import { type N, follow, hash12 } from './common.ts';

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

// Keep the larger marks in the map view. At street level the cuts, mineral
// specks and worn arrises are baked at the scale of 32 six-centimetre stones.
const close = texture(pavement.map), relief = texture(pavementRelief.map);
pavement.onLoad = t => { close.value = t; };
pavementRelief.onLoad = t => { relief.value = t; };
const ready = follow(pavementReady), repeat = 1.92;
function layout(p: N, sample: N, surveyed: boolean) {
  if (!surveyed) return sample.r;
  const pick = hash12(floor(p.div(44).add(vec2(.37, .71))).add(9.1));
  return select(pick.lessThan(.45), sample.r, select(pick.lessThan(.78), sample.g, sample.b));
}
export function pavementStones(p: N, surveyed: boolean) {
  const out = vec3(1).toVar();
  If(ready.greaterThan(.5), () => {
    const uv = p.div(repeat), stone = layout(p, close.sample(uv), surveyed).mul(1.6);
    const warm = relief.sample(uv).b.sub(.5);
    out.assign(vec3(warm.mul(.23).add(1), warm.mul(.025).add(1), warm.mul(-.19).add(1)).mul(stone));
  }).Else(() => { out.assign(vec3(layout(p, stones.sample(p.div(REPEAT)), surveyed).mul(SCALE))); });
  return out;
}
// `p`: in the laying's own axes; `axes` turn the world into them (laying.ts).
export const pavementNormal = (p: N, axes: N) => Fn(() => {
  const n = normalWorldGeometry.toVar();
  If(ready.greaterThan(.5), () => {
    const laid: N = relief.sample(p.div(repeat)).rg.sub(.5).mul(1.6);
    const xy = vec2(laid.x.mul(axes.x).add(laid.y.mul(axes.y)), laid.y.mul(axes.x).sub(laid.x.mul(axes.y)));
    n.assign(normalize(n.add(vec3(xy.x, 0, xy.y.negate()).mul(abs(n.y)))));
  });
  return transformNormalToView(n);
})();
