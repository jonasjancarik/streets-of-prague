// The finished picture on Ultra (../post.ts): the scene is drawn to a target of its own,
// what is brighter than a threshold spills light round itself (three.js's bloom: five
// blurred copies at falling resolutions), then the tone curve runs, and the corners are
// darkened a little.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type * as THREE from 'three';
import { RenderPipeline } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { pass, renderOutput, uniform, uv, vec2, vec4, length, smoothstep, float } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { POST, setPost } from '../post.ts';
import type { N } from './common.ts';

// Bloom by day and at night: [strength, radius, threshold], the threshold in the picture's
// own light after the exposure (1 is about what the curve turns nearly white).
// By day only glints and the brightest sunlit plaster pass it; at night the lamps' pools,
// lit windows and headlights do.
const DAY = [0.22, 0.55, 1.35], NIGHT = [0.45, 0.7, 0.42];
const VIGNETTE = 0.16;
// The bloom's first copy, as a share of the picture's width (three.js's own choice is a half: a
// quarter is blurred enough not to show, and a quarter of the pixels to fill).
const BLOOM_SCALE = 0.25;

export function makePost(renderer: WebGPURenderer) {
  let pipeline: RenderPipeline | null = null, of: THREE.Scene | null = null, by: THREE.Camera | null = null;
  let glow: N = null;
  const build = (scene: THREE.Scene, camera: THREE.Camera) => {
    pipeline?.dispose();
    of = scene; by = camera;
    // (The ground's layers are drawn once a pixel with the stencil: surface.ts.)
    const scenePass: N = pass(scene, camera, { stencilBuffer: true } as any);
    const colour: N = scenePass.getTextureNode('output');
    glow = bloom(colour, DAY[0], DAY[1], DAY[2]);
    glow.setResolutionScale(BLOOM_SCALE);
    const lit: N = renderOutput(colour.add(glow));
    const p: N = uv().sub(0.5).mul(vec2(1, 0.85));
    const shade: N = float(1).sub(smoothstep(0.38, 0.82, length(p)).mul(uniform(VIGNETTE)));
    pipeline = new RenderPipeline(renderer, vec4(lit.rgb.mul(shade), 1) as any);
    pipeline.outputColorTransform = false;
  };
  setPost((scene, camera) => {
    if (!pipeline || of !== scene || by !== camera) build(scene, camera);
    const k = POST.night, mixed = (i: number) => DAY[i] + (NIGHT[i] - DAY[i]) * k;
    const exposure = Math.max(Math.abs(renderer.toneMappingExposure), 0.01);
    glow.strength.value = mixed(0) * (1 + 0.25 * POST.wet * k);
    glow.radius.value = mixed(1);
    glow.threshold.value = mixed(2) / exposure;
    pipeline!.render();
  });
}
