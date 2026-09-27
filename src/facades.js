import * as THREE from 'three';
import proj4 from 'proj4';

// Facade modules: one window bay by one storey each, drawn as sheets of 6 × 2
// (upper floors on top, ground floors below) and packed by assets/facades/build_atlas.py
// into public/facades.webp, one sheet under another. The shader (shading.js) picks a
// module for every bay and storey of a wall, by the wall's style.
export const CELL = [256, 512];
export const SHEETS = 4;

// Styles: 0 tenement, 1 baroque, 2 functionalist, 3 panel housing, 4 family house.
export const STYLE = { tenement: 0, baroque: 1, functionalist: 2, panel: 3, house: 4 };

export const FACADE_ATLAS = { value: null };
export const FACADE_ON = { value: 0 };

let loading = null;
export function loadFacadeAtlas() {
  loading ??= (async () => {
    const img = new Image();
    img.src = 'facades.webp';
    await img.decode();
    const [w, h] = CELL, cols = 6, rows = SHEETS * 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    // Cut the atlas into layers of a texture array, so modules never bleed into
    // their neighbours in the mipmaps.
    const data = new Uint8Array(w * h * 4 * cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const layer = r * cols + c;
      for (let y = 0; y < h; y++) {
        const src = ((r * h + y) * img.width + c * w) * 4;
        data.set(px.subarray(src, src + w * 4), (layer * h + y) * w * 4);
      }
    }
    const tex = new THREE.DataArrayTexture(data, w, h, cols * rows);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8; // walls are seen almost edge-on from above
    tex.needsUpdate = true;
    FACADE_ATLAS.value = tex;
    FACADE_ON.value = 1;
  })().catch((err) => console.warn('Facade textures did not load, drawing plain windows', err));
  return loading;
}

// A wall's style from where it stands and how tall it is. Old Town, Malá Strana and
// Hradčany are mostly baroque and older; tall blocks far out are prefab panel housing;
// low buildings are family houses; the rest is mostly 19th-century tenements with some
// 1920s–30s functionalism further out. Neighbouring walls share the random pick
// (it goes by 60 m squares), so a block keeps to one style.
export function styleFor(index) {
  const [w, s, e, n] = index.bbox_wgs84;
  const local = `+proj=tmerc +lat_0=${(s + n) / 2} +lon_0=${(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
  const at = (lon, lat) => proj4('EPSG:4326', local, [lon, lat]);
  const oldTown = at(14.4213, 50.0875);
  const core = [
    [...oldTown, 750], // Staré Město
    [...at(14.4034, 50.0880), 550], // Malá Strana
    [...at(14.3975, 50.0890), 450], // Hradčany
  ];
  return (x, y, height) => {
    if (height < 8.5) return STYLE.house;
    const pick = cellHash(Math.floor(x / 60), Math.floor(y / 60));
    if (core.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) < r)) return pick < 0.65 ? STYLE.baroque : STYLE.tenement;
    const d = Math.hypot(x - oldTown[0], y - oldTown[1]);
    if (height > 20 && d > 3500) return STYLE.panel;
    if (d > 1800 && pick < 0.25) return STYLE.functionalist;
    return STYLE.tenement;
  };
}

export function cellHash(i, j) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// For every bay and storey, which module of the wall's style: upper floors, then the
// ground floor's doors and the rest of the ground floor, as layers of the atlas
// (sheet × 12 + row × 6 + column). A few bays of each ground floor get a door.
export const FACADE_GLSL = /* glsl */ `
uniform mediump sampler2DArray uFacades;
uniform float uFacadeOn;
const int F_UP[30] = int[30](0, 1, 2, 3, 4, 0,   12, 13, 14, 15, 12, 14,   24, 25, 24, 25, 26, 24,   27, 28, 27, 27, 28, 27,   36, 37, 38, 39, 40, 36);
const int F_DOOR[15] = int[15](7, 8, 9,   18, 19, 20,   31, 31, 34,   32, 32, 34,   42, 44, 45);
const int F_WALL[20] = int[20](6, 6, 10, 11,   21, 22, 23, 20,   30, 30, 30, 35,   33, 35, 33, 35,   43, 46, 47, 43);
float fHash(float a, float b) { return fract(sin(a * 127.1 + b * 311.7) * 43758.5453); }
vec3 facadeModules(vec3 wall, vec4 f, vec4 fdx, vec4 fdy) {
  int style = int(floor(f.w));
  float seed = fract(f.w) * 97.;
  float bays = max(1., floor(f.z / 1.9 + .5));
  vec2 q = vec2(f.x / f.z * bays, f.y < 4. ? clamp(f.y / 4., 0., .999) : (f.y - 4.) / 3.4);
  vec2 cell = floor(q), uv = fract(q);
  int layer;
  if (f.y < 4.) {
    float r = fHash(seed, cell.x);
    layer = r < .18 ? F_DOOR[style * 3 + int(r / .18 * 3.)] : F_WALL[style * 4 + int(fHash(cell.x, seed) * 4.)];
  } else layer = F_UP[style * 6 + int(fHash(seed, cell.y + 7.) * 6.)];
  vec2 k = vec2(bays / f.z, 1. / 3.6);
  vec3 t = textureGrad(uFacades, vec3(uv.x, 1. - uv.y, float(layer)), fdx.xy * k, fdy.xy * k).rgb;
  // Plaster is drawn neutral grey: give it the wall's colour. Frames, doors and
  // metal keep their own.
  float hi = max(t.r, max(t.g, t.b)), sat = (hi - min(t.r, min(t.g, t.b))) / max(hi, 1e-3);
  return mix(t, t * wall / .55, 1. - smoothstep(.08, .2, sat));
}
`;
