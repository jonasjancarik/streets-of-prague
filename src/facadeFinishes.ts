import * as THREE from 'three';

export const facadeFinishes: { plaster?: THREE.Texture; masks?: THREE.Texture; shops?: THREE.Texture; signs?: THREE.Texture } = {};
let loading = false, retryAt = 0;
let shopRetry = 0;
export const shopReady = { value: 0 };
export const shopTexture: { value: THREE.Texture | null } = { value: null };

// The four trades in shop-displays.webp, in the same order. All shop fascias
// share this little mask; the wall material supplies the paint and lighting.
function shopLetters() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [i, title] of ['KNIHKUPECTVÍ', 'PEKAŘSTVÍ', 'KVĚTINY', 'KERAMIKA'].entries()) {
    g.font = i % 2 ? 'bold 44px sans-serif' : 'bold 46px Georgia, serif';
    g.fillText(title, 256, i * 64 + 34, 402);
  }
  const map = new THREE.CanvasTexture(canvas);
  map.anisotropy = 4;
  return map;
}

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
  facadeFinishes.signs ??= shopLetters();
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
