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

export const PATTERN = { flat: 0, asphalt: 1, setts: 2, mosaic: 3, slabs: 4, grass: 5, wood: 6, pitch: 7, dirt: 8, concrete: 9, water: 10 };

// Add a world-position varying to a Lambert/Standard shader and colour it by pattern.
export function patterned(material, id, time) {
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n  vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\n${NOISE_GLSL}\n${PATTERNS_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec2 wp = vec2(vWorld.x, -vWorld.z);
  diffuseColor.rgb = pattern(${id}, diffuseColor.rgb, wp) * (.93 + .14 * fbm(wp * .004));`);
  };
  material.customProgramCacheKey = () => `pattern-${id}`;
  return material;
}
