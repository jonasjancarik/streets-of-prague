import * as THREE from 'three';

export const facadeFinishes: { plaster?: THREE.Texture; masks?: THREE.Texture; shops?: THREE.Texture } = {};
let loading = false, retryAt = 0;
let shopRetry = 0;
export const shopReady = { value: 0 };
export const shopTexture: { value: THREE.Texture | null } = { value: null };

// Publish the pair atomically. In particular the first WebGPU wall must bind
// the finished masks, not compile its material against an undecoded image.
export function loadFacadeFinishes() {
  if (!facadeFinishes.shops && performance.now() >= shopRetry) {
    shopRetry = Infinity;
    new THREE.TextureLoader().load(import.meta.env.BASE_URL + 'shop-displays.webp', map => {
      map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
      facadeFinishes.shops = shopTexture.value = map; shopReady.value = 1;
    }, undefined, () => { shopRetry = performance.now() + 60000; });
  }
  if (loading || facadeFinishes.masks || performance.now() < retryAt) return;
  loading = true;
  const loader = new THREE.TextureLoader(), base = import.meta.env.BASE_URL;
  void Promise.allSettled([loader.loadAsync(base + 'street-plaster.webp'), loader.loadAsync(base + 'street-facade-masks.webp')]).then(results => {
    const [plaster, masks] = results;
    if (plaster.status === 'rejected' || masks.status === 'rejected') {
      for (const r of results) if (r.status === 'fulfilled') r.value.dispose();
      retryAt = performance.now() + 60000; return;
    }
    plaster.value.wrapS = plaster.value.wrapT = THREE.RepeatWrapping; plaster.value.anisotropy = 4;
    masks.value.flipY = false; masks.value.anisotropy = 4;
    for (const t of [plaster.value, masks.value]) { t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; }
    facadeFinishes.plaster = plaster.value; facadeFinishes.masks = masks.value;
  }).finally(() => { loading = false; });
}
