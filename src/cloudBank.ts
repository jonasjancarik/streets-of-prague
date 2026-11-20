// Each tile looks through the same cloud bank from a different direction. The
// channels carry integrated opacity, skylight and two directional lighting terms.
import * as THREE from 'three';

export const BANK = { azimuths: 12, elevations: 7, size: 224, border: 3, shadowHeight: 1100 };
const seed = new THREE.DataTexture(new Uint8Array([0, 128, 128, 255]), 1, 1); seed.magFilter = seed.minFilter = THREE.LinearFilter; seed.needsUpdate = true;
export const CLOUD_BANK: { value: THREE.Texture } = { value: seed };
export const BANK_READY = { value: 0 };
const listeners: ((map: THREE.Texture) => void)[] = [];
export function onCloudBank(fn: (map: THREE.Texture) => void) { listeners.push(fn); }
let loading = false, retryAt = 0;
export function wantCloudBank() {
  if (loading || BANK_READY.value || performance.now() < retryAt) return;
  loading = true;
  new THREE.TextureLoader().load(import.meta.env.BASE_URL + 'cloud-bank.webp', map => {
    map.flipY = false; map.colorSpace = THREE.NoColorSpace; map.minFilter = THREE.LinearFilter; map.magFilter = THREE.LinearFilter;
    map.generateMipmaps = false; map.needsUpdate = true;
    CLOUD_BANK.value = map; BANK_READY.value = 1; loading = false; for (const notify of listeners) notify(map);
  }, undefined, () => { loading = false; retryAt = performance.now() + 60000; });
}
