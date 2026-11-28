// The finished picture on High and Ultra (../post.ts): the scene is drawn to a target of its own,
// what is brighter than a threshold spills light round itself (three.js's bloom: five
// blurred copies at falling resolutions), then the tone curve runs, and the corners are
// darkened a little.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type * as THREE from 'three';
import { Matrix3, RenderPipeline, Vector3, Vector4 } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { Fn, If, pass, renderOutput, uniform, uv, vec2, vec3, vec4, length, smoothstep, float, dot, min, max, abs, cross, fract, screenCoordinate } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { BLUR_TUNE, OTHERS, POST, VIGNETTE_TUNE, setPost } from '../post.ts';
import type { N } from './common.ts';

// Bloom by day and at night: [strength, radius, threshold], the threshold in the picture's
// own light after the exposure (1 is about what the curve turns nearly white).
// By day only glints and the brightest sunlit plaster pass it; at night the lamps' pools,
// lit windows and headlights do.
const DAY = [0.22, 0.55, 1.35], NIGHT = [0.4, 0.7, 0.55];
const VIGNETTE = 0.16;
// (Read each frame: the developer panel can change it.)
const vignette: N = uniform(VIGNETTE);
const AO = 0.8; // how much of the ambient shading is taken
// The bloom's first copy, as a share of the picture's width (three.js's own choice is a half: a
// quarter is blurred enough not to show, and a quarter of the pixels to fill).
const BLOOM_SCALE = 0.25;
// Motion blur when driving (POST.blur): the picture is smeared along the way each point of
// the street moved across it while the shutter was open, worked out from the picture's
// depth and how far the camera travelled. The camera is taken to travel as the player's vehicle does, and its turning
// is left out, so looking round stays sharp. The nearest few other vehicles under way are
// smeared by how they move against the camera (one on your tail at your speed hardly at all);
// traffic further off is smeared as if it stood still. `SHUTTER`:
// how long it is open (s), at full strength; `REACH`: the longest smear, as a share of the
// picture's height; `TAPS`: how many times the picture is read along it.
// (Both are scaled by BLUR_TUNE.strength, from the dev panel.)
const SHUTTER = 0.016, REACH = 0.045, TAPS = 8;
// How high above the road the player's vehicle starts keeping sharp (m).
const LIFT = 0.25;

export function makePost(renderer: WebGPURenderer) {
  let pipeline: RenderPipeline | null = null, of: THREE.Scene | null = null, by: THREE.Camera | null = null, shaded = false, glowing = false;
  let glow: N = null;
  let sceneTarget: THREE.RenderTarget | null = null; // (what the scene is drawn into: post.ts, postTarget)
  // The camera's travel while the shutter is open, as the camera sees it; the player's vehicle
  // there (its reach in w); the picture's width over its height.
  const travel: N = uniform(new Vector3()), player: N = uniform(new Vector4(0, 0, 0, -1)), aspect: N = uniform(1), minSmear: N = uniform(0), reach: N = uniform(REACH);
  // The vehicle's length and up as the camera sees them, and its half length, width and height.
  const along: N = uniform(new Vector3(1, 0, 0)), upright: N = uniform(new Vector3(0, 1, 0)), half: N = uniform(new Vector3());
  // The same for the nearest other vehicles under way (POST.others), with how far each
  // travelled while the shutter was open, as the camera sees it.
  const others = Array.from({ length: OTHERS }, () => ({ mid: uniform(new Vector4(0, 0, 0, -1)) as N, along: uniform(new Vector3(1, 0, 0)) as N, half: uniform(new Vector3()) as N, travel: uniform(new Vector3()) as N }));
  const speed = new Vector3(), turn = new Matrix3();
  const build = (scene: THREE.Scene, camera: THREE.Camera) => {
    pipeline?.dispose();
    of = scene; by = camera; shaded = POST.ao; glowing = POST.glow;
    // (The ground's layers are drawn once a pixel with the stencil: surface.ts.)
    const scenePass: N = pass(scene, camera, { stencilBuffer: true } as any);
    sceneTarget = scenePass.renderTarget;
    let colour: N = scenePass.getTextureNode('output');
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
          // How far outside a vehicle this point is, 0 inside to 1 a fifth of a metre out: a box
          // round its body with room for the mirrors, its bottom a quarter of a metre off the
          // road so the street under and round the car smears like the rest (a sharp patch of
          // cobbles gives it away).
          const outside = (mid: N, dir: N, size: N) => {
            const rel: N = here.sub(mid.xyz).sub(upright.mul(LIFT / 2)).toVar();
            const q: N = vec3(abs(dot(rel, dir)), abs(dot(rel, cross(upright, dir))), abs(dot(rel, upright))).sub(size).sub(vec3(0.1, 0.25, LIFT / -2));
            return mid.w.greaterThan(0).select(smoothstep(0, 0.2, length(max(q, vec3(0)))), float(1));
          };
          // A point on another vehicle moved with it while the shutter was open: what the
          // camera saw it travel is the camera's travel less its own.
          const moved: N = travel.toVar();
          for (const o of others) moved.subAssign(o.travel.mul(outside(o.mid, o.along, o.half).oneMinus()));
          const clip: N = proj.mul(vec4(here.add(moved), 1)).toVar();
          const was: N = vec2(clip.x.div(clip.w), clip.y.div(clip.w).negate()).mul(0.5).add(0.5);
          const keep: N = outside(player, along, half);
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
    // On Ultra (graphics.ts; ?ao=on|off for one visit): ambient shading worked out from the picture's
    // depth (three.js's GTAO at half resolution, the ground's depth drawn for it as in first
    // person). From above it darkens the ground round cars and along walls and the roofs'
    // valleys a little, next to the shadows and the soft shading already there, and costs
    // about 3 ms a frame at 2× on an M5 (7.6 → 10.9 ms standing, 11.4 → 14.2 driving).
    // (After the motion blur, which reads the picture as a texture: shading it before then
    // left the blur a sum to sample, not a picture, and the whole frame came out black.)
    if (POST.ao) {
      const shade: N = ao(scenePass.getTextureNode('depth'), null as any, camera);
      shade.resolutionScale = 0.5;
      shade.radius.value = 4;
      shade.scale.value = 1.6;
      shade.thickness.value = 3;
      shade.samples.value = 12;
      colour = colour.mul(vec4(vec3(shade.getTextureNode().r.mul(AO).add(1 - AO)), 1));
    }
    // (The glow and the darker corners only when asked for: the shading can go on without them.)
    glow = null;
    if (POST.glow) {
      glow = bloom(colour, DAY[0], DAY[1], DAY[2]);
      glow.setResolutionScale(BLOOM_SCALE);
    }
    const lit: N = renderOutput(glow ? colour.add(glow) : colour);
    const p: N = uv().sub(0.5).mul(vec2(1, 0.85));
    const shade: N = POST.glow ? float(1).sub(smoothstep(0.38, 0.82, length(p)).mul(vignette)) : float(1);
    pipeline = new RenderPipeline(renderer, vec4(lit.rgb.mul(shade), 1) as any);
    pipeline.outputColorTransform = false;
  };
  setPost((scene, camera) => {
    if (!pipeline || of !== scene || by !== camera || shaded !== POST.ao || glowing !== POST.glow) build(scene, camera);
    const k = POST.night, mixed = (i: number) => DAY[i] + (NIGHT[i] - DAY[i]) * k;
    const exposure = Math.max(Math.abs(renderer.toneMappingExposure), 0.01);
    if (glow) {
      glow.strength.value = mixed(0) * (1 + 0.25 * POST.wet * k);
      glow.radius.value = mixed(1);
      glow.threshold.value = mixed(2) / exposure;
    }
    vignette.value = Math.min(1, VIGNETTE * VIGNETTE_TUNE.strength);
    camera.updateMatrixWorld();
    speed.fromArray(POST.going);
    if (POST.blur > 0.001) {
      // (Turned into the camera's own axes: its rotation alone, its place left out.)
      travel.value.copy(speed).transformDirection(camera.matrixWorldInverse).multiplyScalar(speed.length() * SHUTTER * POST.blur * BLUR_TUNE.strength);
      reach.value = REACH * BLUR_TUNE.strength;
      player.value.set(POST.car[0], POST.car[1], POST.car[2], 1).applyMatrix4(camera.matrixWorldInverse).setW(POST.car[3]);
      along.value.set(Math.cos(POST.box[3]), 0, -Math.sin(POST.box[3])).transformDirection(camera.matrixWorldInverse);
      upright.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
      half.value.set(POST.box[0], POST.box[1], POST.box[2]);
      const shutter = SHUTTER * POST.blur * BLUR_TUNE.strength;
      others.forEach((o, i) => {
        const c = POST.others[i];
        if (!c) { o.mid.value.w = -1; return; }
        o.mid.value.set(c.mid[0], c.mid[1], c.mid[2], 1).applyMatrix4(camera.matrixWorldInverse).setW(1);
        o.along.value.set(Math.cos(c.box[3]), 0, -Math.sin(c.box[3])).transformDirection(camera.matrixWorldInverse);
        o.half.value.set(c.box[0], c.box[1], c.box[2]);
        // (transformDirection would make it a unit length: the rotation is applied by hand.)
        o.travel.value.fromArray(c.going).applyMatrix3(turn.setFromMatrix4(camera.matrixWorldInverse)).multiplyScalar(shutter);
      });
      aspect.value = (camera as THREE.PerspectiveCamera).aspect || 1;
      minSmear.value = (.35 / Math.max(1, renderer.domElement.height)) ** 2;
    } else travel.value.set(0, 0, 0);
    pipeline!.render();
  }, () => sceneTarget);
}
