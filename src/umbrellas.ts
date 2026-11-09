import * as THREE from 'three';
import { lampLit } from './lamps.ts';
import { sendInstances } from './gpu.ts';
import { SCALE, FIGURE_SIZE } from './figures.ts';

// Umbrellas over the people walking in the rain. From above an open umbrella hides
// whoever carries it, so it needs no pose of theirs: each is one more instance (a
// canopy of eight panels on a stick) put over a walker, all of them one draw, and
// nothing at all is drawn in dry weather.

export const UMBRELLAS = {
  share: 0.6, // of the people have one with them
  from: 0.2, to: 0.55, // how hard it rains when the first and the last of them go up
  snow: 0.45, // how much snow counts for, against rain
};
// Many of them dark, as in any street, and enough that stand out to read from above.
const COLOURS = ['#1b1c20', '#1b1c20', '#1b1c20', '#222b40', '#222b40', '#34363b', '#4a2a2e', '#24463f', '#8a2227', '#b9282d', '#2c4f8c', '#dcb520', '#e8e5dc', '#62967a', '#cc5f8f', '#56437a', '#b0652a', '#3f7fa8'];

// Which umbrella someone has is theirs for good: numbers 0 to 1 from their serial number.
const fract = (v: number) => v - Math.floor(v);
export const chance = (serial: number, salt: number) => fract(Math.sin(serial * 12.9898 + salt * 78.233) * 43758.5453);

function shape() {
  const pos: number[] = [], col: number[] = [];
  const tri = (a: number[], b: number[], c: number[], shade: number) => {
    pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) col.push(shade, shade, shade);
  };
  // Held a little in front, the canopy's top just over two metres of the kit's person.
  const X = 0.1, TOP = 2.04, RIM = 1.86, R = 0.54, N = 8;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, b = ((i + 1) / N) * Math.PI * 2;
    tri([X, TOP, 0], [X + Math.cos(b) * R, RIM, -Math.sin(b) * R], [X + Math.cos(a) * R, RIM, -Math.sin(a) * R], i % 2 ? 0.74 : 1);
  }
  // The stick, down to the hand.
  const S = 0.014;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4, b = a + Math.PI / 2;
    const p = (t: number, y: number) => [X + Math.cos(t) * S, y, -Math.sin(t) * S];
    tri(p(a, 1.15), p(a, TOP), p(b, TOP), 0.3);
    tri(p(a, 1.15), p(b, TOP), p(b, 1.15), 0.3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

const _q = new THREE.Quaternion(), _tilt = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0), ACROSS = new THREE.Vector3(0, 0, 1);
const PALETTE = COLOURS.map((c) => new THREE.Color(c));

export class Umbrellas {
  mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  // How wet it is for the people: 0 dry, 1 pouring (set every frame from the weather).
  wet = 0;
  private n = 0;

  constructor(scene: THREE.Scene, capacity: number) {
    // (Lit by the street lamps like the lamp posts, with the same shader as theirs.)
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    material.onBeforeCompile = (sh) => lampLit(sh);
    material.customProgramCacheKey = () => 'lamp-pole';
    this.mesh = new THREE.InstancedMesh(shape(), material, capacity);
    this.mesh.setColorAt(0, _c.set('#ffffff'));
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // Whether the person with this serial number has theirs up now.
  up(serial: number) {
    return chance(serial, 1) < UMBRELLAS.share && this.wet > UMBRELLAS.from + (UMBRELLAS.to - UMBRELLAS.from) * chance(serial, 2);
  }

  begin() { this.n = 0; }

  // Over someone standing at `at`, facing `h`.
  put(serial: number, at: THREE.Vector3, h: number) {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    const size = Math.min(SCALE, FIGURE_SIZE.value) * (0.92 + 0.16 * chance(serial, 3));
    // Leant into the rain a little, each their own way.
    _q.setFromAxisAngle(UP, h + (chance(serial, 4) - 0.5) * 0.8).multiply(_tilt.setFromAxisAngle(ACROSS, -0.06 - 0.14 * chance(serial, 5)));
    this.mesh.setMatrixAt(this.n, _m.compose(at, _q, _s.setScalar(size)));
    this.mesh.setColorAt(this.n, PALETTE[Math.floor(chance(serial, 6) * PALETTE.length)]);
    this.n++;
  }

  commit() {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    sendInstances(this.mesh);
  }
}
