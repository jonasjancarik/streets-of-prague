import * as THREE from 'three';
import { FACADE_ATLAS, FACADE_ON, FACADE_GLSL } from './facades.ts';
import { lampLit } from './lamps.ts';

// Procedural surface patterns in world space, shared by the ground and the buildings.
// Everything is computed per pixel from the position in metres, so it stays sharp at
// any zoom and needs no textures. Detail fades out once it gets smaller than a pixel.

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
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
// Irregular stones (Prague mosaic pavement): x = gap to the neighbouring stone, y = random.
vec2 stones(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d1 = 8., d2 = 8., id = 0.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y), o = vec2(hash12(i + g), hash12(i + g + 17.3)) * .8 + .1;
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = hash12(i + g + 5.1); } else if (d < d2) d2 = d;
  }
  return vec2(d2 - d1, id);
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
  c += (vnoise(p * 16.) - .5) * .07 * detail(p, .06);                  // aggregate
  c *= 1. - .14 * smoothstep(.6, .85, vnoise(p * vec2(.9, .25) + 23.)); // oil and tyre marks
  float crack = 1. - smoothstep(.0, .025, abs(vnoise(p * .7) - .5));
  c *= 1. - .3 * crack * detail(p, .15) * smoothstep(.55, .7, vnoise(p * .06 + 2.));
  return c;
}
vec3 pSetts(vec3 c, vec2 p, vec2 size) {
  vec2 b = blocks(p, size);
  vec3 stone = c * (.8 + .4 * b.y) * (.92 + .16 * vnoise(p * 9.));
  vec3 s = mix(c * .5, stone, smoothstep(.004, .02, b.x));
  return mix(c * .85, s, detail(p, size.x)) * (.94 + .12 * fbm(p * .2));
}
vec3 pMosaic(vec3 c, vec2 p) {
  vec2 s = stones(p * 11.);
  float dark = step(.9, s.y);                                          // a few grey stones
  vec3 stone = mix(c * (.9 + .18 * s.y), c * .62, dark);
  vec3 m = mix(c * .6, stone, smoothstep(.03, .12, s.x));
  return mix(c * .9, m, detail(p, .09)) * (.95 + .1 * fbm(p * .25));
}
vec3 pSlabs(vec3 c, vec2 p) {
  vec2 b = blocks(p, vec2(.6, .4));
  vec3 s = mix(c * .72, c * (.9 + .15 * b.y), smoothstep(.004, .015, b.x));
  return mix(c * .95, s, detail(p, .4)) * (.93 + .14 * fbm(p * .15));
}
vec3 pGrass(vec3 c, vec2 p) {
  c *= .82 + .32 * fbm(p * .18);
  c = mix(c, c * vec3(1.12, 1.05, .78), smoothstep(.55, .75, fbm(p * .04 + 7.)));  // dry patches
  c = mix(c, c * vec3(1.05, .9, .7), smoothstep(.6, .8, fbm2(p * .15 + 3.)) * .6);  // worn to earth
  c += (vnoise(p * 5.) - .5) * .07 * detail(p, .2);
  return c;
}
vec3 pWood(vec3 c, vec2 p) { return c * (.75 + .45 * fbm(p * .12)) + (vnoise(p * 3.) - .5) * .05; }
vec3 pPitch(vec3 c, vec2 p) { return pGrass(c, p) * (.94 + .1 * step(.5, fract(p.x / 6.))); }
vec3 pDirt(vec3 c, vec2 p) { return c * (.85 + .25 * fbm(p * .5)) + (vnoise(p * 12.) - .5) * .08 * detail(p, .08); }
// Gravel and railway ballast: packed small stones, a few bigger light and dark ones,
// and faint wheel tracks worn into it.
vec3 pGravel(vec3 c, vec2 p) {
  vec2 s = stones(p * 22.);
  vec3 g = c * (.84 + .3 * s.y) * mix(.7, 1., smoothstep(.02, .1, s.x));
  g = mix(g, c * vec3(1.18, 1.16, 1.12), step(.94, hash12(floor(p * 7.))) * .5);
  c = mix(c * (.93 + .1 * vnoise(p * 4.)), g, detail(p, .05));
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
  return c * (.9 + .2 * fbm(p * .03)) + (vnoise(p * 6.) - .5) * .04 * detail(p, .15);
}
vec3 pConcrete(vec3 c, vec2 p) {
  vec2 b = blocks(p, vec2(3., 2.4));
  return c * (.9 + .12 * fbm(p * .4)) * mix(.8, 1., smoothstep(.01, .04, b.x) * detail(p, 1.) + (1. - detail(p, 1.)));
}
vec3 pWater(vec3 c, vec2 p) {
  float n = fbm(p * vec2(.05, .012) + vec2(0., uTime * .03));
  c *= .88 + .2 * n;
  float glint = smoothstep(.72, .8, fbm(p * vec2(.5, .09) + vec2(uTime * .02, uTime * .12)));
  return c + glint * .1 * detail(p, .5);
}
// Dirt on paved ground: broad grimy patches and smaller stains.
vec3 grit(vec3 c, vec2 p) {
  if (uDirt < .5) return c;
  c *= 1. - .22 * smoothstep(.3, .85, fbm2(p * .13 + 5.));
  return c * (1. - .12 * smoothstep(.55, .85, fbm2(p * .6 + 17.)) * detail(p, .6));
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
  bool paved = id <= 4 || id == 9;
  if (uWet > .01) {
    c *= mix(1., paved ? .6 : .78, uWet);
    if (paved) {
      float puddle = smoothstep(.6, .66, fbm2(p * .22 + 31.) * .8 + fbm2(p * .03 + 7.) * .3) * smoothstep(.35, .9, uWet);
      shine = (.1 + .5 * puddle) * uWet;
      c *= 1. - .35 * puddle;
      if (uRain > .01) shine += ripples(p) * puddle * uRain * .8 * detail(p, .12);
    }
  }
  if (uSnow > .01) {
    float lie = id == 1 || id == 2 ? .55 : paved ? .8 : 1.;
    float n = fbm2(p * .3 + 9.);
    float cover = smoothstep(n * .6, n * .6 + .25, uSnow * lie * 1.15);
    vec3 snow = vec3(.78, .8, .84) * (.94 + .06 * vnoise(p * 4.));
    if (id == 1 || id == 2) snow = mix(snow * vec3(.72, .7, .68), c, .35 * (1. - uSnow));   // slush
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
vec3 roofTiles(vec3 c, vec2 wp, vec3 n) {
  vec2 down = normalize(vec2(n.x, -n.z));
  vec2 across = vec2(-down.y, down.x);
  float slate = step(max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)), .08);   // grey roofs
  vec2 size = mix(vec2(.26, .32), vec2(.3, .22), slate);
  vec2 q = vec2(dot(wp, across), dot(wp, down) / max(n.y, .3));
  vec2 b = blocks(q, size);
  float row = fract(q.y / size.y);
  float d = detail(wp, size.y);
  vec3 t = c * (.9 + .2 * b.y);
  t *= .8 + .25 * smoothstep(0., .4, row);                                     // overlap shadow
  t = mix(t * .72, t, smoothstep(0., .012, b.x));
  c = mix(c * .95, t, d);
  c *= .88 + .24 * fbm(wp * .22);                                              // weathering
  return mix(c, c * vec3(.86, .9, .8), smoothstep(.62, .75, fbm(wp * .09 + 4.)) * .7);
}
vec3 flatRoof(vec3 c, vec2 wp) {
  c *= .86 + .22 * fbm(wp * .5);
  return c + (vnoise(wp * 18.) - .5) * .08 * detail(wp, .05);
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
vec3 facade(vec3 c, vec2 f) {
  float along = f.x, h = f.y;
  float bay = fract(along / 1.9), storey = fract((h - .6) / 3.4);
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

// The weather (weather.ts): how wet the ground is, how much snow lies, how hard it's
// raining (0–1 each), and the colour of the sky mirrored in the puddles.
export const WET = { value: 0 };
export const SNOW = { value: 0 };
export const RAIN = { value: 0 };
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

export function shadeBuildings(material: THREE.MeshLambertMaterial) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uCut = CUTAWAY;
    sh.uniforms.uDirt = DIRT;
    sh.uniforms.uFacades = FACADE_ATLAS;
    sh.uniforms.uFacadeOn = FACADE_ON;
    sh.uniforms.uWet = WET;
    sh.uniforms.uSnow = SNOW;
    sh.uniforms.uWindows = WINDOWS;
    lampLit(sh, 'vWorld');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 facade;\nvarying vec3 vWorld;\nvarying vec3 vWN;\nvarying vec4 vFacade;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWN = normalize(mat3(modelMatrix) * objectNormal);\n  vFacade = facade;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nvarying vec3 vWN;\nvarying vec4 vFacade;\nuniform vec4 uCut;\nuniform float uDirt;\nuniform float uWet;\nuniform float uSnow;\nuniform float uWindows;\n${NOISE_GLSL}\n${BUILDING_GLSL}\n${FACADE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vWorld.y > uCut.y && distance(vWorld.xz, uCut.xz) < uCut.w) discard;
  vec3 bn = normalize(vWN);
  vec4 fdx = dFdx(vFacade), fdy = dFdy(vFacade);
  vec2 bwp = vec2(vWorld.x, -vWorld.z);
  if (bn.y > .97) diffuseColor.rgb = flatRoof(diffuseColor.rgb, bwp);
  else if (bn.y > .15) diffuseColor.rgb = roofTiles(diffuseColor.rgb, bwp, bn);
  else {
    if (uFacadeOn > .5 && vFacade.z > .1) diffuseColor.rgb = facadeModules(diffuseColor.rgb, vFacade, fdx, fdy);
    else diffuseColor.rgb = facade(diffuseColor.rgb, vFacade.xy);
    if (uDirt > .5) diffuseColor.rgb = grime(diffuseColor.rgb, vFacade);
  }
  // Lit windows at night: dark glass above the ground floor, in a share of the
  // windows by the time; shop windows at street level the same.
  vec3 windowGlow = vec3(0.);
  if (uWindows > .005 && bn.y < .15 && vFacade.z > .1) {
    float bays = max(1., floor(vFacade.z / 1.9 + .5));
    vec2 cell = vec2(floor(vFacade.x / vFacade.z * bays), floor((vFacade.y - .6) / 3.4));
    float lit = step(fHash(cell.x + fract(vFacade.w) * 97., cell.y), uWindows * (vFacade.y < 4. ? 1.6 : 1.));
    float glass = 1. - smoothstep(.2, .35, luma(diffuseColor.rgb) / max(luma(vColor.rgb), .02));
    windowGlow = mix(vec3(1., .62, .3), vec3(1., .8, .55), fHash(cell.y, cell.x)) * lit * glass * .55;
  }
  // Rain darkens the walls and the roofs; snow lies on the roofs, less on steep ones.
  diffuseColor.rgb *= mix(1., bn.y > .15 ? .72 : .84, uWet);
  if (uSnow > .01 && bn.y > .15) {
    float cover = smoothstep(.0, .25, uSnow * smoothstep(.25, .7, bn.y) * 1.2 - .45 * fbm2(bwp * .4));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.8, .82, .86) * (.93 + .07 * vnoise(bwp * 3.)), cover);
  }`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += windowGlow;');
  };
  material.customProgramCacheKey = () => 'buildings-procedural';
  material.needsUpdate = true;
  return material;
}

// Add a world-position varying to a Lambert/Standard shader and colour it by pattern.
// `relief`: optional { texture, box } hill shading for a tile (see tiles.ts).
// `deck`: for a bridge deck, { mask, box } to draw it only where the tile's decks are
// (mask null: everywhere), and with a hole round the player under it (CUTAWAY).
export function patterned(
  material: THREE.MeshLambertMaterial,
  id: number,
  time: { value: number },
  relief: { texture: THREE.Texture; box: number[] } | null = null,
  deck: { mask: THREE.Texture | null; box?: number[] } | null = null,
  dig = false,
  photo: { texture: THREE.Texture; box: number[] } | null = null,
  sheltered = false, // in a tunnel: no rain or snow
) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.uniforms.uDirt = DIRT;
    sh.uniforms.uWet = WET;
    sh.uniforms.uSnow = SNOW;
    sh.uniforms.uRain = RAIN;
    sh.uniforms.uSkyRef = SKY_REF;
    if (photo) {
      sh.uniforms.uPhoto = { value: photo.texture };
      sh.uniforms.uPhotoBox = { value: photo.box };
    }
    sh.uniforms.uRelief = { value: relief?.texture || null };
    sh.uniforms.uReliefBox = { value: relief?.box || [0, 0, 1, 1] };
    sh.uniforms.uReliefOn = { value: relief ? 1 : 0 };
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
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nuniform sampler2D uRelief; uniform vec4 uReliefBox; uniform float uReliefOn;\n${photo ? 'uniform sampler2D uPhoto; uniform vec4 uPhotoBox;\n' : ''}${deck ? 'uniform vec4 uCut; uniform sampler2D uDeck; uniform vec4 uDeckBox;\n' : ''}${dig ? 'uniform vec4 uDig;\n' : ''}${NOISE_GLSL}\n${PATTERNS_GLSL}\n${WEATHER_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec2 wp = vec2(vWorld.x, -vWorld.z);
${deck ? `  if (vWorld.y > uCut.y && distance(vWorld.xz, uCut.xz) < uCut.w) discard;
${deck.mask ? '  if (texture2D(uDeck, (wp - uDeckBox.xy) / (uDeckBox.zw - uDeckBox.xy)).r < .5) discard;\n' : ''}` : ''}  diffuseColor.rgb = ${photo ? 'texture2D(uPhoto, (wp - uPhotoBox.xy) / (uPhotoBox.zw - uPhotoBox.xy)).rgb' : `pattern(${id}, diffuseColor.rgb, wp)`} * (.93 + .14 * fbm(wp * .004));
  if (uReliefOn > .5) diffuseColor.rgb *= texture2D(uRelief, (wp - uReliefBox.xy) / (uReliefBox.zw - uReliefBox.xy)).r * 2.;
  float shine = 0.;
${sheltered ? '' : `  diffuseColor.rgb = weathered(${id}, diffuseColor.rgb, wp, shine);\n`}${dig ? `  if (distance(vWorld.xz, uDig.xy) < uDig.z) diffuseColor.rgb = vec3(.23, .19, .15) * (.8 + .4 * fbm(wp * .7));
` : ''}`);
    lampLit(sh, 'vWorld');
    // Wet ground mirrors the sky and the lamps.
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.directDiffuse += shine * (uSkyRef + lampLight(vWorld) * .85);');
  };
  material.customProgramCacheKey = () => `pattern-${id}-${relief ? 1 : 0}-${deck ? (deck.mask ? 'mask' : 'cut') : ''}-${dig ? 'dig' : ''}${photo ? '-photo' : ''}${sheltered ? '-in' : ''}`;
  return material;
}
