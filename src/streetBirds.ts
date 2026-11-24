import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { sendInstances } from './gpu.ts';
import { STREET_QUALITY } from './streetQuality.ts';

// The square's nearest pigeons share a handful of rigid parts. No skeleton or
// animation mixer per bird. The regular silhouette fills in while the GLB loads.
const LIMIT = 24;
const parts = ['Perched', 'Head', 'Flying', 'WingLeft', 'WingRight'] as const;
const wings = ['WingLeft', 'WingRight'] as const;
type Part = typeof parts[number];
type Models = Record<Part, THREE.InstancedMesh>;
const up = new THREE.Vector3(0,1,0), across = new THREE.Vector3(0,0,1), forward = new THREE.Vector3(1,0,0);
const root = new THREE.Matrix4(), local = new THREE.Matrix4(), world = new THREE.Matrix4();
const pivot = new THREE.Vector3(), scale = new THREE.Vector3(), unit = new THREE.Vector3(1,1,1);
const turn = new THREE.Quaternion(), bend = new THREE.Quaternion(), tint = new THREE.Color();

export class StreetBirds {
  private models?: Models;
  private loading = false;
  private retryAt = 0;
  private perched = 0;
  private flying = 0;
  private shown = false;

  constructor(private scene: THREE.Scene) {}

  private load() {
    if (this.loading || performance.now() < this.retryAt) return;
    this.loading = true;
    void new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'street-pigeon.glb').then(g => {
      const geometry = parts.map(name => {
        const source = g.scene.getObjectByName(name);
        if (!(source instanceof THREE.Mesh)) throw new Error('Missing pigeon part ' + name);
        return source.geometry as THREE.BufferGeometry;
      });
      const material = new THREE.MeshLambertMaterial({ vertexColors: true });
      const models = {} as Models;
      for (const [i,name] of parts.entries()) {
        const m = models[name] = new THREE.InstancedMesh(geometry[i],material,LIMIT);
        m.name = 'Street pigeon ' + name;
        m.castShadow = m.receiveShadow = true;
        m.frustumCulled = false;
        m.setColorAt(0, tint.set(0xffffff));
        m.count = 0;
        m.visible = false;
        this.scene.add(m);
      }
      this.models = models;
    }).catch(() => { this.retryAt = performance.now() + 60000; })
      .finally(() => { this.loading = false; });
  }

  near(pos: THREE.Vector3, eye: THREE.Vector3) {
    if (this.perched + this.flying >= LIMIT || pos.distanceToSquared(eye) > (.72 * STREET_QUALITY.carReach) ** 2) return false;
    if (this.models) return true;
    this.load();
    return false;
  }

  ground(pos: THREE.Vector3, h: number, size: number, colour: THREE.Color, phase: number, walking: boolean) {
    const m = this.models!, n = this.perched++;
    tint.copy(colour).multiplyScalar(1.45).addScalar(.54);
    root.compose(pos,turn.setFromAxisAngle(up,h),scale.setScalar(size));
    m.Perched.setMatrixAt(n,root);
    m.Perched.setColorAt(n,tint);
    // Peck from the neck down towards the pavement. On the walk the head
    // thrusts forward and holds while the breast catches up.
    const dip = walking ? 0 : Math.max(0,Math.sin(phase*2.4)) ** 4;
    const bob = walking ? Math.sin(phase*14) : 0;
    pivot.set(.037 + .010*bob + .046*dip, .127 + .003*bob - .059*dip, 0);
    local.compose(pivot,bend.setFromAxisAngle(across,-1.09*dip),unit);
    m.Head.setMatrixAt(n,world.multiplyMatrices(root,local));
    m.Head.setColorAt(n,tint);
  }

  air(pos: THREE.Vector3, heading: THREE.Quaternion, size: number, colour: THREE.Color, beatAngle: number) {
    const m = this.models!, n = this.flying++;
    tint.copy(colour).multiplyScalar(1.45).addScalar(.54);
    // Stretch forward in flight. Wing pivots are in the shoulder, one either
    // side of the back. Both follow the bank of the flock.
    turn.copy(heading).multiply(bend.setFromAxisAngle(across,-.40));
    root.compose(pos,turn,scale.setScalar(size));
    m.Flying.setMatrixAt(n,root);
    m.Flying.setColorAt(n,tint);
    for (const wing of wings) {
      const side = wing === 'WingLeft' ? 1 : -1;
      local.compose(pivot.set(.029,.144,-side*.027),bend.setFromAxisAngle(forward,side*beatAngle),unit);
      m[wing].setMatrixAt(n,world.multiplyMatrices(root,local));
      m[wing].setColorAt(n,tint);
    }
  }

  finish() {
    if (!this.shown && !this.perched && !this.flying) return;
    this.shown = this.perched + this.flying > 0;
    if (this.models) for (const name of parts) {
      const m = this.models[name];
      m.count = name === 'Perched' || name === 'Head' ? this.perched : this.flying;
      m.visible = m.count > 0;
      if (m.visible) sendInstances(m);
    }
    this.perched = this.flying = 0;
  }
}
