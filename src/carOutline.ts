import * as THREE from 'three';
import type { Car, CarPool } from './car.ts';
import { CROWN_STENCIL } from './trees.ts';

export class CarOutline {
  private readonly mesh: THREE.Mesh;
  private readonly size = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    // A tapered nose makes the heading readable even when the entire car is hidden.
    const corners = [
      [-0.5, -0.4], [-0.43, -0.5], [0.36, -0.5], [0.5, -0.27],
      [0.5, 0.27], [0.36, 0.5], [-0.43, 0.5], [-0.5, 0.4],
    ];
    const points = (x: number, y: number) => corners.map(([a, b]) => new THREE.Vector2(x * a, y * b));
    const shape = new THREE.Shape(points(1, 1));
    shape.holes.push(new THREE.Path(points(0.91, 0.81)));
    this.mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      color: '#ffe08a', transparent: true, opacity: 0.85, depthWrite: false, depthFunc: THREE.GreaterDepth,
      stencilWrite: true, stencilRef: CROWN_STENCIL, stencilFunc: THREE.EqualStencilFunc, stencilWriteMask: 0,
    }));
    this.mesh.name = 'Player car outline';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(car: Car | null, pool: CarPool) {
    this.mesh.visible = false;
    if (!car || car.two || !pool.matrixOf(car, this.mesh.matrix)) return;
    const { L, W, H } = car.spec;
    this.mesh.matrix.multiply(this.size.makeScale(L, 1, W).setPosition(0, H, 0));
    this.mesh.matrixWorldNeedsUpdate = true;
    this.mesh.visible = true;
  }
}
