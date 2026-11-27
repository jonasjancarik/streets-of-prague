// The avatars' dyed outfits in TSL (DYE_GLSL in ../avatarDyes.ts): the close avatars
// (dyeMaterial) and the middle-distance crowd (streetCrowd.ts). Every material with one key
// shares a compiled graph, the first one's, so one graph serves all fourteen avatars: the
// regions are uniforms read from the mesh being drawn (`userData.dye`), and so are the
// colours, or they come from the crowd instance.

import * as THREE from 'three';
import { float, vec3, vec4, uv, attribute, diffuseColor, uniform, smoothstep, step, max, min, dot, distance, pow, mix, select } from 'three/tsl';
import type { DyeRegions, DyeState } from '../avatarDyes.ts';
import { type N, addPort } from './common.ts';

const inRect = (r: N, p: N) => step(r.x, p.x).mul(step(p.x, r.z)).mul(step(r.y, p.y)).mul(step(p.y, r.w));

// An avatar with no dye (rects nowhere), for an object drawn without one.
const NONE: DyeState = {
  name: '', rects: Array.from({ length: 16 }, () => new THREE.Vector4(-1, -1, -1, -1)), keyed: Array(16).fill(0),
  keep: [new THREE.Vector4(), new THREE.Vector4()], ref: new THREE.Vector4(1, 1, 1, 1), light: new THREE.Vector2(99, 99),
  top: new THREE.Vector4(), bottom: new THREE.Vector4(),
};
const worn = (object: THREE.Object3D | null | undefined) => (object?.userData.dye as DyeState | undefined) ?? NONE;
// A uniform read from each object's dye as it's drawn.
const per = <T>(value: T, read: (d: DyeState, object: THREE.Object3D | null) => T): N =>
  (uniform(value as never) as N).onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => read(worn(object), object));

// The regions' uniforms, made once (module level: see the performance skill's note on
// uniforms made per material). `keyed` goes four rects to a vec4.
const rects = Array.from({ length: 16 }, (_, i) => per(new THREE.Vector4(), d => d.rects[i]));
const keyed = Array.from({ length: 4 }, (_, i) => {
  const v = new THREE.Vector4();
  return per(v, d => v.fromArray(d.keyed, i * 4));
});
const keep = [0, 1].map(i => per(new THREE.Vector4(), d => d.keep[i]));
const ref = per(new THREE.Vector4(), d => d.ref), light = per(new THREE.Vector2(), d => d.light);
const top = per(new THREE.Vector4(), d => d.top), bottom = per(new THREE.Vector4(), d => d.bottom);
const OFF = new THREE.Vector4();
const cell = per(new THREE.Vector4(), (_, object) => (object?.userData.dyeCell as THREE.Vector4 | undefined) ?? OFF);

// A texel's colour `c` (linear) at `p` in the body texture (512 units), dyed `top` and `bottom`.
function dyed(c: N, p: N, top: N, bottom: N) {
  const region = (o: number, keep: N, light: N, ch: N, l: N) => {
    const dist = distance(ch, keep.xyz);
    const key: N = select(keep.w.greaterThan(0), smoothstep(keep.w, keep.w.mul(1.6), dist),
      select(keep.w.lessThan(0), smoothstep(keep.w.negate(), keep.w.mul(-1.6), dist).oneMinus(), float(1)));
    let w: N = float(0);
    for (let i = 0; i < 8; i++) {
      const k = o + i, on: N = keyed[k >> 2]['xyzw'[k & 3]];
      w = max(w, inRect(rects[k], p).mul(mix(1, key, on)));
    }
    return w.mul(smoothstep(light, light.mul(1.3), l).oneMinus());
  };
  const s = pow(max(c, 0), vec3(1 / 2.2));
  const ch = s.div(max(s.r.add(s.g).add(s.b), 1e-3)).toVar();
  const l = dot(c, vec3(.2126, .7152, .0722)).toVar();
  const out = mix(c, top.xyz.mul(min(pow(l.div(ref.x), ref.z), 2.5)), region(0, keep[0], light.x, ch, l).mul(top.w)).toVar();
  return mix(out, bottom.xyz.mul(min(pow(l.div(ref.y), ref.w), 2.5)), region(8, keep[1], light.y, ch, l).mul(bottom.w));
}

// Dyes the material's own colour once it's worked out (the map's alpha, and the alpha test
// on it, stay as they were: the crowd's hair).
function dyeAfter(node: N, colour: () => N) {
  const proto = Object.getPrototypeOf(node);
  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    diffuseColor.assign(vec4(colour(), diffuseColor.a));
  };
}

// The close avatars.
addPort(/^cut-rocketbox-dye$/, (node) => {
  dyeAfter(node, () => dyed(diffuseColor.rgb, uv().mul(512).toVar(), top, bottom));
});

// The middle-distance crowd: the body's cell in the atlas (`dyeCell` on the batch's mesh,
// scale and offset to the body texture's 512 units) and each instance's colours.
addPort(/^street-crowd-dye$/, (node) => {
  dyeAfter(node, () => dyed(diffuseColor.rgb, uv().mul(cell.xy).add(cell.zw).toVar(),
    attribute('crowdTop', 'vec4'), attribute('crowdBottom', 'vec4')));
});
