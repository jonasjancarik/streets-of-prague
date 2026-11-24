import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Bounds } from './map/geo.ts';

// In the Blender source +X is geographic east, +Y north and the heights are
// metres above 180 m Bpv. The map's projected axes vary a little by area.
export const ARCH_ORIGIN: [number, number] = [14.410235, 50.08661];
export interface ArchFrame { x: number; y: number; turn: number }

export class BridgeArches {
  private model?: THREE.Group;
  private loading = false;
  private retryAt = 0;
  private wanted = false;

  constructor(private scene: THREE.Scene, private bounds: Bounds, private frame: ArchFrame, private datum: number) {}

  view(street: boolean, x: number, z: number) {
    if (!street && !this.wanted) return;
    const [west,south,east,north] = this.bounds;
    const dx = Math.max(0, west-x, x-east), dy = Math.max(0, south+z, -z-north);
    this.wanted = street && dx*dx + dy*dy < 400*400;
    if (this.model) { this.model.visible = this.wanted; return; }
    if (this.wanted && !this.loading && performance.now() >= this.retryAt) void this.load();
  }

  private async load() {
    this.loading = true;
    try {
      const { scene: model } = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'charles-arches.glb');
      model.name = 'Charles Bridge stone vaults';
      model.position.set(this.frame.x, 180-this.datum, -this.frame.y);
      model.rotation.y = this.frame.turn;
      model.updateMatrix(); model.matrixAutoUpdate = false;
      for (const o of model.children) {
        if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
      }
      model.visible = this.wanted;
      this.scene.add(model);
      this.model = model;
    } catch { this.retryAt = performance.now() + 60000; }
    finally { this.loading = false; }
  }
}
