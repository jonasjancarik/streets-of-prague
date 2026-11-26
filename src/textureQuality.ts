import * as THREE from 'three';

// Two texture settings the graphics tiers (graphics.ts) set for every texture at once,
// instead of in each of the thirty-odd places a texture is made.
//
// Anisotropic filtering: each texture keeps the amount it was made with (4 for most, 8
// for walls seen edge-on, 1 for those that want none), and `TEXTURE_QUALITY.aniso` scales
// it: 0 turns it off, 1 is as made, 16 the most any GPU takes. three only makes a new
// sampler when a texture's version changes, which uploads it again too, so a change
// re-uploads the textures it changes once (a short hitch, like a change of tier).
//
// Resolution: the image files are made at the size they look right at, and none come
// larger, so this only goes down: `half` draws each loaded picture at half its width and
// height (a quarter of the memory) before it reaches the GPU. Pictures are loaded once,
// so it applies the next time the game starts. It is read from what was saved, as the
// pictures start loading before the game's Graphics exists.
//
// This module must be imported before any texture is made (main.ts imports it first):
// a texture made before it keeps its own anisotropy, out of reach of the setting.
const MOST = 16;
type Want = THREE.Texture & { __aniso?: number; __listed?: boolean };
const made = new Set<WeakRef<Want>>();

function savedHalf(): boolean {
  try {
    const params = new URLSearchParams(location.search);
    const choice = params.get('graphics') ?? localStorage.getItem('graphics');
    if (choice === 'lowest') return true;
    if (choice === 'custom') return JSON.parse(localStorage.getItem('graphicsCustom') ?? '{}')?.textures === 'half';
  } catch {}
  return false;
}

export const TEXTURE_QUALITY = { aniso: 1, half: savedHalf() };

const scaled = (want: number) => want <= 1 ? want : TEXTURE_QUALITY.aniso <= 0 ? 1 : Math.min(MOST, Math.max(1, Math.round(want * TEXTURE_QUALITY.aniso)));

Object.defineProperty(THREE.Texture.prototype, 'anisotropy', {
  configurable: true,
  get(this: Want) { return scaled(this.__aniso ?? 1); },
  set(this: Want, v: number) {
    if (v > 1 && !this.__listed) { this.__listed = true; made.add(new WeakRef(this)); }
    this.__aniso = v;
  },
});
// (A copy takes the amount it was made with, not the scaled one, or it would scale twice.)
const copy = THREE.Texture.prototype.copy;
THREE.Texture.prototype.copy = function (this: Want, source: Want) {
  copy.call(this, source);
  this.anisotropy = source.__aniso ?? 1;
  return this;
};

// A new amount for every texture that filters: those it changes are uploaded again.
export function setAnisotropy(scale: number) {
  if (scale === TEXTURE_QUALITY.aniso) return;
  const before = TEXTURE_QUALITY.aniso;
  for (const ref of made) {
    const tex = ref.deref();
    if (!tex) { made.delete(ref); continue; }
    const want = tex.__aniso ?? 1;
    TEXTURE_QUALITY.aniso = before;
    const was = scaled(want);
    TEXTURE_QUALITY.aniso = scale;
    if (scaled(want) !== was && tex.image && !(tex as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture) tex.needsUpdate = true;
  }
  TEXTURE_QUALITY.aniso = scale;
}

// Half-size pictures: every TextureLoader picture over 256 pixels across.
const load = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
  return load.call(this, url, (tex) => {
    const img = tex.image as { width: number; height: number } & CanvasImageSource;
    if (TEXTURE_QUALITY.half && img && img.width > 256 && img.height > 1) {
      const c = document.createElement('canvas');
      c.width = Math.round(img.width / 2); c.height = Math.max(1, Math.round(img.height / 2));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      (tex as THREE.Texture).image = c;
      tex.needsUpdate = true;
    }
    onLoad?.(tex);
  }, onProgress, onError);
};
