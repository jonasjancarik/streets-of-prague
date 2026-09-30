// The cloud shadows (../clouds.ts) in TSL: the sun's light node with its colour scaled by the
// drifting pattern, so every lit material gets them, trees and cars included, and the sky's
// light and the lamps stay as they were.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { DirectionalLightNode } from 'three/webgpu';
import { texture, float, vec2, positionWorld, smoothstep } from 'three/tsl';
import { CLOUD, CLOUD_MAP, CLOUD_SPAN, CLOUD_EDGE } from '../clouds.ts';
import { followVec } from './common.ts';
import type { N } from './common.ts';

const map = texture(CLOUD_MAP.value);
const uCloud = followVec(CLOUD as any);

export const cloudLit = (world: N = positionWorld): N => {
  const c = map.sample(vec2(world.x, world.z).div(CLOUD_SPAN).add(uCloud.xy)).level(float(0)).r;
  return uCloud.z.mul(smoothstep(CLOUD_EDGE[0], CLOUD_EDGE[1], c)).oneMinus();
};

export class CloudSunNode extends DirectionalLightNode {
  static get type() { return 'CloudSunNode'; }

  setupDirect(...args: unknown[]) {
    const direct = (super.setupDirect as (...a: unknown[]) => { lightDirection: N; lightColor: N })(...args);
    return { lightDirection: direct.lightDirection, lightColor: direct.lightColor.mul(cloudLit()) };
  }
}
