// The river and ponds, seen from above: wind ripples over a slow swell that tilt the
// surface, so it catches the sun and the sky's light unevenly (the tilted normal goes to
// the material's ordinary lighting, shadows included), mirrors more of the sky where it
// leans away from you, glitters towards the sun or the moon, and breaks up the lamps'
// light at night. Rain rings it and makes it choppier. A setting (WATER in shading.ts,
// Graphics.water); without it the water is the plain mottled colour.
// Per pixel: 4 noise reads for the waves, 2 more close up for the glitter.

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Fn, If, float, vec2, vec3, vec4, uniform, renderGroup, cameraPosition, normalize, reflect, dot, pow, max, min, floor, fract, length, abs, smoothstep, mix, clamp, mod, atan, asin, sqrt, texture, cos, fwidth,
} from 'three/tsl';
import { skyAt } from './dome.ts';
import { WATER, SUN_DIR, SUN_LIGHT, BARE } from '../shading.ts';
import { riverBanks } from '../riverReflection.ts';
import { DOME } from '../sky.ts';
import { RIVER_MIRROR } from '../mirror.ts';
import { type N, follow, followColor, followVec, uRain, hash12, vnoise, detail } from './common.ts';

export const uWater = follow(WATER);
export const uStreetRiver = follow(riverBanks.street);
const uBanks = follow(riverBanks.strength), uBetween = follow(riverBanks.mix), uBareBank = follow(BARE);
const horizon = followColor(DOME.horizon), zenith = followColor(DOME.zenith);
const bankA = followVec(riverBanks.a), bankB = followVec(riverBanks.b);
const banks = texture(riverBanks.map);
riverBanks.onLoad = map => { banks.value = map; };
const models = texture(RIVER_MIRROR.target.texture), modelMirror = follow(RIVER_MIRROR.active);
const projection = uniform(RIVER_MIRROR.matrix.clone()).setGroup(renderGroup);
projection.onRenderUpdate(() => { projection.value.copy(RIVER_MIRROR.matrix); return projection.value; });
const uSunLight: N = followColor(SUN_LIGHT);
const uSunDir: N = (() => {
  const u = uniform(SUN_DIR.value.clone()).setGroup(renderGroup);
  u.onRenderUpdate(() => { u.value.copy(SUN_DIR.value); return u.value; });
  return u;
})();

const SWELL = 0.3, RIPPLE = 0.16; // how steep the two layers get
const SKY = 5.3;                  // SKY_REF is 0.06 of the sky's light; a mirror shows about a third of it
const FLAT_MIRROR = 0.2;          // from how much of a mirror the water reads the real sky
const BANK = 0.3;                 // how dark the far bank's band is in it

// How much of a mirror still water is from here (0.05 from straight above, 0.95 along it):
// that much less of its own colour shows (webgpu.ts, pWater).
export const flatMirror = (w: N): N => pow(float(1).sub(max(normalize(cameraPosition.sub(w)).y, 0)), 3).mul(0.9).add(0.05);

// Rings spreading from a drop in each cell (the puddles' and the water's).
export function ripples(p0: N, time: N) {
  const p = p0.mul(2.5), i = floor(p), f = fract(p);
  const t = fract(time.mul(1.1).add(hash12(i)));
  const c = vec2(hash12(i.add(1.7)), hash12(i.add(4.3))).mul(0.6).add(0.2);
  return t.oneMinus().mul(smoothstep(0, 0.07, abs(length(f.sub(c)).sub(t.mul(0.45)))).oneMinus());
}

// The map turned by an angle, so that the noise's square lattice doesn't line up with the screen.
const turned = (p: N, a: number) => vec2(p.x.mul(Math.cos(a)).sub(p.y.mul(Math.sin(a))), p.x.mul(Math.sin(a)).add(p.y.mul(Math.cos(a))));

// The slope of the surface at a point of the map (x east, y north); none with the water off.
export const waves = (p: N, time: N, quiet: boolean): N => Fn(() => {
  const s = vec2(0).toVar();
  If(uWater.greaterThan(0.5), () => {
    const original = () => {
      const b = turned(p,-.9).mul(vec2(1.1,.62)).add(vec2(time.mul(-.4),time.mul(.27)));
      s.assign(vec2(vnoise(b),vnoise(b.add(19.4))).sub(.5).mul(quiet ? .04 : RIPPLE));
      if (quiet) return;
      const a = turned(p, 0.5).mul(vec2(0.13, 0.21)).add(vec2(time.mul(0.06), time.mul(0.1)));
      s.addAssign(vec2(vnoise(a),vnoise(a.add(37.2))).sub(.5).mul(SWELL));
    };
    if (quiet) original();
    else If(uStreetRiver.greaterThan(.5), () => {
      // Slopes of two wind waves with a longer current beneath them. Their
      // crests remain coherent across the surface; a wavelength smaller than
      // a pixel contributes to roughness instead of flickering at the horizon.
      const q = turned(p,-.48).toVar();
      const a = q.y.mul(15.1).add(q.x.mul(1.8));
      const b = q.y.mul(7.8).sub(q.x.mul(2.5));
      const phase = vnoise(q.mul(.36).add(time.mul(.075))).sub(.5);
      const drift = vnoise(q.mul(.14).add(vec2(18,time.mul(-.042)))).sub(.5);
      const gust = vnoise(q.mul(vec2(.61,.22)).add(time.mul(.11))).toVar();
      const small = cos(a.add(phase.mul(7.1)).add(gust.mul(2.5)).sub(time.mul(4.2))).mul(.047).mul(gust.mul(.97).add(.35))
        .mul(float(1).sub(smoothstep(.65,2.9,fwidth(a))));
      const wind = cos(b.add(drift.mul(7.3)).sub(time.mul(2.65))).mul(.033).mul(gust.mul(-.50).add(1.19))
        .mul(float(1).sub(smoothstep(.65,2.9,fwidth(b))));
      const cross = cos(q.x.mul(4.1).add(q.y.mul(2.6)).add(phase.mul(3)).sub(time.mul(1.65))).mul(.012);
      const swell = cos(q.y.mul(1.15).add(q.x.mul(.48)).add(drift.mul(4)).sub(time.mul(.67))).mul(.017);
      s.assign(turned(vec2(small.mul(.12).sub(wind.mul(.32)).add(swell.mul(.42)).add(cross),small.add(wind).add(swell).add(cross.mul(.63))),.48));
    }).Else(original);
    s.mulAssign(uRain.mul(0.6).add(1));
  });
  return s;
})();
// (The map's north is the world's −z.)
export const waveNormal = (s: N) => normalize(vec3(s.x.negate(), 1, s.y));

// The smaller depth views occupy the bottom of the atlas. Correct the ray for
// the distance to the photographed façade, tree or shore, in two-metre steps.
const azimuth = (d: N) => fract(atan(d.x,d.z.negate()).mul(1/(2*Math.PI)).add(.5));
function bankFrom(station: N, w: N, r: N) {
  const cell = vec2(mod(station.w,4).mul(512),floor(station.w.div(4)).mul(66));
  const sample = (angle: N, row: N) => banks.sample(vec2(
    cell.x.add(2.5).add(angle.mul(507)).div(2048),
    float(1).sub(cell.y.add(row).div(1024)))).level(float(0));
  const depthCell = vec2(mod(station.w,8).mul(256),floor(station.w.div(8)).mul(48).add(736));
  const heightInView = (y: N) => clamp(float(33*Math.PI/180).sub(asin(clamp(y,-1,1))).div(36*Math.PI/180),0,1);
  const lookup = vec2(depthCell.x.add(2.5).add(azimuth(r).mul(251)).div(2048),
    float(1).sub(depthCell.y.add(2.5).add(heightInView(r.y).mul(43)).div(1024)));
  const radius = max(5,banks.sample(lookup).level(float(0)).a.mul(510));
  const dir = normalize(r.xz), offset = w.xz.sub(station.xz);
  const local = offset.mul(min(1,radius.mul(.86).div(max(1,length(offset)))));
  const along = dot(local,dir);
  const travel = sqrt(max(1,along.mul(along).add(radius.mul(radius)).sub(dot(local,local)))).sub(along);
  const at = local.add(dir.mul(travel));
  const up = w.y.sub(station.y).add(r.y.mul(travel).div(max(.15,length(r.xz))));
  const look = normalize(vec3(at.x,up,at.y));
  const elevation = asin(clamp(look.y,-1,1));
  const row = clamp(float(33*Math.PI/180).sub(elevation).div(36*Math.PI/180),0,1).mul(61).add(2.5);
  const c = sample(azimuth(look),row);
  const range = float(1).sub(smoothstep(145,275,length(offset)));
  const top = float(1).sub(smoothstep(.47,.575,elevation));
  const leafy = smoothstep(.004,.052,c.g.sub(max(c.r,c.b)));
  const samePool = float(1).sub(smoothstep(1.5,4,abs(w.y.sub(station.y))));
  const coverage = c.a.mul(range).mul(top).mul(samePool).mul(float(1).sub(leafy.mul(uBareBank).mul(.60)));
  return vec4(c.rgb.mul(coverage),coverage);
}

// The light the surface mirrors: the sky, the sun's glitter and the lamps (`lamps`: their
// light there, read a little aside by the slope so that it wavers).
export function waterShine(w: N, p: N, s: N, time: N, skyRef: N, lamps: N, quiet: boolean) {
  const out = vec3(0).toVar();
  const near = detail(p, 0.5); // (derivatives outside the branch)
  If(uWater.greaterThan(0.5), () => {
    const v = normalize(cameraPosition.sub(w)).toVar(), n = waveNormal(s).toVar();
    const r = reflect(v.negate(), n);
    // More of a mirror the more it leans away, and the sky is lighter towards the horizon.
    const mirror = pow(float(1).sub(max(dot(n, v), 0)), 3).mul(0.9).add(0.05).toVar();
    out.assign(skyRef.mul(SKY).mul(float(1.5).sub(r.y.mul(0.5))).mul(mirror));
    // Seen at a slant (from the street, a bridge, a boat) it is a real mirror: the sky in the
    // direction it reflects, clouds, the sun's glow and its disc broken up by the ripples, and
    // low down a darker band for the far bank. From above the slant never gets this far, and
    // the sky is not read (webgpu/dome.ts: eight noise reads).
    If(mirror.greaterThan(FLAT_MIRROR), () => {
      const up: N = vec3(r.x, max(r.y, 0.03), r.z);
      const oldBand = mix(BANK,1,smoothstep(.03,.14,up.y));
      const bankBand = quiet ? oldBand : mix(oldBand,mix(.63,.95,smoothstep(0,.23,up.y)),uStreetRiver);
      // Check the hulls and stonework first. A solid reflection hides the
      // detailed sky and both photographed banks behind it.
      const model = vec4(0).toVar();
      if (!quiet) If(modelMirror.greaterThan(.5), () => {
        const projected = projection.mul(vec4(w,1));
        const uv = projected.xy.div(projected.w).add(vec2(s.x.add(s.y.mul(.27)),s.y).mul(vec2(.20,.145)));
        If(projected.w.greaterThan(0).and(uv.x.greaterThan(0)).and(uv.y.greaterThan(0)).and(uv.x.lessThan(1)).and(uv.y.lessThan(1)), () => {
          model.assign(models.sample(uv).level(float(0)));
        });
      });
      const diffuseSky = mix(horizon,zenith,smoothstep(0,.58,up.y).mul(.57));
      const seen: N = diffuseSky.mul(bankBand).toVar();
      const background = () => {
        const sky: N = skyAt(up,w.xz).rgb;
        seen.assign((quiet ? sky : mix(sky,diffuseSky,uStreetRiver.mul(.54))).mul(bankBand));
        if (!quiet) If(uBanks.greaterThan(.001).and(r.y.lessThan(.58)), () => {
          const bank = mix(bankFrom(bankA,w,r),bankFrom(bankB,w,r),uBetween);
          const illumination = skyRef.mul(12).add(uSunLight.mul(.095));
          const amount = uBanks.mul(.93);
          seen.assign(seen.mul(float(1).sub(bank.a.mul(amount))).add(bank.rgb.mul(illumination).mul(amount)));
        });
      };
      if (quiet) background();
      else {
        If(model.a.lessThan(.97), background);
        // Transparent black around the boats gives their filtered edges
        // premultiplied colour, including where a wake distorts the silhouette.
        seen.assign(seen.mul(float(1).sub(model.a.mul(.85))).add(model.rgb.mul(vec3(.81,.84,.82))));
      }
      out.assign(mix(out, seen.mul(mirror), smoothstep(FLAT_MIRROR, FLAT_MIRROR + 0.15, mirror)));
    });
    // Only the facets that lean catch a lamp: broken streaks, not a lit sheet.
    out.addAssign(lamps.mul(smoothstep(0.05, 0.2, length(s)).mul(0.45)));
    If(near.greaterThan(0), () => {
      // Small steep facets flash the sun, the more the closer they lean towards it.
      const q = turned(p, 1.9).mul(vec2(3.7, 2.3)).add(vec2(time.mul(-0.9), time.mul(0.7)));
      const f = s.mul(2).add(vec2(vnoise(q), vnoise(q.add(7.7))).sub(0.5).mul(quiet ? 0.14 : mix(.7,.31,uStreetRiver)));
      const glint = pow(max(dot(reflect(v.negate(), waveNormal(f)), uSunDir), 0), 160);
      out.addAssign(uSunLight.mul(glint).mul(0.22).mul(near));
      If(uRain.greaterThan(0.01), () => { out.addAssign(skyRef.mul(SKY).mul(ripples(p, time)).mul(uRain).mul(0.22).mul(near)); });
    });
  });
  return out;
}

