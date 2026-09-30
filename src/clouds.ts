// Cloud shadows: a pattern of patches fixed in the world that drifts with the wind and
// dims the sun (never the sky's light or the lamps) where a cloud stands between. It is one
// small tiling texture read once a pixel, so lighting costs the same however many clouds.
import * as THREE from 'three';

export const CLOUD_SPAN = 2400; // metres one repeat of the texture covers
const SIZE = 256;
// How the wind carries the shadows: metres a second, along the ground (x, z).
const WIND = [4.5, 3.2];

// Smooth noise that wraps: a value at each lattice point, blended between them.
function wrapped(cells: number, seed: number) {
  const lattice = new Float32Array(cells * cells);
  let s = seed;
  for (let i = 0; i < lattice.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; lattice[i] = s / 4294967296; }
  return (u: number, v: number) => {
    const x = u * cells, y = v * cells, i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const at = (a: number, b: number) => lattice[(b % cells) * cells + (a % cells)];
    return (at(i, j) * (1 - sx) + at(i + 1, j) * sx) * (1 - sy) + (at(i, j + 1) * (1 - sx) + at(i + 1, j + 1) * sx) * sy;
  };
}

// Patches a few hundred metres across with a rougher edge. Each texel holds its rank among all
// texels (0 to 1), so the shader's threshold sets how much of the ground is under cloud.
function makeMap() {
  const octaves = [[7, 0.55, 3], [15, 0.3, 7], [31, 0.15, 13]].map(([cells, weight, seed]) => ({ noise: wrapped(cells, seed), weight }));
  const values = new Float32Array(SIZE * SIZE);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    let v = 0;
    for (const o of octaves) v += o.noise(i / SIZE, j / SIZE) * o.weight;
    values[j * SIZE + i] = v;
  }
  const order = Array.from(values.keys()).sort((a, b) => values[a] - values[b]);
  const data = new Uint8Array(SIZE * SIZE);
  order.forEach((index, rank) => { data[index] = Math.round(255 * rank / (order.length - 1)); });
  const map = new THREE.DataTexture(data, SIZE, SIZE, THREE.RedFormat, THREE.UnsignedByteType);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = map.minFilter = THREE.LinearFilter;
  map.unpackAlignment = 1;
  map.needsUpdate = true;
  return map;
}

export const CLOUD_MAP = { value: makeMap() };
// x, y: where the pattern has drifted to (in repeats); z: how much of the sun the shadows take away.
export const CLOUD = { value: new THREE.Vector3(0, 0, 0) };
export const CLOUD_EDGE = [0.56, 0.66]; // the ranks between which a texel goes from clear to shaded

// `seconds`: real time, so the shadows keep moving when the game clock is stopped.
// `strength`: 0 for no shadows (night, overcast, rain and snow), up to about 0.6 in fair weather.
export function updateClouds(seconds: number, strength: number) {
  CLOUD.value.set(((WIND[0] * seconds) / CLOUD_SPAN) % 1, ((WIND[1] * seconds) / CLOUD_SPAN) % 1, strength);
}

export const CLOUD_GLSL = /* glsl */`
uniform sampler2D uCloudMap;
uniform vec3 uCloud;
float cloudLit(vec3 world) {
  float c = texture2D(uCloudMap, world.xz * ${(1 / CLOUD_SPAN).toFixed(8)} + uCloud.xy).r;
  return 1. - uCloud.z * smoothstep(${CLOUD_EDGE[0]}, ${CLOUD_EDGE[1]}, c);
}`;
