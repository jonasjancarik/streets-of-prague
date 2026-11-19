import * as THREE from 'three';
import type { Car } from './car.ts';
import { sendInstances } from './gpu.ts';
import { strobe } from './lamps.ts';

// Flashing blue lights for emergency vehicles: the lamps on the roof, for any cars it's
// given each frame. Police cars, fire engines and ambulances use it, and dustcarts their
// amber ones. The light they throw on the street is in the lamps' light map (lamps.ts);
// by day a flat glow on the ground only read as a marker ring, so there is none.

const LAMPS = 64;
const BLUE = new THREE.Color('#3d7bff');
const DIM = new THREE.Color('#0d1a3a');
const AMBER = new THREE.Color('#ffa21f');
const DIM_AMBER = new THREE.Color('#3a2408');

// Where a type carries its lamps: [metres forward of the middle, fraction of half-width sideways, metres above the roof].
type Lamp = [number, number, number];
const BARS: Record<string, { lamps: Lamp[]; rate: number; amber?: boolean }> = {
  // The blue ends of the bar above the cabin.
  police: { lamps: [[0, -0.6, 0.15], [0, -0.42, 0.15], [0, 0.42, 0.15], [0, 0.6, 0.15]], rate: 1.4 },
  // A bar across the cab roof, and one at the back of the body.
  fire: { lamps: [[3.7, -0.62, 0.2], [3.7, -0.38, 0.2], [3.7, 0.38, 0.2], [3.7, 0.62, 0.2], [-3.8, -0.8, 0.15], [-3.8, 0.8, 0.15]], rate: 1.2 },
  // A bar across the cab roof, and two at the back.
  ambulance: { lamps: [[1.7, -0.7, 0.18], [1.7, -0.25, 0.18], [1.7, 0.25, 0.18], [1.7, 0.7, 0.18], [-2.8, -0.8, 0.1], [-2.8, 0.8, 0.1]], rate: 1.6 },
  // A dustcart at work: amber, two on the cab (low, in front of the body) and two on the
  // tailgate.
  garbage: { lamps: [[2.99, -0.6, -0.24], [2.99, 0.6, -0.24], [-3.98, -0.64, 0.04], [-3.98, 0.64, 0.04]], rate: 1, amber: true },
};
const OTHER = BARS.police;

// What a police car, fire engine or ambulance you're driving has on (Car.beacon): its
// lights, its lights and siren, or nothing (null, as for any other car).
export function ownBeacon(car: Car | null | undefined): 'lights' | 'siren' | null {
  if (!car || car.mode !== 'player' || car.burnt || !(car.type === 'police' || car.type === 'fire' || car.type === 'ambulance')) return null;
  const b = car.beacon ?? 'lights';
  return b === 'off' ? null : b;
}

export class Beacons {
  private lamps: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene) {
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.26, 0.14, 0.3), new THREE.MeshBasicMaterial(), LAMPS);
    const m = this.lamps;
    m.count = 0;
    m.frustumCulled = false;
    m.setColorAt(0, new THREE.Color());
    scene.add(m);
  }

  // `lit`: the cars with their lights on. `height`: ground height under a car.
  draw(lit: Car[], height: (x: number, y: number, who: Car) => number, time: number) {
    const d = this.dummy;
    let n = 0;
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
        d.scale.setScalar(bar.amber ? 0.55 : 1);
        d.updateMatrix();
        this.lamps.setMatrixAt(n, d.matrix);
        this.lamps.setColorAt(n, (across < 0 ? right : left) > 0.5 ? (bar.amber ? AMBER : BLUE) : bar.amber ? DIM_AMBER : DIM);
        n++;
      });
    }
    this.lamps.count = n;
    sendInstances(this.lamps);
  }
}
