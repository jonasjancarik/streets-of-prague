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
import { Fn, If, float, vec2, vec3, vec4, texture, positionWorldDirection, cameraPosition, normalize, dot, mix, max, min, clamp, atan, mod, pow, smoothstep, floor, fract, length, step } from 'three/tsl';
import { CLOUD, CLOUD_MAP, CLOUD_SPAN } from '../clouds.ts';
import { BANK, CLOUD_BANK, BANK_READY, onCloudBank } from '../cloudBank.ts';
import { DOME } from '../sky.ts';
import { type N, follow, followColor, followVec, fbm2, hash12 } from './common.ts';

const LAYER = 1100; // m: how high the clouds' undersides are
const map = texture(CLOUD_MAP.value);
const bank = texture(CLOUD_BANK.value);
onCloudBank(t => { bank.value = t; });
const bankReady: N = follow(BANK_READY);
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

  // Each texel integrates a ray from the flatter condensation base to the
  // billowing top. Interpolate four nearby views; a low ray gets the whole side
  // of the cloud without drawing it as a stack of horizontal sheets.
  const elevation: N = max(d.y, 0.04);
  const along: N = d.xz.div(elevation).div(CLOUD_SPAN).toVar();
  const origin: N = over.sub(uShade.xz.mul(BANK.shadowHeight).div(max(uShade.y, 0.20))).div(CLOUD_SPAN).add(uCloud.xy).toVar();
  const coverFair: N = float(0).toVar(), lit: N = float(.48).toVar();
  // The cloudy-weather deck is continuous above the fair-weather banks.
  const deckAt: N = over.add(d.xz.mul(float(1800).div(elevation))).add(uCloud.xy.mul(CLOUD_SPAN * .6));
  const deckNoise: N = fbm2(deckAt.div(1900)).mul(.67).add(fbm2(deckAt.div(580)).mul(.23)).add(.08).toVar();
  const deckFrom: N = mix(1.06, -.19, uAir.y);
  const deck: N = smoothstep(deckFrom, deckFrom.add(.39), deckNoise).toVar();
  const deckShade: N = smoothstep(deckFrom.add(.13), deckFrom.add(.77), deckNoise);
  const deckColor: N = mix(uLit, uBase, deckShade.mul(.72).add(.13));
  const distanceHaze: N = smoothstep(.025, .32, d.y);
  sky.assign(mix(sky, mix(uHorizon, deckColor, distanceHaze.mul(.60).add(.40)), deck.mul(distanceHaze)));
  If(uAir.x.greaterThan(.005).and(d.y.greaterThan(.02)), () => {
    If(bankReady.greaterThan(.5), () => {
      const tile = BANK.size + 2 * BANK.border;
      const point = fract(origin.add(along.mul(BANK.shadowHeight))).mul(BANK.size / tile).add(BANK.border / tile).toVar();
      const az = fract(atan(d.z, d.x).div(2 * Math.PI)).mul(BANK.azimuths).toVar();
      const el = clamp(d.y.sub(.10).div(.15), 0, BANK.elevations - 1).toVar();
      const lo = floor(el), hi = min(BANK.elevations - 1, lo.add(1)), left = floor(az), right = mod(left.add(1), BANK.azimuths);
      const read = (x: N, y: N) => bank.sample(point.add(vec2(x, y)).div(vec2(BANK.azimuths, BANK.elevations))).level(float(0));
      const sample = mix(mix(read(left, lo), read(right, lo), fract(az)), mix(read(left, hi), read(right, hi), fract(az)), fract(el)).toVar();
      // Wisps finer than the baked grid. Fade them at the horizon, where several
      // metres project to less than a pixel; the main contour comes from the volume.
      const atCloud = origin.add(along.mul(BANK.shadowHeight)).toVar();
      const details = map.sample(atCloud.mul(4.7).add(vec2(.17, .29))).level(float(0)).r.sub(.5)
        .add(map.sample(atCloud.mul(13.2)).level(float(0)).r.sub(.5).mul(.32)).mul(distanceHaze);
      coverFair.assign(clamp(sample.r.add(details.mul(sample.r).mul(float(1).sub(sample.r)).mul(1.5)), 0, 1));
      const facing = dot(sample.ba.sub(.5).div(.74), uShade.xz);
      lit.assign(clamp(sample.g.add(facing).div(max(.012, sample.r)).add(details.mul(.09)), 0, 1));
    }).Else(() => {
      const rank: N = map.sample(origin.add(along.mul(LAYER))).level(float(0)).r;
      const density: N = smoothstep(.62, .84, rank);
      coverFair.assign(density); lit.assign(.45);
    });
  });
  const fair: N = coverFair.mul(uAir.x).toVar();
  const cloud: N = mix(uBase, uLit, lit.mul(.86).add(.07)).add(uGlow.mul(pow(mu, 12)).mul(.21));
  sky.assign(mix(sky, mix(uHorizon, cloud, distanceHaze.mul(.70).add(.30)), fair.mul(distanceHaze)));
  const cover: N = max(fair, deck);

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
