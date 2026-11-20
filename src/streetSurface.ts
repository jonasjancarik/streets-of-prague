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
  map: THREE.Texture = neutral;
  onLoad?: (map: THREE.Texture) => void;
  private loading = false;
  private retryAt = 0;

  constructor(private file: string) {}

  view(street: boolean) {
    const ready = this.map !== neutral;
    this.active.value = street && ready ? 1 : 0;
    if (!street || ready || this.loading || performance.now() < this.retryAt) return;
    this.loading = true;
    new THREE.TextureLoader().load(import.meta.env.BASE_URL + this.file, map => {
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.colorSpace = THREE.NoColorSpace;
      map.anisotropy = 4;
      map.needsUpdate = true;
      this.map = map;
      this.loading = false;
      this.onLoad?.(map);
    }, undefined, () => { this.loading = false; this.retryAt = performance.now() + 60000; });
  }
}

export const asphalt = new StreetScan('street-asphalt.webp');
export const setts = new StreetScan('street-setts.webp');

export function streetSurfaceView(street: boolean) {
  asphalt.view(street);
  setts.view(street);
}
