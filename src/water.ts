import * as THREE from 'three';
import { sprayDrawing } from './spray.ts';
import type { Point3 } from './guns.ts';

// The water of a fire hose: a ring of drops that fly from the nozzle to where it aims along
// an arc. Like the spray behind wheels, each drop is written once and the shader moves it.

const DROPS = 1536;
const FLIGHT = 0.4;  // s from the nozzle to the target
const SIZE = 0.22;   // m across a drop
const RATE = 140;    // drops a second from one nozzle

export class Water {
  readonly points: THREE.Object3D;
  private uNow = { value: 0 };
  private uScale = { value: 800 };
  private from: THREE.BufferAttribute;
  private born: THREE.BufferAttribute;
  private vel: THREE.BufferAttribute;
  private next = 0;
  private now = 0;
  private last = -1e9;

  constructor(scene: THREE.Scene, tint: { value: THREE.Color }) {
    const by = sprayDrawing();
    const attribute = (array: Float32Array, size: number): THREE.BufferAttribute =>
      by ? new THREE.InstancedBufferAttribute(array, size) : new THREE.BufferAttribute(array, size);
    this.from = attribute(new Float32Array(DROPS * 3), 3);
    this.born = attribute(new Float32Array(DROPS).fill(-1e9), 1);
    this.vel = attribute(new Float32Array(DROPS * 3), 3);
    if (by) {
      this.points = by({ from: this.from, born: this.born, vel: this.vel, tint, scene, life: FLIGHT, size: SIZE, uNow: this.uNow, uScale: this.uScale });
    } else {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', this.from);
      g.setAttribute('born', this.born);
      g.setAttribute('vel', this.vel);
      this.points = new THREE.Points(g, new THREE.ShaderMaterial({
        uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uNow: this.uNow, uScale: this.uScale, uTint: tint },
        vertexShader: /* glsl */ `
          #include <fog_pars_vertex>
          attribute float born; attribute vec3 vel;
          uniform float uNow; uniform float uScale;
          varying float vA;
          void main() {
            float t = uNow - born, k = t / ${FLIGHT.toFixed(2)};
            vA = t >= 0. && k < 1. ? 1. : 0.;
            vec3 p = position + vel * t + vec3(0., -4.9 * t * t, 0.);
            vec4 mvPosition = viewMatrix * vec4(p, 1.);
            gl_PointSize = vA > 0. ? uScale * ${SIZE.toFixed(2)} / -mvPosition.z : 0.;
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: /* glsl */ `
          #include <fog_pars_fragment>
          uniform vec3 uTint; varying float vA;
          void main() {
            float d = length(gl_PointCoord - .5) * 2.;
            float a = vA * smoothstep(1., .3, d) * .55;
            if (a < .02) discard;
            gl_FragColor = vec4(min(max(uTint * 1.2, vec3(.4, .45, .5)), vec3(.95)), a);
            #include <fog_fragment>
          }`,
        fog: true, transparent: true, depthWrite: false,
      }));
    }
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    this.points.visible = false;
    scene.add(this.points);
  }

  // `jets`: the hoses spraying this frame, as map points (x, y, z up); `pixels`: height of the picture.
  update(dt: number, jets: { from: Point3; to: Point3 }[], pixels: number) {
    this.now += dt;
    this.uNow.value = this.now;
    this.uScale.value = pixels * 1.4;
    this.points.visible = jets.length > 0 || this.now - this.last < FLIGHT;
    if (!jets.length || dt <= 0) return;
    const first = this.next;
    let thrown = 0;
    const f = this.from.array as Float32Array, b = this.born.array as Float32Array, v = this.vel.array as Float32Array;
    const each = Math.max(1, Math.round(RATE * dt));
    for (const j of jets) {
      for (let n = 0; n < each && thrown < DROPS; n++) {
        const i = this.next, p = i * 3;
        this.next = (i + 1) % DROPS;
        const dx = Math.random() - 0.5, dy = Math.random() - 0.5, dz = Math.random() - 0.5;
        // (Three.js is y-up: the map's y is -z.)
        f[p] = j.from[0]; f[p + 1] = j.from[2]; f[p + 2] = -j.from[1];
        b[i] = this.now - Math.random() * dt;
        v[p] = (j.to[0] - j.from[0]) / FLIGHT + dx;
        v[p + 1] = (j.to[2] - j.from[2]) / FLIGHT + 4.9 * FLIGHT + dz;
        v[p + 2] = -((j.to[1] - j.from[1]) / FLIGHT + dy);
        thrown++;
      }
    }
    if (!thrown) return;
    this.last = this.now;
    send(this.from, first, thrown);
    send(this.born, first, thrown);
    send(this.vel, first, thrown);
  }
}

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
