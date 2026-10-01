import * as THREE from 'three';
import { sendInstances } from './gpu.ts';

// What the lights do besides lighting the ground, on the Ultra graphics tier: a faint
// cone in the air in front of every headlight and round the emergency lights, stronger
// in rain and mist, and the glint of each street lamp where the camera would see it
// mirrored: on the roof of a car that is at that spot, and on wet ground.
// Lamps (lamps.ts) fills these in as it goes through the lights each frame.
// Drawn by the WebGPU renderer only (webgpu/glows.ts makes the materials).

// How strong the beams are (how dark it is × how hazy the air).
export const BEAM_ON = { value: 0 };

let beamBy: (() => THREE.Material) | null = null;
export const setBeamShade = (f: typeof beamBy) => { beamBy = f; };
let glintBy: (() => THREE.Material) | null = null;
export const setGlintShade = (f: typeof glintBy) => { glintBy = f; };

const MAX_BEAMS = 320;
const MAX_GLINTS = 1200;
const CAR_CELL = 12; // (the grid of boxes in lamps.ts)

interface Roof { x: number; y: number; h: number; spec: { L: number; W: number; H: number } }

export class LightFx {
  private beams: THREE.InstancedMesh | null = null;
  private glints: THREE.InstancedMesh | null = null;
  private dummy = new THREE.Object3D();
  private c = new THREE.Color();
  private eye: THREE.Vector3 | null = null;
  private gloss = 0;
  private nb = 0;
  private ng = 0;

  constructor(scene: THREE.Scene) {
    this.dummy.rotation.order = 'YZX';
    if (!beamBy || !glintBy) return;
    // A cone along x, from a tenth of its width at the light to its full width at the far end.
    const cone = new THREE.CylinderGeometry(1, 0.1, 1, 20, 1, true).rotateZ(-Math.PI / 2).translate(0.5, 0, 0);
    this.beams = new THREE.InstancedMesh(cone, beamBy(), MAX_BEAMS);
    this.glints = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), glintBy(), MAX_GLINTS);
    for (const m of [this.beams, this.glints]) {
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.instanceMatrix.count * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      m.renderOrder = 6;
      scene.add(m);
    }
  }

  // A new frame. `eye`: the camera (null: nothing is drawn); `on`: how dark it is;
  // `wet`, `murk`: how wet the ground and how hazy the air (0..1).
  begin(eye: THREE.Vector3 | null, on: number, wet: number, murk: number) {
    this.eye = this.beams ? eye : null;
    this.nb = this.ng = 0;
    BEAM_ON.value = on * (0.1 + 0.9 * Math.min(1, murk * 1.6));
    // Dry asphalt and stone mirror a lamp only faintly.
    this.gloss = on * (0.1 + 0.9 * wet);
    if (!this.eye) this.commit();
  }

  // A cone of light in the air from (x, y, z), `len` long and `wide` across at its end.
  beam(x: number, y: number, z: number, dx: number, dy: number, len: number, wide: number, colour: THREE.Color, strength: number, dip = 0.04) {
    if (!this.eye || !this.beams || this.nb >= MAX_BEAMS) return;
    const d = this.dummy;
    d.position.set(x, z, -y);
    d.rotation.set(0, Math.atan2(dy, dx), -dip);
    d.scale.set(len, wide, wide);
    d.updateMatrix();
    this.beams.setMatrixAt(this.nb, d.matrix);
    this.beams.setColorAt(this.nb++, this.c.copy(colour).multiplyScalar(strength));
  }

  private glint(x: number, y: number, z: number, ang: number, long: number, wide: number, colour: THREE.Color, strength: number) {
    if (!this.glints || this.ng >= MAX_GLINTS) return;
    const d = this.dummy;
    d.position.set(x, z, -y);
    d.rotation.set(0, ang, 0);
    d.scale.set(long, 1, wide);
    d.updateMatrix();
    this.glints.setMatrixAt(this.ng, d.matrix);
    this.glints.setColorAt(this.ng++, this.c.copy(colour).multiplyScalar(strength));
  }

  // A street lamp at (x, y), its head `head` m over the ground at z. `grid`, `at`: the
  // boxes near the lights (lamps.ts), of which the first are `cars`, standing at `carZ`.
  lamp(x: number, y: number, z: number, head: number, colour: THREE.Color, strength: number, grid: Map<number, number[]>, at: Float32Array, cars: Roof[], carZ: number[]) {
    const eye = this.eye;
    if (!eye) return;
    const ex = eye.x - x, ey = -eye.z - y, far = Math.hypot(ex, ey), ang = Math.atan2(ey, ex);
    // Where a mirror lying `up` m over the lamp's ground shows the lamp to the camera:
    // on the line from the lamp's foot to the camera's, in the proportion of their heights over it.
    const share = (up: number) => { const h = head - up, H = eye.y - z - up; return H > 1 && h > 0 ? h / (H + h) : -1; };
    const s = share(0);
    if (s < 0) return;
    if (this.gloss > 0.02) this.glint(x + ex * s, y + ey * s, z + 0.06, ang, 0.6 + 0.35 * far * s, 0.45, colour, this.gloss * strength * 0.7);
    // On the roofs of the cars round that spot.
    const px = x + ex * s, py = y + ey * s;
    for (let cx = Math.floor((px - 4) / CAR_CELL); cx <= Math.floor((px + 4) / CAR_CELL); cx++) {
      for (let cy = Math.floor((py - 4) / CAR_CELL); cy <= Math.floor((py + 4) / CAR_CELL); cy++) {
        const list = grid.get(cx * 4096 + cy);
        if (!list) continue;
        for (const i of list) {
          if (i >= cars.length || Math.hypot(at[i * 3] - px, at[i * 3 + 1] - py) > 5) continue;
          const c = cars[i], S = c.spec, top = carZ[i] + S.H - z;
          if (Math.abs(carZ[i] - z) > 3) continue;
          const k = share(top);
          if (k < 0) continue;
          const qx = x + ex * k - c.x, qy = y + ey * k - c.y, co = Math.cos(c.h), si = Math.sin(c.h);
          // (How far inside the car's outline: the glint fades towards its edges.)
          const inL = S.L / 2 - 0.25 - Math.abs(qx * co + qy * si), inW = S.W / 2 - 0.2 - Math.abs(-qx * si + qy * co);
          const edge = Math.min(1, Math.min(inL, inW) / 0.3);
          if (edge <= 0) continue;
          this.glint(c.x + qx, c.y + qy, z + top + 0.05, ang, 0.5, 0.32, colour, strength * edge * 1.1);
        }
      }
    }
  }

  commit() {
    for (const [m, n] of [[this.beams, this.nb], [this.glints, this.ng]] as [THREE.InstancedMesh | null, number][]) {
      if (!m) continue;
      m.count = n;
      sendInstances(m);
    }
  }
}
