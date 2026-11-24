// The finished picture on High and Ultra (../post.ts): the scene is drawn to a target of its own,
// what is brighter than a threshold spills light round itself (three.js's bloom: five
// blurred copies at falling resolutions), then the tone curve runs, and the corners are
// darkened a little.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type * as THREE from 'three';
import { RenderPipeline, Vector3, Vector4 } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { Fn, If, pass, renderOutput, uniform, uv, vec2, vec3, vec4, length, smoothstep, float, dot, min, max, distance, fract, screenCoordinate } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { BLUR_TUNE, POST, setPost } from '../post.ts';
import type { N } from './common.ts';

// Bloom by day and at night: [strength, radius, threshold], the threshold in the picture's
// own light after the exposure (1 is about what the curve turns nearly white).
// By day only glints and the brightest sunlit plaster pass it; at night the lamps' pools,
// lit windows and headlights do.
const DAY = [0.22, 0.55, 1.35], NIGHT = [0.4, 0.7, 0.55];
const VIGNETTE = 0.16;
const AO = 0.8; // how much of the ambient shading is taken
// The bloom's first copy, as a share of the picture's width (three.js's own choice is a half: a
// quarter is blurred enough not to show, and a quarter of the pixels to fill).
const BLOOM_SCALE = 0.25;
// Motion blur when driving (POST.blur): the picture is smeared along the way each point of
// the street moved across it while the shutter was open, worked out from the picture's
// depth and how far the camera travelled. The camera is taken to travel as the player's vehicle does, and its turning
// is left out, so looking round stays sharp; other traffic is smeared as if it stood still. `SHUTTER`:
// how long it is open (s), at full strength; `REACH`: the longest smear, as a share of the
// picture's height; `TAPS`: how many times the picture is read along it.
// (Both are scaled by BLUR_TUNE.strength, from the dev panel.)
const SHUTTER = 0.016, REACH = 0.045, TAPS = 8;

export function makePost(renderer: WebGPURenderer) {
  let pipeline: RenderPipeline | null = null, of: THREE.Scene | null = null, by: THREE.Camera | null = null;
  let glow: N = null;
  // The camera's travel while the shutter is open, as the camera sees it; the player's vehicle
  // there (its reach in w); the picture's width over its height.
  const travel: N = uniform(new Vector3()), player: N = uniform(new Vector4(0, 0, 0, -1)), aspect: N = uniform(1), minSmear: N = uniform(0), reach: N = uniform(REACH);
  const speed = new Vector3();
  const build = (scene: THREE.Scene, camera: THREE.Camera) => {
    pipeline?.dispose();
    of = scene; by = camera;
    // (The ground's layers are drawn once a pixel with the stencil: surface.ts.)
    const scenePass: N = pass(scene, camera, { stencilBuffer: true } as any);
    let colour: N = scenePass.getTextureNode('output');
    // A trial, off unless asked for (?ao): ambient shading worked out from the picture's
    // depth (three.js's GTAO at half resolution, the ground's depth drawn for it as in first
    // person). From above it darkens the ground round cars and along walls and the roofs'
    // valleys a little, next to the shadows and the soft shading already there, and costs
    // about 3 ms a frame at 2× on an M5 (7.6 → 10.9 ms standing, 11.4 → 14.2 driving).
    if (POST.ao) {
      const shade: N = ao(scenePass.getTextureNode('depth'), null as any, camera);
      shade.resolutionScale = 0.5;
      shade.radius.value = 4;
      shade.scale.value = 1.6;
      shade.thickness.value = 3;
      shade.samples.value = 12;
      colour = colour.mul(vec4(vec3(shade.getTextureNode().r.mul(AO).add(1 - AO)), 1));
    }
    {
      const depth: N = scenePass.getTextureNode('depth'), sharp: N = colour;
      const proj: N = uniform((camera as THREE.PerspectiveCamera).projectionMatrix), back: N = uniform((camera as THREE.PerspectiveCamera).projectionMatrixInverse);
      colour = Fn(() => {
        const at: N = uv(), out: N = sharp.toVar();
        // (Asked of a uniform, so where nothing moves the picture is read once as before.)
        If(dot(travel, travel).greaterThan(1e-7), () => {
          // Where this pixel's point was when the shutter opened: it stood still, the camera moved.
          const ndc: N = vec2(at.x, at.y.oneMinus()).mul(2).sub(1);
          const view: N = back.mul(vec4(ndc, depth.sample(at).r, 1)).toVar();
          const here: N = view.xyz.div(view.w).toVar();
          const clip: N = proj.mul(vec4(here.add(travel), 1)).toVar();
          const was: N = vec2(clip.x.div(clip.w), clip.y.div(clip.w).negate()).mul(0.5).add(0.5);
          const keep: N = smoothstep(player.w, player.w.add(1.5), distance(here, player.xyz));
          const smear: N = was.sub(at).mul(keep).toVar();
          // (Behind the camera the sums turn over: nothing there is in the picture anyway.)
          smear.mulAssign(min(1, reach.div(max(length(smear.mul(vec2(aspect, 1))), 1e-5))).mul(clip.w.greaterThan(0.05).select(1, 0)));
          // The sky, distant scenery and the protected player's car usually move
          // less than a third of a pixel. Keep the original sample there instead
          // of reading the same texel eight more times (also in bloom's input).
          const pixels: N = smear.mul(vec2(aspect, 1));
          If(dot(pixels, pixels).greaterThan(minSmear), () => {
            const sum: N = vec3(0).toVar();
            // (Each pixel reads at its own places along the smear, which turns steps into fine grain.)
            const shift: N = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189)).sub(0.5).div(TAPS);
            for (let i = 0; i < TAPS; i++) sum.addAssign(sharp.sample(at.add(smear.mul(shift.add((i + 0.5) / TAPS - 0.5)))).level(0).rgb);
            out.assign(vec4(sum.div(TAPS), out.a));
          });
        });
        return out;
      })();
    }
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
    camera.updateMatrixWorld();
    speed.fromArray(POST.going);
    if (POST.blur > 0.001) {
      // (Turned into the camera's own axes: its rotation alone, its place left out.)
      travel.value.copy(speed).transformDirection(camera.matrixWorldInverse).multiplyScalar(speed.length() * SHUTTER * POST.blur * BLUR_TUNE.strength);
      reach.value = REACH * BLUR_TUNE.strength;
      player.value.set(POST.car[0], POST.car[1], POST.car[2], 1).applyMatrix4(camera.matrixWorldInverse).setW(POST.car[3]);
      aspect.value = (camera as THREE.PerspectiveCamera).aspect || 1;
      minSmear.value = (.35 / Math.max(1, renderer.domElement.height)) ** 2;
    } else travel.value.set(0, 0, 0);
    pipeline!.render();
  });
}
