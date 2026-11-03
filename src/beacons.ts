import * as THREE from 'three';
import type { Car } from './car.ts';
import { sendInstances } from './gpu.ts';
import { strobe } from './lamps.ts';

// Flashing blue lights for emergency vehicles: lamps on the roof and a glow on the
// ground, for any cars it's given each frame. Police cars, fire engines and ambulances
// use it, and dustcarts their amber ones.

const LAMPS = 64;
const GLOWS = 24;
const BLUE = new THREE.Color('#3d7bff');
const DIM = new THREE.Color('#0d1a3a');
const AMBER = new THREE.Color('#ffa21f');
const DIM_AMBER = new THREE.Color('#3a2408');

// Where a type carries its lamps: [metres forward of the middle, fraction of half-width sideways, metres above the roof].
type Lamp = [number, number, number];
const BARS: Record<string, { lamps: Lamp[]; glow: number; rate: number; amber?: boolean }> = {
  // The blue ends of the bar above the cabin.
  police: { lamps: [[0, -0.6, 0.15], [0, -0.42, 0.15], [0, 0.42, 0.15], [0, 0.6, 0.15]], glow: 1, rate: 1.4 },
  // A bar across the cab roof, and one at the back of the body.
  fire: { lamps: [[3.7, -0.62, 0.2], [3.7, -0.38, 0.2], [3.7, 0.38, 0.2], [3.7, 0.62, 0.2], [-3.8, -0.8, 0.15], [-3.8, 0.8, 0.15]], glow: 1.5, rate: 1.2 },
  // A bar across the cab roof, and two at the back.
  ambulance: { lamps: [[1.7, -0.7, 0.18], [1.7, -0.25, 0.18], [1.7, 0.25, 0.18], [1.7, 0.7, 0.18], [-2.8, -0.8, 0.1], [-2.8, 0.8, 0.1]], glow: 1.2, rate: 1.6 },
  // A dustcart at work: amber, two on the cab (low, in front of the body) and two on the
  // tailgate. No glow on the ground by day: amber lamps don't light the street in daylight.
  garbage: { lamps: [[4.2, -0.44, -0.3], [4.2, 0.44, -0.3], [-4.05, -0.64, 0.08], [-4.05, 0.64, 0.08]], glow: 0, rate: 1, amber: true },
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
  // (lamps.ts) and the glow here isn't needed.
  draw(lit: Car[], height: (x: number, y: number, who: Car) => number, time: number, dark = 0) {
    const d = this.dummy;
    let n = 0, g = 0;
    for (const c of lit) {
      const S = c.spec, bar = BARS[c.type] ?? OTHER;
      const fx = Math.cos(c.h), fy = Math.sin(c.h);
      const cabin = S.cabin ?? [0, 0], mid = (cabin[0] + cabin[1]) / 2;
      const base = height(c.x, c.y, c);
      // (The same flashes as the light they throw on the street: lamps.ts.)
      const [left, right] = strobe(time, bar.rate);
      bar.lamps.forEach(([ahead, across, up], i) => {
        if (n >= LAMPS) return;
        const f = (c.type === 'police' ? mid : 0) + ahead, off = across * S.W / 2;
        d.position.set(c.x + fx * f - fy * off, base + S.H + up, -(c.y + fy * f + fx * off));
        d.rotation.set(0, c.h, 0);
        d.scale.setScalar(1);
        d.updateMatrix();
        this.lamps.setMatrixAt(n, d.matrix);
        this.lamps.setColorAt(n, (across < 0 ? right : left) > 0.5 ? (bar.amber ? AMBER : BLUE) : bar.amber ? DIM_AMBER : DIM);
        n++;
      });
      if (g < GLOWS && dark < 0.99 && bar.glow > 0) {
        d.position.set(c.x, base + 0.2, -c.y);
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(bar.glow);
        d.updateMatrix();
        this.glow.setMatrixAt(g, d.matrix);
        this.glow.setColorAt(g, this.col.set(bar.amber ? '#ff9a1a' : '#2a5cff').multiplyScalar((0.25 + 0.2 * Math.abs(Math.sin(time * 8))) * (1 - dark)));
        g++;
      }
    }
    for (const [m, k] of [[this.lamps, n], [this.glow, g]] as [THREE.InstancedMesh, number][]) {
      m.count = k;
      sendInstances(m);
    }
  }
}
