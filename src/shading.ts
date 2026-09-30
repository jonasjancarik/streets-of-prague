import * as THREE from 'three';
import { FACADE_ATLAS, FACADE_ON, FACADE_GLSL } from './facades.ts';
import { lampLit } from './lamps.ts';
import { ROOF_TILES } from './map/roofPalette.ts';

// Procedural surface patterns in world space, shared by the ground and the buildings.
// Everything is computed per pixel from the position in metres, so it stays sharp at
// any zoom and needs no textures. Detail fades out once it gets smaller than a pixel
// (and isn't worked out at all once it has).

// The value noise's lattice: random values, wrapping round every NOISE_SIZE cells.
const NOISE_SIZE = 256;
const LATTICE = (() => {
  const cells = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
  let s = 7;
  for (let i = 0; i < cells.length; i++) cells[i] = ((s = (s * 16807) % 2147483647) >> 7) & 255;
  return cells;
})();
export const NOISE = {
  value: (() => {
    const tex = new THREE.DataTexture(LATTICE, NOISE_SIZE, NOISE_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  })(),
};

// The same noise in JavaScript, for what's baked into textures ahead (see BROAD_GLSL).
function vnoise(x: number, y: number) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const i0 = ((i % NOISE_SIZE) + NOISE_SIZE) % NOISE_SIZE, j0 = ((j % NOISE_SIZE) + NOISE_SIZE) % NOISE_SIZE;
  const i1 = (i0 + 1) % NOISE_SIZE, j1 = (j0 + 1) % NOISE_SIZE;
  const v = (a: number, b: number) => LATTICE[b * NOISE_SIZE + a] / 255;
  return (v(i0, j0) * (1 - ux) + v(i1, j0) * ux) * (1 - uy) + (v(i0, j1) * (1 - ux) + v(i1, j1) * ux) * uy;
}
function fbm(x: number, y: number) {
  let s = 0, a = 0.5;
  for (let k = 0; k < 4; k++) { s += a * vnoise(x, y); x = x * 2.03 + 11.7; y = y * 2.03 + 11.7; a *= 0.5; }
  return s;
}
// The ground's broadest variation, over a few hundred metres: a factor on its colour
// (BROAD_GLSL is the same in the shader). Tiles bake it into their hill shading.
export const broad = (x: number, y: number) => 0.93 + 0.14 * fbm(x * 0.004, y * 0.004);

// Dirt on the paving (grit in PATTERNS_GLSL), baked once into a texture that repeats every
// GRIT_M metres: red the broad grimy patches (about 8 m), green the smaller stains (about
// 2 m), each how dark from 0 to 1. One read a pixel instead of four noise reads, which cost
// about 12% of a frame at 2×. Its own noise, wrapping round the texture's width, so it
// repeats without a seam.
export const GRIT_M = 512;

// The least share of the ambient (sky) light a spot in the deepest courtyard gets; see map/skyView.ts.
export const SKY_LEAST = 0.3;
const GRIT_SIZE = 1024;
export const GRIT = {
  value: (() => {
    const hash = (i: number, j: number, s: number) => {
      let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 2147483647);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    // Value noise at x, y in cells, wrapping every `n` cells (its lattice worked out once).
    const noise = (n: number, s: number) => {
      const lattice = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) lattice[j * n + i] = hash(i, j, s);
      return (x: number, y: number) => {
        const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
        const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
        const i0 = i % n, i1 = (i0 + 1) % n, r0 = (j % n) * n, r1 = ((j + 1) % n) * n;
        return (lattice[r0 + i0] * (1 - ux) + lattice[r0 + i1] * ux) * (1 - uy) + (lattice[r1 + i0] * (1 - ux) + lattice[r1 + i1] * ux) * uy;
      };
    };
    const fbm2 = (n: number, s: number) => {
      const a = noise(n, s), b = noise(n * 2, s + 1);
      return (x: number, y: number) => (a(x, y) * 2 + b(x * 2, y * 2)) / 3;
    };
    const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    // Cells across the texture: as near as whole numbers allow to the 0.13 and 0.6 a
    // metre the shader had before.
    const nb = Math.round(0.13 * GRIT_M), ns = Math.round(0.6 * GRIT_M);
    const patches = fbm2(nb, 1), stains = fbm2(ns, 3);
    const px = new Uint8Array(GRIT_SIZE * GRIT_SIZE * 2);
    for (let v = 0; v < GRIT_SIZE; v++) {
      for (let u = 0; u < GRIT_SIZE; u++) {
        const x = (u + 0.5) / GRIT_SIZE, y = (v + 0.5) / GRIT_SIZE, k = (v * GRIT_SIZE + u) * 2;
        px[k] = Math.round(255 * smooth(0.3, 0.85, patches(x * nb, y * nb)));
        px[k + 1] = Math.round(255 * smooth(0.55, 0.85, stains(x * ns, y * ns)));
      }
    }
    const tex = new THREE.DataTexture(px, GRIT_SIZE, GRIT_SIZE, THREE.RGFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.unpackAlignment = 2;
    tex.needsUpdate = true;
    return tex;
  })(),
};

// Value noise reads its random lattice from a small texture (NOISE, below) instead of
// hashing four corners per call: the smooth step between lattice points goes into
// the coordinate, so one filtered read gives the same curve. It's the ground's main
// cost: a pixel of paving takes a dozen of these or more.
export const NOISE_GLSL = /* glsl */ `
uniform sampler2D uNoise;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  return textureLod(uNoise, (mod(i, ${NOISE_SIZE}.) + f * f * (3. - 2. * f) + .5) * (1. / ${NOISE_SIZE}.), 0.).r;
}
// Two octaves: for broad dirt, where the finer ones would only cost time.
float fbm2(vec2 p) { return (vnoise(p) * 2. + vnoise(p * 2.03 + 11.7)) / 3.; }
float fbm(vec2 p) { float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= .5; } return s; }
// 1 while a pattern with cells of \`cell\` metres is well above pixel size, fading to 0.
float detail(vec2 p, float cell) { float w = length(fwidth(p)); return 1. - smoothstep(cell * .2, cell * .7, w); }
// Running-bond blocks: x = distance to the nearest joint (m), y = per-block random.
vec2 blocks(vec2 p, vec2 size) {
  vec2 q = p / size;
  q.x += step(1., mod(floor(q.y), 2.)) * .5;
  vec2 c = floor(q), f = fract(q), e = min(f, 1. - f) * size;
  return vec2(min(e.x, e.y), hash12(c));
}
// Three random numbers for a cell, for about the price of one hash12.
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
// Irregular stones (Prague mosaic pavement): x = gap to the neighbouring stone, y = random.
vec2 stones(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 64., d2 = 64., id = 0.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec3 h = hash32(i + g);
    vec2 r = g + h.xy * .8 + .1 - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = h.z; } else if (d < d2) d2 = d;
  }
  return vec2(sqrt(d2) - sqrt(d1), id);
}
float luma(vec3 c) { return dot(c, vec3(.299, .587, .114)); }
`;

// Patterns by id. Each takes the base colour and the position in metres (x east, y north).
export const PATTERNS_GLSL = /* glsl */ `
uniform float uTime;
uniform float uDirt;
vec3 pAsphalt(vec3 c, vec2 p) {
  c *= .9 + .18 * fbm(p * .3);
  c *= mix(1., .9, smoothstep(.62, .66, fbm(p * .07 + 3.)));          // repair patches
  float d = detail(p, .06), dc = detail(p, .15);
  if (d > 0.) c += (vnoise(p * 16.) - .5) * .07 * d;                   // aggregate
  c *= 1. - .14 * smoothstep(.6, .85, vnoise(p * vec2(.9, .25) + 23.)); // oil and tyre marks
  if (dc > 0.) {
    float crack = 1. - smoothstep(.0, .025, abs(vnoise(p * .7) - .5));
    c *= 1. - .3 * crack * dc * smoothstep(.55, .7, vnoise(p * .06 + 2.));
  }
  return c;
}
vec3 pSetts(vec3 c, vec2 p, vec2 size) {
  float d = detail(p, size.x);
  vec3 s = c * .85;
  if (d > 0.) {
    vec2 b = blocks(p, size);
    vec3 stone = c * (.8 + .4 * b.y) * (.92 + .16 * vnoise(p * 9.));
    s = mix(s, mix(c * .5, stone, smoothstep(.004, .02, b.x)), d);
  }
  return s * (.94 + .12 * fbm(p * .2));
}
vec3 pMosaic(vec3 c, vec2 p) {
  float d = detail(p, .09);
  vec3 m = c * .9;
  if (d > 0.) {
    vec2 s = stones(p * 11.);
    float dark = step(.9, s.y);                                        // a few grey stones
    vec3 stone = mix(c * (.9 + .18 * s.y), c * .62, dark);
    m = mix(m, mix(c * .6, stone, smoothstep(.03, .12, s.x)), d);
  }
  return m * (.95 + .1 * fbm(p * .25));
}
vec3 pSlabs(vec3 c, vec2 p) {
  float d = detail(p, .4);
  vec3 s = c * .95;
  if (d > 0.) {
    vec2 b = blocks(p, vec2(.6, .4));
    s = mix(s, mix(c * .72, c * (.9 + .15 * b.y), smoothstep(.004, .015, b.x)), d);
  }
  return s * (.93 + .14 * fbm(p * .15));
}
vec3 pGrass(vec3 c, vec2 p) {
  c *= .82 + .32 * fbm(p * .18);
  c = mix(c, c * vec3(1.12, 1.05, .78), smoothstep(.55, .75, fbm(p * .04 + 7.)));  // dry patches
  c = mix(c, c * vec3(1.05, .9, .7), smoothstep(.6, .8, fbm2(p * .15 + 3.)) * .6);  // worn to earth
  float d = detail(p, .2);
  if (d > 0.) c += (vnoise(p * 5.) - .5) * .07 * d;
  return c;
}
vec3 pWood(vec3 c, vec2 p) { return c * (.75 + .45 * fbm(p * .12)) + (vnoise(p * 3.) - .5) * .05; }
vec3 pPitch(vec3 c, vec2 p) { return pGrass(c, p) * (.94 + .1 * step(.5, fract(p.x / 6.))); }
vec3 pDirt(vec3 c, vec2 p) {
  float d = detail(p, .08);
  c *= .85 + .25 * fbm(p * .5);
  if (d > 0.) c += (vnoise(p * 12.) - .5) * .08 * d;
  return c;
}
// Gravel and railway ballast: packed small stones, a few bigger light and dark ones,
// and faint wheel tracks worn into it.
vec3 pGravel(vec3 c, vec2 p) {
  float d = detail(p, .05);
  vec3 g = c;
  if (d > 0.) {
    vec2 s = stones(p * 22.);
    g = c * (.84 + .3 * s.y) * mix(.7, 1., smoothstep(.02, .1, s.x));
    g = mix(g, c * vec3(1.18, 1.16, 1.12), step(.94, hash12(floor(p * 7.))) * .5);
  }
  c = mix(c * (.93 + .1 * vnoise(p * 4.)), g, d);
  return c * (.9 + .16 * fbm(p * .35)) * mix(1., .93, smoothstep(.6, .7, fbm(vec2(p.x * .05, p.y * .8) + 5.)));
}
// Fields: straight crop rows in strips that change direction and tone.
vec3 pField(vec3 c, vec2 p) {
  vec2 cell = floor(p / 90.);
  float a = hash12(cell) * 3.1416, t = hash12(cell + 3.7);
  vec2 d = vec2(cos(a), sin(a));
  float row = fract(dot(p, d) / 1.6);
  c *= mix(vec3(.95, 1.02, .9), vec3(1.07, 1., .88), t);
  c *= 1. - .1 * smoothstep(.35, .5, abs(row - .5)) * detail(p, 1.2);
  float fine = detail(p, .15);
  c *= .9 + .2 * fbm(p * .03);
  if (fine > 0.) c += (vnoise(p * 6.) - .5) * .04 * fine;
  return c;
}
vec3 pConcrete(vec3 c, vec2 p) {
  vec2 b = blocks(p, vec2(3., 2.4));
  return c * (.9 + .12 * fbm(p * .4)) * mix(.8, 1., smoothstep(.01, .04, b.x) * detail(p, 1.) + (1. - detail(p, 1.)));
}
vec3 pWater(vec3 c, vec2 p) {
  float n = fbm(p * vec2(.05, .012) + vec2(0., uTime * .03));
  c *= .88 + .2 * n;
  float d = detail(p, .5);
  if (d > 0.) c += smoothstep(.72, .8, fbm(p * vec2(.5, .09) + vec2(uTime * .02, uTime * .12))) * .1 * d; // glints
  return c;
}
// Dirt on paved ground: broad grimy patches and smaller stains.
// (Baked into uGrit, see GRIT.)
uniform sampler2D uGrit;
vec3 grit(vec3 c, vec2 p) {
  if (uDirt < .5) return c;
  vec2 g = texture(uGrit, p * ${1 / GRIT_M}).rg;
  return c * (1. - .22 * g.r) * (1. - .12 * g.g * detail(p, .6));
}
vec3 pattern(int id, vec3 c, vec2 p) {
  if (id == 1) return grit(pAsphalt(c, p), p);
  if (id == 2) return grit(pSetts(c, p, vec2(.17, .14)), p);
  if (id == 3) return grit(pMosaic(c, p), p);
  if (id == 4) return grit(pSlabs(c, p), p);
  if (id == 5) return pGrass(c, p);
  if (id == 6) return pWood(c, p);
  if (id == 7) return pPitch(c, p);
  if (id == 8) return pDirt(c, p);
  if (id == 9) return grit(pConcrete(c, p), p);
  if (id == 10) return pWater(c, p);
  if (id == 11) return pGravel(c, p);
  if (id == 12) return pField(c, p);
  return c;
}
`;

// Weather on the ground (weather.ts sets the uniforms): wet paving darker, with
// puddles that mirror the sky and the lamps and ripple while it rains; snow lying
// thick on grass and earth, thinner and slushy on the roads and pavements. `shine`:
// how much of a mirror the ground is there.
export const WEATHER_GLSL = /* glsl */ `
uniform float uWet;
uniform float uSnow;
uniform float uStreetSnow;
uniform float uRain;
uniform vec3 uSkyRef;
float ripples(vec2 p) {
  p *= 2.5;
  vec2 i = floor(p), f = fract(p);
  float t = fract(uTime * 1.1 + hash12(i));
  vec2 c = vec2(hash12(i + 1.7), hash12(i + 4.3)) * .6 + .2;
  return (1. - t) * smoothstep(.07, 0., abs(length(f - c) - t * .45));
}
vec3 weathered(int id, vec3 c, vec2 p, inout float shine) {
  if (id == 10) { shine = .35; return c; }
  bool paved = id <= 4 || id == 9, road = id == 1 || id == 2;
  // Streets cleared of snow are wet with the slush.
  float wet = paved && uSnow > .01 ? max(uWet, uSnow * (1. - uStreetSnow) * .8) : uWet;
  if (wet > .01) {
    c *= mix(1., paved ? .6 : .78, wet);
    if (paved) {
      float puddle = smoothstep(.66, .71, fbm2(p * .3 + 31.) * .75 + fbm2(p * .04 + 7.) * .35) * smoothstep(.35, .9, wet);
      shine = (.1 + .4 * puddle) * wet;
      c *= 1. - .35 * puddle;
      float d = uRain > .01 ? detail(p, .12) * puddle : 0.;
      if (d > 0.) shine += ripples(p) * uRain * .8 * d;
    }
  }
  if (uSnow > .01) {
    // The roads are cleared first; the pavements keep some along their edges.
    float lie = road ? uStreetSnow : paved ? .15 + .85 * uStreetSnow : 1.;
    float n = fbm2(p * .3 + 9.);
    float cover = smoothstep(n * .6, n * .6 + .25, uSnow * lie * 1.15);
    vec3 snow = vec3(.78, .8, .84) * (.94 + .06 * vnoise(p * 4.));
    if (paved) snow = mix(snow * vec3(.72, .7, .68), snow, uStreetSnow * uStreetSnow);   // trodden and driven to slush
    c = mix(c, snow, cover);
    shine *= 1. - cover;
  }
  return c;
}
`;

export const PATTERN: Record<string, number> = { flat: 0, asphalt: 1, setts: 2, mosaic: 3, slabs: 4, grass: 5, wood: 6, pitch: 7, dirt: 8, concrete: 9, water: 10, gravel: 11, field: 12 };

// Buildings: tiles laid in rows down the slope of every roof face (the slope comes
// from the face normal), slate in smaller rows, gravel on flat roofs, and a grid of
// windows on the walls, one row per 3.4 m storey with shopfronts at street level.
const BUILDING_GLSL = /* glsl */ `
vec3 roofTilesAs(vec3 c, vec2 wp, vec3 n, float slate) {
  vec2 down = normalize(vec2(n.x, -n.z) + vec2(0., .0001));   // the nudge keeps a flat face from being 0/0
  vec2 across = vec2(-down.y, down.x);
  vec2 size = mix(vec2(.26, .32), vec2(.3, .22), slate);
  vec2 q = vec2(dot(wp, across), dot(wp, down) / max(n.y, .3));
  vec2 b = blocks(q, size);
  float row = fract(q.y / size.y);
  float d = detail(wp, size.y);
  vec3 t = c * (.9 + .2 * b.y);
  t *= mix(vec3(1.07, .95, .86), vec3(.95, 1., 1.05), fract(b.y * 7.3));           // fired-clay variation, tile by tile
  t *= .8 + .25 * smoothstep(0., .4, row);                                     // overlap shadow
  t = mix(t * .72, t, smoothstep(0., .012, b.x));
  c = mix(c * .95, t, d);
  c *= .88 + .24 * fbm(wp * .22);                                              // weathering
  return mix(c, c * vec3(.86, .9, .8), smoothstep(.62, .75, fbm(wp * .09 + 4.)) * .7);
}
// Clay tiles, or slate on grey roofs where the material isn't known.
vec3 roofTiles(vec3 c, vec2 wp, vec3 n) {
  return roofTilesAs(c, wp, n, step(max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)), .08));
}
// Sheet metal: smooth pans running down the slope between thin standing seams (a lit
// edge and a faint shadow beside it), with a broad, soft sheen; copper with verdigris
// in patches.
vec3 sheetRoof(vec3 c, vec2 wp, vec3 n, float copper) {
  vec2 down = normalize(vec2(n.x, -n.z) + vec2(0., .0001));
  float a = dot(wp, vec2(-down.y, down.x)) / .6;
  float seam = fract(a);
  vec3 t = c * (1. + .07 * (1. - smoothstep(0., .035, seam)) - .06 * smoothstep(.94, 1., seam));
  t *= .96 + .03 * fract(sin(floor(a) * 12.9898) * 43758.5453);
  t = mix(t, t * vec3(.82, 1.1, 1.02) + vec3(.02, .06, .05), copper * smoothstep(.45, .8, fbm(wp * .25)) * .7);
  t *= .95 + .1 * fbm(wp * .04);
  return mix(c * (.95 + .1 * fbm(wp * .04)), t, detail(wp, .3));
}
// A mansard's steep lower slope (facades.ts, mansardCoords): a window in every bay of
// about 3.2 m, 1.3 m high from 0.6 m up the slope, in a light frame. mansardGlass is 1 on
// the glass, for the windows lit at night.
float mansardGlass(vec4 f, float grow) {
  float bays = max(1., floor(f.z / 3.2 + .5)), bay = fract(f.x / f.z * bays) * f.z / bays;
  float half_ = f.z / bays * .5;
  return step(abs(bay - half_), .45 + grow) * step(.6 - grow, f.y) * step(f.y, 1.9 + grow);
}
vec3 mansardWindows(vec3 c, vec4 f) {
  c = mix(c, vec3(.74, .72, .68), mansardGlass(f, .08));
  return mix(c, vec3(.16, .19, .23), mansardGlass(f, 0.));
}
// A roof window (pipeline/roof_details.py; f.xy 0-1 across and up it): a grey metal
// frame round glass that shows more sky towards the top.
float roofGlass(vec4 f) {
  return step(.1, min(min(f.x, 1. - f.x), min(f.y, 1. - f.y)));
}
vec3 roofWindow(vec4 f) {
  return mix(vec3(.42, .4, .38), mix(vec3(.12, .15, .19), vec3(.3, .36, .43), f.y), roofGlass(f));
}
vec3 flatRoof(vec3 c, vec2 wp) {
  c *= .86 + .22 * fbm(wp * .5);
  return c + (vnoise(wp * 18.) - .5) * .08 * detail(wp, .05);
}
// Flat roofs of sheets (bitumen rolls 1 m wide, a membrane's 2 m): smooth, with the
// welded seams a little lighter and some dirt.
vec3 sheetsRoof(vec3 c, vec2 wp, float width) {
  float s = fract(wp.x / width);
  vec3 t = c * (1. + .06 * (1. - smoothstep(0., .025, s)) - .03 * smoothstep(.97, 1., s));
  return mix(c, t, detail(wp, .3)) * (.94 + .12 * fbm(wp * .12));
}
// A planted roof: clumps of green and dry brown.
vec3 plantedRoof(vec3 c, vec2 wp) {
  vec3 t = mix(c * vec3(.85, .78, .62), c * vec3(.92, 1.12, .86), smoothstep(.35, .7, fbm2(wp * .6)));
  return t * (1. + (vnoise(wp * 3.) - .5) * .3 * detail(wp, .2));
}
// A terrace: slabs half a metre across with dark joints.
vec3 pavingRoof(vec3 c, vec2 wp) {
  vec2 b = blocks(wp, vec2(.5));
  vec3 t = c * (.93 + .12 * b.y);
  t = mix(t * .72, t, smoothstep(0., .02, b.x));
  return mix(c, t, detail(wp, .5)) * (.93 + .12 * fbm(wp * .2));
}
// Age on top of any roof colour: moss in clumps (more on the shaded north slopes), dark
// streaks running down from the ridge, and stains. Each building ages differently, by a
// number taken from its colour. Flat roofs get only a little. c0: the colour before shading.
vec3 roofWeather(vec3 c, vec3 c0, vec2 wp, vec3 n) {
  float seed = fract(sin(dot(c0, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  float age = .25 + .75 * smoothstep(.2, .9, fract(seed * 7.3 + vnoise(wp * .02) * .35));
  float flat_ = smoothstep(.85, .97, n.y);
  vec2 down = normalize(vec2(n.x, -n.z));
  vec2 s = vec2(dot(wp, vec2(-down.y, down.x)), dot(wp, down));
  float north = .5 + .5 * down.y;
  float d = detail(wp, .3);
  float clump = fbm2(wp * .35 + seed * 40.);
  float moss = smoothstep(.5, .72, clump + (north - .5) * .18) * age * mix(.9, .2, flat_) * d;
  c = mix(c, c * vec3(.62, .82, .42) + vec3(.01, .03, 0.), moss * .75);
  float streak = smoothstep(.5, .85, vnoise(vec2(s.x * 2.2 + seed * 50., s.y * .1)));
  c *= 1. - streak * .22 * age * (1. - flat_) * d;
  return c * (1. - .1 * flat_ * age * smoothstep(.5, .8, fbm2(wp * .12 + seed * 9.)));
}
// Weathering on every wall: soot in broad patches, rain streaks running down, and the
// splashed dirt along the bottom. f: along the wall, height, length, style.seed.
vec3 grime(vec3 c, vec4 f) {
  float seed = fract(f.w) * 97.;
  c *= .76 + .34 * fbm2(vec2(f.x * .1 + seed, f.y * .07));
  float streak = fbm2(vec2(f.x * 1.8 + seed, f.y * .12));
  c *= 1. - .28 * smoothstep(.5, .8, streak) * detail(f.xy, .4);
  return c * mix(.66, 1., smoothstep(0., 1.4, f.y));
}
vec3 facade(vec3 c, vec2 f, float bayWidth) {
  float along = f.x, h = f.y;
  float bay = fract(along / bayWidth), storey = fract((h - .6) / 3.4);
  float upper = step(4., h);
  float win = step(.3, bay) * step(bay, .7) * step(.3, storey) * step(storey, .78) * upper;
  float shop = step(.12, bay) * step(bay, .88) * step(.6, h) * step(h, 3.3) * (1. - upper);
  vec3 glass = vec3(.16, .19, .23) + .06 * vnoise(vec2(along, h) * .7);
  float m = max(win, shop * .85);
  float d = detail(f, .9);
  c = mix(c, glass, m * d);
  return mix(c, c * 1.08, (1. - m) * step(.92, storey) * upper * d);           // cornice line
}
`;

// A round hole through the buildings above the player while they're in a passage
// under a building, so the car stays in view: (x, y above which to cut, z, radius).
// Shadows are drawn without it, so the passage stays in the building's shade.
// Graphics settings (graphics.ts): dirt on the paving and grime on the walls (1 on,
// 0 off), and the small leaves on the trees (vegetation.ts).
export const DIRT = { value: 1 };
export const LEAVES = { value: 1 };
// Roof tiles, gravel and weathering; kept separate from wall and ground dirt.
export const ROOF_DETAIL = { value: 1 };

// The weather (weather.ts): how wet the ground is, how much snow lies, how hard it's
// raining (0–1 each), and the colour of the sky mirrored in the puddles.
export const WET = { value: 0 };
export const SNOW = { value: 0 };
// How much of that snow is still on the streets and pavements (weather.ts: all of it
// at night, less and less through the day).
export const STREET_SNOW = { value: 1 };
export const RAIN = { value: 0 };
// How bare the broadleaf trees are (weather.ts): 1 in winter or under snow, their
// leaves falling as it grows; evergreens keep theirs (vegetation.ts).
export const BARE = { value: 0 };
export const SKY_REF = { value: new THREE.Color(0, 0, 0) };
// Lit windows at night: the share of them (0 by day).
export const WINDOWS = { value: 0 };

export const CUTAWAY = { value: new THREE.Vector4(0, 0, 0, 0) };

// When you're in a tunnel, the ground round you is shown as bare earth, cut open
// down to the tunnel: (x, z, radius, 0).
export const DIG = { value: new THREE.Vector4(0, 0, 0, 0) };

// The same hole in any other material (trees, the ground's depth under a tunnel).
export function cutAway<M extends THREE.Material>(material: M, key: string): M {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uCut = CUTAWAY;
    lampLit(sh);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 cutP = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  cutP = instanceMatrix * cutP;
#endif
  vCutWorld = (modelMatrix * cutP).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;\nuniform vec4 uCut;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  if (vCutWorld.y > uCut.y && distance(vCutWorld.xz, uCut.xz) < uCut.w) discard;`);
  };
  material.customProgramCacheKey = () => `cut-${key}`;
  return material;
}

// Landmark roofs: the colour of their tiles (linear) is the mean of the other roofs' palette;
// a texel counts as a red roof by its saturation and hue (roofs in shadow are low in
// saturation, so texels near black count too) on a face pointing up (the ranges are
// smoothsteps); the tiles are drawn at the texel's brightness relative to `light`.
export const LANDMARK_ROOF = {
  rgb: (() => {
    const mean = new THREE.Color(0, 0, 0);
    for (const h of ROOF_TILES) mean.add(new THREE.Color(h));
    mean.multiplyScalar(1 / ROOF_TILES.length);
    return [mean.r, mean.g, mean.b];
  })(),
  light: 0.15, minLight: 0.15, maxLight: 1.7,
  sat: [0.18, 0.3], hue: [0.11, 0.16], black: [0.02, 0.06], face: [0.15, 0.3], flat: [0.94, 0.98],
};

// A landmark: the cutaway, and its roofs, where the photograph shows a red one, drawn with
// the tile pattern of the other roofs at the photograph's brightness. The face's own
// normal comes from derivatives: the model's normals are all "up" for the light.
export function shadeLandmark(material: THREE.MeshLambertMaterial) {
  const R = LANDMARK_ROOF;
  cutAway(material, 'landmark-roof');
  const cut = material.onBeforeCompile;
  material.onBeforeCompile = (sh, r) => {
    cut(sh, r);
    sh.uniforms.uNoise = NOISE;
    sh.uniforms.uRoofDetail = ROOF_DETAIL;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uRoofDetail;\n${NOISE_GLSL}\n${BUILDING_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  vec3 lmFn = cross(dFdx(vCutWorld), dFdy(vCutWorld));
  vec3 lmUp = normalize(lmFn * (lmFn.y < 0. ? -1. : 1.));
  vec3 lmC = diffuseColor.rgb;
  float lmMax = max(lmC.r, max(lmC.g, lmC.b)), lmMin = min(lmC.r, min(lmC.g, lmC.b));
  float lmHue = (lmC.g - lmC.b) / max(lmMax - lmMin, .001) / 6.;
  float lmWarm = max(smoothstep(${R.sat[0]}, ${R.sat[1]}, (lmMax - lmMin) / max(lmMax, .001)) * (1. - smoothstep(${R.hue[0]}, ${R.hue[1]}, lmHue)),
    1. - smoothstep(${R.black[0]}, ${R.black[1]}, dot(lmC, vec3(.299, .587, .114))))
    * step(max(lmC.g, lmC.b), lmC.r + .01) * smoothstep(${R.face[0]}, ${R.face[1]}, lmUp.y) * (1. - smoothstep(${R.flat[0]}, ${R.flat[1]}, lmUp.y));
  if (uRoofDetail > .5) {
  vec3 lmTile = roofTiles(vec3(${R.rgb.map((v) => v.toFixed(4)).join(',')}) * clamp(dot(lmC, vec3(.299, .587, .114)) / ${R.light}, ${R.minLight}, ${R.maxLight}), vec2(vCutWorld.x, -vCutWorld.z), lmUp);
  diffuseColor.rgb = mix(lmC, lmTile, lmWarm);
  }`);
  };
  material.customProgramCacheKey = () => 'landmark-roof';
  return material;
}

export function shadeBuildings(material: THREE.MeshLambertMaterial) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uCut = CUTAWAY;
    sh.uniforms.uNoise = NOISE;
    sh.uniforms.uDirt = DIRT;
    sh.uniforms.uRoofDetail = ROOF_DETAIL;
    sh.uniforms.uFacades = FACADE_ATLAS;
    sh.uniforms.uFacadeOn = FACADE_ON;
    sh.uniforms.uWet = WET;
    sh.uniforms.uSnow = SNOW;
    sh.uniforms.uWindows = WINDOWS;
    lampLit(sh, 'vWorld');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 facade;\nattribute float sky;\nvarying float vSky;\nvarying vec3 vWorld;\nvarying vec3 vWN;\nvarying vec4 vFacade;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWN = normalize(mat3(modelMatrix) * objectNormal);\n  vFacade = facade;\n  vSky = sky;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vSky;\nvarying vec3 vWorld;\nvarying vec3 vWN;\nvarying vec4 vFacade;\nuniform vec4 uCut;\nuniform float uDirt;\nuniform float uRoofDetail;\nuniform float uWet;\nuniform float uSnow;\nuniform float uWindows;\n${NOISE_GLSL}\n${BUILDING_GLSL}\n${FACADE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vWorld.y > uCut.y && distance(vWorld.xz, uCut.xz) < uCut.w) discard;
  vec3 bn = normalize(vWN);
  vec4 fdx = dFdx(vFacade), fdy = dFdy(vFacade);
  vec2 bwp = vec2(vWorld.x, -vWorld.z);
  vec3 roofBase = diffuseColor.rgb;
  // Flat roofs by their material (tileWorker.ts: the facade attribute's w on roofs;
  // 5-9 flat ones, 0 not known), unless it says it's a shallow roof of tiles or metal.
  bool roofWin = abs(vFacade.w - 10.) < .5 && bn.y > .15;
  if (roofWin) diffuseColor.rgb = roofWindow(vFacade);
  else if (uRoofDetail > .5 && bn.y > .97 && (vFacade.w < .5 || vFacade.w > 4.5)) {
    float m = vFacade.w;
    vec3 r;
    if (m > 8.5) r = pavingRoof(roofBase, bwp);
    else if (m > 7.5) r = plantedRoof(roofBase, bwp);
    else if (m > 4.5 && m < 6.5) r = sheetsRoof(roofBase, bwp, m > 5.5 ? 2. : 1.);
    else r = flatRoof(roofBase, bwp);
    diffuseColor.rgb = roofWeather(r, roofBase, bwp, bn);
  }
  else if (uRoofDetail > .5 && bn.y > .15) {
    // The roof's material (tileWorker.ts: the facade attribute's w on roofs).
    float m = vFacade.w;
    vec3 r;
    if (m > 2.5 && m < 4.5) r = sheetRoof(roofBase, bwp, bn, step(3.5, m));
    else if (m > .5 && m < 2.5) r = roofTilesAs(roofBase, bwp, bn, step(1.5, m));
    else r = roofTiles(roofBase, bwp, bn);
    r = roofWeather(r, roofBase, bwp, bn);
    if (bn.y < .5 && vFacade.z > .1) r = mansardWindows(r, vFacade);
    diffuseColor.rgb = r;
  }
  else if (bn.y <= .15) {
    if (uFacadeOn > .5 && vFacade.z > .1) diffuseColor.rgb = facadeModules(diffuseColor.rgb, vFacade, fdx, fdy);
    else if (fBays(vFacade) > .5) diffuseColor.rgb = facade(diffuseColor.rgb, vFacade.xy, vFacade.z / fBays(vFacade));
    if (uDirt > .5) diffuseColor.rgb = grime(diffuseColor.rgb, vFacade);
  }
  // Lit windows at night: dark glass above the ground floor, in a share of the
  // windows by the time; shop windows at street level the same.
  vec3 windowGlow = vec3(0.);
  float bays = fBays(vFacade);
  if (uWindows > .005 && bn.y < .15 && vFacade.z > .1 && bays > .5) {
    vec2 cell = vec2(floor(vFacade.x / vFacade.z * bays), floor((vFacade.y - .6) / 3.4));
    float lit = step(fHash(cell.x + fract(vFacade.w) * 97., cell.y), uWindows * (vFacade.y < 4. ? 1.6 : 1.));
    float glass = 1. - smoothstep(.13, .22, luma(diffuseColor.rgb) / max(luma(vColor.rgb), .02));
    windowGlow = mix(vec3(1., .62, .3), vec3(1., .8, .55), fHash(cell.y, cell.x)) * lit * glass * .55;
  } else if (uWindows > .005 && roofWin) {
    float lit = step(fHash(floor(vWorld.x * .7), floor(vWorld.z * .7)), uWindows * .6);
    windowGlow = mix(vec3(1., .62, .3), vec3(1., .8, .55), fHash(floor(vWorld.z), 3.)) * lit * roofGlass(vFacade) * .45;
  } else if (uWindows > .005 && bn.y > .15 && bn.y < .5 && vFacade.z > .1) {
    float cell = floor(vFacade.x / vFacade.z * max(1., floor(vFacade.z / 3.2 + .5)));
    float lit = step(fHash(cell + vFacade.z * .37, 7.), uWindows);
    windowGlow = mix(vec3(1., .62, .3), vec3(1., .8, .55), fHash(7., cell)) * lit * mansardGlass(vFacade, 0.) * .55;
  }
  // Rain darkens the walls and the roofs; snow lies on the roofs, less on steep ones.
  diffuseColor.rgb *= mix(1., bn.y > .15 ? .72 : .84, uWet);
  if (uSnow > .01 && bn.y > .15) {
    float cover = smoothstep(.0, .25, uSnow * smoothstep(.25, .7, bn.y) * 1.2 - .45 * fbm2(bwp * .4));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.8, .82, .86) * (.93 + .07 * vnoise(bwp * 3.)), cover);
  }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += windowGlow;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse *= mix(${SKY_LEAST.toFixed(2)}, 1., vSky);`);
  };
  material.customProgramCacheKey = () => 'buildings-procedural';
  material.needsUpdate = true;
  return material;
}

// The WebGPU trial's own version (webgpu.ts), set before any ground is made.
let patternedBy: typeof patterned | null = null;
export const setPatterned = (f: typeof patterned) => { patternedBy = f; };

// Add a world-position varying to a Lambert/Standard shader and colour it by pattern.
// `relief`: optional { texture, box } hill shading for a tile, times broad() (see
// tiles.ts).
// `deck`: for a bridge deck, { mask, box } to draw it only where the tile's decks are
// (mask null: everywhere), and with a hole round the player under it (CUTAWAY).
// userData.flatten() makes the same material without the pattern, for measuring what
// the patterns cost (bench.mjs --ab).
export function patterned(
  material: THREE.MeshLambertMaterial,
  id: number,
  time: { value: number },
  relief: { texture: THREE.Texture; box: number[]; sky?: { texture: THREE.Texture; box: number[] } | null } | null = null,
  deck: { mask: THREE.Texture | null; box?: number[] } | null = null,
  dig = false,
  photo: { texture: THREE.Texture; box: number[] } | null = null,
  sheltered = false, // in a tunnel: no rain or snow
): THREE.MeshLambertMaterial {
  if (patternedBy) return patternedBy(material, id, time, relief, deck, dig, photo, sheltered);
  material.userData.flatten = () => patterned(material.clone(), 0, time, relief, deck, dig, photo, sheltered);
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.uniforms.uNoise = NOISE;
    sh.uniforms.uGrit = GRIT;
    sh.uniforms.uDirt = DIRT;
    sh.uniforms.uWet = WET;
    sh.uniforms.uSnow = SNOW;
    sh.uniforms.uStreetSnow = STREET_SNOW;
    sh.uniforms.uRain = RAIN;
    sh.uniforms.uSkyRef = SKY_REF;
    if (photo) {
      sh.uniforms.uPhoto = { value: photo.texture };
      sh.uniforms.uPhotoBox = { value: photo.box };
    }
    sh.uniforms.uRelief = { value: relief?.texture || null };
    sh.uniforms.uReliefBox = { value: relief?.box || [0, 0, 1, 1] };
    sh.uniforms.uReliefOn = { value: relief ? 1 : 0 };
    sh.uniforms.uSky = { value: relief?.sky?.texture || null };
    sh.uniforms.uSkyBox = { value: relief?.sky?.box || [0, 0, 1, 1] };
    sh.uniforms.uSkyOn = { value: relief?.sky ? 1 : 0 };
    if (dig) sh.uniforms.uDig = DIG;
    if (deck) {
      sh.uniforms.uCut = CUTAWAY;
      sh.uniforms.uDeck = { value: deck.mask };
      sh.uniforms.uDeckBox = { value: deck.box };
    }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nuniform sampler2D uRelief; uniform vec4 uReliefBox; uniform float uReliefOn;\nuniform sampler2D uSky; uniform vec4 uSkyBox; uniform float uSkyOn;\n${photo ? 'uniform sampler2D uPhoto; uniform vec4 uPhotoBox;\n' : ''}${deck ? 'uniform vec4 uCut; uniform sampler2D uDeck; uniform vec4 uDeckBox;\n' : ''}${dig ? 'uniform vec4 uDig;\n' : ''}${NOISE_GLSL}\n${PATTERNS_GLSL}\n${WEATHER_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec2 wp = vec2(vWorld.x, -vWorld.z);
${deck ? `  if (vWorld.y > uCut.y && distance(vWorld.xz, uCut.xz) < uCut.w) discard;
${deck.mask ? '  if (texture2D(uDeck, (wp - uDeckBox.xy) / (uDeckBox.zw - uDeckBox.xy)).r < .5) discard;\n' : ''}` : ''}  diffuseColor.rgb = ${photo ? 'texture2D(uPhoto, (wp - uPhotoBox.xy) / (uPhotoBox.zw - uPhotoBox.xy)).rgb' : `pattern(${id}, diffuseColor.rgb, wp)`};
  // Hill shading and the broad variation (broad), baked together for a tile.
  if (uReliefOn > .5) diffuseColor.rgb *= texture2D(uRelief, (wp - uReliefBox.xy) / (uReliefBox.zw - uReliefBox.xy)).r;
  else diffuseColor.rgb *= .93 + .14 * fbm(wp * .004);
  float shine = 0.;
${sheltered ? '' : `  diffuseColor.rgb = weathered(${id}, diffuseColor.rgb, wp, shine);\n`}${dig ? `  if (distance(vWorld.xz, uDig.xy) < uDig.z) diffuseColor.rgb = vec3(.23, .19, .15) * (.8 + .4 * fbm(wp * .7));
` : ''}`);
    lampLit(sh, 'vWorld');
    // Wet ground mirrors the sky and the lamps.
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n  reflectedLight.directDiffuse += shine * (uSkyRef + lampLightOn(vWorld, normal) * .85);\n  // Courtyards and lanes see less of the sky: less ambient light, never less sun or lamplight.\n  if (uSkyOn > .5) reflectedLight.indirectDiffuse *= mix(${SKY_LEAST.toFixed(2)}, 1., texture2D(uSky, (wp - uSkyBox.xy) / (uSkyBox.zw - uSkyBox.xy)).r);`);
  };
  material.customProgramCacheKey = () => `pattern-${id}-${relief ? 1 : 0}${relief?.sky ? 's' : ''}-${deck ? (deck.mask ? 'mask' : 'cut') : ''}-${dig ? 'dig' : ''}${photo ? '-photo' : ''}${sheltered ? '-in' : ''}`;
  return material;
}
