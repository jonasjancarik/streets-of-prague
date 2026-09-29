import * as THREE from 'three';
import type { Car } from './car.ts';
import { SNOW, STREET_SNOW } from './shading.ts';

// Tyre marks on the road: dark streaks where a car braked hard, slid or was pulled
// round on the handbrake (Car.skidBack/skidFront), and tracks in snow lying on the
// street. They darken whatever is under them and fade out over a minute.
//
// One ring of short quads, one draw call: each new piece of a mark takes the oldest
// slot, and only the slots written in a frame are sent to the GPU. A piece keeps the
// time it was laid and how dark it is; the shader fades it by its age, so nothing has
// to be touched again once it's down.

const SLOTS = 4096;     // pieces of mark (at most ~0.35 m each)
const LIFE = 60;        // s until a mark is gone
const STEP = 0.35;      // m a wheel goes between pieces
const TRACK_STEP = 1.2; // m between pieces of a track in the snow (they're straighter)
const HALF = 0.13;      // half a tyre's width, m
const LIFT = 0.04;      // m above the ground (and a polygon offset, for the far view)

// Where the wheels are, as fractions of the car's half-length and half-width
// (the back two first); a motorbike has one line.
const WHEELS: [number, number][] = [[-1, 1], [-1, -1], [1, 1], [1, -1]];

interface Wheel { on: boolean; run: number; x: number; y: number; ax: number; ay: number; az: number; bx: number; by: number; bz: number; s: number }
const wheel = (): Wheel => ({ on: false, run: 0, x: 0, y: 0, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, s: 0 });

export class Skids {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private pos: THREE.BufferAttribute;
  private mark: THREE.BufferAttribute;
  private next = 0;
  private now = 0;
  private wheels = new WeakMap<Car, Wheel[]>();

  constructor(scene: THREE.Scene) {
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(SLOTS * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    // (time laid, how dark, across the tyre -1..1)
    const mark = new Float32Array(SLOTS * 4 * 3);
    for (let i = 0; i < SLOTS * 4; i++) { mark[i * 3] = -1e9; mark[i * 3 + 2] = i % 2 ? 1 : -1; }
    this.mark = new THREE.BufferAttribute(mark, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('mark', this.mark);
    const index = new Uint16Array(SLOTS * 6);
    for (let i = 0; i < SLOTS; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uNow: { value: 0 } },
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        attribute vec3 mark;
        uniform float uNow;
        varying float vA; varying float vU;
        void main() {
          float age = uNow - mark.x;
          vA = mark.y * (1. - smoothstep(${(LIFE * 0.3).toFixed(1)}, ${LIFE.toFixed(1)}, age));
          vU = mark.z;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        varying float vA; varying float vU;
        void main() {
          float a = vA * (1. - vU * vU * vU * vU);
          #ifdef USE_FOG
            a *= 1. - smoothstep(fogNear, fogFar, vFogDepth);
          #endif
          if (a < .004) discard;
          gl_FragColor = vec4(0., 0., 0., a);
        }`,
      fog: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      // Only darkens what's there (the colour is ignored), so it looks right by day
      // and by night, on asphalt, cobbles or snow.
      blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -12,
    });
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1; // over the ground and the bridges' decks, under the rain
    scene.add(this.mesh);
  }

  // `cars`: those in view; `height(x, y, car)` the ground (or deck) under a car's wheels.
  update(dt: number, cars: Car[], height: (x: number, y: number, car: Car) => number) {
    this.now += dt;
    this.mesh.material.uniforms.uNow.value = this.now;
    const first = this.next;
    let laid = 0;
    // Snow on the streets: moving cars leave tracks in it.
    const snow = SNOW.value * STREET_SNOW.value;
    for (const c of cars) {
      if (c.mode === 'traffic' || c.spec.two === 'bike') continue;
      const speed = c.speed;
      const back = speed > 1 ? Math.max(c.skidBack, snow > 0.25 ? 0.3 * snow : 0) : 0;
      const front = speed > 1 ? c.skidFront : 0;
      let list = this.wheels.get(c);
      if (!list) {
        if (back <= 0 && front <= 0) continue;
        list = WHEELS.map(wheel);
        this.wheels.set(c, list);
      }
      const n = c.spec.two ? 1 : 4;
      const fx = Math.cos(c.h), fy = Math.sin(c.h);
      const L = c.spec.L / 2 - (c.spec.two ? 0.3 : 0.75), W = c.spec.two ? 0 : c.spec.W / 2 - 0.25;
      const step = c.skidBack > 0.05 || c.skidFront > 0.05 ? STEP : TRACK_STEP;
      for (let i = 0; i < n; i++) {
        const w = list[i];
        const s = i < 2 ? back : front;
        if (s <= 0.02) { w.on = false; continue; }
        const [a, b] = WHEELS[i];
        const x = c.x + fx * a * L - fy * b * W, y = c.y + fy * a * L + fx * b * W;
        const dx = x - w.x, dy = y - w.y, d = Math.hypot(dx, dy);
        // Starting a mark, or somewhere else altogether (put there, or just back in view).
        if (!w.on || d > 4) {
          this.edge(w, x, y, dx, dy, d, fx, fy, height, c);
          w.s = 0;
          w.run = 0;
          w.on = true;
          continue;
        }
        if (d < step) continue;
        const ax = w.ax, ay = w.ay, az = w.az, bx = w.bx, by = w.by, bz = w.bz, s0 = w.s;
        this.edge(w, x, y, dx, dy, d, fx, fy, height, c);
        // (Faint for its first metre, so it doesn't start with a hard edge.)
        w.run += d;
        w.s = s * Math.min(1, 0.2 + w.run);
        this.lay(ax, ay, az, bx, by, bz, w, s0 * 0.6, w.s * 0.6);
        laid++;
      }
    }
    if (!laid) return;
    // Send only what changed (in two pieces if the ring went round).
    this.pos.clearUpdateRanges();
    this.mark.clearUpdateRanges();
    if (laid >= SLOTS) {
      this.pos.addUpdateRange(0, SLOTS * 12);
      this.mark.addUpdateRange(0, SLOTS * 12);
    } else if (first + laid <= SLOTS) {
      this.pos.addUpdateRange(first * 12, laid * 12);
      this.mark.addUpdateRange(first * 12, laid * 12);
    } else {
      const tail = SLOTS - first;
      for (const attr of [this.pos, this.mark]) {
        attr.addUpdateRange(first * 12, tail * 12);
        attr.addUpdateRange(0, (laid - tail) * 12);
      }
    }
    this.pos.needsUpdate = true;
    this.mark.needsUpdate = true;
  }

  // The two edges of a tyre's mark at (x, y), across the way it's going (or across
  // the car, if it hasn't moved yet).
  private edge(w: Wheel, x: number, y: number, dx: number, dy: number, d: number, fx: number, fy: number, height: (x: number, y: number, car: Car) => number, c: Car) {
    const ux = d > 0.05 && d < 4 ? dx / d : fx, uy = d > 0.05 && d < 4 ? dy / d : fy;
    const z = height(x, y, c) + LIFT;
    w.x = x; w.y = y;
    w.ax = x - uy * HALF; w.ay = y + ux * HALF; w.az = z;
    w.bx = x + uy * HALF; w.by = y - ux * HALF; w.bz = z;
  }

  // One piece of mark from the edges (a, b) where the wheel was to where it is now.
  private lay(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: Wheel, dark0: number, dark1: number) {
    const i = this.next, o = i * 12;
    this.next = (i + 1) % SLOTS;
    const p = this.pos.array as Float32Array, m = this.mark.array as Float32Array;
    // (Three.js is y-up: the map's y is -z.)
    p[o] = ax; p[o + 1] = az; p[o + 2] = -ay;
    p[o + 3] = bx; p[o + 4] = bz; p[o + 5] = -by;
    p[o + 6] = w.ax; p[o + 7] = w.az; p[o + 8] = -w.ay;
    p[o + 9] = w.bx; p[o + 10] = w.bz; p[o + 11] = -w.by;
    m[o] = m[o + 3] = m[o + 6] = m[o + 9] = this.now;
    m[o + 1] = m[o + 4] = dark0;
    m[o + 7] = m[o + 10] = dark1;
  }
}
