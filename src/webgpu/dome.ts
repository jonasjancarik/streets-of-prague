// The sky seen from the street (first person, and the free camera when it looks towards the
// horizon): blue overhead paling to the haze at the horizon, the sun or the moon with its
// glow, clouds, and stars on a clear night. From straight above none of it shows, and the
// scene's plain backdrop is drawn instead.
//
// The clouds of fair weather are the very ones whose shadows drift over the ground
// (../clouds.ts): each pixel's ray is followed up to the cloud layer and the shadows' pattern
// read where that cloud's shadow falls, so a shadow crossing the street has its cloud in
// the sky. Under a clouded sky a second, broader layer closes over them.
// The colours come from Sky (../sky.ts, DOME), worked out for the time and the weather.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fn, float, vec2, vec3, vec4, texture, positionWorldDirection, cameraPosition, normalize, dot, mix, max, pow, smoothstep, floor, fract, length, step } from 'three/tsl';
import { CLOUD, CLOUD_MAP, CLOUD_SPAN, CLOUD_EDGE } from '../clouds.ts';
import { DOME } from '../sky.ts';
import { type N, followColor, followVec, fbm, fbm2, hash12 } from './common.ts';

const LAYER = 1100; // m: how high the clouds' undersides are
const map = texture(CLOUD_MAP.value);
const uCloud: N = followVec(CLOUD as any);
const uZenith: N = followColor(DOME.zenith), uHorizon: N = followColor(DOME.horizon);
const uLit: N = followColor(DOME.cloudLit), uBase: N = followColor(DOME.cloudBase);
const uDisc: N = followColor(DOME.disc), uGlow: N = followColor(DOME.glow);
const uSun: N = followVec(DOME.sun), uShade: N = followVec(DOME.shade), uAir: N = followVec(DOME.air);

// The sky's colour in a direction, seen from over a spot on the ground (`over`: world x, z).
export const skyAt = (direction: N, over: N): N => Fn(() => {
  const d: N = normalize(direction).toVar();
  const up: N = max(d.y, 0);
  const sky: N = mix(uZenith, uHorizon, pow(float(1).sub(up), 4)).toVar();
  const mu: N = max(dot(d, uSun.xyz), 0).toVar();
  // The glow round the sun: wide and faint, and brighter close to it; warmer and stronger low down.
  sky.addAssign(uGlow.mul(pow(mu, 6).mul(0.5).add(pow(mu, 48).mul(1.2))).mul(float(1).sub(up.mul(0.5))));

  // Where the ray meets the cloud layer, and the shadows' pattern for the cloud there.
  const reach: N = float(LAYER).div(max(d.y, 0.02));
  const at: N = over.add(d.xz.mul(reach)).toVar();
  const shadowAt: N = at.sub(uShade.xz.div(max(uShade.y, 0.2)).mul(LAYER));
  const rank: N = map.sample(shadowAt.div(CLOUD_SPAN).add(uCloud.xy)).level(float(0)).r;
  const drift: N = uCloud.xy.mul(CLOUD_SPAN);
  const rough: N = fbm(at.add(drift).div(380)).sub(0.47).toVar();
  // (A finer ragged edge on top of the broad shape, as a cumulus has.)
  const fine: N = fbm2(at.add(drift).div(75)).sub(0.5);
  const puff: N = rank.add(rough.mul(0.34)).add(fine.mul(0.1)).toVar();
  // (Only the thicker part of what casts a shadow shows as cloud: the thin rim of each is haze.)
  const fair: N = smoothstep(CLOUD_EDGE[0] + 0.06, CLOUD_EDGE[1] + 0.12, puff).mul(uAir.x);
  // How much cloud lies between here and the sun (the same pattern a little way towards
  // it): the side of a cloud turned from the sun is in its own shade.
  const sunward: N = map.sample(shadowAt.add(uShade.xz.mul(170)).div(CLOUD_SPAN).add(uCloud.xy)).level(float(0)).r.add(rough.mul(0.34));
  const ownShade: N = smoothstep(CLOUD_EDGE[0] + 0.02, CLOUD_EDGE[1] + 0.25, sunward).mul(uAir.x);
  // The clouded sky: a broad sheet that closes as the weather does.
  const sheet: N = fbm2(at.add(drift.mul(0.6)).div(1900)).mul(0.7).add(rough.mul(0.25)).add(0.15).toVar();
  const from: N = mix(1.05, -0.12, uAir.y);
  const grey: N = smoothstep(from, from.add(0.4), sheet);
  const cover: N = max(fair, grey).toVar();
  // From below a thick cloud is grey in the middle and bright where it thins out at its edge.
  const thick: N = max(max(smoothstep(CLOUD_EDGE[1] + 0.08, CLOUD_EDGE[1] + 0.45, puff).mul(uAir.x).mul(0.5), ownShade.mul(0.85)), smoothstep(from.add(0.25), from.add(0.8), sheet)).mul(mix(0.75, 1, uAir.y));
  const cloud: N = mix(uLit, uBase, thick).add(uGlow.mul(pow(mu, 10)).mul(float(1).sub(thick)).mul(0.6));
  // Far clouds sink into the haze.
  const near: N = smoothstep(0.03, 0.36, d.y);
  sky.assign(mix(sky, mix(uHorizon, cloud, near.mul(0.75).add(0.25)), cover.mul(near)));

  // The sun's or the moon's disc, where no cloud is in front.
  const edge: N = uSun.w;
  sky.addAssign(uDisc.mul(smoothstep(edge, edge.add(float(1).sub(edge).mul(0.25)), dot(d, uSun.xyz))).mul(float(1).sub(cover)));
  // Stars: one in some of the cells of a lattice on the sky, each a point with its own brightness.
  const cell: N = d.mul(190);
  const id: N = floor(cell), inCell: N = fract(cell).sub(0.5);
  const seed: N = hash12(vec2(id.x.add(id.z.mul(57.3)), id.y.add(id.z.mul(13.7))));
  const star: N = step(0.972, seed).mul(smoothstep(0.26, 0.04, length(inCell))).mul(fract(seed.mul(531)).mul(0.8).add(0.2));
  sky.addAssign(vec3(0.9, 0.93, 1).mul(star).mul(uAir.z).mul(float(1).sub(cover)).mul(smoothstep(0.01, 0.3, d.y)));
  // Below the horizon: the haze.
  return vec4(mix(uHorizon, sky, smoothstep(-0.02, 0.01, d.y)) as N, 1);
})();

export const dome: N = skyAt(positionWorldDirection, cameraPosition.xz);
