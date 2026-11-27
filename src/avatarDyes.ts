import * as THREE from 'three';
import { cutAway } from './shading.ts';

// The avatars wear hand-picked colourways of their own outfits, near (rocketbox.ts) and in
// the middle-distance crowd (streetCrowd.ts) alike. Each person gets one by chance, most
// likely one near the top they wear as an instanced figure (figures.ts randomLook), so the
// cold months' dark coats bring out the dark colourways (outfit() below). Only the main
// garments change: skin, shoes, belts, an inner layer and white stripes keep their texture.
//
// The garments are found in the body texture (512 units across, rows from the top), each
// in up to eight rects. `rects` are dyed whole. In `keyed` ones, the `keep` colour decides
// (sRGB chromaticity and a tolerance): a texel near it is left alone with a tolerance above
// 0, which spares a neck or a blouse in a collar; it alone is dyed with one below 0, for a
// hoodie under a jacket or a sports jacket's coloured panels. Texels brighter than `light`
// (linear) aren't dyed: a white shirt or stripes on darker cloth. A dyed texel keeps its
// brightness relative to `mean`, the garment's average colour, so folds, weave and an
// argyle stay as they were; `contrast` below 1 evens it out (a denim's fading would look
// like dirt on other trousers).
type Rect = [number, number, number, number];
interface Region { rects?: Rect[]; keyed?: Rect[]; keep?: [number, number, number, number]; light?: number; mean: string; contrast?: number }
// A colourway: the top's colour, then the bottom's (null keeps the original garment).
type Outfit = [top: string | null, bottom?: string | null];
interface Dye { top: Region; bottom?: Region; outfits: Outfit[] }

const DENIM = .45; // (contrast for jeans dyed another colour)
export const DYES: Record<string, Dye> = {
  // A pink shirt with rolled sleeves, and jeans.
  'female-adult-01': {
    top: { rects: [[160, 0, 345, 190], [160, 240, 352, 512], [104, 128, 160, 280], [345, 128, 408, 280]],
      keyed: [[160, 190, 345, 240]], keep: [.376, .326, .298, .022], mean: '#daa2ac' },
    bottom: { rects: [[0, 280, 160, 512], [352, 280, 512, 512]], mean: '#899da6', contrast: DENIM },
    outfits: [[null], ['#e6e4de'], ['#a9c0d8'], ['#9fb29a'], ['#2c3a55', '#b9a98a'], ['#2a2a2e'], ['#c49a45'], ['#6e2a35', '#2a2a2e']],
  },
  // A purple strappy top and black trousers.
  'female-adult-03': {
    top: { rects: [[145, 0, 372, 140], [145, 258, 355, 450], [170, 450, 335, 505]], mean: '#b57ab2' },
    bottom: { rects: [[0, 290, 150, 512], [350, 290, 512, 512]], mean: '#5b5b53' },
    outfits: [[null], ['#d06a5a'], ['#e6e2d8'], ['#262628'], ['#2f7d80'], ['#cf9f3a'], ['#2b3858', '#b8a98a'], ['#93a88c'], ['#c48f9a']],
  },
  // A blazer over a pale blue blouse, and jeans.
  'female-adult-05': {
    top: { rects: [[145, 0, 355, 200], [0, 135, 150, 270], [350, 135, 512, 270], [145, 200, 240, 386], [276, 200, 355, 386]],
      keyed: [[145, 200, 355, 400]], keep: [.326, .331, .343, .03], mean: '#e5c9c4' },
    bottom: { rects: [[0, 302, 155, 512], [345, 302, 512, 512]], mean: '#7896a1', contrast: DENIM },
    outfits: [[null], ['#b08a5c'], ['#2b3550'], ['#8a8b8e', '#2b2b2e'], ['#6a2a33'], ['#242427'], ['#e0dacb', '#2e3548'], ['#5e6345'], ['#2e5459']],
  },
  // A grey T-shirt and jeans (the watch's strap is left alone).
  'female-adult-08': {
    top: { rects: [[170, 0, 330, 388]], mean: '#b6b6b0' },
    bottom: { rects: [[0, 305, 170, 512], [340, 305, 512, 512]], mean: '#778691', contrast: DENIM },
    outfits: [[null], ['#e8e6e0'], ['#26262a'], ['#2b3a5a'], ['#6b6e4a'], ['#6d2a33'], ['#c89a3c'], ['#9bb7d4'], ['#d06e5c'], ['#e8e6e0', '#2a2a2e']],
  },
  // A long-sleeved dress with a belt, and boots (the neckline's skin is left out).
  'female-adult-11': {
    top: { rects: [[165, 0, 330, 242], [165, 297, 330, 512], [165, 242, 229, 297], [270, 242, 330, 297], [0, 192, 165, 285], [330, 192, 512, 285]], mean: '#705a4d' },
    outfits: [[null], ['#232325'], ['#26324d'], ['#5c2230'], ['#2b4537'], ['#6b6b6e'], ['#a7825a'], ['#4d2c46']],
  },
  // A wrap cardigan over a brown top, and dark jeans.
  'female-adult-14': {
    top: { rects: [[155, 0, 320, 210], [155, 270, 347, 500], [155, 210, 224, 270], [274, 210, 320, 270], [0, 142, 155, 226], [320, 142, 512, 226]], mean: '#b8b2a7' },
    bottom: { rects: [[0, 280, 150, 512], [347, 280, 512, 512]], mean: '#5f6867', contrast: DENIM },
    outfits: [[null], ['#8d8d90'], ['#a9845a'], ['#2a3550'], ['#6a2b35'], ['#30483a'], ['#e0d8c6'], ['#bf9142'], ['#3a3b40'], ['#e0d8c6', '#2a2a2e']],
  },
  // A jacket over a striped top, and trousers.
  'business-female-02': {
    top: { rects: [[146, 0, 347, 200], [146, 200, 215, 402], [265, 200, 347, 402], [0, 133, 146, 256], [347, 133, 512, 256]],
      keyed: [[215, 200, 265, 402]], keep: [.333, .333, .333, .03], mean: '#89615b' },
    bottom: { rects: [[0, 256, 146, 512], [347, 256, 512, 512]], mean: '#5a4e43' },
    outfits: [[null], ['#283350', '#2a2d38'], ['#3a3b40', '#2c2d30'], ['#222225', '#222225'], ['#a8845c'], ['#8c8c90', '#2c2d30'], ['#2d4638'], ['#ddd5c4', '#2a2d38'], ['#5a2430']],
  },
  // A striped T-shirt and shorts.
  'male-adult-01': {
    top: { rects: [[160, 0, 343, 439], [0, 219, 137, 306], [361, 219, 512, 306]], mean: '#d4cdc7' },
    bottom: { rects: [[0, 0, 137, 123], [361, 0, 512, 123]], mean: '#c5bba1' },
    outfits: [[null], ['#2b3a5a'], ['#a8352f'], ['#3f6b4a'], ['#262628'], ['#9db9d6'], ['#c99b3c'], ['#8e8f92'], [null, '#2c3548'], ['#e6e2d8', '#5d6145'], ['#2b3a5a', '#6e6f72']],
  },
  // A dark jacket over a cyan hoodie (the hoodie takes the colour), and trousers.
  'male-adult-04': {
    top: { keyed: [[146, 0, 365, 480]], keep: [.143, .408, .449, -.09], mean: '#2998a9' },
    bottom: { rects: [[0, 0, 142, 178], [361, 0, 512, 178]], mean: '#817869' },
    outfits: [[null], ['#b0352e'], ['#9a9a9c'], ['#e2e0da'], ['#2a3552'], ['#c8962f'], ['#262628', '#2a2a2e'], ['#d0622b'], ['#3e7a52'], ['#9a9a9c', '#2c3548']],
  },
  // The navy overshirt (assets/rocketbox/overshirt/) over a white T-shirt, with its brown
  // patches, and grey trousers under a belt.
  'male-adult-07': {
    top: { keyed: [[160, 0, 343, 416], [0, 215, 146, 416], [361, 215, 512, 416]], keep: [.38, .318, .302, .025], light: .3, mean: '#696976' },
    bottom: { rects: [[0, 14, 142, 215], [361, 14, 512, 215]], mean: '#7a7a79' },
    outfits: [[null], ['#5b6243'], ['#3c3d42'], ['#a07f58', '#2c3548'], ['#5e2932'], ['#242427'], ['#4b6283'], ['#2f4a3b', '#a99a7c'], [null, '#2a2a2e']],
  },
  // A tracksuit top with white stripes (the trousers stay black).
  'male-adult-10': {
    top: { rects: [[160, 18, 343, 416], [178, 416, 325, 475], [0, 215, 146, 416], [357, 215, 512, 416]], light: .32, mean: '#a56261' },
    outfits: [[null], ['#283a64'], ['#252528'], ['#2f6b45'], ['#2f57a6'], ['#77787c'], ['#5d2330'], ['#c9612c']],
  },
  // A grey argyle jumper and jeans.
  'male-adult-13': {
    top: { rects: [[160, 0, 350, 408], [0, 215, 160, 410], [350, 215, 512, 410]], mean: '#9f9f9f' },
    bottom: { rects: [[0, 0, 160, 215], [350, 0, 512, 215]], mean: '#7d8a8e', contrast: DENIM },
    outfits: [[null], ['#2a3348'], ['#3b3d42'], ['#5e2630'], ['#2c4a3a', '#a99a7c'], ['#a98a63', '#3a3c40'], ['#d8d0bd'], ['#b0843a']],
  },
  // A sports jacket in blue, white and black (its blue panels take the colour), and jeans.
  'male-adult-17': {
    top: { keyed: [[146, 0, 365, 512], [0, 215, 146, 416], [365, 215, 512, 416]], keep: [.038, .384, .578, -.12], mean: '#1070a8' },
    outfits: [[null], ['#b2312c'], ['#2f7a4c'], ['#d0682a'], ['#5b3b8c'], ['#262628'], ['#d2a72f'], ['#2a7f86']],
  },
  // A suit over a white shirt: jacket and trousers in one colour.
  'business-male-03': {
    top: { rects: [[146, 0, 357, 407], [0, 215, 146, 416], [357, 215, 512, 416]], light: .26, mean: '#60605e' },
    bottom: { rects: [[0, 0, 142, 215], [361, 0, 512, 215]], mean: '#5c5c59' },
    outfits: [[null], ['#262f45', '#262f45'], ['#6f7074', '#6f7074'], ['#1e1e21', '#1e1e21'], ['#4f3a2c', '#4f3a2c'], ['#34466b', '#34466b'], ['#a8987c', '#a8987c'], ['#3d3f45', '#3d3f45']],
  },
};

// One avatar's regions as uniforms, eight rects each (`keyed` 1 where the key decides);
// `ref`: each region's mean brightness (x, y) and contrast (z, w); `light`: the brightest
// texel each dyes.
export interface DyeRegions { name: string; rects: THREE.Vector4[]; keyed: number[]; keep: THREE.Vector4[]; ref: THREE.Vector4; light: THREE.Vector2 }
// One person's close avatar: its regions and the colour each takes now (w: 1 to dye it).
export interface DyeState extends DyeRegions { top: THREE.Vector4; bottom: THREE.Vector4 }

const luma = (hex: string) => { const c = new THREE.Color(hex); return c.r * .2126 + c.g * .7152 + c.b * .0722; };
const NOWHERE: Region = { mean: '#808080' };
const regions = new Map<string, DyeRegions>();
export function dyeRegions(name: string) {
  let r = regions.get(name);
  if (!r) {
    const d = DYES[name], parts = [d.top, d.bottom ?? NOWHERE];
    const rects: THREE.Vector4[] = [], keyed: number[] = [];
    for (const g of parts) {
      const all = [...(g.rects ?? []).map(q => [q, 0] as const), ...(g.keyed ?? []).map(q => [q, 1] as const)];
      if (all.length > 8) throw Error(`At most eight rects in each of ${name}'s garments`);
      for (let i = 0; i < 8; i++) {
        rects.push(all[i] ? new THREE.Vector4(...all[i][0]) : new THREE.Vector4(-1, -1, -1, -1));
        keyed.push(all[i]?.[1] ?? 0);
      }
    }
    regions.set(name, r = {
      name, rects, keyed,
      keep: parts.map(g => g.keep ? new THREE.Vector4(...g.keep) : new THREE.Vector4()),
      ref: new THREE.Vector4(luma(parts[0].mean), luma(parts[1].mean), parts[0].contrast ?? 1, parts[1].contrast ?? 1),
      light: new THREE.Vector2(parts[0].light ?? 99, parts[1].light ?? 99),
    });
  }
  return r;
}

// The dye in GLSL, for after `#include <common>` in a fragment shader (with dyeUniforms):
// dyed() gives a texel's colour `c` (linear) at `p` in the body texture (512 units) in the
// colours `top` and `bottom`. (webgpu/avatars.ts has the same in TSL.)
export const DYE_GLSL = `
uniform vec4 uDyeRect[16]; uniform float uDyeKeyed[16]; uniform vec4 uDyeKeep[2]; uniform vec4 uDyeRef; uniform vec2 uDyeLight;
float dyeIn(vec4 r, vec2 p) { return step(r.x, p.x) * step(p.x, r.z) * step(r.y, p.y) * step(p.y, r.w); }
float dyeRegion(int o, vec4 keep, float light, vec2 p, vec3 ch, float l) {
  float d = distance(ch, keep.rgb);
  float key = keep.w > 0. ? smoothstep(keep.w, keep.w * 1.6, d) : keep.w < 0. ? 1. - smoothstep(-keep.w, -keep.w * 1.6, d) : 1.;
  float w = 0.;
  for (int i = 0; i < 8; i++) w = max(w, dyeIn(uDyeRect[o + i], p) * mix(1., key, uDyeKeyed[o + i]));
  return w * (1. - smoothstep(light, light * 1.3, l));
}
vec3 dyed(vec3 c, vec2 p, vec4 top, vec4 bottom) {
  vec3 s = pow(max(c, 0.), vec3(1. / 2.2)), ch = s / max(s.r + s.g + s.b, 1e-3);
  float l = dot(c, vec3(.2126, .7152, .0722));
  vec3 o = mix(c, top.rgb * min(pow(l / uDyeRef.x, uDyeRef.z), 2.5), dyeRegion(0, uDyeKeep[0], uDyeLight.x, p, ch, l) * top.w);
  return mix(o, bottom.rgb * min(pow(l / uDyeRef.y, uDyeRef.w), 2.5), dyeRegion(8, uDyeKeep[1], uDyeLight.y, p, ch, l) * bottom.w);
}`;
export const dyeUniforms = (r: DyeRegions) => ({ uDyeRect: { value: r.rects }, uDyeKeyed: { value: r.keyed }, uDyeKeep: { value: r.keep }, uDyeRef: { value: r.ref }, uDyeLight: { value: r.light } });


// A clone of the avatar's body material that can be dyed, for one person: `mesh` wears it.
// Its key is cutAway's plus "-dye-" and the avatar, so the WebGPU ports for both apply
// (webgpu/avatars.ts). WebGPU shares one compiled graph between materials with the same
// key, so there the colours are read from the mesh, and the regions differ by avatar.
export function dyeMaterial(body: THREE.MeshStandardMaterial, name: string, mesh: THREE.Object3D) {
  const m = cutAway(body.clone(), 'rocketbox');
  const state: DyeState = { ...dyeRegions(name), top: new THREE.Vector4(), bottom: new THREE.Vector4() };
  m.userData.dye = mesh.userData.dye = state;
  const cut = m.onBeforeCompile;
  m.onBeforeCompile = (sh, renderer) => {
    cut.call(m, sh, renderer);
    Object.assign(sh.uniforms, dyeUniforms(state), { uDyeTop: { value: state.top }, uDyeBottom: { value: state.bottom } });
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${DYE_GLSL}\nuniform vec4 uDyeTop; uniform vec4 uDyeBottom;`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = dyed(diffuseColor.rgb, vMapUv * 512., uDyeTop, uDyeBottom);');
  };
  m.customProgramCacheKey = () => `cut-rocketbox-dye-${name}`;
  return m;
}

// How strongly a colourway near the figure's top is preferred: smaller is stricter. (The
// nearest one alone would leave some colourways to nobody: the shirts' palette is small.)
export const DRESS_SPREAD = .12;
// Each avatar's colourways once worked out: the top to compare with (sRGB) and the colours
// to dye in (linear rgb, null to keep the garment).
interface Wardrobe { match: number[][]; top: (number[] | null)[]; bottom: (number[] | null)[] }
const wardrobes = new Map<string, Wardrobe>();
const _c = new THREE.Color();
const linear = (hex?: string | null) => hex ? _c.set(hex).toArray() : null;
function wardrobe(name: string) {
  let w = wardrobes.get(name);
  if (!w) {
    const d = DYES[name];
    wardrobes.set(name, w = {
      match: d.outfits.map(o => _c.set(o[0] ?? d.top.mean).convertLinearToSRGB().toArray()),
      top: d.outfits.map(o => linear(o[0])), bottom: d.outfits.map(o => linear(o[1])),
    });
  }
  return w;
}

// Which colourway avatar `name` wears for someone: by chance, but most likely those near
// `wearing` (the instanced figure's colours, figures.ts colours(): linear rgb, the top
// first); -1, the original outfit, without them. The chance comes from those colours, so a
// person is dressed the same each time they come near, as a close avatar or in the crowd.
export function outfit(name: string, wearing?: ArrayLike<number>) {
  if (!wearing || !(wearing[0] + wearing[1] + wearing[2] > 0)) return -1;
  const { match } = wardrobe(name);
  _c.setRGB(wearing[0], wearing[1], wearing[2]).convertLinearToSRGB();
  let total = 0;
  const weights = match.map(([r, g, b]) => { const w = Math.exp(-((r - _c.r) ** 2 + (g - _c.g) ** 2 + (b - _c.b) ** 2) / DRESS_SPREAD); total += w; return w; });
  let h = 0;
  for (let i = 0; i < wearing.length; i++) h = Math.sin(h * 12.9898 + wearing[i] * 78.233 + i) * 43758.5453 % 1;
  let pick = Math.abs(h) * total;
  for (let i = 0; i < weights.length; i++) if ((pick -= weights[i]) < 0) return i;
  return weights.length - 1;
}

// Writes the top's and the bottom's dye for colourway `which` (outfit()) into `out` from
// `at`: rgb and 1, or 0s to keep the garment.
export function wear(name: string, which: number, out: { [i: number]: number }, at = 0) {
  const w = wardrobe(name);
  [w.top[which], w.bottom[which]].forEach((c, k) => {
    const o = at + k * 4;
    if (which < 0 || !c) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 1;
  });
}

const _dye: number[] = [];
// Dresses a close avatar's material (dyeMaterial) for someone wearing `wearing`.
export function dress(state: DyeState, wearing?: ArrayLike<number>) {
  wear(state.name, outfit(state.name, wearing), _dye);
  state.top.fromArray(_dye, 0);
  state.bottom.fromArray(_dye, 4);
}
