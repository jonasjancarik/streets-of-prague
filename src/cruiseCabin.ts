import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STREET_QUALITY, streetNear } from './streetQuality.ts';
import { StreetVehicleMesh } from './vehicleFittings.ts';

// The five seated figures share one mesh across the sightseeing boats. Their
// local positions are baked against the wheel and the saloon tables.
const cloth = new THREE.MeshLambertMaterial({ vertexColors: true });
let people: Promise<THREE.BufferGeometry> | undefined;
function cabinPeople() {
  return people ??= new GLTFLoader().loadAsync(import.meta.env.BASE_URL+'cruiser-occupants.glb').then(({scene}) => {
    const cabin = scene.children.find((node): node is THREE.Mesh => node instanceof THREE.Mesh);
    if (!cabin?.geometry.hasAttribute('color')) throw Error('Missing cruise cabin occupants');
    const original = cabin.material;
    for (const material of Array.isArray(original) ? original : [original]) material.dispose();
    return cabin.geometry;
  }).catch(error => { people=undefined; throw error; });
}

export class SightseeingBoat extends StreetVehicleMesh {
  private occupants?: THREE.Mesh;
  private near = false;
  private loading = false;
  private retryAt = 0;

  override nearCamera(distance2: number) {
    super.nearCamera(distance2);
    this.near = streetNear(this.near,distance2,Math.min(32,1.5*STREET_QUALITY.avatarReach));
    if (this.occupants) this.occupants.visible=this.near;
    else if (this.near && !this.loading && performance.now()>=this.retryAt) void this.loadPeople();
  }

  private async loadPeople() {
    this.loading=true;
    try {
      const mesh = new THREE.Mesh(await cabinPeople(),cloth);
      mesh.name='Cruiser occupants';
      mesh.matrixAutoUpdate=false;
      mesh.receiveShadow=true;
      mesh.visible=this.near;
      this.add(mesh);
      this.occupants=mesh;
    } catch { this.retryAt=performance.now()+60000; }
    finally { this.loading=false; }
  }
}
