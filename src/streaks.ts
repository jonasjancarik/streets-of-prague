// The lights' reflections in the wet streets at night (the "Lights reflect" setting): each
// lit lamp head, car light and traffic light the game draws gets a streak on the ground
// where its reflection falls, a little towards the camera from its foot (the mirror image
// of a light h up, seen from H up, falls h / (H + h) of the way), smeared out towards the
// camera as on wet asphalt and the longer the higher the light. Brightest in the puddles
// (the same pattern as the ground's, WEATHER_GLSL), flickering while it rains. No second
// render of the scene (that's mirror.ts): a quad a light, only those near the view.

import * as THREE from 'three';
import { NOISE, NOISE_GLSL, RAIN, WET } from './shading.ts';
import { LAMP_ON } from './lamps.ts';
import { send } from './gpu.ts';

export const STREAKS_ON = { value: 0 };
export const STREAK_TIME = { value: 0 };
const MAX = 4096;
// How bright a streak is against the light it mirrors.
export const STREAK_GAIN = 0.7;

// The WebGPU renderer's version of the material (webgpu/glows.ts), set before the streaks are made.
let streakBy: (() => THREE.Material) | null = null;
export const setStreakShade = (f: typeof streakBy) => { streakBy = f; };

export class Streaks {
  mesh: THREE.InstancedMesh;
  private cam = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    // Flat, from a quarter of its length behind the mirror point to three quarters ahead
    // of it (towards the camera, +z); uv.y is 1 at the back.
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.25);
    this.mesh = new THREE.InstancedMesh(g, streakBy ? streakBy() : new THREE.ShaderMaterial({
      uniforms: { uOn: LAMP_ON, uWet: WET, uRain: RAIN, uTime: STREAK_TIME, uNoise: NOISE },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vC; varying vec2 vP;
        void main() {
          vUv = uv; vC = instanceColor;
          vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.);
          vP = vec2(w.x, -w.z);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOn, uWet, uRain, uTime; varying vec2 vUv; varying vec3 vC; varying vec2 vP;
        ${NOISE_GLSL}
        void main() {
          float along = 1. - vUv.y, x = (vUv.x - .5) * 2.;
          float f = along < .25 ? along / .25 : (1. - along) / .75;
          float a = f * f * (1. - x * x) * (1. - x * x);
          float puddle = smoothstep(.66, .71, fbm2(vP * .3 + 31.) * .75 + fbm2(vP * .04 + 7.) * .35);
          float flicker = 1. - uRain * .5 * vnoise(vec2(along * 9. + x * 2., uTime * 4.));
          gl_FragColor = vec4(vC * a * uWet * uOn * (.25 + .75 * puddle) * flicker * ${STREAK_GAIN.toFixed(2)}, 1.);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }), MAX);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }

  // Once a frame, from the lights as drawn (`lights`: instanced glows and flares, each at
  // its light, scaled to its size; a scale of 0 is a slot not lit), within `r` of (cx, cy).
  update(camera: THREE.Camera, lights: THREE.InstancedMesh[], groundAt: (x: number, y: number) => number, r: number, time: number) {
    STREAK_TIME.value = time;
    const m = this.mesh;
    m.count = 0;
    if (!STREAKS_ON.value || WET.value < 0.03 || LAMP_ON.value < 0.03) return;
    camera.getWorldPosition(this.cam);
    const cx = this.cam.x, cz = this.cam.z, out = m.instanceMatrix.array as Float32Array, col = m.instanceColor!.array as Float32Array;
    let n = 0;
    for (const l of lights) {
      const e = l.instanceMatrix.array as Float32Array, c = l.instanceColor?.array as Float32Array | undefined;
      if (!c) continue;
      for (let i = 0; i < l.count && n < MAX; i++) {
        const o = i * 16, size = Math.hypot(e[o], e[o + 1], e[o + 2]);
        if (size < 1e-3) continue;
        const x = e[o + 12], y = e[o + 13], z = e[o + 14];
        const fx = cx - x, fz = cz - z, far = Math.hypot(fx, fz);
        if (far > r) continue;
        const ground = groundAt(x, -z), up = y - ground, high = this.cam.y - ground;
        if (up < 0.2 || high < 1) continue;
        // The mirror point, and the way towards the camera.
        const k = up / (high + up), dx = far > 0.01 ? fx / far : 0, dz = far > 0.01 ? fz / far : 1;
        const w = 0.3 + 0.1 * up, len = 0.9 + 0.5 * up + 0.05 * far;
        const q = n * 16;
        out[q] = dz * w; out[q + 1] = 0; out[q + 2] = -dx * w; out[q + 3] = 0;
        out[q + 4] = 0; out[q + 5] = 1; out[q + 6] = 0; out[q + 7] = 0;
        out[q + 8] = dx * len; out[q + 9] = 0; out[q + 10] = dz * len; out[q + 11] = 0;
        out[q + 12] = x + fx * k; out[q + 13] = ground + 0.04; out[q + 14] = z + fz * k; out[q + 15] = 1;
        col[n * 3] = c[i * 3]; col[n * 3 + 1] = c[i * 3 + 1]; col[n * 3 + 2] = c[i * 3 + 2];
        n++;
      }
    }
    m.count = n;
    send(m.instanceMatrix, n);
    send(m.instanceColor!, n);
  }
}
