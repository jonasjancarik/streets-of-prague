// The legacy WebGL renderer shares the measured openings, material codes and
// atlases of the WebGPU street walls. Three's Lambert shader supplies live
// lighting and shadows. Only the nearby replacement meshes use this program.
import { streetFacadeMaterial as material } from './streetFacades.ts';
import { F_SURFACE as S, FACADE_ATLAS, FACADE_GLSL, FACADE_ON, STREET_FACADE } from './facades.ts';
import { facadeFinishes, shopReady, shopTexture } from './facadeFinishes.ts';
import { CUTAWAY, NOISE, NOISE_GLSL, SKY_LEAST, SKY_REF, WET, WINDOWS } from './shading.ts';
import { KINDS, STRIPS, STRIPS_ON } from './reflections.ts';
import { lampLit } from './lamps.ts';

const vertex = `varying vec4 vFacade, vDetail;
varying float vRows;
varying vec3 vWorld, vWallNormal;
varying float vWallSky;`;
const functions = `

uniform sampler2D uShop, uPlaster, uMasks, uStrip;
uniform float uShopReady, uStripOn, uWet, uWindows;
uniform vec4 uCut;
uniform vec3 uSkyRef;
vec2 maskUV(float layer, vec2 p) {
  return (vec2(mod(layer, 6.), floor(layer / 6.)) + clamp(p, vec2(.016, .009), vec2(.984, .991))) /
         vec2(6., 24.);
}
vec3 shopRoom(vec4 f, vec3 eye, vec3 n) {
  vec2 size = vec2(2. * f.z / max(1., fBays(f)), fStorey(f).x);
  float col = floor(f.x / size.x), seed = floor(fract(f.w) * 32768.);
  float art = floor(streetPick(seed, col, 9.) * 4.);
  vec3 ray = vec3(dot(eye, vec3(n.z, 0., -n.x)), eye.y, max(.001, -dot(eye, n)));
  vec2 face = vec2((1. - fract(f.x / size.x)) * size.x, f.y);
  vec2 sides = mix(face, size - face, step(vec2(0.), ray.xy)) / max(abs(ray.xy), vec2(.001));
  float back = 1.05 / ray.z, travel = max(0., min(back, min(sides.x, sides.y)));
  vec3 hit = vec3(face, 0.) + ray * travel;
  vec2 uv = clamp(hit.xy / size, vec2(.012), vec2(.988));
  vec3 stock = textureLod(uShop, (vec2(mod(art, 2.), 1. - floor(art / 2.)) + uv) * .5,
                          clamp(log2(max(1., distance(cameraPosition, vWorld) / 4.)), 0., 5.))
                   .rgb;
  vec3 trim = mix(vec3(.155, .115, .078), vec3(.30, .265, .213), smoothstep(.12, .16, uv.y));
  vec3 lining = (sides.x < sides.y ? trim : (ray.y > 0. ? vec3(.39, .35, .28) : vec3(.125, .081, .055))) *
                mix(1., .62, hit.z / 1.05);
  float lit = mix(.07, .6, step(.33, streetPick(seed, col, 10.)));
  return mix(lining, stock, step(back, min(sides.x, sides.y) + .0001)) *
         mix(.68, lit, smoothstep(.01, .09, uWindows));
}
`;
const paint = `
  if (vWorld.y > uCut.y && distance(vWorld.xz, uCut.xz) < uCut.w) discard;
  vec4 f = vFacade;
  float layer = floor(vDetail.x + .5), kind = floor(vDetail.z + .5), bays = max(1., fBays(f));
  vec3 stone = diffuseColor.rgb * .79;
  vec3 wall = facadeModuleAt(diffuseColor.rgb, f, dFdx(f), dFdy(f), layer);
  vec2 st = fStorey(f);
  float bay = f.z / bays;
  if (kind == ${S.masonry}. && layer >= 0.) {
    float u = (fract(f.x / bay) - .5) * bay / min(F_MOD[fLook(f)], bay) + .5;
    float v = 1. - fract(f.y < st.x ? clamp(f.y / st.x, 0., .999) : (f.y - st.x) / st.y);
    float mask = texture(uMasks, maskUV(layer, vec2(u, v))).r * (1. - smoothstep(.47, .506, abs(u - .5)));
    float seed = mod(floor(fract(f.w) * 32768.), 997.);
    float datum = f.y < st.x
                      ? float(F_WALL[fLook(f) * 4 + int(streetPick(seed, floor(f.x / bay / 6.), 3.) * 4.)])
                      : layer;
    float row = texture(uMasks, maskUV(datum, vec2(.5, v))).g * 1.25 + .25;
    wall = mix(stone * row, wall, mask);
  }
  if (kind == ${S.infill}.) wall = stone;
  if (kind == ${S.brass}.) wall = vec3(.131, .102, .064);
  if (kind == ${S.iron}.) wall = vec3(.031, .034, .033);
  if (kind == ${S.grilleGlass}.) wall = vec3(.022, .032, .040);
  if (kind >= ${S.reveal}. && kind <= ${S.plinth}.) {
    stone = mix(stone, vec3(dot(stone, vec3(.2126, .7152, .0722))), kind == ${S.plinth}. ? .3 : .1);
    wall = kind == ${S.dressedStone}. ? mix(stone, vec3(.67, .61, .50), fTwoTone(f) * .24) * 1.1
                           : stone * (kind == ${S.plinth}. ? .76 : 1.);
  }
  bool masonry = kind == ${S.masonry}. || (kind >= ${S.reveal}. && kind <= ${S.plinth}.);
  vec3 scan = texture(uPlaster, (f.xy + vec2(.71, .83) * vDetail.w) * .5).rgb - .5;
  if (masonry) wall *= 1. + scan.r * .52;
  float contact = kind == ${S.reveal}. ? clamp(1. + vDetail.w * 1.25, .60, 1.) : 1.;
  vec3 glow = vec3(0.);
  if (kind == ${S.display}. || kind == ${S.glass}. || kind == ${S.grilleGlass}.) {
    vec3 n = normalize(vWallNormal), view = normalize(cameraPosition - vWorld), r = reflect(-view, n);
    float fresnel = .10 + .48 * pow(1. - abs(dot(view, n)), 4.);
    int style = int(floor(f.w)), zone = style == 1 ? 0 : style == 3 ? 2 : style == 4 ? 3 : 1;
    float h = .806 * (1. - r.y / max(length(r.xz), .001) / .7);
    vec4 strip = textureLod(
        uStrip, vec2(atan(r.z, r.x) / 6.2831853 + .5, 1. - (float(zone) + clamp(h, .01, .99)) / ${KINDS.length}.), 1.5);
    glow = strip.rgb * strip.a * fresnel * uStripOn * (1. - smoothstep(.42, .77, r.y)) * (1. - uWindows * .80);
    if (kind == ${S.display}. && uShopReady > .5) {
      wall = vec3(.010, .014, .016);
      glow += shopRoom(f, -view, n) * (1. - fresnel) + uSkyRef * smoothstep(.01, .4, r.y) * fresnel * vWallSky;
    } else {
      float floorId = floor((f.y - st.x) / st.y), cell = floor(f.x / bay);
      glow += vec3(.8, .54, .28) * step(fHash(cell + fract(f.w) * 97., floorId), uWindows) * .38;
    }
  }
  diffuseColor.rgb = wall * vDetail.y * contact * mix(1., .84, uWet);
`;

export function configureStreetFacadeGL() {
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uNoise: NOISE,
      uFacades: FACADE_ATLAS,
      uFacadeOn: FACADE_ON,
      uStreetFacade: STREET_FACADE,
      uCut: CUTAWAY,
      uWet: WET,
      uWindows: WINDOWS,
      uSkyRef: SKY_REF,
      uStrip: STRIPS,
      uStripOn: STRIPS_ON,
      uMasks: { value: facadeFinishes.masks },
      uPlaster: { value: facadeFinishes.plaster },
      uShop: shopTexture,
      uShopReady: shopReady,
    });
    sh.vertexShader = sh.vertexShader.replace(
      '#include <common>',
      '#include <common>\nattribute vec4 facade, detail;\nattribute float sky;\n' + vertex,
    )
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorld=(modelMatrix*vec4(transformed,1.)).xyz;vWallNormal=normalize(mat3(modelMatrix)*objectNormal);vFacade=vec4(facade.xy,mod(facade.z,1024.),facade.w);vRows=floor(facade.z/1024.);vDetail=detail;vWallSky=sky;',
      );
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <common>',
      '#include <common>\n' + vertex + '\n' + NOISE_GLSL + '\n' + FACADE_GLSL + '\n' + functions,
    )
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + paint)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance+=glow;')
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nif(masonry){vec3 n=normalize(vWallNormal),across=vec3(n.z,0.,-n.x);normal=normalize(normal+mat3(viewMatrix)*(across*scan.g+cross(across,n)*scan.b)*.41);}',
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\nreflectedLight.indirectDiffuse*=mix(${SKY_LEAST.toFixed(2)},1.,vWallSky);`,
      );
    lampLit(sh, 'vWorld');
  };
  material.needsUpdate = true;
}
