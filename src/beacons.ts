import * as THREE from 'three';
import type { Car } from './car.ts';
import { sendInstances } from './gpu.ts';

// Flashing blue lights for emergency vehicles: lamps on the roof and a glow on the
// ground, for any cars it's given each frame. Police cars and fire engines use it.

const LAMPS = 64;
const GLOWS = 24;
const BLUE = new THREE.Color('#3d7bff');
const DIM = new THREE.Color('#0d1a3a');

// Where a type carries its lamps: [metres forward of the middle, fraction of half-width sideways, metres above the roof].
type Lamp = [number, number, number];
const BARS: Record<string, { lamps: Lamp[]; glow: number; rate: number }> = {
  // Two lamps above the cabin.
  police: { lamps: [[0, -0.48, 0.18], [0, 0.48, 0.18]], glow: 1, rate: 5 },
  // A bar across the cab roof, and one at the back of the body.
  fire: { lamps: [[2.9, -0.7, 0.2], [2.9, -0.25, 0.2], [2.9, 0.25, 0.2], [2.9, 0.7, 0.2], [-3.8, -0.8, 0.15], [-3.8, 0.8, 0.15]], glow: 1.5, rate: 4 },
};
const OTHER = BARS.police;

export class Beacons {
  private lamps: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private glow: THREE.InstancedMesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private dummy = new THREE.Object3D();
  private col = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.26, 0.14, 0.3), new THREE.MeshBasicMaterial(), LAMPS);
    const glow = new THREE.CircleGeometry(5, 28);
    glow.rotateX(-Math.PI / 2);
    this.glow = new THREE.InstancedMesh(glow, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }), GLOWS);
    for (const m of [this.lamps, this.glow]) {
      m.count = 0;
      m.frustumCulled = false;
      m.setColorAt(0, new THREE.Color());
      scene.add(m);
    }
  }

  // `lit`: the cars with their lights on. `height`: ground height under a car. `dark`: how
  // dark it is (0 by day … 1), when the lamps' light map shows their light on the street
  // (lamps.ts) and the glow here is only a trace.
  draw(lit: Car[], height: (x: number, y: number, who: Car) => number, time: number, dark = 0) {
    const d = this.dummy;
    let n = 0, g = 0;
    for (const c of lit) {
      const S = c.spec, bar = BARS[c.type] ?? OTHER;
      const fx = Math.cos(c.h), fy = Math.sin(c.h);
      const cabin = S.cabin ?? [0, 0], mid = (cabin[0] + cabin[1]) / 2;
      const base = height(c.x, c.y, c);
      const flip = Math.floor(time * bar.rate) % 2;
      bar.lamps.forEach(([ahead, across, up], i) => {
        if (n >= LAMPS) return;
        const f = (c.type === 'police' ? mid : 0) + ahead, off = across * S.W / 2;
        d.position.set(c.x + fx * f - fy * off, base + S.H + up, -(c.y + fy * f + fx * off));
        d.rotation.set(0, c.h, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.lamps.setMatrixAt(n, d.matrix);
        this.lamps.setColorAt(n, (i % 2 === 0) === !!flip ? BLUE : DIM);
        n++;
      });
      if (g < GLOWS) {
        d.position.set(c.x, base + 0.2, -c.y);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(bar.glow);
        d.updateMatrix();
        this.glow.setMatrixAt(g, d.matrix);
        this.glow.setColorAt(g, this.col.set('#2a5cff').multiplyScalar((0.25 + 0.2 * Math.abs(Math.sin(time * 8))) * (1 - 0.8 * dark)));
        g++;
      }
    }
    for (const [m, k] of [[this.lamps, n], [this.glow, g]] as [THREE.InstancedMesh, number][]) {
      m.count = k;
      sendInstances(m);
    }
  }
}
