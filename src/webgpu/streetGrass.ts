// The blades of grass seen from the street (../streetGrass.ts) in TSL: low cards of
// photographed lawn grass in the lawn's own green and the season's, darker at the foot,
// where they meet the ground, and lighter at the tips; they thin out with distance, bend
// with the wind, and lie under the snow.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { float, vec2, vec3, vec4, attribute, texture, uv, positionGeometry, cameraPosition, cameraViewMatrix, distance, mix, smoothstep, sin, fract, floor, step } from 'three/tsl';
import { GRASS_SEASON } from '../groundSeason.ts';
import { TREE_SWAY } from '../shading.ts';
import { GRASS_FADE, GRASS_REACH, GRASS_THIN, setGrassMaterial } from '../streetGrass.ts';
import { lampLit } from './lamps.ts';
import { type N, followVec, uWet, uSnow, vnoise } from './common.ts';

const uSway: N = followVec(TREE_SWAY), uSeason: N = followVec(GRASS_SEASON.park);
// The lawn's green as the ground draws it (COLORS.park in ground.ts, linear light), a little livelier.
const GREEN = vec3(0.21, 0.37, 0.085);

const picture = new THREE.Texture();
picture.colorSpace = THREE.SRGBColorSpace;
picture.wrapS = THREE.RepeatWrapping;
picture.anisotropy = 4;
const blades: N = texture(picture);
export const GRASS_READY = { value: false };
let asked = false;
function load() {
  if (asked) return;
  asked = true;
  new THREE.ImageLoader().load('grass-blades.webp', (image) => { picture.image = image; picture.needsUpdate = true; GRASS_READY.value = true; });
}

function material() {
  const m = new MeshLambertNodeMaterial({ side: THREE.DoubleSide }) as N;
  m.name = 'street-grass';
  const corner: N = attribute('corner', 'vec3'), blade: N = attribute('blade', 'vec3');
  const tone: N = blade.x, rank: N = blade.y, tall: N = blade.z, up: N = uv().y;
  // Close by every card is drawn. Further off fewer and fewer are (each has its rank), those
  // that are grow wider to cover for the rest, and the last sink into the ground.
  const far: N = distance(cameraPosition, positionGeometry);
  const lasts: N = mix(GRASS_THIN, GRASS_REACH, smoothstep(0.85, 0.15, rank));
  const kept: N = float(1).sub(smoothstep(lasts.mul(0.75), lasts, far)).mul(float(1).sub(smoothstep(0.25, 0.6, uSnow)));
  const wider: N = mix(1, 2.6, smoothstep(GRASS_THIN, GRASS_FADE, far));
  // The wind bends the tips, in gusts that cross the lawn.
  const gust: N = sin(uSway.x.mul(1.7).sub(positionGeometry.x.mul(uSway.z).add(positionGeometry.z.mul(uSway.w)).mul(0.35))).add(sin(uSway.x.mul(4.1).add(tone.mul(40))).mul(0.4)).add(0.5);
  const bend: N = vec3(uSway.z, 0, uSway.w).mul(gust).mul(up).mul(tall).mul(uSway.y).mul(0.55);
  m.positionNode = positionGeometry.add(vec3(corner.x.mul(wider), corner.y.mul(kept), corner.z.mul(wider))).add(bend);
  // (The upper part of the picture only, where the blades stand apart: lower down they are
  // a solid mass, and a card of that is a green board.)
  const p: N = blades.sample(vec2(uv().x, up.mul(0.66).add(0.2)));
  // The picture's lower half is a solid mass of blades, and a card of that is a green board
  // on the lawn. So the card is cut into blades of its own as well: narrow columns across
  // it, two in five of them left out and the rest ending at heights of their own.
  const column: N = floor(uv().x.mul(150)), cut: N = fract(sin(column.mul(127.1).add(floor(tone.mul(97)).mul(311.7))).mul(43758.5453));
  const stands: N = step(0.4, cut).mul(step(up, fract(cut.mul(7.7)).mul(0.75).add(0.3)));
  m.opacityNode = p.a.mul(stands);
  m.alphaTest = 0.3;
  // In the lawn's colour: darker and duller at the foot, where the ground shows between
  // the blades, lighter at the tips; card by card a little yellower or bluer, and the same
  // broad lighter and darker patches the ground has.
  const broad: N = vnoise(vec2(positionGeometry.x, positionGeometry.z.negate()).mul(0.18)).mul(0.36).add(0.82);
  const own: N = mix(vec3(1.04, 1.02, 0.88), vec3(0.94, 1.02, 1.04), fract(tone.mul(5.7))).mul(mix(0.88, 1.08, tone));
  const c: N = GREEN.mul(uSeason.xyz).mul(p.rgb).mul(1.3).mul(mix(0.74, 1.1, up)).mul(own).mul(broad).mul(float(1).sub(uWet.mul(0.2)));
  m.colorNode = vec4(c, 1);
  // Lit as the ground under it is: its light comes from above, whichever way the card faces.
  m.setupNormal = () => cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  lampLit(m);
  return m as THREE.Material;
}

setGrassMaterial(() => { load(); return material(); }, GRASS_READY);
