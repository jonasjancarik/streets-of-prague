// The sun's shadow filter (../softshadow.ts). three.js's own takes five samples of the
// shadow map round each pixel within a fixed radius, which gives every shadow the same
// slightly soft edge, and that is what every tier below Ultra uses. This one is put on the
// sun's shadow only while Ultra is chosen (graphics.ts). It first looks at what
// stands between the pixel and the sun nearby and how far above the pixel that is (a
// handful of the shadow map's depths), and widens the radius with that distance: a
// penumbra. A wall's shadow is then sharp at its foot and soft where it falls across the
// street; a roof 25 m up throws an edge about a metre wide. (The sun's real half-degree
// would make that edge 20 cm; this is about four times it, which reads as soft light
// without smearing the shadows of people and posts, whose height keeps them sharp.)

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Fn, If, float, ivec2, vec2, texture, textureLoad, uniform, renderGroup, reference, screenCoordinate, clamp, max, min,
  interleavedGradientNoise, vogelDiskSample,
} from 'three/tsl';
import { SHADOW_FILTER } from '../softshadow.ts';
import type { N } from './common.ts';

const SEARCH = 5;      // samples looking for what casts the shadow
const SEARCH_M = 1.3;  // …within this far of the pixel on the map (m)
const WIDE = 10;       // samples of a widened edge
const PENUMBRA = 0.036; // metres of edge for every metre the caster stands above the pixel
const WIDEST = 1.6;    // m: no edge wider than this

// The shadow's own numbers, made once for each shadow: the filter is called for every
// material, and uniforms made afresh each time were so many more for the renderer to
// update every frame (a millisecond or two of the main thread on a drive).
const made = new WeakMap<object, { mapSize: N; radius: N; texelM: N; depthM: N }>();
const uniformsOf = (shadow: N) => {
  let u = made.get(shadow);
  if (!u) {
    made.set(shadow, (u = {
      mapSize: reference('mapSize', 'vec2', shadow).setGroup(renderGroup),
      radius: reference('radius', 'float', shadow).setGroup(renderGroup),
      // How many metres a texel of the map covers, and how many its whole depth.
      texelM: uniform(1).setGroup(renderGroup).onRenderUpdate(() => (shadow.camera.right - shadow.camera.left) / shadow.mapSize.x),
      depthM: uniform(1).setGroup(renderGroup).onRenderUpdate(() => shadow.camera.far - shadow.camera.near),
    }));
  }
  return u;
};

const filter = Fn(({ depthTexture, shadowCoord, shadow }: N) => {
  const { mapSize, radius, texelM, depthM } = uniformsOf(shadow);
  const texel: N = vec2(1).div(mapSize);
  const phi: N = (interleavedGradientNoise(screenCoordinate.xy) as N).mul(6.28318530718).toVar();
  const lit = (uv: N): N => (texture(depthTexture, uv) as N).compare(shadowCoord.z);
  const taps = (n: number, r: N): N => {
    let sum: N = float(0);
    for (let i = 0; i < n; i++) sum = sum.add(lit(shadowCoord.xy.add(((vogelDiskSample as N)(i, n, phi) as N).mul(r).mul(texel))));
    return sum.div(n);
  };
  const out: N = float(1).toVar();
  // One filtered sample where the pixel is, then what stands in the sun's way round it and
  // how far above the pixel that is on average. Most pixels end here: nothing near stands
  // in the way and the pixel is lit, or everything does and it is in shade (six reads,
  // about what the five samples below cost). Only an edge goes on to be softened.
  const here: N = lit(shadowCoord.xy).toVar();
  const reach: N = float(SEARCH_M).div(texelM);
  const above: N = float(0).toVar(), high: N = float(0).toVar(), found: N = float(0).toVar();
  for (let i = 0; i < SEARCH; i++) {
    const at: N = shadowCoord.xy.add(((vogelDiskSample as N)(i, SEARCH, phi.add(1.7)) as N).mul(reach).mul(texel));
    const depth: N = ((textureLoad as N)(depthTexture, ivec2((clamp(at, 0, 0.9999) as N).mul(mapSize))) as N).x;
    const gap: N = shadowCoord.z.sub(depth).mul(depthM);
    If(gap.greaterThan(0.06), () => { found.addAssign(1); });
    If(gap.greaterThan(0.25), () => { above.addAssign(gap); high.addAssign(1); });
  }
  If(found.lessThan(0.5).and(here.greaterThan(0.999)), () => { out.assign(1); })
    .ElseIf(found.greaterThan(SEARCH - 0.5).and(here.lessThan(0.001)), () => { out.assign(0); })
    .Else(() => {
      const r: N = float(radius).toVar();
      If(high.greaterThan(0.5), () => { r.assign(max(radius, min(above.div(high).mul(PENUMBRA), WIDEST).div(texelM))); });
      If(r.greaterThan(radius.mul(1.6)), () => { out.assign(taps(WIDE, r)); }).Else(() => { out.assign(taps(5, radius)); });
    });
  return out;
});

SHADOW_FILTER.value = filter;
