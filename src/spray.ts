import * as THREE from 'three';
import type { Car } from './car.ts';
import { RAIN, WET } from './shading.ts';

// Spray thrown up behind the wheels of cars driving on a wet road: small puffs of
// droplets that fly back and up and fall away within a second.
//
// One ring of points, one draw call: each new drop takes the oldest slot, with where
// and when it was thrown and how fast; the shader moves it along and fades it, so a
// drop is written once and never touched again.

const DROPS = 4096;
const LIFE = 0.7;   // s a drop lasts
const SIZE = 0.9;   // m across a puff
const RATE = 5;     // drops a wheel throws per metre, on a soaking road

export class Spray {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private from: THREE.BufferAttribute;
  private born: THREE.BufferAttribute;
  private vel: THREE.BufferAttribute;
  private next = 0;
  private now = 0;
  private last = -1e9; // when the last drop was thrown
  private owed = new WeakMap<Car, number>();

  // `tint`: the light on things (WeatherFx.tint).
  constructor(scene: THREE.Scene, tint: { value: THREE.Color }) {
    const g = new THREE.BufferGeometry();
    // Where and when each drop was thrown, and how fast.
    this.from = new THREE.BufferAttribute(new Float32Array(DROPS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.born = new THREE.BufferAttribute(new Float32Array(DROPS).fill(-1e9), 1).setUsage(THREE.DynamicDrawUsage);
    this.vel = new THREE.BufferAttribute(new Float32Array(DROPS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.from);
    g.setAttribute('born', this.born);
    g.setAttribute('vel', this.vel);
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uNow: { value: 0 }, uScale: { value: 800 }, uTint: tint },
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        attribute float born; attribute vec3 vel;
        uniform float uNow; uniform float uScale;
        varying float vA;
        void main() {
          float t = uNow - born, k = t / ${LIFE.toFixed(2)};
          vA = t >= 0. && k < 1. ? (1. - k) * min(1., k * 8.) : 0.;
          vec3 p = position + vel * t + vec3(0., -4.9 * t * t, 0.);
          vec4 mvPosition = viewMatrix * vec4(p, 1.);
          gl_PointSize = vA > 0. ? uScale * ${SIZE.toFixed(2)} * (.6 + k) / -mvPosition.z : 0.;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform vec3 uTint; varying float vA;
        void main() {
          float d = length(gl_PointCoord - .5) * 2.;
          float a = vA * smoothstep(1., .1, d) * .3;
          if (a < .004) discard;
          gl_FragColor = vec4(min(max(uTint * 1.1, vec3(.26, .28, .3)), vec3(.9)), a);
          #include <fog_fragment>
        }`,
      fog: true, transparent: true, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 8; // over the cars, under the mist and the rain
    this.points.visible = false;
    scene.add(this.points);
  }

  // `cars`: those in view; `pixels` how tall the picture is, in pixels.
  update(dt: number, cars: Car[], height: (x: number, y: number, car: Car) => number, pixels: number) {
    this.now += dt;
    const m = this.points.material;
    m.uniforms.uNow.value = this.now;
    m.uniforms.uScale.value = pixels * 1.4;
    // Standing water on the road; more of it while it's still raining.
    const wet = WET.value * (0.5 + 0.5 * RAIN.value);
    this.points.visible = wet > 0.05 || this.now - this.last < LIFE;
    if (wet <= 0.05 || dt <= 0) return;
    const first = this.next;
    let thrown = 0;
    const f = this.from.array as Float32Array, b = this.born.array as Float32Array, v = this.vel.array as Float32Array;
    for (const c of cars) {
      const speed = c.speed;
      if (speed < 4 || c.spec.two === 'bike') continue;
      // Drops owed to this car: more the faster it goes.
      let owe = (this.owed.get(c) ?? 0) + speed * dt * RATE * wet * Math.min(1, speed / 12);
      if (owe < 1) { this.owed.set(c, owe); continue; }
      const fx = Math.cos(c.h), fy = Math.sin(c.h), sgn = c.forwardSpeed >= 0 ? 1 : -1;
      const L = c.spec.L / 2 - 0.6, W = c.spec.two ? 0 : c.spec.W / 2 - 0.25;
      const z = (c.gz ?? height(c.x, c.y, c)) + 0.25;
      while (owe >= 1 && thrown < DROPS) {
        owe--;
        const side = Math.random() < 0.5 ? 1 : -1;
        const x = c.x - fx * L * sgn - fy * side * W, y = c.y - fy * L * sgn + fx * side * W;
        const i = this.next, p = i * 3;
        this.next = (i + 1) % DROPS;
        // (Three.js is y-up: the map's y is -z.)
        f[p] = x; f[p + 1] = z; f[p + 2] = -y;
        b[i] = this.now - Math.random() * dt;
        // Back from the wheel, out to the side and up, trailing the car.
        const out = side * (0.5 + Math.random() * 1.5), back = 0.35 + Math.random() * 0.25;
        v[p] = c.vx * back - fy * out; v[p + 1] = 1 + Math.random() * 2; v[p + 2] = -(c.vy * back + fx * out);
        thrown++;
      }
      this.owed.set(c, Math.min(owe, 1));
    }
    if (!thrown) return;
    this.last = this.now;
    send(this.from, first, thrown);
    send(this.born, first, thrown);
    send(this.vel, first, thrown);
  }
}

// Send only the drops thrown this frame (in two pieces if the ring went round).
function send(attr: THREE.BufferAttribute, first: number, thrown: number) {
  const n = attr.itemSize;
  attr.clearUpdateRanges();
  if (thrown >= DROPS) attr.addUpdateRange(0, DROPS * n);
  else if (first + thrown <= DROPS) attr.addUpdateRange(first * n, thrown * n);
  else {
    attr.addUpdateRange(first * n, (DROPS - first) * n);
    attr.addUpdateRange(0, (first + thrown - DROPS) * n);
  }
  attr.needsUpdate = true;
}
