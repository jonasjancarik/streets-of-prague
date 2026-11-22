// The leaves of the hedges seen from the street (../streetHedges.ts) in TSL: each card a
// cluster of hornbeam leaves (assets/hedges/), darker deep in the hedge and near the
// ground, lighter and yellower where it stands proud; the cards thin out with distance
// and stir in the wind. The hedge's body under them wears the picture of a clipped
// hornbeam hedge's face (hedgeFace; applied in ../webgpu.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { float, vec2, vec3, vec4, attribute, texture, uv, step, positionGeometry, cameraPosition, normalViewGeometry, cameraViewMatrix, distance, dot, mix, smoothstep, normalize, sin, fract } from 'three/tsl';
import { HEDGE_SEASON } from '../groundSeason.ts';
import { TREE_SWAY } from '../shading.ts';
import { HEDGE_FADE, HEDGE_REACH, HEDGE_THIN, setHedgeMaterial } from '../streetHedges.ts';
import { lampLit } from './lamps.ts';
import { type N, followColor, followVec, uWet, uSnow, vnoise } from './common.ts';

const uSway: N = followVec(TREE_SWAY), uSeason: N = followColor(HEDGE_SEASON);

// The pictures (assets/hedges/): a cluster of hornbeam leaves for the cards, and the clipped
// face of a hornbeam hedge for the body under them. Each node keeps its one texture and the
// image is put into it when it arrives. (Given another texture afterwards, the body's
// material, compiled with the first tiles, went on drawing the stand-in.)
const picture = (repeat: boolean, anisotropy: number) => {
  const t = new THREE.Texture();
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
};
const clusterPicture = picture(false, 4), facePicture = picture(true, 8);
const clusters: N = texture(clusterPicture);
const hedgeFace: N = texture(facePicture);
export const HEDGES_READY = { value: false };
let asked = false;
function load() {
  if (asked) return;
  asked = true;
  const loader = new THREE.ImageLoader();
  let left = 2;
  const into = (t: THREE.Texture) => (image: HTMLImageElement) => { t.image = image; t.needsUpdate = true; if (--left === 0) HEDGES_READY.value = true; };
  loader.load('hedge-leaves.webp', into(clusterPicture));
  loader.load('hedge-face.webp', into(facePicture));
}

function material() {
  const m = new MeshLambertNodeMaterial({ side: THREE.DoubleSide }) as N;
  m.name = 'street-hedges';
  const corner: N = attribute('corner', 'vec3'), leaf: N = attribute('leaf', 'vec4');
  const tone: N = leaf.x, height: N = leaf.y, depth: N = leaf.z, rank: N = leaf.w;
  // (The mesh sits at the world's origin: its positions are the world's.)
  // Close by every cluster is drawn. Further off, where single leaves are a pixel, fewer and
  // fewer are (each has its rank: the first in five lasts to the end), and those that are
  // grow to cover for the rest; the last shrink to nothing where the clusters end.
  const far: N = distance(cameraPosition, positionGeometry);
  const lasts: N = mix(HEDGE_THIN, HEDGE_REACH, smoothstep(0.8, 0.2, rank).mul(0.75).add(float(1).sub(smoothstep(0, 0.2, rank)).mul(0.25)));
  const kept: N = float(1).sub(smoothstep(lasts.mul(0.8), lasts, far));
  const grown: N = mix(1, 1.7, smoothstep(HEDGE_THIN, HEDGE_FADE, far));
  // The wind: the clusters that stand proud stir most, each in its own time.
  const stir: N = sin(uSway.x.mul(2.9).add(tone.mul(61))).add(sin(uSway.x.mul(1.3).add(positionGeometry.x.mul(0.7)).add(positionGeometry.z.mul(0.5)))).mul(uSway.y).mul(depth).mul(0.008);
  m.positionNode = positionGeometry.add(corner.mul(kept).mul(grown)).add(vec3(uSway.z, 0.4, uSway.w).mul(stir));
  const p: N = clusters.sample(uv());
  m.opacityNode = p.a;
  m.alphaTest = 0.5;
  // Deep in the hedge little light arrives; so too near the ground. The newest growth, out
  // at the surface and towards the top, is lighter and yellower, a cluster here and there.
  const shade: N = mix(0.5, 0.98, smoothstep(0.05, 0.9, depth)).mul(mix(0.6, 1, smoothstep(0, 0.45, height)));
  const young: N = smoothstep(0.72, 1, fract(tone.mul(7.3))).mul(smoothstep(0.4, 1, depth)).mul(smoothstep(0.3, 1, height));
  const dry: N = mix(vec3(1), vec3(1.22, 1.16, 0.74), young.mul(0.6));
  const lit: N = p.rgb.mul(vec3(0.9, 0.96, 0.9)).mul(uSeason).mul(shade).mul(mix(0.78, 1.1, tone)).mul(dry).mul(float(1).sub(uWet.mul(0.18)));
  const upward: N = dot(normalize(normalViewGeometry), cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  const snowy: N = smoothstep(0.35, 0.85, upward).mul(smoothstep(0.2, 0.8, uSnow)).mul(depth).mul(0.6);
  m.colorNode = vec4(mix(lit, vec3(0.78, 0.8, 0.84), snowy), 1);
  // The cards take the hedge's own rounded face for their light, the same from both sides.
  m.setupNormal = () => normalize(normalViewGeometry);
  lampLit(m);
  return m as THREE.Material;
}

// The hedge's skin under the clusters: the face's picture, darker towards the ground and a
// little darker than the clusters over it (the leaves behind the outermost ones), some
// stretches denser and darker than others. Where the clusters end it is gone too, and the
// body the view from above draws shows again.
function skin() {
  const m = new MeshLambertNodeMaterial() as N;
  m.name = 'street-hedge-skin';
  const height: N = attribute('height', 'float');
  const far: N = distance(cameraPosition, positionGeometry);
  m.positionNode = positionGeometry.sub(vec3(0, 1, 0).mul(step(HEDGE_REACH, far).mul(50)));
  const p: N = hedgeFace.sample(uv());
  const patch: N = vnoise(vec2(positionGeometry.x.add(positionGeometry.z.mul(0.7)), positionGeometry.y).mul(0.55).add(21)).mul(0.3).add(0.84);
  const shade: N = mix(0.5, 0.9, smoothstep(0, 0.5, height));
  const lit: N = p.rgb.mul(uSeason).mul(shade).mul(patch).mul(float(1).sub(uWet.mul(0.18)));
  const upward: N = dot(normalize(normalViewGeometry), cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  m.colorNode = vec4(mix(lit, vec3(0.78, 0.8, 0.84), smoothstep(0.35, 0.85, upward).mul(smoothstep(0.2, 0.8, uSnow)).mul(0.75)), 1);
  lampLit(m);
  return m as THREE.Material;
}

setHedgeMaterial(() => { load(); return { clusters: material(), skin: skin() }; }, HEDGES_READY);
