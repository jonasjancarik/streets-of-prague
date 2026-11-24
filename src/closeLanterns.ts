import * as THREE from 'three';
import { sendInstances } from './gpu.ts';

// A small separate batch for each nearby type of gas post. Metal and mantles
// share one draw, with a second for the clear panes. The overhead pole pages
// keep their original geometry, material and instance budget.
const LIMIT = 20;
export class CloseLanterns {
  street = false;
  private count = 0;
  private batches = new Map<number, THREE.InstancedMesh>();
  private body?: THREE.MeshStandardMaterial;
  private panes?: THREE.MeshPhongMaterial;

  begin() {
    this.count = 0;
    for (const mesh of this.batches.values()) mesh.count = 0;
  }

  add(kind: number, build: (() => THREE.BufferGeometry) | undefined, matrix: THREE.Matrix4, original: THREE.InstancedMesh, distance2: number) {
    if (!this.street || !build || !original.parent || distance2 > 40**2 || this.count >= LIMIT) return false;
    let mesh = this.batches.get(kind);
    if (!mesh) {
      if (!this.body) {
        // The UV on the burner socks reads the light texel. Iron, brass and
        // the post read black, so switching on at dusk only lights the mantles.
        const mask = new THREE.DataTexture(new Uint8Array([0,0,0,255,255,255,255,255]),2,1);
        mask.minFilter = mask.magFilter = THREE.NearestFilter; mask.needsUpdate = true;
        this.body = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:.52, metalness:.18,
          emissive:0xffd79b, emissiveMap:mask, emissiveIntensity:0 });
        this.panes = new THREE.MeshPhongMaterial({ vertexColors:true, transparent:true, opacity:.18, depthWrite:false,
          shininess:72, specular:0xadb9b6, side:THREE.FrontSide });
      }
      mesh = new THREE.InstancedMesh(build(),[this.body,this.panes!],LIMIT);
      mesh.name = 'Close gas lantern '+kind;
      mesh.frustumCulled = false; mesh.count = 0;
      mesh.layers.mask = original.layers.mask;
      this.batches.set(kind,mesh); original.parent.add(mesh);
    }
    mesh.setMatrixAt(mesh.count++,matrix);
    this.count++;
    return true;
  }

  lit(amount: number) { if (this.body) this.body.emissiveIntensity = amount*2.8; }

  finish() {
    for (const mesh of this.batches.values()) {
      mesh.visible = mesh.count > 0;
      if (mesh.visible) sendInstances(mesh);
    }
  }
}
