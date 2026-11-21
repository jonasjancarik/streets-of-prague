// Close street materials share the map's existing colours. The packed scan supplies
// variations in reflectance and the two horizontal components of the surface normal.
import * as THREE from 'three';

const neutral = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
neutral.magFilter = THREE.LinearFilter;
neutral.minFilter = THREE.LinearMipmapLinearFilter;
neutral.wrapS = neutral.wrapT = THREE.RepeatWrapping;
neutral.generateMipmaps = true;
neutral.needsUpdate = true;

class StreetScan {
  active = { value: 0 };
  // Each node needs its own texture identity while the real maps load. Sharing
  // the same placeholder aliases two samples in a precompiled WebGPU material.
  map: THREE.Texture = neutral.clone();
  private ready = false;
  onLoad?: (map: THREE.Texture) => void;
  private loading = false;
  private retryAt = 0;

  constructor(private file: string) {}

  view(street: boolean) {
    this.active.value = street && this.ready ? 1 : 0;
    if (!street || this.ready || this.loading || performance.now() < this.retryAt) return;
    this.loading = true;
    new THREE.TextureLoader().load(import.meta.env.BASE_URL + this.file, map => {
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.colorSpace = THREE.NoColorSpace;
      map.anisotropy = 4;
      map.needsUpdate = true;
      this.map = map;
      this.ready = true;
      this.loading = false;
      this.onLoad?.(map);
    }, undefined, () => { this.loading = false; this.retryAt = performance.now() + 60000; });
  }
}

export const asphalt = new StreetScan('street-asphalt.webp');
export const setts = new StreetScan('street-setts.webp');
export const pavement = new StreetScan('street-mosaic.webp');
export const pavementRelief = new StreetScan('street-mosaic-relief.webp');
export const pavementReady = { value: 0 };

export function streetSurfaceView(street: boolean) {
  asphalt.view(street);
  setts.view(street);
  pavement.view(street); pavementRelief.view(street);
  pavementReady.value = pavement.active.value * pavementRelief.active.value;
}
