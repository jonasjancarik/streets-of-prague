import * as THREE from 'three';
import type { Car, CarPool } from './car.ts';
import { sendInstances } from './gpu.ts';
import { strobe, type Flashing } from './lamps.ts';

// The LED face clips towards white at the peak of a pulse. A small coloured
// fringe keeps the flash readable against sunlit plaster as well as at night.
const LAMPS = 64;
const BLUE_CORE = new THREE.Color(1.10, 2.8, 8), RED_CORE = new THREE.Color(8, 1.30, .78);
const BLUE = new THREE.Color('#2176ff'), RED = new THREE.Color('#ff2331');
const AMBER = new THREE.Color('#ffa21f'), DIM_AMBER = new THREE.Color('#3a2408');

// Along the body in metres, left as a fraction of half-width, height above roof.
type Lamp = [number, number, number];
const BARS: Record<string, Lamp[]> = {
  police: [[-.25, -.64, .163], [-.25, -.42, .163], [-.25, .42, .163], [-.25, .64, .163]],
  fire: [[3.7, -.62, .158], [3.7, -.38, .158], [3.7, .38, .158], [3.7, .62, .158], [-3.8, -.8, .16], [-3.8, .8, .16]],
  ambulance: [[1.275, -.68, .033], [1.275, -.40, .033], [1.275, .40, .033], [1.275, .68, .033],
    [-2.80, -.80, .058], [-2.80, .80, .058], [3.035, -.29, -1.74], [3.035, .29, -1.74]],
  garbage: [[2.99, -.6, -.24], [2.99, .6, -.24], [-3.98, -.64, .04], [-3.98, .64, .04]],
};

function coronaTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const falloff = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [r, alpha] of [[0, .98], [.15, .87], [.30, .49], [.54, .18], [.78, .045], [1, 0]]) {
    falloff.addColorStop(r, `rgba(255,255,255,${alpha})`);
  }
  ctx.fillStyle = falloff;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

// What a police car, fire engine or ambulance you're driving has on (Car.beacon): its
// lights, its lights and siren, or nothing (null, as for any other car).
export function ownBeacon(car: Car | null | undefined): 'lights' | 'siren' | null {
  if (!car || car.mode !== 'player' || car.burnt || !(car.type === 'police' || car.type === 'fire' || car.type === 'ambulance')) return null;
  const b = car.beacon ?? 'lights';
  return b === 'off' ? null : b;
}

export class Beacons {
  private lamps: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  private halos: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private dummy = new THREE.Object3D();
  private body = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    this.lamps = new THREE.InstancedMesh(new THREE.BoxGeometry(.26, .14, .30),
      new THREE.MeshBasicMaterial({ toneMapped: false }), LAMPS);
    this.halos = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: coronaTexture(), transparent: true, depthWrite: false, toneMapped: false }), LAMPS);
    this.lamps.name = 'Beacon LEDs';
    this.halos.name = 'Beacon halos';
    this.halos.renderOrder = 5;
    for (const mesh of [this.lamps, this.halos]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.setColorAt(0, BLUE);
      scene.add(mesh);
    }
  }

  draw(lit: Flashing<Car>[], pool: CarPool, camera: THREE.Camera, time: number) {
    const d = this.dummy;
    let n = 0, halos = 0;
    for (const { car, rate, amber, redLeft } of lit) {
      if (!pool.matrixOf(car, this.body)) continue;
      const [left, right] = strobe(time, rate);
      for (const [ahead, across, up] of BARS[car.type]) {
        if (n >= LAMPS) break;
        const on = across > 0 ? left : right;
        if (!amber && !on) continue;
        const grille = up < -1, red = redLeft && (grille ? across < 0 : across > 0);
        d.position.set(ahead, car.spec.H + up, -across * car.spec.W / 2);
        d.quaternion.identity();
        if (amber) d.scale.setScalar(.55);
        else if (grille) d.scale.set(.09, .29, .45);
        else d.scale.set(car.type === 'police' ? 1.25 : 1.34, car.type === 'fire' ? .58 : .41, .69);
        d.updateMatrix();
        d.matrix.premultiply(this.body);
        this.lamps.setMatrixAt(n, d.matrix);
        this.lamps.setColorAt(n++, amber ? (on ? AMBER : DIM_AMBER) : red ? RED_CORE : BLUE_CORE);
        if (amber) continue;

        // Centre the halo inside the lamp. The opaque LED and body depth
        // then mask its middle and occlude it on the far side of the vehicle.
        d.position.setFromMatrixPosition(d.matrix);
        d.quaternion.copy(camera.quaternion);
        const size = grille ? .58 : 1.05;
        d.scale.set(size, size, 1);
        d.updateMatrix();
        this.halos.setMatrixAt(halos, d.matrix);
        this.halos.setColorAt(halos++, red ? RED : BLUE);
      }
    }
    this.lamps.count = n;
    this.halos.count = halos;
    this.lamps.visible = n > 0;
    this.halos.visible = halos > 0;
    sendInstances(this.lamps);
    sendInstances(this.halos);
  }
}
