import * as THREE from 'three';
import type { Car, CarPool } from './car.ts';

// Your car's indicators, amber as in Europe, flashing on their own before a turn the
// directions give (Satnav.signal). The car's own lamps live in its shader; these are
// glows of their own over its corners, a little above the roof so that from above the
// body doesn't hide them.

const RATE = 1.5; // flashes a second (the rules allow 1 to 2)
const GLOW = 1.6; // m across

function glow() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.25, 'rgba(255,176,0,0.95)');
  g.addColorStop(0.6, 'rgba(255,140,0,0.35)');
  g.addColorStop(1, 'rgba(255,140,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Blinkers {
  private group = new THREE.Group();
  private lamps: THREE.Mesh[] = []; // front left, back left, front right, back right
  private clock = 0;
  private m = new THREE.Matrix4();
  private size = '';

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshBasicMaterial({ map: glow(), transparent: true, depthWrite: false, fog: false, toneMapped: false });
    const plane = new THREE.PlaneGeometry(GLOW, GLOW).rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const lamp = new THREE.Mesh(plane, mat);
      lamp.renderOrder = 2;
      this.lamps.push(lamp);
      this.group.add(lamp);
    }
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    scene.add(this.group);
  }

  // Once a frame, after the cars are drawn: `side`, which way you're about to turn.
  update(dt: number, car: Car | null, side: 'left' | 'right' | null, pool: CarPool) {
    if (!side || !car || car.spec.two === 'bike' || car.burnt || !pool.matrixOf(car, this.m)) {
      this.group.visible = false;
      this.clock = 0;
      return;
    }
    const { L, W, H } = car.spec, size = `${L}|${W}|${H}`;
    if (size !== this.size) {
      this.size = size;
      // Car space: forward is +x, left is -z.
      this.lamps.forEach((lamp, i) => lamp.position.set((i % 2 ? -1 : 1) * (L / 2 - 0.1), H + 0.05, (i < 2 ? -1 : 1) * (W / 2 - 0.1)));
    }
    this.clock += dt;
    this.group.visible = true;
    this.group.matrix.copy(this.m);
    this.group.matrixWorldNeedsUpdate = true;
    const lit = (this.clock * RATE) % 1 < 0.5; // on at once, then half of each beat
    this.lamps.forEach((lamp, i) => { lamp.visible = lit && (i < 2) === (side === 'left'); });
  }
}
