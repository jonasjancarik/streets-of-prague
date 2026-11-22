// The leaves of the hedges seen from the street (../streetHedges.ts) in TSL: each card a
// spray of the street trees' leaves, in the hedge's green, darker deep in the hedge and
// near the ground, lighter and yellower where it stands proud; the cards shrink to nothing
// with distance and stir in the wind.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { float, vec2, vec3, vec4, attribute, uv, positionGeometry, cameraPosition, normalViewGeometry, cameraViewMatrix, distance, dot, mix, smoothstep, normalize, sin, fract } from 'three/tsl';
import { HEDGE_SEASON } from '../groundSeason.ts';
import { TREE_SWAY } from '../shading.ts';
import { HEDGE_FADE, HEDGE_REACH, HEDGE_THIN, setHedgeMaterial } from '../streetHedges.ts';
import { lampLit } from './lamps.ts';
import { sprays, loadStreetTrees, STREET_TREES_READY } from './streetTrees.ts';
import { type N, followColor, followVec, uWet, uSnow } from './common.ts';

const uSway: N = followVec(TREE_SWAY), uSeason: N = followColor(HEDGE_SEASON);
// A hornbeam or privet hedge's green (linear light), before the spray's own light and dark.
const GREEN = vec3(0.085, 0.175, 0.045);

function material() {
  const m = new MeshLambertNodeMaterial({ side: THREE.DoubleSide }) as N;
  m.name = 'street-hedges';
  const corner: N = attribute('corner', 'vec3'), leaf: N = attribute('leaf', 'vec4');
  const tone: N = leaf.x, height: N = leaf.y, depth: N = leaf.z, rank: N = leaf.w;
  // (The mesh sits at the world's origin: its positions are the world's.)
  // Close by every spray is drawn. Further off, where single leaves are a pixel, fewer and
  // fewer are (each spray has its rank: the first in five lasts to the end), and those that
  // are grow to cover for the rest; the last shrink to nothing where the sprays end.
  const far: N = distance(cameraPosition, positionGeometry);
  const lasts: N = mix(HEDGE_THIN, HEDGE_REACH, smoothstep(0.8, 0.2, rank).mul(0.75).add(float(1).sub(smoothstep(0, 0.2, rank)).mul(0.25)));
  const kept: N = float(1).sub(smoothstep(lasts.mul(0.8), lasts, far));
  const grown: N = mix(1, 2.1, smoothstep(HEDGE_THIN, HEDGE_FADE, far));
  // The wind: the sprays that stand proud stir most, each in its own time.
  const stir: N = sin(uSway.x.mul(2.9).add(tone.mul(61))).add(sin(uSway.x.mul(1.3).add(positionGeometry.x.mul(0.7)).add(positionGeometry.z.mul(0.5)))).mul(uSway.y).mul(depth).mul(0.008);
  m.positionNode = positionGeometry.add(corner.mul(kept).mul(grown)).add(vec3(uSway.z, 0.4, uSway.w).mul(stir));
  const card: N = uv();
  const p: N = sprays.sample(vec2(card.x.mul(0.96).add(0.02).div(3), card.y.oneMinus()));
  m.opacityNode = p.a;
  m.alphaTest = 0.42;
  // Deep in the hedge little light arrives; so too near the ground. The newest growth, out
  // at the surface and towards the top, is lighter and yellower, a spray here and there.
  const shade: N = mix(0.38, 1.1, smoothstep(0.05, 0.9, depth)).mul(mix(0.55, 1, smoothstep(0, 0.45, height)));
  const young: N = smoothstep(0.72, 1, fract(tone.mul(7.3))).mul(smoothstep(0.4, 1, depth)).mul(smoothstep(0.3, 1, height));
  const dry: N = mix(vec3(1), vec3(1.32, 1.22, 0.66), young.mul(0.6));
  const lit: N = GREEN.mul(uSeason).mul(p.rgb).mul(1.75).mul(shade).mul(mix(0.78, 1.18, tone)).mul(dry).mul(float(1).sub(uWet.mul(0.18)));
  const upward: N = dot(normalize(normalViewGeometry), cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  const snowy: N = smoothstep(0.35, 0.85, upward).mul(smoothstep(0.2, 0.8, uSnow)).mul(depth).mul(0.6);
  m.colorNode = vec4(mix(lit, vec3(0.78, 0.8, 0.84), snowy), 1);
  // The cards take the hedge's own rounded face for their light, the same from both sides.
  m.setupNormal = () => normalize(normalViewGeometry);
  lampLit(m);
  return m as THREE.Material;
}

setHedgeMaterial(() => { loadStreetTrees(); return material(); }, STREET_TREES_READY);
