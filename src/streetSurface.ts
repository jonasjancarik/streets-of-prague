// One close scan for fine aggregate and the small normals of an asphalt road.
// The game's surface colours, markings, repairs and wetness still set the street.
import * as THREE from 'three';

const neutral = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
neutral.magFilter = THREE.LinearFilter; neutral.minFilter = THREE.LinearMipmapLinearFilter;
neutral.wrapS = neutral.wrapT = THREE.RepeatWrapping; neutral.generateMipmaps = true; neutral.needsUpdate = true;
export const ASPHALT_SCAN: { value: THREE.Texture } = { value: neutral };
export const STREET_SURFACE = { value: 0 };
const listeners: ((map: THREE.Texture) => void)[] = [];
export function onAsphaltScan(fn: (map: THREE.Texture) => void) { listeners.push(fn); }
let loading = false, ready = false, retryAt = 0;
export function streetSurfaceView(street: boolean) {
  STREET_SURFACE.value = street && ready ? 1 : 0;
  if (!street || ready || loading || performance.now() < retryAt) return;
  loading = true;
  new THREE.TextureLoader().load(import.meta.env.BASE_URL + 'street-asphalt.webp', map => {
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.NoColorSpace; map.anisotropy = 4; map.needsUpdate = true;
    ASPHALT_SCAN.value = map; ready = true; loading = false;
    for (const notify of listeners) notify(map);
  }, undefined, () => { loading = false; retryAt = performance.now() + 60000; });
}
