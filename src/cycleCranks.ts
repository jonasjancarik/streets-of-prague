import * as THREE from 'three';
import { sendInstances } from './gpu.ts';
import { mirrored } from './mirror.ts';

// The contact points in assets/figures/build.py, expressed in the bicycle's
// metre frame (+X forward, Y up). The same phase drives the fitted rider.
const PAGE = 128;
const metal = new THREE.Color('#88979a'), rubber = new THREE.Color('#343735');
export class CycleCranks {
  private pages: THREE.InstancedMesh[] = [];
  private used = 0;
  private geometry = new THREE.BoxGeometry(1,1,1);
  private material = new THREE.MeshLambertMaterial();
  private local = new THREE.Matrix4();
  private world = new THREE.Matrix4();
  private size = new THREE.Vector3();
  constructor(private scene: THREE.Scene) {}

  begin() { this.used = 0; }

  add(frame: THREE.Matrix4, phase: number, scale: number) {
    const page = Math.floor(this.used / PAGE);
    let mesh = this.pages[page];
    if (!mesh) {
      mesh = mirrored(new THREE.InstancedMesh(this.geometry, this.material, PAGE));
      mesh.name = 'Bicycle cranks and pedals'; mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = true; mesh.userData.sharedMatrices = true;
      for (let i=0;i<PAGE;i++) mesh.setColorAt(i,i%2 ? rubber : metal);
      this.pages.push(mesh); this.scene.add(mesh);
    }
    const angle = Math.PI/2 - 2*Math.PI*phase, x = .17*Math.cos(angle), y = .17*Math.sin(angle);
    for (let side=1; side>=-1; side-=2) {
      this.local.makeRotationZ(angle).scale(this.size.set(.17*scale,.021*scale,.019*scale));
      this.local.setPosition((-.03+side*x*.5)*scale,(.30+side*y*.5)*scale,-side*.075*scale);
      mesh.setMatrixAt(this.used++ % PAGE,this.world.multiplyMatrices(frame,this.local));
      this.local.makeScale(.084*scale,.020*scale,.075*scale);
      this.local.setPosition((-.03+side*x)*scale,(.30+side*y)*scale,-side*.11*scale);
      mesh.setMatrixAt(this.used++ % PAGE,this.world.multiplyMatrices(frame,this.local));
    }
  }

  end() {
    for (let i=0;i<this.pages.length;i++) {
      const mesh = this.pages[i];
      mesh.count = Math.max(0,Math.min(PAGE,this.used-i*PAGE));
      mesh.visible = mesh.count>0;
      if (mesh.visible) sendInstances(mesh);
    }
  }
}
