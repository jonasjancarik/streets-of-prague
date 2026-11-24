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

uniform sampler2D uShop, uPlaster, uMasks, uStrip, uShopSigns;
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
  float art = vDetail.w >= 1. ? clamp(floor(vDetail.w) - 1., 0., 3.) : floor(streetPick(seed, col, 9.) * 4.);
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
  float footprint = length(fwidth(f.xy));
  if (kind == ${S.masonry}. && layer >= 0. && floor(f.w) != 3.) {
    float u = (fract(f.x / bay) - .5) * bay / min(F_STREET_WIDTH[int(layer)], bay) + .5;
    float v = 1. - fract(f.y < st.x ? clamp(f.y / st.x, 0., .999) : (f.y - st.x) / st.y);
    float mask = texture(uMasks, maskUV(layer, vec2(u, v))).r * (1. - smoothstep(.47, .506, abs(u - .5)));
    float seed = mod(floor(fract(f.w) * 32768.), 997.);
    float composition = floor(fract(f.w * 32768.) * 8.);
    int look = fLook(f);
    int baseLayer = floor(f.w) < 2. && composition >= 5. ? F_ELEVATION[look * 10 + 8]
                                                         : F_WALL[look * 4 + int(streetPick(seed, 0., 3.) * 4.)];
    float datum = f.y < st.x ? float(baseLayer) : layer;
    float row = texture(uMasks, maskUV(datum, vec2(.5, v))).g * 1.25 + .25;
    vec3 pier = stone * row;
    if (look == 8 && composition < 6.) {
      vec2 size = mod(composition, 2.) == 0. ? vec2(.25,.075) : vec2(.92,.44);
      vec2 block = blocks(f.xy, size);
      float joint = 1. - smoothstep(.001, footprint * .55 + .006, block.x);
      pier *= 1. + ((block.y - .5) * .15 - joint * .25) * (1. - smoothstep(size.y * .2, size.y * .7, footprint));
    }
    wall = mix(pier, wall, mask);
  }
  if (kind == ${S.infill}.) wall = stone;
  if (kind == ${S.precast}.) wall = mix(vec3(dot(diffuseColor.rgb, vec3(.30,.59,.11))), vec3(.66,.65,.60), .55);
  if (kind == ${S.metalFrame}.) wall = vec3(.66,.69,.68);
  if (kind == ${S.balconyGlass}.) wall = layer == 125. ? vec3(.16,.21,.24) : vec3(.046,.070,.083);
  if (kind == ${S.shopPaint}. || kind == ${S.canvas}.) wall = diffuseColor.rgb;
  if (kind == ${S.shopSign}.) {
    vec2 at = vec2(clamp(.5 + (.5 - fract(f.x / bay)) * 1.55, .004, .996), (3. - floor(vDetail.w) + fract(vDetail.w)) * .25);
    wall = mix(diffuseColor.rgb, vec3(.81,.72,.53), texture(uShopSigns, at).r);
  }
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
  if (kind == ${S.display}. || kind == ${S.glass}. || kind == ${S.grilleGlass}. || kind == ${S.balconyGlass}.) {
    vec3 n = normalize(vWallNormal), view = normalize(cameraPosition - vWorld), r = reflect(-view, n);
    if (kind == ${S.glass}. && vDetail.w > 0. && vDetail.w < .74) {
      float shift = .12 / max(.19, dot(view, n)), pick = fract(vDetail.w * 17.7);
      float x = (fract(f.x / bay) - .5) * bay - dot(view, vec3(-n.z, 0., n.x)) * shift;
      float y = f.y - view.y * shift;
      float height = f.y < st.x ? y / st.x : (y - st.x) / st.y - floor((f.y - st.x) / st.y);
      bool blind = vDetail.w < .35;
      float cover = blind ? smoothstep(0., .012, height - mix(.32,.71,pick)) : smoothstep(0.,.025, abs(x) - mix(.12,.53,pick));
      vec3 cloth = mix(vec3(.24,.21,.16), vec3(.47,.45,.39), pick) * (blind ? .88 : .82 + .15 * cos(x * 42.));
      wall = mix(wall, cloth, cover * .82);
    }
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
      glow += vec3(.8, .54, .28) * step(fHash(cell + fSeed(f) * 97., floorId), uWindows) * .38;
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
      uShopSigns: { value: facadeFinishes.signs },
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
