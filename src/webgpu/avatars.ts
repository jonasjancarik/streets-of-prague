// The avatars' dyed outfits in TSL (DYE_GLSL in ../avatarDyes.ts): the close avatars
// (dyeMaterial) and the middle-distance crowd (streetCrowd.ts). The regions are constants of
// each avatar's graph; the colours come from the mesh being drawn, or the crowd instance.
// (Every material with one key shares a compiled graph, the first one's: see dyeMaterial.)

import * as THREE from 'three';
import { float, vec2, vec3, vec4, uv, attribute, diffuseColor, uniform, smoothstep, step, max, min, dot, distance, pow, mix } from 'three/tsl';
import type { DyeRegions, DyeState } from '../avatarDyes.ts';
import { type N, addPort } from './common.ts';

const inRect = (r: THREE.Vector4, p: N) => step(r.x, p.x).mul(step(p.x, r.z)).mul(step(r.y, p.y)).mul(step(p.y, r.w));

// A texel's colour `c` (linear) at `p` in the body texture (512 units), dyed `top` and `bottom`.
function dyed(d: DyeRegions, c: N, p: N, top: N, bottom: N) {
  const region = (o: number, keep: THREE.Vector4, light: number, ch: N, l: N) => {
    const dist = distance(ch, vec3(keep.x, keep.y, keep.z));
    const key: N = keep.w > 0 ? smoothstep(keep.w, keep.w * 1.6, dist) : keep.w < 0 ? smoothstep(-keep.w, -keep.w * 1.6, dist).oneMinus() : float(1);
    // (The unused rects, all -1, are left out of the graph.)
    let w: N = float(0);
    for (let i = 0; i < 8; i++) if (d.rects[o + i].z > 0) w = max(w, d.keyed[o + i] ? inRect(d.rects[o + i], p).mul(key) : inRect(d.rects[o + i], p));
    return light < 50 ? w.mul(smoothstep(light, light * 1.3, l).oneMinus()) : w;
  };
  const s = pow(max(c, 0), vec3(1 / 2.2));
  const ch = s.div(max(s.r.add(s.g).add(s.b), 1e-3)).toVar();
  const l = dot(c, vec3(.2126, .7152, .0722)).toVar();
  const out = mix(c, top.xyz.mul(min(pow(l.div(d.ref.x), d.ref.z), 2.5)), region(0, d.keep[0], d.light.x, ch, l).mul(top.w)).toVar();
  return mix(out, bottom.xyz.mul(min(pow(l.div(d.ref.y), d.ref.w), 2.5)), region(8, d.keep[1], d.light.y, ch, l).mul(bottom.w));
}

const OFF = new THREE.Vector4();
const worn = (object: THREE.Object3D | null | undefined) => object?.userData.dye as DyeState | undefined;

// The close avatars.
addPort(/^cut-rocketbox-dye-/, (node, legacy) => {
  const d = legacy.userData.dye as DyeState | undefined;
  if (!d) return;
  const top = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => worn(object)?.top ?? OFF);
  const bottom = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => worn(object)?.bottom ?? OFF);
  dyeAfter(node, () => dyed(d, diffuseColor.rgb, uv().mul(512).toVar(), top, bottom));
});

// Dyes the material's own colour once it's worked out (the map's alpha, and the alpha test
// on it, stay as they were: the crowd's hair).
function dyeAfter(node: N, colour: () => N) {
  const proto = Object.getPrototypeOf(node);
  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    diffuseColor.assign(vec4(colour(), diffuseColor.a));
  };
}

// The middle-distance crowd: the body's cell in the atlas (`dyeCell`, scale and offset to
// the body texture's 512 units) and each instance's colours (crowdTop, crowdBottom).
addPort(/^street-crowd-dye-/, (node, legacy) => {
  const d = legacy.userData.dye as DyeRegions | undefined, cell = legacy.userData.dyeCell as THREE.Vector4 | undefined;
  if (!d || !cell) return;
  dyeAfter(node, () => dyed(d, diffuseColor.rgb, uv().mul(vec2(cell.x, cell.y)).add(vec2(cell.z, cell.w)).toVar(),
    attribute('crowdTop', 'vec4'), attribute('crowdBottom', 'vec4')));
});
