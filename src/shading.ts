import * as THREE from 'three';
import { FACADE_ATLAS, FACADE_ON, FACADE_GLSL } from './facades.ts';

// Procedural surface patterns in world space, shared by the ground and the buildings.
// Everything is computed per pixel from the position in metres, so it stays sharp at
// any zoom and needs no textures. Detail fades out once it gets smaller than a pixel.

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
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
vec3 pAsphalt(vec3 c, vec2 p) {
  c *= .9 + .18 * fbm(p * .3);
  c *= mix(1., .9, smoothstep(.62, .66, fbm(p * .07 + 3.)));          // repair patches
  c += (vnoise(p * 16.) - .5) * .07 * detail(p, .06);                  // aggregate
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
  c += (vnoise(p * 5.) - .5) * .07 * detail(p, .2);
  return c;
}
vec3 pWood(vec3 c, vec2 p) { return c * (.75 + .45 * fbm(p * .12)) + (vnoise(p * 3.) - .5) * .05; }
vec3 pPitch(vec3 c, vec2 p) { return pGrass(c, p) * (.94 + .1 * step(.5, fract(p.x / 6.))); }
vec3 pDirt(vec3 c, vec2 p) { return c * (.85 + .25 * fbm(p * .5)) + (vnoise(p * 12.) - .5) * .08 * detail(p, .08); }
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
vec3 pattern(int id, vec3 c, vec2 p) {
  if (id == 1) return pAsphalt(c, p);
  if (id == 2) return pSetts(c, p, vec2(.17, .14));
  if (id == 3) return pMosaic(c, p);
  if (id == 4) return pSlabs(c, p);
  if (id == 5) return pGrass(c, p);
  if (id == 6) return pWood(c, p);
  if (id == 7) return pPitch(c, p);
  if (id == 8) return pDirt(c, p);
  if (id == 9) return pConcrete(c, p);
  if (id == 10) return pWater(c, p);
  return c;
}
`;

export const PATTERN: Record<string, number> = { flat: 0, asphalt: 1, setts: 2, mosaic: 3, slabs: 4, grass: 5, wood: 6, pitch: 7, dirt: 8, concrete: 9, water: 10 };

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
export const CUTAWAY = { value: new THREE.Vector4(0, 0, 0, 0) };

// When you're in a tunnel, the ground round you is shown as bare earth, cut open
// down to the tunnel: (x, z, radius, 0).
export const DIG = { value: new THREE.Vector4(0, 0, 0, 0) };

// The same hole in any other material (trees, the ground's depth under a tunnel).
export function cutAway<M extends THREE.Material>(material: M, key: string): M {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uCut = CUTAWAY;
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
    sh.uniforms.uFacades = FACADE_ATLAS;
    sh.uniforms.uFacadeOn = FACADE_ON;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 facade;\nvarying vec3 vWorld;\nvarying vec3 vWN;\nvarying vec4 vFacade;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWN = normalize(mat3(modelMatrix) * objectNormal);\n  vFacade = facade;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nvarying vec3 vWN;\nvarying vec4 vFacade;\nuniform vec4 uCut;\n${NOISE_GLSL}\n${BUILDING_GLSL}\n${FACADE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (vWorld.y > uCut.y && distance(vWorld.xz, uCut.xz) < uCut.w) discard;
  vec3 bn = normalize(vWN);
  vec4 fdx = dFdx(vFacade), fdy = dFdy(vFacade);
  vec2 bwp = vec2(vWorld.x, -vWorld.z);
  if (bn.y > .97) diffuseColor.rgb = flatRoof(diffuseColor.rgb, bwp);
  else if (bn.y > .15) diffuseColor.rgb = roofTiles(diffuseColor.rgb, bwp, bn);
  else if (uFacadeOn > .5 && vFacade.z > .1) diffuseColor.rgb = facadeModules(diffuseColor.rgb, vFacade, fdx, fdy);
  else diffuseColor.rgb = facade(diffuseColor.rgb, vFacade.xy);`);
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
) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
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
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\nuniform sampler2D uRelief; uniform vec4 uReliefBox; uniform float uReliefOn;\n${photo ? 'uniform sampler2D uPhoto; uniform vec4 uPhotoBox;\n' : ''}${deck ? 'uniform vec4 uCut; uniform sampler2D uDeck; uniform vec4 uDeckBox;\n' : ''}${dig ? 'uniform vec4 uDig;\n' : ''}${NOISE_GLSL}\n${PATTERNS_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec2 wp = vec2(vWorld.x, -vWorld.z);
${deck ? `  if (vWorld.y > uCut.y && distance(vWorld.xz, uCut.xz) < uCut.w) discard;
${deck.mask ? '  if (texture2D(uDeck, (wp - uDeckBox.xy) / (uDeckBox.zw - uDeckBox.xy)).r < .5) discard;\n' : ''}` : ''}  diffuseColor.rgb = ${photo ? 'texture2D(uPhoto, (wp - uPhotoBox.xy) / (uPhotoBox.zw - uPhotoBox.xy)).rgb' : `pattern(${id}, diffuseColor.rgb, wp)`} * (.93 + .14 * fbm(wp * .004));
  if (uReliefOn > .5) diffuseColor.rgb *= texture2D(uRelief, (wp - uReliefBox.xy) / (uReliefBox.zw - uReliefBox.xy)).r * 2.;
${dig ? `  if (distance(vWorld.xz, uDig.xy) < uDig.z) diffuseColor.rgb = vec3(.23, .19, .15) * (.8 + .4 * fbm(wp * .7));
` : ''}`);
  };
  material.customProgramCacheKey = () => `pattern-${id}-${relief ? 1 : 0}-${deck ? (deck.mask ? 'mask' : 'cut') : ''}-${dig ? 'dig' : ''}${photo ? '-photo' : ''}`;
  return material;
}
